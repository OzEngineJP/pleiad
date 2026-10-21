import { el } from './dom.mjs';
import { fmt, t } from './i18n.mjs';

const format = n => n == null ? t('usage.unknown') : fmt.number(n, { maximumFractionDigits: 1 });
/** リセット時刻を過ぎた枠。使用率は今の値ではない（更新待ち） */
export const isExpired = (window, now = Date.now()) => Boolean(window.resetsAt) && new Date(window.resetsAt).getTime() <= now;
export function quotaText(window, now = Date.now()) {
  return isExpired(window, now) ? t('usage.expired')
    : window.usedPercent == null ? t('usage.percentUnknown')
    : t('usage.percent', { used: format(window.usedPercent), remaining: format(window.remainingPercent) });
}
/** 解除の見込みの時刻。24 時間より先なら日付を付ける */
export const heldTime = (until, now = Date.now()) => new Date(until).getTime() - now < 24 * 3600_000 ? fmt.time(until)
  : fmt.dateTime(until, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** 止まっている枠の名前（モデル・アカウント）。アカウントは quota.accounts の名前で引く（引けなければ出さない） */
export function heldSlotName(slot, quota) {
  const account = slot.account ? (quota?.accounts ?? []).find(a => a.accountId === slot.account)?.label : null;
  return [slot.model || t('usage.held.defaultModel'), account].filter(Boolean).join(' · ');
}
/**
 * 短い間隔の上限で今止まっている枠の一行（providerUsage の held。Issue #111）。
 * 日次・週次の枠が 0% でも止まっていることがあるので、枠の表とは別に出す。until が過ぎたものは出さない
 */
export function heldTexts(held, quota, now = Date.now()) {
  return (Array.isArray(held) ? held : [])
    .filter(s => !s.until || new Date(s.until).getTime() > now)
    .map(s => s.until ? t('usage.held.until', { slot: heldSlotName(s, quota), time: heldTime(s.until, now) })
      : t('usage.held.unknown', { slot: heldSlotName(s, quota) }));
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
function renderQuota(parent, quota, onUsageLogin) {
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
    row.append(el('small', 'usage-note', w.resetsAt
      ? t('usage.resetsAt', { when: fmt.dateTime(w.resetsAt) }) : t('usage.resetsUnknown')));
    parent.append(row);
  }
  for (const account of quota.accounts ?? []) {
    parent.append(el('h4', null, account.label)); renderQuota(parent, account, onUsageLogin);
  }
  if (quota.message) parent.append(el('p', 'usage-note', quota.message));
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
    : { ...row, windows: old.windows, plan: row.plan ?? old.plan };
  if (Array.isArray(quota.accounts)) {
    const old = new Map((prev.accounts ?? []).map(a => [a.accountId ?? '', a]));
    return { ...quota, accounts: quota.accounts.map(a => fill(a, old.get(a.accountId ?? ''))) };
  }
  return prev.accounts ? quota : fill(quota, prev);
}
/**
 * providerUsage の取得。設定の「使用量」と会話のヘッダーのチップ（web/header-usage.mjs）が共有する。
 * 同じエージェントの取得が走っている間は、それに相乗りする（同時に 2 本投げない）。届いた結果は onResult で両方へ配る。
 * 前回の枠の引き継ぎ（carryQuota）もここでするので、両方に同じ値が出る
 */
export function createUsageSource(cmd) {
  const pending = new Map(), listeners = new Set(), last = new Map();
  function load(backend) {
    if (pending.has(backend)) return pending.get(backend);
    const task = cmd('providerUsage', { backend }).then(raw => {
      const result = raw?.quota ? { ...raw, quota: carryQuota(raw.quota, last.get(backend)?.quota) } : raw;
      // 枠もアカウントの行も無い結果（取得の失敗）では前回を捨てない。次に 1 行だけ読めなかったときに引き継げなくなる
      if (result?.quota?.windows?.length || result?.quota?.accounts?.length) last.set(backend, result);
      for (const listener of listeners) listener(backend, result);
      return result;
    }).finally(() => pending.delete(backend));
    pending.set(backend, task); return task;
  }
  return {
    load,
    /** 前回取れた値（同期）。無ければ null。bot ページ・スレッド・入力欄が取得を待たずに描くのに使う */
    get: backend => last.get(backend) ?? null,
    /** 取得済みのエージェントを全部取り直す（サーバーから usageChanged の無効化が届いたとき） */
    reload() { return Promise.allSettled([...last.keys()].map(id => load(id))); },
    onResult: listener => listeners.add(listener),
  };
}
export function setupUsage({ $, cmd, source = createUsageSource(cmd), getBackends, page, isOpen, onUsageLogin, endpoints = async () => [] }) {
  let loading = false;
  // エージェントごとのカード。取り直しの間も前の表示を残し、取れてから差し替える（初回だけ「読み込み中…」）
  const cards = new Map();
  async function renderCard(backend, card, result) {
    const body = el('div'); body.append(el('h3', null, result.label));
    renderHeld(body, result.held, result.quota);
    renderQuota(body, result.quota, onUsageLogin);
    if (result.quota.checkedAt) body.append(el('p', 'usage-note', t('usage.checkedAt', { when: fmt.dateTime(result.quota.checkedAt) })));
    renderEndpoints(body, await endpoints(backend.id).catch(() => []));
    renderLocal(body, result.local);
    card.replaceChildren(...body.children); card.dataset.loaded = '1';
  }
  async function refresh() {
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
          const result = await source.load(backend.id);
          await renderCard(backend, card, result);
        } catch { if (!card.dataset.loaded) card.replaceChildren(el('h3', null, backend.label), el('p', 'usage-note', t('usage.failed'))); }
      }));
    } finally { loading = false; $('refreshUsage').disabled = false; }
  }
  // サーバーから新しい値が届いた（usageChanged → source.load）ら、出ているカードを描き直す
  source.onResult((backend, result) => { const card = cards.get(backend); if (card && result) renderCard({ id: backend }, card, result).catch(() => {}); });
  $('usageTab').onclick = () => { page('usage'); refresh(); };
  $('refreshUsage').onclick = refresh;
}
