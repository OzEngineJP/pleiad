import { createHash } from 'node:crypto';
import { whamQuota, usageWindow } from '../usage.mjs';
import { readAccountAuth } from './opencode-accounts.mjs';
import { t } from '../i18n.mjs';

const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
// Stable credential generation allows persisted quotas to survive a restart.
// Only the digest is retained; credentials never enter quota snapshots or logs.
const identityOf = c => createHash('sha256').update(JSON.stringify(c ?? null)).digest('hex');

export function goQuota(data) {
  const periods = [['rolling', 'fiveHour', 300], ['weekly', 'weekly', 10080], ['monthly', 'monthly', null]];
  const windows = periods.map(([key, label, minutes]) => {
    const w = data?.usage?.[key];
    if (!nonnegative(w?.percent) || w.percent > 100 || typeof w.resetsAt !== 'string' || !Number.isFinite(Date.parse(w.resetsAt)))
      throw new Error('Invalid Go usage');
    return { ...usageWindow(`Go ${t(`usage.window.${label}`)}`, w.percent, w.resetsAt, minutes), provider: 'opencode-go', resetRequiresRefresh: true };
  });
  return { plan: null, windows, message: null };
}

export function copilotQuota(data) {
  const labels = {
    premium_interactions: t('opencode.usage.copilotPremiumRequests'), premium_models: t('opencode.usage.copilotPremiumModels'),
    chat: t('opencode.usage.copilotChat'), completions: t('opencode.usage.copilotCompletions'),
  };
  const windows = ['premium_interactions', 'premium_models', 'chat', 'completions'].flatMap(key => {
    const s = data?.quota_snapshots?.[key];
    if (!s || s.unlimited === true || s.entitlement === -1) return [];
    const remaining = nonnegative(s.percent_remaining) && s.percent_remaining <= 100 ? s.percent_remaining
      : nonnegative(s.remaining) && nonnegative(s.entitlement) && s.entitlement > 0 ? Math.min(100, s.remaining / s.entitlement * 100) : null;
    if (remaining == null) return [];
    return [{ ...usageWindow(labels[key], 100 - remaining, s.reset_date ?? data.quota_reset_date_utc ?? data.quota_reset_date, null), provider: 'github-copilot' }];
  });
  return { plan: typeof data?.copilot_plan === 'string' ? data.copilot_plan : null, windows, message: windows.length ? null : t('opencode.usage.copilotUnavailable') };
}

async function getJson(fetcher, url, headers) {
  const res = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  // Never include a provider response body or a transport exception in a report:
  // either can contain credentials or account details.
  if (!res.ok) {
    const error = new Error('Usage request failed');
    error.status = res.status;
    // A generic forbidden response is insufficient evidence of no subscription.
    if (res.status === 403) {
      const data = await res.json().catch(() => null);
      error.entitlement = [data?.name, data?.code, data?.error?.name, data?.error?.code, data?.error]
        .some(code => code === 'EntitlementError' || code === 'entitlement_error');
    }
    throw error;
  }
  return res.json();
}

export async function accountQuota(account = null, { fetcher = fetch } = {}) {
  const auth = readAccountAuth(account);
  const providers = ['opencode-go', 'openai', 'github-copilot'];
  const connections = await Promise.all(providers.filter(provider => provider === 'opencode-go'
    ? auth.opencode || auth['opencode-go'] || !Object.keys(auth).length : auth[provider]).map(async provider => {
    const c = (provider === 'opencode-go' ? auth.opencode ?? auth['opencode-go'] : auth[provider]) ?? {};
    const base = { provider, identity: identityOf(c), windows: [], checkedAt: null };
    const state = value => ({ ...base, state: value });
    try {
      if (provider === 'opencode-go') {
        const token = c.type === 'oauth' ? c.access : c.key;
        if (!token) return state('no-login');
        if (c.type === 'oauth' && c.expires <= Date.now()) return state('expired');
        const result = goQuota(await getJson(fetcher, 'https://opencode.ai/zen/go/v1/usage', {
          authorization: `Bearer ${token}`, accept: 'application/json',
        }));
        return { ...base, ...result, state: 'ready', checkedAt: Date.now() };
      }
      if (provider === 'openai') {
        if (c.type !== 'oauth') return state('unsupported');
        if (!c.access) return state('no-login');
        if (c.expires <= Date.now()) return state('expired');
        const data = await getJson(fetcher, 'https://chatgpt.com/backend-api/wham/usage', {
          authorization: `Bearer ${c.access}`, 'User-Agent': 'codex-cli', ...(c.accountId ? { 'ChatGPT-Account-Id': c.accountId } : {}),
        });
        const result = whamQuota(data);
        const windows = result.windows.filter(w => nonnegative(w.usedPercent) && w.usedPercent <= 100)
          .map(w => ({ ...w, label: `ChatGPT ${w.label}`, provider }));
        return { ...base, plan: result.plan, windows, state: windows.length ? 'ready' : 'failed', checkedAt: windows.length ? Date.now() : null };
      }
      if (c.type !== 'oauth' || c.enterpriseUrl) return state('unsupported');
      if (!c.refresh) return state('no-login');
      const result = copilotQuota(await getJson(fetcher, 'https://api.github.com/copilot_internal/user', {
        authorization: `token ${c.refresh}`, 'X-GitHub-Api-Version': '2025-04-01', 'User-Agent': 'Pleiad', accept: 'application/json',
      }));
      return { ...base, ...result, state: result.windows.length ? 'ready' : 'unsupported', checkedAt: result.windows.length ? Date.now() : null };
    } catch (error) {
      return state(provider === 'opencode-go' && error.status === 403 && error.entitlement ? 'not-subscribed' : 'failed');
    }
  }));
  const windows = connections.flatMap(c => c.windows);
  return { plan: null, connections, windows,
    ...(connections.some(c => c.state === 'failed') ? { reason: 'error' } : {}),
    message: connections.length && windows.length ? null : t('usage.connection.unavailable') };
}

export async function opencodeUsage({ accounts = [], account } = {}, options) {
  const rows = await Promise.all((account ? [account] : [null, ...accounts]).map(async account => {
    const ready = account ? account.ready ?? Object.keys(readAccountAuth(account)).length > 0 : true;
    const quota = await accountQuota(ready ? account : { ...account, credential: { auth: {} } }, options);
    return { accountId: account?.id ?? null,
      label: account?.name || (account ? account.id : t('opencode.usage.cliLogin')), ready,
      ...quota, checkedAt: quota.windows.length ? Date.now() : null };
  }));
  return { ...rows[0], accounts: rows };
}
