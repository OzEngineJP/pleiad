// エージェント自身の MCP を名前で止める会話のための、設定の置き場の写し（ADR 0330）。
// Devin（DEVIN_CONFIG_HOME）は、会話ごとに MCP を名前で止める引数を持たない。そこで、止める名前があるターンだけ、
// 本物の置き場（利用者の %APPDATA%\devin など）を写した置き場を Pleiad のデータ置き場に作り、そちらを指して起動する。
//   - 本物のディレクトリはジャンクション（Windows）／シンボリックリンク、ファイルはシンボリックリンクで写す。
//     エージェントが書く認証情報・会話の記録・ログは、リンクを通って本物に書かれる（写しに分かれない）
//   - 止める名前を書いたファイル（generated）だけを Pleiad が書く。本物の置き場のファイルは読むだけで、書き換えない
//   - SQLite の DB（*.db と -wal・-shm）はリンクしない。SQLite は -wal を開いたパスの隣に作るので、本物と写しから同時に開くと壊れうる
// 置き場は「本物の置き場 × 止める名前」ごとに 1 つ（同じ組み合わせの会話は共有する）。止める名前が無いターンは使わない（今までと同じ起動）。
// 使っていない古い写しは、新しく使うときに片付ける（claimMcpOffHome）。
// シンボリックリンクを作れない PC（Windows の既定。開発者モードが off）では写しを作れないので、止める手が無いものとして鍵にする（canLinkMcpOffHome）。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from '../atomic-file.mjs';
import { CAPABILITY_STATES } from './agent-marks.mjs';

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

const defaultLinker = (from, to, type) => fsSync.symlinkSync(from, to, type);
let linker = defaultLinker;
/** データ置き場ごとの「リンクを作れるか」の結果。プロセスの間は持ち続ける（開発者モードを後から on にしたら、Pleiad を起動し直すと確かめ直す） */
const linkable = new Map();
const dataDirOf = dir => clean(dir ?? process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'));
const dirLinkType = () => (process.platform === 'win32' ? 'junction' : 'dir');

/** 試験用: リンクを作る関数を差し替える（null で元に戻す）。差し替えると「リンクを作れるか」を確かめ直す */
export function setMcpOffLinker(fn) {
  linker = fn ?? defaultLinker;
  linkable.clear();
}

/**
 * このデータ置き場の下に、ファイルのシンボリックリンクとディレクトリのジャンクション（Windows）／リンクを作れるか。
 * 1 度だけデータ置き場の中で作って確かめ、結果を持つ。作れないなら写しの置き場を作れないので、名前で止める手は無いものとして扱う（nativeMcpOffMode）。
 * AGENT_HOST_FAKE_NO_LINKS=1 は作れない PC のふり（試験用）
 */
export function canLinkMcpOffHome(dataDir) {
  if (process.env.AGENT_HOST_FAKE_NO_LINKS === '1') return false;
  const key = dataDirOf(dataDir);
  if (linkable.has(key)) return linkable.get(key);
  let ok = false, probe = null;
  try {
    fsSync.mkdirSync(key, { recursive: true, mode: 0o700 });
    probe = fsSync.mkdtempSync(path.join(key, '.mcp-off-link-probe-'));
    fsSync.writeFileSync(path.join(probe, 'file'), '');
    fsSync.mkdirSync(path.join(probe, 'dir'));
    linker(path.join(probe, 'file'), path.join(probe, 'file-link'), 'file');
    linker(path.join(probe, 'dir'), path.join(probe, 'dir-link'), dirLinkType());
    ok = true;
  } catch { ok = false; }
  finally {
    if (probe) {
      // リンクを先に外してから消す（ジャンクションの先を消さない）
      for (const n of ['file-link', 'dir-link']) { try { fsSync.unlinkSync(path.join(probe, n)); } catch { try { fsSync.rmdirSync(path.join(probe, n)); } catch { /* 無い */ } } }
      try { fsSync.rmSync(probe, { recursive: true, force: true }); } catch { /* 残っても次の確かめには効かない */ }
    }
  }
  linkable.set(key, ok);
  return ok;
}

/**
 * 能力の印 nativeMcpOff を、この PC で使えるかまで含めて読む。
 *   true    どの定義も止められる（起動の引数で止める。写しの置き場は使わない）
 *   'user'  ユーザーの設定の定義だけ止められる（写しの置き場を使う）。リンクを作れない PC では null
 *   null    止める手が無い
 */
export function nativeMcpOffMode(agent, dataDir) {
  const mark = CAPABILITY_STATES[agent]?.nativeMcpOff;
  if (mark === true) return true;
  if (mark === 'user') return canLinkMcpOffHome(dataDir) ? 'user' : null;
  return null;
}

/**
 * 写しの残す数。超えたうえで、MCP_OFF_IDLE_MS 以上使っていないものだけ、古い順に消す（止める名前の組み合わせで増え続けないように。
 * 使うたびに印（mtime）を付けるので、いま走っている会話や最近使った写しは消さない。core/backends/opencode-context.mjs の写しと同じ規則）
 */
export const MCP_OFF_KEEP = 12;
export const MCP_OFF_IDLE_MS = 24 * 60 * 60 * 1000;

/** リンク（ジャンクション）は外すだけにして（先の本物は消さない）、写しを消す。消す前に、写しの中で置き換わったファイルを本物へ運ぶ（settleMcpOffHome） */
async function removeTree(dir) {
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (name.endsWith(MANIFEST_SUFFIX)) await settleMcpOffHome(path.join(dir, name.slice(0, -MANIFEST_SUFFIX.length)), { idleMs: 0 }).catch(() => {});
  }
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

// ---- 写しの中で置き換わったファイルを本物へ運ぶ（settle）
// エージェントは設定・認証情報を「一時ファイルに書いて rename で置き換える」ことが多い。写しの中でそうすると、本物へのリンクが
// 普通のファイルに置き換わり、書いた中身は写しにだけ残る。それを本物へ運び、リンクに戻す。Pleiad が本物の置き場を書くのはここだけ:
//   - 本物と同じ名前のファイル: 写しのほうが新しい（mtime）なら、その中身で本物を置き換える（writeAtomic）。中身が同じなら運ばない。
//     本物のほうが新しい（写しの外で本物が更新された）なら、本物を正とし、写しの中身は kept へ移して残す（どちらも消さない）
//   - 本物に無い名前のファイル（写しの中で新しく作られた）: 本物へ写し（wx。本物に同じ名前ができていたら運ばない）、リンクに替える。
//     一時ファイルらしい名前・SQLite の DB・ロック・skip の名前は運ばない
//   - Pleiad が書くファイル（generated）をエージェントが書き換えた: 本物へは運ばない（止める名前の disabled を本物へ書かないため）。
//     中身は kept へ移して残し、次のそろえで書き直す
//   - ディレクトリ: 本物のディレクトリはリンクなので中の書き込みは本物に届く。写しの中で新しく作られたディレクトリは運ばない（残す）
// 書きかけを運ばないよう、最後の更新から MCP_OFF_SETTLE_IDLE_MS たっていないファイルは次の機会に回す。
// 運ぶ機会は、写しをそろえるとき（その組み合わせのターン）・Devin のターンを起こすとき（同じ本物の置き場の写しすべて）・古い写しを消す前。
export const MCP_OFF_SETTLE_IDLE_MS = 5000;
/** kept に残す数（古いものから消す） */
export const MCP_OFF_KEPT_MAX = 50;
const MANIFEST_SUFFIX = '.pleiad.json';
const TEMP_LIKE = /\.(tmp|temp|swp|bak|part)$|~$|\.tmp[-.]|^\.#/i;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const manifestOf = target => `${target}${MANIFEST_SUFFIX}`;
const readManifest = async target => {
  try { const value = JSON.parse(await fs.readFile(manifestOf(target), 'utf8')); return value && typeof value === 'object' ? value : null; } catch { return null; }
};

/** 写しの中のファイル at を本物へのリンク from に替える（一時のリンクを作って rename で置き換える。できなければ外して作る） */
async function relink(at, from) {
  const temp = `${at}.ply-link-${crypto.randomBytes(4).toString('hex')}`;
  try {
    linker(from, temp, 'file');
    try { await fs.rename(temp, at); return; } catch { await fs.unlink(temp).catch(() => {}); }
  } catch { /* 下で作り直す */ }
  await fs.unlink(at).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  linker(from, at, 'file');
}

/** 写しの中のファイルを kept へ移して残す（<日時>-<写しの組み合わせ>-<名前>）。古いものは MCP_OFF_KEPT_MAX を超えた分を消す */
async function keep(kept, target, name) {
  await fs.mkdir(kept, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const combo = path.basename(path.dirname(target));
  await fs.rename(path.join(target, name), path.join(kept, `${stamp}-${combo}-${name}`));
  const rows = [];
  for (const n of await fs.readdir(kept).catch(() => [])) {
    const info = await fs.stat(path.join(kept, n)).catch(() => null);
    if (info?.isFile()) rows.push({ n, time: info.mtimeMs });
  }
  rows.sort((x, y) => y.time - x.time);
  for (const { n } of rows.slice(MCP_OFF_KEPT_MAX)) await fs.rm(path.join(kept, n), { force: true }).catch(() => {});
}

/**
 * 写し target の中で置き換わった・新しく作られたファイルを本物へ運び、リンクに戻す（上の「settle」）。
 * 本物の置き場・kept・Pleiad が書くファイルの名前は、写しをそろえたときの記録（<target>.pleiad.json）から読む。記録の無い写しは触らない。
 * 1 つのファイルで失敗しても、ほかのファイルは続ける（失敗したファイルは写しに残し、次の機会に運ぶ）
 */
export async function settleMcpOffHome(target, { idleMs = MCP_OFF_SETTLE_IDLE_MS, skip = () => false } = {}) {
  const manifest = await readManifest(target);
  if (!manifest?.source || !manifest.kept) return;
  const { source, kept } = manifest;
  const generated = manifest.generated && typeof manifest.generated === 'object' ? manifest.generated : {};
  if (!(await fs.stat(source).catch(() => null))?.isDirectory()) return;
  const now = Date.now();
  for (const name of await fs.readdir(target).catch(() => [])) {
    const at = path.join(target, name);
    const info = await lstat(at).catch(() => null);
    if (!info?.isFile() || /\.lock$/i.test(name) || name.includes('.ply-link-') || now - info.mtimeMs < idleMs) continue;
    try {
      if (Object.hasOwn(generated, name)) {
        // Pleiad が書いたままなら何もしない。エージェントが書き換えたら kept へ（次のそろえで書き直す）
        if (sha(await fs.readFile(at, 'utf8')) !== generated[name]) await keep(kept, target, name);
        continue;
      }
      if (skip(name) || UNSHARED_FILE.test(name)) continue;
      const from = path.join(source, name);
      const real = await fs.stat(from).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (real?.isDirectory()) continue;
      const content = await fs.readFile(at);
      const unchanged = async () => { const again = await lstat(at); return again?.isFile() && again.mtimeMs === info.mtimeMs && again.size === info.size; };
      if (!real) {
        if (TEMP_LIKE.test(name)) continue;
        try { await fs.writeFile(from, content, { flag: 'wx', mode: info.mode & 0o777 }); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        if (await unchanged()) await relink(at, from);
        continue;
      }
      const realContent = await fs.readFile(from);
      if (!realContent.equals(content)) {
        if (info.mtimeMs > real.mtimeMs) await writeAtomic(await fs.realpath(from), content, { mode: real.mode & 0o777 });
        else { await keep(kept, target, name); await relink(at, from); continue; }
      }
      // 運んでいる間にエージェントがまた書いたら、リンクに戻さない（次の機会に運ぶ）
      if (await unchanged()) await relink(at, from);
    } catch { /* このファイルは写しに残し、次の機会に運ぶ */ }
  }
}

/** root の下の写しのうち、本物の置き場が source のものをすべて settle する（Devin のターンを起こすとき。止める名前を on に戻した後も、前の写しに残った更新を運ぶ） */
export async function settleMcpOffHomes(root, source) {
  for (const key of await fs.readdir(root).catch(() => [])) {
    const dir = path.join(root, key);
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (!name.endsWith(MANIFEST_SUFFIX)) continue;
      const target = path.join(dir, name.slice(0, -MANIFEST_SUFFIX.length));
      const manifest = await readManifest(target);
      if (manifest?.source && same(manifest.source, source)) await settleMcpOffHome(target).catch(() => {});
    }
  }
}

/**
 * target を source の写しにそろえる。
 *   generated  { <名前>: 中身 }。Pleiad が書くファイル（本物の同じ名前は写さない）
 *   skip       (名前) → true なら写さない（エージェントが写しの中に自分で作る）
 *   kept       写しの中身を本物へ運べないとき（本物のほうが新しい・Pleiad が書くファイルの書き換え）に移して残す場所。
 *              渡すと、そろえる前に settle する（settleMcpOffHome）。渡さなければ、置き換わったファイルは写しに残す（消さない）
 * 写しの中にエージェントが作ったファイル・ディレクトリは消さない（運べるものは本物へ運んでリンクにする。写しだけの DB などは残す）。
 * 消すのは、もう要らないリンクだけ
 */
export async function syncMcpOffHome({ source, target, generated = {}, skip = () => false, kept = null }) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  if (kept) {
    const before = await readManifest(target);
    if (before?.source && same(before.source, source)) await settleMcpOffHome(target, { skip });
  }
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
    // 普通のファイル・ディレクトリ（エージェントが写しの中で置き換えた・作ったもの）は消さない。本物へ運べるものは settle が運んでリンクに戻す
    if (!info?.isSymbolicLink()) continue;
    if (wanted && same(await fs.readlink(at), wanted.from)) { want.delete(name); continue; }
    // ジャンクション・ディレクトリのリンクも unlink で外れる（先は消えない）
    await fs.unlink(at).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  }
  for (const [name, { from, directory }] of want) {
    const at = path.join(target, name);
    if (await lstat(at)) continue;
    try { linker(from, at, directory ? dirLinkType() : 'file'); }
    catch (error) {
      // 同じ写しを別の会話が同時にそろえた
      if (error.code === 'EEXIST') {
        const info = await lstat(at);
        if (info?.isSymbolicLink() && same(await fs.readlink(at), from)) continue;
      }
      // 作れなくなった（権限が変わった）かもしれない。次に一覧を出すときに確かめ直す（作れないなら鍵になる）
      linkable.clear();
      throw Object.assign(new Error(`Could not link ${name} into the conversation settings folder (${error.code}). Allow creating symbolic links (Windows: Developer Mode) and try again.`), { code: 'MCP_OFF_LINK_FAILED', cause: error });
    }
  }
  const previous = (await readManifest(target))?.generated ?? {};
  for (const [name, content] of Object.entries(generated)) {
    const at = path.join(target, name);
    const info = await lstat(at);
    if (info?.isSymbolicLink()) await fs.unlink(at);
    else if (info) {
      const now = await fs.readFile(at, 'utf8').catch(() => null);
      if (now === content) continue;
      // エージェントが書き換えた（前に書いた中身と違う）ものは、書き直す前に kept へ移して残す（まだ settle していない新しい書き換え）
      if (kept && now !== null && previous[name] && sha(now) !== previous[name]) await keep(kept, target, name).catch(() => {});
    }
    await writeAtomic(at, content, { mode: 0o600 });
  }
  // 次の settle が読む記録（本物の置き場・kept・Pleiad が書いたファイルの中身の指紋）
  if (kept) {
    const record = { source: clean(source), kept: clean(kept), generated: Object.fromEntries(Object.entries(generated).map(([n, c]) => [n, sha(c)])) };
    const text = `${JSON.stringify(record)}\n`;
    if (await fs.readFile(manifestOf(target), 'utf8').catch(() => null) !== text) await writeAtomic(manifestOf(target), text, { mode: 0o600 });
  }
  return target;
}
