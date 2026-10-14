// リンクの開き先のシート（docs/inapp-browser.md「リモートから見る」、docs/design-system.md「リンクの開き先のシート」）。
// ホストの画面ではない端末（リモートの窓・モバイル版・LAN のブラウザー）で、会話のリンク・プレビューのリンクを押したとき、
// 下からのシートで「内蔵ブラウザーで開く / 既定のブラウザーで開く / リンクをコピー」を選ぶ（承認済み（2026-10-14））。
//   - 内蔵ブラウザーで開く: ホストの内蔵ブラウザーに新しいタブを足し、右パネルの「ブラウザー」でその映像を見る
//   - 既定のブラウザーで開く: この端末の既定のブラウザー（新しいタブ）
//   - localhost はこの端末では開けない（端末自身を指す）ので、シートを挟まずホストの内蔵ブラウザーのタブで開く（出すかどうかは呼び出し側が pcOnly で決める）
//   - ホストが映像を送れない（デスクトップ版でない npm start）・ホストの画面ではシートを出さない
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { isHostOnlyUrl } from './host-only-links.mjs';

const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON_SCREEN = svg('<path d="M3 4h18v12H3z"/><path d="M8 20h8M12 16v4"/>');
const ICON_EXTERNAL = svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>');
const ICON_COPY = svg('<path d="M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>');
const ICON_CLOSE = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const ICON_CHEVRON = svg('<path d="m9 5 7 7-7 7"/>');

/**
 * 出す選択肢。null ならシートも右クリックのメニューも出さない（呼び出し側が今までどおりに扱う）。
 * pcOnly は localhost など端末では開けない URL（シートは挟まず、ホストの内蔵ブラウザーのタブだけで開く）
 */
export function linkChoices({ url, pageOrigin, hostScreen = false, pcBrowser = false }) {
  if (hostScreen || !pcBrowser) return null;
  return { pcOnly: isHostOnlyUrl(url, pageOrigin) };
}

let sheet = null;
function build() {
  const wrap = el('div', 'link-sheet-wrap'); wrap.hidden = true;
  const veil = el('div', 'link-sheet-veil');
  const box = el('section', 'link-sheet');
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  const title = el('h3', null, t('timeline.link.openSheet')); title.id = 'linkSheetTitle';
  box.setAttribute('aria-labelledby', title.id);
  const close = el('button', 'btn btn-icon'); close.type = 'button';
  close.innerHTML = ICON_CLOSE; close.title = t('timeline.link.close'); close.setAttribute('aria-label', close.title);
  const head = el('div', 'link-sheet-head'); head.append(title, close);
  const url = el('div', 'link-sheet-url mono');
  const destination = (icon, label, chevron) => {
    const b = el('button', 'link-sheet-dest'); b.type = 'button';
    const text = el('span', 'link-sheet-dest-text', label);
    const small = el('small'); text.append(small);
    b.innerHTML = icon; b.append(text);
    if (chevron) { b.append(el('span', 'grow')); b.insertAdjacentHTML('beforeend', ICON_CHEVRON); }
    return { b, small };
  };
  const inApp = destination(ICON_SCREEN, t('timeline.link.openInApp'), true);
  inApp.small.classList.add('mono');
  const external = destination(ICON_EXTERNAL, t('browser.openExternal'), true);
  external.small.textContent = t('timeline.link.openOnDeviceSub');
  const copy = destination(ICON_COPY, t('timeline.link.copy'), false);
  copy.small.hidden = true;
  box.append(el('div', 'link-sheet-handle'), head, url, inApp.b, external.b, copy.b);
  wrap.append(veil, box);
  document.body.append(wrap);
  let current = null, returnFocus = null;
  const hide = () => {
    if (wrap.hidden) return;
    wrap.hidden = true; current = null;
    returnFocus?.focus?.({ preventScroll: true }); returnFocus = null;
  };
  const pick = which => { const action = current?.[which]; hide(); action?.(); };
  close.onclick = hide; veil.onclick = hide;
  inApp.b.onclick = () => pick('onInApp');
  external.b.onclick = () => pick('onExternal');
  copy.b.onclick = () => pick('onCopy');
  wrap.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } });
  return {
    wrap,
    show({ label, hostName, onInApp, onExternal, onCopy }) {
      current = { onInApp, onExternal, onCopy };
      returnFocus = document.activeElement;
      url.textContent = label;
      inApp.small.textContent = hostName || '';
      inApp.small.hidden = !hostName;
      wrap.hidden = false;
      inApp.b.focus({ preventScroll: true });
    },
    hide,
  };
}

/** シートを出す。{ label（URL）, hostName, onInApp, onExternal, onCopy } */
export function showLinkSheet(options) {
  sheet ??= build();
  sheet.show(options);
}
export function hideLinkSheet() { sheet?.hide(); }
export function linkSheetOpen() { return !!sheet && !sheet.wrap.hidden; }
