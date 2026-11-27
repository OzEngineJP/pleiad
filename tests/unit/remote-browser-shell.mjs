import { mountBrowserHost } from '../../web/remote/browser-shell.mjs';

export const name = 'remote-browser-shell';
export const title = 'ブラウザー端末: 同じ接続で会話の画面を差し替える';

export default async function (t) {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const window = new EventTarget();
  const workers = [];
  class Worker {
    messages = [];
    constructor() { workers.push(this); }
    postMessage(data, ports = []) { this.messages.push({ data, ports }); }
    terminate() { this.terminated = true; }
  }
  for (const [name, value] of Object.entries({ window, Worker, location: { origin: 'https://shell.example.test' } })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const origin = 'https://host.example.test';
  const replies = [];
  const frame = () => ({ contentWindow: { postMessage: (...args) => replies.push(args) } });
  const ready = (frame, sender = origin) => {
    const event = new Event('message');
    Object.assign(event, { origin: sender, source: frame.contentWindow, data: { type: 'pleiad:loader' } });
    window.dispatchEvent(event);
  };
  let remote;
  try {
    const first = frame();
    remote = mountBrowserHost({ iframe: first, hostOrigin: origin, relayUrl: 'wss://relay.example.test/v1/device' });
    ready(first, 'https://wrong.example.test');
    t.ok('別のオリジンには通信ポートを渡さない', replies.length === 0);
    ready(first);
    const binding = workers[0].messages.at(-1).data;
    const second = frame();
    remote.attachFrame(second, 'test-conversation');
    ready(first);
    ready(second);
    t.ok('前の画面を解除し、1 つの接続を使い回す', workers.length === 1 && replies.length === 2 &&
      first.src === 'about:blank' && workers[0].messages.some(({ data }) =>
        data.type === 'unbind' && data.requestsId === binding.requestsId));
    t.ok('次に開く会話をローダーへ渡す', new URL(second.src).searchParams.get('open') === 'test-conversation');
    const pending = remote.taskLink({ action: 'start' }).catch(error => error.message);
    workers[0].onerror();
    t.ok('通信ワーカーが停止すると待機中のタスク操作が終わる', await pending === 'host request cancelled');
  } finally {
    remote?.close();
    for (const [, , ports] of replies) for (const port of ports) port.close();
    for (const worker of workers) for (const { ports } of worker.messages) for (const port of ports) port.close();
    for (const key of ['window', 'Worker', 'location']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
}
