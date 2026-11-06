// 入力欄の Markdown 文書モデル（DOM を触らない。ADR 0060）。
//
// 入力欄（web/md-editor.mjs）は「ソースの 1 行 = 1 ブロック」の編集欄。正本は Markdown の文字列で、この文書モデルとの往復では
// 文字が 1 つも変わらない（docToMarkdown(markdownToDoc(s)) === s）。往復を保つため、ブロックの記号（`## `・`- `・`> `）と、
// インラインの区切り（`**`・`_`・`` ` ``・URL）は捨てずにモデルが持つ。行の入れ子（リスト・引用・項目の中の見出しやコード）は、
// 履歴と同じ CommonMark の構造の解析（web/md-structure.mjs の parseStructure）で読む（ADR 0292）。入力欄で整えない構造（表・HTML・
// チェック欄・打ち消し線・setext の見出し・横線）は平文の行のまま残す。
//
// ブロック: { kind, marker, runs, raw?, path?, pid?, pad? }
//   kind   'p' | 'h' | 'ul' | 'ol' | 'quote' | 'cont' | 'code' | 'att'
//          cont は項目の中の続きの行（項目の 2 つ目の段落など）。quote は引用の中の段落の行。引用や項目の中の見出し・リスト・コードは
//          h・ul・ol・code で、外側の記号（`> `・字下げ）は marker に含む
//   marker 行頭の記号と字下げ（`## `・`  - `・`3. `・`> > `・`> # `・cont は項目の中身の始まりまでの空白）。p は ''、code は外側の分だけ
//   runs   インラインの並び [{ text, marks: [{ id, t: 'strong'|'em'|'code'|'link', d?, url? }] }]。code の行は印の無い 1 つの run
//   att    添付の 1 行（原子）。raw は送る 1 行（`[添付] パス`）、path は解決済みのパス、pid は送っている途中の仮の ID
//   pad    添付の前後・閉じたコードブロックの後ろに、キャレットを置くために足した空行。空のうちは Markdown に出さない
// 位置: { b: ブロックの添字, v: ブロックの見える文字の中の位置 }（記号・区切りは数えない）。選択は { s, e }（s ≤ e）
//
// 操作はどれも状態 { blocks, sel } を受けて新しい状態を返す（元は変えない）。DOM との結び付けは md-editor.mjs。
import { parseStructure, codeRoles, prefixEnd } from './md-structure.mjs';
import { ATTACHMENT_LINE, ATTACHMENT_MARKS, attachmentLine, normalizeAttachmentPath } from './timeline.mjs';

export { attachmentLine, normalizeAttachmentPath };

let markSeq = 0;
export const newMark = (t, props = {}) => ({ id: ++markSeq, t, ...props });
const sameMark = (a, b) => a.id === b.id;
const sameMarks = (a, b) => a.length === b.length && a.every((m, i) => sameMark(m, b[i]));
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i].id === b[i].id) i++; return i; };
const clone = (x) => structuredClone(x);

// ------------------------------------------------------------------ runs
export const runsText = (runs) => runs.map(r => r.text).join('');
export const runsLength = (runs) => runs.reduce((n, r) => n + r.text.length, 0);

/** 隣り合って同じ印を持つ run をまとめる（空の run は捨てる） */
export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, r.marks)) last.text += r.text;
    else out.push({ text: r.text, marks: r.marks });
  }
  return out;
}

/** 見える文字の [a, b) を切り出す */
export function sliceRuns(runs, a, b = Infinity) {
  const out = [];
  let at = 0;
  for (const r of runs) {
    const from = Math.max(a - at, 0), to = Math.min(b - at, r.text.length);
    if (to > from) out.push({ text: r.text.slice(from, to), marks: r.marks });
    at += r.text.length;
    if (at >= b) break;
  }
  return out;
}

const plainRun = (text) => (text ? [{ text, marks: [] }] : []);

// ------------------------------------------------------------------ インラインの読み取り
const WORD = /[\p{L}\p{N}]/u;
const PUNCT = /[\\`*_{}\[\]()#+\-.!>~|<]/;

function findCodeClose(s, from, n) {
  let k = from;
  while (k < s.length) {
    if (s[k] !== '`') { k++; continue; }
    let e = k;
    while (s[e] === '`') e++;
    if (e - k === n) return k;
    k = e;
  }
  return -1;
}

/** 太字・斜体の閉じの区切りを探す。コードスパンの中とエスケープは飛ばす。斜体（1 字）は連続 1 つだけ、太字（2 字）は 2 つ以上の連続の頭 */
function findEmphasisClose(s, from, d) {
  const c = d[0], n = d.length;
  let k = from;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '`') {
      let e = k;
      while (s[e] === '`') e++;
      const close = findCodeClose(s, e, e - k);
      k = close >= 0 ? close + (e - k) : e;
      continue;
    }
    if (ch === c) {
      let e = k;
      while (s[e] === c) e++;
      const run = e - k;
      if (n === 1 ? run === 1 : run >= 2) return k;
      k = e;
      continue;
    }
    k++;
  }
  return -1;
}

const LINK = /^\[((?:\\.|[^\[\]\\])+)\]\(([^()\s]+)\)/;

function scan(s, marks, out, depth) {
  let buf = '', i = 0;
  const flush = () => { if (buf) { out.push({ text: buf, marks }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += c + s[i + 1]; i += 2; continue; }
    if (c === '`') {
      let e = i;
      while (s[e] === '`') e++;
      const n = e - i, close = findCodeClose(s, e, n);
      if (close > e) {
        let content = s.slice(e, close);
        // 中身が ` で始まる・終わるときに足す空白（serializeRuns が同じ条件で足す）
        if (content.length > 2 && content[0] === ' ' && content.at(-1) === ' ' && (content[1] === '`' || content.at(-2) === '`')) content = content.slice(1, -1);
        flush();
        out.push({ text: content, marks: [...marks, newMark('code', { d: s.slice(i, e) })] });
        i = close + n;
        continue;
      }
      buf += s.slice(i, e);
      i = e;
      continue;
    }
    if ((c === '*' || c === '_') && depth < 4) {
      const d = s[i + 1] === c ? c + c : c;
      // 斜体は、開きが別の * のすぐ隣なら読まない（太字が閉じないまま残っている形）
      const open = i + d.length, close = d.length === 2 || s[i + 1] !== c ? findEmphasisClose(s, open, d) : -1;
      const content = close > open ? s.slice(open, close) : '';
      const ok = content && !/^\s|\s$/.test(content)
        && !(c === '_' && ((i > 0 && WORD.test(s[i - 1])) || WORD.test(s[close + d.length] ?? '')));
      if (ok) {
        flush();
        scan(content, [...marks, newMark(d.length === 2 ? 'strong' : 'em', { d })], out, depth + 1);
        i = close + d.length;
        continue;
      }
    }
    if (c === '[' && depth < 4 && s[i - 1] !== '!') {
      const m = LINK.exec(s.slice(i));
      if (m) {
        flush();
        scan(m[1], [...marks, newMark('link', { url: m[2] })], out, depth + 1);
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
}

/** 1 行の中身を run の並びにする。serializeRuns で必ず元の文字に戻る */
export function parseInline(text) {
  const out = [];
  scan(String(text ?? ''), [], out, 0);
  return mergeRuns(out);
}

// ------------------------------------------------------------------ インラインの書き出し
const codeTick = (mark, text) => {
  const used = new Set([...text.matchAll(/`+/g)].map(m => m[0].length));
  let n = Math.max(1, (mark.d ?? '`').length);
  while (used.has(n)) n++;
  return '`'.repeat(n);
};

/**
 * run の並びを Markdown の文字にする。text は文字、after[v]（v 番目の見える文字の直後で閉じの区切りの前）と
 * before[v]（v 番目の見える文字の頭。開きの区切りの後）は、見える位置から文字の位置への写し
 */
export function serializeRunsMapped(runs) {
  const codeText = new Map();
  for (const r of runs) for (const m of r.marks) if (m.t === 'code') codeText.set(m.id, (codeText.get(m.id) ?? '') + r.text);
  const ticks = new Map();
  const padded = (m) => /^`|`$/.test(codeText.get(m.id) ?? '');
  const tickOf = (m) => { if (!ticks.has(m.id)) ticks.set(m.id, codeTick(m, codeText.get(m.id) ?? '')); return ticks.get(m.id); };
  const open = (m) => (m.t === 'strong' || m.t === 'em' ? (m.d ?? (m.t === 'strong' ? '**' : '*')) : m.t === 'code' ? tickOf(m) + (padded(m) ? ' ' : '') : '[');
  const close = (m) => (m.t === 'strong' || m.t === 'em' ? (m.d ?? (m.t === 'strong' ? '**' : '*')) : m.t === 'code' ? (padded(m) ? ' ' : '') + tickOf(m) : `](${m.url ?? ''})`);
  let out = '', stack = [], v = 0;
  const before = [], after = [0];
  for (const r of runs) {
    const p = commonPrefix(stack, r.marks);
    for (let k = stack.length - 1; k >= p; k--) out += close(stack[k]);
    for (let k = p; k < r.marks.length; k++) out += open(r.marks[k]);
    stack = r.marks;
    for (let k = 0; k < r.text.length; k++) {
      before[v] = out.length;
      out += r.text[k];
      after[++v] = out.length;
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) out += close(stack[k]);
  before[v] = out.length;
  return { text: out, before, after };
}

export const serializeRuns = (runs) => serializeRunsMapped(runs).text;

/** [a, b) を Markdown の文字で取り出す（コピー）。全部が範囲に入っている強調・リンクだけ区切りを付ける */
export function sliceRaw(runs, a, b) {
  const extent = new Map();
  let at = 0;
  for (const r of runs) {
    for (const m of r.marks) { const e = extent.get(m.id); if (e) e[1] = at + r.text.length; else extent.set(m.id, [at, at + r.text.length]); }
    at += r.text.length;
  }
  const clipped = sliceRuns(runs, a, b).map(r => ({ text: r.text, marks: r.marks.filter(m => { const e = extent.get(m.id); return e[0] >= a && e[1] <= b; }) }));
  return serializeRuns(mergeRuns(clipped));
}

// ------------------------------------------------------------------ ブロック
export const emptyBlock = (kind = 'p') => ({ kind, marker: '', runs: [] });
export const isEmptyBlock = (b) => b.kind !== 'att' && !runsLength(b.runs);
const isPending = (b) => b.kind === 'att' && !b.path;
/** Markdown に出さないブロック（送っている途中の添付・空の pad） */
const omitted = (b) => (b.pad && isEmptyBlock(b)) || isPending(b);

export function blockRaw(b) {
  if (b.kind === 'att') return b.raw ?? '';
  if (b.kind === 'code') return b.marker + runsText(b.runs);
  return b.marker + serializeRuns(b.runs);
}

/** Enter を押したときだけ箇条書きと見なす行頭の中点（打っただけでは変えない。送る本文は打ったとおり） */
const RE_BULLET_CHAR = /^[・•･][ \t　]*/;
const RE_CHECK = /^\[[ xX]\] ?/;
const CODE_ROLES = new Set(['fence-open', 'code', 'fence-close', 'icode']);

const codeBlock = (line, marker = '') => ({ kind: 'code', marker, runs: plainRun(line) });

// ------------------------------------------------------------------ 構造（web/md-structure.mjs。履歴と同じ読み方。ADR 0292）
/**
 * ブロックの並びの構造。info[i] はブロック i の行の情報（md-structure.mjs の行。Markdown に出ないブロックは null）、idx[行] はブロックの添字。
 * 中身の無い箇条書き・番号の行は、中身があるものとして読む（CommonMark では空の項目は段落を打ち切れないが、打っている途中の行は項目として扱う）
 */
export function docStructure(blocks, raw = blockRaw) {
  const idx = [], src = [];
  blocks.forEach((b, i) => {
    if (omitted(b)) return;
    idx.push(i);
    const r = raw(b);
    src.push(r + ((b.kind === 'ul' || b.kind === 'ol') && !runsLength(b.runs) && /[ \t]$/.test(r) ? 'x' : ''));
  });
  const { root, lines } = parseStructure(src);
  const info = blocks.map(() => null);
  idx.forEach((bi, k) => { info[bi] = lines[k]; });
  return { root, lines, info, idx };
}

/** 行の入れ物の記号のうち、ブロックの記号（marker）の中に収まるもの（外から内へ） */
export const ownMarks = (li, b) => (li ? li.marks.filter((m) => m.end <= b.marker.length) : []);

/** 文字の位置 upto の桁（タブは 4 の倍数へ進む） */
function columnOf(text, upto) {
  let c = 0;
  for (let i = 0; i < upto; i++) c = text[i] === '\t' ? c + 4 - (c % 4) : c + 1;
  return c;
}

/** 続きの行の頭: 記号の並びの upto 個目の手前までを写す。項目の記号は同じ幅の空白に（タブは残す）、引用の `>` はそのまま */
export function contPrefix(text, marks, upto = marks.length) {
  let out = '', prev = 0;
  for (let k = 0; k < upto; k++) {
    const m = marks[k], seg = text.slice(prev, m.end);
    if (m.node.t !== 'item') out += seg;
    else {
      const s = seg.replace(/[^\t]/g, ' ');
      // 記号だけで終わる項目（`-`）も、中身の桁まで空ける
      out += m.opened && !s.includes('\t') ? s.padEnd(m.node.markerOffset + m.node.padding) : s;
    }
    prev = m.end;
  }
  return out;
}

/** 記号の並びの k 個目の記号の部分（前の記号の後ろから） */
const segOf = (text, marks, k) => text.slice(marks[k - 1]?.end ?? 0, marks[k].end);

/** 項目の記号の部分の番号を 1 つ進める（箇条書きはそのまま）。後ろに空白が無ければ足す */
function nextItemSeg(seg) {
  const s = seg.replace(/(\d{1,9})([.)])(?=[ \t]*$)/, (_, n, d) => `${Number(n) + 1}${d}`);
  return /[ \t]$/.test(s) ? s : `${s} `;
}

/** 記号の並びの先頭 n 個で始まる続きの行の種類（最後が引用なら引用、項目なら項目の中の続きの行。記号が無ければ段落） */
const contKind = (marks, n) => (n <= 0 ? 'p' : marks[n - 1].node.t === 'bq' ? 'quote' : 'cont');

/** 行 1 つを、構造の行の情報（info）からブロックにする。resolve(path) が truthy な添付の印は原子にする */
function lineBlock(text, info, { resolve = () => null, plain = false } = {}) {
  if (plain || !info) return { kind: 'p', marker: '', runs: plain ? plainRun(text) : parseInline(text) };
  const end = prefixEnd(info);
  if (CODE_ROLES.has(info.role)) return codeBlock(text.slice(end), text.slice(0, end));
  const mark = ATTACHMENT_LINE.exec(text.trim());
  if (mark && resolve(mark[1])) return { kind: 'att', marker: '', runs: [], raw: text, path: mark[1] };
  if (info.role === 'heading' && /#[ \t]+$/.test(text.slice(0, info.at))) return { kind: 'h', marker: text.slice(0, info.at), runs: parseInline(text.slice(info.at)) };
  const m = info.marks.at(-1);
  if (!m || !end) return { kind: 'p', marker: '', runs: parseInline(text) };
  const marker = text.slice(0, end), runs = parseInline(text.slice(end));
  if (m.node.t === 'bq') return { kind: 'quote', marker, runs };
  if (m.opened) return { kind: m.node.parent.ordered ? 'ol' : 'ul', marker, runs };
  return { kind: 'cont', marker, runs };
}

/** 記号の並びの j 個目の記号が、ブロックの記号として最低限要る長さ（引用は `>`、項目は記号と空白 1 つ、続きの行は読んだ空白の全部） */
function minEnd(text, m) {
  if (m.node.t === 'bq') return m.at + 1;
  if (!m.opened) return m.end;
  const bullet = /^(?:\d{1,9}[.)]|[-+*])/.exec(text.slice(m.at))?.[0].length ?? 1;
  return Math.min(m.end, m.at + bullet + 1);
}

/**
 * ブロックの種類と記号が、構造の読み方と合っているか（合わない行は normalizeFences が読み直す）。
 * 記号より後ろに構造の記号が続くのはかまわない（記号のまま打った字。元に戻すで戻した行を勝手に書式にしない）
 */
function agrees(b, li, text) {
  if (!li || b.kind === 'p' || b.kind === 'att' || b.kind === 'code') return true;
  if (CODE_ROLES.has(li.role)) return false;
  const n = b.marker.length;
  if (b.kind === 'h') return li.role === 'heading' && n <= li.at && /#[ \t]+$/.test(b.marker) && ownMarks(li, b).length === li.marks.length;
  let k = -1;
  li.marks.forEach((m, j) => { if (minEnd(text, m) <= n) k = j; });
  const m = li.marks[k];
  if (!m || n > m.end) return false;
  if (m.node.t === 'bq') return b.kind === 'quote';
  if (!m.opened) return b.kind === 'cont';
  return b.kind === (m.node.parent.ordered ? 'ol' : 'ul');
}

/** 行 1 つ（前後の行とつながらないもの）をブロックにする */
export function classifyLine(line, opts = {}) {
  return lineBlock(line, opts.plain ? null : parseStructure([line]).lines[0], opts);
}

/** フェンスの行の役割: 'open' | 'close' | 'in' | null（md-structure.mjs の codeRoles。web/render.mjs の codeFenceMask と同じ範囲） */
export const fenceRoles = (lines) => codeRoles(parseStructure(lines).lines);

/** キャレットを置けるように、添付の前後・閉じたコードブロックの後ろに空の pad を足す（Markdown には出ない） */
export function ensureShape(blocks) {
  if (!blocks.length) blocks.push(emptyBlock());
  if (blocks[0].kind === 'att') blocks.unshift({ ...emptyBlock(), pad: true });
  const last = blocks.at(-1);
  if (last.kind === 'att') blocks.push({ ...emptyBlock(), pad: true });
  else if (last.kind === 'code' && docStructure(blocks).info.at(-1)?.role === 'fence-close') blocks.push({ ...emptyBlock(), pad: true });
  return blocks;
}

/** Markdown の文字列 → ブロック。docToMarkdown で必ず元に戻る。行の種類は履歴と同じ構造の読み方で決める（web/md-structure.mjs） */
export function markdownToDoc(md, opts = {}) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const info = opts.plain ? [] : parseStructure(lines).lines;
  return ensureShape(lines.map((line, i) => lineBlock(line, info[i], opts)));
}

export function docToMarkdown(blocks) {
  return blocks.filter(b => !omitted(b)).map(blockRaw).join('\n');
}

/**
 * 文字列での位置の対応。lines は Markdown に出るブロックだけ { b, start, marker, map }。
 * 出ないブロック（送っている途中の添付・空の pad）は、次に出るブロックの頭と同じ位置に写る
 */
export function docLayout(blocks, memo = null) {
  const lines = [];
  let start = 0;
  blocks.forEach((b, i) => {
    if (omitted(b)) return;
    // memo（WeakMap）を渡すと、変わらないブロックの分を使い回す。渡す側は、ブロックを作った後に書き換えないこと
    let e = memo?.get(b);
    if (!e) {
      const raw = blockRaw(b);
      const map = b.kind === 'att' || b.kind === 'code' ? null : serializeRunsMapped(b.runs);
      e = { raw, marker: b.kind === 'att' ? '' : b.marker, map, len: b.kind === 'att' ? raw.length : runsLength(b.runs) };
      memo?.set(b, e);
    }
    lines.push({ b: i, start, ...e });
    start += e.raw.length + 1;
  });
  return { lines, length: Math.max(0, start - 1) };
}

/** ブロックの Markdown の文字（blockRaw）を、変わらないブロックの分だけ使い回す関数にする（cache は WeakMap。ブロックは作った後に書き換えない） */
export const memoRaw = (cache) => (b) => {
  let r = cache.get(b);
  if (r === undefined) { r = blockRaw(b); cache.set(b, r); }
  return r;
};

/** 位置 → Markdown の文字列の位置（v 番目の見える文字の直後）。layout は docLayout(blocks) の結果を使い回すとき */
export function posToOffset(blocks, pos, layout = docLayout(blocks)) {
  if (!layout.lines.length) return 0;
  const line = layout.lines.find(l => l.b >= pos.b) ?? layout.lines.at(-1);
  if (line.b > pos.b) return line.start;
  if (line.b < pos.b) return layout.length;
  if (!line.map) return line.start + line.marker.length + Math.min(pos.v, line.len);
  return line.start + line.marker.length + line.map.after[Math.min(pos.v, line.len)];
}

/** Markdown の文字列の位置 → 位置（その手前までにある見える文字の数） */
export function offsetToPos(blocks, offset, layout = docLayout(blocks)) {
  if (!layout.lines.length) return { b: 0, v: 0 };
  let line = layout.lines[0];
  for (const l of layout.lines) if (l.start <= offset) line = l;
  const r = Math.max(0, Math.min(offset - line.start, line.raw.length));
  const inner = r - line.marker.length;
  if (!line.map) return { b: line.b, v: Math.max(0, Math.min(inner, line.len)) };
  let v = 0;
  while (v < line.len && line.map.after[v + 1] <= inner) v++;
  return { b: line.b, v: inner < 0 ? 0 : v };
}

/** ブロックの中の位置 v を、行の文字の位置にする（読み直した行へ位置を移すとき） */
function rawOffsetOf(b, v) {
  if (b.kind === 'att') return 0;
  const len = runsLength(b.runs), at = Math.min(v, len);
  return b.marker.length + (b.kind === 'code' ? at : serializeRunsMapped(b.runs).after[at]);
}
/** 行の文字の位置を、ブロックの中の位置にする */
function vOfRaw(b, off) {
  if (b.kind === 'att') return 0;
  const len = runsLength(b.runs), inner = off - b.marker.length;
  if (inner <= 0) return 0;
  if (b.kind === 'code') return Math.min(inner, len);
  const { after } = serializeRunsMapped(b.runs);
  let v = 0;
  while (v < len && after[v + 1] <= inner) v++;
  return v;
}

// ------------------------------------------------------------------ 状態と選択
export const caret = (b, v) => ({ s: { b, v }, e: { b, v } });
export const isCollapsed = (sel) => sel.s.b === sel.e.b && sel.s.v === sel.e.v;
const before = (p, q) => p.b < q.b || (p.b === q.b && p.v <= q.v);
export const orderSel = (a, f) => (before(a, f) ? { s: a, e: f } : { s: f, e: a });

// ------------------------------------------------------------------ 選択の削除
export function deleteSelection(st) {
  if (isCollapsed(st.sel)) return st;
  const next = clone(st);
  const { s, e } = next.sel;
  const bs = next.blocks[s.b], be = next.blocks[e.b];
  if (s.b === e.b) {
    if (bs.kind === 'att') { next.blocks.splice(s.b, 1); ensureShape(next.blocks); next.sel = caret(Math.min(s.b, next.blocks.length - 1), 0); return next; }
    bs.runs = mergeRuns([...sliceRuns(bs.runs, 0, s.v), ...sliceRuns(bs.runs, e.v)]);
    next.sel = caret(s.b, s.v);
    return next;
  }
  const head = bs.kind === 'att' ? null : sliceRuns(bs.runs, 0, s.v);
  const tail = be.kind === 'att' ? null : sliceRuns(be.runs, e.v);
  let merged;
  if (head && tail) {
    merged = { ...bs, runs: mergeRuns([...head, ...tail]) };
    // コードの行と本文の行をつなぐときは、つないだ側の種類に合わせて文字にそろえる
    if (bs.kind === 'code') merged.runs = plainRun(runsText(head) + (be.kind === 'code' ? runsText(tail) : (e.v === 0 ? be.marker : '') + serializeRuns(tail)));
    else if (be.kind === 'code') merged.runs = mergeRuns([...head, ...plainRun(runsText(tail))]);
  } else if (tail) merged = { ...be, runs: tail, marker: e.v === 0 ? be.marker : '' };
  else if (head) merged = { ...bs, runs: head };
  else merged = null;
  const at = s.b;
  // 行をまたいで消して何も残らなければ、見出し・箇条書きの記号も残さず、ふつうの空行にする（全部選んで消したとき）
  if (merged && merged.kind !== 'att' && !runsLength(merged.runs) && s.v === 0) { merged.kind = 'p'; merged.marker = ''; }
  next.blocks.splice(s.b, e.b - s.b + 1, ...(merged ? [merged] : []));
  ensureShape(next.blocks);
  const idx = Math.min(at, next.blocks.length - 1);
  next.sel = caret(idx, merged ? s.v : 0);
  renumber(next.blocks);
  return next;
}

// ------------------------------------------------------------------ 文字の挿入
/** キャレットの位置の印を引き継ぐ run にする（リンク・コードは引き継がない） */
function marksAt(runs, v) {
  let at = 0, marks = [];
  for (const r of runs) {
    if (at + r.text.length >= v && at < v + (v === 0 ? 1 : 0)) { marks = r.marks.filter(m => m.t !== 'link' && m.t !== 'code'); break; }
    at += r.text.length;
  }
  return marks;
}

/** 選択を消して runs を入れる */
export function insertRuns(st, ins) {
  const cur = deleteSelection(st);
  const next = clone(cur);
  const { b, v } = next.sel.s;
  const blk = next.blocks[b];
  if (blk.kind === 'att') return cur;
  const add = blk.kind === 'code' ? plainRun(runsText(ins)) : ins;
  blk.runs = mergeRuns([...sliceRuns(blk.runs, 0, v), ...add, ...sliceRuns(blk.runs, v)]);
  next.sel = caret(b, v + runsLength(add));
  return next;
}

/** 選択を消して文字を入れる（書式は引き継ぐ。改行は入れない） */
export function insertText(st, text) {
  const cur = deleteSelection(st);
  const { b, v } = cur.sel.s;
  return insertRuns(cur, plainRun(text).map(r => ({ ...r, marks: cur.blocks[b].kind === 'code' ? [] : marksAt(cur.blocks[b].runs, v) })));
}

/** 選択を消して、印の無い文字を入れる（強調・コード・リンクの直後で、その外へ打つとき） */
export function insertPlain(st, text) {
  return insertRuns(st, plainRun(text));
}

// ------------------------------------------------------------------ 次の行の記号
/** 記号の並びの先頭 n 個を、行の記号のまま（項目の記号を空白にしないで）残したときの種類 */
function kindOfMarks(marks, n, prefix) {
  if (!prefix || n <= 0) return 'p';
  const m = marks[n - 1];
  if (m.node.t === 'bq') return 'quote';
  return m.opened ? (m.node.parent.ordered ? 'ol' : 'ul') : 'cont';
}

/** 項目 item を始めた行の、その項目の記号の部分（前の記号の後ろから。番号を進める元） */
function itemSegOf(S, blocks, item) {
  const bi = S.idx[item.start], li = S.info[bi];
  const k = li?.marks.findIndex((m) => m.node === item) ?? -1;
  return k < 0 ? null : segOf(blockRaw(blocks[bi]), li.marks, k);
}

/**
 * Enter で行を割ったときの、下の行の種類と記号。項目は次の項目（番号は 1 つ進める）、引用・項目の中の続きの行・コードは同じ入れ物の中の行、
 * 見出し・段落はその入れ物の中の続きの行（入れ物の外なら段落）
 */
function nextLineOf(blocks, b, S = docStructure(blocks)) {
  const blk = blocks[b], li = S.info[b], raw = blockRaw(blk);
  const own = ownMarks(li, blk), n = own.length;
  if (blk.kind === 'cont') return { kind: 'cont', marker: blk.marker };
  if (blk.kind === 'code') { const all = li?.marks ?? []; const marker = contPrefix(raw, all); return { kind: 'code', marker }; }
  if ((blk.kind === 'ul' || blk.kind === 'ol') && own.at(-1)?.opened && own.at(-1).node.t === 'item') {
    return { kind: blk.kind, marker: contPrefix(raw, own, n - 1) + nextItemSeg(segOf(raw, own, n - 1)) };
  }
  if (blk.kind === 'ul' || blk.kind === 'ol') return { kind: blk.kind, marker: blk.marker.replace(/(\d{1,9})([.)])/, (_, x, d) => `${Number(x) + 1}${d}`) };
  const marker = contPrefix(raw, own);
  return { kind: marker ? contKind(own, n) : 'p', marker };
}

// ------------------------------------------------------------------ 番号の振り直し・字下げ
/** 行の記号の中の、文字の位置 p から続く空白の幅を、桁で delta だけ増やす（後ろに空白を足す。タブは残す）・減らす（空白にそろえる）。記号を返す */
function shiftRun(marker, p, delta) {
  const q = p + /^[ \t]*/.exec(marker.slice(p))[0].length;
  if (delta > 0) return marker.slice(0, q) + ' '.repeat(delta) + marker.slice(q);
  const width = columnOf(marker, q) - columnOf(marker, p);
  return marker.slice(0, p) + ' '.repeat(Math.max(0, width + delta)) + marker.slice(q);
}

/** 項目 item の範囲で、その項目の記号を持つ行（空行・遅延の続きは除く）。{ i: ブロックの添字, k: 記号の並びの中の項目の位置 } */
function itemLines(S, blocks, item) {
  const out = [];
  for (let ln = item.start; ln <= item.end; ln++) {
    const i = S.idx[ln], li = S.info[i];
    if (!li || li.role === 'blank' || li.role === 'lazy') continue;
    const own = ownMarks(li, blocks[i]);
    const k = own.findIndex((m) => m.node === item);
    if (k >= 0) out.push({ i, k, li, own });
  }
  return out;
}

/**
 * 番号の振り直し（blocks の要素を差し替える。ブロック自体は書き換えない。変えたら true）。番号のリストごとに、最初の番号から 1 つずつ数える
 * （元の番号が 3, 7 なら 3, 4）。番号の桁が変わったら、その項目の続きの行の字下げも同じだけずらす（項目の中に残す）
 */
export function renumber(blocks) {
  const S = docStructure(blocks);
  const edits = [];   // { i, p, del, ins }（ブロックの記号の中の文字の位置）
  const walk = (node) => {
    for (const c of node.children) {
      if (c.t === 'list' && c.ordered) {
        c.children.forEach((item, k) => {
          const want = String((c.startNum ?? 1) + k);
          const lines = itemLines(S, blocks, item);
          const open = lines.find((l) => l.li.marks[l.k].opened && S.idx[item.start] === l.i);
          if (!open) return;
          const m = open.own[open.k], marker = blocks[open.i].marker;
          const digits = /^\d{1,9}/.exec(marker.slice(m.at))?.[0];
          if (!digits || digits === want) return;
          edits.push({ i: open.i, p: m.at, del: digits.length, ins: want });
          const d = want.length - digits.length;
          if (!d) return;
          for (const l of lines) {
            if (l === open) continue;
            const at = l.own[l.k].at, mk = blocks[l.i].marker;
            if (d > 0) edits.push({ i: l.i, p: at, del: 0, ins: ' '.repeat(d) });
            else edits.push({ i: l.i, p: at, del: Math.min(-d, /^ */.exec(mk.slice(at))[0].length), ins: '' });
          }
        });
      }
      walk(c);
    }
  };
  walk(S.root);
  if (!edits.length) return false;
  // 同じ行の直しは後ろから（前の直しで位置がずれない。入れ子の内側の記号は外側より後ろにある）
  const byBlock = new Map();
  for (const e of edits) (byBlock.get(e.i) ?? byBlock.set(e.i, []).get(e.i)).push(e);
  for (const [i, list] of byBlock) {
    let marker = blocks[i].marker;
    for (const e of list.sort((a, b) => b.p - a.p)) marker = marker.slice(0, e.p) + e.ins + marker.slice(e.p + e.del);
    blocks[i] = { ...blocks[i], marker };
  }
  return true;
}

/** 選択にかかる項目を始める行（ブロックの添字と、その行で始まった一番内側の項目） */
function selectedItems(S, blocks, s, e) {
  const out = [];
  for (let i = s; i <= e; i++) {
    const b = blocks[i];
    if (b?.kind !== 'ul' && b?.kind !== 'ol') continue;
    const m = ownMarks(S.info[i], b).at(-1);
    if (m?.opened && m.node.t === 'item') out.push(i);
  }
  return out;
}

/**
 * Tab（dir = 1）・Shift+Tab（dir = -1）で、選択にかかる項目を 1 段深く・浅くする（項目の中の行・入れ子の項目も一緒に動く）。
 * Tab は前の項目の中身の桁へ（その項目の子になる）、Shift+Tab は親の項目の記号の桁へ（親の次の項目になる）。段の数に限りは無い。
 * 選択に項目の行が無い・Shift+Tab で何も変わらないときは null（フォーカスを動かしてよい）。Tab で動かせる項目が無いときは同じ状態を返す（キーは欄の中で使う）
 */
export function indentList(st, dir) {
  const { s, e } = orderSel(st.sel.s, st.sel.e);
  const next = clone(st);
  const first = selectedItems(docStructure(next.blocks), next.blocks, s.b, e.b);
  if (!first.length) return null;
  const moved = new Set();
  let any = false;
  for (const i of first) {
    if (moved.has(i)) continue;
    // 動かすたびに読み直す（前の項目を動かすと、後ろの項目の親・兄弟が変わる）
    const S = docStructure(next.blocks);
    const m = ownMarks(S.info[i], next.blocks[i]).at(-1);
    if (!m?.opened || m.node.t !== 'item') continue;
    const item = m.node, list = item.parent, lines = itemLines(S, next.blocks, item);
    let delta = 0, holder = null;
    if (dir > 0) {
      const prev = list.children[list.children.indexOf(item) - 1];
      if (!prev) continue;
      delta = prev.markerOffset + prev.padding - item.markerOffset;
      holder = (l) => l.k - 1;
    } else {
      const parent = list.parent;
      if (parent?.t !== 'item') continue;
      const pk = S.info[i].marks.findIndex((x) => x.node === parent);
      if (pk < 0 || S.info[i].marks[pk].opened) continue;   // 親の項目と同じ行で始まった項目（`- - a`）は動かさない
      delta = -(parent.padding + item.markerOffset);
      holder = (l) => l.own.findIndex((x) => x.node === parent) - 1;
    }
    if (!delta) continue;
    for (const l of lines) {
      const h = holder(l);
      if (h < -1 || (dir < 0 && !l.own.some((x) => x.node === list.parent))) continue;
      const b = next.blocks[l.i];
      let marker = shiftRun(b.marker, h >= 0 ? l.own[h].end : 0, delta);
      // 深くした番号の項目は、新しいリストの 1 番から（入る先に番号のリストがあれば、振り直しがそろえる）
      if (dir > 0 && l.i === i && list.ordered) marker = marker.replace(/\d{1,9}(?=[.)][ \t]*$)/, '1');
      next.blocks[l.i] = { ...b, marker };
      moved.add(l.i);
    }
    any = true;
  }
  if (!any) return dir > 0 ? next : null;
  renumber(next.blocks);
  return next;
}

// ------------------------------------------------------------------ Enter
/** soft: Shift+Enter（項目の中の改行）。plain: 整形しない平文の間 */
export function enter(st, { plain = false, soft = false } = {}) {
  const cur = deleteSelection(st);
  const next = clone(cur);
  const { b, v } = next.sel.s;
  const blk = next.blocks[b];
  const finish = () => { renumber(next.blocks); return next; };
  // 添付・閉じフェンスの次に足してあった pad は、そのまま本物の行にする（空行を重ねない）
  const below = (kind = 'p', marker = '') => {
    if (next.blocks[b + 1]?.pad && isEmptyBlock(next.blocks[b + 1])) next.blocks[b + 1] = { kind, marker, runs: [] };
    else next.blocks.splice(b + 1, 0, { kind, marker, runs: [] });
    next.sel = caret(b + 1, 0);
    return next;
  };
  if (blk.kind === 'att') return below();
  const S = plain ? null : docStructure(next.blocks);
  const li = S?.info[b], raw = blockRaw(blk), own = ownMarks(li, blk);
  const left = sliceRuns(blk.runs, 0, v), right = sliceRuns(blk.runs, v);
  delete blk.pad;
  const insertBelow = (kind, marker, runs, at) => {
    blk.runs = left;
    next.blocks.splice(b + 1, 0, { kind, marker, runs });
    next.sel = caret(b + 1, at);
    return finish();
  };
  /**
   * 空の行で抜ける: 記号の並びの upto 個目から後ろを外す。上の行が段落なら、間に入れ物の中の空行を挟んでから下の行へ
   * （挟まないと、次に打った字が上の項目・引用の続き（遅延の続き）として読まれる）
   */
  const leave = (upto) => {
    const marker = contPrefix(raw, own, upto);
    next.blocks[b] = { kind: marker ? contKind(own, upto) : 'p', marker, runs: [] };
    const k = S.idx.indexOf(b), above = S.lines[k - 1]?.role;
    if (above === 'para' || above === 'lazy' || above === 'table') {
      next.blocks.splice(b + 1, 0, { ...next.blocks[b] });
      next.sel = caret(b + 1, 0);
    } else next.sel = caret(b, 0);
    return finish();
  };
  if (!plain && blk.kind === 'cont') {
    if (soft) return insertBelow('cont', blk.marker, right, 0);
    if (!blk.runs.length) return leave(own.length - 1);
    // 項目の中の続きの行で Enter: 一番内側の項目の次の項目を始める
    const k = own.findLastIndex((m) => m.node.t === 'item');
    const seg = k >= 0 ? itemSegOf(S, next.blocks, own[k].node) : null;
    if (seg === null) return insertBelow('p', '', right, 0);
    return insertBelow(own[k].node.parent.ordered ? 'ol' : 'ul', contPrefix(raw, own, k) + nextItemSeg(seg), right, 0);
  }
  // Shift+Enter: 項目の中の改行（項目の中身の桁にそろえた続きの行）。引用は引用のまま続く（下の listLike）
  if (!plain && soft && (blk.kind === 'ul' || blk.kind === 'ol')) {
    return insertBelow('cont', contPrefix(raw, own), right, 0);
  }
  // ・ • ･ で始まる行は、Enter を押したときに箇条書きと見なす（同じ字で続ける。空の項目で抜ける）
  if (!plain && !soft && blk.kind === 'p') {
    const text = runsText(blk.runs);
    const bullet = RE_BULLET_CHAR.exec(text)?.[0];
    if (bullet && v >= bullet.length && !sliceRuns(blk.runs, 0, bullet.length).some(r => r.marks.length)) {
      if (text.length === bullet.length) { blk.runs = []; next.sel = caret(b, 0); return next; }
      return insertBelow('p', '', mergeRuns([...plainRun(bullet), ...right]), bullet.length);
    }
  }
  const listLike = !plain && (blk.kind === 'ul' || blk.kind === 'ol' || blk.kind === 'quote');
  if (listLike) {
    // チェック欄（- [ ] ）は、次の項目も未チェックの [ ] から始める
    const check = blk.kind === 'ul' ? RE_CHECK.exec(runsText(blk.runs))?.[0] : null;
    const carry = check && v >= check.length ? '[ ] ' : '';
    if (carry ? runsText(blk.runs).length === check.length : !blk.runs.length) {
      const n = own.length;
      // 空の項目: 親の項目の中にあれば、親の次の項目にする（1 段戻す）。そうでなければ一番内側の入れ物から抜ける
      const parentAt = n >= 2 && blk.kind !== 'quote' && own[n - 2].node.t === 'item' ? n - 2 : -1;
      if (parentAt >= 0) {
        const parent = own[parentAt].node, seg = itemSegOf(S, next.blocks, parent);
        if (seg !== null) {
          next.blocks[b] = { kind: parent.parent.ordered ? 'ol' : 'ul', marker: contPrefix(raw, own, parentAt) + nextItemSeg(seg), runs: plainRun(carry) };
          next.sel = caret(b, carry.length);
          return finish();
        }
      }
      return leave(Math.max(0, n - 1));
    }
    const { kind, marker } = nextLineOf(next.blocks, b, S);
    return insertBelow(kind, marker, mergeRuns([...plainRun(carry), ...right]), carry.length);
  }
  if (blk.kind === 'h' && v === 0 && blk.runs.length) {
    next.blocks.splice(b, 0, emptyBlock());
    next.sel = caret(b + 1, 0);
    return next;
  }
  if (blk.kind === 'code') {
    const marker = contPrefix(raw, li?.marks ?? []);
    if (li?.role === 'fence-close' && v >= runsLength(blk.runs)) return below(marker ? contKind(li.marks, li.marks.length) : 'p', marker);
    const indent = /^[ \t]*/.exec(runsText(left))[0];
    blk.runs = left;
    next.blocks.splice(b + 1, 0, codeBlock(indent + runsText(right), marker));
    next.sel = caret(b + 1, indent.length);
    return next;
  }
  const { kind, marker } = plain ? { kind: 'p', marker: '' } : nextLineOf(next.blocks, b, S);
  blk.runs = left;
  next.blocks.splice(b + 1, 0, { kind, marker, runs: right });
  next.sel = caret(b + 1, 0);
  return next;
}

// ------------------------------------------------------------------ Backspace / Delete（ブロックの端）
/** 行頭の Backspace。書式の行は一番内側の記号を外し（入れ子の項目・引用は 1 段ずつ）、本文の行は前の行とつなぐ（前が添付ならその添付を外す） */
export function backspaceAtStart(st) {
  const next = clone(deleteSelection(st));
  const { b } = next.sel.s;
  const blk = next.blocks[b];
  if (blk.kind === 'h' || blk.kind === 'ul' || blk.kind === 'ol' || blk.kind === 'quote' || blk.kind === 'cont') {
    const own = ownMarks(docStructure(next.blocks).info[b], blk);
    const n = blk.kind === 'h' ? own.length : Math.max(0, own.length - 1);
    const marker = blk.marker.slice(0, own[n - 1]?.end ?? 0);
    next.blocks[b] = { ...blk, kind: kindOfMarks(own, n, marker), marker };
    next.sel = caret(b, 0);
    renumber(next.blocks);
    return next;
  }
  if (b === 0) return next;
  const prev = next.blocks[b - 1];
  if (prev.kind === 'att') {
    next.blocks.splice(b - 1, 1);
    ensureShape(next.blocks);
    next.sel = caret(Math.min(b - 1, next.blocks.length - 1), 0);
    return next;
  }
  const at = runsLength(prev.runs);
  const runs = prev.kind === 'code' || blk.kind === 'code'
    ? plainRun(runsText(prev.runs) + runsText(blk.runs))
    : mergeRuns([...prev.runs, ...blk.runs]);
  const kind = prev.kind === 'code' && blk.kind !== 'code' ? 'code' : prev.kind;
  next.blocks.splice(b - 1, 2, { ...prev, kind, marker: prev.marker, runs, pad: undefined });
  ensureShape(next.blocks);
  next.sel = caret(b - 1, at);
  renumber(next.blocks);
  return next;
}

/** 行末の Delete。次が添付ならその添付を外し、そうでなければ次の行をつなぐ */
export function deleteAtEnd(st) {
  const next = clone(deleteSelection(st));
  const { b } = next.sel.s;
  if (b >= next.blocks.length - 1) return next;
  const after = next.blocks[b + 1];
  const here = next.blocks[b];
  if (after.kind === 'att') {
    next.blocks.splice(b + 1, 1);
    ensureShape(next.blocks);
    next.sel = caret(b, next.sel.s.v);
    return next;
  }
  const at = runsLength(here.runs);
  const runs = here.kind === 'code' || after.kind === 'code'
    ? plainRun(runsText(here.runs) + runsText(after.runs))
    : mergeRuns([...here.runs, ...after.runs]);
  next.blocks.splice(b, 2, { ...here, kind: here.kind === 'att' ? 'p' : here.kind, runs, pad: undefined });
  ensureShape(next.blocks);
  next.sel = caret(b, at);
  renumber(next.blocks);
  return next;
}

// ------------------------------------------------------------------ 添付（原子）
/**
 * キャレットの位置に添付を入れる。空の行なら置き換え、行の途中なら前後に割る。コードブロックの中なら閉じの後ろ。
 * 入れた後のキャレットは、添付の次の行の頭（無ければ pad を足す）
 */
export function insertAtom(st, atom) {
  const cur = deleteSelection(st);
  const next = clone(cur);
  let { b, v } = next.sel.s;
  const blk = next.blocks[b];
  let at;   // 添付を置く添字
  if (blk.kind === 'code') {
    const S = docStructure(next.blocks), node = S.info[b]?.node;
    at = (node?.t === 'code' ? S.idx[node.end] ?? b : b) + 1;
    next.blocks.splice(at, 0, atom);
  } else if (blk.kind === 'att') {
    at = b + 1;
    next.blocks.splice(at, 0, atom);
  } else if (!blk.runs.length) {
    at = b;
    next.blocks.splice(b, 1, atom);
  } else if (v === 0) {
    at = b;
    next.blocks.splice(b, 0, atom);
  } else if (v >= runsLength(blk.runs)) {
    at = b + 1;
    next.blocks.splice(at, 0, atom);
  } else {
    const { kind, marker } = nextLineOf(next.blocks, b);
    const left = sliceRuns(blk.runs, 0, v), right = sliceRuns(blk.runs, v);
    blk.runs = left;
    at = b + 1;
    next.blocks.splice(at, 0, atom, { kind, marker, runs: right });
    next.sel = caret(at + 1, 0);
    ensureShape(next.blocks);
    return next;
  }
  const after = next.blocks[at + 1];
  if (!after || after.kind === 'att') next.blocks.splice(at + 1, 0, { ...emptyBlock(), pad: true });
  ensureShape(next.blocks);
  next.sel = caret(next.blocks.indexOf(atom) + 1, 0);
  return next;
}

/** 条件に合う添付を外す */
export function removeAtoms(st, pred) {
  const next = clone(st);
  const at = next.sel.s.b;
  let shift = 0;
  next.blocks = next.blocks.filter((b, i) => {
    const drop = b.kind === 'att' && pred(b);
    if (drop && i < at) shift++;
    return !drop;
  });
  ensureShape(next.blocks);
  const idx = Math.max(0, Math.min(at - shift, next.blocks.length - 1));
  next.sel = caret(idx, Math.min(next.sel.s.v, next.blocks[idx].kind === 'att' ? 0 : runsLength(next.blocks[idx].runs)));
  return next;
}

/** removeAtoms の後で、添付の隣でも閉じたコードの後ろでもなくなった余白の行（pad）も外す（取れなかった画像の札を、何も残さずに消すとき） */
export function removeAtomsTidy(st, pred) {
  const next = removeAtoms(st, pred);
  const at = next.sel.s.b;
  let shift = 0;
  const { info } = docStructure(next.blocks);
  const keep = next.blocks.filter((b, i, all) => {
    const stray = b.pad && isEmptyBlock(b) && all.length > 1 && all[i - 1]?.kind !== 'att' && all[i + 1]?.kind !== 'att'
      && !(all[i - 1]?.kind === 'code' && info[i - 1]?.role === 'fence-close');
    if (stray && i < at) shift++;
    return !stray;
  });
  next.blocks = ensureShape(keep);
  const idx = Math.max(0, Math.min(at - shift, next.blocks.length - 1));
  next.sel = caret(idx, Math.min(next.sel.s.v, next.blocks[idx].kind === 'att' ? 0 : runsLength(next.blocks[idx].runs)));
  return next;
}

export const atomKey = (b) => (b.path ? `p:${normalizeAttachmentPath(b.path)}` : b.pid ? `i:${b.pid}` : null);
export const atomKeys = (blocks) => new Set(blocks.filter(b => b.kind === 'att').map(atomKey).filter(Boolean));

export function newAtom({ path, pid, locale = 'ja' }) {
  return { kind: 'att', marker: '', runs: [], ...(path ? { path, raw: attachmentLine(locale, path) } : {}), ...(pid ? { pid } : {}) };
}
export { ATTACHMENT_MARKS };

// ------------------------------------------------------------------ 貼り付け
/** 文字を貼る。1 行なら今の行へ（記法は整える）。複数行なら行ごとにブロックへ（空の行なら置き換え） */
export function pasteText(st, text, { plain = false, resolve = () => null } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const cur = deleteSelection(st);
  const { b } = cur.sel.s;
  const blk = cur.blocks[b];
  if (!src.includes('\n')) return insertRuns(cur, plain || blk.kind === 'code' ? plainRun(src) : parseInline(src));
  // コードブロックの中へ貼った行は、同じ入れ物の中のコードの行（リスト・引用の中のコードなら、その字下げ・`>` を付ける）
  const codeMarker = blk.kind === 'code' ? contPrefix(blockRaw(blk), docStructure(cur.blocks).info[b]?.marks ?? []) : '';
  const parsed = blk.kind === 'code' ? src.split('\n').map((line) => codeBlock(line, codeMarker)) : markdownToDoc(src, { resolve, plain }).filter(x => !x.pad);
  return spliceParsed(cur, parsed, { resolve, plain });
}

/**
 * 貼り付けの HTML（web/html-paste.mjs）を入れる。parts は { md: 1 行の Markdown } と { atom: 添付のブロック } の並び。
 * 1 行の字だけなら今の行へ（記法は整える）。ほかは行ごとにブロックへ。先頭がふつうの段落なら今の行につなぎ、見出し・リスト・引用・コード・添付なら次の行から始める
 */
export function pasteRich(st, parts, { resolve = () => null } = {}) {
  if (parts.length === 1 && parts[0].md !== undefined && classifyLine(parts[0].md).kind === 'p' && !ATTACHMENT_LINE.test(parts[0].md.trim())) return pasteText(st, parts[0].md, { resolve });
  const cur = deleteSelection(st);
  const parsed = [];
  let lines = [];
  const flushLines = () => { if (lines.length) { parsed.push(...markdownToDoc(lines.join('\n'), { resolve }).filter(x => !x.pad)); lines = []; } };
  for (const part of parts) { if (part.md !== undefined) lines.push(part.md); else { flushLines(); parsed.push(part.atom); } }
  flushLines();
  if (!parsed.length) return cur;
  return spliceParsed(cur, parsed, { resolve, rich: true });
}

/** 解いたブロックを、キャレットの行へ差し込む（pasteText・pasteRich の本体）。cur は選択を消した後の状態 */
function spliceParsed(cur, parsed, { plain = false, resolve = () => null, rich = false } = {}) {
  const { b, v } = cur.sel.s;
  const blk = cur.blocks[b];
  const next = clone(cur);
  const inCode = blk.kind === 'code';
  const cutAt = blk.kind === 'att' ? null : v;
  const left = blk.kind === 'att' ? null : { ...blk, runs: sliceRuns(blk.runs, 0, cutAt), pad: undefined };
  const tailOf = blk.kind === 'att' ? null : plain ? { kind: 'p', marker: '' } : blk.kind === 'h' ? { kind: 'p', marker: '' } : nextLineOf(cur.blocks, b);
  const right = blk.kind === 'att' ? null : { ...tailOf, runs: sliceRuns(blk.runs, cutAt) };
  const seq = [];
  if (left && (left.runs.length || left.marker)) seq.push(left);
  const firstIdx = seq.length;
  seq.push(...clone(parsed));
  // 空の頭の行は貼った先頭の行と一体（記号ごと置き換える）。中身のある行なら、貼った先頭の行の中身を後ろにつなぐ
  if (firstIdx === 1 && seq[1].kind !== 'att' && seq[0].kind !== 'att' && !(inCode) && (!rich || seq[1].kind === 'p')) {
    seq[0] = { ...seq[0], runs: mergeRuns([...seq[0].runs, ...seq[1].runs]) };
    seq.splice(1, 1);
  } else if (firstIdx === 1 && inCode) {
    seq[0] = { ...seq[0], runs: plainRun(runsText(seq[0].runs) + runsText(seq[1].runs)) };
    seq.splice(1, 1);
  }
  let caretAt = seq.length - 1;
  let caretV = seq.at(-1).kind === 'att' ? 0 : runsLength(seq.at(-1).runs);
  if (right && right.runs.length) {
    const last = seq.at(-1);
    if (last.kind === 'att') { seq.push(right); caretAt = seq.length - 1; caretV = 0; }
    else {
      caretV = runsLength(last.runs);
      last.runs = last.kind === 'code' ? plainRun(runsText(last.runs) + runsText(right.runs)) : mergeRuns([...last.runs, ...right.runs]);
    }
  }
  next.blocks.splice(b, 1, ...seq);
  const idx = b + caretAt;
  const sel = caret(Math.min(idx, next.blocks.length - 1), caretV);
  normalizeFences(next.blocks, { resolve, plain, sel });
  ensureShape(next.blocks);
  next.sel = caret(Math.min(sel.s.b, next.blocks.length - 1), sel.s.v);
  return next;
}

// ------------------------------------------------------------------ 構造との整合
/**
 * 行の種類と記号を、構造の読み方（web/md-structure.mjs。履歴と同じ）に合わせる。コードの中に入った行は code に、コードから出た行・
 * 構造と合わなくなった書式の行（親の項目が消えた続きの行など）は読み直す。書き換えたら true。
 * undo で戻した「記号のままの行」を勝手に書式にしないよう、段落（p）は書式にしない。sel を渡すと、読み直した行の中の位置を同じ字の上に移す
 */
export function normalizeFences(blocks, { resolve = () => null, plain = false, raw = blockRaw, sel = null } = {}) {
  if (plain) return false;
  const S = docStructure(blocks, raw);
  let changed = false;
  blocks.forEach((b, i) => {
    const li = S.info[i];
    if (!li) return;
    const text = raw(b), code = CODE_ROLES.has(li.role);
    const redo = b.kind === 'att' ? code
      : b.kind === 'code' ? !code || b.marker !== text.slice(0, prefixEnd(li))
      : code || !agrees(b, li, text);
    if (!redo) return;
    // 中身の無い箇条書きの行は、構造を読むときに中身を足してある（docStructure）。読み直すときは足した字を除く
    const nb = lineBlock(text, li, { resolve });
    if (nb.kind === b.kind && nb.marker === b.marker) return;
    if (sel) for (const k of ['s', 'e']) if (sel[k].b === i) sel[k] = { b: i, v: vOfRaw(nb, rawOffsetOf(b, sel[k].v)) };
    blocks[i] = nb;
    changed = true;
  });
  return changed;
}

// ------------------------------------------------------------------ 打った直後の整形
const BLOCK_TRIGGER = /^(#{1,6}|[-*+]|\d{1,9}[.)]|>) $/;

function runAt(runs, v) {
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    if (v > at && v <= at + runs[i].text.length) return { i, o: v - at, at };
    at += runs[i].text.length;
  }
  return null;
}

function inlinePattern(prefix, ch) {
  const c = prefix.length - 1;   // 打った字（prefix の末尾）
  const escaped = (k) => prefix[k - 1] === '\\';
  if (ch === '`') {
    let k = c - 1;
    while (k >= 0 && prefix[k] !== '`') k--;
    if (k < 0 || k === c - 1 || prefix[k - 1] === '`' || escaped(k)) return null;
    const content = prefix.slice(k + 1, c);
    return content.includes('`') ? null : { t: 'code', start: k, content, d: '`' };
  }
  if (ch === ')') {
    const m = /\[([^\[\]]+)\]\(([^()\s]+)\)$/.exec(prefix);
    if (!m || prefix[m.index - 1] === '!' || prefix[m.index - 1] === '\\') return null;
    return { t: 'link', start: m.index, content: m[1], url: m[2] };
  }
  if (ch !== '*' && ch !== '_') return null;
  const wordBefore = (k) => ch === '_' && k > 0 && WORD.test(prefix[k - 1]);
  const okContent = (s) => s && !/^\s|\s$/.test(s);
  if (prefix[c - 1] === ch) {
    // 太字: 直前も同じ字（** を閉じた）
    const d = ch + ch, close = c - 1;
    let k = prefix.lastIndexOf(d, close - 1);
    while (k >= 0 && (prefix[k - 1] === ch || escaped(k))) k = k > 0 ? prefix.lastIndexOf(d, k - 1) : -1;
    if (k < 0) return null;
    const content = prefix.slice(k + 2, close);
    return okContent(content) && !wordBefore(k) ? { t: 'strong', start: k, content, d } : null;
  }
  for (let k = c - 1; k >= 0; k--) {
    if (prefix[k] !== ch) continue;
    if (prefix[k - 1] === ch || prefix[k + 1] === ch || escaped(k)) continue;
    const content = prefix.slice(k + 1, c);
    return okContent(content) && !wordBefore(k) ? { t: 'em', start: k, content, d: ch } : null;
  }
  return null;
}

/**
 * 字を 1 つ打った直後に整える。ch は打った字、キャレットは打った字の直後。整えたら { state, kind }、無ければ null。
 *   行頭 `# `・`- `・`1. `・`> ` で行の種類（項目の中の行・引用の行でも。入れ子の項目・引用・項目の中の見出しになる）、行頭の ``` でコードブロック（閉じも足す）。
 *   行の種類は、履歴と同じ構造の読み方でその種類になるときだけ変える（段落の続きの `2. ` は項目にならないので変えない）
 *   `code`・**太字**・*斜体*・[文字](URL) は閉じた字を打った時点で
 */
export function applyTriggers(st, ch, { plain = false } = {}) {
  if (plain || !isCollapsed(st.sel)) return null;
  const { b, v } = st.sel.s;
  const blk = st.blocks[b];
  if (!blk || blk.kind === 'att' || blk.kind === 'code') return null;
  const text = runsText(blk.runs);
  const lineStart = blk.kind === 'p' || blk.kind === 'cont' || blk.kind === 'quote';
  if (lineStart && ch === ' ') {
    const head = text.slice(0, v);
    const m = BLOCK_TRIGGER.exec(head);
    if (m && serializeRuns(sliceRuns(blk.runs, 0, v)) === head) {
      const next = clone(st);
      const kind = head[0] === '#' ? 'h' : head[0] === '>' ? 'quote' : /\d/.test(head[0]) ? 'ol' : 'ul';
      const nb = { kind, marker: blk.marker + head, runs: sliceRuns(blk.runs, v) };
      next.blocks[b] = nb;
      if (agrees(nb, docStructure(next.blocks).info[b], blockRaw(nb))) {
        next.sel = caret(b, 0);
        return { state: next, kind: 'block' };
      }
    }
  }
  if (lineStart && ch === '`' && text.slice(0, v) === '```') {
    const next = clone(st);
    const own = ownMarks(docStructure(st.blocks).info[b], blk), inner = contPrefix(blockRaw(blk), own);
    next.blocks[b] = codeBlock('```' + text.slice(v), blk.marker);
    next.blocks.splice(b + 1, 0, codeBlock('', inner), codeBlock('```', inner));
    ensureShape(next.blocks);
    next.sel = caret(b, 3);
    return { state: next, kind: 'fence' };
  }
  const at = runAt(blk.runs, v);
  if (!at) return null;
  const run = blk.runs[at.i];
  if (run.marks.length || run.text[at.o - 1] !== ch) return null;
  const pat = inlinePattern(run.text.slice(0, at.o), ch);
  if (!pat) return null;
  const next = clone(st);
  const target = next.blocks[b];
  const r = target.runs[at.i];
  const pre = r.text.slice(0, pat.start), post = r.text.slice(at.o);
  const mark = newMark(pat.t, pat.t === 'link' ? { url: pat.url } : { d: pat.d });
  const middle = pat.t === 'code' ? { text: pat.content, marks: [mark] } : { text: pat.content, marks: [mark] };
  target.runs = mergeRuns([...target.runs.slice(0, at.i), { text: pre, marks: [] }, middle, { text: post, marks: [] }, ...target.runs.slice(at.i + 1)]);
  next.sel = caret(b, at.at + pat.start + pat.content.length);
  next.sel.after = true;
  return { state: next, kind: 'inline' };
}

// ------------------------------------------------------------------ 書式バー
/** 選択の範囲に強調・コード・リンクを付ける（範囲がすべて付いていれば外す）。1 つのブロックの中だけ */
export function toggleMark(st, type, { url } = {}) {
  const { s, e } = st.sel;
  if (s.b !== e.b || s.v === e.v) return st;
  const next = clone(st);
  const blk = next.blocks[s.b];
  if (blk.kind === 'att' || blk.kind === 'code') return st;
  const left = sliceRuns(blk.runs, 0, s.v), mid = sliceRuns(blk.runs, s.v, e.v), right = sliceRuns(blk.runs, e.v);
  const all = mid.length && mid.every(r => r.marks.some(m => m.t === type));
  let midOut;
  if (all) midOut = mid.map(r => ({ text: r.text, marks: r.marks.filter(m => m.t !== type) }));
  else {
    const mark = newMark(type, type === 'link' ? { url } : type === 'strong' ? { d: '**' } : type === 'em' ? { d: '*' } : { d: '`' });
    midOut = mid.map(r => ({ text: r.text, marks: type === 'code' ? [mark] : [...r.marks.filter(m => m.t !== type), mark] }));
  }
  blk.runs = mergeRuns([...left, ...midOut, ...right]);
  next.sel = { s: { b: s.b, v: s.v }, e: { b: s.b, v: e.v } };
  return next;
}

/** 選択の範囲が今どの書式か（書式バーの押された状態） */
export function marksInRange(st) {
  const { s, e } = st.sel;
  if (s.b !== e.b || s.v === e.v) return new Set();
  const blk = st.blocks[s.b];
  if (blk.kind === 'att' || blk.kind === 'code') return new Set();
  const mid = sliceRuns(blk.runs, s.v, e.v);
  const out = new Set();
  for (const t of ['strong', 'em', 'code', 'link']) if (mid.length && mid.every(r => r.marks.some(m => m.t === t))) out.add(t);
  return out;
}

// ------------------------------------------------------------------ 選択の Markdown（コピー・切り取り）
export function selectionMarkdown(st) {
  const { s, e } = st.sel;
  if (isCollapsed(st.sel)) return '';
  const lines = [];
  for (let i = s.b; i <= e.b; i++) {
    const b = st.blocks[i];
    if (b.kind === 'att') { if (!omitted(b)) lines.push(blockRaw(b)); continue; }
    const from = i === s.b ? s.v : 0, to = i === e.b ? e.v : runsLength(b.runs);
    const whole = from === 0 && to >= runsLength(b.runs);
    if (b.kind === 'code') { lines.push((from === 0 ? b.marker : '') + runsText(sliceRuns(b.runs, from, to))); continue; }
    lines.push((whole || from === 0 ? b.marker : '') + sliceRaw(b.runs, from, to));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ 元に戻す
const sameBlock = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameBlocks = (a, b) => a.length === b.length && a.every((x, i) => sameBlock(x, b[i]));
/** 履歴の 1 件分。ブロックの並びだけ写し、ブロック自体は共有する（作った後に書き換えない約束）。選択は写す */
const keep = (state) => ({ blocks: state.blocks.slice(), sel: clone(state.sel) });

/**
 * 元に戻す・やり直しの履歴。状態（{ blocks, sel }）を並べる。ブロックは書き換えない前提で、変わらないブロックは履歴の間で共有する
 * （長い下書きで 1 打鍵ごとに文書全体を写さない）。
 * 文字を打つだけの変更は同じ行の中で続けて 1 つにまとめる（reason: 'type'）。整形・構造の変更はまとめない。
 * 整形の直前（記号のままの状態）と直後を別々に積むので、整えた直後の元に戻すで記号に戻る
 */
export function createHistory({ limit = 200, gap = 1000, now = () => Date.now() } = {}) {
  let stack = [], at = -1, lastAt = 0;
  return {
    reset(state) { stack = [{ state: keep(state), reason: 'init' }]; at = 0; lastAt = 0; },
    push(state, reason = 'edit') {
      const t = now();
      const top = stack[at];
      if (top && sameBlocks(top.state.blocks, state.blocks)) { top.state.sel = clone(state.sel); return false; }
      stack.length = at + 1;
      if (reason === 'type' && top?.reason === 'type' && state.sel.s.b === top.state.sel.s.b && t - lastAt < gap) {
        stack[at] = { state: keep(state), reason };
      } else {
        stack.push({ state: keep(state), reason });
        if (stack.length > limit) stack.shift();
        at = stack.length - 1;
      }
      lastAt = t;
      return true;
    },
    /**
     * すべての記録の状態を fn で書き換える（取れなかった画像の札を、戻す・やり直しにも出さない）。書き換えて同じになった隣の記録は 1 つにまとめる。
     * いまの位置は、同じ記録を指したまま
     */
    rewrite(fn) {
      const out = [];
      let to = 0;
      stack.forEach((entry, i) => {
        const state = fn(entry.state);
        const prev = out.at(-1);
        if (!(prev && sameBlocks(prev.state.blocks, state.blocks))) out.push({ state: keep(state), reason: entry.reason });
        if (i <= at) to = out.length - 1;
      });
      stack = out;
      at = to;
    },
    /** 選択だけを最新の記録に反映する（履歴は増やさない） */
    touch(sel) { if (stack[at]) stack[at].state.sel = clone(sel); },
    undo() { if (at <= 0) return null; at--; return keep(stack[at].state); },
    redo() { if (at >= stack.length - 1) return null; at++; return keep(stack[at].state); },
    get canUndo() { return at > 0; },
    get canRedo() { return at < stack.length - 1; },
    get size() { return stack.length; },
  };
}
