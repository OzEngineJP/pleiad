import { exactOrigin, TAB_PARAM } from './browser-wire.mjs';

/** Run on the host origin in the iframe document provided by the shell. */
export function startHostLoader({ shellOrigin, view, status, entry = '/', serviceWorker = new URL('./browser-service-worker.mjs', import.meta.url) }) {
  const origin = exactOrigin(shellOrigin);
  if (window.parent === window || origin === location.origin) throw new Error('host loader requires a separate shell');
  const target = new URL(entry, location.origin);
  if (target.origin !== location.origin || !['/', '/index.html'].includes(target.pathname)) throw new TypeError('invalid host entry');
  let requests, updates, active, state, binding;

  function show(value) {
    state = value;
    view.hidden = value === 'stopped';
    if (status) {
      status.hidden = value === 'ready';
      status.textContent = ({
        waiting: 'Check the confirmation code on the host.',
        stopped: 'The host connection ended. Check the shell for details.',
      })[value] ?? 'Connecting to the host…';
    }
    if (value === 'ready' && !active) void open();
  }

  async function controller() {
    await navigator.serviceWorker.register(serviceWorker, { type: 'module', scope: '/' });
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller ?? await new Promise((resolve, reject) => {
      function changed() {
        clearTimeout(timer);
        resolve(navigator.serviceWorker.controller);
      }
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        reject(new Error('host view is not controlled by its Service Worker'));
      }, 10_000);
      navigator.serviceWorker.addEventListener('controllerchange', changed, { once: true });
    });
  }

  async function open() {
    if (binding || state !== 'ready') return;
    binding = true;
    try {
      const sw = await controller();
      const streams = new MessageChannel();
      const reply = new MessageChannel();
      const marker = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reply.port1.close(); streams.port1.close(); reject(new Error('host view registration timed out')); }, 10_000);
        reply.port1.onmessage = ({ data }) => {
          clearTimeout(timer);
          reply.port1.close();
          resolve(data);
        };
        streams.port1.onmessage = ({ data, ports }) => requests.postMessage(data, ports);
        sw.postMessage({ type: 'bind' }, [streams.port2, reply.port2]);
      });
      active?.close();
      active = streams.port1;
      target.searchParams.set(TAB_PARAM, marker);
      view.src = target.href;
    } catch {
      show('stopped');
    } finally {
      binding = false;
    }
  }

  window.addEventListener('message', event => {
    if (event.origin === origin && event.source === window.parent && event.data?.type === 'pleiad:bind' && event.ports.length === 2) {
      updates?.close();
      requests?.close();
      [updates, requests] = event.ports;
      updates.onmessage = ({ data }) => { if (data.type === 'status') show(data.state); };
      show(event.data.state);
    } else if (event.origin === location.origin && event.source === view.contentWindow && event.data?.type === 'pleiad:recover') {
      void open();
    }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (active) void open(); });
  window.parent.postMessage({ type: 'pleiad:loader' }, origin);
}
