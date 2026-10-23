// 走っている印（docs/design-system.md §6）。形はここで作り、動きは CSS に任せる。
// display:none の祖先の中では描画されず、document.hidden の間はアニメーションを一時停止する。
import { svgEl } from "./dom.mjs";

import { waitMark } from "./wait-mark.mjs";

if (document.addEventListener) {
  const pauseWhenHidden = () => document.documentElement.classList.toggle("page-hidden", document.hidden);
  document.addEventListener("visibilitychange", pauseWhenHidden);
  pauseWhenHidden();
}

/** 共通の待ちのドット。既存の呼び出し元も同じ部品を使う。 */
export function runMark(title) { return waitMark(title); }

/** 裏の作業の件数は文言で伝える。オフライン・古い状態は paused で静止する。 */
export function satMark(n, title, options) { return waitMark(title, options); }

// 終わったサブエージェント・Pleiad タスクの印（docs/design-system.md §2.2・§6）。動かない。
// 14×14・線幅 1.6・端は丸・currentColor（CSS は .state-mark）。色で意味を足さない。
// 青い丸（完了・未確認。塗りの円・--ink-unread）とは形で見分ける: どれも塗らない線画で、円を含まない。
//   done: チェック。web/icons.mjs の checkIcon（24×24 の m5 12 4 4L19 6）を中心 (12,11) から 0.6 倍して (7,7) に置いたもの
//   fail: ✕。ツールカードの「✕ 失敗」と同じ語彙。弧の半径 5 に収まる 3.5〜10.5
//   stop: 短い横線。止めた・途中で終わった
// 動かないので「走っているときだけ DOM に置く」（§6）の対象ではない。
const STILL_PATHS = {
  done: "M2.8 7.6 5.2 10 11.2 4",
  fail: "M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5",
  stop: "M4 7h6",
};

/** 静止した状態の印を 1 つ作る。shape は done / fail / stop。label は読み上げと title に使う */
export function stillMark(shape, label) {
  const span = document.createElement("span");
  span.className = `state-mark ${shape}`;
  span.setAttribute("role", "img");
  if (label) { span.setAttribute("aria-label", label); span.title = label; }
  const svg = svgEl("svg", { viewBox: "0 0 14 14", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: STILL_PATHS[shape] ?? "" }));
  span.append(svg);
  return span;
}
