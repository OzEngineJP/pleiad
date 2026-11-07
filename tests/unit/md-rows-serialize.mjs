// 入力欄の編集行から送る Markdown（web/md-doc.mjs の docToMarkdown・web/md-rows.mjs、ADR 0301）: でたらめな行の並びで、
// 送った形を CommonMark（履歴と同じ web/md-structure.mjs）で読んでも行ごとの構造が同じで、読み直すと同じ行に戻ることを確かめる
import { markdownToDoc, docToMarkdown, normalizeRows, rowTree, serializeRuns, runsLength } from "../../web/md-doc.mjs";
import { parseStructure } from "../../web/md-structure.mjs";

export const name = "md-rows-serialize";
export const title = "編集行から送る Markdown: 履歴と同じ読み方で行ごとの構造が同じ・読み直すと同じ行";

/** 決まった乱数（実行のたびに同じ入力にする） */
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

const CONTENTS = ["", "", "a", "b c", "> x", "- y", "* y", "1. z", "2. w", "3) v", "# h", "## ", "```", "~~~", "    ind", "  lead", "*e*", "\\>q",
  "---", "***", "| t |", "-", "1.", "[ ] t", "x - y", "日本"];
const BULLETS = ["- ", "* ", "+ ", "1. ", "2. ", "1) ", "10. "];

/** でたらめな行 1 つ。記号は入れ物の並び（引用・続ける項目・最後に始める項目）から作る */
function randomRow(rnd) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  let marker = "", kind = "p";
  const depth = Math.floor(rnd() * rnd() * 4);
  for (let d = 0; d < depth; d++) {
    const r = rnd();
    if (r < 0.4) { marker += "> "; kind = "quote"; }
    else { marker += " ".repeat(pick([2, 2, 3, 4])); kind = "cont"; }
  }
  const r = rnd();
  if (r < 0.35) { marker += pick(BULLETS); kind = /\d/.test(marker.slice(-3)) ? "ol" : "ul"; }
  else if (r < 0.42) { marker += pick(["# ", "## "]); kind = "h"; }
  else if (r < 0.5) { kind = "code"; }
  let text = kind === "code" ? pick(["```", "x", "", "  y", "~~~"]) : pick(CONTENTS);
  if (kind === "h" && /^#/.test(text)) text = "t";
  return { kind, marker, runs: text ? [{ text, marks: [] }] : [] };
}

const isPad = (b) => b.pad && !runsLength(b.runs ?? []);
const rowKey = (b) => `${b.kind}|${JSON.stringify(b.marker)}|${b.kind === "att" ? b.raw : b.kind === "code" ? (b.runs ?? []).map((r) => r.text).join("") : serializeRuns(b.runs).replace(/^[ \t]+/, "")}`;
// 表・setext の見出し・区切り線は、記号を持たない字のまま送る（承認した決まり）。行の入れ物が同じなら、中身の読み方は問わない
const roleOf = (r) => (r === "att" || r === "hr" || r === "table" ? "para" : r);

/** 行ごとの構造（入れ物の種類・その行で始まったか・どの行で始まった入れ物か・役割） */
function structureOf(marks, role) {
  return `${roleOf(role)}:${marks.map((m) => `${m.node.t}${m.opened ? "+" : ""}@${m.node.start}`).join(",")}`;
}

export default async function (t) {
  const rnd = rng(20261108);
  let roundtrip = null, structure = null, idem = null, lazy = null, cases = 0;
  for (let n = 0; n < 6000 && !(roundtrip && structure && idem); n++) {
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => randomRow(rnd));
    normalizeRows(rows);
    const again = rows.map((b) => ({ ...b }));
    if (normalizeRows(again) && !idem) idem = rows.map(rowKey);
    const md = docToMarkdown(rows);
    cases++;
    // 読み直すと同じ行（記号・種類・中身。中身の頭の空白は送らない）
    const back = markdownToDoc(md).filter((b) => !isPad(b)).map(rowKey), want = rows.filter((b) => !isPad(b)).map(rowKey);
    if (!roundtrip && JSON.stringify(back) !== JSON.stringify(want)) roundtrip = { rows: want, md, back };
    // 履歴と同じ読み方で、行ごとの構造が同じ（空行は除く）。遅延の続きにならない
    const tree = rowTree(rows), ps = parseStructure(md.split("\n")).lines;
    for (let ln = 0; ln < tree.lines.length; ln++) {
      if (tree.idx[ln] === null) continue;
      const a = tree.lines[ln], b = ps[ln];
      if (!lazy && b?.role === "lazy") lazy = { rows: want, md, ln };
      if (a.role === "blank" || b?.role === "blank") continue;
      const setext = a.role === "para" && b?.role === "heading" && rows[tree.idx[ln]]?.kind !== "h";
      const sa = structureOf(a.marks, a.role), sb = b ? structureOf(b.marks, setext ? "para" : b.role) : "(なし)";
      if (sa !== sb && !structure) structure = { rows: want, md, ln, rowsReads: sa, markdownReads: sb };
    }
  }
  t.ok(`でたらめな ${cases} 件の行の並び: 送った Markdown を読み直すと同じ行（markdownToDoc(serialize(R)) ≡ R）`, !roundtrip, JSON.stringify(roundtrip));
  t.ok("同じ並び: 送った Markdown を履歴と同じ読み方（md-structure）で読んでも、行ごとの入れ物と役割が同じ", !structure, JSON.stringify(structure));
  t.ok("同じ並び: 送った Markdown に遅延の続きの行は無い（どの行も自分の記号を持つ）", !lazy, JSON.stringify(lazy));
  t.ok("normalizeRows は 2 回目に何も変えない", !idem, JSON.stringify(idem));

  // 代表の並び（承認した区切りの決まり）
  const P = (kind, marker, text = "") => ({ kind, marker, runs: text ? [{ text, marks: [] }] : [] });
  const ser = (rows) => docToMarkdown(rows);
  t.ok("引用の後の本文は区切りの空行を挟む・空の本文の行は空行のまま（区切りと重ねて数を保つ）",
    ser([P("quote", "> ", "a"), P("p", "", "b")]) === "> a\n\nb" && ser([P("quote", "> ", "a"), P("p", ""), P("p", "", "b")]) === "> a\n\n\nb"
    && ser([P("quote", "> ", "a"), P("p", "")]) === "> a\n");
  t.ok("項目の間の空の行は 1 つも 2 つも空行の数のまま", ser([P("ol", "1. ", "a"), P("p", ""), P("ol", "2. ", "b")]) === "1. a\n\n2. b"
    && ser([P("ol", "1. ", "a"), P("p", ""), P("p", ""), P("ol", "2. ", "b")]) === "1. a\n\n\n2. b");
  t.ok("記号を確定していない行頭の記号はエスケープ（`>a` → `\\>a`）・項目の中身の頭の空白は送らない",
    ser([P("p", "", ">a")]) === "\\>a" && ser([P("ul", "- ", "  a")]) === "- a" && ser([P("p", "", "# a")]) === "\\# a");
  t.ok("各行が自分の入れ物の記号を持つ（遅延の続きにしない）", ser(markdownToDoc("> a\nlazy").map(({ src, ...b }) => b)) === "> a\n> lazy");
  t.ok("読み込んだ Markdown は、行を変えないうちは元の文字のまま", ["> a\nlazy", "- a\n\n  b\n", "1. a\n\n\n5. b", "x\n  y"].every((s) => docToMarkdown(markdownToDoc(s)) === s));
}
