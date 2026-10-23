// 同期の鍵の受け渡しの承認と同期のリセット（docs/plus.md「同期の鍵の受け渡し」）。実ブラウザーで、偽の Plus（tests/lib/fake-plus.mjs）を相手に
// 隔離した Pleiad を 2 台（desk・lap）立て、本物の同期のエンジンで次を見る:
//   1. 鍵を持つ PC が 1 台も残っていない desk: リセットを頼む → 待つ → 待ちが明けて新しい鍵で始め直す
//   2. 新しい PC の lap: 承認を待つ（「鍵を持つ PC が使えないとき」）→ 両方に同じ確認コード → desk の承認の窓と通知の行 → 渡す
//   3. この版では使えない api（426）: 更新を促す
//   4. 外された desk が今の鍵を持っていて、ほかの PC がリセットを頼んだ: 知らせ（通知の一覧にも残る）と「リセットを止める」
// 鍵の仕組みそのもの（断る・承認の途中から戻る・外した PC の締め出し・移行・券）は tests/unit/plus-sync-admission.mjs が見る。
// ホームと CLAUDE_CONFIG_DIR は試験の置き場に向ける（本物の ~/.claude には触らない）。
// 実行: node tests/browser/plus-sync-admission.mjs   （PLUS_SYNC_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。明暗 × 1280/360）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createSyncKeys } from '../../core/plus/sync/keys.mjs';
import { createSyncTicket } from '../../core/plus/sync/ticket.mjs';
import { b64url } from '../../core/plus/sync/crypto.mjs';
import { generateKeyPair, hostIdFor } from '../../core/remote/noise.mjs';

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
let browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const UID = 'user-1';
const PLUS_ACCOUNT = { uid: UID, email: 'user@example.com', provider: 'google.com', status: 'plus',
  plan: { name: 'Pleiad Plus' }, limits: { hosts: 10, creditsPerMonth: 500 }, usage: { credits: 10, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: true } };
const ledger = () => plus.state.sync[UID];
const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: path.join(scratch, 'cfg'), appVersion: 'test' });
let hostSeq = 0;

/** 画面の無い PC 1 台（台帳に載せ、自分の secret-store・券・keys を持つ） */
async function scriptedHost(label, name) {
  const id = generateKeyPair();
  const hostId = hostIdFor(id.publicKey);
  const identity = { hostId, publicKey: id.publicKey, privateKey: id.privateKey };
  const secrets = createSecretStore({ file: path.join(scratch, label, 'plus-secrets.json'), cipher: plainCipher });
  const client = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(UID), appVersion: '0.34.0' });
  const ticket = createSyncTicket({ client, identity: async () => identity });
  const keys = createSyncKeys({ client, ticket, secrets, uid: () => UID, hostId: () => hostId, log: () => {}, onShared: () => {} });
  plus.state.hosts[hostId] = {
    hostId, uid: UID, publicKey: b64url(id.publicKey), name, platform: 'win32', online: false, lastSeenAt: null, syncPublicKey: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++hostSeq)).toISOString(), deviceCount: 0, appVersion: '0.34.0',
  };
  return { hostId, keys };
}

/** 隔離した Pleiad を 1 台立て、設定 › Pleiad Plus を開いてログインする。登録された PC の名前を name にする */
async function startPc(label, name) {
  const dataDir = path.join(scratch, label);
  const home = path.join(dataDir, 'home');
  for (const d of ['.claude/skills', '.codex', '.agents/skills', '.gemini']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
  const captureFile = path.join(dataDir, 'external.log');
  const server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile, AGENT_HOST_OS_OPEN: 'dry',
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      // PC の名前（試験を回す PC のホスト名を画面に出さない）
      NODE_OPTIONS: `--import="${pathToFileURL(path.join(ROOT, 'tests', 'lib', 'hostname-preload.mjs')).href}"`, PLEIAD_TEST_HOSTNAME: name } });
  servers.push(server);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();
  const pc = { label, page, ctx, hostId: null };

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
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector('#plusTab:not([hidden])');
    await page.locator('#plusTab').click();
    await page.waitForSelector('#plusPanel:not([hidden])');
  };

  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await pc.openPlus();
  const before = new Set(Object.keys(plus.state.hosts));
  plus.state.nextLogin = { uid: UID, email: 'user@example.com' };
  await page.locator('#plusPanel button:has-text("ログイン")').first().click();
  {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lines = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length) { const ext = await ctx.newPage(); await ext.goto(lines.at(-1)); await ext.close(); break; }
      if (Date.now() > deadline) throw new Error(`${label}: open-external が来ない`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
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

  // ================= 1. 鍵を持つ PC が 1 台も残っていない: 同期のリセット =================
  // 前に使っていた PC（OLD-DESK）が最初の鍵を作り、3 件を同期してから、アカウントのページで外された
  const oldDesk = await scriptedHost('old-desk', 'OLD-DESK');
  const first = await oldDesk.keys.setup();
  ok('前提: OLD-DESK が最初の鍵を作る', first.status === 'ready' && first.v2 === true, first.status);
  Object.assign(ledger(), {
    items: { a: { rev: 1 }, b: { rev: 1 }, c: { rev: 1 } }, totalBytes: 2_400_000,
    lastWriteAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastWriterHostId: oldDesk.hostId,
  });
  plus.unbindHost(oldDesk.hostId, 'user');

  const desk = await startPc('desk', 'DESKTOP-3');
  let tx = await desk.waitText('#plusSyncSection', '鍵を持つ PC がありません', 60_000);
  ok('desk: 「鍵を持つ PC がありません」・72 時間の待ち・消えるもの。経緯の記録（外れた PC の名前など）は出さない',
    tx.includes('リセットは 72 時間後にできます') && tx.includes('サーバーの同期のデータ（約 2.3 MB・3 件）は消えます')
      && !tx.includes('OLD-DESK') && !tx.includes('登録から外れています') && !tx.includes('最後の更新'), tx);
  ok('desk: 鍵を持たない PC の「消して始め直す」は出ない', !tx.includes('鍵を持つ PC が使えないとき') && !(await desk.page.locator('#plusSyncSection [data-fk="syncReset"]').count()), tx);
  await desk.shots('recovery-ask');

  await desk.page.locator('#plusSyncSection [data-fk="syncRecoveryRequest"]').click();
  tx = await desk.waitText('#plusSyncSection', 'リセットを待っています', 15_000);
  ok('リセットを頼む: サーバーにリセットの申し出（この PC・72 時間後）', ledger().recovery?.requestedBy === desk.hostId
    && Math.abs(Date.parse(ledger().recovery.readyAt) - Date.now() - 72 * 3_600_000) < 120_000, JSON.stringify(ledger().recovery));
  ok('待っている間: 「取り下げる」だけで、リセットのボタンは出ない', tx.includes('取り下げる') && !tx.includes('同期をリセット'), tx);
  await desk.shots('recovery-waiting');

  // 待ちを 0 にして頼み直す（取り下げる → 頼む）: 待ちが明けた形
  await desk.page.locator('#plusSyncSection [data-fk="syncRecoveryCancel"]').click();
  await desk.waitText('#plusSyncSection', '同期をリセット', 15_000);
  ok('取り下げる: サーバーのリセットの申し出が消える', !ledger().recovery, JSON.stringify(ledger().recovery));
  plus.state.recoveryWaitMs = 0;
  await desk.page.locator('#plusSyncSection [data-fk="syncRecoveryRequest"]').click();
  tx = await desk.waitText('#plusSyncSection', '待ちは終わりました', 15_000);
  ok('待ちが明けた: 「同期をリセット」と「取り下げる」', tx.includes('リセットできます') && tx.includes('同期をリセット') && tx.includes('取り下げる'), tx);
  await desk.shots('recovery-ready');

  await desk.page.locator('#plusSyncSection [data-fk="syncReset"]').click();
  tx = await desk.waitText('#plusSyncSection', '同期をリセットしますか？', 10_000);
  ok('始め直しの確かめ: 消えるもの（3 件）・消えないもの・ほかの PC は承認で受け取る。チェックの前は押せない',
    tx.includes('3 件') && tx.includes('消えないもの') && tx.includes('この PC の画面で承認すると')
    && await desk.page.locator('#plusSyncSection [data-fk="syncResetYes"]').isDisabled(), tx);
  await desk.shots('recovery-confirm');
  const keyBefore = ledger().keyId;
  await desk.page.locator('#plusSyncSection [data-fk="syncResetCheck"]').check();
  await desk.page.locator('#plusSyncSection [data-fk="syncResetYes"]').click();
  await desk.waitText('#plusSyncSection', '最後の同期:', 60_000);
  ok('始め直した: 新しい鍵・リセットの申し出は消える・desk が鍵を持つ', ledger().keyId !== keyBefore && !ledger().recovery && !!ledger().keys[desk.hostId], ledger().keyId);
  plus.state.recoveryWaitMs = 72 * 3_600_000;

  // ================= 2. 新しい PC: 承認を通した鍵の受け渡し =================
  const lap = await startPc('lap', 'LAPTOP-7');
  tx = await lap.waitText('#plusSyncSection', '鍵を持つ PC の承認を待っています', 60_000);
  ok('lap: 承認を待つ。鍵を持つ PC の名前で案内', tx.includes('DESKTOP-3 で Pleiad を開くと'), tx);
  ok('lap: 受け取る前は鍵を渡されていない', !ledger().keys[lap.hostId], JSON.stringify(Object.keys(ledger().keys)));
  await lap.shots('join-waiting');
  await lap.page.locator('#plusSyncSection [data-fk="syncReset"]').click();
  tx = await lap.waitText('#plusSyncSection', '手元に無い PC は、アカウントのページで外してください', 10_000);
  ok('lap:「鍵を持つ PC が使えないとき」は外し方とリセットの説明。始め直しのボタンは無い',
    tx.includes('72 時間待ってから') && !(await lap.page.locator('#plusSyncSection [data-fk="syncResetYes"]').count()), tx);
  await lap.shots('join-help');
  await lap.page.locator('#plusSyncSection [data-fk="syncHelpClose"]').click();

  // desk が気づく（今すぐ同期）→ 申し込みに挑戦 → lap が明かす → 両方に確認コード
  await desk.page.locator('#plusSyncSection [data-fk="syncNow"]').click();
  await desk.page.waitForSelector('#plusSyncApproval[open]', { timeout: 60_000 });
  tx = await lap.waitText('#plusSyncSection', 'DESKTOP-3 の画面で承認してください', 60_000);
  const lapCode = (await lap.page.locator('#plusSyncSection .sync-code').innerText()).trim();
  const deskCode = (await desk.page.locator('#plusSyncApproval .rm-dialog-code').innerText()).trim();
  ok('確認コード: lap と desk の窓に同じ 6 桁（3 桁ずつ）', /^\d{3} \d{3}$/.test(lapCode) && lapCode === deskCode, `${lapCode} / ${deskCode}`);
  const dlg = await desk.page.locator('#plusSyncApproval').innerText();
  ok('desk の承認の窓: 題・PC の種類と版・見比べる案内・渡さない・渡す',
    dlg.includes('「LAPTOP-7」に同期の鍵を渡しますか？') && /Windows · \d+\.\d+/.test(dlg) && dlg.includes('同じ数字が出ている') && dlg.includes('渡さない') && dlg.includes('渡す'), dlg);
  await lap.shots('join-code');
  await desk.shots('approval');

  // 通知の一覧（窓を閉じて見る。同じ申し込みのままなら次の描き直しで開き直す）
  await desk.page.evaluate(() => document.getElementById('plusSyncApproval')?.close());
  await desk.page.locator('#backToChat').click();
  await desk.page.locator('#notifBell').click();
  const notifTx = await desk.waitText('#notifPanel', 'LAPTOP-7 が同期の鍵を待っています', 15_000);
  ok('通知: あなた待ちに 1 行・場所は「設定 › Pleiad Plus」', notifTx.includes('設定 › Pleiad Plus'), notifTx.slice(0, 300));
  await desk.shots('approval-notice', { only1280: true });
  await desk.page.locator('#notifPanel .nrow', { hasText: '同期の鍵を待っています' }).first().click();
  await desk.page.waitForSelector('#plusPanel:not([hidden])', { timeout: 10_000 });
  if (!(await desk.page.locator('#plusSyncApproval[open]').count())) {
    await desk.page.locator('#plusSyncSection [data-fk="syncNow"]').click();
    await desk.page.waitForSelector('#plusSyncApproval[open]', { timeout: 30_000 });
  }
  ok('通知から開くと承認の窓が出る', (await desk.page.locator('#plusSyncApproval[open]').count()) === 1);

  await desk.page.locator('#plusSyncApproval [data-fk="syncApproveYes"]').click();
  await desk.page.waitForSelector('#plusSyncApproval', { state: 'hidden', timeout: 15_000 });
  await lap.waitText('#plusSyncSection', '最後の同期:', 60_000);
  ok('渡す: lap が今の鍵を受け取り、同期する', !!ledger().keys[lap.hostId] && ledger().keys[lap.hostId].keyId === ledger().keyId);
  tx = await desk.waitText('#plusSyncSection', 'LAPTOP-7', 15_000);
  await desk.shots('approved');

  // ================= 3. この版では使えない api（426） =================
  // lap の券の要求だけに返す（裏の回が先に受けたら、押さずにその画面を見る）
  plus.state.syncFail.push({ path: /^\/v1\/sync\//, hostId: lap.hostId, status: 426, code: 'update_required', message: 'update required', count: 1 });
  await lap.page.locator('#plusSyncSection [data-fk="syncNow"]').click({ timeout: 5_000 }).catch(() => {});
  tx = await lap.waitText('#plusSyncSection', 'この版の Pleiad では同期を続けられません', 30_000);
  ok('426: 更新を促す。「今すぐ同期」は出さない', tx.includes('新しい版に更新すると') && !(await lap.page.locator('#plusSyncSection [data-fk="syncNow"]').count()), tx);
  await lap.shots('update-required');

  // ================= 4. 外された desk が今の鍵を持っていて、ほかの PC がリセットを頼んだ =================
  plus.unbindHost(lap.hostId, 'user');
  plus.unbindHost(desk.hostId, 'user');
  const stranger = await scriptedHost('stranger', 'UNKNOWN-PC');
  const asked = await stranger.keys.recoveryRequest();
  ok('前提: 鍵を持つ PC がどれも外れたので、別の PC がリセットを頼める', !!asked.recovery, JSON.stringify(asked));
  await desk.click('#plusSyncSection [data-fk="syncNow"]');
  tx = await desk.waitText('#plusSyncSection', 'UNKNOWN-PC が同期のリセットを頼んでいます', 60_000);
  ok('外された desk: リセットの知らせと「リセットを止める」', !!(await desk.page.locator('#plusSyncSection [data-fk="syncRecoveryStop"]').count()), tx);
  await desk.shots('recovery-alert');
  // 通知の一覧にも、あなた待ちの行で残る。押すと設定 › Pleiad Plus に戻る
  await desk.page.locator('#backToChat').click();
  await desk.page.locator('#notifBell').click();
  const recTx = await desk.waitText('#notifPanel', 'UNKNOWN-PC が同期のリセットを頼んでいます', 15_000);
  ok('通知: リセットの頼みがあなた待ちに 1 行・場所は「設定 › Pleiad Plus」', recTx.includes('設定 › Pleiad Plus'), recTx.slice(0, 300));
  await desk.shots('recovery-notice');
  await desk.page.locator('#notifPanel .nrow', { hasText: '同期のリセットを頼んでいます' }).first().click();
  await desk.page.waitForSelector('#plusSyncSection [data-fk="syncRecoveryStop"]', { timeout: 15_000 });
  ok('通知の行から「リセットを止める」のある同期のまとまりに戻る', (await desk.page.locator('#plusSyncSection [data-fk="syncRecoveryStop"]').count()) === 1);
  await desk.page.locator('#plusSyncSection [data-fk="syncRecoveryStop"]').click();
  await desk.waitText('#plusSyncSection', 'リセットを止めました', 15_000);
  ok('リセットを止める: 今の鍵の署名で止まる', !ledger().recovery, JSON.stringify(ledger().recovery));
  await desk.page.locator('#backToChat').click();
  await desk.page.locator('#notifBell').click();
  {
    const deadline = Date.now() + 10_000;
    while ((await desk.page.locator('#notifPanel').innerText()).includes('同期のリセットを頼んでいます') && Date.now() < deadline) await desk.page.waitForTimeout(200);
  }
  ok('リセットを止めたら通知の行も消える', !(await desk.page.locator('#notifPanel').innerText()).includes('同期のリセットを頼んでいます'));

  for (const pc of [desk, lap]) await pc.ctx.close();
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) await s.stop().catch(() => {});
  await plus.close().catch(() => {});
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log('\n全て通過');
