import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, summarize } from '../lib/harness.mjs';
import { i18n, setLocale, currentLocale, t as translate } from '../../core/i18n.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { CodexRpc } from '../../core/backends/codex-rpc.mjs';
import { prepareCodexAccount, readCodexCredential } from '../../core/backends/codex-accounts.mjs';
import { loginAccount } from '../../core/backends/opencode-accounts.mjs';
import { accountQuota, opencodeUsage, copilotQuota } from '../../core/backends/opencode-usage.mjs';

export const name = 'account-backend-i18n';
export const title = 'Account backend messages switch languages without changing quota or cancellation state';

export default async function testAccountBackendI18n(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'account-backend-i18n-')));
  const previousLocale = currentLocale();
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(scratch, 'cli');
  const samples = [];
  try {
    for (const locale of ['ja', 'en']) {
      setLocale(locale);
      const expected = (key, params) => {
        assert.equal(typeof i18n.getResource(locale, 'server', key), 'string', `Missing ${locale} server:${key}`);
        const message = translate(key, params);
        assert.notEqual(message, key, `Missing ${locale} server:${key}`);
        assert.ok(!message.includes('{{'), `Unresolved interpolation in ${key}`);
        return message;
      };
      const aborter = new AbortController(); aborter.abort();
      const cancelled = expected('accounts.backend.loginCancelled', { agent: 'Codex' });
      await assert.rejects(codex.auth.login({ signal: aborter.signal }), { message: cancelled });
      const rpc = new CodexRpc();
      rpc.threads.set('thread-busy', {});
      await assert.rejects(rpc.releaseThread('thread-busy'), { message: expected('codex.accounts.threadBusy') });
      const missing = { id: 'acct-missing', dir: path.join(scratch, 'acct-missing') };
      await assert.rejects(prepareCodexAccount(missing), { message: expected('accounts.backend.directoryRemoved', { agent: 'Codex' }) });
      const removed = { id: `acct-deleted-${locale}`, dir: path.join(scratch, `acct-deleted-${locale}`) };
      await codex.accountRemove({ account: removed });
      await assert.rejects(codex.forAccount(removed), { message: expected('accounts.backend.removedOrRemoving', { agent: 'Codex' }) });
      const broken = { id: `acct-broken-${locale}`, dir: path.join(scratch, `acct-broken-${locale}`) };
      await fs.mkdir(broken.dir);
      await fs.writeFile(path.join(broken.dir, 'auth.json'), '{broken');
      await assert.rejects(readCodexCredential(broken), { message: expected('accounts.backend.credentialUnreadable', { agent: 'Codex' }) });
      t.ok(`${locale}: Codex cancelled, busy and removed account paths use translated messages`, true);

      const account = { id: `acct-oc-${locale}`, dir: path.join(scratch, 'oc', `acct-oc-${locale}`) };
      const events = [];
      await assert.rejects(loginAccount({ account, argv: ['fake-opencode'], signal: aborter.signal }), {
        name: 'AbortError', code: 'ABORT_ERR', message: expected('accounts.backend.loginCancelled', { agent: 'OpenCode' }),
      });
      await assert.rejects(loginAccount({ account, argv: ['fake-opencode'], timeoutMs: 5, pollMs: 2, emit: e => events.push(e) }), {
        message: expected('opencode.auth.loginTimeout'),
      });
      assert.equal(events[0].message, expected('opencode.auth.accountRunCommand'));
      assert.equal(events.at(-1).phase, 'error');
      t.ok(`${locale}: OpenCode terminal and cancel/timeout messages preserve auth phases and abort identity`, true);

      const auth = { type: 'oauth', access: 'expired-secret', refresh: 'refresh-secret', expires: 1 };
      const unknown = await accountQuota({ ...account, credential: { auth: { openai: auth } } }, { fetcher: () => { throw new Error('must not fetch an expired credential'); } });
      assert.deepEqual(unknown.windows, []);
      assert.equal(unknown.message, expected('opencode.usage.providerMessage', { provider: 'openai', message: expected('opencode.usage.accessExpired') }));
      const unused = await opencodeUsage({ account: { ...account, ready: false } });
      assert.equal(unused.ready, false);
      assert.equal(unused.checkedAt, null);
      assert.deepEqual(unused.windows, []);
      assert.equal(unused.message, expected('opencode.usage.accountNotReady'));
      const finite = copilotQuota({ quota_snapshots: { chat: { percent_remaining: 72 } } });
      assert.equal(finite.windows[0].label, expected('opencode.usage.copilotChat'));
      assert.equal(finite.windows[0].usedPercent, 28);
      assert.equal(finite.windows[0].remainingPercent, 72);
      const unlimited = copilotQuota({ quota_snapshots: { chat: { unlimited: true } } });
      assert.deepEqual(unlimited.windows, []);
      assert.equal(unlimited.message, expected('opencode.usage.copilotUnavailable'));
      samples.push({ cancelled, unknown: unknown.message });
      t.ok(`${locale}: unknown/unlimited quota remains empty and timestamp/ready/percent semantics stay unchanged`, true);
    }
    assert.notEqual(samples[0].cancelled, samples[1].cancelled);
    assert.notEqual(samples[0].unknown, samples[1].unknown);
    t.ok('changing language changes messages at call time', true);
  } finally {
    setLocale(previousLocale);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Validate a pending translation artifact without changing shared dictionaries.
  if (process.env.ACCOUNT_BACKEND_I18N_REPORT) {
    const resources = JSON.parse(await fs.readFile(process.env.ACCOUNT_BACKEND_I18N_REPORT, 'utf8'));
    assert.deepEqual(Object.keys(resources.ja).sort(), Object.keys(resources.en).sort());
    const slots = text => [...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(m => m[1]).sort();
    assert.deepEqual(slots('{{agent}} {{ entry }}'), ['agent', 'entry']);
    for (const key of Object.keys(resources.en)) {
      assert.ok(resources.en[key].length && resources.ja[key].length);
      assert.deepEqual(slots(resources.ja[key]), slots(resources.en[key]), `Interpolation differs for ${key}`);
    }
    for (const [locale, messages] of Object.entries(resources)) for (const [key, value] of Object.entries(messages))
      i18n.addResource(locale, 'server', key, value);
  }
  const suites = [];
  try {
    suites.push(await runCase({ name, title, default: testAccountBackendI18n }));
    if (process.argv.includes('--opencode')) {
      for (const locale of ['ja', 'en']) {
        setLocale(locale);
        suites.push(await runCase(await import('./opencode-usage.mjs')));
        suites.push(await runCase(await import('./opencode-accounts.mjs')));
      }
    }
    process.exitCode = summarize(suites);
  } finally { await cleanupTestData(); }
}
