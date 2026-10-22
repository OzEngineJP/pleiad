// Claude の裏のコマンドの出力（作業ダイアログの詳細）。SDK の query を身代わりに差し替えて（setClaudeSdkForTest）CLI も LLM も呼ばずに流す。
//   - getBackgroundTask は走っているターンの Query.getTaskOutput（control の get_task_output。末尾 8 KiB と全体の大きさ）を読む
//   - コマンドは Bash の tool_use の input.command（task_started の tool_use_id でつなぐ）。端末の制御文字は落とす
//   - 完了通知の後も、ターンが走っている間は最後の出力を読める。ターンが終わったら null。サブエージェントは null（loadSubagent で読む）
// 画面（詳細の端末の表示・追従・停止）は tests/browser/claude-background-output.mjs が見る
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-background-output";
export const title = "Claude: 裏のコマンドの出力を作業ダイアログの詳細で読む（Query.getTaskOutput）";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION = "21111111-2222-4333-8444-555555555555";
const HOST = "host-bg-output";

/** SDK の Query の身代わり。getTaskOutput は outputs[taskId] を返す（無ければ CLI と同じく断る） */
function fakeSdk() {
  const inbox = [];
  let wake = null, ended = false;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const q = {
    outputs: {},
    asked: [],
    push(...ms) { inbox.push(...ms); poke(); },
    async getTaskOutput(taskId) {
      q.asked.push(taskId);
      if (!(taskId in q.outputs)) throw new Error(`Task ${taskId} not found`);
      return q.outputs[taskId];
    },
    async stopTask() {},
    interrupt() { return Promise.resolve({}); },
    close() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (inbox.length) { yield inbox.shift(); continue; }
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
  const query = ({ prompt }) => {
    (async () => { for await (const _ of prompt) { /* 最初のプロンプト */ } ended = true; poke(); })();
    return q;
  };
  return { q, restore: setClaudeSdkForTest({ query, executable: () => "claude-fake", resumeGraceMs: 30 }) };
}

const sys = (subtype, rest) => ({ type: "system", subtype, session_id: SESSION, ...rest });
const start = () => ({ type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "message_start" } });
const stop = (reason) => ({ type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "message_delta", delta: { stop_reason: reason } } });
const text = (s) => ({ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "text", text: s }] } });
const bash = (id, command) => ({ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(),
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command, run_in_background: true } }] } });
const toolResult = (id, s) => ({ type: "user", parent_tool_use_id: null, session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: s }] } });
const result = () => ({ type: "result", subtype: "success", session_id: SESSION, num_turns: 1, total_cost_usd: 0 });

async function startTurn() {
  let settled = false;
  const events = [];
  const done = claude.runTurn({
    prompt: "work", sessionId: null, cwd: process.cwd(), mode: "bypass",
    emit: (ev) => events.push(ev), askPermission: async () => ({ allow: true }),
    signal: new AbortController(), control: {}, hostSessionId: HOST,
  }).finally(() => { settled = true; });
  done.catch(() => {});
  return { events, settled: () => settled };
}
const until = async (fn, ms = 3000) => { for (let t = 0; t < ms && !fn(); t += 5) await sleep(5); return fn(); };

export default async function (t) {
  // 画面への印（backgroundDetails・stopBackground）は describeBackends がこの 2 つのメソッドの有無から作る
  t.ok("Claude は出力を読む口と止める口を持つ", typeof claude.getBackgroundTask === "function" && typeof claude.stopBackground === "function");

  const { q, restore } = fakeSdk();
  try {
    t.ok("ターンが走っていなければ null", (await claude.getBackgroundTask(HOST, "b1")) === null);
    const turn = await startTurn();
    q.push(sys("init", { model: "claude-test" }),
      start(), bash("toolu_dev", "npm run dev -- --port 5173"), stop("tool_use"),
      sys("task_started", { task_id: "b1", task_type: "local_bash", description: "Start dev server", tool_use_id: "toolu_dev", is_backgrounded: true }),
      sys("background_tasks_changed", { tasks: [{ task_id: "b1", task_type: "local_bash", description: "Start dev server" }] }),
      toolResult("toolu_dev", "Command running in background with ID: b1"),
      sys("task_started", { task_id: "a1", task_type: "local_agent", description: "調べもの", tool_use_id: "toolu_agent" }),
      start(), text("待つ"), stop("end_turn"), result());
    await until(() => turn.events.some((e) => e.type === "phase" && e.state === "waiting"));

    q.outputs.b1 = { output: "\x1b[32mVITE\x1b[0m ready\r\n  Local: http://localhost:5173/\n", total_bytes: 20000, truncated: true };
    const live = await claude.getBackgroundTask(HOST, "b1");
    t.ok("Query.getTaskOutput に task_id がそのまま届く", q.asked.at(-1) === "b1", q.asked.join());
    t.ok("走っている間は running。コマンドは Bash の input.command、題は description", live?.status === "running" && live.kind === "shell"
      && live.command === "npm run dev -- --port 5173" && live.label === "Start dev server", JSON.stringify(live));
    t.ok("端末の色の制御文字を落とした本文", live?.output === "VITE ready\n  Local: http://localhost:5173/\n", JSON.stringify(live?.output));
    t.ok("末尾だけのときは outputTruncated と全体の大きさ（outputTotalBytes）", live?.outputTruncated === true && live.outputTotalBytes === 20000, JSON.stringify(live));
    t.ok("始めた時刻（startedAtMs）が入る", Number.isFinite(live?.startedAtMs), JSON.stringify(live));

    const asked = q.asked.length;
    t.ok("サブエージェントは出力を読まない（null。会話は loadSubagent）", (await claude.getBackgroundTask(HOST, "a1")) === null && q.asked.length === asked);
    t.ok("CLI が断った（知らない id）ときは null", (await claude.getBackgroundTask(HOST, "nope")) === null);

    // 止めた：完了通知の後も、ターンが走っている間は最後の出力を読める
    q.push(sys("task_notification", { task_id: "b1", status: "stopped" }), sys("background_tasks_changed", { tasks: [] }));
    await until(() => (turn.events.filter((e) => e.type === "background").at(-1)?.tasks ?? [1]).length === 0);
    q.outputs.b1 = { output: "bye\n", total_bytes: 4, truncated: false };
    const gone = await claude.getBackgroundTask(HOST, "b1");
    t.ok("完了通知の後は止めた終わり（completed + stopped）と最後の出力", gone?.status === "completed" && gone.stopped === true && gone.failed === false
      && gone.output === "bye\n" && gone.outputTruncated === false && typeof gone.endedAt === "string", JSON.stringify(gone));

    t.ok("ターンが終わる", await until(turn.settled));
    t.ok("ターンが終わったら null（画面は最後に取った出力を残す）", (await claude.getBackgroundTask(HOST, "b1")) === null);
  } finally { restore(); }
}
