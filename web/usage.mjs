import { el } from './dom.mjs';
import { fmt, has, t } from './i18n.mjs';

const format = n => n == null ? t('usage.unknown') : fmt.number(n, { maximumFractionDigits: 1 });
/** リセット時刻を過ぎた枠。使用率は今の値ではない（更新待ち） */
export const isExpired = (window, now = Date.now()) => Boolean(window.resetsAt) && new Date(window.resetsAt).getTime() <= now;
/** 行ごとの待ち時間を優先し、読まなかったアカウントを取得中に見せない。 */
export function quotaFetchState(row, request = {}, now = Date.now()) {
  if (request.pending && request.force) return 'pending';
  if (request.failed) return 'failed';
  if (row?.fetchState === 'pending') return 'pending';
  if (row?.retryAt > now) return 'retry-wait';
  if (request.pending) return 'pending';
  if (request.failed || row?.reason || row?.fetchState === 'failed') return 'failed';
  return 'idle';
}
export const expiredText = (row, request) => {
  const state = quotaFetchState(row, request);
  return state === 'pending' ? t('usage.refreshing') : state === 'failed' || row?.reason ? t('usage.refreshFailed') : t('usage.retryWait');
};
export function quotaText(window, now = Date.now()) {
  return isExpired(window, now) ? '—'
    : window.usedPercent == null ? t('usage.percentUnknown')
    : t('usage.percent', { used: format(window.usedPercent), remaining: format(window.remainingPercent) });
}
/** 解除の見込みの時刻。24 時間より先なら日付を付ける */
export const heldTime = (until, now = Date.now()) => new Date(until).getTime() - now < 24 * 3600_000 ? fmt.time(until)
  : fmt.dateTime(until, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/**
 * 止まっている枠の名前（モデル・アカウント）。アカウントは quota.accounts の名前で引く（引けなければ出さない）。
 * アカウント全体の枠（window があり model が無い）の上限は、どのモデルでも止まっている
 */
export function heldSlotName(slot, quota) {
  const account = slot.account ? (quota?.accounts ?? []).find(a => a.accountId === slot.account)?.label : null;
  return [slot.model || (slot.window ? t('usage.held.allModels') : t('usage.held.defaultModel')), account].filter(Boolean).join(' · ');
}
/** 止まった枠の名前（Claude の five_hour など）。訳の無い名前（Codex の枠の名前）はそのまま */
// i18n-dynamic: usage.held.windows.
export const heldWindowName = window => has(`usage.held.windows.${window}`) ? t(`usage.held.windows.${window}`) : String(window);
/** 解除の時刻が分からないまま、振り分けが一定の間だけ外している枠（until は解除の見込みではない） */
export const heldGuess = slot => slot.reason === 'recently_limited' && !slot.resetsAt;
/**
 * 上限で今止まっている枠の一行（providerUsage の held。Issue #111）。until が過ぎたものは出さない。
 * 短い間隔の上限は日次・週次の枠が 0% でも止まっていることがあるので、枠の表とは別に出す。
 * 5 時間・週の枠（window）で止まったものは、その枠の上限として出す（短い間隔の上限とは言わない）
 */
export function heldTexts(held, quota, now = Date.now()) {
  return (Array.isArray(held) ? held : [])
    .filter(s => !s.until || new Date(s.until).getTime() > now)
    .map(s => {
      const slot = heldSlotName(s, quota);
      if (!s.until) return t('usage.held.open', { slot });
      const time = heldTime(s.until, now);
      if (s.window) return t('usage.held.window', { slot, window: heldWindowName(s.window), time });
      return heldGuess(s) ? t('usage.held.unknown', { slot, time }) : t('usage.held.until', { slot, time });
    });
}
function renderHeld(parent, held, quota) {
  const texts = heldTexts(held, quota);
  if (!texts.length) return;
  const box = el('div', 'usage-held');
  box.setAttribute('role', 'status');
  for (const text of texts) box.append(el('p', null, text));
  box.append(el('small', 'usage-note', t('usage.held.note')));
  parent.append(box);
}
function renderQuota(parent, quota, onUsageLogin, request) {
  const expired = quota.windows?.some(w => isExpired(w));
  if (quota.plan) parent.append(el('p', 'usage-note', t('usage.plan', { plan: quota.plan })));
  for (const w of quota.windows ?? []) {
    const row = el('div', 'usage-window');
    row.append(el('strong', null, w.label), el('span', 'usage-value', quotaText(w)));
    if (w.usedPercent != null && !isExpired(w)) {
      const meter = document.createElement('progress');
      meter.max = 100; meter.value = Math.min(100, w.usedPercent);
      meter.setAttribute('aria-label', t('usage.meter', { label: w.label }));
      row.append(meter);
    }
    const note = el('small', 'usage-note', isExpired(w) ? expiredText(quota, request) : w.resetsAt
      ? t('usage.resetsAt', { when: fmt.dateTime(w.resetsAt) }) : t('usage.resetsUnknown'));
    if (isExpired(w)) note.setAttribute('role', 'status');
    row.append(note);
    parent.append(row);
  }
  // 読めなかった行は、サーバーが前回の値を残して staleSince（その値の時刻）を添える（core/usage.mjs の createQuotaStore）
  if (quota.staleSince && !expired) parent.append(el('p', 'usage-note', t('usage.staleValue', { when: fmt.relative(quota.staleSince) })));
  for (const account of quota.accounts ?? []) {
    parent.append(el('h4', null, account.label)); renderQuota(parent, account, onUsageLogin, request);
  }
  if (quota.message && (!expired || quota.needsUsageLogin || quota.reauth || quota.reason === 'no-login')) parent.append(el('p', 'usage-note', quota.message));
  // 登録したアカウントの使用量は、アカウントごとに「使用量の表示を認可」が済んでから読める（core/backends/claude-usage.mjs）
  if ((quota.needsUsageLogin || quota.reauth) && quota.accountId && onUsageLogin) {
    const button = el('button', 'btn', quota.needsUsageLogin ? t('accounts.authorizeUsage') : t('usage.redoAuth'));
    button.type = 'button'; button.onclick = () => onUsageLogin(quota.accountId);
    parent.append(button);
  }
}
function renderLocal(parent, local) {
  parent.append(el('h4', null, t('usage.local.title')));
  if (local.error) { parent.append(el('p', 'usage-note', local.error)); return; }
  const table = el('table', 'usage-table');
  const heading = el('tr');
  for (const label of [t('usage.local.period'), t('usage.local.input'), t('usage.local.output'), t('usage.local.cost')]) heading.append(el('th', null, label));
  const head = el('thead'); head.append(heading); table.append(head);
  const body = el('tbody');
  for (const [label, total] of [[t('usage.local.fiveHour'), local.fiveHour], [t('usage.local.sevenDay'), local.sevenDay]]) {
    const row = el('tr'); row.append(el('th', null, label));
    for (const key of ['inputTokens', 'outputTokens', 'costUsd']) {
      const metric = total[key];
      const value = !total.turns ? t('usage.local.none') : metric.value == null ? t('usage.unknown')
        : key === 'costUsd' ? `$${metric.value.toFixed(4)}` : format(metric.value);
      const cell = el('td', null, value + (metric.measured > 0 && metric.measured < total.turns ? t('usage.local.partial') : ''));
      cell.title = t('usage.local.measured', { count: total.turns, measured: metric.measured });
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body); parent.append(table);
  parent.append(el('p', 'usage-note', local.since ? t('usage.local.noteSince', { when: fmt.dateTime(local.since) }) : t('usage.local.noteEmpty')));
}
/**
 * 互換の接続先ごとの見出しと「使用量は表示できません」（画面 4 の③）。枠（サブスクの使用率）は互換の先から返らない。
 * ローカル（localhost 等）は枠そのものが無い。Pleiad での使用実績はエージェントごとの表に含まれる（接続先ごとには分けていない）
 */
export function renderEndpoints(parent, endpoints) {
  if (!endpoints?.length) return;
  for (const e of endpoints) {
    parent.append(el('h4', null, t('usage.endpoint', { name: e.name })));
    let local = false;
    try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(e.baseUrl).hostname); } catch {}
    parent.append(el('p', 'usage-note', local ? t('usage.endpointLocal') : t('usage.endpointRemote', { name: e.name })));
  }
  parent.append(el('p', 'usage-note', t('usage.endpointCost')));
}
/**
 * 取れなかった行（枠が空）には前回取れた枠を引き継ぐ。行はアカウントごと（accountId。ログイン中は無し）。
 * 1 アカウントの読み取りの失敗・タイムアウト・rate_limits の無い応答で、札や一覧の行ごと消えないように。薄くはしない
 * （枠の時刻が過ぎれば isExpired で「—」になる）。使用量の認可が済んでいない行（needsUsageLogin）は引き継がない。
 * reauth の行は枠を出したうえで、認可のやり直しのボタンと文言を残す
 */
export function carryQuota(quota, prev) {
  if (!quota || !prev) return quota;
  const fill = (row, old) => !old?.windows?.length || row.windows?.length || row.needsUsageLogin ? row
    : { ...row, windows: old.windows, plan: row.plan ?? old.plan, fetchState: row.fetchState === 'retry-wait' ? 'retry-wait' : 'failed',
      staleSince: row.staleSince ?? old.staleSince ?? old.checkedAt ?? prev.checkedAt };
  if (Array.isArray(quota.accounts)) {
    const old = new Map((prev.accounts ?? []).map(a => [a.accountId ?? '', a]));
    return { ...quota, accounts: quota.accounts.map(a => fill(a, old.get(a.accountId ?? ''))) };
  }
  return prev.accounts ? quota : fill(quota, prev);
}
/**
 * providerUsage の取得。設定の「使用量」と会話のヘッダーのチップ（web/header-usage.mjs）が共有する。
 * 同じエージェントの取得が走っている間は、それに相乗りする（同時に 2 本投げない）。届いた結果は onResult で両方へ配る。
 * 前回の枠の引き継ぎ（carryQuota）もここでするので、両方に同じ値が出る。
 * force は人の読み直し（ボタン）。読めない間に延ばした読む間隔を待たず、すぐ読み直す（delegation.usageRefresh）
 */
export function createUsageSource(cmd, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  visible = () => typeof document === 'undefined' || !document.hidden } = {}) {
  const pending = new Map(), listeners = new Set(), last = new Map(), dirty = new Map(), states = new Map(), stateListeners = new Set();
  const accepted = new Map(), boundaries = new Map(), consumed = new Map();
  let serial = 0, connection = 0, timer = null, disposed = false;
  const emitState = backend => { for (const fn of stateListeners) fn(backend); };
  function schedule() {
    clearTimer(timer); timer = null;
    if (disposed || !visible() || !boundaries.size) return;
    const at = Math.min(...boundaries.values());
    timer = setTimer(resume, Math.min(2_147_483_647, Math.max(0, at - now() + 50)));
    timer?.unref?.();
  }
  function rememberBoundary(backend, result) {
    const quota = result?.quota;
    const rows = Array.isArray(quota?.accounts) ? quota.accounts : [quota];
    const times = [...rows.flatMap(row => (row?.windows ?? []).map(w => new Date(w.resetsAt).getTime())),
      ...(result?.held ?? []).map(s => new Date(s.until).getTime())];
    const old = boundaries.get(backend), used = consumed.get(backend);
    if (used) for (const at of used) if (!times.includes(at)) used.delete(at);
    const next = times.filter(at => Number.isFinite(at) && !used?.has(at) && (at > now() || at === old));
    if (next.length) boundaries.set(backend, Math.min(...next)); else boundaries.delete(backend);
    schedule();
  }
  function resume() {
    if (!visible()) { schedule(); return; }
    for (const [backend, at] of boundaries) if (at <= now()) {
      boundaries.delete(backend);
      if (!consumed.has(backend)) consumed.set(backend, new Set());
      consumed.get(backend).add(at);
      if (pending.has(backend)) dirty.set(backend, false);
      else load(backend).catch(() => {});
    }
    schedule();
  }
  function load(backend, { force = false, snapshot = false } = {}) {
    const running = pending.get(backend);
    if (running && (running.force || !force)) return running.task;
    const request = ++serial, epoch = connection;
    states.set(backend, { pending: true, failed: false, force });
    const read = force ? cmd('invoke', { op: 'delegation.usageRefresh', args: { backend } }) : cmd('providerUsage', { backend, ...(snapshot ? { snapshot: true } : {}) });
    const task = read.then(raw => {
      if (epoch !== connection) return last.get(backend) ?? raw;
      const prev = last.get(backend), before = accepted.get(backend), quota = raw?.quota;
      const older = before && (quota?.generation != null && before.generation != null && quota.generation !== before.generation
        ? quota.generation < before.generation : quota?.revision != null && before.revision != null && quota.revision !== before.revision
          ? quota.revision < before.revision : request < before.request);
      if (older) return prev ?? raw;
      // 再起動・認可の切替後の結果へ、別の世代の枠を引き継がない。
      const sameGeneration = quota?.generation == null || prev?.quota?.generation == null || quota.generation === prev.quota.generation;
      const result = quota ? { ...raw, quota: carryQuota(quota, sameGeneration ? prev?.quota : null) } : raw;
      accepted.set(backend, { generation: quota?.generation, revision: quota?.revision, request });
      const rows = Array.isArray(quota?.accounts) ? quota.accounts : [quota];
      if (pending.get(backend)?.task === task) states.set(backend, { pending: true, force,
        failed: !rows.some(row => row?.windows?.length || row?.fetchState === 'pending') });
      // 枠もアカウントの行も無い結果（取得の失敗）では前回を捨てない。次に 1 行だけ読めなかったときに引き継げなくなる
      if (!sameGeneration || result?.quota?.windows?.length || result?.quota?.accounts?.length) last.set(backend, result);
      rememberBoundary(backend, last.get(backend) ?? result);
      for (const listener of listeners) listener(backend, result);
      return result;
    }).catch(error => {
      if (epoch === connection && pending.get(backend)?.task === task) states.set(backend, { pending: false, failed: true });
      throw error;
    }).finally(() => {
      if (pending.get(backend)?.task !== task) return;
      pending.delete(backend);
      states.set(backend, { pending: false, failed: states.get(backend)?.failed ?? false });
      emitState(backend);
      if (dirty.has(backend)) {
        const snapshot = dirty.get(backend); dirty.delete(backend);
        load(backend, { snapshot }).catch(() => {});
      }
    });
    pending.set(backend, { task, force }); emitState(backend); return task;
  }
  function changed(backend) {
    if (pending.has(backend)) { if (!dirty.has(backend)) dirty.set(backend, true); return pending.get(backend).task; }
    return load(backend, { snapshot: true });
  }
  return {
    load, changed, resume,
    state: backend => states.get(backend) ?? { pending: false, failed: false },
    onState: listener => stateListeners.add(listener),
    dispose() { disposed = true; clearTimer(timer); },
    /** 前回取れた値（同期）。無ければ null。bot ページ・スレッド・入力欄が取得を待たずに描くのに使う */
    get: backend => last.get(backend) ?? null,
    /** 取得済みのエージェントを全部取り直す（サーバーから usageChanged の無効化が届いたとき） */
    reload() { return Promise.allSettled([...new Set([...last.keys(), ...states.keys(), ...pending.keys()])].map(changed)); },
    reconnect() {
      const ids = [...new Set([...last.keys(), ...states.keys(), ...pending.keys()])];
      connection++; pending.clear(); dirty.clear(); states.clear();
      return Promise.allSettled(ids.map(id => load(id)));
    },
    onResult: listener => listeners.add(listener),
  };
}
export function setupUsage({ $, cmd, source = createUsageSource(cmd), getBackends, page, isOpen, onUsageLogin, endpoints = async () => [] }) {
  let loading = false;
  // エージェントごとのカード。取り直しの間も前の表示を残し、取れてから差し替える（初回だけ「読み込み中…」）
  const cards = new Map();
  const versions = new Map();
  async function renderCard(backend, card, result) {
    const version = (versions.get(backend.id) ?? 0) + 1; versions.set(backend.id, version);
    const body = el('div'); body.append(el('h3', null, result.label));
    renderHeld(body, result.held, result.quota);
    renderQuota(body, result.quota, onUsageLogin, source.state?.(backend.id));
    if (result.quota.checkedAt) body.append(el('p', 'usage-note', t('usage.checkedAt', { when: fmt.dateTime(result.quota.checkedAt) })));
    renderEndpoints(body, await endpoints(backend.id).catch(() => []));
    renderLocal(body, result.local);
    if (versions.get(backend.id) !== version) return;
    card.replaceChildren(...body.children); card.dataset.loaded = '1';
  }
  async function refresh({ force = false } = {}) {
    if (loading) return;
    loading = true; $('refreshUsage').disabled = true;
    const root = $('usageCards'), list = getBackends();
    try {
      for (const [id, card] of cards) if (!list.some(b => b.id === id)) { card.remove(); cards.delete(id); }
      if (!list.length) root.replaceChildren(el('p', 'usage-note', t('usage.waiting')));
      else if (!cards.size) root.replaceChildren();
      await Promise.all(list.map(async backend => {
        let card = cards.get(backend.id);
        if (!card) {
          card = el('section', 'usage-card'); card.dataset.loaded = '';
          card.append(el('h3', null, backend.label), el('p', 'usage-note', t('usage.loading')));
          cards.set(backend.id, card); root.append(card);
        }
        try {
          const result = await source.load(backend.id, { force });
          await renderCard(backend, card, result);
        } catch { if (!card.dataset.loaded) card.replaceChildren(el('h3', null, backend.label), el('p', 'usage-note', t('usage.failed'))); }
      }));
    } finally { loading = false; $('refreshUsage').disabled = false; }
  }
  // サーバーから新しい値が届いた（usageChanged → source.load）ら、出ているカードを描き直す
  source.onResult((backend, result) => { const card = cards.get(backend); if (card && result) renderCard({ id: backend }, card, result).catch(() => {}); });
  source.onState?.(backend => {
    const card = cards.get(backend), result = source.get(backend);
    if (card && result) renderCard({ id: backend }, card, result).catch(() => {});
  });
  $('usageTab').onclick = () => { page('usage'); refresh(); };
  $('refreshUsage').onclick = () => refresh({ force: true });
  const visible = () => !document.hidden && isOpen() && !$('usagePanel').hidden;
  const timer = setInterval(() => { if (visible()) refresh(); }, 60_000);
  timer.unref?.();
  document.addEventListener?.('visibilitychange', () => { source.resume?.(); if (visible()) refresh(); });
  globalThis.window?.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
