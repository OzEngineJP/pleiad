import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPageTabs } from '../../web/page-tabs.mjs';
import { pageOpenFixture } from '../lib/page-open-w1.mjs';
export const name = 'browser-pages-w1';
export const title = '画面内のページ・更新・表示切り替え・ファイルツリー';
export default async function(t) {
  const calls = [], origin = 'http://localhost:8123';
  const model = createPageTabs({ origin, pageOpen:async input => { calls.push(input); return pageOpenFixture('http://localhost:8125')(input); } });
  const a = await model.open({sessionId:'one',kind:'file',path:'D:/work/a.html'});
  assert.equal(a.url, (await pageOpenFixture('http://localhost:8125')(calls[0])).url);
  assert.deepEqual(calls, [{sessionId:'one',kind:'file',path:'D:/work/a.html'}]);
  t.ok('HTML uses the complete URL from pageOpen', true);
  const b = await model.open({sessionId:'two',kind:'file',path:a.page.path});
  model.event({type:'page:changed',sessionId:'one',path:a.page.path});
  assert.equal(a.reload, 1); assert.equal(b.reload, undefined);
  model.activity(a); model.event({type:'page:changed',sessionId:'one',path:a.page.path});
  assert.equal(a.pending, true); assert.equal(a.reload, 1);
  model.reload(a); assert.equal(a.pending, false); assert.equal(a.touched, false);
  model.activity(a, true); const old = a.url;
  model.event({type:'page:moved',sessionId:'one',from:old,to:'http://localhost:8225/moved'});
  assert.equal(a.pending, true); assert.equal(a.url, 'http://localhost:8225/moved'); assert.equal(a.dirty, true);
  t.ok('refresh waits after interaction, dirty origin changes wait, and sessions stay separate', true);
  await model.open({sessionId:'one',kind:'git'}, a); model.travel(a,-1);
  assert.equal(a.page.path, 'D:/work/a.html'); assert.equal(a.canGoForward,true);
  model.close(a); assert.equal(model.list('one').length,0); assert.equal(model.list('two').length,1);
  t.ok('page history and closing are independent of Chrome targets',true);
  const bad = createPageTabs({origin,pageOpen:async()=>({url:'javascript:alert(1)'})});
  await assert.rejects(bad.open({sessionId:'one',kind:'file',path:'a.htm'}));
  t.ok('pageOpen rejects executable URLs',true);
  if (process.env.W1_BROWSER_TEST !== '1') { t.note('W1_BROWSER_TEST=1 enables the isolated browser checks.'); return; }
  const require = createRequire(import.meta.url);
  const pw = process.env.W1_PLAYWRIGHT_PACKAGE ? createRequire(process.env.W1_PLAYWRIGHT_PACKAGE)('playwright-core') : require('playwright-core');
  const browser = await pw.chromium.launch({headless:true,...(process.env.W1_CHROME ? {executablePath:process.env.W1_CHROME}:{}),args:['--use-angle=d3d11','--num-raster-threads=4']});
  try { await require('../browser/browser-pages-w1.cjs')({browser,check:(...args)=>t.ok(...args),screenshots:process.env.W1_SCREENSHOTS}); }
  finally { await browser.close(); }
}
