import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { holderSource } from '../../core/adopt.mjs';
import { HeldMcpTransport } from '../../core/context-mcp-held.mjs';

export const name = 'context-mcp-held';
export const title = '保持役の MCP の口: 閉じると読みの列を終え、止めて記録を捨てる・手を離す';
const tick = () => new Promise(resolve => setImmediate(resolve));

/** 保持役の口（core/holder/client.mjs の HolderClient）の身代わり。kill したら子の exit を返す */
function fakeClient() {
  const client = new EventEmitter();
  client.sent = [];
  const note = (t, extra) => { client.sent.push({ t, ...extra }); return true; };
  Object.assign(client, {
    write: (id, data) => note('write', { id, data }),
    kill: (id, options) => { note('kill', { id, ...options }); setImmediate(() => client.emit('exit', { id, code: null, signal: 'SIGKILL' })); return true; },
    ack: (id, seq) => note('ack', { id, seq }),
    label: (id, label) => note('label', { id, label }),
    release: id => note('release', { id }),
    attach: async (id, { from } = {}) => { note('attach', { id, from }); return null; },
  });
  return client;
}
const listeners = client => ['out', 'exit', 'disconnect'].reduce((n, e) => n + client.listenerCount(e), 0);

export default async function (t) {
  {
    const client = fakeClient();
    const transport = new HeldMcpTransport({ id: 'mcp-a', source: holderSource(client, { id: 'mcp-a' }, { spawned: true }) });
    const received = [];
    let closed = 0;
    transport.onmessage = m => received.push(m);
    transport.onclose = () => { closed++; };
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const sentId = JSON.parse(client.sent.find(f => f.t === 'write').data).id;
    client.emit('out', { id: 'mcp-a', seq: 1, line: JSON.stringify({ jsonrpc: '2.0', id: sentId, result: {} }) });
    await tick();
    assert.deepEqual(received, [{ jsonrpc: '2.0', id: 1, result: {} }]);
    await transport.close();
    await tick();
    assert.deepEqual(client.sent.filter(f => f.t !== 'write' && f.t !== 'ack').map(f => f.t), ['kill', 'release']);
    assert.equal(closed, 1);
    assert.equal(listeners(client), 0);
    t.ok('閉じると子を木ごと止め、止まってから記録を捨て、読みの列を終えて onclose を 1 回出す', true);
  }
  {
    const client = fakeClient();
    const transport = new HeldMcpTransport({ id: 'mcp-b', source: holderSource(client, { id: 'mcp-b' }, { spawned: true }) });
    let closed = 0;
    transport.onclose = () => { closed++; };
    await transport.start();
    transport.setKeepHeld(true);
    await transport.close();
    await tick();
    assert.deepEqual(client.sent.map(f => f.t), []);
    assert.equal(closed, 1);
    assert.equal(listeners(client), 0);
    t.ok('サーバーの終わり（keepHeld）は子を止めず記録も残し、読みの列だけを終える', true);
  }
}
