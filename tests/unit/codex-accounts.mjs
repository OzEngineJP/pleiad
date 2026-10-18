import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

export const name = 'codex-accounts';
export const title = 'Codex accounts isolate authentication and RPC state while sharing CLI configuration, history and writer locks';

export default async function test(t) {
  const { t: translate } = await import('../../core/i18n.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-codex-accounts-'));
  const home = path.join(root, 'cli');
  const shared = path.join(root, 'state');
  await fs.mkdir(home); await fs.mkdir(shared);
  const seed = (email, usedPercent) => ({ auth: { fake: { email, usedPercent, identity: email } } });
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(seed('default@example.invalid', 7).auth));
  const config = 'model = "fake-model-1"\n[mcp_servers.custom]\ncommand = "custom-tool"\n';
  await fs.writeFile(path.join(home, 'config.toml'), config);
  await fs.writeFile(path.join(home, 'session_index.jsonl'), 'original-index\n');
  const originalAuth = await fs.readFile(path.join(home, 'auth.json'), 'utf8');
  const vars = { CODEX_HOME: home, CODEX_SQLITE_HOME: home, FAKE_CODEX_ACCOUNTS: '1', FAKE_CODEX_STATE_DIR: shared,
    FAKE_CODEX_LOG: path.join(root, 'calls.jsonl'), OPENAI_API_KEY: 'fake-inherited-key', AGENT_HOST_CODEX_HOLDER: 'off',
    AGENT_HOST_CODEX_BIN: `"${process.execPath}" "${fileURLToPath(new URL('../lib/fake-codex.mjs', import.meta.url))}"` };
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const { backend, codexRpcForAccount, codexBackendForAccount } = await import('../../core/backends/codex.mjs');
  const { rpc: defaultRpc } = await import('../../core/backends/codex-rpc.mjs');
  const { prepareCodexAccount, removeCodexAccountDirectory, codexAccountChildId, codexHomesOverlap } = await import('../../core/backends/codex-accounts.mjs');
  const { acquireHeldAppServer, configureCodexHeld, expandCodexHeld, heldAppServer } = await import('../../core/backends/codex-held.mjs');
  const accounts = [];
  const make = async (suffix, credential = null) => {
    const id = `acct-${suffix}`, dir = path.join(root, 'accounts', 'codex', id);
    await fs.mkdir(dir, { recursive: true });
    const account = { id, name: suffix, dir, credential }; accounts.push(account); return account;
  };
  const run = async (account, extra = {}) => {
    const events = [];
    await backend.runTurn({ account, prompt: 'hello', cwd: root, mode: 'readonly', signal: new AbortController(),
      emit: e => events.push(e), askPermission: async () => ({ allow: false }), ...extra });
    assert.equal(events.find(e => e.type === 'turnResult')?.outcome, 'ok', JSON.stringify(events));
    return events.find(e => e.type === 'session')?.sessionId ?? extra.sessionId;
  };
  const check = label => t.ok(label, true);
  try {
    assert.equal(codexHomesOverlap('C:/Users/test/.codex', 'D:/data/accounts/codex/acct-a', path.win32), false);
    assert.equal(codexHomesOverlap('C:/Users/test/.codex', 'C:/Users/test/.codex/acct-a', path.win32), true);
    assert.equal(codexHomesOverlap('C:/Users/test/.codex', 'C:/Users/test/.codex-other/acct-a', path.win32), false);
    await defaultRpc.stop();
    const a = await make('a', seed('a@example.invalid', 21));
    const b = await make('b', seed('b@example.invalid', 62));
    assert.equal((await backend.accountStatus({ account: a })).label, 'a@example.invalid');
    assert.equal((await backend.accountStatus({ account: b })).label, 'b@example.invalid');
    assert.equal((await backend.auth.status()).account, 'default@example.invalid');
    const ra = await codexRpcForAccount(a), rb = await codexRpcForAccount(b);
    const boundA = await backend.forAccount(a), boundB = await boundA.forAccount(b);
    assert.equal('credential' in boundA || 'account' in boundA, false);
    assert.equal((await boundA.auth.status()).account, 'a@example.invalid');
    assert.equal((await boundB.auth.status()).account, 'b@example.invalid');
    assert.equal((await boundA.usage()).windows[0].usedPercent, 21);
    assert.equal((await boundB.usage()).windows[0].usedPercent, 62);
    assert.ok(await boundB.models(root));
    assert.notEqual(ra, rb);
    const env = await ra.request('fake/env');
    assert.equal(env.home, a.dir); assert.equal(env.sqliteHome, home); assert.equal(env.apiKey, false);
    assert.equal(env.config, config);
    assert.ok(env.args.includes('cli_auth_credentials_store="file"'));
    for (const entry of ['sessions', 'thread-writer-locks', 'config.toml', 'session_index.jsonl']) assert.equal((await fs.lstat(path.join(a.dir, entry))).isSymbolicLink(), true);
    assert.equal(await fs.realpath(path.join(a.dir, 'thread-writer-locks')), await fs.realpath(path.join(b.dir, 'thread-writer-locks')));
    check('two selected accounts isolate auth and app-server, preserve CLI config/MCP and share writer locks');

    const [ta, tb] = await Promise.all([run(a), run(b)]);
    assert.ok(ta && tb && ta !== tb);
    await backend.setTitle(ta, 'A title', { account: a });
    // Simulate conversation wrappers calling native methods without options.
    await boundA.setTitle(ta, 'A title');
    assert.equal((await boundA.getSession(ta)).title, 'A title');
    assert.ok((await boundB.getMessages(tb)).length);
    const boundFork = await boundA.fork(ta, { account: b });
    assert.ok(boundFork.sessionId);
    assert.ok((await ra.request('fake/stats'))['thread/fork']);
    assert.equal((await backend.getSession(ta, { account: a })).title, 'A title');
    assert.ok((await backend.getMessages(ta, { account: a })).length);
    assert.ok((await backend.listSessions({ account: b })).some(x => x.sessionId === ta || x.id === ta));
    await backend.getCompactions(ta, { account: a });
    const fork = await backend.fork(ta, { account: b });
    assert.ok(fork.sessionId);
    await run(b, { sessionId: ta });
    await run(a, { sessionId: ta });
    check('parallel turns, history, naming, fork and cross-account resume use the selected app-server');

    const compactEvents = [];
    await boundA.compact({ sessionId: ta, cwd: root, emit: e => compactEvents.push(e) });
    assert.ok(compactEvents.some(e => e.type === 'compaction' && e.phase === 'complete'));
    const context = { owners: { instruction: 'ply', skill: 'agent', mcp: 'agent' } };
    await run(b, { contextRuntime: context });
    assert.ok(await boundA.suggestTitle({ transcript: 'a title', locale: 'en' }));
    assert.ok(await boundB.suggestNext({ prompt: 'suggest a next step' }));
    await boundB.runTurn({ prompt: 'bound turn', cwd: root, mode: 'readonly', signal: new AbortController(), emit: () => {}, askPermission: async () => ({ allow: false }), account: a });
    const logs = (await fs.readFile(vars.FAKE_CODEX_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    const pidHomes = new Map(logs.filter(x => x.method === 'initialize').map(x => [x.pid, x.home]));
    const turns = logs.filter(x => x.method === 'turn/start');
    assert.ok(turns.some(x => pidHomes.get(x.pid) === a.dir));
    assert.ok(turns.some(x => pidHomes.get(x.pid) === b.dir));
    assert.ok([...pidHomes].filter(([, h]) => h === b.dir).length >= 2);
    assert.equal(turns.some(x => pidHomes.get(x.pid) === home), false);
    check('compaction, title, suggestions and dedicated context servers preserve account selection');

    let quota = await backend.usage({ accounts: [a, b, { ...b, id: 'acct-unready', ready: false }] });
    assert.equal(quota.accounts[0].accountId, null);
    assert.equal(quota.accounts[0].windows[0].usedPercent, 7);
    assert.equal(quota.accounts[1].windows[0].usedPercent, 21);
    assert.equal(quota.accounts[2].windows[0].usedPercent, 62);
    assert.equal(typeof quota.accounts[1].checkedAt, 'number');
    assert.equal(quota.accounts[1].identity.email, 'a@example.invalid');
    assert.equal(quota.accounts[3].checkedAt, null);
    await rb.request('fake/config', { rateFailure: true });
    quota = await backend.usage({ accounts: [a, b] });
    assert.equal(quota.accounts[2].checkedAt, null); assert.deepEqual(quota.accounts[2].windows, []);
    assert.equal(quota.accounts[1].windows[0].usedPercent, 21);
    await rb.request('fake/config', { rateFailure: false });
    check('usage has independent checkedAt, identity and unknown rows without falling back to the CLI account');

    // A live turn, an account operation and background work all prevent removal.
    const stopBusy = rb.attach('busy-test', {});
    await assert.rejects(backend.accountRemove({ account: b }), { message: translate('accounts.backend.inUseByTurn', { agent: 'Codex' }) });
    if (process.platform === 'win32') {
      const alias = { ...b, dir: path.join(path.dirname(b.dir).toUpperCase(), path.basename(b.dir)) };
      assert.equal(await codexRpcForAccount(alias), rb);
      await assert.rejects(backend.accountRemove({ account: alias }), { message: translate('accounts.backend.inUseByTurn', { agent: 'Codex' }) });
    }
    stopBusy();
    await ra.request('fake/config', { unsubscribeFailure: true });
    await assert.rejects(run(b, { sessionId: ta }), { code: -32000 });
    await ra.request('fake/config', { unsubscribeFailure: false });
    await run(b, { sessionId: ta });
    check('busy-account removal and failed writer transfers reject without stopping another account');

    const c = await make('login');
    const urls = [], opened = [];
    const login = await backend.accountLogin({ account: c, emit: e => urls.push(e), openExternal: url => opened.push(url) });
    assert.ok(login.credential.auth); assert.equal(opened.length, 1); assert.equal(urls[0].phase, 'url');
    assert.equal((await backend.accountStatus({ account: { ...c, credential: login.credential } })).hasCredential, true);
    const rc = await codexRpcForAccount(c);
    await rc.request('fake/config', { loginBehavior: 'early' });
    await backend.accountLogin({ account: c });
    await rc.request('fake/config', { loginBehavior: 'fail' });
    await assert.rejects(backend.accountLogin({ account: c }));
    await rc.request('fake/config', { loginBehavior: 'hang' });
    const ac = new AbortController();
    let rejectBusy;
    const busyRemoval = new Promise(resolve => { rejectBusy = resolve; });
    const pending = backend.accountLogin({ account: c, signal: ac.signal, emit: () => {
      rejectBusy(assert.rejects(backend.accountRemove({ account: c }), { message: translate('accounts.backend.inUse', { agent: 'Codex' }) })); ac.abort();
    } });
    await assert.rejects(pending);
    await busyRemoval;
    assert.ok((await rc.request('fake/stats'))['account/login/cancel'] >= 2);
    check('login captures credentials and handles early completion, failed login and cancellation');

    const logoutAccount = await make('logout', seed('logout@example.invalid', 1));
    const logoutBackend = await backend.forAccount(logoutAccount);
    await logoutBackend.auth.logout();
    assert.equal((await logoutBackend.auth.status()).loggedIn, false);
    assert.equal((await logoutBackend.auth.status()).loggedIn, false);
    assert.equal((await backend.accountStatus({ account: logoutAccount })).hasCredential, false);
    await backend.accountDispose({ account: logoutAccount });
    assert.equal((await backend.accountStatus({ account: logoutAccount })).hasCredential, false);
    await assert.rejects(fs.stat(path.join(logoutAccount.dir, 'auth.json')), { code: 'ENOENT' });
    await backend.accountLogin({ account: logoutAccount });
    assert.equal((await backend.accountStatus({ account: logoutAccount })).hasCredential, true);
    check('bound logout remains logged out across status checks and backend recreation until explicit login');

    // CLI refreshes its token file itself: never replace it with the stale seed.
    const refreshed = seed('a-refreshed@example.invalid', 3).auth;
    await fs.writeFile(path.join(a.dir, 'auth.json'), JSON.stringify(refreshed));
    await prepareCodexAccount(a);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(a.dir, 'auth.json'), 'utf8')), refreshed);
    await backend.accountRemove({ account: a });
    await removeCodexAccountDirectory(a);
    await assert.rejects(codexBackendForAccount(a), { message: translate('accounts.backend.removedOrRemoving', { agent: 'Codex' }) });
    await assert.rejects(boundA.getMessages(ta), { message: translate('accounts.backend.removedOrRemoving', { agent: 'Codex' }) });
    if (process.platform === 'win32') await assert.rejects(backend.accountLogin({ account: { ...a, dir: path.join(path.dirname(a.dir).toUpperCase(), path.basename(a.dir)) } }), { message: translate('accounts.backend.removedOrRemoving', { agent: 'Codex' }) });
    assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), originalAuth);
    assert.equal(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), config);
    assert.equal(await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8'), 'original-index\n');
    assert.ok((await fs.stat(path.join(home, 'sessions'))).isDirectory());
    check('token refresh survives re-entry; account deletion removes links while preserving CLI data and refuses stale handles');

    const bad = await make('unsafe', seed('bad@example.invalid', 1));
    await fs.symlink(path.join(home, 'auth.json'), path.join(bad.dir, 'auth.json'), 'file');
    await assert.rejects(prepareCodexAccount(bad), /Unsafe/);
    const clash = await make('clash', seed('bad@example.invalid', 1));
    await fs.mkdir(path.join(clash.dir, 'sessions'));
    await fs.writeFile(path.join(clash.dir, 'sessions', 'sentinel'), 'preserve');
    await assert.rejects(prepareCodexAccount(clash), /Refusing/);
    assert.equal(await fs.readFile(path.join(clash.dir, 'sessions', 'sentinel'), 'utf8'), 'preserve');
    await assert.rejects(prepareCodexAccount({ ...b, dir: home }), /overlaps/);
    const hard = await make('hard', seed('bad@example.invalid', 1));
    await fs.link(path.join(home, 'auth.json'), path.join(hard.dir, 'auth.json'));
    await assert.rejects(prepareCodexAccount(hard), /Unsafe/);
    const malformed = await make('malformed', seed('bad@example.invalid', 1));
    await fs.writeFile(path.join(malformed.dir, 'auth.json'), 'broken-secret-token-do-not-report');
    await assert.rejects(prepareCodexAccount(malformed), { message: translate('accounts.backend.credentialUnreadable', { agent: 'Codex' }) });
    assert.notEqual(codexAccountChildId(a), codexAccountChildId(b));
    assert.equal(codexAccountChildId({ ...a, credential: seed('other', 0) }), codexAccountChildId(a));
    check('auth symlinks, overlapping homes and unexpected existing data fail closed; holder IDs are account-specific and credential-free');

    // A fake holder keeps its child and sequenced output alive across detach.
    // No executable or listening socket is needed for the handover protocol.
    const d = await make('held-d', seed('d@example.invalid', 4));
    const e = await make('held-e', seed('e@example.invalid', 5));
    const client = new EventEmitter();
    client.connected = true; client.welcome = { children: [] };
    const children = new Map(), frames = [];
    let mockThread = 0;
    const output = (id, frame) => { const c = children.get(id); const line = JSON.stringify(frame); c.seq++; c.lines.push({ seq: c.seq, line }); client.emit('out', { id, seq: c.seq, line }); };
    client.spawn = spec => { frames.push(['spawn', spec]); children.set(spec.id, { ...spec, alive: true, seq: 0, acked: 0, marks: {}, lines: [] }); };
    client.write = (id, text) => {
      const req = JSON.parse(text); frames.push(['write', id, req]);
      if (req.id == null) return true;
      let result = {};
      if (req.method === 'account/read') result = { account: { type: 'chatgpt', email: children.get(id).env.CODEX_HOME } };
      if (req.method === 'thread/start') result = { thread: { id: `th_held_${++mockThread}` }, modelProvider: 'openai' };
      if (req.method === 'thread/resume') result = { thread: { id: req.params.threadId }, modelProvider: 'openai' };
      if (req.method === 'thread/unsubscribe') {
        result = { status: 'unsubscribed' };
        setTimeout(() => output(id, { method: 'thread/closed', params: { threadId: req.params.threadId } }), 10);
      }
      if (req.method === 'turn/start') {
        result = { turn: { id: 'held-turn' } };
        setTimeout(() => output(id, { method: 'turn/completed', params: { threadId: req.params.threadId, turn: { id: 'held-turn', status: 'completed' } } }), 10);
      }
      queueMicrotask(() => output(id, { id: req.id, result })); return true;
    };
    client.mark = (id, name) => { children.get(id).marks[name] = children.get(id).seq + 1; };
    client.unmark = (id, name) => { delete children.get(id).marks[name]; };
    client.ack = (id, seq) => { children.get(id).acked = seq; };
    client.label = (id, label) => { children.get(id).label = label; };
    client.detach = async id => { frames.push(['detach', id]); };
    client.attach = async (id, { from }) => { const c = children.get(id); queueMicrotask(() => { for (const item of c.lines.filter(x => x.seq >= from)) client.emit('out', { id, ...item }); }); return { ...c, pendingRequests: [] }; };
    client.replay = async (id, from, to) => ({ lines: children.get(id).lines.filter(x => x.seq >= from && x.seq <= to) });
    client.release = id => frames.push(['release', id]);
    client.kill = id => { frames.push(['kill', id]); client.emit('exit', { id, code: 0 }); };
    const runtime = process.env.AGENT_HOST_RUNTIME_ROOT;
    process.env.AGENT_HOST_RUNTIME_ROOT = root; process.env.AGENT_HOST_CODEX_HOLDER = 'on';
    configureCodexHeld({ dataDir: () => root });
    let hd, he;
    try {
      const ed = await prepareCodexAccount(d), ee = await prepareCodexAccount(e);
      hd = await acquireHeldAppServer({ cli_auth_credentials_store: 'file' }, { account: d, env: ed, link: async () => client });
      he = await acquireHeldAppServer({ cli_auth_credentials_store: 'file' }, { account: e, env: ee, link: async () => client });
      assert.notEqual(hd.id, he.id);
      assert.equal(children.get(hd.id).env.CODEX_HOME, d.dir);
      assert.equal(children.get(he.id).env.CODEX_HOME, e.dir);
      assert.equal(heldAppServer(d), hd); assert.equal(heldAppServer(e), he);
      assert.equal(JSON.stringify(children.get(hd.id).label).includes('credential'), false);
      const heldThread = await run(d);
      assert.ok(hd.labelObject().loaded[heldThread]);
      await run(e, { sessionId: heldThread });
      assert.equal(heldThread in hd.labelObject().loaded, false);
      assert.ok(he.labelObject().loaded[heldThread]);
      hd.markTurn('held-thread'); hd.putCard('held-thread', { held: true });
      await hd.handOff();
      await backend.accountDispose({ account: d });
      assert.equal(heldAppServer(d), null); assert.equal(heldAppServer(e), he);
      const sources = await expandCodexHeld({ client, child: children.get(hd.id) });
      assert.equal(sources.length, 1); assert.equal(sources[0].account.id, d.id);
      const adopted = heldAppServer(d);
      assert.equal(adopted.adopted, true);
      assert.equal((await sources[0].rpc.request('account/read')).account.email, d.dir);
      assert.equal(frames.filter(x => x[0] === 'write' && x[1] === hd.id && x[2].method === 'initialize').length, 1);
      await assert.rejects(backend.adoptTurn({ account: e, source: sources[0], card: { held: true } }), /mismatch/);
      sources[0].dispose();
      await backend.accountRemove({ account: d });
      await he.stop();
      check('holder children keep account env/labels separate, adopt the selected RPC without reinitialization and reject mismatched accounts');
    } finally {
      await backend.accountDispose({ account: d });
      if (he) await he.stop();
      const store = await import('../../core/store.mjs');
      configureCodexHeld({ dataDir: () => store.dataDir });
      if (runtime === undefined) delete process.env.AGENT_HOST_RUNTIME_ROOT; else process.env.AGENT_HOST_RUNTIME_ROOT = runtime;
      process.env.AGENT_HOST_CODEX_HOLDER = 'off';
    }
  } finally {
    for (const account of accounts) await backend.accountDispose({ account }).catch(() => {});
    await defaultRpc.stop();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // The deletion helper unlinks every junction before removing account roots.
    for (const account of accounts) if (await fs.lstat(account.dir).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) await removeCodexAccountDirectory(account);
    assert.ok(path.basename(root).startsWith('pleiad-codex-accounts-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = await import('../lib/test-env.mjs');
  const harness = { ok: (label, value, detail) => { assert.ok(value, `${label}${detail ? `: ${detail}` : ''}`); console.log(`ok ${label}`); } };
  try {
    await test(harness);
    if (process.argv.includes('--baseline')) for (const name of ['codex-models', 'codex-held', 'codex-mode', 'codex-history']) await (await import(`./${name}.mjs`)).default(harness);
  }
  finally { await env.cleanupTestData(); }
}
