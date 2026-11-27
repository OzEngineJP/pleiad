import { TAB_PARAM } from './browser-wire.mjs';
import { t } from '../i18n.mjs';

const embeddedRoot = view => view.parent !== view && new URL(view.location.href).searchParams.has(TAB_PARAM);
export const browserEmbedded = typeof window !== 'undefined' && (() => {
  try { return embeddedRoot(window) || (window.parent !== window && embeddedRoot(window.parent)); }
  catch { return false; }
})();

if (browserEmbedded) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.source === navigator.serviceWorker.controller && event.data?.type === 'pleiad:recover' && embeddedRoot(window)) {
      window.parent.postMessage(event.data, location.origin);
    }
  });
}

export const unavailablePreview = () => t('settings.remote.browser.previewUnavailable');
export const unavailableVoice = () => t('settings.remote.browser.voiceUnavailable');

export function createHostSocket(url) {
  if (!browserEmbedded) return new WebSocket(url);
  const { port1: port, port2 } = new MessageChannel();
  const socket = {
    readyState: WebSocket.CONNECTING,
    send(data) {
      if (socket.readyState === WebSocket.CONNECTING) throw new DOMException('Socket is connecting', 'InvalidStateError');
      if (socket.readyState === WebSocket.OPEN) port.postMessage({ type: 'send', data });
    },
    close(code = 1000, reason = '') {
      if (socket.readyState >= WebSocket.CLOSING) return;
      socket.readyState = WebSocket.CLOSING;
      port.postMessage({ type: 'cancel' });
      finish(code, reason);
    },
  };
  const sw = navigator.serviceWorker;
  const lost = () => finish(1006, 'host view disconnected');
  const timer = setTimeout(lost, 15_000);
  function finish(code, reason) {
    if (socket.readyState === WebSocket.CLOSED) return;
    clearTimeout(timer);
    socket.readyState = WebSocket.CLOSED;
    sw.removeEventListener('controllerchange', lost);
    port.close();
    if (code === 1006) socket.onerror?.(new Event('error'));
    socket.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }
  port.onmessage = ({ data: message }) => {
    if (message.type === 'open') {
      clearTimeout(timer);
      socket.readyState = WebSocket.OPEN;
      socket.onopen?.(new Event('open'));
    } else if (message.type === 'data') {
      port.postMessage({ type: 'credit', index: message.index });
      socket.onmessage?.(new MessageEvent('message', { data: message.data }));
    } else if (message.type === 'close' || message.type === 'reset') {
      finish(message.type === 'reset' ? 1006 : message.code || 1000, message.reason ?? '');
    }
  };
  sw.addEventListener('controllerchange', lost);
  const controller = sw.controller;
  if (controller) controller.postMessage({ type: 'ws', head: { path: new URL(url).pathname } }, [port2]);
  else queueMicrotask(lost);
  return socket;
}

export function installHostDownloads(onError) {
  if (!browserEmbedded) return;
  document.addEventListener('click', async event => {
    const anchor = event.target.closest?.('a[download][href]');
    if (!anchor || event.defaultPrevented) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || url.protocol !== location.protocol) return;
    event.preventDefault();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
      const save = document.createElement('a');
      save.hidden = true;
      save.download = anchor.download || (encoded ? decodeURIComponent(encoded) : plain) || url.pathname.split('/').pop();
      const objectUrl = URL.createObjectURL(await response.blob());
      save.href = objectUrl;
      document.body.append(save);
      save.click();
      save.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (error) { onError(t('settings.remote.browser.downloadFailed', { error: error.message })); }
  });
}
