import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-grok';
export const title = 'Grok: fake ACP でターンと途中送信（待ち行列に積んで同じターンで続けて回す）';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-server-grok-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  let server, c;
  try {
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'grok', AGENT_HOST_GROK_BIN: `node "${path.join(ROOT, 'tests/lib/fake-grok.mjs')}"`, GROK_HOME: path.join(root, 'grok-home') } });
    c = await open(server);
    const first = await c.runTurn({ backend: 'grok', cwd, prompt: 'alpha', mode: 'auto' });
    assert.equal(first.outcome, 'ok');
    t.ok('初回のターンが返る', Boolean(first.sessionId));
    // ---- 途中送信: 走っている回への送信は Grok の待ち行列に積まれ、今の回の直後に続けて回る。
    // Pleiad は決着を待つので、同じターンの中で答えが流れる
    const mark = c.mark();
    const holding = c.runTurn({ sessionId: first.sessionId, prompt: '[slow] hold' });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === first.sessionId, { ms: 10000, from: mark });
    await c.cmd('sendMessage', { sessionId: first.sessionId, messageId: 'grok-steer-0001', prompt: 'steer-me' });
    const held = await holding;
    const heldText = held.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    t.ok('途中送信が待ち行列から同じターンで読まれ、発言の行が出て turnResult は一度だけ',
      heldText.includes('fixture: steer-me')
      && c.since(mark).some(e => e.type === 'userMessage' && e.messageId === 'grok-steer-0001')
      && held.events.filter(e => e.type === 'turnResult').length === 1 && held.outcome === 'ok', heldText);
    c.close(); c = null;
    await server.stop(); server = null;
  } finally { c?.close(); await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
