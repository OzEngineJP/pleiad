// 段階 2 の 2b-4: 走っているターンの付け直し（docs/zero-downtime-update/stage2-server-state.md §4.2-§4.4・§5・§6.1）。
// 通常停止した A と、A 不在中に終わった保持役の子から、B が札と記録を読み直す:
//   1. 記録の再生の道（core/adopt.mjs の replayRecord）: 印から ack までは replay、続きは普通に流して ack、uuid で冪等
//   2. B の起動復元: turnEnd・completedAt・使用量を 1 回だけ残し、A 不在中の完了を拾い直す
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { replayRecord } from '../../core/adopt.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

export const name = 'adopt-finished';
export const title = '付け直し: A が不在の間に終わったターンを B が記録から 1 回だけ締める';

const WAIT_MS = 15_000;
const line = event => JSON.stringify(event);

export default async function (t) {
  // 1. 記録の再生の道（純関数に近い。保持役の子の見え方を真似た元で）
  {
    const lines = [
      [1, line({ type: 'session', sessionId: 's1' })],
      [2, line({ type: 'text.delta', text: 'a' })],
      [3, line({ type: 'text.end', uuid: 'u1' })],
      [4, line({ type: 'text.delta', text: 'b' })],
      [5, line({ type: 'text.end', uuid: 'u2' })],
      [6, line({ type: 'text.end', uuid: 'u2' })],
      [7, line({ type: 'text.end', uuid: 'u1' })],
      [8, line({ type: 'turnResult', outcome: 'ok' })],
    ];
    const acks = [];
    const source = {
      state: { marks: { turn: 2 }, acked: 3 },
      async replay(from, to) { return lines.filter(([seq]) => seq >= from && seq <= to); },
      async *attach(from) { for (const [seq, l] of lines) if (seq >= from) yield { seq, line: l }; yield { exit: { code: 0 } }; },
      ack(seq) { acks.push(seq); },
    };
    const seen = [];
    const result = await replayRecord({ source, normalize: l => [JSON.parse(l)], emit: (event, opts) => { seen.push([event.type, event.uuid ?? event.text ?? event.outcome, Boolean(opts?.replay)]); } });
    assert.deepEqual(seen, [
      ['text.delta', 'a', true], ['text.end', 'u1', true],
      ['text.delta', 'b', false], ['text.end', 'u2', false], ['turnResult', 'ok', false],
    ], '印（2）より前は流さず、ack（3）までは replay、重なった text.end（u2・u1）は 1 回');
    assert.deepEqual(acks, [4, 5, 6, 7, 8], '続きは流し終えた行ごとに ack（捨てた重なりの行も数える）');
    assert.deepEqual(result, { exit: { code: 0 }, replayed: 2, live: 5, acked: 8 });
    await assert.rejects(replayRecord({ source: { state: { marks: {} } }, normalize: () => [], emit: () => {} }), /no turn mark/);
    t.ok('再生の道: 印から ack までは replay・続きは ack・uuid で冪等・印が無ければ投げる', true);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-finished-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOfSession = id => (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === id);
  let a = null, b = null, ca = null, cb = null, holderPid = null;
  try {
    const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_RUNTIME_ROOT: root };
    const holder = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = holder.pid;
    holder.client.close();
    a = await startServer({ env, dataDir, timeoutMs: 30_000 });
    ca = await open({ port: a.port, token: a.token });
    const first = await ca.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:finished' }, { ms: WAIT_MS });
    assert.equal(first.outcome, 'ok');
    const sessionId = first.sessionId;
    const usageBefore = usageOfSession(sessionId).length;
    const mark = ca.mark();
    void ca.cmd('sendMessage', { sessionId, messageId: 'finished-after-stop', prompt: 'held:steps:' + JSON.stringify({ steps: [
      { tool: 'Read', input: { path: 'finish' }, result: 'finished while server is away', ms: 3000 },
      { text: 'final after restart' },
    ] }) }).catch(() => {});
    await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === sessionId, { ms: WAIT_MS, from: mark });
    const port = a.port, token = a.token;
    ca.close(); ca = null;
    await a.stop(); a = null;
    await sleep(3500); // 偽の CLI は A 不在中に終端まで記録する

    // The fake CLI finishes while A is gone. B starts normally and replays the holder record.
    b = await startServer({ env: { ...env, AGENT_HOST_PORT: String(port), AGENT_HOST_TOKEN: token }, dataDir, timeoutMs: 30_000 });
    cb = await open({ port, token });
    const end = await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { ms: WAIT_MS });
    await sleep(300);
    assert.equal(end.outcome, 'ok');
    assert.equal(cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === sessionId).length, 1);
    assert.equal(sessionMeta(sessionId).interrupted ?? null, null);
    assert.equal(sessionMeta(sessionId).turnStartedAt ?? null, null);
    assert.equal(usageOfSession(sessionId).length, usageBefore + 1);
    const loaded = await cb.cmd('loadSession', { sessionId });
    assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === 'final after restart').length, 1);
    assert.deepEqual(loaded.messages.flatMap(m => m.toolCalls ?? []).map(c => c.result.text), ['finished while server is away']);
    t.ok('A が通常停止した間に偽の CLI が完了したターンを B が記録から再生し、turnEnd・使用量・本文を 1 回だけ記録する', true);
  } finally {
    ca?.close(); cb?.close();
    await a?.stop(); await b?.stop();
    if (holderPid) {
      const holder = await connectHolder({ dataDir, root }).catch(() => null);
      holder?.shutdown();
      holder?.close();
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

}
