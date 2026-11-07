import { samePath } from './file-actions.mjs';

const REQUESTS = new Set(['file-menu', 'use-file', 'use-text', 'jump', 'commit', 'worktree']);
/** iframe のページからの頼み（pleiad:page-request）を検査して返す。通さないものは null。スマホの端末内のページ（web/browser-unify.mjs）も使う */
export function pageRequestOf(message, sessionId) {
  const request = message?.request;
  if (message?.type !== 'pleiad:page-request' || !request || !REQUESTS.has(request.type) || request.sessionId !== sessionId) return null;
  try { if (JSON.stringify(message).length > 65536) return null; } catch { return null; }
  if (['file-menu', 'use-file'].includes(request.type) && (typeof request.path !== 'string' || !request.path || request.path.length > 8192)) return null;
  if (request.type === 'file-menu' && (!['file', 'directory'].includes(request.kind ?? 'file') ||
      !Number.isFinite(request.x) || !Number.isFinite(request.y))) return null;
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
    const where = await cmd('resolvePath', { ...context, path: ref.path });
    if (generation !== getGeneration() || !caps()?.pages) return false;
    resolved(where);
    const page = where.kind === 'directory' ? 'dir' : 'file';
    if (openTab) {
      const existing = tabs(sessionId).find(tab => tab.local && samePath(tab.path ?? tab.page?.path, where.path));
      if (existing && focusTab) { await focusTab(existing, sessionId); flashTab?.(existing, sessionId); return true; }
      await openTab({ sessionId, path:where.path, kind:page, line:ref.line }); return true;
    }
    return false;
  };
}
