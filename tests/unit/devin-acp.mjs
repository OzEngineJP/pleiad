import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';

export const name = 'devin-acp';
export const title = 'Devin ACP JSON-RPC framing, callbacks, timeouts and process lifecycle';

const fake = fileURLToPath(new URL('../lib/fake-devin.mjs', import.meta.url));
const launch = (stateDir, callbacks = {}) => new DevinAcp({
  command: [process.execPath, fake], cwd: process.cwd(), env: { FAKE_DEVIN_STATE_DIR: stateDir }, timeoutMs: 2000, ...callbacks,
});

export default async function test(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-acp-'));
  const updates = [];
  const gone = [];
  const rpc = launch(root, { onUpdate: (params) => updates.push(params), onRequest: async (method, params) => ({ method, optionId: params.options[0].optionId }), onGone: (error) => gone.push(error) });
  try {
    const initialized = await rpc.start();
    assert.equal(initialized.protocolVersion, 1);
    assert.ok(Number.isInteger(rpc.pid));
    assert.equal(rpc.alive, true);
    const { sessionId } = await rpc.call('session/new', { cwd: process.cwd(), mcpServers: [] });
    assert.match(sessionId, /^devin-fixture-/);
    await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[multi-utf8] hello' }] });
    assert.ok(updates.some((p) => p.sessionId === sessionId && p.update.content.text === '日本語🙂'));
    assert.ok(updates.filter((p) => p.sessionId === sessionId).length >= 3);
    const loaded = await rpc.call('session/load', { sessionId });
    assert.equal(loaded.sessionId, sessionId);
    assert.ok((await rpc.call('session/list', {})).sessions.some((s) => s.sessionId === sessionId));
    const decision = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[permission]' }] });
    assert.deepEqual(decision.permissionResult, { method: 'session/request_permission', optionId: 'allow_once' });
    await assert.rejects(rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[slow]' }] }, { timeoutMs: 20 }), /timed out/);
    t.ok('initialize・session RPC・通知全体・マルチバイト分割・request応答・timeout', true);
  } catch (error) {
    t.ok('initialize・session RPC・通知全体・マルチバイト分割・request応答・timeout', false, error.stack);
  } finally { await rpc.close(); }
  assert.equal(rpc.alive, false);
  assert.equal(gone.length, 0, 'planned close does not report unexpected process loss');

  const reopened = launch(root);
  try {
    await reopened.start();
    assert.equal((await reopened.call('session/list', {})).sessions.length, 1);
    t.ok('fake fixture はプロセスをまたいで session list を保持', true);
  } catch (error) { t.ok('fake fixture はプロセスをまたいで session list を保持', false, error.stack); }
  finally { await reopened.close(); await fs.rm(root, { recursive: true, force: true }); }

  const racing = launch('');
  try {
    await racing.start();
    const { sessionId } = await racing.call('session/new', { cwd: process.cwd() });
    const pending = racing.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[slow]' }] }, { timeoutMs: 5000 });
    const cancelled = assert.rejects(pending, /closed/);
    await racing.close();
    await cancelled;
    t.ok('close 中の pending request を reject し process tree を終了', !racing.alive);
  } catch (error) { t.ok('close 中の pending request を reject し process tree を終了', false, error.stack); await racing.close(); }

  const startupRace = launch('');
  const starting = startupRace.start().then(() => null, (error) => error);
  await startupRace.close();
  const startupError = await starting;
  assert.ok(startupError);
  assert.equal(startupRace.alive, false);
  t.ok('start/close race reaps the starting child', true);

  const brokenGone = [];
  const broken = launch('', { onGone: (error) => brokenGone.push(error) });
  try {
    await broken.start();
    const { sessionId } = await broken.call('session/new', { cwd: process.cwd() });
    await assert.rejects(broken.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[frame-malformed]' }] }), /Invalid Devin ACP JSON frame/);
    assert.equal(brokenGone.length, 1);
    t.ok('不正 frame は fail closed し pending を reject、onGone は一度だけ', true);
  } catch (error) { t.ok('不正 frame は fail closed し pending を reject、onGone は一度だけ', false, error.stack); }
  finally { await broken.close(); }

  const deadGone = [];
  const dead = launch('', { onGone: (error) => deadGone.push(error) });
  try {
    await dead.start();
    const { sessionId } = await dead.call('session/new', { cwd: process.cwd() });
    await assert.rejects(dead.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[kill]' }] }), /exited/);
    assert.equal(deadGone.length, 1);
    t.ok('予期しない終了は pending reject・onGone 一回', true);
  } catch (error) { t.ok('予期しない終了は pending reject・onGone 一回', false, error.stack); }
  finally { await dead.close(); }
}
