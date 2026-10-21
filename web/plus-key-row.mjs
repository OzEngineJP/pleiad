// 仮想のキー「Pleiad Plus」と OpenRouter のキーを 1 つだけ選ぶラジオの行（docs/plus.md「キー無しの機能」）。
// 設定 › 委譲「委譲先の自動選択に使うキー」と設定 › 通話のキーが同じ形を使う。行の形は設定 › リモートの選択肢（.rm-opts/.rm-row.rm-opt）。
// 状態はサーバーの delegationRouting・voice.status の plus（core/server.mjs の plusKeyInfo）をそのまま描くだけ。
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';

/** 「{date} に戻ります」の date（resetAt を画面の言語の日付に。例 11月1日・Nov 1） */
export const resetDateText = resetAt =>
  resetAt ? new Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric' }).format(new Date(resetAt)) : '';

/**
 * ラジオの 1 行。.rm-row.rm-opt（リモートの「つなぎ方」の選択肢と同じ）。
 * @param {object} o
 * @param {string} o.name     行の名前（Pleiad Plus / OpenRouter）
 * @param {string|Node} [o.sub]  右側の 2 行目（メール・上限の文言・キーの名前）
 * @param {boolean} o.checked  選んでいる印
 * @param {boolean} [o.disabled] 選べない
 * @param {Node} [o.end]      行の右端の部品（キーの選択）
 * @param {string} [o.focusKey] data-fk
 * @param {() => void} [o.onChoose]
 */
export function keyRadioRow({ name, sub = null, checked, disabled = false, end = null, focusKey = '', onChoose }) {
  const row = el('div', 'rm-row rm-opt');
  row.setAttribute('role', 'radio');
  row.setAttribute('aria-checked', String(checked));
  row.tabIndex = disabled ? -1 : 0;
  if (disabled) row.setAttribute('aria-disabled', 'true');
  if (focusKey) row.dataset.fk = focusKey;
  const text = el('span', 'rm-rt');
  text.append(el('span', 'rm-nm', name));
  if (sub) { const s = el('span', 'rm-sub'); s.append(sub); text.append(s); }
  row.append(el('span', 'rm-rd'), text);
  if (end) { const e = el('span', 'rm-end'); e.append(end); row.append(e); }
  if (!disabled && onChoose) {
    row.style.cursor = 'pointer';
    row.onclick = onChoose;
    row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChoose(); } };
  }
  return row;
}

/** ラジオの並び（radiogroup） */
export function keyRadioGroup(label, rows) {
  const opts = el('div', 'rm-opts');
  opts.setAttribute('role', 'radiogroup');
  opts.setAttribute('aria-label', label);
  opts.append(...rows);
  return opts;
}

/** 読み込み中の値の場所取り（.rm-skel）。読み上げは「読み込んでいます」 */
export function loadingMark() {
  const s = el('span', 'rm-skel');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', t('settings.plus.loading'));
  return s;
}

/** Plus の行を出すか（state: off・AGENT_HOST_PLUS=0 のときは行ごと出さない） */
export const plusRowVisible = info => info && info.available !== false && info.state !== 'off';

/**
 * Pleiad Plus の行。状態ごとの右と選べるかは docs/plus.md「画面の行」の表。
 * @param {object} o
 * @param {object} o.info      delegationRouting・voice.status の plus（{ state, available, signedIn, status, email, reachable, limitReached, resetAt }）
 * @param {boolean} o.checked
 * @param {( ) => void} o.onChoose  この行を選ぶ（選べないときは来ない）
 * @param {() => void} o.onLogin   ログインを始める
 * @returns {{ row: HTMLElement, selectable: boolean }}
 */
export function plusKeyRow({ info, checked, onChoose, onLogin }) {
  const p = info ?? {};
  const selectable = p.state !== 'maintenance' && p.signedIn === true && p.status === 'plus';
  let sub = null;
  if (p.state === 'maintenance') {
    sub = t('settings.plus.maintenance');
  } else if (p.signedIn && p.status === 'plus') {
    const box = el('span');
    box.append(document.createTextNode(p.email ?? ''));
    if (p.limitReached) box.append(el('br'), document.createTextNode(t('apiKeys.delegation.plusLimit', { date: resetDateText(p.resetAt) })));
    sub = box;
  } else if (p.signedIn && p.status == null) {
    // アカウントをまだ読めていない。読めるまで「使っていない」とは言わない（承認 2026-10-21）
    sub = p.reachable === false ? t('settings.plus.loadFailed') : loadingMark();
  } else if (p.signedIn) {
    // free・disabled
    sub = t('apiKeys.delegation.plusNotUsing');
  } else {
    const box = el('span');
    box.append(document.createTextNode(`${t('settings.plus.signedOut')} · `));
    const link = el('button', 'ak-link', t('settings.plus.signIn'));
    link.type = 'button';
    link.dataset.fk = 'plusLogin';
    link.onclick = e => { e.stopPropagation(); onLogin?.(); };
    box.append(link);
    sub = box;
  }
  return { selectable, row: keyRadioRow({ name: 'Pleiad Plus', sub, checked, disabled: !selectable, focusKey: 'plus', onChoose }) };
}
