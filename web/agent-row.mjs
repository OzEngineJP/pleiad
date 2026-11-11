// エージェントの行（docs/design-system.md「エージェントの行」）。初回の案内・「使えるエージェントがありません」・設定・会話の中の一覧・送れなかった行が同じ部品を使う。
// 1 本目の道 = 本体（未インストール → 未ログイン → ログイン中）。状態を持つ SDK がある（st.sdk）エージェントだけ 2 本目の道 = SDK（未取得 → 取得しています… → 取得済み）。
// どのエージェントがどう違うかは id ではなく状態の形（st.sdk の有無・installCommand）から読む。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { agentLevel, canPick } from './agent-usable.mjs';
import { backendLogo } from './side.mjs';
import { formatBytes } from './folder-upload.mjs';
import { openExternalLink } from './link-open.mjs';

/** 本体の段: noinst | waiting-install | nologin | expired | pending | unconfirmed | checkFailed | unknown | ok */
export function bodyKey(agent, st, { waiting = false, endpointConfirmed = false, endpointsKnown = true } = {}) {
  const lv = agentLevel({ st: st && { ...st, sdk: undefined }, endpointConfirmed, endpointsKnown, canEndpoint: Boolean(agent.capabilities?.compatEndpoints) });
  switch (lv.reason) {
    case 'notInstalled': return waiting ? 'waiting-install' : 'noinst';
    case 'loggedOut': return 'nologin';
    case 'pending': return 'pending';
    case 'expired': return 'expired';
    case 'unconfirmed': return 'unconfirmed';
    case 'checkFailed': return 'checkFailed';
    case 'unknown': return 'unknown';
    default: return st?.pending && st.loggedIn && !st.expired ? 'pending' : 'ok';   // 使えるが別のログインが進んでいる間は、待っている行と［やめる］を出す
  }
}

/** SDK の段: none | fetching | failed | ready。SDK を持たないエージェントは null */
export function sdkKey(st) {
  const sdk = st?.sdk;
  if (!sdk) return null;
  if (sdk.ready) return 'ready';
  if (sdk.fetching) return 'fetching';
  if (sdk.error) return 'failed';
  return 'none';
}

/**
 * 塗りのボタンを付ける一歩。使えるものが 0 のときだけ、いちばん近い 1 つ（未ログイン・期限切れ・SDK だけ残った本体済み）。
 * items: [{ id, body, sdk }]。答えは { id, step: 'body'|'sdk' } か null
 */
export function nearestStep(items, usableCount) {
  if (usableCount > 0) return null;
  for (const it of items) {
    if (it.body === 'nologin' || it.body === 'expired') return { id: it.id, step: 'body' };
    if (it.body === 'ok' && (it.sdk === 'none' || it.sdk === 'failed')) return { id: it.id, step: 'sdk' };
  }
  return null;
}

function stateEl(key, text, { wait = false } = {}) {
  const s = el('span', `st${key ? ` ${key}` : ''}`);
  if (wait) s.append(runMark());
  s.append(text);
  return s;
}

function bodyState(key, remote) {
  switch (key) {
    case 'noinst': return stateEl('out', t('settings.agents.notInstalled'));
    case 'waiting-install': return stateEl('wait', t('settings.agents.notInstalled'), { wait: true });
    case 'nologin': return stateEl('out', remote ? t('remote.loginOnHostShort') : t('settings.agents.loggedOut'));
    case 'expired': return stateEl('fail', t('settings.agents.expired'));
    case 'pending': return stateEl('wait', t('settings.agents.loginPending'), { wait: true });
    case 'unconfirmed': return stateEl('out', t('settings.agents.unconfirmed'));
    case 'checkFailed': return stateEl('out', t('settings.agents.checkFailed'));
    case 'ok': return stateEl('', t('settings.agents.stateOn'));
    default: return stateEl('out', t('settings.agents.unconfirmed'));
  }
}

function sdkState(st) {
  const sdk = st.sdk;
  switch (sdkKey(st)) {
    case 'none': return [stateEl('out', t('settings.agents.row.sdkNone'))];
    case 'fetching': {
      const f = sdk.fetching;
      const text = f.total
        ? t('settings.agents.claudeSdk.fetching', { received: formatBytes(f.received ?? 0), total: formatBytes(f.total) })
        : t('settings.agents.claudeSdk.fetchingUnknown', { received: formatBytes(f.received ?? 0) });
      const bar = el('span', 'bar mini');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', t('settings.agents.claudeSdk.progressLabel'));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const pct = f.total ? Math.min(100, Math.round(((f.received ?? 0) / f.total) * 100)) : 0;
      bar.setAttribute('aria-valuenow', String(pct));
      const fill = document.createElement('i');
      fill.style.width = f.total ? `${pct}%` : '30%';
      bar.append(fill);
      if (!f.total) bar.classList.add('ind');
      return [stateEl('fetching', text, { wait: true }), bar];
    }
    case 'failed': return [stateEl('fail', `⚠ ${sdkFailedText(sdk.error)}`)];
    case 'ready': return [stateEl('', t('settings.agents.row.sdkReady'))];
    default: return [];
  }
}

/** 取得の失敗の 1 行。理由があるときだけ「: 理由」を付ける（末尾が「:」で終わる行を出さない） */
export function sdkFailedText(error) {
  const reason = String(error?.detail ?? '').trim();
  return reason ? t('settings.agents.claudeSdk.failedWith', { error: reason }) : t('settings.agents.claudeSdk.failed');
}

function button(label, cls, onClick, extra = {}) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (extra.act) b.dataset.act = extra.act;
  if (extra.aria) b.setAttribute('aria-label', extra.aria);
  b.onclick = (e) => { e.stopPropagation(); onClick?.(); };
  return b;
}
const filled = (primary) => (primary ? 'btn btn-primary' : 'btn btn-quiet');

/** 本体の操作（1 つ）。null は操作なし */
export function bodyButton(agent, key, { primary = false, remote = false, on = {} } = {}) {
  if (remote) return null;
  switch (key) {
    case 'noinst': return button(t('settings.agents.install'), filled(primary), () => on.install?.(agent), { act: 'install' });
    case 'waiting-install': {
      const b = button('', 'ibtn', () => on.reopen?.(agent), { act: 'reopen', aria: t('settings.agents.row.openInstall') });
      b.append(extIcon());
      return b;
    }
    case 'nologin': return button(t('settings.agents.signIn'), filled(primary), () => on.login?.(agent), { act: 'login' });
    case 'expired': return button(t('settings.agents.signInAgain'), filled(primary), () => on.login?.(agent), { act: 'login' });
    case 'pending': return button(t('settings.agents.cancelLogin'), 'btn', () => on.cancel?.(agent), { act: 'cancel', aria: t('settings.agents.cancelLoginLabel', { agent: agent.label }) });
    case 'unconfirmed': return button(t('settings.agents.checkStatus'), 'btn btn-quiet', () => on.check?.(agent), { act: 'check' });
    default: return null;
  }
}

/** SDK の操作（1 つ） */
export function sdkButton(agent, st, { primary = false, remote = false, on = {} } = {}) {
  if (remote) return null;
  const k = sdkKey(st);
  if (k === 'none') return button(t('settings.agents.claudeSdk.fetch'), filled(primary), () => on.sdk?.(agent), { act: 'sdk' });
  if (k === 'failed') return button(t('settings.agents.claudeSdk.retry'), filled(primary), () => on.sdk?.(agent), { act: 'sdk' });
  return null;
}

/** 「規約が適用される」の 1 行（SDK が未取得のときだけ。押すことが同意なので、規約への道をここに置く） */
export function termsLine(termsUrl) {
  const a = el('a', 'lnk q', t('settings.agents.claudeSdk.terms'));
  a.href = termsUrl; a.target = '_blank'; a.rel = 'noreferrer';
  return a;
}

function extIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5');
  svg.append(p);
  return svg;
}

/** 本体が済んで SDK も済んだら SDK の行は畳む */
export const sdkFolded = (body, sdk) => body === 'ok' && sdk === 'ready';

/**
 * SDK の行（名前・状態・操作・規約の 1 行）。要素の並びは 3 列の格子に直に入る。
 * 本体が残っていても取得は出せる（独立した道）。塗りは近い一歩だけ
 */
export function sdkRows(agent, st, { body, primary, remote, on, termsUrl, flash }) {
  const k = sdkKey(st);
  if (!k || sdkFolded(body, k)) return [];
  const head = el('div', `ar2-m ar2-h ar2-sub${flash ? ' flash' : ''}`);
  head.dataset.path = 'sdk';
  head.append(el('span', 'ar2-sn', 'Claude Agent SDK'), (() => { const s = el('span', 'arow-s'); s.append(...sdkState(st)); return s; })());
  const act = el('div', 'ar2-a ar2-sub-a');
  const b = sdkButton(agent, st, { primary, remote, on });
  if (b) act.append(b);
  const out = [head, act];
  if (!remote && k === 'none') { const w = el('div', 'ar2-w ar2-d'); w.append(termsLine(termsUrl)); out.push(w); }
  return out;
}

/**
 * 行 1 つ。
 * o: { agent:{id,label,description,installCommand?}, st, remote, desc, waiting, copied, primary:'body'|'sdk'|null, logo=true, flash, termsUrl,
 *      endpointConfirmed, endpointsKnown, on:{install,login,cancel,reopen,copy,sdk,check}, pick:{selected, onPick}|null }
 */
export function agentRow(o) {
  const { agent, st, remote = false, desc = false, waiting = false, copied = false, primary = null, logo = true, flash = false, on = {}, pick = null, sdkOnly = false } = o;
  const body = bodyKey(agent, st, { waiting, endpointConfirmed: o.endpointConfirmed, endpointsKnown: o.endpointsKnown });
  const sdk = sdkKey(st);
  const row = el('div', `arow ar2${logo ? '' : ' nologo'}${flash ? ' flash' : ''}${pick?.selected ? ' sel' : ''}${pick ? ' pickable' : ''}`);
  row.dataset.row = agent.id;
  row.dataset.sig = `${body}/${sdk ?? ''}`;
  if (pick) {
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(Boolean(pick.selected)));
    row.tabIndex = pick.selected ? 0 : -1;
    row.dataset.pick = agent.id;
    row.onclick = () => pick.onPick?.(agent);
  }
  if (sdkOnly) { row.append(...sdkRows(agent, st ?? {}, { body, primary: primary === 'sdk', remote, on, termsUrl: o.termsUrl, flash: o.sdkFlash })); return row; }
  if (logo) row.append(backendLogo(agent.id, agent.label));
  const head = el('div', 'ar2-m ar2-h');
  const stWrap = el('span', 'arow-s');
  stWrap.append(bodyState(body, remote));
  head.append(el('span', 'arow-n', agent.label), stWrap);
  const act = el('div', 'ar2-a');
  const b = bodyButton(agent, body, { primary: primary === 'body', remote, on });
  if (b) act.append(b);
  row.append(head, act);
  if (desc && agent.description) row.append(el('div', 'ar2-w ar2-d', agent.description));
  if (!remote && body === 'waiting-install' && agent.installCommand) {
    const w = el('div', 'ar2-w');
    const line = el('div', 'ar2-cmd');
    const code = el('code', null, agent.installCommand);
    const copy = button(copied ? t('settings.agents.commandCopied') : t('settings.agents.copyCommand'), 'btn', () => on.copy?.(agent), { act: 'copy' });
    line.append(code, copy);
    w.append(line);
    row.append(w);
  }
  row.append(...sdkRows(agent, st ?? {}, { body, primary: primary === 'sdk', remote, on, termsUrl: o.termsUrl, flash: o.sdkFlash }));
  return row;
}

/**
 * 行の一覧を描き直す。前に描いたときと段が変わった行だけ flash を付け（ほかは動かさない）、居た場所（行 + 操作）へ焦点を戻す。
 * items: build(item, flash) が行を返す。key(item) が行の id
 */
export function paintAgentRows(container, items, build, key = (i) => i.agent.id) {
  const prev = new Map([...container.children].map((r) => [r.dataset.row, r.dataset.sig]));
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const keep = active ? { row: active.closest('[data-row]')?.dataset.row, act: active.dataset?.act ?? null, checked: active.getAttribute?.('aria-checked') != null } : null;
  const rows = items.map((item) => {
    const probe = build(item, false);
    const before = prev.get(key(item));
    return before != null && before !== probe.dataset.sig ? build(item, true) : probe;
  });
  container.replaceChildren(...rows);
  if (keep?.row) {
    const row = rows.find((r) => r.dataset.row === keep.row);
    (keep.act && row?.querySelector(`[data-act="${keep.act}"]`)) ? row.querySelector(`[data-act="${keep.act}"]`).focus() : (keep.checked ? row?.focus() : null);
  }
  return rows;
}

/**
 * 行の操作と「待っている」状態を持つ束。画面ごとに 1 つ作り、描くたびに build / paint を呼ぶ。
 * actions: { login(agent), cancel(agent), check(agent), sdk(agent) }（サーバーを呼ぶ操作は呼び出し側）
 * 「インストール」は公式の入れ方のページを開くだけ。済んだかは裏の再確認が見つける（開いたら「未インストール」を待っている形にする）
 */
export function createRowKit({ getAuth, getEndpoints, isRemote, termsUrl, actions, onChange, getAgents }) {
  const waiting = new Set();
  const copied = new Set();
  const sdkFlash = new Set();
  const on = {
    install: (a) => { if (a.installUrl) openExternalLink(a.installUrl); waiting.add(a.id); onChange?.(); },
    reopen: (a) => { if (a.installUrl) openExternalLink(a.installUrl); },
    copy: async (a) => {
      try { await navigator.clipboard.writeText(a.installCommand); } catch { /* 写せなくても「コピーしました」とは言わない */ return; }
      copied.add(a.id); onChange?.();
      setTimeout(() => { copied.delete(a.id); onChange?.(); }, 2000);
    },
    login: (a) => actions.login?.(a),
    cancel: (a) => actions.cancel?.(a),
    check: (a) => actions.check?.(a),
    sdk: (a) => actions.sdk?.(a),
  };
  const ctx = () => {
    const endpoints = getEndpoints?.() ?? null;
    return { endpoints, remote: Boolean(isRemote?.()) };
  };
  const bodyOf = (agent, c = ctx()) => bodyKey(agent, getAuth(agent.id), { waiting: waiting.has(agent.id), endpointConfirmed: Boolean(c.endpoints?.has(agent.id)), endpointsKnown: c.endpoints !== null });
  /** 使える数と、塗りにする一歩 */
  function plan(agents) {
    const c = ctx();
    const items = agents.map((a) => ({ id: a.id, body: bodyOf(a, c), sdk: sdkKey(getAuth(a.id)) }));
    const levelOf = (a) => agentLevel({ st: getAuth(a.id), endpointConfirmed: Boolean(c.endpoints?.has(a.id)), endpointsKnown: c.endpoints !== null, canEndpoint: Boolean(a.capabilities?.compatEndpoints) });
    const usable = agents.filter((a) => levelOf(a).level === 'usable').map((a) => a.id);
    const pickable = agents.filter((a) => canPick(levelOf(a))).map((a) => a.id);
    return { items, usable, pickable, near: nearestStep(items, usable.length) };
  }
  function build(agent, { flash = false, desc = false, logo = true, pick = null, near = null, sdkOnly = false } = {}) {
    const c = ctx();
    return agentRow({
      agent, st: getAuth(agent.id), remote: c.remote, desc, logo, flash, pick, termsUrl, on, sdkOnly,
      waiting: waiting.has(agent.id), copied: copied.has(agent.id), endpointConfirmed: Boolean(c.endpoints?.has(agent.id)), endpointsKnown: c.endpoints !== null,
      primary: near?.id === agent.id ? near.step : null,
    });
  }
  /** 一覧を描く。pickable(agent) が真の行だけ選べる（pick: { selected(id), onPick }） */
  function paint(container, agents, { desc = false, logo = true, pick = null } = {}) {
    const { near } = plan(agents);
    return paintAgentRows(container, agents, (agent, flash) => build(agent, {
      flash, desc, logo, near,
      pick: pick && pick.pickable(agent) ? { selected: pick.selected === agent.id, onPick: pick.onPick } : null,
    }), (a) => a.id);
  }
  /**
   * 選ぶ欄（エージェントの選択・bot / ルーティンのエージェント欄）の 1 行分。{ usable, status, op, terms }
   * status: 「本体の状態 · SDK の状態」（SDK を持たないものは本体だけ）。op: 右の操作は 1 つだけ（本体が残る間は本体、本体が済んで SDK が残るなら「取得する」。
   * 本体が残る間は SDK の取得を出さない）。terms: SDK の操作を出すときの規約の 1 行
   */
  function condensed(agent) {
    const c = ctx();
    const st = getAuth(agent.id);
    const lv = agentLevel({ st, endpointConfirmed: Boolean(c.endpoints?.has(agent.id)), endpointsKnown: c.endpoints !== null, canEndpoint: Boolean(agent.capabilities?.compatEndpoints) });
    const body = bodyOf(agent, c);
    const bodyEl = bodyState(body, c.remote);
    const words = [bodyEl.textContent];
    if (st?.sdk) words.push(sdkState(st).map((n) => n.textContent).filter(Boolean)[0] ?? '');
    let op = bodyButton(agent, body, { remote: c.remote, on });
    let terms = null;
    if (!op && body === 'ok' && st?.sdk) {
      op = sdkButton(agent, st, { remote: c.remote, on });
      if (op && (sdkKey(st) === 'none' || sdkKey(st) === 'failed')) terms = termsLine(termsUrl);
    }
    // 状態が 1 つだけ（SDK の無いエージェント）なら、名前の行の右に置けるよう、印つきの要素も返す
    return { usable: lv.level === 'usable', status: words.filter(Boolean).join(' · '), state: st?.sdk ? null : bodyEl, op, terms };
  }
  return { on, waiting, plan, build, paint, bodyOf, condensed };
}
