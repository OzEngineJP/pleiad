import assert from 'node:assert/strict';
import { createSessionLoads } from '../../web/session-stream.mjs';

export const name = 'session-replay';
export const title = '長い履歴の再生中も受信順序と会話切り替えを保つ';

const event = streamSeq => ({ sessionId: 'a', type: 'text.delta', streamSeq, text: String(streamSeq) });

export default async function (t) {
  const loads = createSessionLoads();
  const load = loads.begin('a');
  const seen = [];
  let clock = 0, yields = 0, paints = 0;
  loads.capture(event(50), 'a'); // Included in snapshot: never duplicate it.
  const ok = await loads.replay(load, { stream: { events: Array.from({ length: 150 }, (_, i) => event(i + 1)) }, streamCursor: 150 }, {
    apply: e => { seen.push(e.streamSeq); clock += 3; }, now: () => clock,
    paint: fn => { paints++; fn(); },
    yieldTask: async () => {
      yields++;
      if (yields === 1) assert.equal(loads.capture(event(151), 'a'), true);
      if (yields === 2) assert.equal(loads.capture(event(152), 'a'), true);
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, Array.from({ length: 152 }, (_, i) => i + 1));
  assert.ok(yields > 2 && paints === yields);
  assert.equal(loads.capture(event(153), 'a'), false);
  t.ok('小分けの再生中に届いた本文も応答の連番より後だけを一度ずつ順に描く', true);

  const old = loads.begin('a');
  let newLoad, cancelled = [];
  const restored = await loads.replay(old, { stream: { events: Array.from({ length: 200 }, (_, i) => event(i)) }, streamCursor: 199 }, {
    apply: e => cancelled.push(e.streamSeq),
    yieldTask: async () => { loads.cancel(old); newLoad = loads.begin('a'); },
  });
  assert.equal(restored, false);
  assert.ok(cancelled.length < 200);
  assert.equal(loads.capture(event(201), 'a'), true);
  assert.deepEqual(loads.finish(newLoad, { streamCursor: 200 }).map(e => e.streamSeq), [201]);
  t.ok('A→B→Aの古い描画を中止し新しい読み込みの受信を妨げない', true);

  const broken = loads.begin('a');
  await assert.rejects(loads.replay(broken, { stream: { events: [event(1)] }, streamCursor: 1 }, { apply: () => { throw new Error('render failed'); } }), /render failed/);
  assert.equal(loads.capture(event(2), 'a'), false);
  t.ok('復元で例外が起きても受信の取り置きを解放する', true);
}
