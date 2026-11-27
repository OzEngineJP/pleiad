// antigravity バックエンドを server 越しに通すテスト。**本物の agy は起動しない。**
//
// AGENT_HOST_AGY_BIN に `node tests/lib/fake-agy.mjs` を渡すと、
// core/backends/antigravity.mjs は「ACP（agy acp）を真似た子プロセス」と話す。
// つまり測っているのは JSON-RPC の張り方と、session/update -> 正規化イベントの写し替えと、
// 控えの書き出しであって、agy そのものではない。
//
// 実機で踏んだ穴（docs/multi-backend.md §2.8）もここで塞いだままにする:
// ツールの開始・終了を分けること、出力の打ち切りを成功と取り違えないこと、
// 打ち切った agy を残さないこと。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { checkFork, checkRewind } from "../lib/fork-contract.mjs";
import { loadSqlite } from "../../core/db.mjs";

export const name = "server-antigravity";
export const title = "antigravity バックエンドが agy のヘッドレス越しに往復する";

const textOf = (turn) => turn.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const dataDir = path.join(scratch, "data");
  const argsFile = path.join(scratch, "agy-args.json");
  const pidFile = path.join(scratch, "agy-pids.json");
  const acpLog = path.join(scratch, "agy-acp.log");
  /** fake-agy（ACP）が受けた依頼を 1 行 1 JSON で控えたもの */
  const acpFrames = async () => (await fs.readFile(acpLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const promptLog = path.join(scratch, "agy-prompts.log");
  const hydrogen = ["medium", "high", "xhigh", "low"].map((level) => `gemini-4-hydrogen-${level}`);

  const readJson = async (file, fallback) => JSON.parse(await fs.readFile(file, "utf8").catch(() => fallback));
  /** 身代わりが起きた順の pid（fake-agy.mjs が控える）。 */
  const spawned = () => readJson(pidFile, "[]");
  /** Pleiad が「生かしている」と控えた pid（孤児の掃除に使う控え）。 */
  const recorded = async () => (await readJson(path.join(dataDir, "antigravity", "pids.json"), "[]")).map((e) => e.pid);
  /** その pid が居なくなるまで待つ（落とすのは非同期）。 */
  const gone = async (pid) => {
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  // 既定が先から分かっている状態を作る一覧の写し。無いと、ターンのあいだに一覧が届いて渡すモデルが変わり、会話を --conversation で起こし直して揺れる
  await fs.mkdir(path.join(dataDir, "antigravity"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "antigravity", "models.json"), JSON.stringify({
    rows: [
      { id: "fake-antigravity-1", label: "Fake Antigravity 1" },
      { id: "fake-antigravity-2", label: "Fake Antigravity 2 (Thinking)" },
      { id: "fake-flash-high", label: "Fake Flash (High)" },
      { id: "fake-flash-low", label: "Fake Flash (Low)" },
      ...hydrogen.map((id) => ({ id, label: id })),
    ],
    defaultLabel: "Fake Flash (High)", fetchedAt: Date.now(),
  }));

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "antigravity",
      AGENT_HOST_AGY_BIN: `node "${fake}"`,
      FAKE_AGY_ARGS_FILE: argsFile,
      FAKE_AGY_PID_FILE: pidFile,
      FAKE_AGY_ACP_LOG: acpLog,
      FAKE_AGY_PROMPT_LOG: promptLog,
      FAKE_AGY_EXTRA_MODELS: hydrogen.join(","),
      FAKE_AGY_SPLIT_MODEL: "gemini-4-hydrogen",
    },
    dataDir,
    timeoutMs: 30_000,
  });

  const asked = [];
  const c = await open({
    port: server.port,
    token: server.token,
    onEvent: async (ev, self) => {
      if (ev.type !== "permission") return;
      asked.push(ev);
      await self.cmd("resolvePermission", { id: ev.id, allow: true }).catch(() => {});
    },
  });

  try {
    // ---- 申告。持てないものを「持てない」と言う
    const backends = await c.cmd("backends");
    const b = backends[0];
    t.ok("antigravity だけが有効になる", backends.length === 1 && b.id === "antigravity",
         backends.map((x) => x.id).join(",") || "(なし)");

    // ---- 語彙。ACP は承認を Pleiad の承認カードへ繋ぐので、default / accept-edits / auto / plan と全部自動（yolo）を選べる
    const modes = await c.cmd("modes", { backend: "antigravity" });
    t.ok("承認モードは ACP の 4 つと全部自動の 5 つ",
      Object.keys(modes).join(",") === "default,accept-edits,auto,plan,yolo" && Boolean(modes.yolo?.label),
      Object.keys(modes).join(","));

    // ---- ログイン判定。`agy models` に聞く（資格情報は OS の資格情報ストアにあって読めない）。
    //      受動の authStatus は agy を起こさない（unconfirmed を返す）ので、明示の再確認（probe）で引く
    const auth = await c.cmd("authStatus", { backend: "antigravity", probe: true });
    t.ok("models が引けたらログイン済みと分かる",
      auth.supported === true && auth.installed === true && auth.loggedIn === true,
      JSON.stringify(auth));

    // 引けたモデルは models 一覧にも出る
    const models = await c.cmd("models", { backend: "antigravity" });
    t.ok("agy models の結果がモデル一覧になる",
      "" in models && "fake-antigravity-1" in models, Object.keys(models).join(","));
    // 表示名を使い、段違い（-high / -low）は 1 つの系統にまとめる。既定は agy のログ（--log-file）から読む
    t.ok("表示名がモデルの名前になり、段違いは系統の名前になる",
      models["fake-antigravity-1"]?.label === "Fake Antigravity 1" && models["fake-flash-high"]?.label === "Fake Flash"
        && models["fake-flash-low"]?.hidden === true && !models["fake-flash-high"]?.hidden,
      JSON.stringify(models));
    t.ok("agy の既定のモデルに解決される", models[""]?.resolvesTo === "fake-flash-high", JSON.stringify(models[""]));
    const agyEfforts = await c.cmd("efforts", { backend: "antigravity", model: "" });
    t.ok("既定のモデルの段が選べ、その段に既定の印が付く",
      JSON.stringify(Object.keys(agyEfforts)) === '["","low","high"]' && agyEfforts[""].resolvesTo === "high" && agyEfforts.high?.isDefault === true,
      JSON.stringify(agyEfforts));
    const lowEfforts = await c.cmd("efforts", { backend: "antigravity", model: "fake-flash-low" });
    t.ok("段違いの id を選んでいれば、その id の段が今の段", lowEfforts[""].resolvesTo === "low", JSON.stringify(lowEfforts[""]));
    const single = await c.cmd("efforts", { backend: "antigravity", model: "fake-antigravity-2" });
    t.ok("段違いの無いモデルは段を選べない", JSON.stringify(Object.keys(single)) === '[""]', JSON.stringify(single));

    // ---- 1ターン目（新規）
    const first = await c.runTurn(
      { prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" },
      { ms: 60_000 },
    );
    const sid = first.sessionId;
    t.ok("init の conversation_id が session イベントで来る", Boolean(sid), sid ?? "(なし)");
    const sessionNew = (await acpFrames()).find((f) => f.method === "session/new");
    t.ok("session/new に作業ディレクトリが渡される", sessionNew?.params?.cwd === ROOT, JSON.stringify(sessionNew?.params ?? null));
    // 「既定」のままなら、モデルも段も替えない（session/new が返した既定のモデルをそのまま使う）
    t.ok("既定のモデル・段のままなら、設定を替えない",
      !(await acpFrames()).some((f) => f.method === "session/set_config_option" && f.params?.configId !== "mode"), JSON.stringify((await acpFrames()).map((f) => f.method)));
    const sessionEvents = first.events.filter((e) => e.type === "session");
    t.ok("id 確定の session は first 付きで1本だけ",
      sessionEvents.length === 1 && sessionEvents[0].first === true,
      JSON.stringify(sessionEvents));

    // 本文は真のデルタで流れる（ここが agy を選ぶ理由）
    t.ok("text_delta が text.delta で流れる", textOf(first) === "了解: こんにちは", JSON.stringify(textOf(first)));
    t.ok("デルタが複数回に分かれて届く",
      first.events.filter((e) => e.type === "text.delta").length > 1,
      `${first.events.filter((e) => e.type === "text.delta").length} 回`);

    // 持てないもの
    t.ok("思考は流れない（agy は逐次の reasoning を出さない）",
      first.events.every((e) => e.type !== "thinking.start" && e.type !== "thinking.delta"));
    t.ok("承認は聞かれない（yolo のターンは agy が許可を求めない。聞かれる側は server-agent-tasks・backend-contract が確かめる）", asked.length === 0, `${asked.length} 件`);

    // ツールは同じ step_index で ACTIVE -> DONE の 2 回来る。**分けて 1 件にする**
    t.ok("tool_name が tool.start になる", first.tools.join(",") === "run_command",
         first.tools.join(",") || "(なし)");
    const starts = first.events.filter((e) => e.type === "tool.start");
    const results = first.events.filter((e) => e.type === "tool.result");
    t.ok("ACTIVE と DONE でツールが二重にならない",
      starts.length === 1 && results.length === 1,
      `start ${starts.length} 件 / result ${results.length} 件`);
    t.ok("開始が先、完了が後に出る",
      first.events.indexOf(starts[0]) < first.events.indexOf(results[0]),
      `${first.events.indexOf(starts[0])} -> ${first.events.indexOf(results[0])}`);
    t.ok("開始と完了は同じ id で結びつく", starts[0]?.id && starts[0].id === results[0]?.id,
         `${starts[0]?.id} / ${results[0]?.id}`);
    // ACTIVE の時点で「実行中」が出る（他のバックエンドと同じ見た目になる）
    t.ok("ツールの開始で実行中が出る",
      first.events.some((e) => e.type === "activity" && e.state === "running"),
      JSON.stringify(first.events.filter((e) => e.type === "activity").map((e) => e.state)));
    t.ok("DONE の出力が tool.result になる",
      results[0]?.text?.includes("hello") && results[0]?.isError === false,
      JSON.stringify(results[0] ?? null));
    t.ok("ツールのパラメータが tool.start に載る",
      starts[0]?.input?.CommandLine === "echo hello",
      JSON.stringify(starts[0]?.input ?? null));

    t.ok("status SUCCESS が turnResult ok になる", first.outcome === "ok", String(first.outcome));
    // fake-agy の usage は input 11・output 7・thinking 3・cache_read 2（total 23）。入力はキャッシュ読みを含み、出力は考えた分を含む（Claude・Codex と同じ）
    t.ok("result の usage がトークン数になる（入力にキャッシュ読み、出力に考えた分を含める）",
      first.events.some((e) => e.type === "usage" && e.inputTokens === 13 && e.outputTokens === 10 && e.cachedTokens === 2),
      JSON.stringify(first.events.find((e) => e.type === "usage") ?? null));

    // ---- 控え。**agy に一覧も履歴も無いので Pleiad が書く**
    const rows = await c.cmd("listSessions");
    const row = rows.find((s) => s.id === sid);
    t.ok("控えから一覧に出る", Boolean(row), sid ?? "(なし)");
    // 同じ置き場に pid の控え（pids.json）も入る。会話として拾わない
    t.ok("控えでないファイルは会話にしない", rows.every((s) => s.id !== "pids"),
         rows.map((s) => s.id).join(",") || "(なし)");
    t.ok("一覧に backend が付く", row?.backend === "antigravity", row?.backend ?? "(なし)");
    t.ok("一覧に cwd が乗る", row?.cwd === ROOT, row?.cwd ?? "(なし)");

    const stored = JSON.parse(
      await fs.readFile(path.join(dataDir, "antigravity", `${sid}.json`), "utf8"),
    );
    t.ok("控えは Pleiad の置き場に入る", stored.conversationId === sid && stored.messages.length === 2,
         `${stored.messages?.length} 件`);
    t.ok("成功 result の生 status と経路を控える",
      stored.turnResults?.[0]?.status === "end_turn" && stored.turnResults[0].source === "result" && stored.turnResults[0].outcome === "ok",
      JSON.stringify(stored.turnResults ?? null));

    const loaded = await c.cmd("loadSession", { sessionId: sid });
    const user = loaded.messages.find((m) => m.role === "user");
    const assistant = loaded.messages.find((m) => m.role === "assistant" && m.text);
    t.ok("控えが履歴になる",
      user?.text === "こんにちは" && assistant?.text === "了解: こんにちは",
      `${loaded.messages.length} 件`);
    t.ok("履歴にツール呼び出しが畳まれる",
      assistant?.toolCalls?.length === 1 && assistant.toolCalls[0].name === "run_command"
        && assistant.toolCalls[0].result?.text.includes("hello"),
      JSON.stringify(assistant?.toolCalls ?? null));

    // ---- 2ターン目。**同じプロセスを使い回す**（1 プロセス = 1 会話）
    const second = await c.runTurn({ prompt: "つづき", sessionId: sid, cwd: ROOT }, { ms: 60_000 });
    t.ok("再開ターンは session を出さない",
      second.events.every((e) => e.type !== "session"),
      JSON.stringify(second.events.filter((e) => e.type === "session")));
    t.ok("同じ会話で続きが流れる", textOf(second) === "了解: つづき", JSON.stringify(textOf(second)));
    const after = JSON.parse(await fs.readFile(path.join(dataDir, "antigravity", `${sid}.json`), "utf8"));
    t.ok("控えが積み増される", after.messages.length === 4, `${after.messages.length} 件`);
    // agy の usage は会話の累計（fake-agy は 2 ターン目に 22・14・6・4）。前のターンの累計（控えのターンの記録）との差を使用量にする
    t.ok("再開ターンの usage は前のターンの累計との差",
      second.events.filter((e) => e.type === "usage").map((e) => [e.inputTokens, e.outputTokens, e.cachedTokens]).join("|") === "13,10,2"
        && after.turnResults?.at(-1)?.usage?.input_tokens === 22,
      JSON.stringify({ usage: second.events.filter((e) => e.type === "usage"), trace: after.turnResults?.at(-1) ?? null }));

    // ---- 入力欄の `!`。Pleiad が実行し、結果を次の発言の前に agy へ渡す（ADR 0054・0281）。
    const shellFrom = c.mark();
    await c.cmd('runShell', { sessionId: sid, runId: 'agy-host-shell-001', command: 'echo AGY_HOST_SHELL_OK', cwd: ROOT });
    const shellDone = await c.waitFor(e => e.type === 'shell.done' && e.runId === 'agy-host-shell-001', { from: shellFrom, ms: 20_000 });
    const shellTurn = await c.runTurn({ prompt: 'wire-all', sessionId: sid, cwd: ROOT }, { ms: 60_000 });
    const shellWire = JSON.parse(textOf(shellTurn));
    t.ok('! の結果を次の agy 発言に引き渡す', shellDone?.exitCode === 0 && shellWire?.wire?.includes('AGY_HOST_SHELL_OK'), JSON.stringify({ shellDone, shellTurn: shellTurn.outcome, wire: shellWire?.wire?.slice(0, 400) }));

    // ---- 時刻。ユーザー発言は送信時、AI の発言は完了時（理由は core/backends/antigravity.mjs）。
    // 提示の並び、ひいては分岐の切り口に効くので番人を置く
    const sentBefore = Date.now();
    await c.runTurn({ prompt: "delay400", sessionId: sid, cwd: ROOT }, { ms: 60_000 });
    const timed = await c.cmd("loadSession", { sessionId: sid });
    const askedAt = new Date(timed.messages.at(-2).at).getTime();
    const repliedAt = new Date(timed.messages.at(-1).at).getTime();
    // 完了時刻でないことは下の repliedAt との差（delay400）で見る。ここで上限を置くと混んだ CI の起動遅れで揺れる
    t.ok("ユーザー発言は送信の時刻で残る", askedAt >= sentBefore, `送信から ${askedAt - sentBefore}ms`);
    t.ok("AI の発言は完了の時刻で残る", repliedAt - askedAt >= 300, `${repliedAt - askedAt}ms 後`);

    // ---- 分岐。**agy に分岐の口が無いので、ホストの写しで分ける**（docs/message-fork.md）。
    // 汎用経路に相乗りしているだけなので、他のバックエンドと同じ契約で測る
    await checkFork(t, c, { id: sid, cwd: ROOT, firstText: "こんにちは", laterText: "つづき" });
    // 同じ会話で巻き戻して送り直す。agy に巻き戻す口は無いので、Pleiad の履歴を切って次のターンで引き継ぐ（ホスト管理。docs/message-fork.md）
    await checkRewind(t, c, { id: sid, firstText: "こんにちは", laterText: "つづき", sawPrefixOnly: true });

    // ---- 失敗
    const failed = await c.runTurn({ prompt: "fail", sessionId: sid, cwd: ROOT }, { ms: 60_000 })
      .catch((err) => ({ outcome: "error", error: String(err?.message ?? err) }));
    t.ok("status ERROR が turnResult error になる", failed.outcome === "error", String(failed.outcome));

    // 本文が届いても result 自体が ERROR なら失敗。この区別を残し、次の成功ターンへ引きずらない。
    const bodySession = await c.runTurn({ prompt: "基準", sessionId: null, cwd: ROOT, backend: "antigravity" }, { ms: 60_000 });
    const bodySid = bodySession.sessionId;
    const pidCount = (await spawned()).length;
    const bodyError = await c.runTurn({ prompt: "error-body", sessionId: bodySid, cwd: ROOT }, { ms: 60_000 });
    const diagnosed = JSON.parse(await fs.readFile(path.join(dataDir, "antigravity", `${bodySid}.json`), "utf8"));
    const bodyTrace = diagnosed.turnResults.at(-1);
    t.ok("本文付き ERROR は失敗だが本文を残す", bodyError.outcome === "error" && textOf(bodyError) === "本文は届いた"
      && diagnosed.messages.at(-1)?.text === "本文は届いた", JSON.stringify(bodyTrace));
    // ACP は依頼の失敗として届く。失敗の文面は安全な固定文（wire の message は残さない）
    t.ok("失敗理由を会話の控えに残す", bodyTrace?.source === "exception" && bodyTrace.outcome === "error" && Boolean(bodyTrace.error), JSON.stringify(bodyTrace));
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(path.join(dataDir, "pleiad.db"), { readOnly: true });
    let failures;
    try { failures = JSON.parse(db.prepare("SELECT value FROM session_fields WHERE session_id = ? AND field = 'antigravityFailures'").get(bodySid)?.value ?? "[]"); }
    finally { db.close(); }
    t.ok("server が failed にした経路も残す", failures.at(-1)?.source === "backend.turnResult"
      && Boolean(failures.at(-1)?.error), JSON.stringify(failures.at(-1)));
    const afterReply = await c.runTurn({ prompt: "limit-after-reply", sessionId: bodySid, cwd: ROOT }, { ms: 60_000 });
    // ACP には「返事が完成した」合図が無いので、返事の後の失敗も本文を残したまま失敗・上限として扱う（成功に読み替えない）
    t.ok("返事の後の上限は limited で、本文は残す", afterReply.outcome === "limited" && textOf(afterReply) === "完成した返事", JSON.stringify(afterReply.outcome));
    const afterOtherError = await c.runTurn({ prompt: "error-after-reply", sessionId: bodySid, cwd: ROOT }, { ms: 60_000 });
    t.ok("返事の後の一般エラーは失敗で、本文は残す", afterOtherError.outcome === "error" && textOf(afterOtherError) === "完成した返事", String(afterOtherError.outcome));
    const noReply = await c.runTurn({ prompt: "limit-no-reply", sessionId: bodySid, cwd: ROOT }, { ms: 60_000 });
    t.ok("返事が完成しない上限は従来どおり limited", noReply.outcome === "limited", String(noReply.outcome));
    const unfinished = await c.runTurn({ prompt: "error-after-tool", sessionId: bodySid, cwd: ROOT }, { ms: 60_000 });
    t.ok("返事の後に道具を呼んで未完了なら失敗", unfinished.outcome === "error", String(unfinished.outcome));
    const recovered = await c.runTurn({ prompt: "復帰", sessionId: bodySid, cwd: ROOT }, { ms: 60_000 });
    t.ok("非成功 result が次のターンへ残らない", recovered.outcome === "ok" && (await spawned()).length === pidCount,
      String(recovered.outcome));

    // ---- 段。agy の --effort は段違いの id を選ぶことと同じ。--model と同時に渡さず、段違いの id に解決する
    const beforeEffort = (await acpFrames()).length;
    const low = await c.runTurn({ prompt: "段", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo", effort: "low" }, { ms: 60_000 });
    const lowSet = (await acpFrames()).slice(beforeEffort).filter((f) => f.method === "session/set_config_option");
    t.ok("段を選ぶと、既定のモデルの段違いの id を session/set_config_option の model に渡す",
      low.outcome === "ok" && lowSet.some((f) => f.params?.configId === "model" && f.params?.value === "fake-flash-low"),
      JSON.stringify(lowSet));

    for (const model of hydrogen) {
      const before = (await acpFrames()).length;
      const turn = await c.runTurn({ prompt: "Hydrogen", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo", model }, { ms: 60_000 });
      const frames = (await acpFrames()).slice(before);
      t.ok(`分かれて返るモデルと段を検証して ${model} で送れる`,
        turn.outcome === "ok" && frames.some((f) => f.method === "session/set_config_option" && f.params?.configId === "model" && f.params?.value === model)
          && frames.some((f) => f.method === "session/prompt"), JSON.stringify({ outcome: turn.outcome, methods: frames.map((f) => f.method) }));
    }

    // ---- 中断。プロトコルに中断が無いのでプロセスを落とす
    const mark = c.mark();
    c.cmd("runTurn", { prompt: "slow", sessionId: null, cwd: ROOT, backend: "antigravity" }).catch(() => {});
    const started = await c.waitFor((e) => e.type === "session", { ms: 60_000, from: mark });
    const stopped = await c.cmd("abort", { sessionId: started.sessionId });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === started.sessionId, { ms: 60_000, from: mark });
    t.ok("中断を受け付ける", stopped.aborted === 1, JSON.stringify(stopped));
    t.ok("落として aborted になる",
      c.since(mark).some((e) => e.type === "turnResult" && e.outcome === "aborted"),
      JSON.stringify(c.since(mark).filter((e) => e.type === "turnResult")));

    // ---- 使用量。agy の usage は会話の累計で、--conversation で起こし直した別のプロセスでも続きから数える（fake-agy も会話 id ごとにファイルで持つ）。
    // プロセスを替えても、次のターンはそのターンの分（控えに残した前のターンの累計との差）だけを記録する
    const usageOf = (turn) => turn.events.filter((e) => e.type === "usage").map((e) => [e.inputTokens, e.outputTokens, e.cachedTokens].join(",")).join("|");
    const counted = await c.runTurn({ prompt: "数える", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    const countedSid = counted.sessionId;
    const lastTrace = async () => JSON.parse(await fs.readFile(path.join(dataDir, "antigravity", `${countedSid}.json`), "utf8")).turnResults.at(-1);
    const countedSecond = await c.runTurn({ prompt: "数える 2", sessionId: countedSid, cwd: ROOT }, { ms: 60_000 });
    t.ok("同じプロセスの 2 ターン目はそのターンの分", usageOf(countedSecond) === "13,10,2" && (await lastTrace())?.usage?.input_tokens === 22,
      JSON.stringify({ usage: usageOf(countedSecond), trace: await lastTrace() }));
    // 中断で agy を落とす（result の無いまま。累計は進まない）
    const slowCount = async () => (await fs.readFile(promptLog, "utf8").catch(() => "")).split("\n").filter((line) => line.includes("slow")).length;
    const slowBefore = await slowCount();
    const killFrom = c.mark();
    c.cmd("runTurn", { prompt: "slow", sessionId: countedSid, cwd: ROOT }).catch(() => {});
    for (let i = 0; i < 200 && (await slowCount()) === slowBefore; i++) await new Promise((r) => setTimeout(r, 50));
    await c.cmd("abort", { sessionId: countedSid });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === countedSid, { ms: 60_000, from: killFrom });
    const argsMark = (await acpFrames()).length;
    const countedResumed = await c.runTurn({ prompt: "数える 3", sessionId: countedSid, cwd: ROOT }, { ms: 60_000 });
    const resumedCalls = (await acpFrames()).slice(argsMark).filter((f) => f.method === "session/resume" || f.method === "session/load");
    t.ok("中断した会話は、次のターンで同じ会話 id を resume する",
      countedResumed.outcome === "ok" && resumedCalls.every((f) => f.params?.sessionId === countedSid),
      JSON.stringify(resumedCalls));
    // 新しいプロセスの累計は 33（前のプロセスの 22 の続き）。差の 11（入力はキャッシュ読みを足して 13）だけを記録する
    t.ok("agy のプロセスを替えても、次のターンの使用量はそのターンの分だけ",
      usageOf(countedResumed) === "13,10,2" && (await lastTrace())?.usage?.input_tokens === 33,
      JSON.stringify({ usage: usageOf(countedResumed), trace: await lastTrace() }));
    // agy が累計を 0 から数え直した（前のターンの累計より減った）ら、差にせず、その累計をこのターンの分として記録する
    const countedReset = await c.runTurn({ prompt: "usage-reset", sessionId: countedSid, cwd: ROOT }, { ms: 60_000 });
    t.ok("累計が減ったら、差にせず累計をそのまま使う",
      usageOf(countedReset) === "13,10,2" && (await lastTrace())?.usage?.input_tokens === 11,
      JSON.stringify({ usage: usageOf(countedReset), trace: await lastTrace() }));
    const countedAfterReset = await c.runTurn({ prompt: "数える 4", sessionId: countedSid, cwd: ROOT }, { ms: 60_000 });
    t.ok("数え直した後は、新しい累計を基準に差を取る",
      usageOf(countedAfterReset) === "13,10,2" && (await lastTrace())?.usage?.input_tokens === 22,
      JSON.stringify({ usage: usageOf(countedAfterReset), trace: await lastTrace() }));
  } finally {
    c.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
