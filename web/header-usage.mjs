// 使用量の札（入力欄の上の帯。docs/design-system.md「使用量の札」）。
// この会話のエージェント（新しい会話は入力欄で選んだもの）の枠のうち、使用率がいちばん高いものを 1 つだけ出す。
// 押すと全エージェントの一覧（浮く面）。トークン数・費用などの詳しい数字は、これまでどおり設定の「使用量」で見る。
//
// 取得は設定の「使用量」と同じ口（web/usage.mjs の createUsageSource）。同じエージェントの取得が走っていれば相乗りする。
// サーバーも 1 分はキャッシュを返す（core/server.mjs の providerQuota）ので、何度呼んでも各サービスへの問い合わせは増えない。
// 更新: 5 分ごと（見えている間）・ターンが終わった直後（そのエージェントの分）・一覧を開いたとき・↻。
// 取得に失敗したら直前の値を薄く出し、いつの値かを添える。（アカウントの行だけ読めなかったときは、その行の前回の枠を薄くせず出す。web/usage.mjs の carryQuota）
import { el } from './dom.mjs';
import { createConversationSheet } from './conversation-usage.mjs';
import { fmt, t } from './i18n.mjs';
import { isExpired, heldTexts, heldSlotName, heldTime, heldWindowName, heldGuess, quotaFetchState, expiredText, connectionOf, connectionName, connectionLabel, renderConnections } from './usage.mjs';

/** これ以上の使用率は強い見た目にする（帯の札・入力欄と bot のページのアカウントの行） */
export const HIGH = 80;
const EVERY = 5 * 60_000;
const DAY = 24 * 3600_000;

/** 今の使用率。時刻を過ぎた枠は今の値ではないので不明（null） */
export const usedOf = (w, now = Date.now()) => w?.usedPercent == null || isExpired(w, now) ? null : w.usedPercent;

/** 上限に達して、回復の時刻がまだ先 */
export function atLimit(w, now = Date.now()) {
  const used = usedOf(w, now);
  return used != null && (used >= 100 || w.remainingPercent === 0) && Boolean(w.resetsAt) && new Date(w.resetsAt).getTime() > now;
}

/** 表に出す率。100 に届いていないのに丸めて 100% と見せない */
export const percentText = used => used == null ? '—' : `${Math.min(Math.round(used), used < 100 ? 99 : 100)}%`;

/**
 * 会話で使うアカウントの使用量。Claude でアカウントを登録していれば quota.accounts にアカウントごとに並ぶ
 * （core/backends/claude-usage.mjs）。account は会話の設定の値で、'' はログイン中のアカウント（accountId の無い行）。
 * 見つからなければ null（別のアカウントの値を借りない）。登録が無ければ quota そのもの
 */
export function quotaOf(quota, account = '') {
  if (!Array.isArray(quota?.accounts) || !quota.accounts.length) return quota ?? null;
  return quota.accounts.find(a => account ? a.accountId === account : !a.accountId) ?? null;
}

/**
 * アカウントの行の右に出す、その週の使用量（docs/design-system.md「bot のページ」、ADR 0224）。
 * quota.accounts からそのアカウントの行だけを引く（無ければ出さない。quotaOf のように先頭の行へ寄せると、別のアカウントの値に見える）。
 * 枠は全体の週次（モデルの系統だけの週次は除く）。週の枠が無い・率が分からなければ null（行は今までの補足のまま）
 */
export function weekUsage(quota, account = '') {
  const rows = Array.isArray(quota?.accounts) && quota.accounts.length ? quota.accounts : null;
  const row = rows ? rows.find(a => account ? a.accountId === account : !a.accountId) : account ? null : quota;
  const used = usedOf((row?.windows ?? []).find(w => w.minutes === 10080 && !w.model && !w.limitName));
  return used == null ? null : { used, high: used >= HIGH };
}

/** 使用量の表示の認可が要る（済んでいない・やり直し・ログイン情報にトークンが無く再ログインが要る） */
export const needsAuth = row => Boolean(row?.needsUsageLogin || row?.reauth || row?.reason === 'no-login');

/** 枠の短い名前。Antigravity のグループ名の頭と、末尾の括弧書き（「週次（7日間）」の「（7日間）」）を外す */
export function shortLabel(w) {
  const full = String(w?.provider ? connectionLabel(w) : w?.label ?? '');
  let label = full;
  if (w?.group && label.startsWith(w.group)) label = label.slice(w.group.length).replace(/^[\s·・:：]+/, '');
  return label.replace(/\s*[（(][^（）()]*[）)]\s*$/, '') || full;
}

const familyOf = s => /(fable|opus|sonnet|haiku)/i.exec(String(s ?? ''))?.[1].toLowerCase() ?? null;
const modelWords = s => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * モデルに合う枠だけに絞る。枠の持つ系譜の情報と、モデル名を照合する（server 側の windowsFor と同じ判定）。
 * - w.provider … `openrouter/…` の `/` の前と一致するものだけ（OpenCode）。一致が無ければ空（別の接続先の枠は出せない）
 * - w.group … モデル名の語といちばん合うグループだけ。gemini / claude / gpt の系統名を含むグループに限る（Antigravity）
 * - w.model … モデルと同じ系統（fable/opus/sonnet/haiku）か、系統指定の無い枠だけ（Claude）
 * 系統・グループは合うものが見つからなければ全部返す（モデル名から系統が読めないときに空になる方が悪い）
 */
export function windowsForModel(windows = [], model = '') {
  const list = Array.isArray(windows) ? windows : [];
  const m = String(model ?? '');
  if (!m) return list;
  if (list.some(w => w.provider)) {
    const provider = m.split('/')[0];
    const matched = list.filter(w => !w.provider || w.provider === provider);
    return matched.length ? matched : [];
  }
  if (list.some(w => w.group)) {
    const tokens = new Set(modelWords(m));
    // backend-allow: モデルの系統の語（delegation-routing.mjs の windowsFor と同じ並び）。エージェントの分岐ではない
    const family = ['gemini', 'claude', 'gpt'].find(f => tokens.has(f));
    if (family) {
      const scored = [...new Set(list.map(w => w.group).filter(Boolean))]
        .filter(g => modelWords(g).includes(family))
        .map(g => [g, modelWords(g).filter(x => tokens.has(x)).length]);
      if (scored.length) {
        const best = Math.max(...scored.map(([, s]) => s));
        const groups = new Set(scored.filter(([, s]) => s === best).map(([g]) => g));
        const matched = list.filter(w => groups.has(w.group));
        if (matched.length) return matched;
      }
    }
    return list;
  }
  if (list.some(w => w.model)) {
    const family = familyOf(m);
    return list.filter(w => !w.model || (family && familyOf(w.model) === family));
  }
  return list;
}

/** チップに出す枠。使用率のいちばん高いもの（不明は除く）。無ければ null */
export function topWindow(windows, now = Date.now()) {
  let top = null;
  for (const w of windows ?? []) {
    const used = usedOf(w, now);
    if (used != null && (top == null || used > usedOf(top, now))) top = w;
  }
  return top;
}

/**
 * Antigravity はモデルのグループごとに枠を持つ（window.group）。いちばん使っているグループの枠だけを出し、
 * 残りは件数と「いずれも X% 未満」（10 刻みで切り上げ）にまとめる。グループが 1 つ以下なら全部
 */
export function groupsOf(windows = [], now = Date.now()) {
  const groups = new Map();
  for (const w of windows) {
    const key = w.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  if (groups.size <= 1) return { windows, group: null, others: 0, below: null };
  const peak = list => Math.max(-1, ...list.map(w => usedOf(w, now) ?? -1));
  const [[group, shown], ...rest] = [...groups].sort((a, b) => peak(b[1]) - peak(a[1]));
  const top = Math.max(-1, ...rest.map(([, list]) => peak(list)));
  return { windows: shown, group: group || null, others: rest.length, below: top < 0 || top >= 100 ? null : Math.min(100, Math.floor(top / 10) * 10 + 10) };
}

/**
 * チップの中身。枠が無いときも unknown として一覧への入口を残す。
 *   kind: 'auth' … 認可が要る（「使用量 —」を薄く）  'unknown' … 枠が無い・率が分からない  'value' … 率または上限
 */
export function chipState(row, now = Date.now()) {
  const window = topWindow(row?.windows, now);
  if (window) {
    const used = usedOf(window, now);
    return { kind: 'value', window, used, high: used >= HIGH, limit: atLimit(window, now) };
  }
  if (needsAuth(row)) return { kind: 'auth' };
  return { kind: 'unknown' };
}

/** 会話の枠（アカウント・モデル）に当たる止まっている枠。モデルが分からない（既定・アカウント全体）側はどのモデルの枠にも合わせる */
export function heldSlotsFor(held, { account = '', model = '' } = {}) {
  return (Array.isArray(held) ? held : []).filter(s => (s.account || '') === (account || '') && !(model && s.model && s.model !== model));
}
/**
 * 会話の枠（アカウント・モデル）が、上限で今止まっているか（providerUsage の held。Issue #111）。
 * 止まっていれば解除のいちばん遅い枠（分からないものが先）、無ければ null
 */
export function heldSlotOf(held, shown = {}, now = Date.now()) {
  let pick = null;
  for (const s of heldSlotsFor(held, shown)) {
    const until = s.until ? new Date(s.until).getTime() : null;
    if (until != null && !(until > now)) continue;
    if (!pick || until == null || (pick.until && until > new Date(pick.until).getTime())) pick = s;
    if (until == null) break;
  }
  return pick;
}

/** 残りの時間。「3 時間 10 分」「42 分」 */
function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours && rest ? t('usage.header.hoursMinutes', { hours, minutes: rest })
    : hours ? t('usage.header.hours', { hours }) : t('usage.header.minutes', { minutes });
}
/** 回復の時刻。24 時間より先なら日付を付ける */
const resetTime = (when, now) => new Date(when).getTime() - now < DAY ? fmt.time(when)
  : fmt.dateTime(when, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** 枠の下に添える回復の目安。「あと 3 時間 10 分で回復」「9/29(月) 9:00 に回復」「14:30 に回復（あと 42 分）」 */
export function resetText(w, now = Date.now(), row, request) {
  if (!w.resetsAt) return t('usage.resetsUnknown');
  if (isExpired(w, now)) return expiredText(row, request);
  const left = new Date(w.resetsAt).getTime() - now;
  if (left >= DAY) return t('usage.header.resetOn', { when: fmt.dateTime(w.resetsAt, { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
  return atLimit(w, now) ? t('usage.header.resetAtIn', { time: fmt.time(w.resetsAt), duration: duration(left) })
    : t('usage.header.resetIn', { duration: duration(left) });
}

/** Visible conversation bounds, including the desktop title bar and visual viewport. */
export function usagePopBounds(chip, column, viewport, titleBottom = 0) {
  const left = Math.max(column.left, viewport.left) + 8;
  const right = Math.min(column.right, viewport.right) - 8;
  const width = Math.max(0, Math.min(340, right - left));
  const top = Math.max(column.top, viewport.top, titleBottom) + 8;
  const bottom = Math.min(chip.top - 6, viewport.bottom - 8);
  return { left: Math.max(left, Math.min(chip.left, right - width)), width,
    bottom, maxHeight: Math.max(0, Math.min(560, bottom - top)) };
}

export function setupHeaderUsage({ $, source, getBackends, onUsageLogin, openSettings, onVisibility = () => {} }) {
  const chip = $('usageChip'), pop = $('usagePop');
  const mobile = globalThis.matchMedia?.('(max-width:700px)') ?? { matches: false, addEventListener() {} };
  let sheet = null, anchor = chip;
  const column = chip.closest?.('main');
  document.body?.append(pop);
  pop.tabIndex = -1;
  pop.setAttribute('aria-label', t('usage.header.title'));
  chip.setAttribute('aria-controls', pop.id || 'usagePop');
  const head = el('div', 'usage-pop-head');
  const heading = el('b', null, t('usage.header.title'));
  const when = el('span', 'when');
  const again = el('button', 'rf', '↻'); again.type = 'button';
  const dismiss = el('button', 'usage-pop-close', '×'); dismiss.type = 'button';
  dismiss.setAttribute('aria-label', t('usage.header.close'));
  dismiss.onclick = () => close(true);
  again.onclick = () => { if (again.getAttribute('aria-disabled') !== 'true') refresh(ids(), { force: true }); };
  head.append(heading, when, again, dismiss);
  const body = el('div', 'usage-pop-body'); body.tabIndex = 0;
  pop.append(head, body);
  mobile.addEventListener('change', () => { close(); onVisibility(); });
  // エージェントごとの最後の値。{ label, quota, failed }。failed は直前の取得に失敗した（quota はその前の値）
  const data = new Map();
  // asked は一度でも取りに行ったエージェント（あとから有効にしたエージェントを、次の 5 分を待たずに取るため）
  const asked = new Set();
  let shown = { backend: null, account: '', endpoint: '', model: '' }, lastRefresh = 0;
  // リセットと held の解除は共通 source が一度だけ取り直し、表示も同期する。

  // 枠・認可のどちらかを持つ結果だけを値として覚える。持たない（取得の失敗・未対応）ときは前の値を残す
  const usable = quota => Boolean(quota?.windows?.length || quota?.accounts?.length || Array.isArray(quota?.connections) || needsAuth(quota));
  function take(backend, result) {
    const prev = data.get(backend);
    // 止まっている枠（held）は使用率の取得とは別にサーバーが持つので、届いた値をそのまま使う
    const held = Array.isArray(result?.held) ? result.held : prev?.held ?? [];
    const newGeneration = result?.quota?.generation != null && prev?.quota?.generation != null && result.quota.generation !== prev.quota.generation;
    if (newGeneration || usable(result?.quota) || !prev || !usable(prev.quota)) data.set(backend, { label: result?.label, quota: result?.quota ?? null, failed: false, held });
    else data.set(backend, { ...prev, failed: true, held });
  }
  source.onResult((backend, result) => { take(backend, result); paint(); });
  source.onState?.(() => paint());

  const labelOf = id => data.get(id)?.label ?? getBackends().find(b => b.id === id)?.label ?? id;
  const ids = () => getBackends().map(b => b.id);

  async function refresh(list = ids(), { force = false } = {}) {
    if (!list.length) return;
    paint();
    if (list.length === ids().length) lastRefresh = Date.now();
    for (const id of list) asked.add(id);
    await Promise.all(list.map(id => source.load(id, { force }).catch(() => {
      const prev = data.get(id);
      data.set(id, { ...prev, failed: true });
      paint();
    })));
    paint();
  }

  // ---- チップ ----
  const mini = used => {
    const bar = el('span', 'usage-mini'); bar.setAttribute('aria-hidden', 'true');
    const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, used ?? 0))}%`;
    bar.append(fill); return bar;
  };
  // 文脈のメーターと同じ ▾（480px 以下は usage.css が隠す）
  const caret = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i caret'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M7 10l5 5 5-5');
    svg.append(path); return svg;
  };
  // 取得そのものが失敗した（前の値を薄く出す）か、アカウントの行だけ読めずサーバーが前回の値を残した（行の staleSince）
  const staleNote = (entry, row) => (entry?.failed || entry?.quota?.stale) && entry.quota?.checkedAt ? t('usage.header.stale', { when: fmt.relative(entry.quota.checkedAt) })
    : row?.staleSince ? t('usage.header.stale', { when: fmt.relative(row.staleSince) }) : '';

  function currentRow() {
    const entry = data.get(shown.backend);
    const account = quotaOf(entry?.quota, shown.account);
    const base = Array.isArray(account?.connections) ? connectionOf(account, shown.model) : account;
    return shown.endpoint ? null : base?.windows?.length ? { ...base, windows: windowsForModel(base.windows, shown.model) } : base;
  }
  function paintChip() {
    const entry = data.get(shown.backend);
    const account = quotaOf(entry?.quota, shown.account);
    const base = Array.isArray(account?.connections) ? connectionOf(account, shown.model) : account;
    // 枠が接続先・グループ・モデルの系統ごとに分かれているときは、会話のモデルに合うものだけを出す
    const row = base?.windows?.length ? { ...base, windows: windowsForModel(base.windows, shown.model) } : base;
    // 互換の接続先で動く会話はサブスクの枠を使わない
    const state = chipState(shown.endpoint ? null : row);
    chip.hidden = false;
    onVisibility();
    const agent = [labelOf(shown.backend), connectionName(base?.provider)].filter(Boolean).join(' '), stale = shown.endpoint ? '' : staleNote(entry, base);
    // 短い間隔の上限で止まっている枠は、日次・週次の率（0% のこともある）より先に出す
    const held = shown.endpoint ? null : heldSlotOf(entry?.held, shown);
    if (held) {
      const time = held.until ? heldTime(held.until) : null;
      // 5 時間・週の枠（window）で止まったものは、枠の上限の札と同じ言い方にする（短い間隔の上限とは言わない）
      const window = held.window ? heldWindowName(held.window) : null;
      const text = !time ? t('usage.header.heldUnknown') : window ? t('usage.header.limitUntil', { time }) : t('usage.header.heldUntil', { time });
      const pc = el('span', 'pc');
      pc.append(el('span', 'long', text), el('span', 'short', !time ? text : window ? t('usage.header.limitShort', { time }) : t('usage.header.heldShort', { time })));
      chip.className = 'usage-chip high';
      chip.replaceChildren(el('span', 'lb', window ?? t('usage.header.heldLabel')), mini(100), pc, caret());
      chip.setAttribute('aria-label', t('usage.header.chipLabel', { agent, text }));
      const when = !time ? t('usage.held.whenUnknown') : heldGuess(held) ? t('usage.held.whenGuess', { time }) : t('usage.held.whenUntil', { time });
      chip.title = window ? t('usage.header.heldWindowTitle', { agent, slot: heldSlotName(held, entry?.quota), window, when })
        : t('usage.header.heldTitle', { agent, slot: heldSlotName(held, entry?.quota), when });
      return;
    }
    chip.className = 'usage-chip' + (state.high ? ' high' : '') + (state.kind !== 'value' || entry?.failed || base?.staleSince ? ' dim' : '');
    if (state.kind !== 'value') {
      const text = shown.endpoint ? t('usage.header.endpointUnavailable')
        : !entry ? t('usage.loading')
        : state.kind === 'auth' ? t('usage.header.unauthorized')
        : row?.windows?.length ? t('usage.unknown') : t('usage.header.unavailable');
      chip.replaceChildren(el('span', 'lb', t('usage.header.title')), mini(0), el('span', 'pc', '—'), caret());
      chip.setAttribute('aria-label', shown.backend ? t('usage.header.chipLabel', { agent, text }) : t('usage.header.title'));
      chip.title = [!shown.endpoint && row?.message || text, stale].filter(Boolean).join(' · ');
      return;
    }
    const w = state.window, label = shortLabel(w);
    let text;
    if (state.limit) {
      const time = resetTime(w.resetsAt, Date.now());
      text = t('usage.header.limitUntil', { time });
      const pc = el('span', 'pc');
      pc.append(el('span', 'long', text), el('span', 'short', t('usage.header.limitShort', { time })));
      chip.replaceChildren(el('span', 'lb', label), mini(state.used), pc, caret());
    } else {
      text = percentText(state.used);
      chip.replaceChildren(el('span', 'lb', label), mini(state.used), el('span', 'pc', text), caret());
    }
    chip.setAttribute('aria-label', [t('usage.header.chipLabel', { agent, text: state.limit ? text : `${label} ${text}` }), stale, base?.state === 'failed' && t('usage.connection.failed')].filter(Boolean).join(' · '));
    chip.title = [t('usage.header.chipTitle', { agent, label: w.label, percent: percentText(state.used), reset: resetText(w) }), stale, base?.state === 'failed' && t('usage.connection.failed')].filter(Boolean).join(' · ');
  }

  // ---- 一覧（浮く面） ----
  function rows(windows, row, request) {
    const grid = el('div', 'usage-rows'), now = Date.now();
    for (const w of windows) {
      const used = usedOf(w, now), high = used != null && used >= HIGH ? ' high' : '';
      const name = el('span', 'wl', w.label); name.title = w.label;
      const bar = el('span', 'usage-bar' + high);
      name.setAttribute('aria-hidden', 'true');
      if (used != null) {
        bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', w.label);
        bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, used))));
        bar.setAttribute('aria-valuetext', percentText(used));
      } else {
        bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `${w.label} ${t('usage.unknown')}`);
      }
      const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, used ?? 0))}%`; bar.append(fill);
      const note = el('span', 'rs' + high, resetText(w, now, row, request));
      bar.setAttribute('aria-description', note.textContent);
      if (isExpired(w, now)) note.setAttribute('role', 'status');
      const value = el('span', 'v' + high, percentText(used)); value.setAttribute('aria-hidden', 'true');
      grid.append(name, value, bar, note);
    }
    return grid;
  }
  function agentSection(id, entry, current) {
    const endpoint = current && shown.endpoint;
    const row = endpoint ? null : quotaOf(entry?.quota, current ? shown.account : '');
    const section = el('section', 'usage-agent' + (entry?.failed ? ' usage-old' : ''));
    const request = { ...source.state?.(id) };
    if (entry?.failed && !request.pending) request.failed = true;
    const pending = !endpoint && quotaFetchState(row, request) === 'pending';
    section.setAttribute('aria-busy', String(pending));
    if (!endpoint && Array.isArray(row?.connections)) {
      const head = el('div', 'an', labelOf(id));
      const notes = [current && t('usage.header.thisConversation'), entry?.quota?.accounts?.length && row.label].filter(Boolean);
      if (notes.length) head.append(el('small', null, notes.join(' · ')));
      section.append(head);
      renderConnections(section, row, { model: current ? shown.model : '', request,
        retry: () => refresh([id], { force: true }),
        renderWindows: (target, c) => { if (c.windows.length) target.append(rows(c.windows, { ...c, reason: c.state === 'failed' ? 'error' : null }, request)); },
      });
      return section;
    }
    // 「この会話」の節はモデルに合う枠だけに絞り、残ったグループ・接続先は「ほか N グループ」にまとめる
    const all = row?.windows ?? [];
    const filtered = current ? windowsForModel(all, shown.model) : all;
    const shownSet = new Set(filtered);
    const rest = all.filter(w => !shownSet.has(w));
    const { windows, group, others, below } = groupsOf(filtered);
    const groupNames = new Set(filtered.map(w => w.group).filter(Boolean));
    const groupName = group ?? (current && rest.length && groupNames.size === 1 ? [...groupNames][0] : null);
    const now = Date.now();
    const peak = list => Math.max(-1, ...list.map(w => usedOf(w, now) ?? -1));
    const restPeak = peak(rest), restOthers = new Set(rest.map(w => w.group ?? w.provider).filter(Boolean)).size;
    const totalOthers = others + restOthers;
    const restBelow = restPeak < 0 || restPeak >= 100 ? null : Math.min(100, Math.floor(restPeak / 10) * 10 + 10);
    const mergedBelow = below == null ? restBelow : restBelow == null ? below : Math.min(below, restBelow);
    const notes = [current && t('usage.header.thisConversation'), row && entry?.quota?.accounts?.length && row.label,
      groupName && t('usage.header.group', { name: groupName })].filter(Boolean);
    const head = el('div', 'an', labelOf(id));
    if (notes.length) head.append(el('small', null, notes.join(' · ')));
    section.append(head);
    const stale = endpoint || row?.windows?.some(w => isExpired(w)) ? '' : staleNote(entry, row);
    if (stale) section.append(el('p', 'usage-note', stale));
    // 上限で止まっている枠（設定の「使用量」と同じ文。web/usage.mjs の heldTexts）。「この会話」の節は会話のアカウント・モデルに当たる枠だけ
    const heldLines = endpoint ? [] : heldTexts(current ? heldSlotsFor(entry?.held, shown) : entry?.held, entry?.quota);
    if (heldLines.length) {
      const box = el('div', 'usage-held'); box.setAttribute('role', 'status');
      for (const text of heldLines) box.append(el('p', null, text));
      section.append(box);
    }
    if (windows.length) section.append(rows(windows, row, request));
    if (totalOthers) section.append(el('p', 'more', mergedBelow == null ? t('usage.header.otherGroups', { count: totalOthers })
      : t('usage.header.otherGroupsBelow', { count: totalOthers, percent: mergedBelow })));
    if (needsAuth(row)) {
      section.append(el('p', 'usage-note', row.message || t('usage.header.unauthorized')));
      // 登録したアカウントの使用量は、アカウントごとに「使用量の表示を認可」が済んでから読める（web/usage.mjs と同じ口）
      if (row.accountId && onUsageLogin) {
        const button = el('button', 'btn btn-quiet', row.needsUsageLogin ? t('accounts.authorizeUsage') : t('usage.redoAuth'));
        button.type = 'button'; button.onclick = () => { close(); onUsageLogin(row.accountId); };
        section.append(button);
      }
    } else if (!windows.length) {
      const text = endpoint ? t('usage.header.endpointUnavailable') : !entry ? t('usage.loading')
        : row?.message || t('usage.header.unavailable');
      section.append(el('p', 'usage-note', text));
    }
    return section;
  }
  function paintPop() {
    if (pop.hidden) return;
    const quota = data.get(shown.backend)?.quota;
    const selected = connectionOf(quotaOf(quota, shown.account), shown.model);
    const checked = shown.endpoint ? null : selected ? selected.checkedAt : Array.isArray(quotaOf(quota, shown.account)?.connections) ? null : quota?.checkedAt;
    const busy = ids().some(id => {
      const quota = data.get(id)?.quota, request = source.state?.(id);
      const rows = Array.isArray(quota?.accounts) ? quota.accounts : [quota];
      return rows.some(row => quotaFetchState(row, request) === 'pending');
    });
    pop.setAttribute('aria-busy', String(busy));
    again.setAttribute('aria-disabled', String(busy));
    again.setAttribute('aria-label', busy ? t('usage.header.refreshing') : t('usage.header.refresh')); again.title = t('usage.header.refresh');
    again.replaceChildren('↻');
    if (busy) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'usage-refresh-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arc.setAttribute('d', 'M20 12a8 8 0 1 1-4-6.9'); svg.append(arc); again.replaceChildren(svg);
    }
    when.textContent = checked ? fmt.relative(checked) : '';
    const order = [shown.backend, ...ids().filter(id => id !== shown.backend)].filter(Boolean);
    const sections = order.map(id => agentSection(id, data.get(id), id === shown.backend));
    const focusable = 'button, summary, a';
    sections.forEach((section, index) => {
      for (const node of section.querySelectorAll(focusable)) {
        node.dataset.usageFocus = JSON.stringify([order[index], order[index] === shown.backend ? shown.account : '', node.tagName, node.className, node.textContent]);
      }
    });
    const foot = el('div', 'foot');
    const more = el('button', null, t('usage.header.openSettings'));
    more.dataset.usageFocus = 'settings';
    more.type = 'button'; more.onclick = () => { close(); openSettings(); };
    foot.append(more);
    const focusKey = document.activeElement?.getAttribute('data-usage-focus');
    const focusedInside = body.contains(document.activeElement);
    const scroll = body.scrollTop;
    const opened = [...pop.querySelectorAll('details')].map(d => d.hasAttribute('open'));
    const othersOpen = pop.querySelector('.usage-other-agents')?.hasAttribute('open') ?? false;
    const others = el('details', 'usage-other-agents');
    const summary = el('summary', null, t('usage.header.otherAgents')); summary.dataset.usageFocus = 'other-agents';
    others.append(summary, ...sections.slice(shown.backend ? 1 : 0));
    body.replaceChildren(...(shown.backend ? [sections[0]] : []), ...(others.children.length > 1 ? [others] : []), foot);
    [...pop.querySelectorAll('details')].forEach((d, i) => { d.open = opened[i] ?? false; });
    const otherAgents = pop.querySelector('.usage-other-agents');
    if (otherAgents) otherAgents.open = othersOpen;
    if (focusedInside) {
      const matches = [...body.querySelectorAll(focusable)].filter(node => focusKey && node.getAttribute('data-usage-focus') === focusKey);
      (matches.length === 1 ? matches[0] : body).focus({ preventScroll: true });
    }
    body.scrollTop = scroll;
  }
  function paint() {
    paintChip(); paintPop();
    const row = quotaOf(data.get(shown.backend)?.quota, shown.account);
    if (!shown.endpoint && quotaFetchState(row, source.state?.(shown.backend)) === 'pending') {
      const expired = windowsForModel(row?.windows, shown.model).filter(w => isExpired(w));
      if (expired.length) {
        const detail = t('usage.header.windowRefreshing', { window: expired.map(shortLabel).join(' · ') });
        chip.title = [chip.getAttribute('title'), detail].filter(Boolean).join(' · ');
        chip.setAttribute('aria-label', [chip.getAttribute('aria-label'), detail].filter(Boolean).join(' · '));
      }
    }
  }

  function bounds() {
    const view = window.visualViewport;
    const viewport = { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
      right: (view?.offsetLeft ?? 0) + (view?.width ?? document.documentElement.clientWidth),
      bottom: (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight) };
    return usagePopBounds(chip.getBoundingClientRect(), column?.getBoundingClientRect() ?? { ...viewport, top: 0 }, viewport,
      document.querySelector?.('.titlebar')?.getBoundingClientRect().bottom ?? 0);
  }
  function openSheet() {
    if (!sheet) {
      sheet = createConversationSheet(t('usage.header.title'), anchor);
      sheet.dialog.classList.add('usage-sheet');
      pop.removeAttribute('role');
      sheet.body.append(pop);
      heading.hidden = true; dismiss.hidden = true;
      sheet.dialog.querySelector('.conversation-sheet-head').insertBefore(head, sheet.dialog.querySelector('.conversation-sheet-close'));
      sheet.dialog.addEventListener('close', () => {
        stopFollowing();
        pop.hidden = true; document.body.append(pop); sheet = null;
        pop.prepend(head); heading.hidden = false; dismiss.hidden = false;
        pop.setAttribute('role', 'dialog');
        expanded(false);
      }, { once: true });
      pop.style.cssText = '';
      sheet.open();
      sheet.dialog.tabIndex = -1; sheet.dialog.focus({ preventScroll: true });
    }
  }
  function expanded(value) {
    chip.setAttribute('aria-expanded', String(value));
    anchor.setAttribute('aria-expanded', String(value));
    anchor.setAttribute('aria-controls', sheet?.dialog.id || pop.id || 'usagePop');
  }
  function positionPop() {
    if (sheet) return;
    const box = bounds();
    // No room for the heading and one quota: use the existing modal sheet.
    if (box.maxHeight < 180 || box.width < 200) { openSheet(); return; }
    const next = { left: `${box.left}px`, bottom: `${window.innerHeight - box.bottom}px`, width: `${box.width}px`, maxHeight: `${box.maxHeight}px` };
    for (const [key, value] of Object.entries(next)) if (pop.style[key] !== value) pop.style[key] = value;
  }
  let followFrame = 0;
  function stopFollowing() { if (followFrame) window.cancelAnimationFrame(followFrame); followFrame = 0; }
  function follow() {
    if (pop.hidden) return;
    positionPop();
    if (!sheet) followFrame = window.requestAnimationFrame?.(follow) ?? 0;
  }
  function open(opener = chip) {
    if (!pop.hidden) return;
    anchor = opener;
    pop.hidden = false;
    if (mobile.matches) openSheet();
    expanded(true);
    positionPop(); paintPop(); refresh();
    if (!sheet) pop.focus({ preventScroll: true });
    follow();
  }
  window.addEventListener('resize', () => { if (!pop.hidden) positionPop(); });
  document.addEventListener('ply-context-usage', () => { if (sheet) paintPop(); });
  function close(focus = false) {
    if (pop.hidden) return;
    stopFollowing();
    if (sheet) { sheet.dialog.close(); return; }
    pop.hidden = true; expanded(false);
    if (focus) anchor.focus({ preventScroll: true });
  }
  chip.onclick = e => { e.stopPropagation(); if (pop.hidden) open(); else close(true); };
  // 面の中の押下は描き直しで要素が外れることがあるので、closest ではなく押した時点の経路で見る
  document.addEventListener('click', e => { if (!sheet && !pop.hidden && !e.composedPath().includes(pop)) close(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing || pop.hidden) return;
    e.preventDefault?.(); e.stopImmediatePropagation?.();
    close(true);
  }, true);

  // 5 分ごと。隠れている間は取らず、見えたときに古ければ取る
  const due = () => !document.hidden && Date.now() - lastRefresh >= EVERY - 1000;
  const timer = setInterval(() => { if (due()) refresh(); }, 60_000);
  document.addEventListener('visibilitychange', () => { source.resume?.(); paint(); if (due()) refresh(); });
  window.addEventListener('pagehide', () => { stopFollowing(); clearInterval(timer); source.dispose?.(); }, { once: true });

  return {
    open,
    currentPercent: () => usedOf(topWindow(currentRow()?.windows)),
    /** 今の会話のエージェント・アカウント・互換の接続先・モデル。client.mjs の syncTopbar が呼ぶ */
    show(next) {
      shown = { backend: next.backend ?? null, account: next.account ?? '', endpoint: next.endpoint ?? '', model: next.model || next.models?.['']?.resolvesTo || '' };
      if (shown.backend && getBackends().length && (!lastRefresh || !asked.has(shown.backend))) refresh(lastRefresh ? [shown.backend] : ids());
      else paint();
    },
    /** どこかの会話のターンが終わった。そのエージェントの分だけ取り直す */
    turnEnded(backend) { refresh(backend ? [backend] : ids()); },
  };
}
