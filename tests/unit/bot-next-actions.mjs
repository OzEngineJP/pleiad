import assert from 'node:assert/strict';
import { createBotNextActions, isNextActionTarget, nextActionRequest, NEXT_ACTION_TTL } from '../../core/bots/next-actions.mjs';

export const name = 'bot-next-actions';
export const title = 'Bot next actions';

export default async (t) => {
  const scope = { channelId: 'channel', threadId: 'thread' };
  const thread = { kind: 'channel' };
  const dm = { kind: 'dm', botId: 'a' };
  const request = { ...scope, id: 'request', text: '@a @b @c @d Review', author: { kind: 'human' }, mentions: ['a', 'b', 'c', 'd'] };
  const direct = { postId: request.id, nextAction: true };
  t.ok('explicit thread and DM requests are eligible', isNextActionTarget(request, thread, 'a')
    && isNextActionTarget({ ...request, mentions: [] }, dm, 'a')
    && nextActionRequest([direct], [request], thread, 'a') === request);
  t.ok('group, heard, inferred, bot-authored, and superseded requests are excluded',
    !isNextActionTarget({ ...request, mentions: ['a', 'everyone'] }, thread, 'a')
    && !isNextActionTarget({ ...request, author: { kind: 'bot' } }, thread, 'a')
    && !isNextActionTarget(request, dm, 'b')
    && !nextActionRequest([{ ...direct, heard: true }], [request], thread, 'a')
    && !nextActionRequest([{ postId: request.id }], [request], thread, 'a')
    && !nextActionRequest([direct], [request, { ...request, id: 'new' }], thread, 'a'));

  let now = 100;
  let latestHuman = request;
  const posts = [];
  const pending = new Map();
  const store = createBotNextActions({
    now: () => now,
    snapshot: (s) => s.channelId === scope.channelId && s.threadId === scope.threadId ? { latestHuman, posts } : null,
    generate: ({ reply }) => new Promise((resolve) => pending.set(reply.id, resolve)),
    changed() {},
  });
  const ids = async (s = scope) => (await store.read(s)).suggestions.map(({ id }) => id);
  const complete = (id, botId, overrides) => {
    const reply = { ...scope, id, text: 'Ready', state: 'done', author: { kind: 'bot', botId }, ...overrides };
    posts.push(reply);
    return store.complete({ request, reply });
  };
  const resolve = (id) => pending.get(id)('{"action":"Review changes","suggestion":"Please review the changes."}');

  await complete('pending', 'a', { state: 'approval' });
  await complete('failed', 'a', { state: 'failed' });
  await complete('empty', 'a', { text: ' ' });
  t.ok('non-final, failed, and blank replies never generate suggestions', pending.size === 0);
  const turns = [complete('a1', 'a'), complete('b1', 'b'), complete('c1', 'c'), complete('d1', 'd')];
  await Promise.resolve();
  for (const [i, id] of ['d1', 'c1', 'b1', 'a1'].entries()) {
    resolve(id);
    await turns[3 - i];
  }
  assert.deepEqual(await ids(), ['d1', 'c1', 'b1']);
  assert.deepEqual(await ids({ ...scope, threadId: 'other' }), []);
  t.ok('reply order determines the newest three even when generation finishes in reverse order', true);

  const replacement = complete('b2', 'b');
  await Promise.resolve();
  assert.deepEqual(await ids(), ['d1', 'c1']);
  resolve('b2');
  await replacement;
  assert.deepEqual(await ids(), ['b2', 'd1', 'c1']);
  assert.deepEqual(await ids(), ['b2', 'd1', 'c1']);
  assert.equal((await store.read(scope, 'd1')).consumed, true);
  await complete('d1', 'd');
  assert.deepEqual(await ids(), ['b2', 'c1']);
  t.ok('one per bot, reads preserve candidates, and adoption consumes just one reply', true);

  const delayed = complete('a2', 'a');
  await Promise.resolve();
  latestHuman = { ...request, id: 'new', text: 'New message' };
  store.observe({ type: 'channelPost', channelId: scope.channelId, op: 'add', post: latestHuman });
  resolve('a2');
  await delayed;
  assert.deepEqual(await ids(), []);
  t.ok('a new human post clears the scope and prevents late generation from reviving it', true);

  latestHuman = request;
  const expiring = complete('a3', 'a');
  await Promise.resolve();
  resolve('a3');
  await expiring;
  assert.deepEqual(await ids(), ['a3']);
  now += NEXT_ACTION_TTL;
  assert.deepEqual(await ids(), []);
  await store.complete({ request, reply: posts.at(-1), finishedAt: now - NEXT_ACTION_TTL });
  assert.deepEqual(await ids(), []);
  t.ok('candidates expire 24 hours after the reply and stale delivery does not revive them', true);
};
