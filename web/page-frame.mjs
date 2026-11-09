import { samePath } from './file-actions.mjs';

const REQUESTS = new Set(['file-menu', 'use-file', 'use-text', 'jump', 'commit', 'worktree', 'open-viz']);
const VIZ_TEXT = value => typeof value === 'string' && value.length <= 2000 ? value : undefined;
/** open-viz・file-menu に乗る可視化の情報は未信頼入力: 形と長さを検査し、束の印は 64 hex のものだけ通す */
function vizOf(value) {
  if (value == null || typeof value !== 'object') return undefined;
  const hash = /^[0-9a-f]{64}$/.test(value.hash ?? '') ? value.hash : undefined;
  if (!hash) return undefined;
  const viz = { hash };
  const entry = VIZ_TEXT(value.entry); if (entry) viz.entry = entry;
  const title = VIZ_TEXT(value.title); if (title) viz.title = title;
  return viz;
}
/** iframe のページからの頼み（pleiad:page-request）を検査して返す。通さないものは null。スマホの端末内のページ（web/browser-unify.mjs）も使う */
export function pageRequestOf(message, sessionId) {
  const request = message?.request;
  if (message?.type !== 'pleiad:page-request' || !request || !REQUESTS.has(request.type) || request.sessionId !== sessionId) return null;
  try { if (JSON.stringify(message).length > 65536) return null; } catch { return null; }
  const viz = vizOf(request.viz);
  const hasPath = typeof request.path === 'string' && request.path && request.path.length <= 8192;
  // use-file は従来どおり有効なパスが必須。file-menu は可視化の行（元パスの記録が無いもの）だけ viz でよい
  if (request.type === 'use-file' && !hasPath) return null;
  if (request.type === 'file-menu' && !hasPath && !viz) return null;
  if (request.type === 'file-menu' && (!['file', 'directory'].includes(request.kind ?? 'file') ||
      !Number.isFinite(request.x) || !Number.isFinite(request.y))) return null;
  if (request.type === 'open-viz' && !viz) return null;
  if (!hasPath) delete request.path;
  if (viz) request.viz = viz; else delete request.viz;
  request.missing = request.missing === true;
  return request;
}

/** ページの中の点（file-menu の x・y）を、iframe の箱の中に収めて画面の点へ直す */
export function framePoint(request, rect) {
  return request.type === 'file-menu' ? { ...request,
    x: rect.left + Math.max(0, Math.min(rect.width, request.x)),
    y: rect.top + Math.max(0, Math.min(rect.height, request.y)) } : { ...request };
}

/** Resolve aliases on the server before choosing a tab; no Chrome startup or chooser. */
export function createFilePageRouter({ cmd, caps, openTab, tabs = () => [], focusTab, flashTab, resolved = () => {}, getGeneration = () => 0 } = {}) {
  return async function open(ref, context = {}, element) {
    const sessionId = context.sessionId;
    if (!caps()?.pages || !sessionId) return false;
    const generation = getGeneration();
    // 開く先はサーバーが決める（pageOpen。パスの確かめもその中で済む）。頼めない環境は従来どおり resolvePath で確かめる
    const opened = await cmd('pageOpen', { sessionId, kind:'file', path:ref.path, ...(ref.line ? { line:ref.line } : {}) }).catch(() => null);
    const where = opened?.path ? { path:opened.path, kind:opened.kind === 'dir' ? 'directory' : 'file', cwd:opened.cwd ?? context.cwd }
      : await cmd('resolvePath', { ...context, path:ref.path });
    if (generation !== getGeneration() || !caps()?.pages) return false;
    resolved(where);
    const page = where.kind === 'directory' ? 'dir' : 'file';
    if (openTab) {
      const existing = tabs(sessionId).find(tab => tab.local && tab.page?.kind !== 'viz' && samePath(tab.path ?? tab.page?.path, where.path));
      if (existing && focusTab) { await focusTab(existing, sessionId); flashTab?.(existing, sessionId); return true; }
      await openTab({ sessionId, path:where.path, kind:page, line:ref.line }); return true;
    }
    return false;
  };
}
