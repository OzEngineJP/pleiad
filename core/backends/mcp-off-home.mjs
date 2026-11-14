// エージェント自身の MCP を名前で止める会話のための、設定の置き場の写し（ADR 0330）。
// Grok（GROK_HOME）・Devin（DEVIN_CONFIG_HOME）は、会話ごとに MCP を名前で止める引数を持たない。そこで、止める名前があるターンだけ、
// 本物の置き場（利用者の ~/.grok・%APPDATA%\devin など）を写した置き場を Pleiad のデータ置き場に作り、そちらを指して起動する。
//   - 本物のディレクトリはジャンクション（Windows）／シンボリックリンク、ファイルはシンボリックリンクで写す。
//     エージェントが書く認証情報・会話の記録・ログは、リンクを通って本物に書かれる（写しに分かれない）
//   - 止める名前を書いたファイル（generated）だけを Pleiad が書く。本物の置き場のファイルは読むだけで、書き換えない
//   - SQLite の DB（*.db と -wal・-shm）はリンクしない。SQLite は -wal を開いたパスの隣に作るので、本物と写しから同時に開くと壊れうる
// 置き場は「本物の置き場 × 止める名前」ごとに 1 つ（同じ組み合わせの会話は共有する）。止める名前が無いターンは使わない（今までと同じ起動）。
// 使っていない古い写しは、新しく使うときに片付ける（claimMcpOffHome）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from '../atomic-file.mjs';

/** 写さないファイル（SQLite の DB とその付属） */
export const UNSHARED_FILE = /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i;

const clean = p => path.resolve(String(p).replace(/^\\\\\?\\/, ''));
const same = (a, b) => process.platform === 'win32' ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);

/** 本物の置き場 source と止める名前 suppress の組み合わせごとの写しの場所（root の下） */
export function mcpOffHomeDir(root, source, suppress) {
  const key = crypto.createHash('sha256').update(JSON.stringify([clean(source), [...new Set(suppress)].sort()])).digest('hex').slice(0, 16);
  return path.join(root, key);
}

const lstat = p => fs.lstat(p).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));

/**
 * 写しの残す数。超えたうえで、MCP_OFF_IDLE_MS 以上使っていないものだけ、古い順に消す（止める名前の組み合わせで増え続けないように。
 * 使うたびに印（mtime）を付けるので、いま走っている会話や最近使った写しは消さない。core/backends/opencode-context.mjs の写しと同じ規則）
 */
export const MCP_OFF_KEEP = 12;
export const MCP_OFF_IDLE_MS = 24 * 60 * 60 * 1000;

/** リンク（ジャンクション）は外すだけにして（先の本物は消さない）、写しを消す */
async function removeTree(dir) {
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) await fs.unlink(p).catch(() => fs.rmdir(p).catch(() => {}));
      else if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * 本物の置き場 source と止める名前 suppress の組み合わせの写しの場所を作って返す（mcpOffHomeDir）。
 * 使った印を付け、root の下の古い写しを片付ける（MCP_OFF_KEEP・MCP_OFF_IDLE_MS）
 */
export async function claimMcpOffHome(root, source, suppress) {
  const dir = mcpOffHomeDir(root, source, suppress);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  await fs.utimes(dir, now, now).catch(() => {});
  const rows = [];
  for (const name of await fs.readdir(root).catch(() => [])) {
    const at = path.join(root, name);
    const info = await fs.lstat(at).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink() && at !== dir) rows.push({ at, time: info.mtimeMs });
  }
  rows.sort((x, y) => y.time - x.time);
  const limit = Date.now() - MCP_OFF_IDLE_MS;
  for (const { at, time } of rows.slice(Math.max(0, MCP_OFF_KEEP - 1))) if (time < limit) await removeTree(at);
  return dir;
}

/**
 * target を source の写しにそろえる。
 *   generated  { <名前>: 中身 }。Pleiad が書くファイル（本物の同じ名前は写さない）
 *   skip       (名前) → true なら写さない（エージェントが写しの中に自分で作る）
 * 写しの中にエージェントが作ったファイル・ディレクトリで、本物に同じ名前が無いものは消さない（写しだけの DB など）。
 * 消すのは、もう要らないリンクと、本物と同じ名前の普通のファイル（リンクに戻す）だけ
 */
export async function syncMcpOffHome({ source, target, generated = {}, skip = () => false, shared = [] }) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  // shared: 写しと本物で必ず同じにするディレクトリ（会話の記録など）。本物にまだ無ければ空で作る（無いままだと、エージェントが写しの中に作り、記録が分かれる）
  for (const name of shared) await fs.mkdir(path.join(source, name), { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(source, { withFileTypes: true }).catch(e => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  const want = new Map();
  for (const entry of entries) {
    if (Object.hasOwn(generated, entry.name) || skip(entry.name) || UNSHARED_FILE.test(entry.name)) continue;
    const from = path.join(source, entry.name);
    // リンクの先が無いもの（壊れたリンク）は写さない。ファイルのリンクは、先があるものだけ（無い先へのリンクは、エージェントが書くとき普通のファイルに置き換わる）
    const pointed = await fs.stat(from).catch(() => null);
    if (!pointed) continue;
    want.set(entry.name, { from, directory: pointed.isDirectory() });
  }
  for (const name of await fs.readdir(target)) {
    if (Object.hasOwn(generated, name)) continue;
    const at = path.join(target, name);
    const info = await lstat(at);
    const wanted = want.get(name);
    if (!info?.isSymbolicLink()) {
      // エージェントが写しの中で置き換えた（一時ファイルからの rename でリンクが普通のファイルになった）本物と同じ名前のファイルは、
      // 本物へのリンクに戻す（写しの設定が本物から離れたままにしない）。ロックのファイル（*.lock）は使用中かもしれないので触らない
      if (wanted && !wanted.directory && info?.isFile() && !/\.lock$/i.test(name)) await fs.unlink(at).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      continue;
    }
    if (wanted && same(await fs.readlink(at), wanted.from)) { want.delete(name); continue; }
    // ジャンクション・ディレクトリのリンクも unlink で外れる（先は消えない）
    await fs.unlink(at).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  }
  for (const [name, { from, directory }] of want) {
    const at = path.join(target, name);
    if (await lstat(at)) continue;
    try { await fs.symlink(from, at, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
    catch (error) {
      // 同じ写しを別の会話が同時にそろえた
      if (error.code === 'EEXIST') {
        const info = await lstat(at);
        if (info?.isSymbolicLink() && same(await fs.readlink(at), from)) continue;
      }
      throw Object.assign(new Error(`Could not link ${name} into the conversation settings folder (${error.code}). Allow creating symbolic links (Windows: Developer Mode) and try again.`), { code: 'MCP_OFF_LINK_FAILED', cause: error });
    }
  }
  for (const [name, content] of Object.entries(generated)) {
    const at = path.join(target, name);
    const info = await lstat(at);
    if (info?.isSymbolicLink()) await fs.unlink(at);
    else if (info && await fs.readFile(at, 'utf8').catch(() => null) === content) continue;
    await writeAtomic(at, content, { mode: 0o600 });
  }
  return target;
}
