// Claude Agent SDK を配布物に入れず、npm のレジストリから取って読む（ADR 0206。core/claude-sdk-install.mjs・core/claude-sdk.mjs・core/claude-sdk-fetch.mjs）。
// 本物のレジストリにはつながない（tarball は手で組み、レジストリはループバックの偽物）:
//   - integrity: 合わない tarball は捨てる（置き場に何も残らない）
//   - 外へ出るパス: ..・絶対パス・ドライブ・\・予約名・pax と GNU の長い名前・シンボリックリンク・ハードリンク・デバイスを拒む（書く前に全体で）
//   - 途中で止まった: 受け取りが切れた・止めた・壊れた gzip・印の無い版のフォルダーと展開の途中の残り（使わず、置き直す・片付けが消す）
//   - オフライン: 閉じたポート・404・407・http への転送・通信の失敗の分け方
//   - 版の切り替え: 新しい版を置いても古い版は読める・片付けは固定の版と最後に使った 1 つを残す
//   - peer 依存: 置き場の SDK が import する zod・MCP SDK は、置き場の上の node_modules（偽物）ではなくアプリのものに解決する
//   - 本物の SDK の import は Node の組み込みとアプリの dependencies だけ（配布物に無いものを読まない）
//   - どちらから読むか（local / download）・同意が無ければ取らない・取得の失敗の文・切り替えの前に取るスクリプト
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MARKER, USED, TMP_PREFIX, STALE_TMP_MS, ClaudeSdkFetchError, checkPin, installedSdk, packageEntry, allowedUrl, classifyNetworkError,
  downloadTarball, verifyIntegrity, safeEntryPath, readTar, writeEntries, unpackTarball, installSdk, cleanupSdk,
} from '../../core/claude-sdk-install.mjs';
import {
  CLAUDE_SDK_PIN, claudeSdkRoot, claudeSdkSource, claudeSdkStatus, claudeSdkConsent, ensureClaudeSdk, loadClaudeSdk, importInstalledSdk,
  isClaudeSdkMissing, onClaudeSdkChange, resetClaudeSdkForTest,
} from '../../core/claude-sdk.mjs';
import { LEGACY_CHECK_FILE } from '../../core/claude-sdk-legacy.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_NAME = '@anthropic-ai/claude-agent-sdk';

export const name = 'claude-sdk';
export const title = 'Claude Agent SDK の取得: integrity・外へ出るパス・途中で止まった展開・オフライン・版の切り替え・peer 依存の解決・同意';

// ---------------------------------------------------------------- tarball を手で組む

function tarHeader(name, { type = '0', size = 0, linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  if (linkname) h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
/** entries: [{ name, type?, data?, linkname? }] → tar（gzip 前） */
function tarOf(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.data == null ? Buffer.alloc(0) : Buffer.from(e.data);
    parts.push(tarHeader(e.name, { type: e.type ?? '0', size: data.length, linkname: e.linkname }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const tgz = (entries) => zlib.gzipSync(tarOf(entries));
const integrityOf = (buf) => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
/** pax の 1 行（長さは行全体のバイト数） */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len++;
  return `${len}${body}`;
}
/** npm の tarball と同じ形（package/ の下）の偽の SDK */
function fakePackage(version, files = {}) {
  return [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', data: JSON.stringify({ name: PIN_NAME, version, type: 'module', exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } } }) },
    { name: 'package/sdk.mjs', data: files['sdk.mjs'] ?? `export const version = ${JSON.stringify(version)};\n` },
    ...Object.entries(files).filter(([k]) => k !== 'sdk.mjs').map(([k, v]) => ({ name: `package/${k}`, data: v })),
  ];
}
const fakePin = (version, gz) => ({ name: PIN_NAME, version, integrity: integrityOf(gz), tarball: `https://registry.npmjs.org/${PIN_NAME}/-/claude-agent-sdk-${version}.tgz` });

const kindOf = async (fn) => { try { await fn(); return 'none'; } catch (err) { return err instanceof ClaudeSdkFetchError ? err.kind : `other: ${err?.message ?? err}`; } };
const kindOfSync = (fn) => { try { fn(); return 'none'; } catch (err) { return err instanceof ClaudeSdkFetchError ? err.kind : `other: ${err?.message ?? err}`; } };
const list = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
/** 置き場に、取った SDK（版のフォルダー・展開の途中）か同意が置かれているか。「前から使っていたか」の判断の印（legacy-check.json）だけは数えない */
const hasSdkFiles = (root) => list(root).some((f) => f !== LEGACY_CHECK_FILE);

/** ループバックの偽のレジストリ。handler(req, res) を差し替えられる。requests に来たパスを残す */
async function fakeRegistry(handler) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { base, requests, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export default async function (t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-claude-sdk-'));
  try {
    await run(t, tmp);
  } finally {
    resetClaudeSdkForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run(t, tmp) {
  let n = 0;
  const freshRoot = () => path.join(tmp, `root-${++n}`, 'claude-sdk');

  // ---------------------------------------------------------------- pin の形
  const goodGz = tgz(fakePackage('1.0.0'));
  const pinA = fakePin('1.0.0', goodGz);
  t.ok('pin: 形の合うものを通す', checkPin(pinA) === pinA);
  const badPin = (patch) => { try { checkPin({ ...pinA, ...patch }); return false; } catch { return true; } };
  t.ok('pin: 名前が違う・版がパスになる・sha1・http の tarball は拒む',
    badPin({ name: '@anthropic-ai/sdk' }) && badPin({ version: '../1.0.0' }) && badPin({ version: '1.0.0/..' }) && badPin({ integrity: 'sha1-abc=' }) && badPin({ tarball: 'http://registry.npmjs.org/x.tgz' }));

  // ---------------------------------------------------------------- integrity
  t.ok('integrity: 合えば通る', kindOfSync(() => verifyIntegrity(goodGz, pinA.integrity)) === 'none');
  t.ok('integrity: 1 バイト違えば integrity の失敗', kindOfSync(() => verifyIntegrity(Buffer.concat([goodGz, Buffer.from([0])]), pinA.integrity)) === 'integrity');
  t.ok('integrity: sha512 でない期待値は integrity の失敗', kindOfSync(() => verifyIntegrity(goodGz, 'sha1-abcd')) === 'integrity');
  {
    const root = freshRoot();
    const other = tgz(fakePackage('1.0.0', { 'sdk.mjs': 'export const version = "tampered";\n' }));
    const kind = await kindOf(() => installSdk({ root, pin: pinA, download: async () => other }));
    t.ok('integrity: 違う tarball は置かない（置き場に版のフォルダーも展開の途中も残らない）', kind === 'integrity' && list(root).length === 0, `${kind} ${list(root)}`);
    t.ok('integrity: 置かなかったので読めない', installedSdk(root, pinA) === null);
  }

  // ---------------------------------------------------------------- 外へ出るパス・リンク
  const escapes = ['../evil.js', 'package/../../evil.js', '/etc/evil.js', 'C:/evil.js', 'package/C:evil.js', 'package\\..\\..\\evil.js',
    'package/con', 'package/aux.js', 'package/lib/nul.txt', 'package/evil.', 'package/evil ', 'package/a|b', ''];
  const notRejected = escapes.filter((name) => kindOfSync(() => safeEntryPath(name)) !== 'extract');
  t.ok('パス: ..・絶対パス・ドライブ・\\・Windows の予約名・末尾の . と空白・使えない文字・空は拒む', notRejected.length === 0, JSON.stringify(notRejected));
  t.ok('パス: package/ を剥がして / 区切りで返す。package/ 自身は null',
    safeEntryPath('package/lib/a.mjs') === 'lib/a.mjs' && safeEntryPath('./package/./b.mjs') === 'b.mjs' && safeEntryPath('package/') === null);

  const withEntry = (extra) => tarOf([...fakePackage('1.0.0'), ...extra]);
  const tarKind = (extra) => kindOfSync(() => readTar(withEntry(extra)));
  t.ok('tar: 外へ出るパスの入ったものは全体を拒む', tarKind([{ name: 'package/../../evil.js', data: 'x' }]) === 'extract');
  t.ok('tar: シンボリックリンクを拒む', tarKind([{ name: 'package/link', type: '2', linkname: '../../../etc/passwd' }]) === 'extract');
  t.ok('tar: ハードリンクを拒む', tarKind([{ name: 'package/hard', type: '1', linkname: 'package/sdk.mjs' }]) === 'extract');
  t.ok('tar: デバイス・FIFO を拒む', tarKind([{ name: 'package/dev', type: '3' }]) === 'extract' && tarKind([{ name: 'package/fifo', type: '6' }]) === 'extract');
  t.ok('tar: pax の path で外へ出るものを拒む', tarKind([{ name: 'PaxHeader/x', type: 'x', data: paxRecord('path', 'package/../../evil.js') }, { name: 'package/harmless.js', data: 'x' }]) === 'extract');
  t.ok('tar: GNU の長い名前で外へ出るものを拒む', tarKind([{ name: '././@LongLink', type: 'L', data: `package/${'a'.repeat(120)}/../../../evil.js\0` }, { name: 'package/x', data: 'x' }]) === 'extract');
  t.ok('tar: 同じパスが 2 度（大小違い）・ファイルの下のファイルを拒む',
    tarKind([{ name: 'package/SDK.mjs', data: 'x' }]) === 'extract' && tarKind([{ name: 'package/sdk.mjs/inner.js', data: 'x' }]) === 'extract');
  {
    const bad = Buffer.from(withEntry([]));
    bad[0] ^= 1;   // 先頭のヘッダーの名前を変え、チェックサムを合わなくする
    t.ok('tar: チェックサムの合わないヘッダーを拒む', kindOfSync(() => readTar(bad)) === 'extract');
  }
  t.ok('tar: 展開の上限を超えるものを拒む', kindOfSync(() => readTar(withEntry([{ name: 'package/big.bin', data: Buffer.alloc(4096) }]), { maxUnpacked: 1024 })) === 'extract');
  {
    const entries = readTar(withEntry([{ name: 'PaxHeader/x', type: 'x', data: paxRecord('path', 'package/lib/long-name.mjs') }, { name: 'package/short', data: 'pax' }]));
    t.ok('tar: pax の path で名前を付けたものは読める', entries.some((e) => e.path === 'lib/long-name.mjs' && e.data.toString() === 'pax'), JSON.stringify(entries.map((e) => e.path)));
  }
  {
    const dest = path.join(tmp, 'write-guard');
    fs.mkdirSync(dest);
    const kind = await kindOf(() => writeEntries([{ path: '../outside.js', type: 'file', data: Buffer.from('x') }], dest));
    t.ok('書く側でも、展開先の外へは書かない（読む側を抜けたとき用）', kind === 'extract' && !fs.existsSync(path.join(tmp, 'outside.js')));
  }
  {
    const root = freshRoot();
    const gz = tgz([...fakePackage('1.0.0'), { name: 'package/../../../escaped.js', data: 'x' }]);
    const kind = await kindOf(() => installSdk({ root, pin: fakePin('1.0.0', gz), download: async () => gz }));
    t.ok('置く: 外へ出る tarball は integrity が合っていても置かない（何も書かない）',
      kind === 'extract' && list(root).length === 0 && !fs.existsSync(path.join(path.dirname(root), 'escaped.js')) && !fs.existsSync(path.join(tmp, 'escaped.js')), `${kind} ${list(root)}`);
  }
  {
    const root = freshRoot();
    const gz = tgz(fakePackage('1.0.1'));
    const kind = await kindOf(() => installSdk({ root, pin: { ...fakePin('1.0.1', gz), version: '1.0.2' }, download: async () => gz }));
    t.ok('置く: 中身の package.json の版が pin と違えば置かない', kind === 'extract' && list(root).length === 0, kind);
  }
  t.ok('入口: exports が置き場の外を指せば拒む', (() => { try { packageEntry(tmp, { exports: { '.': '../../evil.mjs' } }); return false; } catch { return true; } })());
  t.ok('URL: https とループバックの http だけ。ほかの http・資格情報付き・file は拒む',
    allowedUrl('https://registry.npmjs.org/x.tgz') && allowedUrl('http://127.0.0.1:1/x.tgz') && allowedUrl('http://localhost:1/x.tgz')
    && !allowedUrl('http://registry.npmjs.org/x.tgz') && !allowedUrl('https://u:p@registry.npmjs.org/x.tgz') && !allowedUrl('file:///etc/passwd') && !allowedUrl('not a url'));

  // ---------------------------------------------------------------- 置く（成功）・進み
  {
    const root = freshRoot();
    const reg = await fakeRegistry((req, res) => { res.writeHead(200, { 'content-length': goodGz.length }); res.end(goodGz); });
    try {
      const progress = [];
      const got = await installSdk({ root, pin: pinA, registry: reg.base, env: {}, onProgress: (p) => progress.push(p) });
      const last = progress.at(-1);
      t.ok('置く: レジストリの origin だけ差し替え、パスは pin の tarball のまま', reg.requests[0] === new URL(pinA.tarball).pathname, reg.requests.join(' '));
      t.ok('置く: 進みは受け取ったバイト数と全体', last?.received === goodGz.length && last?.total === goodGz.length, JSON.stringify(last));
      t.ok('置く: <root>/<版>/ に置き、印を書く。展開の途中は残らない',
        got.fetched === true && got.dir === path.join(root, '1.0.0') && fs.existsSync(path.join(got.dir, MARKER)) && list(root).join() === '1.0.0', list(root).join());
      t.ok('置く: 入口は exports の default', got.entry === path.join(root, '1.0.0', 'sdk.mjs'));
      const again = await installSdk({ root, pin: pinA, registry: reg.base, env: {} });
      t.ok('置く: もう置いてあれば取りに行かない', again.fetched === false && reg.requests.length === 1);
    } finally { await reg.close(); }
  }

  // ---------------------------------------------------------------- 途中で止まった
  {
    const root = freshRoot();
    const reg = await fakeRegistry((req, res) => { res.writeHead(200, { 'content-length': 100_000 }); res.write(Buffer.alloc(1000)); setTimeout(() => res.socket.destroy(), 20); });
    try {
      const kind = await kindOf(() => installSdk({ root, pin: pinA, registry: reg.base, env: {} }));
      t.ok('途中で止まった: 受け取りの途中で切れたらオフライン。何も置かない', kind === 'offline' && list(root).length === 0, `${kind} ${list(root)}`);
    } finally { await reg.close(); }
  }
  {
    const root = freshRoot();
    const reg = await fakeRegistry((req, res) => { res.writeHead(200, { 'content-length': 100_000 }); res.write(Buffer.alloc(1000)); });
    const ac = new AbortController();
    try {
      const kind = await kindOf(() => installSdk({ root, pin: pinA, registry: reg.base, env: {}, signal: ac.signal, onProgress: (p) => { if (p.received > 0) ac.abort(); } }));
      t.ok('途中で止まった: 受け取りの途中で止めたら aborted。何も置かない', kind === 'aborted' && list(root).length === 0, `${kind} ${list(root)}`);
    } finally { await reg.close(); }
  }
  {
    const root = freshRoot();
    const cut = goodGz.subarray(0, Math.floor(goodGz.length / 2));
    const kind = await kindOf(() => installSdk({ root, pin: fakePin('1.0.0', cut), download: async () => cut }));
    t.ok('途中で止まった: 途中で切れた gzip（integrity は合う）は展開の失敗。何も置かない', kind === 'extract' && list(root).length === 0, `${kind} ${list(root)}`);
    t.ok('途中で止まった: gzip でないものは展開の失敗', kindOfSync(() => unpackTarball(Buffer.from('not gzip'))) === 'extract');
  }
  {
    // 前の取得が落ちた跡: 印の無い版のフォルダー（中身が半分）と、展開の途中のフォルダー
    const root = freshRoot();
    const half = path.join(root, '1.0.0');
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, 'package.json'), JSON.stringify({ name: PIN_NAME, version: '1.0.0', exports: { '.': './sdk.mjs' } }));
    fs.writeFileSync(path.join(half, 'sdk.mjs'), 'export const version = "half";\n');
    const leftover = path.join(root, `${TMP_PREFIX}1.0.0-crashed`);
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'sdk.mjs'), 'export const version = "partial";\n');
    t.ok('途中で止まった: 印の無い版のフォルダーは使わない', installedSdk(root, pinA) === null);
    const got = await installSdk({ root, pin: pinA, download: async () => goodGz });
    t.ok('途中で止まった: 取り直すと、印の無いフォルダーを置き換える',
      got.fetched === true && fs.readFileSync(path.join(half, 'sdk.mjs'), 'utf8').includes('"1.0.0"') && fs.existsSync(path.join(half, MARKER)));
    t.ok('途中で止まった: 展開の途中の残りは、取得では触らない（ほかのプロセスが展開中かもしれない）', fs.existsSync(leftover));
    const keptFresh = await cleanupSdk({ root, pin: pinA });
    t.ok('片付け: 新しい展開の途中は消さない', keptFresh.length === 0 && fs.existsSync(leftover), JSON.stringify(keptFresh));
    const removed = await cleanupSdk({ root, pin: pinA, now: () => Date.now() + STALE_TMP_MS + 60_000 });
    t.ok('片付け: 古い展開の途中は消す。固定の版は残す', removed.includes(path.basename(leftover)) && !fs.existsSync(leftover) && installedSdk(root, pinA) !== null, JSON.stringify(removed));

    const markFile = path.join(half, MARKER);
    const mark = JSON.parse(fs.readFileSync(markFile, 'utf8'));
    fs.writeFileSync(markFile, JSON.stringify({ ...mark, integrity: integrityOf(Buffer.from('other')) }));
    t.ok('印の integrity が pin と違えば（書き換えられた・別の版の中身）使わない', installedSdk(root, pinA) === null);
  }

  // ---------------------------------------------------------------- オフライン・レジストリの失敗
  {
    const port = await closedPort();
    const kind = await kindOf(() => downloadTarball(`http://127.0.0.1:${port}/x.tgz`, { env: {} }));
    t.ok('オフライン: つながらなければ offline', kind === 'offline', kind);
    const root = freshRoot();
    const viaInstall = await kindOf(() => installSdk({ root, pin: pinA, registry: `http://127.0.0.1:${port}/`, env: {} }));
    t.ok('オフライン: 置くときも offline で、何も置かない', viaInstall === 'offline' && list(root).length === 0, viaInstall);
  }
  t.ok('通信の失敗の分け方: 名前が引けない・拒まれた → offline。プロキシの env があれば proxy',
    classifyNetworkError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, {}).kind === 'offline'
    && classifyNetworkError({ code: 'ECONNREFUSED', message: 'refused' }, { HTTPS_PROXY: 'http://proxy.example:8080' }).kind === 'proxy');
  t.ok('通信の失敗の分け方: 証明書を確かめられない → tls',
    classifyNetworkError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', message: 'x' }, {}).kind === 'tls' && classifyNetworkError({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'x' }, {}).kind === 'tls');
  {
    let mode = '404';
    const reg = await fakeRegistry((req, res) => {
      if (mode === '404') { res.writeHead(404); return res.end('not found'); }
      if (mode === '407') { res.writeHead(407); return res.end(); }
      res.writeHead(302, { location: 'http://registry.npmjs.org/evil.tgz' }); res.end();
    });
    try {
      const k404 = await kindOf(() => downloadTarball(`${reg.base}x.tgz`, { env: {} }));
      mode = '407';
      const k407 = await kindOf(() => downloadTarball(`${reg.base}x.tgz`, { env: {} }));
      mode = 'redirect';
      const kRedirect = await kindOf(() => downloadTarball(`${reg.base}x.tgz`, { env: {} }));
      t.ok('レジストリ: 404 は http・407 は proxy・http（ループバック以外）への転送は拒む', k404 === 'http' && k407 === 'proxy' && kRedirect === 'http', `${k404} ${k407} ${kRedirect}`);
    } finally { await reg.close(); }
  }
  {
    const reg = await fakeRegistry((req, res) => { res.writeHead(200, { 'content-length': 5000 }); res.end(Buffer.alloc(5000)); });
    try {
      const kind = await kindOf(() => downloadTarball(`${reg.base}x.tgz`, { env: {}, maxBytes: 1000 }));
      t.ok('レジストリ: 上限より大きい tarball は受け取らない', kind === 'http', kind);
    } finally { await reg.close(); }
  }

  // ---------------------------------------------------------------- 版の切り替え・片付け
  {
    const root = freshRoot();
    const gzOld = tgz(fakePackage('0.9.0'));
    const gzB = tgz(fakePackage('1.1.0'));
    const pinOld = fakePin('0.9.0', gzOld);
    const pinB = fakePin('1.1.0', gzB);
    await installSdk({ root, pin: pinOld, download: async () => gzOld });
    const a = await installSdk({ root, pin: pinA, download: async () => goodGz });
    const apiA = await importInstalledSdk(a.entry, root);
    const b = await installSdk({ root, pin: pinB, download: async () => gzB });
    t.ok('版の切り替え: 新しい版を置いても、古い版はそのまま読める（走っている古いサーバーを止めない）',
      installedSdk(root, pinA)?.dir === a.dir && installedSdk(root, pinB)?.dir === b.dir && apiA.version === '1.0.0');
    const apiB = await importInstalledSdk(b.entry, root);
    t.ok('版の切り替え: 1 つのプロセスで別の版を読める（版ごとのフォルダー）', apiB.version === '1.1.0');

    const ago = (s) => new Date(Date.now() - s * 1000);
    fs.writeFileSync(path.join(root, '0.9.0', USED), '1'); fs.utimesSync(path.join(root, '0.9.0', USED), ago(3000), ago(3000));
    fs.writeFileSync(path.join(root, '1.0.0', USED), '1'); fs.utimesSync(path.join(root, '1.0.0', USED), ago(1000), ago(1000));
    fs.writeFileSync(path.join(root, 'consent.json'), '{"acceptedAt":"x"}');
    fs.mkdirSync(path.join(root, 'notes'));
    const removed = await cleanupSdk({ root, pin: pinB });
    t.ok('片付け: 固定の版と、最後に使ったもう 1 つの版を残し、それより古い版を消す',
      JSON.stringify(removed) === '["0.9.0"]' && list(root).join() === '1.0.0,1.1.0,consent.json,notes', `${JSON.stringify(removed)} ${list(root)}`);
    const removed2 = await cleanupSdk({ root, pin: pinB, keepPrevious: 0 });
    t.ok('片付け: keepPrevious: 0 なら固定の版だけ残す（同意と版でないフォルダーは触らない）', JSON.stringify(removed2) === '["1.0.0"]' && list(root).join() === '1.1.0,consent.json,notes');
    t.ok('片付け: 置き場が無くても落ちない', (await cleanupSdk({ root: path.join(tmp, 'nothing-here'), pin: pinB })).length === 0);
  }

  // ---------------------------------------------------------------- peer 依存はアプリのものに解決する
  {
    const base = path.join(tmp, 'peer');
    const root = path.join(base, 'claude-sdk');
    // 置き場の上の node_modules に偽物を置く（Node の普通の解決なら、こちらを拾う）
    const decoy = (dir, pkg, files) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), s);
    };
    decoy(path.join(base, 'node_modules', 'zod'), { name: 'zod', type: 'module', exports: { './v4': './v4.mjs' } }, { 'v4.mjs': 'export const decoy = true;\n' });
    decoy(path.join(base, 'node_modules', '@modelcontextprotocol', 'sdk'), { name: '@modelcontextprotocol/sdk', type: 'module', exports: { './server/mcp.js': './mcp.js' } },
      { 'mcp.js': 'export const McpServer = "decoy";\n' });
    fs.mkdirSync(path.join(base, 'probe'));
    fs.writeFileSync(path.join(base, 'probe', 'probe.mjs'), "export { decoy } from 'zod/v4';\nexport { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n");
    const probe = await import(pathToFileURL(path.join(base, 'probe', 'probe.mjs')).href);
    t.ok('peer: （前提）置き場の外から普通に解決すると偽物を拾う', probe.decoy === true && probe.McpServer === 'decoy');

    const sdkSource = [
      "import * as z from 'zod/v4';",
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { createHash } from 'node:crypto';",
      "import * as local from './lib/local.mjs';",
      'export { z, McpServer, createHash, local };',
    ].join('\n');
    const gz = tgz(fakePackage('2.0.0', { 'sdk.mjs': sdkSource, 'lib/local.mjs': 'export const ok = true;\n' }));
    const got = await installSdk({ root, pin: fakePin('2.0.0', gz), download: async () => gz });
    const api = await importInstalledSdk(got.entry, root);
    const appZod = await import('zod/v4');
    const appMcp = await import('@modelcontextprotocol/sdk/server/mcp.js');
    t.ok('peer: 置き場の SDK の zod/v4 はアプリの zod（同じモジュール）', api.z === appZod && api.z.decoy === undefined);
    t.ok('peer: 置き場の SDK の MCP SDK はアプリのもの（同じクラス）', api.McpServer === appMcp.McpServer && typeof api.McpServer === 'function');
    t.ok('peer: 組み込み（node:）と置き場の中の相対の import はそのまま', typeof api.createHash === 'function' && api.local.ok === true);
    const probe2 = await import(`${pathToFileURL(path.join(base, 'probe', 'probe.mjs')).href}?again`);
    t.ok('peer: フックは置き場の中だけに効く（外のファイルの解決は変えない）', probe2.decoy === true);
    t.ok('peer: Node 24 の同期のフック（registerHooks）がある', typeof module.registerHooks === 'function', process.version);
  }

  // ---------------------------------------------------------------- 本物の SDK の import
  {
    const sdkDir = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    if (!fs.existsSync(path.join(sdkDir, 'package.json'))) {
      t.ok('本物の SDK: node_modules に無い（npm ci の後に確かめる）', true);
    } else {
      const deps = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies ?? {}));
      const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"'\s]+)["']/g;
      const spec = /^(node:)?(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w./-]+)?$/;
      const pkgOf = (s) => s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
      const bad = [];
      const seen = new Set();
      const walk = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const m of fs.readFileSync(path.join(sdkDir, file), 'utf8').matchAll(re)) {
          const s = m[1];
          if (s.startsWith('./')) { walk(path.posix.normalize(path.posix.join(path.posix.dirname(file), s))); continue; }
          if (!spec.test(s) || module.isBuiltin(s)) continue;
          if (!deps.has(pkgOf(s))) bad.push(`${file}: ${s}`);
        }
      };
      walk('sdk.mjs');
      walk('core.mjs');
      t.ok('本物の SDK: sdk.mjs・core.mjs が読むのは Node の組み込みとアプリの dependencies だけ（配布物にある）', bad.length === 0 && seen.size >= 2, bad.join(', '));
    }
  }

  // ---------------------------------------------------------------- どちらから読むか・同意・取得の失敗（core/claude-sdk.mjs）
  {
    const empty = path.join(tmp, 'app-without-sdk');
    fs.mkdirSync(empty);
    t.ok('読む先: AGENT_HOST_CLAUDE_SDK で強制できる',
      claudeSdkSource({ AGENT_HOST_CLAUDE_SDK: 'local' }, empty) === 'local' && claudeSdkSource({ AGENT_HOST_CLAUDE_SDK: 'download' }, ROOT) === 'download');
    t.ok('読む先: アプリの node_modules に SDK が無ければ download（配布物）', claudeSdkSource({}, empty) === 'download');
    if (fs.existsSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))) {
      t.ok('読む先: アプリの node_modules に SDK があれば local（開発・試験）', claudeSdkSource({}, ROOT) === 'local');
    }
    const data = path.join(tmp, 'data-download');
    const env = { AGENT_HOST_CLAUDE_SDK: 'download', AGENT_HOST_DATA: data };
    const root = claudeSdkRoot(env);
    resetClaudeSdkForTest();
    t.ok('置き場: <データ置き場>/claude-sdk', root === path.join(path.resolve(data), 'claude-sdk'));
    const before = claudeSdkStatus({ env });
    t.ok('状態: 取る前は ready も同意も無い。版は固定の版', before.source === 'download' && before.ready === false && before.consent === false && before.version === CLAUDE_SDK_PIN.version, JSON.stringify(before));
    let missing = null;
    try { await loadClaudeSdk({ fetch: true, env }); } catch (err) { missing = err; }
    t.ok('同意が無ければ取らずに CLAUDE_SDK_MISSING（版を言う文）', isClaudeSdkMissing(missing) && missing.message.includes(CLAUDE_SDK_PIN.version) && !hasSdkFiles(root), missing?.message);
    t.ok('同意が無ければ ensure は consent の失敗', (await kindOf(() => ensureClaudeSdk({ env }))) === 'consent');

    const reg = await fakeRegistry((req, res) => { const body = Buffer.from('this is not the pinned tarball'); res.writeHead(200, { 'content-length': body.length }); res.end(body); });
    const seen = [];
    const off = onClaudeSdkChange((s) => seen.push(s));
    try {
      const env2 = { ...env, AGENT_HOST_CLAUDE_SDK_REGISTRY: reg.base };
      const [k1, k2] = await Promise.all([kindOf(() => ensureClaudeSdk({ consent: true, env: env2 })), kindOf(() => ensureClaudeSdk({ env: env2 }))]);
      t.ok('同意して取る: 同時に 2 回呼んでも取得は 1 本', reg.requests.length === 1 && k1 === 'integrity' && k2 === 'integrity', `${reg.requests.length} ${k1} ${k2}`);
      t.ok('同意して取る: 固定の版の tarball のパスを取りに行く', reg.requests[0] === new URL(CLAUDE_SDK_PIN.tarball).pathname, reg.requests[0]);
      t.ok('同意して取る: 同意を残す（版をまたいで持つ）', claudeSdkConsent(root) === true);
      const after = claudeSdkStatus({ env });
      t.ok('取得の失敗: 状態に kind と、言語の辞書の文が載る', after.ready === false && after.error?.kind === 'integrity' && after.error.message && !after.error.message.startsWith('claudeSdk.'), JSON.stringify(after.error));
      t.ok('取得の失敗: 置き場に版のフォルダーも展開の途中も残らない', list(root).filter((f) => f !== LEGACY_CHECK_FILE).join() === 'consent.json', list(root).join());
      t.ok('状態の知らせ: 取得の始まり（fetching）と終わり（error）を知らせる', seen.some((s) => s.fetching) && seen.at(-1)?.fetching === null && seen.at(-1)?.error?.kind === 'integrity');
      let err = null;
      try { await loadClaudeSdk({ fetch: true, env: env2 }); } catch (e) { err = e; }
      t.ok('会話を始めるときに取れなければ CLAUDE_SDK_MISSING（理由の kind 付き）', isClaudeSdkMissing(err) && err.kind === 'integrity', err?.message);
    } finally { off(); await reg.close(); }

    // 固定の版が置き場にある（偽の中身。印は固定の版）→ download の道で読む
    const dir = path.join(root, CLAUDE_SDK_PIN.version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PIN_NAME, version: CLAUDE_SDK_PIN.version, type: 'module', exports: { '.': { default: './sdk.mjs' } } }));
    fs.writeFileSync(path.join(dir, 'sdk.mjs'), "import * as z from 'zod/v4';\nexport const fake = 'installed';\nexport { z };\n");
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ name: PIN_NAME, version: CLAUDE_SDK_PIN.version, integrity: CLAUDE_SDK_PIN.integrity }));
    resetClaudeSdkForTest();
    const api = await loadClaudeSdk({ env });
    t.ok('download: 置き場の固定の版を読み、peer はアプリのもの', api.fake === 'installed' && api.z === await import('zod/v4'));
    t.ok('download: 読んだ印（片付けで残す版を選ぶ）を書く', fs.existsSync(path.join(dir, USED)));
    t.ok('download: 状態は ready', claudeSdkStatus({ env }).ready === true);
    t.ok('download: 2 度目の読みは同じもの', (await loadClaudeSdk({ env })) === api);
    resetClaudeSdkForTest();

    // ---------------------------------------------------------------- 切り替えの前に取るスクリプト（desktop/switch.cjs の runClaudeSdkFetch → core/claude-sdk-fetch.mjs）
    const { runClaudeSdkFetch } = require('../../desktop/switch.cjs');
    const baseEnv = { ...process.env, AGENT_HOST_CLAUDE_SDK: 'download' };
    delete baseEnv.AGENT_HOST_CLAUDE_SDK_REGISTRY;
    const fetchIn = (dataDir, extra = {}) => runClaudeSdkFetch({ nodeExe: process.execPath, appDir: ROOT, dataDir, env: { ...baseEnv, ...extra }, timeoutMs: 60_000 });
    const noConsent = await fetchIn(path.join(tmp, 'data-fetch-none'));
    t.ok('先取り: 同意が無ければ取らない（ready: false・consent: false）',
      noConsent.fetch === 1 && noConsent.ready === false && noConsent.consent === false && noConsent.version === CLAUDE_SDK_PIN.version && !hasSdkFiles(path.join(tmp, 'data-fetch-none', 'claude-sdk')), JSON.stringify(noConsent));
    const ready = await fetchIn(data);
    t.ok('先取り: もう置いてあれば ready（取りに行かない）', ready.ready === true && ready.consent === true, JSON.stringify(ready));
    const failData = path.join(tmp, 'data-fetch-fail');
    fs.mkdirSync(path.join(failData, 'claude-sdk'), { recursive: true });
    fs.writeFileSync(path.join(failData, 'claude-sdk', 'consent.json'), JSON.stringify({ acceptedAt: new Date().toISOString() }));
    const reg2 = await fakeRegistry((req, res) => { res.writeHead(503); res.end(); });
    try {
      const failed = await fetchIn(failData, { AGENT_HOST_CLAUDE_SDK_REGISTRY: reg2.base });
      t.ok('先取り: 取れなければ ready: false と理由（終了コードは 0。切り替えは止めない）', failed.ready === false && failed.consent === true && failed.kind === 'http' && reg2.requests.length === 1, JSON.stringify(failed));
    } finally { await reg2.close(); }
    const local = await runClaudeSdkFetch({ nodeExe: process.execPath, appDir: ROOT, dataDir: path.join(tmp, 'data-fetch-local'), env: { ...baseEnv, AGENT_HOST_CLAUDE_SDK: 'local' }, timeoutMs: 60_000 });
    t.ok('先取り: local（開発）なら取らずに ready', local.source === 'local' && local.ready === true, JSON.stringify(local));
  }
}
