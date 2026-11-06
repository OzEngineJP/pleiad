import path from 'node:path';
import { classifyAddressInput, resolveAddressInput } from './address-input.mjs';
import { listTreeFolder } from './file-preview.mjs';
import { readSearchProvider, searchUrl } from './chrome/search-provider.mjs';

// pageResult: 画面が確認と書き込みを終えた、ページからの頼み（worktree）の結果をページへ返す（core/page-requests.mjs の result）
// pageEnv: 画面のテーマの変化をファイルのページへ知らせる（言語はサーバーの既定なので savePref が知らせる）
export const BROWSER_UNIFY_COMMANDS = new Set(['vizOnce', 'chromeAddress', 'pageResult', 'pageEnv']);
export const isBrowserUnifyCommand = command => BROWSER_UNIFY_COMMANDS.has(command);

/** Only authenticated connections explicitly watching this conversation receive tab data. */
export function createBrowserUnifyWs(deps = {}) {
  const relay = deps.relay;
  const screens = new WeakMap(); let nextScreen = 0;
  const clientId = client => { if (!screens.has(client)) screens.set(client, `screen:${++nextScreen}`); return screens.get(client); };
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const send = (client, event) => {
    if (client.readyState !== undefined && client.readyState !== client.OPEN) return;
    const message = JSON.stringify({ kind: 'event', event });
    client.send(deps.mask ? deps.mask(message) : message);
  };
  const allowed = (client, id) => Boolean(id && deps.clients?.().has(client) && deps.watching?.(client) === id);
  const unsubscribe = relay?.onTabEvent((type, payload) => {
    if (!['tab:info', 'tab:holder', 'tab:page-request', 'tab:viewport'].includes(type)) return;
    for (const client of deps.clients?.() ?? []) {
      if (!allowed(client, payload.sessionId)) continue;
      if (type === 'tab:page-request' && (!payload.by || payload.by !== clientId(client))) continue;
      send(client, { ...payload, type });
    }
  });
  async function options(sessionId) {
    return { cwd: await deps.cwd?.(sessionId), access: await deps.access?.(sessionId) };
  }
  function pageUrl(sessionId, page, file) {
    const port = deps.ports?.().pages;
    if (!port) fail('UNSUPPORTED');
    const url = new URL(`http://localhost:${port}/_pleiad/s/${encodeURIComponent(sessionId)}/${page}`);
    if (file) url.searchParams.set('path', file);
    return url.href;
  }
  async function destination(sessionId, input) {
    const resolved = await resolveAddressInput(input, await options(sessionId));
    if (resolved.kind === 'blocked') fail(resolved.code);
    if (resolved.kind === 'path') return pageUrl(sessionId, resolved.page, resolved.path);
    if (resolved.kind === 'search') return searchUrl(resolved.query, await readSearchProvider(await deps.profileDir?.(sessionId)));
    return resolved.url;
  }
  async function navigate(args, { by = null } = {}) {
    const { sessionId, targetId, action = 'navigate', input } = args;
    if (!relay) fail('UNSUPPORTED');
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) fail('INVALID');
    const url = action === 'new' && input == null ? pageUrl(sessionId, 'new') : ['new', 'navigate'].includes(action) ? await destination(sessionId, input) : null;
    if (action === 'new' || (!targetId && action === 'navigate')) {
      const opened = await relay.openForConversation(sessionId, url === 'about:blank' ? pageUrl(sessionId, 'new') : url);
      const id = opened?.targetId ?? opened?.tabId;
      if (id) relay.unify.tabHolder.touch({ sessionId, targetId: id, by });
      if (id && url === 'about:blank') {
        const attached = await relay.view.attach(sessionId, id, () => {});
        try { await attached.send('Page.navigate', { url }); } finally { await attached.detach(); }
      }
      return { targetId: id ?? null };
    }
    if (!relay.unify.tabInfo.list(sessionId).some(tab => tab.targetId === targetId)) fail('NO_WINDOW');
    relay.unify.tabHolder.touch({ sessionId, targetId, by });
    if (action === 'close') { await relay.view.closeTab(sessionId, targetId); return {}; }
    const attached = await relay.view.attach(sessionId, targetId, () => {});
    try {
      if (action === 'navigate') await attached.send('Page.navigate', { url });
      else if (action === 'reload') await attached.send('Page.reload');
      else if (action === 'back' || action === 'forward') {
        const history = await attached.send('Page.getNavigationHistory');
        const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
        if (entry) await attached.send('Page.navigateToHistoryEntry', { entryId: entry.id });
      } else if (action === 'tree' || action === 'view') {
        const tab = relay.unify.tabInfo.list(sessionId).find(tab => tab.targetId === targetId);
        if (tab?.page?.kind !== 'file') fail('INVALID');
        const detail = action === 'tree' ? { type: 'tree' } : { type: 'view', view: args.view === 'source' ? 'source' : 'preview' };
        const expression = action === 'view'
          ? `(() => { const url = new URL(location.href); url.searchParams.set('view', ${JSON.stringify(detail.view)}); history.replaceState(null, '', url); window.dispatchEvent(new CustomEvent('pleiad:page-command',{detail:${JSON.stringify(detail)}})); })()`
          : `window.dispatchEvent(new CustomEvent('pleiad:page-command',{detail:${JSON.stringify(detail)}}))`;
        await attached.send('Runtime.evaluate', { expression });
      } else fail('INVALID');
    } finally { await attached.detach(); }
    return {};
  }
  return {
    navigate, clientId,
    snapshot(client, sessionId) {
      if (!allowed(client, sessionId)) return;
      send(client, { type: 'tab:info', sessionId, reset: true, tabs: relay?.unify.tabInfo.list(sessionId) ?? [] });
    },
    close() { unsubscribe?.(); },
    async handle({ command, args, client }) {
      if (command === 'pageResult') {
        // 頼みは、その会話を見ている画面（by）にだけ届けている。見ていない接続からの結果は受けない
        if (!args || typeof args !== 'object' || !allowed(client, args.sessionId)) fail('INVALID');
        const { sessionId, targetId, requestId, ok, result, error } = args;
        return { delivered: await (deps.pageRequests?.result({ sessionId, targetId, requestId, ok, result, error }) ?? false) };
      }
      if (command === 'pageEnv') {
        if (!['auto', 'light', 'dark'].includes(args?.theme)) fail('INVALID');
        return { tabs: await (deps.pageRequests?.env({ theme: args.theme }) ?? 0) };
      }
      if (command === 'vizOnce') {
        const origins = args?.origins;
        if (!Array.isArray(origins) || origins.length > 50 || !origins.every(o => typeof o === 'string' && o.length <= 2048)) fail('INVALID');
        return { token: deps.isolatedRoutes?.once(origins) ?? null };
      }
      if (command !== 'chromeAddress') fail('UNKNOWN_COMMAND');
      if (typeof args?.input !== 'string' || args.input.length > 8192 || typeof args.sessionId !== 'string' || !args.sessionId) fail('INVALID');
      if (args.thumbnail === true) {
        if (!relay?.unify.tabInfo.list(args.sessionId).some(tab => tab.targetId === args.targetId)) fail('NO_WINDOW');
        const attached = await relay.view.attach(args.sessionId, args.targetId, () => {});
        try { return await attached.send('Page.captureScreenshot', { format:'jpeg', quality:30, captureBeyondViewport:false }); }
        finally { await attached.detach(); }
      }
      const opts = await options(args.sessionId);
      const classified = classifyAddressInput(args.input, opts);
      if (classified.kind !== 'path') return { suggestions: [], ...(classified.kind === 'blocked' ? { reason: classified.code } : {}) };
      const paths = process.platform === 'win32' ? path.win32 : path.posix;
      const trailing = /[\\/]$/.test(args.input);
      const folder = trailing ? classified.path : paths.dirname(classified.path);
      const prefix = trailing ? '' : paths.basename(classified.path).toLowerCase();
      try {
        const matches = []; let offset = 0;
        do {
          const listing = await listTreeFolder(folder, { access: opts.access, offset });
          matches.push(...listing.children.filter(entry => entry.name.toLowerCase().startsWith(prefix)));
          offset = listing.next;
        } while (matches.length < 8 && offset != null);
        const suggestions = matches.slice(0, 8).map(entry => ({ path: entry.path ?? entry.id, name: entry.name, directory: entry.kind === 'directory' }));
        if (!suggestions.length) {
          const resolved = await resolveAddressInput(args.input, opts);
          if (resolved.kind === 'blocked') return { suggestions, reason:resolved.code };
        }
        return { suggestions };
      } catch {
        const resolved = await resolveAddressInput(args.input, opts);
        return { suggestions: [], reason: resolved.kind === 'blocked' ? resolved.code : 'not-found' };
      }
    },
  };
}
