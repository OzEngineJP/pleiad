import net from 'node:net';
import { browserUnifyOn } from '../browser-unify-flag.mjs';
import { createIconFetch } from './icon-fetch.mjs';

export const FAVICON_MAX_BYTES = 64 * 1024;
const CACHE_ORIGINS = 128;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);
const iconExpression = `({ href: document.querySelector('link[rel~="icon"]')?.href || new URL('/favicon.ico', location.href).href, ready: document.readyState === 'complete' })`;
const readyExpression = `({ ready: document.readyState === 'complete' })`;

/** Pleiad pages use kind icons and paths, never an icon resource request. */
export function pleiadPage(url, sessionId, { pages } = {}) {
  try {
    const value = new URL(url);
    if (value.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)) return null;
    if (!Number.isInteger(pages) || pages < 1 || Number(value.port || 80) !== pages) return null;
    const match = /^\/_pleiad\/s\/([^/]+)\/(file|dir|git|plugins|new|attachment)$/.exec(value.pathname);
    if (!match || decodeURIComponent(match[1]) !== sessionId) return null;
    return { kind: match[2], path: value.searchParams.get('path') };
  } catch { return null; }
}

/**
 * 宛先が、ページと同じ host（名前と port）で、その host が localhost か IP の直書きか。
 * このときだけアドレスの検査を外す（手元の開発サーバーの favicon。直書きなので DNS の付け替えでは作れない）。Pleiad の port は除く
 */
export function sameLocalHost(url, page, ports = {}) {
  if (url.host !== page.host || url.protocol !== page.protocol) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname !== 'localhost' && !net.isIP(hostname)) return false;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return ![ports.main, ports.pages, ports.isolated].includes(port);
}

/**
 * @param {object} [deps]
 * @param [deps.emit] (type, payload) => 中継の出来事（relay.onTabEvent）。情報が変わったら 'tab:info'
 * @param [deps.log]  ログの 1 行（URL・題を書かない）
 * @param [deps.fetchResource] 中継側の HTTP クライアント（試験では差し替える）。ブラウザーの Cookie を使わない。
 *   既定は core/chrome/icon-fetch.mjs（名前解決の後の IP を検査し、手元・ネットワークの中のアドレスへは繋がない）
 * @returns 中継が呼ぶ口。tab は { sessionId, targetId, windowId, info（Target の targetInfo の写し）, attach(onEvent) }。
 *   attach は中継自身のセッションをそのタブに付ける（relay.view.attach と同じ形の { sessionId, send, detach } を返す）
 *   - added(tab): タブが会話の範囲に入った
 *   - changed(tab): targetInfo が替わった（URL・題）
 *   - removed({ sessionId, targetId }): タブが無くなった
 *   - list(sessionId): その会話だけの初期一覧（追加した順の写し）
 *   - setPagePorts({ main, pages, isolated }): サーバーの port。設定前は page を null とする。favicon はこの port へ取りに行かない
 */
export function createTabInfo({ emit = () => {}, log = () => {}, enabled = browserUnifyOn(), fetchResource = createIconFetch() } = {}) {
  const tabs = new Map(), icons = new Map();
  let pagePorts = {};
  const key = tab => JSON.stringify([tab.sessionId, tab.targetId]);
  const live = state => tabs.get(key(state.data)) === state;
  const report = () => log('chrome-tab-info: metadata unavailable');
  const notify = state => { if (live(state)) emit('tab:info', { ...state.data, page: state.data.page && { ...state.data.page } }); };
  const run = task => { void task.catch(report); };

  function update(state, tab) {
    const url = tab.info?.url ?? '';
    if (state.data.url !== url) {
      state.generation++;
      state.data.favicon = null;
      state.data.canGoBack = false;
      state.data.canGoForward = false;
    }
    Object.assign(state.data, { url, title: tab.info?.title ?? '', windowId: tab.windowId, page: pleiadPage(url, tab.sessionId, pagePorts) });
    notify(state);
  }

  async function history(state) {
    const ticket = ++state.historyTicket, generation = state.generation;
    const value = await state.own.send('Page.getNavigationHistory');
    if (!live(state) || ticket !== state.historyTicket || generation !== state.generation) return;
    const index = value.currentIndex, length = value.entries?.length ?? 0;
    state.data.canGoBack = Number.isInteger(index) && index > 0;
    state.data.canGoForward = Number.isInteger(index) && index >= 0 && index < length - 1;
    notify(state);
  }

  async function readIcon(href, page) {
    // Chrome maps loadNetworkResource(includeCredentials:false) to same-origin,
    // not omit. Use the relay's HTTP client, which has no browser cookie store.
    // Every hop (redirects too) goes through the address check in icon-fetch.mjs, unless it stays on the page's own literal local host.
    const signal = AbortSignal.timeout(5_000);
    for (let redirect = 0; redirect <= 3; redirect++) {
      const url = new URL(href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname.startsWith('/_pleiad/')) return null;
      const response = await fetchResource(url.href, { credentials: 'omit', redirect: 'manual', cache: 'no-store', signal, local: sameLocalHost(url, page, pagePorts) });
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) return null;
          href = new URL(location, url).href;
          continue;
        }
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (response.status !== 200 || !response.body || !IMAGE_TYPES.has(mime) || Number(response.headers.get('content-length')) > FAVICON_MAX_BYTES) return null;
        const reader = response.body.getReader(), parts = []; let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return size ? `data:${mime};base64,${Buffer.concat(parts).toString('base64')}` : null;
            size += chunk.value.byteLength;
            if (size > FAVICON_MAX_BYTES) return null;
            parts.push(Buffer.from(chunk.value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    }
    return null;
  }

  async function favicon(state, loaded = false) {
    if (!state.frameId) return;
    let page;
    try { page = new URL(state.data.url); } catch { return; }
    if (!['http:', 'https:'].includes(page.protocol)) return;
    const internalPage = state.data.page || page.pathname.startsWith('/_pleiad/');
    if (loaded && internalPage) return;
    const generation = state.generation, loadingTicket = state.loadingTicket;
    const world = await state.own.send('Page.createIsolatedWorld', { frameId: state.frameId, worldName: 'pleiad-tab-info' });
    const evaluated = await state.own.send('Runtime.evaluate', { expression: internalPage ? readyExpression : iconExpression, contextId: world.executionContextId, returnByValue: true });
    const result = evaluated.result?.value;
    if (!live(state) || generation !== state.generation) return;
    if (!loaded && result && loadingTicket === state.loadingTicket) { state.data.loading = !result.ready; notify(state); }
    if (internalPage) return;
    if (!loaded && !result?.ready) return;
    let href;
    try {
      href = new URL(result?.href || '/favicon.ico', page);
      if (!['http:', 'https:'].includes(href.protocol) || href.username || href.password || href.pathname.startsWith('/_pleiad/')) return;
    } catch { return; }
    if (state.iconPending === generation) return;
    state.iconPending = generation;
    try {
      let icon;
      if (icons.has(page.origin)) icon = icons.get(page.origin);
      else {
        icon = await readIcon(href.href, page);
        if (!live(state) || generation !== state.generation) return;
        if (icons.size >= CACHE_ORIGINS) icons.delete(icons.keys().next().value);
        icons.set(page.origin, icon);
      }
      if (live(state) && generation === state.generation) { state.data.favicon = icon; notify(state); }
    } finally { if (state.iconPending === generation) state.iconPending = null; }
  }

  function event(state, method, params = {}) {
    if (!live(state)) return;
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      state.frameId = params.frame.id;
      state.generation++;
      if (state.own) run(history(state));
    } else if (method === 'Page.navigatedWithinDocument' && params.frameId === state.frameId) {
      if (state.own) run(history(state));
    } else if (method === 'Page.frameStartedLoading' && params.frameId === state.frameId) {
      state.loadingTicket++;
      state.data.loading = true; notify(state);
    } else if (method === 'Page.frameStoppedLoading' && params.frameId === state.frameId) {
      state.loadingTicket++;
      state.data.loading = false; notify(state);
      if (state.own) { run(history(state)); run(favicon(state, true)); }
    }
  }

  async function connect(state, tab) {
    const own = await tab.attach((method, params) => event(state, method, params));
    if (!live(state)) { await own.detach(); return; }
    state.own = own;
    await own.send('Page.enable');
    const generation = state.generation;
    const tree = await own.send('Page.getFrameTree');
    if (!live(state)) return;
    if (generation === state.generation) state.frameId = tree.frameTree?.frame?.id;
    run(history(state));
    await favicon(state);
  }

  return {
    added(tab) {
      if (!enabled || !tab?.sessionId || !tab.targetId || typeof tab.attach !== 'function') return;
      if (tabs.has(key(tab))) return;
      const state = { data: { sessionId: tab.sessionId, targetId: tab.targetId, windowId: tab.windowId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, favicon: null, page: null }, generation: 0, historyTicket: 0, loadingTicket: 0, own: null };
      tabs.set(key(tab), state);
      update(state, tab);
      run(connect(state, tab));
    },
    changed(tab) {
      if (!enabled || !tab?.sessionId || !tab.targetId) return;
      const state = tabs.get(key(tab));
      if (!state) return;
      const oldUrl = state.data.url;
      update(state, tab);
      if (state.own && oldUrl !== state.data.url) { run(history(state)); run(favicon(state)); }
    },
    removed(tab) {
      if (!enabled || !tab?.sessionId || !tab.targetId) return;
      const state = tabs.get(key(tab));
      if (!state) return;
      tabs.delete(key(tab));
      if (state.own) run(state.own.detach());
      emit('tab:info', { sessionId: tab.sessionId, targetId: tab.targetId, removed: true });
      if (!tabs.size) icons.clear();
    },
    // Initial ordered snapshots are explicitly scoped, including after reconnect.
    list(sessionId) { return [...tabs.values()].filter(s => s.data.sessionId === sessionId).map(s => ({ ...s.data, page: s.data.page && { ...s.data.page } })); },
    // The relay's constructor has no ports dependency; the server supplies the page listener after binding.
    setPagePorts({ main, pages, isolated } = {}) {
      pagePorts = { main, pages, isolated };
      for (const state of tabs.values()) {
        state.data.page = pleiadPage(state.data.url, state.data.sessionId, pagePorts);
        notify(state);
      }
    },
  };
}
