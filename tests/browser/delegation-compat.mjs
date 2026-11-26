// 設定 › 委譲「レベルごとの候補」に互換の接続先（ADR 0360）を実ブラウザーで確かめる:
//   候補の行は ◇ と「モデル · 接続先」、下の行は「エージェント · 使用量は読めない」。確認に失敗した接続先の候補は .off と
//   「使えない（確認に失敗） · 確認し直す」。押すと確かめ直して使える行に戻る。
//   ［候補を追加］の接続先の段は CLI のログイン → 互換の接続先 → 接続先を管理… の順。確認に失敗した接続先は理由付きで選べない。
//   互換の接続先を選ぶとモデルの段は接続先のモデル（メインに「既定」）。モデルを選んで追加すると段に `codex@<接続先>:<モデル>` が入る。
//   打鍵だけで（Tab・Enter・矢印）追加まで進める。
// codex の身代わり（tests/lib/fake-codex.mjs）と偽の互換 API（tests/lib/fake-compat-api.mjs）だけと話す。
// 実行: node tests/browser/delegation-compat.mjs  （DELEG_COMPAT_SHOTS=<ディレクトリ> で場面ごとの画像。SHOT_VIEWPORT=360x780・SHOT_COLOR=dark）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.DELEG_COMPAT_SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-delegcompat-ui-' + 'e'.repeat(24);
const MODEL = 'vendor/fake-large';
const SMALL = 'fake-small';

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const [VW, VH] = (process.env.SHOT_VIEWPORT || '1280x900').split('x').map(Number);
const COLOR = process.env.SHOT_COLOR || 'light';
const tag = `${VW}-${COLOR}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-deleg-compat-ui-'));
const api = await startFakeCompatApi({ keys: [KEY], auth: 'bearer', models: [MODEL, SMALL] });
let server, browser, failures = 0;
const ok = (name, cond, extra = '') => { console.log(`  ${cond ? 'OK' : 'NG'}  ${name}${cond ? '' : `  — ${extra}`}`); if (!cond) failures++; };
const shot = async (target, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `delegation-compat-${tag}-${name}.png`) });
};
const until = async (fn, label, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, 80)); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

// 初めての案内を出さない（設定の画面を閉じてしまうため）
fs.writeFileSync(path.join(dataDir, 'onboarding.json'), JSON.stringify({ seen: true, setupComplete: true, backend: 'codex', cwd: dataDir }));
try {
  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"` } });
  const admin = await open({ port: server.port, token: server.token });
  const register = async name => {
    const input = { agent: 'codex', name, preset: 'custom', baseUrl: `${api.url}/v1`, authMode: 'bearer', key: KEY, roles: { main: MODEL } };
    const checked = await admin.cmd('compatEndpointCheck', { input });
    return (await admin.cmd('compatEndpointSave', { input, receipt: checked.receipt })).id;
  };
  const A = await register('偽の互換 A');
  const F = await register('落ちる互換');
  // F だけ確認に失敗させる（偽の API がキーを断る間に確かめ直す）。戻すのは画面の「確認し直す」の前
  api.set({ keys: ['sk-other-' + 'x'.repeat(20)] });
  const failed = await admin.cmd('compatEndpointRecheck', { id: F });
  api.set({ keys: [KEY] });
  ok('準備: F の確認が失敗した', failed?.ok === false, JSON.stringify(failed));
  const candA = `codex@${A}:${MODEL}`, candF = `codex@${F}:${MODEL}`;
  await admin.cmd('setDelegationRouting', { settings: { tiers: { t1: [candA, candF, 'fake:fast'] } } });

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, colorScheme: COLOR, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('DBG pageerror:', e.message); failures++; });
  await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // 初めての案内は遅れて開くことがある。閉じて設定を開くまで繰り返す
  await until(async () => page.evaluate(() => {
    document.getElementById('onboardingDialog')?.close();
    if (!document.body.classList.contains('settings')) document.getElementById('settings')?.click();
    return document.body.classList.contains('settings') && !document.querySelector('dialog[open]');
  }), '設定を開く');
  await page.evaluate(() => document.getElementById('delegationTab')?.click());
  await page.waitForSelector('#delegationPanel .rt-advanced', { state: 'attached' });
  await page.locator('#delegationPanel .rt-advanced > summary').click();
  const row = c => page.locator(`#delegationPanel .rt-cand-row[data-candidate="${c}"]`);
  await row(candA).waitFor();

  // ---- 1. 候補の行 ----
  {
    const tx = await row(candA).innerText();
    ok('互換の候補: 「vendor/fake-large · 偽の互換 A」', tx.includes(`${MODEL} · 偽の互換 A`), tx);
    ok('互換の候補: 下の行は「Codex · 使用量は読めない」', tx.includes('Codex · 使用量は読めない'), tx);
    ok('互換の候補: 使える（.off でない）', !(await row(candA).evaluate(n => n.classList.contains('off'))));
    ok('互換の候補: チップに ◇ の印', (await row(candA).locator('.rt-picker-chip .compat-mark').innerText()).includes('◇'), await row(candA).locator('.rt-picker-chip').innerHTML());
    const fx = await row(candF).innerText();
    ok('確認に失敗した候補: .off と「使えない（確認に失敗）」', (await row(candF).evaluate(n => n.classList.contains('off'))) && fx.includes('確認に失敗'), fx);
    ok('確認に失敗した候補: 「確認し直す」がある', await row(candF).locator('.rt-recheck').count() === 1);
    await row(candA).scrollIntoViewIfNeeded();
    await shot(page, 'rows');
  }

  // ---- 2. 「確認し直す」（打鍵で押す）→ 使える行に戻る ----
  {
    await row(candF).locator('.rt-recheck').focus();
    await page.keyboard.press('Enter');
    await until(async () => !(await row(candF).evaluate(n => n.classList.contains('off'))) && (await row(candF).innerText()).includes('使用量は読めない'), '確認し直して使える');
    ok('「確認し直す」で使える行に戻る', true);
    // もう一度失敗させておく（ピッカーの「選べない」を見るため）
    api.set({ keys: ['sk-other-' + 'x'.repeat(20)] });
    await admin.cmd('compatEndpointRecheck', { id: F });
    api.set({ keys: [KEY] });
    await until(async () => row(candF).evaluate(n => n.classList.contains('off')), 'F がまた失敗');
  }

  // ---- 3. ［候補を追加］→ エージェント Codex → 接続先の段 ----
  const pop = page.locator('.rt-picker:not([hidden])');
  const item = key => pop.locator(`[data-key="${key}"]`);
  {
    const add = page.locator('#delegationPanel [data-fk="add|t1"]');
    await add.scrollIntoViewIfNeeded();
    await add.click();
    await pop.waitFor();
    await until(async () => (await item('nav:agent').count()) && !(await pop.innerText()).includes('…'), 'ピッカーの読み込み');
    if (!(await item('nav:agent').innerText()).includes('Codex')) {
      await item('nav:agent').click();
      await item('backend:codex').click();
      await until(async () => (await item('nav:agent').innerText()).includes('Codex'), 'Codex を選ぶ');
    }
    await until(async () => (await item('nav:conn').count()) > 0, '接続先の行');
    await item('nav:conn').click();
    const keys = await pop.locator('[data-key]').evaluateAll(ns => ns.map(n => n.dataset.key));
    const order = keys.filter(k => /^(account:|endpoint:|epmanage)/.test(k));
    ok('接続先の段の並び: CLI のログイン → 互換の接続先 → 接続先を管理…', JSON.stringify(order) === JSON.stringify(['account:', `endpoint:${A}`, `endpoint:${F}`, 'epmanage']), JSON.stringify(order));
    const fRow = item(`endpoint:${F}`);
    ok('確認に失敗した接続先: 選べない', (await fRow.getAttribute('aria-disabled')) === 'true' || await fRow.isDisabled());
    ok('確認に失敗した接続先: 理由が出る', /失敗/.test(await fRow.innerText()), await fRow.innerText());
    ok('互換の接続先の行に種類と URL', (await item(`endpoint:${A}`).innerText()).includes('127.0.0.1'), await item(`endpoint:${A}`).innerText());
    await shot(pop, 'pop-conn');

    // ---- 4. 互換の接続先を選ぶ → モデルの段は接続先のモデル ----
    await item(`endpoint:${A}`).click();
    await until(async () => (await item('nav:conn').innerText()).includes('偽の互換 A'), '接続先が変わる');
    // メインのモデル（vendor/fake-large）は既にこのレベルにあるので、一覧の次のモデルで候補を作る
    ok('接続先を選ぶとモデルは接続先のモデルのうちレベルに無いもの（メインは既にある）', (await item('nav:model').innerText()).includes(SMALL), await item('nav:model').innerText());
    await item('nav:model').click();
    const models = await pop.locator('[data-key^="model:"]').evaluateAll(ns => ns.map(n => n.dataset.key));
    ok('モデルの段は接続先の一覧（メイン・ほか）', models.includes(`model:${MODEL}`) && models.includes(`model:${SMALL}`), JSON.stringify(models));
    ok('モデルの段に ID の入力欄', await pop.locator('[data-key="model-q"]').count() === 1);
    ok('メインのモデルは既にレベルにあるので選べない（理由付き）', (await item(`model:${MODEL}`).getAttribute('aria-disabled')) === 'true' && /追加済み/.test(await item(`model:${MODEL}`).innerText()),
      await item(`model:${MODEL}`).innerText());
    await shot(pop, 'pop-model');
  }

  // ---- 5. 打鍵でモデルを選んで追加 ----
  {
    await item(`model:${SMALL}`).focus();
    await page.keyboard.press('Enter');
    await until(async () => (await item('nav:model').count()) && (await item('nav:model').innerText()).includes(SMALL), 'モデルが変わる');
    const confirm = item('confirm');
    await confirm.focus();
    ok('［追加］にフォーカスが届く', await confirm.evaluate(n => n === document.activeElement));
    await page.keyboard.press('Enter');
    const added = `codex@${A}:${SMALL}`;
    await until(async () => (await admin.cmd('delegationRouting')).settings.tiers.t1.includes(added), '段に追加された');
    ok('段に codex@<接続先>:<モデル> が入る（明示のモデル ID）', true);
    await row(added).waitFor();
    ok('追加した候補の行: 「fake-small · 偽の互換 A」', (await row(added).innerText()).includes(`${SMALL} · 偽の互換 A`));
    ok('追加の後、フォーカスは追加した候補のチップ', await page.evaluate(() => document.activeElement?.dataset?.fk ?? '') === 'picker|t1|3',
      await page.evaluate(() => document.activeElement?.dataset?.fk ?? ''));
    await page.locator('#delegationPanel .rt-cand-list').scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, 'rows-added');
  }

  // ---- 6. 接続先を消すと段から外れる（画面も描き直す）----
  {
    await admin.cmd('compatEndpointDelete', { id: F });
    await until(async () => (await row(candF).count()) === 0, '消した接続先の候補が段から消える');
    ok('接続先を消すと候補が段から外れる', !(await admin.cmd('delegationRouting')).settings.tiers.t1.includes(candF));
  }
  await ctx.close();
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await api.close().catch(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
if (failures) { console.error(`\n失敗 ${failures} 件`); process.exit(1); }
console.log('\n全て通過');
