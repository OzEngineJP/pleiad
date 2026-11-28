// Run with node tests/browser/session-todo-tabs.mjs. TODO_TAB_SHOTS optionally saves screenshots.
import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { startServer, waitForTestHolders } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { openInBrowserIcon } from '../../web/icons.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || (process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core' : 'playwright-core'));
let executablePath = process.env.PW_CHROMIUM;
if (!executablePath && process.platform === 'win32') {
  const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const builds = (await fs.readdir(cache)).filter(name => name.startsWith('chromium_headless_shell-'));
  builds.sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  executablePath = path.join(cache, builds[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-todo-tabs-'));
const captureFile = path.join(root, 'external.log');
const shots = process.env.TODO_TAB_SHOTS;
const plus = await startFakePlus();
const uuid = n => '40000000-0000-4000-8000-' + String(n).padStart(12, '0');
const [tenantId, workspaceId, databaseId, viewId] = [1, 2, 3, 4].map(uuid);
const boardPath = '/v1/todo-boards/' + [tenantId, workspaceId, databaseId, viewId].join('/');
const title = '公開プロジェクト';
const viewName = 'ボード';
const destination = new URL('/?page=' + databaseId + '&view=' + viewId, plus.url).href;
const columns = ['未着手', '進行中', '完了'].map((label, i) => ({ label, id: uuid(i + 5) }));
const board = { title, viewName, url: destination, conversation: true, nextOffset: null, columns, rows: [
  { title: '確認メールの文面を整える', columnId: columns[0].id, conversationStates: [] },
  { title: '申し込み画面を確認', columnId: columns[1].id, conversationStates: ['running'] },
  { title: '案内ページの誤字を確認', columnId: columns[2].id, conversationStates: ['completed'] },
] };
plus.state.proxy['/v1/todo-boards'] = { body: { boards: [{ tenantId, workspaceId, databaseId, viewId, title, viewName, workspaceName: 'Design Team' }] } };
plus.state.proxy[boardPath] = { body: board };
plus.state.nextLogin = { uid: 'user-1', email: 'user@example.com' };
let host, client, browser;
async function until(read, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

try {
  host = await startServer({
    dataDir: root, entry: fileURLToPath(new URL('../lib/plus-main-port.mjs', import.meta.url)),
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', AGENT_HOST_PLUS_API: plus.url,
      AGENT_HOST_PLUS_JWKS_URL: plus.jwksUrl, PLUS_EXTERNAL_CAPTURE: captureFile },
  });
  assert.notEqual(Number(host.port), 7420);
  client = await open({ ...host, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('onboardingSeen');
  const { sessionId } = await client.cmd('newSession', { cwd: root, backend: 'fake' });
  const other = await client.cmd('newSession', { cwd: root, backend: 'fake' });
  await client.runTurn({ sessionId, prompt: 'echo:公開前の確認' });
  const invoke = async (op, args = {}) => {
    const response = await client.cmd('invoke', { op, args });
    return response.result ?? response;
  };
  await invoke('todos.add', { sessionId, items: [{ text: '会話の作業', status: 'doing', humanWaiting: true }] });
  await invoke('todos.add', { sessionId: other.sessionId, items: [{ text: '別の会話の作業' }] });
  const lists = {};
  for (const name of ['今週の確認', 'リリース準備', '問い合わせの整理', '来週の準備メモ']) {
    lists[name] = await invoke('todoLists.create', { name });
    await invoke('todoLists.add', { listId: lists[name].id, items: [{ text: name + 'の項目' }] });
  }
  browser = await chromium.launch({ executablePath, args: ['--mute-audio'] });
  if (shots) await fs.mkdir(shots, { recursive: true });
  const screenshot = (page, name) => shots && page.screenshot({ path: path.join(shots, name + '.png') });
  async function showPanel(page, width) {
    if (width === 360) {
      await page.locator('#sessionMore').click();
      await page.getByRole('menuitem', { name: /ToDo/ }).click();
    } else await page.locator('#todoEntry').click();
    const panel = page.locator('.todo-pop:visible');
    await panel.getByRole('tab', { name: 'この会話', exact: true }).waitFor();
    return panel;
  }
  for (const width of [1280, 360]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width, height: width === 360 ? 800 : 900 }, colorScheme: theme, reducedMotion: 'reduce',
    });
    await context.addInitScript(([theme, sessionId]) => {
      localStorage.setItem('agent-host-side-tab', 'chats');
      localStorage.setItem('agent-host-view', JSON.stringify({ channelId: 'home', sessionId }));
      localStorage.setItem('agent-host-theme', theme);
    }, [theme, sessionId]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => console.error(error.message));
    await page.goto('http://127.0.0.1:' + host.port + '/?token=' + host.token + '&open=' + sessionId);
    const panel = await showPanel(page, width);
    const tablist = panel.getByRole('tablist');
    const pinnedTab = tablist.getByRole('tab', { name: 'この会話', exact: true });
    const strip = tablist.locator('.td-tabstrip');
    const selected = tablist.getByRole('tab', { selected: true });
    async function assertSelectedInStrip() {
      const fits = await strip.evaluate(el => {
        const tab = el.querySelector('[aria-selected="true"]');
        if (!tab) return false;
        const row = tab.parentElement.getBoundingClientRect();
        const bounds = el.getBoundingClientRect();
        return row.left >= bounds.left - 0.5 && row.right <= bounds.right + 0.5;
      });
      assert.equal(fits, true, 'the selected tab and its close button fit after the pinned tab');
    }
    const add = panel.getByRole('button', { name: 'タブを追加', exact: true });
    const option = name => panel.locator('.td-tab-chooser').getByRole('button', { name, exact: true });
    const boardOption = () => panel.locator('.td-tab-chooser').getByRole('button', { name: /^公開プロジェクト/ });
    const existing = async (name) => {
      await add.click();
      await option('既存の ToDo リスト').click();
      const search = panel.getByRole('searchbox', { name: 'ToDo リストを検索' });
      await search.waitFor();
      assert.equal(await option('別の会話の作業').count(), 0);
      await search.fill(name);
      await option(name).click();
      await panel.getByRole('tab', { name, exact: true, selected: true }).waitFor();
      await panel.getByText(name + 'の項目', { exact: true }).filter({ visible: true }).waitFor();
    };
    await panel.getByText('会話の作業', { exact: true }).filter({ visible: true }).waitFor();
    await screenshot(page, 'impl-conversation-' + width + '-' + theme);
    if (width === 1280 && theme === 'light') {
      await add.click();
      await option('Plus のボード').click();
      await panel.getByText('Plus にログインしてください。').waitFor();
      await screenshot(page, 'impl-plus-sign-in-1280-light');
      await option('Plus にログイン').click();
      const loginUrl = await until(async () => (await fs.readFile(captureFile, 'utf8').catch(() => '')).trim(), 'Plus login URL');
      const loginPage = await context.newPage();
      await loginPage.goto(loginUrl);
      await until(async () => (await client.cmd('plusStatus')).signedIn, 'Plus sign-in');
      await loginPage.close();
      if (await panel.locator('.td-tab-chooser').isVisible()) await page.keyboard.press('Escape');
      await add.click();
      await option('新規 ToDo リスト').click();
      await panel.getByRole('textbox', { name: 'リスト名' }).fill('試験用の独立リスト');
      await option('作成').click();
      await panel.getByRole('tab', { name: '試験用の独立リスト', selected: true }).waitFor();
      const created = (await invoke('todoLists.catalog')).lists.find(list => list.name === '試験用の独立リスト');
      assert.ok(created);
      await panel.getByRole('button', { name: 'ToDo を追加', exact: true }).click();
      const newItem = panel.getByRole('textbox', { name: 'ToDo を追加' });
      await newItem.fill('独立リストに保存する');
      await newItem.press('Enter');
      await panel.getByText('独立リストに保存する', { exact: true }).filter({ visible: true }).waitFor();
      assert.equal((await invoke('todoLists.list', { listId: created.id })).items[0].text, '独立リストに保存する');
      await panel.getByRole('button', { name: '「試験用の独立リスト」を閉じる' }).click();
      await panel.getByRole('tab', { name: 'この会話', selected: true }).waitFor();
    }
    for (const name of ['来週の準備メモ', '問い合わせの整理', 'リリース準備', '今週の確認']) await existing(name);
    await add.click();
    await option('Plus のボード').click();
    const boardSearch = panel.getByRole('searchbox', { name: 'ボードを検索' });
    await boardSearch.fill('見つからないボード');
    await panel.getByText('一致する項目はありません。', { exact: true }).waitFor();
    await boardSearch.fill('Design Team');
    await boardOption().click();
    await panel.getByRole('tab', { name: title, selected: true }).waitFor();
    await panel.getByText('申し込み画面を確認', { exact: false }).filter({ visible: true }).waitFor();
    assert.deepEqual(await panel.locator('.td-board-group h3').allTextContents(), ['未着手', '進行中', '完了']);
    assert.equal(await panel.getByRole('button', { name: '編集', exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'ToDo を追加' }).count(), 0);
    assert.ok(await strip.evaluate(el => el.scrollLeft > 0), 'the new board tab scrolls into view');
    await assertSelectedInStrip();
    const openPlus = panel.getByRole('button', { name: 'Plus で開く', exact: true });
    assert.equal(await openPlus.locator('svg').evaluate((icon, markup) => {
      const template = document.createElement('template');
      template.innerHTML = markup;
      return icon.isEqualNode(template.content.firstElementChild);
    }, openInBrowserIcon), true);
    const { width: iconWidth, height: iconHeight } = await openPlus.locator('svg').boundingBox();
    assert.deepEqual([iconWidth, iconHeight], [14, 14]);
    await screenshot(page, 'impl-board-' + width + '-' + theme);
    if (width === 1280 && theme === 'light') {
      const popup = page.waitForEvent('popup');
      await openPlus.click();
      const opened = await popup;
      await opened.waitForURL(destination);
      await opened.close();
    }
    await add.click();
    const recents = panel.locator('.td-tab-recents button');
    await until(async () => await recents.count() === 3 && (await recents.first().innerText()).startsWith(title), 'recent order');
    assert.deepEqual((await recents.allInnerTexts()).map(line => line.split('\n')[0]), [title, '今週の確認', 'リリース準備']);
    const menu = panel.locator('.td-tab-options > button');
    assert.deepEqual(await menu.allTextContents(), ['新規 ToDo リスト', '既存の ToDo リスト', 'Plus のボード']);
    await screenshot(page, 'impl-picker-' + width + '-' + theme);
    await page.keyboard.press('Escape');
    assert.equal(await add.evaluate(el => el === document.activeElement), true);
    assert.match(await tablist.ariaSnapshot(), /tablist[^\n]*\n  - tab "この会話"/);
    await selected.press('Home');
    assert.equal(await pinnedTab.getAttribute('aria-selected'), 'true');
    const pinnedLeft = (await pinnedTab.boundingBox()).x;
    const clipsFirstTab = await strip.evaluate(el => {
      el.scrollLeft = el.firstElementChild.getBoundingClientRect().width / 2;
      const edge = el.getBoundingClientRect().left;
      const first = el.firstElementChild.getBoundingClientRect();
      return first.left < edge && first.right > edge;
    });
    assert.equal(clipsFirstTab, true);
    assert.equal((await pinnedTab.boundingBox()).x, pinnedLeft);
    assert.equal(await pinnedTab.evaluate(tab => {
      const rect = tab.getBoundingClientRect();
      return document.elementFromPoint(rect.right - 1, rect.top + rect.height / 2) === tab;
    }), true, 'the scrolling tab is clipped behind the pinned tab');
    await pinnedTab.press('ArrowRight');
    assert.equal(await selected.innerText(), '来週の準備メモ');
    await assertSelectedInStrip();
    await selected.press('ArrowLeft');
    assert.equal(await pinnedTab.getAttribute('aria-selected'), 'true');
    await pinnedTab.press('ArrowLeft');
    await panel.locator('.td-board-group').first().waitFor();
    assert.equal(await selected.innerText(), title);
    await assertSelectedInStrip();
    await selected.press('End');
    await panel.locator('.td-board-group').first().waitFor();
    if (width === 360) {
      const allTabs = panel.getByRole('button', { name: 'タブの一覧' });
      await allTabs.click();
      await screenshot(page, 'impl-all-tabs-' + width + '-' + theme);
      const detach = panel.locator('.td-tab-chooser').getByRole('button', { name: '「来週の準備メモ」を閉じる' });
      await detach.click();
      assert.equal(await tablist.getByRole('tab', { name: '来週の準備メモ', exact: true }).count(), 0);
      await panel.locator('.td-tab-chooser').getByRole('button', { name: /^今週の確認/ }).click();
      await panel.getByText('今週の確認の項目', { exact: true }).filter({ visible: true }).waitFor();
      await assertSelectedInStrip();
    } else {
      plus.state.proxy[boardPath] = { status: 403, body: { error: { code: 'forbidden' } } };
      await selected.click();
      await panel.getByText('このボードを開く権限がありません。').waitFor();
      assert.equal(await panel.getByText('申し込み画面を確認', { exact: false }).count(), 0);
      await screenshot(page, 'impl-plus-no-access-' + width + '-' + theme);
      plus.state.proxy[boardPath] = { status: 503, body: { error: { code: 'unavailable' } } };
      await selected.click();
      await panel.getByText('Plus に接続できませんでした。').waitFor();
      await screenshot(page, 'impl-plus-offline-' + width + '-' + theme);
      plus.state.proxy[boardPath] = { body: board };
      await panel.getByRole('button', { name: '再試行' }).click();
      await panel.locator('.td-board-group').first().waitFor();
      await panel.getByRole('tab', { name: '今週の確認', exact: true }).click();
    }
    await panel.getByRole('button', { name: '「今週の確認」を閉じる' }).click();
    assert.equal((await invoke('todoLists.list', { listId: lists['今週の確認'].id })).items[0].text, '今週の確認の項目');
    assert.deepEqual((await invoke('todos.list', { sessionId })).items.map(item => item.text), ['会話の作業']);
    await existing('今週の確認');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    if (width === 1280 && theme === 'light') {
      await page.reload();
      const reopened = await showPanel(page, width);
      await reopened.getByRole('tab', { name: '今週の確認', exact: true }).waitFor();
      const restoredBoard = reopened.getByRole('tab', { name: title, exact: true });
      await restoredBoard.click();
      await reopened.locator('.td-board-group').first().waitFor();
    }
    await context.close();
    console.log(width, theme, 'passed');
  }
  assert.ok(plus.state.calls.some(call => call.path.startsWith(boardPath) && call.method === 'GET' && call.auth));
} finally {
  await browser?.close();
  client?.close();
  await host?.stop();
  await waitForTestHolders();
  await plus.close();
  await cleanupTestData(root);
}
