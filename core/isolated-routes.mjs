// 隔離の origin の中身（ADR 0292 の 3）。資格を持たない（Cookie を見ない）。URL の中の推し量れない鍵だけで読ませる。
//   - /viz/<束のハッシュ>/<相対パス>: 可視化の束（core/viz-bundle.mjs の viz-blobs/）。入口の HTML は ?embed= のとき会話の枠と同じ包み
//     （基礎のスタイル・高さの知らせ）で返す。?once=<印> は「一度だけ読み込む」の出どころ（10 分。createOnceTokens）
//   - /f/<鍵>/<相対パス>: HTML のファイル（core/html-keys.mjs）。鍵のフォルダーの下だけ。読むたびに ADR 0050 の検査をかける
// 応答のヘッダーの CSP（sandbox を含む）は応答ごとに設定から作る（core/preview-policy.mjs）。枠の中の HTML には、
// 止めた出どころを親へ伝える橋とリンクの橋を、サーバーが頭に差し込む（枠の中で開いたときだけ。Sec-Fetch-Dest で見分ける）。
// sandbox に allow-same-origin が無いと localStorage が例外を投げるので、HTML にはいつもメモリーの代わり（STORAGE_SHIM）も差し込む。
import fs from 'node:fs/promises';
import path from 'node:path';
import { sendStatus } from './page-listener.mjs';
import { inspectFile, readBounded } from './file-preview.mjs';
import { blobPath, readManifest, sweepVizBlobs, isHash } from './viz-bundle.mjs';
import { HTML_SANDBOX, VIZ_SANDBOX, createOnceTokens, isolatedHeaders, previewPolicy } from './preview-policy.mjs';
import { LINK_BRIDGE, STORAGE_SHIM, VIOLATION_BRIDGE, visualizationDocument } from '../web/visualize-document.mjs';

// 上限は Pleiad のページ（ADR 0292 の 2 の 1）と同じ: 文字は 8 MiB、ほかは 32 MiB
const TEXT_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 32 * 1024 * 1024;
const MANIFEST_CACHE = 64;

const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.geojson': 'application/geo+json', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};
const TEXT_TYPES = /^(text\/|application\/(json|geo\+json|manifest\+json|xml)$|image\/svg\+xml$)/;
const typeOf = name => TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
const isHtml = name => /\.html?$/i.test(name);

/** URL のパスの残り（/viz/<ハッシュ>/ の後ろ）を相対パスの部分に分ける。`..`・`.`・空・区切りの混じり・NUL は断る（null） */
export function relativeSegments(rest) {
  const parts = [];
  for (const raw of rest) {
    let part;
    try { part = decodeURIComponent(raw); } catch { return null; }
    if (!part || part === '.' || part === '..' || /[\\/\u0000]/.test(part) || /^[a-z]:$/i.test(part)) return null;
    parts.push(part);
  }
  return parts;
}

/** HTML の文字コードを決める。UTF-8 として読めれば utf-8、そうでなければ文書の meta charset（あれば）。差し込む橋で 1024 バイトの先読みから外れても化けないように */
function htmlCharset(body) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(body); return 'utf-8'; } catch {}
  const head = body.subarray(0, 4096).toString('latin1');
  const match = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(head);
  return match ? match[1] : null;
}

/**
 * 文書の頭（doctype の後ろ）へ差し込む。doctype より前に置くと互換モードになる。
 * 保存庫の代わり（STORAGE_SHIM）はいつも、橋は枠の中で開いたときだけ（別のタブで開いたものは知らせる親がいない）
 */
function withHead(body, inFrame) {
  // latin1 で読むと 1 バイトが 1 文字になり、文字の位置がそのままバイトの位置になる（UTF-8 の BOM は 3 文字）
  const doctype = /^(?:\xEF\xBB\xBF)?\s*<!doctype[^>]*>/i.exec(body.subarray(0, 4096).toString('latin1'));
  const at = doctype ? doctype[0].length : 0;
  const head = STORAGE_SHIM + (inFrame ? VIOLATION_BRIDGE + LINK_BRIDGE : '');
  return Buffer.concat([body.subarray(0, at), Buffer.from(head, 'utf8'), body.subarray(at)]);
}

/** 枠の中で開いたか（Chrome は Sec-Fetch-Dest を付ける。付けないものは枠として扱い、橋を入れる） */
const framed = req => {
  const dest = req.headers['sec-fetch-dest'];
  return dest === undefined || dest === 'iframe' || dest === 'frame';
};

/**
 * @param {object} [deps] サーバーから渡すもの（core/server.mjs が作る）
 * @param [deps.dataDir]       データの置き場（束の中身は <dataDir>/viz-blobs/）
 * @param [deps.store]         会話の台帳（core/store.mjs。prefs の読み込みの確認と許した出どころは store.getPrefs()）
 * @param [deps.htmlKeys]      HTML のファイルの鍵（core/html-keys.mjs。/f/<鍵>/… が resolve を呼ぶ。ファイルのページと同じもの）
 * @param [deps.ports]         () => { main, pages, isolated }
 * @param [deps.fileAccessFor] (sessionId) => ファイルの検査の範囲（core/server.mjs の fileAccessFor）。鍵に access が無いときに使う。無ければ { dataDir }
 * @param [deps.log]           ログの 1 行
 * @param [deps.sweepDelayMs]  起動からこの後に束の片付けを 1 回する（null なら片付けない。試験用）
 * @param [deps.now]           時計（試験用）
 * @returns {{ handle(req, res, { url: URL }): any, once(origins: string[]): string|null, sweep(): Promise<object>, close(): void }}
 */
export function createIsolatedRoutes(deps = {}) {
  const { dataDir = null, store = null, htmlKeys = null, fileAccessFor = null, log = () => {}, now = Date.now } = deps;
  const onceTokens = createOnceTokens({ now });
  const manifests = new Map();
  const sweep = () => (dataDir ? sweepVizBlobs({ dataDir, now, log }) : Promise.resolve({ removed: 0, kept: 0 }));
  const sweepDelayMs = deps.sweepDelayMs === undefined ? 60_000 : deps.sweepDelayMs;
  const timer = dataDir && sweepDelayMs !== null ? setTimeout(() => { sweep().catch(error => log(`viz-blobs: sweep failed: ${String(error?.message ?? error)}`)); }, sweepDelayMs) : null;
  timer?.unref?.();

  const prefs = async () => (await store?.getPrefs?.().catch(() => null)) ?? {};
  const onceFrom = url => onceTokens.take(url.searchParams.get('once')) ?? [];

  async function manifest(hash) {
    if (manifests.has(hash)) return manifests.get(hash);
    const files = dataDir ? await readManifest(dataDir, hash) : null;
    if (files) {
      while (manifests.size >= MANIFEST_CACHE) manifests.delete(manifests.keys().next().value);
      manifests.set(hash, files);
    }
    return files;
  }

  /** 目録から相対パスの中身の名前を引く。Windows で書いた束の大小文字の違いは、1 つに決まるときだけ許す */
  function lookup(files, rel) {
    if (Object.hasOwn(files, rel)) return { rel, sha: files[rel] };
    const lower = rel.toLowerCase();
    const matches = Object.keys(files).filter(key => key.toLowerCase() === lower);
    return matches.length === 1 ? { rel: matches[0], sha: files[matches[0]] } : null;
  }

  function send(req, res, { status = 200, headers, body }) {
    res.writeHead(status, { ...headers, 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function serveViz(req, res, url, hash, rest) {
    const segments = relativeSegments(rest);
    if (!isHash(hash) || !segments?.length) return sendStatus(req, res, 404, 'not found');
    const files = await manifest(hash);
    const found = files && lookup(files, segments.join('/'));
    const file = found && blobPath(dataDir, found.sha);
    if (!file) return sendStatus(req, res, 404, 'not found');
    const policy = previewPolicy(await prefs(), onceFrom(url));
    const security = isolatedHeaders({ policy, sandbox: VIZ_SANDBOX, self: `http://localhost:*/viz/${hash}/` });
    const type = typeOf(found.rel);
    if (!isHtml(found.rel)) {
      // 中身の名前（sha256）が変わらない限り同じ中身。確かめ直しだけで返せるようにする
      const etag = `"${found.sha}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...security, etag, 'cache-control': 'no-cache' }); return res.end(); }
      const body = await fs.readFile(file).catch(() => null);
      if (!body) return sendStatus(req, res, 404, 'not found');
      return send(req, res, { headers: { ...security, 'content-type': TEXT_TYPES.test(type) ? `${type}; charset=utf-8` : type, etag, 'cache-control': 'no-cache' }, body });
    }
    const raw = await fs.readFile(file).catch(() => null);
    if (!raw) return sendStatus(req, res, 404, 'not found');
    const embed = url.searchParams.get('embed');
    let body = null;
    if (['conversation', 'panel', 'tab'].includes(embed)) {
      // 入口の HTML。会話の枠の srcdoc と同じ包み。CSP はヘッダーが持つので meta は書かない
      let content = null;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {}
      if (content !== null) {
        const inFrame = embed !== 'tab' && framed(req);
        const theme = url.searchParams.get('theme');
        // 別のタブは包みの <title> を付ける（タブの列の題。web/visualize-frame.mjs の isolatedVisualizationUrl）
        const title = embed === 'tab' ? (url.searchParams.get('title') ?? '').slice(0, 200) : '';
        body = Buffer.from(visualizationDocument(content, { theme: ['light', 'dark'].includes(theme) ? theme : '', policy, meta: false, title,
          storage: true, resize: inFrame, conversation: embed === 'conversation' }), 'utf8');
      }
    }
    const charset = body ? 'utf-8' : htmlCharset(raw);
    body ??= withHead(raw, framed(req));
    return send(req, res, { headers: { ...security, 'content-type': charset ? `text/html; charset=${charset}` : 'text/html', 'cache-control': 'no-store' }, body });
  }

  async function serveFile(req, res, url, key, rest) {
    const held = htmlKeys?.resolve?.(key);
    const segments = rest.length === 0 || (rest.length === 1 && rest[0] === '') ? [] : relativeSegments(rest);
    // ドットで始まる名前（.env・.git など）は鍵のフォルダーの下でも出さない
    if (!held || !segments || segments.some(part => part.startsWith('.'))) return sendStatus(req, res, 404, 'not found');
    const parts = segments.length ? segments : [held.entry];
    const access = held.access ?? fileAccessFor?.(held.sessionId) ?? { dataDir };
    let checked, root;
    try {
      root = await fs.realpath(held.root);
      checked = await inspectFile(path.join(root, ...parts), access);
    } catch { return sendStatus(req, res, 404, 'not found'); }
    const rel = path.relative(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? checked.file.toLowerCase() : checked.file);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !checked.stat.isFile()) return sendStatus(req, res, 404, 'not found');
    const type = typeOf(checked.file);
    const limit = TEXT_TYPES.test(type) ? TEXT_LIMIT : FILE_LIMIT;
    if (checked.stat.size > limit) return sendStatus(req, res, 413, 'too large');
    let raw;
    try { raw = await readBounded(checked.file, limit); } catch { return sendStatus(req, res, 413, 'too large'); }
    const policy = previewPolicy(await prefs(), [...held.once, ...onceFrom(url)]);
    const security = isolatedHeaders({ policy, sandbox: HTML_SANDBOX, self: `http://localhost:*/f/${key}/` });
    if (isHtml(checked.file)) {
      const charset = htmlCharset(raw);
      return send(req, res, { headers: { ...security, 'content-type': charset ? `text/html; charset=${charset}` : 'text/html', 'cache-control': 'no-store' },
        body: withHead(raw, framed(req)) });
    }
    return send(req, res, { headers: { ...security, 'content-type': TEXT_TYPES.test(type) ? `${type}; charset=utf-8` : type, 'cache-control': 'no-store' }, body: raw });
  }

  return {
    async handle(req, res, { url }) {
      const [, area, key, ...rest] = url.pathname.split('/');
      if (area === 'viz' && key && dataDir) return serveViz(req, res, url, key, rest);
      if (area === 'f' && key) return serveFile(req, res, url, key, rest);
      return sendStatus(req, res, 404, 'not found');
    },
    /** 「一度だけ読み込む」の印を作る（画面が認証された WS で頼む。core/server.mjs が口を作る）。https の出どころが無ければ null */
    once: origins => onceTokens.mint(origins),
    sweep,
    close() { if (timer) clearTimeout(timer); onceTokens.clear(); manifests.clear(); },
  };
}
