// Markdown のブロックの構造の解析と、字下げ・記号・番号の決まり（入力欄と履歴で共通。ADR 0292）。
//
// CommonMark のブロックの読み方（commonmark.js の 3 段: 開いている入れ物を続ける → 新しいブロックを始める → 段落の遅延の続き）を
// そのまま写した自前の部品（外部ライブラリは足さない。設計メモ §11）。行の並びを入れ子のブロックの木にし、行ごとに
// 「どの入れ物の記号を、その行のどこからどこまで読んだか」を持つ。
//   履歴（web/render.mjs）は木を HTML にし、入力欄（web/md-doc.mjs・web/md-editor.mjs）は行ごとの情報で 1 行の種類・字下げ・記号を決める。
// 扱わないもの: setext 見出し・HTML ブロック（生の HTML は文字のまま）・リンクの参照定義・文字参照（ADR 0292）。表は GFM の形（tables）。
//
// 節 { t, parent, children, open, start, end, depth, ... }（start・end は行の添字）
//   root・bq（引用）・list { ordered, bullet, delim, startNum, tight }・item { markerOffset, padding }
//   para { rows }・heading { level, text }・hr・code { fenced, fenceChar, fenceLength, fenceOffset, info, rows }・table { rows }
//   rows は [{ ln, text }]（text は入れ物の記号を除いた中身）
// 行 { marks: [{ node, at, end, opened }], node, role, at }
//   marks  その行で読んだ入れ物（引用・項目）の記号の範囲（文字の位置）。opened はその行で始まった項目・引用
//   node   その行が入った一番内側の節（空行は入れ物）
//   role   'para' | 'lazy' | 'heading' | 'hr' | 'table' | 'fence-open' | 'code' | 'fence-close' | 'icode' | 'blank'
//   at     中身の始まりの文字の位置

/** 入れ子の深さの上限（引用・リストの記号をこれより深くは読まない）。病的な入力で再帰が尽きないための安全の上限で、見た目の段の上限ではない */
export const MAX_NEST = 100;

const RE_SPECIAL = /^[#`~*+_=<>0-9|:-]/;
const RE_HR = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const RE_DELIM = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const isDelimRow = (s) => s.includes('|') && s.includes('-') && RE_DELIM.test(s);
const spaceOrTab = (c) => c === ' ' || c === '\t';
const canContain = (parent, child) => (parent === 'list' ? child === 'item' : (parent === 'root' || parent === 'bq' || parent === 'item') && child !== 'item');

/** 項目のあいだ・項目の中のブロックのあいだに空行があれば緩いリスト（CommonMark の tight / loose） */
function tightOf(list) {
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    if (items[i + 1] && items[i + 1].start > items[i].end + 1) return false;
    const ch = items[i].children;
    for (let j = 0; j + 1 < ch.length; j++) if (ch[j + 1].start > ch[j].end + 1) return false;
  }
  return true;
}

/**
 * 行の並び（または文字列）を解く。
 * @param {string | string[]} input
 * @param {{ tables?: boolean }} opts tables: GFM の表を読む（履歴。入力欄は表を整形しないが、行の役割は同じに読む）
 * @returns {{ root: object, lines: object[] }}
 */
export function parseStructure(input, { tables = true } = {}) {
  const src = Array.isArray(input) ? input : String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
  const root = { t: 'root', parent: null, children: [], open: true, start: 0, end: 0, depth: 0 };
  const info = [];
  let tip = root, oldtip = root, allClosed = true, lastMatched = root;
  let line = '', ln = 0, offset = 0, column = 0, nextNonspace = 0, nextNonspaceColumn = 0, indent = 0, indented = false, blank = false, partial = false;
  let cur = null, consumed = false;

  function findNextNonspace() {
    let i = offset, cols = column, c;
    while ((c = line[i]) !== undefined) {
      if (c === ' ') { i++; cols++; }
      else if (c === '\t') { i++; cols += 4 - (cols % 4); }
      else break;
    }
    blank = c === undefined;
    nextNonspace = i;
    nextNonspaceColumn = cols;
    indent = nextNonspaceColumn - column;
    indented = indent >= 4;
  }
  function advanceNextNonspace() { offset = nextNonspace; column = nextNonspaceColumn; partial = false; }
  /** count 文字（columns なら桁）進む。タブを桁で途中まで読んだときは offset をタブの上に残す（partial） */
  function advanceOffset(count, columns) {
    let c;
    while (count > 0 && (c = line[offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (column % 4);
        if (columns) {
          partial = toTab > count;
          const step = Math.min(count, toTab);
          column += step;
          offset += partial ? 0 : 1;
          count -= step;
        } else { partial = false; column += toTab; offset++; count--; }
      } else { partial = false; offset++; column++; count--; }
    }
  }
  function finalize(b, end) {
    b.open = false;
    if (b.t === 'para') b.end = b.rows.at(-1)?.ln ?? b.start;
    else if (b.t === 'item') b.end = b.children.at(-1)?.end ?? b.start;
    else if (b.t === 'list') { b.end = b.children.at(-1)?.end ?? b.start; b.tight = tightOf(b); }
    else if (b.t === 'code' && !b.fenced) {
      while (b.rows.length > 1 && !b.rows.at(-1).text.trim()) b.rows.pop();
      b.end = b.rows.at(-1)?.ln ?? b.start;
    } else if (b.t === 'table') b.end = b.rows.at(-1).ln;
    else if (b.t === 'heading' || b.t === 'hr') b.end = b.start;
    else b.end = Math.max(b.start, end);
    tip = b.parent;
  }
  function add(t, extra = {}) {
    while (!canContain(tip.t, t)) finalize(tip, ln - 1);
    const n = { t, parent: tip, children: [], open: true, start: ln, end: ln, depth: tip.depth + 1, ...extra };
    tip.children.push(n);
    tip = n;
    return n;
  }
  function closeUnmatched() {
    if (allClosed) return;
    while (oldtip !== lastMatched) { const p = oldtip.parent; finalize(oldtip, ln - 1); oldtip = p; }
    allClosed = true;
  }
  function addLine(n) {
    cur.at = offset;
    let text;
    if (partial) { text = ' '.repeat(4 - (column % 4)) + line.slice(offset + 1); }
    else text = line.slice(offset);
    n.rows.push({ ln, text });
  }

  /** 開いている入れ物を続ける。0: 続いた / 1: 続かない / 2: 行を読み終えた（閉じフェンス） */
  function cont(c) {
    switch (c.t) {
      case 'list': return 0;
      case 'bq': {
        if (indented || line[nextNonspace] !== '>') return 1;
        const at = nextNonspace;
        advanceNextNonspace();
        advanceOffset(1, false);
        if (spaceOrTab(line[offset])) advanceOffset(1, true);
        cur.marks.push({ node: c, at, end: offset, opened: false });
        return 0;
      }
      case 'item': {
        const at = offset;
        if (blank) {
          if (!c.children.length) return 1;   // 空の項目は空行を 1 つしか持てない
          advanceNextNonspace();
        } else if (indent >= c.markerOffset + c.padding) advanceOffset(c.markerOffset + c.padding, true);
        else return 1;
        cur.marks.push({ node: c, at, end: offset, opened: false });
        return 0;
      }
      case 'code':
        if (c.fenced) {
          const m = indent <= 3 && line[nextNonspace] === c.fenceChar ? /^(?:`{3,}|~{3,})(?=[ \t]*$)/.exec(line.slice(nextNonspace)) : null;
          if (m && m[0].length >= c.fenceLength) {
            cur.role = 'fence-close'; cur.node = c; cur.at = nextNonspace;
            finalize(c, ln);
            return 2;
          }
          for (let i = c.fenceOffset; i > 0 && spaceOrTab(line[offset]); i--) advanceOffset(1, true);
          return 0;
        }
        if (indent >= 4) advanceOffset(4, true);
        else if (blank) advanceNextNonspace();
        else return 1;
        return 0;
      case 'para': return blank ? 1 : 0;
      case 'table': return blank || !line.slice(offset).includes('|') ? 1 : 0;
      default: return 1;
    }
  }

  function parseListMarker(c, rest) {
    if (indent >= 4) return null;
    let m;
    const d = { markerOffset: indent };
    if ((m = /^[*+-]/.exec(rest))) Object.assign(d, { ordered: false, bullet: m[0], delim: '', startNum: null });
    else if ((m = /^(\d{1,9})([.)])/.exec(rest)) && (c.t !== 'para' || Number(m[1]) === 1)) Object.assign(d, { ordered: true, bullet: '', delim: m[2], startNum: Number(m[1]) });
    else return null;
    const nc = line[nextNonspace + m[0].length];
    if (!(nc === undefined || nc === '\t' || nc === ' ')) return null;
    // 段落を打ち切るときは、空の項目にしない
    if (c.t === 'para' && !/[^ \t]/.test(line.slice(nextNonspace + m[0].length))) return null;
    advanceNextNonspace();
    advanceOffset(m[0].length, true);
    const sc = column, so = offset;
    do advanceOffset(1, true); while (column - sc < 5 && spaceOrTab(line[offset]));
    const spaces = column - sc;
    if (spaces >= 5 || spaces < 1 || line[offset] === undefined) {
      d.padding = m[0].length + 1;
      column = sc; offset = so; partial = false;
      if (spaceOrTab(line[offset])) advanceOffset(1, true);
    } else d.padding = m[0].length + spaces;
    return d;
  }

  /** ブロックの始まり。0: 無い / 1: 入れ物を始めた / 2: 葉を始めた */
  function tryStarts(c) {
    const rest = line.slice(nextNonspace);
    const ch = rest[0];
    const deep = c.depth >= MAX_NEST;
    let m, d;
    if (!indented && ch === '>' && !deep) {
      const at = nextNonspace;
      advanceNextNonspace();
      advanceOffset(1, false);
      if (spaceOrTab(line[offset])) advanceOffset(1, true);
      closeUnmatched();
      cur.marks.push({ node: add('bq'), at, end: offset, opened: true });
      return 1;
    }
    if (!indented && ch === '#' && (m = /^#{1,6}(?:[ \t]+|$)/.exec(rest))) {
      advanceNextNonspace();
      advanceOffset(m[0].length, false);
      closeUnmatched();
      const text = line.slice(offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      cur.node = add('heading', { level: m[0].trim().length, text });
      cur.role = 'heading'; cur.at = offset;
      offset = line.length; consumed = true;
      return 2;
    }
    if (!indented && (ch === '`' || ch === '~') && (m = /^`{3,}(?!.*`)|^~{3,}/.exec(rest))) {
      const len = m[0].length;
      closeUnmatched();
      cur.node = add('code', { fenced: true, fenceChar: m[0][0], fenceLength: len, fenceOffset: indent, info: rest.slice(len).trim(), rows: [] });
      cur.role = 'fence-open'; cur.at = nextNonspace;
      advanceNextNonspace();
      advanceOffset(len, false);
      consumed = true;
      return 2;
    }
    // 表: 段落の最後の行（| を含む）+ 区切りの行。区切りより前の行は段落のまま残す
    const head = tables && c.t === 'para' && !indented && isDelimRow(rest) ? c.rows.at(-1) : null;
    if (head && head.text.includes('|')) {
      closeUnmatched();
      c.rows.pop();
      if (c.rows.length) finalize(c, ln - 1);
      else { c.parent.children.pop(); c.open = false; tip = c.parent; }
      const n = add('table', { rows: [head, { ln, text: rest }] });
      n.start = head.ln;
      info[head.ln].role = 'table'; info[head.ln].node = n;
      cur.role = 'table'; cur.node = n; cur.at = nextNonspace;
      consumed = true;
      return 2;
    }
    if (!indented && RE_HR.test(rest)) {
      closeUnmatched();
      cur.node = add('hr');
      cur.role = 'hr'; cur.at = nextNonspace;
      offset = line.length; consumed = true;
      return 2;
    }
    if ((!indented || c.t === 'list') && !deep) {
      const at = nextNonspace;
      if ((d = parseListMarker(c, rest))) {
        closeUnmatched();
        if (tip.t !== 'list' || tip.ordered !== d.ordered || tip.bullet !== d.bullet || tip.delim !== d.delim) {
          add('list', { ordered: d.ordered, bullet: d.bullet, delim: d.delim, startNum: d.startNum, tight: true });
        }
        const it = add('item', { markerOffset: d.markerOffset, padding: d.padding });
        cur.marks.push({ node: it, at, end: offset, opened: true });
        return 1;
      }
    }
    if (indented && tip.t !== 'para' && !blank) {
      advanceOffset(4, true);
      closeUnmatched();
      add('code', { fenced: false, info: '', rows: [] });
      return 2;
    }
    return 0;
  }

  function incorporate() {
    let container = root;
    oldtip = tip;
    for (let last; (last = container.children.at(-1)) && last.open;) {
      container = last;
      findNextNonspace();
      const r = cont(container);
      if (r === 1) { container = container.parent; break; }
      if (r === 2) return;
    }
    allClosed = container === oldtip;
    lastMatched = container;
    let matchedLeaf = container.t === 'code';
    while (!matchedLeaf) {
      findNextNonspace();
      if (!indented && !RE_SPECIAL.test(line.slice(nextNonspace, nextNonspace + 1))) { advanceNextNonspace(); break; }
      const s = tryStarts(container);
      if (s === 1) { container = tip; continue; }
      if (s === 2) { container = tip; matchedLeaf = true; break; }
      advanceNextNonspace();
      break;
    }
    if (consumed) return;
    // 残りは文字の行。入れ物が全部続かなかったのに段落が開いていれば、遅延の続き
    if (!allClosed && !blank && tip.t === 'para') {
      addLine(tip);
      cur.role = 'lazy'; cur.node = tip;
      return;
    }
    closeUnmatched();
    const t = container.t;
    if (t === 'code' || t === 'para') {
      addLine(container);
      cur.role = t === 'para' ? 'para' : container.fenced ? 'code' : 'icode';
      cur.node = container;
    } else if (t === 'table') {
      addLine(container);
      cur.role = 'table'; cur.node = container;
    } else if (!blank && offset < line.length) {
      const p = add('para', { rows: [] });
      advanceNextNonspace();
      addLine(p);
      cur.role = 'para'; cur.node = p;
    } else {
      cur.node = container; cur.at = offset;
    }
  }

  for (ln = 0; ln < src.length; ln++) {
    line = src[ln];
    offset = column = 0; blank = false; partial = false; consumed = false;
    cur = { marks: [], node: root, role: 'blank', at: 0 };
    info.push(cur);
    incorporate();
  }
  ln = src.length;
  while (tip) finalize(tip, src.length - 1);
  return { root, lines: info };
}

// ------------------------------------------------------------------ 行の情報を読む部品

/** 節から外へ、入れ物（引用・リスト・項目）の並び（外から内へ） */
export function containersOf(node) {
  const out = [];
  for (let n = node; n && n.t !== 'root'; n = n.parent) if (n.t === 'bq' || n.t === 'list' || n.t === 'item') out.unshift(n);
  return out;
}

/** 行の入れ物の記号の終わり（一番内側の記号の後ろ。記号が無ければ 0） */
export const prefixEnd = (lineInfo) => lineInfo.marks.at(-1)?.end ?? 0;

/** フェンスの行の役割: 'open' | 'close' | 'in' | null（入れ物の中のフェンスも読む） */
export function codeRoles(lines) {
  return lines.map((l) => (l.role === 'fence-open' ? 'open' : l.role === 'fence-close' ? 'close' : l.role === 'code' ? 'in' : null));
}

// ------------------------------------------------------------------ 字下げ・記号・番号の決まり
// 字下げの量は web/tokens.css の --md-list-indent（1 段目）・--md-list-step（2 段目から）・--md-quote-indent・--md-quote-nest。
// 履歴の <ul>/<ol> と入力欄の行は、同じ値を同じ数え方（下の lineIndent）で足す。

const BULLETS = ['disc', 'circle', 'square'];
/** 箇条書きの記号: 外側の箇条書きの数で ● → ○ → ■ をくり返す */
export const bulletType = (ulDepth) => BULLETS[ulDepth % BULLETS.length];
/** リストの記号のクラス（web/style.css の .md-disc・.md-circle・.md-square・.md-decimal・.md-paren） */
export function listClass(list) {
  if (list.ordered) return list.delim === ')' ? 'md-paren' : 'md-decimal';
  let ul = 0;
  for (let n = list.parent; n; n = n.parent) if (n.t === 'list' && !n.ordered) ul++;
  return `md-${bulletType(ul)}`;
}
/** 項目の見せる番号（最初の番号から 1 つずつ。原文の番号は変えない） */
export const itemNumber = (item) => (item.parent.startNum ?? 1) + item.parent.children.indexOf(item);
/** 箇条書きの項目の記号の形（'disc'・'circle'・'square'）。番号付きは ''。入力欄は形を CSS で描く（履歴の list-style と同じ大きさ） */
export const itemBullet = (item) => (item.parent.ordered ? '' : listClass(item.parent).slice(3));
/** 項目の記号の字: 箇条書きは ● ○ ■ の字、番号付きは見せる番号と区切り（"3." / "3)"） */
const BULLET_CHARS = { disc: '•', circle: '◦', square: '▪' };
export function itemMarker(item) {
  const list = item.parent;
  if (list.ordered) return `${itemNumber(item)}${list.delim === ')' ? ')' : '.'}`;
  return BULLET_CHARS[itemBullet(item)];
}
/** 番号が 2 桁以上のとき、記号の幅として足す字数（1ch 単位。"9." までは 0） */
export function markerExtra(list) {
  if (!list.ordered) return 0;
  const last = (list.startNum ?? 1) + Math.max(0, list.children.length - 1);
  return Math.max(0, String(last).length + 1 - 2);
}

/**
 * 節の字下げ（外側の入れ物を足したもの）。l1: 項目の外のリストの数、ln: 項目の中のリストの数、mk: 番号の幅の字数、
 * q: 引用の数、qn: 引用の中の引用の数。bars は引用ごとの縦線の位置（その引用の手前までの字下げ）
 */
export function lineIndent(node) {
  let l1 = 0, ln = 0, mk = 0, q = 0, qn = 0, inQuote = false;
  const bars = [];
  for (const n of containersOf(node)) {
    if (n.t === 'list') {
      if (n.parent.t === 'item') ln++; else l1++;
      mk += markerExtra(n);
    } else if (n.t === 'bq') {
      if (inQuote) qn++;
      bars.push({ l1, ln, mk, q, qn });
      q++;
      inQuote = true;
    }
  }
  return { l1, ln, mk, q, qn, bars };
}

/**
 * 字下げを CSS の長さにする。入力欄は行ごとに字の大きさが変わる（見出し・コード）ので、欄の字で固めた
 * --md-list-indent / --md-list-step / --md-ch を欄に置く（web/style.css）。履歴は字の大きさのままの em と ch
 */
export function indentCss({ l1 = 0, ln = 0, mk = 0, q = 0, qn = 0 }) {
  return `calc(${l1} * var(--md-list-indent) + ${ln} * var(--md-list-step) + ${mk} * var(--md-ch, 1ch) + ${q} * var(--md-quote-indent) + ${qn} * var(--md-quote-nest))`;
}

/** 入れ物の入れ子の深さ（引用・リストの数の最大） */
export function nestDepth(node) {
  let max = 0;
  const walk = (n, d) => {
    const here = n.t === 'bq' || n.t === 'list' ? d + 1 : d;
    if (here > max) max = here;
    for (const c of n.children) walk(c, here);
  };
  walk(node, 0);
  return max;
}
