// web/ のソースの文字列から、関数や塊を切り出して vm へ入れるテストの共通の道具。
// 進行中のターンの部分は web/live-turn.mjs の createLiveTurn の中にある（ADR 0319 段 6-3）。字下げされているので、
// 閉じの `}` は関数の行と同じ字下げで探す。字下げが無い関数（client.mjs の最上位）では今までと同じ切り方になる。
import fs from "node:fs";

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
