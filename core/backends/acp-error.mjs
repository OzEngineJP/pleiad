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

// 短期の制限だけを対象にし、異常な解除秒数で枠を長期間除外しない。
const MAX_TURN_LIMIT_WINDOW_MS = 10 * 60_000;

// Cognition が再試行可能と明示した rate limit の相対秒数を使う。
// 時刻だけの UTC 表記は日付が曖昧。期限不明の limited は枠を無期限に除外するため、読めないものは error のままにする。
export function acpTurnLimit(error, now = Date.now()) {
  if (error?.data?.['cognition.ai/retryable'] !== true) return null;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 16_384) : '';
  if (!/\brate[ _-]?limit(?:ed|[ _-]exceeded)?\b/i.test(message)) return null;
  const seconds = /\breset in (\d+) seconds?\b/i.exec(message);
  if (!seconds || !Number.isFinite(now)) return null;
  const ms = Number(seconds[1]) * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TURN_LIMIT_WINDOW_MS) return null;
  const resetsAt = now + ms;
  return Number.isSafeInteger(resetsAt) && Number.isFinite(new Date(resetsAt).getTime()) ? { resetsAt } : null;
}
