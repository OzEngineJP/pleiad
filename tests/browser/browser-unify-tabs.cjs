// Isolated component browser test. Run through browser-unify-tabs with
// B1_BROWSER_TEST=1; no installed profile or user data is used.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

module.exports = async function browserUnifyTabs({ browser, check, screenshots, mockShots }) {
  const repo = path.resolve(__dirname, '../..');
  const sample = await fs.readFile(path.join(repo, 'docs/file-preview.md'), 'utf8');
  const fixture = String.raw`<!doctype html><html lang="ja" data-theme="light"><meta charset="utf-8">
<script type="importmap">{"imports":{"i18next":"/vendor/i18next.mjs"}}</script>
<link rel="stylesheet" href="/web/tokens.css"><link rel="stylesheet" href="/web/pages/pages.css"><link rel="stylesheet" href="/web/pages/content.css">
<style>body{display:flex;min-height:100vh;background:var(--surface-0)}#conversation{flex:1;min-width:0;padding:36px;font-size:14px}#panel{width:560px;flex:none;min-width:0;background:var(--surface-paper);height:100vh;display:flex;flex-direction:column;overflow:hidden}#page{overflow:auto;flex:1}#page main{padding:16px 28px}#page .metadata{font-size:11px}#tree{display:none}.i{width:18px;height:18px}#menu{position:fixed;z-index:50;background:var(--surface-paper);box-shadow:0 4px 16px var(--shadow);padding:6px;border-radius:8px}#menu button{display:block;width:100%;text-align:left}#menu[hidden]{display:none}@media(max-width:600px){#conversation{display:none}#panel{width:100%}#page main{padding:16px 20px}}</style>
<section id="conversation"><h3>ブラウザーの一本化</h3><p>確認のために、計画と実際のページを開いてください。</p></section>
<aside id="panel"><div id="page"><aside id="tree" hidden></aside><main id="content"></main></div></aside><div id="menu" hidden></div>
<script type="module">
import { createBrowserUnify } from '/web/browser-unify.mjs';
import { renderFile } from '/web/pages/file.mjs';
window.sent=[]; window.notices=[]; window.pageRequests=[];
window.filePath='D:/dev/pleiad/docs/file-preview.md';
window.rows=[{sessionId:'one',targetId:'file',windowId:1,title:'file-preview.md',url:'http://localhost/_pleiad/s/one/file?path='+encodeURIComponent(filePath),page:{kind:'file',path:filePath},canGoBack:true},{sessionId:'one',targetId:'web',windowId:1,title:'GitHub · Pleiad',url:'https://github.com/tekalu1/pleiad',favicon:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="gray"/></svg>')}];
window.chromeFixture={sessionId:'one',tabId:'file',mountBrowserChrome(root){document.querySelector('#panel').prepend(root)},onOpenChange(){},onTargetChange(){},onTabChange(fn){this.change=fn},close(){window.closedPanel=true}};
window.ui=createBrowserUnify({state:{current:'one',cwd:'D:/dev/pleiad'},chrome:()=>chromeFixture,osActions:()=>window.hostScreen===true,notify:text=>notices.push(text),onPageRequest:(request,where)=>{pageRequests.push({request,where});return true},
async cmd(command,args){sent.push({command,args});if(command==='chromeAddress')return {suggestions:args.input.includes('missing')?[]:[{path:filePath}]};if(command==='chromeNavigate'&&args.input?.includes('missing'))throw {code:'not-found'};if(command==='chromePinWindow'){chromeFixture.tabId=args.tabId;chromeFixture.change?.()}return {}},
showMenu(x,y,items){const menu=document.querySelector('#menu');menu.hidden=false;menu.style.left=Math.min(x,innerWidth-180)+'px';menu.style.top=y+'px';menu.replaceChildren(...items.filter(i=>!i.sep).map(item=>{const b=document.createElement('button');b.textContent=item.label;b.disabled=!!item.disabled;b.onclick=()=>{menu.hidden=true;item.onClick()};return b}))}});
window.resetRows=()=>ui.onEvent({type:'tab:info',sessionId:'one',reset:true,tabs:rows});resetRows();
window.enable=()=>ui.capsChanged({browserUnify:true});
await renderFile(document.querySelector('#content'),{name:'file-preview.md',path:filePath,kind:'markdown',fetchedAt:'2026-11-06T03:30:00Z',size:18022,text:__SAMPLE__});
window.ready=true;
</script></html>`.replace('__SAMPLE__', JSON.stringify(sample).replaceAll('<', '\\u003c'));
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
      if (pathname === '/favicon.ico') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64')); return; }
      if (pathname.startsWith('/site') || pathname.startsWith('/_pleiad/s/one/file')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>Live '+pathname+'</title><link rel="icon" href="/favicon.ico"><h1>Page</h1>'); return;
      }
      let file;
      if (pathname === '/vendor/i18next.mjs') file = path.join(repo, 'node_modules/i18next/dist/esm/i18next.js');
      else {
        file = path.resolve(repo, '.' + pathname);
        if (!file.startsWith(path.join(repo, 'web') + path.sep)) { res.writeHead(404); res.end(); return; }
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
    check('flag off does not mount the new browser or its styles', await page.locator('.bu-chrome').count() === 0 && await page.locator('style[data-browser-unify]').count() === 0);
    await page.evaluate(() => enable());
    await page.waitForFunction(() => document.querySelector('.bu-toolbar')?.clientWidth === 560);
    check('desktop tab strip is above the address bar', await page.evaluate(() => document.querySelector('.bu-tabs').getBoundingClientRect().bottom === document.querySelector('.bu-toolbar').getBoundingClientRect().top));
    check('B2 holder slot is inside the address bar', await page.locator('.bu-omni > [data-slot=tab-holder]').count() === 1);
    await shot('1280-light');
    await page.locator('.bu-separator:not([hidden])').first().click();
    check('desktop separator opens absolute-path editing', await page.locator('.bu-address-input').inputValue() === await page.evaluate(() => filePath)); await page.locator('.bu-address-input').press('Escape');
    await page.locator('.bu-crumb').filter({hasText:'docs'}).click();
    check('folder crumb navigates to its absolute folder', await page.evaluate(() => sent.at(-1).args.input === 'D:/dev/pleiad/docs'));
    await page.locator('.bu-crumb').filter({hasText:'docs'}).click({modifiers:['Control']});
    check('modified folder click opens a new tab', await page.evaluate(() => sent.at(-1).args.action === 'new' && sent.at(-1).args.input === 'D:/dev/pleiad/docs'));
    await page.locator('.bu-current').click(); await page.locator('.bu-address-input').fill('D:/dev/pleiad/docs/fi');
    await page.waitForSelector('.bu-suggestion'); await shot('suggestions');
    check('completion selects only the added suffix and highlights the typed prefix', await page.locator('.bu-address-input').evaluate(node => node.selectionEnd === node.value.length && node.selectionStart < node.selectionEnd) && await page.locator('.bu-suggestion strong').count() > 0);
    await page.locator('.bu-address-input').press('ArrowDown'); await page.locator('.bu-address-input').press('Enter');
    check('keyboard accepts a path suggestion', await page.evaluate(() => sent.at(-1).args.input === filePath));
    await page.locator('.bu-current').click(); await page.locator('.bu-address-input').fill('D:/missing.md'); await page.locator('.bu-address-input').press('Enter');
    await page.waitForSelector('.bu-address-error:not([hidden])');
    check('unreadable path shows a reason and keeps editing', await page.locator('.bu-address-error').isVisible() && await page.locator('.bu-address-input').isVisible());
    const rejectedCount = await page.evaluate(() => sent.length); await page.locator('.bu-address-input').press('Enter');
    check('a rejected unchanged path cannot be submitted again', await page.evaluate(() => sent.length) === rejectedCount);
    await shot('path-error'); await page.locator('.bu-address-input').press('Escape');
    await page.locator('.bu-views button').nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll('.bu-views button')[1].getAttribute('aria-pressed') === 'true');
    await page.locator('[data-target=web] .bu-tab-pick').click(); await page.locator('[data-target=file] .bu-tab-pick').click();
    check('source selection survives a tab round trip', await page.locator('.bu-views button').nth(1).getAttribute('aria-pressed') === 'true');
    await page.evaluate(() => { rows[0].url += '&view=source'; resetRows(); rows[0].url=rows[0].url.replace('&view=source','&view=preview'); resetRows(); });
    check('URL state after navigation replaces the cached view selection', await page.locator('.bu-views button').first().getAttribute('aria-pressed') === 'true');
    await page.evaluate(() => { rows[0].page.path=filePath.replace('.md','.png'); resetRows(); });
    check('images do not offer a meaningless source switch', !(await page.locator('.bu-views').isVisible()));
    await page.evaluate(() => { rows[0].page.path=filePath; resetRows(); document.activeElement?.blur(); });
    for (const width of [560,420,300]) {
      await page.locator('#panel').evaluate((node, value) => node.style.width=value+'px', width);
      await page.waitForFunction(value => document.querySelector('.bu-toolbar').clientWidth === value, width);
      check(`address bar stays within ${width}px`, await page.evaluate(() => document.querySelector('.bu-toolbar').scrollWidth === document.querySelector('.bu-toolbar').clientWidth));
      await shot(`narrow-${width}`);
    }
    await page.locator('#panel').evaluate(node => node.style.width='560px');
    await page.evaluate(() => { rows.push(...Array.from({length:12},(_,i)=>({...rows[1],targetId:'extra'+i,title:'Page '+i}))); resetRows(); });
    await page.waitForSelector('.bu-favicons');
    check('crowded tabs collapse to favicons', !(await page.locator('.bu-tab-title').first().isVisible())); await shot('many-tabs');
    await page.evaluate(() => { rows.splice(2); resetRows(); });
    await page.locator('[data-target=web] .bu-tab-pick').click();
    check('web tab shows the URL on desktop', await page.locator('.bu-crumbs').innerText() === 'https://github.com/tekalu1/pleiad');
    const menuLabels = () => page.locator('#menu button').allInnerTexts();
    await page.locator('[data-target=web] .bu-tab-pick').click({button:'right'});
    check('web tab right click offers reload and close, and no outside action off the host screen', JSON.stringify(await menuLabels()) === JSON.stringify(['再読み込み', 'タブを閉じる']));
    await page.locator('#menu button').filter({hasText:'再読み込み'}).click();
    check('tab right click reload targets that tab', await page.evaluate(() => sent.at(-1).args.action === 'reload' && sent.at(-1).args.targetId === 'web'));
    await page.evaluate(() => { window.hostScreen = true; window.opened = []; window.open = url => { opened.push(url); return null; }; });
    await page.locator('.bu-more').click();
    check('web tab menu offers opening the URL in the default browser on the host screen', (await menuLabels()).includes('既定のブラウザーで開く'));
    await page.locator('#menu').evaluate(node => { node.hidden = true; });
    await page.locator('[data-target=file] .bu-tab-pick').click({button:'right'});
    check('file tab right click keeps reload and close, with no web action', JSON.stringify((await menuLabels()).slice(-2)) === JSON.stringify(['再読み込み', 'タブを閉じる']) && !(await menuLabels()).includes('既定のブラウザーで開く'));
    await page.locator('#menu').evaluate(node => { node.hidden = true; }); await page.evaluate(() => { window.hostScreen = false; });
    await page.locator('[data-target=file] .bu-tab-pick').click();
    await page.setViewportSize({width:360,height:720}); await page.locator('#panel').evaluate(node => node.style.width='');
    await page.waitForFunction(() => document.querySelector('.bu-toolbar').classList.contains('bu-mobile'));
    check('phone has no tab row and retains its menu and tab count', !(await page.locator('.bu-tabs').isVisible()) && await page.locator('.bu-more').isVisible() && await page.locator('.bu-count').isVisible());
    check('phone address prioritizes the file name', (await page.locator('.bu-crumbs').innerText()).endsWith('file-preview.md'));
    await shot('360-light');
    await page.locator('.bu-omni').click({position:{x:90,y:17}}); await page.locator('.bu-address-input').fill('D:/editing.md'); await page.locator('.bu-address-input').click();
    check('clicking the phone input preserves edited text', await page.locator('.bu-address-input').inputValue() === 'D:/editing.md'); await page.locator('.bu-address-input').press('Escape');
    await page.locator('.bu-tree').click();
    check('phone tree button opens the tree, not path editing', await page.evaluate(() => sent.at(-1).args.action === 'tree') && !(await page.locator('.bu-address-input').isVisible()));
    for (const position of [{x:90,y:17},{x:180,y:17}]) {
      await page.locator('.bu-omni').click({position});
      check('phone address area enters text editing', await page.locator('.bu-address-input').isVisible()); await page.locator('.bu-address-input').press('Escape');
    }
    await page.evaluate(() => { chromeFixture.isOpen = () => true; chromeFixture.mountPage = node => { document.querySelector('[data-slot="page"]')?.remove(); if (node) { node.dataset.slot = 'page'; document.querySelector('#panel').append(node); } }; chromeFixture.change(); });
    const local = page.locator('#panel > iframe.bu-local-page');
    check('phone file tab renders the page locally from the same origin', await local.count() === 1 && await local.evaluate(node => new URL(node.src).origin === location.origin && new URL(node.src).pathname === '/_pleiad/s/one/file' && new URL(node.src).searchParams.get('path') === filePath));
    await page.waitForFunction(() => document.querySelector('iframe.bu-local-page')?.contentDocument?.querySelector('h1'));
    await local.evaluate(node => node.contentWindow.Function(`parent.postMessage({type:'pleiad:page-request',request:{type:'file-menu',sessionId:'one',path:${JSON.stringify(filePath)},kind:'file',x:5,y:6}},location.origin)`)());
    await page.waitForFunction(() => pageRequests.length === 1);
    check('local page requests reach the host menu with the tab and a screen point', await page.evaluate(() => { const { request, where } = pageRequests[0], box = document.querySelector('iframe.bu-local-page').getBoundingClientRect(); return request.type === 'file-menu' && where.targetId === 'file' && request.x === box.left + 5 && request.y === box.top + 6; }));
    await local.evaluate(node => node.contentWindow.Function(`parent.postMessage({type:'pleiad:page-request',request:{type:'file-menu',sessionId:'two',path:'x',kind:'file',x:1,y:1}},location.origin)`)());
    await page.waitForTimeout(100); check('local page requests for another conversation are ignored', await page.evaluate(() => pageRequests.length === 1));
    const before = await page.evaluate(() => sent.length); await page.locator('.bu-tree').click();
    check('phone tree on a local page stays on the device', await page.evaluate(n => !sent.slice(n).some(item => item.args?.action === 'tree'), before));
    await page.evaluate(() => { chromeFixture.tabId = 'web'; chromeFixture.change(); });
    check('web tabs stay as video on the phone', await local.count() === 0);
    await page.evaluate(() => { chromeFixture.tabId = 'file'; chromeFixture.isOpen = () => false; chromeFixture.change(); });
    check('closed panel shows no local page', await local.count() === 0);
    await page.locator('.bu-count').click(); check('phone tab overview shows two thumbnails', await page.locator('.bu-card').count() === 2 && await page.locator('.bu-card-label .bu-favicon').count() === 2 && await page.locator('.bu-overview-new').count() === 1); await shot('360-tabs'); await page.locator('.bu-count').click();
    await page.evaluate(() => document.documentElement.dataset.theme='dark'); await shot('360-dark');
    await page.setViewportSize({width:1280,height:720}); await shot('1280-dark');
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
    if (screenshots && mockShots) {
      const comparisons = [
        ['desktop', 'tobe-v6-pc-pc.png', 'b1-1280-light.png', 560, 650],
        ['phone', 'tobe-v6-phone-file-phone.png', 'b1-360-light.png', 360, 650],
        ['phone-dark', 'tobe-v6-phone-file-phone-dark.png', 'b1-360-dark.png', 360, 650],
        ...[560,420,300].map(width => [`narrow-${width}`, `tobe-v6-narrow-${width}-pc.png`, `b1-narrow-${width}.png`, width, 240]),
      ];
      for (const [name, reference, actual, width, height] of comparisons) {
        const [mock, implementation] = await Promise.all([fs.readFile(path.join(mockShots, reference)), fs.readFile(path.join(screenshots, actual))]);
        const html = `<!doctype html><meta charset="utf-8"><title>Browser comparison</title><style>body{margin:0;padding:16px;background:#e9e9ec;font:14px system-ui;display:flex;gap:16px}section{width:${width}px;flex:none}h2{font:inherit;margin:0 0 12px}div{height:${height}px;overflow:hidden;position:relative;background:white}img{position:absolute;right:0;top:0;max-width:none}</style>`
          + [['モック v6', mock], ['実装', implementation]].map(([label, data]) => `<section><h2>${label}</h2><div><img src="data:image/png;base64,${data.toString('base64')}"></div></section>`).join('');
        await fs.writeFile(path.join(screenshots, `b1-compare-${name}.html`), html);
        await page.setViewportSize({width:width*2+48,height:height+80}); await page.setContent(html);
        await page.screenshot({path:path.join(screenshots, `b1-compare-${name}.png`)});
      }
    }
  } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
};
