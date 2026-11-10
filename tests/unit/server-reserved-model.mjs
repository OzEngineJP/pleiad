// 予約したモデルと、モデル一覧の確かめの置きどころ（server.mjs）。
//   - 予約してから送信までに一覧が縮んでも、予約したモデルはそのまま backend へ渡る（送信直前に一覧を見ない。
//     使えなければ backend が断り、その理由が会話に出る）
//   - backend がモデルを断ったとき、その理由がターンの結果として会話に出る
//   - 選ぶとき（setTurnSettings）の確かめは、一覧に無いモデルを一度だけ取り直して（models(cwd, { refresh: true })）確かめる:
//     取り直して見つかれば予約できる、取り直しても無ければ断る
// 一覧は AGENT_HOST_FAKE_MODELS のファイルを書き換えて操る（fake.mjs の fakeModels）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-reserved-model";
export const title = "予約したモデルは一覧が縮んでも backend へ届く。選ぶときの確かめは一度だけ取り直す";

const CATALOG = (ids) => Object.fromEntries(ids.map((id) => [id, { label: id }]));

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-rmodel-")));
  const dataDir = path.join(scratch, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const modelsFile = path.join(scratch, "models.json");
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_FAKE_MODELS: modelsFile },
    dataDir, timeoutMs: 60_000,
  });
  const c = await open({ port: server.port, token: server.token });
  const session = (id) => c.cmd("listSessions").then((rows) => (rows ?? []).find((x) => x.id === id));
  try {
    // ---- 予約してから一覧が縮んでも、予約したモデルで送れる（backend に届く）
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast", "smart", "tiny"]) }));
    const first = await c.runTurn({ prompt: "echo:1", sessionId: null, cwd: ROOT, backend: "fake", mode: "default" }, { ms: 30_000 });
    const id = first.sessionId;
    const reserved = await c.cmd("setTurnSettings", { sessionId: id, model: "smart" });
    t.ok("一覧にあるモデルは予約できる", reserved?.model === "smart", JSON.stringify(reserved));

    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast", "tiny"]) }));   // smart が一覧から消えた
    const sent = await c.runTurn({ prompt: "echo:2", sessionId: id }, { ms: 30_000 });
    const done = await session(id);
    t.ok("一覧が縮んでも予約したモデルでターンが走り、backend へそのまま届く",
      sent.outcome === "ok" && sent.initModel === "smart" && done?.model === "smart" && !done?.nextSettings,
      JSON.stringify({ outcome: sent.outcome, sentModel: sent.initModel, model: done?.model, nextSettings: done?.nextSettings }));

    // ---- backend がモデルを断ったとき、その理由が会話に出る（飲み込まない）
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast", "deny-old"]) }));
    await c.cmd("setTurnSettings", { sessionId: id, model: "deny-old" });
    await fs.writeFile(modelsFile, JSON.stringify({ models: CATALOG(["fast"]) }));   // こちらも送信前に消える
    const denied = await c.runTurn({ prompt: "echo:3", sessionId: id }, { ms: 30_000 });
    const deniedResult = denied.events?.find((e) => e.type === "turnResult" && e.error);
    t.ok("backend が断ったモデルは、その理由がターンの結果に出る",
      denied.outcome === "error" && /deny-old/.test(String(deniedResult?.error ?? "")),
      JSON.stringify({ outcome: denied.outcome, error: deniedResult?.error }));

    // ---- 選ぶときの確かめ: 一覧に無いモデルは一度だけ取り直して確かめる
    await fs.writeFile(modelsFile, JSON.stringify({ normal: CATALOG(["fast"]), refreshed: CATALOG(["fast", "newly"]) }));
    const found = await c.cmd("setTurnSettings", { sessionId: id, model: "newly" });
    t.ok("一覧に無いモデルは、取り直して見つかれば予約できる", found?.model === "newly", JSON.stringify(found));
    await c.cmd("setTurnSettings", { sessionId: id, cancel: true }).catch(() => {});

    await fs.writeFile(modelsFile, JSON.stringify({ normal: CATALOG(["fast"]), refreshed: CATALOG(["fast"]) }));
    const rejected = await c.cmd("setTurnSettings", { sessionId: id, model: "ghost" }).then(() => null).catch((e) => e);
    t.ok("取り直しても一覧に無いモデルは断る", rejected instanceof Error, String(rejected));
    const after = await session(id);
    t.ok("断られた予約は残らない", !after?.nextSettings, JSON.stringify(after?.nextSettings));
  } finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
