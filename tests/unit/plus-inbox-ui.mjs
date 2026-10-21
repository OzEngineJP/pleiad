// 設定 › Pleiad Plus › 同期の「届いた変更」（web/plus-inbox.mjs）: 1 件ずつ開く・差分の行・取り込む／捨てる・押した後の 1 行（DOM の代役）
import { t as tr, setLanguage } from '../../web/i18n.mjs';
import { renderInbox, inboxDiffOps, inboxSub, inboxRow, inboxHiddenNotes, sizeText } from '../../web/plus-inbox.mjs';

export const name = 'plus-inbox-ui';
export const title = '同期の届いた変更: 1 件ずつ開く・差分（変更・新しいファイル・削除）・取り込む／捨てる・押した後の 1 行・手元が変わったときは取り込めない・新しい版が届いた・文字でない中身は大きさと sha256 ともう一度の確かめ・見えない文字・「すべて取り込む」は無い（DOM の代役）';

// 子を足したボタン（button('') の後に append）は、代役では textContent が空のままなので葉を集める
const deepText = n => (n.children?.length ? n.children.map(deepText).join('') : (n.textContent ?? ''));
const text = nodes => nodes.map(deepText).join(' ');
function all(nodes, pred) {
  const out = [];
  const walk = n => { if (pred(n)) out.push(n); for (const c of n.children ?? []) walk(c); };
  for (const n of nodes) walk(n);
  return out;
}
const byFk = (nodes, fk) => all(nodes, n => n.dataset?.fk === fk)[0] ?? null;
const byClass = (nodes, cls) => all(nodes, n => String(n.className ?? '').split(/\s+/).includes(cls));

const ITEMS = [
  { id: 'a', path: '~/.claude/skills/release/SKILL.md', kind: 'change', at: '2026-10-22T05:00:00Z', fromName: 'LAPTOP-7' },
  { id: 'b', path: '~/.claude/CLAUDE.md', kind: 'new', at: '2026-10-22T04:00:00Z', fromName: '' },
  { id: 'c', path: '~/.agents/skills/old/SKILL.md', kind: 'delete', at: '2026-10-22T03:00:00Z', fromName: 'DESK' },
];
const DETAILS = {
  a: { id: 'a', kind: 'change', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' },
  b: { id: 'b', kind: 'new', before: null, after: '# 手順\n- 書く\n' },
  c: { id: 'c', kind: 'delete', before: 'x\ny\n', after: null },
};

export default async function (t) {
  const before = (await import('../../web/i18n.mjs')).lang;
  try {
    await setLanguage('ja');
    const calls = [];
    const deps = { onBack: () => calls.push(['back']), onToggle: id => calls.push(['toggle', id]), onTake: id => calls.push(['take', id]), onDrop: id => calls.push(['drop', id]),
      onAskTake: id => calls.push(['ask', id]), onCancelTake: () => calls.push(['cancel']) };

    // 差分の行
    t.ok('差分: 変更は手元と届いたものの差（- と + が並ぶ）', JSON.stringify(inboxDiffOps(DETAILS.a).filter(o => o.t !== ' ').map(o => o.t + o.s)) === JSON.stringify(['-two', '+TWO']));
    t.ok('差分: 新しいファイルは + の行だけ（終わりの改行で空の行を作らない）', inboxDiffOps(DETAILS.b).every(o => o.t === '+') && inboxDiffOps(DETAILS.b).length === 2);
    t.ok('差分: 消すものは - の行だけ', inboxDiffOps(DETAILS.c).every(o => o.t === '-') && inboxDiffOps(DETAILS.c).map(o => o.s).join() === 'x,y');

    // 2 行目
    t.ok('2 行目: 「変更 · LAPTOP-7 · …」', inboxSub(ITEMS[0]).startsWith('変更 · LAPTOP-7 · '));
    t.ok('2 行目: 新しいファイル・名前の分からない PC', inboxSub(ITEMS[1]).startsWith('新しいファイル · ' + tr('settings.plus.inboxFromUnknown')));
    t.ok('2 行目: 削除', inboxSub(ITEMS[2]).startsWith('削除 · DESK'));

    // 面: 戻る・題・一覧
    let nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: DETAILS.a }, ...deps });
    t.ok('戻るは「Pleiad Plus」・題は「届いた変更」', byFk(nodes, 'back')?.className.includes('rm-back') && deepText(byFk(nodes, 'back')).includes('Pleiad Plus') && text(nodes).includes('届いた変更'));
    byFk(nodes, 'back').onclick();
    t.ok('戻るは onBack', calls.at(-1)[0] === 'back');
    const heads = byClass(nodes, 'inx-h');
    t.ok('1 件ごとに見出しの行（パス・aria-expanded）。開いているのは 1 件だけ', heads.length === 3 && heads.map(h => h.getAttribute('aria-expanded')).join() === 'true,false,false' && byClass(nodes, 'inx-b').length === 1);
    t.ok('パスは等幅（rm-nm mono）', byClass(nodes, 'mono')[0]?.textContent === ITEMS[0].path);
    t.ok('開いた 1 件に差分（.scx-lines）と「捨てる」「取り込む」', byClass(nodes, 'scx-lines').length === 1 && byFk(nodes, 'drop:a')?.textContent === '捨てる' && byFk(nodes, 'take:a')?.textContent === '取り込む'
      && byFk(nodes, 'take:a').className.includes('btn-primary') && byFk(nodes, 'drop:a').className.includes('btn-quiet'));
    t.ok('「すべて取り込む」は置かない', !text(nodes).includes('すべて'));
    heads[1].onclick();
    t.ok('ほかの見出しを押すと onToggle(id)', calls.at(-1)[0] === 'toggle' && calls.at(-1)[1] === 'b');
    byFk(nodes, 'take:a').onclick();
    t.ok('「取り込む」は onTake(id)', calls.at(-1)[0] === 'take' && calls.at(-1)[1] === 'a');
    byFk(nodes, 'drop:a').onclick();
    t.ok('「捨てる」は onDrop(id)', calls.at(-1)[0] === 'drop' && calls.at(-1)[1] === 'a');

    // 中身を読み込む前は押せない
    nodes = renderInbox({ items: ITEMS, open: 'b', details: {}, ...deps });
    t.ok('中身を読む前は「取り込む」「捨てる」を押せない', byFk(nodes, 'take:b').disabled === true && byFk(nodes, 'drop:b').disabled === true && text(nodes).includes(tr('settings.plus.inboxLoading')));
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: DETAILS.a }, busy: true, ...deps });
    t.ok('送っている間は押せない', byFk(nodes, 'take:a').disabled === true && byFk(nodes, 'drop:a').disabled === true);

    // 押した後: 1 行を残し、見出しは押せない
    nodes = renderInbox({ items: ITEMS, open: 'b', details: { a: DETAILS.a, b: DETAILS.b }, results: { a: { done: 'taken' }, c: { done: 'dropped' } }, ...deps });
    const notes = byClass(nodes, 'inx-done');
    t.ok('取り込んだ・捨てた行は「取り込みました」「捨てました」を出し、見出しは押せない', notes[0].hidden === false && notes[0].textContent === '取り込みました' && notes[2].textContent === '捨てました'
      && notes[1].hidden === true && byFk(nodes, 'inx:a').disabled === true && byFk(nodes, 'inx:a').getAttribute('aria-expanded') === 'false');
    t.ok('次の 1 件（b）が開いている', byFk(nodes, 'inx:b').getAttribute('aria-expanded') === 'true' && byFk(nodes, 'take:b') !== null);

    // 手元が変わっていた
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: DETAILS.a }, results: { a: { error: 'local_changed' } }, ...deps });
    t.ok('手元が変わっていたら、わけを出して「取り込む」を押せなくする（「捨てる」は押せる）', text(nodes).includes(tr('settings.plus.inboxLocalChanged')) && byFk(nodes, 'take:a').disabled === true && byFk(nodes, 'drop:a').disabled === false);

    // 中身が文字でない: 警告・大きさ・sha256。「取り込む」はもう一度確かめてから
    const SHA = 'ab'.repeat(32);
    const BIN = { ...DETAILS.a, binary: true, before: null, after: null, size: 2048, sha256: SHA, baseSize: 10 };
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: BIN }, ...deps });
    t.ok('文字でない中身は差分の代わりに警告', byClass(nodes, 'scx-lines').length === 0 && text(nodes).includes(tr('settings.plus.inboxBinary')));
    t.ok('文字でない中身は届いた版の大きさと sha256、手元の大きさを出す', text(nodes).includes(tr('settings.plus.inboxBinaryIncoming', { size: '2.0 KB' }))
      && byClass(nodes, 'inx-sha')[0]?.textContent === `sha256 ${SHA}` && text(nodes).includes(tr('settings.plus.inboxBinaryLocal', { size: tr('settings.plus.inboxBytes', { count: 10 }) })));
    t.ok('大きさの見せ方（バイト・KB・MB）', sizeText(10) === tr('settings.plus.inboxBytes', { count: 10 }) && sizeText(2048) === '2.0 KB' && sizeText(3 * 1024 * 1024) === '3.0 MB' && sizeText(undefined) === '');
    byFk(nodes, 'take:a').onclick();
    t.ok('文字でない中身の「取り込む」は、すぐ取り込まずに確かめを開く（onAskTake）', calls.at(-1)[0] === 'ask' && calls.at(-1)[1] === 'a');
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: BIN }, confirming: 'a', ...deps });
    t.ok('確かめの間は「取り込む」「捨てる」の代わりに、問いと「やめる」「確かめたので取り込む」', byFk(nodes, 'take:a') === null && byFk(nodes, 'drop:a') === null
      && text(nodes).includes(tr('settings.plus.inboxBinaryConfirm')) && byFk(nodes, 'takeYes:a')?.textContent === tr('settings.plus.inboxBinaryConfirmYes'));
    byFk(nodes, 'takeNo:a').onclick();
    t.ok('「やめる」は onCancelTake', calls.at(-1)[0] === 'cancel');
    byFk(nodes, 'takeYes:a').onclick();
    t.ok('「確かめたので取り込む」で onTake(id)', calls.at(-1)[0] === 'take' && calls.at(-1)[1] === 'a');
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: BIN }, confirming: 'a', busy: true, ...deps });
    t.ok('送っている間は確かめのボタンも押せない', byFk(nodes, 'takeYes:a').disabled === true && byFk(nodes, 'takeNo:a').disabled === true);
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: DETAILS.a }, confirming: 'a', ...deps });
    t.ok('文字の中身には確かめを出さない', byFk(nodes, 'takeYes:a') === null && byFk(nodes, 'take:a') !== null);

    // 見ている間に新しい版が届いた
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: DETAILS.a }, renewed: { a: true }, ...deps });
    t.ok('新しい版が届いたら「新しい版が届きました」を差分の上に出す', byClass(nodes, 'inx-renewed')[0]?.textContent === tr('settings.plus.inboxRenewed') && byClass(nodes, 'scx-lines').length === 1);
    nodes = renderInbox({ items: ITEMS, open: 'a', details: {}, renewed: { a: true }, ...deps });
    t.ok('読み直している間も「新しい版が届きました」は残し、押せない', byClass(nodes, 'inx-renewed').length === 1 && byFk(nodes, 'take:a').disabled === true);

    // 見えない文字・改行コードだけの違い
    const hid = { id: 'a', kind: 'change', before: 'one\ntwo\n', after: 'one\ntw\u202Eo\u200B\n' };
    t.ok('向きを変える制御文字・幅の無い文字を見つける', inboxHiddenNotes(hid).join() === 'bidi,invisible');
    t.ok('差分の中では ⟨U+XXXX⟩ と書く', inboxDiffOps(hid).some(o => o.t === '+' && o.s === 'tw⟨U+202E⟩o⟨U+200B⟩'));
    t.ok('改行コードだけの違いを見つける', inboxHiddenNotes({ kind: 'change', before: 'a\nb\n', after: 'a\r\nb\r\n' }).join() === 'eol');
    t.ok('頭の BOM と消すものは数えない', inboxHiddenNotes({ kind: 'new', after: '\uFEFF# x\n' }).length === 0 && inboxHiddenNotes({ kind: 'delete', before: '\u202E' }).length === 0);
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: hid }, ...deps });
    t.ok('見えない文字の印を差分の上に出す', text(nodes).includes(tr('settings.plus.inboxHidden.bidi')) && text(nodes).includes(tr('settings.plus.inboxHidden.invisible')));

    // 読み込み中・空
    t.ok('一覧の読み込み中', text(renderInbox({ loading: true, ...deps })).includes(tr('settings.plus.inboxLoading')));
    t.ok('空なら「届いた変更はありません」の一言', text(renderInbox({ items: [], ...deps })).includes(tr('settings.plus.inboxEmpty')));

    // 同期の行（plus-sync から使う）
    const row = inboxRow(5, () => calls.push(['open']));
    row.onclick();
    t.ok('「届いた変更 5 件」の行は押すと開く', deepText(row).includes('届いた変更 5 件') && calls.at(-1)[0] === 'open');

    await setLanguage('en');
    t.ok('英語: 1 件と複数', deepText(inboxRow(1, () => {})).includes('1 change arrived') && deepText(inboxRow(2, () => {})).includes('2 changes'));
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: DETAILS.a }, ...deps });
    t.ok('英語: ボタンと題', byFk(nodes, 'take:a').textContent !== '取り込む' && !/[ぁ-ん]/.test(text(nodes).replace(/~\/\.claude\S*/g, '')));
  } finally {
    await setLanguage(before);
  }
}
