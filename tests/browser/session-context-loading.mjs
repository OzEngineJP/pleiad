// 会話のプラグインの取得状態。別ポート・使い捨てデータと fake の応答だけを使う。
// node tests/browser/session-context-loading.mjs。画像・確認結果は temporary/ に残す。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}
const out = path.join(ROOT, 'temporary/mockups/session-context-loading-impl');
fs.mkdirSync(out, { recursive: true });
const dataRoot = fs.mkdtempSync(path.join(out, 'data-'));
const cwd = path.join(dataRoot, 'work'); fs.mkdirSync(cwd);
execFileSync('git', ['init', '--quiet', cwd]);
fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Working agreements\n\nRead the project instructions before editing files.\n');
const empty = { duplicates: [], missing: [], more: {} };
const findings = { ...empty, missing: [{ target: 'docs/setup.md', path: path.join(cwd, 'AGENTS.md'), scope: 'dir', line: 3, from: 'repo' }] };
const evidence = [], errors = [];
let host, client, browser;
try {
  host = await startServer({ dataDir: path.join(dataRoot, 'data'), env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: path.join(dataRoot, 'codex.log') } });
  client = await open({ ...host, autoAllow: true });
  await client.cmd('onboardingSeen');
  const none = { sources: [], excludePaths: [] };
  for (const kind of ['instruction', 'skill', 'mcp']) await client.cmd('setContextSettings', { cwd, place: cwd, kind,
    value: { owner: 'ply', user: none, directory: kind === 'instruction' ? { sources: ['common'], excludePaths: [] } : none } });
  const managed = await client.cmd('newSession', { cwd, backend: 'fake' });
  await client.runTurn({ ...managed, prompt: 'echo:表示を確認します' });
  const nativeCwd = path.join(dataRoot, 'native'); fs.mkdirSync(nativeCwd);
  execFileSync('git', ['init', '--quiet', nativeCwd]);
  fs.writeFileSync(path.join(nativeCwd, 'AGENTS.md'), '# Working agreements\nRead the project instructions before editing files.\n');
  const native = await client.cmd('newSession', { cwd: nativeCwd, backend: 'codex' });
  await client.runTurn({ ...native, prompt: '表示を確認します', mode: 'full' });
  const unstarted = await client.cmd('newSession', { cwd, backend: 'fake' });
  browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--use-angle=d3d11'] });

  async function scenario(state, width, theme = 'light') {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: theme, locale: 'ja-JP' });
    const commands = new Map(), held = [], counts = {};
    let downstream;
    const behavior = { hold: new Set(), fail: new Set(), replace: {} };
    if (['pending', 'menu-transition', 'report-race'].includes(state)) behavior.hold.add('sessionContext');
    if (state === 'partial-pending') for (const name of ['nativeInstructions', 'contextSettings', 'contextFindings']) behavior.hold.add(name);
    if (state === 'error') behavior.fail.add('sessionContext');
    if (state === 'partial-error') for (const name of ['nativeInstructions', 'contextSettings', 'contextFindings']) behavior.fail.add(name);
    behavior.replace.contextFindings = ['loaded', 'refreshing', 'partial-refreshing'].includes(state) ? findings : empty;
    if (state === 'unknown') Object.assign(behavior.replace, { nativeInstructions: { entries: null }, contextFindings: null, contextSettings: null });
    if (state === 'native-empty') behavior.replace.nativeInstructions = { entries: [] };
    if (state === 'empty') behavior.replace.sessionContext = r => ({ ...r, report: { ...r.report, entries: [] } });
    if (state === 'refreshing') behavior.replace.sessionContext = r => ({ ...r, changed: { differs: true, paths: [path.join(cwd, 'AGENTS.md')], files: [] } });
    const reportTransform = behavior.replace.sessionContext ?? (r => r);
    behavior.replace.sessionContext = r => r == null ? r : reportTransform({ ...r, report: r.report ? { ...r.report,
      entries: r.report.entries.filter(e => e.kind !== 'instruction' || path.resolve(e.path) === path.join(cwd, 'AGENTS.md')) } : r.report });
    behavior.replace.nativeInstructions ??= { entries: [{ id: 'native-fixture', name: 'AGENTS.md', path: path.join(nativeCwd, 'AGENTS.md'), scope: 'dir', tokens: 19 }] };
    await ctx.routeWebSocket(/\/ws/, ws => {
      downstream = ws;
      const upstream = ws.connectToServer();
      ws.onMessage(raw => {
        const m = JSON.parse(String(raw));
        if (m.kind === 'command') { commands.set(m.id, m.command); counts[m.command] = (counts[m.command] ?? 0) + 1; }
        upstream.send(raw);
      });
      upstream.onMessage(raw => {
        const m = JSON.parse(String(raw));
        const name = m.kind === 'response' ? commands.get(m.id) : null;
        const send = () => {
          if (behavior.fail.has(name)) { m.ok = false; m.error = 'Fixture request failure'; delete m.result; }
          else if (Object.hasOwn(behavior.replace, name)) m.result = typeof behavior.replace[name] === 'function' ? behavior.replace[name](m.result) : behavior.replace[name];
          try { ws.send(JSON.stringify(m)); } catch {}
        };
        if (behavior.hold.has(name)) held.push({ name, send, message: m }); else send();
      });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const usesNative = ['unknown', 'partial-pending', 'partial-error', 'native-empty', 'partial-refreshing'].includes(state);
    const id = (state === 'unstarted' ? unstarted : usesNative ? native : managed).sessionId;
    await page.goto(`http://127.0.0.1:${host.port}/?token=${host.token}`, { waitUntil: 'load' });
    await page.waitForSelector(`[data-session="${id}"]`, { state: 'attached' });
    await page.evaluate(() => document.querySelector('#onboardingDialog')?.close());
    await page.locator(`[data-session="${id}"]`).first().click();
    await page.waitForFunction(() => !document.querySelector('#contextEntry').hidden);
    await page.setViewportSize({ width, height: 1000 });
    async function shot(suffix = '') {
      await page.waitForTimeout(260);
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth,
        panel: document.querySelector('.file-preview-content').scrollWidth > document.querySelector('.file-preview-content').clientWidth }));
      assert.equal(overflow.page, false, `${state}/${width}: page overflow`);
      assert.equal(overflow.panel, false, `${state}/${width}: panel overflow`);
      const name = `${state}-${width}-${theme}${suffix}`;
      await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'allow' });
      const entry = await page.locator('#contextEntry').evaluate(e => ({ title: e.title, label: e.getAttribute('aria-label'), mark: e.querySelector('.entry-context-state')?.getAttribute('aria-hidden') }));
      evidence.push({ name, text: await page.locator('.scx').count() ? await page.locator('.scx').innerText() : '', entry, overflow });
    }
    async function openPanel(menuShot = false) {
      if (width === 360) {
        await page.locator('#sessionMore').click();
        if (menuShot) await shot('-menu');
        await page.getByRole('menuitem', { name: /プラグイン/ }).click();
      } else await page.locator('#contextEntry').click();
      await page.waitForSelector('.scx');
    }
    try {
    if (state === 'menu-transition') {
      await page.locator('#sessionMore').click();
      const row = page.getByRole('menuitem', { name: /プラグイン/ });
      assert.match(await row.innerText(), /読み込み中/);
      await shot('-pending');
      behavior.fail.add('sessionContext'); behavior.hold.clear(); held.splice(0).forEach(r => r.send());
      await page.waitForFunction(() => document.querySelector('.context-entry-status')?.textContent === '読み取れませんでした');
      await shot('-failed');
      await row.click();
      behavior.fail.clear();
      await page.locator('.scx').getByRole('button', { name: '再試行' }).click();
      await page.waitForFunction(() => document.querySelector('.scx')?.innerText.includes('気になる所なし'));
      return;
    }
    await openPanel(['pending', 'error'].includes(state));
    const panel = page.locator('.scx');
    const expectText = async text => { await page.waitForFunction(text => document.querySelector('.scx')?.innerText.includes(text), text); };
    if (state === 'report-race') {
      await page.waitForFunction(() => document.querySelector('.scx')?.innerText.includes('読み込み中'));
      const record = held.find(r => r.name === 'sessionContext' && r.message.result?.report)?.message.result;
      assert(record);
      const newer = { ...record.report, entries: record.report.entries.map(e => e.kind === 'instruction' ? { ...e, name: 'newer-instructions.md' } : e) };
      record.refreshedAt = Date.UTC(2020, 0, 2, 3, 4);
      downstream.send(JSON.stringify({ kind: 'event', event: { type: 'contextUsage', sessionId: id, report: newer, plyParts: record.plyParts } }));
      await expectText('newer-instructions.md');
      behavior.hold.clear(); held.splice(0).forEach(r => r.send());
      await page.waitForFunction(() => document.querySelector('.file-preview-path')?.innerText.includes('読み込み直し'));
      await expectText('newer-instructions.md');
      await shot();
      return;
    }
    if (state === 'pending') {
      await expectText('読み込み中…');
      assert(!(await panel.innerText()).includes('まだ始まっていません'));
      assert.match(await page.locator('#contextEntry').getAttribute('aria-label'), /読み込み中/);
    } else if (state === 'error') {
      await expectText('読み取れませんでした');
      assert(!(await panel.innerText()).includes('まだ始まっていません'));
    } else if (state === 'partial-pending') {
      await expectText('設定を読み込み中…'); await expectText('OpenAI Codex が読む指示を探しています…'); await expectText('確認中…');
      assert(await page.locator('[data-act=placeStart]').isDisabled());
      assert.equal(await panel.locator('.scx-n').count(), 0);
      assert(!(await panel.locator('.scx-issues').innerText()).includes('気になる所なし'));
      assert.equal(await panel.locator('.scx-state .run').count(), 4);
    } else if (state === 'partial-error') {
      for (const text of ['指示ファイルを読み取れませんでした', '設定を読み取れませんでした', '気になる所を確認できませんでした']) await expectText(text);
      assert.equal(await panel.locator(':scope > .scx-state').count(), 0, 'partial failure stays local');
    } else if (state === 'unknown') {
      for (const text of ['設定を確認できません', '自分で読む指示は数えていません', '確認できません']) await expectText(text);
      assert.equal((await panel.locator('.scx-issues').innerText()).replaceAll('\n', ''), '気になる所確認できません');
      assert(!(await panel.innerText()).includes('気になる所なし'));
      assert(await page.locator('[data-act=placeStart]').isDisabled());
    } else if (state === 'native-empty') {
      await expectText('OpenAI Codex が読む指示ファイルは見つかりませんでした'); await expectText('気になる所なし');
    } else if (state === 'empty') {
      for (const text of ['渡した指示ファイルはありません', '案内した Skill はありません', 'つなぐ MCP はありません', '気になる所なし']) await expectText(text);
    } else if (state === 'unstarted') await expectText('この会話はまだ始まっていません');
    else await expectText('無いパス');
    if (state === 'refreshing') {
      await expectText('AGENTS.md');
      behavior.hold.add('sessionContext');
      await page.getByRole('button', { name: '新しい内容で会話を続ける', exact: true }).click();
      await expectText('更新中…'); await expectText('AGENTS.md');
      assert.match(await page.locator('#contextEntry').getAttribute('aria-label'), /更新中/);
      assert.equal(await page.locator('#contextEntry .entry-dot').count(), 1);
      assert.equal(await page.locator('#contextEntry .entry-context-state').getAttribute('aria-hidden'), 'true');
      assert.equal(await panel.locator('.scx-n').innerText(), '1');
    }
    if (state === 'partial-refreshing') {
      await expectText('AGENTS.md'); await expectText('無いパス');
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.locator('#contextEntry').click();
      for (const name of ['nativeInstructions', 'contextSettings', 'contextFindings']) behavior.hold.add(name);
      await page.locator('#contextEntry').click();
      await page.setViewportSize({ width, height: 1000 });
      await expectText('指示ファイルを再確認中…'); await expectText('設定を更新中…'); await expectText('気になる所を再確認中…');
      await expectText('AGENTS.md'); await expectText('無いパス');
      assert(await page.locator('[data-act=placeStart]').isDisabled());
      assert.match(await panel.locator('.scx-kind:not(.scx-amount)').first().textContent(), /AGENTS.md/);
      assert.match(await panel.locator('.scx-place .p').innerText(), /設定どおり/);
    }
    await shot();
    if (state === 'pending' || state === 'partial-pending' || state.includes('refreshing')) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const animations = await page.locator('.scx-state .wait-dot, #contextEntry .wait-dot').evaluateAll(es => es.map(e => getComputedStyle(e).animationName));
      assert(animations.length > 0);
      assert(animations.every(name => name === 'none'), 'reduced motion stops every loading mark');
      if (state === 'partial-refreshing') behavior.fail.add('nativeInstructions');
      behavior.hold.clear(); held.splice(0).forEach(r => r.send());
      await page.waitForFunction(() => !document.querySelector('.scx-state .run'));
      if (state === 'partial-refreshing') {
        await expectText('指示ファイルを読み取れませんでした');
        assert.match(await panel.locator('.scx-kind:not(.scx-amount)').first().textContent(), /AGENTS.md/);
        await shot('-failed');
        behavior.fail.clear();
        behavior.replace.nativeInstructions.entries[0].name = 'updated-instructions.md';
        await panel.locator('.scx-amount').getByRole('button', { name: '再試行' }).first().click();
        await page.waitForFunction(() => document.querySelector('.scx-kind:not(.scx-amount)')?.textContent.includes('updated-instructions.md'));
        assert(!(await panel.innerText()).includes('読み取れませんでした'));
        await shot('-retried');
      }
    }
    if (state === 'error' || state === 'partial-error') {
      const before = { ...counts }; behavior.fail.clear();
      if (state === 'error') await panel.getByRole('button', { name: '再試行', exact: true }).click();
      else {
        await panel.locator('.scx-place').getByRole('button', { name: '再試行' }).click();
        await page.waitForFunction(() => !document.querySelector('.scx-place')?.innerText.includes('再試行'));
        assert.equal(counts.nativeInstructions, before.nativeInstructions, 'settings retry does not retry native');
        assert.equal(counts.contextFindings, before.contextFindings, 'settings retry does not retry findings');
        await panel.locator('.scx-amount').getByRole('button', { name: '再試行' }).first().click();
        await page.waitForFunction(() => !document.querySelector('.scx-amount > .scx-state')?.innerText.includes('再試行'));
        await panel.locator('.scx-issues').getByRole('button', { name: '再試行' }).click();
      }
      await expectText('気になる所なし');
      assert(!(await panel.innerText()).includes('読み取れませんでした'));
      await shot('-retried');
    }
    } catch (error) {
      await page.screenshot({ path: path.join(out, 'failure.png') });
      fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
      throw error;
    } finally { await ctx.close(); }
  }
  const states = process.env.CONTEXT_STATES?.split(',') ?? ['pending', 'loaded', 'empty', 'unknown', 'error', 'refreshing', 'partial-pending', 'partial-error', 'native-empty', 'unstarted', 'partial-refreshing', 'report-race', 'menu-transition'];
  for (const width of (process.env.CONTEXT_WIDTHS?.split(',').map(Number) ?? [1280, 360])) for (const theme of (process.env.CONTEXT_THEMES?.split(',') ?? ['light', 'dark'])) {
    for (const state of states) {
      if (state === 'menu-transition' && width !== 360) continue;
      await scenario(state, width, theme);
      console.log('PASS', state, width, theme);
    }
  }
  assert.deepEqual(errors, [], 'no browser exceptions');
  fs.writeFileSync(path.join(out, 'screenshots.txt'), evidence.map(r => path.join(out, r.name + '.png')).join('\n') + '\n');
  console.log(`PASS ${evidence.length} screenshots`);
} finally {
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ evidence, errors }, null, 2));
  await browser?.close(); client?.close(); await host?.stop();
  assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(out));
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
