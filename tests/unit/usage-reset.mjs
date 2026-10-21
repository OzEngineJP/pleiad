import assert from 'node:assert/strict';
import { createQuotaStore, readProviderUsage } from '../../core/usage.mjs';
import { createUsageSource, quotaFetchState, setupUsage } from '../../web/usage.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'usage-reset';
export const title = '使用量のリセット境界と更新通知・応答の競合';
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise(r => setImmediate(r));
const result = (used, revision, generation = 1) => ({ label: 'Agent', quota: { generation, revision,
  windows: [{ label: '5h', usedPercent: used, resetsAt: new Date(used === 96 ? 130_000 : 500_000).toISOString() }] } });

export default async function(t) {
  const check = async (label, fn) => {
    try { await fn(); t.ok(label, true); }
    catch (e) { t.ok(label, false, e.message); }
  };
  await check('TTL 内のリセット境界を越えた通常取得はキャッシュを取り直す', async () => {
    let now = 100_000, calls = 0;
    const store = createQuotaStore({ now: () => now });
    const fetcher = async () => { calls++; return result(calls === 1 ? 96 : 4, calls).quota; };
    await store.refresh('agent', fetcher);
    now = 131_000;
    assert.equal((await store.refresh('agent', fetcher)).windows[0].usedPercent, 4);
    assert.equal(calls, 2);
  });
  await check('pending 中の通知をまとめ、完了後に最新 snapshot を読む', async () => {
    const old = deferred(); let reads = 0;
    const source = createUsageSource(async () => ++reads === 1 ? old.promise : result(4, 2));
    const first = source.load('agent');
    const changed = () => source.changed ? source.changed('agent') : source.load('agent');
    changed(); changed(); changed();
    old.resolve(result(96, 1)); await first; await tick();
    assert.equal(source.get('agent').quota.revision, 2);
    assert.equal(reads, 2);
  });
  await check('force の新値を通常取得の古い応答で巻き戻さない', async () => {
    const old = deferred(), fresh = deferred();
    const source = createUsageSource(command => command === 'invoke' ? fresh.promise : old.promise);
    const normal = source.load('agent'), forced = source.load('agent', { force: true });
    fresh.resolve(result(4, 2)); await forced;
    old.resolve(result(96, 1)); await normal;
    assert.equal(source.get('agent').quota.windows[0].usedPercent, 4);
  });
  await check('通知の読み直しは外部取得を伴わない snapshot の問い合わせ', async () => {
    const calls = [], old = deferred();
    const source = createUsageSource((command, args) => {
      calls.push([command, args]); return calls.length === 1 ? old.promise : Promise.resolve(result(4, 2));
    });
    const pending = source.load('agent');
    source.changed('agent'); source.changed('agent');
    old.resolve(result(96, 1)); await pending; await tick();
    assert.deepEqual(calls.map(([, args]) => !!args.snapshot), [false, true]);
  });
  await check('ローカル集計待ちに更新通知が重なっても応答は最新 snapshot と revision にそろう', async () => {
    const store = createQuotaStore(), summary = deferred(); let reads = 0;
    const fetcher = async () => ({ windows: [{ label: '5h', usedPercent: ++reads === 1 ? 96 : 4 }] });
    await store.refresh('agent', fetcher);
    const source = createUsageSource(async (_command, args) => readProviderUsage({ id: 'agent', label: 'Agent' }, {
      read: () => args.snapshot ? store.get('agent') : store.refresh('agent', fetcher), latest: () => store.get('agent'),
      summary: () => summary.promise, held: () => [],
    }));
    store.subscribe(() => source.changed('agent'));
    const waiting = source.load('agent'); await tick();
    await store.refresh('agent', fetcher, { force: true });
    summary.resolve({ error: 'fixture' }); await waiting; await tick();
    assert.equal(reads, 2, '通知から外部取得を連鎖させない');
    assert.equal(source.get('agent').quota.revision, store.get('agent').revision);
    assert.equal(source.get('agent').quota.windows[0].usedPercent, 4);
  });
  await check('サーバーの新しい世代は低い revision でも採用し、旧世代の遅延応答は捨てる', async () => {
    const late = deferred(); let calls = 0;
    const source = createUsageSource(async () => ++calls === 1 ? result(96, 9, 1) : calls === 2 ? late.promise : result(4, 1, 2));
    await source.load('agent');
    const old = source.load('agent');
    await source.load('agent', { force: true });
    late.resolve(result(96, 10, 1)); await old;
    assert.equal(source.get('agent').quota.generation, 2);
    assert.equal(source.get('agent').quota.revision, 1);
  });
  await check('WS 再接続は初回の pending も同期し、切断前の結果を採用しない', async () => {
    const old = deferred(); let calls = 0;
    const source = createUsageSource(async () => ++calls === 1 ? old.promise : result(4, 1, 2));
    const first = source.load('agent');
    await source.reconnect();
    old.resolve(result(96, 100, 1)); await first;
    assert.equal(calls, 2);
    assert.equal(source.get('agent').quota.generation, 2);
  });
  await check('初回取得が失敗して結果が無くても WS 復帰で同期する', async () => {
    let calls = 0;
    const source = createUsageSource(async () => { if (++calls === 1) throw new Error('offline'); return result(4, 1, 2); });
    await assert.rejects(source.load('agent'));
    await source.reconnect();
    assert.equal(calls, 2); assert.equal(source.get('agent').quota.windows[0].usedPercent, 4);
  });
  await check('新しい世代が空・認証不可でも以前のアカウントの値を復活させない', async () => {
    let fresh = false;
    const source = createUsageSource(async () => fresh ? { quota: { generation: 2, revision: 1, windows: [], reason: 'no-login' } } : result(96, 9, 1));
    await source.load('agent'); fresh = true; await source.load('agent');
    assert.equal(source.get('agent').quota.generation, 2);
    assert.deepEqual(source.get('agent').quota.windows, []);
    assert.equal(source.get('agent').quota.reason, 'no-login');
  });
  await check('リセット境界より読み取り失敗の backoff が優先、手動 force だけは再試行', async () => {
    let now = 100_000, calls = 0;
    const store = createQuotaStore({ now: () => now });
    await store.refresh('agent', async () => result(96, 1).quota);
    now = 110_000;
    const fetcher = async () => { calls++; return { windows: [], reason: 'rate-limited' }; };
    await store.refresh('agent', fetcher, { force: true });
    now = 131_000;
    const waiting = await store.refresh('agent', fetcher);
    assert.equal(calls, 1); assert.equal(waiting.fetchState, 'retry-wait');
    assert.equal(waiting.staleSince, 100_000);
    await store.refresh('agent', fetcher, { force: true }); assert.equal(calls, 2);
  });
  await check('一部 skip のアカウントは更新中にせず、成功した別の行と値の時刻を分ける', async () => {
    let now = 100_000;
    const store = createQuotaStore({ now: () => now });
    const row = (id, used) => ({ accountId: id, windows: [{ label: '5h', usedPercent: used, resetsAt: new Date(now + 30_000).toISOString() }] });
    await store.refresh('agent', async () => ({ accounts: [row('a', 10), row('b', 20)] }));
    now += 1000;
    await store.refresh('agent', async () => ({ accounts: [{ accountId: 'a', windows: [], reason: 'no-login' }, row('b', 25)] }), { force: true });
    now += 31_000;
    const wait = deferred(); let skipped;
    const pending = store.refresh('agent', async ({ skip }) => { skipped = skip; return wait.promise; });
    await tick();
    const snapshot = store.get('agent');
    assert.deepEqual(snapshot.accounts.map(a => a.fetchState), ['retry-wait', 'pending']);
    assert.equal(quotaFetchState(snapshot.accounts[0], { pending: true }, now), 'retry-wait');
    assert.equal(snapshot.accounts[0].windows[0].usedPercent, 10);
    assert.equal(snapshot.accounts[0].checkedAt, 100_000);
    assert.deepEqual(skipped, ['a']);
    wait.resolve({ accounts: [{ accountId: 'a', skipped: true }, row('b', 4)] });
    const after = await pending;
    assert.equal(after.accounts[1].windows[0].usedPercent, 4);
    assert.equal(after.accounts[0].windows[0].usedPercent, 10);
    const forceWait = deferred();
    const forced = store.refresh('agent', async () => forceWait.promise, { force: true }); await tick();
    assert.equal(quotaFetchState(store.get('agent').accounts[0], { pending: true, force: true }, now), 'pending');
    forceWait.resolve({ accounts: [row('a', 3), row('b', 4)] }); await forced;
  });
  const clock = () => {
    let at = 100_000, visible = true, serial = 0;
    const timers = new Map();
    return { now: () => at, visible: () => visible,
      setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: at + delay }); return id; },
      clearTimer(id) { timers.delete(id); },
      hide(value) { visible = !value; },
      async advance(value) {
        at = value;
        for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.fn(); }
        await tick();
      }, count: () => timers.size };
  };
  await check('境界の通常取得は一度だけ。同じ過去時刻の成功応答でも更新中と短いループが残らない', async () => {
    const time = clock(), calls = [];
    const source = createUsageSource(async (command, args) => { calls.push([command, args]); return result(96, calls.length); }, time);
    await source.load('agent'); await time.advance(131_000);
    assert.equal(calls.length, 2); assert.equal(calls[1][0], 'providerUsage');
    assert.equal(calls[1][1].snapshot, undefined);
    assert.equal(source.state('agent').pending, false);
    assert.equal(time.count(), 0);
    await time.advance(150_000); assert.equal(calls.length, 2); source.dispose();
  });
  await check('非表示中の境界は復帰時に通常取得し、held の解除も同じ取得口を使う', async () => {
    const time = clock(); let calls = 0;
    const source = createUsageSource(async () => {
      calls++;
      return { ...result(4, calls), held: [{ until: new Date(130_000).toISOString() }] };
    }, time);
    await source.load('agent'); time.hide(true); await time.advance(131_000);
    assert.equal(calls, 1); time.hide(false); source.resume(); await tick();
    assert.equal(calls, 2); await time.advance(140_000); assert.equal(calls, 2); source.dispose();
  });
  await check('境界で前の取得が pending でも、完了後に通常取得を予約する', async () => {
    const time = clock(), wait = deferred(), calls = [];
    const source = createUsageSource(async (_command, args) => {
      calls.push(args); return calls.length === 2 ? wait.promise : result(calls.length === 1 ? 96 : 4, calls.length);
    }, time);
    await source.load('agent');
    const pending = source.load('agent'); await time.advance(131_000);
    wait.resolve(result(96, 2)); await pending; await tick();
    assert.equal(calls.length, 3); assert.ok(calls.every(args => !args.snapshot));
    assert.equal(source.get('agent').quota.windows[0].usedPercent, 4); source.dispose();
  });
  await check('全体の空応答で前回のアカウント値を保持する間もリセット予約を残す', async () => {
    const time = clock(); let calls = 0;
    const source = createUsageSource(async () => {
      calls++;
      return calls === 2 ? { quota: { windows: [] } } : { quota: { accounts: [{ accountId: 'a', ...result(calls === 1 ? 96 : 4, calls).quota }] } };
    }, time);
    await source.load('agent'); await source.load('agent');
    await time.advance(131_000); assert.equal(calls, 3);
    assert.equal(source.get('agent').quota.accounts[0].windows[0].usedPercent, 4); source.dispose();
  });
  await check('設定の使用量は表示中に 60 秒更新し、非表示・別ページでは取らず復帰時に同期', async () => {
    const saved = { document: globalThis.document, window: globalThis.window, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
    let periodic, delay, opened = true, reads = 0;
    const events = {}, els = new Map(), $ = id => els.get(id) ?? (els.set(id, new N('div')), els.get(id));
    const source = createUsageSource(async () => { reads++; return { label: 'Agent', quota: { windows: [] }, local: { error: 'fixture' } }; });
    try {
      globalThis.setInterval = (fn, ms) => { periodic = fn; delay = ms; return { unref() {} }; };
      globalThis.clearInterval = () => {};
      globalThis.document = { hidden: false, createElement: tag => new N(tag), addEventListener: (type, fn) => { events[type] = fn; } };
      globalThis.window = { addEventListener() {} };
      $('usagePanel').hidden = false;
      setupUsage({ $, source, getBackends: () => [{ id: 'agent' }], page() {}, isOpen: () => opened });
      assert.equal(delay, 60_000);
      periodic(); await tick(); assert.equal(reads, 1);
      document.hidden = true; periodic(); await tick(); assert.equal(reads, 1);
      document.hidden = false; $('usagePanel').hidden = true; periodic(); await tick(); assert.equal(reads, 1);
      $('usagePanel').hidden = false; opened = false; periodic(); await tick(); assert.equal(reads, 1);
      opened = true; events.visibilitychange(); await tick(); assert.equal(reads, 2);
    } finally { source.dispose(); Object.assign(globalThis, saved); }
  });
}
