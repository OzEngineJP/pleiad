import assert from 'node:assert/strict';
import { createPageFrame, createFilePageRouter, pageHeading } from '../../web/page-frame.mjs';
import { fileMenuItems, browserTabMenuItems } from '../../web/file-actions.mjs';
import { configureLinkOpen } from '../../web/link-open.mjs';
import { linkDestination, linkMenuItems, statusParts } from '../../web/link-menu.mjs';
import { configureIsolatedOrigin, isolatedVisualizationUrl, configureVisualizationTabs, openVisualizationTab, visualizationBundleNotice } from '../../web/visualize-frame.mjs';

export const name = 'browser-unify-b3';
export const title = 'Chrome の有無によるファイルの行き先・iframe の境界・共通メニュー・隔離可視化';
const labels = rows => rows.map(row => row.sep ? '—' : row.label);

export default async function(t) {
  const requests = [], sent = [], mounted = [];
  const doc = { location:{ origin:'http://localhost:8123' }, defaultView:{ addEventListener(){}, removeEventListener(){} },
    createElement:() => ({ style:{}, setAttribute(){}, isConnected:true, contentWindow:{ postMessage:(...args) => sent.push(args) },
      getBoundingClientRect:() => ({ left:100, top:50, width:500, height:400 }), remove(){ this.isConnected = false; } }) };
  let current = 's1';
  const frame = createPageFrame({ doc, preview:{ openPanel:panel => mounted.push(panel) }, getSessionId:() => current,
    onRequest:request => { requests.push(request); return { done:true }; } });
  assert.equal(frame.open('/_pleiad/s/s1/file?path=doc.md'), true);
  const first = frame.frame;
  for (const url of ['https://example.test/_pleiad/s/s1/file', '/_pleiad/s/s2/file', '/_pleiad/s/s1/api/raw', '/_pleiad/s/%zz/file', 'http://[']) assert.equal(frame.open(url), false, url);
  const request = { type:'file-menu', sessionId:'s1', path:'D:/doc.md', kind:'file', x:20, y:30, requestId:'r1' };
  const event = overrides => ({ source:first.contentWindow, origin:doc.location.origin, data:{ type:'pleiad:page-request', request }, ...overrides });
  assert.equal(await frame.receive(event({ source:{} })), false);
  assert.equal(await frame.receive(event({ origin:'null' })), false);
  assert.equal(await frame.receive(event({ data:{ type:'pleiad:page-request', request:{ ...request, sessionId:'s2' } } })), false);
  assert.equal(await frame.receive(event({ data:{ type:'pleiad:page-request', request:{ ...request, type:'openDefault' } } })), false);
  assert.equal(await frame.receive(event()), true);
  assert.equal(requests[0].x, 120); assert.equal(requests[0].y, 80);
  assert.equal(sent[0][0].requestId, 'r1'); assert.equal(sent[0][1], doc.location.origin);
  current = 's2'; assert.equal(await frame.receive(event()), false); current = 's1';
  frame.open('/_pleiad/s/s1/dir?path=D:/');
  assert.equal(first.isConnected, false); assert.equal(await frame.receive(event()), false);
  frame.envChanged({ lang:'en' }); frame.command({ type:'reload' });
  assert.equal(sent.at(-2)[0].type, 'pleiad:env'); assert.equal(sent.at(-1)[0].type, 'pleiad:page-command');
  t.ok('iframe は 1 枚。送り元・origin・会話・要求の種類を検査し、座標を親の画面に移す', true);

  let connected = false;
  const opened = [], focused = [], flashed = [], iframe = [];
  let existing = [];
  const route = createFilePageRouter({ cmd:async (_name, args) => ({ path:'D:/work/doc.md', kind:'file', cwd:'D:/work' }),
    frame:{ open:(...args) => { iframe.push(args); return true; } }, caps:() => ({ pages:8124 }), connected:() => connected,
    openTab:async args => opened.push(args), tabs:() => existing, focusTab:async tab => focused.push(tab.id), flashTab:tab => flashed.push(tab.id) });
  await route({ path:'./doc.md', line:9 }, { sessionId:'s1', at:'now' });
  assert.equal(opened.length, 0); assert.match(iframe[0][0], /^\/_pleiad\/s\/s1\/file\?/); assert.match(iframe[0][0], /line=9/);
  // 右の欄の頭のパス: 作業フォルダーの中は相対、外は全体。全体は title
  const stub = { createElement:() => ({ children:[], append(...nodes) { this.children.push(...nodes); } }) };
  const parts = (path, cwd) => { const box = pageHeading(path, cwd, stub); return [box.title, ...box.children.map(child => child.textContent)]; };
  assert.deepEqual(parts('D:\\work\\docs\\a.md', 'D:/Work/'), ['D:\\work\\docs\\a.md', 'docs\\', 'a.md']);
  assert.deepEqual(parts('D:/other/a.md', 'D:/work'), ['D:/other/a.md', 'D:/other/', 'a.md']);
  assert.deepEqual(parts('D:/work2/a.md', 'D:/work'), ['D:/work2/a.md', 'D:/work2/', 'a.md']);
  connected = true; await route({ path:'alias.md' }, { sessionId:'s1' });
  assert.match(opened[0].url, /^http:\/\/localhost:8124\/_pleiad\/s\/s1\/file\?/);
  existing = [{ id:'tab1', file:{ path:'d:\\WORK\\doc.md' } }];
  await route({ path:'./doc.md' }, { sessionId:'s1' });
  assert.equal(opened.length, 1); assert.deepEqual(focused, ['tab1']); assert.deepEqual(flashed, ['tab1']);
  assert.equal(await route({ path:'doc.md' }), false);
  t.ok('Chrome が未接続なら同じページを iframe へ。接続済みなら実体でタブを再利用して強調する', true);

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
    const env = { unify:true, osActions:true, defaultAppAllowed:allowed, run(){} };
    assert.deepEqual(labels(fileMenuItems(target, env)), expected);
    assert.deepEqual(labels(browserTabMenuItems('file', { ...target, directory:target.kind === 'directory' }, env)), expected);
    assert(!labels(fileMenuItems(target, { ...env, osActions:false })).some(label => /エクスプローラー|既定の/.test(label)));
  }
  assert.equal(labels(fileMenuItems({ path:'/doc.md' }, { unify:true, osActions:true, platform:'MacIntel', run(){} }))[0], 'Finder で表示');
  t.ok('タブと行のメニューの順序を統一。フォルダーは保存なし、非許可拡張子は既定アプリなし、遠隔は外部操作なし', true);

  configureLinkOpen({ browserUnify:() => true });
  assert.equal(linkDestination({ href:'https://example.test', inAppAvailable:true }), 'external');
  assert.equal(statusParts({ href:'https://example.test', dest:'external', inAppSetting:true, hostScreen:true })[2], '');
  assert.equal(linkMenuItems({ href:'https://example.test', act:{} }).length, 3);
  configureIsolatedOrigin({ port:8125 });
  const bundle = { hash:'a'.repeat(64), entry:'図/index.html', htmlOnly:true, reason:'too-large' };
  assert.match(isolatedVisualizationUrl(bundle, { host:'192.168.1.7' }), /^http:\/\/192\.168\.1\.7:8125\/viz\//);
  assert.equal(isolatedVisualizationUrl({ ...bundle, entry:'../x' }), null);
  const viz = [];
  configureVisualizationTabs({ sessionId:() => 's1', connected:() => true, openTab:args => viz.push(args) });
  assert.equal(openVisualizationTab(bundle, {}), true); await Promise.resolve();
  assert.match(viz[0].url, /\?embed=tab$/); assert.equal(viz[0].reuse, false);
  assert.match(visualizationBundleNotice(bundle), /合計サイズ/);
  assert.equal(visualizationBundleNotice({ ...bundle, reason:'constructor' }), '画像などの関連ファイルは含めていません。');
  configureLinkOpen({ browserUnify:() => false });
  assert.equal(openVisualizationTab(bundle, {}), false); assert.equal(visualizationBundleNotice(bundle), '');
  assert.equal(linkDestination({ href:'https://example.test', inAppAvailable:true }), 'inapp');
  configureIsolatedOrigin(null); configureVisualizationTabs(null); frame.dispose();
  t.ok('Web は既定ブラウザー。可視化は隔離 URL の新しいタブへ。LAN は端末から届くホスト名、旗 off は従来どおり', true);
}
