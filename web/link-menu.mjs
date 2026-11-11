// 文中の URL・名前付きのリンクの、行き先の一行と右クリックのメニュー（docs/design-system.md「文中の URL」）。
//   - ホバー・キーボードのフォーカスで、会話の左下に「既定のブラウザーで開く」と URL の一行を出す（デスクトップ版のホストの画面だけ。
//     ブラウザーで開いた Pleiad はブラウザー自身が行き先を出す）
//   - 右クリック・長押し・Shift+F10 で「既定のブラウザーで開く / リンクをコピー」
// 押した後は web/link-open.mjs の openExternalLink に集まる
import { el, icon } from './dom.mjs';
import { t } from './i18n.mjs';
import { appLinkOf, openExternalLink, desktopHost } from './link-open.mjs';
import { notify } from './file-actions.mjs';

/** 行き先の一行の字。[行き先, URL（スキームを省く）] */
export function statusParts({ href }) {
  return [t('browser.openExternal'), href.replace(/^https?:\/\//i, '')];
}

/** 右クリックのメニューの項目（web/context-menu.mjs の形）。act は { openExternal, copy } */
export function linkMenuItems({ act }) {
  return [{ label: t('browser.openExternal'), onClick: act.openExternal }, { sep: true }, { label: t('timeline.link.copy'), onClick: act.copy }];
}

/** メニューの題は URL。長ければ先頭を省く（見たいのは末尾） */
export const menuTitle = href => (href.length > 44 ? `…${href.slice(-43)}` : href);

/** 配線する。showMenu は web/client.mjs の右クリックメニュー。statusLine は左下の一行を出すか（既定はデスクトップ版のホストの画面） */
export function setupLinkMenu({ showMenu, doc = document, statusLine = desktopHost }) {
  let status = null, hovered = null;

  function ensureStatus() {
    if (status) return status;
    const box = el('div', 'url-status'); box.setAttribute('aria-hidden', 'true');
    box.append(icon('M14 4h6v6M20 4l-9 9M18 14v5H5V6h5'), el('span', 'dest'), el('span', 'u'));
    (doc.querySelector('main') ?? doc.body).append(box);
    status = box;
    return box;
  }
  function paint(link) {
    // 会話の列の中だけ。ほかの面（右パネル・ダイアログ）には左下の場所が無い
    if (!link.closest('#log')) return;
    if (!statusLine()) return hide();
    const [label, url] = statusParts({ href: link.href });
    const box = ensureStatus();
    box.querySelector('.dest').textContent = label;
    box.querySelector('.u').textContent = url;
    // 入力欄の上に置く（入力欄の高さは複数行で変わる）
    const composer = doc.getElementById('composer'), main = box.parentElement;
    if (composer && main?.getBoundingClientRect) box.style.bottom = `${Math.max(0, main.getBoundingClientRect().bottom - composer.getBoundingClientRect().top) + 8}px`;
    box.classList.add('on');
  }
  const hide = () => { hovered = null; status?.classList.remove('on'); };
  const enter = link => { hovered = link; paint(link); };
  const leave = link => { if (hovered === link) hide(); };

  doc.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const link = appLinkOf(e.target);
    if (link) enter(link);
  });
  doc.addEventListener('pointerout', e => {
    const link = appLinkOf(e.target);
    if (link && !link.contains(e.relatedTarget)) leave(link);
  });
  doc.addEventListener('focusin', e => { const link = appLinkOf(e.target); if (link && e.target.matches?.(':focus-visible')) enter(link); });
  doc.addEventListener('focusout', e => { const link = appLinkOf(e.target); if (link) leave(link); });
  doc.addEventListener('click', hide, true);
  doc.addEventListener('scroll', () => { if (hovered) hide(); }, true);

  /** マウスなら押した位置、キーボード（ContextMenu キー・Shift+F10）なら要素の左下 */
  function pointAt(e, link) {
    if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
    const r = link.getBoundingClientRect();
    return { x: r.left + 8, y: r.bottom + 4 };
  }
  doc.addEventListener('contextmenu', e => {
    if (e.defaultPrevented) return;
    const link = appLinkOf(e.target);
    // 作業のダイアログの中は本体と同じメニュー（メニューは最前面のダイアログの中に出る。web/context-menu.mjs）。
    // ほかのダイアログは、メニューが下に隠れるので標準のままにする
    if (!link || (link.closest('dialog[open]') && !link.closest('#workDialog'))) return;
    const href = link.href;
    const items = linkMenuItems({ act: {
      openExternal: () => openExternalLink(href),
      copy: () => navigator.clipboard.writeText(href).then(() => notify(t('timeline.link.copied')), () => notify(t('timeline.link.copyFailed'))),
    } });
    e.preventDefault();
    hide();
    const at = pointAt(e, link);
    showMenu(at.x, at.y, items, menuTitle(href));
  });
}
