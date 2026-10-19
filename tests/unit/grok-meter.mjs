import assert from 'node:assert/strict';
import { createGrokMapper } from '../../core/backends/grok-normalize.mjs';

export const name = 'grok-meter';
export const title = 'Grok per-prompt token and cost accounting stays separate from context and provider quota';

export default async function test(t) {
  const events = [];
  const mapper = createGrokMapper('meter-fixture', e => events.push(e));
  const usage = (id, over = {}) => ({ sessionUpdate: 'turn_completed', prompt_id: id,
    usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 60, costUsdTicks: 1_000_000_000, ...over } });
  const amounts = () => events.filter(e => e.type === 'usage');
  mapper.accept(usage('old'));
  assert.equal(amounts().length, 0);
  mapper.beginTurn('hello');
  mapper.accept(usage('p1'));
  mapper.accept(usage('p1'));
  assert.equal(amounts().length, 1);
  assert.deepEqual(amounts()[0], { type: 'usage', sessionId: 'meter-fixture', inputTokens: 100,
    outputTokens: 20, cachedTokens: 60, costUsd: .1 });
  mapper.accept(usage('p2'));
  assert.equal(amounts().at(-1).inputTokens, 200);
  assert.equal(amounts().at(-1).costUsd, .2);
  mapper.accept({ sessionUpdate: 'usage_update', used: 80, size: 1000, cost: { amount: 20, currency: 'USD' } });
  assert.equal(amounts().at(-1).costUsd, .2);
  assert.equal(events.filter(e => e.type === 'contextWindow').length, 1);
  mapper.finish();
  mapper.accept(usage('replay'));
  assert.equal(amounts().length, 2);
  t.ok('live prompts aggregate once; replay and session-wide costs do not inflate turn usage', true);

  for (const over of [{ costIsPartial: true }, { usageIsIncomplete: true }, { costUsdTicks: null }, { costUsdTicks: -1 }]) {
    mapper.beginTurn('next');
    mapper.accept(usage('valid'));
    mapper.accept(usage('unknown', over));
    assert.equal(amounts().at(-1).inputTokens, over.usageIsIncomplete ? null : 200);
    assert.equal(amounts().at(-1).costUsd, null);
    mapper.accept(usage('third'));
    assert.equal(amounts().at(-1).costUsd, null);
  }
  mapper.beginTurn('reset');
  mapper.accept(usage('p1', { inputTokens: null, cachedReadTokens: undefined, costUsdTicks: 0 }));
  assert.equal(amounts().at(-1).inputTokens, null);
  assert.equal(amounts().at(-1).cachedTokens, null);
  assert.equal(amounts().at(-1).costUsd, 0);
  mapper.beginTurn('fresh');
  mapper.accept(usage('p1'));
  assert.equal(amounts().at(-1).inputTokens, 100);
  assert.equal(amounts().at(-1).costUsd, .1);
  mapper.accept({ sessionUpdate: 'turn_completed', prompt_id: 'missing' });
  assert.equal(amounts().at(-1).inputTokens, null);
  assert.equal(amounts().at(-1).costUsd, null);
  t.ok('unknown and incomplete bills are never zero; beginTurn resets totals and duplicate ids', true);
}
