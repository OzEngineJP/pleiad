// 中継（core/chrome/relay.mjs）の、Pleiad のページから Pleiad への頼み（plyPage の binding）を受ける口（ADR 0292 の 2 の 5・6）。
//   - ファイルのページ（http://localhost:<pages port>/_pleiad/s/<その会話の id>/…）のタブにだけ、中継自身のセッションで Runtime.addBinding（plyPage）を足す
//   - 頼みを受けるのは、呼んだのが主フレームの既定の world（ページ自身。iframe・隔離した world でない）で、そのフレームの origin がファイルのページで、
//     そのタブを人が操作中（ADR 0293。core/chrome/tab-holder.mjs）のときだけ。人が操作中のタブでは、AI の Runtime.evaluate を中継の門が断るので、
//     AI はページを通して頼みを偽れない。AI の操作のタブから届いた頼みは捨てる
//   - 形とパスの検査は attach で受けた accept（core/page-requests.mjs）がする。accept が無ければ全部捨てる（つなぎ忘れは断る側に倒す）
//   - 通った頼みは 'tab:page-request' で出す（{ sessionId, targetId, by, request }。by は最後に触った画面）
//   - テーマと言語の変化（pleiad:env）と、書き込みの頼みの結果（pleiad:page-result）は、隔離した world から CustomEvent でページへ知らせる
//     （ページのスクリプトが書き換えた関数を通らない。detail は Chrome が world をまたいで写す）
// サーバーがファイルのページの port を渡す前（setPagePorts の前）は、何も付けない。
// ログに URL・パス・頼みの中身を書かない。

/** ページに足す binding の名前（web/pages/bridge.mjs が呼ぶ） */
export const BINDING = 'plyPage';
/** 知らせを出す隔離した world の名前 */
export const WORLD = 'pleiad-page-bridge';
/** 1 つの頼みの大きさの上限（JSON の文字数） */
export const PAYLOAD_LIMIT = 64 * 1024;
/** 1 つのタブの頼みの数の上限（RATE_WINDOW_MS の間） */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 10_000;
/** 結果を待つ書き込みの頼み（worktree）の、1 つのタブの上限と待つ時間（web/pages/bridge.mjs の requestResult と同じ） */
export const PENDING_LIMIT = 50;
export const PENDING_MS = 5 * 60_000;

/**
 * @param {object} [deps]
 * @param [deps.emit]  (type, payload) => 中継の出来事（relay.onTabEvent）。頼みが通ったら 'tab:page-request'
 * @param [deps.ports] () => { main, pages, isolated }（ファイルのページのタブかを見分ける）
 * @param [deps.log]   ログの 1 行
 * @param [deps.now]   時計（試験が差し替える）
 * @returns 中継が呼ぶ口と、サーバーの側（core/page-requests.mjs）が relay.unify.pageBridge で呼ぶ口
 *   中継が呼ぶ口（tab は core/chrome/tab-info.mjs と同じ形）:
 *   - added(tab): タブが会話の範囲に入った。ファイルのページなら tab.attach で中継のセッションを付け、binding を足す
 *   - changed(tab): targetInfo が替わった。ファイルのページになったら付け、外れたら外す
 *   - removed({ sessionId, targetId }): タブが無くなった
 *   サーバーの側の口:
 *   - attach({ holder, accept }): holder(sessionId, targetId) はそのタブの持ち手（tab-holder の holder）。
 *     accept(request, { sessionId, targetId, by }) は検査した頼み（Promise 可）か null（捨てる）
 *   - env(detail, { sessionId }?): テーマと言語の変化を、ファイルのページのタブへ pleiad:env で知らせる（sessionId を付ければその会話だけ）
 *   - result(reply): 書き込みの頼みの結果（{ sessionId, targetId?, requestId, ok, result?, error? }）を、頼んだタブへ pleiad:page-result で返す。
 *     そのタブから届いて、まだ結果を返していない requestId だけ。返せたら true
 *   - tabs(): ファイルのページとして binding を付けたタブの一覧（{ sessionId, targetId }。試験と見張り用）
 */
export function createPageBridge({ emit = () => {}, ports = () => null, log = () => {}, now = Date.now } = {}) {
  const tabs = new Map();       // タブの id -> ファイルのページのタブの記録
  let holder = null, accept = null;

  const pagesOrigin = () => {
    const port = ports()?.pages;
    return Number.isInteger(port) && port > 0 && port < 65536 ? `http://localhost:${port}` : null;
  };
  /** その会話のファイルのページの URL か */
  function isPageUrl(url, sessionId) {
    const origin = pagesOrigin();
    if (!origin || typeof url !== 'string' || typeof sessionId !== 'string' || !sessionId) return false;
    try {
      const u = new URL(url);
      const m = /^\/_pleiad\/s\/([^/]+)\//.exec(u.pathname);
      return u.origin === origin && Boolean(m) && decodeURIComponent(m[1]) === sessionId;
    } catch { return false; }
  }
  const quiet = (what, error) => log(`chrome-page-bridge: ${what}: ${error?.message ?? error}`);

  /** 中継のセッションを付け、binding を足す。付ける途中でタブが外れたら外す */
  function open(tab) {
    const record = { sessionId: tab.sessionId, targetId: tab.targetId, url: tab.info?.url ?? '', own: null, closed: false,
      mainFrame: tab.targetId, contexts: new Map(), world: null, calls: [], pending: new Map() };
    tabs.set(tab.targetId, record);
    record.ready = (async () => {
      const own = await tab.attach((method, params) => onEvent(record, method, params));
      if (record.closed) { await own.detach().catch(() => {}); return; }
      record.own = own;
      const tree = await own.send('Page.getFrameTree').catch(() => null);
      if (tree?.frameTree?.frame?.id) record.mainFrame = tree.frameTree.frame.id;
      await own.send('Runtime.addBinding', { name: BINDING });
      await own.send('Runtime.enable');   // 今ある world を executionContextCreated で受ける（呼び元の world を見分ける）
    })().catch(error => {
      quiet('attach failed', error);
      if (tabs.get(tab.targetId) === record) tabs.delete(tab.targetId);
      record.closed = true;
    });
    return record;
  }
  function close(targetId) {
    const record = tabs.get(targetId);
    if (!record) return;
    tabs.delete(targetId);
    record.closed = true;
    record.pending.clear();
    const own = record.own;
    record.own = null;
    if (own) own.send('Runtime.removeBinding', { name: BINDING }).catch(() => {}).finally(() => own.detach().catch(() => {}));
  }

  function onEvent(record, method, params = {}) {
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const c = params.context ?? {};
        record.contexts.set(c.id, { frameId: c.auxData?.frameId ?? null, isDefault: c.auxData?.isDefault === true, origin: c.origin ?? '', name: c.name ?? '' });
        break;
      }
      case 'Runtime.executionContextDestroyed':
        record.contexts.delete(params.executionContextId);
        if (record.world === params.executionContextId) record.world = null;
        break;
      case 'Runtime.executionContextsCleared':
        record.contexts.clear(); record.world = null;
        break;
      case 'Runtime.bindingCalled':
        if (params.name === BINDING) receive(record, params).catch(error => quiet('request failed', error));
        break;
      case 'Target.detachedFromTarget':
        // Chrome の側で外れた。次の changed で付け直す
        if (tabs.get(record.targetId) === record) { tabs.delete(record.targetId); record.closed = true; record.own = null; }
        break;
    }
  }

  /** 主フレームの既定の world で、ファイルのページの origin か（iframe・隔離した world・別のサイトに移った後を除く） */
  function pageContext(record, contextId) {
    const c = record.contexts.get(contextId);
    return Boolean(c) && c.isDefault && c.frameId === record.mainFrame && c.origin === pagesOrigin() && isPageUrl(record.url, record.sessionId);
  }

  async function receive(record, { payload, executionContextId }) {
    const drop = reason => { log(`chrome-page-bridge: dropped a page request (${reason})`); return null; };
    if (record.closed) return drop('tab closed');
    if (!pageContext(record, executionContextId)) return drop('not the page');
    const time = now();
    record.calls = record.calls.filter(at => time - at < RATE_WINDOW_MS);
    if (record.calls.length >= RATE_LIMIT) return drop('too many');
    record.calls.push(time);
    if (typeof payload !== 'string' || payload.length > PAYLOAD_LIMIT) return drop('too large');
    let request;
    try { request = JSON.parse(payload); } catch { return drop('not json'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) return drop('not an object');
    // 人が操作中のタブだけ。AI の操作のタブで呼べたのは AI の evaluate かもしれない
    const held = heldBy(record);
    if (!held) return drop('not held by a person');
    if (!accept) return drop('no checker');
    let checked;
    try { checked = await accept(request, { sessionId: record.sessionId, targetId: record.targetId, by: held.by }); }
    catch (error) { quiet('check failed', error); checked = null; }
    if (!checked) return drop('rejected');
    // 検査の間に人の操作が終わった・タブが外れたら出さない
    const still = heldBy(record);
    if (record.closed || tabs.get(record.targetId) !== record || !still) return drop('released while checking');
    if (checked.type === 'worktree') remember(record, checked.requestId);
    emit('tab:page-request', { sessionId: record.sessionId, targetId: record.targetId, by: still.by, request: checked });
    return checked;
  }
  /** 人が操作中なら { by }（by は最後に触った画面）。それ以外・持ち手が読めないときは null */
  function heldBy(record) {
    let h;
    try { h = holder?.(record.sessionId, record.targetId); } catch { return null; }
    return h?.holder === 'human' && typeof h.by === 'string' && h.by ? { by: h.by } : null;
  }
  function remember(record, requestId) {
    const time = now();
    for (const [id, at] of record.pending) if (time - at >= PENDING_MS) record.pending.delete(id);
    while (record.pending.size >= PENDING_LIMIT) record.pending.delete(record.pending.keys().next().value);
    record.pending.set(requestId, time);
  }

  /** 隔離した world で CustomEvent を出す。ページがファイルのページでないとき（別のサイトへ移った後）は出さない */
  async function dispatch(record, type, detail) {
    if (record.closed || !record.own) return false;
    const main = [...record.contexts.values()].find(c => c.isDefault && c.frameId === record.mainFrame);
    if (!main || main.origin !== pagesOrigin() || !isPageUrl(record.url, record.sessionId)) return false;
    const expression = `window.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, { detail: JSON.parse(${JSON.stringify(JSON.stringify(detail))}) })); true`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const own = record.own;
      if (!own) return false;
      try {
        if (record.world == null) {
          const made = await own.send('Page.createIsolatedWorld', { frameId: record.mainFrame, worldName: WORLD, grantUniveralAccess: false });
          record.world = made.executionContextId;
        }
        const result = await own.send('Runtime.evaluate', { expression, contextId: record.world, returnByValue: true });
        if (!result?.exceptionDetails) return true;
      } catch { /* world が移り変わった。作り直して 1 回だけやり直す */ }
      record.world = null;
    }
    return false;
  }

  return {
    // ---- 中継が呼ぶ口
    added(tab) {
      if (!tabs.has(tab.targetId) && isPageUrl(tab.info?.url, tab.sessionId)) open(tab);
    },
    changed(tab) {
      const record = tabs.get(tab.targetId);
      const page = isPageUrl(tab.info?.url, tab.sessionId);
      if (record && (!page || record.sessionId !== tab.sessionId)) { close(tab.targetId); if (page) open(tab); return; }
      if (record) { record.url = tab.info?.url ?? ''; return; }
      if (page) open(tab);
    },
    removed({ sessionId, targetId }) {
      if (targetId != null) { close(targetId); return; }
      for (const [id, record] of [...tabs]) if (record.sessionId === sessionId) close(id);
    },

    // ---- サーバーの側の口
    attach({ holder: nextHolder = null, accept: nextAccept = null } = {}) {
      holder = typeof nextHolder === 'function' ? nextHolder : null;
      accept = typeof nextAccept === 'function' ? nextAccept : null;
    },
    async env(detail, { sessionId } = {}) {
      const list = [...tabs.values()].filter(r => sessionId == null || r.sessionId === sessionId);
      const sent = await Promise.all(list.map(r => (r.ready ?? Promise.resolve()).then(() => dispatch(r, 'pleiad:env', detail)).catch(() => false)));
      return sent.filter(Boolean).length;
    },
    async result(reply) {
      const { sessionId, targetId, requestId } = reply ?? {};
      const record = targetId != null ? tabs.get(targetId)
        : [...tabs.values()].find(r => r.sessionId === sessionId && r.pending.has(requestId));
      if (!record || record.sessionId !== sessionId || !record.pending.has(requestId)) return false;
      const at = record.pending.get(requestId);
      record.pending.delete(requestId);
      if (now() - at >= PENDING_MS) return false;
      const detail = { requestId, ok: reply.ok === true, ...(reply.ok === true ? { result: reply.result ?? null } : { error: reply.error ?? 'unavailable' }) };
      return dispatch(record, 'pleiad:page-result', detail);
    },
    tabs: () => [...tabs.values()].filter(r => !r.closed).map(r => ({ sessionId: r.sessionId, targetId: r.targetId })),
  };
}
