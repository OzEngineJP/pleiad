// Antigravity の「既定に従う」: 画面の「既定（モデル名）」と、実際に agy が使うモデルを揃える（issue #161）。
//
//   - 「既定」（model ''）でも、覚えた既定のモデル（models[""].resolvesTo）を --model で明示する
//     （省くと agy はその時点の自分の既定を使い、Pleiad の起動後に agy 側で既定が変わると、別のモデルの枠が減る）
//   - 覚えた一覧が古くなったら（AGENT_HOST_AGY_MODELS_TTL_MS）、一覧を読んだときに裏で `agy models` を引き直し、agy 側の既定に追う
//   - 渡すモデルが変わったら、同じ会話の agy を起こし直す（--model は起動時にしか渡せない）
// 本物の agy は起動しない（tests/lib/fake-agy.mjs。既定のモデルは FAKE_AGY_DEFAULT_LABEL_FILE で切り替える）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "antigravity",
      AGENT_HOST_AGY_BIN: `node "${fake}"`,
      AGENT_HOST_AGY_MODELS_TTL_MS: "200",
      FAKE_AGY_ARGS_FILE: argsFile,
      FAKE_AGY_DEFAULT_LABEL_FILE: labelFile,
    },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });
  const c = await open({ port: server.port, token: server.token });
  const argvList = async () => JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]"));
  /** from 以降に起きた会話の agy（--print 付き）の引数 */
  const turnArgs = async (from) => (await argvList()).slice(from).filter((a) => a.some((x) => x.startsWith("--print")));
  const modelOf = (args) => (args.includes("--model") ? args[args.indexOf("--model") + 1] : null);

  try {
    // 一覧を覚える（ログインの確認が `agy models` を引く）
    await c.cmd("authStatus", { backend: "antigravity" });
    const before = await c.cmd("models", { backend: "antigravity" });
    t.ok("最初は agy の既定（Fake Flash (High)）に解決される", before[""]?.resolvesTo === "fake-flash-high", JSON.stringify(before[""]));

    const mark0 = (await argvList()).length;
    const first = await c.runTurn({ prompt: "こんにちは", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo", model: "" }, { ms: 60_000 });
    const firstArgs = await turnArgs(mark0);
    t.ok("「既定」のターンは、画面に出る既定のモデルを --model で明示する",
      first.outcome === "ok" && firstArgs.length === 1 && modelOf(firstArgs[0]) === "fake-flash-high" && !firstArgs[0].includes("--effort"),
      JSON.stringify(firstArgs));

    // agy 側で既定が変わる（/model で選び直した・agy の既定が更新された）
    await fs.writeFile(labelFile, "Fake Antigravity 1");
    await new Promise((r) => setTimeout(r, 300));
    let after = null;
    for (let i = 0; i < 100; i++) {
      after = await c.cmd("models", { backend: "antigravity" });
      if (after[""]?.resolvesTo === "fake-antigravity-1") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    t.ok("覚えた一覧が古くなると、一覧を読んだときに裏で引き直し、新しい既定に追う",
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
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
