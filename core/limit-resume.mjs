// 使用量の上限で止まった会話の、解除時刻の判断（ADR 0161。docs/design.md「中断と再開」）。
// 上限で止まった会話は自動では再開しない。上限中に人が送った指示を、解除時刻まで送信待ちに置くかだけを決める。
// 副作用を持たない関数だけを置く（待ちの置き方・送信待ちを流すのは core/server.mjs）。

/**
 * 保存する解除時刻。分かって未来ならその時刻、分からない・もう過ぎている（取得元が古い）なら null。
 * 過ぎた時刻のまま残すと、末尾の「◯◯ に解除」が過去を指す
 */
export const limitResetsAt = (resetsAt, now = Date.now()) => (Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : null);

/** 上限中に送った指示を、送信待ちに置いて API に流さないか。解除時刻の前だけ待たせる。解除時刻が分からない上限は待たせない */
export const limitHolds = (limit, now = Date.now()) => Number.isFinite(limit?.resetsAt) && limit.resetsAt > now;

/**
 * エージェントへ渡す文の時刻（解除・再試行の見込み）。この PC の時刻で、時差を添える（例: 2026-10-18 14:05 (UTC+09:00)）。
 * 依頼元のエージェントが人へそのまま伝えても読み違えない形にする
 */
export function clockText(ms) {
  const d = new Date(ms);
  const pad = n => String(Math.abs(n)).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)})`;
}
