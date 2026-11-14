// ツール呼び出しの入力（input）の大きい文字列を頭だけにして運び、行を開いたときに全文を取る（ADR 0334）の、サーバーを使わない部分。
//   - stubMessage: LAZY_MIN 以上の文字列だけを頭（INPUT_HEAD 字＋「…」）にして印（lazyInput = { size, sig, change? }）を付ける。元は変えない。運ばないもの（委譲・id なし・小さい入力）
//   - serveHistory / serveOlder: 頼みに lazyInput: true があるときだけ入力を印にする。無い頼み（古い画面）は全文のまま。窓の大きさ・署名は運ぶ形で数える
//   - 画面（renderToolCall）: 閉じた行は頭だけの入力で描く。開いたら /tool-input から全文を取って、開いた中身を描き直す。失敗は「もう一度」。古い呼び出しは取りに行かない
// サーバーを起動して /tool-input と応答の量を確かめる試験は tests/unit/server-tool-input.mjs
import { renderToolCall, applyToolResult } from "../../web/render.mjs";
import { lazyInputOf, toolInputUrl, isLazyInput, fetchToolInput } from "../../web/tool-input-lazy.mjs";
import {
  stubMessage, inputSig, serveHistory, syncRequest, joinReply, joinOlder, messageSig, anchorSig, windowStart,
  INPUT_HEAD, LAZY_MIN, WINDOW_BYTES,
} from "../../web/history-sync.mjs";

export const name = "tool-input-lazy";
export const title = "ツールの入力: 大きい文字列は頭だけにして運び、行を開いたときに全文を取る。古い頼みは全文のまま";

const at = n => new Date(Date.UTC(2026, 10, 15, 0, n)).toISOString();
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const size = x => JSON.stringify(x).length;
const bigCommand = (k, n = 120_000) => `echo head-${k}\n${"x".repeat(n)}\necho TAIL-${k}`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const hintsOf = () => ({ Edit: { shape: "edit" }, Write: { shape: "write" } });

/** 人と AI が交互に並ぶ n 件。AI の発言の 10 件に 1 件（i % 10 === 1）が大きいコマンドを持つ */
const conversation = n => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? { uuid: `u${i}`, role: "user", text: `質問 ${i}`, at: at(i), backend: "claude" }
  : { uuid: `a${i}`, role: "assistant", text: `答え ${i}`, at: at(i), backend: "claude",
    toolCalls: [{ id: `t${i}`, name: "Bash", input: { command: i % 10 === 1 ? bigCommand(i) : "ls", description: "実行" }, result: { text: "ok", isError: false } }] });

/** fetch を差し替えて fn を走らせる（取りに行った URL を返す） */
async function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  const urls = [];
  globalThis.fetch = (url, init) => { urls.push(String(url)); return impl(String(url), init); };
  try { await fn(urls); } finally { globalThis.fetch = saved; }
  return urls;
}
const jsonReply = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

/** 開く操作（stub の details は open を読めないので、読める口を足して toggle を流す） */
function openRow(card) {
  const details = card.querySelector(".tc-details");
  let opened = false;
  Object.defineProperty(details, "open", { configurable: true, get: () => opened, set: (v) => { opened = Boolean(v); } });
  details.open = true;
  details.dispatchEvent({ type: "toggle" });
}

export default async function (t) {
  // ---------------------------------------------------------------- 頭だけにして印を付ける
  const bash = { id: "c1", name: "Bash", input: { command: bigCommand(1), description: "実行" }, result: { text: "ok" } };
  const message = { role: "assistant", backend: "claude", toolCalls: [bash] };
  const stubbed = stubMessage(message, null, null);
  const call = stubbed.toolCalls[0];
  t.ok("印: 大きい文字列は頭（INPUT_HEAD 字）＋「…」になり、小さい文字列・ほかの欄・結果はそのまま",
    call.input.command === `${bash.input.command.slice(0, INPUT_HEAD)}…` && call.input.description === "実行" && call.result === bash.result && call.id === "c1");
  t.ok("印: lazyInput = { size: 入力の JSON の長さ, sig: inputSig } で、量を決められないとき（hints が無い）は change を付けない",
    call.lazyInput.size === size(bash.input) && call.lazyInput.sig === inputSig(bash.input) && !("change" in call.lazyInput));
  t.ok("印: 元の発言・入力は書き換えない", bash.input.command.length > LAZY_MIN && !("lazyInput" in bash) && message.toolCalls[0] === bash);
  t.ok("印: 同じ入力は 2 度目から作り直さず（頭が同じオブジェクト）、呼び出しの結果が後から付いても同じ印", (() => {
    const again = stubMessage({ ...message, toolCalls: [{ ...bash, result: { text: "別の結果" } }] }, null, null).toolCalls[0];
    return again.input === call.input && again.lazyInput.sig === call.lazyInput.sig && again.result.text === "別の結果";
  })());

  const small = { role: "assistant", toolCalls: [{ id: "s1", name: "Bash", input: { command: "x".repeat(LAZY_MIN - 1) } }] };
  t.ok("印: LAZY_MIN 未満の文字列だけの入力は、発言そのもの（写しを作らない）", stubMessage(small) === small);
  const edge = stubMessage({ role: "assistant", toolCalls: [{ id: "e1", name: "Bash", input: { command: "x".repeat(LAZY_MIN) } }] }).toolCalls[0];
  t.ok("印: ちょうど LAZY_MIN の文字列から印にする", edge.lazyInput && edge.input.command.length === INPUT_HEAD + 1);
  t.ok("印: 呼び出しの無い発言・toolCalls が配列でない発言はそのまま", (() => { const m = { role: "user", text: "x" }; return stubMessage(m) === m && stubMessage({ toolCalls: "x" }) !== null && stubMessage(null) === null; })());

  const nested = { id: "n1", name: "mcp__x__y", input: { files: [{ path: "a", diff: "d".repeat(5000) }, { path: "b", diff: "e" }], meta: { deep: { text: "t".repeat(3000) } }, n: 5, flag: true, nil: null } };
  const nestedStub = stubMessage({ toolCalls: [nested] }).toolCalls[0].input;
  t.ok("印: 配列・入れ子の中の大きい文字列も頭だけにし、小さい値・数・真偽・null は変えない",
    nestedStub.files[0].diff.length === INPUT_HEAD + 1 && nestedStub.files[1].diff === "e" && nestedStub.meta.deep.text.length === INPUT_HEAD + 1
    && nestedStub.n === 5 && nestedStub.flag === true && nestedStub.nil === null && nestedStub.files[0].path === "a");
  t.ok("印: 入れ子の外側の変わらない枝は元のオブジェクトを共有する（構造共有）", (() => {
    const shared = { keep: { a: 1 } };
    const input = { shared: shared.keep, big: "z".repeat(3000) };
    return stubMessage({ toolCalls: [{ id: "x", name: "T", input }] }).toolCalls[0].input.shared === shared.keep;
  })());

  // 切り口が絵文字などの組（サロゲートペア）の前半に当たるときは 1 字手前で切る（壊れた文字を作らない）
  const emoji = `${"a".repeat(INPUT_HEAD - 1)}😀${"b".repeat(3000)}`;
  const emojiHead = stubMessage({ toolCalls: [{ id: "em", name: "T", input: { text: emoji } }] }).toolCalls[0].input.text;
  t.ok("印: 頭の切り口が絵文字の組の途中なら 1 字手前で切る（半端なサロゲートを残さない）", emojiHead === `${"a".repeat(INPUT_HEAD - 1)}…` && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(emojiHead));

  // 深さの上限: これより深い大きい文字列は全文のまま運ぶ（壊れた・悪意のある入力でも全部は辿らない）
  let deep = { text: "d".repeat(3000) };
  for (let k = 0; k < 20; k++) deep = { next: deep };
  const deepCall = { id: "dp", name: "T", input: deep };
  t.ok("印: 深さの上限（16）より深い文字列は辿らず、全文のまま（その呼び出しは印にしない）", stubMessage({ toolCalls: [deepCall] }).toolCalls[0] === deepCall);

  // 運ばないもの
  const bigPrompt = { prompt: "p".repeat(5000), description: "調査" };
  const exempt = [
    { id: "d1", name: "Task", input: bigPrompt }, { id: "d2", name: "Agent", input: bigPrompt },
    { id: "d3", name: "mcp__ply_agents__ply_delegate", input: bigPrompt },
    { name: "Bash", input: { command: bigCommand(9) } }, { id: "", name: "Bash", input: { command: bigCommand(9) } },
    { id: "d4", name: "Bash", input: "文字列の入力 ".repeat(1000) }, { id: "d5", name: "Bash", input: null },
  ];
  t.ok("運ばないもの: 委譲（サブエージェント・ply_delegate）・id の無い呼び出し・オブジェクトでない入力は全文のまま",
    stubMessage({ toolCalls: exempt }).toolCalls.every((c, k) => c === exempt[k]));
  t.ok("運ばないもの: 委譲の名前の集合は発言の backend ごとに引く関数でも渡せる（その集合に入る名前は全文）",
    stubMessage({ backend: "codex", toolCalls: [{ id: "c9", name: "collabAgentToolCall", input: { prompt: "q".repeat(5000) } }] }, (b) => new Set([b === "codex" ? "collabAgentToolCall" : "-"])).toolCalls[0].lazyInput === undefined);

  // 変えた量（行の右端の「−N +M」）はサーバーが全文から数えて添える
  const write = { id: "w1", name: "Write", input: { file_path: "src/a.mjs", content: `${"行\n".repeat(3000)}終わり` } };
  const edit = { id: "e1", name: "Edit", input: { file_path: "src/b.mjs", old_string: `${"同じ\n".repeat(2000)}古い`, new_string: `${"同じ\n".repeat(2000)}新しい 1\n新しい 2` } };
  const [w, e, b] = stubMessage({ backend: "claude", toolCalls: [write, edit, { ...bash, id: "b9" }] }, null, hintsOf).toolCalls;
  t.ok("量: 書き込みは全文の行数、編集は前後の一致を除いた行数を change に添える（Write・Edit は名前で決まる）",
    same(w.lazyInput.change, { path: "src/a.mjs", del: 0, add: 3001 }) && same(e.lazyInput.change, { path: "src/b.mjs", del: 1, add: 2 }), JSON.stringify([w.lazyInput.change, e.lazyInput.change]));
  t.ok("量: 量を持たないと分かっているツール（hints がある）は change: null、hints が無ければ付けない", b.lazyInput.change === null && !("change" in stubMessage({ toolCalls: [{ ...bash, id: "b8" }] }).toolCalls[0].lazyInput));
  const shaped = stubMessage({ backend: "agy", toolCalls: [{ id: "g1", name: "write_to_file", input: { TargetFile: "x.txt", CodeContent: "a\n".repeat(2500) } }] }, null, () => ({ write_to_file: { shape: "write" } })).toolCalls[0];
  t.ok("量: バックエンドの申告（hints の shape）で種類を決めるツールも数える（agy の write_to_file）", same(shaped.lazyInput.change, { path: "x.txt", del: 0, add: 2501 }), JSON.stringify(shaped.lazyInput));
  const unshaped = stubMessage({ backend: "agy", toolCalls: [{ id: "g2", name: "write_to_file", input: { TargetFile: "x.txt", CodeContent: "a\n".repeat(2500) } }] }, null, () => ({ write_to_file: { shape: "other" } })).toolCalls[0];
  t.ok("量: 量を持つ申告の無いツール（hints はあるが shape が write・edit でない）は null", unshaped.lazyInput.change === null);

  // ---------------------------------------------------------------- serveHistory
  const server = { messages: conversation(40), presents: [], completedAt: 5, draft: null };
  const win = { lazy: true, tail: 12, tailBytes: 100_000 };
  const oldWin = serveHistory(clone(server), win);
  const newWin = serveHistory(clone(server), { ...win, lazyInput: true }, null, hintsOf);
  const bigIn = (messages) => messages.filter(m => m.toolCalls?.some(c => c.input?.command?.length > LAZY_MIN)).length;
  t.ok("古い画面（lazy だけ）: 入力は全文のまま・lazyInput の印は付かない", bigIn(oldWin.messages) === 1 && oldWin.messages.every(m => !m.toolCalls?.some(c => "lazyInput" in c)));
  t.ok("新しい頼み（lazyInput: true）: 大きい入力は頭だけで印が付く", bigIn(newWin.messages) === 0 && newWin.messages.some(m => m.toolCalls?.some(c => c.lazyInput?.sig === inputSig(server.messages[31].toolCalls[0].input))));
  t.ok("新しい頼み: 応答は古い頼みの 1/4 未満", size(newWin) < size(oldWin) / 4, `${size(oldWin)} → ${size(newWin)}`);
  t.ok("新しい頼み: 窓は運ぶ形の大きさで数えるので、頭だけの発言は大きさの目安に入らず、より多く運べる", newWin.messages.length > oldWin.messages.length && newWin.base < oldWin.base, `${oldWin.messages.length} → ${newWin.messages.length}`);
  t.ok("新しい頼み: windowStart も measure を渡せば同じ切り方", windowStart(server.messages, 12, 100_000, 40, m => size(stubMessage(m))) === newWin.base);
  const lazyInputOnly = serveHistory(clone(server), { lazyInput: true });
  t.ok("lazyInput だけ（窓なし）: lazy だけの頼みと同じ形の全量（base 0・total 40）で、入力は頭だけの印",
    lazyInputOnly.messages.length === 40 && lazyInputOnly.base === 0 && lazyInputOnly.total === 40 && bigIn(lazyInputOnly.messages) === 0
    && lazyInputOnly.messages.filter(m => m.toolCalls?.some(c => c.lazyInput)).length === 4);
  const plainAll = serveHistory(clone(server), {});
  t.ok("何も無い頼み（古い画面）は今までの形（全量・入力は全文・印なし）", plainAll.messages.length === 40 && bigIn(plainAll.messages) === 4 && plainAll.messages.every(m => !m.toolCalls?.some(c => "lazyInput" in c)));
  t.ok("lazyInput だけを持つ頼みの全量は、古い頼みの全量の署名と違う（頭だけの形で数える）", messageSig(lazyInputOnly.messages[1]) !== messageSig(plainAll.messages[1]) && messageSig(lazyInputOnly.messages[3]) === messageSig(plainAll.messages[3]));
  t.ok("壊れた引数（lazyInput が真偽でない）は印にしない", bigIn(serveHistory(clone(server), { ...win, lazyInput: "yes" }).messages) === 1);

  // 差分: 画面が持っている形（頭だけ）で署名を数えるので、同じ会話の続きの頼みは差分で返る
  const held = { messages: newWin.messages, presents: newWin.presents, base: newWin.base, presentBase: newWin.presentBase };
  const grown = { ...server, messages: [...server.messages, { uuid: "u40", role: "user", text: "続き", at: at(40), backend: "claude" }] };
  const request = syncRequest(held.messages, held.presents, { base: held.base, presentBase: held.presentBase });
  const diff = serveHistory(clone(grown), { ...win, lazyInput: true, ...request }, null, hintsOf);
  const joined = joinReply(held, diff, request);
  t.ok("差分: 頭だけの形で持った窓から続きを頼むと差分が返り、つなぐと新しく開いた窓と同じ", Boolean(joined) && "from" in diff
    && same(joined.messages, serveHistory(clone(grown), { ...win, lazyInput: true }, null, hintsOf).messages.slice(-joined.messages.length)), `from ${diff.from}`);
  // 全文の形で持った窓（古いサーバーから開いた）に、新しい頼みの差分が当たっても、頭だけの形と全文の形の署名は違うので、窓を返して持ち物を置き換える
  const heldFull = { messages: oldWin.messages, presents: oldWin.presents, base: oldWin.base, presentBase: oldWin.presentBase };
  const fullRequest = syncRequest(heldFull.messages, heldFull.presents, { base: heldFull.base, presentBase: heldFull.presentBase });
  const cross = serveHistory(clone(grown), { ...win, lazyInput: true, ...fullRequest }, null, hintsOf);
  t.ok("差分: 全文の形で持っている画面に頭だけの形の差分は合わず、窓を返す（持っている形と運ぶ形が混ざらない）", !("from" in cross) && bigIn(cross.messages) === 0);
  const sameForm = serveHistory(clone(grown), { ...win, ...fullRequest });
  t.ok("差分: 全文の形で持ち、全文の形で頼めば今までどおり差分で返る（新しい画面 × 古いサーバーの形）", "from" in sameForm && bigIn(sameForm.messages) <= 1);

  // 遡り
  const request2 = { before: held.base, count: 12, bytes: 100_000, check: anchorSig(held.messages[0]), presentBefore: held.presentBase };
  const older = serveHistory(clone(server), { lazy: true, lazyInput: true, older: request2 }, null, hintsOf);
  const olderJoin = joinOlder(held, older, request2);
  t.ok("遡り: 頭だけの形の手前の発言が来て、つなげる（check は頭だけの形の署名）", Boolean(olderJoin) && older.messages.length > 0 && bigIn(older.messages) === 0 && olderJoin.base < held.base, `base ${older.base}`);
  t.ok("遡り: 手前の大きい入力にも印が付く（i % 10 === 1 の AI の発言）", older.messages.some(m => m.toolCalls?.some(c => c.lazyInput)));
  const anchorAt = 31;
  const anchorFull = server.messages[anchorAt], anchorStub = stubMessage(anchorFull, null, hintsOf);
  const mid = (check, extra) => serveHistory(clone(server), { lazy: true, ...extra, older: { before: anchorAt, count: 6, bytes: 0, check, presentBefore: 0 } }, null, hintsOf);
  t.ok("遡り: 先頭の発言が大きい入力を持つとき、頭だけの形の署名なら合い、全文の形の署名は合わない（lazyInput の頼み）",
    mid(anchorSig(anchorStub), { lazyInput: true }).stale !== true && mid(anchorSig(anchorFull), { lazyInput: true }).stale === true);
  t.ok("遡り: 古い頼み（lazyInput なし）は全文の形の署名で合い、頭だけの形は合わない", mid(anchorSig(anchorFull), {}).stale !== true && mid(anchorSig(anchorStub), {}).stale === true);

  // 署名の中立: 頭だけの発言を、もう一度頭だけにしても変わらない（二重に頭にしない）
  t.ok("署名: 頭だけの発言を重ねて印にしても署名・形は変わらない（冪等）", stubMessage(stubbed) === stubbed && messageSig(stubMessage(stubbed)) === messageSig(stubbed));

  // ---------------------------------------------------------------- 画面（renderToolCall）
  const sessionId = "S1";
  const fullInput = { command: bigCommand(77, 6000), description: "ビルド" };
  const stubCall = stubMessage({ toolCalls: [{ id: "r77", name: "Bash", input: fullInput }] }, null, hintsOf).toolCalls[0];
  const lazy = lazyInputOf(stubCall, sessionId);
  t.ok("lazyInputOf: 印の無い呼び出し・会話 id / 呼び出し id の無いものは null、印があれば取りに行ける形",
    lazyInputOf({ id: "x", name: "Bash", input: {} }, sessionId) === null && lazyInputOf(stubCall, "") === null && lazyInputOf({ ...stubCall, id: "" }, sessionId) === null && lazyInputOf(null, sessionId) === null
    && isLazyInput(lazy) && lazy.sessionId === sessionId && lazy.id === "r77" && lazy.sig === stubCall.lazyInput.sig && lazy.size === stubCall.lazyInput.size && lazy.change === null);
  t.ok("isLazyInput: 会話 id・呼び出し id・sig の三つが無ければ取りに行けない", !isLazyInput(null) && !isLazyInput({ sessionId: "a", id: "b" }) && !isLazyInput({ sessionId: "a", sig: 1 }) && isLazyInput({ sessionId: "a", id: "b", sig: 0 }));
  t.ok("toolInputUrl: sessionId・id・sig を URL に入れる（sig が覚えの鍵になる）", toolInputUrl({ sessionId: "a b", id: "t/1", sig: 5 }) === "/tool-input?sessionId=a+b&id=t%2F1&sig=5");

  // 閉じた行は頭だけの入力で描き、取りに行かない。開くと取って、開いた中身を全文で描き直す
  const urls = await withFetch(() => jsonReply(fullInput), async (asked) => {
    const card = renderToolCall("Bash", stubCall.input, { id: "r77", lazyInput: lazy });
    t.ok("行: 閉じている間は頭だけで描き、全文の末尾は出さず、取りにも行かない", !card.outerHTML.includes("TAIL-77") && card.outerHTML.includes("head-77") && asked.length === 0 && card.toolInputLazy === true);
    t.ok("行: 行の右端の量（toolChange）は印の change を使う（量を持たないツールは null）", card.toolChange === null);
    applyToolResult(card, { text: "終わりました", isError: false });
    openRow(card);
    t.ok("行: 開いたら全文を取りに行き、その間は「読み込み中」の印を出す", asked.length === 1 && asked[0] === toolInputUrl(lazy) && card.outerHTML.includes("tc-lazy-note") && card.classList.contains("tc-lazy-loading"));
    await tick(); await tick();
    t.ok("行: 取れたら開いた中身が全文になり、読み込み中の印は消える", card.outerHTML.includes("TAIL-77") && !card.outerHTML.includes("tc-lazy-note") && !card.classList.contains("tc-lazy-loading") && card.toolInputLazy === false);
    t.ok("行: 描き直しても結果（出力）は積み直される", card.outerHTML.includes("終わりました") && card.toolResult?.text === "終わりました");
    t.ok("行: 描き直しても閉じた行の面（1 行目のラベル）は 1 つのまま", card.querySelectorAll(".tc-line").length === 1 && card.querySelectorAll(".tc-label").length === 1);
    card.querySelector(".tc-details").dispatchEvent({ type: "toggle" });
    await tick();
    t.ok("行: 開き直しても取り直さない（同じ呼び出しは 1 回だけ）", asked.length === 1);
    const second = renderToolCall("Bash", stubCall.input, { id: "r77", lazyInput: lazy });
    openRow(second); await tick(); await tick();
    t.ok("行: 同じ入力を別の行が開いても、取り直さずに覚えを使う", asked.length === 1 && second.outerHTML.includes("TAIL-77"));
  });
  t.ok("取り先: /tool-input?sessionId=S1&id=r77&sig=<署名>", urls[0] === `/tool-input?sessionId=S1&id=r77&sig=${stubCall.lazyInput.sig}`, urls[0]);

  // open: true で作った行（開いた状態の描き直し）は、すぐ全文を取る
  const eager = { command: bigCommand(88, 5000), description: "即" };
  const eagerCall = stubMessage({ toolCalls: [{ id: "r88", name: "Bash", input: eager }] }, null, hintsOf).toolCalls[0];
  await withFetch(() => jsonReply(eager), async (asked) => {
    const card = renderToolCall("Bash", eagerCall.input, { id: "r88", open: true, lazyInput: lazyInputOf(eagerCall, sessionId) });
    t.ok("行: 開いた状態で作った行は、作ってすぐ全文を取りに行く", asked.length === 1);
    await tick(); await tick();
    t.ok("行: 開いた状態で作った行も、取れたら全文になる", card.outerHTML.includes("TAIL-88"));
  });

  // 書き込み: 描き直した後の量は、印の量と同じ（サーバーが数えた量 = 画面が全文から数えた量）
  const writeInput = { file_path: "src/w.mjs", content: `${"行\n".repeat(2500)}終わり` };
  const writeCall = stubMessage({ backend: "claude", toolCalls: [{ id: "r99", name: "Write", input: writeInput }] }, null, hintsOf).toolCalls[0];
  await withFetch(() => jsonReply(writeInput), async () => {
    const card = renderToolCall("Write", writeCall.input, { id: "r99", lazyInput: lazyInputOf(writeCall, sessionId) });
    const before = clone(card.toolChange);
    openRow(card); await tick(); await tick();
    t.ok("量: 閉じた行は印の量（−0 +2501）で出し、開いて全文から数え直しても同じ", same(before, { path: "src/w.mjs", del: 0, add: 2501 }) && same(card.toolChange, before), JSON.stringify([before, card.toolChange]));
    t.ok("量: 描き直した開いた中身に全文の末尾が入る（書き込みの本文）", card.outerHTML.includes("終わり"));
  });

  // 失敗: 「読めませんでした」と「もう一度」を出し、押せば取り直す。失敗は覚えない
  let fails = 1;
  const flaky = { command: bigCommand(55, 4000) };
  const flakyCall = stubMessage({ toolCalls: [{ id: "r55", name: "Bash", input: flaky }] }, null, hintsOf).toolCalls[0];
  await withFetch(() => (fails-- > 0 ? jsonReply({}, 500) : jsonReply(flaky)), async (asked) => {
    const card = renderToolCall("Bash", flakyCall.input, { id: "r55", lazyInput: lazyInputOf(flakyCall, sessionId) });
    openRow(card); await tick(); await tick();
    const retry = card.querySelector(".btn");
    t.ok("失敗: 全文を読めなかったら理由の一文と「もう一度」を出し、頭だけの表示は残す", Boolean(retry) && card.outerHTML.includes("tc-lazy-note") && card.outerHTML.includes("role=\"alert\"") && !card.outerHTML.includes("TAIL-55") && !card.classList.contains("tc-lazy-loading"));
    retry.onclick({ preventDefault() {}, stopPropagation() {} });
    await tick(); await tick();
    t.ok("失敗: 「もう一度」で取り直せて、取れたら全文になる（失敗は覚えない）", asked.length === 2 && card.outerHTML.includes("TAIL-55") && !card.outerHTML.includes("tc-lazy-note"));
  });

  // 古い呼び出し（印なし）は今までどおり: 全文で描き、取りに行かない
  await withFetch(() => jsonReply({}), async (asked) => {
    const card = renderToolCall("Bash", fullInput, { id: "old1" });
    openRow(card); await tick();
    t.ok("古い呼び出し（印なし）: 全文で描き、開いても取りに行かない", card.outerHTML.includes("TAIL-77") && asked.length === 0 && !card.toolInputLazy);
    const unknown = renderToolCall("Bash", stubCall.input, { id: "r77", lazyInput: { sessionId: "", id: "r77", sig: 1 } });
    openRow(unknown); await tick();
    t.ok("会話 id の分からない印は取りに行かず、頭だけのまま（壊れない）", asked.length === 0 && !unknown.toolInputLazy);
  });

  // fetchToolInput: 同じ入力を続けて頼まれたら 1 度だけ。失敗は覚えない
  let count = 0;
  const ask = { sessionId: "S9", id: "k1", sig: 123 };
  await withFetch(() => { count++; return jsonReply({ ok: true }); }, async () => {
    const [a, b] = await Promise.all([fetchToolInput(ask), fetchToolInput(ask)]);
    t.ok("fetchToolInput: 同時の頼みは 1 度だけ取る", count === 1 && a.ok === true && b === a);
  });
  count = 0;
  await withFetch(() => { count++; return count === 1 ? Promise.reject(new Error("net")) : jsonReply({ ok: 2 }); }, async () => {
    const first = await fetchToolInput({ ...ask, id: "k2" }).catch(() => "failed");
    await tick();
    const second = await fetchToolInput({ ...ask, id: "k2" }).catch(() => "failed");
    t.ok("fetchToolInput: 失敗は覚えず、次の頼みは取り直す", first === "failed" && second.ok === 2 && count === 2);
  });
  t.ok("窓の大きさ（WINDOW_BYTES）は今までどおり", WINDOW_BYTES === 256 * 1024);
}
