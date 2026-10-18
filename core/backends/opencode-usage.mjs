import { whamQuota, usageWindow } from '../usage.mjs';
import { readAccountAuth } from './opencode-accounts.mjs';

const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function copilotQuota(data) {
  const windows = ['premium_interactions', 'premium_models', 'chat', 'completions'].flatMap(key => {
    const s = data?.quota_snapshots?.[key];
    if (!s || s.unlimited === true || s.entitlement === -1) return [];
    const remaining = nonnegative(s.percent_remaining) && s.percent_remaining <= 100 ? s.percent_remaining
      : nonnegative(s.remaining) && nonnegative(s.entitlement) && s.entitlement > 0 ? Math.min(100, s.remaining / s.entitlement * 100) : null;
    if (remaining == null) return [];
    return [{ ...usageWindow(`GitHub Copilot ${key}`, 100 - remaining, s.reset_date ?? data.quota_reset_date_utc ?? data.quota_reset_date, null), provider: 'github-copilot' }];
  });
  return { plan: typeof data?.copilot_plan === 'string' ? data.copilot_plan : null, windows, message: windows.length ? null : 'GitHub Copilot: no finite quota snapshot was returned (unlimited or unavailable).' };
}

async function getJson(fetcher, url, headers) {
  const res = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  // Never include a provider response body or a transport exception in a report:
  // either can contain credentials or account details.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function accountQuota(account = null, { fetcher = fetch } = {}) {
  const auth = readAccountAuth(account);
  const results = await Promise.all(Object.entries(auth).map(async ([provider, c]) => {
    const unknown = message => ({ windows: [], message: `${provider}: ${message}` });
    if (c.type !== 'oauth') return unknown('subscription quota is unavailable for this credential type.');
    if (provider !== 'openai' && provider !== 'github-copilot') return unknown('quota API is not supported.');
    try {
      if (provider === 'openai') {
        if (!c.access) return unknown('OAuth access token is missing.');
        if (c.expires <= Date.now()) return unknown('OAuth access token has expired; run a turn or sign in again to refresh.');
        const data = await getJson(fetcher, 'https://chatgpt.com/backend-api/wham/usage', {
          authorization: `Bearer ${c.access}`, 'User-Agent': 'codex-cli', ...(c.accountId ? { 'ChatGPT-Account-Id': c.accountId } : {}),
        });
        const result = whamQuota(data);
        const windows = result.windows.filter(w => nonnegative(w.usedPercent) && w.usedPercent <= 100)
          .map(w => ({ ...w, label: `ChatGPT ${w.label}`, provider }));
        return { ...result, windows, message: windows.length ? null : 'ChatGPT: quota snapshots were unavailable or invalid.' };
      }
      // OpenCode's Copilot OAuth refresh field contains the long-lived GitHub
      // token; access may be an ephemeral Copilot inference token.
      if (c.enterpriseUrl) return unknown('enterprise quota endpoint is not supported.');
      if (!c.refresh) return unknown('GitHub OAuth token is missing.');
      return copilotQuota(await getJson(fetcher, 'https://api.github.com/copilot_internal/user', {
        authorization: `token ${c.refresh}`, 'X-GitHub-Api-Version': '2025-04-01', 'User-Agent': 'Pleiad', accept: 'application/json',
      }));
    } catch (err) {
      return unknown(/^HTTP \d+$/.test(err?.message) ? `quota unavailable (${err.message}).` : 'quota request failed or returned invalid data.');
    }
  }));
  return {
    plan: results.map(r => r.plan).filter(Boolean).join(', ') || null,
    windows: results.flatMap(r => r.windows),
    message: results.map(r => r.message).filter(Boolean).join(' ') || (results.length ? null : 'No OpenCode provider credentials are available; subscription quota is unknown.'),
  };
}

export async function opencodeUsage({ accounts = [], account } = {}, options) {
  const rows = await Promise.all((account ? [account] : [null, ...accounts]).map(async account => {
    const ready = account ? account.ready ?? Object.keys(readAccountAuth(account)).length > 0 : true;
    return { accountId: account?.id ?? null,
      label: account?.name || (account ? account.id : 'OpenCode CLI login'), ready,
      ...(!ready ? { windows: [], message: 'This account has no usable credential.' } : await accountQuota(account, options)), checkedAt: Date.now() };
  }));
  return { ...rows[0], accounts: rows };
}
