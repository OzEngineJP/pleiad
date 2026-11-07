import { externalOrigin, blockedOrigin } from '../browser-confirm-policy.mjs';
import { api, button, node, text } from './bridge.mjs';

// The HTML file frame (its own <mark>.localhost origin; core/isolated-origins.mjs) reports blocked loads
// through the server-injected VIOLATION_BRIDGE. Count them and offer "load once":
// a new key that carries the one-time https origins (core/html-keys.mjs keeps
// only external origins). Only https origins can be allowed; http is counted.
export async function htmlFrame(content, file, signal) {
  const frame = node('iframe', 'html-preview'); frame.title = file.name;
  // 応答のヘッダーの CSP の sandbox と同じ（core/preview-policy.mjs の APP_SANDBOX）。アプリ専用の出どころなので allow-same-origin が付く
  frame.sandbox = 'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups allow-pointer-lock';
  frame.referrerPolicy = 'no-referrer';
  const blocked = new Map(), once = new Set();
  const label = node('span'); label.setAttribute('role', 'status');
  const load = button(text('blocked.loadOnce'), () => {
    for (const origin of blocked.values()) if (externalOrigin(origin) && once.size < 50) once.add(origin);
    void show().catch(() => {});
  });
  const bar = node('div', 'html-blocked'); bar.hidden = true; bar.append(label, load);
  async function show() {
    const { url } = await api('html-key', [['path', file.path], ...[...once].map(origin => ['once', origin])]);
    if (signal.aborted) return;
    blocked.clear(); bar.hidden = true; frame.src = url;
  }
  const receive = event => {
    if (event.source !== frame.contentWindow || event.data?.type !== 'ply-preview-blocked') return;
    const origin = blockedOrigin(event.data.url);
    const key = String(event.data.url).slice(0, 2048);
    // The opaque frame may report arbitrary content. Bound memory and show text only.
    if (!origin || once.has(origin) || blocked.has(key) || blocked.size >= 500) return;
    blocked.set(key, origin);
    label.textContent = text('blocked.count', { count:blocked.size });
    load.hidden = ![...blocked.values()].some(externalOrigin);
    bar.hidden = false;
  };
  window.addEventListener('message', receive);
  signal.addEventListener('abort', () => window.removeEventListener('message', receive), { once:true });
  content.append(bar, frame);
  await show();
}
