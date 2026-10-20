// 設定 › Pleiad Plus の画面（web/plus-settings.mjs）。実ブラウザーでログイン → 状態ごとの中身を見る。
// 偽の Plus（tests/lib/fake-plus.mjs）だけと話す。外のブラウザーで開く URL は tests/lib/plus-main-port.mjs が
// PLUS_EXTERNAL_CAPTURE のファイルに記録する（OS のブラウザーは開かない）。
// 実行: node tests/browser/plus-settings.mjs   （PLUS_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。明暗 × 1280/360）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}
const SHOTS = process.env.PLUS_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-plus-ui-'));
const captureFile = path.join(dataDir, 'external.log');
const plus = await startFakePlus();
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const BASE_ACCOUNT = { uid: 'user-1', email: 'user@example.com', provider: 'google.com' };
const PLUS_ACCOUNT = { ...BASE_ACCOUNT, status: 'plus', plan: { name: 'Pleiad Plus' },
  limits: { hosts: 3, creditsPerMonth: 1000, syncBytes: 100 }, usage: { credits: 120, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: false } };

try {
  server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `plus-${name}.png`) }); };
  const panelText = page => page.locator('#plusPanel').innerText();
  /** 外に開かれた URL を順に取る（ログインのページなど） */
  let externalSeen = 0;
  async function nextExternal() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lines = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length > externalSeen) { externalSeen = lines.length; return lines.at(-1); }
      if (Date.now() > deadline) throw new Error('open-external が来ない');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  /** 1280/360 × 明/暗 の 4 枚を撮り、360 で横にあふれないことを確かめる */
  async function shots(page, name) {
    if (!SHOTS) return;
    await shot(page, `${name}-light-1280`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, `${name}-dark-1280`);
    await page.setViewportSize({ width: 360, height: 1000 });
    await shot(page, `${name}-light-360`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, `${name}-dark-360`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(`${name}: 幅 360 で横にあふれない`, !overflow);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForSelector('#settingsView:not([hidden])');
  const openPlus = async () => { await page.locator('#plusTab').click(); await page.waitForSelector('#plusPanel:not([hidden])'); };
  await openPlus();

  // 「ログイン」→ 偽のログインのページ（別タブ）→ 戻って中身が出る、までを通す
  async function signIn() {
    await page.locator('#plusPanel button:has-text("ログイン")').first().click();
    const loginUrl = await nextExternal();
    const ext = await ctx.newPage();
    await ext.goto(loginUrl); // /login → ループバックへ 302 → セッションが completed
    await page.waitForSelector('#plusPanel button:has-text("ログアウト")', { timeout: 15_000 });
    await ext.close();
    // account はログインの直後に読まれる。メールが見えるまで待つ
    await page.waitForSelector('#plusPanel :text("user@example.com")', { timeout: 15_000 });
  }
  async function signOut() {
    await page.locator('#plusPanel button:has-text("ログアウト")').click();
    await page.waitForSelector('#plusPanel :text("ログインしていません")');
  }
  /** アカウントを差し替えて入り直す（config と account はログインのたびに読み直される） */
  async function signInAs(account) {
    plus.state.accounts['user-1'] = account;
    await signIn();
  }

  // ---- 1. ログインしていない ----
  {
    const tx = await panelText(page);
    ok('未ログイン: 「ログインしていません」と「ログイン」', tx.includes('ログインしていません') && tx.includes('ログイン'), tx);
    await shots(page, 'signed-out');
  }

  // ---- 2. ログインの途中 ----
  {
    await page.locator('#plusPanel button:has-text("ログイン")').first().click();
    await page.waitForSelector('#plusPanel :text("ブラウザーでログインしています")');
    ok('ログインの途中: 「やめる」が出る', (await panelText(page)).includes('やめる'));
    await shots(page, 'login-waiting');
    await nextExternal(); // 開こうとした URL を消費（次の場面と取り違えない）
    // やめる → 戻る
    await page.locator('#plusPanel button:has-text("やめる")').click();
    await page.waitForSelector('#plusPanel :text("ログインしていません")');
  }

  // ---- 3. free ----
  await signInAs({ ...BASE_ACCOUNT, status: 'free', plan: null, limits: null, usage: null, sync: null });
  ok('free: 「無料」と「Pleiad Plus にする」', (await panelText(page)).includes('無料') && (await panelText(page)).includes('Pleiad Plus にする'));
  await shots(page, 'free');

  // ---- 4. ログアウト → もとに戻る ----
  await signOut();
  ok('ログアウトで「ログインしていません」に戻る', true);

  // ---- 5. plus（今月の利用） ----
  await signInAs(PLUS_ACCOUNT);
  await page.waitForSelector('#plusPanel :text("今月の利用")');
  ok('plus: 今月の利用と Google の入り方', (await panelText(page)).includes('Google でログイン'), await panelText(page));
  await shots(page, 'plus');

  // ---- 6. 上限に達した ----
  await signOut();
  await signInAs({ ...PLUS_ACCOUNT, usage: { ...PLUS_ACCOUNT.usage, credits: 1000 } });
  await page.waitForSelector('#plusPanel :text("上限に達しました")');
  await shots(page, 'plus-limit');

  // ---- 7. disabled ----
  await signOut();
  await signInAs({ ...BASE_ACCOUNT, status: 'disabled', plan: null, limits: null, usage: null, sync: null });
  await page.waitForSelector('#plusPanel :text("このアカウントは使えなくなっています")');
  await shots(page, 'disabled');

  // ---- 8. reachable: false（account の読み直しは 30 秒に 1 回まで。取り直しが効くまで札を押し直して待つ） ----
  await signOut();
  await signInAs(PLUS_ACCOUNT);
  plus.state.down = true;
  {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if ((await panelText(page)).includes('サーバーへの接続に失敗しました')) break;
      if (Date.now() > deadline) { ok('reachable: false の行が出る', false); break; }
      await openPlus().catch(() => {});
      await page.waitForTimeout(1000);
    }
    ok('reachable: false の行が出る', (await panelText(page)).includes('サーバーへの接続に失敗しました'));
  }
  await shots(page, 'unreachable');
  plus.state.down = false;

  // ---- 9. maintenance（ログインのたびに config を取り直すので、入り直して出す） ----
  await signOut();
  plus.state.state = 'maintenance';
  await page.locator('#plusPanel button:has-text("ログイン")').first().click().catch(() => {});
  await openPlus();
  await page.waitForSelector('#plusPanel :text("Pleiad Plus はメンテナンス中です")', { timeout: 15_000 });
  await shots(page, 'maintenance');
  plus.state.state = 'on';

  // ---- 10. この PC の行（host）→ 確かめの窓 ----
  // host は B4 がサーバー側の session.setHost で入れる（この issue では WS から変えられない）。
  // 実物の renderPlus をページの中で走らせてこの PC の行と確かめの窓を撮る（行とコマンドの出し方は単体試験で確かめる）
  const renderHost = confirming => page.evaluate(async (confirming) => {
    const { renderPlus } = await import('/plus-settings.mjs');
    const status = { available: true, state: 'on', needsUpdate: false, signedIn: true, login: { phase: 'idle' }, reachable: true, error: null,
      account: { uid: 'user-1', email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { name: 'Pleiad Plus' },
        limits: { creditsPerMonth: 1000 }, usage: { credits: 120, resetAt: '2026-11-01T00:00:00+09:00' } },
      urls: { account: 'http://127.0.0.1:9/account', profile: null }, host: { state: 'taken' } };
    document.getElementById('plusPanel').replaceChildren(...renderPlus(status, { send: () => {}, openExternal: () => {}, askRebind: () => {}, cancelRebind: () => {}, confirming }));
  }, confirming);
  await renderHost(false);
  await page.waitForSelector('#plusPanel :text("つなぎ直す")');
  await shots(page, 'host-taken');
  await renderHost(true);
  await page.waitForSelector('#plusPanel :text("作り直す")');
  ok('確かめの窓が出る', (await panelText(page)).includes('この PC の鍵を作り直します'));
  await shots(page, 'host-confirm');
  await ctx.close();

  // ---- 11. available === false → メニューの項目ごと出さない（AGENT_HOST_PLUS=0 の別のサーバーで確かめる） ----
  {
    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-plus-off-'));
    const capture2 = path.join(dataDir2, 'external.log');
    const server2 = await startServer({ dataDir: dataDir2, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
      env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_PLUS: '0', PLUS_EXTERNAL_CAPTURE: capture2 } });
    try {
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
      const page2 = await ctx2.newPage();
      await page2.goto(`http://127.0.0.1:${server2.port}/?token=${server2.token}`, { waitUntil: 'load' });
      await page2.waitForTimeout(1500);
      await page2.evaluate(() => document.getElementById('onboardingDialog')?.close());
      await page2.evaluate(() => document.getElementById('settings')?.click());
      await page2.waitForSelector('#settingsView:not([hidden])');
      const hidden = await page2.evaluate(() => document.getElementById('plusTab').hidden);
      ok('available === false → メニューに Pleiad Plus は出ない', hidden === true, `hidden=${hidden}`);
      await ctx2.close();
    } finally {
      await server2.stop().catch(() => {});
      try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch {}
    }
  }
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await plus.close().catch(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log('\n全て通過');
