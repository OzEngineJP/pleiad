// 旧経路で作られた内部の隠れた会話を、会話の操作（get・read・history・送信など）から外すための判定（Issue #180）。
// ネイティブの会話 id を直接指定された場合も、その id を持つ Pleiad の会話（nativeId・segments）まで辿って印を見る。
// 印は durable な meta.bot（learner / pulse + channelId・threadId が null）だけ。題や本文の接頭辞では判定しない。
// 記録そのものは消さない（一覧・検索・操作から返さないだけ）。
import * as store from './store.mjs';
import { isInternalConversationMeta } from './channels/types.mjs';
import { hostConversationOfNative } from './conversations.mjs';

/** id（Pleiad の会話 id でもネイティブ id でもよい）が確実な旧内部会話なら、その Pleiad の会話 id を返す。違えば null */
export async function internalConversationOwner(id) {
  if (!id) return null;
  const direct = await store.get(id).catch(() => null);
  if (isInternalConversationMeta(direct)) return id;
  const host = await hostConversationOfNative(id);
  if (!host || host === id) return null;
  const meta = await store.get(host).catch(() => null);
  return isInternalConversationMeta(meta) ? host : null;
}

/** 通常の会話の操作から返さない会話か（ネイティブ id の直接指定も同じ境界） */
export async function isInternalSessionId(id) {
  return Boolean(await internalConversationOwner(id));
}
