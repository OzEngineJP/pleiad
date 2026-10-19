import assert from 'node:assert/strict';
import { grokQuota } from '../../core/backends/grok-usage.mjs';
import { createGrokBackend } from '../../core/backends/grok.mjs';
import { t as translate } from '../../core/i18n.mjs';

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
