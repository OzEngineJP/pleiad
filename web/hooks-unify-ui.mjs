// ==================== Pleiad の Hook の登録の部品と、会話の右パネルの記録（ADR 0049・0338） ====================
// docs/design-system.md「Hooks」。設定 › プラグイン › Hooks の表（web/hooks-matrix.mjs）が使う部品:
//   - 渡せない理由（reasonText）・渡し方の 1 行（deliveryText）。文は hooks.reason.*・hooks.warn.*（「写す」でなく「渡す・実行する」の言い方）
//   - Pleiad の登録の詳細（plyPeek）と追加・編集のシート（openPlyHookSheet）。登録は <data>/hooks.json で、エージェントの設定ファイルは書かない
//   - 会話の右パネルの面（unifySessionBox）: 渡した hooks・止めたネイティブ・渡せなかったもの・漏れ
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { HOOK_AGENTS, UNIFY_TARGETS, agentLabel, eventLabel } from './hooks-card.mjs';

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
// i18n-dynamic: hooks.reason.
/** 渡せない理由の文（hooks.reason.*）。知らないコードはコードのまま */
export function reasonText(r) {
  const k = `hooks.reason.${r.code}`, s = t(k, r.params ?? {});
  return s === k ? r.code : s;
}
// i18n-dynamic: hooks.warn.
/** 渡すときの注意の文（hooks.warn.*）。知らないコードは「動きが少し違う」とコードを添える */
export function warnText(w) {
  const k = `hooks.warn.${w.code}`, s = t(k, w.params ?? {});
  return s === k ? t('hooks.warn.other', { code: w.code }) : s;
}

// i18n-dynamic: hooks.unify.via.
/** その登録をエージェントへどう渡すか（1 行） */
export function deliveryText(agent, d) {
  if (!d) return t('hooks.unify.notTarget');
  if (d.status !== 'ok') return t('hooks.unify.cannotPass', { reasons: d.reasons.map(reasonText).join(' ') });
  const via = t(`hooks.unify.via.${agent}`);
  return d.adapter ? t('hooks.unify.viaAdapter', { via }) : via;
}
const rowTitle = r => r.name ?? r.command ?? r.event;

// ---------------------------------------------------------------- 画面の小さな決まり（テストで確かめる）
/** 登録のシートの matcher の上書き: 保存済みの値から始め、渡さない先・コマンドの形と同じエージェントの分だけ外す */
export const initialOverrides = hook => ({ ...(hook?.matchers ?? {}) });
export const sheetMatchers = ({ overrides, agent, targets }) =>
  Object.fromEntries(Object.entries(overrides).filter(([a, v]) => v && a !== agent && targets.includes(a)));

/** Pleiad の登録の詳細（行を開いたとき）。onChanged(view, true) は編集・削除の後 */
export function plyPeek(h, { cmd, onChanged, work }) {
  const box = el('div', 'cx-peek hk-peek');
  const facts = el('div', 'fm facts');
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') facts.append(el('span', 'k', k), el('span', 'v', String(v))); };
  put(t('hooks.unify.formLabel'), agentLabel(h.agent));
  put(t('hooks.fact.event'), `${eventLabel(h.event)} · ${h.event}`);
  put('matcher', h.matcher || '*');
  put('timeout', h.timeout ? t('hooks.fact.seconds', { n: h.timeout }) : t('hooks.fact.default'));
  put('async', String(h.async === true));
  put(t('hooks.unify.command'), h.command);
  if (h.importedFrom) put(t('hooks.unify.importedLabel'), `${agentLabel(h.importedFrom.agent)} · ${h.importedFrom.plugin ?? t(`hooks.scope.${h.importedFrom.scope}`)} · ${h.importedFrom.path}`);
  box.append(facts);
  const how = el('div', 'fm facts hk-how');
  how.append(el('span', 'k', t('hooks.unify.howTitle')), el('span', 'v', '…'));
  box.append(how);
  cmd('plyHookPreview', { value: { ...h, command: 'x' } }).then(r => {
    how.replaceChildren();
    for (const [a, label] of UNIFY_TARGETS) { const d = r.targets[a]; if (!d) continue; how.append(el('span', 'k', label), el('span', 'v' + (d.status === 'ok' ? '' : ' cx-strong'), deliveryText(a, d))); }
  }).catch(() => how.replaceChildren());
  box.append(el('p', 'msg', t('hooks.unify.peekNote')));
  const acts = el('div', 'acts');
  // 削除はその場で一度確かめる（登録だけを消す。エージェントの設定ファイルは変えない）
  const del = button(t('hooks.delete'), 'btn', () => {
    const ask = el('div', 'acts hk-ask');
    ask.append(el('span', 'cx-sub', t('hooks.unify.deleteConfirm', { name: h.name })), button(t('mcp.cancel'), 'btn', () => ask.replaceWith(acts)),
      button(t('hooks.confirm.delete'), 'btn btn-primary', () => work(async () => onChanged(await cmd('removePlyHook', { id: h.id }), true))));
    acts.replaceWith(ask);
    ask.querySelector('.btn-primary')?.focus();
  });
  acts.append(button(t('hooks.edit'), 'btn', () => openPlyHookSheet({ cmd, hook: h, onSaved: v => onChanged(v, true) })), del);
  box.append(acts);
  return box;
}

// ---------------------------------------------------------------- 追加・編集のシート（Pleiad の登録）
/** hook があれば編集。保存の前に、エージェントごとの渡し方（plyHookPreview）を確かめる */
export async function openPlyHookSheet({ cmd, hook = null, onSaved }) {
  document.querySelector('dialog.hk-sheet')?.remove();
  const dialog = el('dialog', 'mcp-sheet hk-sheet hk-ply-sheet');
  const form = el('form');
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  const heading = el('h3', null, hook ? t('hooks.unify.sheetEdit') : t('hooks.unify.sheetAdd'));
  heading.tabIndex = -1;
  dialog.setAttribute('aria-label', heading.textContent);
  let full = hook;
  if (hook) { try { full = await cmd('readPlyHook', { id: hook.id }); } catch (e) { form.append(heading, el('p', 'mcp-error', e.message), button(t('mcp.cancel'), 'btn', () => dialog.close())); dialog.showModal(); return; } }
  const scan = await cmd('scanHooks', { scope: 'user' }).catch(() => null);
  const events = scan?.events ?? {};
  const field = (text, control, ...notes) => { const box = el('div', 'mcp-field'), label = el('label', 'hk-label'); label.append(text, control); box.append(label, ...notes); return box; };
  const input = (value, placeholder, mono = false) => { const i = el('input'); i.className = `hk-input${mono ? ' mono' : ''}`; i.value = value ?? ''; i.placeholder = placeholder; i.autocomplete = 'off'; i.spellcheck = false; return i; };
  const name = input(full?.name, 'audit');
  const agent = el('select'); agent.className = 'hk-input';
  for (const [id, label] of HOOK_AGENTS) { const o = el('option', null, label); o.value = id; agent.append(o); }
  agent.value = full?.agent ?? 'claude';
  const event = el('select'); event.className = 'hk-input';
  const paintEvents = () => { const cur = event.value || full?.event || 'PreToolUse'; event.replaceChildren(); for (const e of events[agent.value] ?? []) { const o = el('option', null, `${e} — ${eventLabel(e)}`); o.value = e; event.append(o); } event.value = (events[agent.value] ?? []).includes(cur) ? cur : (events[agent.value]?.[0] ?? ''); };
  paintEvents();
  const matcher = input(full?.matcher, 'Bash', true);
  const command = input(full?.command, 'node ~/hooks/audit.mjs', true);
  const timeout = input(full?.timeout ? String(full.timeout) : '', t('hooks.sheet.timeoutDefault')); timeout.type = 'number'; timeout.min = '1';
  const asyncSelect = el('select'); asyncSelect.className = 'hk-input';
  for (const [v, text] of [['false', t('hooks.sheet.sync')], ['true', t('hooks.sheet.async')]]) { const o = el('option', null, text); o.value = v; asyncSelect.append(o); }
  asyncSelect.value = full?.async ? 'true' : 'false';
  const targets = el('fieldset', 'mcp-field hk-fieldset');
  targets.append(el('legend', null, t('hooks.unify.targets')));
  const chips = el('div', 'cx-chips');
  const boxes = UNIFY_TARGETS.map(([id, label]) => { const l = el('label', 'hk-check'), c = el('input'); c.type = 'checkbox'; c.value = id; c.checked = (full?.targets ?? [agent.value]).includes(id); l.append(c, document.createTextNode(label)); chips.append(l); return c; });
  targets.append(chips, el('p', 'mcp-note', t('hooks.unify.targetsNote')));
  // 渡す先ごとの matcher の上書き（自動で訳せないときに入れたもの）。編集では保存済みの値から始め、見せて変え・消せるようにする
  const overrides = initialOverrides(full);
  const overrideBox = el('div', 'mcp-field hk-overrides');
  const paintOverrides = () => {
    overrideBox.replaceChildren();
    const others = boxes.filter(b => b.checked && b.value !== agent.value).map(b => b.value);
    if (!others.length) { overrideBox.hidden = true; return; }
    overrideBox.hidden = false;
    overrideBox.append(el('span', 'hk-label', t('hooks.unify.matcherOverrides')));
    for (const a of others) {
      const i = input(overrides[a] ?? '', t('hooks.unify.matcherAuto'), true);
      i.setAttribute('aria-label', t('hooks.unify.matcherFor', { agent: agentLabel(a) }));
      i.oninput = () => { overrides[a] = i.value.trim(); };
      const line = el('label', 'hk-maprow');
      line.append(el('span', null, agentLabel(a)), i);
      overrideBox.append(line);
    }
    overrideBox.append(el('p', 'mcp-note', t('hooks.unify.matcherOverridesNote')));
  };
  for (const b of boxes) b.addEventListener('change', paintOverrides);
  paintOverrides();
  const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
  const acts = el('div', 'mcp-acts');
  const go = button(t('hooks.unify.sheetReview'), 'btn btn-primary'); go.type = 'submit';
  acts.append(button(t('mcp.cancel'), 'btn', () => dialog.close()), go);
  agent.onchange = () => { paintEvents(); paintOverrides(); };
  const parts = [heading, el('p', 'mcp-note', t('hooks.unify.sheetLead')), field(t('hooks.sheet.name'), name), field(t('hooks.unify.formLabel'), agent, el('p', 'mcp-note', t('hooks.unify.formNote'))),
    field(t('hooks.sheet.event'), event), field('matcher', matcher, el('p', 'mcp-note', t('hooks.unify.matcherNote'))), field(t('hooks.sheet.command'), command, el('p', 'mcp-note', t('hooks.sheet.commandNote'))),
    field(t('hooks.sheet.timeout'), timeout), field('async', asyncSelect), targets, overrideBox, error, acts];
  form.append(...parts);
  const value = () => ({ ...(hook ? { id: hook.id } : {}), name: name.value.trim(), agent: agent.value, event: event.value, matcher: matcher.value.trim(), command: command.value.trim(),
    timeout: timeout.value.trim() ? Number(timeout.value) : null, async: asyncSelect.value === 'true', targets: boxes.filter(b => b.checked).map(b => b.value),
    // 渡さない先・コマンドの形と同じエージェントの上書きだけを外す（元の agent や targets を変えたときに要らなくなったもの）
    matchers: sheetMatchers({ overrides, agent: agent.value, targets: boxes.filter(b => b.checked).map(b => b.value) }), enabled: hook ? hook.enabled : true });
  form.onsubmit = async ev => {
    ev.preventDefault();
    error.textContent = '';
    const v = value();
    if (!v.name) return void (error.textContent = t('hooks.unify.errorName'));
    if (!v.command) return void (error.textContent = t('hooks.error.command'));
    if (!v.targets.length) return void (error.textContent = t('hooks.error.agents'));
    await review(v);
  };
  /** 保存の前の確認: エージェントごとの渡し方。渡せない先は理由を出し、matcher を自動で訳せない先はここで入れる */
  async function review(v) {
    const box = el('div', 'hk-confirm');
    form.replaceChildren(heading, box);
    form.onsubmit = e => e.preventDefault();
    box.append(el('p', 'cx-sub', t('hooks.unify.reviewLoading')));
    let r;
    try { r = await cmd('plyHookPreview', { value: v }); } catch (e) { box.replaceChildren(el('p', 'mcp-error', e.message)); return; }
    box.replaceChildren(el('p', 'hk-q', t('hooks.unify.reviewLead')), el('p', 'cx-strong hk-warn', t('hooks.unify.reviewWarn')));
    for (const [a, label] of UNIFY_TARGETS) {
      const d = r.targets[a];
      if (!d) continue;
      const card = el('div', 'hk-target');
      const head = el('div', 'row-line');
      head.append(el('b', null, label), el('span', 'hk-state', d.status === 'ok' ? t('hooks.unify.passes') : t('hooks.unify.cannot')));
      card.append(head, el('p', d.status === 'ok' ? 'cx-sub' : 'cx-strong', deliveryText(a, d)));
      if (d.status === 'ok' && d.matcher !== undefined && d.matcher !== null && TOOL_EVENTS.has(d.event)) card.append(el('p', 'cx-sub', t('hooks.row.matcher', { matcher: d.matcher || '*' })));
      if (d.reasons?.some(x => /^matcher/.test(x.code) || x.code === 'partialTools')) {
        const i = input(overrides[a] ?? '', a === 'antigravity' ? 'run_command' : 'Bash', true);
        const again = button(t('hooks.unify.recheck'), 'btn', () => { overrides[a] = i.value.trim(); paintOverrides(); review(value()); });
        const line = el('div', 'hk-redo'); const l = el('label', 'hk-label'); l.append(t('hooks.unify.matcherFor', { agent: label }), i); line.append(l, again);
        card.append(line);
      }
      for (const w of d.warnings ?? []) card.append(el('p', 'mcp-note', warnText(w)));
      box.append(card);
    }
    const ackLabel = el('label', 'hk-check'), ack = el('input'); ack.type = 'checkbox';
    ackLabel.append(ack, document.createTextNode(t('hooks.confirm.ack')));
    const status = el('p', 'mcp-error'); status.setAttribute('role', 'alert');
    const save = button(t('hooks.unify.save'), 'btn btn-primary');
    save.disabled = true;
    ack.onchange = () => { save.disabled = !ack.checked; };
    save.onclick = async () => {
      save.disabled = true;
      try { const view = await cmd('savePlyHook', { value: v }); dialog.close(); onSaved?.(view); }
      catch (e) { status.textContent = e.message; save.disabled = false; }
    };
    const a = el('div', 'mcp-acts');
    a.append(button(t('hooks.confirm.back'), 'btn', () => { form.replaceChildren(...parts); form.onsubmit = formSubmit; heading.focus(); }), button(t('mcp.cancel'), 'btn', () => dialog.close()), save);
    box.append(ackLabel, status, a);
    heading.focus();
  }
  const formSubmit = form.onsubmit;
  dialog.showModal();
  heading.focus();
}

// ---------------------------------------------------------------- 会話の右パネル（担当が Pleiad の会話）
/**
 * unify: 会話の記録（contextSession.hooks）。渡した・止めた・動き続ける・渡せなかった・漏れ。推定で「実行済み」にしない（発火は別の面）
 */
/** 「このエージェントには Hooks を渡せません」の文。対応しているエージェントの名前が取れたときだけ括弧を添える */
export function unsupportedAgentText(agents = '') {
  return t('hooks.unify.session.unsupportedAgent', {
    agents: agents ? t('hooks.unify.session.supportedParen', { agents }) : '' });
}

export function unifySessionBox(unify, { kindBox, short = p => p, agents = '' }) {
  const k = kindBox('Hooks', t('hooks.unify.who'), true);
  if (unify.unsupportedAgent) { k.append(el('p', 'cx-sub', unsupportedAgentText(agents))); return k; }
  k.append(el('p', 'cx-sub', t('hooks.unify.session.lead', { time: new Date(unify.at).toLocaleString() })));
  if (unify.leaks?.length) {
    const n = el('div', 'scx-notice');
    n.append(el('p', 'cx-strong', t('hooks.unify.session.leakTitle', { n: unify.leaks.length })), el('p', 'cx-sub', unify.leaks.map(l => `${l.event} · ${l.name}${l.source ? ` (${l.source})` : ''}`).join(' / ')));
    k.append(n);
  }
  if (unify.untrusted) k.append(el('p', 'cx-strong', t('hooks.unify.session.untrusted', { n: unify.untrusted })));
  // Claude の通知は出どころを持たない。止めた定義と結べないネイティブの発火（管理者の hooks など）は漏れと言わずに分ける
  if (unify.unknownNative?.length) k.append(el('p', 'cx-sub', t('hooks.unify.session.unknownNative', { n: unify.unknownNative.length, names: unify.unknownNative.map(l => `${l.event} · ${l.name}`).join(' / ') })));
  const group = (title, rows, make, empty) => {
    k.append(el('p', 'scx-grp', t('hooks.unify.section', { title, n: rows.length })));
    if (!rows.length) { k.append(el('p', 'cx-sub', empty)); return; }
    for (const r of rows) k.append(make(r));
  };
  const item = (name, sub, mark = '·', on = false) => {
    const row = el('div', 'scx-item');
    const m = el('span', 'mark' + (on ? ' on' : ''), mark); m.setAttribute('aria-hidden', 'true');
    const body = el('div', 't');
    body.append(el('div', 'nm', name));
    if (sub) body.append(el('div', 'p', sub));
    row.append(m, body);
    return row;
  };
  // i18n-dynamic: hooks.unify.session.via.
  group(t('hooks.unify.session.supplied'), unify.supplied ?? [], s => item(s.name, [`${eventLabel(s.event)} · ${s.event}`, s.matcher ? t('hooks.row.matcher', { matcher: s.matcher }) : null,
    t(`hooks.unify.session.via.${s.via}`), s.from !== unify.agent ? t('hooks.unify.form', { agent: agentLabel(s.from) }) : null, s.adapter ? t('hooks.unify.session.viaAdapter') : null].filter(Boolean).join(' · '), '●', true), t('hooks.unify.session.noneSupplied'));
  // 出どころ。Codex の行は hooks/list の source（user・project・plugin・その他は管理者）
  const origin = s => s.plugin ? t('hooks.unify.pluginName', { name: s.plugin }) : t(`hooks.scope.${s.scope ?? (['user', 'project', 'plugin'].includes(s.source) ? s.source : 'managed')}`);
  group(t('hooks.unify.session.stopped'), unify.stopped ?? [], s => item(rowTitle(s), [origin(s),
    s.event ? `${eventLabel(s.event)} · ${s.event}` : null, s.unverified ? t('hooks.unify.skillUnverified') : null].filter(Boolean).join(' · '), '−'), t('hooks.unify.session.noneStopped'));
  if (unify.kept?.length) group(t('hooks.unify.session.kept'), unify.kept, s => item(rowTitle(s), [origin(s), s.event].filter(Boolean).join(' · ')), '');
  group(t('hooks.unify.session.unsupported'), unify.unsupported ?? [], s => item(s.name, `${s.event} · ${s.reasons.map(reasonText).join(' ')}`, '×'), t('hooks.unify.session.noneUnsupported'));
  if (unify.skipped?.length) k.append(el('p', 'cx-sub', t('hooks.unify.session.skipped', { names: unify.skipped.map(s => s.name).join(', ') })));
  k.append(el('p', 'cx-sub', t('hooks.unify.session.foot')));
  return k;
}
