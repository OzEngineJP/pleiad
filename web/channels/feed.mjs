// チャンネルの流れ（W2。docs/design-system.md「チャンネルの流れ」、モック 02）。
// #channelsBody の中に section#chFeed.ch-feed を作る: 投稿の列（.ch-log）と入力欄（#chFeedComposer）。見出し（# 名前・目的・メンバー・⋯）は
// メインの頭（#channelsView > .top）に出す。読み書きはすべて channels.* の操作を invoke で呼ぶ（新しい WS コマンドは足さない）。
// 出来事 channelPost・channelReaction・channelThread・channelRead・channelsChanged・botsChanged で、その場で描き直す。
//
// 部品の口（web/channels/index.mjs）: show({ kind: 'channel', id, threadId? })・hide()・onEvent(ev)。
// 合成の投稿には、会話に記録の無い操作（リアクション・編集・削除）を出さない。
// スレッドを開く空間（W3）はここに無い。要約の行・「スレッドで返信」は host.openThread(channelId, threadId) を呼ぶだけ。
// DM の頭には ToDo の入口を置く（Chats と同じ部品 web/session-todo.mjs。DM の会話 = Bot.dmSessionId のもの。会話ができるまでは隠す）。
import { el, svgEl } from '../dom.mjs';
import { TODO_ICON } from '../session-todo.mjs';
import { botIcon } from './bot-icon.mjs';
import { t } from '../i18n.mjs';
import { fillPost, renderPost, dayText, authorInfo, wireAttachmentZoom } from './post.mjs';
import { retrySource, retryFailed } from './retry.mjs';
import { withReaction } from './reactions.mjs';
import { createChComposer } from './ch-composer.mjs';
import { feedDraftKey } from './ch-attach-model.mjs';
import { openChannelSettings } from './feed-settings.mjs';
import { openEmojiPicker } from '../emoji-picker.mjs';
import { headingButton } from './routine-entry.mjs';
import { shownBot } from './plain-bot.mjs';
import { notify } from '../file-actions.mjs';
import { postMenu, setupPostMenu, menuPoint } from './post-menu.mjs';

const PAGE = 50;
const NEAR_BOTTOM = 80;
const authorSame = (a, b) => JSON.stringify([a?.kind, a?.botId, a?.sessionId, a?.routineId]) === JSON.stringify([b?.kind, b?.botId, b?.sessionId, b?.routineId]);

export function createFeed(host) {
  const body = document.getElementById('channelsBody');
  const top = document.querySelector('#channelsView > .top');
  const title = document.getElementById('channelsPageTitle');
  if (!body || !top || !title) return {};

  const S = {
    id: null, channel: null, posts: [], index: new Map(), summaries: {}, threads: {}, nextBefore: null,
    bots: new Map(), loadingOlder: false, seq: 0, readSent: 0, ready: false,
    queue: [],   // 読み込んでいる間に届いた出来事。読み終えてから順に当てる（読んだ写しが古くても取りこぼさない）
  };
  const titleI18n = title.getAttribute('data-i18n');

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'ch-feed');
  root.id = 'chFeed';
  root.hidden = true;
  const log = el('div', 'ch-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', t('channels:feed.log'));
  log.tabIndex = 0;
  const jump = el('button', 'ch-jump', t('channels:feed.newer'));
  jump.type = 'button';
  jump.hidden = true;
  const composer = createChComposer({
    id: 'chFeedComposer',
    host,
    bucket: () => S.id,
    candidates: () => candidates(),
    blockBots: () => (S.channel?.kind === 'channel' ? allBots() : []),
    suggest: () => suggestion(),
    wakePreview: (text) => host.invoke('channels.wakePreview', { channelId: S.id, text }),
    backendLabel: (id) => host.state?.backends?.find((b) => b.id === id)?.label ?? id,
    onSend: (draft) => post(draft),
  });
  root.append(log, jump, composer.el);
  composer.bindDropZone(root);
  wireAttachmentZoom(log, host);
  body.append(root);
  const emptyNote = body.querySelector(':scope > .ch-empty');

  const postEls = new Map();
  const narrow = () => window.matchMedia?.('(max-width: 700px)').matches;

  // ---------------------------------------------------------------- 発言者・bot
  const ctx = {
    host,
    get bots() { return S.bots; },
    summaryOf: (id) => S.summaries[id],
    threadOf: (id) => S.threads[id],
    sessionTitle: (id) => host.state?.sessions?.find((s) => s.id === id)?.title ?? null,
    actions: {
      react: (p, emoji, on, had) => react(p, emoji, on, had),
      quick: (p, emoji) => react(p, emoji, true, false),
      openThread: (p) => openThread(p),
      menu: (p, x, y, anchor) => openMenu(p, x, y, anchor),
      // 失敗した返事の［やり直す］: bot の返事が流れに並ぶ DM だけ（チャンネルはスレッドの中。web/channels/retry.mjs）
      canRetry: (p) => S.channel?.kind === 'dm' && Boolean(retrySource(S.posts, p)),
      retry: (p) => retryTurn(p),
    },
  };

  async function loadBots() {
    try {
      const got = await host.invoke('bots.list');
      S.bots = new Map((got?.bots ?? []).map((b) => [b.id, shownBot(b, t)]));
    } catch { /* bot の操作がまだ無い・失敗しても投稿は読める。発言者は名前を持たない扱い */ }
  }

  const youInitial = () => [...t('channels:feed.you')][0] ?? '?';
  const memberBots = () => (S.channel?.kind === 'dm' ? [S.bots.get(S.channel.botId)] : (S.channel?.members ?? []).map((id) => S.bots.get(id))).filter(Boolean);

  // i18n-dynamic: channels:feed.botState.
  const stateHint = (bot) => (bot.state === 'working' || bot.state === 'waiting' ? t(`channels:feed.botState.${bot.state}`) : '');
  /** 入力欄の `@名前` を顔＋名前の塊にする bot（今ある bot の全員。メンバーでない bot も、書けば投稿のときメンバーに足される。ADR 0359） */
  const allBots = () => [...S.bots.values()].filter((b) => !b.plain);
  /** @ の一覧に出す bot: チャンネルのメンバー。メンバーがまだいないチャンネルは、いる bot の全員（選べば投稿のときメンバーに足される） */
  const callableBots = () => (memberBots().length ? memberBots() : allBots());
  function candidates() {
    if (!S.channel || S.channel.kind !== 'channel') return [];
    const bots = callableBots();
    return [
      // @here・@everyone は、呼べる bot が 1 体もいないとき（0 体で 0 人宛てになる）は出さない
      ...(memberBots().length ? [
        { id: 'here', name: 'here', icon: '@', glyph: true, hint: t('channels:feed.mention.here') },
        { id: 'everyone', name: 'everyone', icon: '@', glyph: true, hint: t('channels:feed.mention.everyone') },
      ] : []),
      ...bots.map((b) => ({ id: b.id, name: b.name, icon: b.icon, iconImage: b.iconImage, color: b.color, backend: b.backend ?? null, hint: stateHint(b) })),
      { id: 'you', name: t('channels:feed.you'), icon: youInitial(), you: true, hint: '' },
    ];
  }
  /** 誰も呼ばれていない文に勧める bot。この流れで最後に返事をした bot、無ければ先頭のメンバー（メンバーがいなければ先頭の bot） */
  function suggestion() {
    if (!S.channel || S.channel.kind !== 'channel') return null;
    const members = callableBots();
    const last = [...S.posts].reverse().find((p) => p.author?.kind === 'bot' && members.some((b) => b.id === p.author.botId));
    return (last && S.bots.get(last.author.botId)) || members[0] || null;
  }

  // ---------------------------------------------------------------- 見出し
  // DM の ToDo の入口（頭を描き直すたびに付け直すので、ボタンは 1 つだけ作る）。会話が無い間は部品が隠す
  const todoEntry = el('button', 'btn btn-icon ch-todo');
  todoEntry.type = 'button';
  todoEntry.hidden = true;
  todoEntry.setAttribute('aria-expanded', 'false');
  todoEntry.innerHTML = TODO_ICON;
  todoEntry.append(el('span', 'entry-dot'));
  todoEntry.querySelector('.entry-dot').hidden = true;
  const todo = host.todo?.({
    host: document.getElementById('channelsView'), header: top, entry: todoEntry, narrow: window.matchMedia('(max-width: 700px)'),
    // ToDo に結んだ作業は、DM の会話の作業として開く（スレッドの「作業」の入口と同じ範囲の指定）
    openTask: (taskId) => {
      const bot = S.bots.get(S.channel?.botId), sid = bot?.dmSessionId;
      todo.close();
      if (!sid) return;
      host.background?.open({ sessions: () => [sid], group: () => ({ name: bot.name, icon: () => botIcon(bot, 'th-band-icon') }) }, `t:${taskId}`);
    },
  });
  /** DM を見ている間だけ、その bot の DM の会話の ToDo を出す。ほかの面・チャンネルでは持たない */
  const syncTodo = () => todo?.load(S.channel?.kind === 'dm' && !root.hidden ? S.bots.get(S.channel.botId)?.dmSessionId ?? null : null);

  function paintPlaceholder() {
    const ch = S.channel;
    if (!ch) return;
    // 送信の近道は、指で使う画面には出さない（Chats の入力欄の案内と同じ決まり）
    const keys = window.matchMedia?.('(pointer:coarse)').matches ? '' : ` · ${t('channels:feed.composer.sendKeys')}`;
    if (ch.kind === 'dm') composer.setPlaceholder(t('channels:feed.composer.dm', { name: ch.name }) + keys);
    else if (narrow()) composer.setPlaceholder(t('channels:feed.composer.shortPlaceholder', { name: ch.name }));
    else composer.setPlaceholder(t('channels:feed.composer.placeholder', { name: ch.name }) + keys);
  }
  window.matchMedia?.('(max-width: 700px)').addEventListener?.('change', paintPlaceholder);

  function paintHead() {
    const ch = S.channel;
    top.classList.toggle('ch-top', Boolean(ch));
    for (const n of top.querySelectorAll('.ch-head-x')) n.remove();
    syncTodo();
    if (!ch) return;
    title.removeAttribute('data-i18n');
    const dmBot = ch.kind === 'dm' ? S.bots.get(ch.botId) : null;
    if (dmBot) {
      // DM の頭の名前は bot のページへの入口（bot のページは、作った後は DM から開く。ADR 0358）
      const nm = el('button', 'ch-nm');
      nm.type = 'button';
      nm.title = t('channels:side.openBot');
      nm.append(botIcon(dmBot, 'ch-hash'), document.createTextNode(ch.name));
      nm.onclick = () => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id: dmBot.id } }));
      title.replaceChildren(nm);
      title.removeAttribute('title');
    } else {
      title.replaceChildren(el('span', 'ch-hash', '#'), document.createTextNode(ch.name));
      title.title = ch.name;
    }
    const x = (node) => { node.classList.add('ch-head-x'); top.append(node); return node; };
    x(el('span', 'ch-purpose', ch.kind === 'dm' ? '' : ch.purpose ?? ''));
    const members = el('span', 'ch-members');
    const who = [t('channels:feed.you'), ...memberBots().map((b) => b.name)];
    members.title = t('channels:feed.members', { names: who.join(t('channels:feed.reactionSep')) });
    members.setAttribute('role', 'img');
    members.setAttribute('aria-label', members.title);
    members.append(el('span', 'ch-av you', youInitial()), ...memberBots().map((b) => botIcon(b, 'ch-av')));
    x(members);
    if (!ch.archivedAt) x(headingButton(host, ch));   // ［ルーティン n］（W5）
    if (dmBot) x(todoEntry);
    const more = el('button', 'btn btn-icon ch-more');
    more.type = 'button';
    more.title = t('channels:feed.settings.open');
    more.setAttribute('aria-label', t('channels:feed.settings.open'));
    const dots = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    for (const cy of [5, 12, 19]) dots.append(svgEl('circle', { cx: 12, cy, r: 1.4 }));   // 縦の 3 点（「…」の形）
    more.append(dots);
    more.onclick = () => openChannelSettings({ host, channel: ch, bots: [...S.bots.values()], returnTo: more });
    x(more);
    paintPlaceholder();
    composer.setDisabled(Boolean(ch.archivedAt), t('channels:feed.archived'));
  }

  function clearHead() {
    top.classList.remove('ch-top');
    for (const n of top.querySelectorAll('.ch-head-x')) n.remove();
    todo?.load(null);
    if (titleI18n) { title.setAttribute('data-i18n', titleI18n); title.textContent = t(titleI18n); title.removeAttribute('title'); }
  }

  // ---------------------------------------------------------------- 投稿の列
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
  const toBottom = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; };

  const dayEl = (at) => {
    const d = el('div', 'ch-day');
    d.append(el('span', null, dayText(at)));
    d.dataset.day = new Date(at).toDateString();
    return d;
  };

  function paintAll() {
    postEls.clear();
    const nodes = [];
    if (S.nextBefore) nodes.push(el('div', 'ch-older', t('channels:feed.older')));
    let day = null;
    for (const p of S.posts) {
      const key = new Date(p.at).toDateString();
      if (key !== day) { nodes.push(dayEl(p.at)); day = key; }
      const node = renderPost(p, ctx);
      postEls.set(p.id, node);
      nodes.push(node);
    }
    if (!S.posts.length) nodes.push(el('p', 'ch-empty-feed', S.channel?.kind === 'dm'
      ? t('channels:feed.emptyDm', { name: S.channel.name }) : t('channels:feed.emptyChannel')));
    log.replaceChildren(...nodes);
  }

  function repaint(id) {
    const p = S.index.get(id);
    const node = postEls.get(id);
    if (p && node) fillPost(node, p, ctx);
  }
  const repaintAll = () => { for (const id of postEls.keys()) repaint(id); };

  function addPost(p) {
    S.posts.push(p);
    S.index.set(p.id, p);
    log.querySelector('.ch-empty-feed')?.remove();
    const lastDay = [...log.querySelectorAll('.ch-day')].at(-1)?.dataset.day;
    if (lastDay !== new Date(p.at).toDateString()) log.append(dayEl(p.at));
    const node = renderPost(p, ctx);
    node.classList.add('enter');
    postEls.set(p.id, node);
    log.append(node);
    syncRetry();
  }
  /** ［やり直す］は最後の投稿のときだけ。後ろに投稿が増えたら外す */
  function syncRetry() {
    for (const b of log.querySelectorAll('.post-retry-row')) {
      const id = b.closest('.post')?.dataset.postId;
      const p = id ? S.index.get(id) : null;
      if (!p || !retrySource(S.posts, p)) b.remove();
    }
  }

  // ---------------------------------------------------------------- 読み込み
  const isHere = (channelId) => channelId === S.id;

  async function load(id) {
    const seq = ++S.seq;
    S.ready = false;
    S.queue = [];
    log.replaceChildren(el('p', 'ch-loading', t('channels:feed.loading')));
    try {
      const [channel, page] = await Promise.all([host.invoke('channels.get', { channelId: id }), host.invoke('channels.read', { channelId: id, limit: PAGE }), loadBots()]);
      if (seq !== S.seq) return;
      S.channel = channel;
      S.posts = page.posts ?? [];
      S.index = new Map(S.posts.map((p) => [p.id, p]));
      S.summaries = page.summaries ?? {};
      S.threads = Object.fromEntries((page.threads ?? []).map((th) => [th.threadId, th]));
      S.nextBefore = page.nextBefore ?? null;
      S.ready = true;
      paintHead();
      paintAll();
      for (const ev of S.queue.splice(0)) events[ev.type]?.(ev);
      toBottom();
      markRead();
    } catch (err) {
      if (seq !== S.seq) return;
      const box = el('div', 'ch-failed');
      const retry = el('button', 'btn', t('channels:feed.retry'));
      retry.type = 'button';
      retry.onclick = () => load(id);
      box.append(el('p', null, t('channels:feed.loadFailed', { error: err?.message ?? String(err) })), retry);
      log.replaceChildren(box);
    }
  }

  async function loadOlder() {
    if (S.loadingOlder || !S.nextBefore || !S.ready) return;
    S.loadingOlder = true;
    const seq = S.seq;
    try {
      const page = await host.invoke('channels.read', { channelId: S.id, before: S.nextBefore, limit: PAGE });
      if (seq !== S.seq) return;
      const older = (page.posts ?? []).filter((p) => !S.index.has(p.id));
      const before = log.scrollHeight - log.scrollTop;
      S.posts = [...older, ...S.posts];
      for (const p of older) S.index.set(p.id, p);
      Object.assign(S.summaries, page.summaries ?? {});
      for (const th of page.threads ?? []) S.threads[th.threadId] = th;
      S.nextBefore = page.nextBefore ?? null;
      paintAll();
      log.scrollTop = log.scrollHeight - before;
    } catch { /* 次のスクロールで取り直す */ } finally { S.loadingOlder = false; }
  }

  // ---------------------------------------------------------------- 既読
  let readTimer = null;
  const active = () => !root.hidden && document.body.classList.contains('channels') && document.visibilityState !== 'hidden';
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const last = S.posts.at(-1);
      const channelId = S.id;
      if (!channelId || !last || !active() || !nearBottom() || last.at <= S.readSent) return;
      S.readSent = last.at;
      host.invoke('channels.markRead', { channelId, at: last.at }).catch(() => { S.readSent = 0; });
    }, 300);
  }
  document.addEventListener('visibilitychange', () => { if (active()) markRead(); });

  // ---------------------------------------------------------------- 操作
  async function post({ text, attachments, confirmedWake }) {
    // 送り先は押した時のチャンネル。応答を待つ間に別のチャンネルへ移ったら、流れへの追加・スクロール・スレッドを開くのは移った先に持ち込まない
    const channelId = S.id, dm = S.channel?.kind === 'dm';
    const made = await host.invoke('channels.post', { channelId, text, ...(attachments?.length ? { attachments } : {}), ...(confirmedWake ? { confirmedWake } : {}) });
    // @ で選んだ bot がメンバーでなかったので足した（サーバーが投稿の前に足す）。足したことを知らせ、候補にも反映する
    if (made?.addedMembers?.length) {
      const names = made.addedMembers.map((id) => S.bots.get(id)?.name).filter(Boolean);
      if (names.length) notify(t('channels:feed.mention.added', { names: names.join('、') }));
      if (S.channel?.id === channelId) S.channel.members = [...new Set([...(S.channel.members ?? []), ...made.addedMembers])];
    }
    if (S.id !== channelId) return;   // 投稿は届いた知らせ（channels の更新）で、そのチャンネルを開いたときに載る
    if (made?.id && !S.index.has(made.id) && !made.threadId) addPost(made);
    toBottom();
    // bot を @ で呼んだ投稿は新しいスレッドの根になる。ここで書いた人にその返事が見えるよう、スレッドを開く（DM は流れがスレッドの代わり）
    if (made?.id && !dm && (made.mentions ?? []).some((m) => m !== 'you')) host.openThread?.(channelId, made.id);
  }

  /** 失敗した返事のやり直し（DM）。直前のあなたの投稿の本文を、もう一度 bot へ書く */
  async function retryTurn(p) {
    const source = retrySource(S.posts, p);
    const channelId = S.id;
    if (!source || S.channel?.kind !== 'dm') return;
    try {
      const made = await retryFailed({ host, channel: { id: channelId, kind: 'dm' }, threadId: null, failed: p, source });
      if (S.id === channelId && made?.id && !S.index.has(made.id) && !made.threadId) { addPost(made); toBottom(); }
    } catch (err) { composer.say(t('channels:thread.resend.failed', { error: err?.message ?? String(err) }), true); }
  }

  async function react(p, emoji, on, had) {
    if (on && had) return;
    const prev = p.reactions;
    p.reactions = withReaction(prev, emoji, on);
    repaint(p.id);
    try {
      const got = await host.invoke('channels.react', { channelId: p.channelId ?? S.id, postId: p.id, emoji, on });
      if (got?.reactions) { p.reactions = got.reactions; repaint(p.id); }
    } catch (err) {
      p.reactions = prev;
      repaint(p.id);
      composer.say(t('channels:feed.reactFailed', { error: err?.message ?? String(err) }));
    }
  }

  function openThread(p) {
    host.openThread?.(p.channelId ?? S.id, p.threadId ?? p.id);
  }

  function openMenu(p, x, y, anchor, alignRight = false) {
    const node = postEls.get(p.id);
    const { items, title } = postMenu({
      post: p, t, name: authorInfo(p.author, ctx).name, time: node?.querySelector('.post-when')?.textContent ?? '',
      copyButton: node?.querySelector('.post-tool.copy') ?? null,
      reply: () => openThread(p),
      react: () => {
        const at = node?.querySelector('.post-tool.add') ?? anchor;
        openEmojiPicker({ anchor: at, title: t('channels:feed.reactPicker'), onPick: (emoji) => react(p, emoji, true, (p.reactions?.[emoji] ?? []).some((a) => a.kind === 'human')) });
      },
    });
    host.showMenu(x, y, items, title, { alignRight });
  }

  // 右クリック・長押し（web/long-press.mjs が contextmenu を起こす）・Shift+F10・メニューキーで同じメニュー（Chats の発言と同じ口）
  setupPostMenu(log, (node, at) => {
    const p = S.index.get(node.dataset.postId);
    if (!p || p.deletedAt) return;
    const pt = menuPoint(node, at);
    openMenu(p, pt.x, pt.y, node, pt.alignRight);
  });
  jump.onclick = () => { toBottom(); markRead(); };
  log.addEventListener('scroll', () => {
    if (nearBottom()) { jump.hidden = true; markRead(); }
    if (log.scrollTop < 120) loadOlder();
  });

  // ---------------------------------------------------------------- 出来事
  function onReply(op, p) {
    const s = (S.summaries[p.threadId] ??= { count: 0, lastAt: 0, authors: [] });
    if (op === 'add') {
      if (s.count > 0 && p.at <= s.lastAt) return repaint(p.threadId);   // 読み込んだ写しがもう数えている（読み込み中に届いた分）
      s.count += 1;
      s.lastAt = Math.max(s.lastAt, p.at);
      if (s.authors.length < 5 && !s.authors.some((a) => authorSame(a, p.author))) s.authors.push(p.author);
    } else if (op === 'delete') {
      s.count = Math.max(0, s.count - 1);
    }
    repaint(p.threadId);
  }

  function onPost(ev) {
    const { op, post: p } = ev;
    if (!p) return;
    // 取り下げた返信（スレッドの送り直し）は、要約の行の件数から外す（数え直しは次の読み込み）
    if (op === 'withdraw') { if (p.threadId) onReply('delete', p); return; }
    if (p.threadId) return onReply(op, p);
    if (op === 'add') {
      if (S.index.has(p.id)) { Object.assign(S.index.get(p.id), p); repaint(p.id); return; }
      const stick = nearBottom();
      addPost(p);
      if (stick || p.author?.kind === 'human') toBottom();
      else jump.hidden = false;
      markRead();
      composer.refresh();
      return;
    }
    const cur = S.index.get(p.id);
    if (!cur) return;
    if (op === 'delete') Object.assign(cur, p, { deletedAt: p.deletedAt ?? Date.now() });
    else Object.assign(cur, p);
    repaint(p.id);
  }

  function onChannelsChanged(ev) {
    if (ev.removed === S.id) { S.id = null; S.channel = null; root.hidden = true; composer.setDraftKey(null); clearHead(); if (emptyNote) emptyNote.hidden = false; return; }
    if (ev.channel?.id === S.id) { S.channel = ev.channel; paintHead(); }
  }

  const events = {
    channelPost: (ev) => { if (isHere(ev.channelId)) { if (S.ready) onPost(ev); else S.queue.push(ev); } },
    channelReaction: (ev) => {
      if (!isHere(ev.channelId)) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const p = S.index.get(ev.postId);
      if (p) { p.reactions = ev.reactions ?? {}; repaint(p.id); }
    },
    channelThread: (ev) => {
      if (!isHere(ev.channelId) || !ev.thread) return;
      if (!S.ready) { S.queue.push(ev); return; }
      S.threads[ev.threadId] = ev.thread;
      repaint(ev.threadId);
    },
    channelRead: () => {},
    channelsChanged: (ev) => onChannelsChanged(ev),
    botsChanged: (ev) => {
      if (ev.removed) S.bots.delete(ev.removed);
      if (ev.bot) S.bots.set(ev.bot.id, shownBot(ev.bot, t));
      if (!S.id) return;
      paintHead();
      repaintAll();
      composer.refresh();
    },
    todosChanged: (ev) => todo?.onEvent(ev),
  };

  /** 流れの投稿へ送って、一瞬（1.2 秒）だけ強調する（通知の一覧から。動きを減らす設定では滑らせず、明滅もしない） */
  function revealPost(postId) {
    const node = postEls.get(postId);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1300);
  }

  return {
    show(view) {
      if (view?.kind !== 'channel' || !view.id) { this.hide(); return; }
      const same = S.id === view.id && S.ready;
      S.id = view.id;
      S.viewThread = view.threadId ?? null;
      composer.setDraftKey(feedDraftKey(view.id));   // 書きかけはチャンネルごと（別のチャンネルへ移っても残り、戻ると出る）
      root.hidden = false;
      if (emptyNote) emptyNote.hidden = true;
      if (!same) { S.channel = null; S.posts = []; S.index = new Map(); S.threads = {}; S.summaries = {}; S.readSent = 0; paintHead(); }
      else paintHead();   // 別の面（bot のページなど）へ移ると hide() が見出しを戻すので、同じチャンネルへ戻ったときも描き直す
      const done = same ? Promise.resolve().then(() => { toBottom(); markRead(); }) : load(view.id);
      done.then(() => {
        if (view.threadId) host.openThread?.(view.id, view.threadId, { postId: view.postId });
        else if (view.postId) revealPost(view.postId);   // スレッドを開かない（流れの投稿）。通知の一覧の飛び先
        composer.focus();
      });
    },
    hide() {
      root.hidden = true;
      clearHead();
      if (emptyNote) emptyNote.hidden = false;
    },
    onEvent(ev) { events[ev?.type]?.(ev); },
    sideTabChanged(tab) { if (tab === 'channels' && S.ready) markRead(); },
    /** 接続が戻った: ToDo を読み直す（その間の変更を取りこぼさないように） */
    reconnected() { todo?.reconnected(); },
  };
}
