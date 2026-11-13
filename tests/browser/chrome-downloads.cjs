// 会話の Chrome のウィンドウのダウンロードの画面（docs/inapp-browser.md「ダウンロード」、ADR 9187）を、本物のブラウザーで確かめる。
// tests/unit/chrome-downloads-ui.mjs から B1_BROWSER_TEST=1 のときだけ呼ばれる。右の欄（web/browser-unify.mjs）だけを立て、
// サーバーの 'tab:downloads' の代わりに ui.onEvent へ直に渡す。利用者のプロフィールもデータも使わない。
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function chromeDownloads({ browser, check, screenshots }) {
  const repo = path.resolve(__dirname, '../..');
  const fixture = String.raw`<!doctype html><html lang="ja" data-theme="light"><meta charset="utf-8">
<script type="importmap">{"imports":{"i18next":"/vendor/i18next.mjs"}}</script>
<link rel="stylesheet" href="/web/tokens.css"><link rel="stylesheet" href="/web/style.css"><link rel="stylesheet" href="/web/chrome-panel.css"><link rel="stylesheet" href="/web/chrome-control.css">
<style>body{display:flex;min-height:100vh;margin:0;background:var(--surface-0)}#conversation{flex:1;min-width:0;padding:36px;font-size:14px}#panel{position:relative;width:560px;flex:none;min-width:0;background:var(--surface-paper);height:100vh;display:flex;flex-direction:column;overflow:hidden}.cp-screen{flex:1;min-height:0;background:var(--surface-1)}.i{width:18px;height:18px}@media(max-width:600px){#conversation{display:none}#panel{width:100%}}</style>
<section id="conversation"><p>レポートを落としてください。</p><div id="log"></div><button type="button" id="outside">外</button></section>
<aside id="panel"></aside>
<script type="module">
import { createBrowserUnify } from '/web/browser-unify.mjs';
import { createTabHolderStore } from '/web/chrome-control.mjs';
import { createWindowTable } from '/web/chrome-panel.mjs';
import { createContextMenu } from '/web/context-menu.mjs';
import { renderPresent } from '/web/render.mjs';
window.sent=[]; window.notices=[]; window.opened=[]; window.menus=[];
window.holderStore=createTabHolderStore();
window.rows=[{sessionId:'one',targetId:'web',windowId:1,title:'Reports',url:'https://example.com/reports'}];
window.chromeFixture={sessionId:'one',tabId:'web',opened:false,isOpen(){return this.opened},open(el,opts={}){this.opened=true;if(opts.target)this.sessionId=opts.target},async pinTab(){},cancelTabPin(){},get screencastState(){return null},get hold(){return null},workspaceEl:null,get workspace(){return this.workspaceEl},mountBrowserChrome(root){let p=document.querySelector('#buPanel');if(!p){p=document.createElement('div');p.id='buPanel';p.className='cp bu-panel';const s=document.createElement('div');s.className='cp-screen';p.append(root,s);document.querySelector('#panel').prepend(p);this.workspaceEl=p}else if(root.parentElement!==p)p.prepend(root)},onOpenChange(){},onTargetChange(){},onTabChange(){},close(){this.opened=false}};
window.st={current:'one',cwd:'D:/work'};
const contextMenu=createContextMenu();
window.cancelReply={stopped:true};
window.ui=createBrowserUnify({state:window.st,chrome:()=>chromeFixture,controlStore:{get:()=>({state:'idle',by:null})},holderStore,osActions:()=>false,notify:text=>notices.push(text),
  windows:createWindowTable(),conversations:()=>[],waiting:()=>false,deviceOperating:()=>false,agentName:()=>'Claude',
  // ファイルの入口の代役: 何で呼ばれたかを覚える。⋯ のメニューは本物のメニューで 1 項目だけ出す
  preview:{open:(ref,element)=>opened.push({ref,from:element?.className??''}),menu:(x,y,target)=>{menus.push({path:target.path,kind:target.kind,sessionId:target.sessionId??null});contextMenu.open(x,y,[{label:'パスをコピー',onClick(){}}],undefined,{opener:target.element})}},
  async cmd(command,args){sent.push({command,args});if(command==='invoke'&&args.op==='browser.cancelDownload'){if(window.cancelReply==='throw')throw new Error('x');return window.cancelReply}return {}},
  showMenu:(x,y,items,title,opts)=>contextMenu.open(x,y,items,title,opts)});
window.resetRows=()=>ui.onEvent({type:'tab:info',sessionId:'one',reset:true,tabs:rows});resetRows();
window.downloads=list=>ui.onEvent({type:'tab:downloads',sessionId:'one',downloads:list});
window.line=download=>{const row=renderPresent({type:'present',kind:'chromeDownload',by:'ai',chromeDownload:download});document.querySelector('#log').append(row);return row};
ui.capsChanged({browserUnify:true});
window.ready=true;
</script></html>`;
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const shot = async name => { if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `chrome-downloads-impl-${name}.png`), animations: 'allow' }); } };
  const MB = 1024 * 1024;
  const run = { id: 'g1', name: 'report-2026-10.zip', state: 'downloading', received: 20.2 * MB, total: 48.2 * MB, path: null, startedAt: 3, stoppable: true };
  const done = { ...run, state: 'completed', received: 48.2 * MB, path: 'D:\\work\\reports\\report-2026-10.zip', stoppable: false };
  const older = { id: 'g0', name: 'report-2026-09.zip', state: 'completed', received: 41 * MB, total: 41 * MB, path: 'D:\\work\\reports\\report-2026-09.zip', startedAt: 2, stoppable: false };
  const failed = { id: 'gf', name: 'report-2026-08.zip', state: 'failed', received: 1024, total: 30 * MB, path: null, startedAt: 1, stoppable: false };
  const feed = list => page.evaluate(list => downloads(list), list);
  const button = page.locator('.bu-toolbar .dl-btn'), pop = page.locator('.dl-pop'), sheet = page.locator('.dl-sheet');
  const state = () => page.evaluate(() => {
    const b = document.querySelector('.dl-btn'), shown = node => Boolean(node) && getComputedStyle(node).display !== 'none' && !node.hidden;
    return { button: shown(b), label: b.getAttribute('aria-label'), title: b.title, expanded: b.getAttribute('aria-expanded'), ring: shown(b.querySelector('.dl-ring')), dot: shown(b.querySelector('.dl-dot')),
      offset: Number(b.querySelector('.dl-ring .pg').getAttribute('stroke-dashoffset')), pop: shown(document.querySelector('.dl-pop')), sheet: shown(document.querySelector('.dl-sheet')),
      moreDot: shown(document.querySelector('.bu-more .dl-dot')), focus: document.activeElement?.className ?? '', focusLabel: document.activeElement?.getAttribute?.('aria-label') ?? '' };
  });
  const rowsOf = box => page.evaluate(box => [...document.querySelectorAll(`${box} .dl-row`)].map(row => ({ id: row.dataset.id, cls: row.className, name: row.querySelector('.dl-name').textContent, sub: row.querySelector('.dl-sub').textContent,
    main: !row.querySelector('.dl-main').disabled, buttons: [...row.querySelectorAll('.bu-icon')].map(b => b.getAttribute('aria-label')), bar: row.querySelector('.dl-bar>i')?.style.width ?? null })), box);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    try { await page.waitForFunction(() => window.ready, null, { timeout: 10000 }); }
    catch (error) { throw new Error(errors.join('; ') || error.message); }
    await page.locator('.bu-toolbar').waitFor();

    // ---- PC: 入口のボタン
    let s = await state();
    check('ダウンロードの無い会話では、入口のボタンを出さない', s.button === false && s.pop === false, JSON.stringify(s));
    await feed([run]);
    s = await state();
    check('進行中があると、⋮ の左にボタンが出て、輪と「ダウンロード（1 件が進行中）」', s.button && s.ring && !s.dot && s.label === 'ダウンロード（1 件が進行中）' && s.title === s.label, JSON.stringify(s));
    check('輪は進み具合（20.2 / 48.2）のぶんだけ描く', Math.abs(s.offset - 2 * Math.PI * 15 * (1 - 20.2 / 48.2)) < 0.1, String(s.offset));
    const order = await page.evaluate(() => [...document.querySelector('.bu-toolbar').children].map(node => node.className));
    check('ボタンは ⋮ のすぐ左', order.findIndex(c => c.includes('dl-btn')) === order.findIndex(c => c.includes('bu-more')) - 1, order.join(' | '));
    await shot('pc-running');

    // ---- PC: 一覧（進行中）
    await button.click();
    s = await state();
    let list = await rowsOf('.dl-pop');
    check('押すと一覧が開き、最初の押せるボタン（止める）へフォーカスが移る', s.pop && s.expanded === 'true' && s.focusLabel === 'ダウンロードを止める', JSON.stringify(s));
    check('進行中の行: 名前・「受け取った量 / 全体」・止めるボタン・棒', list.length === 1 && list[0].name === 'report-2026-10.zip' && list[0].sub === '20.2 MB / 48.2 MB' && list[0].main === false
      && list[0].buttons.join() === 'ダウンロードを止める' && list[0].bar === '42%' && list[0].cls.includes('is-run'), JSON.stringify(list));
    const place = await page.evaluate(() => { const p = document.querySelector('.dl-pop').getBoundingClientRect(), b = document.querySelector('.dl-btn').getBoundingClientRect(), bar = document.querySelector('.bu-toolbar').getBoundingClientRect(), panel = document.querySelector('#panel').getBoundingClientRect();
      return { below: p.top - bar.bottom, right: p.right - b.right, inside: p.left >= panel.left && p.right <= panel.right, width: p.width, role: document.querySelector('.dl-pop').getAttribute('role'), label: document.querySelector('.dl-pop').getAttribute('aria-label') }; });
    check('一覧はアドレスバーのすぐ下・ボタンの右端にそろえて、欄の中に出る（幅 320）', Math.abs(place.below - 4) < 1 && Math.abs(place.right) < 1 && place.inside && place.width === 320 && place.role === 'list' && place.label === 'ダウンロード', JSON.stringify(place));
    await shot('pc-list-running');
    // 進み具合だけの変化では行を作り直さない（フォーカスを保つ）
    await page.evaluate(() => { window.keptRow = document.querySelector('.dl-pop .dl-row'); });
    await feed([{ ...run, received: 30 * MB }]);
    list = await rowsOf('.dl-pop'); s = await state();
    check('進み具合が変わっても行はそのまま（字と棒だけ替わり、フォーカスは止めるボタンに残る）', await page.evaluate(() => window.keptRow === document.querySelector('.dl-pop .dl-row')) && list[0].sub === '30 MB / 48.2 MB' && list[0].bar === '62%' && s.focusLabel === 'ダウンロードを止める', JSON.stringify({ list, s }));
    // 止める
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => sent.some(entry => entry.command === 'invoke'));
    const stopSent = await page.evaluate(() => sent.filter(entry => entry.command === 'invoke'));
    check('止めるボタンは操作 browser.cancelDownload を会話と id を付けて送る', stopSent.length === 1 && stopSent[0].args.op === 'browser.cancelDownload' && stopSent[0].args.args.sessionId === 'one' && stopSent[0].args.args.id === 'g1', JSON.stringify(stopSent));
    check('止められたときは何も知らせない', (await page.evaluate(() => notices.length)) === 0);
    await page.evaluate(() => { window.cancelReply = { stopped: false }; });
    await page.locator('.dl-pop .dl-row .bu-icon').click();
    await page.waitForFunction(() => notices.length === 1);
    await page.evaluate(() => { window.cancelReply = 'throw'; });
    await page.locator('.dl-pop .dl-row .bu-icon').click();
    await page.waitForFunction(() => notices.length === 2);
    check('止められなかった・失敗したときは「操作できませんでした」と知らせる', (await page.evaluate(() => notices.join('|'))) === '操作できませんでした|操作できませんでした');

    // ---- PC: 終わった
    await feed([done, older, failed]);
    list = await rowsOf('.dl-pop'); s = await state();
    check('開いている間に終わると、行が完了の形に替わる（大きさ · 保存先のフォルダー・⋯）', list.length === 3 && list[0].sub === '48.2 MB · D:\\work\\reports' && list[0].main && list[0].buttons.join() === 'report-2026-10.zip の操作' && list[0].bar === null, JSON.stringify(list));
    check('失敗の行は「ダウンロードできませんでした」で、押せない', list[2].sub === 'ダウンロードできませんでした' && !list[2].main && list[2].buttons.length === 0 && list[2].cls.includes('bad'), JSON.stringify(list[2]));
    check('一覧を開いて見ている間は、輪も未確認の点も出ない・名前は「ダウンロード」', !s.ring && !s.dot && s.label === 'ダウンロード', JSON.stringify(s));
    check('フォーカスのあった行が作り直されても、フォーカスは一覧の中に残る（最初の押せるボタン）', s.focus.includes('dl-main') && await page.evaluate(() => document.querySelector('.dl-pop').contains(document.activeElement)), JSON.stringify(s));
    await shot('pc-list-done');
    // ⋯ のメニュー
    await page.locator('.dl-pop .dl-row').first().locator('.bu-icon').click();
    await page.locator('.pop.menu').waitFor();
    s = await state();
    check('⋯ はファイルの操作のメニューを、そのファイルのパスで開く（一覧は開いたまま）', s.pop && JSON.stringify(await page.evaluate(() => menus)) === JSON.stringify([{ path: 'D:\\work\\reports\\report-2026-10.zip', kind: 'file', sessionId: null }]), JSON.stringify(await page.evaluate(() => menus)));
    await shot('pc-list-row-menu');
    await page.keyboard.press('Escape');
    s = await state();
    check('メニューを Escape で閉じると、一覧は残り、フォーカスは ⋯ へ戻る', s.pop && (await page.locator('.pop.menu').count()) === 0 && s.focusLabel === 'report-2026-10.zip の操作', JSON.stringify(s));
    // キーボード: Escape で閉じてボタンへ戻る
    await page.keyboard.press('Escape');
    s = await state();
    check('Escape で一覧が閉じ、フォーカスは入口のボタンへ戻る', !s.pop && s.expanded === 'false' && s.focus.includes('dl-btn'), JSON.stringify(s));
    await page.keyboard.press('Enter');
    s = await state();
    check('キーボード（Enter）で開くと、最初の行へフォーカスが移る', s.pop && s.focus.includes('dl-main'), JSON.stringify(s));
    await page.keyboard.press('Enter');
    s = await state();
    check('完了の行を押すと、そのファイルを開いて一覧を閉じる', !s.pop && JSON.stringify(await page.evaluate(() => opened)) === JSON.stringify([{ ref: { path: 'D:\\work\\reports\\report-2026-10.zip', line: null }, from: 'dl-main' }]), JSON.stringify(await page.evaluate(() => opened)));
    // 外を押して閉じる
    await button.click();
    await page.locator('#outside').click();
    s = await state();
    check('一覧の外を押すと閉じる', !s.pop && s.expanded === 'false', JSON.stringify(s));
    await button.click(); await button.click();
    check('開いているときにボタンを押すと閉じる', !(await state()).pop);

    // ---- PC: 未確認の点
    await feed([run, older, failed]);   // 進行中に戻す（別の回のつもり）
    await feed([done, older, failed]);
    s = await state();
    check('閉じている間に終わると、ボタンに未確認の点が付く（輪は消える）', s.button && s.dot && !s.ring && s.label === 'ダウンロード', JSON.stringify(s));
    await shot('pc-done-unseen');
    await button.click();
    s = await state();
    check('一覧を開くと点が消える', s.pop && !s.dot, JSON.stringify(s));
    await page.keyboard.press('Escape');
    check('閉じた後も点は戻らない', !(await state()).dot);
    await page.evaluate(() => resetRows());
    s = await state();
    check('見始めた・つなぎ直した（reset）ら一覧を忘れ、ボタンも消える', !s.button, JSON.stringify(s));
    await feed([done, older]);
    s = await state();
    check('その後に届く最初の一覧の、もう終わっているものには点を付けない', s.button && !s.dot && !s.ring, JSON.stringify(s));
    await feed([]);
    check('一覧が空になったらボタンを隠す', !(await state()).button);
    // 別の会話の一覧は、今の会話のボタンに出さない
    await page.evaluate(run => ui.onEvent({ type: 'tab:downloads', sessionId: 'other', downloads: [run] }), run);
    check('ほかの会話のダウンロードでは、この会話のボタンは出ない', !(await state()).button);

    // ---- PC: 止められないもの（会話のプロフィールが CDP の既定でない間）は、止めるボタンを出さない
    await feed([run]);
    await button.click();
    await feed([{ ...run, stoppable: false }]);
    list = await rowsOf('.dl-pop'); s = await state();
    check('止められなくなった進行中の行からは、止めるボタンが消える（一覧は開いたまま・棒は残る）', s.pop && list[0].buttons.length === 0 && list[0].bar === '42%', JSON.stringify(list));
    check('押せるものが一覧に無くなったら、フォーカスは入口のボタンへ移す', s.focus.includes('dl-btn'), JSON.stringify(s));
    await page.keyboard.press('Enter');
    check('そのまま Enter で閉じられる', !(await state()).pop);

    // ---- ダーク
    await feed([run, older, failed]);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await button.click();
    await shot('pc-list-running-dark');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    // ---- 会話の 1 行
    const lines = await page.evaluate(() => {
      const a = line({ name: 'report-2026-10.zip', state: 'completed', size: 48.2 * 1024 * 1024, path: 'D:\\work\\reports\\report-2026-10.zip' });
      const b = line({ name: 'report-2026-08.zip', state: 'failed', size: 0, path: null });
      const c = line({ name: 'report-2026-10.zip', state: 'canceled', size: 0, path: null });
      const file = a.querySelector('button.cc-file');
      return { a: a.textContent, b: b.textContent, c: c.textContent, file: file?.textContent, path: file?.dataset.filePath, color: getComputedStyle(file).color, ink: getComputedStyle(a).color, icon: Boolean(a.querySelector('.cc-line-ic svg')), failedButton: Boolean(b.querySelector('button')) };
    });
    check('会話の 1 行: 完了・失敗・止めたの 3 つの文', lines.a === 'report-2026-10.zip をダウンロードしました · 48.2 MB' && lines.b === 'report-2026-08.zip をダウンロードできませんでした' && lines.c === 'report-2026-10.zip のダウンロードを止めました', JSON.stringify(lines));
    check('完了の行のファイル名は、パスを持つ押せるボタン（リンクの色）。失敗の行には無い', lines.file === 'report-2026-10.zip' && lines.path === 'D:\\work\\reports\\report-2026-10.zip' && lines.color !== lines.ink && lines.icon && !lines.failedButton, JSON.stringify(lines));
    await shot('pc-line');

    // ---- スマホ（360 幅）: ⋮ の点・メニューの「ダウンロード」・欄いっぱいの一覧
    await page.setViewportSize({ width: 360, height: 720 });
    await page.waitForFunction(() => document.querySelector('.bu-toolbar').classList.contains('bu-mobile'));
    s = await state();
    check('スマホではボタンを出さず、⋮ に点が付く（進行中）', !s.button && s.moreDot, JSON.stringify(s));
    await shot('phone-running');
    await page.locator('.bu-more').click();
    await page.locator('.pop.menu').waitFor();
    let menu = await page.evaluate(() => [...document.querySelectorAll('.pop.menu .li')].map(row => ({ text: row.firstChild?.nodeType === 3 ? row.textContent : [...row.childNodes].filter(n => !n.classList?.contains('hint')).map(n => n.textContent).join(''), hint: row.querySelector('.hint')?.textContent ?? null })));
    const item = menu.find(row => row.text.trim() === 'ダウンロード');
    check('⋮ のメニューに「ダウンロード」と、進行中の全体の割合（42%）', Boolean(item) && item.hint === '42%' && menu.findIndex(row => row === item) === menu.findIndex(row => row.text.trim() === '新しいタブ') + 1, JSON.stringify(menu));
    await shot('phone-menu');
    await page.locator('.pop.menu .li', { hasText: 'ダウンロード' }).click();
    await sheet.waitFor();
    s = await state();
    list = await rowsOf('.dl-sheet');
    const cover = await page.evaluate(() => { const sh = document.querySelector('.dl-sheet').getBoundingClientRect(), bar = document.querySelector('.bu-toolbar').getBoundingClientRect(), panel = document.querySelector('#buPanel').getBoundingClientRect(), close = document.querySelector('.dl-sheet-head .bu-icon').getBoundingClientRect(), stop = document.querySelector('.dl-sheet .dl-row .bu-icon').getBoundingClientRect();
      return { top: sh.top - bar.bottom, left: sh.left - panel.left, right: panel.right - sh.right, bottom: panel.bottom - sh.bottom, head: document.querySelector('.dl-sheet-head span').textContent, close: close.width, stop: stop.width, role: document.querySelector('.dl-sheet').getAttribute('role') }; });
    check('押すと一覧がアドレスバーの下を欄いっぱいに覆い、フォーカスは「閉じる」へ', s.sheet && !s.pop && s.focusLabel === '閉じる' && Math.abs(cover.top) < 1 && cover.left === 0 && cover.right === 0 && Math.abs(cover.bottom) < 1 && cover.head === 'ダウンロード', JSON.stringify({ s, cover }));
    check('スマホの一覧の行は同じ中身で、押す所は 44px', list.length === 3 && list[0].sub === '20.2 MB / 48.2 MB' && list[0].buttons.join() === 'ダウンロードを止める' && cover.close === 44 && cover.stop === 44, JSON.stringify({ list, cover }));
    check('一覧を開いている間は ⋮ の点を消す', !s.moreDot);
    await shot('phone-list-running');
    await feed([done, older, failed]);
    list = await rowsOf('.dl-sheet');
    check('スマホの一覧も、終わると行が完了の形に替わる', list[0].sub === '48.2 MB · D:\\work\\reports' && list[0].buttons.join() === 'report-2026-10.zip の操作', JSON.stringify(list));
    await shot('phone-list-done');
    await page.keyboard.press('Escape');
    s = await state();
    check('Escape で閉じ、フォーカスは ⋮ へ戻る。見終えたので点は付かない', !s.sheet && s.focus.includes('bu-more') && !s.moreDot, JSON.stringify(s));
    await page.locator('.bu-more').click();
    await page.locator('.pop.menu').waitFor();
    menu = await page.evaluate(() => [...document.querySelectorAll('.pop.menu .li')].map(row => ({ text: row.textContent, hint: row.querySelector('.hint')?.textContent ?? null })));
    check('進行中が無いときの「ダウンロード」には割合を出さない', menu.some(row => row.text.trim() === 'ダウンロード' && row.hint === null), JSON.stringify(menu));
    await page.locator('.pop.menu .li', { hasText: 'ダウンロード' }).click();
    await sheet.waitFor();
    await page.locator('.dl-sheet-head .bu-icon').click();
    check('「閉じる」で閉じる', !(await state()).sheet);
    await page.locator('.bu-more').click();
    await page.locator('.pop.menu .li', { hasText: 'ダウンロード' }).click();
    await sheet.waitFor();
    await page.locator('.dl-sheet .dl-main').first().click();
    s = await state();
    check('スマホでも完了の行を押すと、ファイルを開いて一覧を閉じる', !s.sheet && (await page.evaluate(() => opened.length)) === 2, JSON.stringify(s));
    // 閉じている間に終わったら ⋮ に点
    await feed([run, older]); await feed([done, older]);
    check('スマホで閉じている間に終わると、⋮ に未確認の点が付く', (await state()).moreDot);
    // 幅が PC に戻ったら、開いていたスマホの一覧は閉じる
    await page.locator('.bu-more').click();
    await page.locator('.pop.menu .li', { hasText: 'ダウンロード' }).click();
    await sheet.waitFor();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => !document.querySelector('.bu-toolbar').classList.contains('bu-mobile'));
    s = await state();
    check('幅が PC に戻ると、スマホの一覧は閉じてボタンに戻る', !s.sheet && s.button && !s.moreDot, JSON.stringify(s));
    check('JavaScript のエラーが出ていない', errors.length === 0, errors.join('; '));
  } finally { await page.close(); await new Promise(resolve => server.close(resolve)); }
};
