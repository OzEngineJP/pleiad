// 会話の Chrome のウィンドウで始まったダウンロードの記録（docs/inapp-browser.md「ダウンロード」、ADR 0328）。
//
// 中継（relay.mjs）が、Chrome のブラウザー全体のイベント（Browser.downloadWillBegin・downloadProgress）のうち、
// 会話のタブで始まったものだけを begin・progress で渡す。ここは会話ごとの一覧（新しい順）を持ち、変わるたびに emit('tab:downloads', …) で画面へ出す。
// 記録はこのプロセスの中だけに持つ（サーバーの更新・再起動では残らない。終わったものは、会話の行（present kind: 'chromeDownload'）に残る）。
// 状態:
//   - downloading: 進行中
//   - completed: 終わった（path は Chrome が保存した絶対パス）
//   - canceled: Pleiad の「ダウンロードを止める」で止めた
//   - failed: Chrome が canceled を返した（失敗も、Chrome の側で人が止めたものも、CDP では区別が付かない）
//   - unknown: Chrome との接続が切れて、結果が分からなくなった進行中のもの。画面には出さない。
//     つなぎ直した後に同じ guid の進み具合が届いたら、downloading に戻る
// 止められるか（stoppable）: Browser.cancelDownload は、そのプロフィールが CDP の「既定の context」のときだけ効く（実機 Chrome 157。ADR 0328）。
// 既定の context は最後に使ったプロフィールへ替わるので、中継が setDefaultContext で今の値を渡す。分からない間（null）は止められるものとして扱う

/** 会話ごとに残す数。超えたら、終わった古いものから捨てる */
export const DOWNLOADS_KEPT = 50;
/** list の wait の上限（秒）。エージェントの MCP の呼び出しは、長く待つと呼び手の側で切られる */
export const DOWNLOAD_WAIT_MAX_SECONDS = 120;
/** 進み具合だけの変化を画面へ出す間隔（ms）。状態の変化はすぐに出す */
const PROGRESS_EMIT_MS = 250;

const bytes = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * @param [deps.emit] (type, payload) => void。'tab:downloads' { sessionId, downloads } を出す（中継の emitTab）
 * @param [deps.now] () => ms
 */
export function createChromeDownloads({ emit = () => {}, now = Date.now, log = () => {} } = {}) {
  const byGuid = new Map();      // guid -> 記録
  const lists = new Map();       // 会話の id -> 記録の配列（新しい順）
  const waiters = new Map();     // 会話の id -> 進行中が無くなるのを待つ関数の Set
  const timers = new Map();      // 会話の id -> 進み具合をまとめて出すタイマー
  const settledListeners = new Set();
  let defaultContext = null;

  const stoppable = record => record.state === 'downloading' && !record.refused
    && (defaultContext == null || record.context == null || record.context === defaultContext);
  /** 画面へ出す形（始まったページの URL は出さない） */
  const forScreen = record => ({ id: record.guid, name: record.name, state: record.state, received: record.received, total: record.total,
    path: record.state === 'completed' ? record.path : null, startedAt: record.startedAt, stoppable: stoppable(record) });
  /** エージェントへ返す形（list_downloads） */
  const forAgent = record => ({ id: record.guid, state: record.state, name: record.name, receivedBytes: record.received, totalBytes: record.total,
    ...(record.state === 'completed' && record.path ? { path: record.path } : {}), pageUrl: record.pageUrl, startedAt: new Date(record.startedAt).toISOString() });
  const listOf = sessionId => lists.get(sessionId) ?? [];
  const running = sessionId => listOf(sessionId).some(record => record.state === 'downloading');
  const screen = sessionId => listOf(sessionId).filter(record => record.state !== 'unknown').map(forScreen);

  function publish(sessionId) {
    const timer = timers.get(sessionId);
    if (timer) { clearTimeout(timer); timers.delete(sessionId); }
    try { emit('tab:downloads', { sessionId, downloads: screen(sessionId) }); } catch (error) { log(`chrome-downloads: emit failed: ${error?.message ?? error}`); }
  }
  function publishSoon(sessionId) {
    if (timers.has(sessionId)) return;
    const timer = setTimeout(() => { timers.delete(sessionId); publish(sessionId); }, PROGRESS_EMIT_MS);
    timer.unref?.();
    timers.set(sessionId, timer);
  }
  function wake(sessionId) {
    if (running(sessionId)) return;
    const set = waiters.get(sessionId);
    if (!set) return;
    waiters.delete(sessionId);
    for (const fn of [...set]) fn();
  }
  function settle(record) {
    record.endedAt = now();
    publish(record.sessionId);
    for (const fn of [...settledListeners]) {
      try { fn({ sessionId: record.sessionId, download: forScreen(record) }); } catch (error) { log(`chrome-downloads: listener failed: ${error?.message ?? error}`); }
    }
    wake(record.sessionId);
  }
  function trim(list) {
    for (let i = list.length - 1; i >= 0 && list.length > DOWNLOADS_KEPT; i -= 1) {
      if (list[i].state === 'downloading') continue;
      byGuid.delete(list[i].guid);
      list.splice(i, 1);
    }
  }

  return {
    /** 会話のタブでダウンロードが始まった（中継が、始まったフレームから会話を引いた後に呼ぶ）。同じ guid の 2 回目は何もしない */
    begin({ sessionId, guid, name, pageUrl = '', context = null }) {
      if (!sessionId || typeof guid !== 'string' || !guid || byGuid.has(guid)) return false;
      const record = { guid, sessionId, name: String(name ?? '') || 'download', pageUrl: String(pageUrl ?? ''), context: context ?? null,
        state: 'downloading', received: 0, total: 0, path: null, startedAt: now(), endedAt: null, stopping: false, refused: false };
      byGuid.set(guid, record);
      const list = lists.get(sessionId) ?? [];
      list.unshift(record);
      trim(list);
      lists.set(sessionId, list);
      publish(sessionId);
      return true;
    },
    /** 進み具合（Browser.downloadProgress の params）。記録に無い guid（利用者自身のダウンロードなど）は false */
    progress(params) {
      const record = byGuid.get(params?.guid);
      if (!record) return false;
      if (record.state !== 'downloading' && record.state !== 'unknown') return true;   // 決着した後に届いたもの
      const restored = record.state === 'unknown';
      record.received = bytes(params.receivedBytes);
      record.total = bytes(params.totalBytes);
      if (params.state === 'completed') {
        record.state = 'completed';
        record.path = typeof params.filePath === 'string' && params.filePath ? params.filePath : null;
        if (!record.total) record.total = record.received;
        settle(record);
      } else if (params.state === 'canceled') {
        record.state = record.stopping ? 'canceled' : 'failed';
        settle(record);
      } else {
        record.state = 'downloading';
        if (restored) publish(record.sessionId); else publishSoon(record.sessionId);
      }
      return true;
    },
    /** その会話の進行中の記録（止める前に中継が引く。{ guid, context }）。無ければ null */
    running(sessionId, guid) {
      const record = byGuid.get(guid);
      return record && record.sessionId === sessionId && record.state === 'downloading' ? { guid: record.guid, context: record.context } : null;
    },
    /** 止める命令を送る前（true）と、断られた後（false）に呼ぶ。断られたものは、以後止められないものとして出す */
    stopping(guid, on) {
      const record = byGuid.get(guid);
      if (!record) return;
      record.stopping = on === true;
      if (!record.stopping && record.state === 'downloading') { record.refused = true; publish(record.sessionId); }
    },
    /** CDP の既定の context が分かった・替わった（null は分からない） */
    setDefaultContext(id) {
      const next = typeof id === 'string' && id ? id : null;
      if (next === defaultContext) return;
      const before = new Map([...byGuid.values()].map(record => [record, stoppable(record)]));
      defaultContext = next;
      const touched = new Set([...before].filter(([record, was]) => stoppable(record) !== was).map(([record]) => record.sessionId));
      for (const sessionId of touched) publish(sessionId);
    },
    /** Chrome との接続が切れた。進行中のものは結果が分からない */
    disconnected() {
      defaultContext = null;
      const touched = new Set();
      for (const record of byGuid.values()) if (record.state === 'downloading') { record.state = 'unknown'; record.stopping = false; touched.add(record.sessionId); }
      for (const sessionId of touched) { publish(sessionId); wake(sessionId); }
    },
    /** エージェントへ返す一覧（新しい順） */
    list(sessionId) { return listOf(sessionId).map(forAgent); },
    /** 画面へ出す一覧（新しい順。unknown は除く） */
    screen,
    /** 進行中のものが無くなるか、seconds が過ぎるか、signal が引かれるまで待つ */
    wait(sessionId, seconds, signal) {
      const ms = Math.min(Math.max(Number(seconds) || 0, 0), DOWNLOAD_WAIT_MAX_SECONDS) * 1000;
      if (!ms || !running(sessionId) || signal?.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          waiters.get(sessionId)?.delete(done);
          signal?.removeEventListener?.('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        timer.unref?.();
        if (!waiters.has(sessionId)) waiters.set(sessionId, new Set());
        waiters.get(sessionId).add(done);
        signal?.addEventListener?.('abort', done, { once: true });
      });
    },
    /** 決着した（completed・canceled・failed）ときの聞き手。fn({ sessionId, download })。会話の行を出すのに使う */
    onSettled(fn) { settledListeners.add(fn); return () => settledListeners.delete(fn); },
    /** 新しい会話の id が決まった（turn.key → 本物の id） */
    rebind(from, to) {
      const list = lists.get(from);
      if (!list || from === to) return;
      lists.delete(from);
      for (const record of list) record.sessionId = to;
      const merged = [...list, ...(lists.get(to) ?? [])].sort((a, b) => b.startedAt - a.startedAt);
      lists.set(to, merged);
      const waiting = waiters.get(from);
      if (waiting) { waiters.delete(from); waiters.set(to, new Set([...(waiters.get(to) ?? []), ...waiting])); }
      publish(from); publish(to);
    },
    /** 会話を消した */
    forget(sessionId) {
      const list = lists.get(sessionId);
      if (!list) return;
      lists.delete(sessionId);
      for (const record of list) byGuid.delete(record.guid);
      const timer = timers.get(sessionId);
      if (timer) { clearTimeout(timer); timers.delete(sessionId); }
      wake(sessionId);
    },
  };
}
