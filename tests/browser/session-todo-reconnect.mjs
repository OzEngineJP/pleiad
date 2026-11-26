// Run with node tests/browser/session-todo-reconnect.mjs (Playwright and Chromium required).
import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { createRelay } from '../../relay/server.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || (process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core' : 'playwright-core'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-todo-reconnect-'));
const enrollSecret = randomBytes(32).toString('base64url');
const relay = createRelay({ enrollSecret, trustProxy: false, logger: () => {} });
const device = createRemoteDevice({ dir: path.join(root, 'device'), name: 'Test phone', platform: 'android' });
const task = 'Check the session ToDo';
let host, client, hostId, browser;
try {
  const relayAddress = await relay.listen(0, '127.0.0.1');
  host = await startServer({ dataDir: path.join(root, 'host'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  client = await open({ ...host, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('onboardingSeen');
  const { sessionId } = await client.cmd('newSession', { cwd: root, backend: 'fake' });
  await client.runTurn({ sessionId, prompt: 'echo:ToDo reconnect test' });
  const invoke = (op, args) => client.cmd('invoke', { op, args: { sessionId, ...args } });
  const added = await invoke('todos.add', { items: [{ text: task }] });
  const item = (added.result ?? added).items[0];

  await client.cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayAddress.port}`, enrollSecret, enabled: true, hostName: 'Test host' });
  const { payload } = await client.cmd('remotePairingStart');
  const from = client.mark();
  const pairing = device.pair(payload);
  pairing.catch(() => {});
  const { request } = await client.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from });
  await client.cmd('remotePairingApprove', { id: request.id });
  ({ hostId } = await pairing);
  const proxy = await device.open(hostId);
  await proxy.link.ready(10_000);

  let executablePath = process.env.PW_CHROMIUM;
  if (!executablePath && process.platform === 'win32') {
    const cache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
    const builds = (await fs.readdir(cache)).filter(n => n.startsWith('chromium_headless_shell-'));
    builds.sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    if (builds[0]) executablePath = path.join(cache, builds[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  }
  browser = await chromium.launch({ executablePath });

  async function openChat(context, url) {
    await context.addInitScript((id) => {
      localStorage.setItem('agent-host-side-tab', 'chats');
      localStorage.setItem('agent-host-view', JSON.stringify({ channelId: 'home', sessionId: id }));
    }, sessionId);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(url);
    return page;
  }

  const desktop = await openChat(await browser.newContext({ viewport: { width: 1280, height: 900 } }),
    `http://127.0.0.1:${host.port}/?token=${host.token}`);
  await desktop.locator('#todoEntry').click();
  await desktop.locator('.todo-pop .td-item:not(.td-meas)').getByText(task, { exact: true }).waitFor();
  console.log('PC ToDo passed');

  const mobileContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const firstList = Promise.withResolvers();
  const reconnected = Promise.withResolvers();
  let listCount = 0, connections = 0;
  await mobileContext.routeWebSocket(url => url.pathname === '/ws', downstream => {
    const upstream = downstream.connectToServer();
    const connection = ++connections;
    let firstListId;
    downstream.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.command === 'invoke' && message.args?.op === 'todos.list' && ++listCount === 1) firstListId = message.id;
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (connection > 1 && message.kind === 'ready') reconnected.resolve();
      if (message.kind === 'response' && message.id === firstListId) {
        // The response made it through the relay. Leave it pending at the browser until the socket drops.
        firstList.resolve({ downstream, upstream, message });
      } else downstream.send(raw);
    });
  });
  const mobile = await openChat(mobileContext, proxy.url);
  await mobile.locator('#sessionMore').click();
  await mobile.getByRole('menuitem', { name: /ToDo/ }).click();
  const panel = mobile.locator('.todo-pop');
  const items = panel.locator('.td-item:not(.td-meas)');
  await panel.getByText('ToDo はありません', { exact: true }).waitFor();
  function within(promise, failure) {
    return Promise.race([promise, mobile.waitForTimeout(10_000).then(() => assert.fail(failure))]);
  }
  const pending = await within(firstList.promise, 'No ToDo list response from the relay');
  assert.equal(pending.message.ok, true);
  const received = pending.message.result.result ?? pending.message.result;
  assert.equal(received.sessionId, sessionId);
  assert.equal(received.items[0].text, task);
  console.log('The remote ToDo response is pending and the mobile sheet is empty');
  await pending.downstream.close({ code: 1011 });
  await pending.upstream.close({ code: 1011 });
  await within(reconnected.promise, 'The browser did not reconnect through the relay');
  await items.getByText(task, { exact: true }).waitFor();
  assert.equal(listCount, 2);

  const updated = 'Updated on the host';
  await invoke('todos.update', { items: [{ id: item.id, text: updated }] });
  await items.getByText(updated, { exact: true }).waitFor();
  console.log('PC ToDo, remote mobile reconnection, and live ToDo event passed');
} finally {
  await browser?.close();
  if (hostId) await device.close(hostId);
  client?.close();
  await host?.stop();
  await relay.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await cleanupTestData();
}
