// Run with Playwright installed. PLAYWRIGHT_MODULE may point to an existing installation.
// LIMIT_SWITCH_SHOTS and LIMIT_SWITCH_MOCK optionally capture the verification views.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { claudeAccountServerEnv, seedClaudeAccount } from '../lib/claude-account-seed.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = path.join(ROOT, 'temporary');
await fs.mkdir(temporary, { recursive: true });
const scratch = await fs.mkdtemp(path.join(temporary, 'limit-switch-'));
const shots = process.env.LIMIT_SWITCH_SHOTS;
if (shots) await fs.mkdir(shots, { recursive: true });
let server, client, browser, compatApi;
try {
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: {
    AGENT_HOST_BACKENDS: 'fake,antigravity,codex',
    AGENT_HOST_AGY_BIN: 'node "' + path.join(ROOT, 'tests/lib/fake-agy.mjs') + '"',
    AGENT_HOST_CODEX_BIN: 'node "' + path.join(ROOT, 'tests/lib/fake-codex.mjs') + '"',
    AGENT_HOST_LOCALE: 'ja',
    ...await claudeAccountServerEnv(path.join(scratch, 'fake-cli')),
  } });
  client = await open({ port: server.port, token: server.token, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('authStatus', { backend: 'antigravity', probe: true });
  await client.cmd('completeSetup', { backend: 'fake' });
  const privateId = await seedClaudeAccount(path.join(scratch, 'data'), 'Private');
  const { sessionId } = await client.cmd('newSession', { backend: 'fake', cwd: scratch });
  await client.cmd('setTurnSettings', { sessionId, account: '' });
  await client.runTurn({ sessionId, prompt: 'echo:デザイン案の続きに取りかかります。' });
  await client.runTurn({ sessionId, prompt: 'limit ' + (Date.now() + 2 * 3600_000) });

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('agent-host-lang', 'ja'));
  await page.goto('http://127.0.0.1:' + server.port + '/?token=' + server.token);
  await page.locator('#groups .row[data-session="' + sessionId + '"]').evaluate(row => row.click());
  const resume = page.locator('#resume');
  const note = page.locator('#resumeNote');
  const prompt = page.locator('#prompt');
  const tail = page.locator('.limit-interrupt-sub').last();
  const choose = async (section, key) => {
    const chip = page.locator('#modelChip');
    if (await chip.getAttribute('aria-expanded') !== 'true') await chip.click();
    await page.locator('#modelPop [data-key="nav:' + section + '"]').click();
    await page.locator('#modelPop [data-key="' + key + '"]').click();
    if (await chip.getAttribute('aria-expanded') === 'true') await chip.click();
  };
  const type = text => prompt.evaluate((editor, text) => {
    editor.focus();
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  const waitResume = disabled => page.waitForFunction(disabled => {
    const resume = document.getElementById('resume');
    return !resume.hidden && resume.disabled === disabled;
  }, disabled);
  // 上限で止まった会話も、解除の前から普通の「再開」（時計にしない・待たせない。ADR 0352）。末尾の 2 行目に解除の時刻だけ出す
  await waitResume(false);
  const fact = (await tail.innerText()).trim();
  assert.match(fact, /に解除$/);
  assert.equal(await resume.getAttribute('aria-label'), '再開');
  await type('再開してください');
  await note.waitFor({ state: 'hidden' });
  await type('');

  await choose('conn', 'account:' + privateId);
  await waitResume(false);
  await note.waitFor({ state: 'hidden' });
  await choose('conn', 'account:');
  await waitResume(false);

  // The fake provider advertises host compaction. Antigravity manages its own.
  await type('/compact');
  await page.locator('#skillList').getByText('/compact', { exact: true }).waitFor();
  await type('');
  await page.locator('#contextMeter').click();
  await page.locator('#meterCompact:enabled').waitFor();
  await page.keyboard.press('Escape');

  await choose('agent', 'backend:antigravity');
  await waitResume(false);
  assert.equal((await tail.innerText()).trim(), fact);
  await type('/compact');
  await page.locator('#skillList').getByText(/Antigravity/).waitFor();
  await type('');
  await page.locator('#contextMeter').click();
  await page.locator('#meterCompact:disabled').waitFor();
  await page.keyboard.press('Escape');
  await note.waitFor({ state: 'hidden' });

  const mockPath = process.env.LIMIT_SWITCH_MOCK;
  const mock = mockPath ? await browser.newPage() : null;
  if (mock) await mock.goto(pathToFileURL(mockPath).href);
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [360, 'light']]) {
    await page.setViewportSize({ width, height: 800 });
    await page.locator('#themeSeg [data-theme="' + theme + '"]').evaluate(button => button.click());
    await type('');
    await waitResume(false);
    assert.equal(await resume.getAttribute('aria-label'), '再開');
    assert.equal(await resume.locator('.resume-play').isVisible(), true);
    assert.equal(await note.evaluate(node => node.getBoundingClientRect().height), 0);
    assert.equal((await tail.innerText()).trim(), fact);
    if (shots) await page.screenshot({ path: path.join(shots, 'verify-' + width + '-' + theme + '-empty.png'), animations: 'disabled' });
    await type('再開してください');
    await resume.waitFor({ state: 'hidden' });
    assert.equal(await note.evaluate(node => node.getBoundingClientRect().height), 0);
    assert.equal(await page.locator('#send').isEnabled(), true);
    if (shots) await page.screenshot({ path: path.join(shots, 'verify-' + width + '-' + theme + '.png'), animations: 'disabled' });
    if (mock && shots) {
      await mock.setViewportSize({ width, height: 800 });
      await mock.locator('.theme [data-theme="' + theme + '"]').click();
      await mock.locator('#empty-narrow').setChecked(width === 360);
      for (const id of ['typing-after', 'empty-after', 'history-a']) {
        await mock.locator('#' + id).screenshot({ path: path.join(shots, 'mock-' + width + '-' + theme + '-' + id + '.png') });
      }
    }
  }

  const from = client.mark();
  await page.locator('#send').click();
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from, ms: 15000 })
    .catch(async err => { throw new Error(`${err.message}\nAntigravity: ${JSON.stringify(await client.cmd('listMessages', { sessionId }))}`); });
  assert.equal((await client.cmd('listSessions')).find(row => row.id === sessionId).backend, 'antigravity');

  const { sessionId: stoppedId } = await client.cmd('newSession', { backend: 'fake', cwd: scratch });
  const stop = async (held) => {
    const from = client.mark();
    await client.cmd('runTurn', { sessionId: stoppedId, prompt: 'slow' });
    await client.waitFor(e => e.type === 'activity' && e.sessionId === stoppedId, { from });
    if (held) await client.cmd('sendMessage', { sessionId: stoppedId, messageId: 'held-in-browser', prompt: 'echo:held' });
    await client.cmd('abort', { sessionId: stoppedId });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === stoppedId && e.interrupted?.reason === 'user', { from });
  };
  await stop(false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#groups .row[data-session="' + stoppedId + '"]').evaluate(row => row.click());
  await waitResume(false);
  await type('continue');
  await resume.waitFor({ state: 'hidden' });
  assert.equal(await note.evaluate(node => node.getBoundingClientRect().height), 0);
  await type('');
  await stop(true);
  await page.waitForFunction(() => document.getElementById('resumeNote').textContent.includes('1'));
  await type('continue');
  await note.waitFor({ state: 'visible' });
  assert.match(await note.innerText(), /1/);

  const key = 'sk-compat-' + 's'.repeat(24);
  compatApi = await startFakeCompatApi({ keys: [key], auth: 'bearer', models: ['vendor/fake-large'] });
  const input = { agent: 'codex', name: 'Fake Responses', preset: 'custom', baseUrl: compatApi.url + '/v1',
    authMode: 'bearer', key, roles: { main: 'vendor/fake-large' } };
  const { receipt } = await client.cmd('compatEndpointCheck', { input });
  const { id: endpoint } = await client.cmd('compatEndpointSave', { input, receipt });
  const { sessionId: compatId } = await client.cmd('newSession', { backend: 'codex', cwd: scratch });
  await client.cmd('setTurnSettings', { sessionId: compatId, endpoint });
  assert.equal((await client.runTurn({ sessionId: compatId, prompt: 'hit usage limit' })).outcome, 'limited');
  await page.locator('#groups .row[data-session="' + compatId + '"]').evaluate(row => row.click());
  await waitResume(false);
  await choose('conn', 'account:');
  await waitResume(false);
  await choose('conn', 'endpoint:' + endpoint);
  await waitResume(false);
  await choose('conn', 'account:');
  await waitResume(false);
  await type('continue on official');
  assert.equal(await note.evaluate(node => node.getBoundingClientRect().height), 0);
  const officialFrom = client.mark();
  await page.locator('#send').click();
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === compatId && e.outcome === 'ok', { from: officialFrom, ms: 15000 })
    .catch(async err => { throw new Error(`${err.message}\nCodex: ${JSON.stringify(await client.cmd('listMessages', { sessionId: compatId }))}`); });

  assert.deepEqual(pageErrors, []);
  console.log('PASS: account and endpoint reselection, agent switch, compaction, history, immediate delivery, and held notes');
} finally {
  await browser?.close();
  client?.close();
  await server?.stop();
  await compatApi?.close();
  assert.ok(!server || server.child.exitCode !== null || server.child.signalCode !== null, 'test server exited');
  assert.equal(path.dirname(scratch), temporary);
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
