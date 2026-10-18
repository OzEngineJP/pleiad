import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';

export const name = 'devin-acp';
export const title = 'Devin ACP JSON-RPC framing, callbacks, timeouts and process lifecycle';

const fake = fileURLToPath(new URL('../lib/fake-devin.mjs', import.meta.url));
const launch = (stateDir, callbacks = {}) => new DevinAcp({
  command: [process.execPath, fake], cwd: process.cwd(), env: { ...process.env, FAKE_DEVIN_STATE_DIR: stateDir }, timeoutMs: 2000, ...callbacks,
});

export default async function test(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-acp-'));
  const updates = [];
  const gone = [];
  const rpc = launch(root, { onUpdate: (params) => updates.push(params), onRequest: async (method, params, { signal }) => {
    assert.equal(method, 'session/request_permission');
    assert.equal(typeof params.toolCall.toolCallId, 'string');
    assert.equal(signal.aborted, false);
    const selected = params.options.find(option => option.kind === 'reject_once');
    assert.ok(selected && typeof selected.name === 'string');
    return { outcome: { outcome: 'selected', optionId: selected.optionId } };
  }, onGone: (error) => gone.push(error) });
  try {
    const initialized = await rpc.start();
    assert.equal(initialized.protocolVersion, 1);
    assert.ok(Number.isInteger(rpc.pid));
    assert.equal(rpc.alive, true);
    const { sessionId } = await rpc.call('session/new', { cwd: process.cwd(), mcpServers: [] });
    assert.match(sessionId, /^devin-fixture-/);
    await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[multi-utf8] hello' }] });
    assert.ok(updates.some((p) => p.sessionId === sessionId && p.update.content?.text === '日本語🙂'));
    assert.ok(updates.filter((p) => p.sessionId === sessionId).length >= 3);
    const loaded = await rpc.call('session/load', { sessionId });
    assert.equal(loaded.sessionId, sessionId);
    assert.ok((await rpc.call('session/list', {})).sessions.some((s) => s.sessionId === sessionId));
    const decision = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[permission]' }] });
    assert.deepEqual(decision.permissionResult, { outcome: { outcome: 'selected', optionId: 'reject_once' } });
    await assert.rejects(rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[slow]' }] }, { timeoutMs: 20 }), /timed out/);
    t.ok('initialize・session RPC・通知全体・マルチバイト分割・request応答・timeout', true);
  } catch (error) {
    t.ok('initialize・session RPC・通知全体・マルチバイト分割・request応答・timeout', false, error.stack);
  } finally { await rpc.close(); }
  assert.equal(rpc.alive, false);
  assert.equal(gone.length, 0, 'planned close does not report unexpected process loss');
  await assert.rejects(rpc.start(), /closed/);
  t.ok('正常 close 後の start は古い initialize 成功を返さない', true);

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
    await assert.rejects(dead.start(), /closed/);
    t.ok('予期しない終了は pending reject・onGone 一回', true);
  } catch (error) { t.ok('予期しない終了は pending reject・onGone 一回', false, error.stack); }
  finally { await dead.close(); }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-boundaries-'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const permission = { jsonrpc: '2.0', id: 'boundary-request', method: 'session/request_permission', params: { options: [] } };
  const inject = (client, frame) => client.proc.stdout.emit('data', Buffer.from(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`));
  try {
    const order = [];
    const ordered = launch('', { onResponse: ({ method, params }) => { if (method === 'session/list') order.push(`response:${params.cwd}`); }, onUpdate: () => order.push('notification') });
    try {
      await ordered.start();
      const response = ordered.call('session/list', { cwd: 'wire-order' });
      inject(ordered, `${JSON.stringify({ jsonrpc: '2.0', id: `pleiad-${ordered.nextId}`, result: { sessions: [] } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ordered', update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypass' } } })}\n`);
      await response; order.push('await');
      assert.deepEqual(order, ['response:wire-order', 'notification', 'await']);
      t.ok('onResponse は同一 batch の ACK・通知を await より先に受信順で通知する', true);
    } finally { await ordered.close(); }

    let lateCalls = 0;
    const late = launch('', { onRequest: () => { lateCalls++; return {}; } });
    try {
      await late.start();
      inject(late, `${JSON.stringify(permission)}\n{not-json}\n`);
      await settle();
      assert.equal(lateCalls, 0);
      assert.equal(late.incoming.size, 0);
      t.ok('同じ chunk の fatal frame 後は queued permission handler を開始しない', true);
    } finally { await late.close(); }

    for (const reason of ['close', 'fail']) {
      let signal, aborted = false, ready;
      const entered = new Promise(resolve => { ready = resolve; });
      const waiting = launch('', { onRequest: (_method, _params, context) => {
        signal = context.signal;
        return new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve({ outcome: { outcome: 'cancelled' } }); }, { once: true }); ready(); });
      } });
      try {
        await waiting.start(); inject(waiting, permission); await entered;
        if (reason === 'close') await waiting.close(); else inject(waiting, '{not-json}\n');
        await settle();
        assert.equal(signal.aborted, true); assert.equal(aborted, true); assert.equal(waiting.incoming.size, 0);
        t.ok(`${reason} は接続の AbortSignal で実行中の permission handler を解除する`, true);
      } finally { await waiting.close(); }
    }

    const secret = 'SYNTHETIC_ACP_SECRET';
    for (const code of [-32602, 123456]) {
      const callbacks = launch('', { onRequest: () => { throw Object.assign(new Error(`https://invalid.test/?token=${secret}`), { code, data: { token: secret } }); } });
      const wire = [];
      try {
        await callbacks.start();
        const originalWrite = callbacks.proc.stdin.write.bind(callbacks.proc.stdin);
        callbacks.proc.stdin.write = (chunk, ...rest) => { const frame = JSON.parse(String(chunk)); if (frame.error) wire.push(frame.error); return originalWrite(chunk, ...rest); };
        const { sessionId } = await callbacks.call('session/new', { cwd: process.cwd() });
        await assert.rejects(callbacks.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[permission]' }] }), { message: 'Devin ACP request failed' });
        assert.deepEqual(wire, [{ code: code === -32602 ? -32602 : -32603, message: 'Devin ACP client request failed' }]);
        const failed = callbacks.call('session/list', {});
        inject(callbacks, { jsonrpc: '2.0', id: `pleiad-${callbacks.nextId}`, error: { code: -32042, message: secret, data: { token: secret } } });
        await assert.rejects(failed, error => error.message === 'Devin ACP request failed' && error.code === -32042 && !Object.hasOwn(error, 'data') && !JSON.stringify(error).includes(secret));
        t.ok(`callback と受信 RPC error の本文・data を公開せず許可した code だけ返す（${code}）`, true);
      } finally { await callbacks.close(); }
    }

    let gone;
    const missing = launch('', { command: [path.join(scratch, `${secret}-missing.exe`)], onGone: error => { gone = error; } });
    try {
      await assert.rejects(missing.start(), error => error.message === 'Devin ACP process failed' && error.code === 'ENOENT' && !error.message.includes(secret));
      assert.equal(gone.message, 'Devin ACP process failed');
      assert.equal(gone.code, 'ENOENT');
      await assert.rejects(missing.start(), /closed/);
      t.ok('spawn 失敗は実行 path や生の message を start/onGone に出さない', true);
    } finally { await missing.close(); }

    const initFailure = path.join(scratch, 'initialize-failure.mjs');
    await fs.writeFile(initFailure, [
      "import readline from 'node:readline';",
      "readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'SYNTHETIC_ACP_SECRET',data:{token:'SYNTHETIC_ACP_SECRET'}}})+'\\n'); });",
    ].join('\n'));
    const init = launch('', { command: [process.execPath, initFailure] });
    try {
      await assert.rejects(init.start(), { message: 'Devin ACP request failed', code: -32000 });
      await assert.rejects(init.start(), /closed/);
      t.ok('initialize 失敗後の start は古い Promise を再利用しない', true);
    } finally { await init.close(); }

    const unreaped = launch('');
    unreaped.proc = Object.assign(new EventEmitter(), { pid: 'synthetic-unreaped-child', exitCode: null, signalCode: null });
    unreaped.reaping = Promise.resolve();
    await assert.rejects(unreaped.close(), /did not stop/);
    t.ok('failure で reaping 済みでも OS 終了が未確認なら close は失敗する', true);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
