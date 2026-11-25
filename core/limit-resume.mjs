// 使用量の上限で止まった会話の、解除時刻・枠の読み取り（ADR 0161・0352。docs/design.md「中断と再開」）。
// 上限は、エージェントが実際にターンを断ったときだけ「止まった」と数える（先回りして止めない。ADR 0352）。
// 止まった会話は自動では再開せず、解除時刻は情報として保存・表示するだけで、人の送信も待たせない。
// 副作用を持たない関数だけを置く。

/**
 * 保存する解除時刻。分かって未来ならその時刻、分からない・もう過ぎている（取得元が古い）なら null。
 * 過ぎた時刻のまま残すと、末尾の「◯◯ に解除」が過去を指す
 */
export const limitResetsAt = (resetsAt, now = Date.now()) => (Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : null);

const CLAUDE_ACCOUNT_WINDOWS = new Set(['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_overage_included', 'overage']);
const CLAUDE_MODEL_WINDOWS = new Set(['seven_day_opus', 'seven_day_sonnet']);

export function claudeLimitScope(window) {
  if (CLAUDE_ACCOUNT_WINDOWS.has(window)) return 'account';
  if (CLAUDE_MODEL_WINDOWS.has(window)) return 'model';
}

/** 保存済みの Claude の中断は、枠の名前だけでも単体の上限を判定できる。 */
export function limitScope(limit) {
  return limit.scope ?? (limit.backend === 'claude' ? claudeLimitScope(limit.window) : undefined); // backend-allow: 保存済みの Claude 固有の枠名を解釈する
}

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
