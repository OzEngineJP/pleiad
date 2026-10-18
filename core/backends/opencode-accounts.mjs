import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { t } from '../i18n.mjs';
import { loadSqlite } from '../db.mjs';

const privateRoots = new Set();
const accountId = /^[a-z0-9][a-z0-9-]*$/i;
const statSafe = p => fs.lstatSync(p, { throwIfNoEntry: false });
const contains = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

// The CLI's default credential store. An account must never reach into it, and
// a link that would make the private area resolve to it fails closed.
export function defaultOpencodeData() {
  return path.resolve(process.env.AGENT_HOST_OPENCODE_DATA
    || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode'));
}

// Resolve aliases even when the final directory has not been created yet.
function canonicalPath(candidate) {
  let ancestor = path.resolve(candidate);
  const missing = [];
  while (!statSafe(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Cannot resolve OpenCode account directory');
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...missing);
}

function assertSeparateFromCli(dir) {
  const cli = canonicalPath(defaultOpencodeData()), account = canonicalPath(dir);
  if (contains(account, cli) || contains(cli, account)) throw new Error('OpenCode account directory overlaps the CLI data directory');
}

// Mirrors the Codex account-directory check: the account owns its own directory,
// it must not overlap the CLI data directory, and no existing ancestor or entry
// below it may be a link (a junction/symlink could redirect reads, chmods and
// writes to the shared CLI credential store).
function accountDir(account, { create = false, requireExists = true } = {}) {
  if (!account || typeof account.id !== 'string' || !accountId.test(account.id) || typeof account.dir !== 'string' || !path.isAbsolute(account.dir))
    throw new Error('Invalid OpenCode account directory');
  const dir = path.resolve(account.dir);
  if (path.basename(dir) !== account.id) throw new Error('Invalid OpenCode account directory');
  assertSeparateFromCli(dir);
  for (let p = dir; ; p = path.dirname(p)) {
    const s = statSafe(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error('Unsafe OpenCode account directory');
    if (path.dirname(p) === p) break;
  }
  if (create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return accountDir(account, { requireExists });
  }
  if (requireExists && !statSafe(dir)) throw new Error(t('accounts.backend.directoryRemoved', { agent: 'OpenCode' }));
  return dir;
}

function assertRealDir(dir) {
  const s = statSafe(dir);
  if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error('Unsafe OpenCode account directory');
}

// The account directory and every directory the CLI reads/writes below it must
// be real directories, so no link can redirect the private area to the CLI store.
function assertAccountTree(account, { requireExists = true } = {}) {
  accountDir(account, { create: false, requireExists });
  for (const dir of Object.values(accountPaths(account))) {
    assertRealDir(dir);
    assertRealDir(path.join(dir, 'opencode'));
  }
}

function assertSafeAuth(file) {
  const s = statSafe(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) throw new Error('Unsafe OpenCode authentication file');
  return s;
}

function readAuthText(file) {
  if (!assertSafeAuth(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

// Newer OpenCode keeps credentials in opencode.db (SQLite `credential` table) instead of
// auth.json. Read it directly rather than launching the CLI; a missing, unreadable or
// differently shaped store simply contributes nothing.
function credentialRows(file) {
  if (!assertSafeAuth(file)) return [];
  let db = null;
  try {
    db = new (loadSqlite().DatabaseSync)(file, { readOnly: true });
    const cols=new Set(db.prepare('PRAGMA table_info(credential)').all().map(c=>c.name));
    const order=cols.has('active') ? ' ORDER BY active DESC'+(cols.has('time_created')?', time_created DESC':'')+', id DESC' : '';
    const rows=db.prepare('SELECT integration_id, value FROM credential'+order).all();
    const selected=new Map();
    for(const row of rows)if(!selected.has(row.integration_id))selected.set(row.integration_id,row);
    return [...selected.values()];
  } catch { return []; }
  finally { try { db?.close(); } catch {} }
}

// A `credential.value` JSON blob in auth.json's per-provider shape. The store writes
// API keys as type "key" (auth.json used "api"); OAuth expiry may be an ISO string.
function storedCredential(value) {
  let c;
  try { c = JSON.parse(value); } catch { return null; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (c.type === 'key') return { ...c, type: 'api' };
  if (c.type === 'oauth' && typeof c.expires === 'string') return { ...c, expires: Date.parse(c.expires) };
  return c;
}

// Credentials from opencode.db. For accounts the file must pass the same checks as
// auth.json so a link cannot redirect the read to the shared CLI store.
function readStoredAuth(account) {
  let rows;
  try { rows = credentialRows(path.join(opencodeData(account), 'opencode.db')); }
  catch (err) { if (account) throw err; return {}; }
  return validAuth(Object.fromEntries(rows.map(row => [row.integration_id, storedCredential(row.value)]).filter(([, c]) => c)));
}

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
  return account ? path.join(accountPaths(account).data, 'opencode') : defaultOpencodeData();
}

// v2 の認証 DB を優先し、移行前の auth.json と暗号化した控えを補完に使う。
export function validAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, c]) => c && (
    c.type === 'oauth' && typeof c.access === 'string' && typeof c.refresh === 'string' && Number.isFinite(c.expires) && c.expires >= 0
    || c.type === 'api' && typeof c.key === 'string' && c.key.length > 0
    || c.type === 'wellknown' && typeof c.key === 'string' && typeof c.token === 'string'
  )));
}

export function readAccountAuth(account = null) {
  const file = path.join(opencodeData(account), 'auth.json');
  // The CLI's own store stays lenient: there is no saved seed to fall back to.
  if (!account) {
    const stored = readStoredAuth(null);
    try { return { ...validAuth(JSON.parse(fs.readFileSync(file, 'utf8'))), ...stored }; }
    catch { return stored; }
  }
  assertAccountTree(account, { requireExists: false });
  const stored = readStoredAuth(account);
  // Absent CLI copy: the encrypted snapshot is the only source, so use it.
  if (!statSafe(file)) return { ...validAuth(account.credential?.auth), ...stored };
  // Present CLI copy: never read it through a link or an unsafe directory tree,
  // and never silently substitute the saved seed for an unreadable file.
  assertSafeAuth(file);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(t('accounts.backend.credentialUnreadable', { agent: 'OpenCode' })); }
  return { ...validAuth(parsed), ...stored };
}

function legacyImportSource(account) {
  try {
    const file=path.join(opencodeData(account),'auth.json');
    return assertSafeAuth(file)?validAuth(JSON.parse(fs.readFileSync(file,'utf8'))):null;
  }catch {
    console.error('  opencode: invalid legacy credential source skipped');
    return null;
  }
}

/** 新規 v2 DB の bootstrap は auth.json を取り込まない。初回だけの作業を残す。 */
export function prepareCredentialImport(file,account=null) {
  if(statSafe(file)?.size)return;
  if(!legacyImportSource(account))return;
  const marker=file+'.pleiad-import-auth';
  try{fs.writeFileSync(marker,'pending',{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;assertSafeAuth(marker);}
}

/** CLI の DB を直に書かず、公式 API で不足する初回資格情報だけを足す。 */
export async function importLegacyCredentials(request,file,account=null) {
  const marker=file+'.pleiad-import-auth';
  if(!assertSafeAuth(marker))return;
  let current;
  try{current=(await request('GET','/api/credential'))?.data;}catch{return {pending:true};}
  if(!Array.isArray(current))return {pending:true};
  const present=new Set(current.map(c=>c.integrationID));
  let pending=false,skipped=0;
  const source=legacyImportSource(account)??{};
  for(const [rawID,credential] of Object.entries(source)) {
    const integrationID=rawID.replace(/\/+$/,'');
    const record=v=>v && typeof v==='object' && !Array.isArray(v);
    if(!integrationID || credential.type==='oauth' && (!Number.isInteger(credential.expires) || credential.methodID!==undefined && typeof credential.methodID!=='string' || ['accountId','enterpriseUrl'].some(key=>credential[key]!==undefined && typeof credential[key]!=='string')) || credential.metadata!==undefined && (!record(credential.metadata) || credential.type==='api' && Object.values(credential.metadata).some(value=>typeof value!=='string'))) {skipped++;continue;}
    const value=credential.type==='api'?{type:'key',key:credential.key,...(credential.metadata?{metadata:credential.metadata}:{})}:credential.type==='wellknown'?{type:'key',key:credential.token}:{
      type:'oauth',methodID:credential.methodID ?? (integrationID==='openai'?'chatgpt-browser':['github-copilot','opencode','xai'].includes(integrationID)?'device':'oauth'),
      access:credential.access,refresh:credential.refresh,expires:credential.expires,
      metadata:{...credential.metadata,...(credential.accountId?{accountID:credential.accountId}:{}),...(credential.enterpriseUrl?{enterpriseUrl:credential.enterpriseUrl}:{})},
    };
    const id='cred_pleiad_legacy_'+crypto.createHash('sha256').update(integrationID).digest('hex').slice(0,24);
    let discovering=false;
    try {
      if(!present.has(integrationID))await request('POST','/api/credential',{body:{id,integrationID,label:value.type==='oauth'?'OAuth':'API key',value,activate:false}});
      if(credential.type==='wellknown') {
        discovering=true;
        await request('POST','/api/experimental/integration/wellknown',{body:{url:integrationID}});
      }
    }
    catch(error) {
      if(error.status===400 && !discovering){skipped++;continue;}
      if(error.status===409) {
        const rows=await request('GET','/api/credential').then(result=>result?.data).catch(()=>null);
        if(rows?.some(c=>c.id===id && c.integrationID===integrationID) && credential.type!=='wellknown')continue;
      }
      pending=true;
    }
  }
  if(!pending)try{fs.unlinkSync(marker);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(pending || skipped)console.error('  opencode: credential restore:',pending?'pending':'complete',`(${skipped} invalid entries skipped)`);
  return {pending,skipped};
}

export function prepareAccount(account) {
  if (!account) return {};
  const dir = accountDir(account, { create: true });
  fs.chmodSync(dir, 0o700);
  privateRoot(dir);
  const dirs = accountPaths(account);
  assertAccountTree(account);
  for (const sub of [...Object.values(dirs), opencodeData(account),path.join(dir,'home')]) {
    assertAccountTree(account);
    assertRealDir(sub);
    fs.mkdirSync(sub, { recursive: true, mode: 0o700 });
    assertAccountTree(account);
    fs.chmodSync(sub, 0o700);
  }
  const file = path.join(opencodeData(account), 'auth.json');
  const auth = validAuth(account.credential?.auth);
  if (Object.keys(auth).length && !assertSafeAuth(file)) {
    assertAccountTree(account);
    fs.writeFileSync(file, JSON.stringify(auth), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  assertAccountTree(account);
  if (assertSafeAuth(file)) fs.chmodSync(file, 0o600);
  const credentials = Object.fromEntries(Object.keys(process.env)
    .filter(key => /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i.test(key))
    .map(key => [key, '']));
  return {
    ...credentials,
    HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),
    XDG_DATA_HOME: dirs.data, XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    OPENCODE_CONFIG_DIR: path.join(dirs.config, 'opencode'),
    PLEIAD_OPENCODE_ACCOUNT_ID: account.id,
    // Do not inherit another account's provider credentials or explicit database.
    OPENCODE_DB: path.join(opencodeData(account),'opencode.db'), OPENCODE_CONFIG: '', OPENAI_API_KEY: '', OPENAI_ORG_ID: '', OPENAI_PROJECT_ID: '',
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
  const env = {...prepareAccount(account),OPENCODE_CONFIG_CONTENT:'',OPENCODE_PASSWORD:'',OPENCODE_SERVER_PASSWORD:''};
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
  // readAuthText refuses to follow a link to the CLI store; a swap mid-login
  // therefore fails closed instead of reading the shared credentials.
  assertAccountTree(account);
  const before = readAuthText(file) ?? '';
  // Newer OpenCode writes credentials to opencode.db instead of auth.json, so a
  // login that only touches the store must count as a change too.
  const storedBefore = readStoredAuth(account);
  emit?.({ type: 'auth', phase: 'url', url: accountLoginCommand(account, argv), message: t('opencode.auth.accountRunCommand') });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { await delay(pollMs, undefined, { signal: abortSignal }); }
    catch (err) { if (err.name === 'AbortError') throw cancelled(err); throw err; }
    assertAccountTree(account);
    const text = readAuthText(file);
    const fileChanged = text != null && text !== before;
    const stored = readStoredAuth(account);
    const storedChanged = JSON.stringify(stored) !== JSON.stringify(storedBefore);
    if (!fileChanged && !storedChanged) continue;
    let auth = {};
    if (fileChanged) { try { auth = validAuth(JSON.parse(text)); } catch { continue; } }
    if (!Object.keys(auth).length && storedChanged) auth = stored;
    if (!Object.keys(auth).length) continue;
    if (text != null) fs.chmodSync(file, 0o600);
    emit?.({ type: 'auth', phase: 'done', message: t('opencode.auth.accountLoggedIn') });
    return { credential: { auth }, label: Object.keys(auth).join(', ') };
  }
  const message = t('opencode.auth.loginTimeout');
  emit?.({ type: 'auth', phase: 'error', message });
  throw new Error(message);
}
