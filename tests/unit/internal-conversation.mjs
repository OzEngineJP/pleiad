// 旧内部会話の分類（Issue #180）: durable 印（bot.kind が learner/pulse・channel/thread が無い）だけで判定し、
// 題や本文の接頭辞では判定しない。ネイティブ id の直接指定も host の会話の印まで辿る。
// 一覧（pageSessions）・検索（passesFilters）からは includeDelegated と独立に外れる。
import assert from 'node:assert/strict';
import { backend as fake } from '../../core/backends/fake.mjs';
import { createConversation, conversation, deleteConversation, hostConversationOfNative } from '../../core/conversations.mjs';
import * as store from '../../core/store.mjs';
import { isInternalConversationMeta } from '../../core/channels/types.mjs';
import { internalConversationOwner, isInternalSessionId } from '../../core/internal-conversation.mjs';
import { pageSessions } from '../../core/ops/sessions.mjs';
import { passesFilters } from '../../core/session-search.mjs';

export const name = 'internal-conversation';
export const title = '旧内部会話の分類: durable 印だけ・接頭辞を使わない・ネイティブ id も同じ境界・一覧と検索から常に外す';

const hiddenMarks = [
  { botId: 'b_learner', kind: 'learner', channelId: null, threadId: null },
  { botId: 'b_owl12345', kind: 'pulse', channelId: null, threadId: null },
];

export default async function (t) {
  const made = [];
  try {
    // ---- 真偽表（純粋な関数）
    const meta = (bot) => ({ bot });
    assert.equal(isInternalConversationMeta(meta(hiddenMarks[0])), true);
    assert.equal(isInternalConversationMeta(meta(hiddenMarks[1])), true);
    assert.equal(isInternalConversationMeta(meta({ botId: 'b_1', kind: 'learner', channelId: 'c', threadId: null })), false, 'チャンネルに紐づく learner は隠さない');
    assert.equal(isInternalConversationMeta(meta({ botId: 'b_1', kind: 'pulse', channelId: null, threadId: 't' })), false, 'スレッドに紐づく pulse は隠さない');
    for (const kind of ['thread', 'dm', 'routine']) {
      assert.equal(isInternalConversationMeta(meta({ botId: 'b_1', kind, channelId: 'c', threadId: null })), false, `${kind} は通常の bot 会話`);
    }
    assert.equal(isInternalConversationMeta(null), false);
    assert.equal(isInternalConversationMeta({}), false);
    t.ok('hidden の種類でも channel/thread を持つ通常の bot 会話は隠さない', true);

    // ---- ネイティブ id（今の nativeId と前の segments）から host の印を引く
    const internalId = await createConversation(fake, { title: '記憶の整理', cwd: '/tmp' });
    made.push(internalId);
    Object.assign(await conversation(internalId), { nativeId: 'native-now', segments: [{ backend: 'fake', nativeId: 'native-old' }] });
    await store.setSessionData(internalId, 'bot', hiddenMarks[0], { durable: true });
    assert.equal(await hostConversationOfNative('native-now'), internalId);
    assert.equal(await hostConversationOfNative('native-old'), internalId);
    assert.equal(await internalConversationOwner(internalId), internalId);
    assert.equal(await internalConversationOwner('native-now'), internalId);
    assert.equal(await internalConversationOwner('native-old'), internalId);
    assert.equal(await isInternalSessionId('native-now'), true);
    assert.equal(await isInternalSessionId('native-nothing'), false);

    // ---- 通常の bot 会話・ユーザーの会話・委譲の子は隠さない
    const normalId = await createConversation(fake, { title: '通常の会話', cwd: '/tmp' });
    made.push(normalId);
    Object.assign(await conversation(normalId), { nativeId: 'native-normal' });
    await store.setSessionData(normalId, 'bot', { botId: 'b_1', kind: 'dm', channelId: 'c', threadId: null }, { durable: true });
    assert.equal(await isInternalSessionId(normalId), false);
    assert.equal(await isInternalSessionId('native-normal'), false);
    const userId = await createConversation(fake, { title: '利用者の会話', cwd: '/tmp' });
    made.push(userId);
    assert.equal(await isInternalSessionId(userId), false);

    // ---- 題・本文の接頭辞では判定しない（印の無い行は残す）
    const prefixed = { id: 'prefixed', title: '<pleiad-memory-learn> 覚えて', text: '<pleiad-pulse>', backend: 'fake', bot: null, delegation: null };
    assert.equal(isInternalConversationMeta(prefixed), false);
    assert.equal(passesFilters(prefixed, { includeDelegated: true, since: null, until: null }), true, '接頭辞だけの行は検索から外さない');

    // ---- 一覧・検索: includeDelegated と独立に常に外す
    const rows = [
      { id: 'internal', title: '心拍', status: null, cwd: '/tmp', backend: 'fake', lastModified: 10, delegation: null, bot: hiddenMarks[1] },
      { id: 'bot', title: '通常', status: null, cwd: '/tmp', backend: 'fake', lastModified: 9, delegation: null, bot: { botId: 'b_1', kind: 'dm', channelId: 'c', threadId: null } },
      { id: 'delegated', title: '子', status: null, cwd: '/tmp', backend: 'fake', lastModified: 8, delegation: { parentSessionId: 'p' }, bot: null },
    ];
    const listed = pageSessions(rows, { includeDelegated: true, limit: 10 });
    assert.deepEqual(listed.sessions.map((row) => row.id).sort(), ['bot', 'delegated']);
    assert.equal(passesFilters(rows[0], { includeDelegated: true, since: null, until: null }), false);
    assert.equal(passesFilters(rows[1], { includeDelegated: true, since: null, until: null }), true);

    await deleteConversation(internalId);
    await deleteConversation(normalId);
    await deleteConversation(userId);
    t.ok('ネイティブ id の直接指定でも host の印を辿り、一覧・検索からは常に外す', true);
  } finally {
    for (const id of made) await deleteConversation(id).catch(() => {});
  }
}
