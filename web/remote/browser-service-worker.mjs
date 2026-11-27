import { LOADER_PATH, TAB_PARAM } from './browser-wire.mjs';

const pending = new Map();
const bound = new Map();
const bindings = new Map();
const bootstrap = new Set([
  LOADER_PATH, '/_pleiad-remote/loader.mjs', '/_pleiad-remote/browser-loader.mjs',
  '/_pleiad-remote/browser-service-worker.mjs', '/_pleiad-remote/browser-wire.mjs',
  '/_pleiad-remote/browser-recover.mjs',
]);
const denied = () => new Response('Host view is unavailable', { status: 403 });

function requestRecovery(client) {
  if (client && new URL(client.url).searchParams.has(TAB_PARAM)) client.postMessage({ type: 'pleiad:recover' });
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const source = event.source;
  if (!source?.id || new URL(source.url).origin !== location.origin) return;
  const [port, reply] = event.ports;
  if (event.data?.type === 'bind' && new URL(source.url).pathname === LOADER_PATH && reply) {
    event.waitUntil((async () => {
      const live = new Set((await self.clients.matchAll({ type: 'window' })).map(client => client.id));
      for (const [id, route] of bindings) {
        if (id === source.id || !live.has(id)) {
          route.port.close();
          bindings.delete(id);
          pending.delete(route.marker);
        }
      }
      for (const [id, route] of bound) if (!live.has(id) || !bindings.has(route.id) || route.id === source.id) bound.delete(id);
      const marker = crypto.randomUUID();
      const route = { id: source.id, marker, port, expires: Date.now() + 15_000 };
      bindings.set(source.id, route);
      pending.set(marker, route);
      reply.postMessage(marker);
      reply.close();
    })());
  } else if (event.data?.type === 'ws' && port) {
    const route = bound.get(source.id);
    if (route && bindings.get(route.id) === route) route.port.postMessage(event.data, [port]);
    else {
      requestRecovery(source);
      port.postMessage({ type: 'reset', reason: 'host view disconnected' });
      port.close();
    }
  }
});

function request(route, source, path) {
  return new Promise((resolve, reject) => {
    const { port1: port, port2 } = new MessageChannel();
    let controller, ended = false, failed, waiting = false;
    const queue = [];
    const cleanup = () => {
      clearTimeout(deadline);
      source.signal.removeEventListener('abort', cancel);
      port.close();
    };
    const cancel = () => {
      port.postMessage({ type: 'cancel' });
      cleanup();
      const error = new Error('host request cancelled');
      if (controller) controller.error(error);
      else reject(error);
    };
    const deadline = setTimeout(cancel, 30_000);
    const pull = () => {
      if (!waiting || !controller) return;
      if (failed) {
        controller.error(failed);
        cleanup();
      } else if (queue.length) {
        const message = queue.shift();
        controller.enqueue(message.data);
        port.postMessage({ type: 'credit', index: message.index });
      } else if (ended) {
        controller.close();
        cleanup();
      } else return;
      waiting = false;
    };
    if (source.signal.aborted) return cancel();
    source.signal.addEventListener('abort', cancel, { once: true });
    port.onmessage = ({ data }) => {
      if (data.type === 'response') {
        clearTimeout(deadline);
        const { status, headers } = data.head;
        if (status >= 300 && status < 400 && status !== 304) {
          cancel();
          return;
        }
        const body = source.method === 'HEAD' || [204, 205, 304].includes(status) ? null : new ReadableStream({
          start(value) { controller = value; },
          pull() { waiting = true; pull(); },
          cancel() { port.postMessage({ type: 'cancel' }); cleanup(); },
        });
        resolve(new Response(body, { status, headers }));
      } else if (data.type === 'data') queue.push(data);
      else if (data.type === 'end') {
        ended = true;
        if (!controller) cleanup();
      } else if (data.type === 'reset') {
        failed = new Error(data.reason ?? 'host reset ' + data.code);
        if (!controller) { reject(failed); cleanup(); }
        else { controller.error(failed); controller = null; cleanup(); }
      }
      pull();
    };
    route.port.postMessage({ type: 'http', head: {
      method: source.method, path, headers: Object.fromEntries(source.headers),
    } }, [port2]);
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || bootstrap.has(url.pathname)) return;
  const marker = url.searchParams.get(TAB_PARAM);
  let route = bound.get(event.clientId);
  if (event.request.mode === 'navigate') {
    route ??= bound.get(event.replacesClientId);
    if (marker && !route && ['/', '/index.html'].includes(url.pathname)) {
      const grant = pending.get(marker);
      pending.delete(marker);
      if (grant?.expires > Date.now()) route = grant;
    }
    if (route && event.resultingClientId) bound.set(event.resultingClientId, route);
    // Firefox can omit both old client IDs on iframe reload. Ask the verified
    // loader to issue a new single-use grant. This document grants no access.
    if (!route && marker && event.request.destination === 'iframe') {
      event.respondWith(new Response('<!doctype html><script type="module" src="/_pleiad-remote/browser-recover.mjs"></script>',
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }));
      return;
    }
  }
  if (!route || bindings.get(route.id) !== route || !['GET', 'HEAD'].includes(event.request.method)) {
    if (!route && event.clientId && event.request.mode !== 'navigate') {
      event.waitUntil(self.clients.get(event.clientId).then(requestRecovery));
    }
    event.respondWith(denied());
    return;
  }
  url.searchParams.delete(TAB_PARAM);
  event.respondWith(request(route, event.request, url.pathname + url.search)
    .catch(() => new Response('Host connection unavailable', { status: 502 })));
});
