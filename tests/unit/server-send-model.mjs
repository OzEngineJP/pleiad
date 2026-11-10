// 予約の無いふつうの送信のモデル決め（server.mjs の sendModel。ADR 0309）。
//   - 保存したモデルが一覧から消えても、一覧では裁かず形だけ確かめてそのまま backend へ渡す
//     （黙って既定に戻さない。使えなければ backend が断り、その理由が会話に出る）
//   - backend が断ったあと、モデルを選び直せば次の送信は通る
// 一覧は AGENT_HOST_FAKE_MODELS のファイルを書き換えて操る（fake.mjs の fakeModels）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-send-model";
export const title = "ふつうの送信は保存したモデルを一覧で裁かずそのまま渡す";

const CATALOG = (ids) => Object.fromEntries(ids.map((id) => [id, { label: id }]));

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-smodel-")));
  const dataDir = path.join(scratch, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const modelsFile = path.join(scratch, "models.json");
  const env = { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_FAKE_MODELS: modelsFile };
  const server = await startServer({ env, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    // ---- 保存したモデルが一覧から消えても、ふつうの送信でそのまま backend へ届く（既定に戻らない）
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast", "smart"]) }));
    const first = await c.runTurn({ prompt: "echo:1", sessionId: null, cwd: ROOT, backend: "fake", mode: "default" }, { ms: 30_000 });
    const id = first.sessionId;
    await c.cmd("setModel", { sessionId: id, model: "smart" });
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast"]) }));   // smart が一覧から消えた
    const sent = await c.runTurn({ prompt: "echo:2", sessionId: id }, { ms: 30_000 });
    t.ok("保存したモデルは一覧に無くてもそのまま backend へ渡る（既定に戻さない）",
      sent.outcome === "ok" && sent.initModel === "smart",
      JSON.stringify({ outcome: sent.outcome, model: sent.initModel }));

    // ---- 渡された値（この送信の指定）も一覧で裁かずそのまま渡す
    const asked = await c.runTurn({ prompt: "echo:3", sessionId: id, model: "ghost" }, { ms: 30_000 });
    t.ok("送信ごとに渡されたモデルも一覧に無くてもそのまま渡る",
      asked.outcome === "ok" && asked.initModel === "ghost",
      JSON.stringify({ outcome: asked.outcome, model: asked.initModel }));

    // ---- backend がモデルを断ったとき、その理由がターンの結果として会話に出る（飲み込まない）
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast", "deny-old"]) }));
    await c.cmd("setModel", { sessionId: id, model: "deny-old" });
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast"]) }));   // こちらも送信前に消える
    const denied = await c.runTurn({ prompt: "echo:4", sessionId: id }, { ms: 30_000 });
    const deniedResult = denied.events?.find((e) => e.type === "turnResult" && e.error);
    t.ok("backend が断ったモデルは、その理由がターンの結果に出る",
      denied.outcome === "error" && /deny-old/.test(String(deniedResult?.error ?? "")),
      JSON.stringify({ outcome: denied.outcome, error: deniedResult?.error }));

    // ---- モデルを選び直せば次の送信は通る
    await c.cmd("setModel", { sessionId: id, model: "fast" });
    const recovered = await c.runTurn({ prompt: "echo:5", sessionId: id }, { ms: 30_000 });
    t.ok("断られたあとにモデルを選び直せば次の送信は通る",
      recovered.outcome === "ok" && recovered.initModel === "fast",
      JSON.stringify({ outcome: recovered.outcome, model: recovered.initModel }));
  } finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
