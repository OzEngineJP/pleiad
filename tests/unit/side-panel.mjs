// 右パネルの枠（web/side-panel.mjs）: モードごとの部品の表と、渡されなかった部品を必ず隠す当て方。
import assert from 'node:assert/strict';
import { applySlots, fileSlots, customSlots, chromeSlots, subtitleFor } from '../../web/side-panel.mjs';
import { visualizationDocument } from '../../web/visualize-document.mjs';

export const name = 'side-panel';
export const title = '右パネルの枠: モードごとの部品・渡さない部品は隠す・見出しの下の行';

/** 枠の部品を最小の DOM（tests/lib/dom-stub.mjs）で作る */
function makeParts() {
  const node = (tag = 'div') => document.createElement(tag);
  const ids = ['tree', 'more', 'wide', 'close', 'path', 'reload', 'reveal', 'save', 'use', 'status', 'profile', 'windowMore'];
  const buttons = Object.fromEntries(ids.map(id => { const b = node('button'); b.textContent = id; return [id, b]; }));
  return { panel: node('aside'), name: node('span'), kind: node('span'), path: node('div'), actions: node(), toolbar: node(), switcher: node(),
    tools: node(), location: node(), note: node(), treePane: node(), footer: node('footer'), footActions: node(), status: node('span'),
    content: node(), buttons };
}
const shown = (parts, container) => parts[container].children.map(c => c.textContent);

export default async function (t) {
  // ---- モードの表
  const loading = fileSlots({ file: null, osActions: true });
  assert.deepEqual(loading.head, ['tree', 'wide', 'close'], '取得前は ⋯ を出さない');
  assert.equal(loading.aside, true); assert.equal(loading.views, false);
  assert.deepEqual(loading.footer, ['use']);
  const html = fileSlots({ file: { kind: 'html', text: '<p>', downloadable: true }, osActions: true });
  assert.deepEqual(html.head, ['tree', 'more', 'wide', 'close']);
  assert.deepEqual(html.toolbar, ['path', 'reload'], 'HTML の描画は Pleiad のページの仕事なので、道具の列にブラウザーの口は無い');
  assert.deepEqual(html.footer, ['reveal', 'save', 'use']);
  const remote = fileSlots({ file: { kind: 'html', text: '<p>', downloadable: true }, osActions: false });
  assert.deepEqual(remote.toolbar, ['path', 'reload']); assert.deepEqual(remote.footer, ['save', 'use']);
  assert.equal(html.views, false, 'HTML は原文だけ（描画の切り替えは無い）');
  assert.equal(fileSlots({ file: { kind: 'text', text: 'x' } }).views, false, 'テキストは切り替えを出さない');
  assert.equal(fileSlots({ file: { kind: 'markdown', text: '# x' } }).kind, 'ファイル');
  t.ok('ファイル: 取得の前後・HTML・遠隔で出す部品', true);

  const custom = customSlots({ label: 'コンテキスト' });
  assert.deepEqual(custom.head, ['close']); assert.equal(custom.footer, null); assert.equal(custom.aside, false);
  t.ok('コンテキストは閉じるだけ', true);

  const chrome = chromeSlots({ label: '会話の Chrome', toolbar: ['status', 'profile', 'windowMore'] });
  assert.equal(chrome.mode, 'browser');
  assert.deepEqual(chrome.head, ['wide', 'close']);
  assert.deepEqual(chrome.toolbar, ['status', 'profile', 'windowMore'], '道具の列は窓の側が渡したまま');
  assert.equal(chrome.aside, false); assert.equal(chrome.footer, null); assert.equal(chrome.views, false);
  t.ok('会話の Chrome の窓: 見出しは広げると閉じる、道具の列は窓の側が渡す', true);

  // ---- 枠に当てる。前のモードの部品が残らない
  const parts = makeParts();
  applySlots(parts, { ...html, title: 'a.html', subtitle: 'docs/a.html', note: '', status: 'HTML · 12:00 に取得' });
  assert.deepEqual(shown(parts, 'actions'), ['tree', 'more', 'wide', 'close']);
  assert.equal(parts.treePane.hidden, false); assert.equal(parts.kind.textContent, 'ファイル');
  parts.location.hidden = false;
  applySlots(parts, { ...html, title: 'a.html' });
  assert.equal(parts.location.hidden, false, '「パス」があれば開いた行はそのまま');
  applySlots(parts, { ...chrome, title: '会話の Chrome', subtitle: '', note: '' });
  assert.equal(parts.treePane.hidden, true, 'ファイルの次に Chrome の窓を開いてもツリーの枠が残らない');
  assert.deepEqual(shown(parts, 'actions'), ['wide', 'close']);
  assert.deepEqual(shown(parts, 'tools'), ['status', 'profile', 'windowMore']);
  assert.equal(parts.footer.hidden, true);
  assert.equal(parts.location.hidden, true, '「パス」が無いモードではパスの行を閉じる');
  assert.equal(parts.note.hidden, true); assert.equal(parts.panel.dataset.mode, 'browser');
  assert.equal(parts.panel.getAttribute('aria-label'), '会話の Chrome');
  applySlots(parts, { ...custom, title: 'コンテキスト', subtitle: '', note: '' });
  assert.equal(parts.toolbar.hidden, true); assert.equal(parts.footer.hidden, true); assert.equal(parts.kind.hidden, true);
  assert.deepEqual(shown(parts, 'actions'), ['close']); assert(parts.panel.classList.contains('custom'));
  applySlots(parts, { ...loading, title: 'b.md' });
  assert(!parts.panel.classList.contains('custom')); assert.equal(parts.footer.hidden, false); assert.equal(parts.treePane.hidden, false);
  assert.equal(parts.name.textContent, 'b.md');
  t.ok('枠: 渡された部品だけを並べ、ほかは隠す（ファイル → Chrome の窓 → コンテキスト → ファイル）', true);

  // ---- 見出しの下の行
  assert.equal(subtitleFor('D:\\w\\out\\q.html', 'D:\\w'), 'out/q.html');
  assert.equal(subtitleFor('d:/W/out/q.html', 'D:/w/'), 'out/q.html', 'Windows は大文字小文字を問わない');
  assert.equal(subtitleFor('/home/a/x.html', '/home/b'), '/home/a/x.html', '外ならそのまま');
  assert.equal(subtitleFor('/home/a/x.html', null), '/home/a/x.html');
  assert.equal(subtitleFor(null, '/w', '会話に保存された表示'), '会話に保存された表示');
  t.ok('見出しの下: 作業ディレクトリの中は相対、外はそのまま、元が無ければ説明', true);

  // ---- 単体で開く写し（サーバーが返す文書）
  const doc = visualizationDocument('<p>x</p>', { resize: false, title: '<売上>' });
  assert(!doc.includes('ply-visualize-height')); assert(doc.includes('<title>&#60;売上&#62;</title>'));
  assert(visualizationDocument('<p>x</p>').includes('ply-visualize-height'), '会話の枠は今までどおり高さを知らせる');
  t.ok('写しの文書: 単体では高さのスクリプトを持たず、題はエスケープする', true);
}
