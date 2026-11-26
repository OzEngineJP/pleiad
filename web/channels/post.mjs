// 投稿 1 件の描画（チャンネルの流れ。docs/design-system.md「チャンネルの流れ」）。
//   .post[data-post-id] > .post-av・.post-main（.post-head・.post-body・.post-state・.reactions・.thread-summary）・.post-tools
// 本文は host.renderAssistantMarkdown（エスケープ済みの HTML。bot の返事と同じ描き方）。@ の呼びかけだけ後から色を付ける。
// 発言者は Author（core/channels/types.mjs）。bot は bots.list の定義（アイコン・名前・バックエンド）から引く。
import { el, svgEl } from '../dom.mjs';
import { fmt, t } from '../i18n.mjs';
import { runMark } from '../arc.mjs';
import { durationText } from '../chrome-control.mjs';
import { backendLogo } from '../side.mjs';
import { placeAttachments, attachmentHtml, paintUserBody, userTools, attachmentImageSrc } from '../user-message.mjs';
import { renderReactions, addButton } from './reactions.mjs';
import { botIcon, botColorVar } from './bot-icon.mjs';
import { copyGlyphs, copyToClipboard } from '../message-actions.mjs';

/** 同じ日か */
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** 投稿の時刻。今日は時分、それ以外は月日と時分 */
export function whenText(at, now = Date.now()) {
  if (sameDay(at, now)) return fmt.time(at);
  return fmt.dateTime(at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 日の区切りの文字。今日・昨日・月日（曜日） */
export function dayText(at, now = Date.now()) {
  if (sameDay(at, now)) return t('channels:feed.day.today');
  if (sameDay(at, now - 86_400_000)) return t('channels:feed.day.yesterday');
  return fmt.dateTime(at, { month: 'long', day: 'numeric', weekday: 'short' });
}

/**
 * 発言者の表示。bot は定義から（消えた bot は名前を持たない）。
 * @param {object} author Author
 * @param {{ bots: Map<string, object>, sessionTitle?: (id: string) => string|null }} ctx
 * @returns {{ kind: string, name: string, avatar: string, backend: string|null, you: boolean }}
 */
export function authorInfo(author, ctx) {
  switch (author?.kind) {
    case 'human': {
      const name = t('channels:feed.you');
      return { kind: 'human', name, avatar: [...name][0] ?? '?', backend: null, you: true };
    }
    case 'bot': {
      const bot = ctx.bots.get(author.botId);
      return { kind: 'bot', name: bot?.name ?? t('channels:feed.unknownBot'), avatar: bot?.icon ?? '', backend: bot?.backend ?? null, you: false };
    }
    case 'agent': {
      // 別の会話の AI が書いた投稿。名前は Chats の「別の会話の AI が送った発言」と同じ言い方（ADR 0157・0104）
      const title = ctx.sessionTitle?.(author.sessionId);
      return { kind: 'agent', name: title ? t('chat.message.sentByConversation', { title }) : t('chat.message.sentByAnother'), avatar: '◇', backend: null, you: false };
    }
    case 'routine':
      return { kind: 'routine', name: t('channels:feed.routine'), avatar: '⏱', backend: null, you: false };
    default:
      return { kind: 'system', name: t('channels:feed.system'), avatar: '·', backend: null, you: false };
  }
}

/** 札・一覧の「誰が」に出す名前 */
export const nameOfAuthor = (author, ctx) => authorInfo(author, ctx).name;

const foldName = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

/** 送った投稿の bot の宛先: 顔＋名前の塊（入力欄の塊と同じ見た目。mention-blocks.mjs）。`@` は見えない字で残す（コピーすると `@名前`） */
function mentionPill(bot, text) {
  const pill = el('span', 'mention mt');
  pill.dataset.bot = bot.id ?? '';
  pill.style.setProperty('--bot-color', botColorVar(bot));
  const face = botIcon(bot, 'mention-av mt-face');
  face.setAttribute('aria-hidden', 'true');
  pill.append(face, el('span', 'mt-at', text.slice(0, 1)), text.slice(1));
  return pill;
}

/**
 * bot の名前を、@ の呼びかけとして色付けする。コード（code・pre）と、すでにリンクの中は触らない。
 * bots（宛先になった bot の定義）に当たる名前は、顔＋名前の塊にする（ADR 0359）。それ以外（@あなた など）は字の色だけ
 */
export function highlightMentions(root, names, bots = []) {
  const byName = new Map((bots ?? []).filter((b) => b?.name).map((b) => [foldName(b.name), b]));
  const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return;
  const escaped = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${escaped.join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  const texts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) texts.push(child);
      else if (child.nodeType === 1 && !/^(CODE|PRE|A|SCRIPT|STYLE)$/.test(child.tagName)) walk(child);
    }
  };
  walk(root);
  for (const node of texts) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      // メールの形（直前が英数字・_）は呼びかけではない
      const before = m.index > 0 ? text[m.index - 1] : '';
      if (/[A-Za-z0-9_]/.test(before)) continue;
      const bot = byName.get(foldName(m[1]));
      frag.append(text.slice(last, m.index), bot ? mentionPill(bot, m[0]) : el('span', 'mention', m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** 投稿の添付（Post.attachments）を、札・画像の描き方の部品（web/user-message.mjs の attachmentHtml）が読む形にする */
const presentOf = (a) => ({ kind: a.kind === 'image' ? 'image' : 'file', path: a.path, captionParams: { name: a.name }, size: a.size, origin: a.origin });

/**
 * 添付つきの投稿の本文の HTML。本文の `[添付] パス` の行は、その位置で添付（画像は縮小、ほかは札）に置き換わる（Chats の自分の発言と同じ。
 * web/user-message.mjs の placeAttachments）。印の無い添付は本文の後ろに並ぶ。文字の区間は renderMarkdown（bot の返事と同じ描き方）
 * @param {string} text 投稿の本文（原文）
 * @param {object[]} attachments Post.attachments
 * @param {(text: string) => string} renderMarkdown エスケープ済みの HTML を返す
 */
export function attachedBodyHtml(text, attachments, renderMarkdown) {
  let html = '', run = [];
  const flush = () => { if (run.length) html += `<div class="msg-atts">${run.map(attachmentHtml).join('')}</div>`; run = []; };
  for (const seg of placeAttachments(text, attachments.map(presentOf))) {
    if (seg.type === 'attachment') { run.push(seg.present); continue; }
    flush();
    if (seg.text.trim()) html += renderMarkdown(seg.text);
  }
  flush();
  return html;
}

/** 添付の画像を押すと大きく見る（Chats の会話と同じライトボックス。host.openImage）。log は投稿の列 */
export function wireAttachmentZoom(log, host) {
  log.addEventListener('click', (e) => {
    const img = e.target.closest?.('.msg-att-zoom')?.querySelector('img');
    if (img) host.openImage?.(img.src, img.alt, img.dataset.filePath, img);
  });
}

const replyIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z' }));
  return svg;
};
const moreIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  // 縦の 3 点（docs/design-system.md「「…」の形」）
  for (const cy of [5.5, 12, 18.5]) svg.append(svgEl('circle', { cx: 12, cy, r: 1.5, fill: 'currentColor', stroke: 'none' }));
  return svg;
};

const iconButton = (cls, label, child) => {
  const b = el('button', `post-tool ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(child);
  return b;
};

const tickMark = () => {
  const svg = svgEl('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M3.5 7.3 6 9.8l4.6-5.3' }));
  return svg;
};
const ringMark = () => {
  const svg = svgEl('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 7, cy: 7, r: 4.2 }));
  return svg;
};
const CHECK = /^\s*\[( |x|X)\]\s?/;

/**
 * 本文の「- [x] …」「- [ ] …」の並びを、進捗のチェックリストにする（済みは✓・いま走っているものは弧・これからは輪）。
 * bot のターンの投稿の本文（bot が同じ投稿の編集で更新する進捗）だけが対象。全部の行が [ ] か [x] で始まる一番外の箇条書きだけで、ほかの箇条書きは触らない
 * @param {HTMLElement} body 本文の要素（renderAssistantMarkdown の HTML が入っている）
 * @param {boolean} working ターンが走っているか（最初の未完了の行に弧を出す）
 */
export function paintChecklist(body, working) {
  for (const ul of body.querySelectorAll('ul')) {
    if (ul.parentElement?.closest('li')) continue;
    const items = [...ul.children].filter((li) => li.tagName === 'LI');
    if (!items.length || !items.every((li) => CHECK.test(li.textContent))) continue;
    ul.classList.add('ck');
    const done = items.map((li) => CHECK.exec(li.textContent)?.[1].toLowerCase() === 'x');
    const current = working ? done.findIndex((d) => !d) : -1;
    items.forEach((li, i) => {
      // 先頭の「[x] 」の印を外す（入れ子の <p> の中にあることもある）
      const first = document.createTreeWalker(li, NodeFilter.SHOW_TEXT).nextNode();
      if (first) first.nodeValue = first.nodeValue.replace(CHECK, '');
      const mark = el('span', 'mk');
      if (done[i]) mark.append(tickMark());
      else if (i === current) mark.append(runMark(t('channels:feed.state.working')));
      else mark.append(ringMark());
      const text = el('span', 'ck-text');
      text.append(...li.childNodes);
      li.append(mark, text);
      li.classList.add(done[i] ? 'done' : i === current ? 'cur' : 'todo');
    });
  }
}

/**
 * 返事のない失敗か（bot のターンの投稿が failed で終わり、本文が無い）。返事の場所には本文でなく「✕ 失敗 · 理由」を出す。
 * 理由（Post.failure）を持たない昔の投稿は、本文の失敗文をそのまま出す
 */
export const isTurnFailure = (post) => post.state === 'failed' && Boolean(post.turn) && !post.failedWithBody && typeof post.failure === 'string' && !post.deletedAt;

/** 返事の文章があるか（書き出す前の待ちの印「…」だけではない） */
const hasText = (post) => { const s = String(post.text ?? '').trim(); return s !== '' && s !== '…'; };

// 作業中の返事の経過時間。画面に残っている分だけ 1 秒ごとに進め、無くなったら止める（ターンの投稿は作業中に書き換わらないので、時計だけ別に進める）
const clocks = new Set();
let clockTimer = null;
function tickClocks() {
  const at = Date.now();
  for (const node of clocks) {
    if (!node.isConnected) { clocks.delete(node); continue; }
    node.textContent = durationText((at - Number(node.dataset.since)) / 1000);
  }
  if (!clocks.size) { clearInterval(clockTimer); clockTimer = null; }
}
function watchClock(node) {
  clocks.add(node);
  if (!clockTimer) { clockTimer = setInterval(tickClocks, 1000); clockTimer.unref?.(); }
}

/** 状態の行（bot のターンの投稿・ルーティンの実行の根）。成功を緑の ✓ で見せない（終了は文字だけ） */
function stateLine(post) {
  const state = post.state;
  if (!state) return null;
  if (state === 'done' && !post.routine) return null;
  // bot の返事を待つ間: 返事の場所の 1 行「考えている · 12 秒」（文章を書き出したら「書いている」）。止めるのは入力欄の ■
  if (state === 'working' && post.turn) {
    const row = el('div', 'post-state working');
    const clock = el('span', 'post-state-clock');
    clock.dataset.since = String(post.at);
    clock.textContent = durationText((Date.now() - post.at) / 1000);
    row.append(runMark(t('channels:feed.state.working')), el('span', 'post-state-text', t(hasText(post) ? 'channels:feed.state.writing' : 'channels:feed.state.thinking')), el('span', 'post-state-dot', '·'), clock);
    watchClock(clock);
    return row;
  }
  // 止めた返事: 文章が残っていれば止めた記録はスレッドの「■ 中断しました · 時刻」の行が持つ。何も書けずに止めたときだけ、返事の場所に 1 行
  if (state === 'stopped' && post.turn) {
    if (hasText(post)) return null;
    const row = el('div', 'post-state stopped');
    row.append(el('span', 'post-state-sq'), el('span', 'post-state-text', t('channels:feed.state.stopped')));
    return row;
  }
  const softFailure = state === 'failed' && post.turn && post.failedWithBody;
  const row = el('div', `post-state ${softFailure ? 'failed-body' : state}`);
  if (state === 'working') row.append(runMark(t('channels:feed.state.working')));
  else if (state === 'waiting') row.append(el('span', 'post-state-mark', '◆'));
  else if (state === 'failed' && !softFailure) row.append(el('span', 'post-state-mark', '✕'));
  // i18n-dynamic: channels:feed.state.
  const label = t(`channels:feed.state.${softFailure ? 'failedWithBody' : state}`);
  const reason = post.routine?.missed ? t('channels:feed.state.missed') : post.routine?.reason;
  row.append(el('span', 'post-state-text', reason && (state === 'skipped' || post.routine?.missed) ? `${label} · ${reason}` : label));
  // 返事のない失敗: 理由を同じ行に 1 行で添える（長ければ省く。全文は title）
  if (isTurnFailure(post) && post.failure) {
    const why = el('span', 'post-state-reason', post.failure);
    why.title = post.failure;
    row.append(why);
  }
  return row;
}

/** スレッドの要約の行。「💬 3 件の返信 · 🦉 Owl 作業中」。返信が無ければ null */
/**
 * スレッドで実際に動いている bot。状態（ThreadState.state）はスレッド全体の集計なので、名前は bot ごとの印（ThreadState.live）から選ぶ。
 * あなた待ち（waiting）のときは待っている bot、作業中のときは作業している bot。印が無ければ空（名前を出さない）
 * @returns {string[]} botId の並び（印の並び）
 */
export function liveBotIds(th) {
  const want = th?.state === 'waiting' ? 'waiting' : 'working';
  return Object.entries(th?.live ?? {}).filter(([, state]) => state === want).map(([botId]) => botId);
}

/** 動いている bot の名前の並び: 1 体は名前、2 体は「A・B」、3 体以上は「A ほか n」 */
export function liveNamesText(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return t('channels:feed.liveJoin', { a: names[0], b: names[1] });
  return t('channels:feed.liveMore', { first: names[0], count: names.length - 1 });
}

export function renderSummary(post, ctx) {
  const s = ctx.summaryOf?.(post.id);
  if (!s?.count || post.threadId) return null;
  const th = ctx.threadOf?.(post.id);
  const b = el('button', 'thread-summary');
  b.type = 'button';
  b.setAttribute('aria-label', t('channels:feed.openThread', { count: s.count }));
  b.append(el('span', 'ts-count', `💬 ${t('channels:feed.replies', { count: s.count })}`));
  // 動いている bot は ThreadState.live から選ぶ（返信した最後の bot や最初の会話の bot ではない。いま動いているのは別の bot のことがある）
  const live = liveBotIds(th).map((id) => ctx.bots.get(id)).filter(Boolean);
  const names = liveNamesText(live.map((b) => b.name));
  const status = el('span', 'ts-status');
  if (th?.state === 'working') {
    status.classList.add('working');
    status.append('· ');
    if (live.length) {
      for (const bot of live.slice(0, 2)) status.append(botIcon(bot, 'ts-bot-icon'));
      status.append(` ${names}`);
    } else status.append(th?.agentName ?? t('channels:feed.unknownBot'));
    status.append(` ${t('channels:feed.threadWorking')}`, runMark(t('channels:feed.state.working')));
  } else if (th?.state === 'waiting') {
    status.classList.add('waiting');
    status.append('· ', el('span', 'ts-mark', '◆'), ` ${t('channels:feed.threadWaiting', { name: names || th?.agentName || t('channels:feed.unknownBot') })}`);
  } else if (th?.state === 'failed') {
    status.classList.add('failed');
    status.append('· ', el('span', 'ts-mark', '✕'), ` ${t('channels:feed.state.failed')}`);
  } else if (s.lastAt) {
    status.append(`· ${t('channels:feed.lastReply', { when: whenText(s.lastAt) })}`);
  }
  b.append(status);
  b.onclick = () => ctx.actions.openThread(post);
  return b;
}

/**
 * 投稿の中身を（再）描画する。root は renderPost が作った .post
 * @param {HTMLElement} root
 * @param {object} post Post
 * @param {object} ctx { bots, summaryOf, threadOf, sessionTitle, host, actions: { react, openThread, menu, quick } }
 */
export function fillPost(root, post, ctx) {
  const info = authorInfo(post.author, ctx);
  // システム側の投稿（Pleiad の知らせ）は、Chats のシステム側の行と同じく小さく中立に出す（道具・リアクションは無い）
  root.className = `post${post.deletedAt ? ' deleted' : ''}${info.you ? ' mine' : ''}${info.kind === 'system' ? ' sys' : ''}`;
  root.dataset.postId = post.id;
  root.dataset.author = info.kind;
  const av = info.kind === 'bot' ? botIcon(ctx.bots.get(post.author.botId), 'post-av') : el('span', `post-av${info.you ? ' you' : ''}`, info.avatar);
  av.setAttribute('aria-hidden', 'true');
  const main = el('div', 'post-main');

  const head = el('div', 'post-head');
  head.append(el('b', 'post-name', info.name));
  if (info.backend) {
    const label = ctx.host.state?.backends?.find((b) => b.id === info.backend)?.label ?? info.backend;
    head.append(backendLogo(info.backend, label));
  }
  if (post.routine) head.append(el('span', 'post-kind', t('channels:feed.routine')));
  // 分けたスレッドの根（channels.branchThread）。元のスレッドと同じ本文が並ぶので、枝だと分かる札
  if (post.branchOf && !post.threadId) head.append(el('span', 'post-kind', t('channels:feed.branch')));
  const when = el('time', 'post-when', whenText(post.at));
  when.dateTime = new Date(post.at).toISOString();
  when.title = fmt.dateTime(post.at);
  head.append(when);
  if (post.editedAt && !post.deletedAt) head.append(el('span', 'post-edited', t('channels:feed.edited')));
  main.append(head);

  const body = el('div', 'post-body');
  if (post.deletedAt) {
    body.append(el('span', 'post-deleted', t('channels:feed.deleted')));
  } else if (isTurnFailure(post) || (post.turn && !hasText(post))) {
    // 本文は出さない（失敗は「✕ 失敗 · 理由」、待つ間は「考えている」の行が返事の場所を占める。「…」は待ちの印で、読ませない）
    body.hidden = true;
  } else if (info.kind === 'human') {
    // あなたの投稿は Chats の自分の発言と同じ描き方（添付をその位置に・長ければ畳む。原文は dataset.raw。web/user-message.mjs）
    paintUserBody(body, post.text ?? '', (post.attachments ?? []).map(presentOf));
    highlightMentions(body, (post.mentions ?? []).map((m) => (m === 'you' ? t('channels:feed.you') : ctx.bots.get(m)?.name)), (post.mentions ?? []).map((m) => ctx.bots.get(m)));
  } else {
    body.innerHTML = post.attachments?.length
      ? attachedBodyHtml(post.text ?? '', post.attachments, (s) => ctx.host.renderAssistantMarkdown(s))
      : ctx.host.renderAssistantMarkdown(post.text ?? '');
    const names = (post.mentions ?? []).map((m) => (m === 'you' ? t('channels:feed.you') : ctx.bots.get(m)?.name));
    if (post.mentions?.includes('you')) names.push('you');
    highlightMentions(body, names, (post.mentions ?? []).map((m) => ctx.bots.get(m)));
    if (post.turn) paintChecklist(body, post.state === 'working');
  }
  main.append(body);
  // 添付の「📎 N ▾」と一覧の面（Chats の自分の発言と同じ。web/user-message.mjs の userTools）
  if (!post.deletedAt && info.kind === 'human' && post.attachments?.length) {
    const presents = post.attachments.map(presentOf);
    const tools = userTools({
      presents,
      openItem: (item, present) => {
        const src = present && attachmentImageSrc(present);
        if (src) ctx.host.openImage?.(src, item.name, item.path);
        else if (item.path) ctx.host.filePreview?.open({ path: item.path, line: null }, null);
      },
      copyPath: (path) => { navigator.clipboard?.writeText(path).catch(() => {}); },
    });
    if (tools) main.append(tools);
  }

  if (!post.deletedAt) {
    const state = stateLine(post);
    if (state) main.append(state);
    // 返事のない失敗: 返事の場所に［やり直す］（最後の投稿のときだけ。ctx.actions.retry が持ち主）
    if (isTurnFailure(post) && ctx.actions.canRetry?.(post)) {
      const retry = el('button', 'btn post-retry', t('channels:feed.retryTurn'));
      retry.type = 'button';
      retry.onclick = () => { retry.disabled = true; ctx.actions.retry(post).finally(() => { retry.disabled = false; }); };
      const retryRow = el('div', 'post-retry-row');
      retryRow.append(retry);
      main.append(retryRow);
    }
    const nameOf = (a) => nameOfAuthor(a, ctx);
    const row = renderReactions(post, { nameOf, onToggle: (emoji, on, had) => ctx.actions.react(post, emoji, on, had) });
    main.append(row);
    const summary = renderSummary(post, ctx);
    if (summary) main.append(summary);
  }

  root.replaceChildren(av, main);
  if (!post.deletedAt) {
    const tools = el('div', 'post-tools');
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', t('channels:feed.tools'));
    const quick = iconButton('quick', t('channels:feed.quick', { emoji: '👍' }), document.createTextNode('👍'));
    quick.onclick = () => ctx.actions.quick(post, '👍');
    const add = addButton(post, (emoji, on, had) => ctx.actions.react(post, emoji, on, had), 'post-tool add');
    const reply = iconButton('reply', t('channels:feed.reply'), replyIcon());
    reply.onclick = () => ctx.actions.openThread(post);
    // コピー（Chats の発言のコピーと同じ ✓ と「コピーしました」）。bot の返事は投稿の本文だけ（作業ログ・進捗の一覧は入れない）
    const copy = iconButton('copy', post.author?.kind === 'human' ? t('chat.message.copy') : t('chat.message.copyReply'), document.createDocumentFragment());
    copy.append(...copyGlyphs());
    copy.onclick = () => copyToClipboard(post.text ?? '', copy);
    const more = iconButton('more', t('channels:feed.more'), moreIcon());
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); ctx.actions.menu(post, r.right, r.bottom + 4, more); };
    tools.append(quick, add, copy, reply, more);
    root.append(tools);
  }
  return root;
}

export function renderPost(post, ctx) {
  const root = el('div', 'post');
  root.tabIndex = -1;
  return fillPost(root, post, ctx);
}
