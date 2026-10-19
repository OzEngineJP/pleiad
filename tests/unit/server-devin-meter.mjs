import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-devin-meter';
export const title = 'Devin token totals persist through replay, resumed turns, steer and server restart';

export default async function test(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-meter-'));
  const dataDir = path.join(root, 'data');
  const env = { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"` };
  let server, client;
  const totals = async () => {
    const { local } = await client.cmd('providerUsage', { backend: 'devin' });
    return [local.fiveHour.inputTokens.value, local.fiveHour.outputTokens.value, local.fiveHour.cachedTokens.value];
  };
  try {
    server = await startServer({ dataDir, env }); client = await open(server);
    const first = await client.runTurn({ backend: 'devin', cwd: root, mode: 'ask', prompt: '[usage-multi] one' });
    assert.equal(first.outcome, 'ok');
    assert.deepEqual(await totals(), [1400, 110, 900]);
    await client.cmd('loadSession', { sessionId: first.sessionId });
    await client.cmd('loadSession', { sessionId: first.sessionId });
    assert.deepEqual(await totals(), [1400, 110, 900]);
    await client.runTurn({ sessionId: first.sessionId, mode: 'ask', prompt: 'two' });
    assert.deepEqual(await totals(), [2400, 210, 1700]);
    t.ok('all model calls count once, completion usage does not overwrite the sum, and replay does not add history', true);

    const mark = client.mark();
    const pending = client.runTurn({ backend: 'devin', cwd: root, mode: 'ask', prompt: '[slow] three' });
    const started = await client.waitFor(event => event.type === 'session' && event.first, { from: mark, ms: 10000 });
    await client.cmd('sendMessage', { sessionId: started.sessionId, messageId: 'devin-meter-steer', prompt: 'four' });
    await pending;
    assert.deepEqual(await totals(), [5400, 510, 4100]);
    t.ok('a steered prompt contributes its own model request within the same Pleiad turn', true);

    client.close(); client = null; await server.stop(); server = null;
    server = await startServer({ dataDir, env }); client = await open(server);
    assert.deepEqual(await totals(), [5400, 510, 4100]);
    t.ok('input/output/cache totals survive server restart without a model call', true);
  } finally {
    client?.close(); await server?.stop();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
