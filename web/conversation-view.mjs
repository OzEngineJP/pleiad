// 会話の本文の面を束ねる部品（ADR 0319 段 6-5）。web/client.mjs から動かしただけ。
// 進行中のターン（web/live-turn.mjs）と履歴の面（web/history-pane.mjs）の実例、履歴を読む間の出来事の取り置き（createSessionLoads）、
// 筋への行の置き方（wrap・place・append・末尾へ送る）を、この実例が持つ。主の会話の 1 つだけが使う（子の会話は段 6-6 から）。
// この部品は主の会話の値（state.current など）を直に読まない。必要なものは次の hooks で受ける。
//   isRunning() / stopping() / behind() / backgroundCounts() / turnStart()   進行中のターンの問い（live-turn.mjs の hooks と同じ）
//   aiMsg(opts) / stopComputer(bundle) / onActivity()                          進行中のターンの下請け
//   isBusy()                                                                   今、送信などで手が塞がっているか（行を足したとき末尾へ付いていくかの判定）
//   会話を開く（paint）: setUuid(m, uuid) / isEditing() / syncOutboxRows(sessionId) / onEvent(ev, replay) / batchPaint(fn)
//   歴史の面の下請け（history-pane.mjs の hooks と同じ）: spine, placeJunctions, paintDelegateStates, paintCompactions, syncEdit, paintable,
//     updateBranches, cmd, select, finalizing, systemHistoryNode, stripActions, userMsg, noteEndpointFailure, linkDelegateCard,
//     activeBackendId, subagentToolsOf, isBoundaryTool, currentSession, isLoadingSession, backendVocab
import { el } from "./dom.mjs";
import { layoutBranchSpine } from "./branch-view.mjs";
import { createSessionLoads } from "./session-stream.mjs";
import { createLiveTurn } from "./live-turn.mjs";
import { createHistoryPane } from "./history-pane.mjs";

// 役ごとの設定。主は今の動きのまま
const ROLES = {
  main: { branches: true },
  child: { branches: false },
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
    const tick = () => { log.scrollTop = log.scrollHeight; if (performance.now() < end) requestAnimationFrame(tick); };
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

  /** 分岐の筋の置き直し。分岐を持たない役（子）は何もしない */
  function relayoutBranches() { if (!replaying && config.branches) layoutBranchSpine(thread); }

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
    hooks.syncOutboxRows(id);
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
    atBottom, followBottom, scrollToEnd, relayoutBranches, wrap, place, append,
  };
}
