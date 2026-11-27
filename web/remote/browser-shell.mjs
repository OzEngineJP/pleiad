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
  const readyListeners = new Set();
  let binding, closed = false, status = { type: 'status', state: 'connecting' };
  let proofId = 0;
  const bind = event => {
    if (!iframe || event.origin !== origin || event.source !== iframe.contentWindow || event.data?.type !== 'pleiad:loader') return;
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
      if (data.state === 'ready' || data.state === 'stopped') {
        for (const listener of readyListeners) listener(data.state);
      }
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
  const controls = new MessageChannel();
  worker.postMessage({ type: 'bind' }, [controls.port1]);
  const requests = new Set();
  // The host Service Worker passes the bootstrap route through to the origin.
  if (iframe) iframe.src = new URL(LOADER_PATH, origin).href;
  return {
    taskLink(input, { signal } = {}) {
      if (closed || signal?.aborted) return Promise.reject(new Error('host request cancelled'));
      return new Promise((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        const decoder = new TextDecoder();
        let responseStatus, body = '';
        const finish = (error, result) => {
          clearTimeout(deadline);
          readyListeners.delete(send);
          requests.delete(cancel);
          signal?.removeEventListener('abort', cancel);
          if (error) port1.postMessage({ type: 'cancel' });
          port1.close();
          if (error) reject(error);
          else resolve(result);
        };
        const cancel = () => finish(new Error('host request cancelled'));
        const deadline = setTimeout(cancel, 330_000);
        requests.add(cancel);
        signal?.addEventListener('abort', cancel, { once: true });
        port1.onmessage = ({ data }) => {
          if (data.type === 'response') responseStatus = data.head.status;
          if (data.type === 'data') {
            body += decoder.decode(data.data, { stream: true });
            port1.postMessage({ type: 'credit', index: data.index });
            if (body.length > 4096) cancel();
          }
          if (data.type === 'end') {
            try {
              if (responseStatus !== 200) throw new Error('host denied task link');
              finish(null, JSON.parse(body + decoder.decode()));
            } catch (error) { finish(error); }
          }
          if (data.type === 'reset') finish(new Error('host request disconnected'));
        };
        const send = (state) => {
          readyListeners.delete(send);
          if (state !== 'ready') return cancel();
          controls.port2.postMessage({ type: 'http', head: {
            method: 'POST', path: '/_remote/task-link', taskLink: input,
          } }, [port2]);
        };
        if (status.state === 'ready' || status.state === 'stopped') send(status.state);
        else readyListeners.add(send);
      });
    },
    close() {
      closed = true;
      window.removeEventListener('message', bind);
      binding?.postMessage({ type: 'status', state: 'stopped' });
      binding?.close();
      for (const cancel of requests) cancel();
      controls.port2.close();
      worker.terminate();
      for (const finish of proofs.values()) finish({ error: true });
      proofs.clear();
      if (iframe) iframe.src = 'about:blank';
    },
  };
}
