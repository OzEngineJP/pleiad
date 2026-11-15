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
const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const version = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
const executablePath = process.env.PW_CHROMIUM || path.join(base, version, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
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
  browser = await chromium.launch({ executablePath });
  for (const tab of ['instruction', 'skill', 'mcp', 'hooks']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(id => {
      localStorage.setItem('agent-host-current', id);
      const Native = window.WebSocket;
      window.__brandHeld = [];
      window.__brandReleased = false;
      window.__releaseBrands = () => { window.__brandReleased = true; for (const resume of window.__brandHeld.splice(0)) resume(); };
      window.WebSocket = class extends Native {
        send(data) {
          const m = JSON.parse(data);
          if (m.command === 'backends') (this.brandIds ??= new Set()).add(m.id);
          return super.send(data);
        }
        set onmessage(fn) {
          super.onmessage = e => {
            const m = JSON.parse(e.data);
            if (!window.__brandReleased && this.brandIds?.has(m.id)) window.__brandHeld.push(() => fn(e));
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
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `plugin-polish-${process.env.BASELINE ? 'before' : 'pending'}-${tab}.png`) }); }
    // 詳細・確認の帯を開き、帯のボタンへフォーカス。保存はしない。
    const rows = panel.locator('.cx-row[data-key]');
    const detail = rows.locator('button.nm, button.cx-open').first();
    if (await detail.count()) await detail.click();
    const target = rows.locator('button.cx-ag[data-agent="opencode"][aria-pressed="false"]:not([aria-disabled])').first();
    if (await target.count()) await target.click();
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
    if (shots) await page.screenshot({ path: path.join(shots, `plugin-polish-${process.env.BASELINE ? 'stale' : 'after'}-${tab}.png`) });
    if (!process.env.BASELINE) {
      assert(!after.includes('SPAN'), `${tab}: 一覧が届いたらロゴになる`);
      assert.equal(state.ask, focused.ask, `${tab}: 確認の帯を保つ`);
      assert.equal(state.peek, focused.peek, `${tab}: 行の詳細を保つ`);
      assert.equal(state.scroll, focused.scroll, `${tab}: スクロールを保つ`);
      assert(state.focus, `${tab}: フォーカスを保つ`);
      assert(focused.ask && focused.peek > 0, `${tab}: 確認と詳細が実際に開いている`);
      const names = await panel.locator('button.cx-ag').evaluateAll(els => els.map(e => e.getAttribute('aria-label')).join(' '));
      assert(!names.includes('Devin CLI') && !names.includes('Grok Build'), `${tab}: 読み上げ名も短い名前へ更新する`);
    }
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(observations));
  console.log('PASS: 4 タブの遅着・詳細・確認・フォーカス・スクロール');
} finally {
  await browser?.close(); client?.close(); await server?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
