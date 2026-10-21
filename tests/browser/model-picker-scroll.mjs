// 入力欄のモデルの面を開いてスクロールした位置が、開いている間の描き直しで戻らないこと（実ブラウザー）:
//   - スマホ（360px・タッチ）: チップを押して開き、指で一覧を下までなぞる。使用量の更新（usageChanged）で面が描き直されても、
//     位置はそのまま・焦点も同じ行のまま（以前は、開いたときに焦点を置いた一番上の宛先の札へ焦点を当て直すときに面がスクロールし、上へ戻っていた）
//   - PC（マウスのホイール）: 同じく戻らない
//   - キーボードで ↓ を押して移った行は、描き直しの後も焦点を保ち、見えたまま
// 実行: node tests/browser/model-picker-scroll.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// 本物のサーバー（fake のバックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
// 使用量は AGENT_HOST_FAKE_QUOTA のファイルから読む。別の接続から delegation.usageRefresh を呼ぶと、サーバーが usageChanged を全ての画面へ流す
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-model-scroll-'));
const quotaFile = path.join(dataDir, 'fake-quota.json');
const writeQuota = used => fs.writeFileSync(quotaFile, JSON.stringify({ windows: [
  { label: '5 時間', usedPercent: used, resetsAt: new Date(Date.now() + 3600_000).toISOString(), minutes: 300 },
  { label: '週', usedPercent: used / 2, resetsAt: new Date(Date.now() + 5 * 86400_000).toISOString(), minutes: 10080 },
] }));
writeQuota(20);
let server, ws, browser;

// 面の様子。描き直した回数は、面の子を印で見分ける（render は子を作り直す）
const popState = page => page.evaluate(() => {
  const pop = document.getElementById('modelPop');
  const a = document.activeElement;
  return { open: !pop.hidden, top: Math.round(pop.scrollTop), max: pop.scrollHeight - pop.clientHeight,
    marked: Boolean(pop.firstElementChild?.__mark), focusKey: pop.contains(a) ? a.dataset?.key ?? null : null,
    focusVisible: (() => { if (!pop.contains(a)) return null; const p = pop.getBoundingClientRect(), r = a.getBoundingClientRect(); return r.top >= p.top - 1 && r.bottom <= p.bottom + 1; })() };
});
const markChildren = page => page.evaluate(() => { for (const c of document.getElementById('modelPop').children) c.__mark = true; });
// 使用量を別の接続から読み直させ、面が描き直されるまで待つ（その後の描き直しも落ち着くまで少し待つ）
async function repaintByUsage(page, used) {
  await markChildren(page);
  writeQuota(used);
  await ws.cmd('invoke', { op: 'delegation.usageRefresh', args: { backend: 'fake' } });
  await page.waitForFunction(() => !document.getElementById('modelPop').firstElementChild?.__mark, null, { timeout: 10000 });
  await page.waitForTimeout(1500);
}

async function session({ viewport, mobile }) {
  const ctx = await browser.newContext({ viewport, locale: 'ja-JP', ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  // モデルの一覧が届くまで（チップの「確かめている」が外れるまで）
  await page.waitForFunction(() => { const c = document.getElementById('modelChip'); return c && !c.classList.contains('checking') && c.offsetParent; }, null, { timeout: 20000 });
  return { ctx, page, errors };
}
// 面を開き、使用量の行まで描かれて落ち着くのを待つ
async function openPicker(page, how) {
  if (how === 'tap') await page.locator('#modelChip').tap();
  else await page.locator('#modelChip').click();
  await page.waitForFunction(() => !document.getElementById('modelPop').hidden);
  await page.waitForTimeout(1500);
  const s = await popState(page);
  check(s.open && s.max > 80, `${how}: 面が開き、一覧がスクロールできる高さがある`, s);
  check(s.focusKey !== null, `${how}: 開いたときの焦点は面の中（選んでいる行）`, s);
  return s;
}

try {
  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', AGENT_HOST_FAKE_QUOTA: quotaFile } });
  ws = await open({ port: server.port, token: server.token });
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });

  const scenes = [
    // スマホ: 360px。キーボードや帯で縦が狭いときに一覧がはみ出す高さ
    ['スマホ（360px・タッチ）', { viewport: { width: 360, height: 380 }, mobile: true }, async (page) => {
      await openPicker(page, 'tap');
      const cdp = await page.context().newCDPSession(page);
      const box = await page.locator('#modelPop').boundingBox();
      // 指で上へなぞって、一覧を下へ送る（止めてから離す。はじかない）
      const x = Math.round(box.x + box.width / 2), y0 = Math.round(box.y + box.height * 0.6), dy = Math.round(box.height * 0.5);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y0 - dy * i / 12) }] });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(200);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(600);
      const scrolled = await popState(page);
      check(scrolled.top > 40, 'スマホ: 指でなぞると一覧が下へ動く', scrolled);
      await repaintByUsage(page, 35);
      const after = await popState(page);
      check(after.open, 'スマホ: 使用量の更新の後も面は開いたまま', after);
      check(Math.abs(after.top - scrolled.top) <= 1, 'スマホ: 使用量の更新で描き直しても、スクロールの位置が戻らない', { before: scrolled.top, after: after.top });
      check(after.focusKey === scrolled.focusKey, 'スマホ: 焦点は同じ行のまま', { before: scrolled.focusKey, after: after.focusKey });
      // 2 度目の更新でも同じ
      await repaintByUsage(page, 50);
      check(Math.abs((await popState(page)).top - scrolled.top) <= 1, 'スマホ: 2 度目の更新でも位置を保つ');
    }],
    ['PC（ホイール）', { viewport: { width: 1280, height: 380 }, mobile: false }, async (page) => {
      await openPicker(page, 'click');
      const box = await page.locator('#modelPop').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(600);
      const scrolled = await popState(page);
      check(scrolled.top > 40, 'PC: ホイールで一覧が下へ動く', scrolled);
      await repaintByUsage(page, 65);
      const after = await popState(page);
      check(Math.abs(after.top - scrolled.top) <= 1, 'PC: 使用量の更新で描き直しても、スクロールの位置が戻らない', { before: scrolled.top, after: after.top });
      check(after.focusKey === scrolled.focusKey, 'PC: 焦点は同じ行のまま', { before: scrolled.focusKey, after: after.focusKey });
    }],
    ['PC（キーボード）', { viewport: { width: 1280, height: 380 }, mobile: false }, async (page) => {
      await openPicker(page, 'click');
      // 宛先の札から Tab でモデルの一覧へ入り、↓ で一覧の終わりへ移る（移った行は見える所までスクロールされる）
      const key = () => page.evaluate(() => document.activeElement?.dataset?.key ?? '');
      for (let i = 0; i < 6 && !(await key()).startsWith('model:'); i++) await page.keyboard.press('Tab');
      for (let i = 0; i < 6 && (await key()) !== 'model:tiny'; i++) await page.keyboard.press('ArrowDown');
      check(await key() === 'model:tiny', 'キーボード: Tab と ↓ で一覧の最後の行へ移れる', await key());
      await page.waitForTimeout(300);
      const moved = await popState(page);
      check(moved.focusKey && moved.focusVisible, 'キーボード: ↓ で移った行に焦点があり、見えている', moved);
      await repaintByUsage(page, 80);
      const after = await popState(page);
      check(after.focusKey === moved.focusKey && after.focusVisible, 'キーボード: 描き直しの後も、移った行に焦点があり見えている', { moved, after });
      check(Math.abs(after.top - moved.top) <= 1, 'キーボード: 描き直しでスクロールの位置が変わらない', { before: moved.top, after: after.top });
    }],
  ];

  const failed = [];
  for (const [name, opts, run] of scenes) {
    const { ctx, page, errors } = await session(opts);
    try {
      await run(page);
      check(errors.length === 0, `${name}: ページの例外が無い`, errors);
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `model-picker-scroll-${failed.length}.png`) }).catch(() => {});
    }
    await ctx.close();
  }

  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  if (failed.length) {
    console.log(failed.map(f => `  NG  ${f}`).join('\n'));
    process.exitCode = 1;
  } else console.log(`\n全て通過 ${results.length} 判定`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`  NG  ${e.message}`);
  process.exitCode = 1;
} finally {
  ws?.close?.();
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}
