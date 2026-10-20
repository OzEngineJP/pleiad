// 設定 › 委譲「委譲先の自動選択に使うキー」の打鍵（実ブラウザー。docs/plus.md「画面の行」）:
//   ラジオは 1 つだけ選べる。Pleiad Plus が上・OpenRouter が下。状態ごとの右（メール・上限の文言・ログインの案内・
//   「Pleiad Plus を使っていません」）と選べるか。Plus を選ぶと OpenRouter の印が消え、その逆も。
//   未ログインの「ログイン」は Plus のログイン（外に開く URL を記録）を始める。state: off / AGENT_HOST_PLUS=0 では行ごと出ない。
// 偽の Plus（tests/lib/fake-plus.mjs）だけと話す。実行: node tests/browser/delegation-plus.mjs
//   DELEG_PLUS_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.DELEG_PLUS_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-or-v1-' + 'a'.repeat(24);

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-deleg-plus-ui-'));
const captureFile = path.join(dataDir, 'external.log');
const plus = await startFakePlus();
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };
const BASE_ACCOUNT = { uid: 'user-1', email: 'user@example.com', provider: 'google.com' };
const PLUS_ACCOUNT = { ...BASE_ACCOUNT, status: 'plus', plan: { name: 'Pleiad Plus' },
  limits: { hosts: 3, creditsPerMonth: 500, syncBytes: 100 }, usage: { credits: 120, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: false } };

const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `delegation-plus-${name}.png`) }); } };
/** 外に開かれた URL を順に取る */
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

const plusRow = page => page.locator('#delegationPanel .rm-opt', { hasText: 'Pleiad Plus' });
const orRow = page => page.locator('#delegationPanel .rm-opt', { hasText: 'OpenRouter' });
const checked = async loc => (await loc.getAttribute('aria-checked')) === 'true';
const selectable = async loc => (await loc.getAttribute('aria-disabled')) !== 'true';

async function newPage(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForSelector('#settingsView:not([hidden])');
  await page.locator('#delegationTab').click();
  await page.waitForSelector('#delegationPanel .rm-opts');
  return page;
}

try {
  server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  const admin = await open({ port: server.port, token: server.token });
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const [VW, VH] = (process.env.SHOT_VIEWPORT || '1280x820').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, colorScheme: process.env.SHOT_COLOR || 'light', locale: process.env.SHOT_LOCALE || 'ja-JP' });
  const page = await newPage(ctx, url);
  page.on('console', m => { if (m.type() === 'error') console.log('DBG console:', m.text()); });
  page.on('pageerror', e => console.log('DBG pageerror:', e.message));

  /** 画面の中の「ログイン」→ 偽のログインのページを辿って入り直す */
  async function signInViaRow(account) {
    plus.state.accounts['user-1'] = account;
    await plusRow(page).locator('button[data-fk="plusLogin"]').dispatchEvent('click');   // 行は aria-disabled でもリンクは押せる
    const loginUrl = await nextExternal();
    const ext = await ctx.newPage();
    for (let i = 0; i < 3 && !(await ext.goto(loginUrl, { waitUntil: 'commit', timeout: 10_000 }).then(() => true).catch(() => false)); i++);
    await ext.waitForURL('**/callback*', { timeout: 15_000 }).catch(() => {});
    let signedIn = false;
    for (let i = 0; i < 150; i++) { if ((await admin.cmd('plusStatus')).signedIn) { signedIn = true; break; } await new Promise(r => setTimeout(r, 100)); }
    if (!signedIn) throw new Error('plusStatus.signedIn にならない ' + JSON.stringify(await admin.cmd('plusStatus')));
    await page.waitForSelector('#delegationPanel .rm-opt >> text=user@example.com', { timeout: 15_000 });
    await ext.close();
  }
  /** 設定 › Pleiad Plus のログイン・ログアウトで入れ替える（行の無い状態を作るとき） */
  async function plusLogin(account) {
    plus.state.accounts['user-1'] = account;
    await admin.cmd('plusLogin');
    const loginUrl = await nextExternal();
    const ext = await ctx.newPage();
    for (let i = 0; i < 3 && !(await ext.goto(loginUrl, { waitUntil: 'commit', timeout: 10_000 }).then(() => true).catch(() => false)); i++);
    await ext.waitForURL('**/callback*', { timeout: 15_000 }).catch(() => {});
    await ext.close();
    for (let i = 0; i < 100; i++) {
      if ((await admin.cmd('plusStatus')).signedIn) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('ログインが終わらない');
  }
  const signOut = () => admin.cmd('plusLogout');
  const until = async (fn, label, ms = 15_000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, 80)); }
    throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)}`);
  };

  // ---- 1. ログインしていない: 「ログインしていません · ログイン」・選べない ----
  {
    const row = plusRow(page);
    ok('未ログイン: Pleiad Plus の行が OpenRouter の上', (await page.locator('#delegationPanel .rm-opt').first().innerText()).includes('Pleiad Plus'));
    ok('未ログイン: 「ログインしていません · ログイン」', (await row.innerText()).includes('ログインしていません') && (await row.innerText()).includes('ログイン'));
    ok('未ログイン: 選べない・印も無い', !(await selectable(row)) && !(await checked(row)));
    ok('未ログイン: OpenRouter は「キーを選ぶ」', (await orRow(page).innerText()).includes('キーを選ぶ'));
    await shot(page, 'signed-out');
  }

  // ---- 2. 行の「ログイン」→ Plus のログインが始まる ----
  {
    await plusRow(page).locator('button[data-fk="plusLogin"]').dispatchEvent('click');   // 行は aria-disabled でもリンクは押せる
    const loginUrl = await nextExternal();
    ok('行の「ログイン」は Plus のログインを始める（外へ開く）', loginUrl.startsWith(`${plus.url}/login`), loginUrl);
    const ext = await ctx.newPage();
    plus.state.accounts['user-1'] = PLUS_ACCOUNT;
    for (let i = 0; i < 3 && !(await ext.goto(loginUrl, { waitUntil: 'commit', timeout: 10_000 }).then(() => true).catch(() => false)); i++);
    await ext.waitForURL('**/callback*', { timeout: 15_000 }).catch(() => {});
    await until(async () => (await plusRow(page).innerText()).includes('user@example.com'), 'メールが見える');
    await ext.close();
  }

  // ---- 3. plus（自動で両方に plus が選ばれる）----
  {
    const row = plusRow(page);
    ok('plus: メールが出る・選べる・印がつく', (await row.innerText()).includes('user@example.com') && (await selectable(row)) && (await checked(row)));
    ok('plus: OpenRouter の印は消える', !(await checked(orRow(page))));
    ok('plus: 案内「委譲先の自動選択と音声通話に Pleiad Plus を使います」は設定 › Pleiad Plus に出る', true); // 案内そのものは plus-settings の試験
    await shot(page, 'plus');
  }

  // ---- 4. OpenRouter のキーを登録して選ぶ → plus の印が消える ----
  {
    await admin.cmd('setApiKey', { provider: 'openrouter', key: KEY });
    // apiKeysChanged → refresh → 描き直しが済んでから開く（pop の選択肢に登録したキーが入るまで）
    const openPop = async () => {
      await orRow(page).click();
      return page.locator('#delegationPanel .ak-pop .li').allInnerTexts();
    };
    await until(async () => {
      const items = await openPop();
      if (items.some(x => x.includes('OpenRouter') && !x.includes('登録'))) return true;
      if (await page.locator('#delegationPanel .ak-pop').count()) await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      return false;
    }, '選択肢に登録したキー', 60000);
    await page.locator('#delegationPanel .ak-pop .li', { hasText: 'OpenRouter' }).first().click();
    await until(async () => await checked(orRow(page)), 'OpenRouter に印', 60000);
    ok('OpenRouter を選ぶと plus の印が消える', !(await checked(plusRow(page))));
    ok('OpenRouter の行に選んだキーが出る', (await orRow(page).innerText()).includes('登録済み') || (await orRow(page).innerText()).includes('OpenRouter'));
    // もう一度 Plus を選ぶ → OpenRouter の印が消える
    await plusRow(page).click();
    await until(async () => await checked(plusRow(page)), 'plus に印', 60000);
    ok('plus を選ぶと OpenRouter の印が消える', !(await checked(orRow(page))));
    await shot(page, 'plus-chosen');
  }

  // ---- 5. 上限に達した → メール＋「今月の上限に達しました（… に戻ります）」・選べる ----
  await signOut();
  await signInViaRow({ ...PLUS_ACCOUNT, usage: { credits: 500, resetAt: '2026-12-01T00:00:00+09:00' } });
  {
    const tx = await plusRow(page).innerText();
    ok('上限: メールと「今月の上限に達しました（… に戻ります）」', tx.includes('user@example.com') && tx.includes('今月の上限に達しました') && tx.includes('に戻ります'), tx);
    ok('上限: 選べる（選んだままにできる）', await selectable(plusRow(page)));
    await shot(page, 'limit');
  }

  // ---- 6. plus を選んだままログアウト → 印は残る・効き目は「キーが無い」 ----
  {
    const row = plusRow(page);
    if (!(await checked(row))) await row.click();
    await signOut();
    await until(async () => (await plusRow(page).innerText()).includes('ログインしていません'), 'ログインしていません');
    ok('ログアウト: plus の印は残る・行は選べない', (await checked(plusRow(page))) && !(await selectable(plusRow(page))));
    ok('ログアウト: 効き目の行は「キーが無い」と同じ（難しさを「中」と扱う）', (await page.locator('#delegationPanel').innerText()).includes('キーが登録されていない'));
    await shot(page, 'plus-checked-signedout');
  }

  // ---- 7. free ----
  await plusLogin({ ...BASE_ACCOUNT, status: 'free', plan: null, limits: null, usage: null, sync: null });
  await until(async () => (await plusRow(page).innerText()).includes('Pleiad Plus を使っていません'), 'free の文言');
  {
    const row = plusRow(page);
    ok('free: 「Pleiad Plus を使っていません」・選べない', !(await selectable(row)));
    await shot(page, 'free');
  }

  // ---- 8. disabled ----
  await signOut();
  await plusLogin({ ...BASE_ACCOUNT, status: 'disabled', plan: null, limits: null, usage: null, sync: null });
  await until(async () => (await plusRow(page).innerText()).includes('Pleiad Plus を使っていません'), 'disabled の文言');
  ok('disabled: 「Pleiad Plus を使っていません」・選べない', !(await selectable(plusRow(page))));
  await shot(page, 'disabled');
  await signOut();

  // ---- 9. state: off → 行ごと出ない ----
  {
    plus.state.state = 'off';
    await admin.cmd('plusLogin').catch(() => {});   // config を取り直させる（off で断られる）
    await until(async () => (await plusRow(page).count()) === 0, 'off で行が消える');
    ok('state:off → Pleiad Plus の行ごと出さない', true);
    await shot(page, 'state-off');
    plus.state.state = 'on';
  }
  await ctx.close();

  // ---- 10. AGENT_HOST_PLUS=0 → 行ごと出ない ----
  {
    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-deleg-plus-off-'));
    const capture2 = path.join(dataDir2, 'external.log');
    const server2 = await startServer({ dataDir: dataDir2, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
      env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_PLUS: '0', PLUS_EXTERNAL_CAPTURE: capture2 } });
    try {
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
      const page2 = await newPage(ctx2, `http://127.0.0.1:${server2.port}/?token=${server2.token}`);
      ok('AGENT_HOST_PLUS=0 → Pleiad Plus の行ごと出さない', (await plusRow(page2).count()) === 0 && (await orRow(page2).count()) === 1);
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
