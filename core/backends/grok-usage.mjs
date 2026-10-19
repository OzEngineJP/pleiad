import { usageWindow } from '../usage.mjs';
import { t } from '../i18n.mjs';

const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const cents = value => value && typeof value === 'object' && !Array.isArray(value)
  ? nonnegative(typeof value.val === 'string' && /^\d+$/.test(value.val) ? Number(value.val) : Object.hasOwn(value, 'val') ? value.val : 0) : null;

/** Grok's read-only billing extension; prefer the shared usage pool over legacy monthly cents. */
export function grokQuota(data) {
  const config = data?.config;
  const plan = typeof data?.subscription_tier === 'string' ? data.subscription_tier : null;
  const unknown = () => ({ plan, windows: [], message: t('grok.usageUnknown') });
  if (!config || typeof config !== 'object') return unknown();
  let used = nonnegative(config.creditUsagePercent);
  let period = config.currentPeriod ?? (config.billingPeriodEnd ? { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: config.billingPeriodEnd } : null);
  if (config.creditUsagePercent != null && used == null) return unknown();
  if (config.creditUsagePercent == null) {
    // Absence means unknown. Only a present empty Cent object represents zero.
    const limit = cents(config.monthlyLimit), spent = cents(config.used);
    if (limit == null || limit <= 0 || spent == null) return unknown();
    used = 100 * spent / limit;
    period = { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: config.billingPeriodEnd };
  }
  if (!Number.isFinite(used) || used > 100) return unknown();
  const weekly = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY';
  const monthly = period?.type === 'USAGE_PERIOD_TYPE_MONTHLY';
  const label = weekly ? t('usage.window.weekly') : monthly ? t('usage.window.monthly') : t('usage.window.unknown');
  const window = usageWindow(label, used, period?.end ?? null, weekly ? 10080 : null);
  return { plan, windows: [window], message: null };
}
