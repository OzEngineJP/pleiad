// 初回の案内の「会話を始める」（completeSetup）は、画面が「使える」とした行を通す。
// ログインの口が無く、確認の済んだ互換の接続先だけで使えるエージェントも、ここで止めない（docs/desktop-onboarding.md「出さない場合」）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { startFakeCompatApi } from "../lib/fake-compat-api.mjs";

export const name = "server-setup-endpoint-only";
export const title = "初回の案内: ログインが無くても、確認済みの接続先だけで使えるエージェントは completeSetup を通る";

const KEY = "sk-compat-" + "e".repeat(24);

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-setup-ep-"));
  const codexHome = path.join(scratch, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  const api = await startFakeCompatApi({ keys: [KEY], auth: "bearer", models: ["vendor/fake-large"] });
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "codex",
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, "tests/lib/fake-codex.mjs")}"`, FAKE_CODEX_ACCOUNTS: "1", CODEX_HOME: codexHome } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const rejected = async p => { try { await p; return null; } catch (e) { return e; } };
  try {
    const before = await c.cmd("authStatus", { backend: "codex" });
    t.ok("前提: ログインしていない", before.loggedIn === false, JSON.stringify(before));
    const none = await rejected(c.cmd("completeSetup", { backend: "codex", cwd: scratch }));
    t.ok("ログインも接続先も無ければ通らない", Boolean(none), String(none?.message));

    const input = { agent: "codex", name: "偽の接続先", preset: "custom", baseUrl: api.url + "/v1", authMode: "bearer", key: KEY, roles: { main: "vendor/fake-large" } };
    const checked = await c.cmd("compatEndpointCheck", { input });
    await c.cmd("compatEndpointSave", { input, receipt: checked.receipt });
    const done = await c.cmd("completeSetup", { backend: "codex", cwd: scratch });
    t.ok("確認の済んだ接続先があれば、ログインしていなくても通る", done.setupComplete === true && done.backend === "codex", JSON.stringify(done));
  } finally { c.close(); await server.stop(); await api.close?.(); await fs.rm(scratch, { recursive: true, force: true }); }
}
