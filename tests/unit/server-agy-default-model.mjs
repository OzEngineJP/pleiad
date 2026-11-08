// Antigravity の「既定に従う」: 画面の「既定（モデル名）」と、実際に agy が使うモデルを揃える（issue #161）。
//
//   - 「既定」（model ''）でも、覚えた既定のモデル（models[""].resolvesTo）を --model で明示する
//     （省くと agy はその時点の自分の既定を使い、Pleiad の起動後に agy 側で既定が変わると、別のモデルの枠が減る）
//   - 一覧の引き直しは明示の再確認（authStatus の probe）だけ。受動の models() は `agy models` を起こさない
//     （未ログインだと OAuth を待つので headless 保証が無い）。probe で取れた一覧が agy 側の既定の変化に追う
//   - 渡すモデルが変わったら、同じ会話の agy を起こし直す（--model は起動時にしか渡せない）
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
  const labelFile = path.join(scratch, "default-label");
  await fs.writeFile(labelFile, "Fake Flash (High)");

  const env = {
    AGENT_HOST_BACKENDS: "antigravity",
    AGENT_HOST_AGY_BIN: `node "${fake}"`,
    FAKE_AGY_ARGS_FILE: argsFile,
    FAKE_AGY_DEFAULT_LABEL_FILE: labelFile,
  };
  const server = await startServer({ env, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const argvList = async () => JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]"));
  /** from 以降に起きた会話の agy（--print 付き）の引数 */
  const turnArgs = async (from) => (await argvList()).slice(from).filter((a) => a.some((x) => x.startsWith("--print")));
  const modelOf = (args) => (args.includes("--model") ? args[args.indexOf("--model") + 1] : null);

  try {
    // 一覧を覚える（明示の再確認が `agy models` を引く。受動の authStatus・models() は起こさない）
    await c.cmd("authStatus", { backend: "antigravity", probe: true });
    const before = await c.cmd("models", { backend: "antigravity" });
    t.ok("最初は agy の既定（Fake Flash (High)）に解決される", before[""]?.resolvesTo === "fake-flash-high", JSON.stringify(before[""]));

    const mark0 = (await argvList()).length;
    const first = await c.runTurn({ prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    const firstArgs = await turnArgs(mark0);
    t.ok("「既定」のターンは、画面に出る既定のモデルを --model で明示する",
      first.outcome === "ok" && firstArgs.length === 1 && modelOf(firstArgs[0]) === "fake-flash-high" && !firstArgs[0].includes("--effort"),
      JSON.stringify(firstArgs));

    // agy 側で既定が変わる（/model で選び直した・agy の既定が更新された）。受動の models() は
    // cache を返すだけで引き直さない（`agy models` は起こさない）。明示の再確認で一覧を引き直す
    await fs.writeFile(labelFile, "Fake Antigravity 1");
    const stale = await c.cmd("models", { backend: "antigravity" });
    t.ok("受動の models() は引き直さず cache を返す", stale[""]?.resolvesTo === "fake-flash-high", JSON.stringify(stale[""]));
    await c.cmd("authStatus", { backend: "antigravity", probe: true });
    const after = await c.cmd("models", { backend: "antigravity" });
    t.ok("明示の再確認で一覧を引き直し、新しい既定に追う",
      after?.[""]?.resolvesTo === "fake-antigravity-1", JSON.stringify(after?.[""]));

    const mark1 = (await argvList()).length;
    const second = await c.runTurn({ prompt: "続き", sessionId: first.sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    const secondArgs = await turnArgs(mark1);
    t.ok("渡すモデルが変わったら、同じ会話の agy を新しい既定で起こし直す（--conversation で続ける）",
      second.outcome === "ok" && secondArgs.length === 1 && modelOf(secondArgs[0]) === "fake-antigravity-1"
        && secondArgs[0][secondArgs[0].indexOf("--conversation") + 1] === first.sessionId,
      JSON.stringify(secondArgs));

    const mark2 = (await argvList()).length;
    const third = await c.runTurn({ prompt: "もう一度", sessionId: first.sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    t.ok("渡すモデルが同じなら、生きている agy を使い回す", third.outcome === "ok" && (await turnArgs(mark2)).length === 0, JSON.stringify(await turnArgs(mark2)));

    // 一覧があるうちに、モデルと段を既定（prefs）に覚えさせる。次の区間で写し無しの再起動を試す
    await c.cmd("setTurnSettings", { sessionId: first.sessionId, model: "fake-flash-high", effort: "low", rememberEffort: true, rememberModel: true });
  } finally {
    c.close();
    await server.stop();
  }

  // ---- 冷たい cache（旧版・写しが無い・壊れた）。覚えている段を「一覧に無い」と黙って既定へ落とさない。
  //      agy は段がモデル id に入るので、落とすと保存とは違う強さで動く。明示の一覧確認で直せる形で止める
  await fs.writeFile(labelFile, "Fake Flash (High)");   // agy 側の既定は変わっていない想定
  await fs.rm(path.join(scratch, "data", "antigravity", "models.json"), { force: true });
  const server2 = await startServer({ env, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const c2 = await open({ port: server2.port, token: server2.token });
  try {
    const mark3 = (await argvList()).length;
    await assert.rejects(
      c2.runTurn({ prompt: "段", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 30_000 }),
      /モデル一覧がまだ確認できていない|状態を再確認/);
    t.ok("一覧が無いのに覚えている段があれば、別の強さで黙って走らず、直し口の分かる失敗にする", true);
    t.ok("失敗したターンは agy を起こさない", (await argvList()).length === mark3, JSON.stringify(await argvList()));
    await c2.cmd("authStatus", { backend: "antigravity", probe: true });
    const fourth = await c2.runTurn({ prompt: "段", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
    const fourthArgs = await turnArgs(mark3);
    t.ok("一覧を確認すれば覚えていたモデル・段がそのまま効く（--model に段違いの id）",
      fourth.outcome === "ok" && fourthArgs.length === 1 && modelOf(fourthArgs[0]) === "fake-flash-low",
      JSON.stringify(fourthArgs));
  } finally {
    c2.close();
    await server2.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
