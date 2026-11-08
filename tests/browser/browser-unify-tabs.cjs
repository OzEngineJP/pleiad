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
<header id="top"><button type="button" class="btn btn-icon" id="browserEntry" hidden><svg class="i" viewBox="0 0 24 24"></svg></button></header>
<aside id="panel"><div id="page"><aside id="tree" hidden></aside><main id="content"></main></div></aside><div id="menu" hidden></div>
<script type="module">
import { createBrowserUnify } from '/web/browser-unify.mjs';
import { setupBrowserEntry } from '/web/header-entries.mjs';
import { createTabHolderStore } from '/web/chrome-control.mjs';
import { createWindowTable } from '/web/chrome-panel.mjs';
import { renderFile } from '/web/pages/file.mjs';
window.sent=[]; window.notices=[]; window.pageRequests=[];
window.filePath='D:/dev/pleiad/docs/file-preview.md';
window.rows=[{sessionId:'one',targetId:'file',windowId:1,title:'file-preview.md',url:'http://localhost/_pleiad/s/one/file?path='+encodeURIComponent(filePath),page:{kind:'file',path:filePath},canGoBack:true},{sessionId:'one',targetId:'web',windowId:1,title:'GitHub · Pleiad',url:'https://github.com/tekalu1/pleiad',favicon:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="gray"/></svg>')}];
window.holderStore=createTabHolderStore();
window.windowTable=createWindowTable();
window.convRows=[];
window.waitingIds=new Set(); window.deviceOpIds=new Set();
window.chromeFixture={sessionId:'one',tabId:'file',opened:false,pins:[],scState:null,isOpen(){return this.opened},open(el,opts={}){this.opened=true;(this.opens??=[]).push(opts.target??null);if(opts.target)this.sessionId=opts.target},async pinTab(id,pin){this.pins.push({sessionId:id,...pin});sent.push({command:'chromePinWindow',args:{sessionId:id,...pin}});if(window.delayPin)await new Promise((resolve,reject)=>{window.finishPin=resolve;window.failPin=reject});if(pin.tabId)chromeFixture.tabId=pin.tabId;chromeFixture.change?.({type:'state'})},cancelTabPin(){this.pins.push({cancelled:true});sent.push({command:'chromePinWindow',args:{sessionId:this.sessionId,windowId:null,tabId:null}})},get screencastState(){return this.scState},get hold(){return null},mountBrowserChrome(root){document.querySelector('#panel').prepend(root)},onOpenChange(fn){this.openChange=fn},onTargetChange(){},onTabChange(fn){this.change=fn},close(){window.closedPanel=true;this.opened=false}};
window.ui=createBrowserUnify({state:{current:'one',cwd:'D:/dev/pleiad'},chrome:()=>chromeFixture,controlStore:{get:id=>({state:(window.agentStates?.[id])??window.agentState??'idle',by:window.agentBy??null})},holderStore,onTabsChange:()=>window.entry?.paint(),osActions:()=>window.hostScreen===true,notify:text=>notices.push(text),onPageRequest:(request,where)=>{pageRequests.push({request,where});return true},
  windows:windowTable,conversations:()=>window.convRows,waiting:id=>window.waitingIds.has(id),deviceOperating:id=>window.deviceOpIds.has(id),agentName:()=>'Claude',
async cmd(command,args){sent.push({command,args});if(command==='chromeAddress')return {suggestions:args.input.includes('missing')?[]:[{path:filePath}]};if(command==='chromeNavigate'&&args.input?.includes('missing'))throw {code:'not-found'};if(command==='chromePinWindow'){if(window.delayPin)await new Promise((resolve,reject)=>{window.finishPin=resolve;window.failPin=reject});chromeFixture.tabId=args.tabId;chromeFixture.change?.({type:'state'})}if(command==='pageOpen')return {kind:args.kind==='dir'?'dir':'file',url:'/site/'+encodeURIComponent(args.path??'page'),path:args.path};return {}},
showMenu(x,y,items){const menu=document.querySelector('#menu');menu.hidden=false;menu.style.left=Math.min(x,innerWidth-180)+'px';menu.style.top=y+'px';menu.replaceChildren(...items.filter(i=>!i.sep).map(item=>{const b=document.createElement('button');if(item.icon)b.append(item.icon.cloneNode(true));b.append(document.createTextNode(item.label));b.disabled=!!item.disabled;b.onclick=()=>{menu.hidden=true;item.onClick()};return b}))}});
window.resetRows=()=>ui.onEvent({type:'tab:info',sessionId:'one',reset:true,tabs:rows});resetRows();
window.enable=()=>ui.capsChanged({browserUnify:true});
// 頭の行の入口（web/header-entries.mjs と本物と同じ配線。スマホの [N] は openEntry → browser-unify の openEntry）
window.entry=setupBrowserEntry({button:document.querySelector('#browserEntry'),chrome:()=>chromeFixture,windows:{has:()=>false,operating:()=>window.agentOperating===true},getSessionId:()=>'one',chromeAvailable:()=>true,getChromeState:()=>window.agentState||'idle',humanHeld:id=>holderStore.anyHuman(id),mobile:()=>matchMedia('(max-width:600px)').matches,tabs:id=>ui.tabsOf(id),openEntry:id=>ui.openEntry(id)});
holderStore.onChange(()=>window.entry?.paint());
matchMedia('(max-width:600px)').addEventListener('change',()=>window.entry?.paint());
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
    await page.evaluate(async () => { window.openedPageTab = await ui.openTab({ sessionId:'one', kind:'file', path:'D:/docs/file.md' }); });
    await page.evaluate(() => { window.sent.length = 0; chromeFixture.change?.({ type:'reconnected' }); });
    await page.waitForFunction(() => window.sent.some(c => c.command === 'pageOpen'), null, { timeout:5000 }).catch(() => {});
    const order = await page.evaluate(() => window.sent.map(c => c.command));
    check('reconnect re-registers the session watch before reissuing page keys',
      order.indexOf('watchSession') !== -1 && order.indexOf('pageOpen') !== -1 && order.indexOf('watchSession') < order.indexOf('pageOpen'), order.join(','));

    // ---- 人が触っているタブがある間の戻す入口（ADR 0296）: 見ているタブとは無関係に会話ごと
    const third = await page.evaluate(async () => {
      resetRows();   // 実機 Chrome の確認で棚を空にしたので、file・web の 2 枚を戻す（計: ファイルのページ + 3 枚）
      ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third', url:'https://example.net/' });
      ui.onEvent({ type:'tab:holder', sessionId:'one', targetId:'web', holder:'human', by:'device' });
      // web2 を見る（ファイルのページを開いている選択を映像のタブへ切り替える）
      await ui.focusTab({ targetId:'web2' }, 'one');
      return document.querySelectorAll('.bu-tab').length;
    });
    check('badge shows 「AI に戻す」 while another tab is viewed (any tab of the conversation is human-held)',
      third === 4 && await page.locator('.b2-control').isVisible() && (await page.locator('.b2-control .b2-action').textContent()).includes('AI に戻す'),
      `tabs=${third} visible=${await page.locator('.b2-control').isVisible()} action=${await page.locator('.b2-control .b2-action').textContent()}`);
    await page.evaluate(() => { window.sent.length = 0; });
    await page.locator('.b2-control .b2-action').click();
    check('badge resume sends chromeResume for the conversation', (await page.evaluate(() => window.sent)).some(c => c.command === 'chromeResume' && c.args.sessionId === 'one'));
    await page.evaluate(() => ui.focusTab(window.openedPageTab, 'one'));
    check('the conversation badge stays visible on a local page while another tab is human-held', await page.locator('.b2-control').isVisible());
    await page.evaluate(() => { document.documentElement.dataset.theme='dark'; ui.envChanged({theme:'dark'}); });
    await shot('1280-dark-held-local');
    await page.setViewportSize({ width:360, height:720 });
    await page.evaluate(() => { chromeFixture.opened = false; ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third again' }); entry.paint(); });
    // スマホの頭の行の [N]（承認済み 2026-11-08）: 入力欄の上の帯はやめ、タブの数の四角が入口
    check('no browser strip above the composer', await page.locator('.bu-phone-strip,.b2-strip').count() === 0);
    check('the header shows the tab count as a square', await page.locator('#browserEntry').isVisible() && (await page.locator('#browserEntry .entry-tabn').textContent()) === '4',
      `entry=${await page.locator('#browserEntry').isVisible()} tabn=${await page.locator('#browserEntry .entry-tabn').textContent()} tabs=${await page.evaluate(() => ui.tabsOf('one').length)}`);
    check('the header count carries the paused mark while a human holds a tab', await page.locator('#browserEntry .entry-paused').count() === 1);
    check('the held row hides while a tab nobody holds is on screen', await page.locator('.b2-control').isHidden());
    await page.locator('#browserEntry').click();
    await page.waitForFunction(() => window.sent.some(c => c.command === 'chromePinWindow' && c.args?.tabId === 'web'), null, { timeout:3000 });
    check('the header count opens the human-held tab first', true);
    check('the held row shows II + 「あなたが操作中」 + 「AI に戻す」 under the address bar',
      await page.locator('.b2-control').isVisible() && await page.locator('.b2-control .b2-pause').count() === 1 && (await page.locator('.b2-control').textContent()).includes('あなたが操作中'));
    await page.evaluate(() => { document.documentElement.dataset.theme='light'; ui.envChanged({theme:'light'}); });
    const badges = await page.evaluate(() => ['#browserEntry .entry-tabn', '.bu-count'].map(selector => {
      const element = document.querySelector(selector), rect = element.querySelector('svg rect');
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { width:box.width, height:box.height, color:style.color, stroke:rect.getAttribute('stroke'), strokeWidth:rect.getAttribute('stroke-width'), radius:rect.getAttribute('rx') };
    }));
    check('phone header and address counts share 20px SVG badges and ink-weak color', badges.length === 2
      && badges.every(badge => badge.width === 20 && badge.height === 20 && badge.stroke === 'currentColor' && badge.strokeWidth === '1.7' && badge.radius === '4')
      && badges[0].color === badges[1].color, JSON.stringify(badges));
    await shot('360-light-tab-count');
    await page.evaluate(() => { document.documentElement.dataset.theme='dark'; ui.envChanged({theme:'dark'}); });
    await shot('360-dark-held-row');
    await page.evaluate(() => { window.sent.length = 0; });
    await page.locator('.b2-control .b2-action').click();
    check('the held row returns control to the AI', (await page.evaluate(() => window.sent)).some(c => c.command === 'chromeResume' && c.args.sessionId === 'one'));
    await page.evaluate(() => { ui.onEvent({ type:'tab:holder', sessionId:'one', targetId:'web', holder:'ai' }); });
    check('the row and the mark go away once no human tab remains', await page.locator('.b2-control').isHidden() && await page.locator('#browserEntry .entry-paused').count() === 0);
    await page.setViewportSize({ width:1280, height:720 });
    await page.evaluate(() => ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'web2', title:'Third again' }));
    check('badge goes away once no human tab remains', await page.locator('.b2-control').isHidden());
    await shot('handback-entries');

    // ---- 上の列（会話の題のチップ・窓の番号・追う）: 親から子の Chrome を会話を移らずに見る（8e2bd1ab^ 269-291 行）
    await page.evaluate(() => {
      chromeFixture.sessionId = 'one'; chromeFixture.opened = true; chromeFixture.pins = [];
      window.agentStates = { one:'running', 'one/child':'running' };
      windowTable.apply({ sessionId:'one', windows:2, windowIds:[1,2], currentWindowId:1, pinnedWindowId:null, operating:true });
      windowTable.apply({ sessionId:'one/child', windows:2, windowIds:[9,10], currentWindowId:9, pinnedWindowId:null, operating:true });
      window.convRows = [{ sessionId:'one/child', taskId:'t1', title:'子の作業', windows:2, state:'running', waiting:false }];
      ui.onEvent({ type:'tab:info', sessionId:'one/child', reset:true, tabs:[{ sessionId:'one/child', targetId:'c1', windowId:9, title:'Child tab', url:'https://child.example/' }] });
      ui.conversationsChanged();
    });
    check('the top row shows 「この会話」 plus a child conversation chip', await page.locator('.cp-sw[data-open]').count() === 1
      && await page.locator('.cp-sw-conv').count() === 2
      && (await page.locator('.cp-sw-conv').first().textContent()).includes('この会話')
      && (await page.locator('.cp-sw-conv').nth(1).textContent()).includes('子の作業'));
    check('numbered window chips mark the windows the agent is on', await page.locator('.cp-sw-chip:not(.cp-sw-conv)').count() === 4 && await page.locator('.cp-sw-chip[data-agent]').count() === 2);
    await page.locator('.cp-sw-conv').nth(1).click();
    await page.evaluate(() => ui.conversationsChanged());
    check('clicking the child chip retargets the panel without leaving the conversation', await page.evaluate(() => chromeFixture.sessionId === 'one/child' && chromeFixture.opens.at(-1) === 'one/child' && document.querySelectorAll('.cp-sw-conv')[1].hasAttribute('data-on')));
    check('the strip then shows the child tabs', await page.locator('.bu-tab').count() === 1 && (await page.locator('.bu-tab .bu-tab-title').textContent()).includes('Child tab'));
    await page.locator('.cp-sw-chip:not(.cp-sw-conv)').nth(3).click();
    check('clicking a window chip pins that child window', await page.evaluate(() => chromeFixture.pins.at(-1)?.sessionId === 'one/child' && chromeFixture.pins.at(-1)?.windowId === 10 && chromeFixture.pins.at(-1)?.tabId === null));
    await page.evaluate(() => { windowTable.apply({ sessionId:'one/child', windows:2, windowIds:[9,10], currentWindowId:9, pinnedWindowId:10, operating:true }); ui.conversationsChanged(); });
    await page.locator('.cp-sw-follow').click();
    check('「エージェントを追う」 releases the pin', await page.evaluate(() => chromeFixture.pins.at(-1)?.windowId === null && chromeFixture.pins.at(-1)?.tabId === null));
    await page.evaluate(() => { chromeFixture.scState = { agentTabId:'c1', tabId:'c1' }; ui.conversationsChanged(); });
    check('the tab the agent is on carries the running mark', await page.locator('.bu-tab .bu-agent').count() === 1);
    // 入口を押したとき（32 行）: 操作中なら Chrome のタブを開いて追う（固定を足さない）
    await page.evaluate(() => { chromeFixture.opened = false; chromeFixture.pins = []; });
    await page.evaluate(() => ui.openEntry('one'));
    check('opening the entry while the agent operates follows the agent (no pin)', await page.evaluate(() => chromeFixture.opened && chromeFixture.pins.length === 0));
    await shot('1280-light-conv-chips');
    await page.setViewportSize({ width:360, height:720 });
    await shot('360-light-conv-chips');
    await page.evaluate(() => { document.documentElement.dataset.theme='dark'; ui.envChanged({theme:'dark'}); });
    await shot('360-dark-conv-chips');
    await page.evaluate(() => { document.documentElement.dataset.theme='light'; ui.envChanged({theme:'light'}); });
    await page.setViewportSize({ width:1280, height:720 });
  } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
};
