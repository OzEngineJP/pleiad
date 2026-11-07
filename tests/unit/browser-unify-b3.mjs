import assert from 'node:assert/strict';
import { createFilePageRouter, pageRequestOf, framePoint } from '../../web/page-frame.mjs';
import { fileMenuItems } from '../../web/file-actions.mjs';
import { linkMenuItems, statusParts } from '../../web/link-menu.mjs';
import { configureIsolatedOrigin, isolatedVisualizationUrl, configureVisualizationTabs, openVisualizationTab, visualizationBundleNotice } from '../../web/visualize-frame.mjs';

export const name = 'browser-unify-b3';
export const title = 'Chrome の有無によるファイルの行き先・iframe の境界・共通メニュー・隔離可視化';
const labels = rows => rows.map(row => row.sep ? '—' : row.label);

export default async function(t) {
  const request = { type:'file-menu', sessionId:'s1', path:'D:/doc.md', kind:'file', x:20, y:30 };
  assert.equal(pageRequestOf({ type:'pleiad:page-request', request }, 's2'), null);
  assert.equal(pageRequestOf({ type:'pleiad:page-request', request:{ ...request, type:'openDefault' } }, 's1'), null);
  assert.deepEqual(framePoint(request, { left:100, top:50, width:500, height:400 }), { ...request, x:120, y:80 });
  t.ok('ページの要求は会話と種類を検査し、座標を親の画面へ移す', true);
  let connected = false;
  const opened = [], focused = [], flashed = [], iframe = [];
  let existing = [];
  const route = createFilePageRouter({ cmd:async (_name, args) => ({ path:'D:/work/doc.md', kind:'file', cwd:'D:/work' }),
    frame:{ open:(...args) => { iframe.push(args); return true; } }, caps:() => ({ pages:8124 }), connected:() => connected,
    openTab:async args => opened.push(args), tabs:() => existing, focusTab:async tab => focused.push(tab.id), flashTab:tab => flashed.push(tab.id) });
  await route({ path:'./doc.md', line:9 }, { sessionId:'s1', at:'now' });
  assert.equal(opened.length, 1); assert.equal(iframe.length, 0); assert.equal(opened[0].line, 9); assert.equal(opened[0].path, 'D:/work/doc.md');
  connected = true; await route({ path:'alias.md' }, { sessionId:'s1' });
  assert.equal(opened[1].kind, 'file'); assert.equal(opened[1].sessionId, 's1');
  existing = [{ id:'tab1', local:true, page:{ path:'d:\\WORK\\doc.md' } }];
  await route({ path:'./doc.md' }, { sessionId:'s1' });
  assert.equal(opened.length, 2); assert.deepEqual(focused, ['tab1']); assert.deepEqual(flashed, ['tab1']);
  assert.equal(await route({ path:'doc.md' }), false);
  t.ok('Chrome の接続によらずページのタブへ。同じ実体のファイルは再利用して強調する', true);

  let finishResolve, generation = 0;
  const delayed = createFilePageRouter({ cmd:() => new Promise(resolve => { finishResolve = resolve; }),
    caps:() => ({ pages:8124 }), frame:{ open:() => { throw Error('stale iframe'); } }, getGeneration:() => generation });
  const pending = delayed({ path:'doc.md' }, { sessionId:'s1' });
  generation++;
  finishResolve({ path:'D:/work/doc.md', kind:'file' });
  assert.equal(await pending, false);
  t.ok('パスの解決を待つ間に会話が変わったら、遅れたページを出さない', true);

  const cases = [
    [{ path:'D:/page.html' }, false, ['エクスプローラーで表示', '既定のブラウザーで開く', '—', 'パスをコピー', '相対パスをコピー', '—', '保存', '会話で使う']],
    [{ path:'D:/doc.md' }, true, ['エクスプローラーで表示', '既定のアプリで開く', '—', 'パスをコピー', '相対パスをコピー', '—', '保存', '会話で使う']],
    [{ path:'D:/run.ps1' }, false, ['エクスプローラーで表示', '—', 'パスをコピー', '相対パスをコピー', '—', '保存', '会話で使う']],
    [{ path:'D:/folder', kind:'directory' }, false, ['エクスプローラーで開く', '既定のブラウザーで開く', '—', 'パスをコピー', '相対パスをコピー', '—', '会話で使う']],
  ];
  for (const [target, allowed, expected] of cases) {
    const env = { osActions:true, defaultAppAllowed:allowed, platform:'Win32', run(){} };
    assert.deepEqual(labels(fileMenuItems(target, env)), expected);
    assert(!labels(fileMenuItems(target, { ...env, osActions:false })).some(label => /エクスプローラー|既定の/.test(label)));
  }
  assert.equal(labels(fileMenuItems({ path:'/doc.md' }, { osActions:true, platform:'MacIntel', run(){} }))[0], 'Finder で表示');
  t.ok('ファイルのメニューの順序。フォルダーは保存なし、非許可拡張子は既定アプリなし、遠隔は外部操作なし', true);

  assert.deepEqual(statusParts({ href:'https://example.test' }), ['既定のブラウザーで開く', 'example.test']);
  assert.equal(linkMenuItems({ act:{} }).length, 3);
  configureIsolatedOrigin({ port:8125 });
  const bundle = { hash:'a'.repeat(64), entry:'図/index.html', htmlOnly:true, reason:'too-large' };
  assert.match(isolatedVisualizationUrl(bundle), /^http:\/\/localhost:8125\/viz\//, '画面が 127.0.0.1 でも隔離は localhost（Host の検査に通る名前）');
  assert.equal(isolatedVisualizationUrl({ ...bundle, entry:'../x' }), null);
  const viz = [];
  configureVisualizationTabs({ sessionId:() => 's1', connected:() => true, openTab:args => viz.push(args) });
  assert.equal(openVisualizationTab(bundle, {}), true); await Promise.resolve();
  assert.match(viz[0].url, /\?embed=tab$/); assert.equal(viz[0].reuse, false);
  assert.equal(openVisualizationTab(bundle, {}, '月ごとの売上'), true); await Promise.resolve();
  assert.match(viz[1].url, /\?embed=tab&title=%E6%9C%88/, '広げたタブの題は可視化の見出し');
  assert.match(visualizationBundleNotice(bundle), /合計サイズ/);
  assert.equal(visualizationBundleNotice({ ...bundle, reason:'constructor' }), '画像などの関連ファイルは含めていません。');
  configureVisualizationTabs({ sessionId:() => 's1', connected:() => false, openTab:args => viz.push(args) });
  assert.equal(openVisualizationTab(bundle, {}), false, 'Chrome がつながっていなければ開かない（呼び出し元が既定のブラウザーへ回す）');
  assert.equal(visualizationBundleNotice({ ...bundle, htmlOnly:false }), '');
  configureIsolatedOrigin(null); configureVisualizationTabs(null);
  t.ok('Web は既定ブラウザー。可視化は隔離 URL の新しいタブへ。LAN は端末から届くホスト名', true);
}
