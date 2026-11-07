const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function({browser,check,screenshots}) {
  const repo = path.resolve(__dirname,'../..');
  const fixture = `<!doctype html><html lang="ja" data-theme="light"><meta charset="utf-8">
<script type="importmap">{"imports":{"i18next":"/vendor/i18next.mjs"}}</script>
<link rel="stylesheet" href="/web/tokens.css"><link rel="stylesheet" href="/web/tree.css"><link rel="stylesheet" href="/web/pages/pages.css">
<style>body{margin:0;display:flex;height:100vh;background:var(--surface-paper);color:var(--ink);font:14px system-ui}#conversation{flex:1;padding:32px}#filePreview{width:820px;display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden}.file-preview-head,.file-preview-toolbar,.file-preview-resize,.file-preview-foot{display:none!important}.file-preview-body-layout,.file-preview-content{display:flex;flex:1;min-height:0;min-width:0}.file-preview-content[hidden],#filePreview[hidden],.file-preview-tree-pane[hidden]{display:none!important}.cp-screen{position:relative;overflow:hidden}.cp-screen>img,.cp-ghost,.cp-veil,.cp-empty,.cp-lag,.cp-stale,.cp-profile-slot,.cp-crop{display:none!important}.cp-slot{display:none}.i{width:18px;height:18px}#menu{position:fixed;z-index:99;background:var(--surface-paper);box-shadow:0 4px 16px var(--shadow);padding:6px;border-radius:8px}#menu button{display:block;padding:10px;background:none;border:0;color:inherit}#menu[hidden]{display:none}@media(max-width:600px){#conversation{display:none}#filePreview{width:100%}}</style>
<nav id="sidebar"></nav><main id="conversation"><h2>ファイルを確認</h2><p>計画と資料を開いています。</p><div id="composer"></div></main><div id="menu" hidden></div>
<script type="module">
import {createBrowserUnify} from '/web/browser-unify.mjs';
import {setupFilePreview} from '/web/file-preview.mjs';
import {setupChromePanel} from '/web/chrome-panel.mjs';
import {pageOpenFixture} from '/tests/lib/page-open-w1.mjs';
window.appState={current:'one',cwd:'D:/work'};window.sent=[]; window.errors=[]; window.current='one'; let panelOpen=false;
const cmd=async(command,args)=>{sent.push({command,args});if(command==='resolvePath')return {path:args.path,kind:args.path.endsWith('/docs')?'directory':'file'};if(command==='chromeNavigate')return {targetId:args.targetId??'chrome:'+sent.length};return {}};
window.preview=setupFilePreview({getContext:()=>({sessionId:current}),cmd,useFile(){},onLayout(){}});
window.cp=setupChromePanel({cmd,preview,session:()=>current});
window.ui=createBrowserUnify({cmd,state:appState,chrome:()=>cp,pageOpen:pageOpenFixture(location.origin.replace('127.0.0.1','localhost')),notify:e=>errors.push(e),confirm:()=>window.allowDiscard===true,composer:()=>document.querySelector('#composer'),
showMenu(x,y,items){const m=document.querySelector('#menu');m.hidden=false;m.style.left=Math.min(x,innerWidth-180)+'px';m.style.top=y+'px';m.replaceChildren(...items.filter(i=>!i.sep).map(i=>{const b=document.createElement('button');b.textContent=i.label;b.disabled=!!i.disabled;b.onclick=()=>{m.hidden=true;i.onClick?.()};return b}))}});
ui.capsChanged({browserUnify:{pages:Number(location.port)}});
window.openFile=path=>ui.openTab({sessionId:'one',kind:'file',path});
await openFile('D:/work/docs/plan.md'); window.ready=true;
</script>`;
  const pageContent = `<!doctype html><html lang="ja"><meta charset="utf-8"><link rel="stylesheet" href="/web/tokens.css"><style>body{margin:0;padding:32px 40px;color:var(--ink);background:var(--surface-paper);font:14px/1.8 system-ui}h1{font-size:24px}input{font:inherit;color:inherit;background:var(--surface-paper);border:1px solid var(--line);padding:8px}main{max-width:680px}li{padding:5px}html{height:100%}body{min-height:1300px} @media(max-width:600px){body{padding:20px}}</style><main><h1>ブラウザーをひとつに</h1><p>ファイル・フォルダー・可視化を、会話の右側で確認できます。</p><h2>ファイルを開く</h2><ul><li>左のツリーから資料を選ぶ</li><li>タブを切り替えて見比べる</li><li>変更が届いたら内容を確認する</li></ul><label>メモ <input aria-label="メモ"></label><p id="count"></p></main><script>window.loads=Date.now();addEventListener('message',e=>{if(e.data?.type==='pleiad:env')document.documentElement.dataset.theme=e.data.env.theme});</script><script type="module">import {installPageActivity} from "/web/pages/activity.mjs";installPageActivity();</script>`;
  const tree = [{id:'D:/work',name:'work',kind:'directory',children:[{id:'D:/work/docs',name:'docs',kind:'directory',open:true,children:[{id:'D:/work/docs/plan.md',name:'plan.md',kind:'file'},{id:'D:/work/docs/report.html',name:'report.html',kind:'file'},{id:'D:/work/docs/notes.md',name:'notes.md',kind:'file'}]},{id:'D:/work/src',name:'src',kind:'directory'}]}];
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://localhost'); let p=url.pathname;
    if(p.startsWith('/_pleiad/assets/'))p=p.replace('/_pleiad/assets/','/web/');
    if(p.endsWith('/api/env')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({theme:'dark',lang:'ja'}))}
    if(p.endsWith('/api/preview')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({path:url.searchParams.get('path'),name:'actual.md',kind:'markdown',size:100,fetchedAt:new Date().toISOString(),text:'# Actual file page\n\n[Related](./related.md)'}))}
    if(p==='/_pleiad/s/one/file' && url.searchParams.get('path')?.endsWith('actual.md')){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end((await fs.readFile(path.join(repo,'web/pages/index.html'),'utf8')).replace('<head>','<head><script type="importmap">{"imports":{"i18next":"/vendor/i18next.mjs"}}</script>'))}
    if(p==='/fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(fixture)}
    if(p==='/fixture-page'||p.startsWith('/_pleiad/')){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(pageContent)}
    if(p==='/file-preview'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({tree,children:[]}))}
    const file=p==='/vendor/i18next.mjs'?path.join(repo,'node_modules/i18next/dist/esm/i18next.js'):path.resolve(repo,'.'+p);
    if(!file.startsWith(path.join(repo,'web')+path.sep)&&p!=='/vendor/i18next.mjs'&&p!=='/tests/lib/page-open-w1.mjs'){res.writeHead(404);return res.end()}
    res.setHeader('Content-Type',p.endsWith('.css')?'text/css':p.endsWith('.json')?'application/json':'text/javascript');res.end(await fs.readFile(file));
  }catch(e){res.writeHead(500);res.end(e.message)}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shot=async name=>{if(screenshots){await fs.mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,`${name}.png`),animations:'allow'})}};
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    try{await page.waitForFunction(()=>window.ready,null,{timeout:12000})}catch(e){throw Error(errors.join(';')||e.message)}
    await page.frameLocator('.bu-local-page:not([hidden])').locator('h1').waitFor();
    await page.locator('.bu-explorer-list .tree-row').first().waitFor();
    check('opening a file without Chrome creates a page and no Chrome target',await page.evaluate(()=>sent.every(x=>x.command!=='chromeNavigate')));
    check('wide explorer is beside the page',await page.evaluate(()=>document.querySelector('.bu-explorer').getBoundingClientRect().right<=document.querySelector('.cp-screen').getBoundingClientRect().left+1));
    check('local page has no holder or activity dot',await page.locator('.b2-control:visible,.b2-chip,.bu-dot').count()===0);
    await shot('1280-light-tree');
    const tab=await page.evaluate(()=>ui.tabsOf('one')[0].targetId);
    await page.evaluate(()=>{window.kept=document.querySelector('.bu-local-page');window.kept.contentWindow.persist='kept'});
    await page.evaluate(()=>ui.display('chrome'));await page.evaluate(()=>ui.display('page'));await page.evaluate(()=>ui.display('chrome'));await page.evaluate(()=>ui.display('page'));
    check('display round trip preserves the same browsing context and reuses one Chrome target',await page.evaluate(()=>document.querySelector('.bu-local-page')===kept&&kept.contentWindow.persist==='kept'&&sent.filter(x=>x.command==='chromeNavigate'&&x.args.action==='new').length===1));
    await page.evaluate(()=>{preview.close();cp.open()});
    check('closing and reopening the real panel preserves the browsing context',await page.evaluate(()=>kept.contentWindow.persist==='kept'));
    await page.evaluate(()=>{preview.openPanel({key:'context',title:'Context',body:document.createElement('div')});cp.open()});
    check('switching another panel preserves the page context',await page.evaluate(()=>kept.contentWindow.persist==='kept'));
    await page.evaluate(()=>ui.onEvent({type:'page:changed',sessionId:'one',path:'D:/work/docs/plan.md'}));
    await page.waitForFunction(()=>!kept.contentWindow.persist);
    await page.evaluate(async()=>{kept.contentWindow.persist='session';preview.sessionChanged('two');current=appState.current='two';await ui.openTab({sessionId:'two',kind:'git'});preview.sessionChanged('one');current=appState.current='one';cp.open()});
    check('switching conversations keeps each page browsing context',await page.evaluate(()=>kept.contentWindow.persist==='session'&&!kept.hidden));
    check('untouched file reloads automatically',await page.locator('.bu-page-update').isHidden());
    await page.frameLocator('.bu-local-page:not([hidden])').locator('input').fill('保存前');
    await page.evaluate(()=>ui.onEvent({type:'page:changed',sessionId:'one',path:'D:/work/docs/plan.md'}));
    await page.locator('.bu-page-update').waitFor();await shot('1280-update');
    await page.locator('.bu-page-update').click();
    check('declining dirty refresh preserves the input',await page.frameLocator('.bu-local-page:not([hidden])').locator('input').inputValue()==='保存前');
    await page.evaluate(()=>window.allowDiscard=true);await page.locator('.bu-page-update').click();
    await page.waitForFunction(()=>kept.contentDocument?.querySelector('input')?.value==='');
    await page.locator('.bu-explorer-list').focus();await page.keyboard.press('ArrowDown');
    check('arrow navigation does not open a file',await page.evaluate(()=>ui.tabsOf('one').length===1));
    await page.locator('.bu-explorer-list .tree-row').filter({hasText:'notes.md'}).click();
    await page.waitForFunction(()=>ui.tabsOf('one')[0].page.path.endsWith('notes.md'));
    check('tree file click navigates the same local tab',await page.evaluate(()=>ui.tabsOf('one').length===1));
    await page.locator('.bu-explorer-list .tree-row').filter({hasText:'plan.md'}).click({modifiers:['Control']});
    check('Control click opens a second page tab',await page.evaluate(()=>ui.tabsOf('one').length===2));
    await page.locator('.bu-explorer-list .tree-row').filter({hasText:'notes.md'}).click({button:'middle'});
    check('already open file is focused without duplication',await page.evaluate(()=>ui.tabsOf('one').length===2));
    await page.locator('.bu-explorer-head button').nth(1).click();
    check('collapse all folds the top-level folders',await page.locator('.bu-explorer-list .tree-row').count()===2);
    await page.locator('.bu-explorer-head button').nth(0).click();
    await page.locator('.bu-tree-resize').focus();await page.keyboard.press('ArrowRight');
    check('separator keyboard changes width by 16',await page.locator('.bu-tree-resize').getAttribute('aria-valuenow')==='224');
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';ui.envChanged({theme:'dark'})});await page.frameLocator('.bu-local-page:not([hidden])').locator('html[data-theme=dark]').waitFor();await shot('1280-dark-tree');
    await page.setViewportSize({width:360,height:800});await page.evaluate(()=>{document.documentElement.dataset.theme='light';ui.envChanged({theme:'light'})});
    await page.waitForFunction(()=>document.querySelector('.bu-explorer').hidden);
    await shot('360-light');await page.locator('.bu-tree').click();await shot('360-tree');
    await page.locator('.bu-tree').click();check('tree toggle closes its overlay',await page.locator('.bu-explorer').isHidden());await page.locator('.bu-tree').click();
    check('360px explorer is 280px wide over the full-width page without overflow',await page.evaluate(()=>document.querySelector('.bu-explorer').getBoundingClientRect().width===280&&document.querySelector('.cp-screen').clientWidth===360&&document.documentElement.scrollWidth===360));
    await page.keyboard.press('Escape');check('Escape closes only the narrow explorer',await page.locator('.bu-explorer').isHidden()&&await page.locator('#filePreview').isVisible());
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';ui.envChanged({theme:'dark'})});await page.frameLocator('.bu-local-page:not([hidden])').locator('html[data-theme=dark]').waitFor();await shot('360-dark');
    await page.setViewportSize({width:1280,height:900});await page.locator('.bu-tree-resize').waitFor();
    check('returning to a wide pane restores the saved tree width',await page.locator('.bu-tree-resize').getAttribute('aria-valuenow')==='224');
    await page.setViewportSize({width:360,height:800});await page.locator('.bu-explorer').waitFor({state:'hidden'});
    await page.evaluate(()=>openFile('D:/work/docs/report.html'));await page.frameLocator('.bu-local-page:not([hidden])').locator('h1').waitFor();
    check('HTML shows its path and file icon rather than its internal URL',(await page.locator('.bu-crumbs').innerText()).endsWith('report.html')&&await page.locator('.bu-display').innerText()==='ページ ⌄');
    await page.frameLocator('.bu-local-page:not([hidden])').locator('input').fill('隔離ページの入力');
    await page.waitForFunction(()=>ui.tabsOf('one').at(-1).dirty);
    await page.evaluate(()=>ui.onEvent({type:'page:changed',sessionId:'one',path:'D:/work/docs/report.html'}));
    check('isolated HTML bridge reports input and defers refresh',await page.locator('.bu-page-update').isVisible());
    await page.evaluate(()=>ui.display('chrome'));
    check('HTML Chrome display uses the URL returned by pageOpen',await page.evaluate(()=>sent.filter(x=>x.command==='chromeNavigate').at(-1).args.input===ui.tabsOf('one').at(-1).url));
    await page.evaluate(()=>ui.display('page'));
    const beforeMove=await page.frameLocator('.bu-local-page:not([hidden])').locator('input').inputValue();
    const moved=await page.evaluate(()=>{const port=Number(location.port);ui.onEvent({type:'page:moved',sessionId:'one',previous:{pages:[port],isolated:[]},ports:{pages:port}});return ui.tabsOf('one').at(-1).pending});
    check('dirty moved page keeps the old document until accepted',moved===true&&await page.frameLocator('.bu-local-page:not([hidden])').locator('input').inputValue()===beforeMove);
    await page.locator('.bu-page-update').click();
    await page.frameLocator('.bu-local-page:not([hidden])').locator('input').waitFor();
    await page.waitForFunction(()=>document.querySelector('.bu-local-page:not([hidden])').contentDocument?.querySelector('input')?.value==='');
    await page.evaluate(()=>ui.openTab({sessionId:'one',kind:'git'}));await page.evaluate(()=>ui.display('chrome'));
    check('git Chrome display uses the pages origin',await page.evaluate(()=>sent.filter(x=>x.command==='chromeNavigate').at(-1).args.input===location.origin.replace('127.0.0.1','localhost')+'/_pleiad/s/one/git'));
    await page.evaluate(()=>ui.display('page'));
    await page.evaluate(()=>ui.onEvent({type:'tab:info',sessionId:'one',targetId:'remote-web',url:'https://example.com',title:'Example'}));
    await page.evaluate(()=>openFile('D:/work/last.md'));
    check('remote and local tabs retain opening order',await page.evaluate(()=>ui.tabsOf('one').slice(-2).map(t=>t.targetId==='remote-web'?'remote':'local').join(','))==='remote,local');
    await page.evaluate(()=>ui.onEvent({type:'tab:info',sessionId:'one',targetId:'ai-file',page:{kind:'file',path:'D:/work/ai.md'},url:location.origin+'/_pleiad/s/one/file?path=D:/work/ai.md'}));
    await page.evaluate(()=>ui.focusTab(ui.tabsOf('one').find(t=>t.targetId==='ai-file'),'one'));
    await page.evaluate(()=>ui.display('page'));await page.evaluate(()=>ui.navigate('navigate',{input:'D:/work/next.md'}));await page.evaluate(()=>ui.display('chrome'));
    check('AI page conversion navigates its reused Chrome target after a file change',await page.evaluate(()=>sent.filter(x=>x.command==='chromeNavigate').at(-1).args.targetId==='ai-file'&&sent.filter(x=>x.command==='chromeNavigate').at(-1).args.input==='D:/work/next.md'));
    await page.evaluate(()=>ui.display('page'));await page.evaluate(()=>ui.navigate('navigate',{input:'https://example.test/'}));
    check('navigating a local page to the web selects the Chrome tab',await page.evaluate(()=>!ui.tabsOf('one').find(t=>t.targetId==='ai-file').local&&document.querySelector('.bu-local-page:not([hidden])')===null));
    await page.evaluate(()=>openFile('D:/work/docs/actual.md'));
    await page.frameLocator('.bu-local-page:not([hidden])').locator('h1').filter({hasText:'Actual file page'}).waitFor();
    check('real file renderer has no nested tree and applies dark colors',await page.frameLocator('.bu-local-page:not([hidden])').locator('#tree').count()===0&&await page.frameLocator('.bu-local-page:not([hidden])').locator('html').getAttribute('data-theme')==='dark');
    await shot('360-dark-real-file');
    await page.frameLocator('.bu-local-page:not([hidden])').getByRole('link',{name:'Related',exact:true}).click();
    await page.waitForFunction(()=>sent.some(x=>x.command==='resolvePath'&&x.args.base==='D:/work/docs/actual.md'));
    check('real Markdown links resolve relative to the containing file',await page.evaluate(()=>sent.some(x=>x.command==='resolvePath'&&x.args.base==='D:/work/docs/actual.md'&&x.args.path==='./related.md')));
    check('no runtime errors',errors.length===0,errors.join(';'));
    check('no failed commands',await page.evaluate(()=>window.errors.length===0),await page.evaluate(()=>window.errors.join(';')));
  }finally{await page.close();await new Promise(r=>server.close(r))}
};
