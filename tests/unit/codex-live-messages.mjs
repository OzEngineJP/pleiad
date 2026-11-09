import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rpc } from '../../core/backends/codex-rpc.mjs';
import { backend } from '../../core/backends/codex.mjs';
import { liveSnapshot } from '../../core/live-snapshot.mjs';

export const name = 'codex-live-messages';
export const title = 'Codexの確定した発言を作業の終了前に履歴へまとめる';

export default async function (t) {
  const previous = process.env.AGENT_HOST_CODEX_BIN;
  process.env.AGENT_HOST_CODEX_BIN = `node "${fileURLToPath(new URL('../lib/scripted-codex.mjs', import.meta.url))}"`;
  rpc.stop();
  const threadId = 'live-messages-test';
  const events = [];
  let run;
  const push = frames => rpc.request('test/push', { frames });
  try {
    await rpc.request('test/state');
    run = backend.runTurn({ prompt: 'work', sessionId: threadId, cwd: process.cwd(), mode: 'full', emit: e => events.push(e), askPermission: async () => ({ allow: true }) });
    const until = Date.now() + 10_000;
    let turnId;
    while (!turnId && Date.now() < until) {
      turnId = (await rpc.request('test/state')).turns.at(-1);
      if (!turnId) await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(turnId, 'turn started');
    const item = (method, item, turn = turnId) => ({ method, params: { threadId, turnId: turn, item } });
    const delta = (itemId, text, turn = turnId) => ({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn, itemId, delta: text } });
    const completed = (id, text, turn = turnId) => item('item/completed', { id, type: 'agentMessage', text }, turn);
    const frames = [];
    for (let i = 0; i < 120; i++) {
      frames.push(delta(`m${i}`, `step ${i}`), completed(`m${i}`, `step ${i}`));
      const tool = { id: `t${i}`, type: 'commandExecution', command: 'echo ok', commandActions: [], status: 'inProgress' };
      frames.push(item('item/started', tool), item('item/completed', { ...tool, status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }));
    }
    frames.push(
      item('item/started', { id: 'old-started', type: 'agentMessage', text: '' }, 'previous-turn'),
      completed('old-started', 'stale text', 'previous-turn'),
      completed('empty', ''),
      delta('active', 'still working'),
    );
    await push(frames);
    assert.deepEqual(events.filter(e => e.type === 'text.end').map(e => e.uuid), Array.from({ length: 120 }, (_, i) => `m${i}`));
    const snap = liveSnapshot({ messages: [], presents: [], events }, { backend: 'codex' });
    assert.equal(snap.messages.length, 120);
    assert.equal(snap.events.filter(e => e.type === 'tool.start').length, 0);
    assert.equal(events.some(e => e.text === 'stale text' || e.uuid === 'empty'), false);
    assert.equal(events.some(e => e.type === 'turnResult'), false);
    t.ok('作業が続く間も発言ごとに確定し数百件の出来事を再生に残さない', true);

    await push([completed('active', 'still working'), completed('active', 'still working'), delta('active', 'duplicate'), completed('old', 'old', 'previous-turn'), delta('old', 'old', 'previous-turn')]);
    assert.equal(events.filter(e => e.type === 'text.end' && e.uuid === 'active').length, 1);
    assert.equal(events.some(e => e.text === 'old' || e.text === 'duplicate'), false);
    t.ok('重複した完了や古い作業の通知で本文を増やさない', true);

    await push([completed('no-delta', 'complete only'), delta('partial', 'par'), completed('partial', 'partial')]);
    assert.equal(events.filter(e => e.type === 'text.delta').slice(-3).map(e => e.text).join('|'), 'complete only|par|tial');
    t.ok('完了だけ届く本文と最後の差分を落とさず復元する', true);

    const ends = events.filter(e => e.type === 'text.end').length;
    await push([{ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: 'completed' } } }]);
    await run;
    assert.equal(events.filter(e => e.type === 'text.end').length, ends);
    t.ok('作業の終了時に確定済み発言の終了を重ねない', true);
  } finally {
    rpc.stop();
    await run?.catch(() => {});
    if (previous === undefined) delete process.env.AGENT_HOST_CODEX_BIN;
    else process.env.AGENT_HOST_CODEX_BIN = previous;
  }
}
