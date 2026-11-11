// 初回の案内の「会話を始める」（completeSetup）は、画面が選ばせた「確かめたが確かめられなかった」行も通す。
// 確かめたのに落ちた理由が分からない（未ログインとは断定できない）Antigravity だけの人が、先へ進めなくならないように（docs/desktop-onboarding.md「出さない場合」）。
// 画面とサーバーは同じ判定の関数（web/agent-usable.mjs の canPick）を通る。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-setup-check-failed";
export const title = "初回の案内: 確かめたが確かめられなかったエージェントは completeSetup を通る・はっきり未ログインは通らない";

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-setup-cf-"));
  const run = async (script, fn) => {
    const bin = path.join(scratch, "agy-" + Math.random().toString(36).slice(2) + ".cmd");
    const js = bin.replace(/\.cmd$/, ".mjs");
    await fs.writeFile(js, script);
    await fs.writeFile(bin, process.platform === "win32" ? `@"${process.execPath}" "${js}" %*
` : `#!/bin/sh
exec "${process.execPath}" "${js}" "$@"
`, { mode: 0o755 });
    const server = await startServer({ dataDir: await fs.mkdtemp(path.join(scratch, "d-")), env: { AGENT_HOST_BACKENDS: "antigravity", AGENT_HOST_AGY_BIN: bin } });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    try { await fn(c); } finally { c.close(); await server.stop(); }
  };
  const rejected = async p => { try { await p; return null; } catch (e) { return e; } };
  try {
    await run("process.stderr.write('unexpected failure\n'); process.exit(1);", async c => {
      const st = await c.cmd("authStatus", { backend: "antigravity", probe: true });
      t.ok("前提: 確かめたが確かめられない（未ログインとは断定できない）", st.unconfirmed === true && st.installed !== false, JSON.stringify(st));
      const done = await c.cmd("completeSetup", { backend: "antigravity", cwd: scratch });
      t.ok("確かめられなかった行は通る", done.setupComplete === true && done.backend === "antigravity", JSON.stringify(done));
    });
    await run("process.stderr.write('Please sign in\n'); process.exit(1);", async c => {
      const err = await rejected(c.cmd("completeSetup", { backend: "antigravity", cwd: scratch }));
      t.ok("はっきり未ログインと確かめられた行は通らない", Boolean(err), String(err?.message));
    });
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
