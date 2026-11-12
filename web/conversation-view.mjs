// 会話の本文の面を束ねる部品（ADR 0319 段 6-5）。web/client.mjs から動かしただけ。
// 進行中のターン（web/live-turn.mjs）と履歴の面（web/history-pane.mjs）の実例、履歴を読む間の出来事の取り置き（createSessionLoads）、
// 筋への行の置き方（wrap・place・append・末尾へ送る）を、この実例が持つ。主の会話の 1 つだけが使う（子の会話は段 6-6 から）。
// この部品は主の会話の値（state.current など）を直に読まない。必要なものは次の hooks で受ける。
//   isRunning() / stopping() / behind() / backgroundCounts() / turnStart()   進行中のターンの問い（live-turn.mjs の hooks と同じ）
//   aiMsg(opts) / stopComputer(bundle) / onActivity()                          進行中のターンの下請け
//   isBusy()                                                                   今、送信などで手が塞がっているか（行を足したとき末尾へ付いていくかの判定）
//   会話を開く（paint）: setUuid(m, uuid) / isEditing() / outbox(sessionId) / onEvent(ev, replay) / batchPaint(fn)
//   出来事を描く（apply）: userMsg(text, opts) / userRaw(row) / paintUser(row, text, presents) / paintUserTools(row) / markSentBy(row, by) / markSentLate(row, at, planned) /
//     hhmm(at) / taskNoticeNode(text, at) / paintInterruptLine(live) / turnFailedRow(ev) / syncHistory()
//   主だけの仕事（子の会話は渡さない）: paintOutbox() / markFailedMessage(row, item) / voiceDelivery / provisionalByMessage /
//     onStopping(ev) / onTurnOk() / onReplyArrived(ev, replay) / onTurnSettled(ev)
//   歴史の面の下請け（history-pane.mjs の hooks と同じ）: spine, placeJunctions, paintDelegateStates, paintCompactions, syncEdit, paintable,
//     updateBranches, cmd, select, finalizing, systemHistoryNode, stripActions, userMsg, noteEndpointFailure, linkDelegateCard,
//     activeBackendId, subagentToolsOf, isBoundaryTool, currentSession, isLoadingSession, backendVocab
import { el, svgEl } from "./dom.mjs";
import { layoutBranchSpine } from "./branch-view.mjs";
import { createSessionLoads } from "./session-stream.mjs";
import { createLiveTurn, ACTIVITY_LABEL } from "./live-turn.mjs";
import { createHistoryPane } from "./history-pane.mjs";
import { t } from "./i18n.mjs";
import { renderPresent, renderToolCall, applyToolResult } from "./render.mjs";
import { bundleOf, markRunning } from "./tool-bundle.mjs";
import { toolStartedAt } from "./server-clock.mjs";
import { isComputerTool } from "./computer-use.mjs";
import { attachmentMessageIndex, normalizeAttachmentPath } from "./timeline.mjs";
import { sysFold } from "./system-messages.mjs";
import { runMark, satMark } from "./arc.mjs";
import { CHILD_MENU } from "./message-actions.mjs";
import { waitsForNextTurn, injectTaskInstructions } from "./task-instructions.mjs";

/**
 * 役ごとの設定。主は今の動きのまま（読むのは child の仕事だけ。主の行は client.mjs の既存の経路が描く）。
 * child は、作業のダイアログの子の会話（client.mjs の readonlyThread・refreshDetail が今描いているもの）と同じ見え方の設定:
 *   branches   分岐の筋（枝の最小化・分岐の先）を出すか。子の会話は 1 本道（左の縦の線は 1 本道でも引く。layoutBranchSpine は枝の行が無ければ真っすぐな 1 本を引く）
 *   ownSpine   筋の置き直しを実例が自分で見張る（主は client.mjs が #thread を見張るので false。子は自分の thread の高さが変わったら置き直す）
 *   readonly   履歴の行を historyRow の readonly で描く（Markdown にしない・uuid を持たない・システム側の行の操作を外す・
 *              返答の発言者をモデル名で出す・委譲カードと道具のカードの登録をしない）
 *   menu       発言のメニューの絞り（message-actions.mjs の CHILD_MENU。分岐・編集は出さない）
 *   edit / resend / gitBadge   編集・再送・git の印は出さない
 *   skipPresent  読むだけの筋に出さない提示の種類（git の要約の押した先は今の会話の右パネルで、読んでいる子の会話ではない）
 *   nameTags   発言者の語を 依頼 / あなた / 追加の指示 にする（userWord）
 *   instructions  追加の指示の行（instructionRow）を出す
 *   liveActivity  走っている子は末尾に稼働表示（弧だけ）を置く（activityRow）
 *   yieldToReader  末尾へ付いていく間に、読んでいる人が上へ動かしたら追従をやめる（作業のダイアログ。主は従来どおり）
 */
const ROLES = {
  main: {
    branches: true, ownSpine: false, readonly: false, menu: null, edit: true, resend: true, gitBadge: true,
    skipPresent: [], nameTags: false, instructions: false, liveActivity: false, yieldToReader: false,
  },
  child: {
    branches: false, ownSpine: true, readonly: true, menu: CHILD_MENU, edit: false, resend: false, gitBadge: false,
    skipPresent: ["git", "worktree"], nameTags: true, instructions: true, liveActivity: true, yieldToReader: true,
  },
};

/**
 * 会話の本文の面 1 つ。sessionId は子の会話の実例が自分の会話を示す（主は null。主の会話は hooks.currentSession() が答える）。
 * log・thread・frame は DOM（主は #log・#thread・#logFrame）。role は 'main' / 'child'。
 */
export function createConversationView({ sessionId = null, log, thread, frame, role = "main", hooks }) {
  const config = ROLES[role] ?? ROLES.main;
  const { isBusy, isLoadingSession } = hooks;
  // この実例の会話。主は固定の id を持たないので今の会話を hooks に問い、子は自分の会話
  const here = () => sessionId ?? hooks.currentSession();

  // 状態
  let replaying = false;    // 読み込み中に取り置いた出来事を流し直している間（読むだけの印。末尾の判定・追従をしない）
  let seq = 0;              // 履歴でない行（live:N）の通し番号
  const loads = createSessionLoads();

  // ---------------------------------------------------------------- 筋への置き方

  const atBottom = () => !replaying && log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  /** 会話の下端に付いていく（行が伸びて高さが変わる間も、読んでいた下端に居続ける） */
  function followBottom(ms = 320) {
    if (replaying) return;
    const end = performance.now() + ms;
    let put = -1;
    const tick = () => {
      // 子の面（作業のダイアログ）は、読んでいる人が上へ動かしたら、そこで追従をやめる（流れが 250ms おきでも、読んでいる位置を保つ）
      if (config.yieldToReader && put >= 0 && log.scrollTop < put - 4) return;
      log.scrollTop = log.scrollHeight;
      put = log.scrollTop;
      if (performance.now() < end) requestAnimationFrame(tick);
    };
    tick();
  }

  /**
   * 末尾へ送り、高さが落ち着くまで末尾に合わせ直す。画面の外の発言は仮の高さで並び（style.css の content-visibility）、
   * 末尾へ送ったあとに見えた分が本当の高さに伸びるので、1 回送るだけでは末尾から外れる。
   * 利用者がスクロールし始めたら（ホイール・タッチ・キー）そこでやめる
   */
  let settling = null;
  function scrollToEnd() {
    settling?.abort();
    const run = settling = new AbortController();
    log.scrollTop = log.scrollHeight;
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) log.addEventListener(type, () => run.abort(), { signal: run.signal, passive: true });
    let last = log.scrollHeight, calm = 0, frames = 0;
    const tick = () => {
      if (run.signal.aborted) return;
      if (++frames > 60) return run.abort();
      const height = log.scrollHeight;
      if (height !== last || !atBottom()) { log.scrollTop = height; last = height; calm = 0; }
      else if (++calm >= 3) return run.abort();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** 筋（左の縦の線）の置き直し。分岐を持たない役（子）も、枝の行が無い 1 本の線を引く（主と同じ線） */
  function relayoutBranches() { if (!replaying) layoutBranchSpine(thread); }
  // 子の thread は client.mjs の見張りの外。高さが変わったら（画像・折り畳み・返答が伸びる）同じフレームの変化をまとめて置き直す
  let spineFrame = null;
  const spineWatch = config.ownSpine && typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (spineFrame !== null) return;
    spineFrame = requestAnimationFrame(() => { spineFrame = null; relayoutBranches(); });
  }) : null;
  spineWatch?.observe(thread);

  /**
   * 発言の入れ物。左の溝（gutter）に筋の節、右に中身。枝の最小化・最大化はこの高さと位置を動かす。
   * 節は中身の箱の外にあるので、中身の overflow:hidden に切られない。
   */
  function wrap(node, key) {
    const w = el("div", "mw");
    if (key) w.dataset.key = key;
    if (node.matches?.(".m:not(.sys):not(.cont):not(.activity)")) w.classList.add("node");
    if (node.matches?.(".m.cont")) w.classList.add("cont");
    if (node.matches?.(".m.card")) w.classList.add("card");
    if (node.matches?.(".m.activity")) w.classList.add("activity");
    const body = el("div", "mw-body");
    body.append(node);
    w.append(el("div", "mw-gutter"), body);
    return w;
  }

  /**
   * 筋の末尾に置く。稼働表示（走っている間だけある）は常に一番下に残す。
   * 稼働表示の行は activity.el が持っている。1 行ごとに筋の子孫を探すと、履歴を描く間が件数の 2 乗になる
   */
  function place(w) {
    if (historyPane.paintBefore) { historyPane.paintBefore.before(w); return; }
    const act = liveTurn.activity.el?.isConnected ? liveTurn.activity.el.closest(".mw") : null;
    if (act && !w.classList.contains("activity")) act.before(w);
    else thread.append(w);
  }

  function append(node, key) {
    if (historyPane.painting || replaying) { const w = wrap(node, key); place(w); return w; }
    const stick = !isBusy() && atBottom();
    const w = wrap(node, key);
    place(w);
    relayoutBranches();
    if (stick) log.scrollTop = log.scrollHeight;
    return w;
  }

  // ---------------------------------------------------------------- 部品

  const liveTurn = createLiveTurn({
    thread, log,
    isRunning: hooks.isRunning,
    stopping: hooks.stopping,
    behind: hooks.behind,
    backgroundCounts: hooks.backgroundCounts,
    turnStart: hooks.turnStart,
    aiMsg: hooks.aiMsg,
    placeRow: (node, key) => append(node, key),
    atBottom: () => atBottom(),
    followBottom: (ms) => followBottom(ms),
    relayout: () => relayoutBranches(),
    onActivity: hooks.onActivity,
    stopComputer: hooks.stopComputer,
    replaying: () => replaying,
    painting: () => historyPane.painting,
    nextSeq: () => ++seq,
  });

  // 子の会話の履歴を描く下請け（history-pane.mjs の hooks.child）。追加の指示・依頼の行を足し、出さない提示を除く
  const childState = { backend: undefined, live: false, steer: true, prompt: null, instructions: [], waiting: false, hostOffline: null, seen: new Set() };
  const childPaint = {
    items: (items, { messages, base }) => childItems(items, messages, base),
    extraRow: (it) => (it.kind === "request"
      ? wrap(parentMsg(it.text, it.at, t("dialog.work.request")), "request")
      : instructionRow(it.instruction, { live: childState.live, steer: childState.steer })),
    rowOptions: (it) => ({ ...historyRowOptions({ backend: childState.backend, base: historyPane.base }, it), linkCards: true }),
    place: (w) => place(w),
  };

  const historyPane = createHistoryPane({
    thread, log,
    atBottom: () => atBottom(),
    placeRow: (node, key) => append(node, key),
    resetLiveTurn: () => liveTurn.resetLiveTurn(),
    spine: hooks.spine,
    relayoutBranches: () => relayoutBranches(),
    placeJunctions: hooks.placeJunctions,
    paintDelegateStates: hooks.paintDelegateStates,
    paintCompactions: hooks.paintCompactions,
    syncEdit: hooks.syncEdit,
    paintable: hooks.paintable,
    updateBranches: hooks.updateBranches,
    cmd: hooks.cmd,
    select: hooks.select,
    finalizing: hooks.finalizing,
    systemHistoryNode: hooks.systemHistoryNode,
    stripActions: hooks.stripActions,
    userMsg: hooks.userMsg,
    aiMsg: hooks.aiMsg,
    thinkFromText: (text) => liveTurn.thinkFromText(text),
    noteEndpointFailure: hooks.noteEndpointFailure,
    linkDelegateCard: hooks.linkDelegateCard,
    activeBackendId: hooks.activeBackendId,
    subagentToolsOf: hooks.subagentToolsOf,
    isBoundaryTool: hooks.isBoundaryTool,
    currentSession: here,
    isBusy,
    isLoadingSession,
    backendVocab: hooks.backendVocab,
    toolCardMap: () => liveTurn.toolCards,
    child: role === "child" ? childPaint : null,
  });

  // ---------------------------------------------------------------- 会話を開く（paintSession の実例の仕事）

  // 会話を開いている最中の読み込みと、開いた直後に送った発言の id（履歴の描き方・出来事の流し直しが読む）
  let displayLoad = null;
  let initialMessageId;
  const isCurrent = (id, load) => here() === id && displayLoad === load;

  /** 手前を足している最中の会話を描き替えるとき: 残す行（位置を保つ描き替え・枝の切り替え）は手前まで描き終えてから、そうでなければやめる */
  function prepare({ keepUpTo, plan }) {
    if (historyPane.backfill) { if (keepUpTo !== undefined || plan) historyPane.flushBackfill(); else historyPane.cancelBackfill(); }
  }

  /** 読んだ履歴をこの実例の持ち物にする（発言・窓の先頭・提示・開いた直後の発言の id） */
  function adopt(data) {
    historyPane.messages = data?.messages ?? [];
    historyPane.base = data?.base ?? 0;
    historyPane.earlierCalls = data?.earlierCalls ?? [];
    initialMessageId = data?.initialMessageId;
    historyPane.presents = data?.presents ?? [];
    historyPane.presentBase = data?.presentBase ?? 0;
    historyPane.olderFail = null;
  }

  /** A live assistant row can represent several persisted tool/thinking entries. */
  function branchAnchor(mi) {
    const rows = [...thread.querySelectorAll('.mw[data-key^="m:"]')];
    return rows.find(w => Number(w.dataset.key.slice(2)) === mi)
      ?? rows.filter(w => Number(w.dataset.key.slice(2)) <= mi).at(-1)
      ?? thread.querySelector('.mw[data-key^="live:"]')
      ?? thread.querySelector('.mw');
  }

  /**
   * 読んだ履歴を筋に描き、読み込み中に取り置いた出来事を流し直す。読み込みが途中で捨てられたら null。
   * beforeFirstPaint は、残す行を決めた後・最初に描く前の主だけの仕事（入力欄の下書きを戻す）
   */
  async function paint(data, { id, load, keepUpTo, transition, quiet, plan, beforeFirstPaint }) {
    const scrollAt = log.scrollTop;
    // 読み直しは、末尾を見ていたなら末尾へ、読み返していたならその位置のまま描き替える
    const atEnd = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
    const restoreReading = plan && !atEnd ? historyPane.holdReading() : null;
    const retained = plan ? historyPane.retainThread(plan) : null;
    if (keepUpTo === undefined) { if (!retained) historyPane.clearThread(); }
    else {
      const last = keepUpTo > 0 ? branchAnchor(keepUpTo - 1) : null;
      let after = !last;
      for (const x of [...thread.children]) {
        if (x.classList.contains('spine')) continue;
        if (after) x.remove();
        if (x === last) after = true;
      }
    }
    // Shared DOM survives a fork switch, but its UUID must belong to the selected session.
    // 静かな読み直しで残した行は同じ会話の同じ発言なので、uuid は変わらない
    if (!retained) for (const w of thread.querySelectorAll('.mw[data-key^="m:"]')) {
      const message = historyPane.messages[Number(w.dataset.key.slice(2)) - historyPane.base];
      const m = w.querySelector('.m[data-role]');
      if (m && message) {
        delete m.dataset.uuid;
        hooks.setUuid(m, message.uuid);
      }
    }
    beforeFirstPaint?.();
    liveTurn.closeTurnEl();
    // 長い会話を開くときは、末尾の数行を先に描き、手前は idle に足す（ADR 0182: C1）。
    // 位置を保つ描き替え・枝の切り替え・編集中・開いた直後に送った会話は、全部を描く
    const split = !retained && keepUpTo === undefined && !transition && (!quiet || atEnd) && !hooks.isEditing() && !initialMessageId ? historyPane.splitFirstPaint() : null;
    const added = split ? historyPane.paintHistory(0, null, split.tail) : historyPane.paintHistory(keepUpTo ?? 0, retained);
    if (split) { historyPane.backfill = split.job; log.style.overflowAnchor = 'none'; }
    hooks.syncEdit();
    hooks.paintCompactions();
    if (initialMessageId) {
      const lastUser = [...thread.querySelectorAll('.mw:has(.m.user:not(.cmd))')].at(-1);
      if (lastUser) lastUser.dataset.messageId = initialMessageId;
    }
    syncOutboxRows(hooks.outbox(id));
    // Keep incoming display events queued until snapshot restoration catches up.
    if (load) {
      const restored = await loads.replay(load, data, {
        current: () => isCurrent(id, load),
        apply: event => hooks.onEvent(event, true),
        paint: fn => {
          replaying = true;
          try { hooks.batchPaint(fn); }
          finally { replaying = false; liveTurn.flushStream(); relayoutBranches(); }
        },
      });
      if (!restored) return null;
    }
    return { added, atEnd, scrollAt, restoreReading };
  }

  /** 描き終えた後の位置決め。末尾へ送るか、読み返していた位置へ戻す。窓の高さの確定と手前の読み足しを始める */
  function finish(res, { keepUpTo, quiet }) {
    if (keepUpTo === undefined && (!quiet || res.atEnd)) scrollToEnd(); else if (res.restoreReading) res.restoreReading(); else log.scrollTop = res.scrollAt;
    historyPane.prepareHistoryHeights();
    requestAnimationFrame(historyPane.maybeLoadOlder);
    if (historyPane.backfill) historyPane.scheduleBackfill(historyPane.backfill);
  }

  // ---------------------------------------------------------------- 送った発言の行（途中送信の配達。server の userMessage.pending / delivered）
  //
  // 受理（吹き出しを出す）と「エージェントに渡った」は別の瞬間。渡るまでの間だけ、吹き出しの下に
  // 回る弧と一言を出す（docs/design-system.md §6。印は待っている間しか DOM に置かない）。
  // 渡ったら「AIへ送信済み」に戻し、渡らないままターンが終わったら、次のターンで答えることを言う。
  const NO_VOICE = { isVoice: () => false, owns: () => false, adopt() {}, mark: () => false, queued() {} };
  const voiceDelivery = hooks.voiceDelivery ?? NO_VOICE;   // 声で送った発言の配送の一行（web/voice/delivery.mjs）。入力欄から送った発言の言い方は変えない
  const provisionalByMessage = hooks.provisionalByMessage ?? new Map();   // 送った直後の仮の添付（messageId -> 添付）
  const deliveredEarly = new Set();   // 吹き出しより先に届いた配達の合図
  const deliveryTimers = new WeakMap();
  const turnErrorRows = new Map();    // 会話 id -> 直近のターンの失敗の行（送れなかった発言の行を出すとき片付ける）
  const DELIVERY = {
    sending: t('chat.delivery.sending'),
    pending: t('chat.delivery.pending'),
    late: t('chat.delivery.late'),
    sent: t('chat.delivery.sent'),
  };
  const messageRow = (messageId) => (messageId
    ? [...thread.querySelectorAll('.mw[data-message-id]')].find(w => w.dataset.messageId === messageId)
    : null) ?? null;
  function markDelivery(row, kind) {
    const status = row.querySelector('.outbox-status');
    if (!status) return;
    clearTimeout(deliveryTimers.get(row));
    if (kind === 'pending') row.dataset.deliveryPending = '1';
    else delete row.dataset.deliveryPending;
    if (kind === 'sending') row.dataset.deliverySending = '1';
    else delete row.dataset.deliverySending;
    const waiting = kind === 'pending' || kind === 'sending';
    if (voiceDelivery.isVoice(row) && voiceDelivery.mark(row, kind)) return;
    status.replaceChildren(DELIVERY[kind]);
    status.classList.remove('outbox-status-failed');
    status.classList.toggle('outbox-status-mark', waiting);
    if (waiting) deliveryTimers.set(row, setTimeout(() => {
      if (row.isConnected && status.textContent === DELIVERY[kind])
        status.prepend(runMark(kind === 'sending' ? DELIVERY.sending : t('chat.delivery.notYet')));
    }, 150));
  }

  function ensureMessageRow(messageId, text, at, sentBy = null, word = null) {
    let row = messageRow(messageId);
    if (!row) {
      const presents = provisionalByMessage.get(messageId) ?? [];
      provisionalByMessage.delete(messageId);
      const node = hooks.userMsg(text, { at, presents, sentBy });
      if (word) node.querySelector(".who > span").textContent = word;
      row = append(node, `live:${++seq}`);
      row.dataset.messageId = messageId;
      if (voiceDelivery.owns(messageId)) voiceDelivery.adopt(row);
    } else if (sentBy) hooks.markSentBy(row.querySelector('.m.user') ?? row, sentBy);
    if (!row.querySelector('.outbox-status')) row.querySelector('.m').append(el('div', 'outbox-status'));
    return row;
  }

  /** 発言の行の配達の時計を止める（送れなかった行へ替えるとき） */
  const clearDeliveryTimer = (row) => clearTimeout(deliveryTimers.get(row));

  /** 送れなかった行・送信待ちの行を、送信待ちの一覧（outbox）の今の中身に合わせる */
  function syncOutboxRows(messages) {
    if (!here() || isLoadingSession()) { hooks.paintOutbox?.(); return; }
    let withdrawn = false;
    for (const item of messages ?? []) {
      const row = messageRow(item.id);
      // 声で送った発言は、送信待ちでも会話の行に残す（時計の一行と［取り消す］。入力欄の脇の一覧にも出さない）
      if (item.status === 'queued' && (item.waiting || row?.dataset.messageStarted) && voiceDelivery.isVoice(row)) { voiceDelivery.queued(row, item); continue; }
      if ((item.status === 'queued' && (item.waiting || row?.dataset.messageStarted))
        || ['paused', 'unknown', 'cancelled'].includes(item.status)) {
        if (row) { row.remove(); withdrawn = true; }
      } else if (item.status === 'failed') {
        hooks.markFailedMessage?.(ensureMessageRow(item.id, item.args.prompt, item.at, item.args.sentBy), item);
        const failure = turnErrorRows.get(here());
        if (failure?.messageId === item.id) {
          failure.node.closest('.mw')?.remove();
          turnErrorRows.delete(here());
          withdrawn = true;
        }
      } else if (item.status === 'sending' && row) {
        row.dataset.messageStarted = '1';
        if (!row.dataset.deliveryPending) markDelivery(row, 'sending');
      }
    }
    if (withdrawn) relayoutBranches();
    hooks.paintOutbox?.();
  }

  /** ターンが終わったのに「送信中」のままの吹き出し（渡った合図が来なかった）を片付ける。失敗なら outbox が先に失敗へ替えている */
  function settleSending() {
    for (const row of thread.querySelectorAll('.mw[data-delivery-sending]')) markDelivery(row, 'sent');
  }

  // ---------------------------------------------------------------- 出来事を本文に描く（onEvent の本文の部分）

  /** 上限・一時的な失敗のあと、バックエンドが再試行を待っている（ADR 0229）。人の応答待ちとは別の言い方で、次の時刻と回数を出す */
  const retryLabel = (retry) => {
    const time = Number.isFinite(retry?.next) ? hooks.hhmm(retry.next) : "";
    const attempt = retry?.attempt ?? 1;
    if (retry?.limit) return time ? t("activity.retryLimit", { time, attempt }) : t("activity.retryLimitNoTime", { attempt });
    return time ? t("activity.retryError", { time, attempt }) : t("activity.retryErrorNoTime", { attempt });
  };

  const {
    activity, runningTools, toolCards, ensureTurnEl, openTurnEl, closeBundle, liveBundle, closeTurnEl, settleStrays,
    thinkBox, closeThink, endStream, appendText,
  } = liveTurn;

  /**
   * 1 つの出来事を、この実例の本文に描く。描く出来事の種類:
   *   userMessage / taskInstruction / userMessage.delivered / userMessage.dropped（送った発言の行と配達）
   *   text.delta / text.end / thinking.start / thinking.delta / tool.start / tool.result（進行中のターン）
   *   activity / turnResult / turnEnd / taskNotice / channelEvent / interruptionNote / present
   * この実例の会話の出来事かどうかの振り分けと、画面全体・主だけの仕事（上部のバー・既読・git・入力欄）は呼ぶ側と hooks の仕事。
   * 戻り値は、描いた行（あれば）
   */
  function apply(ev, replay = false) {
    switch (ev.type) {
      case 'taskInstruction':
      case 'userMessage': {
        // 委譲の子への追加指示の受付（taskInstruction）は、配送中の発言と同じ pending の行として出す。
        // userMessage.delivered/dropped（messageId 照合）で解決する。会話の中の位置は出来事の並び（受付時点）
        const pending = ev.type === 'taskInstruction' ? true : ev.pending;
        if (replay && ev.messageId === initialMessageId && ev.type === 'userMessage') {
          const row = ensureMessageRow(ev.messageId, ev.text, ev.at, ev.sentBy, liveUserWord(ev));
          const confirmed = row.dataset.delivered === '1' || deliveredEarly.delete(ev.messageId);
          if (confirmed) row.dataset.delivered = '1';
          markDelivery(row, ev.pending && !confirmed ? 'sending' : 'sent');
          syncOutboxRows(hooks.outbox(here()));
          return;
        }
        closeTurnEl();
        const row = ev.messageId ? ensureMessageRow(ev.messageId, ev.text, ev.at, ev.sentBy, liveUserWord(ev))
          : append(hooks.userMsg(ev.text, { at: ev.at, sentBy: ev.sentBy }), `live:${++seq}`);
        if (!row.querySelector('.outbox-status')) row.querySelector('.m').append(el('div', 'outbox-status'));
        row.dataset.messageStarted = '1';
        const userRow = row.querySelector('.m.user');
        // 本文が同じなら描き直さない（送った直後の画像の枠を、読み込みの途中でやり直さない）
        if (userRow?.querySelector(':scope > .body') && hooks.userRaw(userRow) !== String(ev.text ?? '')) hooks.paintUser(userRow, ev.text, userRow.attached ?? []);
        if (ev.at) { row.querySelector('.m').dataset.at = ev.at; row.querySelector('.who .when').textContent = hooks.hhmm(ev.at); }
        if (ev.scheduledFor) hooks.markSentLate(row.querySelector('.m'), ev.at, ev.scheduledFor);
        // 放置中の圧縮で末尾に付いた区切りは、この発言の前へ置き直す（at で並べ直す）。
        // 区切りがすべてこの発言より前にあるときは作り直さない。古い区切りを最新の発言の前へ動かしていた不具合の再発を防ぐ
        const rows = [...thread.children];
        if ([...thread.querySelectorAll('.mw[data-compaction-id]')].some(boundary => rows.indexOf(boundary) > rows.indexOf(row))) hooks.paintCompactions();
        // pending = 受理はしたが、まだエージェントに渡っていない（userMessage.delivered を待つ）。
        // 配達の合図が先に来ていた分（速いバックエンド）はここで消化する
        const confirmed = row.dataset.delivered === '1' || deliveredEarly.delete(ev.messageId);
        if (confirmed) row.dataset.delivered = '1';
        if (pending && ev.messageId && !confirmed) markDelivery(row, ev.initial ? 'sending' : 'pending');
        else markDelivery(row, 'sent');
        syncOutboxRows(hooks.outbox(here()));
        return;
      }
      case 'userMessage.delivered': {
        const row = messageRow(ev.messageId);
        // 吹き出しより先に届くことがある（受理の応答と配達の合図が競る）。覚えておいて吹き出しで消す
        if (!row) { if (ev.messageId) deliveredEarly.add(ev.messageId); return; }
        row.dataset.delivered = '1';
        markDelivery(row, 'sent');
        return;
      }
      case 'userMessage.dropped':
        // 読まれないままターンが死んだ。発言は送信待ち（保留）へ戻るので、会話からは下げる
        messageRow(ev.messageId)?.remove();
        hooks.paintOutbox?.();
        return;

      case "text.delta":
        return appendText(String(ev.text ?? ""));

      case "text.end": {
        // 確定した発言。id が分かったので「ここから分岐」が押せるようになる。
        // 続くツール呼び出しは同じ発言に入る（履歴の 1 メッセージ = 本文 + ツール呼び出し）。
        // 本文の無い発言（ツールだけ）が、本文の無い発言に続くときは、発言もまとまりも閉じない。
        // 履歴は「本文も thinking も無く連続するツール呼び出し」を 1 つの発言に合成する（claude-normalize の transcriptToMessages）ので、ライブも同じにする。
        // Claude は本文の無い発言ごとに text.end を出す
        const bodyless = !liveTurn.streamEl && !liveTurn.thinkEl;
        if (bodyless && liveTurn.turnClosed && !liveTurn.endedWithText) return;
        // 見せるものが無い発言（thinking が署名だけ）のために、空の発言の入れ物は作らない。id は次の入れ物に持たせる
        if (bodyless && !liveTurn.turnEl) { liveTurn.pendingUuid = ev.uuid ?? null; liveTurn.turnClosed = true; liveTurn.endedWithText = false; return; }
        // 本文のある発言に続けて来たなら（本文の無いツールだけの発言）、新しい発言を作る
        const m = openTurnEl();
        if (ev.uuid) hooks.setUuid(m, ev.uuid);
        liveTurn.endedWithText = !bodyless;
        closeThink();
        endStream();
        liveTurn.turnClosed = true;
        return;
      }

      case "thinking.start":
        endStream();
        activity.show(ACTIVITY_LABEL.thinking);
        return;

      case "thinking.delta": {
        // 平文が来ないエージェント（Claude の thinking は署名だけ）もある。
        // 中身が来たときだけ箱を作る。稼働表示は文言だけにする。
        activity.show(ACTIVITY_LABEL.thinking);
        if (ev.text) {
          const box = thinkBox().querySelector(".think-body");
          box.textContent += ev.text;
          if (liveTurn.thinkEl.open) box.scrollTop = box.scrollHeight;
        }
        return;
      }

      case "tool.start": {
        if (ev.id && toolCards.has(ev.id)) {
          const card = toolCards.get(ev.id);
          if (!card.classList.contains("tc-done") && !card.classList.contains("tc-error") && !card.classList.contains("tc-stopped") && !card.classList.contains("tc-running") && !card.classList.contains("tc-waiting") && !hooks.isBoundaryTool(ev.name, hooks.subagentToolsOf(ev.backend ?? hooks.activeBackendId()))) {
            markRunning(card, toolStartedAt(ev)); runningTools.add(card);
          }
          return card;
        }
        endStream();
        const stick = atBottom();
        const card = renderToolCall(ev.name, ev.input, { id: ev.id, at: ev.at, startedAt: ev.startedAt });
        hooks.linkDelegateCard(card, ev.input);
        const boundary = hooks.isBoundaryTool(ev.name, hooks.subagentToolsOf(ev.backend ?? hooks.activeBackendId()));
        if (boundary) { closeBundle(); ensureTurnEl().append(card); }
        else {
          // 経過はサーバーが受けた時刻（at）から数える。開き直し・再接続の再生でも 0 に戻らない
          const since = toolStartedAt(ev);
          markRunning(card, since);
          liveBundle(isComputerTool(ev.name) ? "computer" : "tools", since).add(card);
          runningTools.add(card);
        }
        // 2 件目で見出しが現れ、行が伸びる間も、読んでいた下端に付いていく
        if (stick) followBottom();
        if (ev.id) toolCards.set(ev.id, card);
        // 通常ツールは同じ行を末尾へ移し、汎用の稼働表示を重ねない。
        // 委譲・サブエージェントの行には弧が無い（状態は 4 秒ごとの更新で追いつく）ので、それまでは従来の稼働表示を残す
        if (boundary) activity.show(t("activity.runningTool", { tool: ev.name }));
        else activity.suspend();
        return card;
      }

      // ツールの戻り。対応するカードに結果を差し込む（別の吹き出しにはしない）
      case "tool.result": {
        const card = toolCards.get(ev.id);
        if (card) { applyToolResult(card, ev); hooks.noteEndpointFailure(card, ev); hooks.linkDelegateCard(card, null, ev); bundleOf(card)?.paint(); }
        activity.afterTool();
        return;
      }

      case "activity":
        if (ev.state === "idle") { settleStrays(); closeBundle(); return activity.hide(); }
        // 別のタブで押した中断・開き直した会話でも、止まり終えるまで中断ボタンを押せなくする（主だけの仕事）
        if (ev.state === "stopping") hooks.onStopping?.(ev);
        // running / waiting は「動いている」「待っている」だけを言う汎用の事象。ツールの行が語っている間（suspend 中）は出さない
        return activity.show(ev.label || (ev.state === 'preparing'
          ? ev.current && ev.total ? t('activity.connectingMcp', { current: ev.current, total: ev.total }) : t('activity.preparing')
          : ev.state === 'mcpStart' ? t('activity.mcpStarting', { name: ev.name ?? '' })
          : ev.state === 'retrying' ? retryLabel(ev.retry)
          : ACTIVITY_LABEL[ev.state] || ACTIVITY_LABEL.running), { delayMark: ev.state === 'preparing', passive: ev.state === 'running' || ev.state === 'waiting' });

      case 'taskNotice':
        closeTurnEl();
        // 本文があれば開ける 1 行（既定は閉じた状態。履歴の systemHistoryNode と同じ形）
        append(hooks.taskNoticeNode(ev.text, hooks.hhmm(ev.at ?? new Date())));
        return;
      case 'channelEvent':
        // bot の会話へチャンネルの出来事・記憶の包みを渡した。履歴と同じ行（systemHistoryNode）で出す（サーバーが履歴と同じ形の rows を付ける）
        closeTurnEl();
        for (const row of ev.rows ?? []) { const node = hooks.systemHistoryNode({ at: new Date().toISOString(), ...row }); if (node) append(node); }
        return;
      case 'interruptionNote': {
        // 中断で止めたものをエージェントへ伝えた。開くと伝えた中身が読める（履歴の systemHistoryNode と同じ形）。
        // 添えた発言の吹き出しの前に置く（履歴と同じ並び）
        const node = append(sysFold(t('chat.sys.interruptionNote'), ev.text ?? ''));
        const row = ev.messageId ? messageRow(ev.messageId) : null;
        if (row && row !== node) row.before(node);
        return;
      }
      case "turnResult": {
        if (ev.compact) return;
        settleStrays();
        closeBundle();                                // ターンが終わったら、最新の行を残さず見出しだけにする
        // 終わったことは稼働表示が消えれば分かる。通ったターンでは、主だけの仕事（設定の行の期限切れの読み直し）をして終わる
        if (ev.outcome === "ok") { hooks.onTurnOk?.(); return; }
        closeTurnEl();
        // 中断の一行は保存された状態と同じ形で描く（paintInterruptLine が二重に出さない）
        if (ev.outcome === "aborted" || ev.outcome === 'limited') hooks.paintInterruptLine({ at: ev.at ?? Date.now(),
          reason: ev.outcome === 'limited' ? 'limit' : ev.reason, resetsAt: ev.resetsAt, window: ev.window,
          account: ev.account, backend: ev.backend });
        else {
          // ターンの失敗は会話の出来事として残す。「✕ 失敗」は強い字（ツールの失敗と同じ語）
          const node = hooks.turnFailedRow(ev);
          if (ev.sessionId) turnErrorRows.set(ev.sessionId, { messageId: ev.messageId, node });
          const failed = hooks.outbox(ev.sessionId)?.find(m => m.status === 'failed' && m.id === ev.messageId);
          if (failed) syncOutboxRows(hooks.outbox(ev.sessionId));
        }
        return;
      }

      case "present": {
        if (ev.by === "human") {
          const rows = [...thread.querySelectorAll('.m[data-role="user"]')];
          const index = attachmentMessageIndex(rows.map(row => ({role:"user", at:row.dataset.at, text:hooks.userRaw(row)})), ev);
          // 結び付いた発言が Markdown で描かれているなら、添付は本文の位置に取り込む（別のカードは出さない）
          const owner = index >= 0 && rows[index].querySelector(':scope > .body')?.classList.contains('md-user') ? rows[index] : null;
          if (owner) {
            const same = (a, b) => normalizeAttachmentPath(a) === normalizeAttachmentPath(b);
            const known = (owner.attached ?? []).findIndex(p => same(p.path, ev.path));
            if (known < 0) hooks.paintUser(owner, hooks.userRaw(owner), [...(owner.attached ?? []), ev]);
            else if (owner.attached[known].provisional) {
              // 送った直後に仮の添付で描いてある。描き直さず（画像を読み直さない）、持っている情報だけを本物に替える
              owner.attached[known] = ev;
              hooks.paintUserTools(owner);
            }
            relayoutBranches();
            return owner.closest('.mw');
          }
          const wrapper = append(renderPresent(ev), `live:${++seq}`);
          wrapper.dataset.humanAttachment = "true";
          if (index >= 0) {
            let anchor = rows[index].closest('.mw');
            while (anchor.nextElementSibling?.dataset.humanAttachment === "true") anchor = anchor.nextElementSibling;
            anchor.after(wrapper);
            relayoutBranches();
          }
          return wrapper;
        }
        closeTurnEl();
        return append(renderPresent(ev), `live:${++seq}`);
      }

      case "turnEnd":
        // 読み返している間に返答が終わったら、最新へのボタンに新着の印（主だけの仕事）
        hooks.onReplyArrived?.(ev, replay);
        closeTurnEl();
        // 渡った合図が来ないままターンが終わった分。Codex などは次のターンとして答える。
        // Claude は区切りで取り出された分にも同じターンの中で答え、渡った合図も出す（取りこぼしても、
        // 次の内部ターンが始まった時点で出す。core/backends/claude.mjs の takeLeftovers）ので、普通はここに残らない。
        // 待っているものは何も走っていないので、回る弧はここで外す
        for (const row of thread.querySelectorAll('.mw[data-delivery-pending]')) markDelivery(row, 'late');
        // 走っている印・送信中の印を下ろす（主だけの仕事）
        hooks.onTurnSettled?.(ev);
        hooks.paintInterruptLine();
        if (replaying && displayLoad) displayLoad.syncHistory = true;
        else hooks.syncHistory?.();
        return;
    }
  }

  // ---------------------------------------------------------------- 子の会話の見え方（role: 'child'）。段 6-6 から画面で使う

  const clockIcon = () => {
    const svg = svgEl("svg", { class: "i", viewBox: "0 0 24 24", "aria-hidden": "true" });
    svg.append(svgEl("circle", { cx: 12, cy: 12, r: 8 }), svgEl("path", { d: "M12 8v4.5l3 2" }));
    return svg;
  };

  /** 親の発言の吹き出し。人の発言と同じ部品で、発言者の語だけ替える */
  function parentMsg(text, at, word) {
    const m = hooks.userMsg(text, { at });
    m.querySelector(".who > span").textContent = word;
    return m;
  }

  /**
   * 子の会話の履歴の発言者の語。最初の発言は依頼、人が子へ直接送った発言（sentByHuman。ADR 0317）は「あなた」、それ以外は追加の指示。
   * 古い分を省いた筋（base > 0）の最初の発言は会話の途中なので、依頼ではなく追加の指示。主は null（人の発言の既定のまま）
   */
  function userWord(m, { index = 1, base = 0 } = {}) {
    if (!config.nameTags) return null;
    if (index === 0 && !base) return t("dialog.work.request");
    return m?.sentByHuman ? t("chat.message.you") : t("dialog.work.instruction");
  }

  /** 履歴の発言 1 件を描くときの historyPane.historyRow への渡し物（読むだけの筋）。user は発言者の語を替えた吹き出しを返す */
  function historyRowOptions({ backend, base = 0 } = {}, item = {}) {
    const opts = { readonly: config.readonly, backend, sessionId: here() };
    if (config.nameTags) opts.user = (m) => parentMsg(m.text, m.at, userWord(m, { index: item.mi, base }));
    return opts;
  }

  /** 読むだけの筋に出さない提示か（git の要約・作業ブランチ。押した先が、読んでいる子の会話ではないため） */
  const skipsPresent = (p) => config.skipPresent.includes(p?.kind);

  /**
   * 追加の指示の行（依頼元が子へ送った指示）。state は sending（差し込み待ち）/ queued（待機）/ dropped（届かず終わった）/ delivered（届いた）。
   * steer は子のバックエンドが走っている間の差し込みを受けるか（能力の印。呼ぶ側が渡す）、live は子が走っているか
   */
  function instructionRow(instruction, { live = false, steer = true } = {}) {
    const m = parentMsg(instruction.text, instruction.at, t("dialog.work.instruction"));
    m.dataset.instructionId = instruction.id;
    if (instruction.state === "sending") {
      const status = el("div", "outbox-status outbox-status-mark");
      status.append(runMark(t("chat.delivery.notYet")), t("chat.delivery.pending"));
      m.append(status);
    } else if (instruction.state === "dropped") {
      m.append(el("div", "outbox-status", t("dialog.work.instructionDropped")));
    } else if (instruction.state === "delivered") {
      // 届いた分は何も付けない（発言そのものが配送の記録。待機の印は付けない）
    } else {
      // 待機中。字の代わりに、発言者の行の静止した時計の印（title・読み上げ名）
      m.classList.add("queued");
      const clock = el("span", "who-queued");
      clock.setAttribute("role", "img");
      clock.title = t("dialog.work.instructionQueued");
      clock.setAttribute("aria-label", t("dialog.work.instructionQueued"));
      clock.append(clockIcon());
      m.querySelector(".who > span").after(clock);
      // 途中で渡せない子・設定の変更と一緒に積んだ指示は、今の作業が終わるまで届かない。印だけでなく字で書き添える
      if (waitsForNextTurn(instruction, { live, steer })) m.append(el("div", "outbox-status", t("dialog.work.instructionNextTurn")));
    }
    const w = wrap(m, `instruction:${instruction.id}`);
    if (instruction.state !== "sending") w.classList.remove("node");
    return w;
  }

  /** 流れてきた人の発言（子の会話）の発言者の語。最初の発言は依頼、人が直接送った発言はあなた、それ以外は追加の指示 */
  function liveUserWord(ev) {
    if (!config.nameTags) return null;
    if (ev.sentByHuman) return t("chat.message.you");
    return !historyPane.base && !thread.querySelector(".m.user") ? t("dialog.work.request") : t("dialog.work.instruction");
  }

  /**
   * 履歴の項目に、子の会話の行を足し引きする（history-pane の hooks.child.items）。
   * 追加の指示は injectTaskInstructions が決めた位置（受付の出来事・配送の id・錨・時刻）に置き、届いた発言の履歴の行（重複）は省く。
   * 最初の発言が依頼でないとき（記録に依頼が無い）は、依頼の行を先頭に足す。git の要約・作業ブランチの提示は出さない
   */
  function childItems(items, messages, base) {
    let rest = items.filter(it => !(it.kind === "present" && skipsPresent(it.p)));
    const list = childState.instructions;
    if (list.length) {
      // 指示を差し込むときは、発言の複製に通し番号を付けて渡す（ツールの錨で 1 つの発言が前後に分かれても、元の添字が分かる）
      const tagged = messages.map((m, i) => ({ ...m, __mi: base + i }));
      const injected = injectTaskInstructions(list, tagged);
      const last = new Map();
      injected.forEach((m, i) => { if (m.role !== "instruction") last.set(m.__mi, i); });
      const out = [];
      let p = 0;
      const push = (m, it) => out.push(m.role === "instruction"
        ? { kind: "instruction", instruction: m.instruction, at: m.at, sortAt: 0 }
        : { ...it, m, mi: m.__mi });
      for (const it of rest) {
        if (it.kind !== "msg") { out.push(it); continue; }
        const end = last.get(it.mi);
        if (end === undefined) continue;   // 届いた指示の履歴の行: 指示の行が代わりに出る
        for (; p <= end; p++) push(injected[p], it);
      }
      for (; p < injected.length; p++) if (injected[p].role === "instruction") push(injected[p]);
      rest = out;
    }
    if (!base && childState.prompt && messages[0]?.role !== "user") rest = [{ kind: "request", text: childState.prompt, at: messages[0]?.at, sortAt: 0 }, ...rest];
    return rest;
  }

  /** 子の会話の状態（バックエンド・走っているか・依頼の本文・途中送信を受けるか）を渡す。履歴を描く前と、状態が変わったときに呼ぶ */
  function setChild(next = {}) {
    Object.assign(childState, next);
  }

  /** 追加の指示の一覧を、描く前に渡す（最初に描く履歴が使う。ここにある指示は、最初の描画が置く） */
  function setInstructions(list) {
    childState.instructions = list ?? [];
    childState.seen = new Set(childState.instructions.map(x => x.id));
  }

  /**
   * 描いた後に追加の指示の一覧が変わった（受け付けた・渡った・届かず終わった・待機になった）: 描いてある行の状態を替え、
   * 描いたときに無かった指示は、稼働表示の手前（末尾）に足す。描いたときにあった指示を足し直さない（履歴の発言に任せたものがある）
   */
  function syncInstructions(list) {
    childState.instructions = list ?? [];
    const opts = { live: childState.live, steer: childState.steer };
    for (const x of childState.instructions) {
      const old = thread.querySelector(`:scope > .mw[data-key="instruction:${CSS.escape(String(x.id))}"]`);
      if (old) {
        const fresh = instructionRow(x, opts);
        if (fresh.innerHTML !== old.innerHTML || fresh.className !== old.className) { fresh.dataset.h = old.dataset.h ?? ""; if (!fresh.dataset.h) delete fresh.dataset.h; old.replaceWith(fresh); }
      } else if (!childState.seen.has(x.id)) {
        childState.seen.add(x.id);
        closeTurnEl();
        const stick = !isBusy() && atBottom();
        place(instructionRow(x, opts));
        if (stick) log.scrollTop = log.scrollHeight;
      }
    }
  }

  /** 追加の指示のまわりの出来事か（描くのは apply でなく、指示の一覧の読み直し） */
  const isInstructionEvent = (ev) => ev?.type === "taskInstruction"
    || (/^userMessage/.test(ev?.type ?? "") && typeof ev.messageId === "string" && ev.messageId.startsWith("task-send-"));

  /** 実例を閉じる: 取り置き・描く仕事・タイマーを止める。行は残す（呼ぶ側が本文ごと捨てる）。閉じた実例は使わない */
  function dispose() {
    spineWatch?.disconnect();
    if (spineFrame !== null) cancelAnimationFrame(spineFrame);
    spineFrame = null;
    loads.cancel();
    settling?.abort();
    historyPane.dispose();
    liveTurn.resetLiveTurn();
    liveTurn.runningTools.clear();
  }

  /** 走っている子は末尾に稼働表示（弧だけ）を置く。ホストに届かない間・承認を待つ間は、その言い方に替える */
  function activityRow({ hostOffline = null, waiting = false } = {}) {
    const act = el("div", "m activity");
    if (hostOffline) {
      act.append(el("span", "txt", t("dialog.work.hostOfflineThread")),
        el("span", "el", hostOffline.time ? t("dialog.work.hostOfflineCatchUp", { time: hostOffline.time }) : t("dialog.work.hostOfflineCatchUpNoTime")));
    } else if (waiting) act.append(el("span", "txt", t("activity.waitingApproval")));
    const tip = el("span", "activity-tip");
    const mark = hostOffline ? satMark(1, t("dialog.work.hostOfflineMark")) : runMark(t("activity.turnRunning"));
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", hostOffline ? t("dialog.work.hostOfflineMark") : t("activity.turnRunning"));
    tip.append(mark);
    act.prepend(tip);
    return wrap(act, "activity");
  }

  return {
    role,
    config,
    get sessionId() { return here(); },
    log, thread, frame,
    loads, liveTurn, historyPane,
    get replaying() { return replaying; },
    set replaying(on) { replaying = on; },
    get displayLoad() { return displayLoad; },
    set displayLoad(load) { displayLoad = load; },
    get initialMessageId() { return initialMessageId; },
    set initialMessageId(id) { initialMessageId = id; },
    nextSeq: () => ++seq,
    prepare, adopt, paint, finish, branchAnchor,
    apply, messageRow, markDelivery, ensureMessageRow, syncOutboxRows, settleSending, clearDeliveryTimer,
    userWord, historyRowOptions, skipsPresent, instructionRow, activityRow,
    childState, childItems, setChild, setInstructions, syncInstructions, isInstructionEvent, dispose,
    atBottom, followBottom, scrollToEnd, relayoutBranches, wrap, place, append,
  };
}
