// 思考の署名が通らなくなった Antigravity の会話（docs/multi-backend.md §2.8「思考の署名が通らない会話」）を server 越しに通す。
// **本物の agy は起動しない。** 身代わり（tests/lib/fake-agy.mjs）の poison-signature で、会話の id ごと（または全部）に
// step を出さない INVALID_ARGUMENT の ERROR を返させる。
//
// 確かめること: 再開した会話が何も実行せずに断られたら、記録を新しい会話へ引き継いで一度だけ送り直す・
// 引き継いだ記録で続く・発言が二重に入らない・当たらない 400 や step の始まった後の失敗では作り直さない・
// 作り直した会話もまた断られたら送信待ちの「失敗」で止まり、送り続けない
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";
import { rejectedBeforeRun } from "../../core/backends/antigravity.mjs";

export const name = "server-agy-thought-signature";
export const title = "思考の署名が通らない agy の会話を、記録を引き継いだ新しい会話で一度だけ送り直す";

const SIGNATURE_ERROR = "INVALID_ARGUMENT (code 400): Invalid thought signature.";

export default async function (t) {
  // ---- 当たり判定。ERROR・署名の文言・step 無し・本文無しが揃ったときだけ
  const hit = { status: "ERROR", error: SIGNATURE_ERROR, response: "" };
  t.ok("署名の断りで、step も本文も無いときだけ当たる",
    rejectedBeforeRun(hit)
      && rejectedBeforeRun({ ...hit, status: "error", error: "invalid THOUGHT signature" })
      && !rejectedBeforeRun({ ...hit, status: "SUCCESS" })
      && !rejectedBeforeRun({ ...hit, error: "INVALID_ARGUMENT (code 400): Request contains an invalid argument." })
      && !rejectedBeforeRun(hit, { steps: 1 })
      && !rejectedBeforeRun(hit, { sawText: true })
      && !rejectedBeforeRun({ ...hit, response: "返事" })
      && !rejectedBeforeRun(null));

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-sig-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const dataDir = path.join(scratch, "data");
  const argsFile = path.join(scratch, "agy-args.json");
  const promptLog = path.join(scratch, "agy-prompts.log");
  const signatureDir = path.join(scratch, "signature");
  const allMark = path.join(signatureDir, "all");

  /** 身代わりが起きた順の引数（会話の agy だけ） */
  const spawns = async () => JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]"));
  /** 身代わりが受け取ったプロンプトのうち、needle を含む行 */
  const prompts = async (needle) => (await fs.readFile(promptLog, "utf8").catch(() => "")).split("\n").filter((line) => line.includes(needle));
  const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

  // 既定が先から分かっている状態を作る一覧の写し。無いと、ターンのあいだに一覧が届いて渡すモデルが変わり、会話を --conversation で起こし直して揺れる
  await fs.mkdir(path.join(dataDir, "antigravity"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "antigravity", "models.json"), JSON.stringify({
    rows: [
      { id: "fake-antigravity-1", label: "Fake Antigravity 1" },
      { id: "fake-antigravity-2", label: "Fake Antigravity 2 (Thinking)" },
      { id: "fake-flash-high", label: "Fake Flash (High)" },
      { id: "fake-flash-low", label: "Fake Flash (Low)" },
    ],
    defaultLabel: "Fake Flash (High)", fetchedAt: Date.now(),
  }));

  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "antigravity",
      AGENT_HOST_AGY_BIN: `node "${fake}"`,
      FAKE_AGY_ARGS_FILE: argsFile,
      FAKE_AGY_PROMPT_LOG: promptLog,
      FAKE_AGY_SIGNATURE_DIR: signatureDir,
    },
    dataDir,
    timeoutMs: 30_000,
  });
  const c = await open({ port: server.port, token: server.token });

  const turn = (prompt, sessionId) => c.runTurn({ prompt, sessionId, cwd: ROOT, backend: "antigravity", mode: "yolo" }, { ms: 60_000 });
  /** 送信待ち越しに送り、そのターンの終わりまで待つ。目印から後の出来事と、送信待ちの項目を返す */
  const send = async (sessionId, messageId, prompt) => {
    const from = c.mark();
    await c.cmd("sendMessage", { sessionId, messageId, prompt });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === sessionId, { from, ms: 60_000 });
    // 送信待ちの書き換えはターンの終わりの後にも続く（閉じる・失敗の記録）。落ち着くまで少し待つ
    let item = null;
    for (let i = 0; i < 40; i++) {
      item = (await c.cmd("listMessages", { sessionId })).find((m) => m.id === messageId);
      if (item && item.status !== "sending") break;
      await sleep(50);
    }
    return { events: c.since(from), item };
  };
  const load = (sessionId) => c.cmd("loadSession", { sessionId });
  const userRows = (loaded, needle) => loaded.messages.filter((m) => m.role === "user" && String(m.text ?? "").includes(needle));
  const results = (events, sessionId) => events.filter((e) => e.type === "turnResult" && e.sessionId === sessionId);

  try {
    // ---- 1. 再開した会話が断られる → 記録を新しい会話へ引き継いで一度だけ送り直し、続ける
    const first = await turn("こんにちは", null);
    const sid = first.sessionId;
    const poisoned = await turn("poison-signature", sid);
    const marks = await fs.readdir(signatureDir).catch(() => []);
    t.ok("身代わりが会話の署名を壊す（準備）", first.outcome === "ok" && poisoned.outcome === "ok" && marks.length === 1, JSON.stringify({ first: first.outcome, poisoned: poisoned.outcome, marks }));
    const oldNative = marks[0];

    const spawnsBefore = (await spawns()).length;
    const recovered = await send(sid, "signature-001", "続きをお願い");
    const turnResults = results(recovered.events, sid);
    t.ok("送り直した 1 回で成功し、断りの失敗は画面に出さない",
      turnResults.length === 1 && turnResults[0].outcome === "ok", JSON.stringify(turnResults.map((e) => ({ outcome: e.outcome, error: e.error }))));
    t.ok("送信待ちの発言は送れたことになる（失敗・結果不明にしない）", recovered.item?.status === "sent", JSON.stringify(recovered.item));
    const after = (await spawns()).slice(spawnsBefore);
    t.ok("送り直しは --conversation を付けない新しい agy の会話で起こす",
      after.length >= 1 && !after.at(-1).includes("--conversation") && after.every((a) => !a.includes("--conversation") || flag(a, "--conversation") === oldNative),
      JSON.stringify(after.map((a) => flag(a, "--conversation"))));
    const sent = await prompts("続きをお願い");
    t.ok("発言は 2 回だけ届く（断られた 1 回と、引き継ぎの 1 回）", sent.length === 2, String(sent.length));
    t.ok("引き継ぎに前の記録（最初の発言・前の返事）が入る",
      sent[1]?.includes("HISTORY") && sent[1].includes("こんにちは") && sent[1].includes("署名を壊した") && !sent[0]?.includes("HISTORY"),
      sent[1]?.slice(0, 300));
    t.ok("引き継ぎに、断られた発言を記録として二重に入れない",
      (sent[1]?.match(/続きをお願い/g) ?? []).length === 1, String((sent[1]?.match(/続きをお願い/g) ?? []).length));
    t.ok("送り直した返事が届く", recovered.events.some((e) => e.type === "text.delta" && e.sessionId === sid && e.text.includes("了解")));

    const loaded = await load(sid);
    t.ok("会話の記録に発言が 1 回だけ、送った原文で並ぶ",
      userRows(loaded, "続きをお願い").length === 1 && userRows(loaded, "続きをお願い")[0].text === "続きをお願い",
      JSON.stringify(userRows(loaded, "続きをお願い").map((m) => m.text.slice(0, 80))));
    t.ok("前の記録も二重にならない", userRows(loaded, "こんにちは").length === 1 && userRows(loaded, "poison-signature").length === 1,
      JSON.stringify(loaded.messages.map((m) => `${m.role}:${String(m.text ?? "").slice(0, 20)}`)));
    const rebuilds = loaded.rebuilds ?? [];
    t.ok("作り直したことを区切り（recover）で 1 回だけ残す",
      rebuilds.length === 1 && rebuilds[0].kind === "recover" && rebuilds[0].phase === "complete", JSON.stringify(rebuilds));

    const spawnsBeforeNext = (await spawns()).length;
    const next = await turn("その次", sid);
    const nextSpawns = (await spawns()).slice(spawnsBeforeNext);
    const nextPrompt = await prompts("その次");
    t.ok("次の発言は新しい会話で続く（引き継ぎ直さない・壊れた会話へ戻らない）",
      next.outcome === "ok" && nextPrompt.length === 1 && !nextPrompt[0].includes("HISTORY")
        && nextSpawns.every((a) => flag(a, "--conversation") && flag(a, "--conversation") !== oldNative),
      JSON.stringify({ outcome: next.outcome, prompts: nextPrompt.length, spawns: nextSpawns.map((a) => flag(a, "--conversation")) }));
    t.ok("次の発言では区切りを足さない", ((await load(sid)).rebuilds ?? []).length === 1);

    // ---- 2. 作り直した会話もまた断られる → 送信待ちの「失敗」で止まり、送り続けない
    const second = await turn("はじめ", null);
    const sid2 = second.sessionId;
    await turn("poison-signature-all", sid2);
    const spawnsBeforeFail = (await spawns()).length;
    const failed = await send(sid2, "signature-002", "もう一度");
    const failResults = results(failed.events, sid2);
    t.ok("作り直した会話も断られたら失敗を 1 回だけ出す",
      failResults.length === 1 && failResults[0].outcome === "error", JSON.stringify(failResults.map((e) => ({ outcome: e.outcome, error: e.error }))));
    t.ok("送信待ちの発言は「失敗」（結果不明にしない）", failed.item?.status === "failed", JSON.stringify(failed.item));
    await sleep(1500);
    t.ok("送り直しは 1 回まで（発言は 2 回だけ届き、それ以上送らない）", (await prompts("もう一度")).length === 2, String((await prompts("もう一度")).length));
    t.ok("agy を起こすのも 2 回まで", (await spawns()).length - spawnsBeforeFail <= 2, String((await spawns()).length - spawnsBeforeFail));
    t.ok("断られた発言は会話の記録に入らない（送信待ちの失敗にだけ残る）", userRows(await load(sid2), "もう一度").length === 0);

    // 利用者が「再送する」を選ぶと（ここでは断りをやめておく）、失敗の発言を送り直し、記録の引き継ぎで続く
    await fs.rm(allMark, { force: true });
    const resumeFrom = c.mark();
    await c.cmd("messageAction", { sessionId: sid2, messageId: "signature-002", action: "retry" });
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === sid2, { from: resumeFrom, ms: 60_000 });
    let resent = null;
    for (let i = 0; i < 40 && resent?.status !== "sent"; i++) { resent = (await c.cmd("listMessages", { sessionId: sid2 })).find((m) => m.id === "signature-002"); if (resent?.status !== "sent") await sleep(50); }
    const loaded2 = await load(sid2);
    t.ok("再送すると続き、発言は記録に 1 回だけ並ぶ",
      resent?.status === "sent" && userRows(loaded2, "もう一度").length === 1 && (await prompts("もう一度")).length === 3,
      JSON.stringify({ status: resent?.status, rows: userRows(loaded2, "もう一度").length, prompts: (await prompts("もう一度")).length }));

    // ---- 3. 当たらない失敗では作り直さない
    const third = await turn("最初の発言", null);
    const sid3 = third.sessionId;
    const spawnsBeforeMiss = (await spawns()).length;
    const afterStep = await send(sid3, "mismatch-001", "signature-after-step");
    const otherCode = await send(sid3, "mismatch-002", "fail-400");
    const missSpawns = (await spawns()).slice(spawnsBeforeMiss);
    t.ok("step の始まった後の断り・署名でない 400 は失敗のまま（送り直さない）",
      results(afterStep.events, sid3).map((e) => e.outcome).join() === "error" && results(otherCode.events, sid3).map((e) => e.outcome).join() === "error"
        && (await prompts("signature-after-step")).length === 1 && (await prompts("fail-400")).length === 1,
      JSON.stringify({ afterStep: results(afterStep.events, sid3).map((e) => e.outcome), otherCode: results(otherCode.events, sid3).map((e) => e.outcome) }));
    t.ok("どちらも新しい会話を起こさない", missSpawns.every((a) => a.includes("--conversation")), JSON.stringify(missSpawns.map((a) => flag(a, "--conversation"))));
    // step が始まった発言は渡っている（送れた）。署名でない 400 は何か実行したかもしれないので結果不明。どちらも「失敗」（再開で送り直す）にしない
    t.ok("何か実行したかもしれない失敗は「失敗」にしない（step の後は送れた・署名でない 400 は結果不明）",
      afterStep.item?.status === "sent" && otherCode.item?.status === "unknown", JSON.stringify([afterStep.item?.status, otherCode.item?.status]));
    t.ok("区切りを残さない", ((await load(sid3)).rebuilds ?? []).length === 0);

    // ---- 4. 新しい会話が最初の発言で断られる → 作り直さず「失敗」
    await fs.mkdir(signatureDir, { recursive: true });
    await fs.writeFile(allMark, "");
    const fresh = await c.cmd("newSession", { backend: "antigravity", cwd: ROOT });
    const spawnsBeforeFresh = (await spawns()).length;
    const freshSend = await send(fresh.sessionId, "fresh-send-001", "新しく始める");
    t.ok("新しい会話の断りは送り直さず「失敗」",
      freshSend.item?.status === "failed" && (await prompts("新しく始める")).length === 1 && (await spawns()).length - spawnsBeforeFresh === 1,
      JSON.stringify({ status: freshSend.item?.status, prompts: (await prompts("新しく始める")).length, spawns: (await spawns()).length - spawnsBeforeFresh }));
    t.ok("新しい会話の断りでは区切りを残さない", ((await load(fresh.sessionId)).rebuilds ?? []).length === 0);
    await fs.rm(allMark, { force: true });
  } finally {
    c.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
