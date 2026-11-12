// web/ のソースの文字列から、関数や塊を切り出して vm へ入れるテストの共通の道具。
// 進行中のターンの部分は web/live-turn.mjs の createLiveTurn の中、履歴の面は web/history-pane.mjs の createHistoryPane の中にある
// （ADR 0319 段 6-3・6-4）。字下げされているので、閉じの `}` は関数の行と同じ字下げで探す。
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

/** client.mjs・live-turn.mjs・history-pane.mjs をつないだソース。どれにある関数でも cutFunction で切り出せる */
export const readClientAndLiveTurn = () => `${readWeb("client.mjs")}\n${readLiveTurn()}\n${readHistoryPane()}`;

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
