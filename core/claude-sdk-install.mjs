// Claude Agent SDK を npm のレジストリから取って、データ置き場に置く部品（ADR 0206）。
// 配布物は SDK を同梱しない（Anthropic の独自ライセンス。SignPath の無料の署名の条件）。ここは取得・確かめ・展開・置き換え・片付けだけを持ち、
// どれを使うか・いつ取るか・読み込みは core/claude-sdk.mjs。
//
// 置き場: <root>/<版>/（root は <データ置き場>/claude-sdk）。中身は npm の tarball の package/ を剥がしたもの。
//   <root>/<版>/.pleiad-sdk.json   取り終えた印（名前・版・integrity）。最後に書く。印が pin と合うものだけを使う
//   <root>/<版>/.pleiad-used       最後に読み込んだ時刻（古い版の片付けで、直前に使っていた版を残すため）
//   <root>/.tmp-<版>-<乱数>/       展開の途中。確かめてから <版>/ へ名前を替える。落ちて残ったものは片付けで消す
//
// 取る: tarball を 1 本、メモリに受ける（上限 MAX_TARBALL）→ sha512 を package-lock の integrity と比べる（違えば捨てる）→
// gunzip → tar を 1 件ずつ確かめて書く（展開先の外へ出るパス・リンク・普通のファイルとフォルダー以外は全体を拒む）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const MARKER = '.pleiad-sdk.json';
export const USED = '.pleiad-used';
export const TMP_PREFIX = '.tmp-';
/** tarball の上限（0.3.288 は 1.5 MB ほど）と、展開した中身の上限（同じく 5.3 MB ほど） */
export const MAX_TARBALL = 64 * 1024 * 1024;
export const MAX_UNPACKED = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_REDIRECTS = 5;
/** 受け取りが止まったと見なすまで（無通信の時間） */
export const IDLE_TIMEOUT_MS = 30_000;
/** 片付けで、展開の途中のフォルダーを消すまでの猶予（ほかのプロセスが展開している最中のものを消さない） */
export const STALE_TMP_MS = 60 * 60_000;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/**
 * 取得の失敗。kind は画面の文言（server:claudeSdk.errors.<kind>）と再試行の判断に使う。
 *   offline   つながらない（名前が引けない・拒まれた・途中で切れた・時間切れ）
 *   proxy     プロキシが断った（407）・プロキシへつながらない
 *   tls       証明書を確かめられない（社内の中継が証明書を差し替えている、など）
 *   http      レジストリが 200 以外を返した・大きすぎる
 *   integrity 取れた中身が固定の integrity と違う
 *   extract   tarball の中身が不正（外へ出るパス・リンク・形が違う）
 *   disk      書けない（容量・権限）
 *   aborted   止めた
 */
export class ClaudeSdkFetchError extends Error {
  constructor(kind, detail, cause) {
    super(`${kind}: ${detail}`);
    this.name = 'ClaudeSdkFetchError';
    this.kind = kind;
    this.detail = String(detail ?? '');
    if (cause) this.cause = cause;
  }
}
const fail = (kind, detail, cause) => new ClaudeSdkFetchError(kind, detail, cause);

/** pin（core/claude-sdk-pin.json）の形を確かめる。版はフォルダー名になるので、形の決まったものだけを通す */
export function checkPin(pin) {
  if (!pin || typeof pin !== 'object') throw new Error('claude-sdk pin is missing');
  if (pin.name !== '@anthropic-ai/claude-agent-sdk') throw new Error(`claude-sdk pin has an unexpected name: ${pin.name}`);
  if (!VERSION_RE.test(String(pin.version))) throw new Error(`claude-sdk pin has an invalid version: ${pin.version}`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(pin.integrity))) throw new Error('claude-sdk pin needs a sha512 integrity');
  if (!/^https:\/\//.test(String(pin.tarball))) throw new Error('claude-sdk pin needs an https tarball URL');
  return pin;
}

export const versionDir = (root, version) => {
  if (!VERSION_RE.test(String(version))) throw new Error(`invalid version: ${version}`);
  return path.join(root, version);
};

/** <root>/<版>/ が取り終えたもので、pin と同じ中身なら { dir, entry }。違えば null（読み込みはこれだけを通す） */
export function installedSdk(root, pin) {
  const dir = versionDir(root, pin.version);
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    if (mark?.name !== pin.name || mark?.version !== pin.version || mark?.integrity !== pin.integrity) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg?.name !== pin.name || pkg?.version !== pin.version) return null;
    const entry = packageEntry(dir, pkg);
    return fs.statSync(entry).isFile() ? { dir, entry } : null;
  } catch { return null; }
}

/** package.json の exports['.'] の入口（無ければ main）。フォルダーの外を指すものは拒む */
export function packageEntry(dir, pkg) {
  const dot = pkg?.exports?.['.'];
  const rel = typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? pkg?.main ?? 'index.js';
  const entry = path.resolve(dir, String(rel));
  if (!entry.startsWith(path.resolve(dir) + path.sep)) throw new Error(`the package entry points outside: ${rel}`);
  return entry;
}

// ---------------------------------------------------------------- 取得

/** プロキシの env があるか（つながらないときに「プロキシ」と言うか「オフライン」と言うか） */
const proxyConfigured = (env) => PROXY_ENV.some((k) => String(env[k] ?? '').trim());

/** つなぐ先ごとの Agent。https はプロキシの env（HTTPS_PROXY・NO_PROXY。Node 24 の proxyEnv）と、OS の信頼する証明書も使う */
function agentFor(url, env) {
  if (url.protocol === 'http:') return new http.Agent({ keepAlive: false });
  const options = { keepAlive: false, proxyEnv: env };
  // 社内の中継が証明書を差し替えている環境では、OS に入れた証明書でしか確かめられない（中身は integrity で確かめるので、ここは届くかどうかだけ）
  try {
    if (typeof tls.getCACertificates === 'function') options.ca = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
  } catch { /* 取れなければ Node の既定 */ }
  return new https.Agent(options);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** 取りに行ってよい URL か。https だけ。試験の口（ループバック）だけ http を許す */
export function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  return null;
}

/** 通信の失敗を kind に分ける */
export function classifyNetworkError(err, env = process.env) {
  if (err instanceof ClaudeSdkFetchError) return err;
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? err);
  if (/proxy/i.test(code) || /proxy/i.test(message)) return fail('proxy', message, err);
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS/i.test(code)) return fail('tls', message, err);
  if (OFFLINE_CODES.has(code) || /timed? ?out/i.test(message)) return fail(proxyConfigured(env) ? 'proxy' : 'offline', message, err);
  return fail('offline', message, err);
}

/**
 * tarball を受け取る（メモリに。上限 maxBytes）。onProgress({ received, total }) は受け取るたびに呼ぶ（total は content-length。無ければ null）。
 * signal で止められる。リダイレクトは https のまま MAX_REDIRECTS 回まで
 */
export function downloadTarball(raw, { onProgress = () => {}, signal = null, env = process.env, maxBytes = MAX_TARBALL, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); err ? reject(err) : resolve(value); };
    let req = null;
    const onAbort = () => { req?.destroy(); done(fail('aborted', 'cancelled')); };
    if (signal?.aborted) return done(fail('aborted', 'cancelled'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const get = (current, left) => {
      const url = allowedUrl(current);
      if (!url) return done(fail('http', `refused URL: ${String(current).slice(0, 200)}`));
      const lib = url.protocol === 'http:' ? http : https;
      req = lib.get(url, { agent: agentFor(url, env), headers: { 'user-agent': 'Pleiad (claude-agent-sdk fetch)', accept: 'application/octet-stream' } }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (left <= 0) return done(fail('http', 'too many redirects'));
          return get(new URL(res.headers.location, url).href, left - 1);
        }
        if (status === 407) { res.resume(); return done(fail('proxy', 'HTTP 407 Proxy Authentication Required')); }
        if (status !== 200) { res.resume(); return done(fail('http', `HTTP ${status}`)); }
        const length = Number(res.headers['content-length']);
        const total = Number.isFinite(length) && length > 0 ? length : null;
        if (total && total > maxBytes) { res.resume(); return done(fail('http', `the tarball is too large (${total} bytes)`)); }
        const chunks = [];
        let received = 0;
        onProgress({ received, total });
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) { req.destroy(); return done(fail('http', `the tarball is too large (over ${maxBytes} bytes)`)); }
          chunks.push(chunk);
          onProgress({ received, total });
        });
        res.on('end', () => {
          if (total && received !== total) return done(fail('offline', `the download ended early (${received} of ${total} bytes)`));
          done(null, Buffer.concat(chunks, received));
        });
        res.on('error', (err) => done(classifyNetworkError(err, env)));
        res.on('aborted', () => done(fail('offline', 'the connection was closed during the download')));
      });
      req.setTimeout(idleTimeoutMs, () => req.destroy(Object.assign(new Error(`no data for ${Math.round(idleTimeoutMs / 1000)}s`), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => done(classifyNetworkError(err, env)));
    };
    get(raw, MAX_REDIRECTS);
  });
}

/** npm の integrity（sha512-<base64>）と中身が合うか。合わなければ integrity の失敗を投げる */
export function verifyIntegrity(buffer, integrity) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity));
  if (!m) throw fail('integrity', 'the expected integrity is not sha512');
  const actual = crypto.createHash('sha512').update(buffer).digest('base64');
  const expected = Buffer.from(m[1], 'base64');
  const got = Buffer.from(actual, 'base64');
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) throw fail('integrity', `sha512-${actual} does not match ${integrity}`);
}

// ---------------------------------------------------------------- tar

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * tarball の中のパス（先頭のフォルダー package/ を剥がす前）を、展開先からの相対パス（/ 区切り）にする。拒むものは extract の失敗を投げる:
 * 絶対パス・ドライブ（C:）・\ を含む・NUL・..・Windows の予約名・末尾の . と空白。先頭のフォルダーだけのもの（package/ 自身）は null
 */
export function safeEntryPath(name) {
  const raw = String(name);
  if (!raw || raw.includes('\0')) throw fail('extract', 'an entry has an empty name or NUL');
  if (raw.includes('\\') || raw.includes(':')) throw fail('extract', `an entry name has \\ or : (${raw.slice(0, 200)})`);
  if (raw.startsWith('/')) throw fail('extract', `an entry has an absolute path (${raw.slice(0, 200)})`);
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw fail('extract', `an entry leaves the destination (${raw.slice(0, 200)})`);
  const rest = parts.slice(1);   // npm と同じく、先頭のフォルダー（package/）を剥がす
  if (!rest.length) return null;
  for (const p of rest) {
    if (WINDOWS_RESERVED.test(p) || /[. ]$/.test(p) || /[<>"|?*\x00-\x1f]/.test(p)) throw fail('extract', `an entry has a name that cannot be written safely (${raw.slice(0, 200)})`);
  }
  return rest.join('/');
}

const text = (buf, from, len) => { const s = buf.subarray(from, from + len); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
function octal(buf, from, len) {
  const field = buf.subarray(from, from + len);
  if (field[0] & 0x80) {   // GNU の 256 進（大きいファイル）
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const s = text(buf, from, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw fail('extract', `a tar header has a bad number (${s.slice(0, 20)})`);
  return parseInt(s, 8);
}
function checksumOk(block) {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  return sum === stored;
}
function paxRecords(body) {
  const out = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(body.subarray(i, sp).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) throw fail('extract', 'a pax header is malformed');
    const record = body.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * tar（gunzip 済み）を読んで [{ path, type: 'file'|'dir', data }] を返す。書く前に全体を確かめる（途中まで書いてから拒むことが無い）。
 * 普通のファイル・フォルダー・pax（x・g）・GNU の長い名前（L）だけを受ける。シンボリックリンク・ハードリンク・デバイスなどは拒む
 */
export function readTar(tar, { maxUnpacked = MAX_UNPACKED } = {}) {
  const entries = [];
  let offset = 0, pax = {}, longName = null, unpacked = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;   // 終わりの印（0 のブロック）
    if (!checksumOk(block)) throw fail('extract', `a tar header has a bad checksum at ${offset}`);
    const type = String.fromCharCode(block[156] || 48);
    const size = pax.size !== undefined ? Number(pax.size) : octal(block, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw fail('extract', 'a tar entry has a bad size');
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw fail('extract', 'the tar ends inside an entry');
    const body = tar.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = paxRecords(body); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(body, 0, body.length); continue; }
    const prefix = text(block, 345, 155);
    const name = pax.path ?? longName ?? (text(block, 257, 6).startsWith('ustar') && prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    pax = {}; longName = null;
    if (type === '1' || type === '2') throw fail('extract', `the tarball has a link (${name.slice(0, 200)})`);
    if (type !== '0' && type !== '7' && type !== '5') throw fail('extract', `the tarball has an unsupported entry type ${JSON.stringify(type)} (${name.slice(0, 200)})`);
    const rel = safeEntryPath(name);
    if (entries.length >= MAX_ENTRIES) throw fail('extract', 'the tarball has too many entries');
    if (rel == null) continue;
    unpacked += size;
    if (unpacked > maxUnpacked) throw fail('extract', 'the tarball unpacks too large');
    entries.push({ path: rel, type: type === '5' ? 'dir' : 'file', data: type === '5' ? null : body });
  }
  // 同じパスが 2 度出る・ファイルの下にファイルを置く、は npm の tarball では起きない。起きたら拒む（上書きの順で中身が変わる）
  const seen = new Map();
  for (const e of entries) {
    const key = e.path.toLowerCase();
    if (seen.has(key) && !(seen.get(key) === 'dir' && e.type === 'dir')) throw fail('extract', `the tarball has the same path twice (${e.path.slice(0, 200)})`);
    seen.set(key, e.type);
  }
  for (const e of entries) {
    const parts = e.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (seen.get(parts.slice(0, i).join('/')) === 'file') throw fail('extract', `the tarball puts a file under a file (${e.path.slice(0, 200)})`);
  }
  return entries;
}

/** 確かめた一覧を dest（空のフォルダー）へ書く。書く先が dest の外に出ないことをもう一度確かめる */
export async function writeEntries(entries, dest) {
  const base = path.resolve(dest);
  const inside = (rel) => {
    const target = path.resolve(base, ...rel.split('/'));
    if (!target.startsWith(base + path.sep)) throw fail('extract', `an entry leaves the destination (${rel.slice(0, 200)})`);
    return target;
  };
  for (const e of entries) {
    const target = inside(e.path);
    if (e.type === 'dir') { await fs.promises.mkdir(target, { recursive: true }); continue; }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    // 実行の印は付けない（SDK は JS だけ。CLI の実行ファイルは別の optional の包みで、取らない）
    await fs.promises.writeFile(target, e.data, { mode: 0o644, flag: 'wx' });
  }
}

/** gunzip して読む。上限を超える中身は展開しない */
export function unpackTarball(gz, { maxUnpacked = MAX_UNPACKED } = {}) {
  let tar;
  try { tar = zlib.gunzipSync(gz, { maxOutputLength: maxUnpacked + 1024 * 1024 }); }
  catch (err) { throw fail('extract', `the tarball is not gzip: ${err.message}`, err); }
  return readTar(tar, { maxUnpacked });
}

// ---------------------------------------------------------------- 置き場へ置く

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Windows は書いた直後のフォルダーの名前替えが、ウイルス対策の読みで EPERM・EBUSY になることがある。少し待って何度か試す */
async function renameDir(from, to, { tries = 20 } = {}) {
  for (let i = 0; ; i++) {
    try { return await fs.promises.rename(from, to); }
    catch (err) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      await sleep(Math.min(50 * (i + 1), 500));
    }
  }
}

/**
 * pin の版を root に置く。もう置いてあれば何もしない。{ dir, entry, fetched } を返す。
 *   download(url, { onProgress, signal }) は試験が差し替える（既定は downloadTarball）
 * 手順: 受け取る → integrity → 全体を読んで確かめる → <root>/.tmp-… に書く → package.json の名前と版を確かめる → 印を書く → <版>/ へ名前を替える。
 * どこで落ちても、印の無い .tmp-… が残るだけで、使われない（片付けが消す）
 */
export async function installSdk({ root, pin, registry = null, onProgress = () => {}, signal = null, env = process.env, download = downloadTarball, now = () => Date.now() }) {
  checkPin(pin);
  const have = installedSdk(root, pin);
  if (have) return { ...have, fetched: false };
  // 試験の口: レジストリの origin だけを差し替える（パスは pin の tarball のまま）
  const url = registry ? new URL(new URL(pin.tarball).pathname, registry).href : pin.tarball;
  const gz = await download(url, { onProgress, signal, env });
  verifyIntegrity(gz, pin.integrity);
  const entries = unpackTarball(gz);
  const pkgEntry = entries.find((e) => e.path === 'package.json' && e.type === 'file');
  let pkg;
  try { pkg = JSON.parse(pkgEntry.data.toString('utf8')); } catch { throw fail('extract', 'the tarball has no readable package.json'); }
  if (pkg?.name !== pin.name || pkg?.version !== pin.version) throw fail('extract', `the tarball is ${pkg?.name}@${pkg?.version}, expected ${pin.name}@${pin.version}`);
  if (signal?.aborted) throw fail('aborted', 'cancelled');

  try { await fs.promises.mkdir(root, { recursive: true }); }
  catch (err) { throw fail('disk', err.message, err); }
  let tmp = null;
  try {
    tmp = await fs.promises.mkdtemp(path.join(root, `${TMP_PREFIX}${pin.version}-`));
    await writeEntries(entries, tmp);
    packageEntry(tmp, pkg);
    // 印は最後に書く（印があるフォルダーは、中身が全部そろっている）
    await fs.promises.writeFile(path.join(tmp, MARKER), JSON.stringify({ name: pin.name, version: pin.version, integrity: pin.integrity, installedAt: now() }));
    const dest = versionDir(root, pin.version);
    try { await renameDir(tmp, dest); tmp = null; }
    catch (err) {
      // ほかのプロセスが先に置いた（同じ中身）ならそれを使う。印の無い・違う中身のフォルダーが居座っていれば、消して置き直す
      if (installedSdk(root, pin)) return { ...installedSdk(root, pin), fetched: true };
      if (!fs.existsSync(dest)) throw err;
      await fs.promises.rm(dest, { recursive: true, force: true });
      await renameDir(tmp, dest); tmp = null;
    }
  } catch (err) {
    if (err instanceof ClaudeSdkFetchError) throw err;
    throw fail('disk', err?.message ?? String(err), err);
  } finally {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  const got = installedSdk(root, pin);
  if (!got) throw fail('disk', 'the installed copy could not be read back');
  return { ...got, fetched: true };
}

/** 読み込んだ印（片付けで、直前まで使っていた版を残すため）。書けなくても読み込みは止めない */
export function markUsed(dir, now = Date.now()) {
  try { fs.writeFileSync(path.join(dir, USED), String(now)); } catch { /* 読み取り専用の置き場など。片付けが印の時刻で判断できないだけ */ }
}

const usedAt = (dir) => {
  for (const name of [USED, MARKER]) {
    try { return fs.statSync(path.join(dir, name)).mtimeMs; } catch { /* 次を見る */ }
  }
  return 0;
};

/**
 * 古い版を片付ける。残すのは pin の版と、それ以外で最後に使った 1 つ（前の版の Pleiad で起こし直す・戻すときのため）。
 * 展開の途中（.tmp-…）は STALE_TMP_MS より古いものだけ消す。消したフォルダー名を返す
 */
export async function cleanupSdk({ root, pin, keepPrevious = 1, now = () => Date.now() }) {
  let names;
  try { names = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  const versions = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const full = path.join(root, d.name);
    if (d.name.startsWith(TMP_PREFIX)) {
      let age = 0;
      try { age = now() - (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
      if (age > STALE_TMP_MS) { await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {}); removed.push(d.name); }
      continue;
    }
    if (!VERSION_RE.test(d.name) || d.name === pin.version) continue;
    versions.push({ name: d.name, full, at: usedAt(full) });
  }
  versions.sort((a, b) => b.at - a.at);
  for (const v of versions.slice(keepPrevious)) {
    await fs.promises.rm(v.full, { recursive: true, force: true }).catch(() => {});
    removed.push(v.name);
  }
  return removed;
}
