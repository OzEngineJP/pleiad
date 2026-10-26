// Run: node tests/browser/satellite-approval.mjs
// Uses the conversation's agent-browser window and an isolated fake server.
// SATELLITE_SHOTS optionally keeps screenshots inside the worktree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { scrubInheritedEnv } from '../lib/inherited-env.mjs';

// Keep the browser connection in the caller, but do not pass it to the test server.
const browserEnv = { ...process.env };
scrubInheritedEnv();
const ab = (...args) => execFileSync(browserEnv.AGENT_BROWSER_BIN || 'agent-browser', args,
  { env: browserEnv, encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const wait = async (fn, label) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timeout: ${label}`);
};
fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'satellite-approval-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.SATELLITE_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const capture = name => { if (shots) ab('screenshot', path.join(shots, `${name}.png`)); };
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open(server);
  await client.cmd('authLogin', { backend: 'fake' });
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Satellite approval regression' });
  const parent = first.sessionId;
  const delegate = async (title, task) => {
    const turn = await client.runTurn({ sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate',
      arguments: { backend: 'fake', kind: 'mechanical', title, task } }) });
    const result = turn.events.find(e => e.sessionId === parent && e.type === 'tool.result');
    return JSON.parse(result.text);
  };
  const a = await delegate('Child approval', 'ask-slow');
  const b = await delegate('Child still running', 'slow');
  ab('open', `http://127.0.0.1:${server.port}/?token=${server.token}`);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  // Inspect and close onboarding before selecting the conversation.
  capture('onboarding');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('#thread .m.activity .run.sat circle').length === 2), 'two satellites before approval');
  await wait(() => evaluate(() => !!document.querySelector('#thread .m.card:not(.done) .btn-primary')), 'relayed approval');
  capture('before-answer');
  ab('click', '#thread .m.card:not(.done) .btn-primary');
  await wait(() => evaluate(() => !document.querySelector('#thread .m.card:not(.done) .btn-primary')), 'approval folded');
  await wait(() => evaluate(() => document.querySelectorAll('#thread .m.activity .run.sat circle').length === 2), 'two satellites after approval');
  // A running broadcast arrives every four seconds. It must retain the satellites too.
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(evaluate(() => document.querySelectorAll('#thread .m.activity .run.sat circle').length), 2);
  capture('after-answer');
  console.log('PASS: parent finished; relayed approval answered; two satellites survive sync');
  for (const task of [a, b]) await client.runTurn({ sessionId: parent,
    prompt: 'ply:' + JSON.stringify({ name: 'ply_task_cancel', arguments: { taskId: task.taskId } }) });
  await wait(() => evaluate(() => !document.querySelector('#thread .m.activity')), 'children stopped');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
