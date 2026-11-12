// 設定 › コンピューターの操作の「wait_until の問いに使うキー」（Pleiad Plus / OpenRouter / 使わない）と、
// 会話の行の「未確認」を実ブラウザーで確かめる（2026-11-13、docs/computer-use.md「wait_until の待ち方」）。
// 偽の Plus（tests/lib/fake-plus.mjs）と fake のバックエンドだけと話す。データ置き場は一時ディレクトリ。
// 実行: node tests/browser/computer-wait-until-plus.mjs   （WU_SHOTS=<ディレクトリ> で場面ごとの画像を撮る。明暗 × 1280/360）
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
const SHOTS = process.env.WU_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-wu-plus-'));
const captureFile = path.join(dataDir, 'external.log');
const plus = await startFakePlus();
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };
const PLUS_ACCOUNT = { uid: 'user-1', email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { name: 'Pleiad Plus' },
  limits: { hosts: 3, creditsPerMonth: 500, syncBytes: 100 }, usage: { credits: 120, resetAt: '2026-12-01T00:00:00+09:00' }, sync: { enabled: false } };

try {
  server = await startServer({ dataDir, entry: path.join(ROOT, 'tests', 'lib', 'plus-main-port.mjs'),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS_API: plus.url, PLUS_EXTERNAL_CAPTURE: captureFile } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'ja-JP' });
  const page = await ctx.newPage();
  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `wu-${name}.png`) }); };
  /** 1280/360 × 明/暗 の 4 枚。360 で横にあふれないことも確かめる */
  async function shots(name, selector) {
    if (!SHOTS) return;
    const take = async tag => {
      if (selector) await page.locator(selector).first().screenshot({ path: path.join(SHOTS, `wu-${name}-${tag}.png`) });
      else await shot(`${name}-${tag}`);
    };
    await page.emulateMedia({ colorScheme: 'light' });
    await take('light-1280');
    await page.emulateMedia({ colorScheme: 'dark' });
    await take('dark-1280');
    await page.setViewportSize({ width: 360, height: 1000 });
    await take('dark-360');
    await page.emulateMedia({ colorScheme: 'light' });
    await take('light-360');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(`${name}: 幅 360 で横にあふれない`, !overflow);
    await page.setViewportSize({ width: 1280, height: 1000 });
  }

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // ---- ログイン（設定 › Pleiad Plus）。案内の窓が遅れて開き直すことがあるので、設定が開くまで閉じて押す
  for (let i = 0; i < 20 && !(await page.evaluate(() => document.body.classList.contains('settings'))); i++) {
    await page.evaluate(() => { document.getElementById('onboardingDialog')?.close(); document.getElementById('settings')?.click(); });
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('#settingsView', { state: 'visible' });
  const openPage = async id => { await page.locator(`#${id}Tab`).click(); await page.waitForSelector(`#${id}Panel:not([hidden])`); };
  const computerText = () => page.locator('#computerPanel').innerText();
  plus.state.accounts['user-1'] = PLUS_ACCOUNT;
  await openPage('plus');
  await page.locator('#plusPanel button:has-text("ログイン")').first().click();
  const deadline = Date.now() + 10_000;
  let loginUrl = '';
  while (!loginUrl && Date.now() < deadline) {
    const lines = fs.existsSync(captureFile) ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean) : [];
    loginUrl = lines.at(-1) ?? '';
    if (!loginUrl) await new Promise(r => setTimeout(r, 50));
  }
  const ext = await ctx.newPage();
  await ext.goto(loginUrl);
  await page.waitForSelector('#plusPanel button:has-text("ログアウト")', { timeout: 15_000 });
  await ext.close();
  await page.waitForSelector('#plusPanel :text("user@example.com")', { timeout: 15_000 });

  // ---- 設定 › コンピューターの操作: 3 行のラジオ
  await openPage('computer');
  await page.waitForSelector('#computerPanel [role=radiogroup]');
  const group = page.locator('#computerPanel [role=radiogroup]').first();
  const names = async () => (await group.locator('[role=radio] .rm-nm').allInnerTexts());
  ok('3 行のラジオ: Pleiad Plus / OpenRouter / 使わない', JSON.stringify(await names()) === JSON.stringify(['Pleiad Plus', 'OpenRouter', '使わない']), JSON.stringify(await names()));
  ok('最初は「使わない」を選んでいる', (await group.locator('[role=radio][aria-checked=true] .rm-nm').innerText()) === '使わない');
  ok('送り先の説明に Pleiad Plus の経路を書く', (await computerText()).includes('Pleiad Plus を選んだときは、Pleiad Plus のサーバーを通ります'));
  await shots('settings-none', '#computerPanel');

  // Pleiad Plus を選ぶ（クリック）
  await group.locator('[role=radio]:has-text("Pleiad Plus")').click();
  await page.waitForFunction(() => document.querySelector('#computerPanel [role=radio][aria-checked=true] .rm-nm')?.textContent === 'Pleiad Plus');
  ok('Pleiad Plus を選べる（メールが 2 行目に出る）', (await computerText()).includes('user@example.com'));
  await shots('settings-plus', '#computerPanel');

  // キーボード: ↑↓ ではなく Tab で行へ → Space/Enter で選ぶ（行は tabindex=0 の radio）
  await group.locator('[role=radio]:has-text("使わない")').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#computerPanel [role=radio][aria-checked=true] .rm-nm')?.textContent === '使わない');
  ok('キーボード（Enter）で「使わない」を選べる', true);
  await group.locator('[role=radio]:has-text("Pleiad Plus")').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#computerPanel [role=radio][aria-checked=true] .rm-nm')?.textContent === 'Pleiad Plus');
  ok('キーボード（Space）で Pleiad Plus を選べる', true);

  // 上限に達した
  plus.state.accounts['user-1'] = { ...PLUS_ACCOUNT, usage: { ...PLUS_ACCOUNT.usage, credits: 500 } };
  await openPage('plus');
  await page.locator('#plusPanel button:has-text("ログアウト")').click();
  await page.waitForSelector('#plusPanel :text("ログインしていません")');
  await page.locator('#plusPanel button:has-text("ログイン")').first().click();
  {
    let seen = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
    const before = seen.length;
    const dl = Date.now() + 10_000;
    while (seen.length <= before - 0 && Date.now() < dl) { await new Promise(r => setTimeout(r, 50)); seen = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean); if (seen.length > before) break; }
    const e2 = await ctx.newPage();
    await e2.goto(seen.at(-1));
    await page.waitForSelector('#plusPanel button:has-text("ログアウト")', { timeout: 15_000 });
    await e2.close();
  }
  await page.waitForSelector('#plusPanel :text("上限に達しました")', { timeout: 15_000 });
  await openPage('computer');
  await page.waitForSelector('#computerPanel :text("上限に達しました")');
  ok('上限に達したときは 1 文と「アカウントを管理」', (await computerText()).includes('アカウントを管理'), await computerText());
  // モック 03: 1 文と「アカウントを管理」は灰色の枠（.nf-card）の中、Pleiad Plus の行のすぐ下（OpenRouter の行の上）
  const order = await page.evaluate(() => {
    const g = document.querySelector('#computerPanel [role=radiogroup]');
    return { card: !!g.closest('.nf-card') && g.closest('.nf-card').contains(g.querySelector('.rm-err')), kids: [...g.children].map(c => c.getAttribute('role') === 'radio' ? 'radio:' + c.querySelector('.rm-nm').textContent : c.className.split(' ')[0]) };
  });
  ok('1 文と「アカウントを管理」が枠の中・Pleiad Plus の行と OpenRouter の行の間', order.card && order.kids.join(',') === 'radio:Pleiad Plus,rm-err,rm-acts,radio:OpenRouter,radio:使わない', JSON.stringify(order));
  await shots('settings-plus-limit', '#computerPanel');

  // ---- 会話の行の「未確認」（render.mjs を直に呼んで #thread に置く）
  await page.locator('#backToChat').click();
  await page.waitForFunction(() => !document.body.classList.contains('settings'));
  // 設定から戻ると案内の窓（fake のエージェントしか無いため）が開き直す。幕が画像に写らないよう、この確かめの間だけ畳んで隠す
  await page.addStyleTag({ content: '#onboardingDialog{display:none !important}' });
  await page.evaluate(async () => {
    const { renderToolCall, applyToolResult } = await import('/render.mjs');
    const thread = document.getElementById('thread');
    const mk = (wait, title) => {
      const card = renderToolCall('mcp__ply_computer__wait_until', { title, until: 'Is it done?' }, { id: 'w' + Math.random() });
      applyToolResult(card, { text: '待ちました', isError: false, computer: { tool: 'wait_until', state: 'ok', title, wait } });
      thread.append(card);
    };
    window.__mk = mk;
    mk({ status: 'unverified', reason: 'plus_credit', via: 'plus', reset_at: '2026-12-01T00:00:00+09:00', checks: 0, waited_ms: 3000 }, '読み込みが終わるまで待つ');
    mk({ status: 'unverified', reason: 'plus_logged_out', via: 'plus', checks: 0, waited_ms: 3000 }, '保存が終わるまで待つ');
    mk({ status: 'error', reason: 'http_401', checks: 1, waited_ms: 3000 }, '変換が終わるまで待つ');
    mk({ status: 'unverified', reason: 'no_key', checks: 0, waited_ms: 3000 }, 'ダウンロードが終わるまで待つ');
  });
  const cards = page.locator('#thread .tc-computer');
  ok('未確認の行は 3 つ（使わない（no_key）には付けない）', (await page.locator('#thread .tc-unverified').count()) === 3, String(await page.locator('#thread .tc-unverified').count()));
  ok('右端に「未確認」', (await page.locator('#thread .tc-unv').first().innerText()) === '未確認');
  ok('理由と設定へのリンク', (await page.locator('#thread .tc-unv-line').first().innerText()).includes('今月の Pleiad Plus の上限に達しているため'));
  await page.locator('#thread .tc-unv-open').first().scrollIntoViewIfNeeded();
  await shots('thread-unverified', '#thread');
  // リンクで設定 › コンピューターの操作 が開く
  // 案内の窓の gate（fake のエージェントしか無い）が会話を inert にしているので、実際の押下は dispatchEvent で届ける
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.locator('#thread .tc-unv-open').first().dispatchEvent('click');
  await page.waitForSelector('#computerPanel:not([hidden])');
  ok('「設定 › コンピューターの操作 を開く」で設定のそのページが開く', true);
} catch (e) {
  console.log('  NG  例外', e?.stack ?? e);
  failures++;
} finally {
  await browser?.close();
  await server?.stop?.();
  await plus.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures ? `\n  失敗 ${failures} 件` : '\n  全て通過');
process.exit(failures ? 1 : 0);
