// 設定 › Pleiad Plus の同期。偽の Plus と隔離した PC で承認済みの 5 場面を通す。
// ホームと CLAUDE_CONFIG_DIR は試験の置き場に向ける（本物の ~/.claude には触らない）。
// 実行: node tests/browser/plus-sync-admission.mjs   （PLUS_SYNC_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。明暗 × 1280/360）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-plus-adm-'));
const plus = await startFakePlus();
const servers = [];
let browser, failures = 0, checks = 0;
const ok = (name, cond, extra = '') => { checks++; console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const UID = 'user-1';
const PLUS_ACCOUNT = { uid: UID, email: 'user@example.com', provider: 'google.com', status: 'plus',
  plan: { name: 'Pleiad Plus' }, limits: { hosts: 10, creditsPerMonth: 500 }, usage: { credits: 10, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: true } };
const ledger = () => plus.state.sync[UID];
/** 隔離した Pleiad を 1 台立て、設定 › Pleiad Plus を開いてログインする。登録された PC の名前を name にする */
async function startPc(label, name) {
  const dataDir = path.join(scratch, label);
  const home = path.join(dataDir, 'home');
  for (const d of ['.claude/skills', '.codex', '.agents/skills', '.gemini']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'onboarding.json'), JSON.stringify({ seen: true, setupComplete: true }));
  const captureFile = path.join(dataDir, 'external.log');
  const server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile, AGENT_HOST_OS_OPEN: 'dry',
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      // PC の名前（試験を回す PC のホスト名を画面に出さない）
      NODE_OPTIONS: `--import="${pathToFileURL(path.join(ROOT, 'tests', 'lib', 'hostname-preload.mjs')).href}"`, PLEIAD_TEST_HOSTNAME: name } });
  servers.push(server);
  const command = async (op, args) => {
    const client = await openWs(server);
    try { return await client.cmd(op, args); } finally { client.ws.close(); }
  };
  await command('authLogin', { backend: 'fake' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();
  const pc = { label, page, ctx, hostId: null };
  pc.sync = () => command('invoke', { op: 'plus.syncNow', args: {} });

  const shot = async file => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sync-key-${file}.png`) }); };
  pc.shot = shot;
  pc.shots = async (shotName, { only1280 = false } = {}) => {
    if (!SHOTS) return;
    await page.mouse.move(1270, 890);
    await page.waitForTimeout(400);
    await shot(`${shotName}-light-1280`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(600);
    await shot(`${shotName}-dark-1280`);
    if (!only1280) {
      await page.setViewportSize({ width: 360, height: 900 });
      await page.waitForTimeout(200);
      await shot(`${shotName}-dark-360`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(600);
    if (!only1280) {
      await shot(`${shotName}-light-360`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      ok(`${shotName}: 幅 360 で横にあふれない`, !overflow);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
    }
  };
  pc.waitText = async (sel, text, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const tx = await page.locator(sel).innerText().catch(() => '');
      if (tx.includes(text)) return tx;
      if (Date.now() > deadline) await page.screenshot({ path: path.join(process.env.ADM_DEBUG_DIR || scratch, `fail-${label}.png`) }).catch(() => {});
      if (Date.now() > deadline) throw new Error(`${label}: 「${text}」が ${sel} に出ない（今: ${tx.slice(0, 200)}）`);
      await page.waitForTimeout(200);
    }
  };
  pc.click = async (sel, ms = 30_000) => {
    try { await page.locator(sel).first().click({ timeout: ms }); } catch (e) {
      await page.screenshot({ path: path.join(process.env.ADM_DEBUG_DIR || scratch, `fail-${label}.png`) }).catch(() => {});
      const tx = await page.locator('#plusSyncSection').innerText({ timeout: 1000 }).catch(() => '(無い)');
      throw new Error(`${label}: ${sel} を押せない（同期の節: ${tx.slice(0, 300)}）`);
    }
  };
  pc.openPlus = async () => {
    await page.waitForSelector('html[data-agent-gate]', { state: 'attached' });
    const button = await page.locator('#onboardingDialog').evaluate(dialog => dialog.open) ? '#onboardingGear' : '#settings';
    await page.locator(button).click();
    await page.waitForSelector('body.settings #settingsView');
    await page.waitForSelector('#plusTab:not([hidden])');
    await page.locator('#plusTab').click();
    await page.waitForSelector('#plusPanel:not([hidden])');
  };
  pc.reregister = async () => {
    const before = pc.hostId;
    await pc.click('#plusPanel [data-fk="hostReregister"]');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = Object.values(plus.state.hosts).find(h => h.uid === UID && h.name === name);
      if (match) { pc.hostId = match.hostId; return before !== pc.hostId; }
      await page.waitForTimeout(100);
    }
    throw new Error(`${label}: 登録が戻らない`);
  };

  pc.login = async selector => {
    const opened = () => fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
    const count = opened().length;
    plus.state.nextLogin = { uid: UID, email: 'user@example.com' };
    await pc.click(selector);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lines = opened();
      if (lines.length > count) {
        const ext = await ctx.newPage();
        try { await ext.goto(lines.at(-1)); } finally { await ext.close(); }
        return;
      }
      if (Date.now() > deadline) throw new Error(`${label}: open-external が来ない`);
      await new Promise(r => setTimeout(r, 50));
    }
  };
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await pc.openPlus();
  const before = new Set(Object.keys(plus.state.hosts));
  await pc.login('#plusPanel [data-fk="login"]');
  {
    const deadline = Date.now() + 20_000;
    while (!pc.hostId) {
      pc.hostId = Object.keys(plus.state.hosts).find(id => !before.has(id) && plus.state.hosts[id].uid === UID) ?? null;
      if (!pc.hostId && Date.now() > deadline) throw new Error(`${label}: 台帳に載らない`);
      if (!pc.hostId) await page.waitForTimeout(100);
    }
  }
  await page.waitForSelector('#plusSyncSection', { timeout: 20_000 });
  return pc;
}

try {
  plus.state.accounts[UID] = PLUS_ACCOUNT;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  const old = await startPc('old-desk', 'OLD-DESK');
  await old.waitText('#plusSyncSection', '同期済み');
  const keyBefore = ledger().keyId;
  Object.assign(ledger(), {
    items: { a: { rev: 1 }, b: { rev: 1 }, c: { rev: 1 } }, totalBytes: 2_400_000,
    lastWriteAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastWriterHostId: old.hostId,
  });
  plus.unbindHost(old.hostId, 'user');

  // 02: 本番の待機時間は単体試験で検証する。ここでは通常のタイマーを待てる長さにする。
  plus.state.restartWaitMs = 18_000;
  plus.state.clockOffsetMs = 6 * 60_000;
  const desk = await startPc('desk', 'DESKTOP-3');
  const relogin = '#plusSyncSection [data-fk="syncRelogin"]';
  await desk.page.waitForSelector(relogin);
  ok('02: 最近のログインが必要な場合は始め直しの依頼を出さない', !ledger().recovery);
  plus.state.clockOffsetMs = 0;
  await desk.login(relogin);
  let tx = await desk.waitText('#plusSyncSection', 'に始まります');
  ok('02: 操作なしで準備を始め、スイッチの行に開始時刻を表示する',
    tx.includes('準備しています') && ledger().recovery?.requestedBy === desk.hostId
    && ledger().recovery?.auto === false && await desk.page.locator('#plusSyncSection .sync-row .sync-st').count() === 1, tx);
  ok('02: データがある状態で待ち、リセットの操作を表示しない', ledger().keyId === keyBefore
    && !(await desk.page.locator('#plusSyncSection [data-fk="syncReset"]').count()));
  await desk.shots('02-preparing');
  await desk.waitText('#plusSyncSection', '同期済み', 60_000);
  ok('02: 待ちが明けると操作なしで同期を始め直す', ledger().keyId !== keyBefore && !ledger().recovery && !!ledger().keys[desk.hostId]);
  await desk.shots('01-synced');
  plus.state.restartWaitMs = 24 * 3_600_000;

  // 03: 新しい PC の同期を、数字を見比べて許可する。
  const lap = await startPc('lap', 'LAPTOP-7');
  tx = await lap.waitText('#plusSyncSection', 'ほかの PC の許可を待っています');
  ok('03: 利用する PC を案内し、許可を受けるまでは同期しない',
    tx.includes('DESKTOP-3 で Pleiad を開いてください') && !ledger().keys[lap.hostId], tx);
  await lap.shots('03-waiting');

  // desk が気づく（今すぐ同期）→ 申し込みに挑戦 → lap が明かす → 両方に確認コード
  await desk.page.locator('#plusSyncSection [data-fk="syncNow"]').click();
  await desk.page.waitForSelector('#plusSyncApproval[open]', { timeout: 60_000 });
  tx = await lap.waitText('#plusSyncSection', 'DESKTOP-3 の画面で、この数字を確かめて許可してください', 60_000);
  const lapCode = (await lap.page.locator('#plusSyncSection .sync-code').innerText()).trim();
  const deskCode = (await desk.page.locator('#plusSyncApproval .rm-dialog-code').innerText()).trim();
  ok('確認コード: lap と desk の窓に同じ 6 桁（3 桁ずつ）', /^\d{3} \d{3}$/.test(lapCode) && lapCode === deskCode, `${lapCode} / ${deskCode}`);
  const dlg = await desk.page.locator('#plusSyncApproval').innerText();
  ok('desk の承認の窓: 題・PC の種類と版・見比べる案内・渡さない・渡す',
    dlg.includes('「LAPTOP-7」の同期を許可しますか？') && /Windows · \d+\.\d+/.test(dlg) && dlg.includes('同じ数字が出ている') && dlg.includes('許可しない') && dlg.includes('許可する'), dlg);
  await lap.shots('03-code');
  await desk.shots('03-approval');

  // 通知の一覧（窓を閉じて見る。同じ申し込みのままなら次の描き直しで開き直す）
  await desk.page.evaluate(() => document.getElementById('plusSyncApproval')?.close());
  await desk.page.locator('#backToChat').click();
  await desk.page.locator('#notifBell').click();
  const notifTx = await desk.waitText('#notifPanel', 'LAPTOP-7 が同期の許可を待っています', 15_000);
  ok('通知: あなた待ちに 1 行・場所は「設定 › Pleiad Plus」', notifTx.includes('設定 › Pleiad Plus'), notifTx.slice(0, 300));
  await desk.shots('approval-notice', { only1280: true });
  await desk.page.locator('#notifPanel .nrow', { hasText: '同期の許可を待っています' }).first().click();
  await desk.page.waitForSelector('#plusPanel:not([hidden])', { timeout: 10_000 });
  if (!(await desk.page.locator('#plusSyncApproval[open]').count())) {
    await desk.page.locator('#plusSyncSection [data-fk="syncNow"]').click();
    await desk.page.waitForSelector('#plusSyncApproval[open]', { timeout: 30_000 });
  }
  ok('通知から開くと承認の窓が出る', (await desk.page.locator('#plusSyncApproval[open]').count()) === 1);

  await desk.page.locator('#plusSyncApproval [data-fk="syncApproveYes"]').click();
  await desk.page.waitForSelector('#plusSyncApproval', { state: 'hidden', timeout: 15_000 });
  await lap.waitText('#plusSyncSection', '同期済み', 60_000);
  ok('渡す: lap が今の鍵を受け取り、同期する', !!ledger().keys[lap.hostId] && ledger().keys[lap.hostId].keyId === ledger().keyId);
  tx = await desk.waitText('#plusSyncSection', 'LAPTOP-7 の同期を許可しました', 15_000);
  await desk.shots('03-approved');

  // ================= 3. この版では使えない api（426） =================
  // lap の券の要求だけに返す（裏の回が先に受けたら、押さずにその画面を見る）
  plus.state.syncFail.push({ path: /^\/v1\/sync\//, hostId: lap.hostId, status: 426, code: 'update_required', message: 'update required', count: 1 });
  await lap.page.locator('#plusSyncSection [data-fk="syncNow"]').click({ timeout: 5_000 }).catch(() => {});
  tx = await lap.waitText('#plusSyncSection', 'この版の Pleiad では同期を続けられません', 30_000);
  ok('426: 更新を促す。「今すぐ同期」は出さない', tx.includes('新しい版に更新すると') && !(await lap.page.locator('#plusSyncSection [data-fk="syncNow"]').count()), tx);
  await lap.shots('update-required');

  // 04: 前の PC は、自分が知っている PC だと確かめてから申し込める。
  await old.click('#plusSyncSection [data-fk="syncNow"]');
  await old.waitText('#plusPanel', '登録から外されています');
  ok('04: 1 回の操作で新しい登録に戻る', await old.reregister());
  tx = await old.waitText('#plusSyncSection', 'DESKTOP-3 で同期が始め直されました');
  ok('04: 自動で加わらず、相手の名前と案内を表示する',
    tx.includes('知らない PC なら押さないでください') && !ledger().joins?.[old.hostId], tx);
  await old.shots('04-restarted');
  await old.click('#plusSyncSection [data-fk="syncAcceptRestart"]');
  await old.waitText('#plusSyncSection', 'ほかの PC の許可を待っています');
  ok('04: 一度選ぶと許可の申し込みに進む', Boolean(ledger().joins?.[old.hostId]));
  plus.unbindHost(old.hostId, 'user');

  // 05: 前の PC に出る知らせから、待機中の始め直しを止めて登録し直す。
  plus.unbindHost(lap.hostId, 'user');
  plus.unbindHost(desk.hostId, 'user');
  const next = await startPc('next', 'NEW-PC');
  await next.waitText('#plusSyncSection', 'に始まります');
  await desk.click('#plusSyncSection [data-fk="syncNow"]');
  tx = await desk.waitText('#plusPanel', 'NEW-PC が同期を始め直そうとしています');
  ok('05: 登録が外れた PC に知らせと止める操作を表示する',
    tx.includes('心当たりがなければ止めてください') && tx.includes('この PC を登録し直す') && !tx.includes('鍵'), tx);
  await desk.shots('05-recovery-alert');
  await desk.page.locator('#backToChat').click();
  await desk.page.locator('#notifBell').click();
  const recTx = await desk.waitText('#notifPanel', 'NEW-PC が同期を始め直そうとしています');
  ok('05: 通知から設定に戻れる', recTx.includes('設定 › Pleiad Plus'), recTx);
  await desk.shots('05-recovery-notice');
  await desk.page.locator('#notifPanel .nrow', { hasText: '同期を始め直そうとしています' }).first().click();
  await desk.click('#plusSyncSection [data-fk="syncRecoveryStop"]');
  await desk.waitText('#plusSyncSection', '止めました');
  ok('05: 今の鍵の署名で始め直しを取り消す', !ledger().recovery);
  await next.sync();
  await next.waitText('#plusSyncSection', 'ほかの PC の許可を待っています');
  ok('05: 1 回の操作で新しい登録に戻る', await desk.reregister());
  await desk.waitText('#plusSyncSection', '同期済み');
  await next.sync();
  await next.waitText('#plusSyncSection', 'DESKTOP-3 で Pleiad を開いてください');
  ok('05: 再登録した PC がそのまま同期し、新しい PC は許可へ進む',
    ledger().keyId !== keyBefore && Boolean(ledger().keys[desk.hostId]) && Boolean(ledger().joins?.[next.hostId]));
  if (SHOTS) {
    // 一覧の応答を撮る間だけ待たせ、同期中の表示を通常の同期経路で確かめる。
    const { promise, resolve } = Promise.withResolvers();
    plus.route('GET', '/v1/sync/items', async (_req, res) => {
      await promise;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [], seq: ledger().seq, totalBytes: ledger().totalBytes }));
    });
    try {
      await desk.click('#plusSyncSection [data-fk="syncNow"]');
      await desk.waitText('#plusSyncSection', '同期しています…');
      await desk.shots('01-syncing');
    } finally { resolve(); }
  }
  for (const pc of [desk, lap, old, next]) {
    const panel = await pc.page.locator('#plusPanel').textContent();
    ok(`${pc.label}: Pleiad Plus の設定に「鍵」を表示しない`, !panel.includes('鍵'), panel);
    await pc.ctx.close();
  }
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) await s.stop().catch(() => {});
  await plus.close().catch(() => {});
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log(`\n全て通過 ${checks} 件`);
