import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const browserCache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const executablePath = process.env.PW_CHROMIUM || path.join(browserCache,
  fs.readdirSync(browserCache).filter((name) => /^chromium_headless_shell-/.test(name)).sort().at(-1),
  'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-bot-next-actions-'));
const screenshots = process.env.PW_SCREENSHOTS;
let server, browser, ws;

async function until(read, label) {
  for (let i = 0; i < 100; i++) {
    const result = await read();
    if (result) return result;
    await delay(150);
  }
  throw new Error(label);
}

try {
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  ws = await open({ port: server.port, token: server.token });
  await ws.cmd('authLogin', { backend: 'fake' });
  const call = (op, args) => ws.cmd('invoke', { op, args });
  await call('settings.set', { key: 'botEnabled', value: true });
  await ws.cmd('setPref', { key: 'composer.suggestions', value: true });
  const names = ['Atlas', 'Mira', 'Luna'];
  const bots = [];
  for (const [index, name] of names.entries()) {
    bots.push(await call('bots.create', { name, backend: 'fake', icon: ['🦉', '🛠️', '🌙'][index] }));
  }
  const channel = await call('channels.create', { name: 'リリース準備', members: bots.map((bot) => bot.id) });
  const message = '修正内容を一覧にしてください。';
  const fixture = (mentions = '') => `${mentions}echo:リリース前の確認が終わりました。\nsuggest:${message}\naction:修正内容をまとめてもらう`;
  const root = await call('channels.post', { channelId: channel.id, text: fixture(names.map((name) => `@${name} `).join('')) });
  const other = await call('channels.post', { channelId: channel.id, text: '別のスレッド', new: true });
  const dm = (await call('channels.list', {})).channels.find((c) => c.kind === 'dm' && c.members.includes(bots[0].id));
  await call('channels.post', { channelId: dm.id, text: fixture() });
  const where = { channelId: channel.id, threadId: root.id };
  const read = (scope) => call('channels.nextActions', scope);
  await until(async () => (await read(where)).suggestions.length === 3, 'three replies generate suggestions');
  await until(async () => (await read({ channelId: dm.id })).suggestions.length === 1, 'DM generates a suggestion');
  assert.deepEqual((await read({ channelId: channel.id, threadId: other.id })).suggestions, []);

  browser = await chromium.launch({ executablePath });
  const shot = async (page, filename) => {
    if (screenshots) await page.screenshot({ path: path.join(screenshots, filename), animations: 'disabled' });
  };
  const show = (page, id, threadId) => page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent('channels:show', { detail }));
  }, { kind: 'channel', id, threadId });

  let keyboardContext, touchContext;
  for (const width of [1280, 360]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 360 ? 780 : 850 }, locale: 'ja-JP',
        colorScheme, hasTouch: width === 360, isMobile: width === 360,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`);
      await page.locator('#prompt').waitFor();
      const start = page.locator('#onboardingDialog[open] button', { hasText: '会話を始める' });
      const gate = await start.waitFor({ timeout: 2500 }).then(() => true, () => false);
      if (gate) await start.click();
      await page.locator('#onboardingDialog[open]').waitFor({ state: 'hidden' });
      await show(page, channel.id, root.id);
      const row = page.locator('.ch-next-primary:visible');
      await row.waitFor();
      await page.locator('.composer-ghost.on:visible').waitFor();
      assert.match(await row.textContent(), /修正内容をまとめてもらう/);
      assert.match(await page.locator('.ch-next-more:visible').textContent(), /2/);
      assert.ok((await page.locator('#thPrompt').getAttribute('aria-description'))?.includes(message));
      assert.equal(await page.locator('#cbox .recall-open').isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
      await shot(page, `thread-${width}-${colorScheme}.png`);
      if (width === 360 && colorScheme === 'dark') {
        const more = page.locator('.ch-next-more:visible');
        await more.tap();
        assert.equal(await more.getAttribute('aria-expanded'), 'true');
        await shot(page, 'thread-360-dark-choices.png');
      }
      if (width === 1280 && colorScheme === 'light') keyboardContext = { page };
      else if (width === 360 && colorScheme === 'light') touchContext = { page };
      else await context.close();
    }
  }

  const { page } = keyboardContext;
  const input = page.locator('#thPrompt');
  await page.locator('.ch-next-more:visible').click();
  await shot(page, 'thread-1280-choices.png');
  const choice = page.locator('.ch-next-choice:visible').first();
  await input.press('Shift+Tab');
  assert.equal(await input.evaluate((node) => node.value), '');
  if (!await choice.isVisible()) await page.locator('.ch-next-more:visible').click();
  const choiceLabel = await choice.textContent();
  const selected = names.find((name) => choiceLabel.includes(name));
  await choice.click();
  await input.press('Tab');
  await page.waitForFunction((expected) => document.getElementById('thPrompt').value === expected, `@${selected} ${message}`);
  assert.equal(await input.evaluate((node) => node === document.activeElement), true);
  await shot(page, 'thread-1280-tab-draft.png');
  assert.equal((await call('channels.read', where)).posts.filter((post) => post.author.kind === 'human').length, 1);
  await input.press('Control+a');
  await input.press('Backspace');
  await show(page, channel.id, other.id);
  await page.locator('.ch-next-primary:visible').waitFor({ state: 'hidden' });
  await show(page, channel.id, root.id);
  await page.locator('.ch-next-primary:visible').waitFor();
  await input.press('Escape');
  await until(async () => (await read(where)).suggestions.length === 1, 'Escape discards only the selected candidate');
  assert.equal(await input.evaluate((node) => node.value), '');
  assert.equal(await page.locator('.composer-ghost.on:visible').count(), 0);
  await input.press('Shift+Tab');
  assert.equal(await page.locator('.ch-next-primary:visible').count(), 0);
  await page.evaluate(() => document.activeElement.blur());
  const last = page.locator('.ch-next-primary:visible');
  await last.waitFor();
  const lastLabel = await last.textContent();
  const lastBot = names.find((name) => lastLabel.includes(name));
  await last.click();
  await page.waitForFunction((expected) => document.getElementById('thPrompt').value === expected, `@${lastBot} ${message}`);

  const mobile = touchContext.page;
  await show(mobile, dm.id);
  await mobile.locator('.ch-next-primary:visible').waitFor();
  assert.equal(await mobile.locator('.ch-next-more:visible').count(), 0);
  await shot(mobile, 'dm-360-light.png');
  await mobile.locator('.cg-take:visible').tap();
  const dmInput = mobile.locator('#chFeedComposerInput');
  await until(async () => await dmInput.evaluate((node) => node.value) === message, 'touch adoption produces a DM draft without a mention');
  assert.equal((await call('channels.read', { channelId: dm.id })).posts.filter((post) => post.author.kind === 'human').length, 1);
  console.log('Bot next actions: scope, selection, Tab, Escape, action click, and touch passed.');
} finally {
  await browser?.close();
  ws?.close();
  await server?.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
