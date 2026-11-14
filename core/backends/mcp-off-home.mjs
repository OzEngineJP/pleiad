// エージェント自身の MCP を名前で止める会話のための、設定の置き場の写し（ADR 0336）。
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
const nameKey = n => (process.platform === 'win32' ? n.toLowerCase() : n);

/** 本物の置き場 source と止める名前 suppress の組み合わせごとの写しの場所（root の下） */
export function mcpOffHomeDir(root, source, suppress) {
  const key = crypto.createHash('sha256').update(JSON.stringify([clean(source), [...new Set(suppress)].sort()])).digest('hex').slice(0, 16);
  return path.join(root, key);
}

const lstat = p => fs.lstat(p).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));

const defaultLinker = (from, to, type) => fsSync.symlinkSync(from, to, type);
let linker = defaultLinker;
/**
 * データ置き場ごとの「リンクを作れるか」の結果（{ ok, at }）。作れると分かったら、プロセスの間は持ち続ける。
 * 作れないという結果は MCP_OFF_NOLINK_RECHECK_MS だけ持ち、それを過ぎたら確かめ直す（1 回の一覧の中では確かめ直さず、
 * 開発者モードを後から on にしたら、Pleiad を起動し直さなくても次に一覧を出すときから押せるようにする）
 */
const linkable = new Map();
export const MCP_OFF_NOLINK_RECHECK_MS = 2000;
const dataDirOf = dir => clean(dir ?? process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'));
const dirLinkType = () => (process.platform === 'win32' ? 'junction' : 'dir');

/** 試験用: リンクを作る関数を差し替える（null で元に戻す）。差し替えると「リンクを作れるか」を確かめ直す */
export function setMcpOffLinker(fn) {
  linker = fn ?? defaultLinker;
  linkable.clear();
}

/**
 * このデータ置き場の下に、ファイルのシンボリックリンクとディレクトリのジャンクション（Windows）／リンクを作れるか。
 * データ置き場の中で作って確かめる（結果の持ち方は上の linkable）。作れないなら写しの置き場を作れないので、名前で止める手は無いものとして扱う（nativeMcpOffMode）。
 * now は試験用（確かめ直すまでの時間を進める）。AGENT_HOST_FAKE_NO_LINKS=1 は作れない PC のふり（試験用）
 */
export function canLinkMcpOffHome(dataDir, now = Date.now()) {
  if (process.env.AGENT_HOST_FAKE_NO_LINKS === '1') return false;
  const key = dataDirOf(dataDir);
  const known = linkable.get(key);
  if (known && (known.ok || now - known.at < MCP_OFF_NOLINK_RECHECK_MS)) return known.ok;
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
  linkable.set(key, { ok, at: now });
  return ok;
}

/**
 * 能力の印 nativeMcpOff を、この PC で使えるかまで含めて読む。
 *   true    どの定義も止められる（起動の引数で止める。写しの置き場は使わない）
 *   'user'  ユーザーの設定の定義だけ止められる（写しの置き場を使う）。リンクを作れない PC では null（鍵の理由は 'nolinks'）
 *   null    止める手が無い
 */
export function nativeMcpOffMode(agent, dataDir) {
  const mark = CAPABILITY_STATES[agent]?.nativeMcpOff;
  if (mark === true) return true;
  if (mark === 'user') return canLinkMcpOffHome(dataDir) ? 'user' : null;
  return null;
}

/** 写しの置き場で止める手（nativeMcpOff: 'user'）を持つのに、この PC ではリンクを作れないので止められないか（鍵の理由 'nolinks'） */
export const mcpOffBlockedByLinks = (agent, dataDir) => CAPABILITY_STATES[agent]?.nativeMcpOff === 'user' && !canLinkMcpOffHome(dataDir);

/**
 * 写しの残す数。超えたうえで、MCP_OFF_IDLE_MS 以上使っていないものだけ、古い順に消す（止める名前の組み合わせで増え続けないように。
 * 使うたびに印（mtime）を付けるので、いま走っている会話や最近使った写しは消さない。core/backends/opencode-context.mjs の写しと同じ規則）
 */
export const MCP_OFF_KEEP = 12;
export const MCP_OFF_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * 写しの片付けの前に、写しの中の 1 つ（at）を残すか調べる。リンク・Pleiad の一時のリンク・ロック・Pleiad が書いたままのファイルは要らない（true）。
 * それ以外（本物へ運べなかったファイル・写しの中で作られたディレクトリ）は kept へ移す。移せなければ false（その写しは消さない）
 */
async function evacuate(at, { manifest, kept, combo }) {
  const name = path.basename(at);
  const info = await lstat(at).catch(() => null);
  if (!info || info.isSymbolicLink() || name.includes('.ply-link-') || name.endsWith(MANIFEST_SUFFIX)) return true;
  if (info.isFile() && /\.lock$/i.test(name)) return true;
  const pleiad = manifest?.generated?.[name];
  if (pleiad && info.isFile() && sha(await fs.readFile(at, 'utf8').catch(() => '')) === pleiad) return true;
  if (!kept) return false;
  try { await keep(kept, at, { combo }); return true; } catch { return false; }
}

/**
 * 写し dir を消す。消す前に、写しの中で置き換わったファイルを本物へ運び（settleMcpOffHome）、運べなかった中身は kept へ移す（黙って消さない）。
 * kept へ移せないもの（kept が分からない・移すのに失敗した）が 1 つでもあれば、その写しは消さずに残す（次の片付けでもう一度試す）。
 * リンク（ジャンクション）は外すだけにして（先の本物は消さない）、写しを消す
 */
async function removeTree(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const manifests = new Map();
  for (const name of names) {
    if (!name.endsWith(MANIFEST_SUFFIX)) continue;
    const target = path.join(dir, name.slice(0, -MANIFEST_SUFFIX.length));
    await settleMcpOffHome(target, { idleMs: 0 }).catch(() => {});
    manifests.set(path.basename(target), await readManifest(target));
  }
  const kept = [...manifests.values()].find(m => m?.kept)?.kept ?? null;
  const combo = path.basename(dir);
  for (const name of names) {
    if (name.endsWith(MANIFEST_SUFFIX)) continue;
    const at = path.join(dir, name);
    const info = await lstat(at).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    // 写し（<組>/devin。記録の無い作りかけも）は中を 1 つずつ。写しの外に作られたファイルは、そのまま
    const inner = info.isDirectory() ? (await fs.readdir(at).catch(() => [])).map(n => path.join(at, n)) : [at];
    for (const item of inner) if (!(await evacuate(item, { manifest: manifests.get(name) ?? null, kept, combo }))) return false;
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
  return true;
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
//   - 本物と同じ名前のファイル: 写しのほうが新しい（mtime）なら、本物の今の中身を kept へ写してから、写しの中身で本物を置き換え（writeAtomic）、
//     本物の mtime を写しの mtime にそろえる（写しが 2 つあっても、運ぶ順で新旧の判定が入れ替わらないように）。中身が同じなら運ばない。
//     本物のほうが新しい（写しの外で本物が更新された）なら、本物を正とし、写しの中身は kept へ移して残す（どちらも消さない）
//   - 本物に無い名前のファイル（写しの中で新しく作られた）: そのエージェントが設定の置き場の直下に作ると分かっている名前（carry）だけ、
//     本物へ写し（wx。本物に同じ名前ができていたら運ばない）、リンクに替える。ほかの名前（一時ファイルなど）は運ばず写しに残す
//   - Pleiad が書くファイル（generated）をエージェントが書き換えた: 本物へは運ばない（止める名前の disabled を本物へ書かないため）。
//     中身は kept へ移して残し、次のそろえで書き直す
//   - ディレクトリ: 本物のディレクトリはリンクなので中の書き込みは本物に届く。写しの中で新しく作られたディレクトリは運ばない（残す）
// 書きかけを運ばないよう、最後の更新から MCP_OFF_SETTLE_IDLE_MS たっていないファイルは次の機会に回す。
// 運ぶ機会は、写しをそろえるとき（その組み合わせのターン）・Devin のターンを起こすとき（同じ本物の置き場の写しすべて）・古い写しを消す前。
export const MCP_OFF_SETTLE_IDLE_MS = 5000;
/** kept に残す数と日数（どちらかを超えたものから消す。中身は設定・認証情報の写しで、秘密を含みうる） */
export const MCP_OFF_KEPT_MAX = 50;
export const MCP_OFF_KEPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MANIFEST_SUFFIX = '.pleiad.json';
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

/**
 * kept の古いものを消す（MCP_OFF_KEPT_MAX を超えた分と、MCP_OFF_KEPT_MAX_AGE_MS より前に残したもの）。
 * 残した時刻は mtime（keep が付ける）。ターンを起こすたびにも呼ぶ（何も残さない日が続いても、期限を過ぎたものを消す）
 */
export async function pruneMcpOffKept(kept, now = Date.now()) {
  const rows = [];
  for (const n of await fs.readdir(kept).catch(() => [])) {
    const info = await fs.lstat(path.join(kept, n)).catch(() => null);
    if (info && !info.isSymbolicLink() && (info.isFile() || info.isDirectory())) rows.push({ n, time: info.mtimeMs });
  }
  rows.sort((x, y) => y.time - x.time);
  for (const [i, { n, time }] of rows.entries()) {
    if (i >= MCP_OFF_KEPT_MAX || now - time > MCP_OFF_KEPT_MAX_AGE_MS) await fs.rm(path.join(kept, n), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * at を kept へ移して残す（<日時>-<写しの組み合わせ>-<label><名前>）。content を渡すと、移さずにその中身を書いて残す（本物を置き換える前の中身）。
 * 残した時刻を mtime に付け、古いものを消す（pruneMcpOffKept）
 */
async function keep(kept, at, { combo, content = null, label = '' }) {
  await fs.mkdir(kept, { recursive: true, mode: 0o700 });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  const dest = path.join(kept, `${stamp}-${combo}-${label}${path.basename(at)}`);
  if (content !== null) await fs.writeFile(dest, content, { mode: 0o600, flag: 'wx' });
  else {
    await fs.rename(at, dest);
    const now = new Date();
    await fs.utimes(dest, now, now).catch(() => {});
  }
  await pruneMcpOffKept(kept);
}

/**
 * 写し target の中で置き換わった・新しく作られたファイルを本物へ運び、リンクに戻す（上の「settle」）。
 * 本物の置き場・kept・Pleiad が書くファイル・本物へ写してよい新しい名前は、写しをそろえたときの記録（<target>.pleiad.json）から読む。記録の無い写しは触らない。
 * 1 つのファイルで失敗しても、ほかのファイルは続ける（失敗したファイルは写しに残し、次の機会に運ぶ。古い写しを片付けるときは kept へ移す）
 */
export async function settleMcpOffHome(target, { idleMs = MCP_OFF_SETTLE_IDLE_MS, skip = () => false } = {}) {
  const manifest = await readManifest(target);
  if (!manifest?.source || !manifest.kept) return;
  const { source, kept } = manifest;
  const generated = manifest.generated && typeof manifest.generated === 'object' ? manifest.generated : {};
  const carry = new Set((Array.isArray(manifest.carry) ? manifest.carry : []).map(nameKey));
  const combo = path.basename(path.dirname(target));
  if (!(await fs.stat(source).catch(() => null))?.isDirectory()) return;
  const now = Date.now();
  for (const name of await fs.readdir(target).catch(() => [])) {
    const at = path.join(target, name);
    const info = await lstat(at).catch(() => null);
    if (!info?.isFile() || /\.lock$/i.test(name) || name.includes('.ply-link-') || now - info.mtimeMs < idleMs) continue;
    try {
      if (Object.hasOwn(generated, name)) {
        // Pleiad が書いたままなら何もしない。エージェントが書き換えたら kept へ（次のそろえで書き直す）
        if (sha(await fs.readFile(at, 'utf8')) !== generated[name]) await keep(kept, at, { combo });
        continue;
      }
      if (skip(name) || UNSHARED_FILE.test(name)) continue;
      const from = path.join(source, name);
      const real = await fs.stat(from).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (real?.isDirectory()) continue;
      const content = await fs.readFile(at);
      const unchanged = async () => { const again = await lstat(at); return again?.isFile() && again.mtimeMs === info.mtimeMs && again.size === info.size; };
      if (!real) {
        if (!carry.has(nameKey(name))) continue;
        try { await fs.writeFile(from, content, { flag: 'wx', mode: info.mode & 0o777 }); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        await fs.utimes(from, info.atime, info.mtime).catch(() => {});
        if (await unchanged()) await relink(at, from);
        continue;
      }
      const realContent = await fs.readFile(from);
      if (!realContent.equals(content)) {
        if (info.mtimeMs > real.mtimeMs) {
          // 置き換える前の本物の中身を kept に残す（運ぶ間に本物が書き換わった・時計が戻ったときに失わない）
          await keep(kept, from, { combo, content: realContent, label: 'replaced-' });
          const realPath = await fs.realpath(from);
          await writeAtomic(realPath, content, { mode: real.mode & 0o777 });
          // 本物の mtime を写しにそろえる（運んだ時刻にすると、もっと新しい別の写しが「本物より古い」と判定されて kept へ行く）
          await fs.utimes(realPath, info.atime, info.mtime).catch(() => {});
        } else { await keep(kept, at, { combo }); await relink(at, from); continue; }
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
 *   carry      本物に無い名前でも、写しの中で作られたら本物へ写してよい名前（エージェントが設定の置き場の直下に作ると分かっているもの）
 * 写しの中にエージェントが作ったファイル・ディレクトリは消さない（運べるものは本物へ運んでリンクにする。写しだけの DB などは残す）。
 * 消すのは、もう要らないリンクと、前は Pleiad が書いていて今は書かない名前の Pleiad が書いたままの中身だけ
 */
export async function syncMcpOffHome({ source, target, generated = {}, skip = () => false, kept = null, carry = [] }) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const before = await readManifest(target);
  if (kept && before?.source && same(before.source, source)) await settleMcpOffHome(target, { skip });
  // 前の記録（無ければ null。片付けの失敗や手で消したとき）。Pleiad が書いたファイルの指紋
  const previous = before?.generated && typeof before.generated === 'object' ? before.generated : null;
  // 前は Pleiad が書いていて、今は書かない名前（本物の config.json から mcpServers が消えたなど）: Pleiad が書いたままの中身は消して、
  // 下で本物へのリンクに替える（写しの中の古い中身を、後の settle が本物へ運ばない）。書き換えられていたら kept へ移す
  for (const name of Object.keys(previous ?? {})) {
    if (Object.hasOwn(generated, name)) continue;
    const at = path.join(target, name);
    const info = await lstat(at);
    if (!info?.isFile()) continue;
    if (sha(await fs.readFile(at, 'utf8')) === previous[name]) await fs.unlink(at);
    else if (kept) await keep(kept, at, { combo: path.basename(path.dirname(target)) }).catch(() => {});
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
  for (const [name, content] of Object.entries(generated)) {
    const at = path.join(target, name);
    const info = await lstat(at);
    if (info?.isSymbolicLink()) await fs.unlink(at);
    else if (info) {
      const now = await fs.readFile(at, 'utf8').catch(() => null);
      if (now === content) continue;
      // Pleiad が前に書いたままでない中身（エージェントが書き換えた・記録が無くて前に書いた中身が分からない）は、書き直す前に kept へ移して残す
      if (kept && now !== null && (!previous?.[name] || sha(now) !== previous[name])) await keep(kept, at, { combo: path.basename(path.dirname(target)) }).catch(() => {});
    }
    await writeAtomic(at, content, { mode: 0o600 });
  }
  // 次の settle が読む記録（本物の置き場・kept・Pleiad が書いたファイルの中身の指紋・本物へ写してよい新しい名前）
  if (kept) {
    const record = { source: clean(source), kept: clean(kept), generated: Object.fromEntries(Object.entries(generated).map(([n, c]) => [n, sha(c)])), carry: [...new Set(carry)].sort() };
    const text = `${JSON.stringify(record)}\n`;
    if (await fs.readFile(manifestOf(target), 'utf8').catch(() => null) !== text) await writeAtomic(manifestOf(target), text, { mode: 0o600 });
  }
  return target;
}
