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
