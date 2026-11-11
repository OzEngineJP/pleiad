// 開いている会話の宣言（loadSession の watch・watchSession）と、会話の一覧の使い回し（ADR 0024・docs/multi-backend.md §2.1）。
// fake バックエンドでサーバーを立て、宣言した接続と宣言していない接続の 2 本で確かめる。LLM もネットワークも要らない。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";
import { streamEvents } from "../../web/session-stream.mjs";

export const name = "server-watch";
export const title = "流れの出来事は開いている会話の分だけ届き、一覧は使い回しても古くならない";

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-watch-")));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const runner = await open({ port: server.port, token: server.token });
  const phone = await open({ port: server.port, token: server.token });
  const turn = { cwd: ROOT, backend: "fake", mode: "default" };
  const endOf = (c, id, from) => c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id, { ms: 20_000, from });
  const deltas = (c, from, id) => c.since(from).filter((e) => e.type === "text.delta" && e.sessionId === id).length;

  try {
    const x = (await runner.runTurn({ ...turn, prompt: "echo:ひとつめの会話", sessionId: null }, { ms: 20_000 })).sessionId;
    const y = (await runner.runTurn({ ...turn, prompt: "echo:ふたつめの会話", sessionId: null }, { ms: 20_000 })).sessionId;
    t.ok("会話が 2 つできる", Boolean(x && y && x !== y), JSON.stringify({ x, y }));

    // ---- 宣言した接続には、開いている会話の流れだけが届く ----
    await phone.cmd("loadSession", { sessionId: x, live: true, watch: true });
    let from = phone.mark(), runFrom = runner.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:開いていない会話の返答", sessionId: y });
    await endOf(phone, y, from);
    await sleep(50);
    t.ok("開いていない会話の本文の流れは届かない", deltas(phone, from, y) === 0, String(deltas(phone, from, y)));
    t.ok("開いていない会話の完了（turnEnd）は届く", phone.since(from).some((e) => e.type === "turnEnd" && e.sessionId === y));
    t.ok("宣言していない接続には今までどおり全部届く", deltas(runner, runFrom, y) > 0, String(deltas(runner, runFrom, y)));

    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:開いている会話の返答", sessionId: x });
    await endOf(phone, x, from);
    t.ok("開いている会話の流れは届く", deltas(phone, from, x) > 0, String(deltas(phone, from, x)));

    // ---- watchSession で開き直すと、届く会話が替わる ----
    await phone.cmd("watchSession", { sessionId: y });
    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:移った先の返答", sessionId: y });
    await runner.cmd("runTurn", { ...turn, prompt: "echo:移る前の会話の返答", sessionId: x }).catch(() => {});
    await Promise.all([endOf(phone, y, from), endOf(phone, x, from)]);
    await sleep(50);
    t.ok("watchSession の後は移った先の流れが届く", deltas(phone, from, y) > 0, String(deltas(phone, from, y)));
    t.ok("移る前の会話の流れは届かない", deltas(phone, from, x) === 0, String(deltas(phone, from, x)));

    // ---- main の窓口だけを宣言した接続（modal を開いていない）でも、流れ以外の出来事は、宣言していない接続と同じだけ届く ----
    // （スレッドの帯の「コンテキスト N%」・Channels の投稿・一覧の状態・通知は、開いていない会話の分も要る。ADR 0315 は絞りを広げるだけで、狭めない）
    {
      const nonStream = (c, f) => c.since(f).filter((e) => !streamEvents.has(e.type) && e.type !== "reply");
      const countsOf = (list) => list.reduce((m, e) => { const k = e.sessionId ? `${e.type}@${e.sessionId === x ? "x" : e.sessionId === y ? "y" : "?"}` : e.type; m[k] = (m[k] || 0) + 1; return m; }, {});
      from = phone.mark(); runFrom = runner.mark();
      await runner.cmd("runTurn", { ...turn, prompt: "echo:開いていない会話の分の出来事", sessionId: x });
      await Promise.all([endOf(phone, x, from), endOf(runner, x, runFrom)]);
      await sleep(100);
      const forPhone = countsOf(nonStream(phone, from)), forRunner = countsOf(nonStream(runner, runFrom));
      t.ok("開いていない会話の、流れ以外の出来事（一覧・使用量・通知など）が届く", Object.keys(forRunner).some((k) => k.endsWith("@x")), JSON.stringify(forRunner));
      t.ok("main の窓口だけの接続にも、流れ以外の出来事が宣言していない接続と同じだけ届く", JSON.stringify(forPhone) === JSON.stringify(forRunner), JSON.stringify({ forPhone, forRunner }));
    }

    // ---- 窓口は 2 つ（main と modal。ADR 0315）: 作業のダイアログが映す会話の流れも、メインの会話と並んで届く ----
    await phone.cmd("watchSession", { sessionId: x, slot: "modal" });
    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:メインの返答", sessionId: y });
    await runner.cmd("runTurn", { ...turn, prompt: "echo:モーダルの返答", sessionId: x });
    await Promise.all([endOf(phone, y, from), endOf(phone, x, from)]);
    t.ok("modal の窓口の会話の流れも届く（main の窓口と並ぶ）", deltas(phone, from, x) > 0 && deltas(phone, from, y) > 0, JSON.stringify({ x: deltas(phone, from, x), y: deltas(phone, from, y) }));
    await phone.cmd("watchSession", { sessionId: null, slot: "modal" });
    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:窓口を空にした後の返答", sessionId: x });
    await endOf(phone, x, from);
    await sleep(50);
    t.ok("modal の窓口を空にしたら、その会話の流れは届かない（main は変わらない）", deltas(phone, from, x) === 0, String(deltas(phone, from, x)));
    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:メインはそのまま", sessionId: y });
    await endOf(phone, y, from);
    t.ok("modal を空にしても main の会話の流れは届き続ける", deltas(phone, from, y) > 0, String(deltas(phone, from, y)));

    // ---- modal の窓口だけを宣言した接続（main を宣言していない）は絞られない。後から main を宣言すると modal も効き始める ----
    const lone = await open({ port: server.port, token: server.token });
    try {
      await lone.cmd("watchSession", { sessionId: x, slot: "modal" });
      from = lone.mark();
      await runner.cmd("runTurn", { ...turn, prompt: "echo:modal だけの接続への返答", sessionId: y });
      await endOf(lone, y, from);
      t.ok("main を宣言していない接続は、modal だけ宣言しても今までどおり全部届く", deltas(lone, from, y) > 0, String(deltas(lone, from, y)));
      const w = (await runner.runTurn({ ...turn, prompt: "echo:main に宣言する会話", sessionId: null }, { ms: 20_000 })).sessionId;
      await lone.cmd("watchSession", { sessionId: w, slot: "main" });
      from = lone.mark();
      await runner.cmd("runTurn", { ...turn, prompt: "echo:main を宣言した後の返答", sessionId: y });
      await runner.cmd("runTurn", { ...turn, prompt: "echo:modal の枠の会話の返答", sessionId: x });
      await Promise.all([endOf(lone, y, from), endOf(lone, x, from)]);
      await sleep(50);
      t.ok("main を宣言すると絞られ、modal の枠の会話だけが並んで届く", deltas(lone, from, y) === 0 && deltas(lone, from, x) > 0, JSON.stringify({ x: deltas(lone, from, x), y: deltas(lone, from, y) }));
    } finally { lone.close(); }

    // ---- 一覧の使い回し: 変えた直後の一覧に載る ----
    await runner.cmd("listSessions");
    await runner.cmd("setTitle", { sessionId: x, title: "付け直したタイトル" });
    const row = (await runner.cmd("listSessions")).find((s) => s.id === x);
    t.ok("タイトルを変えた直後の一覧に新しいタイトルが載る", row?.title === "付け直したタイトル", JSON.stringify(row?.title));
    const z = (await runner.runTurn({ ...turn, prompt: "echo:みっつめの会話", sessionId: null }, { ms: 20_000 })).sessionId;
    t.ok("作った直後の会話が一覧に載る", (await runner.cmd("listSessions")).some((s) => s.id === z));
    const fork = await runner.cmd("fork", { sessionId: z });
    const lineage = await runner.cmd("lineage", { sessionId: z });
    t.ok("分けた直後の枝が系譜に載る", lineage.sessions.some((s) => s.id === fork.sessionId), JSON.stringify(lineage.sessions.map((s) => s.id)));
  } finally {
    runner.close();
    phone.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
