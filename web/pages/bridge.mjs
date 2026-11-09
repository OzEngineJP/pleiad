import { t, setLanguage } from '../i18n.mjs';
import { moreIcon } from '../icons.mjs';

const match = /^\/_pleiad\/s\/([^/]+)\/([^/]+)$/.exec(location.pathname);
export const sessionId = match ? decodeURIComponent(match[1]) : '';
export const page = match?.[2] ?? 'new';
export const prefix = `/_pleiad/s/${encodeURIComponent(sessionId)}/`;
export const query = new URLSearchParams(location.search);
export const text = (key, options) => t(`pages:${key}`, options);
export const node = (tag, className, value) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value != null) el.textContent = value;
  return el;
};
/** web/icons.mjs の固定の SVG を要素にする（中身は手元の定数だけ） */
export const icon = markup => { const template = document.createElement('template'); template.innerHTML = markup; return template.content.firstElementChild; };
export const button = (label, action, className = '') => {
  const el = node('button', className, label); el.type = 'button'; el.addEventListener('click', action); return el;
};
export const pageUrl = (kind, path, extra = {}) => {
  const q = new URLSearchParams(extra); if (path != null) q.set('path', path);
  return `${prefix}${kind}${q.size ? `?${q}` : ''}`;
};
export const openFile = (path, kind = 'file') => {
  const url = pageUrl(kind === 'directory' ? 'dir' : kind, path);
  if (parent !== window) parent.postMessage({ type:'pleiad:page-open', sessionId, url }, location.origin);
  else location.href = url;
};
export async function api(name, params = {}) {
  const q = new URLSearchParams(params);
  // Each page API read belongs to the tab that opened this page. The server
  // uses this owner to release file watches when the tab closes.
  if (query.has('watchOwner') && !q.has('watchOwner')) q.set('watchOwner', query.get('watchOwner'));
  const res = await fetch(`${prefix}api/${name}${q.size ? `?${q}` : ''}`, { credentials:'same-origin', cache:'no-store' });
  const result = await res.json();
  if (!res.ok) throw Object.assign(new Error(result.error?.code ?? 'read-failed'), { code:result.error?.code ?? 'read-failed' });
  return result;
}
export async function loadContent(file) {
  if (!file.content) return file;
  const response = await fetch(pageUrl('api/raw', file.path), { credentials:'same-origin', cache:'no-store' });
  if (!response.ok) throw Object.assign(new Error('read-failed'), { code:'read-failed' });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > (file.content.binary ? 32 : 8) * 1024 * 1024) throw Object.assign(new Error('over-limit'), { code:'over-limit' });
  if (file.content.binary) file.bytes = bytes;
  if (file.content.text) file.text = new TextDecoder('utf-8', { fatal:true }).decode(bytes);
  return file;
}
export function errorView(root, error) {
  const code = error?.code ?? 'read-failed';
  const known = ['not-found', 'session-not-found', 'access-denied', 'protected-data', 'network-path', 'different-host', 'cwd-unknown', 'not-file', 'invalid-path', 'over-limit', 'unsupported', 'unavailable', 'read-failed'];
  // i18n-dynamic: errors.
  root.replaceChildren(node('p', 'empty error', text(`errors.${known.includes(code) ? code : 'read-failed'}`)));
}
// These are requests for the host's menu/confirmation, never write operations.
export function request(type, detail = {}) {
  if (!['file-menu', 'use-file', 'commit', 'use-text', 'worktree', 'jump', 'open-viz'].includes(type)) return;
  const message = { type, sessionId, ...detail };
  if (typeof globalThis.plyPage === 'function') return globalThis.plyPage(JSON.stringify(message));
  else if (parent !== window) parent.postMessage({ type:'pleiad:page-request', request:message }, location.origin);
}
const pending = new Map();
// Browser bindings and postMessage have no return value. Writes wait for the
// host's completion event, rather than treating delivery as acknowledgement.
export function requestResult(type, detail = {}) {
  if (pending.size >= 50) return Promise.reject(new Error('unavailable'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish({ ok:false, error:'unavailable' }), 300000);
    const finish = reply => {
      if (!pending.delete(requestId)) return;
      clearTimeout(timer);
      if (reply.ok === true) resolve(reply.result); else reject(new Error(reply.error || 'unavailable'));
    };
    pending.set(requestId, finish);
    try {
      const result = request(type, { ...detail, requestId });
      if (result != null) Promise.resolve(result).then(value => finish({ ok:true, result:value }), error => finish({ ok:false, error:error?.message }));
    } catch (error) { finish({ ok:false, error:error?.message }); }
  });
}
const receiveResult = reply => pending.get(reply?.requestId)?.(reply);
window.addEventListener('pleiad:page-result', event => receiveResult(event.detail));
export function fileActions(row, path, kind = 'file') {
  row.addEventListener('contextmenu', event => { event.preventDefault(); request('file-menu', { path, kind, x:event.clientX, y:event.clientY }); });
  const more = button(null, event => { event.stopPropagation(); request('file-menu', { path, kind, x:event.clientX, y:event.clientY }); }, 'more');
  more.append(icon(moreIcon)); more.title = text('fileMenu'); more.setAttribute('aria-label', text('fileMenu')); row.append(more);
}
/** 可視化の行の「⋯」。path が無い（元の記録が無い）ときは viz の情報だけで開くメニューになる（ホスト側で OS の動作は出さない）。missing は記録に元パスがあるが実体が無い印（コピーに要るので path は残す） */
export function vizActions(row, { hash, entry = '', title = '', path = '', missing = false }) {
  const detail = { viz:{ hash, entry, title }, x:0, y:0, missing:missing === true };
  if (path) { detail.path = path; detail.kind = 'file'; }
  const menu = event => { event.stopPropagation(); event.preventDefault();
    const rect = row.getBoundingClientRect();
    request('file-menu', { ...detail, x: event.clientX || rect.right - 8, y: event.clientY || rect.top + rect.height / 2 }); };
  row.addEventListener('contextmenu', menu);
  const more = button(null, menu, 'more');
  more.append(icon(moreIcon)); more.title = text('fileMenu'); more.setAttribute('aria-label', text('fileMenu')); row.append(more);
}
export function size(value) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
export function date(value) { const d = new Date(value); return Number.isNaN(+d) ? '' : d.toLocaleString(document.documentElement.lang, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
export function metadata(file) { return node('p', 'metadata', text('fetched', { time:date(file.fetchedAt), size:size(file.size) })); }

const media = matchMedia('(prefers-color-scheme: dark)');
let theme = 'auto';
async function applyEnv(env) {
  if (env.lang && ['ja', 'en'].includes(env.lang)) { await setLanguage(env.lang); document.documentElement.lang = env.lang; }
  if (env.theme != null) theme = ['light', 'dark'].includes(env.theme) ? env.theme : 'auto';
  document.documentElement.dataset.theme = theme === 'auto' ? media.matches ? 'dark' : 'light' : theme;
}
media.addEventListener('change', () => { if (theme === 'auto') document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'; });
export async function initializeEnv() {
  const env = await api('env'); await applyEnv(env);
  // The relay dispatches this event in the page; iframe hosts use the message below.
  window.addEventListener('pleiad:env', async event => { await applyEnv(event.detail ?? {}); window.dispatchEvent(new Event('pleiad:refresh')); });
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'pleiad:page-result') receiveResult(event.data);
    if (event.data?.type === 'pleiad:env') { await applyEnv(event.data.env ?? {}); window.dispatchEvent(new Event('pleiad:refresh')); }
    if (event.data?.type === 'pleiad:page-command') window.dispatchEvent(new CustomEvent('pleiad:page-command', { detail:event.data.command }));
  });
  return env;
}
