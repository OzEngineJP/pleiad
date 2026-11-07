import assert from 'node:assert/strict';
import { grokQuota } from '../../core/backends/grok-usage.mjs';
import { createGrokBackend } from '../../core/backends/grok.mjs';
import { t as translate } from '../../core/i18n.mjs';
import { createUsageMonitor } from '../../core/delegation-usage.mjs';
import { normalizeSettings, route } from '../../core/delegation-routing.mjs';

export const name = 'grok-usage';
export const title = 'Grok: live billing quota, legacy fallback and private read-only ACP lifecycle';

const billing = { subscription_tier: 'SuperGrok', config: {
  creditUsagePercent: 23.5,
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-18T00:00:00Z', end: '2026-10-25T00:00:00Z' },
  monthlyLimit: { val: 1000 }, used: { val: 999 },
} };

export default async function test(t) {
  const quota = grokQuota(billing);
  assert.equal(quota.plan, 'SuperGrok');
  assert.deepEqual(quota.windows, [{ label: translate('usage.window.weekly'), usedPercent: 23.5,
    remainingPercent: 76.5, resetsAt: '2026-10-25T00:00:00.000Z', minutes: 10080 }]);
  assert.equal(grokQuota({ config: { ...billing.config, creditUsagePercent: 0 } }).windows[0].usedPercent, 0);
  assert.equal(grokQuota({ config: { ...billing.config, creditUsagePercent: 100 } }).windows[0].remainingPercent, 0);
  const legacy = grokQuota({ config: { monthlyLimit: { val: '1000' }, used: { val: '250' }, billingPeriodEnd: '2026-11-01T00:00:00Z' } });
  assert.equal(legacy.windows[0].usedPercent, 25);
  assert.equal(legacy.windows[0].label, translate('usage.window.monthly'));
  assert.equal(legacy.windows[0].minutes, null);
  assert.equal(grokQuota({ config: { monthlyLimit: { val: 100 }, used: {} } }).windows[0].usedPercent, 0);
  for (const config of [null, {}, { monthlyLimit: { val: 100 } }, { monthlyLimit: {}, used: {} },
    { monthlyLimit: { val: 100 }, used: { val: null } }, { monthlyLimit: { val: 100 }, used: [] },
    { creditUsagePercent: 101 }, { creditUsagePercent: -1 }, { creditUsagePercent: '22' }]) {
    assert.equal(grokQuota({ config }).windows.length, 0);
    assert.equal(grokQuota({ config }).message, translate('grok.usageUnknown'));
  }
  assert.equal(grokQuota({ config: { creditUsagePercent: 11, currentPeriod: { end: 'invalid' } } }).windows[0].resetsAt, null);
  t.ok('shared weekly percentage takes precedence; legacy monthly cents and unknown values remain honest', true);

  const now = Date.parse('2026-10-20T00:00:00Z');
  const unused = { subscription_tier: 'SuperGrok Lite', config: {
    isUnifiedBillingUser: true, currentPeriod: billing.config.currentPeriod, prepaidBalance: { val: 0 },
  } };
  const omitted = grokQuota(unused, { now });
  assert.equal(omitted.windows[0].usedPercent, 0);
  assert.equal(omitted.windows[0].remainingPercent, 100);
  assert.equal(omitted.windows[0].minutes, 10080);
  assert.equal(omitted.windows[0].resetsAt, '2026-10-25T00:00:00.000Z');
  assert.equal(omitted.usageSource, 'implicit_zero');
  assert.equal(omitted.message, null);
  const month = grokQuota({ config: { ...unused.config, currentPeriod: {
    type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z',
  } } }, { now });
  assert.equal(month.windows[0].usedPercent, 0);
  assert.equal(month.windows[0].label, translate('usage.window.monthly'));
  assert.equal(month.windows[0].minutes, null);
  assert.equal(grokQuota(unused, { now: Date.parse(unused.config.currentPeriod.start) }).windows[0].usedPercent, 0);
  assert.equal(grokQuota(unused, { now: Date.parse(unused.config.currentPeriod.end) }).windows.length, 0);
  const numeric = grokQuota({ config: { ...unused.config, creditUsagePercent: 1 } }, { now });
  assert.equal(numeric.windows[0].usedPercent, 1);
  assert.equal(numeric.usageSource, undefined);
  const legacyWithPeriod = grokQuota({ config: { ...unused.config, monthlyLimit: { val: 100 }, used: { val: 25 } } }, { now });
  assert.equal(legacyWithPeriod.windows[0].usedPercent, 25);
  assert.equal(legacyWithPeriod.windows[0].label, translate('usage.window.monthly'));
  for (const change of [
    { isUnifiedBillingUser: false }, { isUnifiedBillingUser: undefined },
    { creditUsagePercent: null }, { creditUsagePercent: undefined }, { creditUsagePercent: '0' },
    { creditUsagePercent: -1 }, { creditUsagePercent: 101 }, { creditUsagePercent: NaN },
    { currentPeriod: null }, { currentPeriod: {} },
    ...[{ type: 'unknown' }, { start: null }, { start: 'invalid' }, { end: null }, { end: 'invalid' },
      { start: '2026-10-21T00:00:00Z' }, { end: '2026-10-19T00:00:00Z' },
      { start: '2026-10-25T00:00:00Z', end: '2026-10-18T00:00:00Z' }]
      .map(change => ({ currentPeriod: { ...unused.config.currentPeriod, ...change } })),
    { monthlyLimit: { val: 0 }, used: { val: 0 } }, { monthlyLimit: { val: 100 } }, { used: {} },
    { creditUsagePercent: null, monthlyLimit: { val: 100 }, used: { val: 25 } },
  ]) {
    const invalid = grokQuota({ config: { ...unused.config, ...change } }, { now });
    assert.equal(invalid.windows.length, 0, JSON.stringify(change));
    assert.equal(invalid.usageSource, undefined);
    assert.equal(invalid.message, translate('grok.usageUnknown'));
  }
  assert.equal(grokQuota(unused, { now: NaN }).windows.length, 0);
  t.ok('only an omitted percentage in an active unified weekly or monthly period represents zero', true);

  let routingBilling = unused;
  const settings = normalizeSettings({
    tiers: { t1: [], t2: ['grok:grok-4.7', 'devin:swe-2-high'], t3: [], t4: [] },
    table: { mechanical: ['t2', 't2', 't2'] },
  });
  const monitor = createUsageMonitor({
    backends: () => ['grok', 'devin'].map(id => ({ id, usage: async () => {} })),
    read: async backend => ({ ...(backend.id === 'grok' ? grokQuota(routingBilling, { now })
      : { windows: [{ label: 'daily', minutes: 1440, usedPercent: 0 }] }), checkedAt: now }),
    candidates: () => settings.tiers.t2, modelKnown: async () => true,
  });
  const choose = blocked => route({ kind: 'mechanical', settings, usage: monitor.snapshot(), now, blocked });
  await monitor.refresh();
  assert.equal(choose().routing.target.backend, 'grok');
  assert.equal(choose().routing.selectedWithLowHeadroom, undefined);
  assert.equal(choose().routing.skipped.length, 0);
  assert.equal(choose(backend => backend === 'grok' ? { reason: 'recently_limited' } : null).routing.target.backend, 'devin');
  routingBilling = { config: { ...unused.config, creditUsagePercent: 1 } };
  await monitor.refresh();
  assert.equal(choose().routing.target.backend, 'grok');
  routingBilling = { config: { ...unused.config, creditUsagePercent: 100 } };
  await monitor.refresh();
  assert.equal(choose().routing.target.backend, 'devin');
  routingBilling = { config: {} };
  await monitor.refresh();
  assert.equal(choose().routing.target.backend, 'devin');
  t.ok('usage monitoring routes omitted zero and explicit one percent in candidate order, respecting limits and unknowns', true);

  const calls = [];
  let fail = null, closed = 0;
  class FakeAcp {
    async start() { calls.push('initialize'); }
    async call(method, params) {
      calls.push(method);
      assert.equal(method, '_x.ai/billing');
      assert.deepEqual(params, {});
      if (fail) throw fail;
      return billing;
    }
    async close() { closed++; }
  }
  const backend = createGrokBackend({ Acp: FakeAcp, command: () => ['grok-fixture'] });
  assert.deepEqual(await backend.usage(), quota);
  assert.deepEqual(calls, ['initialize', '_x.ai/billing']);
  assert.equal(closed, 1);
  fail = new Error('SYNTHETIC_SECRET https://invalid.test/?token=SYNTHETIC_SECRET');
  const failed = await backend.usage();
  assert.equal(failed.windows.length, 0);
  assert.equal(failed.checkedAt, null);
  assert.equal(failed.message, translate('grok.usageFetchFailed'));
  assert.equal(JSON.stringify(failed).includes('SYNTHETIC_SECRET'), false);
  assert.equal(closed, 2);
  fail = Object.assign(new Error('private auth detail'), { code: -32002 });
  assert.equal((await backend.usage()).message, translate('grok.usageNoCredentials'));
  assert.equal(closed, 3);
  t.ok('billing reads create no session or model request, close their client and hide failure details', true);
}
