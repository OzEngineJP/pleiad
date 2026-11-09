import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFile, readPreview, listTreeFolder, previewFailure, FILE_LIMIT } from './file-preview.mjs';
import { readLocalFile } from './local-files.mjs';
import { currentLocale } from './i18n.mjs';
import { fileMark } from './isolated-origins.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const pdf = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const pages = new Set(['file', 'dir', 'git', 'plugins', 'new', 'attachment']);
const types = { '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.bcmap':'application/octet-stream', '.pfb':'application/octet-stream', '.ttf':'font/ttf', '.wasm':'application/wasm' };
const fault = (code, status = 400) => Object.assign(new Error(code), { pageCode:code, status });

/** Authenticated GET/HEAD only. Both listeners use these routes; no operation here writes files.
 * deps has the S0 server contract, plus optional recentFiles(sessionId) and env(sessionId).
 * recentFiles returns [{path, source, at?}]; env returns {theme?,lang?} from the host UI.
 */
export function createPagesRoutes(deps = {}) {
  const visited = new Map();
  const ports = () => deps.ports?.() ?? {};
  const validPort = value => Number.isInteger(value) && value > 0 && value < 65536;
  // The ports the viewer reaches. On the main listener, the remote forwarder
  // (core/remote/forward.mjs) adds x-pleiad-page-ports from the authenticated
  // channel header: the device proxy's ports. Anything malformed is ignored.
  function viewPorts(req, via) {
    const raw = via === 'main' ? req.headers['x-pleiad-page-ports'] : undefined;
    if (typeof raw !== 'string' || raw.length > 200) return ports();
    try {
      const value = JSON.parse(raw);
      const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
      if (keys === 'isolated,main,pages' && validPort(value.main) && validPort(value.pages) && validPort(value.isolated)) return { main:value.main, pages:value.pages, isolated:value.isolated };
    } catch { /* not JSON */ }
    deps.log?.({ type:'pages:error', code:'invalid-page-ports' });
    return ports();
  }
  function headers(via) {
    const isolated = Number(ports().isolated);
    return {
      'cache-control':'private, no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff',
      'content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src ${isolated > 0 ? `http://localhost:${isolated} http://*.localhost:${isolated}` : "'none'"}; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${via === 'main' ? "'self'" : "'none'"}`,
    };
  }
  function send(req, res, via, status, body, extra = {}) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { ...headers(via), 'content-type':'application/json; charset=utf-8', ...extra, 'content-length':data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }
  const json = (req, res, via, value) => send(req, res, via, 200, JSON.stringify(value));

  async function asset(url) {
    const prefix = '/_pleiad/assets/';
    if (url.pathname === '/_pleiad/vendor/i18next.mjs') return { body:await fs.readFile(fileURLToPath(import.meta.resolve('i18next'))), type:types['.mjs'] };
    let base, name;
    if (url.pathname.startsWith(prefix)) { base = web; name = decodeURIComponent(url.pathname.slice(prefix.length)); }
    else if (url.pathname.startsWith('/_pleiad/vendor/pdfjs/')) { base = pdf; name = decodeURIComponent(url.pathname.slice('/_pleiad/vendor/pdfjs/'.length)); }
    else return null;
    if (!name || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..')) throw fault('not-found', 404);
    const ext = path.extname(name), type = types[ext];
    // Only Pleiad's public modules/styles/dictionaries and the PDF viewer's resources.
    if (!type || (base === web && !(ext === '.mjs' || ext === '.css' || (ext === '.json' && /^locales\/(ja|en)\/[a-z-]+\.json$/.test(name))))) throw fault('not-found', 404);
    if (base === pdf && !/^(build|cmaps|standard_fonts|wasm)\//.test(name)) throw fault('not-found', 404);
    let body = await fs.readFile(path.join(base, name));
    // Keep script-src 'self' without an inline import map on either listener.
    if (base === web && name === 'i18n.mjs') body = Buffer.from(body.toString('utf8').replace("from 'i18next'", "from '/_pleiad/vendor/i18next.mjs'"));
    return { body, type };
  }

  async function handle(req, res, { url = new URL(req.url, 'http://localhost'), via = 'pages' } = {}) {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        send(req, res, via, 405, JSON.stringify({ error:{ code:'method-not-allowed' } }), { allow:'GET, HEAD' }); return;
      }
      const staticFile = await asset(url);
      if (staticFile) { send(req, res, via, 200, staticFile.body, { 'content-type':staticFile.type }); return; }
      const match = /^\/_pleiad\/s\/([^/]+)\/(file|dir|git|plugins|new|attachment|api\/[a-z-]+)$/.exec(url.pathname);
      if (!match) throw fault('not-found', 404);
      const sessionId = decodeURIComponent(match[1]), route = match[2];
      const sessions = await deps.store.getAll();
      if (!Object.hasOwn(sessions, sessionId)) throw fault('session-not-found', 404);
      const meta = sessions[sessionId];
      if (pages.has(route)) {
        send(req, res, via, 200, await fs.readFile(path.join(web, 'pages/index.html')), { 'content-type':'text/html; charset=utf-8' }); return;
      }
      const q = url.searchParams;
      // A query cannot choose a different session from the URL.
      if (q.has('sessionId') && q.get('sessionId') !== sessionId) throw fault('access-denied', 403);
      const access = deps.fileAccessFor(sessionId), roots = deps.fileRoots(sessions);
      const view = viewPorts(req, via);
      async function resolve(raw = q.get('path')) {
        if (typeof raw !== 'string' || !raw || raw.length > 32768) throw fault('invalid-path');
        const base = q.get('base');
        if (base) await inspectFile(base, access);
        const ref = await deps.resolveSessionFile({ path:raw, sessionId, at:q.get('at') ?? undefined, base:base ?? undefined }, sessions, roots);
        // Resolve and inspect once more here, including relative bases and symlinks.
        return { ...ref, ...(await inspectFile(ref.path, access)) };
      }
      async function op(id, input = {}) {
        const result = await deps.ops({ by:'human', via:'ui', sessionId }, id, { ...input, sessionId });
        if (!result?.ok) throw fault('read-failed', 502);
        return result.result;
      }
      switch (route) {
        case 'api/env': {
          const prefs = await deps.store.getPrefs?.() ?? {};
          const env = await deps.env?.(sessionId) ?? {};
          json(req, res, via, { lang:env.lang ?? currentLocale(), theme:env.theme ?? prefs.theme ?? 'auto', sessionId, isolatedPort:view.isolated ?? null }); break;
        }
        case 'api/preview': {
          const ref = await resolve();
          if (q.get('resource') !== '1') deps.watch?.add(sessionId, ref.file, ref.stat.isDirectory() ? 'dir' : 'file', q.get('watchOwner') || undefined);
          const result = await readPreview(ref.file, roots, { access, resource:q.get('resource') === '1' });
          // API errors and unsupported content use codes; translations belong to the page.
          if (result.kind === 'unsupported') { delete result.reason; result.reasonCode = result.size > (result.downloadable ? 8 * 1024 * 1024 : FILE_LIMIT) ? 'over-limit' : 'unsupported'; }
          // The relay's text limit is 8 MiB, while binary responses allow 32 MiB.
          // Send page content separately so JSON escaping/base64 cannot inflate it.
          if (q.get('content') === 'raw' && q.get('resource') !== '1' && (typeof result.text === 'string' || result.data)) {
            result.content = { binary:!!result.data, text:typeof result.text === 'string' };
            delete result.data; delete result.text;
          }
          if (q.get('resource') !== '1') {
            const list = visited.get(sessionId) ?? [];
            visited.delete(sessionId); visited.set(sessionId, [{ path:result.path, source:'opened', at:result.fetchedAt }, ...list.filter(f => f.path !== result.path)].slice(0, 30));
            if (visited.size > 100) visited.delete(visited.keys().next().value);
          }
          json(req, res, via, { ...result, line:ref.line, cwd:ref.cwd }); break;
        }
        case 'api/raw': {
          const ref = await resolve();
          const raw = await readLocalFile(ref.file, access, { download:q.get('download') === '1' });
          send(req, res, via, 200, raw.body, raw.headers); break;
        }
        case 'api/tree': {
          const ref = await resolve();
          deps.watch?.add(sessionId, ref.file, 'dir', q.get('watchOwner') || undefined);
          const offset = Number(q.get('offset') ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0) throw fault('invalid-path');
          json(req, res, via, await listTreeFolder(ref.file, { access, offset })); break;
        }
        case 'api/viz': {
          // 会話に保存した可視化の束の中身（「HTML を保存」が取る）。この会話の記録にある束だけ。認証済み GET
          const body = await deps.vizEntry?.(sessionId, String(q.get('hash') ?? ''), String(q.get('entry') ?? ''));
          if (!body) throw fault('not-found', 404);
          send(req, res, via, 200, body, { 'content-type':'text/plain; charset=utf-8' }); break;
        }
        case 'api/html-key': {
          const ref = await resolve();
          if (!ref.stat.isFile() || !/\.html?$/i.test(ref.file)) throw fault('unsupported');
          if (ref.stat.size > 8 * 1024 * 1024) throw fault('over-limit', 413);
          // once: https origins the person allowed to load one time (core/html-keys.mjs keeps only external origins).
          const key = await deps.htmlKeys?.issue({ sessionId, path:ref.file, once:q.getAll('once').slice(0, 50), access });
          if (!key || !ports().isolated || !view.isolated || !deps.secret) throw fault('unavailable', 503);
          deps.watch?.add(sessionId, ref.file, 'file', q.get('watchOwner') || undefined);
          // アプリの専用の出どころ（f<フォルダーの印>.localhost。core/isolated-origins.mjs）。localStorage などはその origin の中で効く。
          // 端末（スマホの道の port）は <印>.localhost を名前解決できないので localhost のまま（その origin 内の保存は端末では分けない）
          const marked = view.isolated === ports().isolated;
          const mark = fileMark(deps.secret, path.dirname(ref.file));
          const host = marked ? `${mark}.localhost` : 'localhost';
          json(req, res, via, { url:`http://${host}:${view.isolated}/f/${encodeURIComponent(key)}/${encodeURIComponent(path.basename(ref.file))}`, mark }); break;
        }
        case 'api/git': {
          const kind = q.get('kind') ?? 'changes';
          if (!['status', 'changes', 'diff', 'history', 'commit', 'worktrees', 'worktree', 'prs'].includes(kind)) throw fault('unsupported');
          await inspectFile(meta.cwd, access);
          if (kind === 'prs') {
            json(req, res, via, await op('git.prs', { states:q.get('states') !== 'false' })); break;
          }
          const input = {};
          if (q.has('worktree')) {
            const ref = await resolve(q.get('worktree'));
            if (!ref.stat.isDirectory()) throw fault('not-file');
            // The existing git reader also checks membership in this repository.
            input.worktree = ref.file;
          }
          if (['changes', 'diff'].includes(kind)) input.range = q.get('range') === 'session' ? 'session' : 'uncommitted';
          if (kind === 'changes') input.only = 'changes';
          if (kind === 'diff') {
            const raw = q.get('path');
            // core/git-info.mjs runs git with GIT_LITERAL_PATHSPECS=1, so globs and
            // pathspec magic in a checked name never expand to unchecked files
            // (`[id].mjs` is fine). `:` stays rejected: on Windows `a:b` resolves
            // drive-relative, so the checked path would differ from the one git reads.
            const validName = value => value && value.length <= 4096 && !/[\\:]/.test(value) && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split('/').some(p => !p || p === '.' || p === '..');
            if (!validName(raw) || (q.has('orig') && !validName(q.get('orig')))) throw fault('invalid-path');
            // Git names are relative to the repository root, not the conversation cwd.
            // A deleted path is valid, but its closest existing ancestor must pass
            // the same protection/ownership/confine checks as a live preview.
            const state = await op('git.status');
            if (!state?.git?.root) throw fault('not-found', 404);
            for (const name of [raw, q.get('orig')].filter(Boolean)) {
              let candidate = path.resolve(input.worktree ?? state.git.root, name);
              for (;;) {
                try { await inspectFile(candidate, access); break; }
                catch (error) {
                  if (error.code !== 'ENOENT' || path.dirname(candidate) === candidate) throw error;
                  candidate = path.dirname(candidate);
                }
              }
            }
            input.path = raw;
            if (q.has('orig')) input.orig = q.get('orig');
            input.after = true;
            for (const key of ['commit', 'from', 'to']) {
              if (q.has(key)) { if (!/^[a-f0-9]{7,64}$/i.test(q.get(key))) throw fault('unsupported'); input[key] = q.get(key); }
            }
            if (q.has('context')) {
              const context = Number(q.get('context'));
              if (!Number.isInteger(context) || context < 0 || context > 1000) throw fault('unsupported');
              input.context = context;
            }
            if (q.has('stage')) {
              if (!['staged', 'work'].includes(q.get('stage'))) throw fault('unsupported');
              input.stage = q.get('stage');
            }
          }
          if (kind === 'commit') { if (!/^[a-f0-9]{7,64}$/i.test(q.get('hash') ?? '')) throw fault('unsupported'); input.hash = q.get('hash'); }
          if (kind === 'history') { input.limit = 50; if (q.has('cursor')) input.cursor = q.get('cursor'); if (q.get('through') === 'true') input.through = true; }
          if (kind === 'worktrees' && q.get('only') === 'list') input.only = 'list';
          if (kind === 'worktree' && !input.worktree) throw fault('invalid-path');
          const result = await op(`git.${kind}`, input);
          if (kind === 'worktrees' && result.worktrees?.rows) {
            const rows = [];
            for (const row of result.worktrees.rows) { try { await inspectFile(row.path, access); rows.push(row); } catch { /* No path outside the conversation's file policy. */ } }
            result.worktrees = { ...result.worktrees, rows, total:rows.length };
            if (result.worktrees.base?.path) {
              try { await inspectFile(result.worktrees.base.path, access); }
              catch { result.worktrees.base = null; }
            }
          }
          if (kind === 'changes' && q.get('only') === 'light') result.timeline = await deps.gitTimeline?.(sessionId) ?? [];
          json(req, res, via, result); break;
        }
        case 'api/plugins': {
          const data = await op('context.session', { compare:false });
          const entries = [];
          for (const entry of data?.report?.entries ?? []) {
            if (!['instruction', 'skill', 'mcp'].includes(entry.kind)) continue;
            if (entry.path) { try { await inspectFile(entry.path, access); } catch { continue; } }
            // Configuration, injected content and environment variables are not page data.
            entries.push(Object.fromEntries(['id', 'name', 'title', 'kind', 'status', 'description', 'path'].filter(k => entry[k] != null).map(k => [k, entry[k]])));
          }
          json(req, res, via, { report:{ entries } }); break;
        }
        case 'api/recent': {
          const entries = [...(await deps.recentFiles?.(sessionId) ?? []), ...(visited.get(sessionId) ?? [])];
          const files = [], seen = new Set();
          for (const entry of entries.slice(0, 200)) {
            if (!entry || typeof entry.path !== 'string') continue;
            try {
              const { file, stat } = await inspectFile(entry.path, access);
              const key = process.platform === 'win32' ? file.toLowerCase() : file;
              if (seen.has(key)) continue;
              seen.add(key);
              if (!stat.isFile()) continue;
              files.push({ path:file, name:path.basename(file), source:['read', 'edited', 'attached', 'opened'].includes(entry.source) ? entry.source : 'opened', at:entry.at, ...(typeof entry.actor === 'string' ? { actor:entry.actor } : {}) });
              if (files.length === 20) break;
            } catch { /* A recent reference never grants access. */ }
          }
          const folders = [];
          const past = (meta.history ?? []).filter(v => v.field === 'cwd').slice().reverse().flatMap(v => [v.to, v.from]);
          for (const dir of [meta.cwd, ...past].filter(Boolean)) {
            try { const { file, stat } = await inspectFile(dir, access); if (stat.isDirectory() && !folders.some(f => f.path === file)) folders.push({ path:file, name:path.basename(file) || file }); } catch { /* unavailable cwd */ }
          }
          const visualizations = [];
          for (const item of (await deps.visualizations?.(sessionId) ?? []).slice(0, 20)) {
            try {
              const target = new URL(item.url);
              // 可視化の出どころは束の印の <印>.localhost（古い localhost の形も受ける）。port は見ている側のものへ付け替える。
              // 端末の port なら名前は localhost へ戻す（<印>.localhost は端末から名前解決できない）
              const marked = target.hostname === 'localhost' || /^[a-z0-9][a-z0-9-]{0,61}\.localhost$/.test(target.hostname);
              if (target.protocol !== 'http:' || !marked || Number(target.port || 80) !== ports().isolated || target.username || target.password || !view.isolated) continue;
              target.port = String(view.isolated);   // the device proxy's isolated port when viewed from a phone
              if (view.isolated !== ports().isolated) target.hostname = 'localhost';
              const row = { title:String(item.title ?? ''), url:target.href,
                hash:String(item.hash ?? ''), entry:String(item.entry ?? ''), at:typeof item.at === 'string' ? item.at : undefined };
              // 元のファイル: 記録にあって読めるなら実体のパス、消えた・無いものは missing（拒否など別の失敗はパスを返して開く側が断る）
              if (typeof item.path === 'string' && item.path) {
                try {
                  const { file, stat } = await inspectFile(item.path, access);
                  if (stat.isFile()) row.path = file; else { row.path = item.path; row.missing = true; }
                } catch (error) {
                  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { row.path = item.path; row.missing = true; }
                  else row.path = item.path;
                }
              }
              visualizations.push(row);
            } catch { /* Only this conversation's host supplies visualization links. */ }
          }
          json(req, res, via, { files, visualizations, folders:folders.slice(0, 8), session:{ id:sessionId, title:meta.title ?? '' } }); break;
        }
        default: throw fault('not-found', 404);
      }
    } catch (error) {
      const code = error.pageCode ?? previewFailure(error).code;
      const status = error.status ?? (['access-denied', 'protected-data'].includes(code) ? 403 : code === 'not-found' ? 404 : 400);
      deps.log?.({ type:'pages:error', code });
      send(req, res, via, status, JSON.stringify({ error:{ code } }));
    }
  }
  return { handle };
}
