// 設定 › Pleiad Plus の「同期」（web/plus-sync.mjs）。実ブラウザーで、偽の Plus（tests/lib/fake-plus.mjs）を相手に
// 本物の同期のエンジンを回して、状態ごとの中身・スイッチ・やり直しの確かめ・競合の行を見る。
// AGENT_HOST_OS_OPEN=dry で「フォルダーを開く」は窓を開かずに成功する。
// 実行: node tests/browser/plus-sync.mjs   （PLUS_SYNC_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。明暗 × 1280/360）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { open as openWs } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}
const SHOTS = process.env.PLUS_SYNC_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-plus-sync-'));
const captureFile = path.join(dataDir, 'external.log');
const plus = await startFakePlus();
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const UID = 'user-1';
const PLUS_ACCOUNT = { uid: UID, email: 'user@example.com', provider: 'google.com', status: 'plus',
  plan: { name: 'Pleiad Plus' }, limits: { hosts: 3, creditsPerMonth: 500 }, usage: { credits: 10, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: true } };
// もう 1 台の PC（鍵を持っている）。自分宛てが無いとき waiting_key にするための台帳の行
const OTHER_HOST = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const seedWaitingKey = () => {
  plus.state.hosts[OTHER_HOST] = { hostId: OTHER_HOST, publicKey: 'x', name: 'other-pc', platform: 'win32', online: true, lastSeenAt: null, syncPublicKey: 'x'.repeat(43), createdAt: new Date().toISOString(), deviceCount: 0, uid: UID };
  plus.state.sync[UID] = { keyId: '0123456789abcdef', keys: { [OTHER_HOST]: { keyId: '0123456789abcdef', wrapped: 'x'.repeat(80), wrappedBy: OTHER_HOST } }, items: {}, seq: 0, totalBytes: 0 };
};

try {
  // 「同期するもの」の暗号化に実 home を読ませないため、指示ファイルの元は試験の置き場へ向ける
  fs.mkdirSync(path.join(dataDir, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'codex'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });   // エンジンの fs.watch が張られるよう、起動前に置く
  // PATCH /v1/account の失敗を差し込める口（failPatch が真の間だけ 500）
  let failPatch = false;
  plus.route('PATCH', '/v1/account', async (req, res) => {
    if (failPatch) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"code":"unavailable","message":"x"}}'); }
    const raw = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
    const body = JSON.parse(raw || '{}');
    const cur = plus.state.accounts[UID] ?? PLUS_ACCOUNT;
    plus.state.accounts[UID] = { ...cur, ...(body?.sync ? { sync: { ...cur.sync, ...body.sync } } : {}) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(plus.state.accounts[UID]));
  });
  // 競合の写し（30 日以内）。エンジンの回し始めに数えられる
  const stamp = new Date(Date.now() - 60_000).toISOString().replace(/[-:T]/g, m => (m === 'T' ? '-' : '')).slice(0, 15);
  const conflictDir = path.join(dataDir, 'plus', 'sync-conflicts', stamp);
  fs.mkdirSync(conflictDir, { recursive: true });
  fs.writeFileSync(path.join(conflictDir, 'settings_locale.json'), '{"locale":"en"}');

  server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile, AGENT_HOST_OS_OPEN: 'dry',
      CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude'), CODEX_HOME: path.join(dataDir, 'codex') } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sync-${name}.png`) }); };
  const panelText = page => page.locator('#plusPanel').innerText().catch(() => '');
  const syncText = page => page.locator('#plusSyncSection').innerText().catch(() => '');
  async function shots(page, name) {
    if (!SHOTS) return;
    await shot(page, `${name}-light-1280`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, `${name}-dark-1280`);
    await page.setViewportSize({ width: 360, height: 1000 });
    await shot(page, `${name}-light-360`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(`${name}: 幅 360 で横にあふれない`, !overflow);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  /** ある文字が出るまで待つ（plusSyncStatus 出来事で描き直される） */
  async function waitText(sel, text, ms = 30_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const tx = await page.locator(sel).innerText().catch(() => '');
      if (tx.includes(text)) return tx;
      if (Date.now() > deadline) throw new Error(`「${text}」が ${sel} に出ない（今: ${tx.slice(0, 120)}）`);
      await page.waitForTimeout(200);
    }
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForSelector('#settingsView:not([hidden])');
  // 起動の直後（ログインの出来事を起こす前）に、設定の「Pleiad Plus」の項目が出る
  await page.waitForSelector('#plusTab:not([hidden])');
  ok('起動直後: 出来事を起こさなくても Pleiad Plus の項目が出る', true);
  const openPlus = async () => { await page.locator('#plusTab').click(); await page.waitForSelector('#plusPanel:not([hidden])'); };
  await openPlus();

  // 未ログイン: 「同期」のまとまりは無い
  ok('未ログイン: 「同期」のまとまりは出さない', !(await page.locator('#plusSyncSection').count()), '');

  // ---- ログイン（free）→「同期」は出さない ----
  plus.state.accounts[UID] = { uid: UID, email: 'user@example.com', provider: 'google.com', status: 'free', plan: null, limits: null, usage: null, sync: null };
  plus.state.nextLogin = { uid: UID, email: 'user@example.com' };
  await page.locator('#plusPanel button:has-text("ログイン")').first().click();
  const loginUrl = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    (async () => { for (;;) {
      const lines = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length) return resolve(lines.at(-1));
      if (Date.now() > deadline) return reject(new Error('open-external が来ない'));
      await new Promise(r => setTimeout(r, 50));
    } })();
  });
  const ext = await ctx.newPage();
  await ext.goto(loginUrl);
  await page.waitForSelector('#plusPanel :text("無料")', { timeout: 15_000 });
  await ext.close();
  ok('free: 「同期」のまとまりは出さない', !(await page.locator('#plusSyncSection').count()), '');

  // ---- plus + waiting_key（自分宛てが無い）。上限は下げておき、やり直しの後の最初の上げで quota にする ----
  plus.state.accounts[UID] = PLUS_ACCOUNT;
  seedWaitingKey();
  plus.state.syncLimitBytes = 10;
  await page.locator('#plusPanel button:has-text("ログアウト")').click();
  await page.waitForSelector('#plusPanel :text("ログインしていません")');
  await page.locator('#plusPanel button:has-text("ログイン")').first().click();
  {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lines = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length >= 2) { const ext2 = await ctx.newPage(); await ext2.goto(lines.at(-1)); await ext2.close(); break; }
      if (Date.now() > deadline) throw new Error('2 回目の open-external が来ない');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  await page.waitForSelector('#plusSyncSection', { timeout: 20_000 });
  ok('plus: 「同期」のまとまりが出る（見出し・スイッチ・同期するもの）', (await syncText(page)).includes('同期') && (await syncText(page)).includes('設定・skill・指示ファイルを同期する'));
  const waitTx = await waitText('#plusSyncSection', 'ほかの PC が鍵を渡すのを待っています', 60_000);
  ok('waiting_key: 文と下の案内と「同期をやり直す」', waitTx.includes('別の PC で Pleiad を開いてください') && waitTx.includes('同期をやり直す'), waitTx);
  await shots(page, 'waiting-key');

  // 「同期をやり直す」→ 確かめ → やめる（何も送らない）
  await page.locator('#plusSyncSection button:has-text("同期をやり直す")').click();
  const confirmTx = await waitText('#plusSyncSection', '同期をやり直しますか？');
  ok('確かめ: 題と本文と 2 ボタン', confirmTx.includes('サーバーから消して、この PC の内容で始め直します') && confirmTx.includes('やめる'), confirmTx);
  await shots(page, 'reset-confirm');
  const resetsBefore = plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length;
  await page.locator('#plusSyncSection button:has-text("やめる")').click();
  await page.waitForTimeout(500);
  ok('やめる: reset は飛ばない', plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length === resetsBefore);

  // 「やり直す」→ POST /v1/sync/reset → 新しい鍵で始まる（waiting_key → idle）
  await page.locator('#plusSyncSection button:has-text("同期をやり直す")').click();
  await page.locator('#plusSyncSection button:has-text("やり直す")').click();
  {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (plus.state.syncBodies.some(b => b.method === 'POST' && b.path === '/v1/sync/reset')) break;
      if (Date.now() > deadline) { ok('やり直す: POST /v1/sync/reset が飛ぶ', false); break; }
      await new Promise(r => setTimeout(r, 100));
    }
    ok('やり直す: POST /v1/sync/reset が飛ぶ', plus.state.syncBodies.some(b => b.method === 'POST' && b.path === '/v1/sync/reset'));
  }
  // やり直しのあとの最初の同期で、上限を越える PUT が 413 → quota
  const quotaTx = await waitText('#plusSyncSection', '同期の容量の上限に達しました', 60_000);
  ok('quota: 上限・使用量・送られない・「同期をやり直す」', quotaTx.includes('/ 0.0 MB') && quotaTx.includes('新しく変えたものは送られません') && quotaTx.includes('同期をやり直す'), quotaTx);
  await shots(page, 'quota');

  // 上限を戻して、手元の変更（skill を足す → fs.watch → 5 秒まとめて run）で idle へ
  plus.state.syncLimitBytes = 7_340_032;
  const touchSkill = async (name) => {
    const dir = path.join(dataDir, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
    await page.waitForTimeout(9000);
  };
  await touchSkill('skill-a');
  const idleTx = await waitText('#plusSyncSection', '最後の同期:', 60_000);
  ok('idle: 「最後の同期: 」と「今すぐ同期」「同期をやり直す」', idleTx.includes('今すぐ同期') && idleTx.includes('同期をやり直す'), idleTx);
  ok('競合の写し 1 件: 行と「フォルダーを開く」と 30 日', idleTx.includes('1 件の古い方を残しました') && idleTx.includes('フォルダーを開く') && idleTx.includes('30 日で消えます'), idleTx);
  await shots(page, 'idle-conflicts');
  // 「フォルダーを開く」（AGENT_HOST_OS_OPEN=dry で成功。失敗の文言が出ないことだけ見る）
  await page.locator('#plusSyncSection button:has-text("フォルダーを開く")').click();
  await page.waitForTimeout(500);
  ok('「フォルダーを開く」: 失敗の文言は出ない', !(await syncText(page)).includes('変えられませんでした'));

  // ---- スイッチの入り切り（PATCH /v1/account） ----
  const patchCalls = () => plus.state.calls.filter(c => c.method === 'PATCH' && c.path === '/v1/account');
  const before = patchCalls().length;
  await page.locator('#plusSyncSection [data-fk="syncToggle"]').click();
  {
    const deadline = Date.now() + 10_000;
    for (;;) { if (patchCalls().length > before) break; if (Date.now() > deadline) throw new Error('PATCH が来ない'); await new Promise(r => setTimeout(r, 50)); }
  }
  ok('スイッチを切る: PATCH /v1/account が飛ぶ', patchCalls().length > before);
  ok('PATCH の本文は {sync:{enabled:false}}', plus.state.accounts[UID]?.sync?.enabled === false, JSON.stringify(plus.state.accounts[UID]?.sync));
  // エンジンが次の回で sync_disabled → disabled を待ってから、状態の行が消えることを見る
  {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const tx = await syncText(page);
      if (!tx.includes('最後の同期')) break;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(300);
    }
  }
  const offTx = await syncText(page);
  ok('切ったあと: 状態の行は出さない（スイッチだけ残る）', !offTx.includes('最後の同期') && !offTx.includes('同期できませんでした'), offTx);
  await shots(page, 'sync-off');
  // 入れ直す
  await page.locator('#plusSyncSection [data-fk="syncToggle"]').click();
  await waitText('#plusSyncSection', '最後の同期:', 60_000);
  ok('入れ直す: sync.enabled が true に戻る', plus.state.accounts[UID]?.sync?.enabled === true);
  // PATCH の失敗 → スイッチが戻って「変えられませんでした」
  failPatch = true;
  await page.locator('#plusSyncSection [data-fk="syncToggle"]').click();
  await waitText('#plusSyncSection', '変えられませんでした');
  ok('PATCH の失敗: 戻して「変えられませんでした」', (await syncText(page)).includes('変えられませんでした') && plus.state.accounts[UID]?.sync?.enabled === true);
  failPatch = false;

  // ---- error（503 unavailable。手元の変更で run を起こす） ----
  plus.state.syncFail.push({ method: 'GET', path: /^\/v1\/sync\/items/, status: 503, code: 'unavailable', count: 200 });
  await touchSkill('skill-b');
  const errTx = await waitText('#plusSyncSection', '同期できませんでした', 60_000);
  ok('error: 「同期できませんでした」と「サーバーにつながりません」と「今すぐ同期」', errTx.includes('サーバーにつながりません') && errTx.includes('今すぐ同期'), errTx);
  await shots(page, 'error');
  plus.state.syncFail.length = 0;

  await ctx.close();

  // ---- 英語の画面。言語はサーバーの ready.locale が決めるので、AGENT_HOST_LOCALE=en で立て直す（dataDir は同じ: ログインを引き継ぐ） ----
  {
    await server.stop();
    server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
      env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile, AGENT_HOST_OS_OPEN: 'dry',
        CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude'), CODEX_HOME: path.join(dataDir, 'codex'), AGENT_HOST_LOCALE: 'en' } });
    const url2 = `http://127.0.0.1:${server.port}/?token=${server.token}`;
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'en-US' });
    const page2 = await ctx2.newPage();
    const pageErrs = [];
    page2.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));
    page2.on('console', m => { if (m.type() === 'error') pageErrs.push(`console: ${m.text().slice(0, 200)}`); });
    let loads = 0;
    page2.on('load', () => loads++);
    await page2.goto(url2, { waitUntil: 'load' });
    // ready.locale（en）の適用で 1 回リロードされる。最終の DOM（<html lang="en">）を待つ
    await page2.waitForFunction(() => document.documentElement.lang === 'en', { timeout: 30_000 });
    {
      const dl = Date.now() + 30_000;
      let prev = -1, quiet = 0;
      while (Date.now() < dl) {
        if (loads === prev) { if ((quiet += 300) >= 2500) break; } else { prev = loads; quiet = 0; }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    await page2.evaluate(() => document.getElementById('onboardingDialog')?.close()).catch(() => {});
    await page2.evaluate(() => document.getElementById('settings')?.click());
    await page2.waitForSelector('#settingsView:not([hidden])', { timeout: 15_000 });
    // 起動直後の取得は ready の後に送るので、ログインの出来事を起こさなくても tab は出る
    await page2.waitForSelector('#plusTab:not([hidden])', { timeout: 15_000 });
    ok('en: 出来事を起こさなくても Pleiad Plus の項目が出る', true);
    // 続きの場面はログインしていない状態から。logout で状態を戻す
    { const c = await openWs({ port: server.port, token: server.token });
      try { await c.cmd('plusLogout'); } finally { c.ws.close(); } }
    try {
      await page2.locator('#plusTab').click();
      await page2.waitForSelector('#plusPanel:not([hidden])', { timeout: 15_000 });
      // ログインし直す（外のブラウザーで開く → 偽の Plus の /login → 戻る）
      await page2.waitForSelector('#plusPanel button:has-text("Sign in")', { timeout: 15_000 });
      await page2.locator('#plusPanel button:has-text("Sign in")').first().click();
      const deadline = Date.now() + 30_000;
      let done = false;
      while (!done && Date.now() < deadline) {
        const lines = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
        if (lines.length) {
          const loginUrl = lines.at(-1);
          const ext2 = await ctx2.newPage();
          try { await ext2.goto(loginUrl); done = true; } catch { /* 偽の Plus がまだ受け付けていなければ試し直す */ }
          await ext2.close();
        }
        if (!done) await new Promise(r => setTimeout(r, 500));
      }
      if (!done) throw new Error('open-external のページを開けない');
      await page2.waitForSelector('#plusSyncSection', { timeout: 30_000 });
    } catch (e) {
      console.log(`  page2 の失敗（loads=${loads}）: ${pageErrs.join(' | ') || '画面のエラーなし'}`);
      throw e;
    }
    const tx2 = await page2.locator('#plusSyncSection').innerText();
    ok('en: 見出し Sync とスイッチの文言', tx2.includes('Sync') && tx2.includes('Sync settings, skills and instructions'), tx2.slice(0, 200));
    await shots(page2, 'en');
    await ctx2.close();
  }
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await plus.close().catch(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log('\n全て通過');
