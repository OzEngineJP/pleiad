import { t } from './i18n.mjs';
import { samePath } from './file-actions.mjs';

const REQUESTS = new Set(['file-menu', 'use-file', 'use-text', 'jump', 'commit', 'worktree']);
const PAGES = new Set(['file', 'dir', 'attachment', 'git', 'plugins', 'new']);

/** The fallback serves only Pleiad's own pages, authenticated by the app cookie. */
export function createPageFrame({ doc = globalThis.document, preview, onRequest = () => {}, getSessionId = () => null } = {}) {
  let frame = null, sessionId = null;
  const origin = () => doc.location?.origin ?? globalThis.location.origin;
  function close() { frame?.remove(); frame = null; sessionId = null; }
  function send(type, data) { frame?.contentWindow?.postMessage({ type, ...data }, origin()); }
  async function receive(event) {
    if (!frame?.isConnected || event.source !== frame.contentWindow || event.origin !== origin()) return false;
    const message = event.data, request = message?.request;
    if (message?.type !== 'pleiad:page-request' || !request || !REQUESTS.has(request.type) || request.sessionId !== sessionId ||
        (getSessionId() && getSessionId() !== sessionId)) return false;
    try { if (JSON.stringify(message).length > 65536) return false; } catch { return false; }
    if (['file-menu', 'use-file'].includes(request.type) && (typeof request.path !== 'string' || !request.path || request.path.length > 8192)) return false;
    if (request.type === 'file-menu' && (!['file', 'directory'].includes(request.kind ?? 'file') ||
        !Number.isFinite(request.x) || !Number.isFinite(request.y))) return false;
    const source = frame, rect = frame.getBoundingClientRect();
    const detail = request.type === 'file-menu' ? { ...request,
      x: rect.left + Math.max(0, Math.min(rect.width, request.x)),
      y: rect.top + Math.max(0, Math.min(rect.height, request.y)) } : { ...request };
    try {
      const result = await onRequest(detail);
      if (frame === source && request.requestId) send('pleiad:page-result', { requestId: request.requestId, ok: true, result });
    } catch {
      if (frame === source && request.requestId) send('pleiad:page-result', { requestId: request.requestId, ok: false, error: 'unavailable' });
    }
    return true;
  }
  doc?.defaultView?.addEventListener('message', receive);
  return {
    open(url, { sessionId: id = getSessionId(), title = t('filePreview.panel'), element } = {}) {
      let parsed;
      try { parsed = new URL(url, origin()); } catch { return false; }
      const match = /^\/_pleiad\/s\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
      if (parsed.origin !== origin() || parsed.username || parsed.password || !match ||
          match[1] !== encodeURIComponent(id) || !PAGES.has(match[2])) return false;
      close(); sessionId = id;
      frame = doc.createElement('iframe'); frame.className = 'page-frame'; frame.title = title;
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.style.cssText = 'border:0;width:100%;height:100%;min-height:0;display:block;flex:1';
      frame.src = parsed.href;
      preview?.openPanel({ key: 'page-frame', title, label: title, body: frame, element, onClose: close });
      return true;
    },
    close, receive,
    envChanged(env) { send('pleiad:env', { env }); },
    command(command) { send('pleiad:page-command', { command }); },
    dispose() { close(); doc?.defaultView?.removeEventListener('message', receive); },
    get frame() { return frame; },
  };
}

/** Resolve aliases on the server before choosing a tab; no Chrome startup or chooser. */
export function createFilePageRouter({ cmd, frame, caps, connected = () => false, openTab, tabs = () => [], focusTab, flashTab, resolved = () => {}, getGeneration = () => 0 } = {}) {
  return async function open(ref, context = {}, element) {
    const sessionId = context.sessionId;
    if (!caps()?.pages || !sessionId) return false;
    const generation = getGeneration();
    const where = await cmd('resolvePath', { ...context, path: ref.path });
    if (generation !== getGeneration() || !caps()?.pages) return false;
    resolved(where);
    const page = where.kind === 'directory' ? 'dir' : 'file';
    const params = new URLSearchParams({ path: where.path });
    if (ref.line) params.set('line', String(ref.line));
    const suffix = `/_pleiad/s/${encodeURIComponent(sessionId)}/${page}?${params}`;
    if (connected(sessionId) && openTab) {
      const existing = tabs(sessionId).find(tab => samePath(tab.path ?? tab.page?.path ?? tab.file?.path, where.path));
      if (existing && focusTab) {
        await focusTab(existing, sessionId); flashTab?.(existing, sessionId); return true;
      }
      await openTab({ sessionId, url: `http://localhost:${caps().pages}${suffix}`, path: where.path, kind: where.kind, reuse: true });
      return true;
    }
    return frame.open(suffix, { sessionId, title: where.path, element });
  };
}
