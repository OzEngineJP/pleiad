// web/ のソースの文字列から、関数や塊を切り出して vm へ入れるテストの共通の道具。
// 進行中のターンの部分は web/live-turn.mjs の createLiveTurn の中にある（ADR 0319 段 6-3）。字下げされているので、
// 閉じの `}` は関数の行と同じ字下げで探す。字下げが無い関数（client.mjs の最上位）では今までと同じ切り方になる。
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

/** client.mjs と live-turn.mjs をつないだソース。どちらにある関数でも cutFunction で切り出せる */
export const readClientAndLiveTurn = () => `${readWeb("client.mjs")}\n${readLiveTurn()}`;

/** createLiveTurn の「状態」の宣言（let turnEl … const toolCards）。切り出した関数と同じ vm に先に入れる */
export function liveTurnStateDecl(liveSource = readLiveTurn()) {
  const from = liveSource.indexOf("  // 状態\n");
  const mark = "const toolCards = new Map();";
  const at = liveSource.indexOf(mark, from);
  if (from < 0 || at < 0) throw new Error("live-turn.mjs に状態の宣言が無い");
  return liveSource.slice(from, liveSource.indexOf("\n", at));
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
