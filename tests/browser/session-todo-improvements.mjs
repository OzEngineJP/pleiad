// Run with node tests/browser/session-todo-improvements.mjs (Playwright and Chromium required).
import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || (process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core' : 'playwright-core'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-todo-improvements-'));
const shots = process.env.TODO_SCREENSHOTS;
const long = '画面を切り替えずに、会話の ToDo の全文を確認します。'.repeat(24);
let host, client, browser;
try {
  host = await startServer({ dataDir: root, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  client = await open({ ...host, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('onboardingSeen');
  const { sessionId } = await client.cmd('newSession', { cwd: root, backend: 'fake' });
  await client.runTurn({ sessionId, prompt: 'echo:会話の ToDo の画面試験' });
  const invoke = async (op, args) => {
    const response = await client.cmd('invoke', { op, args: { sessionId, ...args } });
    return response.result ?? response;
  };
  const from = client.mark();
  const title = '別の画面を担当する子の会話';
  await client.cmd('runTurn', { sessionId, prompt: 'ply:' + JSON.stringify({
    name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task: 'echo:子の会話の開き先を確認する' },
  }) });
  const delegated = await client.waitFor(e => e.sessionId === sessionId && e.type === 'tool.result', { from });
  const { taskId } = JSON.parse(delegated.text);
  await client.waitFor(e => e.sessionId === sessionId && e.type === 'turnEnd', { from });
  const names = ['要件を確認する', '実装の範囲を決める', '作業の準備をする', '画面の表示を確認する', '保存処理を確認する', '確認結果をまとめる'];
  const added = await invoke('todos.add', { items: names.map((text, i) => ({
    text: i === 3 ? long : text,
    ...(i < 3 ? { status: 'done' } : {}),
    ...(i === 3 ? { assignee: '山田', humanWaiting: true } : {}),
    ...(i === 4 ? { assignee: 'Codex' } : {}),
  })) });
  const [a, b, c, d, e, f] = added.items.map(item => item.id);
  await invoke('todos.update', { items: [
    { id: b, after: [a] }, { id: c, after: [b] }, { id: d, after: [c] },
    { id: e, after: [c] }, { id: f, after: [d, e] },
  ] });

  let executablePath = process.env.PW_CHROMIUM;
  if (!executablePath && process.platform === 'win32') {
    const cache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
    const builds = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-'));
    builds.sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    if (builds[0]) executablePath = path.join(cache, builds[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  }
  browser = await chromium.launch({ executablePath });
  if (shots) await fs.mkdir(shots, { recursive: true });
  async function capture(page, name) {
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
  }
  async function openPanel(width, theme) {
    const context = await browser.newContext({ viewport: { width, height: width === 360 ? 800 : 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(theme => {
      localStorage.setItem('agent-host-side-tab', 'channels');
      localStorage.setItem('agent-host-view', JSON.stringify({ channelId: 'home' }));
      localStorage.setItem('agent-host-theme', theme);
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(6_000);
    await page.goto(`http://127.0.0.1:${host.port}/?token=${host.token}`);
    await page.locator('#channelsView .thread-summary').click();
    await showPanel(page, width);
    return page;
  }
  async function showPanel(page, width) {
    if (width === 360) {
      await page.locator('#sessionMore').click();
      await page.getByRole('menuitem', { name: /ToDo/ }).click();
    } else await page.locator('#todoEntry').click();
    await page.locator(`.td-item[data-id="${d}"]`).waitFor({ state: 'attached' });
  }
  const row = (page, id) => page.locator(`.td-item[data-id="${id}"]`);
  const read = page => row(page, d).locator('.td-text');
  const mode = (page, view) => page.locator(`.td-seg [data-v="${view}"]`).click();
  const panel = page => page.locator('.todo-pop');
  const widthOf = page => panel(page).evaluate(el => el.offsetWidth);

  const desktop = await openPanel(1280, 'light');
  await mode(desktop, 'list');
  await read(desktop).locator('xpath=self::*[@aria-expanded="false"]').waitFor();
  assert.equal(await read(desktop).textContent(), long);
  assert.equal(await row(desktop, d).locator('.td-owner').textContent(), '山田');
  assert.equal(await row(desktop, d).locator('.td-human').isVisible(), true);
  assert.equal(await row(desktop, a).locator('.td-text').getAttribute('role'), null);
  assert.ok((await row(desktop, d).boundingBox()).x > (await row(desktop, c).boundingBox()).x);
  assert.equal((await row(desktop, f).boundingBox()).x, (await row(desktop, c).boundingBox()).x);
  await capture(desktop, 'light-1280-list');
  const collapsed = await read(desktop).boundingBox();
  await read(desktop).press('Enter');
  assert.equal(await read(desktop).getAttribute('aria-expanded'), 'true');
  assert.ok((await read(desktop).boundingBox()).height > collapsed.height);
  await capture(desktop, 'light-1280-keyboard-expanded');
  await read(desktop).press('Space');
  assert.equal(await read(desktop).getAttribute('aria-expanded'), 'false');
  const resize = desktop.locator('.td-resize-width');
  const defaultWidth = await widthOf(desktop);
  await resize.press('ArrowLeft');
  assert.equal(await widthOf(desktop), defaultWidth + 16);
  await mode(desktop, 'flow');
  assert.equal(await widthOf(desktop), 640);
  await mode(desktop, 'list');
  assert.equal(await widthOf(desktop), defaultWidth + 16);
  await desktop.reload();
  await desktop.locator('#channelsView .thread-summary').click();
  await showPanel(desktop, 1280);
  await mode(desktop, 'list');
  assert.equal(await widthOf(desktop), defaultWidth + 16);
  await resize.press('Home');
  assert.equal(await widthOf(desktop), defaultWidth);
  const corner = desktop.locator('.td-resize-both');
  const { x, y, width, height } = await corner.boundingBox();
  const defaultHeight = await panel(desktop).evaluate(el => el.offsetHeight);
  await desktop.mouse.move(x + width / 2, y + height / 2);
  await desktop.mouse.down();
  await desktop.mouse.move(x + width / 2 - 50, y + height / 2 + 30, { steps: 4 });
  await desktop.mouse.up();
  assert.equal(await widthOf(desktop), defaultWidth + 50);
  assert.equal(await panel(desktop).evaluate(el => el.offsetHeight), defaultHeight + 30);
  await capture(desktop, 'light-1280-resized');
  await corner.dblclick();
  assert.equal(await widthOf(desktop), defaultWidth);
  await desktop.locator('.td-max').click();
  assert.equal(await resize.isVisible(), false);
  await desktop.locator('.td-max').click();
  await desktop.keyboard.press('Escape');
  await panel(desktop).waitFor({ state: 'hidden' });
  await showPanel(desktop, 1280);
  const floating = await panel(desktop).boundingBox();
  await desktop.mouse.click(floating.x - 24, floating.y + 100);
  await panel(desktop).waitFor({ state: 'hidden' });

  const dark = await openPanel(1280, 'dark');
  await mode(dark, 'flow');
  await dark.locator('.td-stack').waitFor();
  assert.equal(await dark.locator('.td-stack').count(), 1);
  const sibling = await row(dark, e).evaluate(el => el.style.transform);
  await read(dark).click();
  assert.equal(await read(dark).getAttribute('aria-expanded'), 'true');
  assert.equal(await row(dark, e).evaluate(el => el.style.transform), sibling);
  await capture(dark, 'dark-1280-flow-expanded');
  await read(dark).press('Space');
  assert.equal(await read(dark).getAttribute('aria-expanded'), 'false');
  const status = await invoke('todos.list', {});
  assert.equal(status.items.find(item => item.id === d).status, 'todo');
  await invoke('todos.update', { items: [{ id: e, taskId }] });
  const child = row(dark, e).getByRole('button', { name: '子の会話 ↗' });
  await child.waitFor();
  await capture(dark, 'dark-1280-linked-task');
  await child.click();
  await dark.locator('#workDialog').getByText(title, { exact: true }).first().waitFor();
  await invoke('todos.update', { items: [{ id: e, taskId: null, status: 'todo' }] });
  await dark.keyboard.press('Escape');
  await showPanel(dark, 1280);
  await mode(dark, 'flow');

  const mobile = await openPanel(360, 'light');
  await mode(mobile, 'list');
  assert.equal(await mobile.locator('.td-resize-width').isVisible(), false);
  await capture(mobile, 'light-360-list');
  await read(mobile).click();
  assert.equal(await read(mobile).getAttribute('aria-expanded'), 'true');
  await capture(mobile, 'light-360-list-expanded');
  const mobileDark = await openPanel(360, 'dark');
  await mode(mobileDark, 'flow');
  await capture(mobileDark, 'dark-360-flow');

  let count = 6;
  let previous = f;
  for (const target of [10, 15, 30]) {
    const entries = [];
    const ends = [];
    for (let i = 0; i < target - count - 1; i++) {
      const lane = i % 3;
      const ref = `lane-${i}`;
      entries.push({ ref, text: `${['表示', '操作', '保存'][lane]}を確認する ${count + i + 1}`, after: [ends[lane] ?? previous] });
      ends[lane] = ref;
    }
    entries.push({ text: `確認結果をまとめる ${target}`, after: ends });
    const { items } = await invoke('todos.add', { items: entries });
    if (target === 10) {
      await invoke('todos.update', { items: [d, e, f].map(id => ({ id, status: 'done' })) });
    }
    previous = items.at(-1).id;
    count = target;
    for (const [page, size] of [[dark, 1280], [mobileDark, 360]]) {
      await page.locator('.td-close').click();
      await panel(page).waitFor({ state: 'hidden' });
      await showPanel(page, size);
      assert.equal(await panel(page).evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.waitForFunction(n => document.querySelectorAll('.todo-pop .td-item[data-id]').length === n, count);
      const stack = page.locator('.td-stack');
      await stack.filter({ hasText: '完了 6' }).waitFor();
      assert.equal(await stack.count(), 1);
      assert.equal(await stack.evaluate(el => el.offsetWidth), 112);
      assert.equal(await stack.evaluate(el => el.offsetHeight), size === 360 ? 36 : 28);
      assert.equal(await panel(page).locator('.td-item.gone').count(), 6);
      assert.equal(await page.locator('.td-edge.pend').count() > 0, true);
      if (target === 10) {
        await stack.click();
        await stack.waitFor({ state: 'hidden' });
        assert.equal(await panel(page).locator('.td-item[data-id]:not(.gone)').count(), count);
        await page.locator('.td-fold').click();
        await stack.waitFor();
        await mode(page, 'list');
        assert.equal(await panel(page).locator('.td-item[data-id]:not(.gone)').count(), count);
        assert.equal(await page.locator('.td-fold').isVisible(), false);
        await mode(page, 'flow');
        await stack.waitFor();
      }
      await capture(page, `dark-${size}-flow-${count}`);
      await page.locator('.td-zoom button').last().click();
      if (count === 30) await capture(page, `dark-${size}-flow-${count}-overview`);
    }
  }
  console.log('ToDo text, metadata, branches, resizing, and 10/15/30-item flows passed');
} finally {
  await browser?.close();
  client?.close();
  await host?.stop();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await cleanupTestData();
}
