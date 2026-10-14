// バックエンドが共通で使う小さな定数と道具。SDK にもネットワークにも依存しない。
import { PR_URL } from "../git-timeline.mjs";

// ツールの結果は数百 KB になることがある。表示に要るのは行数・件数・成否と先頭だけなので
// （web/render.mjs の applyToolResult は全文を出さない）、**履歴に残す時点で**切っておく。
// ライブのイベントは切らない（v1 が生の SDK メッセージを素通ししていたのと同じ見た目にする）。
export const MAX_RESULT_CHARS = 2000;

/**
 * ツールの結果を max 文字で切って notice を付ける。切り捨てる側（末尾）に PR の URL があれば、notice の後ろへ 1 行で残す
 * （gh pr create は作った PR の URL を最後に出す。切ると履歴から PR が拾えなくなる。docs/git-design の「PR の決め方」）。
 */
export function cutText(text, max, notice) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const urls = [...s.slice(max).matchAll(new RegExp(PR_URL.source, "g"))];
  return s.slice(0, max) + notice + (urls.length ? `
${urls.at(-1)[0]}` : "");
}

/** capabilities の既定。バックエンドは持てるものだけ true にする。 */
export const NO_CAPABILITIES = {
  title: false,
  tag: false,
  fork: false,
  subagents: false,
  liveModel: false,
  liveMode: false,
  hostTools: false,
  // ply_agents（委譲の橋）を受け取れるか。受け取れる会話にだけ Pleiad の指示を入れる（core/ply-instructions.mjs）
  plyAgents: false,
  alwaysAllow: false,
  login: false,
};
