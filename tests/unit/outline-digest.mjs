// 系譜の照合用の概要（outline の digest。web/outline.mjs・ADR 0333）。
// 本文を運ばず、本文とツール名の指紋 fp と人の発言の抜粋 ex だけにしても、分岐点の判定・札の抜粋・窓の手前の埋めが
// 全文のときと同じ結果になること、新旧の画面とサーバーの組み合わせで壊れないことを見る。
import { createBranches, commonPrefix } from "../../web/branches.mjs";
import { digestOf, excerptOf, fingerprint, isDigest, promptExcerpt } from "../../web/outline.mjs";

export const name = "outline-digest";
export const title = "系譜の概要（digest）は、全文のときと同じ分岐点・札の抜粋・窓の手前の埋めになる";

const msg = (role, text, uuid, extra = {}) => ({ role, text, uuid, at: null, ...extra });
const tool = (name) => ({ id: name, name, input: { big: "x".repeat(50) }, result: "r".repeat(50) });
/** 線を通した形（サーバーが JSON にして画面が読む） */
const wire = (list) => JSON.parse(JSON.stringify(list));
const digestList = (list) => wire(list.map(digestOf));

const parent = [
  msg("user", "こんにちは", "p0"),
  msg("assistant", "", "p1", { toolCalls: [tool("Read")] }),
  msg("assistant", "", "p2", { thinking: "考え中" }),
  msg("assistant", "こんにちは！", "p3"),
  msg("user", "続けて", "p4"),
  msg("assistant", "続けます", "p5", { tools: ["Bash"] }),
];
const copy = (m, i, who = "c") => ({ ...m, uuid: `${who}${i}` });
const child = [...parent.slice(0, 4).map((m, i) => copy(m, i)), msg("user", "別の話", "c4"), msg("assistant", "はい", "c5")];

/** 家族を読む fake。mode: "new"（digest を頼まれたら digest を返す）/ "old"（outline を真偽として読む古いサーバー。全文の形で返す）/ "full"（基準。今までの outline: true の返事と同じ） */
function serverCmd(lineage, histories, { mode = "new", seen = [] } = {}) {
  return async (command, args, opts) => {
    if (command === "lineage") return lineage;
    if (command !== "loadSession") throw new Error(`知らない command: ${command}`);
    seen.push({ args, opts });
    const list = histories[args.sessionId] ?? [];
    const full = wire(list.map((m) => ({
      uuid: m.uuid, role: m.role, text: m.text, tools: m.tools,
      ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ name: c.name })) } : {}),
    })));
    if (mode === "new" && args.outline?.digest === true) return { messages: digestList(list) };
    return { messages: full };
  };
}

const lineage = {
  rootId: "P",
  sessions: [
    { id: "P", title: "同じ題", parent: null, createdAt: "2026-01-01T00:00:00Z", lastModified: 1 },
    { id: "C", title: "同じ題", parent: { sessionId: "P", atMessage: "p3" }, createdAt: "2026-01-02T00:00:00Z", lastModified: 2 },
    { id: "D", title: "同じ題", parent: { sessionId: "P", atMessage: null }, createdAt: "2026-01-03T00:00:00Z", lastModified: 3 },
    { id: "E", title: "別の題", parent: { sessionId: "P", atMessage: null }, createdAt: "2026-01-04T00:00:00Z", lastModified: 4 },
  ],
};
const said = (who, text) => [...parent.slice(0, 4).map((m, i) => copy(m, i, who)), msg("user", text, `${who}u`), msg("assistant", "はい", `${who}a`)];
const long = "React のまま\n  直して。".padEnd(40, "　") + " 先頭の 200 字より後ろまで続く依頼文。".repeat(30);
const histories = {
  P: parent,
  C: said("c", long),
  D: said("d", "Vue で書き直して"),
  E: said("e", "   \n  "),   // 空白だけの人の発言は抜粋にしない
};

/** 家族の写しから、画面が読む結果を全部取り出す（札の抜粋・分岐点・境） */
async function observe(cmd, currentId, window = null) {
  const b = createBranches({ cmd, titleOf: (id) => lineage.sessions.find((s) => s.id === id)?.title });
  const current = window ? window.messages : histories[currentId];
  await b.load(currentId, current, window ? { base: window.base } : {});
  const out = { rows: {}, junctions: {}, boundaries: {}, distinguish: {} };
  for (const [id, r] of b.family.rows) out.rows[id] = { k: r.k, length: r.messages.length };
  for (const id of b.family.rows.keys()) {
    out.junctions[id] = [...b.junctions(id)].map(([k, v]) => [k, v.map((e) => ({ ...e }))]);
    for (const other of b.family.rows.keys()) out.boundaries[`${id}>${other}`] = b.boundary(id, other);
  }
  const cut = b.junctions(currentId).get(3) ?? [];
  const entries = [{ id: currentId, name: b.nameOf(currentId), n: 2 }, ...cut];
  // 窓のときは今の枝の履歴を渡さず、家族の写し（手前の概要 + 窓）から読む（web/client.mjs の placeJunctions と同じ）
  out.distinguish = b.distinguish(entries, window ? { id: currentId, messages: undefined } : { id: currentId, messages: histories[currentId] });
  return out;
}

export default async function (t) {
  // ---- 概要の形
  const d = digestList(parent);
  t.ok("概要は uuid・役割・指紋だけで、本文もツールの入出力も運ばない",
    d.every((m, i) => m.uuid === parent[i].uuid && m.role === parent[i].role && Number.isSafeInteger(m.fp)
      && !("text" in m) && !("toolCalls" in m) && !("tools" in m) && !("thinking" in m)), JSON.stringify(d));
  t.ok("概要の判定と抜粋は人の発言で本文があるときだけ", d[0].ex === "こんにちは" && d[4].ex === "続けて" && d.filter((m) => "ex" in m).length === 2, JSON.stringify(d));
  t.ok("空白だけの人の発言は抜粋を持たない", !("ex" in digestOf(msg("user", "  \n ", "u"))) && !("ex" in digestOf(msg("user", "", "u"))) && !("ex" in digestOf({ role: "user", uuid: "u" })));
  t.ok("isDigest は指紋の有無で見分ける", d.every(isDigest) && parent.every((m) => !isDigest(m)));
  t.ok("指紋は線を通っても同じ（53 ビットの整数）", d.every((m, i) => m.fp === fingerprint(parent[i])));
  t.ok("本文が違えば指紋が違う", fingerprint(msg("user", "あ", "a")) !== fingerprint(msg("user", "い", "a")));
  t.ok("ツール名が違えば指紋が違う", fingerprint(msg("assistant", "", "a", { toolCalls: [tool("Read")] })) !== fingerprint(msg("assistant", "", "a", { toolCalls: [tool("Write")] })));
  t.ok("ツールの入出力が違っても指紋は同じ（照合は名前だけ）",
    fingerprint(msg("assistant", "", "a", { toolCalls: [tool("Read")] })) === fingerprint(msg("assistant", "", "b", { toolCalls: [{ name: "Read", input: 1 }] })));
  t.ok("本文が無いのと空は同じ指紋", fingerprint({ role: "assistant", uuid: "a" }) === fingerprint(msg("assistant", "", "b")));

  // ---- 抜粋は全文から取るときと同じ
  const spaced = "  先頭の  空白と\n\n改行を\t畳む。" + "あ".repeat(300);
  t.ok("概要の抜粋は全文の抜粋と同じ（畳んで 200 字）", promptExcerpt(digestOf(msg("user", spaced, "u"))) === excerptOf(spaced) && excerptOf(spaced).length === 200);
  t.ok("全文の発言の抜粋は今までの excerptOf のまま", promptExcerpt(msg("user", "a\n b", "u")) === "a b");

  // ---- commonPrefix は、全文・概要のどの組み合わせでも同じ
  const variants = {
    "同じ履歴": [parent, parent.map((m, i) => copy(m, i))],
    "uuid が全部違う子": [parent, child],
    "本文で止まる": [parent, [parent[0], msg("assistant", "違う", "x")]],
    "ツール名で止まる": [[msg("assistant", "", "a", { toolCalls: [tool("Read")] })], [msg("assistant", "", "b", { toolCalls: [tool("Write")] })]],
    "役割だけ違う": [[msg("user", "同じ", "a")], [msg("assistant", "同じ", "b")]],
    "uuid が同じなら中身が違っても同じ発言": [[msg("user", "前", "same")], [msg("user", "後", "same")]],
    "空の本文と本文なし": [[{ role: "assistant", uuid: "a" }], [msg("assistant", "", "b")]],
    "片方が短い": [parent.slice(0, 2), parent],
  };
  for (const [label, [a, b]] of Object.entries(variants)) {
    const want = commonPrefix(a, b);
    const got = [commonPrefix(digestList(a), b), commonPrefix(a, digestList(b)), commonPrefix(digestList(a), digestList(b))];
    t.ok(`commonPrefix（${label}）: 全文どうしと概要を交えた 3 通りが同じ`, got.every((n) => n === want), `${want} ← ${got}`);
  }

  // ---- 家族の読み込み: 新しいサーバー（digest）・古いサーバー（全文の形）・outline: true だけを読む古いサーバーのどれでも、全文のときと同じ
  const base = await observe(serverCmd(lineage, histories, { mode: "full" }), "C");
  t.ok("基準（全文の形）で分岐点が決まる", base.rows.C.k === 3 && base.rows.D.k === 3 && base.rows.E.k === 3, JSON.stringify(base.rows));
  const excerpts = Object.fromEntries(base.distinguish.map((e) => [e.id, e.excerpt]));
  t.ok("基準の札の抜粋は、分岐後の最初の人の発言（200 字まで・空白は畳む）",
    excerpts.P === "続けて" && excerpts.D === "Vue で書き直して" && excerpts.C === excerptOf(long) && excerptOf(long).length === 200 && excerpts.E === undefined,
    JSON.stringify(excerpts));
  for (const mode of ["new", "old"]) {
    const seen = [];
    const got = await observe(serverCmd(lineage, histories, { mode, seen }), "C");
    t.ok(`家族の読み込み（${mode}）: 札・分岐点・境・抜粋が全文のときと同じ`, JSON.stringify(got) === JSON.stringify(base), JSON.stringify(got).slice(0, 300));
    t.ok(`家族の読み込み（${mode}）: 画面は digest を頼み、返事が大きい中継越しは bulk で受ける`,
      seen.length > 0 && seen.every((s) => s.args.outline?.digest === true && s.opts?.bulk === true), JSON.stringify(seen));
  }
  const bytes = (list) => JSON.stringify(list).length;
  const bigHistory = Array.from({ length: 400 }, (_, i) => msg(i % 2 ? "assistant" : "user", `発言 ${i}\n${"長い本文です。".repeat(400)}`, `m${i}`, i % 2 ? { toolCalls: [tool("Read"), tool("Edit")] } : {}));
  t.ok("400 発言・各約 2,800 字の会話の概要は、全文の形の 1/10 より小さい", bytes(digestList(bigHistory)) * 10 < bytes(wire(bigHistory)), `${bytes(digestList(bigHistory))} / ${bytes(wire(bigHistory))}`);

  // ---- 子ではなく親を開いているとき
  t.ok("親を開いても全文のときと同じ", JSON.stringify(await observe(serverCmd(lineage, histories, { mode: "new" }), "P")) === JSON.stringify(await observe(serverCmd(lineage, histories, { mode: "old" }), "P")));

  // ---- 窓の手前を概要で埋める（withPrefix）: 窓（全文）だけを持って開いたときも、通し番号と分岐点が全文のときと同じ
  const full = histories.C;
  for (const at of [2, 4]) {
    const window = { base: at, messages: full.slice(at) };
    const want = await observe(serverCmd(lineage, histories, { mode: "old" }), "C", window);
    const got = await observe(serverCmd(lineage, histories, { mode: "new" }), "C", window);
    t.ok(`窓（${at} から）の手前の埋め: 新しいサーバーでも古いサーバーでも同じ`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got).slice(0, 300));
    t.ok(`窓（${at} から）: 通し番号は全文を持っているときと同じ`, got.rows.C.length === full.length && got.rows.C.k === base.rows.C.k && JSON.stringify(got.junctions.P) === JSON.stringify(base.junctions.P), JSON.stringify(got.rows));
  }
  // 窓の外にある分岐点は、概要の指紋と窓の全文の本文で照合して出る
  const noAt = { ...lineage, sessions: lineage.sessions.map((s) => s.id === "C" ? { ...s, parent: { sessionId: "P", atMessage: null } } : s) };
  for (const mode of ["old", "new"]) {
    const b = createBranches({ cmd: serverCmd(noAt, histories, { mode }) });
    await b.load("C", full.slice(4), { base: 4 });
    t.ok(`atMessage が無くても、窓の外の分岐点が接頭辞（概要の指紋）から決まる（${mode}）`, b.family.rows.get("C").k === 3 && b.junctions("C").get(3)?.[0]?.id === "P", String(b.family.rows.get("C").k));
  }

  // ---- 送信後の差し替え（update）は、手前の概要を残して窓だけ全文に替える
  {
    const b = createBranches({ cmd: serverCmd(lineage, histories, { mode: "new" }) });
    await b.load("C", full.slice(4), { base: 4 });
    const grown = [...full.slice(4), msg("user", "さらに足した発言", "c6")];
    b.update("C", grown, { base: 4 });
    const row = b.family.rows.get("C");
    t.ok("update は手前の概要を残して窓の分だけ全文に替える", row.messages.length === 7 && row.messages.slice(0, 4).every(isDigest) && row.messages.slice(4).every((m) => !isDigest(m)), JSON.stringify(row.messages.map(isDigest)));
    t.ok("update の後も親との境は変わらない", b.junctions("C").get(3)?.[0]?.id === "P");
  }

  // ---- 古い画面 × 新しいサーバー: outline: true は今までの形（本文・ツール名つき）
  // サーバー側の実測は tests/unit/server-fork.mjs（実際の loadSession）。ここは画面側の読み方だけ確かめる
  const oldShape = wire(parent.map((m) => ({ uuid: m.uuid, role: m.role, text: m.text, tools: m.tools, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ name: c.name })) } : {}) })));
  t.ok("全文の形（古いサーバーの返事）と概要が混ざった履歴でも照合できる（窓の手前が概要・窓が全文の形）",
    commonPrefix([...digestList(parent.slice(0, 3)), ...oldShape.slice(3)], parent.map((m, i) => copy(m, i))) === parent.length);
}
