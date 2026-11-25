// Antigravity の「既定に従う」: 画面の「既定（モデル名）」と、実際に agy が使うモデルを揃える（issue #161）。
//
//   - 「既定」（model ''）のままなら、モデルも段も替えない（ACP は session/new が返す既定のモデルをそのまま使う）。
//     段を覚えていれば、既定のモデルの段違いの id を session/set_config_option の model で渡す
//   - 一覧の引き直しは、人の明示（authStatus の probe）のほか、このプロセスでログイン済みと確かめた所でだけ:
//     覚えた段の要る送信で一覧が無ければ /usage で確かめて取る（待つ）・使用量が読めて一覧が無ければ裏で取る・
//     'in' の間に TTL を超えた一覧は読み取りをきっかけに裏で引き直す。受動の models() 自体は `agy models` を待たない
//     （`agy models` は headless 保証が無いので、未確認・未ログインでは起こさない）
//   - 渡すモデルが変わっても、走っている agy に session/set_config_option で渡す（起こし直さない）
// 本物の agy は起動しない（tests/lib/fake-agy.mjs。既定のモデルは FAKE_AGY_DEFAULT_LABEL_FILE で切り替える）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-agy-default-model";
export const title = "Antigravity の「既定」は覚えた既定のモデルを明示し、agy 側の既定の変化に追う";

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agydef-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const argsFile = path.join(scratch, "agy-args.json");
  const acpLog = path.join(scratch, "agy-acp.log");
  const labelFile = path.join(scratch, "default-label");
  await fs.writeFile(labelFile, "Fake Flash (High)");

  const env = {
    AGENT_HOST_BACKENDS: "antigravity",
    AGENT_HOST_AGY_BIN: `node "${fake}"`,
    FAKE_AGY_ARGS_FILE: argsFile,
    FAKE_AGY_ACP_LOG: acpLog,
    FAKE_AGY_DEFAULT_LABEL_FILE: labelFile,
  };
  const server = await startServer({ env, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const argvList = async () => JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]"));
  const acpFrames = async () => (await fs.readFile(acpLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  /** from 以降に agy へ渡った、モデルを替える依頼の値 */
  const modelSets = async (from) => (await acpFrames()).slice(from).filter((f) => f.method === "session/set_config_option" && f.params?.configId === "model").map((f) => f.params.value);
  const newSessions = async (from) => (await acpFrames()).slice(from).filter((f) => f.method === "session/new");

  try {
    // 一覧を覚える（明示の再確認が `agy models` を引く。受動の authStatus・models() は起こさない）
    await c.cmd("authStatus", { backend: "antigravity", probe: true });
    const before = await c.cmd("models", { backend: "antigravity" });
    t.ok("最初は agy の既定（Fake Flash (High)）に解決される", before[""]?.resolvesTo === "fake-flash-high", JSON.stringify(before[""]));

    const mark0 = (await acpFrames()).length;
    const first = await c.runTurn({ prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    t.ok("「既定」のターンは、モデルも段も替えず session/new の既定のままで走る",
      first.outcome === "ok" && (await newSessions(mark0)).length === 1 && (await modelSets(mark0)).length === 0,
      JSON.stringify((await acpFrames()).slice(mark0).map((f) => f.method)));

    // agy 側で既定が変わる（/model で選び直した・agy の既定が更新された）。受動の models() は待たず
    // 覚えた一覧を返す（取ったばかり＝TTL 内なので裏の引き直しも起きない）。明示の再確認で一覧を引き直す
    await fs.writeFile(labelFile, "Fake Antigravity 1");
    const stale = await c.cmd("models", { backend: "antigravity" });
    t.ok("受動の models() は待たず覚えた一覧を返す", stale[""]?.resolvesTo === "fake-flash-high", JSON.stringify(stale[""]));
    await c.cmd("authStatus", { backend: "antigravity", probe: true });
    const after = await c.cmd("models", { backend: "antigravity" });
    t.ok("明示の再確認で一覧を引き直し、新しい既定に追う",
      after?.[""]?.resolvesTo === "fake-antigravity-1", JSON.stringify(after?.[""]));

    const mark1 = (await acpFrames()).length;
    const second = await c.runTurn({ prompt: "続き", sessionId: first.sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    t.ok("渡すモデルが変わったら、同じ会話の agy を起こし直さず、新しい既定を session/set_config_option で渡す",
      second.outcome === "ok" && (await newSessions(mark1)).length === 0 && (await modelSets(mark1)).join() === "fake-antigravity-1",
      JSON.stringify((await acpFrames()).slice(mark1).map((f) => f.method)));

    const mark2 = (await acpFrames()).length;
    const third = await c.runTurn({ prompt: "もう一度", sessionId: first.sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    t.ok("渡すモデルが同じなら、生きている agy を使い回す", third.outcome === "ok" && (await newSessions(mark2)).length === 0 && (await modelSets(mark2)).length === 0, JSON.stringify((await acpFrames()).slice(mark2).map((f) => f.method)));

    // 一覧があるうちに、モデルと段を既定（prefs）に覚えさせる。次の区間で写し無しの再起動を試す
    await c.cmd("setTurnSettings", { sessionId: first.sessionId, model: "fake-flash-high", effort: "low", rememberEffort: true, rememberModel: true });
  } finally {
    c.close();
    await server.stop();
  }

  // ---- 一覧の写しも無い再起動。覚えている段を「一覧に無い」と黙って既定へ落とさない:
  //      送信の関所が、受動でも起こせる /usage でログインを確かめてから一覧を自分で取り、覚えた段で送る。
  //      （未ログイン・見通し不明なら、別の強さで黙って走らないよう同じ関所で止める。antigravity-passive.mjs）
  await fs.writeFile(labelFile, "Fake Flash (High)");   // agy 側の既定は変わっていない想定
  await fs.rm(path.join(scratch, "data", "antigravity", "models.json"), { force: true });
  const server2 = await startServer({ env, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const c2 = await open({ port: server2.port, token: server2.token });
  try {
    const mark3 = (await argvList()).length;
    const frames3 = (await acpFrames()).length;
    const fourth = await c2.runTurn({ prompt: "段", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    const spawned = (await argvList()).slice(mark3);
    t.ok("一覧が無くても送信の関所が一覧を取り、覚えたモデル・段がそのまま効く（model に段違いの id）",
      fourth.outcome === "ok" && (await modelSets(frames3)).includes("fake-flash-low"),
      JSON.stringify({ sets: await modelSets(frames3), spawned }));
    t.ok("一覧の取得（agy models）は 1 本だけ",
      spawned.filter((a) => a.at(-1) === "models").length === 1, JSON.stringify(spawned));
  } finally {
    c2.close();
    await server2.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
