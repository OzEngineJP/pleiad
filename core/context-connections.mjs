import { hash } from './context-runtime.mjs';
import { t } from './i18n.mjs';

const WARM_IDLE_MS = 10 * 60_000;
const CACHE_LIMIT = 128;

// 接続と一覧だけを共有する。認可・ターンの有効性は利用側の binding が持つ。
// snapshots（core/mcp-ledger.mjs）があるとき、一覧の写しはデータ置き場にも残す。写しのある MCP は
// ツールを snapshot で広告したまま standby にし、最初の呼び出し（wake）でプロセスを起こす（遅延起動）。
export function createContextConnections({ connect, idleMs = WARM_IDLE_MS, snapshots = null } = {}) {
  const entries = new Map(), all = new Set(), cache = new Map();
  let disposed = false;
  const keyFor = (item, config) => `${item.id}:${hash([item.definition, { ...config, fetch: undefined }])}`;
  const snapshotGet = key => {
    let snapshot = cache.get(key);
    if (snapshot === undefined && snapshots) {
      snapshot = snapshots.get(key);
      if (snapshot !== undefined) { cache.set(key, snapshot); }
    }
    return snapshot;
  };
  const forget = key => { cache.delete(key); snapshots?.delete(key); };
  function remember(key, serverId, snapshot) {
    if (disposed) return;
    cache.delete(key);
    cache.set(key, snapshot);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    snapshots?.put(key, serverId, snapshot);
  }
  function close(entry) {
    if (entry.closing) return entry.closing;
    clearTimeout(entry.timer);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    entry.retired = true;
    // 起きていない（standby）ままの回収は、接続も client も無いので map から外すだけ
    if (!entry.started) { all.delete(entry); return entry.closing = Promise.resolve(); }
    // connect が終わる前に dispose/abort されても、後から生まれた client を回収する。
    // exit イベントでも stdin を同期的に閉じ始める。通常の終了経路は完了まで await する。
    const stopped = entry.client?.close().catch(() => {});
    return entry.closing = entry.started.then(async result => {
      await (stopped ?? result.client?.close().catch(() => {}));
    }).finally(() => { all.delete(entry); });
  }
  function retire(entry) {
    entry.retired = true;
    clearTimeout(entry.timer);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (!entry.users.size) return close(entry);
  }
  function release(entry, user, discard = false) {
    entry.users.delete(user);
    if (discard) retire(entry);
    if (entry.users.size) return;
    if (disposed || entry.retired) return close(entry);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void close(entry); }, idleMs);
    entry.timer.unref();
  }
  async function waitForUser(promise, entry, user) {
    const signal = user.controller.signal;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => { void Promise.resolve(release(entry, user, true)).catch(() => {}); reject(new Error(t('context.bridge.aborted'))); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  /** 実際に接続を始める（1 回だけ。同じ entry の呼び出しは同じ started にぶら下がる） */
  function start(entry) {
    if (entry.started) return entry.started;
    entry.standby = false;
    entry.started = connect(entry.item, { key: entry.key, name: entry.item.name, resolved: entry.resolved, cached: snapshotGet(entry.key), onClient: client => { entry.client = client; } }).then(result => {
      entry.result = result;
      // standby の行を持つ全利用者へ、起きた（または失敗した）ことを知らせる
      for (const user of entry.users) { try { user.mcpStarted?.(entry, result); } catch { /* 画面の更新の失敗で接続は止めない */ } }
      if (result.status !== 'connected') { retire(entry); return result; }
      entry.refresh = async () => {
        if (entry.refreshing) return entry.refreshing;
        entry.refreshing = result.list().then(async snapshot => {
          if (entries.get(entry.key) === entry) remember(entry.key, entry.id, snapshot);
          const changed = hash([result.tools, result.caps]) !== hash([snapshot.tools, snapshot.caps]);
          Object.assign(result, snapshot, { cached: false });
          entry.stale = false;
          if (changed) await Promise.allSettled([...entry.users].map(b => b.refresh?.()));
          return snapshot;
        }).catch(e => { if (entries.get(entry.key) === entry) forget(entry.key); entry.stale = true; throw e; }).finally(() => { entry.refreshing = null; });
        return entry.refreshing;
      };
      if (entries.get(entry.key) === entry) remember(entry.key, entry.id, { tools: result.tools, caps: result.caps });
      return result;
    });
    return entry.started;
  }
  /** 一覧の写し（遅延起動の判定。永続化されたものだけ＝プロセスをまたいで残る写し。無ければ従来どおり接続して覚える） */
  const snapshotFor = key => snapshots?.get(key);
  async function acquire(item, resolved, user, restarted, { lazy = false } = {}) {
    if (disposed) throw new Error(t('context.bridge.aborted'));
    const key = keyFor(item, resolved.config);
    // 変更前の stdio がポート等を持つ場合もあるため、新しい接続の前に退役させる。
    await Promise.allSettled([...entries.values()].filter(e => e.id === item.id && e.cwd === user.runtime.policy.cwd && e.key !== key).map(retire));
    if (user.closed || disposed) throw new Error(t('context.bridge.aborted'));
    let entry = entries.get(key);
    if (restarted && entry) { await retire(entry); entry = null; }
    if (user.closed || disposed) throw new Error(t('context.bridge.aborted'));
    const reused = !!entry;
    if (!entry) {
      entry = { key, id: item.id, cwd: user.runtime.policy.cwd, users: new Set(), retired: false, item, resolved, standby: lazy && !!snapshotFor(key), snapshot: lazy ? snapshotGet(key) : undefined };
      entries.set(key, entry); all.add(entry);
      if (!entry.standby) start(entry);
    } else if (entry.standby && !lazy) start(entry);   // standby のまま残っている entry を起こす（呼び出し駆動・一覧を持たない再接続）
    entry.users.add(user);
    clearTimeout(entry.timer);
    // standby: 一覧の写しだけを持つ lease をすぐ返す。プロセスは最初の呼び出し（wake）まで起こさない
    if (lazy && entry.standby) {
      const lease = { entry, result: { status: 'standby', tools: entry.snapshot?.tools ?? [], caps: entry.snapshot?.caps, snapshot: true }, release: discard => release(lease.entry, user, discard) };
      if (user.closed || disposed) { await lease.release(true); throw new Error(t('context.bridge.aborted')); }
      return lease;
    }
    let result;
    try { result = await waitForUser(entry.started, entry, user); }
    catch (e) { await release(entry, user, true); throw e; }
    if (reused && result.status === 'connected') {
      try {
        // SDK の ping(options) は軽い往復だけ。重なったターンの検査はまとめる。
        entry.check ??= result.client.ping({ timeout: Math.min(3000, resolved.config.timeout) }).finally(() => { entry.check = null; });
        await waitForUser(entry.check, entry, user);
      } catch {
        await release(entry, user, true);
        if (user.closed || disposed) throw new Error(t('context.bridge.aborted'));
        return acquire(item, resolved, user, false, { lazy });
      }
    }
    const lease = { entry, result, release: discard => release(lease.entry, user, discard) };
    if (user.closed || disposed) { await lease.release(true); throw new Error(t('context.bridge.aborted')); }
    // キャッシュがあれば一覧を待たずに返す。更新失敗は次の利用時に再度試す。
    if ((result.cached || entry.stale) && !entry.background) entry.background = entry.refresh().catch(() => {}).finally(() => { entry.background = null; });
    return lease;
  }
  /**
   * standby の entry を起こす（最初の呼び出し・resources/prompts の要求で呼ぶ）。
   * 退役済みなら同じキーで取り直す（新しい接続）。lease.entry / lease.result を新しいものに差し替える。
   */
  async function wake(lease, user) {
    let entry = lease.entry;
    if (entry.retired) {
      const next = await acquire(entry.item, entry.resolved, user, false, { lazy: false });
      // 古い側の users は退役済みのまま残る（close は users を見ない）。release は今の entry を放す
      lease.entry = next.entry; lease.result = next.result;
      return { entry: next.entry, result: next.result };
    }
    if (entry.standby) start(entry);
    const result = await waitForUser(entry.started, entry, user);
    lease.result = result;
    // 写しで応えていた分は、起きた一覧を裏で取り直す（古い広告を差し替える）
    if (result.status === 'connected' && (result.cached || entry.stale) && !entry.background) entry.background = entry.refresh().catch(() => {}).finally(() => { entry.background = null; });
    return { entry, result };
  }
  function prune(keys, cwd) {
    for (const entry of entries.values()) if (entry.cwd === cwd && !keys.has(entry.key)) retire(entry);
    for (const key of cache.keys()) {
      // 定義変更は同じ id の旧キャッシュも消す。別の場所の登録は上限で回収する。
      if ([...keys].some(k => k.split(':')[0] === key.split(':')[0]) && !keys.has(key)) forget(key);
    }
    snapshots?.prune(new Set([...keys].map(k => k.split(':')[0])), keys);
  }
  function dispose() {
    disposed = true;
    cache.clear();
    return Promise.allSettled([...all].map(close));
  }
  return { acquire, wake, keyFor, snapshotFor, prune, dispose };
}
