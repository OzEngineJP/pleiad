// Grok の認証ホームを Pleiad の会話アカウントごとに分ける。
// 本人の ~/.grok は共有・複製せず、追加アカウントは Pleiad が所有する別ホームでログインする。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../process.mjs';
import { t } from '../i18n.mjs';

const stat = p => fs.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const overlap = (a, b) => {
  const inside = (root, candidate) => {
    const rel = path.relative(root, candidate);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  };
  return inside(a, b) || inside(b, a);
};

export const defaultGrokHome = () => path.resolve(process.env.AGENT_HOST_GROK_HOME || process.env.GROK_HOME || path.join(os.homedir(), '.grok'));

async function accountHome(account, dataDir, { create = false } = {}) {
  const root = path.resolve(dataDir, 'accounts', 'grok');
  if (!account || !/^acct-[0-9a-f]{12}$/i.test(String(account.id ?? '')) || typeof account.dir !== 'string' || !path.isAbsolute(account.dir)) {
    throw new Error('Invalid Grok account directory');
  }
  const dir = path.resolve(account.dir);
  if (path.basename(dir) !== account.id || path.dirname(dir) !== root || overlap(dir, defaultGrokHome())) {
    throw new Error('Grok account directory overlaps another home');
  }
  for (let p = dir; ; p = path.dirname(p)) {
    const s = await stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error('Unsafe Grok account directory');
    if (p === root) break;
    const relative = path.relative(root, p);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Grok account directory is outside the account root');
    }
  }
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await stat(dir))) throw new Error(t('accounts.backend.directoryRemoved', { agent: 'Grok Build' }));
  return dir;
}

async function protect(dir) {
  await fs.chmod(dir, 0o700);
  if (process.platform !== 'win32') return;
  const who = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = who.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error(t('accounts.backend.permissionsUnknown', { agent: 'Grok Build' }));
  const acl = await run('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  if (acl.startError || acl.exitCode !== 0) throw new Error(t('accounts.backend.permissionsFailed', { agent: 'Grok Build' }));
}

export async function readGrokCredential(account, dataDir) {
  const dir = await accountHome(account, dataDir);
  const file = path.join(dir, 'auth.json'), s = await stat(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) throw new Error('Unsafe Grok authentication file');
  let auth;
  try { auth = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error(t('accounts.backend.credentialUnreadable', { agent: 'Grok Build' })); }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || !Object.keys(auth).length) {
    throw new Error(t('accounts.backend.credentialUnreadable', { agent: 'Grok Build' }));
  }
  return { auth };
}

export async function prepareGrokAccount(account, dataDir, { login = false, allowUnauthenticated = false } = {}) {
  const dir = await accountHome(account, dataDir, { create: login });
  await protect(dir);
  const file = path.join(dir, 'auth.json');
  const current = await readGrokCredential(account, dataDir);
  if (!current && account.credential != null) {
    const auth = account.credential?.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || !Object.keys(auth).length) throw new Error('Invalid stored Grok credential');
    await fs.writeFile(file, JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
  }
  if (!login && !allowUnauthenticated && !(await readGrokCredential(account, dataDir))) {
    throw new Error(t('accounts.backend.notLoggedIn', { agent: 'Grok Build' }));
  }
  const env = { ...process.env, GROK_HOME: dir };
  delete env.XAI_API_KEY;
  delete env.AGENT_HOST_GROK_HOME;
  return { dir, env };
}
