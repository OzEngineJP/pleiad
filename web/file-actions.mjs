// ファイルの操作メニュー（docs/design-system.md「ファイルの操作」）。
// ⋯ ボタン・右クリック・Shift+F10 のどれでも同じ中身を開く。場所（右パネルの頭・ツリー・画像・会話のリンク）で変えない。
// 開くのは web/client.mjs の showMenu（会話一覧と同じ 1 つのメニュー。2 つ持つと同時に開きうる）。
// OS の操作（エクスプローラー・ブラウザー）はサーバーのある PC の画面から見ているときだけ出す。
// 出さないだけでなく、サーバーも断る（core/server.mjs の revealPath / openPath）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { folderIcon, openInBrowserIcon, copyIcon, downloadIcon, fileIcon, closeIcon } from './icons.mjs';

const isHtml = path => /\.html?$/i.test(String(path ?? ''));

/**
 * メニューの項目。run(action) が実際の操作をする（file-preview.mjs）。開くのは Pleiad のページ（クリック）なので、ここには OS の操作と写す・持ち出すだけを並べる。
 * @param {{ path:string, kind?:'file'|'directory'|null }} target
 * @param {{ osActions:boolean, canUse?:boolean, defaultAppAllowed?:boolean, run:(action:string)=>void }} env
 *   defaultAppAllowed はサーバーが既定のアプリで開いてよいと返した種類の実体か（core/server.mjs の resolvePath）
 */
export function fileMenuItems(target, { osActions, canUse = true, run, defaultAppAllowed = false, platform = globalThis.navigator?.platform ?? '' }) {
  const directory = target.kind === 'directory';
  const item = (label, action) => {
    const icon = el('span');
    icon.innerHTML = ({ reveal:folderIcon, external:openInBrowserIcon, default:openInBrowserIcon,
      copy:copyIcon, copyRelative:copyIcon, save:downloadIcon, use:fileIcon })[action];
    return { label, icon, onClick: () => run(action) };
  };
  const mac = /Mac|darwin/i.test(platform);
  const groups = [
    [
      osActions && item(mac ? t('files.menu.revealFinder') : directory ? t('files.menu.revealFolder') : t('files.menu.revealFile'), 'reveal'),
      osActions && (directory || isHtml(target.path)) && item(t('browser.openExternal'), 'external'),
      osActions && !directory && defaultAppAllowed && item(t('files.menu.openDefault'), 'default'),
    ],
    [item(t('files.menu.copyPath'), 'copy'), item(t('files.menu.copyRelative'), 'copyRelative')],
    [!directory && item(t('files.menu.save'), 'save'), canUse && item(t('files.menu.use'), 'use')],
  ].map(group => group.filter(Boolean)).filter(group => group.length);
  return groups.flatMap((group, i) => i ? [{ sep: true }, ...group] : group);
}

/**
 * パスをクリップボードへ写し、短い知らせを出す。relative は相対パスか（知らせの文言だけが違う）。
 * 右パネルの ⋯・会話の可視化のカードが同じものを使う（挙動と文言をそろえる）
 */
export async function copyPathText(text, relative = false) {
  try { await navigator.clipboard.writeText(text); notify(relative ? t('files.copiedRelative') : t('files.copiedPath')); }
  catch { notify(relative ? t('files.copyRelativeFailed') : t('files.copyPathFailed')); }
}

/** 作業ディレクトリからの相対パス。外にあれば null */
export function relativeTo(path, cwd) {
  if (!path || !cwd) return null;
  const norm = s => String(s).replaceAll('\\', '/').replace(/\/+$/, '');
  const p = norm(path), base = norm(cwd);
  const windows = /^[a-z]:\//i.test(p);
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, base)) return '.';
  if (!same(p.slice(0, base.length + 1), `${base}/`)) return null;
  const rel = p.slice(base.length + 1);
  return windows ? rel.replaceAll('/', '\\') : rel;
}

/** 同じファイルか（区切りの違い、Windows の大文字小文字を無視する） */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = s => String(s).replaceAll('\\', '/').replace(/\/+$/, '');
  const x = norm(a), y = norm(b);
  return /^[a-z]:\//i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const TOAST_MS = 4000;
// toastHover はポインターが載っている間、toastFocus はフォーカスが中にある間。toastBack はフォーカスが入る前に居た所
let toastTimer, toastHover = false, toastFocus = false, toastBack = null;
function hideToast(box) { clearTimeout(toastTimer); toastHover = toastFocus = false; box.hidden = true; }
/** 消えるまでの時間を数え直す。ポインターが載っている・フォーカスが中にある間は数えない */
function armToast(box) {
  clearTimeout(toastTimer);
  if (!toastHover && !toastFocus) toastTimer = setTimeout(() => hideToast(box), TOAST_MS);
}
function createToast() {
  const box = el('div', 'file-toast');
  // 読み上げるのは文だけ（✕ の名前まで読ませない）ので、role は文の側に付ける
  const text = el('span', 'file-toast-text'); text.setAttribute('role', 'status');
  const close = el('button', 'btn btn-icon file-toast-close'); close.type = 'button'; close.innerHTML = closeIcon;
  close.title = t('files.toastClose'); close.setAttribute('aria-label', t('files.toastClose'));
  close.onclick = () => {
    // キーボードで来て閉じたときは、来る前に居た所へフォーカスを返す
    const back = box.contains(document.activeElement) ? toastBack : null;
    hideToast(box);
    if (back?.isConnected) back.focus();
  };
  // タッチは指を置いている間だけ pointerenter〜pointerleave になる（mouseenter だと、ほかを触るまで載ったままになる）
  box.addEventListener('pointerenter', () => { toastHover = true; armToast(box); });
  box.addEventListener('pointerleave', () => { toastHover = false; armToast(box); });
  box.addEventListener('focusin', event => { if (!toastFocus) toastBack = event.relatedTarget ?? null; toastFocus = true; armToast(box); });
  box.addEventListener('focusout', event => { toastFocus = !!event.relatedTarget && box.contains(event.relatedTarget); armToast(box); });
  box.append(text, close);
  return box;
}
/**
 * 短い知らせ（コピーした・開けなかった）。4 秒で消える。右端の ✕ でも消せる。
 * ポインターが載っている・フォーカスが中にある間は消さず、離れたら 4 秒を数え直す（docs/design-system.md「短い知らせ」）。
 * 拡大表示（モーダルの dialog）が開いていればその中に出す（外に出すと背景の幕の下に隠れる）
 */
export function notify(text) {
  const host = document.querySelector('dialog[open]') ?? document.body;
  const box = document.querySelector('.file-toast') ?? createToast();
  // 置き場所を移すと「離れた」が届かないことがあるので、載っている扱いをやめる
  if (box.parentNode !== host) { toastHover = toastFocus = false; host.append(box); }
  box.querySelector('.file-toast-text').textContent = text; box.hidden = false;
  armToast(box);
}

/** ダウンロードを始める（<a download> を押すのと同じ）。殻でもブラウザーでも既定のダウンロードになる */
export function download(href, name = '') {
  const a = el('a'); a.href = href; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
}
