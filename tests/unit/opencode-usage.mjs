import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runCase, summarize } from '../lib/harness.mjs';
import { accountQuota, opencodeUsage } from '../../core/backends/opencode-usage.mjs';
import { createQuotaStore, compactQuota } from '../../core/usage.mjs';
import { windowsFor, checkCandidate, normalizeSettings, elapsedPercent } from '../../core/delegation-routing.mjs';
import { windowsForModel } from '../../web/header-usage.mjs';
import { carryQuota, renderQuota } from '../../web/usage.mjs';
import { N } from '../lib/dom-stub.mjs';
import { errorOf } from '../../core/backends/opencode-normalize.mjs';
import { loadSqlite } from '../../core/db.mjs';

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
    if (scenario === 'forbidden') { res.writeHead(403); return res.end('{}'); }
    if (scenario === 'not-subscribed') { res.writeHead(403); return res.end('{"error":{"name":"EntitlementError"}}'); }
    if (scenario === 'server-error') { res.writeHead(503); return res.end('secret-provider-response'); }
    if (scenario === 'redirect') { res.writeHead(302, { location: '/stolen-token' }); return res.end(); }
    if (scenario === 'malformed') return res.end('{invalid');
    if (scenario === 'empty') return res.end('{}');
    if (req.url === '/zen/go/v1/usage') return res.end(JSON.stringify({ usage: {
      rolling: { percent: 3, resetsAt: '2033-05-18T03:33:20Z' },
      weekly: { percent: 6, resetsAt: '2033-05-24T03:33:20Z' },
      monthly: { percent: 3, resetsAt: '2033-06-01T00:00:00Z' },
    } }));
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
    assert.ok(['chatgpt.com', 'api.github.com', 'opencode.ai'].includes(u.hostname));
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

    // 新しい OpenCode は資格情報を auth.json ではなく opencode.db（credential 表）に書く。そちらも読む
    const loginDir = path.join(scratch, 'login');
    await fs.mkdir(loginDir, { recursive: true });
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(path.join(loginDir, 'opencode.db'));
    db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER)');
    const put = db.prepare('INSERT INTO credential (id, integration_id, value) VALUES (?, ?, ?)');
    put.run('c1', 'openrouter', JSON.stringify({ type: 'key', key: 'or-db-key' }));
    put.run('c2', 'opencode', JSON.stringify({ type: 'oauth', access: 'zen-access', refresh: 'zen-refresh', expires: Date.now() + 86_400_000 }));
    put.run('c3', 'broken', 'not-json');
    db.close();
    const dbOnly = await accountQuota(null, { fetcher });
    assert.equal(dbOnly.windows.length, 3);
    assert.ok(dbOnly.windows.every(w => w.provider === 'opencode-go'));
    assert.deepEqual(dbOnly.windows.map(w => w.usedPercent), [3, 6, 3]);
    assert.deepEqual(dbOnly.windows.map(w => w.minutes), [300, 10080, null]);
    assert.ok(dbOnly.windows.every(w => w.label.startsWith('Go ')));
    assert.equal(seen.find(r => r.url.includes('/zen/go/')).headers.authorization, 'Bearer zen-access');
    assert.ok(!seen.some(r => r.url.includes('/auth/key')));
    assert.ok(!JSON.stringify(dbOnly).includes('or-db-key') && !JSON.stringify(dbOnly).includes('zen-access'));
    t.ok('Go reads existing SQLite OAuth credentials: three percentages, calendar reset, no OpenRouter request', true);

    await fs.writeFile(path.join(loginDir, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'old-json-key' } }));
    const merged = await accountQuota(null, { fetcher });
    assert.equal(seen.filter(r => r.url.includes('/zen/go/')).at(-1).headers.authorization, 'Bearer zen-access');
    assert.equal(merged.windows.length, 3);
    t.ok('SQLite credentials take precedence over migrated auth.json', true);

    const goAccount = { ...account, credential: { auth: { opencode: { type: 'api', key: 'go-key' }, openrouter: { type: 'api', key: 'ignored-key' } } } };
    const api = await accountQuota(goAccount, { fetcher });
    assert.equal(seen.at(-1).headers.authorization, 'Bearer go-key');
    assert.deepEqual(windowsForModel([...api.windows, ...quota.windows], 'opencode-go/kimi-k2.5'), api.windows);
    assert.deepEqual(windowsFor('opencode', 'opencode-go/kimi-k2.5', [...api.windows, ...quota.windows]), api.windows);
    const now = Date.now(), candidate = 'opencode:opencode-go/kimi-k2.5';
    const verdict = checkCandidate(candidate, { usage: { opencode: { available: true, checkedAt: now,
      models: { 'opencode-go/kimi-k2.5': true }, windows: api.windows } }, settings: normalizeSettings({}), now });
    assert.equal(verdict.ok, true);
    assert.notEqual(verdict.reason, 'usage_unknown');
    const passedReset = api.windows.map(w => w.minutes === null ? { ...w, resetsAt: new Date(now - 1).toISOString() } : w);
    assert.equal(checkCandidate(candidate, { usage: { opencode: { available: true, checkedAt: now,
      models: { 'opencode-go/kimi-k2.5': true }, windows: passedReset } }, settings: normalizeSettings({}), now }).reason, 'usage_unknown');
    assert.equal(elapsedPercent(api.windows[2], now), null);
    assert.equal(compactQuota(api).windows[0].label, api.windows[0].label);
    t.ok('opencode-go model candidates and the header match Go windows; monthly never assumes 30 days', true);

    for (const state of ['unauthorized', 'forbidden', 'server-error', 'not-subscribed', 'empty', 'malformed', 'redirect']) {
      scenario = state;
      const value = await accountQuota(goAccount, { fetcher });
      assert.equal(value.connections[0].state, state === 'not-subscribed' ? 'not-subscribed' : 'failed');
      assert.equal(value.windows.length, 0);
      assert.ok(!JSON.stringify(value).includes('secret-provider-response'));
    }
    scenario = 'normal';
    const expiredGo = { ...goAccount, credential: { auth: { opencode: { ...oauth, expires: 1 } } } };
    const beforeGo = seen.length;
    assert.equal((await accountQuota(expiredGo, { fetcher })).connections[0].state, 'expired');
    assert.equal((await accountQuota({ ...goAccount, credential: { auth: {} } }, { fetcher })).connections[0].state, 'no-login');
    const router = await accountQuota({ ...goAccount, credential: { auth: { openrouter: { type: 'api', key: 'ignored' } } } }, { fetcher });
    assert.equal(router.connections.length, 0); assert.equal(router.windows.length, 0);
    assert.equal(seen.length, beforeGo);
    t.ok('Go separates entitlement, expired OAuth, missing auth, generic 401/403/5xx and unsupported connections', true);

    const store = createQuotaStore();
    const snapshot = value => ({ ...value, accounts: [{ ...value, accountId: null, checkedAt: Date.now() }] });
    await store.refresh('fixture', () => snapshot(api));
    scenario = 'server-error';
    const failure = snapshot(await accountQuota(goAccount, { fetcher }));
    const retained = await store.refresh('fixture', () => failure, { force: true });
    assert.equal(retained.accounts[0].windows.length, 3);
    assert.ok(retained.accounts[0].connections[0].staleSince);
    assert.equal(carryQuota(failure, snapshot(api)).accounts[0].windows.length, 3);
    const changed = { ...goAccount, credential: { auth: { opencode: { type: 'api', key: 'different-key' } } } };
    const freshFailure = snapshot(await accountQuota(changed, { fetcher }));
    assert.equal((await store.refresh('fixture', () => freshFailure, { force: true })).accounts[0].windows.length, 0);
    assert.equal(carryQuota(freshFailure, snapshot(api)).accounts[0].windows.length, 0);
    assert.equal((await store.refresh('fixture', () => snapshot(router), { force: true })).accounts[0].windows.length, 0);
    const savedDir = path.join(scratch, 'quota-cache');
    await fs.mkdir(savedDir);
    const persistent = createQuotaStore({ dir: savedDir });
    await persistent.refresh('fixture', () => snapshot(api)); await persistent.flush();
    const restored = createQuotaStore({ dir: savedDir });
    const afterRestart = await restored.refresh('fixture', () => failure, { force: true });
    assert.equal(afterRestart.accounts[0].windows.length, 3);
    assert.ok(afterRestart.accounts[0].connections[0].staleSince);
    await restored.flush();
    const oldSnapshot = { backends: { fixture: { windows: [{ provider: 'openrouter', usedPercent: 75 }],
      accounts: [{ windows: [{ provider: 'openrouter', usedPercent: 75 }], message: 'retired diagnostic' }] } } };
    await fs.writeFile(path.join(savedDir, 'usage-quota.json'), JSON.stringify(oldSnapshot));
    const retired = createQuotaStore({ dir: savedDir }).get('fixture');
    assert.equal(retired.windows.length, 0); assert.equal(retired.accounts[0].windows.length, 0);
    scenario = 'normal';
    t.ok('Server and browser retain failed reads only per connection and credential generation', true);

    {
      const root = new N('div');
      renderQuota(root, snapshot(api), null, {}, { model: 'opencode-go/kimi-k2.5', retry() {} });
      assert.equal(root.querySelectorAll('.usage-window').length, 3);
      assert.equal(root.querySelectorAll('.usage-provider').length, 1);
    }
    t.ok('Settings render account → connection → three periods once, without the top-level copy', true);

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
    assert.equal(unsupported.connections[0].state, 'expired');
    assert.equal(unsupported.connections.length, 1);
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
