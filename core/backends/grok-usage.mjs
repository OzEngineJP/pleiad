import { usageWindow } from '../usage.mjs';
import { t } from '../i18n.mjs';

const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const cents = value => value && typeof value === 'object' && !Array.isArray(value)
  ? nonnegative(typeof value.val === 'string' && /^\d+$/.test(value.val) ? Number(value.val) : Object.hasOwn(value, 'val') ? value.val : 0) : null;

function omittedZero(config, now) {
  if (config.isUnifiedBillingUser !== true || Object.hasOwn(config, 'monthlyLimit') || Object.hasOwn(config, 'used')) return false;
  const period = config.currentPeriod;
  if (!['USAGE_PERIOD_TYPE_WEEKLY', 'USAGE_PERIOD_TYPE_MONTHLY'].includes(period?.type)) return false;
  if (typeof period.start !== 'string' || typeof period.end !== 'string') return false;
  const start = Date.parse(period.start), end = Date.parse(period.end);
  return Number.isFinite(now) && start <= now && now < end;
}

/** Grok's read-only billing extension; prefer the shared usage pool over legacy monthly cents. */
export function grokQuota(data, { now = Date.now() } = {}) {
  const config = data?.config;
  const plan = typeof data?.subscription_tier === 'string' ? data.subscription_tier : null;
  const unknown = () => ({ plan, windows: [], message: t('grok.usageUnknown') });
  if (!config || typeof config !== 'object' || Array.isArray(config)) return unknown();
  let used = nonnegative(config.creditUsagePercent);
  let period = config.currentPeriod ?? (config.billingPeriodEnd ? { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: config.billingPeriodEnd } : null);
  const hasPercent = Object.hasOwn(config, 'creditUsagePercent');
  let usageSource = null;
  if (hasPercent && used == null) return unknown();
  if (!hasPercent) {
    const limit = cents(config.monthlyLimit), spent = cents(config.used);
    if (limit != null && limit > 0 && spent != null) {
      used = 100 * spent / limit;
      period = { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: config.billingPeriodEnd };
    } else if (omittedZero(config, now)) {
      // Unified billing omits the percentage at zero; a current period distinguishes it from an empty response.
      used = 0;
      usageSource = 'implicit_zero';
    } else return unknown();
  }
  if (!Number.isFinite(used) || used > 100) return unknown();
  const weekly = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY';
  const monthly = period?.type === 'USAGE_PERIOD_TYPE_MONTHLY';
  const label = weekly ? t('usage.window.weekly') : monthly ? t('usage.window.monthly') : t('usage.window.unknown');
  const window = usageWindow(label, used, period?.end ?? null, weekly ? 10080 : null);
  return { plan, windows: [window], message: null, ...(usageSource ? { usageSource } : {}) };
}
