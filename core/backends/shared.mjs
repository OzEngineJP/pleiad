// バックエンドが共通で使う小さな定数と道具。SDK にもネットワークにも依存しない。
import { PR_URL } from "../git-timeline.mjs";
import { isPlyDelegateToolName } from "../../web/delegate-result.mjs";

// ツールの結果は数百 KB になることがある。表示に要るのは行数・件数・成否と先頭だけなので
// （web/render.mjs の applyToolResult は全文を出さない）、**履歴に残す時点で**切っておく。
// ライブのイベントは切らない（v1 が生の SDK メッセージを素通ししていたのと同じ見た目にする）。
export const MAX_RESULT_CHARS = 2000;

// ply_delegate の結果は切らない。画面は結果の JSON の taskId でカードを子のタスクに結び付ける（web/delegate-result.mjs）ので、
// 切ると履歴から描いたカードの内訳がまるごと消える。結果は数 KB（振り分けの記録とタスクの状態）
export const keepsFullResult = (name) => isPlyDelegateToolName(name);

/** 履歴に載せるツールの結果を MAX_RESULT_CHARS で切る（keepsFullResult のツールと短い結果はそのまま返す） */
export function cutToolResult(name, result, notice) {
  const text = result?.text;
  if (typeof text !== "string" || text.length <= MAX_RESULT_CHARS || keepsFullResult(name)) return result;
  return { ...result, text: cutText(text, MAX_RESULT_CHARS, notice), truncated: true };
}

/**
 * ツールの結果を max 文字で切って notice を付ける。切り捨てる側（末尾）に PR の URL があれば、notice の後ろへ 1 行で残す
 * （gh pr create は作った PR の URL を最後に出す。切ると履歴から PR が拾えなくなる。docs/git-panel-pr.md の「PR の決め方」）。
 */
export function cutText(text, max, notice) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const urls = [...s.slice(max).matchAll(new RegExp(PR_URL.source, "g"))];
  return s.slice(0, max) + notice + (urls.length ? `
${urls.at(-1)[0]}` : "");
}

// 能力の印の一覧と既定（何も持たない形）は core/backends/capability-marks.mjs
