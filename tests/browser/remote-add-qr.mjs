// 設定 › リモート › 端末を追加 の流れに出る QR を全部集めて、どれもペアリングの QR か、
// アプリ（Android・iOS の PairingCodec.parse）が installLink と分ける URL（tests/remote/vectors.json）であることを見る（実ブラウザー）。
// 自分の中継サーバーと Pleiad Plus の両方のつなぎ方・スマホと PC を通る。偽の Plus とローカル中継だけを使う。
// アプリの入れ方の QR とペアリングの QR の読み上げ名が分かれていること、入れ方の QR の下の一行、Plus のときの「この後 QR を使わない」も見る。
// 実行: node tests/browser/remote-add-qr.mjs（REMOTE_ADD_QR_SHOTS で撮影先を変更できる）
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
import { open } from '../lib/ws-client.mjs';
import { parsePairingPayload } from '../../core/remote/pairing.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.REMOTE_ADD_QR_SHOTS || path.join(process.cwd(), 'temporary', 'screenshots', 'remote-add-qr');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-remote-add-qr-'));
const captureFile = path.join(SCRATCH, 'external.log');
const VECTORS = JSON.parse(fs.readFileSync(path.resolve('tests/remote/vectors.json'), 'utf8'));
const INSTALL_LINKS = new Set(VECTORS.pleiad.pairing.payloads.filter(v => v.error === 'installLink').map(v => v.input));
const JA = JSON.parse(fs.readFileSync(path.resolve('web/locales/ja/ui.json'), 'utf8'));
const WIZ = JA.settings.remote.wizard;
const PAIR_LABEL = JA.settings.remote.pair.qrLabel;
const ACCOUNT_ID = 'user-1';
const ACCOUNT = { uid: ACCOUNT_ID, email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { id: 'plus', name: 'Pleiad Plus' },
  limits: { hosts: 17, devicesPerHost: 19, sessionsPerHost: 21, creditsPerMonth: 37, syncBytes: 222222 }, usage: { devices: 0, sessions: 0, credits: 4 }, sync: { enabled: false } };
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

let verifier;
const enrollSecret = crypto.randomBytes(32).toString('base64url');
// 自分の中継サーバー（登録の合言葉だけ）と、公式の中継の代わり（Plus のアカウントで通す）
const ownRelay = createRelay({ enrollSecret, trustProxy: false, logger: () => {} });
const ownRelayUrl = `http://127.0.0.1:${(await ownRelay.listen(0, '127.0.0.1')).port}`;
const authz = createPlusRelayAuthz({ verify: token => verifier.verify(token), isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid });
const relay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz });
const relayAddr = await relay.listen(0, '127.0.0.1');
const relayUrl = `http://127.0.0.1:${relayAddr.port}`;
const plus = await startFakePlus({ relayUrl });
plus.state.accounts[ACCOUNT_ID] = ACCOUNT;
verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
let server, browser, client, page;

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
  await ctx.addInitScript(() => { delete window.plyRemote; });
  // 画面が QR にした文字列を残す（qrPath が qrcode(…).addData に渡すもの）
  await ctx.route('**/vendor/qrcode-generator.mjs', async route => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/^export default qrcode;\r?$/m, `
const recording = (typeNumber, level) => {
  const qr = qrcode(typeNumber, level);
  const addData = qr.addData;
  qr.addData = (data, mode) => { (globalThis.__qrTexts ??= []).push(String(data)); return addData.call(qr, data, mode); };
  return qr;
};
Object.assign(recording, qrcode);
export default recording;
`);
    check(body.includes('export default recording;'), 'QR の部品に記録の口を差し込める');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
  });
  page = await ctx.newPage();
  let externalSeen = 0;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForSelector('#settingsView:not([hidden])');
  await page.locator('#remoteTab').click();
  await page.waitForSelector('#remotePanel:not([hidden])');
  await client.cmd('setRemoteSettings', { enabled: true, relayUrl: ownRelayUrl, enrollSecret });
  await until(async () => (await client.cmd('remoteStatus')).connection?.state === 'connected', '自分の中継サーバーへ接続');
  const hostId = (await client.cmd('remoteStatus')).hostId;

  const wizard = page.locator('#remoteAddDevice');
  const seen = [];
  /** 今の段に出ている QR（読み上げ名と点の形） */
  const collect = async (where) => {
    const qrs = await wizard.locator('svg.rm-qr').evaluateAll(svgs => svgs.map(s => ({ label: s.getAttribute('aria-label'), d: s.querySelector('.rm-qr-fg')?.getAttribute('d') ?? '' })));
    for (const q of qrs) seen.push({ ...q, where });
    return qrs;
  };
  const shot = async (name) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await wizard.screenshot({ path: path.join(SHOTS, `remote-add-qr-${name}.png`) });
  };
  const openSignIn = async () => {
    await page.locator('#remotePanel .rm-group').first().locator('button', { hasText: 'Pleiad Plus にログイン' }).click();
    const lines = await until(() => {
      const rows = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      return rows.length > externalSeen ? rows : null;
    }, 'ログイン URL');
    externalSeen = lines.length;
    const tab = await ctx.newPage();
    await tab.goto(lines.at(-1));
    await tab.close();
    await until(async () => (await client.cmd('plusStatus')).signedIn, '偽のログイン完了');
    await page.waitForTimeout(300);
  };
  const openWizard = async () => {
    await page.evaluate(() => document.querySelector('#remotePanel [data-fk="add"]')?.click());
    await page.waitForSelector('#remoteAddDevice[open]');
  };
  const pick = async (kind) => { await wizard.locator(`[data-fk="seg-${kind}"]`).click(); await page.waitForTimeout(150); };
  const next = async () => { await wizard.locator('[data-fk="next"]').click(); await page.waitForTimeout(150); };
  const cancel = async () => {
    await wizard.locator('[data-fk="cancel"]').click();
    await until(async () => !(await wizard.isVisible()), '端末追加の窓を閉じる');
  };

  // ---- 自分の中継サーバー（Plus にログインしていない）: スマホ
  await openWizard();
  let qrs = await collect('own: スマホ: アプリを入れる');
  let text = await wizard.innerText();
  check(qrs.length === 1 && qrs[0].label === WIZ.installQrLabel, 'アプリを入れる: 入れ方の QR の読み上げ名はペアリングの QR と別', qrs.map(q => q.label));
  check(WIZ.installQrLabel !== PAIR_LABEL, '入れ方とペアリングの読み上げ名は違う文');
  check(text.includes(WIZ.installQrNote) && WIZ.installQrNote.includes('ペアリングの QR ではありません'), 'アプリを入れる: QR の下にペアリングの QR ではないことの一行', text);
  check(!text.includes(WIZ.plusNext), '自分の中継サーバーのときは Plus の一行を出さない', text);
  await shot('own-install');
  await next();
  check(await wizard.locator('[role="radio"][aria-checked="true"][data-fk="own"]').count() === 1, 'つなぎ方: Plus にログインしていなければ自分の中継サーバー');
  await collect('own: スマホ: つなぎ方');
  await next();
  await wizard.locator('svg.rm-qr').waitFor();
  qrs = await collect('own: スマホ: つなぐ');
  check(qrs.length === 1 && qrs[0].label === PAIR_LABEL, 'つなぐ: ペアリングの QR の読み上げ名', qrs.map(q => q.label));
  await shot('own-pair');
  await cancel();

  // ---- 自分の中継サーバー: PC（QR は出さず、コードを貼る）
  await openWizard();
  await pick('pc');
  check((await collect('own: PC: アプリを入れる')).length === 0, 'PC: アプリを入れるの段に QR は無い');
  await next();
  await collect('own: PC: つなぎ方');
  await next();
  await wizard.locator('.rm-code-v').waitFor();
  check((await collect('own: PC: つなぐ')).length === 0, 'PC: つなぐの段は QR ではなくコード');
  await cancel();

  // ---- Pleiad Plus（契約中）: スマホと PC
  await openSignIn();
  await until(async () => (await client.cmd('plusStatus', { refresh: true })).account?.status === 'plus', 'Plus アカウント');
  await page.waitForTimeout(400);
  await openWizard();
  qrs = await collect('plus: スマホ: アプリを入れる');
  text = await wizard.innerText();
  check(qrs.length === 1 && qrs[0].label === WIZ.installQrLabel, 'Plus: アプリを入れるの QR は入れ方の QR', qrs.map(q => q.label));
  check(text.includes(WIZ.installQrNote) && text.includes(WIZ.plusNext) && WIZ.plusNext.includes('QR は使いません'),
    'Plus: アプリを入れるの段で、この後スマホで Plus にログインし QR は使わないと分かる', text);
  await shot('plus-install');
  await next();
  check(await wizard.locator('[role="radio"][aria-checked="true"][data-fk="plus"]').count() === 1, 'つなぎ方: 契約中は Pleiad Plus');
  await collect('plus: スマホ: つなぎ方');
  await next();
  await page.waitForSelector('#remoteAddDevice:has-text("スマホを待っています")');
  check((await collect('plus: スマホ: つなぐ')).length === 0, 'Plus: つなぐの段に QR は無い');
  await cancel();
  await openWizard();
  await pick('pc');
  check((await collect('plus: PC: アプリを入れる')).length === 0 && !(await wizard.innerText()).includes(WIZ.plusNext), 'Plus: PC のアプリを入れるには QR もスマホの一行も無い');
  await cancel();

  // ---- 出た QR を全部、文字列に戻して分ける
  // 記録した文字列を画面と同じ qrPath で点の形にし、出ていた QR と突き合わせる（web/remote.mjs は document を使うのでページの中で）
  const pairs = await page.evaluate(async () => {
    const { qrPath } = await import('/remote.mjs');
    return [...new Set(globalThis.__qrTexts ?? [])].map(s => [qrPath(s).d, s]);
  });
  const byPath = new Map(pairs);
  check(seen.length === 3, '端末追加の流れで出た QR は 3 つ（スマホのアプリを入れる 2・自分の中継サーバーのつなぐ 1）', seen.map(q => q.where));
  for (const q of seen) {
    const s = byPath.get(q.d);
    check(s !== undefined, `${q.where}: QR の点から文字列に戻せる`);
    let pairing = null;
    try { pairing = parsePairingPayload(s); } catch {}
    if (pairing) check(pairing.hostId === hostId && q.label === PAIR_LABEL, `${q.where}: この PC のペアリングの QR`, s);
    else check(INSTALL_LINKS.has(s) && q.label === WIZ.installQrLabel, `${q.where}: アプリが installLink と分ける URL`, s);
  }

  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`\n全て通過 ${results.length} 判定`);
  await ctx.close();
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`  NG  ${e.stack ?? e}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page?.screenshot({ path: path.join(SHOTS, 'remote-add-qr-failed.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await client?.ws.close();
  await browser?.close().catch(() => {});
  await server?.stop();
  await plus.close();
  await relay.close();
  await ownRelay.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}
