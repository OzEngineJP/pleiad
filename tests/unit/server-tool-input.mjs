// ツール呼び出しの入力（input）の遅延をサーバー越しに確かめる（ADR 0334）。大きいコマンド・書き込みを持つ会話で、
//   - 窓・全量・遡り・差分のどれも、頼みに lazyInput: true があるときだけ入力の大きい文字列を頭だけの印にする。lazy だけの古い画面・頼みの無い読み出しは全文のまま
//   - 印の署名（lazyInput.sig）と GET /tool-input が合う: 全文を JSON で返し、長く覚えさせる。署名・呼び出し id が合わなければ返さない
//   - 窓は頭だけの形で数えるので、応答はずっと小さく、頭だけで持った窓から続きを頼むと差分で返る
//   - 委譲の呼び出し（Task）は全文のまま
//   - 走っているターンの発言（記録に載る前）からも、findToolInput が全文を返す
// 純粋な計算（stubMessage・画面の描き直し）の確認は tests/unit/tool-input-lazy.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { findToolInput } from "../../core/history.mjs";
import { syncRequest, joinReply, joinOlder, anchorSig, inputSig, INPUT_HEAD, LAZY_MIN } from "../../web/history-sync.mjs";

export const name = "server-tool-input";
export const title = "loadSession の入力の遅延: 大きい入力は頭だけの印、全文は /tool-input から。古い頼みは全文のまま";

const ID = "tool-input-120";
const start = Date.parse("2026-11-15T09:00:00+09:00");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const size = x => JSON.stringify(x).length;
const BIG = 150_000;

async function seed(dir, cwd) {
  await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
  const messages = [];
  for (let i = 0; i < 60; i++) {
    const at = k => new Date(start + (i * 3 + k) * 60_000).toISOString();
    messages.push({ role: "user", text: `質問 ${i}`, uuid: `claude:${ID}:u${i}`, at: at(0), backend: "claude" });
    const calls = [];
    if (i % 5 === 0) calls.push({ id: `bash${i}`, name: "Bash", input: { command: `echo head-${i}\n${"x".repeat(BIG)}\necho TAIL-${i}`, description: "巨大な実行" }, result: { text: "ok", isError: false, truncated: false } });
    else calls.push({ id: `read${i}`, name: "Read", input: { file_path: `src/m${i}.mjs` }, result: { text: `行 ${i}\n`.repeat(20), isError: false, truncated: false } });
    if (i === 10) calls.push({ id: "write10", name: "Write", input: { file_path: "src/big.mjs", content: `${"行\n".repeat(4000)}終わり` }, result: { text: "ok", isError: false, truncated: false } });
    if (i === 20) calls.push({ id: "task20", name: "Task", input: { description: "調査", prompt: `${"依頼 ".repeat(2000)}終わり` }, result: { text: "調べ終わりました", isError: false, truncated: false } });
    messages.push({ role: "assistant", text: `答え ${i}`, uuid: `claude:${ID}:a${i}`, at: at(1), backend: "claude", toolCalls: calls });
  }
  const info = { sessionId: ID, title: "Tool input", cwd, createdAt: start, lastModified: Date.parse(messages.at(-1).at) };
  await fs.writeFile(path.join(dir, "conversations", `${ID}.json`), JSON.stringify({ messages }));
  await fs.writeFile(path.join(dir, "conversations.json"), JSON.stringify({
    [ID]: { segments: [{ backend: "claude", nativeId: `n-${ID}` }], info, backend: "fake", nativeId: null, base: messages.length },
  }));
  await fs.writeFile(path.join(dir, "sessions.json"), JSON.stringify({
    [ID]: { backend: "fake", title: info.title, cwd, createdAt: info.createdAt, lastModified: info.lastModified },
  }));
  return messages;
}

const callsOf = (messages) => messages.flatMap(m => m.toolCalls ?? []);
// 全文のままの大きい入力の数（委譲の Task は運ぶ形でも全文なので数えない）
const bigStrings = (messages) => callsOf(messages).filter(c => c.name !== "Task" && JSON.stringify(c.input).length >= LAZY_MIN).length;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-tool-input-"));
  const cwd = path.join(scratch, "work");
  await fs.mkdir(cwd, { recursive: true });
  const seeded = await seed(scratch, cwd);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: scratch });
  let client;
  try {
    client = await open(server);
    const http = (url, init) => fetch(`http://127.0.0.1:${server.port}${url}${url.includes("?") ? "&" : "?"}token=${server.token}`, init);
    const toolInput = (id, sig, extra = "") => http(`/tool-input?sessionId=${ID}&id=${encodeURIComponent(id)}&sig=${sig}${extra}`);
    const original = (id) => callsOf(seeded).find(c => c.id === id).input;

    // ---------------------------------------------------------------- 頼み方ごとの形
    const full = await client.cmd("loadSession", { sessionId: ID });
    t.ok("（前提）頼みの無い読み出し（古い画面）は全量で、入力は全文・印なし",
      full.messages.length === 120 && bigStrings(full.messages) === 13 && callsOf(full.messages).every(c => !("lazyInput" in c)), `${bigStrings(full.messages)}`);
    const fullSize = size(full);

    const win = { lazy: true, tail: 30, tailBytes: 256 * 1024 };
    const old = await client.cmd("loadSession", { sessionId: ID, ...win });
    t.ok("古い画面（lazy だけ）: 窓の入力は全文のまま・印なし（古い画面は印を読めない）", bigStrings(old.messages) > 0 && callsOf(old.messages).every(c => !("lazyInput" in c)));

    const next = await client.cmd("loadSession", { sessionId: ID, ...win, lazyInput: true });
    const stubs = callsOf(next.messages).filter(c => c.lazyInput);
    t.ok("新しい頼み（lazyInput: true）: 大きい入力は頭だけの印になり、応答は古い画面の窓の 1/5 未満",
      stubs.length > 0 && stubs.filter(c => c.name === "Bash").every(c => c.input.command.length === INPUT_HEAD + 1 && c.input.description === "巨大な実行") && size(next) < size(old) / 5, `${size(old)} → ${size(next)}（全量 ${fullSize}）`);
    t.ok("新しい頼み: 窓は頭だけの形で数えるので、古い画面の窓より手前まで運ぶ（base が小さい）", next.base < old.base, `${old.base} → ${next.base}`);
    t.ok("新しい頼み: 小さい入力（Read）は印にせずそのまま", callsOf(next.messages).filter(c => c.name === "Read").every(c => !c.lazyInput && typeof c.input.file_path === "string"));

    const everything = await client.cmd("loadSession", { sessionId: ID, lazyInput: true });
    const bash0 = callsOf(everything.messages).find(c => c.id === "bash0");
    t.ok("lazyInput だけ（窓なし）: 全量の並びで、入力だけが頭と印になる",
      everything.messages.length === 120 && bigStrings(everything.messages) === 0 && bash0.input.command.startsWith("echo head-0\n")
      && bash0.lazyInput.sig === inputSig(original("bash0")) && bash0.lazyInput.size === size(original("bash0")) && size(everything) < fullSize / 10);
    t.ok("lazyInput 以外の呼び出しの欄（id・name・result）は変えない",
      same(callsOf(everything.messages).map(c => [c.id, c.name, c.result]), callsOf(full.messages).map(c => [c.id, c.name, c.result])));

    // 書き込みの量は、サーバーが全文から数えて印に添える（fake のバックエンドは hints を持たないが、Write は名前で量を持つと分かる）
    const write = callsOf(everything.messages).find(c => c.id === "write10");
    t.ok("量: 書き込みの量（−0 +4001）を印に添える（画面は全文を取らずに行の右端を出せる）", same(write.lazyInput.change, { path: "src/big.mjs", del: 0, add: 4001 }), JSON.stringify(write.lazyInput));

    // 委譲は全文のまま
    const task = callsOf(everything.messages).find(c => c.id === "task20");
    t.ok("委譲（Task）の入力は全文のまま運び、印を付けない（依頼文を画面の状態から読む）", !task.lazyInput && task.input.prompt === original("task20").prompt);

    // 壊れた値は印にしない
    const weird = await client.cmd("loadSession", { sessionId: ID, ...win, lazyInput: "yes" });
    t.ok("lazyInput が真偽でない頼みは古い頼みとして全文を返す", callsOf(weird.messages).every(c => !c.lazyInput) && bigStrings(weird.messages) > 0);

    // ---------------------------------------------------------------- /tool-input
    const target = stubs.find(c => c.id.startsWith("bash"));
    const res = await toolInput(target.id, target.lazyInput.sig);
    const body = await res.json();
    t.ok("全文: GET /tool-input が入力をそのまま JSON で返す", res.status === 200 && same(body, original(target.id)), `${res.status}`);
    t.ok("全文: 長く覚えさせ（immutable）、直に開かれても実行されない形（nosniff・sandbox・JSON）",
      /max-age=31536000/.test(res.headers.get("cache-control") ?? "") && /immutable/.test(res.headers.get("cache-control") ?? "")
      && res.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(res.headers.get("content-security-policy") ?? "")
      && /^application\/json/.test(res.headers.get("content-type") ?? "") && /Accept-Encoding/i.test(res.headers.get("vary") ?? ""));
    t.ok("全文: 末尾まで欠けず返る（頭だけの入力には無い部分）", body.command.endsWith(`echo TAIL-${target.id.slice(4)}`) && body.command.length > BIG);

    const gz = await toolInput(target.id, target.lazyInput.sig, "");
    t.ok("全文: 受け手が gzip を受けるときは縮めて返す（fetch は既定で gzip を受け、自分で戻す）",
      gz.headers.get("content-encoding") === "gzip" && same(await gz.json(), original(target.id)));
    const plain = await http(`/tool-input?sessionId=${ID}&id=${target.id}&sig=${target.lazyInput.sig}`, { headers: { "accept-encoding": "identity" } });
    const plainText = await plain.text();
    t.ok("全文: gzip を受けない受け手には縮めずに返す", !plain.headers.get("content-encoding") && JSON.parse(plainText).command.length > BIG && Number(plain.headers.get("content-length")) === Buffer.byteLength(plainText));

    const head = await http(`/tool-input?sessionId=${ID}&id=${target.id}&sig=${target.lazyInput.sig}`, { method: "HEAD", headers: { "accept-encoding": "identity" } });
    t.ok("全文: HEAD は本文なしで同じ見出しを返す", head.status === 200 && (await head.text()) === "" && Number(head.headers.get("content-length")) === Buffer.byteLength(plainText));

    const wrongSig = await toolInput(target.id, target.lazyInput.sig + 1);
    t.ok("全文: 署名が合わなければ別の入力を返さず 404（覚えさせない）", wrongSig.status === 404 && /no-store/.test(wrongSig.headers.get("cache-control") ?? "") && !/immutable/.test(wrongSig.headers.get("cache-control") ?? ""));
    const other = callsOf(everything.messages).find(c => c.id === "bash5");
    const crossed = await toolInput(target.id, other.lazyInput.sig);
    t.ok("全文: 別の呼び出しの署名を付けても返さない（id と署名の両方が合うものだけ）", crossed.status === 404);
    const missing = await toolInput("nothing", target.lazyInput.sig);
    t.ok("全文: 無い呼び出し id は 404", missing.status === 404);
    const unknownSession = await http(`/tool-input?sessionId=nothing-here&id=${target.id}&sig=${target.lazyInput.sig}`);
    t.ok("全文: 無い会話は 404（エラーにしない）", unknownSession.status === 404);
    const noSig = await http(`/tool-input?sessionId=${ID}&id=${target.id}`);
    const badSig = await http(`/tool-input?sessionId=${ID}&id=${target.id}&sig=abc`);
    const noId = await http(`/tool-input?sessionId=${ID}&sig=1`);
    const noSession = await http(`/tool-input?id=${target.id}&sig=1`);
    t.ok("全文: 頼みが壊れていれば 400（署名なし・数でない署名・id なし・会話なし）", [noSig, badSig, noId, noSession].every(r => r.status === 400));
    const longId = await http(`/tool-input?sessionId=${ID}&id=${"a".repeat(600)}&sig=1`);
    t.ok("全文: 長すぎる id は 400", longId.status === 400);
    const noToken = await fetch(`http://127.0.0.1:${server.port}/tool-input?sessionId=${ID}&id=${target.id}&sig=${target.lazyInput.sig}`);
    const presentNoToken = await fetch(`http://127.0.0.1:${server.port}/present-body?sessionId=${ID}&i=0&field=content`);
    t.ok("全文: 認証（token）が無ければ返さない（/present-body と同じ扱い）", noToken.status >= 400 && noToken.status === presentNoToken.status && !(await noToken.text()).includes("TAIL"), `${noToken.status}`);

    // ---------------------------------------------------------------- 差分
    let held = { messages: next.messages, presents: next.presents, base: next.base, presentBase: next.presentBase };
    const request = syncRequest(held.messages, held.presents, { base: held.base, presentBase: held.presentBase });
    const diff = await client.cmd("loadSession", { sessionId: ID, ...win, lazyInput: true, ...request });
    const joined = joinReply(held, diff, request);
    t.ok("差分: 頭だけの形で持った窓から頼むと、変わりが無ければ差分で返り、つなぐと窓と同じ（署名は頭だけの形で数える）",
      Boolean(joined) && "from" in diff && same(joined.messages, next.messages) && joined.base === next.base && size(diff) < size(next) / 3, `from ${diff.from}・${size(diff)}`);
    // 全文の形で持った窓（古いサーバー・古い画面から開いた）に新しい頼みは、署名が合わず窓を返す（形が混ざらない）
    const heldOld = { messages: old.messages, presents: old.presents, base: old.base, presentBase: old.presentBase };
    const mixed = await client.cmd("loadSession", { sessionId: ID, ...win, lazyInput: true, ...syncRequest(heldOld.messages, heldOld.presents, { base: heldOld.base, presentBase: heldOld.presentBase }) });
    t.ok("差分: 全文の形で持つ窓に新しい頼みの差分は合わず、頭だけの窓を返す", !("from" in mixed) && bigStrings(mixed.messages) === 0 && mixed.base === next.base);
    const sameOld = await client.cmd("loadSession", { sessionId: ID, ...win, ...syncRequest(heldOld.messages, heldOld.presents, { base: heldOld.base, presentBase: heldOld.presentBase }) });
    t.ok("差分: 全文の形で持ち全文の形で頼む（古い画面・古いサーバーの形）は今までどおり差分", "from" in sameOld && sameOld.base === old.base && sameOld.from === old.base + old.messages.length - 2 && sameOld.messages.length === 2 && same(sameOld.messages, old.messages.slice(-2)),
      JSON.stringify({ from: sameOld.from, n: sameOld.messages.length, base: sameOld.base, oldBase: old.base }));

    // ---------------------------------------------------------------- 遡り
    let have = held, loads = 0, stale = false;
    while (have.base > 0 && loads < 20) {
      const older = { before: have.base, count: 30, bytes: 256 * 1024, check: anchorSig(have.messages[0]), presentBefore: have.presentBase };
      const reply = await client.cmd("loadSession", { sessionId: ID, lazy: true, lazyInput: true, older });
      const next2 = joinOlder(have, reply, older);
      if (!next2) { stale = true; break; }
      have = next2;
      loads++;
    }
    t.ok("遡り: 頭だけの形のまま base が 0 になるまで続けて取れ、つないだ並びは lazyInput の全量と同じ",
      !stale && have.base === 0 && loads >= 1 && same(have.messages, everything.messages), `${loads} 回`);
    t.ok("遡り: 手前の応答にも入力の全文は含まれず、頭だけの印が付く", bigStrings(have.messages) === 0 && callsOf(have.messages).some(c => c.lazyInput));
    const oldOlder = await client.cmd("loadSession", { sessionId: ID, lazy: true, older: { before: old.base, count: 30, bytes: 256 * 1024, check: anchorSig(old.messages[0]), presentBefore: 0 } });
    t.ok("遡り: lazyInput の無い古い頼みは、手前の入力も全文", oldOlder.stale !== true && callsOf(oldOlder.messages).every(c => !c.lazyInput));
    // 遡りの合図の発言（before の位置）が大きい入力を持つとき: 頭だけの形の署名は合い、全文の形の署名は合わない（形を混ぜない）
    const anchorAt = seeded.findIndex((m, k) => k > 10 && m.toolCalls?.some(c => c.id === "bash5"));
    const anchorStub = everything.messages[anchorAt], anchorFull = seeded[anchorAt];
    const olderAt = (check, extra = {}) => client.cmd("loadSession", { sessionId: ID, lazy: true, ...extra, older: { before: anchorAt, count: 6, bytes: 0, check, presentBefore: 0 } });
    t.ok("遡り: 合図の発言が大きい入力を持つとき、lazyInput の頼みは頭だけの形の署名で合い、全文の形の署名は stale",
      anchorStub.toolCalls.some(c => c.lazyInput) && (await olderAt(anchorSig(anchorStub), { lazyInput: true })).stale !== true && (await olderAt(anchorSig(anchorFull), { lazyInput: true })).stale === true);
    t.ok("遡り: 古い頼みは全文の形の署名で合い、頭だけの形の署名は stale",
      (await olderAt(anchorSig(anchorFull))).stale !== true && (await olderAt(anchorSig(anchorStub))).stale === true);

    // ---------------------------------------------------------------- findToolInput（走っているターンの発言）
    const live = [{ role: "assistant", toolCalls: [{ id: "live1", name: "Bash", input: { command: "y".repeat(5000) } }] }];
    const liveInput = live[0].toolCalls[0].input;
    const backend = { getMessages: async () => seeded };
    const viaLive = await findToolInput(ID, backend, { id: "live1", sig: inputSig(liveInput), extra: live });
    t.ok("findToolInput: 走っているターンの発言（記録に載る前）からも全文を返す", same(viaLive, liveInput));
    t.ok("findToolInput: 記録からも見つかる", same(await findToolInput(ID, backend, { id: "write10", sig: inputSig(original("write10")) }), original("write10")));
    t.ok("findToolInput: 署名が違う・id が無い・会話 id が無い・backend が読み出せないときは null",
      (await findToolInput(ID, backend, { id: "live1", sig: 0, extra: live })) === null
      && (await findToolInput(ID, backend, { id: "", sig: 1 })) === null
      && (await findToolInput("", backend, { id: "write10", sig: 1 })) === null
      && (await findToolInput(ID, {}, { id: "write10", sig: inputSig(original("write10")) })) === null
      && (await findToolInput(ID, null, { id: "write10", sig: Number.NaN })) === null);
    t.ok("findToolInput: 入力がオブジェクトでない呼び出しは返さない", (await findToolInput(ID, { getMessages: async () => [{ toolCalls: [{ id: "s", input: "x" }] }] }, { id: "s", sig: inputSig("x") })) === null);
  } finally {
    client?.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
