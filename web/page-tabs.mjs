import { samePath } from './file-actions.mjs';

/** Screen-owned pages. Chrome targets are attached only by an explicit display change. */
export function createPageTabs({ pageOpen, origin, changed = () => {} }) {
  const sessions = new Map(); let serial = 0;
  const list = id => sessions.get(id) ?? [];
  // 隔離の origin（<印>.localhost:<port>。core/isolated-origins.mjs）。URL はサーバーが pageOpen で決める。
  // 画面が自分で作るのは本体と同じ出どころのページ（/_pleiad/…）だけ
  const MARK = /^[a-z0-9][a-z0-9-]{0,61}\.localhost$/;
  /** 履歴・タブにつけるページの印。可視化は束の場所（hash・entry）、HTML は題も持つ（アドレスバーが出す） */
  const tabPage = page => ({ kind:page.kind, path:page.path,
    ...(page.vizHash ? { vizHash:page.vizHash, entry:page.entry } : {}),
    ...(page.title ? { title:page.title } : {}) });
  async function open(input, replace = null) {
    const { sessionId, kind = 'new', path, vizHash, hash, entry } = input;
    let page;
    if (kind === 'viz' || kind === 'html' || (kind === 'file' && /\.html?$/i.test(path ?? ''))) {
      let opened;
      if (kind === 'html' && !path && input.url) {
        // Chrome のタブを「ページ」へ戻すとき、サーバーが決めた隔離の URL を引き継ぐ（鍵は URL の中なので再発行は要らない）
        const at = new URL(input.url, origin);
        if (at.hostname !== 'localhost' && !MARK.test(at.hostname.toLowerCase())) throw new Error('invalid-url');
        opened = { kind: 'html', url: at.href };
      } else {
        // 開く先はサーバーが決める（core/browser-unify-ws.mjs の pageOpen。可視化は hash、HTML のファイルは kind:'html'）
        const request = kind === 'viz'
          ? { sessionId, kind: 'viz', hash: String(vizHash ?? hash ?? ''), ...(entry ? { entry } : {}), ...(input.title ? { title: input.title } : {}) }
          : { sessionId, kind: 'html', path, ...(input.title ? { title: input.title } : {}) };
        opened = await pageOpen(request);
      }
      const url = new URL(opened?.url ?? '', origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
      if (!['viz', 'html'].includes(opened?.kind)) throw new Error('invalid-url');
      page = { url: url.href, origin: url.origin, kind: opened.kind, path: opened.path,
        vizHash: opened.hash ?? (kind === 'viz' ? vizHash ?? hash : undefined), entry: opened.entry ?? entry,
        title: input.title ?? url.searchParams.get('title') ?? '' };
    } else {
      if (!['file', 'dir', 'git', 'plugins', 'new', 'attachment'].includes(kind)) throw new Error('invalid-url');
      const url = new URL(`/_pleiad/s/${encodeURIComponent(sessionId)}/${kind}`, origin);
      if (path) url.searchParams.set('path', path);
      if (input.line) url.searchParams.set('line', input.line);
      page = { url: url.href, origin, kind, path, title: input.title ?? '' };
    }
    const tab = replace ?? { targetId:`page:${++serial}`, sessionId, local:true, mode:'page', history:[], position:-1 };
    Object.assign(tab, { url:page.url, title:page.title, page:tabPage(page), origin:page.origin,
      request:{ sessionId, kind, path, vizHash:vizHash ?? hash, entry }, touched:false, dirty:false, pending:false });
    tab.history.splice(++tab.position); tab.history.push(page);
    tab.canGoBack = tab.position > 0; tab.canGoForward = false;
    if (!replace) sessions.set(sessionId, [...list(sessionId), tab]);
    changed(tab); return tab;
  }
  function activity(tab, input = false) { tab.touched = true; if (input) tab.dirty = true; }
  function reload(tab) { tab.pending = false; tab.touched = false; tab.dirty = false; tab.reload = (tab.reload ?? 0) + 1; changed(tab); }
  /** page:moved の前の port の URL を今の port へ付け替える（core/isolated-origins.mjs の movedPageUrl と同じ決まり。印は port に依らないので変わらない） */
  function moved(value, { previous = {}, ports = {} } = {}) {
    let url; try { url = new URL(value); } catch { return null; }
    const host = url.hostname.toLowerCase();
    if (host !== 'localhost' && !MARK.test(host)) return null;
    const port = Number(url.port || 80);
    const to = [previous.isolated ?? []].flat().includes(port) ? ports.isolated
      : [previous.pages ?? []].flat().includes(port) ? ports.pages : null;
    if (!Number.isInteger(to)) return null;
    url.port = String(to); return url.href;
  }
  function event(message) {
    if (message.type === 'page:changed') {
      for (const tab of list(message.sessionId)) {
        if (!samePath(tab.page.path, message.path)) continue;
        if (tab.touched) { tab.pending = true; changed(tab); } else reload(tab);
      }
      return;
    }
    if (message.type !== 'page:moved') return;
    for (const tabs of sessions.values()) for (const tab of tabs) {
      for (const item of tab.history) { const next = item.url && moved(item.url, message); if (next) { item.url = next; item.origin = new URL(next).origin; } }
      const next = tab.url && moved(tab.url, message); if (!next) continue;
      tab.url = next; tab.origin = new URL(next).origin;
      tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, origin:tab.origin };
      if (tab.dirty) { tab.pending = true; changed(tab); } else reload(tab);
    }
  }
  function travel(tab, direction) {
    const position = tab.position + direction, page = tab.history[position]; if (!page) return;
    tab.position = position; Object.assign(tab, { url:page.url, title:page.title, origin:page.origin, page:tabPage(page), touched:false, dirty:false, pending:false });
    tab.canGoBack = position > 0; tab.canGoForward = position < tab.history.length - 1; changed(tab);
  }
  return { list, open, activity, reload, event, travel,
    close(tab) { sessions.set(tab.sessionId, list(tab.sessionId).filter(item => item !== tab)); changed(tab); } };
}
