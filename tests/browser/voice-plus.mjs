// 設定 › 通話の「使うキー」に Pleiad Plus の行（実ブラウザー。docs/plus.md「画面の行」）:
//   Plus が上・OpenRouter が下。上限に達していると、Plus の行の下に
//   「今月の Pleiad Plus の上限に達したため、通話を始められません。」と「アカウントを管理」（urls.profile を外のブラウザーで開く）。
//   通話の途中に中継が credit_exhausted を返しても同じ文言で通話を終える。覚えている間は通話を始めない。
// 偽の Plus（tests/lib/fake-plus.mjs）だけと話す。偽のマイクの音は wav。実行: node tests/browser/voice-plus.mjs
//   VOICE_PLUS_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。
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
const SHOTS = process.env.VOICE_PLUS_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STT_PATH = '/v1/proxy/voice/audio/transcriptions';
const PLUS_ACCOUNT = { uid: 'user-1', email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { name: 'Pleiad Plus' },
  limits: { hosts: 3, creditsPerMonth: 500, syncBytes: 100 }, usage: { credits: 500, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: false } };

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}
/** 声のような音（4Hz で揺れる倍音）を bursts の区間だけ鳴らす（発話の区切りが作られる。voice-call.mjs と同じ形） */
function writeSpeechWav(file, bursts = [[0.3, 1.7], [1.95, 3.35]], secs = 24) {
  const rate = 16000, n = rate * secs, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = bursts.some(([a, b]) => t >= a && t < b)
      ? 0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.3 * Math.sin(2 * Math.PI * 540 * t)) / 1.8 : 0;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt16LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-voice-plus-ui-'));
const wav = path.join(scratch, 'speech.wav');
writeSpeechWav(wav);
const captureFile = path.join(scratch, 'external.log');
const plus = await startFakePlus();
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `voice-plus-${name}.png`) }); } };
const until = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, 80)); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)}`);
};
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

try {
  server = await startServer({ dataDir: path.join(scratch, 'data'), entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_LOCALE: process.env.SHOT_LANG || 'ja', PLUS_EXTERNAL_CAPTURE: captureFile },
    timeoutMs: 60_000 });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  const admin = await open({ port: server.port, token: server.token });
  // 「アカウントを管理」の開き先を外のブラウザーへ（偽の main が PLUS_EXTERNAL_CAPTURE に記録する）
  await admin.cmd('setPref', { key: 'linkOpen', value: 'external' });
  // 偽のマイクはエコー除去の制約を受け付けないので切る（voice-call.mjs と同じ）
  await admin.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { echoCancellation: false, ackPhrase: false, narration: false } } });
  browser = await chromium.launch({ executablePath: chromiumPath(),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
  const [VW, VH] = (process.env.SHOT_VIEWPORT || '1280x820').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, colorScheme: process.env.SHOT_COLOR || 'light', locale: process.env.SHOT_LOCALE || 'ja-JP', permissions: ['microphone'] });

  /** Plus に入り直す（偽のログインのページを別コンテキストのタブで辿る） */
  async function plusLogin(account) {
    plus.state.accounts['user-1'] = account;
    await admin.cmd('plusLogin');
    const loginUrl = await nextExternal();
    const extCtx = await browser.newContext();
    const ext = await extCtx.newPage();
    await ext.goto(loginUrl, { waitUntil: 'commit', timeout: 20_000 }).catch(() => {});
    await ext.waitForURL('**/callback*', { timeout: 15_000 }).catch(() => {});
    await extCtx.close();
    for (let i = 0; i < 100; i++) {
      if ((await admin.cmd('plusStatus')).signedIn) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('ログインが終わらない');
  }

  // 通話ページはログインが済んでから作る（裏に回ったタブでは AudioWorklet が作れない環境がある）
  await plusLogin(PLUS_ACCOUNT);   // 委譲と通話の両方に plus が自動で選ばれる
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  page.on('console', m => console.log('PAGE', m.type(), m.text().slice(0, 200)));
  await page.addInitScript(() => { try { localStorage.setItem('ply-voice-debug', '1'); } catch {} });
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'あとで', exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('send'));

  const openVoiceSettings = async () => {
    await page.evaluate(() => document.getElementById('settings')?.click());
    await page.waitForSelector('#settingsView:not([hidden])');
    await page.locator('#voiceTab').click();
    await page.waitForSelector('#voicePanel:not([hidden]) .rm-opts');
  };
  const plusRow = page.locator('#voicePanel .rm-opt', { hasText: 'Pleiad Plus' });
  const orRow = page.locator('#voicePanel .rm-opt', { hasText: 'OpenRouter' });
  const closeSettings = () => page.locator('#settingsClose, button:has-text("閉じる")').first().click().catch(async () => {
    await page.evaluate(() => { document.getElementById('settingsView').hidden = true; });
  });

  // ---- 2. 途中で credit_exhausted → 同じ文言で通話を終える ----
  const resetAt = new Date(Date.now() + 10 * 86400_000).toISOString();
  plus.state.proxy[STT_PATH] = { status: 429, body: { error: { code: 'credit_exhausted', message: 'x', resetAt } } };
  await page.locator('header.top .vc-call').click({ force: true });   // glow が載るので force。AudioWorklet には活性化の実クリックが要る
  await until(async () => (await page.locator('.vc-note.show .vc-nt').innerText().catch(() => '')).includes('今月の Pleiad Plus の上限に達したため'), '途中の上限の一行');
  {
    const note = await page.locator('.vc-note.show .vc-nt').innerText();
    ok('途中の 429 credit_exhausted: 「…通話を始められません。」と「アカウントを管理」', note.includes('今月の Pleiad Plus の上限に達したため、通話を始められません。') && note.includes('アカウントを管理'), note);
    ok('途中の 429: 通話は終わっている', !(await page.locator('.vc-call.on').count()));
    await shot(page, 'call-credit-exhausted');
  }

  // ---- 3. 「アカウントを管理」→ urls.profile を外へ開く（ブラウザー版では新しいタブ。openExternalLink → target=_blank）----
  {
    const popup = ctx.waitForEvent('page', { timeout: 15_000 });
    await page.locator('.vc-note.show .vc-nb', { hasText: 'アカウントを管理' }).click();
    const ext = await popup;
    await ext.waitForURL(`${plus.url}/profile*`, { timeout: 15_000 }).catch(() => {});
    ok('「アカウントを管理」は urls.profile を外のブラウザーで開く', ext.url().startsWith(`${plus.url}/profile`), ext.url());
    await ext.close();
  }

  // ---- 4. 覚えている間は通話を始めない（上流へ送らない）----
  {
    const sttCallsBefore = plus.state.calls.filter(c => c.path === STT_PATH).length;
    await page.locator('.vc-note.show .vc-nx').click();
    await page.locator('header.top .vc-call').click({ force: true });   // glow が載るので force。ユーザー活性化のため実クリック
    await until(async () => (await page.locator('.vc-note.show .vc-nt').innerText().catch(() => '')).includes('今月の Pleiad Plus の上限に達したため'), '始められない一行');
    await page.waitForTimeout(800);
    ok('始められない: 上流（中継の書き起こし）へは送らない', plus.state.calls.filter(c => c.path === STT_PATH).length === sttCallsBefore);
    await shot(page, 'call-blocked');
  }

  // ---- 5. 設定 › 通話の Pleiad Plus の行・上限の文言 ----
  await openVoiceSettings();
  {
    ok('通話の設定: Pleiad Plus が上・OpenRouter が下', (await page.locator('#voicePanel .rm-opt').first().innerText()).includes('Pleiad Plus'));
    ok('通話の設定: メールと印', (await plusRow.innerText()).includes('user@example.com') && (await plusRow.getAttribute('aria-checked')) === 'true');
    ok('通話の設定: OpenRouter は「キーを選ぶ」', (await orRow.innerText()).includes('キーを選ぶ'));
    await shot(page, 'settings-plus');
    const tx = await until(async () => {
      const t_ = await page.locator('#voicePanel').innerText().catch(() => '');
      return t_.includes('今月の Pleiad Plus の上限に達したため、通話を始められません。') && t_.includes('アカウントを管理') ? t_ : null;
    }, '設定画面の上限の文言');
    ok('通話の設定: 上限の文言と「アカウントを管理」', Boolean(tx));
    await shot(page, 'settings-limit');
  }
  await ctx.close();
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await plus.close().catch(() => {});
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log('\n全て通過');
