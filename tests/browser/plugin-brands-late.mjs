// PowerShell: $env:PW_CORE='C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core'; node tests/browser/plugin-brands-late.mjs
// 本物の別ポートのサーバーと使い捨ての home。一覧の応答だけを保留し、4 タブの初回表示と遅着後を確認する。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PW_CORE);
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const version = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
  return path.join(base, version, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
}
const shots = process.env.SHOT_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-plugin-brands-'));
const home = path.join(root, 'home');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const errors = [], observations = [];
let server, client, browser;
try {
  write(path.join(home, '.claude/CLAUDE.md'), '# Test instructions\n');
  write(path.join(home, '.codex/skills/demo/SKILL.md'), '---\nname: demo\ndescription: demo\n---\nTest skill\n');
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { demo: { command: 'test-only' } } }));
  write(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo test' }] }] } }));
  write(path.join(home, '.grok/auth.json'), JSON.stringify({ apiKey: 'test-key' }));
  const grokStub = path.join(root, process.platform === 'win32' ? 'grok.cmd' : 'grok');
  write(grokStub, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(grokStub, 0o755);
  const bins = Object.fromEntries(['CLAUDE', 'CODEX', 'AGY', 'OPENCODE', 'DEVIN', 'GROK'].map(n => [`AGENT_HOST_${n}_BIN`, path.join(root, `missing-${n}.exe`)]));
  server = await startServer({ dataDir: path.join(root, 'data'), env: {
    AGENT_HOST_BACKENDS: 'fake,claude,codex,antigravity,opencode,devin,grok',
    HOME: home, USERPROFILE: home, PLEIAD_SCAN_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), ...bins,
    AGENT_HOST_GROK_BIN: grokStub, AGENT_HOST_GROK_HOME: path.join(home, '.grok'),
  } });
  client = await open({ ...server, autoAllow: true });
  await client.cmd('onboardingSeen');
  const session = await client.cmd('newSession', { backend: 'fake', cwd: home });
  await client.runTurn({ ...session, prompt: 'echo:plugin brands' });
  browser = await chromium.launch({ executablePath: chromiumPath() });
  for (const tab of ['instruction', 'skill', 'mcp', 'hooks']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    // 本番は受信済みの一覧をキャッシュする。再到着そのものはテスト限定の入口から同じ loadBackends を通す。
    await page.route('**/client.mjs', async route => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: body + '\nwindow.__repeatBrands = change => { const list = structuredClone(state.backends); if (change) list.find(b => b.id === "claude").shortLabel = "Claude " + change; state.backends = []; return loadBackends(list); };' });
    });
    await page.addInitScript(id => {
      localStorage.setItem('agent-host-current', id);
      const Native = window.WebSocket;
      window.__brandHeld = [];
      window.__saveHeld = [];
      window.__holdSaves = false;
      window.__releaseSaves = () => { window.__holdSaves = false; for (const resume of window.__saveHeld.splice(0)) resume(); };
      window.__brandCommands = [];
      window.__brandReleased = false;
      window.__releaseBrands = () => { window.__brandReleased = true; for (const resume of window.__brandHeld.splice(0)) resume(); };
      window.WebSocket = class extends Native {
        send(data) {
          const m = JSON.parse(data);
          window.__brandSocket = this;
          window.__brandCommands.push(m.command);
          if (window.__holdSaves && /^set(Doc|Mcp|Hook|Ply)/.test(m.command)) (this.saveIds ??= new Set()).add(m.id);
          if (m.command === 'backends') (this.brandIds ??= new Set()).add(m.id);
          return super.send(data);
        }
        set onmessage(fn) {
          super.onmessage = e => {
            const m = JSON.parse(e.data);
            if (!window.__brandReleased && this.brandIds?.has(m.id)) window.__brandHeld.push(() => fn(e));
            else if (window.__holdSaves && this.saveIds?.has(m.id)) window.__saveHeld.push(() => fn(e));
            else fn(e);
          };
        }
        get onmessage() { return super.onmessage; }
      };
    }, session.sessionId ?? session.id);
    await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__brandHeld.length > 0);
    await page.evaluate(() => {
      document.getElementById('onboardingDialog')?.close();
      document.getElementById('settings').click();
      document.getElementById('openContext').click();
    });
    await page.locator(`#cx-tab-${tab}`).click();
    const panel = page.locator(`#cx-panel-${tab}`);
    await panel.locator('button.cx-ag .mk').first().waitFor();
    const before = await panel.locator('button.cx-ag .mk').evaluateAll(els => els.map(e => e.tagName));
    assert(before.includes('SPAN'), `${tab}: 一覧より先に表が出る`);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `plugin-polish-pending-${tab}.png`) }); }
    // 詳細・確認の帯を開き、帯のボタンへフォーカス。保存はしない。
    const rows = panel.locator('.cx-row[data-key]');
    const detail = rows.locator('button.nm, button.cx-open').first();
    if (await detail.count()) await detail.click();
    const target = rows.locator('button.cx-ag[data-agent="opencode"][aria-pressed="false"]:not([aria-disabled])').first();
    if (await target.count()) await target.click();
    const initialAdd = panel.locator('[data-add-place]').first();
    if (await initialAdd.count()) { await initialAdd.click(); await panel.locator('.cx-addbox input').fill('draft/search/location'); }
    const focused = await page.evaluate(() => {
      document.querySelector('.cx-ask .btn-primary')?.focus({ preventScroll: true });
      const sc = document.querySelector('.settings-content'); sc.scrollTop = 120;
      window.__brandFocusPath = [];
      const panel = document.querySelector('.cx-tabpanel:not([hidden])');
      for (let node = document.activeElement; node && node !== panel; node = node.parentElement) {
        if (!node.parentElement) break;
        window.__brandFocusPath.unshift(Array.from(node.parentElement.children).indexOf(node));
      }
      window.__brandFocusPanel = panel;
      return { ask: !!document.querySelector('.cx-ask'), peek: document.querySelectorAll('.cx-peek').length, scroll: sc.scrollTop };
    });
    await page.evaluate(() => window.__releaseBrands());
    await page.waitForFunction(async () => (await import('./agent-brands.mjs')).agentBrand('claude') !== null);
    await page.waitForTimeout(250);
    const after = await panel.locator('button.cx-ag .mk').evaluateAll(els => els.map(e => e.tagName));
    const state = await page.evaluate(() => ({ ask: !!document.querySelector('.cx-ask'), peek: document.querySelectorAll('.cx-peek').length, scroll: document.querySelector('.settings-content').scrollTop,
      focus: window.__brandFocusPath.reduce((node, index) => node?.children[index], window.__brandFocusPanel) === document.activeElement && document.activeElement !== document.body }));
    observations.push({ tab, before, after, focused, state });
    if (shots) await page.screenshot({ path: path.join(shots, `plugin-polish-after-${tab}.png`) });
    const initialDraft = await panel.locator('.cx-addbox input').evaluateAll(es => es.map(e => e.value));
    assert(!after.includes('SPAN'), `${tab}: 一覧が届いたらロゴになる`);
    assert.equal(state.ask, focused.ask, `${tab}: 確認の帯を保つ`);
    assert.equal(state.peek, focused.peek, `${tab}: 行の詳細を保つ`);
    assert.equal(state.scroll, focused.scroll, `${tab}: スクロールを保つ`);
    assert(state.focus, `${tab}: フォーカスを保つ`);
    assert(focused.ask && focused.peek > 0, `${tab}: 確認と詳細が実際に開いている`);
    const names = await panel.locator('button.cx-ag').evaluateAll(els => els.map(e => e.getAttribute('aria-label')).join(' '));
    assert(!names.includes('Devin CLI') && !names.includes('Grok Build'), `${tab}: 読み上げ名も短い名前へ更新する`);
    assert(names.includes('Devin') && names.includes('Grok'), `${tab}: 読み上げ名に一覧の短い名前が入る`);
    assert((await panel.locator('.cx-ask').innerText()).includes('OpenCode'), `${tab}: 確認の帯も一覧の短い名前へ更新する`);
    if (tab === 'instruction' && process.env.BRAND_MEASURE === '1') {
      const baseline = await page.evaluate(() => window.__brandCommands.length);
      console.log('MEASURE: settings open, passive 60 seconds');
      await page.waitForTimeout(60_000);
      const commands = await page.evaluate(n => window.__brandCommands.slice(n), baseline);
      console.log('MEASURE: ' + JSON.stringify({ seconds: 60, refreshes: commands.filter(c => c === 'listSessions').length, backends: commands.filter(c => c === 'backends').length }));
      const n = await page.evaluate(() => window.__brandCommands.filter(c => c === 'listSessions').length);
      await page.evaluate(() => window.__brandSocket.close());
      await page.waitForFunction(n => window.__brandCommands.filter(c => c === 'listSessions').length > n, n);
      await page.waitForTimeout(500);
      console.log('RECONNECT: ' + JSON.stringify(await page.evaluate(() => ({ refreshes: window.__brandCommands.filter(c => c === 'listSessions').length, backends: window.__brandCommands.filter(c => c === 'backends').length }))));
    }
    const add = panel.locator('[data-add-place]').first();
    if (await add.count()) await add.click();
    if (await panel.locator('.cx-addbox input').count()) await panel.locator('.cx-addbox input').fill('draft/search/location');
    const find = panel.locator('.cx-find input');
    if (await find.count()) await find.fill('dem');
    const findBefore = await find.evaluateAll(es => es.map(e => e.value));
    if (tab === 'skill') assert.deepEqual(findBefore, ['dem'], 'Skills の絞り込みへ実際に入力した');
    const draftBefore = await panel.locator('.cx-addbox input').evaluateAll(es => es.map(e => e.value));
    await panel.locator('button.cx-ag').first().evaluate(e => { window.__sameBrandElement = e; });
    await page.evaluate(() => window.__repeatBrands());
    const same = await page.evaluate(() => window.__sameBrandElement.isConnected);
    const draftAfter = await panel.locator('.cx-addbox input').evaluateAll(es => es.map(e => e.value));
    if (shots) await page.screenshot({ path: path.join(shots, 'plugin-polish-repeat-after-' + tab + '.png') });
    console.log('REPEAT: ' + JSON.stringify({ tab, same, draftBefore, draftAfter }));
    assert.deepEqual({ attached: same, draft: draftAfter, filter: await find.evaluateAll(es => es.map(e => e.value)) },
      { attached: true, draft: draftBefore, filter: findBefore }, tab + ': 同じ一覧なら DOM と入力途中の文字を保つ');
    if (tab === 'instruction') assert.deepEqual(initialDraft, ['draft/search/location'], '最初の到着でも入力途中の文字を保つ');
    const editor = panel.locator(tab === 'instruction' ? '.cx-budget input' : '.cx-fold input');
    if (await editor.count()) {
      await panel.locator('.cx-fold > summary').click();
      const draft = tab === 'instruction' ? '12345' : 'https://example.invalid/draft.json';
      await editor.fill(draft);
      await page.evaluate(() => window.__repeatBrands('editor'));
      assert.equal(await editor.inputValue(), draft, tab + ': 詳細設定の入力途中の文字を保つ');
      assert(await editor.evaluate(e => document.activeElement === e && e.closest('details').open), tab + ': 入力のフォーカスと詳細の開閉を保つ');
    }
    // 実際に短い名前が変わった到着でも、未保存の入力と鍵の吹き出しを保つ。
    const locked = panel.locator('button.cx-ag[data-tip]').first();
    if (await locked.count()) { await locked.click({ force: true }); await page.locator('.cx-tip.on').waitFor(); }
    const tipBefore = await page.locator('.cx-tip.on').count();
    await page.evaluate(() => window.__repeatBrands('changed'));
    const changedElement = await page.evaluate(() => window.__sameBrandElement.isConnected);
    const draftChanged = await panel.locator('.cx-addbox input').evaluateAll(es => es.map(e => e.value));
    const tipAfter = await page.locator('.cx-tip.on').count();
    console.log('CHANGE: ' + JSON.stringify({ tab, draftBefore, draftChanged, tipBefore, tipAfter }));
    assert(!changedElement, tab + ': 対応が変われば表を描き直す');
    assert.deepEqual(await find.evaluateAll(es => es.map(e => e.value)), findBefore, tab + ': 対応が変わっても絞り込みを保つ');
    assert.deepEqual(draftChanged, draftBefore, tab + ': 対応が変わっても入力途中の文字を保つ');
    assert.equal(tipAfter, tipBefore, tab + ': 対応が変わっても鍵の吹き出しを保つ');
    if (shots) await page.screenshot({ path: path.join(shots, `plugin-polish-changed-state-${tab}.png`) });
    // 応答を保留して、押した直後の状態が実際の対応変更でも戻らないことを確かめる。
    await page.evaluate(async () => (await import('./lock-tip.mjs')).hideLockTip());
    const saveButton = rows.locator('button.cx-ag[aria-pressed="true"]:not([aria-disabled]):visible').first();
    assert(await saveButton.count(), tab + ': 保存中の確認に使うマスがある');
    const saveKey = await saveButton.evaluate(e => e.closest('.cx-row').dataset.key);
    await page.evaluate(() => { window.__holdSaves = true; });
    await saveButton.click();
    await page.waitForFunction(() => window.__saveHeld.length > 0);
    const readPending = () => panel.locator('.cx-row').evaluateAll((es, key) => {
      const row = es.find(e => e.dataset.key === key);
      return row ? { row: row.querySelector('.cx-sw')?.getAttribute('aria-checked'), cells: [...row.querySelectorAll('button.cx-ag')].map(e => [e.dataset.agent, e.getAttribute('aria-pressed')]) } : null;
    }, saveKey);
    const pending = await readPending();
    await page.evaluate(() => window.__repeatBrands('pending'));
    const pendingAfter = await readPending();
    console.log('PENDING: ' + JSON.stringify({ tab, pending, pendingAfter }));
    assert.deepEqual(pendingAfter, pending, tab + ': 保存の応答を待つ間の見た目を保つ');
    await page.evaluate(() => window.__releaseSaves());
    await page.waitForTimeout(300);
    if (tab === 'instruction') {
      await panel.locator('.rt-grip:not([disabled]):visible').first().click();
      await page.locator('.pop.menu').first().evaluate(e => { window.__brandMenu = e; });
      await page.evaluate(() => window.__repeatBrands());
      assert(await page.evaluate(() => window.__brandMenu.isConnected), '同じ一覧ではメニューを保つ');
      await page.evaluate(() => window.__repeatBrands('menu'));
      assert(await page.evaluate(() => window.__brandMenu.isConnected), '対応が変わってもメニューを保つ');
    }

    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(observations));
  console.log('PASS: 4 タブの遅着・同じ一覧の DOM と入力・変更時の吹き出しと保存中の表示・詳細・確認・フォーカス・スクロール');
} finally {
  await browser?.close(); client?.close(); await server?.stop();
  fs.rmSync(root, { recursive: true, force: true });
  if (server) console.log(`CLEANUP: ${JSON.stringify({ pid: server.child.pid, port: server.port, exited: server.child.exitCode !== null || server.child.signalCode !== null })}`);
}
