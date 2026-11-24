import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { run as runProcess } from './process.mjs';

export const OWN_DIR = 'own-dir';
/** 鍵束を見る security の打ち切り（ロック中・確認待ちで待ち続けない。ADR 0351） */
export const KEYCHAIN_TIMEOUT_MS = 5_000;
/** CLI の削除（claude auth logout）の打ち切り */
export const LOGOUT_TIMEOUT_MS = 15_000;
/** macOS の security の終了コードのうち、この Mac ではまだ使えないもの（50: 鍵束なし・37: 既定の鍵束なし）。ほかの失敗はロック・拒否として扱う */
const KEYCHAIN_PLATFORM_CODES = [50, 37];
const KEYCHAIN_MISSING = 44;
const directories = ['projects', 'skills', 'plugins'];
const entries = [...directories, 'settings.json'];
const pending = new Map();
const pathKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

export function withClaudeUsageDir(dir, run) {
  const key = pathKey(dir);
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  pending.set(key, next);
  return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
}

async function lstat(file) {
  try { return await fs.lstat(file); }
  catch (err) { if (err.code !== 'ENOENT') throw err; return null; }
}

// Reserve destinations without overwriting entries, even when another account is migrating.
async function moveExclusive(source, target) {
  const info = await fs.lstat(source);
  if (info.isDirectory()) {
    await fs.mkdir(target);
    for (const name of await fs.readdir(source)) {
      await moveExclusive(path.join(source, name), path.join(target, name));
    }
    await fs.rmdir(source);
    return;
  }
  if (info.isSymbolicLink() || info.isFile()) {
    try { await fs.link(source, target); }
    catch (err) {
      if (err.code !== 'EXDEV' || !info.isFile()) throw err;
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    }
    await fs.unlink(source);
    return;
  }
  throw new Error('Unsupported configuration entry');
}

// The caller holds withClaudeUsageDir throughout login checks, migration and profile projection.
export async function ensureClaudeOwnDirLinks(dir, shared) {
  const own = await fs.realpath(dir);
  const base = path.resolve(shared);
  const assertSeparate = other => {
    const a = pathKey(own), b = pathKey(other);
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
      throw new Error('Overlapping configuration directories');
    }
  };
  assertSeparate(base);
  await fs.mkdir(base, { recursive: true });
  assertSeparate(await fs.realpath(base));
  const moves = [];
  const move = async (source, target, entry) => {
    if (!await lstat(target)) {
      try {
        await moveExclusive(source, target);
        moves.push({ entry, action: 'shared', name: path.basename(source) });
        return;
      } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    const name = `${path.basename(source)}.pleiad-moved-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    await fs.rename(source, path.join(path.dirname(dir), name));
    moves.push({ entry, action: 'archived', name });
  };
  for (const entry of entries) {
    const directory = directories.includes(entry);
    const source = path.join(dir, entry), target = path.join(base, entry);
    const before = await lstat(source);
    if (before?.isSymbolicLink()) {
      const destination = path.resolve(path.dirname(source), await fs.readlink(source));
      if (pathKey(destination) !== pathKey(target)) throw new Error('Unexpected configuration link');
    }
    const sharedEntry = await lstat(target);
    if (sharedEntry && !(directory ? sharedEntry.isDirectory() : sharedEntry.isFile())) {
      // Shared entries may themselves be links, provided they resolve outside the account.
      const resolved = await fs.realpath(target);
      assertSeparate(resolved);
      const info = await fs.stat(target);
      if (!(directory ? info.isDirectory() : info.isFile())) throw new Error('Invalid shared configuration entry');
    }
    if (directory) {
      await fs.mkdir(target, { recursive: true });
      if (before && !before.isSymbolicLink()) {
        if (!before.isDirectory()) throw new Error('Expected a configuration folder');
        for (const name of await fs.readdir(source)) await move(path.join(source, name), path.join(target, name), entry);
        await fs.rmdir(source);
      }
    } else {
      if (before && !before.isSymbolicLink()) {
        if (!before.isFile()) throw new Error('Expected a settings file');
        if (before.size) await move(source, target, entry);
        else await fs.unlink(source);
      }
      if (!await lstat(target)) {
        await fs.writeFile(target, '{}\n', { flag: 'wx' }).catch(err => { if (err.code !== 'EEXIST') throw err; });
      }
    }
    if (!before?.isSymbolicLink()) {
      await fs.symlink(target, source, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    }
  }
  return moves;
}

/**
 * macOS で CLI がログインを置くキーチェーンの項目名。CLAUDE_CONFIG_DIR に渡す文字列そのもの（NFC）の SHA-256 の先頭 8 桁を付ける
 * （CLI 2.1.322 の実機で確認。ADR 0351）。realpath や末尾の / の調整はしない（ログイン・会話・使用量に渡す文字列と同じにするため）
 */
export function claudeKeychainService(configDir) {
  return `Claude Code-credentials-${createHash('sha256').update(String(configDir).normalize('NFC')).digest('hex').slice(0, 8)}`;
}

/** CLI が項目に付ける account（OS のログイン名） */
export function claudeKeychainAccount() {
  try { return os.userInfo().username; } catch { return process.env.USER || ''; }
}

/**
 * 専用フォルダにログインがあるか（ADR 0351）。中身は読まない。
 *   'present' … ある / 'missing' … 無い（ログインし直す） / 'keychain' … 鍵束を開けない（ロック・拒否・打ち切り） / 'platform' … この Mac ではまだ使えない
 * Windows・Linux は <dir>/.credentials.json がファイルとしてあるか。macOS は security find-generic-password を -w なしで呼ぶ
 * （-w は中身を読むので確認のダイアログが出る。ここでは決して付けない）
 */
export async function claudeLoginPresent(dir, { platform = process.platform, run = runProcess, account = claudeKeychainAccount(), lstat = fs.lstat } = {}) {
  if (platform !== 'darwin') {
    const info = await lstat(path.join(dir, '.credentials.json')).catch(() => null);
    return info?.isFile() ? 'present' : 'missing';
  }
  let result;
  try {
    result = await run('/usr/bin/security', ['find-generic-password', '-s', claudeKeychainService(dir), '-a', account],
      { timeoutMs: KEYCHAIN_TIMEOUT_MS, maxOutputChars: 64 * 1024, windowsHide: true });
  } catch (error) { return error?.code === 'ENOENT' ? 'platform' : 'keychain'; }
  if (result?.startCode === 'ENOENT') return 'platform';
  if (!result || result.timedOut || result.stopped || result.startError) return 'keychain';
  if (result.exitCode === 0) return 'present';
  if (result.exitCode === KEYCHAIN_MISSING) return 'missing';
  if (KEYCHAIN_PLATFORM_CODES.includes(result.exitCode)) return 'platform';
  return 'keychain';
}

/**
 * macOS で、専用フォルダのログインを使った CLI・使用量の読み取りが認証の失敗で終わったときの見分け（ADR 0351 の M7）。
 * -w なしの有無の判定は、鍵束がロック中でも 0（有り）を返す（実機）。項目が有る（または有無を確かめられない）のに断られたら、
 * 鍵束を開けなかった（ロック中）か、サーバー側で取り消された（M6。未確認で見分けられない）とみて 'keychain' を返す。
 * 呼び手は期限切れの印を付けず、ロックの解除と再送を主に、続くときのログインし直しも出す（会話は keychainAuth、使用量は keychain の行）。
 * 項目が無い（44）・security が無い・macOS 以外は null（今までどおり期限切れとして扱う）
 */
export async function macKeychainAuthFailure(dir, { platform = process.platform, present = claudeLoginPresent } = {}) {
  if (platform !== 'darwin' || !dir) return null;
  const found = await Promise.resolve().then(() => present(dir, { platform })).catch(() => 'keychain');
  return found === 'present' || found === 'keychain' ? 'keychain' : null;
}

/** macOS で ssh 経由で起動したか（ADR 0351 の M8。画面の無いセッションでは鍵束を開けない） */
export function sshSession(env = process.env) {
  return ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT'].some(name => Boolean(env?.[name]));
}

/**
 * アカウントを消す前に、CLI に自分のキーチェーンの項目を消させる（macOS だけ。ADR 0351）。Pleiad は security delete-generic-password を呼ばない。
 * 消えたかを有無で確かめ、残っていればログに書く。失敗しても削除は止めない（戻り値で結果だけ返す）
 */
export async function logoutClaudeOwnDir(dir, { command, env = process.env, platform = process.platform, run = runProcess,
  present = claudeLoginPresent, log = message => console.warn(message) } = {}) {
  if (platform !== 'darwin') return 'skipped';
  // 使用量のログインをしていない（フォルダが無い）アカウントには項目も無い
  if (!(await lstat(dir))?.isDirectory()) return 'skipped';
  const argv = typeof command === 'function' ? command() : command;
  if (!Array.isArray(argv) || !argv.length) { log('[claude-accounts] claude auth logout skipped: CLI not found'); return 'no-cli'; }
  // ログインと同じく、別の認証の指定を外して、このフォルダだけを CLI に渡す（core/claude-login.mjs の loginEnv と同じ名前）
  const childEnv = Object.fromEntries(Object.entries(env)
    .filter(([key]) => !['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())));
  childEnv.CLAUDE_CONFIG_DIR = dir;
  const result = await Promise.resolve()
    .then(() => run(argv[0], [...argv.slice(1), 'auth', 'logout'], { env: childEnv, timeoutMs: LOGOUT_TIMEOUT_MS, maxOutputChars: 64 * 1024, windowsHide: true }))
    .catch(() => null);
  if (!result || result.timedOut || result.startError || result.exitCode !== 0) {
    log(`[claude-accounts] claude auth logout failed (exit ${result?.exitCode ?? '-'}${result?.timedOut ? ', timed out' : ''})`);
  }
  const left = await Promise.resolve().then(() => present(dir, { platform, run })).catch(() => 'keychain');
  if (left !== 'missing') log(`[claude-accounts] keychain item may remain after logout (${left})`);
  return left === 'missing' ? 'removed' : left;
}

export async function unlinkClaudeOwnDirLinks(dir) {
  // A directory link at the account root must never be traversed during deletion.
  if (!(await lstat(dir))?.isDirectory()) return;
  for (const entry of entries) {
    const file = path.join(dir, entry);
    if ((await lstat(file))?.isSymbolicLink()) await fs.unlink(file);
  }
}
