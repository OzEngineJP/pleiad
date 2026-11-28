import { createSuggestionJobs, parseActionSuggestion } from '../prompt-suggestions.mjs';

export const NEXT_ACTION_TTL = 24 * 60 * 60 * 1000;
const keyOf = ({ channelId, threadId }) => JSON.stringify([channelId, threadId ?? null]);
const live = (post) => post && !post.deletedAt && !post.withdrawnAt;
const sameBody = (a, b) => live(b) && a.text === b.text && a.editedAt === b.editedAt;

export function isNextActionTarget(post, channel, botId) {
  if (!live(post) || post.author?.kind !== 'human' || !post.text?.trim()) return false;
  const mentions = post.mentions ?? [];
  if (mentions.includes('here') || mentions.includes('everyone')) return false;
  return channel.kind === 'dm' ? channel.botId === botId : mentions.includes(botId)
    || (post.to === botId && mentions.every((name) => name === 'you'));
}

export function nextActionRequest(items, posts, channel, botId) {
  const post = posts.findLast((p) => p.author?.kind === 'human');
  const item = items.findLast((i) => !i.heard && !i.reaction && !i.inner);
  return item?.nextAction && item.postId === post?.id && isNextActionTarget(post, channel, botId) ? post : null;
}

export function createBotNextActions({ snapshot, generate, changed, onError, now = Date.now }) {
  const rooms = new Map();
  const seen = new Map();
  const last = new Map();
  let sequence = 0;
  const jobs = createSuggestionJobs({
    parse: parseActionSuggestion, onError,
    onSuggestion(entry, value) {
      if (rooms.get(keyOf(entry))?.get(entry.botId) !== entry) return;
      entry.value = value;
      const ready = ordered(entry);
      for (const old of ready.slice(3)) remove(old);
      changed(entry);
    },
  });

  const entries = (scope) => [...(rooms.get(keyOf(scope))?.values() ?? [])];
  const ordered = (scope) => entries(scope).filter((e) => e.value && e.expiresAt > now())
    .sort((a, b) => b.finishedAt - a.finishedAt || b.postOrder - a.postOrder || b.sequence - a.sequence);

  function remove(entry) {
    const key = keyOf(entry);
    const room = rooms.get(key);
    if (room?.get(entry.botId) !== entry) return;
    clearTimeout(entry.timer);
    jobs.cancel(entry);
    room.delete(entry.botId);
    if (!room.size) rooms.delete(key);
  }

  function discard(entry) {
    remove(entry);
    changed(entry);
  }

  function valid(entry, context) {
    return context && sameBody(entry.request, context.latestHuman)
      && entry.request.id === context.latestHuman.id
      && sameBody(entry.reply, context.posts.find((p) => p.id === entry.reply.id && p.state === 'done'));
  }

  async function complete({ request, reply, turn, finishedAt = now() }) {
    if (!request || !live(reply) || reply.state !== 'done' || !reply.text?.trim() || reply.author?.kind !== 'bot') return;
    const expiresAt = finishedAt + NEXT_ACTION_TTL;
    const remaining = expiresAt - now();
    if (remaining <= 0 || seen.has(reply.id)) return;
    const id = reply.id;
    const expiry = setTimeout(() => seen.delete(id), remaining);
    expiry.unref?.();
    seen.set(reply.id, expiry);
    const entry = {
      channelId: reply.channelId, threadId: reply.threadId, botId: reply.author.botId,
      request, reply, finishedAt, expiresAt, sequence: ++sequence,
    };
    const key = keyOf(entry);
    const botKey = JSON.stringify([key, entry.botId]);
    if (last.get(botKey)?.finishedAt > finishedAt) return;
    const markerValue = { finishedAt };
    const marker = setTimeout(() => {
      if (last.get(botKey) === markerValue) last.delete(botKey);
    }, remaining);
    marker.unref?.();
    last.set(botKey, markerValue);
    const context = await snapshot(entry);
    if (!valid(entry, context) || last.get(botKey) !== markerValue) return;
    entry.postOrder = context.posts.findIndex((p) => p.id === reply.id);
    const previous = rooms.get(key)?.get(entry.botId);
    if (previous) remove(previous);
    if (!rooms.has(key)) rooms.set(key, new Map());
    rooms.get(key).set(entry.botId, entry);
    changed(entry);
    entry.timer = setTimeout(() => {
      if (rooms.get(key)?.get(entry.botId) === entry) discard(entry);
    }, Math.max(0, entry.expiresAt - now()));
    entry.timer.unref?.();
    await jobs.start(entry, async (signal) => {
      const raw = await generate({ request, reply, turn, signal });
      return valid(entry, await snapshot(entry)) ? raw : null;
    });
    if (!entry.value) remove(entry);
  }

  function observe(event) {
    if (!['channelPost', 'channelsChanged', 'botsChanged'].includes(event.type)) return;
    for (const room of rooms.values()) {
      for (const entry of room.values()) {
        const post = event.post;
        if (event.type === 'channelPost' && post && event.channelId === entry.channelId) {
          if (event.op === 'add' && post.author?.kind === 'human'
              && (post.threadId ?? null) === entry.threadId && post.id !== entry.request.id) discard(entry);
          else if ((post.id === entry.request.id && !sameBody(entry.request, post))
              || (post.id === entry.reply.id && (!sameBody(entry.reply, post) || post.state !== 'done'))
              || (post.id === entry.threadId && !live(post))) discard(entry);
        } else if (event.type === 'botsChanged' && event.removed === entry.botId) discard(entry);
        else if (event.type === 'channelsChanged'
            && (event.removed === entry.channelId || (event.channel?.id === entry.channelId && event.channel.archivedAt))) discard(entry);
      }
    }
  }

  async function read(scope, consumeId) {
    const candidates = ordered(scope);
    if (!candidates.length) return { suggestions: [], consumed: false };
    const context = await snapshot(scope);
    let consumed = false;
    for (const entry of candidates) {
      if (rooms.get(keyOf(entry))?.get(entry.botId) !== entry) continue;
      if (entry.expiresAt <= now() || !valid(entry, context)) discard(entry);
      else if (entry.reply.id === consumeId) { discard(entry); consumed = true; }
    }
    const suggestions = ordered(scope).filter((entry) => valid(entry, context)).map((entry) => ({
      id: entry.reply.id, botId: entry.botId, expiresAt: entry.expiresAt, ...entry.value,
    }));
    return { suggestions, consumed };
  }

  return { complete, observe, read };
}
