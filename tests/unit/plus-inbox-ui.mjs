// 設定 › Pleiad Plus › 同期の「届いた変更」（web/plus-inbox.mjs）: 1 件ずつ開く・差分の行・取り込む／捨てる・押した後の 1 行（DOM の代役）
import { t as tr, setLanguage } from '../../web/i18n.mjs';
import { renderInbox, inboxDiffOps, inboxSub, inboxRow } from '../../web/plus-inbox.mjs';

export const name = 'plus-inbox-ui';
export const title = '同期の届いた変更: 1 件ずつ開く・差分（変更・新しいファイル・削除）・取り込む／捨てる・押した後の 1 行・手元が変わったときは取り込めない・「すべて取り込む」は無い（DOM の代役）';

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
    const deps = { onBack: () => calls.push(['back']), onToggle: id => calls.push(['toggle', id]), onTake: id => calls.push(['take', id]), onDrop: id => calls.push(['drop', id]) };

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

    // 中身が文字でない
    nodes = renderInbox({ items: ITEMS, open: 'a', details: { a: { ...DETAILS.a, binary: true, before: null, after: null } }, ...deps });
    t.ok('文字でない中身は差分の代わりに一言', byClass(nodes, 'scx-lines').length === 0 && text(nodes).includes(tr('settings.plus.inboxBinary')));

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
