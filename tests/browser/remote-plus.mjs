// 設定 › リモート「この PC へ」の Plus 経路（実ブラウザー）。偽の Plus とローカル中継だけを使う。
// 実行: node tests/browser/remote-plus.mjs（REMOTE_PLUS_SHOTS で撮影先を変更できる）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createRelay } from '../../relay/server.mjs';
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { createPlusRelayAuthz } from '../lib/plus-relay-authz.mjs';
import { admitDevice, connectDevice } from '../lib/remote-device.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.REMOTE_PLUS_SHOTS || path.join(process.cwd(), 'temporary', 'screenshots', 'remote-plus');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-remote-plus-ui-'));
const captureFile = path.join(SCRATCH, 'external.log');
const ACCOUNT_ID = 'user-1';
const ACCOUNT = { uid: ACCOUNT_ID, email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { id: 'plus', name: 'Pleiad Plus' },
  limits: { hosts: 17, devicesPerHost: 19, sessionsPerHost: 21, creditsPerMonth: 37, syncBytes: 222222 }, usage: { devices: 0, sessions: 0, credits: 4 }, sync: { enabled: false } };
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

let verifier;
const authz = createPlusRelayAuthz({ verify: token => verifier.verify(token), isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid });
const relay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz });
const relayAddr = await relay.listen(0, '127.0.0.1');
const relayUrl = `http://127.0.0.1:${relayAddr.port}`;
const ownSecret = crypto.randomBytes(32).toString('base64url');
const ownRelay = createRelay({ enrollSecret: ownSecret, trustProxy: false, logger: () => {} });
const ownRelayAddr = await ownRelay.listen(0, '127.0.0.1');
const ownRelayUrl = `http://127.0.0.1:${ownRelayAddr.port}`;
const plus = await startFakePlus({ relayUrl });
plus.state.accounts[ACCOUNT_ID] = ACCOUNT;
verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
let server, browser, client;
const devices = [];

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

async function until(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: timeout`);
}

try {
  server = await startServer({ dataDir: path.join(SCRATCH, 'data'), entry: path.resolve('tests/lib/plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_PLUS_JWKS_URL: plus.jwksUrl, PLUS_EXTERNAL_CAPTURE: captureFile } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  client = await open({ port: server.port, token: server.token });
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'ja-JP' });
  // 「ほかの PC へ」タブは desktop preload があるときだけ出る。ブラウザー試験にも空の hosts bridge を置き、
  // アプリの「設定 › リモート」と同じタブ列を撮る（端末追加や保存の動作は呼ばない）。
  await ctx.addInitScript(() => {
    delete window.plyRemote;
    window.plyDesktop = { hosts: {
      onChange() {}, onCode() {}, onOpen() {},
      init: async () => ({ ok: true, hosts: [], encrypted: true }),
      list: async () => ({ ok: true, hosts: [], encrypted: true }),
    } };
  });
  const page = await ctx.newPage();
  let externalSeen = 0;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForSelector('#settingsView:not([hidden])');
  await page.locator('#remoteTab').click();
  await page.waitForSelector('#remotePanel:not([hidden])');
  await page.locator('#remotePanel #remoteEnable').click();
  await until(async () => (await client.cmd('remoteStatus')).enabled, 'リモート許可');
  await page.waitForSelector('#remotePanel .rm-group');
  check((await client.cmd('remoteStatus')).plus?.connect === true, '公式の中継の既定は入');
  check(await page.locator('#remotePanel .rm-group').first().innerText().then(s => s.includes('Pleiad Plus（公式の中継）')), 'Plus のまとまりの見出し');
  check(await page.locator('#remotePanel .rm-tabrow [data-fk="seg-this"]').innerText() === 'この PC へ'
    && await page.locator('#remotePanel .rm-tabrow [data-fk="seg-other"]').innerText() === 'ほかの PC へ', '設定 › リモートの両タブを表示');

  const shot = async (name, selector = '#remotePanel') => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const node = page.locator(selector);
    await page.screenshot({ path: path.join(SHOTS, `remote-plus-${name}-light-1280.png`), fullPage: false });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(SHOTS, `remote-plus-${name}-dark-1280.png`), fullPage: false });
    await page.setViewportSize({ width: 360, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: path.join(SHOTS, `remote-plus-${name}-light-360.png`), fullPage: false });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(SHOTS, `remote-plus-${name}-dark-360.png`), fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(!overflow, `${name}: 360px で横にはみ出さない`);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
  };
  const openSignIn = async () => {
    await page.locator('#remotePanel .rm-group').first().locator('button', { hasText: 'Pleiad Plus にログイン' }).click();
    const lines = await until(() => {
      const rows = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      return rows.length > externalSeen ? rows : null;
    }, 'ログイン URL');
    externalSeen = lines.length;
    const loginUrl = lines.at(-1);
    const tab = await ctx.newPage();
    await tab.goto(loginUrl);
    await tab.close();
    await until(async () => (await client.cmd('plusStatus')).signedIn, '偽のログイン完了');
    await page.waitForTimeout(300);
  };

  // 未ログイン: ログインの入口は 1 つだけ。
  check((await page.locator('#remotePanel .rm-group').first().locator('button').count()) === 1, '未ログイン: Plus の入口が 1 つ');
  check(await page.locator('#remotePanel .rm-group .cx-sw').count() === 0, '未ログイン: Plus のスイッチは出さない');
  await shot('signed-out');
  await page.evaluate(() => document.querySelector('#remotePanel [data-fk="add"]')?.click());
  await page.locator('#remoteAddDevice [data-fk="next"]').click();
  await page.locator('#remoteAddDevice [role="radio"][data-fk="plus"]').click();
  check(await page.locator('#remoteAddDevice [role="radio"][data-fk="plus"]').getAttribute('aria-checked') === 'true', '未ログインでも Pleiad Plus を選べる');
  await page.locator('#remoteAddDevice [data-fk="next"]').click();
  await page.waitForSelector('#remoteAddDevice:has-text("ブラウザーでログイン")');
  const loginStep = await page.locator('#remoteAddDevice').innerText();
  check(loginStep.includes('Pleiad Plus にログインします') && loginStep.includes('ブラウザーでログイン'), 'つなぐ: ログイン案内とブラウザーの入口', loginStep);
  check(await page.locator('#remoteAddDevice .rm-stp li').count() === 3, '端末を追加は 3 段（アプリを入れる › つなぎ方 › つなぐ）');
  await shot('wizard-login', '#remoteAddDevice');
  await page.locator('#remoteAddDevice [data-fk="next"]').click();
  await until(async () => !(await page.locator('#remoteAddDevice').isVisible()), 'ログイン前の つなぐ の段から閉じる');

  // free: 既存の「Pleiad Plus にする」を再利用する。
  plus.state.accounts[ACCOUNT_ID] = { ...ACCOUNT, status: 'free', plan: null, limits: null, usage: null };
  await openSignIn();
  await until(async () => (await client.cmd('plusStatus', { refresh: true })).account?.status === 'free', '無料アカウント');
  await page.waitForTimeout(400);
  check((await page.locator('#remotePanel .rm-group').first().innerText()).includes('Pleiad Plus にする'), 'free: Plus にする行');
  check(await page.locator('#remotePanel .rm-group .cx-sw').count() === 0, 'free: Plus のスイッチは出さない');
  await shot('free');

  // Plus の契約でログイン。二つの radio と、スマホを待つ案内を通る。
  await page.locator('#plusTab').click();
  await page.locator('#plusPanel button:has-text("ログアウト")').click();
  await until(async () => !(await client.cmd('plusStatus')).signedIn, 'ログアウト');
  plus.state.accounts[ACCOUNT_ID] = ACCOUNT;
  await page.locator('#remoteTab').click();
  await openSignIn();
  await until(async () => (await client.cmd('plusStatus')).account?.status === 'plus', 'Plus アカウント');
  await page.waitForTimeout(400);
  if (!(await client.cmd('remoteStatus')).enabled) {
    await page.locator('#remotePanel #remoteEnable').click();
    await until(async () => (await client.cmd('remoteStatus')).enabled, 'リモート許可');
  }
  await page.evaluate(() => document.querySelector('#remotePanel [data-fk="add"]')?.click());
  await page.locator('#remoteAddDevice [data-fk="next"]').click();
  check(await page.locator('#remoteAddDevice [role="radiogroup"] [role="radio"]').count() === 2, 'つなぎ方: Plus と自分の中継サーバーを radio で表示');
  check(await page.locator('#remoteAddDevice [role="radio"][aria-checked="true"]').innerText().then(s => s.includes('Pleiad Plus')), '契約中は Plus を初期選択');
  await shot('method', '#remoteAddDevice');
  await page.locator('#remoteAddDevice [data-fk="next"]').click();
  await page.waitForSelector('#remoteAddDevice:has-text("スマホを待っています")');
  const waitingText = await page.locator('#remoteAddDevice').innerText();
  check(waitingText.includes('スマホに Pleiad を入れる') && waitingText.includes('スマホの Pleiad で Pleiad Plus にログイン') && waitingText.includes('user@example.com'),
    'つなぐ: するべきこと 2 つ（入れる・ログイン）とアカウント', waitingText);
  check(await page.locator('#remoteAddDevice .rm-todo li.done').count() === 1, 'つなぐ: 入れるは済み、ログインはまだ');
  check(await page.locator('#remoteAddDevice .rm-live:not(.rm-live-ok)').count() === 1, 'つなぐ: 待っている行は一行');
  check(await page.locator('#remoteAddDevice [data-fk="cancel"]').count() === 0
    && await page.locator('#remoteAddDevice [data-fk="next"]').innerText() === '閉じる'
    && await page.locator('#remoteAddDevice [data-fk="next"]').isEnabled()
    && await page.locator('#remoteAddDevice [data-fk="back"]').isVisible(), 'つなぐ: 下は「戻る」と押せる「閉じる」（やめるは無い）');
  await shot('waiting', '#remoteAddDevice');
  // キーボード: 閉じるにフォーカスを当てられる
  await page.locator('#remoteAddDevice [data-fk="next"]').focus();
  check(await page.evaluate(() => document.activeElement?.dataset.fk) === 'next', 'キーボード: 閉じるにフォーカスが乗る');

  const remote = await client.cmd('remoteStatus');
  const host = await until(() => plus.state.hosts[remote.hostId], 'この PC の登録');
  try { await until(async () => (await client.cmd('remoteStatus')).plus?.link?.state === 'connected', '公式の中継へ接続'); }
  catch (e) { throw new Error(`${e.message}\n${JSON.stringify({ remote: await client.cmd('remoteStatus'), plus: await client.cmd('plusStatus'), hostCalls: { count: plus.state.calls.filter(c => c.path.startsWith('/v1/hosts')).length, recent: plus.state.calls.filter(c => c.path.startsWith('/v1/hosts')).slice(-8).map(c => [c.method, c.path]) }, log: server.tail?.() })}`); }
  const token = plus.issueIdToken(ACCOUNT_ID);
  const first = await admitDevice({ relayUrl, hostId: remote.hostId, hostPublicKey: Buffer.from(host.publicKey, 'base64url'), idToken: token, name: 'Pixel 9', platform: 'android' });
  check(!first.denied, 'Plus 端末の登録', { ...first, hostUid: plus.state.hosts[remote.hostId]?.uid, accountUid: (await client.cmd('plusStatus')).uid, tokenUid: (await verifier.verify(token)).uid, hostId: remote.hostId, log: server.tail?.() });
  const live = await connectDevice(first, { extraHeaders: { 'x-pleiad-account': token } });
  devices.push(live);
  const second = await admitDevice({ relayUrl, hostId: remote.hostId, hostPublicKey: Buffer.from(host.publicKey, 'base64url'), idToken: token, name: 'Pixel Tablet', platform: 'android' });
  await until(async () => (await client.cmd('remoteStatus')).devices?.filter(d => d.via === 'plus').length === 2, 'Plus の端末 2 台');
  await page.waitForSelector('#remotePanel .rm-group:has-text("Pixel 9"):has-text("Pixel Tablet")');
  // 同じ段のまま、待っている行がチェックと「Pixel 9 をつなぎました」に替わる
  await page.waitForSelector('#remoteAddDevice .rm-live-ok:has-text("Pixel 9 をつなぎました")');
  check(await page.locator('#remoteAddDevice .rm-todo li.done').count() === 2 && await page.locator('#remoteAddDevice .rm-stp li').count() === 3,
    '完了: 同じ段で 2 つとも済み、待つ行が「つなぎました」');
  await shot('done', '#remoteAddDevice');
  await page.locator('#remoteAddDevice [data-fk="next"]').click();
  await until(async () => !(await page.locator('#remoteAddDevice').isVisible()), '端末追加の窓を閉じる');
  check(await page.locator('#remotePanel .rm-group:has-text("Pixel 9"):has-text("Pixel Tablet")').isVisible(), '一覧の撮影前に端末追加の窓を閉じる');
  check(await page.locator('#remotePanel .rm-st-ok').first().innerText() === 'つながっています · user@example.com', 'Plus の状態行: つながっています · メール');
  await shot('two-devices-one-offline');

  // オフライン端末は Plus のスイッチを切っても一覧に残る。
  await page.locator('#remotePanel [data-fk="plusConnect"]').click();
  await until(async () => (await client.cmd('remoteStatus')).plus?.connect === false, 'Plus 接続をオフ');
  await page.waitForSelector('#remotePanel .rm-group:has-text("Pixel Tablet"):has-text("オフライン")');
  const text = await page.locator('#remotePanel').innerText();
  check(text.includes('Pixel 9') && text.includes('Pixel Tablet') && text.includes('オフライン'), 'Plus の端末 2 台が残り、未接続端末にオフラインが出る');
  check(await page.locator('#remotePanel .rm-st-off').count() >= 1, '切ったときも Plus のまとまりは「オフ」の一行を出す');
  check(await page.locator('#remotePanel [data-fk="plusConnect"]').getAttribute('aria-label') === 'Pleiad Plus でつなぐ', 'Plus スイッチは読み上げ名だけを持つ');
  await shot('two-devices-off');

  // 自分の中継サーバーも入れると、まとまりが二つ並ぶ。Plus を切っている間は「スマホからは自分の中継サーバーでつながります」
  await client.cmd('setRemoteSettings', { relayUrl: ownRelayUrl, enrollSecret: ownSecret });
  await until(async () => (await client.cmd('remoteStatus')).connection?.state === 'connected', '自分の中継サーバーへ接続');
  await page.waitForSelector('#remotePanel .rm-group:has-text("自分の中継サーバー") .rm-st-ok');
  check(await page.locator('#remotePanel .rm-st-off').first().innerText() === 'オフ · スマホからは自分の中継サーバーでつながります', 'Plus を切って自分の中継サーバーがあるときの一行');
  check(await page.locator('#remotePanel .rm-group:has-text("自分の中継サーバー") .rm-st-ok').innerText() === `つながっています · 127.0.0.1:${ownRelayAddr.port}`, '自分の中継サーバーの状態行');
  await shot('both-plus-off');
  // キーボード: Tab で Plus のスイッチへ移り、Space で入れる
  await page.locator('#remotePanel [data-fk="plusConnect"]').evaluate(b => { const all = [...document.querySelectorAll('#remotePanel button')]; all[all.indexOf(b) - 1]?.focus(); });
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement?.dataset.fk) === 'plusConnect', 'キーボード: Tab で Plus のスイッチにフォーカス');
  await page.keyboard.press('Space');
  await until(async () => (await client.cmd('remoteStatus')).plus?.connect === true, 'Plus 接続をオン');
  await page.waitForSelector('#remotePanel .rm-group:has-text("Pleiad Plus") .rm-st-ok');
  check(await page.locator('#remotePanel .rm-st-ok').count() === 2, '二つのまとまりがどちらも「つながっています」');
  const afterFocus = await page.evaluate(() => ({ fk: document.activeElement?.dataset?.fk ?? null, tag: document.activeElement?.tagName }));
  check(afterFocus.fk === 'plusConnect', 'キーボード: 切り替えた後もフォーカスはスイッチに残る', afterFocus);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'remote-plus-both-focus-light-1280.png') });
  await shot('both');

  // 中継が届かない状態と利用不可の状態も、まとまりの一行に出す（切っている間は「オフ」が先なので、入れ直してから）。
  plus.state.down = true;
  await until(async () => (await client.cmd('plusStatus', { refresh: true })).reachable === false, '接続失敗の状態', 40_000);
  await page.waitForSelector('#remotePanel:has-text("サーバーへの接続に失敗しました")');
  check((await page.locator('#remotePanel').innerText()).includes('サーバーへの接続に失敗しました'), '接続失敗: 承認された一行');
  await shot('connection-failed');
  plus.state.down = false;
  plus.state.accounts[ACCOUNT_ID] = { ...ACCOUNT, status: 'disabled' };
  await until(async () => (await client.cmd('plusStatus', { refresh: true })).account?.status === 'disabled', '利用不可アカウント', 40_000);
  await page.waitForSelector('#remotePanel:has-text("このアカウントでは公式の中継を使えません")');
  await shot('unavailable');
  check(await page.locator('#remotePanel').innerText().then(s => s.includes('このアカウントでは公式の中継を使えません')), '利用不可: 承認された一行');

  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`\n全て通過 ${results.length} 判定`);
  await ctx.close();
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`  NG  ${e.stack ?? e}`);
  process.exitCode = 1;
} finally {
  for (const d of devices) { const closing = d.close?.(); if (closing?.catch) await closing.catch(() => {}); }
  await client?.ws.close();
  await browser?.close().catch(() => {});
  await server?.stop();
  await plus.close();
  await relay.close();
  await ownRelay.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}
