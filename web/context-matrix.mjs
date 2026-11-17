// 「名前ごと・エージェントごと」の一覧（外部 MCP・指示・Skills・Pleiad の指示・Hooks）が共通で使う小さな部品。
// 行の中身（何を並べてどこへ保存するか）はそれぞれのタブが持ち、ここでは行の並び・アイコン・スイッチ・確認・凡例だけをそろえる。

import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { agentName, conversationContextAgents } from './agent-brands.mjs';
import { brandMark } from './context-tabs.mjs';
import { ensureLockTips, lockReasonText, lockAriaLabel, joinLockReasons, spokenLockReason } from './lock-tip.mjs';

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

/**
 * 保存の知らせの文。fresh = Antigravity・Grok に渡る物が変わった。
 * pruned = 上限に届いて外した、もう無いフォルダー・ファイルの設定の数（{ places, keys }。黙って外さない。2 回目のレビュー B1）
 */
export const savedText = (fresh, pruned = null) => {
  let text = fresh ? t('context.savedFresh') : t('context.saved');
  const extra = [];
  // 場所とキーの両方を外したときは「上限に届いたため」を 1 回にまとめる
  if (pruned?.places > 0 && pruned?.keys > 0) extra.push(t('context.savedPrunedBoth', { places: pruned.places, keys: pruned.keys }));
  else if (pruned?.places > 0) extra.push(t('context.savedPrunedPlaces', { count: pruned.places }));
  else if (pruned?.keys > 0) extra.push(t('context.savedPrunedKeys', { count: pruned.keys }));
  // 続ける文は区切り（。・. ）から始まる。前の文の終わりの句点は重ねない
  if (extra.length) text = text.replace(/[.。]$/, '') + extra.join('');
  return text;
};

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
export function lockedAgentChip(agent, cell, name, { ariaLabel, key, keyAttr = 'fk', agentLabel = null } = {}) {
  const short = agentLabel ?? agentName(agent);
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
  const short = agentLabel ?? agentName(agent);
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

/** 1 つのオン・オフだけのスイッチ（Pleiad の指示の行。disabledReason があれば鍵つき aria-disabled にする） */
export function rowSwitch({
  role = 'switch',
  checked = false,
  labelText,
  disabledReason = null,
  key = null,
  keyAttr = 'fk',
  onToggle = null,
}) {
  const sw = matrixButton('cx-sw');
  sw.setAttribute('role', role);
  sw.setAttribute('aria-checked', String(Boolean(checked)));
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

let wholeSeq = 0;

/**
 * 行・まとまりの全体のスイッチ（外部 MCP・指示・Skills・Hooks の 4 つの表と会話の右パネルで共通。ADR 0337 §決定 4 の 2026-11-17 改訂・ToBe-A′）。
 * 形は今のスイッチのまま。一部だけオンなら横棒、押しても残る鍵つきのオン（fixed）があれば小さな鍵を重ねる。
 * role="checkbox" + aria-checked="true|mixed|false"（role="switch" は mixed を持てない）。
 * 読み上げ名は「項目名、いまの状態。押したときの動き」。鍵の理由（fixedReason）は名前に混ぜず、説明（aria-describedby）と鍵へのホバーに分ける。
 * disabledReason があるとき（押しても変わらない）だけ aria-disabled にして、スイッチ全体に鍵の吹き出しを付ける。
 */
export function wholeSwitch({
  state = 'false',
  fixed = false,
  fixedReason = null,
  name,
  next = 'off',
  disabledReason = null,
  key = null,
  keyAttr = 'fk',
  onToggle = null,
}) {
  const sw = matrixButton('cx-sw');
  sw.setAttribute('role', 'checkbox');
  sw.setAttribute('aria-checked', state);
  if (key) sw.dataset[keyAttr] = key;
  // i18n-dynamic: ui:context.rowSwitch.state
  const stateText = t(`context.rowSwitch.state.${state}`);
  if (disabledReason) {
    ensureLockTips();
    sw.setAttribute('aria-disabled', 'true');
    sw.dataset.tip = disabledReason;
    sw.setAttribute('aria-label', lockAriaLabel(t('context.rowSwitch.ariaState', { name, state: stateText }), disabledReason));
    if (fixed) { const lk = matrixLockGlyph(); lk.setAttribute('aria-hidden', 'true'); sw.append(lk); }
    return sw;
  }
  // i18n-dynamic: ui:context.rowSwitch.next
  sw.setAttribute('aria-label', t('context.rowSwitch.aria', { name, state: stateText, next: t(`context.rowSwitch.next.${next}`) }));
  if (fixed) {
    const lk = matrixLockGlyph();
    lk.setAttribute('aria-hidden', 'true');
    if (fixedReason) {
      ensureLockTips();
      // 鍵の上だけに理由を出す。押す動きは止めない（lock-tip.mjs の data-tip-pass）
      lk.dataset.tip = fixedReason;
      lk.dataset.tipPass = '';
      const desc = el('span', null, spokenLockReason(fixedReason));
      desc.hidden = true;
      desc.id = `cx-sw-why-${++wholeSeq}`;
      sw.setAttribute('aria-describedby', desc.id);
      sw.append(lk, desc);
    } else sw.append(lk);
  }
  if (onToggle) sw.onclick = onToggle;
  return sw;
}

/** 全体のスイッチの状態（集計済みの行から）。'true' | 'mixed' | 'false' */
export const wholeState = (row) => (row.rowMixed ? 'mixed' : row.rowSwitchOn ? 'true' : 'false');

/** 押したときの動き。変えられるオンがあれば 'off'（その分だけまとめてオフ）、無ければ外す前の選択に戻す 'restore'／はじめて使う 'on' */
export const wholeNext = (row) => (row.rowChangeableOn ? 'off' : row.rowRestore === 'was' ? 'restore' : 'on');

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
    const text = typeof a === 'string' ? agentName(a) : (a.label ?? agentName(a.id));
    const i = el('span', `li be-${id}`);
    i.append(brandMark(id), document.createTextNode(text));
    legend.append(i);
  }
  return legend;
}

/**
 * 鍵つきでオンのマス（Devin・Grok が自分で読むなど、Pleiad からは止められない物）の理由文。理由ごとに 1 回（重ねない）。
 * rows は 1 行でも、まとまりの子の配列でもよい。無ければ null
 */
export function docFixedReasons(doc, rows) {
  const out = [];
  for (const row of [].concat(rows ?? [])) {
    for (const a of doc?.agents ?? []) {
      const cell = row?.cells?.[a];
      if (!cell?.locked || !cell.on) continue;
      const text = lockReasonText(agentName(a), cell);
      if (!out.includes(text)) out.push(text);
    }
  }
  return joinLockReasons(out);
}

/** 押せない行（変えられるマスが無い・外す前の選択も無い）の理由文（右パネル・設定画面で共通）。鍵つきでオンのマスがあればその理由 */
export function docLockReason(doc, row) {
  const fixed = docFixedReasons(doc, row);
  if (fixed) return fixed;
  const lockAgent = doc?.agents?.find(a => row.cells?.[a]?.locked);
  return lockAgent ? lockReasonText(agentName(lockAgent), row.cells[lockAgent]) : t('context.matrix.locked');
}

/** まとまりのスイッチを押せないときの理由文。鍵つきでオンのマスがあればその理由、無ければ押せない子の理由 */
export function docRowLockSummary(doc, items) {
  const fixed = docFixedReasons(doc, items);
  if (fixed) return fixed;
  const r = items.find(e => e.rowLocked) ?? items[0];
  return r ? docLockReason(doc, r) : t('context.matrix.locked');
}

/**
 * 行のスイッチの見え方（core/context-doc-matrix.mjs の summarizeRowMeta と同じ。ADR 0337 §決定 4・2026-11-17 の改訂）。
 * 集計は、鍵の無いマスと鍵つきでオンのマスを数える（固定オフ・対象外のマスは分母に入れない）。
 * restore は、鍵の無いオンのマスが 1 つも無いときの戻し先（'was' | 'default' | null）。省略したら前の値を引き継ぐ
 */
export function recalcDocRow(row, agentIds, restore = row.rowRestore ?? null) {
  const unlocked = agentIds.filter(a => row.cells[a] && !row.cells[a].locked);
  const unlockedOn = unlocked.filter(a => row.cells[a].on);
  const lockedOn = agentIds.filter(a => row.cells[a]?.locked && row.cells[a]?.on);
  const onCount = unlockedOn.length + lockedOn.length;
  row.rowRestore = unlockedOn.length ? null : restore;
  row.rowLocked = unlocked.length === 0 || (unlockedOn.length === 0 && !row.rowRestore);
  row.rowMixed = onCount > 0 && onCount < unlocked.length + lockedOn.length;
  row.rowSwitchOn = onCount > 0;
  row.anyOn = onCount > 0;
  row.rowFixed = lockedOn.length > 0;
  row.rowChangeableOn = unlockedOn.length > 0;
  row.rowNextOn = unlockedOn.length === 0;
}

/**
 * まとまり（Skills のフォルダー・指示の置き場）のスイッチの見え方。子の全部のマスを同じ規則で集計する。
 * 押すと、変えられるオンのある子だけをオフにする（rowNextOn = false）。無ければ、外す前の記録のある子から戻す（無ければ初期値）。
 * keys は押したときに書く子の名前（押せない子は含めない）。keys が空なら押せない。
 * オフにする向きでも、外す前の記録だけを持つ子（先に自分の行のスイッチで外した子）を keys に含める。core が、今回は外していない子の
 * 古い戻し先を消すため（残すと、まとまりを戻したときにその子までオンになる）
 */
export function docBundleMeta(agentIds, items) {
  let unlocked = 0, unlockedOn = 0, lockedOn = 0;
  for (const r of items) {
    for (const a of agentIds) {
      const c = r.cells?.[a];
      if (!c) continue;
      if (!c.locked) { unlocked++; if (c.on) unlockedOn++; } else if (c.on) lockedOn++;
    }
  }
  const onCount = unlockedOn + lockedOn;
  const rowChangeableOn = unlockedOn > 0;
  const press = items.filter(r => !r.rowLocked);
  const rowRestore = rowChangeableOn ? null : press.some(r => r.rowRestore === 'was') ? 'was' : press.length ? 'default' : null;
  return {
    rowMixed: onCount > 0 && onCount < unlocked + lockedOn,
    rowSwitchOn: onCount > 0,
    anyOn: onCount > 0,
    rowFixed: lockedOn > 0,
    rowChangeableOn,
    rowNextOn: !rowChangeableOn,
    rowRestore,
    rowLocked: press.length === 0,
    keys: press.map(r => r.key),
  };
}

/** 1 つのマスを押した直後の見た目（保存の後に読み直す）。最後の変えられるオンを外したときは、core と同じく外す前の選択を覚えた扱いにする */
export function applyDocAgentLocal(row, agentIds, agent, on) {
  const c = row.cells[agent];
  if (!c || c.locked) return;
  const lastOn = !on && c.on && !agentIds.some(a => a !== agent && row.cells[a] && !row.cells[a].locked && row.cells[a].on);
  if (lastOn) row.rule = { ...(row.rule ?? {}), was: { off: [...(row.rule?.off ?? [])], spread: [...(row.rule?.spread ?? [])] } };
  c.on = Boolean(on);
  c.mode = on ? (c.native ? 'native' : 'spread') : 'off';
  recalcDocRow(row, agentIds, lastOn ? 'was' : null);
}

const setCellOn = (c, next) => { c.on = next; c.mode = next ? (c.native ? 'native' : 'spread') : 'off'; };

/**
 * 行のスイッチを押した直後の見た目（保存の後に読み直す）。core/context-agents.mjs の planDocRowPress と同じ規則。
 * - オフ（on: false）: 鍵の無いオンのマスをまとめてオフ。鍵つきのオンは残す。外す前の選択は row.rule.was に覚える
 * - オン（on: true）: 鍵の無いオンのマスがあれば変えない。無ければ、外す前の選択（was）→ 出どころのエージェントだけ、の順に戻す。
 *   allowDefault が false なら、記録の無い行は初期値へ広げない（まとまりで、もともとオフだった子をオンにしない）
 * 返り値: 見た目を変えたか
 */
export function applyDocRowLocal(row, agentIds, on, { allowDefault = true } = {}) {
  const unlocked = agentIds.filter(a => row.cells[a] && !row.cells[a].locked);
  const changeableOn = unlocked.filter(a => row.cells[a].on);
  if (!on) {
    if (!changeableOn.length) return false;
    row.rule = { ...(row.rule ?? {}), was: { off: [...(row.rule?.off ?? [])], spread: [...(row.rule?.spread ?? [])] } };
    for (const a of unlocked) setCellOn(row.cells[a], false);
    recalcDocRow(row, agentIds, 'was');
    return true;
  }
  if (changeableOn.length) return false;
  const was = row.rule?.was;
  const wasOn = a => (row.cells[a].native ? !(was.off ?? []).includes(a) : (was.spread ?? []).includes(a));
  if (was && unlocked.some(wasOn)) {
    for (const a of unlocked) setCellOn(row.cells[a], wasOn(a));
    recalcDocRow(row, agentIds, null);
    return true;
  }
  if (!allowDefault || row.rowRestore !== 'default') return false;
  // 自分で読むエージェントが 1 つも無い物（探す場所に足したフォルダー）は、渡せる全エージェント。あれば、それだけ
  const anyNative = agentIds.some(a => row.cells[a]?.native);
  for (const a of unlocked) setCellOn(row.cells[a], anyNative ? Boolean(row.cells[a].native) : true);
  recalcDocRow(row, agentIds, null);
  return true;
}

/** まとまりのスイッチを押した直後の見た目。core/context-doc-matrix.mjs の applyDocTouch と同じ順（外す前の記録のある子から戻し、無ければ初期値） */
export function applyDocBundleLocal(rows, agentIds, on) {
  if (!on) {
    for (const r of rows) {
      if (applyDocRowLocal(r, agentIds, false) || rows.length < 2 || !r.rule?.was) continue;
      // まとめて外したとき、今回は外していない子（先に外してあった子）の古い戻し先は消す（core の applyDocTouch と同じ）
      const { was, ...rest } = r.rule;
      r.rule = rest;
      recalcDocRow(r, agentIds, 'default');
    }
    return;
  }
  let changed = false;
  for (const r of rows) changed = applyDocRowLocal(r, agentIds, true, { allowDefault: false }) || changed;
  if (!changed) for (const r of rows) applyDocRowLocal(r, agentIds, true, { allowDefault: true });
}

/**
 * 会話の右パネルで、鍵つきでオンのマスの理由を開くボタン（エージェントのアイコンを並べない代わり。ToBe-A′）。
 * 鍵つきでオンのマスが無ければ空の配列。押しても何も変えない（aria-disabled）。理由は鍵へのホバー・フォーカス・タップで出す
 */
export function docReasonKey(doc, rows) {
  const reason = docFixedReasons(doc, rows);
  if (!reason) return [];
  ensureLockTips();
  const b = matrixButton('reason-key');
  b.setAttribute('aria-disabled', 'true');
  b.setAttribute('aria-label', lockAriaLabel(t('context.rowSwitch.reasonName'), reason));
  b.dataset.tip = reason;
  b.append(matrixLockGlyph());
  return [b];
}

/**
 * 全体のスイッチ 1 つ分（行・まとまり・作業場所の行で共通）。meta は行の集計（rowLocked・rowMixed・rowFixed・rowChangeableOn・rowRestore…）か
 * docBundleMeta の返り値。rows は鍵つきでオンのマスの理由を集める行（まとまりは子の配列）
 */
export function docRowSwitch({ doc, meta, rows, name, key, keyAttr = 'cxFk', onToggle }) {
  return wholeSwitch({
    state: wholeState(meta),
    fixed: Boolean(meta.rowFixed) && !meta.rowChangeableOn,
    fixedReason: docFixedReasons(doc, rows),
    name,
    next: wholeNext(meta),
    disabledReason: meta.rowLocked ? docRowLockSummary(doc, [].concat(rows)) : null,
    key,
    keyAttr,
    onToggle,
  });
}
