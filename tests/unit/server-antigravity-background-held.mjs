// 保持役に載せた agy（インストール版の既定。session.pid を持たない）でも、裏へ回ったコマンドだけを止められる。**本物の agy は起動しない。**
//
// 止める口は、保持役の直下の子から会話の agy を引き（antigravity.mjs の agyPidOf）、その直下のシェルだけを落とす。
// 保持役・agy・会話の外の同じコマンドは残る。偽の agy の振る舞いは server-antigravity-background と同じ hang-command
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { ensureHolder, connectHolder } from "../../core/holder/client.mjs";
import { killTree, listProcesses } from "../../core/backends/antigravity-background.mjs";

export const name = "server-antigravity-background-held";
export const title = "保持役に載せた agy でも、裏へ回ったコマンドだけを止める";

const COMMAND = 'node -e "setInterval(()=>{},1000)"';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 後片付けで落としてよいのは、この試験が起こしたものだけ。init・自分・自分の親（runner）には、一覧を取り違えても手を出さない
const safeToKill = (pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-bg-held-")));
  const dataDir = path.join(scratch, "data");
  const root = path.join(scratch, "runtime");
  const commandPidFile = path.join(scratch, "command-pid");
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const leftovers = new Set();
  const outside = spawn(COMMAND, { shell: true, stdio: "ignore", windowsHide: true });
  leftovers.add(outside.pid);
  let holderPid = null, server = null, c = null;
  try {
    const found = await ensureHolder({ dataDir, root, mode: "detached", idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();
    server = await startServer({
      env: {
        AGENT_HOST_BACKENDS: "antigravity",
        AGENT_HOST_AGY_BIN: `node "${fake}"`,
        AGENT_HOST_RUNTIME_ROOT: root,
        AGENT_HOST_AGY_BACKGROUND_MS: "400",
        FAKE_AGY_COMMAND_PID_FILE: commandPidFile,
      },
      dataDir,
      timeoutMs: 30_000,
    });
    c = await open({ port: server.port, token: server.token });

    const first = await c.runTurn({ prompt: "plain", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 30_000 });
    const sessionId = first.sessionId;
    const agys = (await listProcesses({ parent: holderPid })).filter((p) => p.command.includes("fake-agy"));
    t.ok("agy は保持役の子として走る", agys.length === 1, JSON.stringify(agys.map((p) => p.pid)));

    const from = c.mark();
    const ended = c.runTurn({ prompt: "hang-command", sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    const shown = await c.waitFor((e) => e.type === "background" && e.sessionId === sessionId && e.tasks?.length === 1, { from, ms: 15_000 });
    // 偽の agy は ACTIVE を出してからシェルを起こし、その pid を書く（並べて流すと 0.4 秒の裏へ回る判定より遅れる）
    await until(async () => Number(await fs.readFile(commandPidFile, "utf8").catch(() => "0")) > 0, 10_000);
    const shell = Number(await fs.readFile(commandPidFile, "utf8").catch(() => "0")) || null;
    if (shell) leftovers.add(shell);

    const stopped = await c.cmd("stopBackground", { sessionId, taskId: shown.tasks[0].id }).then((r) => r, (e) => ({ error: e.message }));
    t.ok("保持役に載せた agy でも止める口が成功を返す", stopped?.stopped === true, JSON.stringify(stopped));
    const result = await ended;
    t.ok("ターンは result で終わる", result.outcome === "ok", String(result.outcome));
    t.ok("コマンドのシェルは落ちる", Boolean(shell) && await until(() => !alive(shell)), String(shell));
    t.ok("agy・保持役・会話の外の同じコマンドは落とさない", agys.every((p) => alive(p.pid)) && alive(holderPid) && alive(outside.pid));
  } finally {
    c?.close();
    await server?.stop?.();
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      probe?.shutdown();
      probe?.close();
      if (!await until(() => !alive(holderPid))) { try { process.kill(holderPid); } catch { /* 既に終わっている */ } }
    }
    for (const pid of leftovers) if (safeToKill(pid) && alive(pid)) await killTree(pid).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
