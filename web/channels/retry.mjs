// 失敗した返事の［やり直す］（ADR 0358）。返事の場所に出る「✕ 失敗 · 理由」の下のボタン。流れ（DM）とスレッドが同じ部品を使う。
//   retrySource(posts, failed) … やり直しの元になる投稿（失敗の直前のあなたの投稿）。失敗が最後の投稿でなければ null（後ろに続きがあれば出さない）
//   retryFailed({ host, channel, threadId, failed, source }) … 元の投稿をもう一度 bot に届ける
//     スレッドの返信なら channels.resend（bot の会話をその手前へ巻き戻し、同じ本文を送り直す。ADR 0157 の 4.5）。
//     スレッドの根・DM の流れ・DM のスレッドは送り直せない（根は取り下げられない）ので、同じ本文を同じ場所へもう一度書く（宛先は失敗した bot）
const attachmentOf = (a) => ({ path: a.path, name: a.name, mime: a.mime ?? '' });
const clientIdOf = () => `rt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function retrySource(posts, failed) {
  const live = posts.filter((p) => !p.deletedAt);
  if (live.at(-1)?.id !== failed.id) return null;
  for (let i = live.length - 2; i >= 0; i--) if (live[i].author?.kind === 'human') return live[i];
  return null;
}

export async function retryFailed({ host, channel, threadId, failed, source }) {
  const body = { text: source.text ?? '', ...(source.attachments?.length ? { attachments: source.attachments.map(attachmentOf) } : {}) };
  if (!body.text) throw new Error('empty source');
  if (channel.kind !== 'dm' && source.threadId) {
    return host.invoke('channels.resend', { channelId: channel.id, postId: source.id, ...body, stopRunning: false, clientId: clientIdOf() });
  }
  const to = channel.kind !== 'dm' ? failed.turn?.botId : null;
  return host.invoke('channels.post', { channelId: channel.id, ...(threadId ? { threadId } : {}), ...body, ...(to ? { to } : {}), clientId: clientIdOf() });
}
