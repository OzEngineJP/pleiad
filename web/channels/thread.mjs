// スレッド（W3。docs/design-system.md「スレッドの空間モデル」、ADR 0111）。
// 実体は bot の作業の会話なので、Chats の会話と同じ画面の形にする: 見出し（入口は目次・git・内蔵ブラウザー）・投稿の列・入力欄。
//   根の投稿 → 返信。bot の返事は進捗のチェックリストを同じ投稿の編集で更新（S4 が畳んだターンの投稿）、道具は「道具 n 件」の折りたたみ
//   （Chats と同じ Bundle）、可視化は投稿の中にインライン、ファイルのリンク・HTML・ブラウザーは右パネル（host.filePreview）。
//   作業中は返事の場所に「考えている · 12 秒」の 1 行、止めるのは入力欄の送信の横の ■（channels.stopThread。Chats と同じ形）。承認待ちはスレッドの中に承認のカード（Chats と同じ部品。どちらで押しても同じ resolvePermission）。
// 板の並べ方・滑らせ方は deck.mjs（流れとの 2 枚）。この部品は #chThread の中身だけを持つ。
// 部品の口（web/channels/index.mjs）: openThread(channelId, threadId)・show(view)・hide()・onEvent(ev)・contextForPanel(anchor)。
import { el } from '../dom.mjs';
import { botIcon } from './bot-icon.mjs';
import { t } from '../i18n.mjs';
import { savedEvent } from '../saved-text.mjs';
import { renderPost, fillPost, authorInfo, wireAttachmentZoom, whenText, vanishedTurnPost } from './post.mjs';
import { withReaction } from './reactions.mjs';
import { createThreadComposer } from './thread-composer.mjs';
import { shownBot } from './plain-bot.mjs';
import { createWorkPlaces } from './work-places.mjs';
import { notify } from '../file-actions.mjs';
import { threadDraftKey } from './ch-attach-model.mjs';
import { openEmojiPicker } from '../emoji-picker.mjs';
import { postMenu, setupPostMenu, menuPoint } from './post-menu.mjs';
import { openSourceDialog } from '../message-actions.mjs';
import { makeBranchRow } from '../branch-view.mjs';
import { penGlyph } from '../resend-band.mjs';
import { paintUnsent } from '../outbox.mjs';
import { createDeck } from './deck.mjs';
import { createThreadHead } from './thread-head.mjs';
import { conversationIcon } from '../conversation-usage.mjs';
import { isComposingKey, isMac } from '../keyboard.mjs';
import { createConversationNav } from '../conversation-nav-view.mjs';
import { createConversationRail } from '../conversation-rail.mjs';
import { createConversationToc } from '../conversation-toc.mjs';
import { createBackgroundChip } from '../background-chip.mjs';
import { createToolSource, turnWindows, logInWindow, signatureOf, toolNodes } from './thread-tools.mjs';
import { retrySource, retryFailed } from './retry.mjs';
import { createThreadStream } from './thread-stream.mjs';

const PAGE = 50;
const NEAR_BOTTOM = 80;
const LIVE = new Set(['working', 'waiting']);
/** 書きかけの流し（ADR 0367）に使う出来事。replay のときは使わない */
const STREAM_TYPES = new Set(['text.delta', 'text.end', 'tool.start', 'turnEnd']);

/** スレッドの題: 根の投稿の最初の行（先頭の @ の呼びかけは外す） */
export function titleOf(root) {
  const line = String(root?.text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const plain = line.replace(/\s+/g, ' ').trim();
  const stripped = plain.replace(/^(?:@\S+\s*)+/, '').trim();
  return (stripped || plain).slice(0, 120);
}

export function createThread(host) {
  const body = document.getElementById('channelsBody');
  const view = document.getElementById('channelsView');
  const feedRoot = document.getElementById('chFeed');
  const top = view?.querySelector(':scope > .top') ?? feedRoot?.querySelector(':scope > .top');
  if (!body || !view || !feedRoot || !top) return {};

  const S = {
    channelId: null, threadId: null, channel: null, posts: [], index: new Map(), thread: null, bots: new Map(),
    nextBefore: null, ready: false, seq: 0, queue: [], loadingOlder: false,
    pending: [],   // bot へ届く前のあなたの投稿（channels.pending。送信待ちの行）
  };
  const toolCache = new Map();  // postId -> { sig, wrap, bundles }（道具の行。同じなら作り直さず、開いた状態を保つ）
  const cards = new Map();      // 承認の id -> .mw
  let windows = new Map();
  const tools = createToolSource({ cmd: (command, args) => host.cmd(command, args) });
  const places = createWorkPlaces({ host });   // bot が実際に動く場所（会話がまだ無いときの返信先の作業場所。core の pickCwd と同じ判定）

  // ---------------------------------------------------------------- DOM
  const root = el('section', 'ch-thread');
  root.id = 'chThread';
  root.setAttribute('aria-labelledby', 'chThreadTitle');
  const log = el('div', 'th-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', t('channels:thread.log'));
  log.tabIndex = 0;
  const older = el('div', 'ch-older', t('channels:feed.older'));
  older.hidden = true;
  // 投稿の列は Chats と同じ列の入れ物（.col-lane。style.css の「列」）で真ん中に置く（可視化の［広げる］の基準もこの箱）
  const rootSlot = el('div', 'th-root col-lane');
  const rdiv = el('div', 'th-rdiv col-lane');
  const replies = el('div', 'th-replies col-lane');
  const perms = el('div', 'th-perms bg-thread col-lane');   // 承認のカード（Chats の .mw.card をそのまま入れる。--gut は CSS で投稿の本文の位置に合わせる）
  log.append(older, rootSlot, rdiv, replies, perms);
  // 会話の移動（最新へ・地図・目次と検索・Alt+↑↓・End）の部品が重なる、投稿の列の入れ物（Chats の #logFrame と同じ役）
  const frame = el('div', 'log-frame th-frame');
  frame.append(log);
  // サブエージェントの入口（入力欄のすぐ上の右端。Chats の「バックグラウンド」と同じチップ。bot が委譲した子がいなければ出さない）。
  // 押すと bot ごとに子を並べる一覧が開く（Chats と同じ部品。docs/design-system.md「バックグラウンド」）
  // 入力欄は Chats の会話と同じ部品（web/channels/thread-composer.mjs。ADR 0157）。宛先は本文の @ だけ（ADR 0362）
  let voiceView = null;
  const composer = createThreadComposer({
    host,
    bucket: () => S.channelId,
    candidates: () => candidates(),
    blockBots: () => (S.channel?.kind === 'channel' ? allBots() : []),
    suggest: () => suggestion(),
    wakePreview: (text) => host.invoke('channels.wakePreview', { channelId: S.channelId, threadId: S.threadId, text }),
    backendLabel: (id) => host.state?.backends?.find((b) => b.id === id)?.label ?? id,
    onSend: (draft) => send(draft),
    onStop: () => stopThread(),
    receiver: () => receiver(),
    session: () => receiverSession(),
    schedules: () => (host.state?.schedules ?? []).filter((r) => r.kind === 'post' && r.channelId === S.channelId && r.threadId === S.threadId).sort((a, b) => a.at - b.at),
    pending: () => S.pending.map((x) => ({ id: x.postId, text: S.index.get(x.postId)?.text ?? '' })).filter((x) => x.text),
    withdrawPending: (postId) => host.invoke('channels.withdrawPending', { channelId: S.channelId, postId }).then(() => refreshPending()),
    edit: { target: (id) => resendTarget(id), send: (ctx) => resendSend(ctx), branch: (ctx) => resendBranch(ctx), decorate: (id, on, tail) => resendDecorate(id, on, tail), locate: (id) => resendLocate(id) },
    compact: (sessionId) => host.invoke('sessions.compact', { sessionId }),
  });
  // 目次のボタンは会話の目次（web/conversation-toc.mjs）が自分で受ける
  const head = createThreadHead({ host, onClose: () => close(), onBack: () => close(), onToc: () => {},
    // 題を変える（根の投稿は変えない。空にすると根の投稿の最初の行に戻る）
    onRename: (title) => host.invoke('channels.setThreadTitle', { channelId: S.channelId, threadId: S.threadId, title }).catch((err) => composer.say(t('channels:thread.renameFailed', { error: err?.message ?? String(err) }), true)),
    // ✦ 題の候補: このスレッドで最後に動いた bot の会話から（Chats の suggestTitle と同じ。bot の会話がまだ無ければ出さない）
    suggestTitle: async () => {
      const sessionId = activeSession();
      if (!sessionId) { composer.say(t('channels:thread.titleNoSession')); return null; }
      try { return (await host.cmd('suggestTitle', { sessionId }))?.title ?? null; }
      catch (err) { composer.say(t('session.titleSuggestFailed', { error: err?.message ?? String(err) }), true); return null; }
    } });
  const { strip: subs, entry: subsButton } = composer.work;
  const subsChip = createBackgroundChip(subsButton);
  root.append(head.el, frame, composer.el);
  composer.bindDropZone(root);
  wireAttachmentZoom(log, host);
  const deck = createDeck({ view, body, feed: feedRoot, thread: root, top });
  // 通話モードの差し込み口（スレッド。承認済み 2026-10-06）。契約は web/voice/index.mjs の冒頭。入力欄・見出し・面へは、ここの 1 か所だけで繋ぐ
  voiceView = host.voice?.mount({
    id: 'thread',
    canStart: () => Boolean(S.threadId && !S.channel?.archivedAt && (!threadReadOnly() || receiver())),
    header: head.el.querySelector('.th-entries'), headerBefore: head.todoButton,
    composer: composer.voiceSlot(),
    main: root, log, overlay: root, replyScope: () => log,
    tail: {
      place: (node) => replies.after(node), rows: replies, persistMarks: true,
      isRow: (node) => node.classList.contains('post'), rowKey: (node) => node.dataset.postId ?? null,
      markHost: (row) => row.querySelector('.post-head .post-name'),
      createRow: () => {
        const row = el('div', 'post mine');
        const av = el('span', 'post-av you', youInitial());
        av.setAttribute('aria-hidden', 'true');
        const main = el('div', 'post-main');
        const hd = el('div', 'post-head');
        hd.append(el('b', 'post-name', t('channels:feed.you')), el('time', 'post-when', whenText(Date.now())));
        const text = el('div', 'post-body');
        main.append(hd, text);
        row.append(av, main);
        return { el: row, body: text };
      },
    },
    target: () => (S.threadId ? { kind: 'thread', channelId: S.channelId, threadId: S.threadId } : null),
    // 送り先は発言を確定した時のスレッド（target）。キューを待つ間に別のスレッドへ移っていたら、話していたスレッドへ直に投稿する
    send: (text, target) => (!target || (target.channelId === S.channelId && target.threadId === S.threadId)
      ? send({ text, attachments: [] })
      : host.invoke('channels.post', { channelId: target.channelId, threadId: target.threadId, text })),
    follow: () => { if (nearBottom()) log.scrollTop = log.scrollHeight; },
  });

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
  const toBottom = () => { log.scrollTop = log.scrollHeight; markRead(); };

  // ---------------------------------------------------------------- 会話の移動（Chats と同じ部品。docs/design-system.md「会話の移動」）
  // 発言の並びは、投稿の列のあなたの投稿（根と返信）。吹き出しは .post-body（あなたの投稿は dataset.raw に原文）
  const narrow = matchMedia('(max-width: 700px)');
  const nav = createConversationNav({
    frame, log, thread: log, narrow, scrollToEnd: () => toBottom(), isRunning: () => liveBots().length > 0,
    rows: {
      users: (box) => [...box.querySelectorAll('.post[data-author="human"]:not(.deleted)')],
      rowOf: (user) => user,
      bodyOf: (user) => user.querySelector('.post-body'),
      whenOf: (user) => user.querySelector('.post-when')?.textContent ?? '',
      subtree: true,
    },
  });
  createConversationRail({ frame, log, thread: log, nav, narrow });
  narrow.addEventListener('change', () => paintPlaceholder());
  const toc = createConversationToc({
    thread: log, log, nav, preview: host.filePreview, narrow, button: head.tocButton,
    // 項目: あなたの投稿 = 発言、bot・AI の投稿 = 返答、投稿の中のツールのカード = ツール
    entriesOf: ({ turns, kinds, turnInfo }) => {
      const turnOf = new Map(turns.map((x, i) => [x.row, i]));
      const out = [];
      let turn = -1;
      for (const node of log.querySelectorAll('.post:not(.deleted)')) {
        const body = node.querySelector('.post-body');
        const at = node.querySelector('.post-when')?.textContent ?? '';
        if (turnOf.has(node)) {
          turn = turnOf.get(node);
          out.push({ kind: 'user', turn, row: node, el: node, bodies: [body].filter(Boolean), at: turnInfo(turns[turn]).at, pending: kinds[turn] === 'pending' });
          continue;
        }
        if (body?.textContent.trim()) out.push({ kind: 'answer', turn, row: node, el: node, bodies: [body], at });
        for (const card of node.querySelectorAll('.tc')) if (!card.parentElement.closest('.tc')) out.push({ kind: 'tool', turn, row: node, el: card, at });
      }
      return out;
    },
  });
  // ToDo: Chats と同じ部品（web/session-todo.mjs）。スレッドの bot の会話（activeSession）のものを出す。client.mjs が host.todo で組み立てる。
  // 狭い画面は頭に ToDo の入口を置かず、⋮ のメニューの先頭に「ToDo · n/m 完了」を出す（未確認の変更は ⋮ の点で知らせる）
  const todo = host.todo?.({
    host: root, header: head.el, entry: head.todoButton, narrow, moreButton: head.moreButton, onChange: () => paintMore(),
    openTask: (taskId) => { todo.close(); host.background?.open(scope, `t:${taskId}`); },
  });
  const syncTodo = () => todo?.load(S.threadId && S.ready ? activeSession() : null);

  // 狭い画面だけの ⋮（広い画面は CSS が隠す）。先頭が ToDo、次が通話（使えるとき）、その次が題の候補（✦ と同じ）
  function paintMore() {
    const button = head.moreButton;
    const changed = Boolean(todo?.hasUnseen());
    const dot = button.querySelector('.entry-dot');
    if (changed && !dot) { const mark = el('span', 'entry-dot'); mark.setAttribute('aria-hidden', 'true'); button.append(mark); }
    else if (!changed) dot?.remove();
    button.setAttribute('aria-label', changed ? `${t('session.more')} · ${t('todo.unseen')}` : t('session.more'));
  }
  head.moreButton.onclick = () => {
    const call = head.el.querySelector('.vc-call');
    const items = [];
    if (todo?.sessionId()) {
      items.push({ label: todo.label(), icon: conversationIcon('todo'), hint: todo.hasUnseen() ? () => el('span', 'hint todo-menu-dot') : null, onClick: () => todo.open() });
    }
    if (call && !call.hidden) {
      const icon = call.querySelector('.vc-ci svg')?.cloneNode(true);
      icon?.setAttribute('class', 'conversation-menu-icon');
      items.push({ label: call.getAttribute('aria-label') ?? '', icon, onClick: () => call.click() });
    }
    if (head.canSuggest()) {
      const glyph = el('span', 'conversation-menu-icon menu-glyph', '✦');
      glyph.setAttribute('aria-hidden', 'true');
      items.push({ label: t('session.titleWand'), icon: glyph, onClick: () => head.suggest() });
    }
    const r = head.moreButton.getBoundingClientRect();
    host.showMenu(r.right, r.bottom + 4, items, null, { alignRight: true });
  };

  // Ctrl+F（macOS は ⌘F）: スレッドを見ている間は、虫眼鏡と同じ面（目次と検索）を開いて検索欄へ。Chats の会話の Ctrl+F より先に受ける
  document.addEventListener('keydown', (event) => {
    const mac = isMac();
    if (event.defaultPrevented || isComposingKey(event) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f'
      || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
    if (!watching() || !S.threadId || !S.ready || document.body.classList.contains('settings') || document.querySelector('dialog[open]')) return;
    const field = event.target;
    // 入力欄（このスレッドの返信欄）と目次の検索欄では奪う。ほかの入力要素の中では奪わない
    if ((field.matches?.('input,textarea') || field.isContentEditable) && !(root.contains(field) && !field.closest?.('.th-title-input')) && !field.closest?.('.toc')) return;
    event.preventDefault();
    toc.focusSearch();
  }, true);

  // スレッドを見ていて末尾にいる間は、そのスレッドの既読を返信まで進める。
  let readTimer = null, readSent = 0;
  const watching = () => document.body.classList.contains('channels') && deck.state !== 'feed' && document.visibilityState !== 'hidden';
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const last = S.posts.at(-1);
      if (!S.threadId || !S.ready || !last?.threadId || !watching() || !nearBottom() || last.at <= readSent) return;
      const { channelId, threadId, seq } = S;
      readSent = last.at;
      host.invoke('channels.markRead', { channelId, threadId, at: last.at }).catch(() => {
        if (S.seq === seq && readSent === last.at) readSent = 0;
      });
    }, 300);
  }
  document.addEventListener('visibilitychange', () => { syncWatch(); if (watching()) markRead(); });

  // ---------------------------------------------------------------- 書きかけの流し（ADR 0367）
  // 開いているスレッドの bot の返事の書きかけを、保存より先に流してもらう。サーバーの接続の「スレッド」の枠（watchSession の slot: 'thread'）。
  // 見ている間だけ宣言し、閉じた・別のスレッドを開いた・Chats へ移った・隠れたら外す。宣言の返事に、いま書いている途中の分の写しが入っている
  let watched = '';     // 宣言しているスレッド（`channelId\nthreadId`）。空は宣言なし
  let watchSeq = 0;
  function syncWatch({ force = false } = {}) {
    const want = S.channelId && S.threadId && watching() ? `${S.channelId}\n${S.threadId}` : '';
    if (!force && want === watched) return;
    const seq = ++watchSeq;
    watched = want;
    streams.clear();
    if (!want) { host.cmd('watchSession', { slot: 'thread', sessionId: '' }).catch(() => {}); return; }
    host.cmd('watchSession', { slot: 'thread', channelId: S.channelId, threadId: S.threadId })
      .then((got) => { if (seq === watchSeq && watched === want) streams.snapshot(got?.threadStream); })
      .catch(() => { /* 流れが無くても、投稿は保存のたびに更新される */ });
  }
  /** 書きかけの流しの相手: その会話の最後の投稿（作業中のもの）と、その前に確定した同じ会話の投稿の本文（古い順） */
  function streamChain(sessionId) {
    let at = -1;
    for (let i = S.posts.length - 1; i >= 0; i--) {
      const p = S.posts[i];
      if (p.turn?.sessionId === sessionId && !p.deletedAt) { at = i; break; }
    }
    const post = S.posts[at];
    if (!post || !LIVE.has(post.state)) return null;
    const before = [];
    for (let i = at - 1; i >= 0 && before.length < 6; i--) {
      const p = S.posts[i];
      if (p.turn?.sessionId === sessionId && !p.deletedAt) before.unshift(p.text ?? '');
    }
    return { post, before };
  }
  const streams = createThreadStream({
    chainFor: (sessionId) => (S.ready ? streamChain(sessionId) : null),
    repaint: (id) => repaint(id),
    nearBottom: () => nearBottom(),
    follow: () => { log.scrollTop = log.scrollHeight; },
  });

  // ---------------------------------------------------------------- 発言者・bot
  const ctx = {
    host,
    get bots() { return S.bots; },
    summaryOf: () => null,
    threadOf: () => null,
    sessionTitle: (id) => host.state?.sessions?.find((s) => s.id === id)?.title ?? null,
    streaming: (p) => streams.streaming(p),   // 書きかけが出ている投稿（状態の行を「書いている」にする。web/channels/post.mjs）
    actions: {
      react: (p, emoji, on, had) => react(p, emoji, on, had),
      quick: (p, emoji) => react(p, emoji, true, false),
      openThread: () => composer.focus(),   // スレッドの中の「返信」は入力欄へ
      menu: (p, x, y, anchor) => openMenu(p, x, y, anchor),
      // 失敗した返事の［やり直す］（最後の投稿のときだけ。web/channels/retry.mjs）
      canRetry: (p) => !threadReadOnly() && Boolean(retrySource(S.posts, p)),
      retry: (p) => retryTurn(p),
    },
  };

  async function loadBots() {
    try {
      const got = await host.invoke('bots.list');
      S.bots = new Map((got?.bots ?? []).map((b) => [b.id, shownBot(b, t)]));
    } catch { /* 定義が引けなくても投稿は出る */ }
  }
  const youInitial = () => [...t('channels:feed.you')][0] ?? '?';
  const memberBots = () => (S.channel?.members ?? []).map((id) => S.bots.get(id)).filter(Boolean);
  /** いま作業中（作業中・あなた待ち）の bot。ターンの投稿の状態から引く（同じ bot は 1 つ） */
  const liveBots = () => {
    const ids = [];
    for (const p of S.posts) if (p.turn?.botId && LIVE.has(p.state) && !p.deletedAt && !ids.includes(p.turn.botId)) ids.push(p.turn.botId);
    return ids.map((id) => S.bots.get(id) ?? { id, name: t('channels:feed.unknownBot'), icon: '' });
  };
  function threadReadOnly() {
    return Boolean(S.thread?.deletedBot && !Object.keys(S.thread.sessions ?? {}).some(id => S.bots.has(id)));
  }
  /** 入力欄の `@名前` を顔＋名前の塊にする bot（今ある bot の全員。メンバーでない bot も、書けば投稿のときメンバーに足される。ADR 0362） */
  const allBots = () => [...S.bots.values()].filter((b) => !b.plain);
  /** @ の一覧に出す bot: チャンネルのメンバー。メンバーがまだいないチャンネルは、いる bot の全員（選べば投稿のときメンバーに足される） */
  const callableBots = () => (memberBots().length || S.channel?.kind !== 'channel' ? memberBots() : allBots());
  function candidates() {
    const live = new Set(liveBots().map((b) => b.id));
    return [
      // @here・@everyone は、メンバーの bot がいないとき（呼ぶ相手が 0 体）は出さない
      ...(memberBots().length ? [
        { id: 'here', name: 'here', icon: '@', glyph: true, hint: t('channels:feed.mention.here') },
        { id: 'everyone', name: 'everyone', icon: '@', glyph: true, hint: t('channels:feed.mention.everyone') },
      ] : []),
      ...callableBots().map((b) => ({ id: b.id, name: b.name, icon: b.icon, iconImage: b.iconImage, color: b.color, backend: b.backend ?? null,
        // i18n-dynamic: channels:feed.botState.
        hint: live.has(b.id) ? t(`channels:feed.botState.${S.posts.findLast((p) => p.turn?.botId === b.id && LIVE.has(p.state))?.state ?? 'working'}`) : '' })),
      { id: 'you', name: t('channels:feed.you'), icon: youInitial(), you: true, hint: '' },
    ];
  }
  /** 誰も @ していない文に勧める bot。作業中の bot が 1 体ならその bot に届くので勧めない。それ以外はこのスレッドで最後に返事をした bot */
  function suggestion() {
    if (liveBots().length === 1) return null;
    const last = S.posts.findLast((p) => p.author?.kind === 'bot' && S.bots.has(p.author.botId));
    return (last && S.bots.get(last.author.botId)) || callableBots()[0] || null;
  }
  function paintPlaceholder() {
    voiceView?.refresh();
    // 狭い画面は短く「スレッドに返信」だけ
    if (window.matchMedia?.('(max-width: 700px)').matches) { composer.setPlaceholder(t('channels:thread.composer.placeholder')); composer.refresh(); return; }
    const live = liveBots();
    // 送信の近道は、指で使う画面には出さない（Chats の入力欄と同じ）
    const keys = window.matchMedia?.('(pointer:coarse)').matches ? '' : ` · ${t('channels:feed.composer.sendKeys')}`;
    // 受ける bot に追従する: その bot が作業中なら「作業中でも届きます」、そうでなければ「〜に届きます」
    const to = receiver();
    const text = to && live.some((b) => b.id === to.id) ? t('channels:thread.composer.working', { name: to.name })
      : to ? t('channels:thread.composer.to', { name: to.name })
        : live.length === 1 ? t('channels:thread.composer.working', { name: live[0].name }) : t('channels:thread.composer.placeholder');
    composer.setPlaceholder(text + keys);
    composer.refresh();
  }

  /**
   * @ の無い返信を受ける bot（サーバーの宛先の決まりと同じ。ADR 0117・0362）。DM はその bot、スレッドは作業中の 1 体 →
   * 最後に答えた bot → 会話を持つ bot。いなければ null（チャンネルでまだ bot が答えていないスレッドは、誰も起きない）
   */
  function receiver() {
    if (S.channel?.kind === 'dm') return S.bots.get(S.channel.botId) ?? memberBots()[0] ?? null;
    const live = liveBots().filter((b) => S.bots.has(b.id));
    if (live.length === 1) return S.bots.get(live[0].id);
    const lastSpoke = S.posts.findLast((p) => p.author?.kind === 'bot' && S.bots.has(p.author.botId))?.author.botId;
    const id = lastSpoke ?? Object.keys(S.thread?.sessions ?? {}).find((b) => S.bots.has(b));
    return id ? S.bots.get(id) : null;
  }
  /**
   * 受ける bot の、このスレッドの会話（「/」の候補・`!`・/compact）。会話がまだ無ければ作業場所だけ。
   * 会話がまだ無いときの作業場所は、サーバーが会話を作るときの決め方（pickCwd）と同じ判定で推す: チャンネルの cwd は bot のフォルダーの中のときだけ使う
   */
  function receiverSession() {
    const bot = receiver();
    if (!bot) return null;
    const sessionId = S.thread?.sessions?.[bot.id] ?? null;
    const row = sessionId ? host.state?.sessions?.find((x) => x.id === sessionId) : null;
    if (!row?.cwd) places.warm([bot]);
    return { sessionId, cwd: row?.cwd || places.of(bot, S.channel?.cwd).cwd };
  }

  /** そのスレッドの bot の会話（右パネルの作業場所の基準・git・ブラウザー）。最後に動いた bot の会話 */
  function activeSession() {
    const turn = S.posts.findLast((p) => p.turn?.sessionId && !p.deletedAt);
    if (turn) return turn.turn.sessionId;
    return Object.values(S.thread?.sessions ?? {}).at(-1) ?? null;
  }
  const sessionIds = () => new Set([...Object.values(S.thread?.sessions ?? {}), ...S.posts.map((p) => p.turn?.sessionId).filter(Boolean)]);

  // ---------------------------------------------------------------- サブエージェント（bot が委譲した子）
  /** この会話を持つ bot（スレッドの bot の会話 → bot。一覧は bot ごとに分ける） */
  function botOfSession(sessionId) {
    for (const [botId, sid] of Object.entries(S.thread?.sessions ?? {})) if (sid === sessionId) return S.bots.get(botId) ?? { id: botId };
    const p = S.posts.find((x) => x.turn?.sessionId === sessionId && x.turn.botId);
    return p ? (S.bots.get(p.turn.botId) ?? { id: p.turn.botId }) : null;
  }
  /** client.mjs の一覧・カードに渡す範囲: このスレッドの bot の会話から委譲した子 */
  const scope = {
    sessions: () => sessionIds(),
    group: (sessionId) => {
      const bot = botOfSession(sessionId);
      return { name: bot?.name ?? t('channels:feed.unknownBot'), icon: () => botIcon(bot, 'th-band-icon') };
    },
  };
  host.background?.mount(log, scope);
  subsButton.onclick = () => host.background?.open(scope);
  function paintSubs() {
    const items = S.threadId && host.background ? host.background.items(scope) : [];
    subsChip.update(items, S.threadId);
    subs.hidden = !items.length;
  }
  host.background?.subscribe(paintSubs);
  /** このスレッドの bot の会話が変わった（委譲の子の行を読む範囲）。変わっていなければ何もしない */
  const syncSubs = () => { host.background?.watch(S.threadId && S.ready ? [...sessionIds()] : []); paintSubs(); };
  /** 作業ログの委譲カードを、Chats と同じ形（状態の印・経過・子の会話への矢印）に仕上げさせる。カードが DOM に入ってから 1 回にまとめる */
  let delegatesQueued = false;
  function paintDelegates() {
    if (delegatesQueued || !host.background) return;
    delegatesQueued = true;
    requestAnimationFrame(() => { delegatesQueued = false; host.background.paint(); });
  }

  // ---------------------------------------------------------------- 見出し・帯
  function paintHead() {
    // 人が付けた題（channels.setThreadTitle）があればそれ、無ければ根の投稿の最初の行
    head.setTitle({ channel: S.channel?.home ? t('channels:side.home') : S.channel?.name ?? '', home: Boolean(S.channel?.home), title: S.thread?.title || titleOf(S.posts[0]) });
    head.setSession(activeSession());
    syncTodo();
  }

  // 送信の横の ■: bot が作業中（承認待ちを含む）の間だけ出す。押すとこのスレッドの bot の会話をすべて止める（channels.stopThread）
  let stopBusy = false;
  function paintStop() {
    const th = S.thread;
    const working = th?.state === 'working' || th?.state === 'waiting' || liveBots().length > 0;
    composer.setStop({ show: working || stopBusy, disabled: stopBusy });
  }
  async function stopThread() {
    if (stopBusy || !S.threadId) return;
    stopBusy = true;
    paintStop();
    try {
      await host.invoke('channels.stopThread', { channelId: S.channelId, threadId: S.threadId });
    } catch (err) {
      composer.say(t('channels:thread.stopFailed', { error: err?.message ?? String(err) }));
    } finally {
      stopBusy = false;
      paintStop();
    }
  }

  // ---------------------------------------------------------------- 投稿 1 件
  const sysNode = (p) => {
    const n = el('div', 'th-sys');
    n.dataset.postId = p.id;
    // 止めた知らせ（state: stopped）は「■ 中断しました · 17:34」。そのほかの Pleiad の知らせは「– 本文」
    if (p.state === 'stopped') n.append(el('span', 'th-sys-sq'), el('span', null, p.text ?? ''), el('span', 'th-sys-when', `· ${whenText(p.at)}`));
    else n.append(el('span', 'th-sys-mark', '–'), el('span', null, p.text ?? ''));
    return n;
  };

  /**
   * ターンの投稿の作業ログ（ADR 0117）: 返事の下に畳んで残す、独り言・終わりの報告の文と道具の行。会話の履歴から（まだ読んでいなければ無し）。
   * 開いている・閉じているは、作り直しても同じ要素を使って保つ
   */
  function logSlot(p) {
    const w = windows.get(p.id);
    const messages = w ? tools.messagesOf(w.sessionId) : null;
    if (!messages) return toolCache.get(p.id)?.wrap ?? null;
    const items = logInWindow(messages, w, p.text);
    if (!items.length) return null;
    const running = p.state === 'working';   // 承認待ちの呼び出しは走っていない（弧を出さない）
    const lastCalls = items.findLast((i) => i.kind === 'calls');
    const count = items.reduce((n, i) => n + (i.kind === 'calls' ? i.calls.length : 0), 0);
    const sig = `${items.map((i) => (i.kind === 'text' ? `t${i.text.length}` : signatureOf(i.calls))).join('/')}${running ? '+' : ''}`;
    let c = toolCache.get(p.id);
    if (!c || c.sig !== sig) {
      const wrap = c?.wrap ?? el('details', 'th-worklog');
      const head = el('summary', 'th-worklog-head', count ? t('channels:thread.workLogTools', { count }) : t('channels:thread.workLog'));
      const box = el('div', 'th-worklog-body');
      const bundles = [];
      for (const item of items) {
        if (item.kind === 'text') {
          const text = el('div', 'th-log-text');
          text.innerHTML = host.renderAssistantMarkdown(item.text);
          box.append(text);
          continue;
        }
        const backend = S.bots.get(p.turn?.botId)?.backend ?? null;
        const built = toolNodes(item.calls, { running: running && item === lastCalls,
          subagentTools: host.state?.backends?.find((b) => b.id === backend)?.subagentTools,
          link: (card, c) => host.background?.link(card, c.input, c.result, { scope, sessionId: w.sessionId, backend }) });
        const group = el('div', 'th-tools');
        group.append(...built.nodes);
        box.append(group);
        bundles.push(...built.bundles);
      }
      // 開いていた行・まとまりは、作り直しても同じ範囲を開けておく
      bundles.forEach((b, i) => { const old = c?.bundles[i]; if (old) b.restoreView(old.viewState()); });
      wrap.replaceChildren(head, box);
      c = { sig, wrap, bundles };
      toolCache.set(p.id, c);
    }
    return c.wrap;
  }

  /** fillPost の後に足すもの: 提示（可視化はインライン）と、その下に畳んだ作業ログ。会話そのものを開く入口は投稿の ⋯（openMenu） */
  function decorate(node, p) {
    const main = node.querySelector(':scope > .post-main');
    if (!main || p.deletedAt) return;
    const bodyEl = main.querySelector('.post-body');
    let below = bodyEl;
    // bot へ届く前のあなたの投稿: 本文の下の 1 行（送信中 ＋［編集］［取り消す］。Chats の送信待ちの吹き出しと同じ。入力欄の上のカードは無い）
    if (S.pending.some((x) => x.postId === p.id)) {
      const line = el('div', 'outbox-status');
      paintUnsent(line, 'queued', { act: { edit: () => composer.pendingAction(p.id, 'edit'), cancel: () => composer.pendingAction(p.id, 'cancel') } });
      bodyEl.after(line);
      below = line;
    }
    if (p.presents?.length) {
      const box = el('div', 'post-presents');
      for (const ev of p.presents) {
        try { box.append(host.renderPresent(savedEvent(ev))); } catch { /* 描けない提示は飛ばす */ }
      }
      if (box.childElementCount) { bodyEl.after(box); below = box; }
    }
    // 確定前の書きかけは本文のすぐ下（提示・作業ログより上。本文の続きとして読める位置）
    if (p.turn?.sessionId) streams.attach(bodyEl, p);
    if (p.turn?.sessionId) {
      const slot = logSlot(p);
      if (slot) below.after(slot);
    }
  }

  const postEls = new Map();
  function nodeFor(p) {
    if (p.author?.kind === 'system') return sysNode(p);
    const node = renderPost(p, ctx);
    decorate(node, p);
    return node;
  }
  function repaint(id) {
    const p = S.index.get(id);
    const old = postEls.get(id);
    if (!p || !old) return;
    if (p.author?.kind === 'system') { const n = sysNode(p); old.replaceWith(n); postEls.set(id, n); return; }
    // 通知の一覧・目次から着いた直後の強調（flash）は、bot の返事の更新で描き直されても消さない（クラスが書き換わっても同じ動きが続く）
    const flashing = old.classList.contains('flash');
    fillPost(old, p, ctx);
    decorate(old, p);
    if (flashing) old.classList.add('flash');
    paintDelegates();
  }
  const repaintTurns = (sessionId) => { for (const p of S.posts) if (p.turn && (!sessionId || p.turn.sessionId === sessionId)) repaint(p.id); };

  function paintRdiv() {
    const n = Math.max(0, S.posts.length - 1);
    rdiv.textContent = n ? t('channels:thread.replies', { count: n }) : t('channels:thread.noReplies');
  }

  function paintAll() {
    postEls.clear();
    const [first, ...rest] = S.posts;
    const rootNode = first ? nodeFor(first) : null;
    if (first) postEls.set(first.id, rootNode);
    rootSlot.replaceChildren(...(rootNode ? [rootNode] : []));
    replies.replaceChildren(...rest.map((p) => { const n = nodeFor(p); postEls.set(p.id, n); return n; }));
    older.hidden = !S.nextBefore;
    paintRdiv();
    paintDelegates();
  }

  function addPost(p) {
    S.posts.push(p);
    S.index.set(p.id, p);
    const node = nodeFor(p);
    node.classList?.add('enter');
    postEls.set(p.id, node);
    replies.append(node);
    paintRdiv();
    paintDelegates();
  }

  // ---------------------------------------------------------------- 読み込み
  function reset() {
    Object.assign(S, { channel: null, posts: [], index: new Map(), thread: null, nextBefore: null, ready: false, queue: [], loadingOlder: false, pending: [] });
    postEls.clear(); toolCache.clear(); cards.clear(); tools.forget(); streams.forget();
    perms.replaceChildren();
    rootSlot.replaceChildren(); replies.replaceChildren(); rdiv.textContent = '';
    stopBusy = false; composer.setStop();
    nav.reset(); toc.reset();
    todo?.load(null);
    readSent = 0;
    host.background?.watch([]);
    paintSubs();
  }

  async function load() {
    const seq = ++S.seq;
    const { channelId, threadId } = S;
    S.ready = false;
    S.queue = [];
    rootSlot.replaceChildren(el('p', 'ch-loading', t('channels:thread.loading')));
    try {
      const [page, channel] = await Promise.all([
        host.invoke('channels.read', { channelId, threadId, limit: PAGE }),
        host.invoke('channels.get', { channelId }).catch(() => null),
        loadBots(),
      ]);
      if (seq !== S.seq) return;
      S.channel = channel;
      // 黙って終えたターンの消えた投稿は並べない（「削除された投稿」の行を残さない。post.mjs の vanishedTurnPost）
      S.posts = (page.posts ?? []).filter((p) => p.id === threadId || !vanishedTurnPost(p));
      S.index = new Map(S.posts.map((p) => [p.id, p]));
      S.thread = (page.threads ?? []).find((th) => th.threadId === threadId) ?? null;
      S.nextBefore = page.nextBefore ?? null;
      S.ready = true;
      windows = turnWindows(S.posts);
      paintHead();
      paintAll();
      paintStop();
      paintPlaceholder();
      syncSubs();
      for (const ev of S.queue.splice(0)) events[ev.type]?.(ev);
      paintPendingPerms();
      refreshPending();
      toBottom();
      for (const sid of new Set([...windows.values()].map((w) => w.sessionId))) tools.refresh(sid, { force: true });
      composer.setDisabled(Boolean((threadReadOnly() && !receiver()) || S.channel?.archivedAt), threadReadOnly() ? t('ui:deletedBotReadOnly') : t('channels:feed.archived'));
      composer.refresh();
      composer.syncEdit();
      markSelected();
      if (seq === S.seq) composer.focus();
      requestAnimationFrame(flushReveal);
      paintBranches();
    } catch (err) {
      if (seq !== S.seq) return;
      const box = el('div', 'ch-failed');
      const retry = el('button', 'btn', t('channels:feed.retry'));
      retry.type = 'button';
      retry.onclick = () => load();
      box.append(el('p', null, t('channels:thread.loadFailed', { error: err?.message ?? String(err) })), retry);
      rootSlot.replaceChildren(box);
    }
  }

  async function loadOlder() {
    if (S.loadingOlder || !S.nextBefore || !S.ready) return;
    S.loadingOlder = true;
    const seq = S.seq;
    try {
      const page = await host.invoke('channels.read', { channelId: S.channelId, threadId: S.threadId, before: S.nextBefore, limit: PAGE });
      if (seq !== S.seq) return;
      const olderPosts = (page.posts ?? []).filter((p) => !S.index.has(p.id) && !vanishedTurnPost(p));
      const before = log.scrollHeight - log.scrollTop;
      S.posts = [S.posts[0], ...olderPosts, ...S.posts.slice(1)];
      for (const p of olderPosts) S.index.set(p.id, p);
      S.nextBefore = page.nextBefore ?? null;
      windows = turnWindows(S.posts);
      paintAll();
      log.scrollTop = log.scrollHeight - before;
    } catch { /* 次のスクロールで取り直す */ } finally { S.loadingOlder = false; }
  }

  // ---------------------------------------------------------------- 操作
  async function send({ text, attachments, confirmedWake, clientId, at }) {
    if (threadReadOnly()) { composer.edit.end({ restore: true }); throw new Error(t('ui:deletedBotReadOnly')); }
    // 送り先は押した時のスレッド。途中の待ち（会話を作る・投稿の応答）の間に別のスレッドへ移っても、送り先と載せる先は変えない
    const channelId = S.channelId, threadId = S.threadId;
    const here = () => S.channelId === channelId && S.threadId === threadId;
    // 日時を指定した返信は予定として置く（時刻が来たら人の投稿として投稿される。channels.schedulePost）
    if (at) {
      await host.invoke('channels.schedulePost', { channelId, threadId, text, at, clientId, ...(attachments?.length ? { attachments } : {}) });
      return;
    }
    const made = await host.invoke('channels.post', { channelId, threadId, text, ...(attachments?.length ? { attachments } : {}), ...(confirmedWake ? { confirmedWake } : {}), ...(clientId ? { clientId } : {}) });
    // @ で選んだ bot がメンバーでなかったので足した（サーバーが投稿の前に足す）。足したことを知らせ、候補にも反映する
    if (made?.addedMembers?.length) {
      const names = made.addedMembers.map((id) => S.bots.get(id)?.name).filter(Boolean);
      if (names.length) notify(t('channels:feed.mention.added', { names: names.join('、') }));
      if (S.channel?.id === channelId) S.channel.members = [...new Set([...(S.channel.members ?? []), ...made.addedMembers])];
    }
    if (!here()) return;
    if (made?.id && !S.index.has(made.id) && made.threadId === threadId) { addPost(made); afterPosts(); }
    toBottom();
  }

  /** 失敗した返事のやり直し。元の投稿をもう一度 bot に届ける（スレッドの返信は送り直し、根・DM は同じ本文を書き足す） */
  async function retryTurn(p) {
    const source = retrySource(S.posts, p);
    if (!source || threadReadOnly()) return;
    try { await retryFailed({ host, channel: { id: S.channelId, kind: S.channel?.kind }, threadId: S.threadId, failed: p, source }); }
    catch (err) { composer.say(t('channels:thread.resend.failed', { error: err?.message ?? String(err) }), true); }
  }
  /** ［やり直す］は最後の投稿のときだけ。後ろに投稿が増えたら外す */
  function syncRetry() {
    for (const b of log.querySelectorAll('.post-retry-row')) {
      const id = b.closest('.post')?.dataset.postId;
      const p = id ? S.index.get(id) : null;
      if (!p || !retrySource(S.posts, p)) b.remove();
    }
  }

  async function react(p, emoji, on, had) {
    if (on && had) return;
    const prev = p.reactions;
    p.reactions = withReaction(prev, emoji, on);
    repaint(p.id);
    try {
      const got = await host.invoke('channels.react', { channelId: S.channelId, postId: p.id, emoji, on });
      if (got?.reactions) { p.reactions = got.reactions; repaint(p.id); }
    } catch (err) {
      p.reactions = prev;
      repaint(p.id);
      composer.say(t('channels:feed.reactFailed', { error: err?.message ?? String(err) }));
    }
  }

  /** エージェントに渡した原文（channels.deliveries）。bot ごとに切り替えて見る（聞こえた投稿はその印つき） */
  async function showSource(p, opener) {
    try {
      const got = await host.invoke('channels.deliveries', { channelId: S.channelId, postId: p.id });
      const list = got?.deliveries ?? [];
      if (!list.length) { composer.say(t('channels:thread.noSource')); return; }
      openSourceDialog({ opener, variants: list.map((d) => ({
        label: `${S.bots.get(d.botId)?.name ?? t('channels:feed.unknownBot')}${d.heard ? ` · ${t('channels:thread.heardMark')}` : ''}`,
        text: d.text, at: d.at ? whenText(Date.parse(d.at)) : '' })) });
    } catch (err) { composer.say(t('channels:thread.sourceFailed', { error: err?.message ?? String(err) }), true); }
  }
  function openMenu(p, x, y, anchor, alignRight = false) {
    const node = postEls.get(p.id);
    const more = node?.querySelector('.post-tool.more') ?? null;
    // 原文は、このスレッド（DM）で bot が受けた人の投稿だけ
    const received = p.author?.kind === 'human' && (S.channel?.kind === 'dm' || Object.keys(S.thread?.sessions ?? {}).length > 0);
    const { items, title } = postMenu({
      post: p, t, name: authorInfo(p.author, ctx).name, time: node?.querySelector('.post-when')?.textContent ?? '',
      copyButton: node?.querySelector('.post-tool.copy') ?? null,
      react: () => {
        const at = node?.querySelector('.post-tool.add') ?? anchor;
        openEmojiPicker({ anchor: at, title: t('channels:feed.reactPicker'), onPick: (emoji) => react(p, emoji, true, (p.reactions?.[emoji] ?? []).some((a) => a.kind === 'human')) });
      },
      source: received ? () => showSource(p, more ?? anchor) : null,
      // ここから分岐: 根からこの投稿までを写した新しいスレッド（bot の会話もこの手前で分ける）
      fork: threadReadOnly() || S.channel?.kind === 'dm' || p.state === 'working' ? null : () => branchFrom(p),
      // 編集して再送信・再送信: あなたの返信だけ（根は分岐して送る）
      ...(!threadReadOnly() && p.author?.kind === 'human' && p.threadId && S.channel?.kind !== 'dm' ? { edit: () => beginResend(p, true), resend: () => beginResend(p, false) } : {}),
    });
    more?.setAttribute('aria-expanded', 'true');
    node?.classList.add('menu-open');
    host.showMenu(x, y, items, title, { alignRight, onClose: () => { more?.setAttribute('aria-expanded', 'false'); node?.classList.remove('menu-open'); } });
  }
  // ---------------------------------------------------------------- 送り直し（ADR 0157 の 4.5、ADR 0178。Chats と同じ「編集中」の入力欄。web/composer/edit-mode.mjs）
  const resendId = () => `rs-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  /** 元の返信と、送り直すと消えるものの見立て。根（先頭）と、無い投稿は null */
  function resendTarget(id) {
    const idx = S.posts.findIndex((x) => x.id === id && !x.deletedAt);
    if (idx <= 0) return null;
    const after = S.posts.slice(idx + 1).filter((x) => !x.deletedAt);
    const running = liveBots().length > 0;
    // bot のターン（作業）が後ろにあれば、ファイルの変更は戻らないことを帯の 2 行目に書く（中身までは見ない）
    const tail = { saved: after.length, users: after.filter((x) => x.author?.kind === 'human').length, files: after.some((x) => x.turn), running, forkOnly: false, any: after.length > 0 || running };
    return { time: postEls.get(id)?.querySelector('.post-when')?.textContent ?? '', tail };
  }
  /** 元の返信に「編集中」の札を付け、消える範囲の投稿を薄くする */
  function resendDecorate(id, on, tail) {
    for (const n of log.querySelectorAll('.post.doomed')) n.classList.remove('doomed');
    for (const n of log.querySelectorAll('.editing-tag')) n.remove();
    for (const n of log.querySelectorAll('.post.edit-src')) n.classList.remove('edit-src');
    const node = postEls.get(id);
    if (!on || !node) return;
    node.classList.add('edit-src');
    const tag = el('span', 'editing-tag');
    tag.append(penGlyph(), t('chat.resend.tag'));
    node.querySelector('.post-head .post-name')?.after(tag);
    if (!tail?.any) return;
    const idx = S.posts.findIndex((x) => x.id === id);
    for (const x of S.posts.slice(idx + 1)) postEls.get(x.id)?.classList.add('doomed');
  }
  function resendLocate(id) {
    const node = postEls.get(id);
    if (!node) return;
    node.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1300);
  }
  /** 編集して再送信（edit）・再送信。後ろに消えるもの（投稿・作業中の返事）があれば入力欄の上の帯に出す。押した時点では何も消さない */
  function beginResend(p, edit) {
    if (threadReadOnly()) return;
    const found = resendTarget(p.id);
    if (!found) return;
    const { tail } = found;
    if (!edit && !tail.any) { void doResend(p, { text: p.text ?? '', attachments: (p.attachments ?? []).map(attachmentOf) }, false); return; }
    composer.edit.begin({ id: p.id, time: found.time, tail }, { text: p.text ?? '', attached: (p.attachments ?? []).map((a) => ({ ...a })) }, { focus: edit ? 'text' : 'send' });
  }
  const attachmentOf = (a) => ({ path: a.path, name: a.name, mime: a.mime ?? '' });
  async function doResend(p, body, stopRunning) {
    if (threadReadOnly()) return false;
    try {
      await host.invoke('channels.resend', { channelId: S.channelId, postId: p.id, text: body.text, stopRunning, clientId: resendId(), ...(body.attachments?.length ? { attachments: body.attachments } : {}) });
      return true;
    } catch (err) { composer.say(t('channels:thread.resend.failed', { error: err?.message ?? String(err) }), true); return false; }
  }
  async function resendSend({ id, text, tail }) {
    if (threadReadOnly()) return false;
    const p = S.index.get(id);
    if (!p) { composer.edit.targetLost(); return false; }
    return doResend(p, composer.attach.compose(text), tail.running);
  }
  /** 分岐して送る: H の直前で分けた新しいスレッドに、新しい本文（と添付）を書く。移る前に入力欄を編集前の書きかけへ戻す（元のスレッドの下書きになる） */
  async function resendBranch({ id, text }) {
    if (threadReadOnly()) return false;
    const idx = S.posts.findIndex((x) => x.id === id);
    if (idx <= 0) { composer.edit.targetLost(); return false; }
    const body = composer.attach.compose(text);
    try {
      const made = await host.invoke('channels.branchThread', { channelId: S.channelId, threadId: S.threadId, atPostId: S.posts[idx - 1].id });
      await host.invoke('channels.post', { channelId: made.channelId, threadId: made.threadId, text: body.text, clientId: resendId(), ...(body.attachments.length ? { attachments: body.attachments } : {}) });
      composer.edit.end({ restore: true });
      composer.saveDraft();
      document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: made.channelId, threadId: made.threadId } }));
      return true;
    } catch (err) { composer.say(t('channels:thread.branch.failed', { error: err?.message ?? String(err) }), true); return false; }
  }
  // ---------------------------------------------------------------- 送信待ち（ADR 0157 の F12）
  let pendingTimer = 0;
  async function refreshPending() {
    clearTimeout(pendingTimer);
    if (!S.threadId) return;
    const key = `${S.channelId}/${S.threadId}`;
    const before = S.pending.map((x) => x.postId);
    try {
      const got = await host.invoke('channels.pending', { channelId: S.channelId, threadId: S.threadId });
      if (`${S.channelId}/${S.threadId}` !== key) return;
      S.pending = got?.items ?? [];
    } catch { S.pending = []; }
    // 届く前の投稿の下の 1 行を、増えた・減ったものだけ描き直す
    const now = new Set(S.pending.map((x) => x.postId));
    for (const id of new Set([...before, ...now])) if (now.has(id) !== before.includes(id)) repaint(id);
    composer.paintSchedules();
  }
  const refreshPendingSoon = () => { clearTimeout(pendingTimer); pendingTimer = setTimeout(refreshPending, 250); };

  // ---------------------------------------------------------------- `!` の行（宛先の bot の会話のシェル。Chats と同じ行の部品）
  const shells = el('div', 'th-shells col-lane');
  perms.after(shells);   // 投稿の列の末尾の目印（会話の移動の部品）より前に置く
  function onShellStart(ev) {
    if (!Object.values(S.thread?.sessions ?? {}).includes(ev.sessionId) || !host.shellRow) return;
    const bot = S.bots.get(Object.entries(S.thread.sessions).find(([, sid]) => sid === ev.sessionId)?.[0]);
    const node = host.shellRow({ role: 'user', kind: 'shell', text: `! ${ev.command}`, command: ev.command, stdout: '', stderr: '', at: ev.at, backend: ev.backend,
      runId: ev.runId, pending: true, running: true, live: true });
    if (!node) return;
    const wrap = el('div', 'th-shell');
    if (bot) wrap.append(el('p', 'th-shell-where', t('channels:thread.shellWhere', { name: bot.name })));
    wrap.append(node);
    shells.append(wrap);
    if (nearBottom()) toBottom();
  }

  /** 取り下げた投稿（送り直し）を、列から消す */
  function withdrawPost(id) {
    const node = postEls.get(id);
    node?.remove();
    postEls.delete(id);
    const i = S.posts.findIndex((p) => p.id === id);
    if (i >= 0) S.posts.splice(i, 1);
    S.index.delete(id);
    paintRdiv();
    afterPosts();
  }

  // ---------------------------------------------------------------- 分岐（ADR 0157 の 4.4）
  async function branchFrom(p) {
    if (threadReadOnly()) return;
    try {
      const made = await host.invoke('channels.branchThread', { channelId: S.channelId, threadId: S.threadId, atPostId: p.id });
      document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: made.channelId, threadId: made.threadId } }));
    } catch (err) { composer.say(t('channels:thread.branch.failed', { error: err?.message ?? String(err) }), true); }
  }
  /**
   * 分けた投稿の直後に「オリジナル / 枝 N」の行（Chats の分岐の行と同じ部品。web/branch-view.mjs）。兄弟は同じ branchOf を持つスレッド。
   * 枝の中では、頭に「分岐元」の一行と、写した分けた投稿の直後に同じ行。押すとそのスレッドへ
   */
  let branchSeq = 0;
  async function paintBranches() {
    const seq = ++branchSeq;
    const rootPost = S.posts[0];
    if (!S.threadId || !rootPost || S.channel?.kind === 'dm') { for (const n of log.querySelectorAll('.th-branch')) n.remove(); return; }
    const origin = rootPost.branchOf?.threadId ?? S.threadId;
    let roots;
    try { roots = (await host.invoke('channels.read', { channelId: S.channelId, limit: 100 })).posts ?? []; } catch { return; }
    const points = new Map();
    for (const r of roots) if (r.branchOf?.threadId === origin && !r.deletedAt) (points.get(r.branchOf.postId) ?? points.set(r.branchOf.postId, []).get(r.branchOf.postId)).push(r);
    const here = rootPost.branchOf ? [{ postId: rootPost.branchOf.postId, anchor: S.posts.find((p) => p.copyOf === rootPost.branchOf.postId) }]
      : [...points.keys()].map((postId) => ({ postId, anchor: S.index.get(postId) }));
    const rows = [];
    for (const { postId, anchor } of here) {
      if (!anchor) continue;
      const ids = [origin, ...(points.get(postId) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => r.id)];
      // 続きの件数: 分けた投稿（枝では写した投稿）より後ろの投稿の数
      const counts = await Promise.all(ids.map(async (id) => {
        try {
          const page = await host.invoke('channels.read', { channelId: S.channelId, threadId: id, limit: 100 });
          const i = page.posts.findIndex((p) => (id === origin ? p.id === postId : p.copyOf === postId));
          return i >= 0 ? page.posts.length - i - 1 : 0;
        } catch { return 0; }
      }));
      const entries = ids.map((id, i) => ({ id, name: i === 0 ? t('channels:thread.branch.original') : t('channels:thread.branch.nth', { n: i }), n: counts[i] }));
      rows.push({ anchor, entries });
    }
    if (seq !== branchSeq) return;
    for (const n of log.querySelectorAll('.th-branch')) n.remove();
    if (rootPost.branchOf) {
      const from = roots.find((r) => r.id === origin);
      const line = el('p', 'th-branch th-branch-from', t('channels:thread.branch.from', { title: from ? titleOf(from) : t('channels:thread.untitled') }));
      rootSlot.before(line);
    }
    for (const { anchor, entries } of rows) {
      const row = makeBranchRow(`b:${anchor.id}`, entries, S.threadId, (id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: S.channelId, threadId: id } })));
      row.classList.add('th-branch');
      const node = postEls.get(anchor.id);
      if (!node) continue;
      node.after(row);
      row.layout();
    }
  }

  // 右クリック・長押し・Shift+F10・メニューキー（Chats の発言と同じ口。web/message-actions.mjs の setupMessageMenu）
  setupPostMenu(log, (node, at) => {
    const p = S.index.get(node.dataset.postId);
    if (!p || p.deletedAt) return;
    const pt = menuPoint(node, at);
    openMenu(p, pt.x, pt.y, node, pt.alignRight);
  });
  log.addEventListener('scroll', () => {
    if (nearBottom()) markRead();
    if (log.scrollTop < 120) loadOlder();
  });

  /** 目次・通知の一覧から: 投稿へ送って、一瞬（1.2 秒）だけ強調する。動きを減らす設定では滑らせず、明滅もしない（CSS の .flash） */
  function goTo(p) {
    const node = postEls.get(p.id);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1300);
  }
  /** 通知の一覧（ADR 0149）から開いたとき、着いたら送って輪を付ける投稿。読み込みが済んでから flushReveal が使う */
  let revealId = null;
  function flushReveal() {
    if (!revealId || !S.ready) return;
    const p = S.index.get(revealId);
    revealId = null;
    if (p) goTo(p);
  }

  // ---------------------------------------------------------------- 承認のカード
  function showCard(ev) {
    if (!ev?.id || cards.has(ev.id) || !sessionIds().has(ev.sessionId)) return;
    if (perms.querySelector(`[data-key="perm:${CSS.escape(ev.id)}"]`)) return;
    const stick = nearBottom();
    const m = host.permissionCard(ev, perms);
    const wrap = m?.closest?.('.mw') ?? perms.querySelector(`[data-key="perm:${CSS.escape(ev.id)}"]`);
    if (!wrap) return;
    cards.set(ev.id, wrap);
    if (stick) toBottom(); else nav.replyArrived();
  }
  function paintPendingPerms() {
    for (const ev of host.state?.pendingPerms?.values?.() ?? []) showCard(ev);
  }
  /** 別の画面（Chats・スマホ）で答えた承認のカードは外す。答え終えたカード（done）は履歴として残す */
  function settleCards() {
    const pending = host.state?.pendingPerms;
    if (!pending) return;
    for (const [id, wrap] of cards) {
      if (pending.has(id) || wrap.classList.contains('done') || wrap.querySelector('.card.done')) continue;
      wrap.remove();
      cards.delete(id);
    }
  }

  // ---------------------------------------------------------------- 出来事
  /** 投稿が増えた・変わった後に揃えるもの */
  function afterPosts() {
    windows = turnWindows(S.posts);
    syncRetry();
    paintStop();
    paintPlaceholder();
    composer.refresh();
    composer.syncEdit();
    toc.refresh(); nav.refresh(); nav.syncRunning();
    head.setSession(activeSession());
    syncTodo();
    syncSubs();
  }

  function onReply(op, p) {
    const stick = nearBottom();
    if (op === 'add') {
      if (S.index.has(p.id)) { Object.assign(S.index.get(p.id), p); repaint(p.id); } else addPost(p);
    } else {
      const cur = S.index.get(p.id);
      if (!cur) return;
      const was = cur.state;
      Object.assign(cur, p, op === 'delete' ? { deletedAt: p.deletedAt ?? Date.now() } : {});
      repaint(p.id);   // 保存された本文が伸びた分は、ここで本文に吸収され、書きかけの残りが縮む
      if (p.turn?.sessionId && was !== p.state && !LIVE.has(p.state)) { tools.refresh(p.turn.sessionId, { force: true }); streams.settled(p.turn.sessionId); }
    }
    afterPosts();
    // 走っている間の道具の行は、投稿の更新（1 秒に 1 回まで）に合わせて取り直す（間隔は thread-tools の REFRESH_MS）
    if (p.turn?.sessionId && (LIVE.has(p.state) || op === 'add')) tools.refresh(p.turn.sessionId, { force: op === 'add' });
    if (stick || p.author?.kind === 'human') toBottom(); else nav.replyArrived();
  }

  function onRoot(op, p) {
    const cur = S.index.get(p.id);
    if (!cur) return;
    Object.assign(cur, p, op === 'delete' ? { deletedAt: p.deletedAt ?? Date.now() } : {});
    repaint(p.id);
    paintHead();
    toc.refresh(); nav.refresh(); nav.syncRunning();
  }

  tools.onLoaded((sessionId) => {
    if (!S.ready) return;
    const stick = nearBottom();
    repaintTurns(sessionId);
    if (stick) toBottom();
  });

  const events = {
    'shell.start': (ev) => { if (S.ready) onShellStart(ev); },
    channelPost(ev) {
      if (ev.channelId !== S.channelId || !S.threadId) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const p = ev.post;
      if (!p) return;
      if (ev.op === 'withdraw') { if (p.threadId === S.threadId) { withdrawPost(p.id); refreshPendingSoon(); } return; }
      // 黙って終えたターンが消した投稿は、取り下げと同じく列から消す（「削除された投稿」の行を残さない）
      if (ev.op === 'delete' && p.threadId === S.threadId && vanishedTurnPost(p)) { withdrawPost(p.id); refreshPendingSoon(); return; }
      if (p.threadId === S.threadId) refreshPendingSoon();
      if (p.threadId === S.threadId) onReply(ev.op, p);
      else if (!p.threadId && p.id === S.threadId) onRoot(ev.op, p);
      // このスレッド（の元）から新しい枝ができた: 分岐の行を描き直す
      else if (!p.threadId && p.branchOf && ev.op === 'add') paintBranches();
    },
    channelReaction(ev) {
      if (ev.channelId !== S.channelId || !S.threadId) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const p = S.index.get(ev.postId);
      if (p) { p.reactions = ev.reactions ?? {}; repaint(p.id); }
    },
    channelThread(ev) {
      if (ev.channelId !== S.channelId || ev.threadId !== S.threadId || !ev.thread) return;
      if (!S.ready) { S.queue.push(ev); return; }
      const idle = S.thread?.state !== 'idle' && ev.thread.state === 'idle';
      const retitled = (S.thread?.title ?? '') !== (ev.thread.title ?? '');
      S.thread = ev.thread;
      if (threadReadOnly()) composer.edit.end({ restore: true });
      composer.setDisabled(Boolean((threadReadOnly() && !receiver()) || S.channel?.archivedAt), threadReadOnly() ? t('ui:deletedBotReadOnly') : t('channels:feed.archived'));
      if (retitled) paintHead();
      paintStop();
      paintPlaceholder();
      syncTodo();
      syncSubs();
      paintPendingPerms();
    },
    todosChanged: (ev) => todo?.onEvent(ev),
    channelsChanged(ev) {
      if (!S.channelId) return;
      if (ev.removed === S.channelId) { close(); return; }
      if (ev.channel?.id === S.channelId) { S.channel = ev.channel; paintHead(); paintStop(); composer.setDisabled(Boolean((threadReadOnly() && !receiver()) || ev.channel.archivedAt), threadReadOnly() ? t('ui:deletedBotReadOnly') : t('channels:feed.archived')); }
    },
    botsChanged(ev) {
      if (ev.removed) S.bots.delete(ev.removed);
      if (ev.bot) S.bots.set(ev.bot.id, shownBot(ev.bot, t));
      if (!S.threadId || !S.ready) return;
      for (const id of postEls.keys()) repaint(id);
      paintStop();
      paintPlaceholder();
      composer.refresh();
      paintSubs();
    },
    permission(ev) {
      if (S.ready && S.threadId) showCard(ev);
    },
    running() {
      // client.mjs が承認の残りを数え直した後に、答え済みのカードを外す
      if (S.threadId) setTimeout(settleCards, 0);
    },
    // 書きかけの流し（ADR 0367）。スレッドの枠を宣言している間だけサーバーから届く。replay（会話を読み直した流し直し）は使わない（宣言の返事の写しがある）
    'text.delta': (ev) => streams.event(ev),
    'text.end': (ev) => streams.event(ev),
    'tool.start': (ev) => streams.event(ev),
    turnEnd: (ev) => streams.event(ev),
  };

  // ---------------------------------------------------------------- 開く・閉じる
  /** 流れの側で選んでいるスレッドの根の投稿に印（左の線と背景）を付ける。流れが描き直されても付け直す */
  function markSelected() {
    for (const n of feedRoot.querySelectorAll('.post[data-open]')) delete n.dataset.open;
    if (S.threadId) { const n = feedRoot.querySelector(`.post[data-post-id="${CSS.escape(S.threadId)}"]`); if (n) n.dataset.open = ''; }
  }
  const feedLog = feedRoot.querySelector('.ch-log');
  if (feedLog) new MutationObserver(() => { if (S.threadId) markSelected(); }).observe(feedLog, { childList: true });

  function open(channelId, threadId, { postId = null } = {}) {
    if (!channelId || !threadId) return;
    revealId = postId;
    const same = S.channelId === channelId && S.threadId === threadId;
    S.channelId = channelId;
    S.threadId = threadId;
    deck.setThread(true);
    if (same) {
      markSelected();
      composer.focus();
      flushReveal();
      syncWatch();
      return;
    }
    S.seq++;
    reset();
    syncWatch();   // 別のスレッドを開いたら、前のスレッドの枠は外れて、このスレッドの枠へ替わる
    composer.setDraftKey(threadDraftKey(channelId, threadId));   // 書きかけはスレッドごと（ほかのスレッドへ移っても残る）
    composer.refresh();
    toc.close();
    head.setTitle({ channel: document.getElementById('channelsPageTitle')?.title ?? '', title: '' });
    markSelected();
    load();
  }

  function close() {
    if (!S.threadId) return;
    host.noteView?.({ kind: 'channel', id: S.channelId });
    composer.setDraftKey(null);   // 書きかけは持ち主の下書きへ残して、入力欄を空に戻す
    toc.close();
    todo?.load(null);
    S.seq++;
    S.threadId = null;
    syncWatch();   // 閉じたら書きかけの流しを外す
    streams.forget();
    host.background?.watch([]);
    paintSubs();
    markSelected();
    deck.setThread(false);
    feedRoot.querySelector('.ch-input')?.focus({ preventScroll: true });
  }

  return {
    openThread: open,
    show(view) {
      if (view?.kind !== 'channel') { if (S.threadId) close(); return; }
      if (S.channelId && view.id !== S.channelId && S.threadId) close();
      S.channelId = view.id;
    },
    hide() { /* スレッドは開いたまま（Chats へ移って戻っても同じ所から） */ },
    onEvent(ev, replay = false) {
      // 会話を読み直したときの流し直し（replay）の書きかけは使わない。スレッドの枠の返事の写しが、同じ分を重ならずに渡す
      if (replay && STREAM_TYPES.has(ev?.type)) return;
      events[ev?.type]?.(ev);
    },
    /** 予定（schedule.json）が動いた: このスレッドへの返信の予定の行を描き直す */
    schedulesChanged() { composer.paintSchedules(); },
    /** 接続が戻った: ToDo を読み直す（その間の変更を取りこぼさないように） */
    reconnected() { todo?.reconnected(); syncWatch({ force: true }); },   // つなぎ直した接続には枠が無い: 宣言し直して、書きかけの写しをもらう
    contextForPanel(anchor) {
      if (!anchor?.closest?.('#chThread')) return null;
      return { sessionId: activeSession(), at: undefined };
    },
    sideTabChanged() { syncWatch(); },   // Chats へ移ったら流しを外し、戻ったら宣言し直す
    /** テスト・ほかの部品が見る */
    get state() { return { deck: deck.state, threadId: S.threadId, channelId: S.channelId }; },
  };
}
