import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { t } from '../i18n.mjs';

const privateRoots = new Set();
let userSid;
function privateRoot(dir) {
  if (process.platform !== 'win32' || privateRoots.has(dir)) return;
  userSid ??= /S-1-[0-9-]+/.exec(spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout ?? '')?.[0];
  if (!userSid) throw new Error(t('accounts.backend.permissionsUnknown', { agent: 'OpenCode' }));
  const acl = spawnSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  if (acl.status !== 0) throw new Error(t('accounts.backend.permissionsFailed', { agent: 'OpenCode' }));
  privateRoots.add(dir);
}

export function accountKey(account) {
  if (!account) return 'login';
  if (!account.id || !account.dir || !path.isAbsolute(account.dir)) throw new Error('OpenCode account requires id and absolute dir');
  return `${account.id}:${path.resolve(account.dir)}`;
}

export function accountPaths(account) {
  accountKey(account);
  return Object.fromEntries(['data', 'config', 'cache', 'state'].map(k => [k, path.join(account.dir, k)]));
}

export function opencodeData(account = null) {
  return account ? path.join(accountPaths(account).data, 'opencode')
    : process.env.AGENT_HOST_OPENCODE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
}

// Keep the CLI's required plaintext copy only in this account's private data dir.
// A refreshed CLI copy takes precedence over the encrypted login snapshot.
export function validAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, c]) => c && (
    c.type === 'oauth' && typeof c.access === 'string' && typeof c.refresh === 'string' && Number.isFinite(c.expires) && c.expires >= 0
    || c.type === 'api' && typeof c.key === 'string' && c.key.length > 0
    || c.type === 'wellknown' && typeof c.key === 'string' && typeof c.token === 'string'
  )));
}

export function readAccountAuth(account = null) {
  try { return validAuth(JSON.parse(fs.readFileSync(path.join(opencodeData(account), 'auth.json'), 'utf8'))); }
  catch { return account ? validAuth(account.credential?.auth) : {}; }
}

export function prepareAccount(account) {
  if (!account) return {};
  const dirs = accountPaths(account);
  fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(account.dir, 0o700);
  privateRoot(account.dir);
  for (const dir of [...Object.values(dirs), opencodeData(account)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const file = path.join(opencodeData(account), 'auth.json');
  const auth = validAuth(account.credential?.auth);
  if (!fs.existsSync(file) && Object.keys(auth).length) {
    try { fs.writeFileSync(file, JSON.stringify(auth), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  const credentials = Object.fromEntries(Object.keys(process.env)
    .filter(key => /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i.test(key))
    .map(key => [key, '']));
  return {
    ...credentials,
    XDG_DATA_HOME: dirs.data, XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    OPENCODE_CONFIG_DIR: path.join(dirs.config, 'opencode'),
    PLEIAD_OPENCODE_ACCOUNT_ID: account.id,
    // Do not inherit another account's provider credentials or explicit database.
    OPENCODE_DB: '', OPENCODE_CONFIG: '', OPENAI_API_KEY: '', OPENAI_ORG_ID: '', OPENAI_PROJECT_ID: '',
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', GITHUB_TOKEN: '', GH_TOKEN: '',
    GITHUB_COPILOT_TOKEN: '', OPENCODE_API_KEY: '',
    AWS_ACCESS_KEY_ID: '', AWS_PROFILE: '',
    AWS_SHARED_CREDENTIALS_FILE: path.join(account.dir, 'aws-credentials'), AWS_CONFIG_FILE: path.join(account.dir, 'aws-config'),
    GOOGLE_APPLICATION_CREDENTIALS: path.join(account.dir, 'google-credentials.json'),
  };
}

const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const shQuote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
export function accountLoginCommand(account, argv, platform = process.platform) {
  const dirs = accountPaths(account);
  const env = { XDG_DATA_HOME: dirs.data, XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    OPENCODE_CONFIG_DIR: path.join(dirs.config, 'opencode') };
  if (platform === 'win32') {
    // Run in a child PowerShell so the user's terminal environment is unchanged.
    const script = [...Object.entries(env).map(([k, v]) => `$env:${k}=${psQuote(v)}`), `& ${[...argv, 'auth', 'login'].map(psQuote).join(' ')}`].join('; ');
    return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  return `env ${Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`).join(' ')} ${[...argv, 'auth', 'login'].map(shQuote).join(' ')}`;
}

export async function loginAccount({ account, emit, signal, argv, timeoutMs = 600_000, pollMs = 1000 }) {
  if (!account) throw new Error('OpenCode account login requires an isolated account');
  const abortSignal = signal?.signal ?? signal;
  const cancelled = cause => Object.assign(new Error(t('accounts.backend.loginCancelled', { agent: 'OpenCode' }), { cause }), { name: 'AbortError', code: 'ABORT_ERR' });
  if (abortSignal?.aborted) throw cancelled(abortSignal.reason);
  prepareAccount(account);
  const file = path.join(opencodeData(account), 'auth.json');
  const before = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
  emit?.({ type: 'auth', phase: 'url', url: accountLoginCommand(account, argv), message: t('opencode.auth.accountRunCommand') });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { await delay(pollMs, undefined, { signal: abortSignal }); }
    catch (err) { if (err.name === 'AbortError') throw cancelled(err); throw err; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text === before) continue;
    let auth;
    try { auth = validAuth(JSON.parse(text)); } catch { continue; }
    if (!Object.keys(auth).length) continue;
    fs.chmodSync(file, 0o600);
    emit?.({ type: 'auth', phase: 'done', message: t('opencode.auth.accountLoggedIn') });
    return { credential: { auth }, label: Object.keys(auth).join(', ') };
  }
  const message = t('opencode.auth.loginTimeout');
  emit?.({ type: 'auth', phase: 'error', message });
  throw new Error(message);
}
