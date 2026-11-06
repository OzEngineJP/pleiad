// 可視化の束（ADR 0292 の 3 の 4）。visualize{"path":…} が指す HTML と、同じフォルダーの下のファイルを、
// 内容のハッシュで <データ置き場>/viz-blobs/<sha256> に 1 ファイルずつ書く（書いたら変えない）。
// 束の目録（相対パス → sha256）も同じ置き場に、目録そのものの sha256 の名前で置く。この名前が束のハッシュで、
// 隔離の origin は /viz/<束のハッシュ>/<相対パス> で目録を引いて配る（core/isolated-routes.mjs）。
// 束の一覧は可視化の記録の行（core/history.mjs）が持つ。記録から消えた束のファイルは起動時の片付け（sweepVizBlobs）で消す。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectFile, readBounded } from './file-preview.mjs';

export const BLOB_DIR = 'viz-blobs';
/** 束の上限（2026-11-06 の追加の決定）。どれかを超えたら HTML だけの束にする */
export const BUNDLE_LIMITS = Object.freeze({ files: 200, bytes: 32 * 1024 * 1024, file: 8 * 1024 * 1024 });
// 中を見るフォルダーの数の上限（ファイルの無い深いフォルダーで歩き続けないため）
const MAX_DIRS = 2000;
const HASH = /^[0-9a-f]{64}$/;

export const blobDir = dataDir => path.join(dataDir, BLOB_DIR);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const isHash = value => typeof value === 'string' && HASH.test(value);

/** 束の中から外す名前（ドットで始まるもの・node_modules） */
export const skippedName = name => name.startsWith('.') || name.toLowerCase() === 'node_modules';

/** 目録の文字列。キーを並べて、同じ中身なら同じ文字列（同じハッシュ）になるようにする */
export function manifestText(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ v: 1, files: sorted });
}

/** 中身を書く。同じ名前があれば書かずに時刻だけ進める（片付けの猶予の内に入れる）。一時ファイルに書いてから名前を変える */
async function writeBlob(dir, hash, body) {
  const file = path.join(dir, hash);
  const now = new Date();
  if (await fs.utimes(file, now, now).then(() => true, () => false)) return;
  const temp = path.join(dir, `${hash}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(temp, body, { flag: 'wx' });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    // 同じ中身を別の書き手が先に置いた（Windows は置き換えを断ることがある）
    await fs.rm(temp, { force: true }).catch(() => {});
    if (!(await fs.stat(file).then(s => s.isFile(), () => false))) throw error;
  }
}

/** 目録の中身（{ 相対パス: { sha256, size, body } }）から束を書き、記録の行に持つ形を返す */
async function writeBundle(dataDir, entries, { entry, htmlOnly, reason }) {
  const dir = blobDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const files = Object.fromEntries(Object.entries(entries).map(([rel, file]) => [rel, file.sha256]));
  const manifest = manifestText(files);
  const hash = sha256(manifest);
  for (const file of Object.values(entries)) await writeBlob(dir, file.sha256, file.body);
  await writeBlob(dir, hash, manifest);
  return {
    hash, entry, htmlOnly,
    ...(reason ? { reason } : {}),
    files: Object.entries(entries).map(([rel, file]) => ({ path: rel, sha256: file.sha256, size: file.size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** 束の入口の名前。HTML の名前に使えない文字（パスの区切り・制御文字）が来たら index.html にする */
export function entryName(file) {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? '';
  return base && !skippedName(base) && /\.html?$/i.test(base) && !/[\u0000-\u001f]/.test(base) ? base : 'index.html';
}

/**
 * HTML だけの束（上限を超えたとき・前の版の記録）。reason: too-many-files | too-large | file-too-large | legacy
 */
export async function htmlOnlyBundle(dataDir, { entry, body, reason }) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return writeBundle(dataDir, { [entry]: { sha256: sha256(buffer), size: buffer.length, body: buffer } }, { entry, htmlOnly: true, reason });
}

/** フォルダーの下を歩いて、束に入れるファイル（相対パス・実体）を集める。上限を超えたら理由を返す */
async function walk(root, limits) {
  const found = [];
  let bytes = 0, dirs = 0;
  const queue = [''];
  while (queue.length) {
    const relDir = queue.shift();
    if (++dirs > MAX_DIRS) return { reason: 'too-many-files' };
    let names;
    try { names = await fs.readdir(path.join(root, relDir), { withFileTypes: true }); }
    catch { continue; }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of names) {
      if (skippedName(dirent.name)) continue;
      // シンボリックリンクとジャンクションはたどらない（フォルダーの外を指せる）
      if (dirent.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) { queue.push(rel); continue; }
      if (!dirent.isFile()) continue;
      const stat = await fs.stat(path.join(root, rel)).catch(() => null);
      if (!stat) continue;
      if (stat.size > limits.file) return { reason: 'file-too-large' };
      bytes += stat.size;
      found.push({ rel, size: stat.size });
      if (found.length > limits.files) return { reason: 'too-many-files' };
      if (bytes > limits.bytes) return { reason: 'too-large' };
    }
  }
  return { found };
}

const insideRoot = (root, file) => {
  const a = process.platform === 'win32' ? root.toLowerCase() : root, b = process.platform === 'win32' ? file.toLowerCase() : file;
  const rel = path.relative(a, b);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * 可視化の束を集めて書く。file は visualize の参照が指す HTML（prepareVisualization が読んだもの）、
 * entryBody はその中身（会話の行の content と同じもの。入口はこれを使い、読み直さない）。
 * 1 つずつ ADR 0050 の検査（inspectFile）をかけ、通らないファイルは束に入れない。
 */
export async function collectBundle(file, access, { dataDir, entryBody, limits = BUNDLE_LIMITS }) {
  const { file: real } = await inspectFile(file, access);
  const root = path.dirname(real);
  const entry = entryName(real);
  const body = Buffer.isBuffer(entryBody) ? entryBody : Buffer.from(String(entryBody), 'utf8');
  const walked = await walk(root, limits);
  if (walked.reason) return htmlOnlyBundle(dataDir, { entry, body, reason: walked.reason });
  const entries = { [entry]: { sha256: sha256(body), size: body.length, body } };
  for (const { rel } of walked.found) {
    if (rel === entry) continue;
    try {
      const checked = await inspectFile(path.join(root, ...rel.split('/')), access);
      if (!checked.stat.isFile() || !insideRoot(root, checked.file)) continue;
      const data = await readBounded(checked.file, limits.file);
      entries[rel] = { sha256: sha256(data), size: data.length, body: data };
    } catch { /* 読めないもの・守られた置き場のものは入れない */ }
  }
  return writeBundle(dataDir, entries, { entry, htmlOnly: false });
}

/** 束の目録（{ 相対パス: sha256 }）。名前と中身のハッシュが合わなければ null */
export async function readManifest(dataDir, hash) {
  if (!isHash(hash)) return null;
  const raw = await fs.readFile(path.join(blobDir(dataDir), hash)).catch(() => null);
  if (!raw || sha256(raw) !== hash) return null;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed?.v === 1 && parsed.files && typeof parsed.files === 'object' ? parsed.files : null;
  } catch { return null; }
}

/** 束の中の 1 ファイルの実体のパス（中身の名前）。無ければ null */
export function blobPath(dataDir, hash) {
  return isHash(hash) ? path.join(blobDir(dataDir), hash) : null;
}

/** 記録の行の束の形を確かめて、決まった項目だけ残す（画面や前の版から来た形をそのまま書かない） */
export function cleanBundle(bundle) {
  if (!bundle || !isHash(bundle.hash) || typeof bundle.entry !== 'string' || !bundle.entry || bundle.entry.length > 1024) return null;
  const files = Array.isArray(bundle.files) ? bundle.files.slice(0, BUNDLE_LIMITS.files + 1)
    .filter(file => file && typeof file.path === 'string' && file.path.length <= 1024 && isHash(file.sha256))
    .map(file => ({ path: file.path, sha256: file.sha256, size: Number.isFinite(file.size) && file.size >= 0 ? file.size : 0 })) : [];
  return {
    hash: bundle.hash, entry: bundle.entry, htmlOnly: bundle.htmlOnly === true,
    ...(typeof bundle.reason === 'string' && /^[a-z-]{1,40}$/.test(bundle.reason) ? { reason: bundle.reason } : {}),
    files,
  };
}

/** 記録の置き場（presents/*.jsonl・conversations/*.json）の中に書かれた sha256 を集める。読めなければ null（片付けをやめる） */
async function referencedHashes(dataDir) {
  const seen = new Set();
  for (const dir of ['presents', 'conversations']) {
    let names;
    try { names = await fs.readdir(path.join(dataDir, dir)); }
    catch (error) { if (error.code === 'ENOENT') continue; return null; }
    for (const name of names) {
      if (!/\.(jsonl|json)$/i.test(name)) continue;
      let text;
      try { text = await fs.readFile(path.join(dataDir, dir, name), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; return null; }
      for (const match of text.matchAll(/[0-9a-f]{64}/g)) seen.add(match[0]);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return seen;
}

/**
 * 起動時の片付け。記録のどこにも名前が出ない束の中身と、書きかけの一時ファイルを消す。
 * 猶予（graceMs）より新しいものは残す（無停止の更新で前のサーバーが書いた直後のもの・前の版の記録を読んで書き直したもの）。
 * 目録の中のファイルは、目録が残れば残す。
 */
export async function sweepVizBlobs({ dataDir, graceMs = 60 * 60 * 1000, now = Date.now, log = () => {} }) {
  const dir = blobDir(dataDir);
  let names;
  try { names = await fs.readdir(dir); }
  catch { return { removed: 0, kept: 0 }; }
  if (!names.length) return { removed: 0, kept: 0 };
  const referenced = await referencedHashes(dataDir);
  if (!referenced) { log('viz-blobs: sweep skipped (records unreadable)'); return { removed: 0, kept: names.length }; }
  for (const hash of [...referenced]) {
    if (!names.includes(hash)) continue;
    const files = await readManifest(dataDir, hash);
    for (const sha of Object.values(files ?? {})) if (isHash(sha)) referenced.add(sha);
  }
  let removed = 0, kept = 0;
  for (const name of names) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!stat) continue;
    const blob = isHash(name), temp = /^[0-9a-f]{64}\.[0-9a-f]{12}\.tmp$/.test(name);
    if ((!blob && !temp) || (blob && referenced.has(name)) || now() - stat.mtimeMs < graceMs) { kept++; continue; }
    await fs.rm(path.join(dir, name), { force: true }).then(() => { removed++; }, () => { kept++; });
  }
  if (removed) log(`viz-blobs: removed ${removed} unreferenced`);
  return { removed, kept };
}
