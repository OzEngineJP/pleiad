import assert from 'node:assert/strict';
import { createDevinMapper } from '../../core/backends/devin-normalize.mjs';

export const name = 'devin-meter';
export const title = 'Devin request token accounting: duplicate context refresh, replay, cache and partial data';

export default async function test(t) {
  const events = [];
  const mapper = createDevinMapper('meter', event => events.push(event));
  const sample = (input = 1000, output = 100, cached = 800, extra = {}) => ({ sessionUpdate: 'usage_update', used: 120000, size: 262000,
    _meta: { 'cognition.ai/inputTokens': input, 'cognition.ai/outputTokens': output, 'cognition.ai/cachedReadTokens': cached, ...extra } });
  const amounts = () => events.filter(event => event.type === 'usage' && 'inputTokens' in event);
  const latest = () => {
    const { inputTokens, outputTokens, cachedTokens } = amounts().at(-1);
    return [inputTokens, outputTokens, cachedTokens];
  };
  mapper.accept(sample());
  assert.equal(amounts().length, 0);
  mapper.beginTurn('hello');
  mapper.accept({ sessionUpdate: 'usage_update', used: 120000, size: 262000 });
  assert.equal(amounts().length, 0);
  mapper.accept(sample());
  mapper.accept(sample());
  mapper.accept(sample(1000, 100, 800, { 'cognition.ai/subagent_context': {} }));
  assert.equal(amounts().length, 1);
  assert.deepEqual(latest(), [1000, 100, 800]);
  mapper.accept(sample(400, 10, 100));
  assert.deepEqual(latest(), [1400, 110, 900]);
  mapper.finish();
  mapper.accept(sample(99999));
  assert.deepEqual(latest(), [1400, 110, 900]);
  t.ok('request counters add once, include cache already and stay separate from context and replay', true);

  mapper.beginTurn('next');
  mapper.accept(sample());
  mapper.accept({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'next response' } });
  mapper.accept(sample(1000, 100, 800, { 'cognition.ai/subagent_context': {} }));
  assert.deepEqual(latest(), [1000, 100, 800]);
  mapper.accept(sample());
  assert.deepEqual(latest(), [2000, 200, 1600]);
  t.ok('separate requests with equal counts survive a response boundary; context refresh still does not count', true);

  for (const invalid of [undefined, null, -1, '1', Infinity, 1.5]) {
    mapper.beginTurn('partial');
    const partial = sample(1000, 100, invalid);
    if (invalid === undefined) delete partial._meta['cognition.ai/cachedReadTokens'];
    mapper.accept(partial);
    assert.deepEqual(latest(), [1000, 100, null]);
    mapper.accept(sample(400, 10, 100));
    assert.deepEqual(latest(), [1400, 110, null]);
  }
  mapper.beginTurn('bad input');
  mapper.accept(sample(null, 100, 800));
  assert.deepEqual(latest(), [null, 100, 800]);
  mapper.beginTurn('zero');
  mapper.accept(sample(0, 0, 0));
  assert.deepEqual(latest(), [0, 0, 0]);
  t.ok('missing or invalid counters stay unknown; explicit zero and turn reset remain valid', true);
}
