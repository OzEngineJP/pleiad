// 接続先（CLI のログイン・登録したアカウント・互換の接続先）の 1 枚のカード。設定 › エージェント設定の「接続先」の一覧で、
// 3 つの持ち主（web/client.mjs・web/agent-accounts.mjs・web/compat-endpoints.mjs）が同じ形で描く。
// Claude のアカウント（web/claude-accounts.mjs）は文字列の HTML で同じ形（.mp-card.mp-acct.cc）を描く。
// 形: 名前（· 新しい会話の既定）と状態の 1 行 | 操作の組。組が横に収まらなければ、組ごと状態の行の下へ回る（web/manage-panel.css の .cc）。
// docs/design-system.md「接続先の一覧」（承認済み 2026-11-26）・ADR 0359。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

/** 名前の後ろの「· 新しい会話の既定」（既定のカード 1 枚だけに付く） */
export function defaultBadge() { return el('span', 'def', ` ${t('conn.isDefault')}`); }

/** HTML の文字列で描く持ち主（web/claude-accounts.mjs）向けの同じ印 */
export function defaultBadgeHtml(esc) { return `<span class="def"> ${esc(t('conn.isDefault'))}</span>`; }

/**
 * @param {{ name: string, isDefault?: boolean, status?: string, warn?: boolean,
 *   actions?: Array<{ label: string, onClick: () => void, act?: string, primary?: boolean, quiet?: boolean, aria?: string, disabled?: boolean } | null | false>,
 *   extra?: Node[], dataset?: Record<string,string>, confirming?: boolean }} o
 */
export function connCard({ name, isDefault = false, status = '', warn = false, actions = [], extra = [], dataset = {}, confirming = false }) {
  const card = el('div', 'mp-card mp-acct cc');
  for (const [k, v] of Object.entries(dataset)) card.dataset[k] = v;
  const head = el('div', 'mp-row mp-head'), info = el('div', 'mp-card-info'), nm = el('div', 'mp-name');
  const strong = el('strong', null, name);
  if (name.length > 20) strong.title = name;
  if (isDefault) strong.append(defaultBadge());
  nm.append(strong); info.append(nm);
  if (status) info.append(el('small', warn ? 'mp-ln warn' : 'mp-ln', status));
  const acts = el('div', `mp-card-actions${confirming ? ' away' : ''}`);
  for (const a of actions) {
    if (!a) continue;
    const b = el('button', `btn${a.primary ? ' btn-primary' : a.quiet ? ' btn-quiet' : ''}`, a.label);
    b.type = 'button';
    if (a.act) b.dataset.act = a.act;
    if (a.aria) b.setAttribute('aria-label', a.aria);
    if (a.disabled) b.disabled = true;
    b.onclick = (e) => { e?.stopPropagation(); return a.onClick(); };
    acts.append(b);
  }
  head.append(info, acts);
  card.append(head, ...extra.filter(Boolean));
  return card;
}

/** 削除の確認（カードの下に出す）。compat は「保存したキーも消えます。」を足す */
export function connConfirm({ name, withKey = false, onNo, onYes, yesLabel = t('conn.delete') }) {
  const box = el('div', 'mp-confirm');
  box.setAttribute('role', 'group');
  box.append(el('p', null, `${t('conn.confirmDelete', { name })}${withKey ? t('conn.keyAlsoDeleted') : ''}`));
  const row = el('div', 'mp-card-actions');
  const no = el('button', 'btn', t('conn.cancel')); no.type = 'button'; no.dataset.confirm = 'no'; no.onclick = onNo;
  const yes = el('button', 'btn danger', yesLabel); yes.type = 'button'; yes.dataset.confirm = 'yes'; yes.onclick = onYes;
  row.append(no, yes); box.append(row);
  return box;
}
