import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPageTabs } from '../../web/page-tabs.mjs';
import { pageOpenFixture } from '../lib/page-open.mjs';
export const name = 'browser-pages';
export const title = '画面内のページ・更新・表示切り替え・ファイルツリー';
export default async function(t) {
  const calls = [], origin = 'http://localhost:8123';
  const model = createPageTabs({ origin, pageOpen:async input => { calls.push(input); return pageOpenFixture('http://localhost:8125')(input); } });
  const a = await model.open({sessionId:'one',kind:'file',path:'D:/work/a.html'});
  assert.equal(a.url, (await pageOpenFixture('http://localhost:8125')(calls[0])).url);
  assert.deepEqual(calls, [{sessionId:'one',kind:'html',path:'D:/work/a.html',tab:a.targetId}]);
  assert.equal(a.page.kind, 'html');
  t.ok('HTML uses the complete URL from pageOpen (kind:html)', true);
  const v = await model.open({sessionId:'one',kind:'viz',vizHash:'ab'.repeat(32),entry:'chart.html'});
  assert.equal(calls[1].kind, 'viz'); assert.equal(calls[1].hash, 'ab'.repeat(32));
  assert.equal(v.page.kind, 'viz'); assert.equal(v.page.vizHash, 'ab'.repeat(32));
  t.ok('visualizations ask pageOpen with the bundle hash', true);
  const b = await model.open({sessionId:'two',kind:'file',path:a.page.path});
  model.event({type:'page:changed',sessionId:'one',path:a.page.path});
  assert.equal(a.reload, 1); assert.equal(b.reload, undefined);
  model.activity(a); model.event({type:'page:changed',sessionId:'one',path:a.page.path});
  assert.equal(a.pending, true); assert.equal(a.reload, 1);
  model.reload(a); assert.equal(a.pending, false); assert.equal(a.touched, false);
  model.activity(a, true); const old = a.url;
  model.event({type:'page:moved',sessionId:'one',previous:{pages:[8125],isolated:[]},ports:{pages:8225}});
  assert.equal(a.pending, true); assert.equal(a.url, old.replace(':8125', ':8225')); assert.equal(a.dirty, true);
  t.ok('refresh waits after interaction, dirty origin changes wait, and sessions stay separate', true);
  await model.open({sessionId:'one',kind:'git'}, a); model.travel(a,-1);
  assert.equal(a.page.path, 'D:/work/a.html'); assert.equal(a.canGoForward,true);
  model.close(a); assert.equal(model.list('one').length,1); assert.equal(model.list('two').length,1);
  t.ok('page history and closing are independent of Chrome targets',true);
  const bad = createPageTabs({origin,pageOpen:async()=>({kind:'html',url:'javascript:alert(1)'})});
  await assert.rejects(bad.open({sessionId:'one',kind:'file',path:'a.htm'}));
  t.ok('pageOpen rejects executable URLs',true);
  if (process.env.BROWSER_PAGES_TEST !== '1') { t.note('BROWSER_PAGES_TEST=1 enables the isolated browser checks.'); return; }
  const require = createRequire(import.meta.url);
  const pw = process.env.BROWSER_PAGES_PLAYWRIGHT_PACKAGE ? createRequire(process.env.BROWSER_PAGES_PLAYWRIGHT_PACKAGE)('playwright-core') : require('playwright-core');
  const browser = await pw.chromium.launch({headless:true,...(process.env.BROWSER_PAGES_CHROME ? {executablePath:process.env.BROWSER_PAGES_CHROME}:{}),args:['--use-angle=d3d11','--num-raster-threads=4']});
  try { await require('../browser/browser-pages.cjs')({browser,check:(...args)=>t.ok(...args),screenshots:process.env.BROWSER_PAGES_SCREENSHOTS}); }
  finally { await browser.close(); }
}
