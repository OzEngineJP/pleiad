// 設定 › リモート「この PC へ」の Plus 経路（実ブラウザー）。偽の Plus とローカル中継だけを使う。
// 端末の承認と取り消し（ADR 0245）: 承認の窓・取り消した端末・もう一度の許可・通知の一覧のあなた待ちも通る。
// 実行: node tests/browser/remote-plus.mjs（REMOTE_PLUS_SHOTS で撮影先を変更できる。承認と取り消しの場面は DEVICE_APPROVAL_SHOTS）
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
import { generateKeyPair } from '../../core/remote/noise.mjs';
import { issueTicket } from '../../core/plus/tickets.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.REMOTE_PLUS_SHOTS || path.join(process.cwd(), 'temporary', 'screenshots', 'remote-plus');
const APPROVAL_SHOTS = process.env.DEVICE_APPROVAL_SHOTS || SHOTS;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-remote-plus-ui-'));
const captureFile = path.join(SCRATCH, 'external.log');
const ACCOUNT_ID = 'user-1';
const ACCOUNT = { uid: ACCOUNT_ID, email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { id: 'plus', name: 'Pleiad Plus' },
  limits: { hosts: 17, devicesPerHost: 19, sessionsPerHost: 21, creditsPerMonth: 37, syncBytes: 222222 }, usage: { devices: 0, sessions: 0, credits: 4 }, sync: { enabled: false } };
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

let verifier;
const authz = createPlusRelayAuthz({ verify: token => verifier.verify(token), keysUrl: () => plus.ticketKeysUrl, isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid });
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
  /** 開き直して 設定 › リモート へ */
  const gotoRemote = async () => {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector('#settingsView:not([hidden])');
    await page.locator('#remoteTab').click();
    await page.waitForSelector('#remotePanel:not([hidden])');
  };
  await gotoRemote();
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
  /** 端末の承認と取り消しの場面: device-approval-<場面>-<幅>-<light|dark>.png */
  const approvalShot = async (name, widths = [1280, 360]) => {
    fs.mkdirSync(APPROVAL_SHOTS, { recursive: true });
    for (const width of widths) {
      for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: width === 360 ? 780 : 1000 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(APPROVAL_SHOTS, `device-approval-${name}-${width}-${scheme}.png`) });
      }
    }
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
  const base = { relayUrl, hostId: remote.hostId, hostPublicKey: Buffer.from(host.publicKey, 'base64url'), platform: 'android' };
  // 新しい鍵は、同じアカウントでも PC の画面の承認の窓を通る（ADR 0245）。裏のつなぎ直し（admit）は窓を出さずに断る
  // 端末は券で申し込む（券を出す api では、ID トークンだけの申し込みを PC が 'update_required' で断る）
  const plusRequest = async (method, p, body) => {
    const r = await fetch(`${plus.url}${p}`, { method, headers: { authorization: `Bearer ${plus.issueIdToken(ACCOUNT_ID)}`, 'content-type': 'application/json', 'x-pleiad-admission': '2' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status });
    return j;
  };
  const admitWithTicket = async ({ keyPair = generateKeyPair(), ...opts }) =>
    admitDevice({ ...base, ...opts, keyPair, ticket: await issueTicket({ request: plusRequest, purpose: 'device', keyPair, hostId: remote.hostId }) });
  const quiet = await admitWithTicket({ name: 'Pixel 9' });
  check(quiet.denied && quiet.reason === 'approval', '許可していない鍵の裏のつなぎ直しは窓を出さずに断る', quiet);
  /** 人がつなぐ（pair）→ 承認の窓に端末と同じ確認コード。shotName があれば撮る。answer が false なら答えずに { pending } を返す */
  const pairThroughWindow = async (opts, { shotName = '', answer = true } = {}) => {
    let code = '';
    const pending = admitWithTicket({ ...opts, mode: 'pair', onCode: c => { code = c; } });
    pending.catch(() => {});
    await page.waitForSelector('#remotePairDialog[open]');
    await until(() => code, '端末の確認コード');
    const text = await page.locator('#remotePairDialog').innerText();
    check(text.includes(opts.name) && text.includes('Pleiad Plus') && text.replace(/\D/g, '').includes(code),
      `${opts.name}: 承認の窓に名前・公式の中継・端末と同じ確認コード`, { text, code });
    if (shotName) await approvalShot(shotName);
    if (!answer) return { pending };
    await page.locator('#remotePairDialog .btn-primary').click();
    return pending;
  };
  const firstKey = generateKeyPair();
  const first = await pairThroughWindow({ name: 'Pixel 9', keyPair: firstKey }, { shotName: 'approve-plus' });
  check(!first.denied, 'Plus 端末の登録', { ...first, hostUid: plus.state.hosts[remote.hostId]?.uid, accountUid: (await client.cmd('plusStatus')).uid, tokenUid: (await verifier.verify(token)).uid, hostId: remote.hostId, log: server.tail?.() });
  const live = await connectDevice(first, { extraHeaders: { 'x-pleiad-account': token } });
  devices.push(live);
  const second = await pairThroughWindow({ name: 'Pixel Tablet' });
  check(!second.denied, '2 台目も承認の窓で許可して登録', second);
  await until(async () => (await client.cmd('remoteStatus')).devices?.filter(d => d.via === 'plus' && d.approvedBy === 'host').length === 2, 'Plus の端末 2 台（PC の画面で許可）');
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

  // 取り消し（ADR 0245）: 詳しい画面から Pixel Tablet を取り消すと「取り消した端末」に並び、その鍵は公式の中継からも入れない
  await page.locator('#remotePanel button', { hasText: 'Pixel Tablet' }).first().click();
  await page.locator('#remotePanel [data-fk="revoke"]').click();
  await page.locator('#remotePanel [data-fk="revokeYes"]').click();
  await page.waitForSelector('#remotePanel .rm-group:has-text("取り消した端末"):has-text("Pixel Tablet")');
  check(!(await page.locator('#remotePanel .rm-group:has-text("Pleiad Plus")').first().innerText()).includes('Pixel Tablet'), '取り消した端末は Plus のまとまりから外れる');
  await approvalShot('revoked-list');
  const revokedAgain = await admitWithTicket({ name: 'Pixel Tablet', keyPair: second.keyPair, mode: 'pair' });
  check(revokedAgain.denied && revokedAgain.reason === 'revoked', '取り消した鍵は、新しい券でも窓を出さずに断る', revokedAgain);
  check(!(await page.locator('#remotePairDialog').evaluate(d => d.open)), '取り消した鍵には承認の窓を出さない');
  await page.locator('#remotePanel .rm-group:has-text("取り消した端末") button', { hasText: 'Pixel Tablet' }).click();
  await page.waitForSelector('#remotePanel [data-fk="hideRevoked"]');
  const revokedDetail = await page.locator('#remotePanel').innerText();
  check(revokedDetail.includes('この PC'), '取り消した端末の詳しい画面: 取り消した機器（この PC）', revokedDetail);
  await approvalShot('revoked-detail');
  await page.locator('#remotePanel [data-fk="back"]').click();

  // もう一度の許可: 前の版で確認コードなしに入った Plus の端末（approvedBy の無い記録）は、許可し直すまで通らない。
  // 台帳を前の版の形にして読み直させ、画面を開き直す
  const closing = live.close?.();
  if (closing?.catch) await closing.catch(() => {});
  devices.length = 0;
  const ledgerFile = path.join(SCRATCH, 'data', 'remote', 'devices.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const old = ledger.devices.find(d => d.id === first.deviceId);
  delete old.approvedBy; delete old.approvedAt;
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  await client.cmd('setRemoteSettings', {});   // 台帳を読み直す（起動時の読み込みと同じ）
  await gotoRemote();
  await page.waitForSelector('#remotePanel .rm-group:has-text("もう一度の許可が要る端末"):has-text("Pixel 9")');
  await approvalShot('reapprove-list');
  const quietOld = await admitWithTicket({ name: 'Pixel 9', keyPair: firstKey });
  check(quietOld.denied && quietOld.reason === 'approval', 'もう一度の許可が要る端末の裏のつなぎ直しは断る', quietOld);
  const { pending: reapproved } = await pairThroughWindow({ name: 'Pixel 9', keyPair: firstKey }, { shotName: 'approve-again', answer: false });
  const againText = await page.locator('#remotePairDialog').innerText();
  check(againText.includes('「Pixel 9」をもう一度許可しますか？'), 'もう一度の許可の題', againText);
  // 通知の一覧: 承認待ちが「あなた待ち」（◆）に出る。窓を閉じ、会話へ戻ってベルから開く
  await page.locator('#remotePairDialog').evaluate(d => d.close());
  await page.locator('#backToChat').click();
  await until(async () => (await page.locator('#notifBell').getAttribute('aria-label'))?.includes('あなた待ち') ?? false, 'ベルにあなた待ち');
  await page.locator('#notifBell').click();
  await page.waitForSelector('#notifPanel:not([hidden]):has-text("端末「Pixel 9」が追加の許可を待っています")');
  check(true, '通知の一覧のあなた待ちに承認待ちの端末');
  await approvalShot('inbox-wait', [1280]);
  await page.keyboard.press('Escape');
  const reqId = (await client.cmd('remoteStatus')).pairing?.requests?.[0]?.id;
  await client.cmd('remotePairingApprove', { id: reqId });
  const back = await reapproved;
  check(!back.denied && back.deviceId === first.deviceId, 'もう一度の許可は同じ端末の記録のまま', back);
  await until(async () => (await client.cmd('remoteStatus')).devices?.some(d => d.id === first.deviceId && !d.reapprove && d.approvedBy === 'host'), '許可し直した記録');
  await gotoRemote();

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
