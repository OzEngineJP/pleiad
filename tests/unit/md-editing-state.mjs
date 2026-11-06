import {
  markdownToDoc, docToMarkdown, caret, enter, backspaceAtStart, insertText, insertPlain,
  applyTriggers, snapshotEditing, restoreEditing, replaceMarkdownRange, mergeEditingContent,
  docStructure, editingNode, createHistory, posToOffset, offsetToPos, selectionMarkdown,
  deleteSelection, deleteAtEnd, pasteText, toggleMark, newAtom, insertAtom, removeAtoms, normalizeFences,
} from '../../web/md-doc.mjs';
import { normalizeEditingState } from '../../web/md-editing-state.mjs';
import { parseDrafts, serializeDrafts } from '../../web/channels/ch-attach-model.mjs';
import { lineIndent } from '../../web/md-structure.mjs';

export const name = 'md-editing-state';
export const title = '確定前の記号・同じ行の構造解除・送信境界・編集情報の保存と範囲操作';
const st = (text, b = 0, v = 0) => ({ blocks: markdownToDoc(text), sel: caret(b, v) });
const md = s => docToMarkdown(s.blocks);
const shape = s => s.blocks.map(b => b.kind).join(',');
const bars = s => { const S = docStructure(s.blocks); return s.blocks.map((b, i) => S.info[i] ? lineIndent(editingNode(s.blocks, S, b, S.info[i])).bars.length : 0); };
const select = (s, b, v = 0) => ({ blocks: s.blocks, sel: caret(b, v) });
const exit = (text = '> a\n> b') => backspaceAtStart(st(text, 1));

export default async function (t) {
  for (const marker of ['>', '-', '1.']) {
    const pending = insertPlain(st(''), marker), S = docStructure(pending.blocks);
    const at = lineIndent(editingNode(pending.blocks, S, pending.blocks[0], S.info[0]));
    t.ok(`${marker} は確定前に字下げ・引用線を付けない`, !at.bars.length && at.l1 === 0 && at.ln === 0 && at.mk === 0 && md(pending) === marker, JSON.stringify(at));
    const spaced = insertText(pending, ' '), committed = applyTriggers(spaced, ' ')?.state;
    t.ok(`${marker} は Space で確定し、空行も次の Enter で1行進む`, committed && shape(committed) !== 'p' && enter(committed).sel.s.b === 1);
    const saved = snapshotEditing(pending.blocks);
    t.ok(`${marker} の確定前状態を復元できる`, shape({ blocks: restoreEditing(md(pending), saved) }) === 'p');
  }
  for (const text of ['> a\n> ', '> a\n> b', '- a\n- ', '- a\n- b', '1. a\n2. ', '1. a\n2. b']) {
    const before = st(text, 1), s = backspaceAtStart(before), typed = insertText(s, 'x');
    t.ok(`解除 ${JSON.stringify(text)} は2行・同じ行頭、入力後も本文`, s.blocks.length === 2 && s.sel.s.b === 1 && s.sel.s.v === 0 && shape(s).endsWith(',p') && shape(typed).endsWith(',p'));
    const S = docStructure(typed.blocks);
    let node = S.info[1].node, inside = false;
    while (node) { inside ||= node.t === 'bq' || node.t === 'item'; node = node.parent; }
    t.ok('送信本文を共通解析しても引用・項目の外', !inside && md(typed).includes('\n\n'));
    const h = createHistory(); h.reset(before); h.push(s, 'backspace');
    t.ok('Undo1回で構造・境界・選択を戻す、Redoで再解除', md(h.undo()) === text && md(h.redo()) === md(s));
    const restored = restoreEditing(md(s), JSON.parse(JSON.stringify(snapshotEditing(s.blocks))));
    t.ok('保存復元後も2編集行、原文一致', restored.length === 2 && docToMarkdown(restored) === md(s) && restored[1].breakBefore === '');
  }
  const q = enter(st('> a', 0, 1));
  t.ok('Enter直後の空引用も2行とも引用線を保つ', q.blocks.length === 2 && bars(q).join() === '1,1' && md(q) === '> a\n> ');
  const deep = exit('> > a\n> > b');
  t.ok('多段引用は一段だけ外し外側を保つ', deep.blocks.length === 2 && deep.blocks[1].marker === '> ' && deep.blocks[1].breakBefore === '> ' && bars(deep).join() === '2,1');
  const listInQuote = exit('> - a\n> - b');
  t.ok('引用内リストの解除は引用を保つ', shape(listInQuote) === 'ul,quote' && bars(listInQuote).join() === '1,1' && md(listInQuote) === '> - a\n> \n> b');
  t.ok('入れ子項目の先頭は親の続きへ戻し不要な境界を増やさない', md(exit('- a\n  - b')) === '- a\n  b');
  const s = exit(), raw = md(s), offset = posToOffset(s.blocks, { b: 1, v: 0 });
  t.ok('原文offsetは境界を含み、編集位置は境界を飛び越す', offset === 5 && offsetToPos(s.blocks, 4).b === 1 && offsetToPos(s.blocks, 4).v === 0 && offsetToPos(s.blocks, offset + 1).v === 1);
  const all = { ...s, sel: { s: { b: 0, v: 0 }, e: { b: 1, v: 1 } } };
  t.ok('複数行コピーは送信境界を含め、解除行だけのコピーは本文だけ', selectionMarkdown(all) === raw && selectionMarkdown({ ...s, sel: { s: { b: 1, v: 0 }, e: { b: 1, v: 1 } } }) === 'b');
  const cut = deleteSelection(all);
  t.ok('全体切取りは境界も消す', md(cut) === '' && cut.blocks.length === 1);
  t.ok('編集行の左右削除は1回で隣行と結合する', md(backspaceAtStart(s)) === '> ab' && md(deleteAtEnd(select(s, 0, 1))) === '> ab');
  const replace = replaceMarkdownRange(s, '本文', offset, offset + 1);
  t.ok('setRangeText相当の本文置換は境界と2行を保つ', md(replace) === '> a\n\n本文' && replace.blocks.length === 2 && replace.sel.s.b === 1 && replace.sel.s.v === 2);
  const multiline = replaceMarkdownRange(s, 'new\nline', offset, offset + 1);
  t.ok('範囲APIの複数行置換でも境界を編集行へ戻さない', md(multiline) === '> a\n\nnew\nline' && multiline.blocks.length === 3 && multiline.blocks[1].breakBefore === '');
  const removeBoundary = replaceMarkdownRange(s, '', 4, 5);
  t.ok('原文APIで区切りを明示削除すれば通常の原文として扱う', md(removeBoundary) === '> a\nb' && !removeBoundary.blocks.some(b => b.breakBefore !== undefined));
  const replaceAll = replaceMarkdownRange(s, '> pasted\n> quote', 0, raw.length);
  t.ok('原文全置換は旧編集状態を持ち越さない', md(replaceAll) === '> pasted\n> quote' && shape(replaceAll) === 'quote,quote');
  const prepended = replaceMarkdownRange(s, 'queued\n\n', 0, 0);
  t.ok('送信待ちの本文を先頭へ戻しても既存下書きの境界を保つ', md(prepended) === 'queued\n\n' + raw && prepended.blocks.length === 4 && prepended.blocks.at(-1).breakBefore === '');
  const pasted = pasteText(s, 'new\ntext');
  t.ok('解除行へ複数行貼付しても境界と原文を保つ', md(pasted) === '> a\n\nnew\ntextb' && pasted.blocks.length === 3 && pasted.blocks[1].breakBefore === '');
  const formatted = toggleMark({ ...s, sel: { s: { b: 1, v: 0 }, e: { b: 1, v: 1 } } }, 'strong');
  t.ok('解除行の書式変更でも境界を保つ', md(formatted) === '> a\n\n**b**');
  const code = applyTriggers(insertPlain(select(exit('> a\n> '), 1), '```'), '`')?.state;
  t.ok('解除行のコード作成でも境界は開きフェンスだけ', code && code.blocks[1].breakBefore === '' && code.blocks.slice(2).every(b => b.breakBefore === undefined));
  const atom = insertAtom(select(s, 1), newAtom({ path: 'C:/test/a.png' }));
  t.ok('解除行頭の添付挿入は境界を添付へ移す', atom.blocks[1].kind === 'att' && atom.blocks[1].breakBefore === '' && atom.blocks[2].breakBefore === undefined);
  for (const removed of [removeAtoms(atom, () => true), backspaceAtStart(select(atom, 2)), deleteAtEnd(select(atom, 0, 1)), deleteSelection({ ...atom, sel: { s: { b: 1, v: 0 }, e: { b: 1, v: 1 } } })]) {
    t.ok('添付だけの削除は境界を次の本文へ戻す', md(removed) === raw && removed.blocks.length === 2 && removed.blocks[1].breakBefore === '');
  }
  const uploading = insertAtom(select(s, 1), newAtom({ pid: 'pending-test' }));
  t.ok('未完了の添付を除いた送信原文にも本文境界を残す', md(uploading) === raw && docToMarkdown(restoreEditing(raw, snapshotEditing(uploading.blocks))) === raw && bars(uploading).at(-1) === 0);
  t.ok('未完了添付を含む範囲コピーも本文境界を保つ', selectionMarkdown({ ...uploading, sel: { s: { b: 0, v: 0 }, e: { b: 2, v: 1 } } }) === raw);
  t.ok('添付から次の本文行頭までの範囲削除は本文境界を保つ', md(deleteSelection({ ...atom, sel: { s: { b: 1, v: 0 }, e: { b: 2, v: 0 } } })) === raw);
  const saved = snapshotEditing(s.blocks);
  for (const bad of [{ ...saved, v: 2 }, { ...saved, hash: 'bad' }, { ...saved, rows: [...saved.rows].reverse() }, { ...saved, rows: saved.rows.map((r, i) => i ? { ...r, before: 'secret' } : r) }]) {
    t.ok('不正な編集情報は捨て、本文だけを原文通り読む', normalizeEditingState(raw, bad) === null && docToMarkdown(restoreEditing(raw, bad)) === raw && restoreEditing(raw, bad).length === 3);
  }
  for (const text of ['>alone\nlazy', '-\n\ntext', '1. a\n3. b', '> a\n\nb']) {
    t.ok('既存の原文のみのデータを勝手に書き換えない', docToMarkdown(restoreEditing(text)) === text);
  }
  const merged = mergeEditingContent([{ text: raw, editing: saved }, { text: 'draft' }]);
  t.ok('編集取り消しの結合でも内部境界を保持する', merged.text === raw + '\n\ndraft' && restoreEditing(merged.text, merged.editing).length === 4);
  const withAttachment = mergeEditingContent([{ text: docToMarkdown(atom.blocks), editing: snapshotEditing(atom.blocks), attached: [{ path: 'C:/test/a.png' }] }, { text: 'other' }]);
  const restoredAttachment = restoreEditing(withAttachment.text, withAttachment.editing, { resolve: p => p === 'C:/test/a.png' });
  t.ok('編集中の結合で添付の実体と境界を保つ', restoredAttachment.some(b => b.kind === 'att' && b.breakBefore === ''));
  const channel = parseDrafts(serializeDrafts(new Map([['feed:x', { text: raw, attached: [], at: 1, editing: saved }]])));
  t.ok('チャンネルの保存形式を往復しても境界と2行を保つ', restoreEditing(channel.get('feed:x').text, channel.get('feed:x').editing).length === 2);
  let exact = true;
  for (let a = 0; a <= raw.length; a++) for (let b = a; b <= raw.length; b++) for (const value of ['', 'x', 'x\ny']) {
    const next = replaceMarkdownRange(s, value, a, b);
    exact &&= md(next) === raw.slice(0, a) + value + raw.slice(b);
  }
  t.ok('原文offsetの全範囲置換は指定した文字列と厳密に一致する', exact);
  for (const [kind, marker, text] of [
    ['quote', 'secret', 'secret body'], ['h', 'body', 'body text'], ['code', 'lang', 'language'],
    ['cont', 'body', 'body'], ['ul', '> ', '> quote'], ['ol', '- ', '- item'],
    ['quote', '# ', '# heading'], ['h', '> body# ', '> body# heading'],
    ['code', '```', '```js'], ['p', '> ', '> quote'], ['att', 'body', 'body'],
  ]) {
    const forged = { v: 1, length: text.length, hash: normalizeEditingState(text, snapshotEditing(markdownToDoc(text))).hash, rows: [{ at: 0, kind, marker }] };
    t.ok('本文や別種の記号を隠す編集情報を捨てる: ' + kind + '/' + marker, normalizeEditingState(text, forged) === null && docToMarkdown(restoreEditing(text, forged)) === text);
  }
  for (const text of ['>','-','1.','> ', '- ', '1. ', '> > ', '> - ', '- a\n  > b', '> # heading', '- > ### heading', '> ```js\n> body\n> ```', '- ```js\n  code\n  ```', '    code', '- a\n  continuation', '> - a\n>   b', '- > - a\n  >   b']) {
    const blocks = markdownToDoc(text), saved = snapshotEditing(blocks);
    t.ok('正規の空行・入れ子・コードprefixを検証して復元: ' + JSON.stringify(text), !!saved && docToMarkdown(restoreEditing(text, saved)) === text);
  }
  const unchanged = structuredClone(s.blocks);
  normalizeFences(unchanged);
  t.ok('通常の構造再確認で解除を取り消さない', docToMarkdown(unchanged) === raw && unchanged[1].kind === 'p');
}
