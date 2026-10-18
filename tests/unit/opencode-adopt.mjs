import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCase, summarize } from '../lib/harness.mjs';
import { createOpencodeServer } from '../../core/backends/opencode-server.mjs';
import { acquireHeldOpencode, configureOpencodeHeld, expandHeldOpencode, opencodeChildId } from '../../core/backends/opencode-held.mjs';

export const name = 'opencode-adopt';
export const title = 'Lost adopted OpenCode servers reject before listen without waiting for a new origin';

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('OpenCode restore exceeded the fake pre-listen boundary')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

export default async function testOpencodeAdopt(t) {
  const keys = ['AGENT_HOST_OPENCODE_HOLDER', 'AGENT_HOST_RUNTIME_ROOT'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_HOST_OPENCODE_HOLDER = 'on';
  process.env.AGENT_HOST_RUNTIME_ROOT = path.join(process.env.AGENT_HOST_DATA, 'fake-opencode-adopt-runtime');
  const calls = { env: 0, origin: 0, spawn: 0, reads: 0, allowSpawn: [] };
  const pendingOrigin = new Promise(() => {});
  let currentOrigin = null;
  const env = () => { calls.env++; return currentOrigin ? {} : pendingOrigin; };
  const origin = () => { calls.origin++; return currentOrigin ?? pendingOrigin; };
  const auth = 'Basic fake-adopt-auth';
  let expectedAuth = auth;
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== expectedAuth) { res.writeHead(401); res.end(); return; }
    if (url.pathname === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      return;
    }
    if (url.pathname !== '/session/ses_restore/message' || url.searchParams.get('directory') !== '/restore-workspace') {
      res.writeHead(404); res.end(); return;
    }
    calls.reads++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ info: { id: 'msg_saved', role: 'user' }, parts: [{ type: 'text', text: 'saved history' }] }]));
  });
  const client = new EventEmitter();
  Object.assign(client, { connected: true, attach: async () => ({ alive: true }), release() {}, ack() {}, label() {},
    kill(id) { client.emit('exit', { id, code: 0 }); },
    spawn() { calls.spawn++; throw new Error('pre-listen acquisition must not spawn a holder child'); },
  });
  const sources = [], servers = [], heldChildren = [];
  let replacement = null;
  try {
    // Keep the holder's global configuration isolated from other suites.
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--acquire-only'], { timeout: 5000, windowsHide: true });
    t.ok('read-only acquisition returns before holder discovery even for a directly executable CLI', true);
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const restore = async (suffix, dieOnAcquire = false) => {
      const account = { id: `adopt-${suffix}`, dir: path.join(process.env.AGENT_HOST_DATA, `adopt-${suffix}`) };
      const restored = await expandHeldOpencode({ client, child: { id: opencodeChildId(account), alive: true,
        label: { v: 1, server: { base, auth, origin: 'http://previous-pleiad', account },
          turns: { [`ses_restore_${suffix}`]: { backendCard: { account } } } } } });
      assert.equal(restored.length, 1);
      sources.push(...restored);
      const held = restored[0].opencode;
      heldChildren.push(held);
      const srv = createOpencodeServer({ command: () => ['fake.cmd'], env, origin, currentOrigin: () => currentOrigin,
        held: { acquire(args) {
          calls.allowSpawn.push(args.allowSpawn);
          if (args.allowSpawn && replacement) return Promise.resolve(replacement);
          return acquireHeldOpencode({ ...args, account }).then(child => {
            if (dieOnAcquire && child) client.emit('exit', { id: child.id, code: 1 });
            return child;
          });
        } } });
      servers.push(srv);
      return { srv, held };
    };
    const read = srv => srv.request('GET', '/session/ses_restore/message', { directory: '/restore-workspace' });
    const notReady = { code: 'OPENCODE_ORIGIN_NOT_READY' };

    const dead = await restore('dead');
    client.emit('exit', { id: dead.held.id, code: 1 });
    await bounded(Promise.all([assert.rejects(read(dead.srv), notReady), assert.rejects(read(dead.srv), notReady)]));
    await bounded(assert.rejects(read(dead.srv), notReady));
    assert.equal(dead.srv.running, false);
    assert.equal(client.listeners('exit').includes(dead.held.onExit), false);
    assert.deepEqual({ env: calls.env, origin: calls.origin, spawn: calls.spawn, reads: calls.reads }, { env: 0, origin: 0, spawn: 0, reads: 0 });
    assert.ok(calls.allowSpawn.every(value => value === false));
    t.ok('death between expand and history read rejects concurrent calls and retries without waiting or spawning', true);

    const duringAcquire = await restore('during-acquire', true);
    await bounded(assert.rejects(read(duringAcquire.srv), notReady));
    assert.equal(duringAcquire.srv.running, false);
    assert.equal(calls.reads, 0);
    assert.equal(calls.env, 0);
    assert.equal(calls.origin, 0);
    t.ok('a child that dies while acquisition resolves cannot be adopted from its stale server metadata', true);

    const live = await restore('live');
    const messages = await bounded(read(live.srv));
    assert.equal(messages[0].parts[0].text, 'saved history');
    assert.equal(live.srv.held, live.held);
    assert.equal(calls.reads, 1);
    assert.equal(calls.env, 0);
    assert.equal(calls.origin, 0);
    t.ok('a live adopted server still serves authenticated history before the new Pleiad listens', true);

    client.emit('exit', { id: live.held.id, code: 1 });
    await bounded(assert.rejects(read(live.srv), notReady));
    assert.equal(live.srv.running, false);
    assert.equal(calls.env, 0);
    assert.equal(calls.origin, 0);
    assert.equal(calls.spawn, 0);
    t.ok('death after adoption also rejects instead of restarting before listen', true);

    const cold = createOpencodeServer({ command: () => ['fake.cmd'], env, origin, currentOrigin: () => currentOrigin });
    servers.push(cold);
    await bounded(assert.rejects(read(cold), notReady));
    assert.equal(calls.env, 0);
    assert.equal(calls.origin, 0);
    t.ok('the direct-child fallback also fails before entering an unresolved environment/origin', true);

    currentOrigin = 'http://new-pleiad';
    replacement = { server: null, closed: false, detached: false,
      async spawn({ env }) {
        calls.spawn++;
        expectedAuth = `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
        return base;
      },
      setServer(server) { this.server = server; },
      onGone() {}, tail: () => '', async stop() {},
    };
    assert.equal((await bounded(read(dead.srv)))[0].parts[0].text, 'saved history');
    assert.equal(calls.allowSpawn.at(-1), true);
    assert.equal(calls.spawn, 1);
    assert.equal(calls.env, 1);
    assert.equal(calls.origin, 1);
    assert.equal(replacement.server.origin, currentOrigin);
    t.ok('a rejected server can retry normal startup after listen publishes the new origin', true);
  } finally {
    for (const srv of servers) await srv.stop();
    for (const held of heldChildren) { if (!held.closed) client.emit('exit', { id: held.id, code: 0 }); held.dispose(); }
    for (const source of sources) source.dispose();
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--acquire-only')) {
      process.env.AGENT_HOST_OPENCODE_HOLDER = 'on';
      process.env.AGENT_HOST_RUNTIME_ROOT = path.join(process.env.AGENT_HOST_DATA, 'unused-runtime');
      configureOpencodeHeld({ dataDir: () => { throw new Error('read-only acquisition reached holder discovery'); } });
      assert.equal(await bounded(acquireHeldOpencode({ argv: [process.execPath], allowSpawn: false })), null);
    } else process.exitCode = summarize([await runCase({ name, title, default: testOpencodeAdopt })]);
  }
  finally { await cleanupTestData(); }
}
