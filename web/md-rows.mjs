// 入力欄の編集行の構造（ADR 0301）。編集行（web/md-doc.mjs のブロック）だけが構造の正本で、送る Markdown は行から一方向に作る。
//
// createMatcher は、行の文字（rowText）を上から 1 行ずつ読み、行が「自分の記号で」どの入れ物（引用・項目）に入るかを決める。
// 読み方は CommonMark の入れ物の続け方と始め方（web/md-structure.mjs）と同じだが、段落の遅延の続き（lazy continuation）は使わない。
// 記号の無い行は入れ物の外。送る Markdown を CommonMark で読んでも同じ構造になるように、serialize が区切りの空行（sepBetween）と
// 行頭のエスケープ（escapeContent）を足す（tests/unit/md-rows-serialize.mjs の性質の試験）。
//
// 行の読み方の結果 { kept, path, marks, opens, end, role }
//   path   行が入った入れ物の並び（外から内へ）。kept はそのうち行の記号が覆うものの数（空行は字下げの足りない項目から外）
//   marks  行で読んだ入れ物の記号 { k, at, end, opened, ... }（k は path の添字）。opened はその行で始まった入れ物
//   role   'para' | 'blank' | 'heading' | 'fence-open' | 'code' | 'fence-close' | 'icode' | 'att'
//   end    入れ物の記号の終わり（文字の位置）
// tree を作る（step）と、入れ物は md-structure.mjs の節と同じ形の木になる（bq・list { ordered, bullet, delim, startNum }・
// item { markerOffset, padding }・code）。字下げ・番号・記号の描き方（lineIndent・itemMarker）はそのまま使える。
// 扱わないもの（送る形を CommonMark で読むと違って見えることがあるもの）: 表・setext の見出し・横線・記号の中のタブ（4 桁へ丸めて読む）。

export const RE_HR = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const RE_ITEM = /^(?:[-+*]|\d{1,9}[.)])/;
const RE_FENCE_OPEN = /^`{3,}(?!.*`)|^~{3,}/;
const RE_FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const RE_HEADING = /^#{1,6}(?:[ \t]+|$)/;
const isWs = (ch) => ch === ' ' || ch === '\t';
const isBlank = (s) => !/[^ \t]/.test(s);
const adv = (c, ch) => (ch === '\t' ? c + 4 - (c % 4) : c + 1);

/** 空白を飛ばす。[文字の位置, 桁] */
function skipWs(line, p, c) {
  while (isWs(line[p])) { c = adv(c, line[p]); p++; }
  return [p, c];
}
/** 空白を n 桁まで読む（タブは途中で止めず丸ごと読む） */
function takeCols(line, p, c, n) {
  const goal = c + n;
  while (c < goal && isWs(line[p])) { c = adv(c, line[p]); p++; }
  return [p, c];
}

const listFits = (list, e) => list && list.ordered === e.ordered && (e.ordered ? list.delim === e.delim : list.bullet === e.bullet);

/**
 * 行を上から読む。step(line, kind) は読んで先へ進み、peek(line, kind) は進まずに読んだ結果だけ返す。
 * kind は行の種類（'p' | 'h' | 'ul' | 'ol' | 'quote' | 'cont' | 'code' | 'att' | 'sep'）。見出し・コード・添付の役割は種類で決める
 * （段落の行の `# ` はエスケープ済みなので、文字だけで決めても同じ）。tree: true で入れ物の木（root）と行の情報を作る
 */
export function createMatcher({ tree = false } = {}) {
  const root = { t: 'root', parent: null, children: [], open: true, start: 0, end: 0, depth: 0 };
  let top = { t: 'root', node: root, list: null, filled: false };
  let stack = [], fence = null, icode = null, row = 0;

  function run(line, kind, commit) {
    const make = commit && tree;
    const R = { ...top }, S = stack.map((e) => ({ ...e }));
    const up = (k) => (k > 0 ? S[k - 1] : R);
    let fn = fence, ic = icode;
    let p = 0, c = 0, k = 0, kept = -1, opens = 0, role = null;
    const marks = [];
    const blankLine = isBlank(line);
    // 1. 開いている入れ物を続ける（遅延の続きは無い）
    for (; k < S.length; k++) {
      const e = S[k];
      const [np, nc] = skipWs(line, p, c);
      const indent = nc - c;
      if (e.t === 'bq') {
        if (indent >= 4 || line[np] !== '>') break;
        p = np + 1; c = nc + 1;
        if (isWs(line[p])) { c = adv(c, line[p]); p++; }
        marks.push({ k, at: np, end: p, opened: false });
        continue;
      }
      if (blankLine) {
        // 中身の無い項目は、すぐ下の字下げのそろった空行を 1 つだけ持てる（Shift+Enter の行。CommonMark は閉じるが、空行なので見え方は同じ）
        if (!e.filled) {
          if (!(row === e.start + 1 && indent >= e.need)) break;
          e.hadBlank = true;
        }
        if (kept < 0 && indent < e.need) kept = k;
        const at = p;
        [p, c] = takeCols(line, p, c, e.need);
        marks.push({ k, at, end: p, opened: false });
        continue;
      }
      if ((!e.filled && e.hadBlank) || indent < e.need) break;
      const at = p;
      [p, c] = takeCols(line, p, c, e.need);
      marks.push({ k, at, end: p, opened: false });
    }
    const matched = k;
    if (kept < 0) kept = matched;
    // 2. 開いているフェンスの中
    if (fn && matched >= fn.depth) {
      const [np, nc] = skipWs(line, p, c);
      const m = nc - c <= 3 ? RE_FENCE_CLOSE.exec(line.slice(np)) : null;
      role = m && m[1][0] === fn.ch && m[1].length >= fn.len ? 'fence-close' : 'code';
    } else fn = null;
    // 3. 新しい入れ物を始める
    if (!role) {
      S.length = matched;
      for (;;) {
        const [np, nc] = skipWs(line, p, c);
        const indent = nc - c, rest = line.slice(np);
        if (indent >= 4 || isBlank(rest)) break;
        const P = up(S.length);
        if (rest[0] === '>') {
          let q = np + 1, qc = nc + 1;
          if (isWs(line[q])) { qc = adv(qc, line[q]); q++; }
          const e = { t: 'bq', start: row, filled: false, list: null };
          if (make) { e.node = { t: 'bq', parent: P.node, children: [], open: true, start: row, end: row, depth: P.node.depth + 1 }; P.node.children.push(e.node); }
          P.filled = true; P.list = null;
          marks.push({ k: S.length, at: np, end: q, opened: true });
          S.push(e); opens++;
          p = q; c = qc;
          continue;
        }
        if (RE_HR.test(rest)) break;
        const m = RE_ITEM.exec(rest);
        if (!m || !(rest.length === m[0].length || isWs(rest[m[0].length]))) break;
        const len = m[0].length;
        let q = np + len, qc = nc + len, sq = q, sc = qc;
        while (isWs(line[sq]) && sc - qc < 5) { sc = adv(sc, line[sq]); sq++; }
        const spaces = sc - qc, empty = isBlank(line.slice(q));
        let padding;
        if (spaces >= 5 || spaces < 1 || empty) {
          padding = len + 1;
          if (isWs(line[q])) { qc = adv(qc, line[q]); q++; }
        } else { padding = len + spaces; q = sq; qc = sc; }
        const ordered = !/^[-+*]/.test(m[0]);
        const e = {
          t: 'item', need: indent + padding, markerOffset: indent, padding, ordered,
          bullet: ordered ? '' : m[0], delim: ordered ? m[0].at(-1) : '', num: ordered ? Number(m[0].slice(0, -1)) : null,
          start: row, filled: false, hadBlank: false, list: null,
        };
        if (make) {
          let list = listFits(P.list, e) ? P.list : null;
          if (!list) {
            list = { t: 'list', ordered, bullet: e.bullet, delim: e.delim, startNum: ordered ? e.num : null, tight: true, parent: P.node, children: [], open: true, start: row, end: row, depth: P.node.depth + 1 };
            P.node.children.push(list);
          }
          e.node = { t: 'item', markerOffset: indent, padding, parent: list, children: [], open: true, start: row, end: row, depth: list.depth + 1 };
          list.children.push(e.node);
          P.list = list;
        } else P.list = listFits(P.list, e) ? P.list : { ordered, bullet: e.bullet, delim: e.delim };
        P.filled = true;
        marks.push({ k: S.length, at: np, end: q, opened: true, item: true, ordered, num: e.num, empty });
        S.push(e); opens++;
        p = q; c = qc;
      }
    }
    // 4. 行の役割（種類で決める）
    if (!role) {
      const [np, nc] = skipWs(line, p, c);
      const indent = nc - c, rest = line.slice(np), blank = isBlank(rest);
      let fm;
      if (kind === 'code') {
        if (ic && opens === 0 && matched === ic.depth && (indent >= 4 || blank)) role = 'icode';
        else if (indent < 4 && (fm = RE_FENCE_OPEN.exec(rest))) {
          role = 'fence-open';
          fn = { depth: S.length, ch: fm[0][0], len: fm[0].length, node: null };
        } else if (indent >= 4 && !blank) { role = 'icode'; ic = { depth: S.length, node: null }; }
        else role = blank ? 'blank' : 'para';
      } else if (kind === 'h' && indent < 4 && RE_HEADING.test(rest)) role = 'heading';
      else if (kind === 'att' && !blank) role = 'att';
      else role = blank ? 'blank' : 'para';
      if (role !== 'icode') ic = null;
      if (role === 'fence-open') ic = null;
    } else ic = null;
    if (role === 'fence-close') fn = null;
    const deep = S.length ? S.at(-1) : R;
    if (role !== 'blank') { deep.filled = true; deep.list = null; }
    const path = kept < matched ? S.slice(0, kept) : S;
    const out = { kept, path, marks: marks.filter((m) => m.k < path.length), opens, end: p, role };
    if (!commit) return out;
    // 進める
    if (make) {
      const deepNode = path.length ? path.at(-1).node : root;
      let node = deepNode;
      if (role === 'fence-open' || (role === 'icode' && !ic.node)) {
        const st = role === 'fence-open' ? fn : ic;
        st.node = { t: 'code', fenced: role === 'fence-open', parent: (S.length ? S.at(-1).node : root), children: [], open: true, start: row, end: row, depth: deepNode.depth + 1 };
        st.node.parent.children.push(st.node);
        node = st.node;
      } else if (role === 'code' || role === 'fence-close') { node = fence.node; node.end = row; }
      else if (role === 'icode') { node = ic.node; node.end = row; }
      for (const e of path) { e.node.end = row; if (e.node.parent?.t === 'list') e.node.parent.end = row; }
      out.info = {
        marks: out.marks.map((m) => ({ node: path[m.k].node, at: m.at, end: m.end, opened: m.opened })),
        node, role, at: p,
      };
    }
    top = R; stack = S; fence = fn; icode = ic; row++;
    return out;
  }

  return {
    step: (line, kind) => run(line, kind, true),
    peek: (line, kind) => run(line, kind, false),
    get root() { return root; },
    get row() { return row; },
  };
}

/**
 * 行 A（読んで進めた結果）と次の行 B（A の後で peek した結果）のあいだに要る区切りの空行。要らなければ null。
 * 段落（添付も段落として読まれる）の次の行が、CommonMark で段落の続きとして読まれてしまうときに足す:
 *   (a) B が A の入れ物の一部を持たない、新しい入れ物を始めない段落・字下げのコード（遅延の続きになる）
 *   (c) B が A と同じ入れ物の中で、段落を打ち切れない項目（中身の無い項目・1 以外の番号）を始める
 *   (d) B が字下げのコード（段落を打ち切れない）
 * 区切りは B が続ける入れ物の記号だけ（引用は `>`、項目は字下げ）
 */
export function sepBetween(A, B) {
  if (!A || (A.role !== 'para' && A.role !== 'att')) return null;
  const first = B.marks.find((m) => m.opened);
  const need = (B.kept < A.path.length && B.opens === 0 && (B.role === 'para' || B.role === 'att' || B.role === 'icode'))
    || (B.kept === A.path.length && first?.item && (first.empty || (first.ordered && first.num !== 1)))
    || B.role === 'icode';
  if (!need) return null;
  return B.path.slice(0, B.kept).map((e) => (e.t === 'bq' ? '> ' : ' '.repeat(e.need))).join('').trimEnd();
}

const RE_LEAD = /^\\*(?:>|#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|`{3,}(?!.*`)|~{3,})/;
const RE_ORDERED = /^(\d{1,9})(\\*)([.)])(?:[ \t]|$)/;
const RE_BULLET_SEG = /[-+*][ \t]*$/;

/**
 * 行の中身（記号の後ろ）の頭が、送ったときに構造の記号として読まれないようにする（記号の無い字は記号にしない）。
 * { text, esc, p }: esc なら文字の位置 p に `\` を足した。見出しの行・空の中身はそのまま
 */
export function escapeContent(content, kind, marker = '') {
  if (kind === 'h' || !content) return { text: content, esc: false, p: 0 };
  if (RE_LEAD.test(content) && !RE_HR.test(content)) return { text: '\\' + content, esc: true, p: 0 };
  const o = RE_ORDERED.exec(content);
  if (o) return { text: content.slice(0, o[1].length) + '\\' + content.slice(o[1].length), esc: true, p: o[1].length };
  if (kind === 'ul' || kind === 'ol') {
    const seg = RE_BULLET_SEG.exec(marker)?.[0];
    if (seg && RE_HR.test(seg + content)) {
      const at = content.search(/[-*_]/);
      if (at >= 0) return { text: content.slice(0, at) + '\\' + content.slice(at), esc: true, p: at };
    }
  }
  return { text: content, esc: false, p: 0 };
}

/** escapeContent の逆。送った形（読んだ行の中身）から、足した `\` を除く。足した形でなければそのまま */
export function unescapeContent(text, kind, marker = '') {
  for (const p of [0, RE_ORDERED.exec(text.replace(/^(\d{1,9})\\/, '$1'))?.[1].length, text.search(/\\[-*_]/)]) {
    if (p === undefined || p < 0 || text[p] !== '\\') continue;
    const content = text.slice(0, p) + text.slice(p + 1);
    const e = escapeContent(content, kind, marker);
    if (e.esc && e.p === p && e.text === text) return { text: content, esc: true, p };
  }
  return { text, esc: false, p: 0 };
}
