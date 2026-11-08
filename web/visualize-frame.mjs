// srcdoc で描く写しは不透明な sandbox の出どころ（allow-same-origin は付けない。周りの画面は資格を持つ）。
// 隔離の origin の束は、アプリごとの専用の出どころ（v<束の印>.localhost）で開く（allow-same-origin が付き、
// localStorage・fetch・相対パスが効く。core/isolated-origins.mjs・core/preview-policy.mjs の APP_SANDBOX）
import { t } from './i18n.mjs';
import { visualizationDocument } from './visualize-document.mjs';
import { confirmedPreview, currentPreviewPolicy } from './preview-confirm.mjs';
export { VISUALIZE_CSP, visualizationDocument } from './visualize-document.mjs';

if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', event => {
  // cross-origin の iframe の上では親の要素に :hover が付かない。枠の中の橋の「触れている」の報告で
  // カードに .point を付け、操作列（style.css）を出す。外れるときは少し待って、操作列へ移った途中なら消さない
  if (event.data?.type === 'ply-preview-point') {
    for (const frame of document.querySelectorAll('iframe.visualize-frame')) {
      if (frame.contentWindow !== event.source) continue;
      const card = frame.closest('.visualize-seamless');
      if (!card) continue;
      if (event.data.over === true) card.classList.add('point');
      else setTimeout(() => { if (!card.matches(':hover,:focus-within')) card.classList.remove('point'); }, 80);
    }
    return;
  }
  if (event.data?.type !== 'ply-visualize-height' || !Number.isFinite(event.data.height)) return;
  // No commands or arbitrary styles cross this boundary: only bounded height,
  // and only from a currently mounted visualization's own WindowProxy.
  for (const frame of document.querySelectorAll('iframe.visualize-frame:not(.visualize-fill)')) {
    if (frame.contentWindow !== event.source) continue;
    frame.style.height = `${Math.min(900, Math.max(120, event.data.height))}px`;
  }
});

/** 応答のヘッダーの CSP の sandbox と同じ（core/preview-policy.mjs の APP_SANDBOX）。アプリの専用の出どころで動く */
export const APP_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups allow-pointer-lock';

/** Scripts run, but in an opaque origin with no referrer or device permissions.
 * Shared by srcdoc visualizations and previews without an isolated origin. */
export function isolateFrame(frame) {
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  return frame;
}

// 隔離の origin（ADR 0295 の 3）。画面の起動がサーバーの hostCapabilities から port と「一度だけ読み込む」の印の頼み方を渡す。
// 渡されるまでと、束の無い記録は srcdoc で描く（相対パスの画像・fetch は読めない）
let isolated = null;
/** @param {{ port: number, mintOnce?: (origins: string[]) => Promise<string|null> } | null} options */
export function configureIsolatedOrigin(options) {
  isolated = Number.isInteger(options?.port) && options.port > 0 && options.port <= 65535 ? { port: options.port, mintOnce: options.mintOnce ?? null } : null;
}
let visualizationTabs = null;
export function configureVisualizationTabs(options) { visualizationTabs = options; }
/** Returns false only when the no-Chrome layout must handle the expansion. */
export function openVisualizationTab(bundle, element, title = '', path = '') {
  const tabs = visualizationTabs;
  const sessionId = tabs?.sessionId?.(element);
  if (!sessionId || !tabs.connected?.(sessionId) || !tabs.openTab) return false;
  // 開く先はサーバーが決める（pageOpen → 束の印の出どころ）。束・入口・題・元のファイルは一度だけ渡す
  try { Promise.resolve(tabs.openTab({ sessionId, kind:'viz', vizHash:bundle?.hash, entry:bundle?.entry, title, path })).catch(error => tabs.onError?.(error)); }
  catch (error) { tabs.onError?.(error); }
  return true;
}
export function visualizationBundleNotice(bundle) {
  if (!bundle?.htmlOnly) return '';
  const reasons = {
    'too-many-files': t('timeline.present.resourcesTooMany'),
    'too-large': t('timeline.present.resourcesTooLarge'),
    'file-too-large': t('timeline.present.resourceTooLarge'),
    legacy: t('timeline.present.resourcesLegacy'),
  };
  return Object.hasOwn(reasons, bundle.reason) ? reasons[bundle.reason] : t('timeline.present.resourcesOmitted');
}
const BUNDLE_HASH = /^[0-9a-f]{64}$/;
/** 束の印の出どころの名前（core/isolated-origins.mjs の vizMark と同じ）。アプリごとの origin になる */
export const visualizationHost = hash => `v${String(hash ?? '').toLowerCase().slice(0, 24)}.localhost`;

/**
 * 束の URL（隔離の origin の /viz/<束のハッシュ>/<入口>）。隔離の origin が無い・束の形が違うときは null。
 * embed: conversation（会話の枠）| panel（右の欄）| tab（別のタブ。高さの知らせ・橋を入れない）
 * PC は束の印の <印>.localhost、リモート画面は端末の隔離リスナーが受ける localhost を使う。
 * title: 別のタブの題（タブの列とアドレスバーはページの <title> を読む。可視化の中身はふつう <title> を持たない）
 */
export function isolatedVisualizationUrl(bundle, { embed = 'panel', theme = '', once = null, host = null, title = '' } = {}) {
  if (!isolated || !BUNDLE_HASH.test(bundle?.hash ?? '') || typeof bundle.entry !== 'string' || !bundle.entry) return null;
  if (!['conversation', 'panel', 'tab'].includes(embed) || bundle.entry.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) return null;
  const entry = bundle.entry.split('/').map(encodeURIComponent).join('/');
  const params = new URLSearchParams({ embed });
  if (['light', 'dark'].includes(theme)) params.set('theme', theme);
  if (once) params.set('once', once);
  if (embed === 'tab' && title) params.set('title', String(title).slice(0, 200));
  const hostname = host ?? (globalThis.window?.plyRemote ? 'localhost' : visualizationHost(bundle.hash));
  return `http://${hostname}:${isolated.port}/viz/${bundle.hash}/${entry}?${params}`;
}

// fill: the frame gets its height from the container (the preview panel), so the
// iframe's own height report is ignored instead of clamping it to 900px.
// bundle: 記録の行の束（core/viz-bundle.mjs）。隔離の origin があれば、束を URL で読ませる（相対パスの画像・fetch・WASM が効く）
export function visualizationFrame(content, title, { fill = false, conversation = false, bundle = null } = {}) {
  const frame = document.createElement('iframe');
  frame.className = fill ? 'visualize-frame visualize-fill' : 'visualize-frame';
  isolateFrame(frame);
  frame.title = title || t('timeline.present.kind.visualization');
  const srcdoc = policy => visualizationDocument(content, { theme: document.documentElement?.dataset?.theme, policy, conversation });
  if (!isolatedVisualizationUrl(bundle)) {
    confirmedPreview(frame, srcdoc);
    return frame;
  }
  // 隔離の origin の応答のヘッダーの sandbox と同じ（APP_SANDBOX。アプリの専用の出どころなので allow-same-origin が付く）
  frame.setAttribute('sandbox', APP_FRAME_SANDBOX);
  confirmedPreview(frame, async (policy, once) => {
    const theme = document.documentElement?.dataset?.theme;
    const embed = conversation ? 'conversation' : 'panel';
    if (!once.length) return { src: isolatedVisualizationUrl(bundle, { embed, theme }) };
    // 「一度だけ読み込む」はサーバーに印を作らせて URL に載せる。作れなければ、会話の中身を srcdoc で描く（束の中の他のファイルは読めない）
    const token = await Promise.resolve(isolated?.mintOnce?.(once)).catch(() => null);
    const src = typeof token === 'string' && token ? isolatedVisualizationUrl(bundle, { embed, theme, once: token }) : null;
    return src ? { src } : srcdoc(policy);
  });
  return frame;
}

/** 元のファイル名を使う。無ければタイトルから作り、保存先で困る文字は落とす */
export function visualizationFileName({ path, title }) {
  const base = String(path ?? '').split(/[\\/]/).pop() ?? '';
  if (/\.html?$/i.test(base)) return base;
  // 保存先で困る記号（92 は円記号／バックスラッシュ）と制御文字を落とす
  const banned = '/:*?"<>|';
  const safe = [...String(title ?? '')]
    .filter(c => c >= ' ' && c.codePointAt(0) !== 92 && !banned.includes(c)).join('').trim();
  return `${safe || t('timeline.present.kind.visualization')}.html`;
}

/**
 * 保存するのは会話に残っている内容。ホスト上のファイルを取りに行かない
 * （消えていても、書き換わっていても、見えているものが手元に落ちる）。
 * 表示と同じ包み（CSP・基礎スタイル）を付けるので、単体で開いても同じに見える。
 * 配色は焼き込まず、開いた環境のライト／ダークに従う。
 */
export function visualizationBlobUrl(content) {
  return URL.createObjectURL(new Blob([visualizationDocument(content, { resize: false, policy: currentPreviewPolicy() })], { type: 'text/html;charset=utf-8' }));
}

/** 会話にはいくつも並ぶので、URL は押したときだけ作って手放す */
export function downloadVisualization({ path, title, content }) {
  const url = visualizationBlobUrl(content);
  const link = document.createElement('a');
  link.href = url; link.download = visualizationFileName({ path, title });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
