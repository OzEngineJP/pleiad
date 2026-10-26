import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runCase, summarize } from '../lib/harness.mjs';
import { prepareAccount, opencodeData, loginAccount, readAccountAuth, accountLoginCommand,prepareCredentialImport,importLegacyCredentials } from '../../core/backends/opencode-accounts.mjs';
import { t as translate } from '../../core/i18n.mjs';

export const name = 'opencode-accounts';
export const title = 'OpenCode accounts: private auth, conversations, context, limits, and holder ownership';

export default async function testOpencodeAccounts(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-accounts-')));
  const envKeys = ['AGENT_HOST_DATA', 'AGENT_HOST_OPENCODE_DATA', 'AGENT_HOST_OPENCODE_BIN', 'AGENT_HOST_OPENCODE_HOLDER', 'AGENT_HOST_RUNTIME_ROOT', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_CONFIG', 'FAKE_OPENCODE_MODEL'];
  const before = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { AGENT_HOST_DATA: path.join(scratch, 'pleiad'), AGENT_HOST_OPENCODE_DATA: path.join(scratch, 'cli'),
    AGENT_HOST_OPENCODE_BIN: `"${process.execPath}" "${fileURLToPath(new URL('../lib/fake-opencode.mjs', import.meta.url))}"`,
    AGENT_HOST_OPENCODE_HOLDER: 'off', OPENAI_API_KEY: 'unrelated-cli-api-key', GEMINI_API_KEY: 'unrelated-gemini-key', OPENCODE_CONFIG: 'unrelated-config' });
  const auth = access => ({ auth: { openai: { type: 'oauth', access, refresh: `refresh-${access}`, expires: Date.now() + 3600000 } } });
  const one = { id: 'acct-one', name: 'One', dir: path.join(scratch, 'accounts', 'acct-one'), credential: auth('one') };
  const two = { id: 'acct-two', name: 'Two', dir: path.join(scratch, 'accounts', 'acct-two'), credential: auth('two') };
  let backend, stop;
  const resultText = events => events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
  try {
    await fs.mkdir(process.env.AGENT_HOST_OPENCODE_DATA, { recursive: true });
    const realAuth = path.join(process.env.AGENT_HOST_OPENCODE_DATA, 'auth.json');
    await fs.writeFile(realAuth, JSON.stringify(auth('current-cli').auth));
    const original = await fs.readFile(realAuth, 'utf8');
    const oneEnv = prepareAccount(one), twoEnv = prepareAccount(two);
    const restored={id:'acct-restored',dir:path.join(scratch,'accounts','acct-restored'),credential:auth('restored')};
    restored.credential.auth.invalid={...restored.credential.auth.openai,expires:1.5};
    restored.credential.auth['https://wellknown.invalid/']={type:'wellknown',key:'ENV_NAME',token:'fixture'};
    prepareAccount(restored);
    const fresh=path.join(opencodeData(restored),'opencode.db'),marker=fresh+'.pleiad-import-auth',created=[];
    prepareCredentialImport(fresh,restored);
    const records=[];let loseResponse=true,wellknownCalls=0;
    const credentials=async(method,_url,options)=>{
      if(method==='GET')return {data:records};
      if(_url.endsWith('/wellknown')) {wellknownCalls++;if(wellknownCalls===1)throw Object.assign(new Error('Manifest unavailable'),{status:400});return null;}
      created.push(options.body);records.push(options.body);
      if(loseResponse){loseResponse=false;throw new Error('Lost response');}
      return {data:options.body};
    };
    assert((await importLegacyCredentials(credentials,fresh,restored)).pending);
    assert(fsSync.existsSync(marker));
    await importLegacyCredentials(credentials,fresh,restored);
    assert.equal(created.length,2);assert.equal(created[0].activate,false);assert.equal(created[0].value.methodID,'chatgpt-browser');
    assert.equal(created[1].integrationID,'https://wellknown.invalid');assert.equal(wellknownCalls,2);
    assert(!fsSync.existsSync(marker));
    await fs.writeFile(fresh,'existing database');records.length=0;
    prepareCredentialImport(fresh,restored);await importLegacyCredentials(credentials,fresh,restored);
    assert.equal(created.length,2);
    t.ok('Fresh v2 credential restore survives a lost API response once and does not reimport into an existing logged-out database',true);
    const legacyBroken=path.join(scratch,'broken.db');
    prepareCredentialImport(legacyBroken);
    await fs.writeFile(realAuth,'{');
    prepareCredentialImport(legacyBroken);
    await importLegacyCredentials(credentials,legacyBroken);
    assert(fsSync.existsSync(legacyBroken+'.pleiad-import-auth'));
    for(let retry=0;retry<4;retry++)await importLegacyCredentials(credentials,legacyBroken);
    assert(!fsSync.existsSync(legacyBroken+'.pleiad-import-auth'));
    await fs.writeFile(realAuth,original);
    const linkedAuth=path.join(scratch,'auth-link.json');
    await fs.rename(realAuth,linkedAuth);await fs.link(linkedAuth,realAuth);
    prepareCredentialImport(legacyBroken);
    assert(!fsSync.existsSync(legacyBroken+'.pleiad-import-auth'));
    await fs.unlink(realAuth);await fs.rename(linkedAuth,realAuth);
    t.ok('Malformed or linked legacy credentials do not prevent startup or remain pending',true);
    assert.notEqual(oneEnv.XDG_DATA_HOME, twoEnv.XDG_DATA_HOME);
    assert.notEqual(oneEnv.XDG_CONFIG_HOME, twoEnv.XDG_CONFIG_HOME);
    assert.notEqual(oneEnv.XDG_STATE_HOME, twoEnv.XDG_STATE_HOME);
    assert.equal(readAccountAuth(one).openai.access, 'one');
    await fs.writeFile(path.join(opencodeData(one), 'auth.json'), JSON.stringify(auth('refreshed-one').auth));
    prepareAccount(one);
    assert.equal(readAccountAuth(one).openai.access, 'refreshed-one');
    assert.equal(await fs.readFile(realAuth, 'utf8'), original);
    t.ok('account data/config/cache/state and auth isolate; refreshed CLI auth wins over saved snapshot', true);

    // A private area that links into the CLI credential store fails closed
    // and never chmods, reads or overwrites the user's default CLI auth.
    const seedAccount = id => ({ id, dir: path.join(scratch, 'accounts', id), credential: auth(`seed-${id}`) });
    const openAuthDir = async account => { await fs.mkdir(path.join(opencodeData(account)), { recursive: true }); };
    const linked = seedAccount('acct-linked');
    await openAuthDir(linked);
    let fileSymlinks = true;
    try { await fs.symlink(realAuth, path.join(opencodeData(linked), 'auth.json'), 'file'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      fileSymlinks = false;
    }
    if (fileSymlinks) {
      await assert.rejects(async () => readAccountAuth(linked), /Unsafe OpenCode authentication file/);
      await assert.rejects(async () => prepareAccount(linked), /Unsafe OpenCode authentication file/);
      assert.equal((await fs.lstat(path.join(opencodeData(linked), 'auth.json'))).isSymbolicLink(), true);
      assert.equal(await fs.readFile(realAuth, 'utf8'), original);
      await fs.unlink(path.join(opencodeData(linked), 'auth.json'));
      t.ok('an auth symlink to the CLI store is refused by read/prepare and neither the link nor the CLI auth changes', true);
    } else {
      t.note('File symlink scenario skipped: Windows did not grant symlink creation; hardlink isolation is tested below.');
    }
    const hard = seedAccount('acct-hard');
    await openAuthDir(hard);
    await fs.link(realAuth, path.join(opencodeData(hard), 'auth.json'));
    await assert.rejects(async () => readAccountAuth(hard), /Unsafe OpenCode authentication file/);
    await assert.rejects(async () => prepareAccount(hard), /Unsafe OpenCode authentication file/);
    assert.equal((await fs.stat(path.join(opencodeData(hard), 'auth.json'))).nlink >= 2, true);
    assert.equal(await fs.readFile(realAuth, 'utf8'), original);
    t.ok('a hardlinked auth is refused and the shared CLI store is left untouched', true);

    const dirLinked = seedAccount('acct-dirlinked');
    await fs.mkdir(dirLinked.dir, { recursive: true });
    await fs.mkdir(path.join(dirLinked.dir, 'data'), { recursive: true });
    await fs.symlink(process.env.AGENT_HOST_OPENCODE_DATA, path.join(dirLinked.dir, 'data', 'opencode'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(async () => readAccountAuth(dirLinked), /Unsafe OpenCode account directory/);
    await assert.rejects(async () => prepareAccount(dirLinked), /Unsafe OpenCode account directory/);
    assert.equal(await fs.readFile(realAuth, 'utf8'), original);
    t.ok('a data directory linked to the CLI data directory is refused and the CLI auth is untouched', true);

    const emptyTarget = path.join(scratch, 'empty-external');
    await fs.mkdir(emptyTarget);
    const absent = seedAccount('acct-absent');
    await fs.mkdir(path.join(absent.dir, 'data'), { recursive: true });
    await fs.symlink(emptyTarget, opencodeData(absent), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readAccountAuth(absent), /Unsafe OpenCode account directory/);
    assert.deepEqual(await fs.readdir(emptyTarget), []);
    t.ok('an unsafe directory with no auth cannot silently fall back to its saved credential', true);

    const changing = seedAccount('acct-changing');
    prepareAccount(changing);
    const cliMode = (await fs.stat(realAuth)).mode;
    const swappingLogin = loginAccount({ account: changing, argv: ['opencode'], timeoutMs: 1000, pollMs: 5,
      emit: e => { if (e.phase === 'url') {
        // The replacement happens before the first poll, after initial validation.
        fsSync.renameSync(opencodeData(changing), `${opencodeData(changing)}-saved`);
        fsSync.symlinkSync(process.env.AGENT_HOST_OPENCODE_DATA, opencodeData(changing), process.platform === 'win32' ? 'junction' : 'dir');
      } } });
    await assert.rejects(swappingLogin, /Unsafe OpenCode account directory/);
    assert.equal(await fs.readFile(realAuth, 'utf8'), original);
    assert.equal((await fs.stat(realAuth)).mode, cliMode);
    t.ok('a directory replaced during login is refused before reading or chmodding the CLI auth', true);

    const overlapping = { id: 'acct-overlap', dir: path.join(process.env.AGENT_HOST_OPENCODE_DATA, 'acct-overlap') };
    await assert.rejects(async () => prepareAccount(overlapping), /overlaps the CLI data directory/);
    assert.equal(await fs.readFile(realAuth, 'utf8'), original);
    t.ok('an account directory nested in the CLI data directory is refused', true);

    const cliAlias = path.join(scratch, 'cli-alias');
    await fs.symlink(process.env.AGENT_HOST_OPENCODE_DATA, cliAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const cliData = process.env.AGENT_HOST_OPENCODE_DATA;
    process.env.AGENT_HOST_OPENCODE_DATA = cliAlias;
    try { assert.throws(() => prepareAccount(overlapping), /overlaps the CLI data directory/); }
    finally { process.env.AGENT_HOST_OPENCODE_DATA = cliData; }
    t.ok('a CLI data alias cannot hide overlap with an account directory', true);

    const ancestorOverlap = seedAccount('acct-ancestor-overlap');
    await fs.mkdir(path.join(ancestorOverlap.dir, 'data'), { recursive: true });
    const ancestorAlias = path.join(scratch, 'cli-parent-alias');
    await fs.symlink(path.join(ancestorOverlap.dir, 'data'), ancestorAlias, process.platform === 'win32' ? 'junction' : 'dir');
    process.env.AGENT_HOST_OPENCODE_DATA = path.join(ancestorAlias, 'missing', 'opencode');
    try {
      assert.throws(() => prepareAccount(ancestorOverlap), /overlaps the CLI data directory/);
      assert.throws(() => readAccountAuth(ancestorOverlap), /overlaps the CLI data directory/);
      assert.equal(fsSync.existsSync(opencodeData(ancestorOverlap)), false);
      assert.equal(fsSync.existsSync(process.env.AGENT_HOST_OPENCODE_DATA), false);
    } finally { process.env.AGENT_HOST_OPENCODE_DATA = cliData; }
    t.ok('an absent CLI path below an aliased ancestor is refused before creating directories or writing a credential seed', true);

    for (const phase of ['account', 'data', 'auth']) {
      const swapped = seedAccount(`acct-swap-${phase}`);
      const mkdir = fsSync.mkdirSync, lstat = fsSync.lstatSync;
      let changed = false;
      try {
        fsSync.mkdirSync = (file, ...options) => {
          const result = mkdir(file, ...options);
          if (!changed && ((phase === 'account' && file === swapped.dir) || (phase === 'data' && file === path.join(swapped.dir, 'data')))) {
            changed = true; process.env.AGENT_HOST_OPENCODE_DATA = path.join(swapped.dir, 'uncreated-cli');
          }
          return result;
        };
        fsSync.lstatSync = (file, ...options) => {
          const result = lstat(file, ...options);
          if (!changed && phase === 'auth' && file === path.join(opencodeData(swapped), 'auth.json')) {
            changed = true; process.env.AGENT_HOST_OPENCODE_DATA = path.join(swapped.dir, 'uncreated-cli');
          }
          return result;
        };
        assert.throws(() => prepareAccount(swapped), /overlaps the CLI data directory/);
        assert.equal(changed, true);
        assert.equal(fsSync.existsSync(path.join(opencodeData(swapped), 'auth.json')), false);
      } finally { fsSync.mkdirSync = mkdir; fsSync.lstatSync = lstat; process.env.AGENT_HOST_OPENCODE_DATA = cliData; }
      t.ok(`account overlap is revalidated after ${phase} preparation and before credential writes`, true);
    }

    const broken = seedAccount('acct-broken');
    await openAuthDir(broken);
    await fs.writeFile(path.join(opencodeData(broken), 'auth.json'), '{not-json');
    await assert.rejects(async () => readAccountAuth(broken), { message: translate('accounts.backend.credentialUnreadable', { agent: 'OpenCode' }) });
    t.ok('an unreadable account auth fails closed instead of silently using the saved seed', true);

    const login = { id: 'acct-login', dir: path.join(scratch, 'accounts', 'acct-login') };
    const emitted = [];
    const signing = loginAccount({ account: login, argv: ['opencode'], timeoutMs: 1000, pollMs: 10, emit: e => emitted.push(e) });
    await fs.writeFile(path.join(opencodeData(login), 'auth.json'), JSON.stringify(auth('logged-in').auth));
    const signed = await signing;
    assert.equal(signed.credential.auth.openai.access, 'logged-in');
    assert.equal(emitted[0].phase, 'url');
    assert.equal(emitted[0].message, translate('opencode.auth.accountRunCommand'));
    assert.equal(emitted.at(-1).message, translate('opencode.auth.accountLoggedIn'));
    assert.ok(!emitted[0].url.includes('logged-in'));
    const encoded = accountLoginCommand(login, ['C:/Program Files/opencode.exe'], 'win32').split(' ').at(-1);
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.ok(script.includes(login.dir) && script.includes('XDG_DATA_HOME') && script.includes('auth'));
    const aborter = new AbortController();
    const cancelled = loginAccount({ account: login, argv: ['opencode'], signal: aborter.signal, pollMs: 10 });
    aborter.abort();
    await assert.rejects(cancelled, { name: 'AbortError', code: 'ABORT_ERR', message: translate('accounts.backend.loginCancelled', { agent: 'OpenCode' }) });
    const rejected = loginAccount({ account: login, argv: ['opencode'], timeoutMs: 25, pollMs: 5 });
    await assert.rejects(rejected, { message: translate('opencode.auth.loginTimeout') });
    t.ok('login publishes only an isolated terminal command, observes auth change, supports abort and timeout', true);

    ({ backend, stopOpencodeServer: stop } = await import('../../core/backends/opencode.mjs'));
    const { opencodeRelay } = await import('../../core/opencode-relay.mjs');
    opencodeRelay.setOrigin('http://127.0.0.1:1');
    assert.equal(backend.capabilities.accounts, 'agent');
    assert.equal((await backend.accountStatus({ account: one })).hasCredential, true);
    assert.equal((await backend.accountStatus({ account: { id: 'none', dir: path.join(scratch, 'none') } })).hasCredential, false);
    const { DatabaseSync } = (await import('../../core/db.mjs')).loadSqlite();
    const offlineOne = `ses_offline_one_${path.basename(scratch)}`, offlineTwo = `ses_offline_two_${path.basename(scratch)}`;
    for (const [account, id] of [[one, offlineOne], [two, offlineTwo]]) {
      const db = new DatabaseSync(path.join(opencodeData(account), 'opencode.db'));
      db.exec('create table session (id text, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer); create table message (id text, session_id text, data text, time_created integer); create table part (id text, message_id text, session_id text, data text, time_created integer)');
      db.prepare('insert into session values (?, null, ?, ?, 1000, 1000, null)').run(id, scratch, account.name);
      db.prepare('insert into message values (?, ?, ?, 1000)').run(`${id}_msg`, id, JSON.stringify({ role: 'user' }));
      db.prepare('insert into part values (?, ?, ?, ?, 1000)').run(`${id}_part`, `${id}_msg`, id, JSON.stringify({ type: 'text', text: `history ${account.name}` }));
      db.close();
    }
    assert.deepEqual((await backend.listSessions({ account: one })).map(s => s.sessionId), [offlineOne]);
    assert.equal((await backend.getSession(offlineTwo, { account: two })).title, 'Two');
    assert.equal((await backend.getMessages(offlineOne, { account: one }))[0].text, 'history One');
    t.ok('offline session and message database reads select the account data directory', true);
    const run = async (account, prompt, extra = {}) => {
      const events = [];
      const result = await backend.runTurn({ cwd: scratch, mode: 'ask', prompt, account, emit: e => events.push(e), ...extra });
      return { ...result, events, text: resultText(events) };
    };
    const first = await run(one, 'account-env');
    process.env.FAKE_OPENCODE_MODEL = 'fake/tiny';
    const second = await run(two, 'account-env');
    delete process.env.FAKE_OPENCODE_MODEL;
    const firstEnv = JSON.parse(first.text), secondEnv = JSON.parse(second.text);
    assert.equal(firstEnv.accountId, one.id);
    assert.equal(secondEnv.accountId, two.id);
    assert.equal(firstEnv.inheritedOpenAI, false);
    assert.equal(firstEnv.inheritedGemini, false);
    assert.equal(firstEnv.inheritedConfig, false);
    assert.equal(firstEnv.data, oneEnv.XDG_DATA_HOME);
    assert.equal(secondEnv.data, twoEnv.XDG_DATA_HOME);
    assert.equal((await backend.models(scratch, { account: one }))[''].resolvesTo, 'fake/echo');
    assert.equal((await backend.models(scratch, { account: two }))[''].resolvesTo, 'fake/tiny');
    const continued = await run(one, 'continued one', { sessionId: first.sessionId });
    assert.match(continued.text, /continued one/);
    assert.equal((await backend.getMessages(first.sessionId, { account: one })).filter(m => m.role === 'user').length, 2);
    assert.equal((await backend.listSessions({ account: two })).length, 1);
    assert.ok(!(await backend.listSessions({ account: two })).some(s => s.id === first.sessionId));
    await assert.rejects(backend.getMessages(first.sessionId, { account: two }), /different account/);
    await assert.rejects(run(two, 'wrong account', { sessionId: first.sessionId }), /different account/);
    await backend.setTitle(first.sessionId, 'Account One Title', { account: one });
    assert.equal((await backend.getSession(first.sessionId, { account: one })).title, 'Account One Title');
    const fork = await backend.fork(first.sessionId, { account: one, title: 'Account One Fork' });
    assert.equal(fork.accountId, one.id);
    assert.equal((await backend.getSession(fork.sessionId, { account: one })).title, 'Account One Fork');
    assert.ok(!(await backend.listSessions({ account: two })).some(s => s.id === fork.sessionId));
    t.ok('turn, continuation, history, title and fork stay with their selected account; cross-account resume fails', true);

    const compactEvents = [];
    await backend.compact({ sessionId: first.sessionId, account: one, emit: e => compactEvents.push(e) });
    assert.ok(compactEvents.some(e => e.phase === 'complete'));
    const task = await run(one, 'task');
    const [child] = await backend.listSubagents(task.sessionId, { account: one });
    assert.ok(child);
    assert.ok((await backend.getSubagentMessages(task.sessionId, child, { account: one })).length > 0);
    assert.ok(await backend.getSubagentOrigin(task.sessionId, child, { account: one }));
    const managed = await run(one, 'account-env', { contextRuntime: { owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' } } });
    assert.equal(JSON.parse(managed.text).data, oneEnv.XDG_DATA_HOME);
    assert.ok(JSON.parse(managed.text).config.startsWith(one.dir));
    const suggestions = await run(two, 'candidate generation', { addedInstructions: 'Return a next-prompt candidate.' });
    assert.match(suggestions.text, /candidate generation/);
    const limited = await run(one, 'limited');
    const partial = await run(two, 'partial-limited');
    const toolLimited = await run(one, 'tool-limited');
    assert.ok(limited.events.some(e => e.type === 'turnResult' && e.outcome === 'limited' && e.pristine === true && e.resetsAt));
    assert.ok(partial.events.some(e => e.type === 'turnResult' && e.outcome === 'limited' && e.pristine === false));
    assert.ok(toolLimited.events.some(e => e.type === 'tool.start'));
    assert.ok(toolLimited.events.some(e => e.type === 'turnResult' && e.outcome === 'limited' && e.pristine === false));
    assert.equal(await fs.readFile(realAuth, 'utf8'), original);
    t.ok('compaction, subagents, managed context, candidate turns and limited/pristine preserve account ownership', true);

    const boundOne = await backend.forAccount(one);
    const boundTwo = await boundOne.forAccount(two);
    const boundLogin = await boundOne.forAccount(null);
    await fs.rename(realAuth, `${realAuth}.saved`);
    try { assert.equal((await boundLogin.auth.status()).loggedIn, true); }
    finally { await fs.rename(`${realAuth}.saved`, realAuth); }
    assert.ok(!Object.hasOwn(boundOne, 'account') && !Object.hasOwn(boundOne, 'credential'));
    const boundEvents = [];
    const boundTurn = await boundTwo.runTurn({ cwd: scratch, prompt: 'account-env', mode: 'ask', account: one, emit: e => boundEvents.push(e) });
    assert.equal(JSON.parse(resultText(boundEvents)).accountId, two.id);
    assert.equal((await boundOne.models(scratch, { account: two }))[''].resolvesTo, 'fake/echo');
    assert.equal((await boundTwo.models(scratch))[''].resolvesTo, 'fake/tiny');
    assert.equal((await boundOne.getSession(first.sessionId)).title, 'Account One Title');
    assert.ok((await boundOne.getMessages(first.sessionId, { account: two })).length > 0);
    await assert.rejects(boundTwo.getMessages(first.sessionId), /different account/);
    await boundTwo.setTitle(boundTurn.sessionId, 'Bound Two');
    assert.equal((await boundTwo.getSession(boundTurn.sessionId)).title, 'Bound Two');
    const boundFork = await boundTwo.fork(boundTurn.sessionId, { title: 'Bound Fork' });
    assert.equal(boundFork.accountId, two.id);
    assert.equal((await boundTwo.auth.status()).loggedIn, true);
    const savedOne = await fs.readFile(path.join(opencodeData(one), 'auth.json'), 'utf8');
    await fs.writeFile(path.join(opencodeData(one), 'auth.json'), JSON.stringify({ openai: { ...JSON.parse(savedOne).openai, expires: 1 } }));
    const boundUsage = await boundOne.usage({ accounts: [two] });
    assert.equal(boundUsage.accountId, one.id);
    assert.deepEqual(boundUsage.accounts.map(a => a.accountId), [one.id]);
    await fs.writeFile(path.join(opencodeData(one), 'auth.json'), savedOne);
    t.ok('forAccount binds every entry, options cannot override it, rebind selects last account, usage reads only that account', true);

    const { HeldOpencode, opencodeChildId, expandHeldOpencode, acquireHeldOpencode } = await import('../../core/backends/opencode-held.mjs');
    const client = new EventEmitter();
    Object.assign(client, { connected: true, label() {}, detach: async () => {}, release() {}, ack() {} });
    const heldOne = new HeldOpencode({ client, spawned: false, id: opencodeChildId(one), server: { account: { id: one.id, dir: one.dir } } });
    const heldTwo = new HeldOpencode({ client, spawned: false, id: opencodeChildId(two), server: { account: { id: two.id, dir: two.dir } } });
    heldOne.putCard(first.sessionId, { backendCard: { account: { id: one.id, dir: one.dir } } });
    heldTwo.putCard(second.sessionId, { backendCard: { account: { id: two.id, dir: two.dir } } });
    assert.notEqual(heldOne.id, heldTwo.id);
    assert.equal(heldOne.labelObject().server.account.id, one.id);
    client.emit('exit', { id: heldTwo.id, code: 0 });
    assert.equal(heldTwo.closed, true);
    assert.equal(heldOne.closed, false);
    assert.ok(!JSON.stringify(heldOne.labelObject()).includes('refresh-'));
    heldOne.dispose();
    heldTwo.dispose();
    t.ok('holder ids, labels, exit events and ordinary server disposal isolate account processes and contain no provider credentials', true);

    process.env.AGENT_HOST_OPENCODE_HOLDER = 'on';
    process.env.AGENT_HOST_RUNTIME_ROOT = path.join(scratch, 'fake-runtime');
    client.attach = async () => ({ alive: true });
    const restore = async (account, sessionId) => {
      const label = { k: 'opencode-server', v: 1, server: { base: 'http://127.0.0.1:1', auth: 'Basic fake', secret: opencodeRelay.secret,
        account: { id: account.id, dir: account.dir } }, turns: { [sessionId]: { backendCard: { account: { id: account.id, dir: account.dir } } } } };
      return expandHeldOpencode({ client, child: { id: opencodeChildId(account), alive: true, label } });
    };
    const restoredOne = await restore(one, first.sessionId);
    const restoredTwo = await restore(two, second.sessionId);
    const acquiredOne = await acquireHeldOpencode({ argv: ['fake'], account: one });
    const acquiredTwo = await acquireHeldOpencode({ argv: ['fake'], account: two });
    assert.equal(acquiredOne.server.account.id, one.id);
    assert.equal(acquiredTwo.server.account.id, two.id);
    assert.notEqual(acquiredOne.id, acquiredTwo.id);
    assert.equal(restoredOne[0].opencode, acquiredOne);
    assert.equal(restoredTwo[0].opencode, acquiredTwo);
    await assert.rejects(backend.accountRemove({ account: one }), { message: translate('accounts.backend.inUse', { agent: 'OpenCode' }) });
    await assert.rejects(backend.adoptTurn({ account: one, sessionId: first.sessionId, card: { held: true, account: two }, source: { held: true } }), /holder account mismatch/);
    for (const held of [acquiredOne, acquiredTwo]) { client.emit('exit', { id: held.id, code: 0 }); held.dispose(); }
    for (const source of [...restoredOne, ...restoredTwo]) source.dispose();
    process.env.AGENT_HOST_OPENCODE_HOLDER = 'off';
    t.ok('multiple adopted holder children remain separate through acquisition; mismatched adoption and busy removal fail', true);

    const turnAbort = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const running = run(one, 'slow', { signal: { signal: turnAbort.signal }, control: { onReady: started } });
    // Starting/preparing is already a use, before the prompt reaches the CLI.
    await assert.rejects(backend.accountRemove({ account: one }), { message: translate('accounts.backend.inUse', { agent: 'OpenCode' }) });
    await ready;
    await assert.rejects(backend.accountRemove({ account: one }), { message: translate('accounts.backend.inUse', { agent: 'OpenCode' }) });
    turnAbort.abort();
    await running;
    await backend.accountRemove({ account: one });
    assert.equal(readAccountAuth(one).openai.access, 'refreshed-one');
    assert.ok((await backend.getMessages(second.sessionId, { account: two })).length > 0);
    t.ok('removal refuses preparing/running accounts, stops idle server, preserves credentials and other account', true);
  } finally {
    await stop?.();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = summarize([await runCase({ name, title, default: testOpencodeAccounts })]);
