// 同期で届いた skill・指示ファイルの受け入れ待ち（ADR 0246）。実ブラウザーで、偽の Plus（tests/lib/fake-plus.mjs）を相手に本物の同期のエンジンを回し、
// 待ちに置いた 3 件（変更・新しいファイル・削除）を、設定 › Pleiad Plus の「届いた変更」と通知の一覧から開いて、取り込む・捨てる・手元が変わったとき・
// 見ている間に新しい版が届いたときを見る。最後に、文字でない中身（大きさ・sha256・もう一度の確かめ）を見る。
// 待ちの中身は試験が <data>/plus/sync-inbox/ に置く（暗号の道は tests/unit/plus-sync-inbox.mjs が見る）。
// ホームと CLAUDE_CONFIG_DIR は試験の置き場に向ける（パスは ~/.claude/… と出る。本物の ~/.claude には触らない）。
// 実行: node tests/browser/plus-sync-inbox.mjs   （PLUS_SYNC_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。明暗 × 1280/360）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
const SHOTS = process.env.PLUS_SYNC_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-plus-inbox-'));
const home = path.join(dataDir, 'home');
const captureFile = path.join(dataDir, 'external.log');
const plus = await startFakePlus();
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };

const UID = 'user-1';
const PLUS_ACCOUNT = { uid: UID, email: 'user@example.com', provider: 'google.com', status: 'plus',
  plan: { name: 'Pleiad Plus' }, limits: { hosts: 3, creditsPerMonth: 500 }, usage: { credits: 10, resetAt: '2026-11-01T00:00:00+09:00' }, sync: { enabled: true } };
// 送った PC（台帳の名前を出すため。同期の公開鍵は持たせない＝鍵を渡す宛てにしない）
const OTHER_HOST = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const inboxIdOf = logical => sha(Buffer.from(logical, 'utf8')).slice(0, 32);
const SKILL_BEFORE = '---\nname: release\ndescription: リリースの手順\n---\n# リリース\n\n1. 版を上げる\n2. タグを付ける\n3. ノートを書く\n';
const SKILL_AFTER = '---\nname: release\ndescription: リリースの手順\n---\n# リリース\n\n1. 版を上げる\n2. 変更の一覧を確かめる\n3. タグを付ける\n4. ノートを書く\n';
const CLAUDE_MD = '# 全体の指示\n\n- 日本語で答える\n- commit の前に試験を回す\n';
const OLD_NOTES = '---\nname: old-notes\n---\n# 古いメモ\n\nもう使わない手順。\n';
// 見ている間に届き直した版
const SKILL_AFTER2 = SKILL_AFTER.replace('4. ノートを書く\n', '4. ノートの下書きを作る\n5. ノートを書く\n');
// 文字として読めない中身（PNG の頭 + でたらめなバイト。2048 バイト）
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x00]), crypto.randomBytes(2036)]);

/** 待ちに 1 件置く（engine の hold と同じ形） */
function hold(logical, { kind, incoming = null, base = null, minutesAgo, rev = 2 }) {
  const dir = path.join(dataDir, 'plus', 'sync-inbox', inboxIdOf(logical));
  fs.mkdirSync(dir, { recursive: true });
  if (incoming != null) fs.writeFileSync(path.join(dir, 'incoming'), incoming);
  if (base != null) fs.writeFileSync(path.join(dir, 'base'), base);
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({ path: logical, from: OTHER_HOST, at, mtime: at, kind, rev,
    sha256: incoming != null ? sha(Buffer.from(incoming)) : null, baseSha: base != null ? sha(Buffer.from(base)) : null })}\n`);
}

try {
  for (const d of ['.claude/skills/release', '.codex', '.agents/skills/old-notes', '.gemini']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/release/SKILL.md'), SKILL_BEFORE);
  fs.writeFileSync(path.join(home, '.agents/skills/old-notes/SKILL.md'), OLD_NOTES);

  server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile, AGENT_HOST_OS_OPEN: 'dry',
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();

  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sync-inbox-${name}.png`) }); };
  async function shots(name) {
    if (!SHOTS) return;
    await page.mouse.move(1270, 890);
    await page.waitForTimeout(400);
    await shot(`${name}-light-1280`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(600);
    await shot(`${name}-dark-1280`);
    await page.setViewportSize({ width: 360, height: 900 });
    await page.waitForTimeout(200);
    await shot(`${name}-dark-360`);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(600);
    await shot(`${name}-light-360`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(`${name}: 幅 360 で横にあふれない`, !overflow);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);
  }
  async function waitText(sel, text, ms = 30_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const tx = await page.locator(sel).innerText().catch(() => '');
      if (tx.includes(text)) return tx;
      if (Date.now() > deadline) throw new Error(`「${text}」が ${sel} に出ない（今: ${tx.slice(0, 160)}）`);
      await page.waitForTimeout(200);
    }
  }

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForSelector('#plusTab:not([hidden])');
  await page.locator('#plusTab').click();
  await page.waitForSelector('#plusPanel:not([hidden])');

  // ---- ログイン（plus）→ この PC が最初の鍵を作って idle ----
  plus.state.accounts[UID] = PLUS_ACCOUNT;
  plus.state.hosts[OTHER_HOST] = { hostId: OTHER_HOST, publicKey: 'x', name: 'LAPTOP-7', platform: 'win32', online: true, lastSeenAt: null, syncPublicKey: null, createdAt: new Date().toISOString(), deviceCount: 0, uid: UID };
  plus.state.nextLogin = { uid: UID, email: 'user@example.com' };
  await page.locator('#plusPanel button:has-text("ログイン")').first().click();
  {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lines = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length) { const ext = await ctx.newPage(); await ext.goto(lines.at(-1)); await ext.close(); break; }
      if (Date.now() > deadline) throw new Error('open-external が来ない');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  await page.waitForSelector('#plusSyncSection', { timeout: 20_000 });
  await waitText('#plusSyncSection', '最後の同期:', 60_000);
  ok('前提: 同期が idle になる。届いた変更が無い間は行を出さない', !(await page.locator('#plusSyncSection [data-fk="syncInbox"]').count()));

  // ---- 待ちに 3 件置いて、1 回回す ----
  hold('skills/claude/release/SKILL.md', { kind: 'change', incoming: SKILL_AFTER, base: SKILL_BEFORE, minutesAgo: 12 });
  hold('instructions/claude', { kind: 'new', incoming: CLAUDE_MD, minutesAgo: 40 });
  hold('skills/agents/old-notes/SKILL.md', { kind: 'delete', base: OLD_NOTES, minutesAgo: 125 });
  await page.locator('#plusSyncSection button:has-text("今すぐ同期")').click();
  const rowTx = await waitText('#plusSyncSection', '届いた変更 3 件', 30_000);
  ok('同期のまとまりに「◆ 届いた変更 3 件」の行', rowTx.includes('◆'), rowTx);
  await page.locator('#plusSyncSection [data-fk="syncInbox"]').scrollIntoViewIfNeeded();
  await shot('row-light-1280');

  // ---- 通知の一覧: 「同期で届いた変更が 3 件あります」 ----
  await page.locator('#backToChat').click();
  await page.locator('#notifBell').click();
  const notifTx = await waitText('#notifPanel', '同期で届いた変更が 3 件あります', 15_000);
  ok('通知: あなた待ちに 1 行・場所は「設定 › Pleiad Plus」', notifTx.includes('設定 › Pleiad Plus'), notifTx.slice(0, 300));
  await shot('notify-light-1280');
  await page.locator('#notifPanel .nrow', { hasText: '同期で届いた変更' }).first().click();

  // ---- 通知から「届いた変更」の面が開く。最初の 1 件（新しく届いた順: 変更）が開いている ----
  await page.waitForSelector('#plusPanel .inx-list', { timeout: 15_000 });
  await page.waitForSelector('#plusPanel .inx.open .scx-lines', { timeout: 15_000 });
  const heads = await page.locator('#plusPanel .inx-h').evaluateAll(hs => hs.map(h => ({ path: h.querySelector('.rm-nm')?.textContent, sub: h.querySelector('.rm-sub')?.textContent, open: h.getAttribute('aria-expanded') })));
  ok('通知の行を押すと「届いた変更」の面が開く。3 件・最初の 1 件だけ開く', heads.length === 3 && heads.map(h => h.open).join() === 'true,false,false', JSON.stringify(heads));
  ok('パスは ~/ からの見た目', heads[0].path === '~/.claude/skills/release/SKILL.md' && heads[1].path === '~/.claude/CLAUDE.md' && heads[2].path === '~/.agents/skills/old-notes/SKILL.md', JSON.stringify(heads));
  ok('2 行目: 種類 · 送った PC の名前 · 届いた時刻', heads[0].sub.startsWith('変更 · LAPTOP-7 · ') && heads[1].sub.startsWith('新しいファイル · LAPTOP-7') && heads[2].sub.startsWith('削除 · LAPTOP-7'), JSON.stringify(heads));
  const panelTx = await page.locator('#plusPanel').innerText();
  ok('戻るは「Pleiad Plus」・題は「届いた変更」・「すべて取り込む」は無い', panelTx.includes('Pleiad Plus') && panelTx.includes('届いた変更') && !panelTx.includes('すべて'), panelTx.slice(0, 200));
  const diff = await page.locator('#plusPanel .inx.open .scx-lines').innerText();
  ok('差分: 足した行が出る', diff.includes('変更の一覧を確かめる'), diff);
  await shots('pane');

  // ---- 見ている間に新しい版が届いた → 「取り込む」を押しても書かない・「新しい版が届きました」・差分を読み直す ----
  hold('skills/claude/release/SKILL.md', { kind: 'change', incoming: SKILL_AFTER2, base: SKILL_BEFORE, minutesAgo: 1, rev: 3 });
  await page.locator('#plusPanel .inx.open button[data-act="take"]').click();
  await waitText('#plusPanel .inx.open', '新しい版が届きました', 15_000);
  const renewedDiff = await waitText('#plusPanel .inx.open .scx-lines', 'ノートの下書きを作る', 15_000);
  ok('新しい版が届いていたら、取り込まずに「新しい版が届きました」と新しい差分を出す',
    fs.readFileSync(path.join(home, '.claude/skills/release/SKILL.md'), 'utf8') === SKILL_BEFORE && renewedDiff.includes('変更の一覧を確かめる'), renewedDiff);
  await page.waitForSelector('#plusPanel .inx.open button[data-act="take"]:not([disabled])', { timeout: 15_000 });
  ok('新しい版を読み直したら、もう一度「取り込む」を押せる', await page.locator('#plusPanel .inx.open button[data-act="take"]').isEnabled());
  await shots('renewed');

  // ---- 取り込む → 書く・「取り込みました」・次の 1 件（新しいファイル）が開く ----
  await page.locator('#plusPanel .inx.open button[data-act="take"]').click();
  await waitText('#plusPanel', '取り込みました', 15_000);
  await page.waitForSelector('#plusPanel .inx.open .scx-lines', { timeout: 15_000 });
  ok('取り込む: 手元のファイルが見直した版になる', fs.readFileSync(path.join(home, '.claude/skills/release/SKILL.md'), 'utf8') === SKILL_AFTER2);
  const open2 = await page.locator('#plusPanel .inx.open .rm-nm').innerText();
  ok('取り込んだら次の 1 件（新しいファイル）が開く。+ の行だけ', open2 === '~/.claude/CLAUDE.md' && (await page.locator('#plusPanel .inx.open .scx-lines').innerText()).includes('日本語で答える'), open2);
  const focused = await page.evaluate(() => document.activeElement?.dataset?.fk ?? '');
  ok('フォーカスは次の見出しへ', focused.startsWith('inx:'), focused);
  await shots('taken');

  // ---- 新しいファイルを捨てる → 書かない・「捨てました」 ----
  await page.locator('#plusPanel .inx.open button[data-act="drop"]').click();
  await waitText('#plusPanel', '捨てました', 15_000);
  ok('捨てる: 手元にファイルを作らない', !fs.existsSync(path.join(home, '.claude/CLAUDE.md')));

  // ---- 削除: 手元を変えてから取り込む → 書かない・わけを出す・「取り込む」を押せない ----
  await page.waitForSelector('#plusPanel .inx.open .scx-lines', { timeout: 15_000 });
  fs.writeFileSync(path.join(home, '.agents/skills/old-notes/SKILL.md'), `${OLD_NOTES}\n追記した行\n`);
  await page.locator('#plusPanel .inx.open button[data-act="take"]').click();
  await waitText('#plusPanel', 'この PC のファイルが変わったため', 15_000);
  ok('手元が変わっていたら消さない', fs.existsSync(path.join(home, '.agents/skills/old-notes/SKILL.md')));
  ok('手元が変わっていたら「取り込む」を押せない', await page.locator('#plusPanel .inx.open button[data-act="take"]').isDisabled());
  ok('手元が変わっていても「捨てる」は押せる', await page.locator('#plusPanel .inx.open button[data-act="drop"]').isEnabled());
  await shots('local-changed');
  await page.locator('#plusPanel .inx.open button[data-act="drop"]').click();
  await waitText('#plusPanel', '捨てました', 15_000);

  // ---- 0 件: 通知の行が消え、同期のまとまりの行も消える ----
  await page.locator('#plusPanel button.rm-back').click();
  await page.waitForSelector('#plusSyncSection', { timeout: 10_000 });
  {
    const deadline = Date.now() + 10_000;
    while ((await page.locator('#plusSyncSection [data-fk="syncInbox"]').count()) && Date.now() < deadline) await page.waitForTimeout(200);
  }
  ok('すべて済んだら「届いた変更」の行は消える', !(await page.locator('#plusSyncSection [data-fk="syncInbox"]').count()));
  await page.locator('#backToChat').click();
  await page.locator('#notifBell').click();
  await page.waitForTimeout(800);
  ok('すべて済んだら通知の行も消える', !(await page.locator('#notifPanel').innerText()).includes('同期で届いた変更'));

  // ---- 文字でない中身: 差分の代わりに警告・大きさ・sha256。「取り込む」はもう一度確かめてから書く ----
  hold('skills/claude/release/logo.png', { kind: 'new', incoming: PNG, minutesAgo: 3 });
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.locator('#plusTab').click();
  await page.waitForSelector('#plusSyncSection', { timeout: 10_000 });
  await page.locator('#plusSyncSection button:has-text("今すぐ同期")').click();
  await waitText('#plusSyncSection', '届いた変更 1 件', 30_000);
  await page.locator('#plusSyncSection [data-fk="syncInbox"]').click();
  await page.waitForSelector('#plusPanel .inx.open .inx-sha', { timeout: 15_000 });
  const binTx = await page.locator('#plusPanel .inx.open').innerText();
  ok('文字でない中身: 差分を出さず、警告・届いた版の大きさ・sha256 を出す',
    binTx.includes('中身を表示できません') && binTx.includes('2.0 KB') && binTx.includes(`sha256 ${sha(PNG)}`) && !(await page.locator('#plusPanel .inx.open .scx-lines').count()), binTx);
  await page.locator('#plusPanel .inx.open button[data-act="take"]').click();
  await page.waitForSelector('#plusPanel .inx.open button[data-act="takeYes"]', { timeout: 10_000 });
  const askTx = await page.locator('#plusPanel .inx.open').innerText();
  const logo = path.join(home, '.claude/skills/release/logo.png');
  ok('「取り込む」を押すと、まだ書かずにもう一度確かめる', !fs.existsSync(logo) && askTx.includes('sha256 が同じことを確かめましたか') && !(await page.locator('#plusPanel .inx.open button[data-act="take"]').count()), askTx);
  await shots('binary-confirm');
  await page.locator('#plusPanel .inx.open button[data-act="takeYes"]').click();
  await waitText('#plusPanel', '取り込みました', 15_000);
  ok('「確かめたので取り込む」で届いた版をそのまま書く', fs.existsSync(logo) && fs.readFileSync(logo).equals(PNG));
  await ctx.close();
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await plus.close().catch(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log('\n全て通過');
