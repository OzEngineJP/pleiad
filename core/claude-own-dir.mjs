import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

export const OWN_DIR = 'own-dir';
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

export async function unlinkClaudeOwnDirLinks(dir) {
  // A directory link at the account root must never be traversed during deletion.
  if (!(await lstat(dir))?.isDirectory()) return;
  for (const entry of entries) {
    const file = path.join(dir, entry);
    if ((await lstat(file))?.isSymbolicLink()) await fs.unlink(file);
  }
}
