// 入力欄の Markdown の編集（web/md-doc.mjs、ADR 0301）を、打鍵の並びを総当たり・でたらめに流して、決まりが崩れる並びを探す。
// 操作の流れは web/md-editor.mjs と同じ（beforeinput → enter・backspaceAtStart・deleteAtEnd・deleteSelection・pasteText、
// input → applyTriggers と normalizeRows、apply() → normalizeRows、同じ理由の履歴）。操作のたびに次を確かめる:
//   TYPE   キャレットで引き金にならない字を打っても、打った行・ほかの行の入れ物（引用の数・項目の数）と種類が変わらない
//          （範囲を選んで打つと行がつながる・コードの行は字のまま読むので、どちらも除く。ほかの行は字のある行だけ）
//   SENT   字のある行の見た目の入れ物が、送る Markdown を履歴と同じ読み方（md-structure.mjs）で読んだ入れ物と同じ
//   DRAFT  下書きに保存して戻すと（snapshotEditing → restoreEditing）、行・記号・中身・見た目の入れ物が同じ
//   LOAD   送った Markdown を下書きの情報なしで読んでも（別の PC・古い版）、行の見た目の入れ物が送る Markdown と同じ
//   CRASH  操作が例外を出すか、選択が行の外・字の外に出る
// CI では総当たり 3 打鍵・でたらめ 300 件。`MD_ROWS_SEARCH=full` で総当たり 4 打鍵・でたらめ 20000 件（手元で流して報告に書く）。
// `MD_ROWS_SEARCH_OUT=<file>` で、見つけた並びの一覧を JSON に書く
import {
  restoreEditing, offsetToPos, docToMarkdown, markdownToDoc, caret, createHistory, normalizeRows, applyTriggers, insertText,
  enter, backspaceAtStart, deleteAtEnd, deleteSelection, pasteText, pasteRich, indentList, isCollapsed, runsLength, runsText,
  snapshotEditing, rowTree,
} from "../../web/md-doc.mjs";
import { writeFileSync } from "node:fs";
import { parseStructure, lineIndent, containersOf } from "../../web/md-structure.mjs";

export const name = "md-rows-search";
export const title = "入力欄の Markdown の編集: 打鍵の並びの総当たりとでたらめで、見た目・送る形・下書き・読み込みの入れ物が崩れない";

const FULL = process.env.MD_ROWS_SEARCH === "full";
const DEPTH = FULL ? 4 : 3, RANDOM = FULL ? 20000 : 300, LENGTH = 24;

const copy = (st) => ({ blocks: st.blocks.map((b) => ({ ...b, runs: b.runs.map((r) => ({ ...r, marks: r.marks.slice() })) })), sel: { s: { ...st.sel.s }, e: { ...st.sel.e } } });
const len = (b) => (b.kind === "att" ? 0 : runsLength(b.runs));

/** 入力欄の代役（md-editor.mjs の出来事の振り分けと同じ） */
function createModel(md, clock) {
  const blocks = restoreEditing(md, undefined, {});
  const end = offsetToPos(blocks, docToMarkdown(blocks).length);
  let st = { blocks, sel: caret(end.b, end.v) };
  const history = createHistory({ now: clock });
  history.reset(st);
  const apply = (next, reason) => {
    next = { ...next, blocks: next.blocks.slice(), sel: { ...next.sel, s: { ...next.sel.s }, e: { ...next.sel.e } } };
    normalizeRows(next.blocks, { sel: next.sel });
    st = next; history.push(st, reason);
  };
  // ブラウザーが DOM を変えた後の syncFromDom
  const sync = (dom, ch, reason) => {
    let s = dom;
    const trig = ch ? applyTriggers(s, ch) : null;
    if (trig) {
      history.push(s, "type");
      s = trig.state;
      normalizeRows(s.blocks, { sel: s.sel });
      st = s; history.push(st, "format");
      return "trigger";
    }
    normalizeRows(s.blocks, { sel: s.sel });
    st = s; history.push(st, reason);
    return null;
  };
  const del = (dir) => {
    const s = st.sel, b = st.blocks[s.s.b];
    if (!isCollapsed(s)) { if (s.s.b !== s.e.b) apply(deleteSelection(st), "delete"); else sync(deleteSelection(copy(st)), null, "delete"); return; }
    if (dir < 0 && s.s.v === 0) { apply(backspaceAtStart(st), "delete"); return; }
    if (dir > 0 && s.s.v >= len(b)) { apply(deleteAtEnd(st), "delete"); return; }
    const range = dir < 0 ? { s: { b: s.s.b, v: s.s.v - 1 }, e: { ...s.s } } : { s: { ...s.s }, e: { b: s.s.b, v: s.s.v + 1 } };
    sync(deleteSelection({ ...copy(st), sel: range }), null, "delete");
  };
  const moveTo = (sel) => { st = { ...st, sel }; };
  const ops = {
    type(ch) {
      if (isCollapsed(st.sel) || st.sel.s.b === st.sel.e.b) return sync(insertText(copy(st), ch), ch.length === 1 ? ch : null, "type");
      apply(insertText(st, ch), "type"); return null;
    },
    ime(text) { return sync(insertText(copy(st), text), null, "type"); },
    enter() { apply(enter(st, {}), "enter"); },
    shiftEnter() { apply(enter(st, { soft: true }), "enter"); },
    backspace() { del(-1); },
    del() { del(1); },
    paste(text) { apply(pasteText(st, text, {}), "paste"); },
    rich(parts) { apply(pasteRich(st, parts, {}), "paste"); },
    undo() { const s = history.undo(); if (s) { st = s; history.touch(s.sel); } },
    redo() { const s = history.redo(); if (s) { st = s; history.touch(s.sel); } },
    left() { const { b, v } = st.sel.s; moveTo(v > 0 ? caret(b, v - 1) : b > 0 ? caret(b - 1, len(st.blocks[b - 1])) : caret(b, v)); },
    right() { const { b, v } = st.sel.e; moveTo(v < len(st.blocks[b]) ? caret(b, v + 1) : b < st.blocks.length - 1 ? caret(b + 1, 0) : caret(b, v)); },
    up() { const { b, v } = st.sel.s; if (b > 0) moveTo(caret(b - 1, Math.min(v, len(st.blocks[b - 1])))); },
    down() { const { b, v } = st.sel.e; if (b < st.blocks.length - 1) moveTo(caret(b + 1, Math.min(v, len(st.blocks[b + 1])))); },
    home() { moveTo(caret(st.sel.s.b, 0)); },
    end() { moveTo(caret(st.sel.e.b, len(st.blocks[st.sel.e.b]))); },
    shiftUp() { const { b, v } = st.sel.s; if (b > 0) moveTo({ s: { b: b - 1, v: Math.min(v, len(st.blocks[b - 1])) }, e: { ...st.sel.e } }); },
    shiftHome() { moveTo({ s: { b: st.sel.s.b, v: 0 }, e: { ...st.sel.e } }); },
    selectAll() { const last = st.blocks.length - 1; moveTo({ s: { b: 0, v: 0 }, e: { b: last, v: len(st.blocks[last]) } }); },
    tab() { const n = indentList(st, 1); if (n) apply(n, "indent"); },
    shiftTab() { const n = indentList(st, -1); if (n) apply(n, "indent"); },
  };
  return { ops, get state() { return st; } };
}

const depthOf = (node) => { let q = 0, item = 0; for (const n of containersOf(node)) { q += n.t === "bq"; item += n.t === "item"; } return [q, item]; };

/** 行ごとの、入力欄が描く入れ物（md-editor.mjs の decoOf と同じ rowTree）と、送る Markdown を履歴と同じ読み方で読んだ入れ物 */
function observe(blocks) {
  const md = docToMarkdown(blocks), S = rowTree(blocks), sent = parseStructure(md.split("\n")).lines;
  const lineOf = new Map();
  S.idx.forEach((i, ln) => { if (i !== null) lineOf.set(i, ln); });
  const rows = blocks.map((b, i) => {
    const li = S.info[i];
    return {
      kind: b.kind, text: b.kind === "att" ? "" : runsText(b.runs), pad: isPad(b),
      // Markdown に出ない行（キャレットを置く空行）は飾りを付けない（md-editor.mjs の decoOf）ので、入れ物の外に見える
      shown: li ? [lineIndent(li.node).bars.length, depthOf(li.node)[1]] : [0, 0],
      sent: lineOf.has(i) && sent[lineOf.get(i)] ? depthOf(sent[lineOf.get(i)].node) : null,
    };
  });
  return { md, rows };
}

// キャレットを置く空行（pad）は、空のうちは Markdown に出ない
const isPad = (b) => !!b.pad && b.kind !== "att" && !runsLength(b.runs);
const rowKey = (b) => `${b.kind}|${b.marker}|${b.kind === "att" ? b.raw : runsText(b.runs)}|${b.pad ? 1 : 0}`;
// 下書きは送る Markdown から読み直す（ADR 0301）。中身の頭の空白は送らない（md-rows-serialize と同じ比べ方）。空の pad は比べない
const draftKey = (b) => `${b.kind}|${b.marker}|${b.kind === "att" ? b.raw : b.kind === "code" ? runsText(b.runs) : runsText(b.runs).replace(/^[ \t]+/, "")}`;
const shownOf = (o) => o.rows.filter((r) => !r.pad).map((r) => r.shown?.join(",") ?? "-").join(" ");
const mismatch = (r) => r.text.trim() && r.shown && r.sent && r.kind !== "code" && r.shown.join() !== r.sent.join();

function check(before, op, arg, after, trigger) {
  const out = [], oa = observe(after.blocks), at = before.st.sel.s.b;
  if ((op === "type" || op === "ime") && trigger !== "trigger" && arg !== " " && isCollapsed(before.st.sel) && before.st.blocks[at]?.kind !== "code") {
    const rb = before.obs.rows[at], ra = oa.rows[after.sel.s.b];
    if (rb && ra && (rb.shown?.join() !== ra.shown?.join() || rb.kind !== ra.kind)) out.push({ inv: "TYPE", detail: `${rb.kind}[${rb.shown}] -> ${ra.kind}[${ra.shown}]` });
    else if (before.obs.rows.length === oa.rows.length) {
      // 字の無い行は空行で、続けられる入れ物から深さが決まる（読み込んだときと同じ）ので比べない
      const changed = oa.rows.map((_, i) => i).filter((i) => i !== at && oa.rows[i].text.trim() && before.obs.rows[i].shown?.join() !== oa.rows[i].shown?.join());
      if (changed.length) out.push({ inv: "TYPE", detail: changed.map((i) => `row ${i} [${before.obs.rows[i].shown}] -> [${oa.rows[i].shown}]`).join("; ") });
    }
  }
  oa.rows.forEach((r, i) => { if (mismatch(r)) out.push({ inv: "SENT", detail: `row ${i} ${r.kind} ${JSON.stringify(r.text)} shown[${r.shown}] sent[${r.sent}]` }); });
  const md = oa.md, restored = restoreEditing(md, JSON.parse(JSON.stringify(snapshotEditing(after.blocks))), {});
  const a = after.blocks.filter((b) => !isPad(b)).map(draftKey).join("\n"), b = restored.filter((x) => !isPad(x)).map(draftKey).join("\n");
  if (a !== b) out.push({ inv: "DRAFT", detail: `${JSON.stringify(a)} -> ${JSON.stringify(b)}` });
  else if (shownOf(oa) !== shownOf(observe(restored))) out.push({ inv: "DRAFT", detail: `${shownOf(oa)} -> ${shownOf(observe(restored))}` });
  observe(markdownToDoc(md, {})).rows.forEach((r, i) => { if (mismatch(r)) out.push({ inv: "LOAD", detail: `row ${i} ${JSON.stringify(r.text)} shown[${r.shown}] sent[${r.sent}]` }); });
  for (const end of [after.sel.s, after.sel.e]) {
    const row = after.blocks[end.b];
    if (!row || !Number.isInteger(end.v) || end.v < 0 || end.v > len(row)) { out.push({ inv: "CRASH", detail: `selection outside rows ${JSON.stringify(end)}` }); break; }
  }
  return out;
}

const opOf = (k) => (typeof k === "object" ? [k.op, k.arg] : k.length === 1 ? ["type", k] : [k, undefined]);
const label = (k) => (typeof k === "object" ? `${k.op}(${JSON.stringify(k.arg)})` : k === " " ? "Space" : k);

/** 種（打って作る並びか、読み込む Markdown）から並びを流し、決まりが崩れた所を返す */
function runSeq(seed, seq, steps = null) {
  let t = 0;
  const m = createModel(typeof seed === "string" ? seed : "", () => t);
  const doOp = (k) => { const [op, arg] = opOf(k); return op === "type" || op === "ime" || op === "paste" || op === "rich" ? m.ops[op](arg) : m.ops[op](); };
  if (typeof seed !== "string") for (const k of seed) doOp(k);
  const hits = [];
  for (let i = 0; i < seq.length; i++) {
    t += steps ? steps[i] : 50;
    const before = { st: m.state, obs: observe(m.state.blocks) }, [op, arg] = opOf(seq[i]);
    let trigger;
    try { trigger = doOp(seq[i]); } catch (e) { hits.push({ step: i, inv: "CRASH", detail: String(e.stack).split("\n").slice(0, 3).join(" | ") }); break; }
    for (const f of check(before, op, arg, m.state, trigger)) hits.push({ step: i, ...f });
  }
  return { hits, state: m.state };
}

// 打って作る種（引き金で確定した記号）と、読み込む種（読み込んだまま送る元の文字）
const TYPED = {
  quote: [">", " ", "a"], quote2: [">", " ", ">", " ", "a"], ul: ["-", " ", "a"], ol: ["1", ".", " ", "a"],
  "ul-nested": ["-", " ", "a", "enter", "tab", "b"], "ol-nested": ["1", ".", " ", "a", "enter", "tab", "b"],
  "quote-ul": [">", " ", "-", " ", "a"], "quote-ol": [">", " ", "1", ".", " ", "a"], "ul-quote": ["-", " ", ">", " ", "a"],
  "ul-cont": ["-", " ", "a", "shiftEnter", "b"], "quote2-text": [">", " ", "a", "enter", ">", " ", "b"],
  "quote-paste": [">", " ", { op: "paste", arg: "p\nq" }],
};
const LOADED = {
  "L:quote": "> a", "L:quote2": "> > a", "L:ul-nested": "- a\n  - b", "L:quote-ol-ul": "> 1. a\n>    - b", "L:ul-cont": "- a\n  b",
  "L:ol2": "1. a\n2. b", "L:lazy": "> a\nb", "L:quote-blank": "> a\n>\n> b", "L:quote-sep": "> a\n\nb", "L:fence": "> ```\n> x\n> ```",
};

export default async function (t) {
  const found = new Map();
  const record = (seed, seq, h) => {
    const key = `${seed} :: ${h.inv} after ${label(seq[h.step])}: ${h.detail.replace(/row \d+ /g, "").replace(/"[^"]*"/g, "T")}`;
    const steps = seq.slice(0, h.step + 1).map(label), ex = found.get(key);
    if (!ex || steps.length < ex.steps.length) found.set(key, { seed, inv: h.inv, steps, detail: h.detail });
  };
  const seeds = [...Object.entries(TYPED), ...Object.entries(LOADED)];

  // 総当たり: 同じ状態（行と選択）に着いた並びは先へ延ばさない
  const KEYS = ["enter", "shiftEnter", "backspace", "del", "left", "right", "up", "down", "home", "end", "b", " "];
  let states = 0;
  for (const [nm, seed] of seeds) {
    const seen = new Set();
    let frontier = [[]];
    for (let d = 0; d < DEPTH; d++) {
      const next = [];
      for (const seq of frontier) for (const k of KEYS) {
        const s2 = [...seq, k], { hits, state } = runSeq(seed, s2);
        for (const h of hits.filter((x) => x.step === s2.length - 1)) record(nm, s2, h);
        if (hits.some((h) => h.inv === "CRASH")) continue;
        const key = state.blocks.map(rowKey).join("\n") + "#" + JSON.stringify(state.sel);
        if (seen.has(key)) continue;
        seen.add(key); states++; next.push(s2);
      }
      frontier = next;
    }
  }

  // でたらめ: 履歴・貼り付け（字と HTML）・IME・範囲の選択・字下げ・記号の字を混ぜる。見つけたら、同じ崩れが残るかぎり操作を減らす
  let r = 20261108;
  const rnd = () => (r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ALPHABET = ["enter", "enter", "shiftEnter", "shiftEnter", "backspace", "backspace", "backspace", "del", "left", "right", "up", "down", "home", "end",
    "a", "b", " ", ">", ">", "-", "1", ".", "undo", "undo", "redo", "selectAll", "shiftHome", "shiftUp", "tab", "shiftTab",
    { op: "ime", arg: "あい" }, { op: "paste", arg: "x\ny" }, { op: "paste", arg: "> p\nq" }, { op: "paste", arg: "- p\n- q" }, { op: "paste", arg: "\n" },
    { op: "paste", arg: "z" }, { op: "paste", arg: "1. p\n\n2. q" }, { op: "rich", arg: [{ md: "> p" }, { md: "> q" }] },
    { op: "rich", arg: [{ md: "- p" }, { md: "  - q" }] }, { op: "rich", arg: [{ md: "**p**" }, { md: "q" }] }];
  const randomSeeds = [...seeds, ["empty", []]];
  for (let n = 0; n < RANDOM; n++) {
    const [nm, seed] = pick(randomSeeds);
    const seq = Array.from({ length: LENGTH }, () => pick(ALPHABET)), steps = Array.from({ length: LENGTH }, () => (rnd() < 0.2 ? 1500 : 50));
    const first = runSeq(seed, seq, steps).hits[0];
    if (!first) continue;
    const sig = (h, s) => `${h.inv}|${label(s[h.step])}|${h.detail.replace(/row \d+ /g, "").replace(/"[^"]*"/g, "T")}`, want = sig(first, seq);
    let cur = seq.slice(0, first.step + 1), curSteps = steps.slice(0, first.step + 1);
    for (let i = cur.length - 2; i >= 0; i--) {
      const s2 = cur.filter((_, j) => j !== i), st2 = curSteps.filter((_, j) => j !== i);
      if (runSeq(seed, s2, st2).hits.some((h) => h.step === s2.length - 1 && sig(h, s2) === want)) { cur = s2; curSteps = st2; }
    }
    const h = runSeq(seed, cur, curSteps).hits.find((x) => x.step === cur.length - 1 && sig(x, cur) === want);
    record(nm, cur, h ?? first);
  }

  const list = [...found.values()].sort((a, b) => a.inv.localeCompare(b.inv) || a.steps.length - b.steps.length);
  const byInv = {};
  for (const x of list) byInv[x.inv] = (byInv[x.inv] ?? 0) + 1;
  if (process.env.MD_ROWS_SEARCH_OUT) writeFileSync(process.env.MD_ROWS_SEARCH_OUT, JSON.stringify({ depth: DEPTH, states, random: RANDOM, byInv, list }, null, 1));
  for (const inv of ["TYPE", "SENT", "DRAFT", "LOAD", "CRASH"]) {
    const hits = list.filter((x) => x.inv === inv);
    t.ok(`${inv}: 総当たり ${DEPTH} 打鍵（${states} 状態）とでたらめ ${RANDOM} 件で崩れない`, !hits.length, JSON.stringify(hits.slice(0, 3)));
  }
}
