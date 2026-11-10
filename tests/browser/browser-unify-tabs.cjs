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
<link rel="stylesheet" href="/web/tokens.css"><link rel="stylesheet" href="/web/style.css"><link rel="stylesheet" href="/web/pages/pages.css"><link rel="stylesheet" href="/web/pages/content.css">
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
window.chromeFixture={sessionId:'one',tabId:'file',opened:false,pins:[],scState:null,isOpen(){return this.opened},open(el,opts={}){this.opened=true;(this.opens??=[]).push(opts.target??null);if(opts.target)this.sessionId=opts.target},async pinTab(id,pin){this.pins.push({sessionId:id,...pin});sent.push({command:'chromePinWindow',args:{sessionId:id,...pin}});if(window.delayPin)await new Promise((resolve,reject)=>{window.finishPin=resolve;window.failPin=reject});if(pin.tabId){this.tabId=pin.tabId;this.scState={...(this.scState||{}),tabId:pin.tabId}}this.change?.({type:'state'})},cancelTabPin(){this.cancelTabPinCalls=(this.cancelTabPinCalls??0)+1},get screencastState(){return this.scState},get hold(){return null},workspaceEl:null,get workspace(){return this.workspaceEl},mountBrowserChrome(root){let p=document.querySelector('#buPanel');if(!p){p=document.createElement('div');p.className='cp bu-panel';const s=document.createElement('div');s.className='cp-screen';p.append(root,s);document.querySelector('#panel').prepend(p);this.workspaceEl=p}else if(root.parentElement!==p)p.prepend(root)},onOpenChange(fn){this.openChange=fn},onTargetChange(){},onTabChange(fn){this.change=fn},close(){window.closedPanel=true;this.opened=false}};
window.st={current:'one',cwd:'D:/dev/pleiad'};
window.ui=createBrowserUnify({state:window.st,chrome:()=>chromeFixture,controlStore:{get:id=>({state:(window.agentStates?.[id])??window.agentState??'idle',by:window.agentBy??null})},holderStore,onTabsChange:()=>window.entry?.paint(),osActions:()=>window.hostScreen===true,notify:text=>notices.push(text),onPageRequest:(request,where)=>{pageRequests.push({request,where});return true},
  windows:windowTable,conversations:()=>window.convRows,waiting:id=>window.waitingIds.has(id),deviceOperating:id=>window.deviceOpIds.has(id),agentName:()=>'Claude',
async cmd(command,args){sent.push({command,args});if(command==='chromeAddress')return {suggestions:args.input.includes('missing')?[]:[{path:filePath}]};if(command==='chromeNavigate'&&args.input?.includes('missing'))throw {code:'not-found'};if(command==='chromePinWindow'){if(window.delayPin)await new Promise((resolve,reject)=>{window.finishPin=resolve;window.failPin=reject});if(args.tabId){chromeFixture.tabId=args.tabId;chromeFixture.scState={...(chromeFixture.scState||{}),tabId:args.tabId}}chromeFixture.change?.({type:'state'})}if(command==='pageOpen')return {kind:args.kind==='dir'?'dir':'file',url:'/site/'+encodeURIComponent(args.path??'page'),path:args.path};return {}},
showMenu(x,y,items){const menu=document.querySelector('#menu');menu.hidden=false;menu.style.left=Math.min(x,innerWidth-180)+'px';menu.style.top=y+'px';menu.replaceChildren(...items.filter(i=>!i.sep).map(item=>{const b=document.createElement('button');if(item.icon)b.append(item.icon.cloneNode(true));b.append(document.createTextNode(item.label));b.disabled=!!item.disabled;b.onclick=()=>{menu.hidden=true;item.onClick()};return b}))}});
window.resetRows=()=>ui.onEvent({type:'tab:info',sessionId:'one',reset:true,tabs:rows});resetRows();
window.enable=()=>ui.capsChanged({browserUnify:true});
// 頭の行の入口（web/header-entries.mjs と本物と同じ配線。スマホの [N] は openEntry → browser-unify の openEntry）
window.entry=setupBrowserEntry({button:document.querySelector('#browserEntry'),chrome:()=>chromeFixture,windows:{has:()=>false,operating:()=>window.agentOperating===true},getSessionId:()=>window.entrySid||'one',chromeAvailable:()=>true,getChromeState:()=>window.agentState||'idle',humanHeld:id=>holderStore.anyHuman(id),mobile:()=>matchMedia('(max-width:600px)').matches,tabs:id=>ui.tabsOf(id),openEntry:id=>ui.openEntry(id)});
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
      if (pathname === '/file-preview') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tree:[{ name:'pleiad', kind:'directory', id:'D:/dev/pleiad', children:[{ name:'docs', kind:'directory', id:'D:/dev/pleiad/docs' }] }] })); return; }
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

    // ---- 上の行: 会話の切替はタブの列の左端の共有 combo（窓番号・「エージェントを追う」は無い。承認済み 2026-11-08）
    await page.evaluate(() => {
      chromeFixture.sessionId = 'one'; chromeFixture.opened = true; chromeFixture.pins = [];
      window.agentStates = { one:'running', 'one/child':'running' };
      windowTable.apply({ sessionId:'one', windows:2, windowIds:[1,2], currentWindowId:1, pinnedWindowId:null, operating:true });
      windowTable.apply({ sessionId:'one/child', windows:2, windowIds:[9,10], currentWindowId:9, pinnedWindowId:null, operating:true });
      window.convRows = [{ sessionId:'one/child', taskId:'t1', title:'子の作業', windows:2, state:'running', waiting:false }];
      ui.onEvent({ type:'tab:info', sessionId:'one/child', reset:true, tabs:[{ sessionId:'one/child', targetId:'c1', windowId:9, title:'Child tab', url:'https://child.example/' }] });
      ui.conversationsChanged();
    });
    const convPick = value => page.evaluate(v => { const i = document.querySelector('.bu-tabrow > .bu-conv input'); i.focus(); i.value = v; i.blur(); }, value);
    check('the tab row leads with the conversation combo and keeps + fixed at the end (no window chips, no follow button)',
      await page.locator('.bu-tabrow > .bu-conv').count() === 1
      && (await page.locator('.bu-tabrow > .bu-conv input').inputValue()) === 'この会話'
      && await page.locator('.cp-sw,.cp-sw-follow,.cp-sw-chip').count() === 0
      && await page.locator('.bu-tabrow > .bu-new').count() === 1 && await page.locator('.bu-tabs .bu-new').count() === 0);
    await convPick('子の作業');
    await page.evaluate(() => ui.conversationsChanged());
    check('choosing the child in the combo retargets the panel without leaving the conversation', await page.evaluate(() => chromeFixture.sessionId === 'one/child' && chromeFixture.opens.at(-1) === 'one/child' && document.querySelector('.bu-tabrow > .bu-conv input').value === '子の作業'));
    check('the strip then shows only the child tabs (parent tabs are not mixed)', await page.locator('.bu-tab').count() === 1 && (await page.locator('.bu-tab .bu-tab-title').textContent()).includes('Child tab'));

    // ---- タブの列は会話の全ウィンドウのタブ。AI のタブを選ぶとエージェントを追う（pin 解除）
    const stripTitles = () => page.evaluate(() => [...document.querySelectorAll('.bu-tab .bu-tab-title')].map(el => el.textContent));
    await page.evaluate(() => {
      ui.onEvent({ type:'tab:info', sessionId:'one/child', reset:true, tabs:[
        { sessionId:'one/child', targetId:'w9a', windowId:9,  title:'W9 A',  url:'https://w9a.example/' },
        { sessionId:'one/child', targetId:'w9b', windowId:9,  title:'W9 B',  url:'https://w9b.example/' },
        { sessionId:'one/child', targetId:'w10a', windowId:10, title:'W10 A', url:'https://w10a.example/' },
      ]});
      ui.conversationsChanged();
    });
    check('the strip lists the tabs of every window of the conversation', (await stripTitles()).join(',') === 'W9 A,W9 B,W10 A');
    await page.evaluate(() => { chromeFixture.pins = []; });
    await page.locator('.bu-tab').nth(2).locator('.bu-tab-pick').click();
    check('clicking a tab pins that tab with its window', await page.evaluate(() => chromeFixture.pins.at(-1)?.sessionId === 'one/child' && chromeFixture.pins.at(-1)?.windowId === 10 && chromeFixture.pins.at(-1)?.tabId === 'w10a'));
    await page.evaluate(() => { chromeFixture.scState = { agentTabId:'w9a', tabId:'w10a' }; ui.conversationsChanged(); });
    check('the tab the agent is on carries the running arc (idle tabs carry no dot)', await page.locator('.bu-tab .bu-agent .run').count() === 1 && await page.locator('.cp-sw-dot').count() === 0);
    await page.locator('.bu-tab').nth(0).locator('.bu-tab-pick').click();
    check('clicking the agent tab follows the agent (pin released)', await page.evaluate(() => chromeFixture.pins.at(-1)?.windowId === null && chromeFixture.pins.at(-1)?.tabId === null));
    // 入口を押したとき（32 行）: 操作中なら Chrome のタブを開いて追う（固定を足さない）
    await page.evaluate(() => { chromeFixture.opened = false; chromeFixture.pins = []; });
    await page.evaluate(() => { ui.openEntry('one'); ui.conversationsChanged(); });
    check('opening the entry while the agent operates follows the agent (no pin)', await page.evaluate(() => chromeFixture.opened && chromeFixture.pins.length === 0));
    // 「この会話」はファイルのタブを残し、Chrome のタブはその会話の全ウィンドウのもの（子のタブは混ぜない）
    await page.evaluate(() => ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'w2a', windowId:2, title:'W2 A', url:'https://w2a.example/' }));
    const oneTitles = await stripTitles();
    check('this conversation keeps file tabs and shows all its Chrome tabs across windows', oneTitles.length === 5 && oneTitles.includes('W2 A') && !oneTitles.some(t => /^(W9|W10|Child)/.test(t)), oneTitles.join(','));
    await page.evaluate(() => ui.onEvent({ type:'tab:info', sessionId:'one', targetId:'w2a', removed:true }));

    // ---- スマホのタブ切替: 押した直後に選択＋読み込み線。古い返事・別ターゲットでは下ろさない
    await page.setViewportSize({ width:360, height:720 });
    await page.evaluate(() => {
      chromeFixture.opened = true; chromeFixture.sessionId = 'one'; chromeFixture.scState = { tabId:'file', agentTabId:'file' };
      window.delayPin = true; ui.conversationsChanged();
    });
    await page.locator('.bu-count').click();
    check('the phone tab list opens with a head row (close · conversation combo · +)', await page.locator('.bu-overview:not([hidden]) .bu-ov-head').count() === 1
      && await page.locator('.bu-ov-head .bu-conv').count() === 1 && await page.locator('.bu-ov-head .bu-icon').count() === 2);
    check('the list shows only this conversation\'s tabs', await page.evaluate(() => document.querySelectorAll('.bu-card').length === ui.tabsOf('one').length));
    await page.evaluate(() => { [...document.querySelectorAll('.bu-card')].find(el => el.textContent.includes('GitHub'))?.querySelector('.bu-card-pick')?.click(); });
    check('tapping a card selects it at once and shows the loading line under the bar', await page.evaluate(() => document.querySelector('.bu-overview').hidden === true && document.querySelector('.bu-load')?.hidden === false && chromeFixture.pins.at(-1)?.tabId === 'web'));
    await page.evaluate(() => { chromeFixture.scState = { tabId:'web', agentTabId:'file' }; chromeFixture.change?.({ type:'state' }); });
    check('a state update alone does not clear the loading line (the picture could still be stale)', await page.evaluate(() => document.querySelector('.bu-load')?.hidden === false));
    await page.evaluate(() => { chromeFixture.change?.({ type:'frame', tabId:'other' }); });
    check('a frame of another tab does not clear the loading line', await page.evaluate(() => document.querySelector('.bu-load')?.hidden === false));
    await page.evaluate(() => { window.finishPin?.(); chromeFixture.change?.({ type:'frame', tabId:'web' }); });
    await page.waitForFunction(() => document.querySelector('.bu-load')?.hidden === true, null, { timeout:3000 });
    check('the line clears once the picked tab\'s first frame arrives', true);
    // AI のタブを選んだ（follow = 固定解除）ときも、前の絵のフレームでは下ろさない（指摘: 古い A の残 frame で消えていた）
    await page.evaluate(() => { chromeFixture.scState = { tabId:'web', agentTabId:'web' }; ui.conversationsChanged(); });
    await page.locator('.bu-count').click();
    await page.locator('.bu-overview:not([hidden])').waitFor({ timeout:3000 });
    await page.evaluate(() => { [...document.querySelectorAll('.bu-card')].find(el => el.textContent.includes('GitHub'))?.querySelector('.bu-card-pick')?.click(); });
    check('following the agent tab still shows the loading line (pin released)', await page.evaluate(() => document.querySelector('.bu-load')?.hidden === false && chromeFixture.pins.at(-1)?.tabId === null));
    await page.evaluate(() => { chromeFixture.change?.({ type:'frame', tabId:'old' }); });
    check('a leftover frame of the previous tab does not clear the line while following', await page.evaluate(() => document.querySelector('.bu-load')?.hidden === false));
    await page.evaluate(() => { window.finishPin?.(); chromeFixture.change?.({ type:'frame', tabId:'web' }); });
    await page.waitForFunction(() => document.querySelector('.bu-load')?.hidden === true, null, { timeout:3000 });
    check('the line clears on the followed tab\'s first frame', true);
    // 一覧の会話 combo: カードの無い会話でも候補が下端で切れず、2 人目まで届く
    await page.evaluate(() => {
      window.convRows = [{ sessionId:'one/childA', taskId:'ta', title:'委譲の子 A', windows:1 }, { sessionId:'one/childB', taskId:'tb', title:'委譲の子 B', windows:1 }];
      chromeFixture.sessionId = 'one/childA'; chromeFixture.scState = null; window.delayPin = false;
      ui.conversationsChanged();
    });
    await page.locator('.bu-count').click();
    await page.locator('.bu-overview:not([hidden])').waitFor({ timeout:3000 });
    check('an empty conversation shows a short list', await page.evaluate(() => document.querySelectorAll('.bu-overview:not([hidden]) .bu-card').length === 0));
    await page.locator('.bu-ov-head .bu-conv input').click();
    await page.locator('.bu-ov-head .bu-conv .clist li', { hasText:'委譲の子 B' }).waitFor({ timeout:3000 });
    const secondHit = await page.evaluate(() => {
      const li = [...document.querySelectorAll('.bu-ov-head .bu-conv .clist li')].find(el => el.textContent.includes('委譲の子 B'));
      if (!li) return { found:false };
      const r = li.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
      return { found:true, rect:[r.left, r.top, r.width, r.height].join(','), point:[x, y].join(','),
        hit: hit ? `${hit.tagName}.${hit.className}` : 'null', ok: hit === li || li.contains(hit) };
    });
    check('the second conversation candidate is hittable below the head', secondHit?.ok === true, JSON.stringify(secondHit));
    await page.locator('.bu-ov-head .bu-conv .clist li', { hasText:'委譲の子 B' }).click();
    check('choosing the second candidate mirrors that conversation', await page.evaluate(() => chromeFixture.opens?.at(-1) === 'one/childB'));
    // 一覧は会話を替えても開いたままが正しいので、戻るボタンで閉じてから戻る
    await page.locator('.bu-ov-head .bu-icon').first().click();
    await page.evaluate(() => { chromeFixture.sessionId = 'one'; window.convRows = []; ui.conversationsChanged(); });
    await page.setViewportSize({ width:1280, height:720 });
    // 欄が閉じているまま会話が変わっても空のタブを足さない（前の仕様 32 行）。タブの数はスマホの [N] で出るので 360px で確かめる
    await page.setViewportSize({ width:360, height:720 });
    await page.evaluate(() => { chromeFixture.opened = false; window.st.current = 'two'; window.entrySid = 'two'; window.sent.length = 0; ui.sessionChanged('two'); });
    await page.evaluate(() => new Promise(r => setTimeout(r, 80)));
    check('a closed pane adds no empty tab when the conversation changes', !(await page.evaluate(() => window.sent.some(c => c.command === 'pageOpen'))) && (await page.evaluate(() => ui.tabsOf('two').length)) === 0,
      `sent=${JSON.stringify(await page.evaluate(() => window.sent.map(c => c.command)))} tabs=${await page.evaluate(() => ui.tabsOf('two').length)}`);
    await page.evaluate(() => window.entry.paint());
    check('the header count stays 0 for a conversation with no tabs', (await page.locator('#browserEntry .entry-tabn').textContent()) === '0');
    // 欄を開いていれば、watchSession の返事のあと空のタブが 1 つ立つ
    await page.evaluate(() => { chromeFixture.opened = true; ui.sessionChanged('two'); });
    await page.evaluate(() => new Promise(r => setTimeout(r, 80)));
    check('an open pane makes one empty tab when the conversation changes', (await page.evaluate(() => ui.tabsOf('two').length)) === 1 && (await page.locator('#browserEntry .entry-tabn').textContent()) === '1',
      `tabs=${await page.evaluate(() => ui.tabsOf('two').length)} tabn=${await page.locator('#browserEntry .entry-tabn').textContent()}`);
    await page.evaluate(() => { window.st.current = 'one'; window.entrySid = null; chromeFixture.sessionId = 'one'; chromeFixture.tabId = 'c1'; window.sent.length = 0; ui.sessionChanged('one'); window.entry.paint(); });
    await page.setViewportSize({ width:1280, height:720 });
    await shot('1280-light-conv-chips');
    await page.setViewportSize({ width:360, height:720 });
    await shot('360-light-conv-chips');
    await page.evaluate(() => { document.documentElement.dataset.theme='dark'; ui.envChanged({theme:'dark'}); });
    await shot('360-dark-conv-chips');
    await page.evaluate(() => { document.documentElement.dataset.theme='light'; ui.envChanged({theme:'light'}); });
    await page.setViewportSize({ width:1280, height:720 });

    // ---- ツリーは常にアドレスバーの下から始まり開閉のボタンは押せる・[N] はスマホのバーだけ（beta.34 の報告）
    const geom = () => page.evaluate(() => {
      const e = document.querySelector('.bu-explorer'), bar = document.querySelector('.bu-omni');
      const conv = document.querySelector('.bu-tabrow > .bu-conv'), count = document.querySelector('.bu-count');
      return { exists:!!e, hidden:e ? e.hidden : true, top:e ? e.getBoundingClientRect().top : -1,
        barBottom:bar ? bar.getBoundingClientRect().bottom : -1, convOpen:conv ? !conv.hidden : false,
        count:count ? getComputedStyle(count).display : 'absent' };
    });
    await page.evaluate(() => {
      window.st.current = 'one'; window.entrySid = 'one';
      window.agentStates = { one:'running', 'one/child':'running' };
      window.convRows = [{ sessionId:'one/child', taskId:'t1', title:'子の作業', windows:2, state:'running', waiting:false }];
      windowTable.apply({ sessionId:'one', windows:2, windowIds:[1,2], currentWindowId:1, pinnedWindowId:null, operating:true });
      windowTable.apply({ sessionId:'one/child', windows:2, windowIds:[9,10], currentWindowId:9, pinnedWindowId:null, operating:true });
      ui.onEvent({ type:'tab:info', sessionId:'one', reset:true, tabs:rows });
      chromeFixture.sessionId = 'one'; chromeFixture.tabId = 'file'; chromeFixture.scState = null; window.delayPin = false;
      document.querySelector('#panel').style.width = '720px';
      ui.conversationsChanged(); ui.openEntry('one');
    });
    await page.locator('.bu-tab[data-target="file"] .bu-tab-pick').click();
    // ツリーは既定で閉じる（覚えていない会話。docs/design-system.md「ファイルのツリーと更新」）
    await page.locator('.bu-tree').waitFor({ state:'visible', timeout:8000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 120)));
    check('the tree starts closed in a conversation that has not opened it', await page.evaluate(() => { const e = document.querySelector('.bu-explorer'); return !e || e.hidden; }));
    await page.locator('.bu-tree').click();
    await page.waitForSelector('.bu-explorer:not([hidden])', { timeout:8000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 120)));
    let g = await geom();
    check('with the conversation row the tree starts below the address bar', g.convOpen && g.exists && !g.hidden && g.top >= g.barBottom, JSON.stringify(g));
    await page.locator('.bu-tree').click();
    // 閉じる動き（ばね）が終わると隠れる
    check('the tree toggle in the address bar closes the explorer', await page.waitForFunction(() => document.querySelector('.bu-explorer').hidden, null, { timeout:3000 }).then(() => true, () => false));
    await page.locator('.bu-tree').click();
    await page.evaluate(() => new Promise(r => setTimeout(r, 120)));
    g = await geom();
    check('the tree toggle reopens the explorer below the address bar', !g.hidden && g.top >= g.barBottom, JSON.stringify(g));
    // 欄が狭いとき（ツリーが映像に重なる形）でも同じ境界
    await page.evaluate(() => { document.querySelector('#panel').style.width = '560px'; });
    await page.evaluate(() => new Promise(r => setTimeout(r, 150)));
    g = await geom();
    check('the narrow column turns the tree into an overlay', g.hidden, JSON.stringify(g));
    await page.locator('.bu-tree').click();
    await page.evaluate(() => new Promise(r => setTimeout(r, 150)));
    g = await geom();
    check('the overlay tree starts below the address bar', !g.hidden && g.top >= g.barBottom, JSON.stringify(g));
    // 会話の列が無いとき
    await page.evaluate(() => {
      window.convRows = [];
      windowTable.apply({ sessionId:'one/child', windows:0, windowIds:[] });
      windowTable.apply({ sessionId:'one', windows:1, windowIds:[1], currentWindowId:1, pinnedWindowId:null, operating:true });
      document.querySelector('#panel').style.width = '720px';
      ui.conversationsChanged();
    });
    await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
    g = await geom();
    check('without the conversation row the tree starts below the address bar', !g.convOpen && !g.hidden && g.top >= g.barBottom, JSON.stringify(g));
    check('no tab count badge in the address bar on PC', g.count === 'none', JSON.stringify(g));
    // 新しいタブには印を付けず、字の頭はほかのタブ・一覧の行とそろえる（docs/design-system.md「PC のタブとアドレスバー」）
    await page.evaluate(() => { ui.onEvent({ type:'tab:info', sessionId:'one', reset:true, tabs:[...rows, { sessionId:'one', targetId:'nt', windowId:1, title:'新しいタブ', url:'http://localhost/_pleiad/s/one/new', page:{ kind:'new' } }] }); });
    await page.locator('.bu-tab[data-target="nt"]').waitFor({ timeout:3000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
    const slotOf = (root, textSel) => { const icon = root.querySelector('.bu-favicon'), text = root.querySelector(textSel); return { tag:icon?.tagName, empty:!!icon && icon.childElementCount === 0, width:icon ? Math.round(icon.getBoundingClientRect().width) : 0, textLeft:text ? Math.round(text.getBoundingClientRect().left - root.getBoundingClientRect().left) : -1 }; };
    const stripMarks = await page.evaluate(src => { const slotOf = eval(src); const pick = id => document.querySelector(`.bu-tab[data-target="${id}"] .bu-tab-pick`); return { nt:slotOf(pick('nt'), '.bu-tab-title'), web:slotOf(pick('web'), '.bu-tab-title') }; }, String(slotOf));
    check('the new tab carries no mark in the strip and its title lines up with the other tabs',
      stripMarks.nt.tag === 'SPAN' && stripMarks.nt.empty && stripMarks.nt.width === 16 && stripMarks.nt.textLeft === stripMarks.web.textLeft && stripMarks.web.tag === 'IMG', JSON.stringify(stripMarks));
    check('the + button keeps its plus icon', await page.locator('.bu-tabrow > .bu-new svg path').count() === 1);
    await page.evaluate(() => { document.querySelector('#panel').style.width = '380px'; });
    await page.locator('.bu-list').waitFor({ state:'visible', timeout:3000 });
    await page.locator('.bu-list').click();
    await page.locator('.bu-alltabs li[role="option"]').first().waitFor({ timeout:3000 });
    const listMarks = await page.evaluate(src => { const slotOf = eval(src); const row = id => document.querySelector(`.bu-alltabs li[data-target="${id}"]`); return { nt:slotOf(row('nt'), '.t'), file:slotOf(row('file'), '.t') }; }, String(slotOf));
    check('the new tab carries no mark in the tab list and its text lines up with rows that have one',
      listMarks.nt.tag === 'SPAN' && listMarks.nt.empty && listMarks.nt.width === 16 && listMarks.nt.textLeft === listMarks.file.textLeft && listMarks.file.tag === 'svg', JSON.stringify(listMarks));
    await page.keyboard.press('Escape');
    await page.evaluate(() => { ui.onEvent({ type:'tab:info', sessionId:'one', reset:true, tabs:rows }); document.querySelector('#panel').style.width = '720px'; });
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    // スマホ: [N] は出る・重なるツリーもアドレスバーの下
    await page.setViewportSize({ width:360, height:720 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 150)));
    g = await geom();
    check('the tab count badge shows in the address bar on the phone', g.count === 'grid', JSON.stringify(g));
    if (g.hidden) { await page.locator('.bu-tree').click(); await page.evaluate(() => new Promise(r => setTimeout(r, 150))); }
    g = await geom();
    check('on the phone the tree overlay starts below the address bar', !g.hidden && g.top >= g.barBottom, JSON.stringify(g));
    await page.setViewportSize({ width:1280, height:720 });
  } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
};
