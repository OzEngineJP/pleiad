// 作業場所 → git の本体（canonical root）の求め方。claude-connectors-auth.mjs（CLI の projects のキー）と
// 記憶の作業場所（core/memory/store.mjs の ws。ADR 0110 の段 2）が同じ規則を使う。
//   gitRootOf(start, P, io)            … start から上へ .git（ファイルでもフォルダでも）を探した作業ツリーの場所。無ければ null
//   canonicalRoot(root, P, io, platform) … worktree なら本体の作業ツリー、そうでなければ root のまま（CLI の判定の控えめな近似）
//   canonicalWorkspace(cwd, opts)      … 記憶の作業場所。git の外は null、worktree は本体、区切りはスラッシュ・末尾なし
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const realpathJs = promisify(fsSync.realpath);   // コールバック版は JS の実装（fs.promises.realpath は OS の実装で大文字小文字を直す）

/** 既定のファイル操作（試験が差し替える） */
export const GIT_IO = { readFile: fs.readFile, stat: fs.stat, lstat: fs.lstat, realpath: realpathJs };

const DRIVE = /^[A-Za-z]:/;
/** CLI が安全でないとして worktree の解決をやめる参照（NUL・UNC やデバイス・別のドライブ）。CLI の判定の控えめな近似 */
function unsafeRef(ref, base, platform) {
  if (typeof ref !== 'string' || !ref || ref.includes('\0')) return true;
  if (/^[\\/]{2}/.test(ref)) return true;
  return platform === 'win32' && DRIVE.test(ref) && DRIVE.test(base) && ref[0].toLowerCase() !== base[0].toLowerCase();
}

/** ファイルかフォルダがあるか（シンボリックリンクは指す先で見る）。読めなければ無い */
async function isEntry(file, io) {
  try {
    const st = await io.lstat(file);
    const real = st.isSymbolicLink() ? await io.stat(file) : st;
    return real.isDirectory() || real.isFile();
  } catch { return false; }
}

/** 普通のファイルか（シンボリックリンク・特殊なファイル・フォルダ・無いは false） */
async function plainFile(file, io) {
  try { return (await io.lstat(file)).isFile(); } catch { return false; }
}

export async function gitRootOf(start, P, io) {
  let dir = P.resolve(start);
  const top = dir.substring(0, dir.indexOf(P.sep) + 1) || P.sep;
  while (dir !== top) {
    if (await isEntry(P.join(dir, '.git'), io)) return dir;
    const up = P.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return (await isEntry(P.join(top, '.git'), io)) ? top : null;
}

/** worktree なら本体の作業ツリーの場所、そうでなければ root のまま */
export async function canonicalRoot(root, P, io, platform) {
  let head;
  try { head = String(await io.readFile(P.join(root, '.git'), 'utf8')).trim(); } catch { return root; }
  try {
    if (!head.startsWith('gitdir:')) return root;
    const ref = head.slice('gitdir:'.length).trim();
    if (unsafeRef(ref, root, platform)) return root;
    const gitDir = P.resolve(root, ref);
    const commonFile = P.join(gitDir, 'commondir');
    if (!(await plainFile(commonFile, io))) return root;
    const common = String(await io.readFile(commonFile, 'utf8')).trim();
    if (unsafeRef(common, gitDir, platform)) return root;
    const commonDir = P.resolve(gitDir, common);
    if (P.resolve(P.dirname(gitDir)) !== P.join(commonDir, 'worktrees')) return root;
    const backFile = P.join(gitDir, 'gitdir');
    if (!(await plainFile(backFile, io))) return root;
    const back = String(await io.readFile(backFile, 'utf8')).trim();
    if (unsafeRef(back, root, platform)) return root;
    if (P.sep === '/' && [root, gitDir, back, commonDir].some(s => s.includes('\\'))) return root;
    if ((await io.realpath(P.resolve(gitDir, back))) !== P.join(await io.realpath(root), '.git')) return root;
    if (P.basename(commonDir) !== '.git') return (await isEntry(P.join(commonDir, '.git'), io)) ? root : commonDir;
    return P.dirname(commonDir);
  } catch { return root; }
}

/** パスをスラッシュ形にする（Windows の \ を / へ。末尾の / は落とす。ルート自体 '/' や 'C:/' は残す） */
export function slashPath(p) {
  const s = String(p).replaceAll('\\', '/');
  return s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s;
}

/** 作業場所 cwd の git の本体（canonical root。スラッシュ形・末尾なし）。git の外・読めない・空は null */
export async function canonicalWorkspace(cwd, { platform = process.platform, io = GIT_IO } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  let original;
  try { original = await io.realpath(cwd); } catch { original = cwd; }
  if (!P.isAbsolute(original)) return null;
  const root = await gitRootOf(original, P, io);
  if (!root) return null;
  return slashPath(await canonicalRoot(root, P, io, platform));
}
