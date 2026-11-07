/** Screen-owned pages. Chrome targets are attached only by an explicit display change. */
export function createPageTabs({ pageOpen, origin, changed = () => {} }) {
  const sessions = new Map(); let serial = 0;
  const list = id => sessions.get(id) ?? [];
  async function open(input, replace = null) {
    const { sessionId, kind = 'new', path, vizHash, entry } = input;
    let page;
    if (kind === 'viz' || (kind === 'file' && /\.html?$/i.test(path ?? ''))) {
      page = await pageOpen({ sessionId, kind, ...(path ? { path } : {}), ...(vizHash ? { vizHash, entry } : {}) });
      const url = new URL(page.url, origin);
      if (url.origin !== page.origin || !['file', 'viz'].includes(page.kind)) throw new Error('invalid-url');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
      page = { ...page, url:url.href };
    } else {
      if (!['file', 'dir', 'git', 'plugins', 'new', 'attachment'].includes(kind)) throw new Error('invalid-url');
      const url = new URL(`/_pleiad/s/${encodeURIComponent(sessionId)}/${kind}`, origin);
      if (path) url.searchParams.set('path', path);
      if (input.line) url.searchParams.set('line', input.line);
      page = { url:url.href, origin, kind, path, title:input.title ?? '' };
    }
    const tab = replace ?? { targetId:`page:${++serial}`, sessionId, local:true, mode:'page', history:[], position:-1 };
    Object.assign(tab, { url:page.url, title:page.title, page:{ kind:page.kind, path:page.path }, origin:page.origin,
      request:{ sessionId, kind, path, vizHash, entry }, touched:false, dirty:false, pending:false });
    tab.history.splice(++tab.position); tab.history.push(page);
    tab.canGoBack = tab.position > 0; tab.canGoForward = false;
    if (!replace) sessions.set(sessionId, [...list(sessionId), tab]);
    changed(tab); return tab;
  }
  function activity(tab, input = false) { tab.touched = true; if (input) tab.dirty = true; }
  function reload(tab) { tab.pending = false; tab.touched = false; tab.dirty = false; tab.reload = (tab.reload ?? 0) + 1; changed(tab); }
  function event(message) {
    for (const tab of list(message.sessionId)) {
      if (message.type === 'page:changed' && tab.page.path === message.path) {
        if (tab.touched) { tab.pending = true; changed(tab); } else reload(tab);
      }
      if (message.type === 'page:moved') {
        let next; try { next = new URL(message.to, origin); } catch { continue; }
        if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) continue;
        for (const item of tab.history) if (item.url === message.from) { item.url = next.href; item.origin = next.origin; }
        if (tab.url !== message.from) continue;
        tab.url = next.href; tab.origin = next.origin;
        tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, origin:tab.origin };
        if (tab.dirty) tab.pending = true; else reload(tab);
        changed(tab);
      }
    }
  }
  function travel(tab, direction) {
    const position = tab.position + direction, page = tab.history[position]; if (!page) return;
    tab.position = position; Object.assign(tab, { url:page.url, title:page.title, origin:page.origin, page:{ kind:page.kind, path:page.path }, touched:false, dirty:false, pending:false });
    tab.canGoBack = position > 0; tab.canGoForward = position < tab.history.length - 1; changed(tab);
  }
  return { list, open, activity, reload, event, travel,
    close(tab) { sessions.set(tab.sessionId, list(tab.sessionId).filter(item => item !== tab)); changed(tab); } };
}
