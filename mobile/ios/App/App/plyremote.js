// ホストの main frame 用の口。アプリがオリジン・受信関数名・端末情報を埋める（ADR 0174）。
(() => {
  const ORIGIN = __PLY_ORIGIN__;
  if (window.top !== window || window.opener || window.origin !== ORIGIN || window.plyRemote) return;
  const handlers = window.webkit && window.webkit.messageHandlers;
  const bridge = handlers && handlers.plyRemoteBridge;
  if (!bridge) return;
  const info = __PLY_INFO__;
  const listeners = new Set();
  let last = null;
  const waiting = new Map();
  let nextId = 0;
  const receive = (text) => {
    let m; try { m = JSON.parse(text); } catch (_) { return; }
    if (m && m.type === 'status') { last = m.status; for (const fn of listeners) { try { fn(last); } catch (_) {} } }
    else if (m && m.type === 'reply' && waiting.has(m.id)) { const done = waiting.get(m.id); waiting.delete(m.id); done(m.result); }
  };
  Object.defineProperty(window, __PLY_RECEIVER__, { value: receive, writable: false, configurable: false, enumerable: false });
  const post = (type, extra) => bridge.postMessage(JSON.stringify(Object.assign({ type }, extra || {})));
  const ask = (type) => new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    post(type, { id });
    setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 120000);
  });
  // 離れている間の通知（ADR 0086）: ページが帯を出し、殻が入にする（Android の remoteScript と同じ口）
  const notify = Object.freeze({
    state: () => ask('notify.state'),
    enable: () => ask('notify.enable'),
    dismiss: () => post('notify.dismiss'),
  });
  const api = Object.freeze({
    hostId: info.hostId, hostName: info.hostName, relay: info.relay, device: info.device, shell: 'mobile',
    status: () => Promise.resolve(last),
    onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    retry: () => { post('retry'); return Promise.resolve(); },
    backToHosts: () => post('back'),
    closeWindow: () => post('back'),
    setTheme: (dark, colors) => post('theme', { dark: dark === true, top: String((colors && colors.top) || ''), bottom: String((colors && colors.bottom) || '') }),
    notify,
  });
  Object.defineProperty(window, 'plyRemote', { value: api, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(window, 'backToHosts', { value: api.backToHosts, writable: false, configurable: false, enumerable: false });
  post('hello');
})();
