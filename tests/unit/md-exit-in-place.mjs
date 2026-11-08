import {
  markdownToDoc, docToMarkdown, caret, enter, backspaceAtStart, deleteAtEnd,
  insertText, applyTriggers, rowTree, snapshotEditing, restoreEditing,
  createHistory, deleteSelection, pasteText, normalizeRows,
} from '../../web/md-doc.mjs';
import { parseStructure, lineIndent } from '../../web/md-structure.mjs';
import { textHash } from '../../web/md-editing-state.mjs';

export const name = 'md-exit-in-place';
export const title = '空の構造行を同じ行で解除し、入力・結合・保存で深さを保つ';
const md = s => docToMarkdown(s.blocks);
const shape = s => s.blocks.map(b => b.kind).join(',');
const start = text => ({ blocks: markdownToDoc(text), sel: caret(0, 0) });
const type = (s, text) => {
  for (const ch of text) { s = insertText(s, ch); s = applyTriggers(s, ch)?.state ?? s; }
  return s;
};
const depth = node => { let q = 0, item = 0; for (; node; node = node.parent) { q += node.t === 'bq'; item += node.t === 'item'; } return [q, item]; };

export default async function(t) {
  for (const mark of ['>', '-', '1.']) {
    const first = type(start(''), mark + ' a'), continued = enter(first), out = enter(continued);
    t.ok(`${mark} の Enter×2 は2編集行・同じ行頭・境界付き本文`, out.blocks.length === 2 && out.blocks[1].kind === 'p' && md(out) === `${mark} a\n` && out.sel.s.b === 1 && out.sel.s.v === 0);
    t.ok(`${mark} の空行Enterと行頭Backspaceは同じ状態`, JSON.stringify(out) === JSON.stringify(backspaceAtStart(continued)));
    const typed = type(out, 'b');
    t.ok(`${mark} の解除後の文字は送信でも構造の外`, md(typed) === `${mark} a\n\nb` && depth(parseStructure(md(typed).split('\n')).lines.at(-1).node).join() === '0,0');
    const joined = backspaceAtStart(out);
    t.ok(`${mark} の追加Backspaceは即座に前行末へ結合`, joined.blocks.length === 1 && joined.blocks[0].kind === first.blocks[0].kind && joined.sel.s.b === 0 && joined.sel.s.v === 1 && md(type(joined, 'b')) === `${mark} ab`);
    t.ok(`${mark} の前行末Deleteも同じ結合`, md(type(deleteAtEnd({ ...out, sel: caret(0, 1) }), 'b')) === `${mark} ab`);
    const h = createHistory(); h.reset(first); h.push(continued, 'enter'); h.push(out, 'enter');
    t.ok(`${mark} Undo/Redo後の入力でも境界を保つ`, md(h.undo()) === md(continued) && md(type(h.redo(), 'b')) === md(typed));
    const restored = restoreEditing(md(out), JSON.parse(JSON.stringify(snapshotEditing(out.blocks))));
    t.ok(`${mark} 空の解除行を保存復元しても2行`, restored.length === 2 && md(type({ blocks: restored, sel: out.sel }, 'b')) === md(typed));
    const deleted = deleteSelection({ ...typed, sel: { s: { b: 1, v: 0 }, e: { b: 1, v: 1 } } });
    t.ok(`${mark} 範囲削除→複数行貼付でも境界を保つ`, md(pasteText(deleted, 'b\nc')) === `${mark} a\n\nb\nc`);
  }
  for (const [seed, marker, kind, wantDepth] of [
    ['> > a', '> ', 'quote', [1, 0]], ['> - a', '> ', 'quote', [1, 0]],
    ['- a\n  - b', '- ', 'ul', [0, 1]], ['1. a\n   1. b', '2. ', 'ol', [0, 1]],
    ['> 1. a\n>    - b', '> 2. ', 'ol', [1, 1]],
  ]) {
    let s = start(seed); s.sel = caret(s.blocks.length - 1, 1);
    const continued = enter(s), out = enter(continued), b = out.blocks.at(-1);
    t.ok(`${seed} は空の子項目を残さず同じ行で一段解除`, out.blocks.length === continued.blocks.length && b.marker === marker && b.kind === kind && out.sel.s.b === continued.sel.s.b);
    const node = rowTree(out.blocks).info[out.blocks.length - 1].node;
    const typed = type(out, 'c'), parsed = parseStructure(md(typed).split('\n'));
    t.ok(`${seed} の空行と入力後と送信で深さが一致`, lineIndent(node).bars.length === wantDepth[0] && depth(parsed.lines.at(-1).node).join() === wantDepth.join());
    const restored = restoreEditing(md(out), snapshotEditing(out.blocks));
    t.ok(`${seed} の空行の深さを保存復元`, restored.length === out.blocks.length && restored.at(-1).marker === marker && md(type({ blocks: restored, sel: out.sel }, 'c')) === md(typed));
  }
  let deep = enter({ ...start('> > a'), sel: caret(0, 1) }); deep = enter(deep); deep = enter(deep);
  t.ok('二重引用を続けて解除すると古い引用境界も解除する', md(type(deep, 'b')) === '> > a\n\nb' && deep.blocks.length === 2 && deep.blocks[1].kind === 'p');
  let quotedList = enter({ ...start('> - a'), sel: caret(0, 1) }); quotedList = enter(quotedList); quotedList = enter(quotedList);
  t.ok('引用内リストはリスト→引用→本文の順で解除する', md(type(quotedList, 'b')) === '> - a\n\nb' && quotedList.blocks.length === 2 && quotedList.blocks[1].kind === 'p');
  const heading = type(enter(enter(type(start(''), '> a'))), '# title');
  const unheaded = backspaceAtStart({ ...heading, sel: caret(1, 0) });
  t.ok('解除後の本文を見出しにして戻しても元の引用外に留まる', heading.blocks[1].kind === 'h' && md(unheaded) === '> a\n\ntitle' && unheaded.blocks[1].kind === 'p');
  const soft = enter(enter({ ...start('> a'), sel: caret(0, 1) }), { soft: true });
  t.ok('空引用のShift+Enterも引用の行を足す（ADR 0301）', md(soft) === '> a\n> \n> ' && shape(soft) === 'quote,quote,quote' && soft.sel.s.b === 2);
  // 打鍵: 字・'\n' Enter・'\r' Shift+Enter・'\b' 行頭の Backspace
  const keys = (seq) => { let s = start(''); for (const k of seq) s = k === '\n' ? enter(s) : k === '\r' ? enter(s, { soft: true }) : k === '\b' ? backspaceAtStart(s) : type(s, k); return s; };
  for (const [seq, want, kinds, label] of [
    ['> a\n\n\bb', '> ab', 'quote', 'Enter Enter Backspace b は前の引用の行につながる'],
    ['> a\r\r\bb', '> a\n> \nb', 'quote,quote,p', 'Shift+Enter Shift+Enter Backspace b は引用の外'],
    ['> a\r\r\b\bb', '> a\n> b', 'quote,quote', 'Shift+Enter Shift+Enter Backspace Backspace b は空の引用の行に入る'],
    ['> \r\r', '> \n> \n> ', 'quote,quote,quote', '空の引用だけでも Shift+Enter は引用の行を足す'],
    ['- > a\r\r', '- > a\n  > \n  > ', 'quote,quote,quote', '項目の中の空の引用も Shift+Enter で引用の行を足す'],
    ['- \r\rx', '- \n  x', 'ul,cont', '空の項目の頭の後の空の続きの行では、Shift+Enter をもう一度押しても空行を足さない'],
  ]) {
    const s = keys(seq);
    t.ok(`${label} ${JSON.stringify(seq)}`, md(s) === want && shape(s) === kinds, JSON.stringify([md(s), shape(s)]));
  }
  const head = keys('- \r');
  t.ok('空の項目の頭に戻って Shift+Enter を押しても空行を 2 つにしない', md(enter({ ...head, sel: caret(0, 0) }, { soft: true })) === md(head));
  // 空の頭の下に子の項目があるとき、空行を足すと項目が閉じて子が外へ出るので、Shift+Enter は何もしない
  const parent = { ...start('- \n  - q'), sel: caret(0, 0) }, softParent = enter(parent, { soft: true });
  t.ok('子のある空の項目の頭の Shift+Enter は空行を足さず、子の深さを変えない', md(softParent) === '- \n  - q' && depth(parseStructure(md(softParent).split('\n')).lines[1].node).join() === '0,2', md(softParent));
  // 項目の頭で打った `> ` は、行をそろえ直しても記号が `- > ` のまま（空の引用でも Markdown の空行ではない）
  const quoteHead = type(start(''), '- > ');
  normalizeRows(quoteHead.blocks, { sel: quoteHead.sel });
  t.ok('項目の頭の `> ` は、行をそろえ直しても記号とキャレットを保つ', md(quoteHead) === '- > ' && shape(quoteHead) === 'quote' && quoteHead.sel.s.v === 0, JSON.stringify([md(quoteHead), quoteHead.sel]));
  // 引用の中の `>` だけの行は、引用の中の項目を閉じない（CommonMark と同じ）
  const inQuote = markdownToDoc('> - a\n>\n>   b'), rows = rowTree(inQuote).info, read = parseStructure('> - a\n>\n>   b'.split('\n')).lines;
  t.ok('引用の中の `>` だけの行の後も、項目の続きの行は項目の中', depth(rows[2].node).join() === '1,1' && depth(read[2].node).join() === '1,1', JSON.stringify([depth(rows[2].node), depth(read[2].node)]));
  // 項目と子の間で Enter×2 を押してやめた行の下の中身は、項目の字下げを外して一緒に出す。残すと字を打ったときにこの行が外へ飛ぶ
  for (const [seed, want] of [['- a\n  - b', '- a\n\nb\n- b'], ['- a\n  b', '- a\n\nb\nb']]) {
    const out = enter(enter({ ...start(seed), sel: caret(0, 1) })), typed = type(out, 'b');
    const lines = parseStructure(md(typed).split('\n')).lines;
    t.ok(`${JSON.stringify(seed)} の項目と中身の間でやめた行に打っても、行は項目の外のまま`, md(typed) === want && typed.blocks[1].kind === 'p' && depth(rowTree(typed.blocks).info[1].node).join() === '0,0' && depth(lines[2].node).join() === '0,0', md(typed));
  }
  // 中身の無い項目の頭へ改行を貼っても、頭と子の間に空の行を作らない（空の行が項目を閉じ、子が外へ出る。Shift+Enter と同じ）
  for (const seed of ['- a\n  - b', '1. a\n   - b']) {
    const head = enter({ ...start(seed), sel: caret(0, 1) }), pasted = pasteText(head, '\n'), typed = type(pasted, 'b');
    const rows = rowTree(typed.blocks).info;
    t.ok(`${JSON.stringify(seed)} の空の項目の頭へ改行を貼って打っても、子の項目は子のまま`, typed.blocks.length === 3 && depth(rows[2].node).join() === '0,2', md(typed));
  }
  // 空の行に項目の頭の行を Delete でつなぐと、その項目の中身は字下げを外して一緒に出る（前の項目の中身にならない）。
  // 項目の行につなぐときは、中身はつないだ項目の中身のまま
  {
    const row = (kind, marker, text) => ({ kind, marker, runs: text ? [{ text, marks: [] }] : [] });
    const blank = { blocks: [row('ol', '> 1. ', 'a'), row('ul', '>    - ', 'qa'), row('cont', '>    ', ''), row('ul', '>    - ', ''), row('cont', '>      ', 'z')], sel: caret(0, 0) };
    const joined = deleteAtEnd({ ...blank, sel: caret(2, 0) }), typed = type({ ...joined, sel: caret(2, 0) }, '.');
    const rows = rowTree(typed.blocks).info;
    const shown = (s) => s.blocks.map((x) => x.marker + x.runs.map((r) => r.text).join('')).join('|');
    t.ok('空の続きの行に空の項目の頭をつなぐと、項目の中身は外へ出て、空の行に打っても動かない', shown(joined) === '> 1. a|>    - qa|>    |>    z' && shown(typed) === '> 1. a|>    - qa|>    .|>    z' && depth(rows[3].node).join() === '1,1' && md(typed) === '> 1. a\n>    - qa\n>\n>    .\n>    z', JSON.stringify([shown(joined), md(typed)]));
    const item = deleteAtEnd({ ...start('- a\n- \n  z'), sel: caret(0, 1) });
    t.ok('項目の行に空の項目の頭をつなぐと、中身はつないだ項目の中身のまま', md(item) === '- a\n  z', md(item));
  }
  for (const raw of ['> a\nb', '- a\nb', '1. a\nb', '> > a\n> b', '> a\n\nb', '- a\n\n', '> - a\n> \n> b']) {
    t.ok(`既存原文を読むだけでは変更しない ${JSON.stringify(raw)}`, docToMarkdown(markdownToDoc(raw)) === raw);
  }
  // The previous Enter behavior saved three editor rows, including two empty paragraphs.
  const legacyText = '> a\n\n';
  const legacy = { v: 1, length: legacyText.length, hash: textHash(legacyText), rows: [
    { at: 0, kind: 'quote', marker: '> ' }, { at: 4, kind: 'p', marker: '' }, { at: 5, kind: 'p', marker: '' },
  ] };
  const restoredLegacy = restoreEditing(legacyText, legacy);
  t.ok('旧版の3編集行の保存情報を原文と行数のまま復元', restoredLegacy.length === 3 && docToMarkdown(restoredLegacy) === legacyText && JSON.stringify(snapshotEditing(restoredLegacy)) === JSON.stringify(legacy));
}
