import { hash } from './context-runtime.mjs';
import { t } from './i18n.mjs';

const WARM_IDLE_MS = 10 * 60_000;
const CACHE_LIMIT = 128;

// 接続と一覧だけを共有する。認可・ターンの有効性は利用側の binding が持つ。
export function createContextConnections({ connect, idleMs = WARM_IDLE_MS }) {
  const entries = new Map(), all = new Set(), cache = new Map();
  let disposed = false;
  const keyFor = (item, config) => `${item.id}:${hash([item.definition, { ...config, fetch: undefined }])}`;
  function remember(key, snapshot) {
    if (disposed) return;
    cache.delete(key);
    cache.set(key, snapshot);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  function close(entry) {
    if (entry.closing) return entry.closing;
    clearTimeout(entry.timer);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    entry.retired = true;
    // connect が終わる前に dispose/abort されても、後から生まれた client を回収する。
    // exit イベントでも stdin を同期的に閉じ始める。通常の終了経路は完了まで await する。
    const stopped = entry.client?.close().catch(() => {});
    return entry.closing = entry.ready.then(async result => {
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
  async function acquire(item, resolved, user, restarted) {
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
      entry = { key, id: item.id, cwd: user.runtime.policy.cwd, users: new Set(), retired: false };
      entries.set(key, entry); all.add(entry);
      entry.ready = connect(item, { resolved, cached: cache.get(key), onClient: client => { entry.client = client; } }).then(result => {
        entry.result = result;
        if (result.status !== 'connected') { retire(entry); return result; }
        entry.refresh = async () => {
          if (entry.refreshing) return entry.refreshing;
          entry.refreshing = result.list().then(async snapshot => {
            if (entries.get(key) === entry) remember(key, snapshot);
            const changed = hash([result.tools, result.caps]) !== hash([snapshot.tools, snapshot.caps]);
            Object.assign(result, snapshot, { cached: false });
            entry.stale = false;
            if (changed) await Promise.allSettled([...entry.users].map(b => b.refresh?.()));
            return snapshot;
          }).catch(e => { if (entries.get(key) === entry) cache.delete(key); entry.stale = true; throw e; }).finally(() => { entry.refreshing = null; });
          return entry.refreshing;
        };
        if (entries.get(key) === entry) remember(key, { tools: result.tools, caps: result.caps });
        return result;
      });
    }
    entry.users.add(user);
    clearTimeout(entry.timer);
    let result;
    try { result = await waitForUser(entry.ready, entry, user); }
    catch (e) { await release(entry, user, true); throw e; }
    if (reused && result.status === 'connected') {
      try {
        // SDK の ping(options) は軽い往復だけ。重なったターンの検査はまとめる。
        entry.check ??= result.client.ping({ timeout: Math.min(3000, resolved.config.timeout) }).finally(() => { entry.check = null; });
        await waitForUser(entry.check, entry, user);
      } catch {
        await release(entry, user, true);
        if (user.closed || disposed) throw new Error(t('context.bridge.aborted'));
        return acquire(item, resolved, user, false);
      }
    }
    const lease = { entry, result, release: discard => release(entry, user, discard) };
    if (user.closed || disposed) { await lease.release(true); throw new Error(t('context.bridge.aborted')); }
    // キャッシュがあれば一覧を待たずに返す。更新失敗は次の利用時に再度試す。
    if ((result.cached || entry.stale) && !entry.background) entry.background = entry.refresh().catch(() => {}).finally(() => { entry.background = null; });
    return lease;
  }
  function prune(keys, cwd) {
    for (const entry of entries.values()) if (entry.cwd === cwd && !keys.has(entry.key)) retire(entry);
    for (const key of cache.keys()) {
      // 定義変更は同じ id の旧キャッシュも消す。別の場所の登録は上限で回収する。
      if ([...keys].some(k => k.split(':')[0] === key.split(':')[0]) && !keys.has(key)) cache.delete(key);
    }
  }
  function dispose() {
    disposed = true;
    cache.clear();
    return Promise.allSettled([...all].map(close));
  }
  return { acquire, keyFor, prune, dispose };
}
