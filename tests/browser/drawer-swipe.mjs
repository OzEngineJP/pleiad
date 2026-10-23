// 実行: node tests/browser/drawer-swipe.mjs（PW_CORE・PW_CHROMIUMでブラウザーを指定できる）。
// 一時のデータ置き場・fakeだけを使い、360px幅の実タッチでパンとの競合を確かめる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const version = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
const executablePath = process.env.PW_CHROMIUM || path.join(base, version, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-drawer-swipe-'));
let server, browser, ws;
const results = [];
const check = (ok, label, detail = '') => { if (!ok) throw new Error(`${label} ${JSON.stringify(detail)}`); results.push(label); };
try {
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  ws = await open({ port: server.port, token: server.token });
  await ws.runTurn({ backend: 'fake', cwd: scratch, prompt: 'echo:スワイプを確認する本文です。' });
  browser = await chromium.launch({ executablePath });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true, locale: 'ja-JP' });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await page.locator('#prompt').waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] });
  const wait = ms => page.waitForTimeout(ms);
  const isOpen = () => page.evaluate(() => document.documentElement.classList.contains('side-open'));
  async function swipe(x1, y1, x2, y2, { pause = 0, cancel = false, during } = {}) {
    await touch('touchStart', x1, y1);
    if (Math.abs(x2 - x1) > Math.abs(y2 - y1)) {
      for (const distance of [4, 8, 12]) {
        await touch('touchMove', x1 + Math.sign(x2 - x1) * distance, y1);
        await wait(16);
      }
    }
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10);
      await wait(20);
    }
    if (during) await during();
    await wait(pause);
    await touch(cancel ? 'touchCancel' : 'touchEnd');
    await wait(300);
  }
  async function close() { if (await isOpen()) { await page.locator('#closeSidebar').click(); await wait(300); } }
  // 会話を選ぶと閉じることも、スワイプで開いた後に確かめる。
  const row = page.locator('#groups .row[data-session^="fake-"]').first();
  await page.locator('#openSidebar').click(); await wait(300);
  await row.click(); await wait(400);
  await page.waitForFunction(() => [...document.querySelectorAll('#log .body')].some(n => n.textContent.trim() === 'スワイプを確認する本文です。'));
  // 本文と横スクロールのfixtureを本物の会話領域へ置く。祖先を含めた実際のパンの可否を見る。
  await page.evaluate(() => {
    const log = document.getElementById('log');
    log.replaceChildren();
    const text = document.createElement('div'); text.id = 'swipeText';
    text.style.cssText = 'height:180px;padding:16px'; text.textContent = '本文を右へ引くと脇が開きます。';
    const scroller = document.createElement('div'); scroller.id = 'swipeHorizontal';
    scroller.style.cssText = 'overflow-x:auto;width:100%;height:90px';
    const pre = document.createElement('pre'); pre.style.cssText = 'width:1200px;height:80px;margin:0'; pre.textContent = '横にスクロールするコード '.repeat(40); scroller.append(pre);
    const filler = document.createElement('div'); filler.style.height = '1800px'; filler.textContent = '縦にスクロールする本文';
    log.append(text, scroller, filler); log.scrollTop = 0;
  });
  const bounds = await page.locator('#swipeText').boundingBox();
  const y = bounds.y + 80;
  await swipe(65, y, 245, y, { pause: 120, during: async () => {
    const state = await page.evaluate(() => ({ x: document.getElementById('sidebar').getBoundingClientRect().x,
      opacity: +getComputedStyle(document.getElementById('sideVeil')).opacity,
      dragging: document.documentElement.classList.contains('side-dragging'), transition: getComputedStyle(document.getElementById('sidebar')).transitionDuration }));
    check(state.dragging && Math.abs(state.x + 129.6) < 3 && Math.abs(state.opacity - 180 / 309.6) < .02 && state.transition === '0s', '指の距離と幕の濃さが追従し、追従中の遷移は0ms', state);
  } });
  check(await isOpen(), '右へのスワイプで開く');
  await wait(100);
  check(await page.evaluate(() => document.querySelector('main').inert && document.activeElement.id === 'closeSidebar'), '既存のinertと閉じるボタンへのフォーカスを通る');
  const rowBounds = await row.boundingBox();
  await swipe(220, rowBounds.y + rowBounds.height / 2, 30, rowBounds.y + rowBounds.height / 2, { pause: 120 });
  check(!await isOpen(), '開いた脇の会話の行から左へスワイプして閉じる');
  check(await page.evaluate(() => !document.querySelector('main').inert && !document.documentElement.classList.contains('side-dragging')), '閉じた後の操作制限と追従の印が残らない');
  await swipe(65, y, 125, y, { pause: 120 });
  check(!await isOpen(), '短く引いて止めた後は閉じる');
  await swipe(65, y, 245, y, { cancel: true });
  check(!await isOpen(), '閉じた状態からのpointercancelは閉じた状態へ戻す');
  await swipe(65, y, 245, y, { pause: 120 });
  await swipe(260, y, 65, y, { cancel: true });
  check(await isOpen(), '開いた状態からのpointercancelは開いた状態へ戻す');
  await page.keyboard.press('Escape'); await wait(300);
  check(!await isOpen(), 'Escで閉じる');
  await swipe(65, y, 245, y, { pause: 120 });
  await page.locator('#sideVeil').tap({ position: { x: 340, y: 250 } }); await wait(300);
  check(!await isOpen(), '外側のタップで閉じる');
  await swipe(65, y, 245, y, { pause: 120 });
  await row.click(); await wait(300);
  check(!await isOpen(), '会話の選択で閉じる');

  const horizontal = await page.locator('#swipeHorizontal').boundingBox();
  const hy = horizontal.y + 35;
  await page.locator('#swipeHorizontal').evaluate(n => { n.scrollLeft = 200; });
  await swipe(90, hy, 250, hy, { pause: 120 });
  check(!await isOpen() && await page.locator('#swipeHorizontal').evaluate(n => n.scrollLeft < 150), 'コードの上では脇が開かず、中身が横スクロールする');
  await page.locator('#swipeHorizontal').evaluate(n => { n.scrollLeft = 0; });
  await swipe(90, hy, 250, hy, { pause: 120 });
  check(!await isOpen(), '横スクロールの端でも脇へ切り替えない');
  const excluded = await page.evaluate(async () => {
    const { excludedDrawerTarget } = await import('/drawer-swipe.mjs');
    const examples = ['<pre><span>code</span></pre>', '<table><tbody><tr><td>table</td></tr></tbody></table>', '<iframe></iframe>', '<input>', '<textarea></textarea>', '<a href="#">link</a>', '<button>button</button>', '<div contenteditable="true"><span>edit</span></div>', '<div class="tc-term"><span>terminal</span></div>', '<div role="tablist"><span>tabs</span></div>'];
    return examples.every(html => { const box = document.createElement('div'); box.innerHTML = html; const target = box.querySelector('span,td') || box.firstElementChild; return excludedDrawerTarget(target, { open: false, boundary: box }); });
  });
  check(excluded, '実際の要素でも入力・リンク・編集・表・iframe・端末・タブの除外が働く');
  await swipe(150, y + 70, 150, y - 60, { pause: 120 });
  check(!await isOpen() && await page.locator('#log').evaluate(n => n.scrollTop > 40), '縦に引くと本文がスクロールし、脇は開かない');
  await page.locator('#log').evaluate(n => { n.scrollTop = 0; }); await wait(100);
  await swipe(10, y, 240, y, { pause: 120 });
  check(!await isOpen(), '左端24pxはOSに譲る');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await swipe(65, y, 245, y, { pause: 120 });
  check(await isOpen() && await page.locator('#sidebar').evaluate(n => getComputedStyle(n).transitionDuration.split(',').every(v => parseFloat(v) === 0)), 'reduced-motionでも追従して開き、確定後は0ms');
  await close();
  await swipe(65, y, 245, y, { during: async () => page.setViewportSize({ width: 900, height: 760 }) });
  check(!await isOpen() && await page.locator('#sidebar').evaluate(n => !n.style.transform), '幅が広がると追従と引き出しの状態を片付ける');
  check(errors.length === 0, '画面の例外なし', errors);
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`drawer-swipe: ${results.length} 件 通過`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.error(e.stack); process.exitCode = 1;
} finally {
  ws?.close();
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
