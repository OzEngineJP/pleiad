// CODEX_HOME isolates authentication; records and writer locks stay shared with
// the user's CLI. Never replace existing entries or follow links while deleting.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const dirs = ['sessions', 'archived_sessions', 'thread-writer-locks', 'skills', 'memories', 'rules', 'plugins', 'attachments', 'generated_images', 'packages', 'vendor_imports'];
const files = ['config.toml', 'AGENTS.md', 'history.jsonl', 'session_index.jsonl'];
const stat = async p => fs.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
export const codexDefaultHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
export function codexHomesOverlap(a, b, paths = path) {
  const inside = (root, candidate) => {
    const relative = paths.relative(root, candidate);
    return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep));
  };
  return inside(a, b) || inside(b, a);
}
export const codexAccountKey = account => {
  if (!account) return '';
  const key = `${account.id}:${path.resolve(account.dir)}`;
  return process.platform === 'win32' ? key.toLowerCase() : key;
};
export const codexAccountChildId = account => account ? `codex-app-server-${crypto.createHash('sha256').update(codexAccountKey(account)).digest('hex').slice(0, 24)}` : 'codex-app-server';

export async function privateCodexPath(dir) {
  await fs.chmod(dir, 0o700);
  if (process.platform !== 'win32') return;
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('Cannot determine the owner of the Codex account directory');
  await exec('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
}

async function accountDir(account, { create = false } = {}) {
  if (!account || typeof account.id !== 'string' || !/^acct-[a-z0-9-]+$/i.test(account.id) || typeof account.dir !== 'string' || !path.isAbsolute(account.dir)) throw new Error('Invalid Codex account directory');
  const dir = path.resolve(account.dir), home = codexDefaultHome();
  if (path.basename(dir) !== account.id || codexHomesOverlap(dir, home)) throw new Error('Codex account directory overlaps the CLI home');
  // The account and its ancestors must be real directories, including on Windows
  // where junctions report isSymbolicLink(). No auth write can escape the home.
  for (let p = dir; ; p = path.dirname(p)) {
    const s = await stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error('Unsafe Codex account directory');
    if (path.dirname(p) === p) break;
  }
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await stat(dir))) throw new Error('Codex account directory was removed');
  return dir;
}

async function share(dir, home, name, directory) {
  const target = path.join(home, name), link = path.join(dir, name);
  const existing = await stat(link);
  if (existing) {
    if (!existing.isSymbolicLink() || !same(await fs.readlink(link), target)) throw new Error(`Refusing to replace Codex account entry: ${name}`);
    return;
  }
  if (directory) await fs.mkdir(target, { recursive: true });
  try { await fs.symlink(target, link, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
  catch (e) { throw new Error(`Cannot share Codex ${name} (${e.code}); symbolic links are required`, { cause: e }); }
}

export async function validateCodexAccount(account) {
  const dir = await accountDir(account), home = codexDefaultHome();
  for (const name of [...dirs, ...files]) {
    const link = path.join(dir, name), s = await stat(link);
    if (!s?.isSymbolicLink() || !same(await fs.readlink(link), path.join(home, name))) throw new Error(`Unsafe Codex shared entry: ${name}`);
  }
  return (await codexAccountLoggedOut(account)) ? null : readCodexCredential(account);
}

export async function codexAccountLoggedOut(account) {
  const file = path.join(await accountDir(account), '.pleiad-logged-out'), s = await stat(file);
  if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink > 1)) throw new Error('Unsafe Codex logout marker');
  return Boolean(s);
}

export async function markCodexLoggedOut(account, loggedOut) {
  const file = path.join(await accountDir(account), '.pleiad-logged-out');
  const marked = await codexAccountLoggedOut(account);
  if (loggedOut && !marked) await fs.writeFile(file, '1', { flag: 'wx', mode: 0o600 });
  if (!loggedOut && marked) await fs.unlink(file);
}

export async function readCodexCredential(account) {
  const dir = await accountDir(account);
  const file = path.join(dir, 'auth.json'), s = await stat(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) throw new Error('Unsafe Codex authentication file');
  let auth;
  try { auth = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error('Cannot read Codex authentication file'); }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Invalid Codex authentication file');
  return { auth };
}

export async function prepareCodexAccount(account, { login = false, allowUnauthenticated = false } = {}) {
  const dir = await accountDir(account, { create: login });
  await privateCodexPath(dir);
  const home = codexDefaultHome();
  for (const name of dirs) await share(dir, home, name, true);
  for (const name of files) await share(dir, home, name, false);
  const current = await readCodexCredential(account);
  const loggedOut = await codexAccountLoggedOut(account);
  if (!current && account.credential != null && !loggedOut) {
    const auth = account.credential?.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Invalid stored Codex credential');
    // Exclusive creation refuses symlinks/hardlinks and preserves refreshed CLI
    // tokens on every later call. The encrypted copy is a recovery seed only.
    await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
  }
  if (!login && !allowUnauthenticated && (loggedOut || !(await readCodexCredential(account)))) throw new Error('Codex account is not logged in');
  const env = { ...process.env, CODEX_HOME: dir, CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME || home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

// Parent calls accountDispose before removing the directory. This helper is also
// useful for failed provisioning: link targets must survive even partial setup.
export async function removeCodexAccountDirectory(account) {
  const dir = await accountDir(account);
  const walk = async p => {
    const s = await stat(p);
    if (!s) return;
    if (s.isSymbolicLink()) { await fs.unlink(p); return; }
    if (s.isDirectory()) { for (const name of await fs.readdir(p)) await walk(path.join(p, name)); await fs.rmdir(p); }
    else await fs.unlink(p);
  };
  await walk(dir);
}
