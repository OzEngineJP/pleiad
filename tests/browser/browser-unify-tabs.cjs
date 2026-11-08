// Isolated component browser test. Run through browser-unify-tabs with
// B1_BROWSER_TEST=1; no installed profile or user data is used.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

module.exports = async function browserUnifyTabs({ browser, check, screenshots, mockShots, unifySource, panelSource, hubSource }) {
  const repo = path.resolve(__dirname, '../..');
  const sample = await fs.readFile(path.join(repo, 'docs/file-preview.md'), 'utf8');
  const fixture = String.raw`<!doctype html><html lang="ja" data-theme="light"><meta charset="utf-8">
<script type="importmap">{"imports":{"i18next":"/vendor/i18next.mjs"}}</script>
<link rel="stylesheet" href="/web/tokens.css"><link rel="stylesheet" href="/web/pages/pages.css"><link rel="stylesheet" href="/web/pages/content.css">
<style>body{display:flex;min-height:100vh;background:var(--surface-0)}#conversation{flex:1;min-width:0;padding:36px;font-size:14px}#panel{width:560px;flex:none;min-width:0;background:var(--surface-paper);height:100vh;display:flex;flex-direction:column;overflow:hidden}#page{overflow:auto;flex:1}#page main{padding:16px 28px}#page .metadata{font-size:11px}#tree{display:none}.i{width:18px;height:18px}#menu{position:fixed;z-index:50;background:var(--surface-paper);box-shadow:0 4px 16px var(--shadow);padding:6px;border-radius:8px}#menu button{display:block;width:100%;text-align:left}#menu[hidden]{display:none}@media(max-width:600px){#conversation{display:none}#panel{width:100%}#page main{padding:16px 20px}}</style>
<section id="conversation"><h3>ブラウザーの一本化</h3><p>確認のために、計画と実際のページを開いてください。</p><div id="chromeBanner"><div class="cc-banner">一時停止中</div></div><div id="composer"></div></section>
<aside id="panel"><div id="page"><aside id="tree" hidden></aside><main id="content"></main></div></aside><div id="menu" hidden></div>
<script type="module">
import { createBrowserUnify } from '/web/browser-unify.mjs';
import { renderFile } from '/web/pages/file.mjs';
window.sent=[]; window.notices=[]; window.pageRequests=[];
window.filePath='D:/dev/pleiad/docs/file-preview.md';
window.rows=[{sessionId:'one',targetId:'file',windowId:1,title:'file-preview.md',url:'http://localhost/_pleiad/s/one/file?path='+encodeURIComponent(filePath),page:{kind:'file',path:filePath},canGoBack:true},{sessionId:'one',targetId:'web',windowId:1,title:'GitHub · Pleiad',url:'https://github.com/tekalu1/pleiad',favicon:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="gray"/></svg>')}];
window.chromeFixture={sessionId:'one',tabId:'file',mountBrowserChrome(root){document.querySelector('#panel').prepend(root)},onOpenChange(fn){this.openChange=fn},onTargetChange(){},onTabChange(fn){this.change=fn},close(){window.closedPanel=true}};
window.ui=createBrowserUnify({state:{current:'one',cwd:'D:/dev/pleiad'},chrome:()=>chromeFixture,controlStore:{get:()=>({state:window.agentState||'idle'})},composer:()=>document.querySelector('#composer'),osActions:()=>window.hostScreen===true,notify:text=>notices.push(text),onPageRequest:(request,where)=>{pageRequests.push({request,where});return true},
async cmd(command,args){sent.push({command,args});if(command==='chromeAddress')return {suggestions:args.input.includes('missing')?[]:[{path:filePath}]};if(command==='chromeNavigate'&&args.input?.includes('missing'))throw {code:'not-found'};if(command==='chromePinWindow'){if(window.delayPin)await new Promise((resolve,reject)=>{window.finishPin=resolve;window.failPin=reject});chromeFixture.tabId=args.tabId;chromeFixture.change?.({type:'state'})}return {}},
showMenu(x,y,items){const menu=document.querySelector('#menu');menu.hidden=false;menu.style.left=Math.min(x,innerWidth-180)+'px';menu.style.top=y+'px';menu.replaceChildren(...items.filter(i=>!i.sep).map(item=>{const b=document.createElement('button');if(item.icon)b.append(item.icon.cloneNode(true));b.append(document.createTextNode(item.label));b.disabled=!!item.disabled;b.onclick=()=>{menu.hidden=true;item.onClick()};return b}))}});
window.resetRows=()=>ui.onEvent({type:'tab:info',sessionId:'one',reset:true,tabs:rows});resetRows();
window.enable=()=>ui.capsChanged({browserUnify:true});
await renderFile(document.querySelector('#content'),{name:'file-preview.md',path:filePath,kind:'markdown',fetchedAt:'2026-11-06T03:30:00Z',size:18022,text:__SAMPLE__});
window.ready=true;
</script></html>`.replace('__SAMPLE__', JSON.stringify(sample).replaceAll('<', '\\u003c'));
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/web/chrome-panel.mjs' && panelSource) { res.setHeader('Content-Type', 'text/javascript'); res.end(panelSource); return; }
      if (pathname === '/web/browser-unify.mjs' && unifySource) { res.setHeader('Content-Type', 'text/javascript'); res.end(unifySource); return; }
      if (pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
      if (pathname === '/favicon.ico') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64')); return; }
      if (pathname.startsWith('/site') || pathname.startsWith('/_pleiad/s/one/file')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>Live '+pathname+'</title><link rel="icon" href="/favicon.ico"><h1>Page</h1>'); return;
      }
      let file;
      if (pathname === '/vendor/i18next.mjs') file = path.join(repo, 'node_modules/i18next/dist/esm/i18next.js');
      else {
        file = path.resolve(repo, '.' + pathname);
        if (!file.startsWith(path.join(repo, 'web') + path.sep) && pathname !== '/tests/lib/tab-state.mjs') { res.writeHead(404); res.end(); return; }
      }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport:{width:1280,height:720}, deviceScaleFactor:1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const shot = async name => { if (screenshots) { await fs.mkdir(screenshots, {recursive:true}); await page.screenshot({path:path.join(screenshots, `b1-${name}.png`),animations:'allow'}); } };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    try { await page.waitForFunction(() => window.ready, null, {timeout:10000}); }
    catch (error) { throw new Error(errors.join('; ') || error.message); }
    const jpeg = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = source.height = 800;
      const reduced = document.createElement('canvas'); reduced.width = reduced.height = 268;
      const context = source.getContext('2d'), small = reduced.getContext('2d');
      const paint = (x, size = 1) => {
        context.fillStyle = '#fff'; context.fillRect(0,0,800,800);
        context.fillStyle = '#222'; context.font = '16px sans-serif'; context.fillText('Document preview',20,30);
        if (x !== null) { context.fillStyle = '#000'; context.fillRect(x,100,size,size); }
        small.drawImage(source,0,0,268,268);
        return { low:reduced.toDataURL('image/jpeg',0.55).split(',')[1], sharp:source.toDataURL('image/jpeg',0.8).split(',')[1] };
      };
      const original = paint(null);
      for (let size = 1; size <= 3; size++) for (let x = 100; x < 110; x++) {
        const updated = paint(x,size);
        if (original.low !== updated.low || original.sharp === updated.sharp) continue;
        const pixels = async data => {
          const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode();
          context.drawImage(image,0,0); return context.getImageData(0,0,800,800).data;
        };
        const a = await pixels(original.sharp), b = await pixels(updated.sharp);
        return { low:original.low, sharp:original.sharp, updatedSharp:updated.sharp, differentPixels:a.some((value,index) => value !== b[index]),
          metadata:{deviceWidth:800,deviceHeight:800,pageScaleFactor:1,offsetTop:0,scrollOffsetX:0,scrollOffsetY:0} };
      }
      throw new Error('Chrome did not produce the reduced JPEG collision');
    });
    check('Chrome produces equal reduced JPEGs whose decoded sharp pixels differ', jpeg.differentPixels);
    const { checkScreencastSharp } = await import(pathToFileURL(path.join(repo, 'tests/lib/screencast-sharp.mjs')).href);
    const { createScreencastHub } = await import(hubSource ? 'data:text/javascript;base64,' + Buffer.from(hubSource).toString('base64') : pathToFileURL(path.join(repo, 'core/browser-screencast.mjs')).href);
    await checkScreencastSharp(createScreencastHub, {ok:check}, jpeg);
    await require('./screencast-sharp.cjs')({browser,check,createScreencastHub});
    const tabChecks = await page.evaluate(async () => {
      const {checkTabState} = await import('/tests/lib/tab-state.mjs');
      const {setupChromePanel, createWindowTable} = await import('/web/chrome-panel.mjs');
      const checks=[];
      await checkTabState(setupChromePanel, createWindowTable, {ok:(label,pass)=>checks.push({label,pass})});
      return checks;
    });
    for (const result of tabChecks) check(result.label, result.pass);
    check('flag off does not mount the new browser or its styles', await page.locator('.bu-chrome').count() === 0 && await page.locator('style[data-browser-unify]').count() === 0);
    await page.evaluate(() => enable());
    check('no permanent holder slot or activity dot', await page.locator('.bu-holder-slot,.bu-dot').count() === 0);
    check('browser components render without JavaScript errors', errors.length === 0, errors.join('; '));
    // Actual Chrome targets feed the same tab-info producer and rendered strip.
    const { createTabInfo } = await import(pathToFileURL(path.join(repo, 'core/chrome/tab-info.mjs')).href);
    const web = http.createServer(server.listeners('request')[0]);
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    const livePages = [], targets = new Map(), events = [], delivered = [];
    const info = createTabInfo({ emit(type,event) { events.push(event); delivered.push(page.evaluate(event => ui.onEvent({type:'tab:info',...event}), event)); } });
    info.setPagePorts({pages:server.address().port});
    const discovery = await browser.newBrowserCDPSession();
    discovery.on('Target.targetInfoChanged', ({targetInfo}) => {
      const tab = targets.get(targetInfo.targetId); if (tab) { tab.info=targetInfo; info.changed(tab); }
    });
    await discovery.send('Target.setDiscoverTargets', {discover:true});
    try {
      await page.evaluate(() => ui.onEvent({type:'tab:info',sessionId:'one',reset:true,tabs:[]}));
      for (const [index, url] of [`http://127.0.0.1:${web.address().port}/site-ai`,`http://127.0.0.1:${web.address().port}/site-human`,`http://localhost:${server.address().port}/_pleiad/s/one/file?path=D:/docs/file.md`].entries()) {
        const target = await browser.newPage(); livePages.push(target);
        const cdp = await target.context().newCDPSession(target);
        let ready; const connected = new Promise(resolve => { ready=resolve; });
        const targetInfo = (await cdp.send('Target.getTargetInfo')).targetInfo;
        const tab = {sessionId:'one',targetId:targetInfo.targetId,windowId:1,info:targetInfo,async attach(onEvent) {
          for (const method of ['Page.frameNavigated','Page.navigatedWithinDocument','Page.frameStartedLoading','Page.frameStoppedLoading']) cdp.on(method, params => onEvent(method,params));
          return {async send(method,params) { const result=await cdp.send(method,params); if(method==='Page.getFrameTree')setTimeout(ready,0); return result; },detach:()=>cdp.detach()};
        }};
        targets.set(tab.targetId,tab); info.added(tab); await connected;
        await target.goto(url);
        if (index === 0) await target.evaluate(() => document.title='Updated AI page');
        tab.info = (await cdp.send('Target.getTargetInfo')).targetInfo; info.changed(tab);
        if (index === 0) check('actual target title changes', await target.title() === 'Updated AI page', JSON.stringify({dom:await target.title(),info:tab.info.title}));
      }
      const deadline = Date.now()+10000;
      while (Date.now()<deadline && !(info.list('one').length===3 && info.list('one').filter(row=>row.favicon).length===2 && info.list('one').some(row=>row.title==='Updated AI page') && info.list('one').every(row=>!row.loading))) await new Promise(resolve=>setTimeout(resolve,25));
      await Promise.all(delivered);
      const live = info.list('one');
      check('real Chrome AI, human and file targets share one strip', live.length===3 && await page.locator('.bu-tab').count()===3 && live.some(row=>row.page?.kind==='file'));
      check('real Chrome title and favicon changes reach the strip', live.some(row=>row.title==='Updated AI page') && live.filter(row=>row.favicon).length===2, JSON.stringify(live.map(row=>({title:row.title,icon:!!row.favicon}))));
      check('real Chrome loading changes reach the strip', events.some(event=>event.loading===true) && live.every(row=>!row.loading));
      await shot('live-chrome-tabs');
    } finally {
      for (const tab of targets.values()) info.removed(tab);
      await Promise.all(delivered); await discovery.detach(); await Promise.all(livePages.map(target=>target.close()));
      await new Promise(resolve=>web.close(resolve));
    }
    // つなぎ直し: 見張りの登録（watchSession）が鍵の取り直し（pageOpen）より先に線へ出る。逆だと再発行が INVALID で落ちる
    await page.evaluate(() => ui.openTab({ sessionId:'one', kind:'file', path:'D:/docs/file.md' }));
    await page.evaluate(() => { window.sent.length = 0; chromeFixture.change?.({ type:'reconnected' }); });
    await page.waitForFunction(() => window.sent.some(c => c.command === 'pageOpen'), null, { timeout:5000 }).catch(() => {});
    const order = await page.evaluate(() => window.sent.map(c => c.command));
    check('reconnect re-registers the session watch before reissuing page keys',
      order.indexOf('watchSession') !== -1 && order.indexOf('pageOpen') !== -1 && order.indexOf('watchSession') < order.indexOf('pageOpen'), order.join(','));

    // ---- 人が触っているタブがある間の戻す入口（ADR 0296）: 見ているタブとは無関係に会話ごと
    const third = await page.evaluate(() => {
      ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third', url:'https://example.net/' });
      ui.onEvent({ type:'tab:holder', sessionId:'one', targetId:'web', holder:'human', by:'device' });
      chromeFixture.tabId='web2'; ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third again', url:'https://example.net/' });
      return document.querySelectorAll('.bu-tab').length;
    });
    check('badge shows 「AI に戻す」 while another tab is viewed (any tab of the conversation is human-held)',
      third === 3 && await page.locator('.b2-control').isVisible() && (await page.locator('.b2-control .b2-action').textContent()).includes('AI に戻す'));
    await page.evaluate(() => { window.sent.length = 0; });
    await page.locator('.b2-control .b2-action').click();
    check('badge resume sends chromeResume for the conversation', (await page.evaluate(() => window.sent)).some(c => c.command === 'chromeResume' && c.args.sessionId === 'one'));
    await page.evaluate(() => { chromeFixture.tabId='file'; ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'file', title:'file-preview.md' }); });
    check('local page keeps the badge hidden (no video to return to)', await page.locator('.b2-control').isHidden());
    await page.setViewportSize({ width:360, height:720 });
    await page.evaluate(() => ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third again' }));
    check('phone strip keeps 「AI に戻す」 while the right pane is closed',
      await page.locator('.bu-phone-strip').isVisible() && await page.locator('.b2-strip-resume').isVisible() && (await page.locator('.b2-strip-resume').textContent()).includes('AI に戻す'));
    await page.setViewportSize({ width:1280, height:720 });
    await page.evaluate(() => { ui.onEvent({ type:'tab:holder', sessionId:'one', targetId:'web', holder:'ai' }); ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third again' }); });
    check('badge goes away once no human tab remains', await page.locator('.b2-control').isHidden());
    await shot('handback-entries');
  } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
};
