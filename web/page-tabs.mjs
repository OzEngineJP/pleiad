import { samePath } from './file-actions.mjs';

/** Screen-owned pages. Chrome targets are attached only by an explicit display change. */
export function createPageTabs({ pageOpen, origin, changed = () => {}, touched = null, release = null, onError = null }) {
  const sessions = new Map(); let serial = 0;
  const list = id => sessions.get(id) ?? [];
  // 隔離の origin（<印>.localhost:<port>。core/isolated-origins.mjs）。URL はサーバーが pageOpen で決める。
  // 画面が自分で作るのは本体と同じ出どころのページ（/_pleiad/…）だけ
  const MARK = /^[a-z0-9][a-z0-9-]{0,61}\.localhost$/;
  /** 「触った」の判定（読み位置・入力を捨てるか）。既定はページが送る活動の印。画面は Chrome の映像の持ち手も足せる */
  const isTouched = tab => (touched ? touched(tab) : false) || tab.touched || tab.dirty;
  /** 履歴・タブにつけるページの印。可視化は束の場所（hash・entry）、HTML は題も持つ（アドレスバーが出す） */
  const tabPage = page => ({ kind:page.kind, path:page.path,
    ...(page.vizHash ? { vizHash:page.vizHash, entry:page.entry } : {}),
    ...(page.title ? { title:page.title } : {}) });
  /** pageOpen の応答をタブの印へ戻す。ページは suffix（本体と同じ出どころ）、隔離のものは返ってきた URL のまま */
  const applyOpened = (tab, opened, at) => {
    const url = opened.suffix ? new URL(opened.suffix, origin).href : at.href;
    Object.assign(tab, { url, origin:new URL(url).origin });
    tab.page = { kind:opened.kind ?? tab.page?.kind,
      path:opened.path ?? (opened.kind === 'viz' ? tab.page?.path : undefined),
      ...(opened.hash || tab.page?.vizHash ? { vizHash:opened.hash ?? tab.page?.vizHash, entry:opened.entry ?? tab.page?.entry } : {}),
      ...(opened.title || tab.page?.title ? { title:opened.title ?? tab.page?.title } : {}) };
    if (tab.page?.kind !== 'viz') { delete tab.page.vizHash; delete tab.page.entry; }
    if (tab.histTrail?.length) tab.histTrail[tab.histPos] = tab.url;
    if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, origin:tab.origin,
      kind:tab.page?.kind, path:tab.page?.path, vizHash:tab.page?.vizHash, entry:tab.page?.entry, title:tab.page?.title };
  };
  async function open(input, replace = null) {
    const { sessionId, kind = 'new', path, vizHash, hash, entry } = input;
    let page;
    if (kind === 'viz' || kind === 'html' || (kind === 'file' && /\.html?$/i.test(path ?? ''))) {
      let opened;
      if (kind === 'html' && input.url) {
        // 隔離の /f/<鍵>/ の URL をそのまま開く（中のリンク・Chrome のタブを「ページ」へ戻すとき。鍵は URL の中。path は pageResolve が確かめたもの）
        const at = new URL(input.url, origin);
        if (at.hostname !== 'localhost' && !MARK.test(at.hostname.toLowerCase())) throw new Error('invalid-url');
        opened = { kind: 'html', url: at.href, path };
      } else {
        // 開く先はサーバーが決める（core/browser-unify-ws.mjs の pageOpen。可視化は hash、HTML のファイルは kind:'html'）
        const request = kind === 'viz'
          ? { sessionId, kind: 'viz', hash: String(vizHash ?? hash ?? ''), ...(entry ? { entry } : {}), ...(input.title ? { title: input.title } : {}), ...(input.path ? { path: input.path } : {}) }
          : { sessionId, kind: 'html', path, ...(input.title ? { title: input.title } : {}) };
        opened = await pageOpen(request);
      }
      const url = new URL(opened?.url ?? '', origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
      if (!['viz', 'html'].includes(opened?.kind)) throw new Error('invalid-url');
      page = { url: url.href, origin: url.origin, kind: opened.kind, path: opened.path,
        vizHash: opened.hash ?? (kind === 'viz' ? vizHash ?? hash : undefined), entry: opened.entry ?? entry,
        title: opened.title ?? input.title ?? url.searchParams.get('title') ?? '' };
    } else {
      if (!['file', 'dir', 'git', 'plugins', 'new', 'attachment'].includes(kind)) throw new Error('invalid-url');
      const url = new URL(`/_pleiad/s/${encodeURIComponent(sessionId)}/${kind}`, origin);
      if (path) url.searchParams.set('path', path);
      if (input.line) url.searchParams.set('line', input.line);
      page = { url: url.href, origin, kind, path, title: input.title ?? '' };
    }
    const tab = replace ?? { targetId:`page:${++serial}`, sessionId, local:true, mode:'page', history:[], position:-1, histTrail:[page.url], histPos:0 };
    Object.assign(tab, { url:page.url, title:page.title, page:tabPage(page), origin:page.origin,
      request:{ sessionId, kind, path, vizHash:vizHash ?? hash, entry }, touched:false, dirty:false, pending:false });
    tab.history.splice(++tab.position); tab.history.push(page);
    tab.canGoBack = tab.position > 0; tab.canGoForward = false;
    if (!replace) sessions.set(sessionId, [...list(sessionId), tab]);
    changed(tab); return tab;
  }
  function activity(tab, input = false) { tab.touched = true; if (input) tab.dirty = true; }
  function reload(tab) { tab.pending = false; tab.touched = false; tab.dirty = false; tab.reload = (tab.reload ?? 0) + 1; changed(tab); }
  /** ファイルの表示（プレビュー/原文）。隔離の HTML は ?view= で同じ文書の別の出し方を読ませる（core/isolated-routes.mjs） */
  function view(tab, name) {
    const next = name === 'source' ? 'source' : 'preview';
    let url;
    try { url = new URL(tab.url); } catch { return; }
    if (next === 'source') url.searchParams.set('view', 'source'); else url.searchParams.delete('view');
    tab.view = next;
    if (url.href === tab.url) { changed(tab); return; }
    tab.url = url.href;
    if (tab.histTrail?.length) tab.histTrail[tab.histPos] = tab.url;
    if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url };
    reload(tab);
  }
  /**
   * ページの中の移動（隔離の origin のリンク・戻る/進む・履歴の書き換え）。URL・題・戻る/進む・対象を追い直す。
   * 文書の中の履歴は tab.histTrail で持ち、戻った場所は同じ URL の並びで見分ける（新しい移動は先を捨てて足す）。
   * resolved はサーバーが URL から戻した対象（pageResolve。ファイルのパス・束の入口。見張りもサーバーが登り直す）
   */
  function locate(tab, { url, title = null, resolved = null } = {}) {
    const trail = tab.histTrail ?? (tab.histTrail = [tab.url]);
    let pos = tab.histPos ?? trail.length - 1;
    if (trail[pos] === url) { /* 同じ場所の報告（読み直し・ハッシュだけの替わりは下で捌く） */ }
    else if (trail[pos - 1] === url) pos--;
    else if (trail[pos + 1] === url) pos++;
    else { trail.splice(pos + 1); trail.push(url); pos = trail.length - 1; }
    tab.histPos = pos;
    tab.canGoBack = pos > 0; tab.canGoForward = pos < trail.length - 1;
    tab.url = url;
    if (title) { tab.title = title; if (tab.page) tab.page.title = title; }
    if (resolved?.kind === 'html') { tab.page = { ...tab.page, kind:'html', path:resolved.path }; if (tab.request) tab.request.path = resolved.path; }
    else if (resolved?.kind === 'viz') tab.page = { ...tab.page, kind:'viz', vizHash:resolved.hash, entry:resolved.entry };
    tab.touched = false; tab.dirty = false; tab.pending = false;
    if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, title:tab.title,
      kind:tab.page?.kind, path:tab.page?.path, vizHash:tab.page?.vizHash, entry:tab.page?.entry };
    changed(tab);
  }
  /** 鍵・開く先をサーバーへ取り直す（期限切れ・サーバーの入れ替えで外れた見張りの戻し。request は open が覚えている開き方） */
  async function reissue(tab) {
    const page = tab.page ?? {};
    const request = page.kind === 'viz'
      ? { sessionId:tab.sessionId, kind:'viz', hash:page.vizHash, entry:page.entry, title:page.title, path:page.path }
      : { sessionId:tab.sessionId, kind:page.kind === 'html' ? 'html' : (tab.request?.kind ?? 'file'),
          path:page.path ?? tab.request?.path, title:page.title ?? tab.title, line:tab.request?.line };
    const opened = await pageOpen(request);
    if (!opened?.url) throw Object.assign(new Error('invalid-url'), { code:'invalid-url' });
    const at = new URL(opened.url, origin);
    applyOpened(tab, opened, at);
    if (isTouched(tab)) { tab.pending = true; changed(tab); } else reload(tab);
    return tab;
  }
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
        if (isTouched(tab)) { tab.pending = true; changed(tab); } else reload(tab);
      }
      return;
    }
    if (message.type !== 'page:moved') return;
    for (const tabs of sessions.values()) for (const tab of tabs) {
      for (const item of tab.history) { const next = item.url && moved(item.url, message); if (next) { item.url = next; item.origin = new URL(next).origin; } }
      const next = tab.url && moved(tab.url, message);
      if (!next) {
        // 前の port から付け替えられない隔離の URL は、開き方から鍵と見張りを取り直す
        if (tab.local && ['html', 'viz'].includes(tab.page?.kind)) reissue(tab).catch(error => onError?.(error, tab));
        continue;
      }
      tab.url = next; tab.origin = new URL(next).origin;
      tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, origin:tab.origin };
      if (isTouched(tab)) { tab.pending = true; changed(tab); } else reload(tab);
    }
  }
  function travel(tab, direction) {
    const position = tab.position + direction, page = tab.history[position]; if (!page) return;
    tab.position = position; Object.assign(tab, { url:page.url, title:page.title, origin:page.origin, page:tabPage(page), touched:false, dirty:false, pending:false });
    tab.canGoBack = position > 0; tab.canGoForward = position < tab.history.length - 1; changed(tab);
  }
  return { list, sessionIds: () => [...sessions.keys()], open, activity, reload, event, travel, locate, view, reissue, isTouched,
    close(tab) { release?.(tab); sessions.set(tab.sessionId, list(tab.sessionId).filter(item => item !== tab)); changed(tab); } };
}
