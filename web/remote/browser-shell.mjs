import { exactOrigin, LOADER_PATH } from './browser-wire.mjs';

/**
 * Attach one host to a shell-owned iframe. getTickets runs on the shell origin.
 * The host origin only receives stream ports.
 */
export function mountBrowserHost({ iframe, hostOrigin, account, hostId, hostKey, relayUrl, name,
  interactive = true, getTickets, onStatus = () => {} }) {
  const origin = exactOrigin(hostOrigin);
  const relay = new URL(relayUrl);
  if (origin === location.origin || relay.username || relay.password || relay.search || relay.hash ||
    (relay.protocol !== 'wss:' && !(relay.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname)))) {
    throw new TypeError('expected separate host origin and a relay WebSocket URL');
  }
  const worker = new Worker(new URL('./browser-worker.mjs', import.meta.url), { type: 'module' });
  const proofs = new Map();
  let binding, closed = false, status = { type: 'status', state: 'connecting' };
  let proofId = 0;
  const bind = event => {
    if (event.origin !== origin || event.source !== iframe.contentWindow || event.data?.type !== 'pleiad:loader') return;
    const { port1, port2 } = new MessageChannel();
    const requests = new MessageChannel();
    binding?.close();
    binding = port1;
    worker.postMessage({ type: 'bind' }, [requests.port1]);
    event.source.postMessage({ type: 'pleiad:bind', state: status.state }, origin, [port2, requests.port2]);
  };
  window.addEventListener('message', bind);
  worker.onmessage = async ({ data }) => {
    if (data.type === 'status') {
      status = data;
      // Approval details belong to the shell, which displays the matching code.
      binding?.postMessage({ type: 'status', state: data.state });
      onStatus(data);
    } else if (data.type === 'proof') {
      proofs.get(data.proofId)?.(data);
    } else if (data.type === 'tickets') {
      const { id, devicePub } = data;
      const outstanding = new Set();
      let tickets;
      try {
        tickets = await getTickets({ hostId, devicePub, origin: location.origin,
          prove(challenge) {
            if (closed) return Promise.reject(new Error('host closed'));
            const request = ++proofId;
            outstanding.add(request);
            return new Promise((resolve, reject) => {
              proofs.set(request, result => result.error ? reject(new Error('invalid ticket challenge')) : resolve(result.proof));
              worker.postMessage({ type: 'proof', id, proofId: request, challenge });
            });
          },
        });
      } catch (error) {
        tickets = { error: 'ticket request failed', retry: error?.retryable === true };
      } finally {
        for (const request of outstanding) {
          proofs.get(request)?.({ error: true });
          proofs.delete(request);
        }
      }
      if (!closed) worker.postMessage({ type: 'tickets', id, tickets });
    }
  };
  worker.onerror = () => {
    status = { type: 'status', state: 'stopped', reason: 'browser communication worker failed' };
    binding?.postMessage({ type: 'status', state: status.state });
    onStatus(status);
  };
  worker.postMessage({ account, hostId, hostKey, relayUrl: relay.href, name, interactive });
  // The host Service Worker passes the bootstrap route through to the origin.
  iframe.src = new URL(LOADER_PATH, origin).href;
  return {
    close() {
      closed = true;
      window.removeEventListener('message', bind);
      binding?.postMessage({ type: 'status', state: 'stopped' });
      binding?.close();
      worker.terminate();
      for (const finish of proofs.values()) finish({ error: true });
      proofs.clear();
      iframe.src = 'about:blank';
    },
  };
}
