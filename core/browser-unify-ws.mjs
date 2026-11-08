import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyAddressInput, resolveAddressInput } from './address-input.mjs';
import { inspectFile, listTreeFolder } from './file-preview.mjs';
import { isHash } from './viz-bundle.mjs';
import { fileMark, vizMark, LOCALHOST_MARK } from './isolated-origins.mjs';
import { readSearchProvider, searchUrl } from './chrome/search-provider.mjs';

// pageResult: 画面が確認と書き込みを終えた、ページからの頼み（worktree）の結果をページへ返す（core/page-requests.mjs の result）
// pageEnv: 画面のテーマの変化をファイルのページへ知らせる（言語はサーバーの既定なので savePref が知らせる）
// pageOpen: ページ・HTML・可視化の開く先をサーバーが決める（ADR 0295 の 7。画面は port や URL を組み立てない）
export const BROWSER_UNIFY_COMMANDS = new Set(['vizOnce', 'chromeAddress', 'pageResult', 'pageEnv', 'pageOpen', 'pageResolve', 'pageWatch']);
export const isBrowserUnifyCommand = command => BROWSER_UNIFY_COMMANDS.has(command);

/** Only authenticated connections explicitly watching this conversation receive tab data. */
export function createBrowserUnifyWs(deps = {}) {
  const relay = deps.relay;
  const screens = new WeakMap(); let nextScreen = 0;
  const clientId = client => { if (!screens.has(client)) screens.set(client, `screen:${++nextScreen}`); return screens.get(client); };
  // 見張りの持ち主（core/page-watch.mjs の owner）は「画面の id/タブの id」。タブを閉じたとき・画面が切れたときにその分だけ外れる
  const ownerOf = (client, tab) => `${clientId(client)}/${typeof tab === 'string' && tab ? tab : '·'}`;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const send = (client, event) => {
    if (client.readyState !== undefined && client.readyState !== client.OPEN) return;
    const message = JSON.stringify({ kind: 'event', event });
    client.send(deps.mask ? deps.mask(message) : message);
  };
  // タブ情報の届け先は「見ている会話とその子孫」（inapp-browser.md。親が子の Chrome を会話を移らずに見る）
  const scope = client => {
    const id = deps.watching?.(client);
    if (typeof id !== 'string' || !id) return [];
    return [id, ...(deps.descendants?.(id) ?? []).filter(value => typeof value === 'string' && value && value !== id)];
  };
  const allowed = (client, id) => Boolean(id && deps.clients?.().has(client) && scope(client).includes(id));
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
  function pageUrl(sessionId, page, file, owner = null) {
    const port = deps.ports?.().pages;
    if (!port) fail('UNSUPPORTED');
    const url = new URL(`http://localhost:${port}/_pleiad/s/${encodeURIComponent(sessionId)}/${page}`);
    if (file) url.searchParams.set('path', file);
    if (owner && owner !== '·') url.searchParams.set('watchOwner', owner);
    return url.href;
  }
  async function destination(sessionId, input) {
    const resolved = await resolveAddressInput(input, await options(sessionId));
    if (resolved.kind === 'blocked') fail(resolved.code);
    if (resolved.kind === 'path') return pageUrl(sessionId, resolved.page, resolved.path);
    if (resolved.kind === 'search') return searchUrl(resolved.query, await readSearchProvider(await deps.profileDir?.(sessionId)));
    return resolved.url;
  }
  /** 束の目録の相対パスを、登録の通りの綴りに直す（大小文字は 1 つに決まるときだけ。core/isolated-routes.mjs と同じ規則） */
  const manifestRel = (files, rel) => {
    if (Object.hasOwn(files, rel)) return rel;
    const matches = Object.keys(files).filter(key => key.toLowerCase() === rel.toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  };
  const PAGE_KINDS = new Set(['file', 'dir', 'git', 'plugins', 'new', 'attachment']);
  /**
   * 「開く先」を決める（pageOpen）。返り値:
   *   - ページ:   { kind, path?, suffix, url }。url はファイルのページの port の URL、suffix は Chrome の無い画面が
   *     本体と同じ出どころで使う /_pleiad/…
   *   - HTML:    { kind:'html', path, key, url }。url はフォルダーの印の出どころ（f<印>.localhost）
   *   - 可視化:  { kind:'viz', hash, entry, url }。url は束の印の出どころ（v<印>.localhost）
   * ページの対象は変化の見張り（core/page-watch.mjs）に登録する（開いたファイルが変わったら page:changed）
   */
  async function openTarget(sessionId, input, owner = '·') {
    const ports = deps.ports?.() ?? {};
    if (!ports.pages || !ports.isolated) fail('UNSUPPORTED');
    const kind = typeof input?.kind === 'string' ? input.kind : '';
    const title = typeof input?.title === 'string' ? input.title.slice(0, 200) : '';
    if (PAGE_KINDS.has(kind) || kind === 'html') {
      let file = null, page = kind, cwd = null;
      if (kind === 'html' || ['file', 'dir', 'attachment'].includes(kind)) {
        const opts = await options(sessionId);
        const resolved = await resolveAddressInput(typeof input?.path === 'string' ? input.path : '', opts);
        if (resolved.kind === 'blocked') fail(resolved.code);
        if (resolved.kind !== 'path') fail('INVALID');
        file = resolved.path;
        cwd = opts?.cwd ?? null;
        if (kind !== 'attachment' && kind !== 'html') page = resolved.page;
      }
      if (kind === 'html') {
        const access = await deps.access?.(sessionId) ?? null;
        const checked = await inspectFile(file, access ?? {});
        if (checked === 'denied' || !/\.html?$/i.test(checked.file)) fail('INVALID');
        const key = deps.htmlKeys?.issue({ sessionId, path: checked.file, once: Array.isArray(input?.once) ? input.once.slice(0, 50) : [] });
        if (!key || !deps.secret) fail('UNAVAILABLE');
        deps.pageWatch?.add(sessionId, checked.file, 'file', owner);
        const suffix = title ? `?title=${encodeURIComponent(title)}` : '';
        return { kind: 'html', path: checked.file, key, cwd: cwd ?? undefined,
          url: `http://${fileMark(deps.secret, path.dirname(checked.file))}.localhost:${ports.isolated}/f/${encodeURIComponent(key)}/${encodeURIComponent(path.basename(checked.file))}${suffix}` };
      }
      if (file) deps.pageWatch?.add(sessionId, file, page === 'dir' ? 'dir' : 'file', owner);
      const url = new URL(pageUrl(sessionId, page, file, owner));
      if (/^\d{1,9}$/.test(String(input?.line ?? ''))) url.searchParams.set('line', String(input.line));
      return { kind: page, path: file ?? undefined, cwd: cwd ?? undefined, suffix: `${url.pathname}${url.search}`, url: url.href };
    }
    if (kind === 'viz') {
      const hash = typeof input?.hash === 'string' ? input.hash.toLowerCase() : '';
      if (!isHash(hash)) fail('INVALID');
      const files = await deps.isolatedRoutes?.manifest?.(hash);
      const rel = files && manifestRel(files, typeof input?.entry === 'string' && input.entry ? input.entry.replaceAll('\\', '/') : 'index.html');
      if (!rel) fail('NOT_FOUND');
      // 元のファイルはクライアントの送った値でなく、会話の記録にある束の持ち主の行から決める（指摘 6）
      const source = await deps.vizSource?.(sessionId, hash).catch(() => null);
      const params = new URLSearchParams({ embed: 'tab', ...(title ? { title } : {}) });
      return { kind: 'viz', hash, entry: rel, title: title || rel, path: source?.path ?? undefined,
        url: `http://${vizMark(hash)}.localhost:${ports.isolated}/viz/${hash}/${rel.split('/').map(encodeURIComponent).join('/')}?${params}` };
    }
    fail('INVALID');
  }

  /**
   * 隔離の origin の URL を、開いている対象（ファイルのパス・束）へ戻す（pageResolve）。
   * ページ内の移動で親が受け取った URL を確かめ、ファイルなら変化の見張りにも登り直す
   */
  async function resolvePageLocation(sessionId, raw, owner = null) {
    let parsed;
    try { parsed = new URL(String(raw ?? '')); } catch { fail('INVALID'); }
    const isolated = deps.ports?.().isolated;
    if (!isolated || parsed.protocol !== 'http:' || parsed.port !== String(isolated)) fail('INVALID');
    if (!(parsed.hostname === 'localhost' || LOCALHOST_MARK.test(parsed.hostname))) fail('INVALID');
    const parts = parsed.pathname.split('/').slice(1).map(part => { try { return decodeURIComponent(part); } catch { return null; } });
    if (parts.some(part => part === null)) fail('INVALID');
    if (parts[0] === 'viz' && isHash(parts[1] ?? '')) {
      const hash = parts[1];
      if (parsed.hostname !== 'localhost' && parsed.hostname !== `${vizMark(hash)}.localhost`) fail('INVALID');
      const files = await deps.isolatedRoutes?.manifest?.(hash).catch(() => null);
      if (!files) fail('NOT_FOUND');
      const entry = manifestRel(files, parts.slice(2).join('/') || 'index.html');
      if (!entry) fail('NOT_FOUND');
      return { kind: 'viz', hash, entry };
    }
    if (parts[0] === 'f' && /^[A-Za-z0-9_-]{40,8192}$/.test(parts[1] ?? '')) {
      const held = deps.htmlKeys?.resolve?.(parts[1]);
      if (!held?.root) fail('NOT_FOUND');
      if (held.sessionId && held.sessionId !== sessionId) fail('INVALID');
      if (parsed.hostname !== 'localhost' && parsed.hostname !== `${fileMark(deps.secret, held.root)}.localhost`) fail('INVALID');
      // ドットで始まる名前（.env・.git など）は開いている対象としても認めない（serveFile と同じ。指摘 7）
      const rel = parts.slice(2).filter(part => part && part !== '.' && part !== '..');
      if (rel.some(part => part.startsWith('.'))) fail('NOT_FOUND');
      const file = path.join(held.root, ...rel);
      if (rel.length && file !== held.root && !file.startsWith(held.root + path.sep)) fail('INVALID');
      const access = await deps.access?.(sessionId) ?? null;
      // 実体のパスが鍵のフォルダーの中にあることを realpath で確かめる（シンボリックリンク・ジャンクションで外へ出させない）
      let checked, root;
      try {
        root = await fs.realpath(held.root);
        checked = await inspectFile(rel.length ? path.join(root, ...rel) : path.join(root, held.entry), access ?? {});
      } catch { fail('NOT_FOUND'); }
      if (!checked || checked === 'denied') fail('NOT_FOUND');
      const real = await fs.realpath(checked.file).catch(() => null);
      if (!real) fail('NOT_FOUND');
      const inside = path.relative(
        process.platform === 'win32' ? root.toLowerCase() : root,
        process.platform === 'win32' ? real.toLowerCase() : real);
      if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) fail('NOT_FOUND');
      if (inside.split(/[\\/]/).some(part => part.startsWith('.'))) fail('NOT_FOUND');
      // 開いている対象として追うのは HTML の文書だけ（.md や画像を「そのファイルのページ」として登録しない）
      if (!checked.stat?.isFile?.() || !/\.html?$/i.test(checked.file)) fail('NOT_FOUND');
      if (owner) deps.pageWatch?.add(sessionId, checked.file, 'file', owner);
      return { kind: 'html', path: checked.file };
    }
    fail('NOT_FOUND');
  }
  /** 隔離の /f/<鍵>/… の URL が出しているファイルのパス（pageChanged で中身と比べる）。鍵が開けなければ null */
  function htmlTabPath(raw) {
    let parsed;
    try { parsed = new URL(String(raw ?? '')); } catch { return null; }
    const isolated = deps.ports?.().isolated;
    if (!isolated || parsed.port !== String(isolated)) return null;
    const parts = parsed.pathname.split('/').slice(1).map(part => { try { return decodeURIComponent(part); } catch { return null; } });
    if (parts[0] !== 'f' || !/^[A-Za-z0-9_-]{40,8192}$/.test(parts[1] ?? '')) return null;
    const held = deps.htmlKeys?.resolve?.(parts[1]);
    if (!held?.root) return null;
    const rel = parts.slice(2).filter(part => part && part !== '.' && part !== '..');
    return path.join(held.root, ...(rel.length ? rel : [held.entry]));
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
      } else if (action === 'view') {
        const tab = relay.unify.tabInfo.list(sessionId).find(tab => tab.targetId === targetId);
        if (tab?.page?.kind !== 'file') fail('INVALID');
        const detail = { type: 'view', view: args.view === 'source' ? 'source' : 'preview' };
        await attached.send('Runtime.evaluate', { expression:
          `(() => { const url = new URL(location.href); url.searchParams.set('view', ${JSON.stringify(detail.view)}); history.replaceState(null, '', url); window.dispatchEvent(new CustomEvent('pleiad:page-command',{detail:${JSON.stringify(detail)}})); })()` });
      } else fail('INVALID');
    } finally { await attached.detach(); }
    // どのタブへ届けたかを応答に入れる（画面は移動後のタブの情報を知る。新規は上で返す）
    return { targetId };
  }
  return {
    navigate, clientId,
    /** 追っていたファイルが変わった（core/page-watch.mjs の emit から）。その会話を見ている画面と、そのファイルを出しているタブへだけ */
    pageChanged(sessionId, filePath) {
      if (typeof sessionId !== 'string' || !sessionId || typeof filePath !== 'string' || !filePath) return;
      for (const client of deps.clients?.() ?? []) if (allowed(client, sessionId)) send(client, { type: 'page:changed', sessionId, path: filePath });
      const norm = value => String(value ?? '').replaceAll('\\', '/');
      const target = process.platform === 'win32' ? norm(filePath).toLowerCase() : norm(filePath);
      const same = value => (process.platform === 'win32' ? norm(value).toLowerCase() : norm(value)) === target;
      for (const tab of relay?.unify.tabInfo.list(sessionId) ?? []) {
        if (!['file', 'dir', 'html'].includes(tab.page?.kind)) continue;
        if (tab.page.kind === 'html') {
          // 隔離の /f/<鍵>/ のタブ: 鍵を開いて中身のパスと比べる。人が操作中のタブは画面の「更新を表示」に任せる
          const shown = htmlTabPath(tab.url);
          if (!shown || !same(shown)) continue;
          if (relay?.unify.tabHolder?.holder?.(sessionId, tab.targetId)?.holder === 'human') continue;
          void (async () => {
            try {
              const attached = await relay.view.attach(sessionId, tab.targetId, () => {});
              try { await attached.send('Runtime.evaluate', { expression: 'location.reload()' }); }
              finally { await attached.detach(); }
            } catch { /* タブは既に無い・まだページを読んでいない */ }
          })();
          continue;
        }
        if (!same(tab.page?.path)) continue;
        // 読み直すか「更新を表示」を出すかはページが決める（web/pages/app.mjs。触っていなければ読み直す）
        void (async () => {
          try {
            const attached = await relay.view.attach(sessionId, tab.targetId, () => {});
            try { await attached.send('Runtime.evaluate', { expression: `window.dispatchEvent(new CustomEvent('pleiad:page-command',{detail:${JSON.stringify({ type: 'changed' })}}))` }); }
            finally { await attached.detach(); }
          } catch { /* タブは既に無い・まだページを読んでいない */ }
        })();
      }
    },
    /**
     * pages・isolated の port が替わった・サーバーが入れ替わった（server.mjs の startPageListeners から）。
     * Chrome に残っているタブを新しい URL へ移し（core/chrome/relay.mjs の migratePageTabs）、
     * 見ている画面へ今の port と前の port を知らせる（画面の中の枠・リンクは画面が張り直す）
     */
    async portsChanged({ previous = {} } = {}) {
      const ports = deps.ports?.() ?? {};
      if (relay?.migratePageTabs && typeof deps.movedUrl === 'function') {
        try {
          const result = await relay.migratePageTabs(deps.movedUrl);
          if (result) deps.log?.(`page tabs: migrated ${result.moved ?? 0}, failed ${result.failed ?? 0}${result.reasons?.length ? ` (${result.reasons.slice(0, 3).join('; ')})` : ''}`);
        }
        catch (error) { deps.log?.(`page tabs: migrate failed: ${String(error?.message ?? error)}`); }
      }
      for (const client of deps.clients?.() ?? []) {
        if (!deps.watching?.(client)) continue;
        send(client, { type: 'page:moved', ports: { pages: ports.pages ?? null, isolated: ports.isolated ?? null },
          previous: { pages: previous.pages ?? [], isolated: previous.isolated ?? [] } });
      }
    },
    snapshot(client, sessionId) {
      if (!allowed(client, sessionId)) return;
      // 見ている会話に続けて子孫それぞれの一覧を送る（親の画面の列が子のタブを出せるように）
      for (const id of scope(client)) {
        send(client, { type: 'tab:info', sessionId: id, reset: true, tabs: relay?.unify.tabInfo.list(id) ?? [] });
        // 開き直した画面にも、人の操作中のタブの札を出す（AI のタブは送らない。画面は tab:info の reset で持ち手を忘れる）
        for (const held of relay?.unify.tabHolder?.held?.(id) ?? []) send(client, { ...held, type: 'tab:holder', sessionId: id });
      }
    },
    /** 画面の接続が切れた: その画面の持ち主ぶんの見張りを外す（ほかの画面の分は残る。server.mjs の detach から） */
    screenClosed(client) {
      const id = screens.get(client);
      if (id) deps.pageWatch?.removeClient?.(id);
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
      if (command === 'pageOpen') {
        // 開く先はサーバーが決める。その会話を見ている画面だけが頼める（allowed は見ている会話かを確かめる）
        if (!args || typeof args !== 'object' || !allowed(client, args.sessionId)) fail('INVALID');
        return openTarget(args.sessionId, args, ownerOf(client, args.tab));
      }
      if (command === 'pageResolve') {
        if (!args || typeof args !== 'object' || !allowed(client, args.sessionId)) fail('INVALID');
        return resolvePageLocation(args.sessionId, args.url, typeof args.tab === 'string' && args.tab ? ownerOf(client, args.tab) : null);
      }
      if (command === 'pageWatch') {
        if (!args || typeof args !== 'object' || !allowed(client, args.sessionId) || typeof args.path !== 'string' || !args.path) fail('INVALID');
        // 外すのはこの画面のこのタブぶんだけ（ほかの画面・タブが同じファイルを見ていても残る。core/page-watch.mjs）
        deps.pageWatch?.remove?.(args.sessionId, args.path, args.kind === 'dir' ? 'dir' : 'file', ownerOf(client, args.tab));
        return { removed: true };
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
