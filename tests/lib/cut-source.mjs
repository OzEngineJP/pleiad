// web/ のソースの文字列から、関数や塊を切り出して vm へ入れるテストの共通の道具。
// 進行中のターンの部分は web/live-turn.mjs の createLiveTurn の中、履歴の面は web/history-pane.mjs の createHistoryPane の中、
// 筋への置き方などは web/conversation-view.mjs の createConversationView の中にある（ADR 0319 段 6-3・6-4・6-5）。字下げされているので、閉じの `}` は関数の行と同じ字下げで探す。
// 字下げが無い関数（client.mjs の最上位）では今までと同じ切り方になる。
import fs from "node:fs";
import vm from "node:vm";

/** web/ の相対パスのソースを、改行を LF にして読む */
export function readWeb(rel) {
  return fs.readFileSync(new URL(`../../web/${rel}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
}

/** `function name(`（`async ` 付きも）から、同じ字下げの閉じの `}` までを返す。無ければ空文字 */
export function cutFunction(source, name, { withAsync = false } = {}) {
  let start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  if (withAsync && source.slice(start - 6, start) === "async ") start -= 6;
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const indent = source.slice(lineStart, start).match(/^ */)[0];
  const close = `\n${indent}}`;
  return source.slice(start, source.indexOf(close, start) + close.length);
}

/** web/live-turn.mjs（進行中のターンの描画）のソース */
export const readLiveTurn = () => readWeb("live-turn.mjs");

/** web/history-pane.mjs（履歴の面の描画）のソース */
export const readHistoryPane = () => readWeb("history-pane.mjs");

/** web/conversation-view.mjs（会話の本文の面。筋への置き方・本文の面の束ね）のソース */
export const readConversationView = () => readWeb("conversation-view.mjs");

/**
 * conversation-view.mjs・client.mjs・live-turn.mjs・history-pane.mjs をつないだソース。どれにある関数でも cutFunction で切り出せる。
 * client.mjs の同名の関数は 1 行の委任（本体は view の中）なので、view を先に置いて本体の方を先に見つける
 */
export const readClientAndLiveTurn = () => `${readConversationView()}\n${readWeb("client.mjs")}\n${readLiveTurn()}\n${readHistoryPane()}`;


/**
 * 主の会話の mainView（web/conversation-view.mjs）のうち、会話を開く仕事（prepare・adopt・paint・finish）だけを、切り出した関数として vm へ入れる。
 * 実物の createConversationView は自前の履歴の面・進行中のターンを作るので、描く部分を作りものにしたいテストはこちらを使う。
 * vm に要るもの: state・sessionLoads・thread・log・historyPane（作りものの持ち物。持たない関数は同名の vm の関数へ回る）・
 * setUuid・chatEdit・syncEdit・paintCompactions・syncOutboxRows・outboxes・onEvent・batchToolMeasurements・batchTerminalUpdates・batchToolUpdates・
 * runningTools・closeTurnEl・flushStream・relayoutBranches・scrollToEnd・requestAnimationFrame。
 * state の messages ほか・displayLoad・initialMessageId は、本物では実例の持ち物へつながる（ここでは state の同名の項目へつなぐ）
 */
export function openBridge(viewSource = readConversationView()) {
  const functions = ["prepare", "adopt", "branchAnchor", "paint", "finish"].map(name => cutFunction(viewSource, name, { withAsync: true })).join("\n");
  // 出来事を描く apply と、送った発言の行・配達の合図（view の中の const 群。NO_VOICE から retryLabel の終わりまで）
  const deliveryHead = viewSource.indexOf("const NO_VOICE");
  const deliveryTail = viewSource.indexOf("const {\n    activity, runningTools", deliveryHead);
  if (deliveryHead < 0 || deliveryTail < 0) throw new Error("web/conversation-view.mjs に配達の行の一群が無い");
  const delivery = viewSource.slice(deliveryHead, deliveryTail);
  const apply = cutFunction(viewSource, "apply").replaceAll("displayLoad", "state.displayLoad");   // 本物では実例の持ち物。ここでは state の同名の項目
  return `const mainView = (() => {
  let replaying = false, seq = 0;
  const loads = sessionLoads;
  const here = () => state.current;
  const isCurrent = (id, load) => state.current === id && state.displayLoad === load;
  const explicit = {
    setUuid: (m, uuid) => setUuid(m, uuid), isEditing: () => chatEdit.active, syncEdit: () => syncEdit(), paintCompactions: () => paintCompactions(),
    outbox: (id) => outboxes.get(id) ?? [], onEvent: (ev, replay) => onEvent(ev, replay),
    batchPaint: (fn) => batchToolMeasurements(() => batchTerminalUpdates(() => batchToolUpdates(() => runningTools.batch(fn)))),
    isLoadingSession: () => state.loadingSession, isBusy: () => state.busy, currentSession: () => state.current,
  };
  const g = globalThis;
  const fallback = (target) => new Proxy(target, { get: (own, key) => key in own ? own[key] : typeof g[key] === 'function' ? (...args) => g[key](...args) : g[key] });
  const hooks = fallback(explicit);
  const liveTurn = fallback({ closeTurnEl: () => closeTurnEl(), flushStream: () => flushStream() });
  const relayoutBranches = () => globalThis.relayoutBranches();
  const scrollToEnd = () => globalThis.scrollToEnd();
  const own = globalThis.historyPane;
  const bound = ${JSON.stringify(HISTORY_STATE_KEYS)};
  const historyPane = new Proxy(own, {
    get: (target, key) => bound.includes(key) ? state[key] : key in target ? target[key] : (...args) => globalThis[key](...args),
    set: (target, key, value) => { if (bound.includes(key)) state[key] = value; else target[key] = value; return true; },
  });
  let initialMessageId;
  const { isBusy, isLoadingSession } = hooks;
  const atBottom = () => g.atBottom();
  ${delivery}
  ${functions}
  ${apply}
  const mirrored = adopt;
  return {
    prepare, adopt: (data) => { mirrored(data); state.initialMessageId = initialMessageId; }, paint, finish, branchAnchor,
    apply, messageRow, markDelivery, ensureMessageRow, syncOutboxRows, settleSending, clearDeliveryTimer,
    get replaying() { return replaying; }, set replaying(on) { replaying = on; }, nextSeq: () => ++seq,
  };
})();`;
}

/** createLiveTurn の「状態」の宣言（let turnEl … const toolCards）。切り出した関数と同じ vm に先に入れる */
export function liveTurnStateDecl(liveSource = readLiveTurn()) {
  const from = liveSource.indexOf("  // 状態\n");
  const mark = "const toolCards = new Map();";
  const at = liveSource.indexOf(mark, from);
  if (from < 0 || at < 0) throw new Error("live-turn.mjs に状態の宣言が無い");
  return liveSource.slice(from, liveSource.indexOf("\n", at));
}

/**
 * createHistoryPane の「状態」の宣言（let messages … let backfill）。切り出した関数と同じ vm に先に入れる。
 * messages・base・presents・presentBase・earlierCalls は、本物では client の state の同名の項目からここへつながる
 */
export function historyPaneStateDecl(paneSource = readHistoryPane()) {
  const from = paneSource.indexOf("  // 状態\n");
  const mark = "let backfill = null;";
  const at = paneSource.indexOf(mark, from);
  if (from < 0 || at < 0) throw new Error("history-pane.mjs に状態の宣言が無い");
  return paneSource.slice(from, paneSource.indexOf("\n", at));
}

export const HISTORY_STATE_KEYS = ["messages", "base", "presents", "presentBase", "earlierCalls"];

/**
 * client の state の同名の項目（本物は createHistoryPane の実例へつながる）を、vm の中の宣言へつなぐ。
 * historyPaneStateDecl を vm へ入れた後に呼ぶ。state に初めから入れていた値は、つなぎ直した先へ写す
 */
export function bindHistoryState(state, context) {
  const initial = {};
  for (const key of HISTORY_STATE_KEYS) {
    if (key in state) initial[key] = state[key];
    Object.defineProperty(state, key, {
      get: () => vm.runInContext(key, context),
      set: (v) => { context.__historyValue = v; vm.runInContext(`${key} = __historyValue`, context); },
      enumerable: true, configurable: true,
    });
  }
  Object.assign(state, initial);
}

export const LIVE_STATE_KEYS = ["turnEl", "bundle", "pendingUuid", "endedWithText", "turnClosed", "streamEl", "thinkEl", "toolCards"];

/**
 * client の state の同名の項目（本物は createLiveTurn の実例へつながる）を、vm の中の宣言へつなぐ。
 * 切り出した client の関数が state.streamEl などを読み書きしても、切り出した live-turn の関数と同じ値を見る
 */
export function bindLiveState(state, context) {
  for (const key of LIVE_STATE_KEYS) {
    const desc = { get: () => vm.runInContext(key, context), enumerable: true, configurable: true };
    if (key !== "toolCards") desc.set = (v) => { context.__liveValue = v; vm.runInContext(`${key} = __liveValue`, context); };
    Object.defineProperty(state, key, desc);
  }
}
