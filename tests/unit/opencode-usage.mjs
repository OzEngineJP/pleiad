import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runCase, summarize } from '../lib/harness.mjs';
import { accountQuota, opencodeUsage } from '../../core/backends/opencode-usage.mjs';
import { errorOf } from '../../core/backends/opencode-normalize.mjs';
import { t as translate } from '../../core/i18n.mjs';

export const name = 'opencode-usage';
export const title = 'OpenCode provider quotas: OAuth headers, account isolation, unknown data, and limits';

export default async function testOpencodeUsage(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-usage-')));
  const oldData = process.env.AGENT_HOST_OPENCODE_DATA;
  process.env.AGENT_HOST_OPENCODE_DATA = path.join(scratch, 'login');
  const seen = [];
  let scenario = 'normal';
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (scenario === 'unauthorized') { res.writeHead(401); return res.end('secret-provider-response'); }
    if (scenario === 'redirect') { res.writeHead(302, { location: '/stolen-token' }); return res.end(); }
    if (scenario === 'malformed') return res.end('{invalid');
    if (scenario === 'empty') return res.end('{}');
    if (req.url === '/backend-api/wham/usage') return res.end(JSON.stringify({ plan_type: 'plus', rate_limit: {
      primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 2000000000 },
      secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 2000500000 },
    }, additional_rate_limits: [{ metered_feature: 'spark', limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000, reset_at: 2000000000 } } }] }));
    return res.end(JSON.stringify({ copilot_plan: 'pro', quota_reset_date: '2033-06-01T00:00:00Z', quota_snapshots: {
      premium_interactions: { percent_remaining: 25, entitlement: 300, remaining: 75 },
      completions: { unlimited: true, percent_remaining: 0 },
      chat: { entitlement: 100, remaining: 80 },
      invalid: { percent_remaining: '75', entitlement: 0 },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetcher = (url, init) => {
    const u = new URL(url);
    assert.ok(['chatgpt.com', 'api.github.com'].includes(u.hostname));
    return fetch(`http://127.0.0.1:${server.address().port}${u.pathname}`, init);
  };
  const oauth = { type: 'oauth', access: 'access-one', refresh: 'github-token-one', expires: Date.now() + 3600000, accountId: 'chatgpt-org-one' };
  const account = { id: 'acct-one', name: 'One', ready: true, dir: path.join(scratch, 'acct-one'), credential: { auth: { openai: oauth, 'github-copilot': { ...oauth, expires: 0 } } } };
  try {
    const quota = await accountQuota(account, { fetcher });
    assert.equal(quota.windows.length, 5);
    const primary = quota.windows.find(w => w.limitId === 'codex' && w.minutes === 300);
    assert.equal(primary.usedPercent, 27);
    assert.equal(primary.remainingPercent, 73);
    assert.equal(primary.resetsAt, '2033-05-18T03:33:20.000Z');
    assert.equal(quota.windows.find(w => w.limitId === 'spark').usedPercent, 3);
    assert.equal(quota.windows[3].usedPercent, 75);
    assert.equal(quota.windows[4].usedPercent, 20);
    assert.ok(quota.windows.every(w => ['openai', 'github-copilot'].includes(w.provider)));
    assert.equal(seen.find(r => r.url.includes('wham')).headers.authorization, 'Bearer access-one');
    assert.equal(seen.find(r => r.url.includes('wham')).headers['chatgpt-account-id'], 'chatgpt-org-one');
    assert.equal(seen.find(r => r.url.includes('copilot')).headers.authorization, 'token github-token-one');
    t.ok('official response percentages, reset units, additional buckets and provider-specific auth', true);

    const other = { ...account, id: 'acct-two', name: 'Two', dir: path.join(scratch, 'acct-two'), credential: { auth: { openai: { ...oauth, access: 'access-two' } } } };
    const multiple = await opencodeUsage({ accounts: [account, other, { ...other, id: 'empty', dir: path.join(scratch, 'empty'), ready: false }] }, { fetcher });
    assert.deepEqual(multiple.accounts.map(r => r.accountId), [null, 'acct-one', 'acct-two', 'empty']);
    assert.equal(multiple.accounts[0].checkedAt, null);
    assert.ok(multiple.accounts.slice(1, 3).every(r => Number.isFinite(r.checkedAt)));
    assert.equal(multiple.accounts[3].checkedAt, null);
    assert.equal(multiple.accounts[3].windows.length, 0);
    assert.equal(multiple.accounts[3].ready, false);
    assert.ok(seen.some(r => r.headers.authorization === 'Bearer access-two'));
    assert.ok(!JSON.stringify(multiple).includes('access-one') && !JSON.stringify(multiple).includes('github-token-one'));
    t.ok('login and registered rows carry independent accountId, ready, checkedAt without tokens', true);

    for (scenario of ['unauthorized', 'malformed', 'empty', 'redirect']) {
      const result = await accountQuota(account, { fetcher });
      assert.equal(result.windows.length, 0);
      assert.ok(result.message);
      assert.ok(!JSON.stringify(result).includes('secret-provider-response'));
      const failedRow = await opencodeUsage({ account }, { fetcher });
      assert.equal(failedRow.checkedAt, null);
    }
    assert.ok(!seen.some(r => r.url === '/stolen-token'));
    const before = seen.length;
    const unsupported = await accountQuota({ ...account, credential: { auth: { openai: { ...oauth, expires: 1 }, custom: oauth, key: { type: 'api', key: 'key-secret' } } } }, { fetcher });
    assert.equal(seen.length, before);
    assert.equal(unsupported.windows.length, 0);
    assert.ok(unsupported.message.includes(translate('opencode.usage.accessExpired')));
    assert.ok(unsupported.message.includes(translate('opencode.usage.providerUnsupported')));
    t.ok('expired, unsupported, HTTP errors, redirects and malformed replies remain honestly unknown', true);

    assert.equal(errorOf({ name: 'APIError', data: { message: 'slow down', statusCode: 429 } }).limited, true);
    assert.equal(errorOf({ name: 'APIError', data: { message: 'forbidden', statusCode: 403, responseBody: '{"error":{"code":"quota_exceeded"}}' } }).limited, true);
    assert.equal(errorOf({ name: 'APIError', data: { message: 'rate limit discussed in prompt', statusCode: 500 } }).limited, false);
    assert.equal(errorOf({ name: 'ProviderAuthError', data: { message: 'login required' } }).auth, true);
    t.ok('structured quota errors are limited; generic server and authentication errors stay distinct', true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (oldData === undefined) delete process.env.AGENT_HOST_OPENCODE_DATA; else process.env.AGENT_HOST_OPENCODE_DATA = oldData;
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = summarize([await runCase({ name, title, default: testOpencodeUsage })]);
