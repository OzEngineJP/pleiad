// node tests/browser/waiting-cards.mjs (PW_CORE and PW_CHROMIUM can override Playwright and Chromium).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? (process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core' : 'playwright-core'));
function chromiumPath() {
  if (process.env.PW_CHROMIUM || process.platform !== 'win32') return process.env.PW_CHROMIUM;
  const cache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const revisions = fs.readdirSync(cache).filter(dir => /^chromium_headless_shell-\d+$/.test(dir));
  revisions.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(cache, revisions[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}
async function bounded(promise, description) {
  const { promise: timeout, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 15_000);
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}
const scratch = fs.mkdtempSync(path.join(process.cwd(), 'waiting-cards-test-'));
let host, client, browser;
try {
  host = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  client = await open(host);
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });
  const { sessionId } = await client.runTurn({ backend: 'fake', cwd: scratch, prompt: 'echo:waiting-history' });
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ locale: 'ja-JP' });
  const history = Promise.withResolvers();
  const question = Promise.withResolvers();
  const oldWaiting = Promise.withResolvers();
  let route, loadId, answerId;
  const answer = Promise.withResolvers();
  await page.routeWebSocket('**/ws?*', socket => {
    route = socket;
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.command === 'loadSession' && m.args.sessionId === sessionId && m.args.live) loadId ??= m.id;
      if (m.command === 'resolvePermission') answerId = m.id;
      server.send(raw);
    });
    server.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.kind === 'response' && loadId && m.id === loadId) return history.resolve(raw);
      if (m.kind === 'response' && answerId && m.id === answerId) answer.resolve(m);
      if (m.event?.type === 'running') return;
      socket.send(raw);
      const ev = m.event;
      if (ev?.type === 'waitingCards' && ev.cards.length === 0) oldWaiting.resolve(raw);
      const card = ev?.type === 'waitingCards' ? ev.cards.find(c => c.sessionId === sessionId && c.kind === 'question')
        : ev?.type === 'permission' && ev.sessionId === sessionId && ev.kind === 'question' ? ev : null;
      if (card) question.resolve({ card, snapshot: ev.type === 'waitingCards' ? ev : null });
    });
  });
  await page.goto(`http://127.0.0.1:${host.port}/?token=${host.token}`);
  const row = page.locator(`.row[data-session="${sessionId}"]`);
  await row.waitFor();
  await row.evaluate(el => el.click());
  const oldHistory = await bounded(history.promise, 'the original history response');
  const oldRunning = await client.cmd('running');
  void client.cmd('runTurn', { sessionId, prompt: 'question' }).catch(() => {});
  const { card, snapshot } = await bounded(question.promise, 'the question');
  const running = work => JSON.stringify({ kind: 'event', event: { ...work, type: 'running' } });
  route.send(running(oldRunning));
  route.send(running(await client.cmd('running')));
  if (snapshot) route.send(await bounded(oldWaiting.promise, 'the original waiting snapshot'));
  route.send(oldHistory);
  await page.locator('#thread .m.user', { hasText: 'echo:waiting-history' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.cbox[aria-busy="true"]'));
  const openCard = page.locator(`.mw[data-key="perm:${card.id}"] .card > .card:not(.done)`);
  assert.equal(await openCard.count(), 1, 'the question must survive the older running and history responses');
  assert.match(await openCard.textContent(), new RegExp(card.questions[0].question));
  assert.deepEqual(await openCard.locator('.opt-label').allTextContents(), ['A', 'B']);
  assert.match(await row.textContent(), /回答待ち/);
  const from = client.mark();
  await openCard.locator('.opt').first().evaluate(button => button.click());
  await openCard.locator('.card-actions .btn-primary').evaluate(button => {
    if (button.disabled) throw new Error('the answer button is disabled');
    button.click();
  });
  if (snapshot) {
    for (const phase of ['sent', 'received', 'drawn']) {
      const { line } = await host.waitLine(new RegExp(`\\[waitingCards\\].*"phase":"${phase}".*"connectionId":"${snapshot.connectionId}".*"id":"${card.id}"`));
      const { connectionId, revision, hostInstance, sessionId, id, surface, ...rest } = JSON.parse(line.slice(line.indexOf('{')));
      assert.equal(connectionId, snapshot.connectionId);
      assert.equal(revision, snapshot.revision);
      assert.equal(hostInstance, snapshot.hostInstance);
      assert.equal(sessionId, card.sessionId);
      assert.equal(id, card.id);
      assert.equal(surface, phase === 'drawn' ? 'conversation' : undefined);
      assert.deepEqual(rest, { phase });
    }
  }
  const result = await bounded(answer.promise, 'the browser to send the answer');
  assert.equal(result.ok, true, result.error);
  await client.waitFor(ev => ev.type === 'turnEnd' && ev.sessionId === sessionId, { from, ms: 10_000 });
  console.log('PASS: one answerable question survives older running, history and waiting snapshots');
} finally {
  await browser?.close();
  client?.ws.close();
  await host?.stop();
  await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 8 });
}
