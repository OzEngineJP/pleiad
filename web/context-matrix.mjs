// 「名前ごと・エージェントごと」の一覧（外部 MCP・指示・Skills・Pleiad の指示・Hooks）が共通で使う小さな部品。
// 行の中身（何を並べてどこへ保存するか）はそれぞれのタブが持ち、ここでは行の並び・アイコン・スイッチ・確認・凡例だけをそろえる。

import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { agentShortLabel, conversationContextAgents } from './agent-brands.mjs';
import { brandMark } from './context-tabs.mjs';
import { ensureLockTips, lockReasonText, lockAriaLabel } from './lock-tip.mjs';

/**
 * 会話を始めるときだけ設定を読むエージェント（エージェントの記述の contextAt）。始まっている会話には次のターンでも届かないので、
 * ここに渡る物が変わった保存のときだけ「Antigravity と Grok は、新しい会話から反映します」と添える（レビューの決定 (b)）
 */
export const freshAgents = () => conversationContextAgents();

/** 指示・Skills の表の前と後で、Antigravity・Grok のマスのオン・オフが変わったか（前と後の両方にある行だけ比べる。読み直しで増えた・消えた行は数えない） */
export function docFreshChanged(before, after) {
  const rows = (d) => new Map([...(d?.rows ?? []), ...(d?.summaryRow ? [d.summaryRow] : [])].map((r) => [r.key, r]));
  const a = rows(before), b = rows(after);
  for (const [key, row] of b) {
    const prev = a.get(key);
    if (!prev) continue;
    if (freshAgents().some((agent) => (prev.cells?.[agent]?.on === true) !== (row.cells?.[agent]?.on === true))) return true;
  }
  return false;
}

/** 保存の知らせの文。fresh = Antigravity・Grok に渡る物が変わった */
export const savedText = (fresh) => (fresh ? t('context.savedFresh') : t('context.saved'));

export const MATRIX_ICON = {
  url: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>',
  stdio: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  connector: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  plugin: '<path d="M9 3v4m6-4v4M6 7h12v3.5a6 6 0 0 1-12 0zM12 16.5V21"/>',
  folder: '<path d="M4 7.5a2 2 0 0 1 2-2h3.5l2 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
};

export function matrixSvg(body) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = body;
  return s;
}

export function matrixLockGlyph() {
  const k = el('span', 'lk');
  k.append(matrixSvg(MATRIX_ICON.lock));
  return k;
}

export function matrixButton(cls, text) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/** 鍵つきで押せないエージェントアイコン（MCP・指示・Skills・Pleiad の指示・テストで共通） */
export function lockedAgentChip(agent, cell, name, { ariaLabel, key, keyAttr = 'fk' } = {}) {
  const short = agentShortLabel(agent, agent);
  const on = cell.on !== undefined ? Boolean(cell.on) : cell.state === 'on';
  const b = matrixButton(`cx-ag be-${agent}`);
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-disabled', 'true');
  b.dataset.agent = agent;
  if (key) b.dataset[keyAttr] = key;
  const reason = lockReasonText(short, cell);
  b.dataset.tip = reason;
  b.setAttribute('aria-label', lockAriaLabel(ariaLabel ?? t('mcp.matrix.agentAria', { agent: short, name }), reason));
  b.append(brandMark(agent), matrixLockGlyph());
  ensureLockTips();
  return b;
}

/**
 * 1 セル分のエージェントアイコン。
 * state: 'on' | 'off' | 'mixed' | 'lockon' | 'lockoff' | 'na' | 'hide'
 */
export function agentChip({
  agent,
  state,
  cell = null,
  name,
  agentLabel = null,
  ariaLabel = null,
  key = null,
  keyAttr = 'fk',
  title = null,
  onToggle = null,
}) {
  if (state === 'na') {
    const x = el('span', 'cx-ag na');
    x.setAttribute('aria-hidden', 'true');
    return x;
  }
  if (state === 'hide') {
    const x = el('span', 'cx-ag none');
    x.setAttribute('aria-hidden', 'true');
    return x;
  }
  const locked = state === 'lockon' || state === 'lockoff' || Boolean(cell?.locked) || cell?.mode === 'locked' || cell?.mode === 'blocked';
  if (locked) {
    return lockedAgentChip(agent, cell ?? { on: state === 'lockon' }, name, { ariaLabel, key, keyAttr });
  }
  const short = agentLabel ?? agentShortLabel(agent, agent);
  const pressed = state === 'mixed' ? 'mixed' : String(state === 'on' || Boolean(cell?.on));
  const b = matrixButton(`cx-ag be-${agent}`);
  b.dataset.agent = agent;
  if (key) b.dataset[keyAttr] = key;
  b.setAttribute('aria-pressed', pressed);
  b.setAttribute('aria-label', ariaLabel ?? t('context.matrix.agentAria', { agent: short, name }));
  b.title = title ?? short;
  b.append(brandMark(agent));
  if (onToggle) b.onclick = onToggle;
  return b;
}

/** 6 つのエージェントアイコンを並べる枠。ボタンが無ければ狭い画面用に .empty を付ける */
export function agentStrip({ agents, labelText, solo = false, renderCell }) {
  const ags = el('div', 'cx-ags');
  ags.setAttribute('role', 'group');
  ags.setAttribute('aria-label', labelText);
  for (const a of agents) ags.append(renderCell(a));
  const hasBtn = ags.querySelector
    ? Boolean(ags.querySelector('button'))
    : Array.from(ags.children ?? []).some(c => c.tagName === 'BUTTON');
  if (!hasBtn) ags.classList.add('empty');
  if (solo) ags.classList.add('solo');
  return ags;
}

/** 行またはまとまりのスイッチ（disabledReason があれば鍵つき aria-disabled にする） */
export function rowSwitch({
  role = 'switch',
  checked = false,
  mixed = false,
  labelText,
  disabledReason = null,
  key = null,
  keyAttr = 'fk',
  onToggle = null,
}) {
  const sw = matrixButton('cx-sw');
  sw.setAttribute('role', role);
  sw.setAttribute('aria-checked', mixed ? 'mixed' : String(Boolean(checked)));
  if (key) sw.dataset[keyAttr] = key;
  if (disabledReason) {
    ensureLockTips();
    sw.setAttribute('aria-disabled', 'true');
    sw.dataset.tip = disabledReason;
    sw.setAttribute('aria-label', lockAriaLabel(labelText, disabledReason));
  } else {
    sw.setAttribute('aria-label', labelText);
    if (onToggle) sw.onclick = onToggle;
  }
  return sw;
}

/** ほかのエージェントへ初めて広げるときの行内確認 */
export function askBanner({
  ariaLabel,
  text,
  cancelLabel,
  confirmLabel,
  cancelKey = null,
  confirmKey = null,
  keyAttr = 'fk',
  onCancel,
  onConfirm,
}) {
  const box = el('div', 'cx-ask');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', ariaLabel);
  box.append(el('span', 'q', text));
  const cancel = matrixButton('btn', cancelLabel);
  if (cancelKey) cancel.dataset[keyAttr] = cancelKey;
  cancel.onclick = onCancel;
  const ok = matrixButton('btn btn-primary', confirmLabel);
  if (confirmKey) ok.dataset[keyAttr] = confirmKey;
  ok.onclick = onConfirm;
  box.append(cancel, ok);
  return box;
}

/** 狭い画面向け: エージェントのロゴと短い名前の対応 */
export function agentLegend(agents) {
  const legend = el('div', 'cx-legend names');
  legend.setAttribute('aria-hidden', 'true');
  for (const a of agents) {
    const id = typeof a === 'string' ? a : a.id;
    const text = typeof a === 'string' ? agentShortLabel(a, a) : (a.label ?? agentShortLabel(a.id, a.id));
    const i = el('span', `li be-${id}`);
    i.append(brandMark(id), document.createTextNode(text));
    legend.append(i);
  }
  return legend;
}

/** 名前×エージェントの行全体がロックされているときの理由文（右パネル・設定画面で共通） */
export function docLockReason(doc, row) {
  const lockAgent = doc?.agents?.find(a => row.cells[a]?.locked && row.cells[a]?.on)
    ?? doc?.agents?.find(a => row.cells[a]?.locked);
  return lockAgent ? lockReasonText(agentShortLabel(lockAgent, lockAgent), row.cells[lockAgent]) : t('context.matrix.locked');
}

/** まとまりのスイッチの理由文。鍵つきでオンの行があれば、その行の理由（その行が残るのでスイッチが変わらない） */
export function docRowLockSummary(doc, items) {
  const r = items.find(e => e.rowLocked && e.rowSwitchOn) ?? items.find(e => e.rowLocked);
  return r ? docLockReason(doc, r) : t('context.matrix.locked');
}

/**
 * まとまりのスイッチを押せないか。全部の行が押せないか、鍵つきでオンの行が 1 つでもあれば押せない
 * （押してもオンのまま変わらない、を作らない。ADR 0337 §決定 4）
 */
export function docBundleLocked(items) {
  return items.every(e => e.rowLocked) || items.some(e => e.rowLocked && e.rowSwitchOn);
}

/**
 * 行のスイッチの見え方（core/context-doc-matrix.mjs の summarizeRowMeta と同じ）。
 * どれかのエージェントに渡っていればオン（鍵つきでオンも数える）。鍵つきでオンのマスが残る行は押せない
 */
export function recalcDocRow(row, agentIds) {
  const unlocked = agentIds.filter(a => !row.cells[a]?.locked);
  const unlockedOn = unlocked.filter(a => row.cells[a]?.on);
  const lockedOn = agentIds.filter(a => row.cells[a]?.locked && row.cells[a]?.on);
  const onCount = unlockedOn.length + lockedOn.length;
  row.rowLocked = unlocked.length === 0 || lockedOn.length > 0;
  row.rowMixed = onCount > 0 && onCount < unlocked.length + lockedOn.length;
  row.rowSwitchOn = onCount > 0;
  row.anyOn = onCount > 0;
}

/**
 * 行のスイッチを押した直後の見た目（保存の後に読み直す）。core/context-agents.mjs の setDocRowRule と同じ規則:
 * オフは鍵の無いマスを全部オフ。オンはオフにする前（rule.was）に戻し、無ければ出どころ（自分で読む）のエージェントだけ。
 * 自分で読むエージェントが無い物（探す場所に足したフォルダー）は、渡せる全エージェント
 */
export function applyDocRowLocal(row, agentIds, on) {
  const was = row.rule?.was;
  const anyNative = agentIds.some(a => row.cells[a]?.native);
  for (const a of agentIds) {
    const c = row.cells[a];
    if (!c || c.locked) continue;
    let next = false;
    if (on && was) next = c.native ? !(was.off ?? []).includes(a) : (was.spread ?? []).includes(a);
    else if (on) next = anyNative ? Boolean(c.native) : true;
    c.on = next;
    c.mode = next ? (c.native ? 'native' : 'spread') : 'off';
  }
  recalcDocRow(row, agentIds);
}
