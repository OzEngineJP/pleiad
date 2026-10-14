// agy の裏へ回ったコマンドを、server 越しに一覧へ出して止める。**本物の agy は起動しない。**
//
// 身代わり（tests/lib/fake-agy.mjs の hang-command）は、本物と同じく終わらないコマンドを自分の直下のシェルで走らせ、
// stream には ACTIVE を出したまま、コマンドが終わったときにだけ DONE を出す。
// 測ること: ACTIVE のまましばらくたつと background に出る・phase は active のまま・止める口が当たるのはそのシェルだけ
// （同じコマンドの会話の外のプロセスは残る・agy 自身も残る）・DONE で一覧から外れてターンが result で終わる・中断でも一覧が空になる。
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { killTree, listProcesses } from "../../core/backends/antigravity-background.mjs";

export const name = "server-antigravity-background";
export const title = "agy の裏へ回ったコマンドを一覧に出し、そのコマンドだけを止める";

const COMMAND = 'node -e "setInterval(()=>{},1000)"';
const turnOf = (ev, sessionId) => (ev.turns ?? []).find((x) => x.sessionId === sessionId);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-bg-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const pidFile = path.join(scratch, "agy-pids.json");
  const commandPidFile = path.join(scratch, "command-pid");
  const commandPid = async () => Number(await fs.readFile(commandPidFile, "utf8").catch(() => "0")) || null;
  const leftovers = new Set();

  // 会話の外で、同じコマンドを走らせておく（止める口が当ててはいけない）
  const outside = spawn(COMMAND, { shell: true, stdio: "ignore", windowsHide: true });
  leftovers.add(outside.pid);

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "antigravity",
      AGENT_HOST_AGY_BIN: `node "${fake}"`,
      AGENT_HOST_AGY_BACKGROUND_MS: "400",
      FAKE_AGY_PID_FILE: pidFile,
      FAKE_AGY_COMMAND_PID_FILE: commandPidFile,
    },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });
  const c = await open({ port: server.port, token: server.token });

  try {
    const [b] = await c.cmd("backends");
    t.ok("裏のコマンドを止められると申告する", b?.capabilities?.stopBackground === true, JSON.stringify(b?.capabilities?.stopBackground));

    // ---- すぐ終わるコマンドは一覧に出ない
    const quick = await c.runTurn({ prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    const sessionId = quick.sessionId;
    await new Promise((r) => setTimeout(r, 600));
    t.ok("すぐ DONE が来たコマンドは裏に出ない", quick.tools.includes("run_command")
      && !c.since(0).some((e) => e.type === "background"), quick.tools.join(","));

    // ---- 終わらないコマンド
    const from = c.mark();
    const ended = c.runTurn({ prompt: "hang-command", sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    const shown = await c.waitFor((e) => e.type === "running" && turnOf(e, sessionId)?.background?.length === 1, { from, ms: 15_000 });
    const turn = turnOf(shown, sessionId);
    const task = turn.background[0];
    const toolId = c.since(from).find((e) => e.type === "tool.start" && e.name === "run_command")?.id;
    t.ok("ACTIVE のままのコマンドが、裏のコマンド（shell）として一覧に出る",
      task.kind === "shell" && task.id === toolId && task.label === COMMAND, JSON.stringify(task));
    t.ok("phase は active のまま（waiting にしない）", turn.phase !== "waiting", String(turn.phase));
    t.ok("background のイベントは会話の id 付きで全量が流れる",
      c.since(from).some((e) => e.type === "background" && e.sessionId === sessionId && e.tasks?.length === 1));

    const shell = await commandPid();
    // シェルの下の node（Windows の cmd は子を起こす。sh は exec して子を持たないことがある）
    let inner = [];
    if (shell) await until(async () => (inner = (await listProcesses({ parent: shell }).catch(() => [])).map((p) => p.pid)).length > 0, 3_000);
    if (shell) leftovers.add(shell);
    for (const pid of inner) leftovers.add(pid);
    const agyPid = JSON.parse(await fs.readFile(pidFile, "utf8")).at(-1);

    const unknown = await c.cmd("stopBackground", { sessionId, taskId: `${sessionId}:999` }).then(() => null, (e) => e.message);
    t.ok("知らない id は止めずに断る", Boolean(unknown) && alive(shell), String(unknown));

    const stopFrom = c.mark();
    const stopped = await c.cmd("stopBackground", { sessionId, taskId: task.id }).then((r) => r, (e) => ({ error: e.message }));
    t.ok("止める口が成功を返す", stopped?.stopped === true, JSON.stringify(stopped));
    const done = c.since(stopFrom).find((e) => e.type === "tool.end" || e.type === "tool.result");
    const emptied = c.since(stopFrom).find((e) => e.type === "background" && e.sessionId === sessionId && e.tasks?.length === 0);
    t.ok("返る前に agy の DONE が来て、一覧が空になっている", Boolean(emptied), JSON.stringify(c.since(stopFrom).map((e) => e.type)));
    t.ok("ツールは止めたコマンドの出力で終わる", Boolean(done) && /exited/.test(JSON.stringify(done)), JSON.stringify(done)?.slice(0, 200));

    const result = await ended;
    t.ok("ターンは result で終わる（中断ではない）", result.outcome === "ok"
      && result.events.some((e) => e.type === "text.delta" && e.text.includes("コマンドが終わった")), String(result.outcome));
    t.ok("コマンドのシェルとその子は落ちる", await until(() => !alive(shell) && inner.every((pid) => !alive(pid))),
      JSON.stringify({ shell, inner, alive: inner.filter(alive) }));
    t.ok("会話の外の同じコマンドは落とさない", alive(outside.pid), String(outside.pid));
    t.ok("agy 自身は落とさない（会話は続く）", alive(agyPid), String(agyPid));
    const after = await c.cmd("running");
    t.ok("ターンが終わった後、一覧に残らない", !turnOf(after, sessionId)?.background?.length);

    // ---- 中断でも一覧は空になる
    await fs.rm(commandPidFile, { force: true });
    const abortFrom = c.mark();
    const aborted = c.runTurn({ prompt: "hang-command again", sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    await c.waitFor((e) => e.type === "background" && e.sessionId === sessionId && e.tasks?.length === 1, { from: abortFrom, ms: 15_000 });
    const second = await commandPid();
    if (second) leftovers.add(second);
    // 中断で agy が落ちると、Windows ではシェルが先に消えてその子の node が親無しで残る。後片付けのために先に控える
    if (second) {
      await until(async () => (await listProcesses({ parent: second }).catch(() => [])).some((p) => /setInterval/.test(p.command)), 3_000);
      for (const p of await listProcesses({ parent: second }).catch(() => [])) leftovers.add(p.pid);
    }
    await c.cmd("abort", { sessionId });
    await aborted;
    t.ok("中断すると一覧が空で流れる",
      c.since(abortFrom).some((e) => e.type === "background" && e.sessionId === sessionId && e.tasks?.length === 0),
      JSON.stringify(c.since(abortFrom).filter((e) => e.type === "background")));
    const gone = await c.cmd("stopBackground", { sessionId, taskId: task.id }).then(() => null, (e) => e.message);
    t.ok("終わったターンのタスクは止めずに断る", Boolean(gone), String(gone));
  } finally {
    c.close();
    await server.stop?.();
    for (const pid of leftovers) if (pid && alive(pid)) await killTree(pid).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
