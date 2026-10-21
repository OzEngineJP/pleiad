import { t } from '../i18n.mjs';

/** Classify known provider failures without exposing RPC messages or data. */
export function acpRequestFailure(error, agent, fallback) {
  const data = error?.data;
  const text = [error?.message, data, data?.message, data?.details, data?.error, data?.error?.message]
    .filter(value => typeof value === 'string').map(value => value.slice(0, 16_384)).join('\n');
  const status = [error?.code, data?.status, data?.statusCode, data?.httpStatus];
  let message = fallback;
  if (/\busage balance exhausted\b|\bcredit balance is too low\b|\binsufficient[ _](?:balance|funds|credits?|quota)\b|\b(?:usage limit|quota) (?:reached|exceeded|exhausted)\b/i.test(text)) {
    message = t('acp.errors.usageExhausted', { agent });
  } else if (status.includes(402) || /\b(?:status(?: code)?\s*[:=]?\s*402|402 Payment Required)\b/i.test(text)) {
    message = t('acp.errors.paymentRequired', { agent });
  } else if (status.includes(429) || /\brate[ _-]?limit(?:ed|[ _-]exceeded)?\b|\btoo many requests\b|\bstatus(?: code)?\s*[:=]?\s*429\b/i.test(text)) {
    message = t('acp.errors.rateLimited', { agent });
  }
  return { message, code: Number.isSafeInteger(error?.code) ? error.code : -32000 };
}

// 解除の見込みの上限。free model の制限は数秒〜十数時間（実測 2026-10-21 に「10 hours 50 minutes」）。
// 桁あふれの値で枠を何日も外さないよう、1 日で切る。
const MAX_TURN_LIMIT_WINDOW_MS = 24 * 3600_000;
// 「0 seconds」や過ぎた時刻でも、過去の時刻にしない（過去の解除時刻は記録されず、枠が止まらない）
const MIN_TURN_LIMIT_WINDOW_MS = 1000;
// 併記の時刻（時:分）を相対の見込みより後として採る幅。分の切り上げ（10 秒後が「1 分後の時:分」）の分だけ。
// 離れすぎた時刻は日付か時計の食い違いとみなし、相対の見込みを使う
const ABSOLUTE_SLACK_MS = 2 * 60_000;
const UNIT_MS = { day: 86_400_000, hour: 3_600_000, hr: 3_600_000, minute: 60_000, min: 60_000, second: 1000, sec: 1000 };

/** 「reset in 10 hours 50 minutes」「reset in 1 minute」「reset in 8 seconds」の長さ（ms）。読めなければ null */
function relativeMs(message) {
  const head = /\breset(?:s)? in ((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\b[\s,]*(?:and\s+)?)+)/i.exec(message);
  if (!head) return null;
  let ms = 0;
  for (const [, n, unit] of head[1].matchAll(/(\d+)\s*(day|hour|hr|minute|min|second|sec)s?\b/gi)) ms += Number(n) * UNIT_MS[unit.toLowerCase()];
  return Number.isFinite(ms) ? ms : null;
}

/** 「(at 09:19 UTC)」の時刻。今より 1 分以上前なら翌日として読む（時:分だけで日付が無い）。読めなければ null */
function absoluteAt(message, now) {
  const m = /\bat (\d{1,2}):(\d{2})\s*UTC\b/i.exec(message);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2]));
  if (at < now - 60_000) at += 86_400_000;
  return Number.isFinite(at) ? at : null;
}

// Cognition が再試行可能と明示した rate limit を limited にする（Issue #111）。
// 解除の見込みは、相対（N seconds・N minute(s)・N hours N minutes）と併記の時刻（at HH:MM UTC）の遅い方。時刻だけでも読む。
// 見込みは下限で、次の試行では後ろへずれる（同じ枠の再発で保留を延ばすのは core/slot-limits.mjs）。
// どちらも読めない文面は、解除時刻の分からない limited（resetsAt: null）。error にすると枠が止まらず、自動の振り分けが同じ枠を選び直す
export function acpTurnLimit(error, now = Date.now()) {
  if (error?.data?.['cognition.ai/retryable'] !== true) return null;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 16_384) : '';
  if (!/\brate[ _-]?limit(?:ed|[ _-]exceeded)?\b/i.test(message)) return null;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now + MAX_TURN_LIMIT_WINDOW_MS).getTime()) || !Number.isFinite(new Date(now).getTime())) return null;
  const rel = relativeMs(message);
  const abs = absoluteAt(message, now);
  let resetsAt = null;
  if (rel != null) {
    resetsAt = now + Math.min(rel, MAX_TURN_LIMIT_WINDOW_MS);
    if (abs != null && abs > resetsAt && abs - resetsAt <= ABSOLUTE_SLACK_MS) resetsAt = abs;
  } else if (abs != null) resetsAt = abs;
  if (resetsAt == null) return { resetsAt: null };
  resetsAt = Math.min(Math.max(resetsAt, now + MIN_TURN_LIMIT_WINDOW_MS), now + MAX_TURN_LIMIT_WINDOW_MS);
  return Number.isSafeInteger(resetsAt) ? { resetsAt } : { resetsAt: null };
}
