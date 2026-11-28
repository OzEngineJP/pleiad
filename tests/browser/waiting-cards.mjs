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
  host = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', AGENT_HOST_WAITING_TRACE: '1' } });
  client = await open(host);
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });
  const { sessionId } = await client.runTurn({ backend: 'fake', cwd: scratch, prompt: 'echo:waiting-history' });
  browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ locale: 'ja-JP' });
  const trace = [];
  page.on('console', m => {
    if (m.text().startsWith('[waitingCards] ')) trace.push(JSON.parse(m.text().slice('[waitingCards] '.length)));
  });
  const history = Promise.withResolvers();
  const question = Promise.withResolvers();
  const oldWaiting = Promise.withResolvers();
  let route, loadId, answerId, traceId;
  const answer = Promise.withResolvers();
  const reported = Promise.withResolvers();
  await page.routeWebSocket('**/ws?*', socket => {
    route = socket;
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.command === 'loadSession' && m.args.sessionId === sessionId && m.args.live) loadId ??= m.id;
      if (m.command === 'resolvePermission') answerId = m.id;
      if (m.args?.op === 'app.reportSlow' && m.args.args.entries.some(e => e.kind === 'waiting-card' && e.phase === 'drawn')) traceId = m.id;
      server.send(raw);
    });
    server.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.kind === 'response' && loadId && m.id === loadId) return history.resolve(raw);
      if (m.kind === 'response' && answerId && m.id === answerId) answer.resolve(m);
      if (m.kind === 'response' && traceId && m.id === traceId) reported.resolve(m);
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
  if (snapshot) {
    const raw = await bounded(oldWaiting.promise, 'the original waiting snapshot');
    route.send(raw);
    const older = JSON.parse(raw);
    older.event.cards = [{ ...card, questions: [] }];
    route.send(JSON.stringify(older));
  }
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
  const { line } = await host.waitLine(new RegExp(`\\[waitingCards\\].*"phase":"sent".*"id":"${card.id}".*"connectionId":"${snapshot.connectionId}"`));
  const metadata = { id: card.id, revision: snapshot.revision, connectionId: snapshot.connectionId };
  assert.deepEqual(JSON.parse(line.slice(line.indexOf('{'))), { phase: 'sent', ...metadata });
  assert.deepEqual(trace.find(e => e.phase === 'received' && e.id === card.id), { phase: 'received', ...metadata });
  assert.deepEqual(trace.find(e => e.phase === 'drawn' && e.id === card.id), { phase: 'drawn', ...metadata, surface: 'conversation' });
  assert.ok(trace.some(e => e.phase === 'ignored' && e.id === card.id && e.revision < snapshot.revision));
  const traceReport = await bounded(reported.promise, 'the existing diagnostics command to accept the draw record');
  assert.equal(traceReport.ok, true, JSON.stringify(traceReport));
  assert.ok(traceReport.result.recorded >= 1);
  const result = await bounded(answer.promise, 'the browser to send the answer');
  assert.equal(result.ok, true, result.error);
  await client.waitFor(ev => ev.type === 'turnEnd' && ev.sessionId === sessionId, { from, ms: 10_000 });
  console.log('PASS: one answerable question survives older running, history and waiting snapshots');

  const incompatible = await browser.newPage({ locale: 'ja-JP' });
  await incompatible.addInitScript(() => {
    Storage.prototype.setItem = new Proxy(Storage.prototype.setItem, {
      apply(setItem, storage, args) {
        if (storage === sessionStorage) {
          if (args[0] === 'ply-version-reload') window.reloadStorageBlocked = true;
          throw new Error('session storage is unavailable');
        }
        return Reflect.apply(setItem, storage, args);
      },
    });
  });
  await incompatible.routeWebSocket('**/ws?*', socket => {
    const server = socket.connectToServer();
    server.onMessage(raw => {
      const frame = JSON.parse(raw);
      socket.send(frame.kind === 'ready'
        ? JSON.stringify({ ...frame, protocolVersion: 3, version: '0.0.0', build: 'old-host' })
        : raw);
    });
  });
  await incompatible.goto(`http://127.0.0.1:${host.port}/?token=${host.token}`);
  await incompatible.getByText('未対応の protocolVersion: 3', { exact: true }).first().waitFor();
  assert.equal(await incompatible.evaluate(() => window.reloadStorageBlocked), true);
  console.log('PASS: incompatible protocol is reported without session storage');
} finally {
  await browser?.close();
  client?.ws.close();
  await host?.stop();
  await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 8 });
}
