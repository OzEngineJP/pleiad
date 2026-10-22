// Run: node tests/browser/delegate-card.mjs
// Uses the conversation's agent-browser window and an isolated fake server.
// DELEGATE_CARD_SHOTS sets the optional screenshot directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'delegate-card-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.DELEGATE_CARD_SHOTS;
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const wait = async (fn, label) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout: ${label}`);
};
const selector = '.tc[data-tool$="ply_delegate"]';
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open({ ...server, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Delegate card regression' });
  const parent = first.sessionId;
  ab('open', `http://127.0.0.1:${server.port}/?token=${server.token}`);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  // Close onboarding deliberately before selecting the parent conversation.
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => !!document.querySelector('#prompt')), 'composer');
  evaluate(sel => {
    window.__delegateBeforeResult = [];
    window.__delegateObserver?.disconnect();
    window.__delegateObserver = new MutationObserver(() => {
      for (const card of document.querySelectorAll(sel)) {
        if (!card.querySelector('.tc-output')) window.__delegateBeforeResult.push({ id: card.dataset.taskId ?? null, go: !!card.querySelector('.tc-go') });
      }
    });
    window.__delegateObserver.observe(document.body, { childList: true, subtree: true });
  }, selector);

  const call = async (name, args) => {
    const from = client.mark();
    await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name, arguments: args }) });
    const result = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from, ms: 30_000 });
    await client.waitFor(e => e.sessionId === parent && e.type === 'turnEnd', { from, ms: 30_000 });
    return JSON.parse(result.text);
  };
  const delegate = (title, task) => call('ply_delegate', { backend: 'fake', kind: 'mechanical', title, task });
  const A = await delegate('A: cancelled investigation', 'active-shell');
  await call('ply_task_cancel', { taskId: A.taskId });
  const B = await delegate('B: follow up A', `echo:Investigate cancelled task ${A.taskId}`);
  const C = await delegate('C: follow up A and B', `echo:Compare ${A.taskId} and ${B.taskId}`);
  const ids = [A.taskId, B.taskId, C.taskId];
  const readCards = () => evaluate(sel => [...document.querySelectorAll(sel)].map(card => ({
    id: card.dataset.taskId, result: JSON.parse(card.querySelector('.tc-output pre').textContent).taskId,
    arrows: card.querySelectorAll(':scope > .tc-go').length,
    state: card.querySelector('.tc-head').getAttribute('aria-label'),
  })), selector);
  await wait(() => evaluate(sel => document.querySelectorAll(`${sel}[data-task-id]`).length === 3, selector), 'three linked cards');
  const pending = evaluate(() => window.__delegateBeforeResult);
  assert.ok(pending.length, 'observed tool starts before their results');
  assert.ok(pending.every(row => row.id === null && !row.go), 'no task binding before result');
  const checkCards = () => {
    const rows = readCards();
    assert.deepEqual(rows.map(row => row.id), ids);
    assert.ok(rows.every(row => row.id === row.result && row.arrows === 1));
    assert.ok(rows[0].state.includes('停止済み'));
    assert.ok(rows.slice(1).every(row => row.state.includes('完了')));
    return rows;
  };
  console.log('live:', JSON.stringify(checkCards()));
  if (shots) { fs.mkdirSync(shots, { recursive: true }); ab('screenshot', path.join(shots, 'delegate-card-fix-live.png')); }

  ab('reload');
  await wait(() => evaluate(sel => document.querySelectorAll(`${sel}[data-task-id]`).length === 3, selector), 'history cards');
  console.log('history:', JSON.stringify(checkCards()));
  // The arrow must select B's child, even though B's request contains A's id.
  evaluate(sel => {
    const card = document.querySelectorAll(sel)[1];
    card.querySelector('.tc-details').open = true;
    card.querySelector('.tc-tabs button').click();
    card.scrollIntoView({ block: 'center' });
  }, selector);
  if (shots) ab('screenshot', path.join(shots, 'delegate-card-fix-history.png'));
  evaluate(sel => document.querySelectorAll(sel)[1].querySelector('.tc-go').click(), selector);
  await wait(() => evaluate(() => !!document.querySelector('#workDialog[open]')), 'child dialog');
  await wait(() => evaluate(() => !!document.querySelector('#workList [aria-current="true"]')), 'selected child');
  const selected = evaluate(() => document.querySelector('#workList [aria-current="true"]').dataset.key);
  assert.equal(selected, `t:${B.taskId}`);
  if (shots) ab('screenshot', path.join(shots, 'delegate-card-fix-child.png'));
  console.log('PASS: live starts, cancellation, three delegates, history and child arrow');
} finally {
  client?.close();
  await server?.stop();
  // base is created by this test, entirely inside the worktree.
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
