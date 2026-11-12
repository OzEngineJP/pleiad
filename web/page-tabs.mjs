import { samePath } from './file-actions.mjs';

/** タブが今も元の可視化のファイルを表示しているときだけ、その可視化の記録（request.viz）を返す（別のファイルへ移ったタブには保存版の入口を出さない） */
export function savedVizOf(tab) {
  const viz = tab?.request?.viz;
  return viz?.hash && viz.path && tab.page?.path && samePath(tab.page.path, viz.path) ? viz : null;
}

/** Screen-owned pages. Chrome targets are attached only by an explicit display change. */
export function createPageTabs({ pageOpen, origin, changed = () => {}, touched = null, release = null, onError = null }) {
  const sessions = new Map(); let serial = 0;
  const MARK = /^[a-z0-9][a-z0-9-]{0,61}\.localhost$/;
  const list = id => sessions.get(id) ?? [];
  // 隔離の origin（<印>.localhost:<port>。core/isolated-origins.mjs）。URL はサーバーが pageOpen で決める。
  // 画面が自分で作るのは本体と同じ出どころのページ（/_pleiad/…）だけ
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
    const targetId = replace?.targetId ?? input.targetId ?? `page:${++serial}`;
    let page;
    if (kind === 'viz' || (kind === 'html' && path && !input.url) || ['file', 'dir'].includes(kind)) {
      // 開く先はサーバーが決める（core/browser-unify-ws.mjs の pageOpen。可視化は hash、HTML のファイルは kind:'html'）。
      // tab は変化の見張りの持ち主（core/page-watch.mjs の owner。タブを閉じた・タブの中で移ったときにその分だけ外す）
      const request = kind === 'viz'
        ? { sessionId, kind: 'viz', hash: String(vizHash ?? hash ?? ''), tab: targetId, ...(entry ? { entry } : {}), ...(input.title ? { title: input.title } : {}), ...(input.path ? { path: input.path } : {}) }
        : { sessionId, kind:kind === 'file' && /\.html?$/i.test(path ?? '') ? 'html' : kind, path, tab: targetId, ...(input.title ? { title: input.title } : {}) };
      const opened = await pageOpen(request);
      const url = new URL(opened?.suffix || opened?.url || '', origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-url');
      if (!['viz', 'html', 'file', 'dir', 'git', 'plugins', 'new', 'attachment'].includes(opened?.kind)) throw new Error('invalid-url');
      page = { url: url.href, origin: url.origin, kind: opened.kind, path: opened.path,
        vizHash: opened.hash ?? (kind === 'viz' ? vizHash ?? hash : undefined), entry: opened.entry ?? entry,
        title: opened.title ?? input.title ?? url.searchParams.get('title') ?? '', stamp: opened.stamp };
    } else {
      if (kind === 'html') {
        let url;
        try { url = new URL(input.url); } catch { throw new Error('invalid-url'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || !(url.hostname === 'localhost' || MARK.test(url.hostname.toLowerCase()))
          || !/^\/f\/[A-Za-z0-9_-]{40,8192}\//.test(url.pathname)) throw new Error('invalid-url');
        page = { url:url.href, origin:url.origin, kind:'html', path, title:input.title ?? url.searchParams.get('title') ?? '' };
      } else {
        if (!['file', 'dir', 'git', 'plugins', 'new', 'attachment'].includes(kind)) throw new Error('invalid-url');
        const url = new URL(`/_pleiad/s/${encodeURIComponent(sessionId)}/${kind}`, origin);
        if (path) url.searchParams.set('path', path);
        if (input.line) url.searchParams.set('line', input.line);
        page = { url: url.href, origin, kind, path, title: input.title ?? '' };
      }
    }
    const tab = replace ?? { targetId, sessionId, local:true, mode:'page', history:[], position:-1, histTrail:[page.url], histPos:0 };
    if (replace && tab.page?.path && (!page.path || !samePath(tab.page.path, page.path))) release?.(tab);
    // 元の可視化の記録（hash・入口・題・元のパス）は固定: request.path はページの中の移動で変わるが、この tab をどの可視化から開いたかは変わらない。
    // 固定の元パスはサーバーが解いた page.path を優先する（記録の綴りと解決後がずれても、表示中のファイルと見比べられる）
    const rawViz = input.viz ?? ((vizHash ?? hash) ? { hash:vizHash ?? hash, entry, title:input.title, path } : null);
    const viz = kind !== 'viz' && rawViz?.hash ? { hash:rawViz.hash ?? '', entry:rawViz.entry ?? '', title:rawViz.title ?? '', path:page.path ?? rawViz.path ?? '' } : null;
    Object.assign(tab, { url:page.url, title:page.title, page:tabPage(page), origin:page.origin,
      request:{ sessionId, kind, path, ...(viz ? { viz } : {}) }, touched:false, dirty:false, pending:false, stamp:page.stamp, nextStamp:undefined });
    if (page.kind === 'html') tab.keyIssuedAt = Date.now();
    tab.history.splice(++tab.position); tab.history.push(page);
    tab.canGoBack = tab.position > 0; tab.canGoForward = false;
    if (replace) { tab.histTrail = [page.url]; tab.histPos = 0; }   // 別の文書に替わる: 文書の中の履歴は張り直す（前の文書の場所を残さない）
    if (!replace) sessions.set(sessionId, [...list(sessionId), tab]);
    changed(tab); return tab;
  }
  function activity(tab, input = false) { tab.touched = true; if (input) tab.dirty = true; }
  function reload(tab) {
    if (tab.page?.kind === 'html' && Date.now() - (tab.keyIssuedAt ?? 0) >= 24 * 60 * 60 * 1000) {
      void reissue(tab).catch(error => onError?.(error, tab));
      return;
    }
    tab.pending = false; tab.touched = false; tab.dirty = false; tab.reload = (tab.reload ?? 0) + 1;
    // 読み直した版: 変化の知らせが運んだ印があればそれ、無ければ分からない（null。次の見比べで 1 回だけ読み直す）
    tab.stamp = tab.nextStamp ?? null; tab.nextStamp = undefined;
    changed(tab);
  }
  /** 今のタブを読み直すよう頼む（読んでいる所・内容は消さない読み直し。ADR 0321）。触って（入力して）いるタブには出さず「更新を表示」にする */
  function refresh(tab) {
    if (!tab?.local) return false;
    if (tab.dirty) { tab.pending = true; changed(tab); return false; }
    reload(tab); return true;
  }
  /** ファイルの表示（プレビュー/原文）。隔離の HTML は ?view= で同じ文書の別の出し方を読ませる（core/isolated-routes.mjs） */
  function view(tab, name) {
    const next = name === 'source' ? 'source' : 'preview';
    let url;
    try { url = new URL(tab.url); } catch { return; }
    if (next === 'source') url.searchParams.set('view', 'source'); else url.searchParams.delete('view');
    tab.view = next;
    if (url.href === tab.url) { changed(tab); return; }
    tab.url = url.href;
    // 原文（?view=source）は別の文書として文書の中の履歴に足す。戻るとプレビューの URL へ戻れる（原文の文書には橋が無い。指摘 8）
    if (tab.histTrail?.length) { const pos = tab.histPos ?? 0; if (tab.histTrail[pos] !== url.href) { tab.histTrail.splice(pos + 1); tab.histTrail.push(url.href); tab.histPos = pos + 1; tab.canGoBack = true; tab.canGoForward = false; } }
    if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url };
    reload(tab);
  }
  /**
   * ページの中の移動（隔離の origin のリンク・戻る/進む・履歴の書き換え）。URL・題・戻る/進む・対象を追い直す。
   * 文書の中の履歴は tab.histTrail で持ち、戻った場所は同じ URL の並びで見分ける（新しい移動は先を捨てて足す）。
   * resolved はサーバーが URL から戻した対象（pageResolve。ファイルのパス・束の入口。見張りもサーバーが登り直す）
   */
  function locate(tab, { url, title = null, resolved = null, sameDocument = false } = {}) {
    const trail = tab.histTrail ?? (tab.histTrail = [tab.url]);
    let pos = tab.histPos ?? trail.length - 1;
    if (sameDocument) {
      // replaceState の報告（橋が sameDocument を付ける）は履歴に積まず
      // その場の URL を書き換えるだけ。触った・未確定の印は消さない（押せる「戻る」の偽物を生まない。指摘 2）
      trail[pos] = url; tab.histPos = pos;
      tab.url = url;
      try { tab.view = new URL(url).searchParams.get('view') === 'source' ? 'source' : 'preview'; } catch {}
      if (title) { tab.title = title; if (tab.page) tab.page.title = title; }
      if (resolved?.kind === 'html') { tab.page = { ...tab.page, kind:'html', path:resolved.path }; if (tab.request) tab.request.path = resolved.path; }
      else if (resolved?.kind === 'viz') tab.page = { ...tab.page, kind:'viz', path:resolved.path, vizHash:resolved.hash, entry:resolved.entry };
      if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, title:tab.title,
        kind:tab.page?.kind, path:tab.page?.path, vizHash:tab.page?.vizHash, entry:tab.page?.entry };
      changed(tab);
      return;
    }
    if (trail[pos] === url) { /* 同じ場所の報告（読み直し・ハッシュだけの替わりは上で捌く） */ }
    else if (trail[pos - 1] === url) pos--;
    else if (trail[pos + 1] === url) pos++;
    else { trail.splice(pos + 1); trail.push(url); pos = trail.length - 1; }
    tab.histPos = pos;
    tab.canGoBack = pos > 0 || (tab.position ?? 0) > 0; tab.canGoForward = pos < trail.length - 1 || (tab.position ?? 0) < (tab.history?.length ?? 0) - 1;
    tab.url = url;
    try { tab.view = new URL(url).searchParams.get('view') === 'source' ? 'source' : 'preview'; } catch {}
    if (title) { tab.title = title; if (tab.page) tab.page.title = title; }
    if (resolved?.kind === 'html') { tab.page = { ...tab.page, kind:'html', path:resolved.path }; if (tab.request) tab.request.path = resolved.path; }
    else if (resolved?.kind === 'viz') tab.page = { ...tab.page, kind:'viz', path:resolved.path, vizHash:resolved.hash, entry:resolved.entry };
    tab.touched = false; tab.dirty = false; tab.pending = false; tab.stamp = null;
    if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, title:tab.title,
      kind:tab.page?.kind, path:tab.page?.path, vizHash:tab.page?.vizHash, entry:tab.page?.entry };
    changed(tab);
  }
  /**
   * 文書の中の履歴（histTrail）を戻る/進む。親が URL を出し、枠は場所を差し替えるだけ
   * （枠の中の history は鍵の替わり・再接続・読み直しで失われるので頼らない。指摘 1）。
   * 戻り値は移る先の URL（履歴が無ければ null）。実際に枠を動かすのは呼び手（browser-unify.mjs）
   */
  /** 文書の中の履歴の移る先（histGo と同じ判定・まだ動かさない。枠の移し方を呼び手が決めてから histGo で確定する） */
  function histPeek(tab, direction) {
    const trail = tab.histTrail ?? [];
    return trail[(tab.histPos ?? trail.length - 1) + direction] ?? null;
  }
  function histGo(tab, direction) {
    const trail = tab.histTrail ?? [];
    const pos = (tab.histPos ?? trail.length - 1) + direction;
    if (pos < 0 || pos >= trail.length || !trail[pos]) return null;
    tab.histPos = pos;
    tab.url = trail[pos];
    try { tab.view = new URL(tab.url).searchParams.get('view') === 'source' ? 'source' : 'preview'; } catch {}
    tab.canGoBack = pos > 0 || (tab.position ?? 0) > 0;
    tab.canGoForward = pos < trail.length - 1 || (tab.position ?? 0) < (tab.history?.length ?? 0) - 1;
    if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url };
    tab.touched = false; tab.dirty = false; tab.pending = false;
    changed(tab);
    return trail[pos];
  }
  /** 鍵・開く先をサーバーへ取り直す（期限切れ・サーバーの入れ替えで外れた見張りの戻し。request は open が覚えている開き方） */
  async function reissue(tab) {
    const page = tab.page ?? {};
    // 応答を待つ間にタブが別のファイルへ移った（open の置き換え・locate）・閉じた場合は、古い応答で巻き戻さない
    const placeOf = target => `${target.page?.kind}|${target.page?.path ?? target.request?.path}|${target.page?.vizHash ?? ''}|${target.page?.entry ?? ''}`;
    const asked = placeOf(tab);
    const request = page.kind === 'viz'
      ? { sessionId:tab.sessionId, kind:'viz', hash:page.vizHash, entry:page.entry, title:page.title, path:page.path, tab:tab.targetId }
      : { sessionId:tab.sessionId, kind:page.kind === 'html' ? 'html' : (tab.request?.kind ?? 'file'),
          path:page.path ?? tab.request?.path, title:page.title ?? tab.title, line:tab.request?.line, tab:tab.targetId };
    const opened = await pageOpen(request);
    if (!opened?.url) throw Object.assign(new Error('invalid-url'), { code:'invalid-url' });
    if (!list(tab.sessionId).includes(tab) || placeOf(tab) !== asked) return tab;
    const at = new URL(opened.url, origin);
    const was = tab.url;
    applyOpened(tab, opened, at);
    if (tab.page?.kind === 'html') tab.keyIssuedAt = Date.now();
    // 戻ってきた URL が同じなら読み直さない（鍵・見張りはサーバー側で戻った。つなぎ直しで触っていないタブを毎回読み直さない。指摘 9）。
    // 版の印（stamp）が分かるときは、見ていない間にファイルが変わったかで決める: 変わっていて入力が無ければ読み直し、
    // 入力があれば「更新を表示」。変わっていなければ何もしない（ADR 0321）
    const stamp = opened.stamp;
    if (stamp !== undefined) {
      const differs = stamp !== tab.stamp || tab.url !== was;
      if (differs && tab.dirty) { tab.pending = true; tab.nextStamp = stamp; changed(tab); }
      else if (differs) { reload(tab); tab.stamp = stamp; }
      else changed(tab);
      return tab;
    }
    if (isTouched(tab)) { tab.pending = true; changed(tab); }
    else if (tab.url !== was) reload(tab); else changed(tab);
    return tab;
  }
  /**
   * 見ていなかった間に変わったファイルへ追いつく（会話へ戻った・つなぎ直した）。
   * 対象はファイル・フォルダー・添付・HTML のタブ。版の印が同じなら読み直さない
   */
  function catchUp(sessionId) {
    for (const tab of list(sessionId)) {
      if (!tab.local || !tab.page?.path || !['file', 'dir', 'html', 'attachment'].includes(tab.page.kind)) continue;
      reissue(tab).catch(error => onError?.(error, tab));
    }
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
        if (!tab.page?.path || !samePath(tab.page.path, message.path)) continue;   // 外の URL のタブ（kind:'web'・page なし）は対象外
        // 読み直した（見せた）ときの版の印は知らせが運ぶ（見えている間の変化の後に、戻ったときの見比べで二重に読み直さない）
        if (message.stamp) tab.nextStamp = message.stamp;
        if (isTouched(tab)) { tab.pending = true; changed(tab); } else reload(tab);
      }
      return;
    }
    if (message.type !== 'page:moved') return;
    for (const tabs of sessions.values()) for (const tab of tabs) {
      for (const item of tab.history) { const next = item.url && moved(item.url, message); if (next) { item.url = next; item.origin = new URL(next).origin; } }
      for (const [at, item] of (tab.histTrail ?? []).entries()) { const next = item && moved(item, message); if (next) tab.histTrail[at] = next; }
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
    if (tab.page?.path && (!page.path || !samePath(tab.page.path, page.path))) release?.(tab);
    tab.position = position; Object.assign(tab, { url:page.url, title:page.title, origin:page.origin, page:tabPage(page), touched:false, dirty:false, pending:false, stamp:null });
    // 別の文書に移る: 文書の中の履歴はその文書ので張り直す（前の文書の場所を残すと、戻る/進むが別の文書の場所を指す）
    tab.histTrail = [page.url]; tab.histPos = 0;
    try { tab.view = new URL(page.url).searchParams.get('view') === 'source' ? 'source' : 'preview'; } catch {}
    tab.canGoBack = position > 0; tab.canGoForward = position < tab.history.length - 1; changed(tab);
  }
  /** このタブをどの可視化から開いたかを今の可視化へ書き直す（同じパスのタブの使い回し・別の束からの開き直し）。元パスは解決済みの表示中のパスを優先する */
  function markViz(tab, viz) {
    if (!tab?.request) return;
    tab.request = { ...tab.request, viz:{ hash:viz.hash ?? '', entry:viz.entry ?? '', title:viz.title ?? '', path:tab.page?.path ?? viz.path ?? '' } };
    changed(tab);
  }
  return { list, sessionIds: () => [...sessions.keys()], open, activity, reload, refresh, catchUp, event, travel, locate, view, reissue, histGo, histPeek, isTouched, markViz, savedVizOf,
    close(tab) { release?.(tab); sessions.set(tab.sessionId, list(tab.sessionId).filter(item => item !== tab)); changed(tab); } };
}
