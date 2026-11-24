import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backend, probeClaudeConnectors, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { credentialsMissing, readClaudeAccountsUsage, shouldMarkUsageExpired } from '../../core/backends/claude-usage.mjs';
import { createClaudeAccounts } from '../../core/claude-accounts.mjs';
import * as connectorsAuth from '../../core/claude-connectors-auth.mjs';
import { claudeOwnDirEnv, createClaudeConnectorsWiring, VERIFIED_VERSIONS } from '../../core/claude-connectors-auth.mjs';
import { createClaudeLogin } from '../../core/claude-login.mjs';
import {
  claudeKeychainService, claudeLoginPresent, ensureClaudeOwnDirLinks, KEYCHAIN_TIMEOUT_MS, logoutClaudeOwnDir, macKeychainAuthFailure, OWN_DIR, sshSession,
  withClaudeUsageDir,
} from '../../core/claude-own-dir.mjs';
import { recordPlatform } from '../lib/claude-launch-record.mjs';

export const name = 'claude-own-dir';
export const title = 'コネクターの専用フォルダ方式（macOS のキーチェーンの有無の判定を含む）';

const id = 'acct-abcdef012345';
const account = { id, name: 'Example' };
const put = (dir, file, text) => fs.writeFile(path.join(dir, file), text);
const read = (dir, file) => fs.readFile(path.join(dir, file), 'utf8');

/**
 * 偽物の security。呼ばれた引数を全部覚え、決めた結果を返す（本物の鍵束には触れない）。
 * reply は { exitCode } / { timedOut } / { startCode } / 例外
 */
function fakeSecurity(reply = { exitCode: 0 }) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const r = typeof reply === 'function' ? reply(file, args) : reply;
    if (r instanceof Error) throw r;
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, stopped: false, ...r };
  };
  return { run, calls };
}
/** 中身を読む・出す呼び方（-w・-g）と、鍵束を書き換える呼び方をしていないか */
const readsSecret = calls => calls.some(c => c.args.some(a => ['-w', '-g'].includes(a))
  || c.args.some(a => /^(?:delete|add|set|unlock|lock)-/.test(a)));

async function macKeychain(t, root) {
  // 1. 項目名: CLAUDE_CONFIG_DIR に渡す文字列（NFC）の SHA-256 の先頭 8 桁。realpath・末尾の / の調整はしない
  const dir = '/Users/example/pleiad-data/claude-usage/acct-abcdef012345';
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  t.ok('macOS: 項目名は CLAUDE_CONFIG_DIR の文字列そのものから作る（ハッシュ付き）', claudeKeychainService(dir) === `Claude Code-credentials-${hash}`);
  t.ok('macOS: 末尾の / は別の項目・NFD は NFC に揃えてから作る',
    claudeKeychainService(`${dir}/`) !== claudeKeychainService(dir)
    && claudeKeychainService('/Users/ex/ガ') === claudeKeychainService('/Users/ex/ガ'));

  // 2. 終了コードごとの種類
  const all = [];
  const rows = [
    [{ exitCode: 0 }, 'present', '0 → ログインあり'],
    [{ exitCode: 44 }, 'missing', '44（項目なし） → ログインし直す'],
    [{ exitCode: 36 }, 'keychain', '36（ロック） → keychain'],
    [{ exitCode: 51 }, 'keychain', '51（認証失敗） → keychain'],
    [{ exitCode: 128 }, 'keychain', '128（拒否） → keychain'],
    [{ exitCode: 1 }, 'keychain', '知らない失敗 → keychain'],
    [{ timedOut: true }, 'keychain', '打ち切り（5 秒） → keychain'],
    [{ exitCode: 44, timedOut: true }, 'keychain', '打ち切りは終了コードより先 → keychain'],
    [{ exitCode: 50 }, 'platform', '50（鍵束なし） → platform'],
    [{ exitCode: 37 }, 'platform', '37（既定の鍵束なし） → platform'],
    [{ startCode: 'ENOENT', startError: 'spawn ENOENT' }, 'platform', 'security が無い → platform'],
    [Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), 'platform', 'security を起こせない（例外の ENOENT） → platform'],
    [new Error('boom'), 'keychain', 'そのほかの例外 → keychain'],
  ];
  for (const [reply, want, label] of rows) {
    const sec = fakeSecurity(reply);
    const got = await claudeLoginPresent(dir, { platform: 'darwin', run: sec.run, account: 'login-name-0001' });
    all.push(...sec.calls);
    const c = sec.calls[0];
    t.ok(`macOS: ${label}`, got === want && sec.calls.length === 1 && c.file === '/usr/bin/security'
      && c.args.join(' ') === `find-generic-password -s Claude Code-credentials-${hash} -a login-name-0001`
      && c.options.timeoutMs === KEYCHAIN_TIMEOUT_MS && KEYCHAIN_TIMEOUT_MS === 5_000, `${got} ${JSON.stringify(c)}`);
  }
  {
    const sec = fakeSecurity({ exitCode: 0 });
    await claudeLoginPresent(dir, { platform: 'darwin', run: sec.run });
    all.push(...sec.calls);
    t.ok('macOS: 既定の account は OS のログイン名', sec.calls[0].args.at(-1) === os.userInfo().username);
  }

  // 3. Windows・Linux は .credentials.json の有無だけ（security は呼ばない）
  const fileDir = path.join(root, 'file-login');
  await fs.mkdir(fileDir, { recursive: true });
  const none = fakeSecurity();
  const before = await claudeLoginPresent(fileDir, { platform: 'linux', run: none.run });
  await put(fileDir, '.credentials.json', '{}');
  const after = await claudeLoginPresent(fileDir, { platform: 'win32', run: none.run });
  t.ok('Windows・Linux: ファイルの有無で判定し、security は呼ばない', before === 'missing' && after === 'present' && none.calls.length === 0);

  // 4. 使用量の credentialsMissing も同じ関数を使う（macOS で「ログインし直す」を出せるのは 44 のときだけ）
  const usageRows = [[{ exitCode: 44 }, true], [{ exitCode: 0 }, false], [{ exitCode: 36 }, false], [{ timedOut: true }, false], [{ exitCode: 50 }, false]];
  const usageBad = [];
  for (const [reply, want] of usageRows) {
    const sec = fakeSecurity(reply);
    const got = await credentialsMissing({ configDir: dir, env: {}, platform: 'darwin',
      readFile: async () => { throw new Error('macOS must not read .credentials.json'); },
      present: (d, o) => claudeLoginPresent(d, { ...o, run: sec.run, account: 'login-name-0001' }) });
    all.push(...sec.calls);
    if (got !== want || sec.calls[0]?.args[2] !== claudeKeychainService(dir)) usageBad.push(`${JSON.stringify(reply)} → ${got}`);
  }
  const loggedIn = fakeSecurity({ exitCode: 44 });
  const mine = await credentialsMissing({ env: {}, platform: 'darwin', present: (d, o) => claudeLoginPresent(d, { ...o, run: loggedIn.run }) });
  const apiKey = await credentialsMissing({ configDir: dir, env: { ANTHROPIC_API_KEY: 'fake-key' }, platform: 'darwin',
    present: (d, o) => claudeLoginPresent(d, { ...o, run: loggedIn.run }) });
  t.ok('使用量（macOS）: 登録したアカウントは項目の有無で判定し、44 のときだけログインし直しを出す。ログイン中のアカウントと API キーは見ない',
    usageBad.length === 0 && mine === false && apiKey === false && loggedIn.calls.length === 0, usageBad.join(' | '));

  // 5. 会話の検査: macOS の種類
  const dataDir = path.join(root, 'mac-data');
  await fs.mkdir(dataDir, { recursive: true });
  await put(dataDir, 'claude-accounts.json', JSON.stringify({ version: 1, accounts: [account] }));
  const noSecrets = { get: async () => null, delete: async () => {} };
  const accounts = createClaudeAccounts({ dataDir, secrets: noSecrets, cliConfig: path.join(root, 'mac.claude.json') });
  const own = accounts.usageDir(id);
  await fs.mkdir(own, { recursive: true });
  await put(own, 'ply-usage-login.json', '{}');
  const unexpected = () => assert.fail('own-dir entered the b1 authentication path');
  const CODES = { present: 0, missing: 44, keychain: 36, platform: 50 };
  let answer = 'present';
  const seenDirs = [];
  const wiringFor = (platform, extraEnv = {}) => createClaudeConnectorsWiring({
    dataDir, accounts, env: { CLAUDE_CONFIG_DIR: path.join(root, 'mac-shared'), ...extraEnv }, home: root, managedFiles: [], platform,
    versions: async () => VERIFIED_VERSIONS[0], usage: { refresh: unexpected, guard: unexpected }, probe: unexpected,
    loginPresent: async (d, o) => {
      seenDirs.push(d);
      const sec = fakeSecurity({ exitCode: CODES[answer] });
      const got = await claudeLoginPresent(d, { ...o, run: sec.run, account: 'login-name-0001' });
      all.push(...sec.calls);
      return got;
    },
  });
  await wiringFor('darwin').settings.setEnabled(id, true, OWN_DIR);
  const lifted = wiringFor('darwin');
  const kinds = {};
  for (const a of Object.keys(CODES)) {
    answer = a;
    const r = await lifted.inspect(account, { mode: OWN_DIR });
    kinds[a] = `${r.kind}:${r.reauth ?? ''}`;
  }
  t.ok('macOS（既定で使える。ADR 0351）: 0 → 使える・44 → ownDirLogin（ログインし直す）・36 → keychain（ログインし直しは出さない）・50 → platform',
    kinds.present === 'ok:' && kinds.missing === 'ownDirLogin:true' && kinds.keychain === 'keychain:false' && kinds.platform === 'platform:false', JSON.stringify(kinds));
  answer = 'keychain';
  await assert.rejects(lifted.resolve(id), e => e.code === 'connectors-keychain' && e.connectorsError?.reauth === false);
  answer = 'present';
  const oldMarker = await wiringFor('darwin', { AGENT_HOST_MACOS_OWN_DIR: '0' }).inspect(account, { mode: OWN_DIR });
  t.ok('macOS: 前の試験用の目印（AGENT_HOST_MACOS_OWN_DIR）は見ない', oldMarker.kind === 'ok', JSON.stringify(oldMarker));

  // 6. 4 つの経路（ログイン・会話・使用量・有無の判定）と削除の logout が同じ文字列を使う
  const pty = { last: null };
  const login = createClaudeLogin({
    command: () => ['/usr/local/bin/claude'], emit: () => {}, saveToken: async () => ({ id }), markUsageLogin: async () => {},
    usageDir: aid => accounts.usageDir(aid), scratchDir: path.join(root, 'mac-scratch'), env: {},
    spawn: (argv, args, opts) => { pty.last = { argv, args, opts }; return { onData() {}, onExit() {}, write() {}, kill() {} }; },
  });
  const { loginId } = login.start({ kind: 'usage-login', accountId: id });
  login.cancel(loginId);
  const loginDir = pty.last.opts.env.CLAUDE_CONFIG_DIR;
  seenDirs.length = 0;
  const runtime = await lifted.resolve(id);
  const checkDir = seenDirs[0];
  let prepared = null;
  try { prepared = (await runtime.connectors.prepare()).env.CLAUDE_CONFIG_DIR; }
  catch (err) { if (!(process.platform === 'win32' && ['ownDirLinksWindows', 'ownDirLinks'].includes(err?.connectorsKind ?? err?.connectorsError?.kind))) throw err; }
  const usageDir = (await accounts.usageTargets()).find(a => a.id === id).configDir;
  const logoutSec = fakeSecurity({ exitCode: 44 });
  const logoutRuns = [];
  const logs = [];
  const gone = await logoutClaudeOwnDir(own, { platform: 'darwin', command: () => ['/usr/local/bin/claude'], env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-token', PATH: '/usr/bin' },
    run: async (file, args, options) => {
      if (file === '/usr/bin/security') return logoutSec.run(file, args, options);
      logoutRuns.push({ file, args, options });
      return { exitCode: 0 };
    },
    present: (d, o) => claudeLoginPresent(d, { ...o, account: 'login-name-0001' }), log: m => logs.push(m) });
  all.push(...logoutSec.calls);
  const logoutDir = logoutRuns[0]?.options.env.CLAUDE_CONFIG_DIR;
  const strings = { login: loginDir, check: checkDir, conversation: prepared ?? checkDir, usage: usageDir, logout: logoutDir };
  t.ok('同じ文字列: ログイン（usage-login）・有無の判定・会話の CLAUDE_CONFIG_DIR・使用量の configDir・削除の logout が accounts.usageDir(id) と一字一句同じ',
    Object.values(strings).every(v => v === own) && logoutSec.calls[0]?.args[2] === claudeKeychainService(own), JSON.stringify(strings));
  if (prepared === null) t.skip('会話の CLAUDE_CONFIG_DIR の実物（リンクの作成権限がない Windows。prepare は有無の判定と同じ dir を渡す）');

  // 7. 削除: macOS だけ claude auth logout（認証の指定を外し、同じフォルダを渡す）→ 有無を確かめる。残っていればログに書くが止めない
  t.ok('削除（macOS）: CLI に auth logout をさせ、Pleiad は security で消さない。会話用トークンは子へ渡さない。消えたら removed',
    gone === 'removed' && logoutRuns.length === 1 && logoutRuns[0].file === '/usr/local/bin/claude' && logoutRuns[0].args.join(' ') === 'auth logout'
    && logoutRuns[0].options.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && logoutRuns[0].options.env.PATH === '/usr/bin' && logs.length === 0, JSON.stringify(logoutRuns));
  const remainLogs = [];
  const remain = await logoutClaudeOwnDir(own, { platform: 'darwin', command: ['/usr/local/bin/claude'], env: {},
    run: async file => (file === '/usr/bin/security' ? { exitCode: 0 } : { exitCode: 1 }), log: m => remainLogs.push(m) });
  t.ok('削除（macOS）: 失敗して項目が残ってもログに書くだけ（秘密は書かない）', remain === 'present' && remainLogs.length === 2 && !remainLogs.join().includes('fake'), JSON.stringify(remainLogs));
  const skipped = [];
  const onWin = await logoutClaudeOwnDir(own, { platform: 'win32', command: ['/x'], run: async (...a) => { skipped.push(a); return { exitCode: 0 }; } });
  const noDir = await logoutClaudeOwnDir(path.join(root, 'never-logged-in'), { platform: 'darwin', command: ['/x'], run: async (...a) => { skipped.push(a); return { exitCode: 0 }; } });
  t.ok('削除: Windows・Linux と、使用量のログインをしていない（フォルダが無い）アカウントでは CLI を呼ばない', onWin === 'skipped' && noDir === 'skipped' && skipped.length === 0);
  const order = [];
  const removing = createClaudeAccounts({ dataDir, secrets: noSecrets, cliConfig: path.join(root, 'mac.claude.json'),
    logout: async d => { order.push([d, Boolean(await fs.lstat(d).catch(() => null))]); throw new Error('logout failed'); } });
  await removing.remove(id);
  t.ok('削除: フォルダを消す前に同じフォルダで logout を呼び、失敗しても削除は止めない',
    order.length === 1 && order[0][0] === own && order[0][1] === true && !(await fs.lstat(own).catch(() => null)), JSON.stringify(order));

  // 8. どの呼び方でも中身を読まない（ダイアログを出さない）。b1 の読み取り経路は消えた
  t.ok('macOS: security は find-generic-password だけで、-w・-g・書き換えは一度も使わない',
    all.length > 20 && !readsSecret(all) && all.every(c => c.args[0] === 'find-generic-password'), String(all.length));
  t.ok('ADR 0340 の準備経路 readMacAccessCredentials は無い', !('readMacAccessCredentials' in connectorsAuth));
}

/**
 * Mac の実機の M7・M8 を受けた直し（ADR 0351）。偽の security と偽の CLI の失敗で確かめる（本物の鍵束・CLI には触れない）
 *   M7: 項目が有るのに CLI・使用量が断られた = 鍵束を開けなかった（ロック中）か、サーバー側で取り消された（M6 は未確認で見分けられない）。
 *       期限切れの印は付けず、会話は keychainAuth（再送と、ログインし直しも出す）、使用量は keychain の行（ログインし直しも出す）にする
 *   M8: ssh で起動したら止める（ssh）
 */
async function macAuthFailures(t, root) {
  const dir = '/Users/example/pleiad-data/claude-usage/acct-abcdef012345';
  const all = [];
  const presentWith = reply => (d, o) => {
    const sec = fakeSecurity(reply);
    return claudeLoginPresent(d, { ...o, run: sec.run, account: 'login-name-0001' }).finally(() => all.push(...sec.calls));
  };

  // 1. 断られたときの見分け: 項目が有る（0）・確かめられない（ロック・打ち切り・例外）→ keychain、無い（44）・使えない（50・security なし）→ null
  const rows = [
    [{ exitCode: 0 }, 'keychain', '0（有る。ロック中でも 0 が返る）'],
    [{ exitCode: 36 }, 'keychain', '36（ロック）'],
    [{ timedOut: true }, 'keychain', '打ち切り'],
    [{ exitCode: 44 }, null, '44（項目なし）'],
    [{ exitCode: 50 }, null, '50（鍵束なし）'],
    [{ startCode: 'ENOENT', startError: 'spawn ENOENT' }, null, 'security が無い'],
  ];
  const bad = [];
  for (const [reply, want, label] of rows) {
    const got = await macKeychainAuthFailure(dir, { platform: 'darwin', present: presentWith(reply) });
    if (got !== want) bad.push(`${label} → ${got}`);
  }
  const thrown = await macKeychainAuthFailure(dir, { platform: 'darwin', present: async () => { throw new Error('boom'); } });
  let otherCalls = 0;
  const other = present => async (...a) => { otherCalls++; return present(...a); };
  const onLinux = await macKeychainAuthFailure(dir, { platform: 'linux', present: other(presentWith({ exitCode: 0 })) });
  const onWin = await macKeychainAuthFailure(dir, { platform: 'win32', present: other(presentWith({ exitCode: 0 })) });
  const noDir = await macKeychainAuthFailure('', { platform: 'darwin', present: other(presentWith({ exitCode: 0 })) });
  t.ok('M7 の見分け（macOS）: 項目が有る・確かめられない → keychain（期限切れにしない）、44・50・security なし → null（今までどおり期限切れ）',
    bad.length === 0 && thrown === 'keychain', bad.join(' | '));
  t.ok('M7 の見分け: Windows・Linux とフォルダの無いときは null で、有無も見ない',
    onLinux === null && onWin === null && noDir === null && otherCalls === 0);

  // 2. ssh の見分け
  t.ok('M8: SSH_CONNECTION・SSH_TTY・SSH_CLIENT のどれかがあれば ssh。空の値・無いときは ssh でない',
    sshSession({ SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22' }) && sshSession({ SSH_TTY: '/dev/ttys001' }) && sshSession({ SSH_CLIENT: '192.0.2.1 50000 22' })
    && !sshSession({}) && !sshSession({ SSH_TTY: '' }) && !sshSession(undefined) && !sshSession({ SSH_AUTH_SOCK: '/tmp/agent' }));

  // 3. 会話の入口（専用フォルダ方式）
  const dataDir = path.join(root, 'mac-auth-data');
  await fs.mkdir(dataDir, { recursive: true });
  await put(dataDir, 'claude-accounts.json', JSON.stringify({ version: 1, accounts: [account] }));
  const accounts = createClaudeAccounts({ dataDir, secrets: { get: async () => null, delete: async () => {} }, cliConfig: path.join(root, 'mac-auth.claude.json') });
  const own = accounts.usageDir(id);
  await fs.mkdir(own, { recursive: true });
  await put(own, 'ply-usage-login.json', '{}');
  const unexpected = () => assert.fail('own-dir entered the b1 authentication path');
  const CODES = { present: 0, missing: 44, keychain: 36 };
  let answer = 'present';
  let checks = 0;
  const wiringFor = (platform, extraEnv = {}) => createClaudeConnectorsWiring({
    dataDir, accounts, env: { CLAUDE_CONFIG_DIR: path.join(root, 'mac-auth-shared'), ...extraEnv }, home: root, managedFiles: [], platform,
    versions: async () => VERIFIED_VERSIONS[0], usage: { refresh: unexpected, guard: unexpected }, probe: unexpected,
    loginPresent: (d, o) => { checks++; return presentWith({ exitCode: CODES[answer] })(d, o); },
  });
  await wiringFor('darwin').settings.setEnabled(id, true, OWN_DIR);
  const lifted = {};
  const sshKinds = {};
  for (const name of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT']) {
    const r = await wiringFor('darwin', { ...lifted, [name]: 'example' }).inspect(account, { mode: OWN_DIR });
    sshKinds[name] = `${r.kind}:${r.reauth}`;
  }
  t.ok('M8（macOS）: ssh で起動したら ssh で止め（OS の止めとは別の理由）、「ログインし直す」を出さず、鍵束も見ない',
    Object.values(sshKinds).every(v => v === 'ssh:false') && checks === 0, JSON.stringify(sshKinds));
  await assert.rejects(wiringFor('darwin', { ...lifted, SSH_TTY: '/dev/ttys001' }).resolve(id), e => e.code === 'connectors-ssh' && /ssh/.test(e.message) && !/darwin/.test(e.message));
  const emptySsh = await wiringFor('darwin', { ...lifted, SSH_TTY: '' }).inspect(account, { mode: OWN_DIR });
  await put(own, '.credentials.json', '{}');
  const linuxSsh = await wiringFor('linux', { SSH_CONNECTION: 'example' }).inspect(account, { mode: OWN_DIR });
  await fs.unlink(path.join(own, '.credentials.json'));
  t.ok('M8: 空の値では止めない。Linux（と Windows）は ssh でも今までどおり',
    emptySsh.kind === 'ok' && linuxSsh.kind === 'ok', JSON.stringify({ emptySsh, linuxSsh }));

  // 4. 入口が会話へ渡す authFailure（断られたときに呼ぶ）
  answer = 'present';
  const runtime = await wiringFor('darwin', lifted).resolve(id);
  const failed = await runtime.connectors.authFailure();
  answer = 'missing';
  const relogin = await runtime.connectors.authFailure();
  await put(own, '.credentials.json', '{}');
  const linuxRuntime = await wiringFor('linux').resolve(id);
  await fs.unlink(path.join(own, '.credentials.json'));
  const linuxFailure = await linuxRuntime.connectors.authFailure();
  const ce = failed?.connectorsError;
  t.ok('M7（入口）: 項目が有るのに断られたら keychainAuth（ロックの解除と、続くときのログインし直しを書く・アカウントを添える）。項目が無ければ null（期限切れ）。Linux は null',
    ce?.kind === 'keychainAuth' && ce.reauth === true && /ログインし直|sign in again/i.test(failed.message) && ce.accountId === id && /キーチェーン|keychain/i.test(failed.message)
    && relogin === null && linuxFailure === null, JSON.stringify({ ce, message: failed?.message, relogin, linuxFailure }));

  // 5. 会話（偽の CLI の失敗）: 401 の result で終わる・例外で終わる。どちらも connectorsError（keychainAuth）を添え、server は期限切れの印を付けない
  const SESSION = '11111111-2222-4333-8444-555555555557';
  const MESSAGE = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}';
  const init = () => ({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-test' });
  const authResult = () => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: MESSAGE, session_id: SESSION, num_turns: 1, total_cost_usd: 0 });
  const runClaude = async (messages, throws, connectors) => {
    const query = ({ prompt }) => {
      (async () => { for await (const _ of prompt) { /* 最初のプロンプト */ } })();
      return {
        interrupt: () => Promise.resolve({}), close() {},
        async *[Symbol.asyncIterator]() { for (const m of messages) yield m; if (throws) throw new Error(throws); },
      };
    };
    const restore = setClaudeSdkForTest({ query, executable: () => 'claude-fake', resumeGraceMs: 30 });
    const events = [];
    let error = null;
    try {
      await backend.runTurn({
        prompt: 'work', sessionId: null, cwd: process.cwd(), mode: 'bypass', connectors, connectorsEnv: { CLAUDE_CONFIG_DIR: own },
        emit: ev => events.push(ev), askPermission: async () => ({ allow: true }),
        signal: new AbortController(), control: {}, hostSessionId: 'host-own-dir-keychain',
      });
    } catch (err) { error = err; } finally { restore(); }
    return { result: events.find(e => e.type === 'turnResult') ?? null, error };
  };
  let asked = 0;
  const connectorsWith = reply => ({ identity: OWN_DIR, authFailure: () => { asked++; return reply(); } });
  answer = 'present';
  const keychainConnectors = connectorsWith(() => runtime.connectors.authFailure());
  const viaResult = await runClaude([init(), authResult()], null, keychainConnectors);
  const viaThrow = await runClaude([init()], 'Claude Code process exited with code 1: ' + MESSAGE, keychainConnectors);
  t.ok('M7（会話・401 の result）: 項目が有れば kind auth に keychainAuth の connectorsError を添える（期限切れにしない）',
    viaResult.result?.kind === 'auth' && viaResult.result.connectorsError?.kind === 'keychainAuth' && viaResult.result.connectorsError.reauth === true
    && /キーチェーン|keychain/i.test(viaResult.result.error), JSON.stringify(viaResult.result));
  t.ok('M7（会話・CLI が例外で終わる）: turnResult と投げる例外の両方に keychainAuth の connectorsError を添える',
    viaThrow.result?.kind === 'auth' && viaThrow.result.connectorsError?.kind === 'keychainAuth'
    && viaThrow.error?.connectorsError?.kind === 'keychainAuth', JSON.stringify({ result: viaThrow.result, error: viaThrow.error?.message }));
  answer = 'missing';
  const missingResult = await runClaude([init(), authResult()], null, keychainConnectors);
  const missingThrow = await runClaude([init()], 'Claude Code process exited with code 1: ' + MESSAGE, keychainConnectors);
  t.ok('M7（会話）: 項目が無い（44）なら connectorsError を添えない（server が期限切れの印を付け、ログインし直しを出す）',
    missingResult.result?.kind === 'auth' && !missingResult.result.connectorsError
    && missingThrow.result?.kind === 'auth' && !missingThrow.result.connectorsError && !missingThrow.error?.connectorsError,
    JSON.stringify({ a: missingResult.result, b: missingThrow.result }));
  const askedBefore = asked;
  const ok = await runClaude([init(), { type: 'result', subtype: 'success', result: 'done', session_id: SESSION, num_turns: 1, total_cost_usd: 0 }], null, keychainConnectors);
  const otherFail = await runClaude([init()], 'Claude Code process exited with code 1', keychainConnectors);
  const notOwnDir = await runClaude([init(), authResult()], null, { identity: 'token', authFailure: () => { asked++; return runtime.connectors.authFailure(); } });
  t.ok('M7（会話）: 通ったとき・認証でない失敗・専用フォルダでない会話では、有無を見に行かない',
    ok.result?.outcome === 'ok' && otherFail.result?.kind !== 'auth' && notOwnDir.result?.kind === 'auth' && !notOwnDir.result.connectorsError
    && asked === askedBefore, JSON.stringify({ asked, askedBefore, ok: ok.result, otherFail: otherFail.result }));

  // 6. 使用量（偽の CLI の失敗）: 項目が有れば keychain の行（ログイン切れの印は付けず、取り消しに備えてログインし直しは出す）。無ければ今までどおり
  const usageAccount = { id, name: 'Example', configDir: dir, usageLogin: true };
  const read = async ({ configDir }) => {
    if (!configDir) return { windows: [] };
    throw new Error('Invalid API key · Please run /login');
  };
  const usageFor = reply => readClaudeAccountsUsage({ accounts: [usageAccount], read,
    keychainFailure: d => macKeychainAuthFailure(d, { platform: 'darwin', present: presentWith(reply) }) });
  const lockedRow = (await usageFor({ exitCode: 0 })).accounts.find(r => r.accountId === id);
  const missingRow = (await usageFor({ exitCode: 44 })).accounts.find(r => r.accountId === id);
  const linuxRow = (await readClaudeAccountsUsage({ accounts: [usageAccount], read,
    keychainFailure: d => macKeychainAuthFailure(d, { platform: 'linux', present: presentWith({ exitCode: 0 }) }) })).accounts.find(r => r.accountId === id);
  t.ok('M7（使用量・macOS）: 項目が有るのに断られたら keychain の行。期限切れの印（cliAuthFailed）は付けず、「ログインし直す」（reauth）は出す',
    lockedRow?.keychain === true && !lockedRow.cliAuthFailed && lockedRow.reauth === true && !shouldMarkUsageExpired(lockedRow)
    && /キーチェーン|keychain/i.test(lockedRow.message) && /ログインし直|sign in again/i.test(lockedRow.message), JSON.stringify(lockedRow));
  t.ok('M7（使用量）: 項目が無い（44）・Windows・Linux は今までどおり期限切れの印を付ける',
    shouldMarkUsageExpired(missingRow) && missingRow.reauth === true && !missingRow.keychain
    && shouldMarkUsageExpired(linuxRow) && !linuxRow.keychain, JSON.stringify({ missingRow, linuxRow }));

  t.ok('M7・M8: security は find-generic-password だけで、-w・-g・書き換えは一度も使わない',
    all.length > 10 && !readsSecret(all) && all.every(c => c.args[0] === 'find-generic-password'), String(all.length));

  // 7. 起動の記録（tests/lib/claude-launch-record.mjs）: macOS は linux として入口に渡す（b1 の入口は macOS では platform で止まるため）
  t.ok('起動の記録: macOS は linux の記録と同じ OS として入口に渡す（Windows は win32 のまま）',
    recordPlatform('darwin') === 'linux' && recordPlatform('linux') === 'linux' && recordPlatform('win32') === 'win32');
}

export default async function (t) {
  const macRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-own-dir-mac-'));
  try { await macKeychain(t, macRoot); await macAuthFailures(t, macRoot); }
  finally { await fs.rm(macRoot, { recursive: true, force: true }); }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-own-dir-'));
  try {
    const shared = path.join(root, 'shared');
    const env = {
      CLAUDE_CONFIG_DIR: shared, CLAUDE_CODE_OAUTH_TOKEN: 'fake-token',
      CLAUDE_CODE_OAUTH_SCOPES: 'fake-scope', ANTHROPIC_API_KEY: 'fake-key', PATH: 'example',
    };
    const parentEnv = { ...env };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(dataDir);
    await put(dataDir, 'claude-accounts.json', JSON.stringify({ version: 1, accounts: [account] }));
    let secretReads = 0;
    const secrets = { get: async () => { secretReads++; return null; }, delete: async () => {} };
    const accounts = createClaudeAccounts({ dataDir, secrets, cliConfig: path.join(root, '.claude.json') });
    let versions = VERIFIED_VERSIONS[0];
    const unexpected = () => assert.fail('own-dir entered the b1 authentication path');
    const wiring = createClaudeConnectorsWiring({
      // ファイルでログインを見る OS として動かす（macOS の止めと有無の判定は macKeychain で確かめる）
      dataDir, accounts, env, home: root, managedFiles: [], versions: async () => versions,
      platform: process.platform === 'darwin' ? 'linux' : process.platform,
      usage: { refresh: unexpected, guard: unexpected }, probe: unexpected,
    });
    const own = accounts.usageDir(id);
    await fs.mkdir(own, { recursive: true });

    await assert.rejects(wiring.resolve(id), { code: 'missing-token' });
    await wiring.settings.setEnabled(id, true, 'b1');
    await assert.rejects(wiring.resolve(id), { code: 'missing-token' });
    await wiring.settings.setEnabled(id, true, OWN_DIR);
    assert.deepEqual(await wiring.settings.read(id), { enabled: true, mode: OWN_DIR });
    await assert.rejects(wiring.resolve(id), { code: 'connectors-ownDirLogin' });
    await put(own, 'ply-usage-login.json', '{}');
    assert.equal((await wiring.inspect(account, { mode: OWN_DIR })).kind, 'ownDirLogin');
    await put(own, '.credentials.json', '{"claudeAiOauth":{"expiresAt":1,"refreshTokenExpiresAt":1}}');
    versions = { cli: '0.0.1', sdk: '0.0.1' };
    assert.equal((await wiring.inspect(account, { mode: OWN_DIR })).kind, 'version');
    versions = VERIFIED_VERSIONS[0];
    const runtime = await wiring.resolve(id);
    assert.equal(secretReads, 2);
    assert.equal(runtime.token, undefined);
    assert.equal(runtime.connectors.fresh, undefined);
    await assert.rejects(runtime.resolveCatalogAccount(), { code: 'missing-token' });
    assert.deepEqual(claudeOwnDirEnv(env, { CLAUDE_CONFIG_DIR: own }), { CLAUDE_CONFIG_DIR: own, PATH: 'example' });
    assert.deepEqual(env, parentEnv);
    t.ok('専用フォルダ方式だけ会話用トークン、持ち主照合、期限の検査が不要', true);

    // A wrong entry stops preparation before starting a CLI or overwriting the entry.
    await put(own, 'projects', 'keep');
    const blocked = await wiring.inspect(account, { mode: OWN_DIR, prepare: true });
    assert.equal(blocked.kind, 'ownDirLinks');
    assert.equal(await read(own, 'projects'), 'keep');
    await fs.unlink(path.join(own, 'projects'));
    t.ok('ログイン、版、リンクの失敗に理由がある', true);

    await put(root, 'link-target', '');
    try { await fs.symlink(path.join(root, 'link-target'), path.join(root, 'link-probe'), 'file'); }
    catch (err) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(err.code)) throw err;
      t.skip('ファイル用シンボリックリンクの作成権限がない Windows');
      return;
    }

    await fs.mkdir(path.join(own, 'projects'));
    await fs.mkdir(path.join(own, 'skills'));
    await fs.mkdir(path.join(shared, 'skills'));
    await put(own, 'skills/new', 'new data');
    await put(own, 'skills/same', 'account data');
    await put(shared, 'skills/same', 'shared data');
    await put(own, 'settings.json', '');
    await put(own, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'dedicated@example.invalid' } }));
    await put(shared, '.claude.json', JSON.stringify({
      oauthAccount: { emailAddress: 'shared@example.invalid' }, mcpServers: { example: { command: 'fake' } },
    }));
    const prepared = await wiring.inspect(account, { mode: OWN_DIR, prepare: true });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.moves.find(m => m.action === 'shared')?.entry, 'skills');
    const archive = prepared.moves.find(m => m.action === 'archived').name;
    assert.match(archive, /^same\.pleiad-moved-/);
    assert.equal(await read(path.dirname(own), archive), 'account data');
    assert.equal(await read(shared, 'skills/new'), 'new data');
    assert.equal(await read(own, 'skills/same'), 'shared data');
    for (const entry of ['projects', 'skills', 'plugins', 'settings.json']) {
      assert.equal((await fs.lstat(path.join(own, entry))).isSymbolicLink(), true);
      assert.equal(await fs.realpath(path.join(own, entry)), await fs.realpath(path.join(shared, entry)));
    }
    assert.deepEqual(await withClaudeUsageDir(own, () => ensureClaudeOwnDirLinks(own, shared)), []);
    assert.deepEqual(await Promise.all([runtime.connectors.prepare(), runtime.connectors.prepare()]), [
      { env: { CLAUDE_CONFIG_DIR: own } }, { env: { CLAUDE_CONFIG_DIR: own } },
    ]);
    const profile = JSON.parse(await read(own, '.claude.json'));
    assert.equal(profile.oauthAccount.emailAddress, 'dedicated@example.invalid');
    assert.deepEqual(profile.mcpServers, { example: { command: 'fake' } });
    t.ok('リンク作成と再検査、共有への移動、競合時の退避、設定の投影', true);

    const { connectors } = runtime;
    const seen = [];
    const restore = setClaudeSdkForTest({
      executable: () => 'fake-claude', resolveSettings: async () => ({ sources: [] }),
      query: ({ options }) => {
        seen.push(options.env);
        return {
          initializationResult: async () => ({}),
          mcpServerStatus: async () => [{ name: 'claude.ai Example', status: 'connected' }],
          async *[Symbol.asyncIterator]() {
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } };
          },
        };
      },
    });
    try {
      connectors.fresh = unexpected;
      assert.equal((await backend.forAccount(runtime).internalTurn({ prompt: 'OK', cwd: root })).text, 'OK');
      assert.deepEqual(await probeClaudeConnectors({ connectors }), [{ name: 'Example', status: 'connected' }]);
      for (const child of seen) {
        assert.equal(child.CLAUDE_CONFIG_DIR, own);
        assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.equal(child.CLAUDE_CODE_OAUTH_SCOPES, undefined);
        assert.equal(child.ANTHROPIC_API_KEY, undefined);
      }
    } finally { restore(); }
    await accounts.remove(id);
    await assert.rejects(fs.lstat(own), { code: 'ENOENT' });
    assert.equal(await read(shared, 'skills/same'), 'shared data');
    assert.equal(await read(path.dirname(own), archive), 'account data');
    t.ok('起動とコネクター一覧の環境変数を分離し、アカウント削除後も共有と退避のデータが残る', true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
