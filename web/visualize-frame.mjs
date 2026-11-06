// Interactive documents always have an opaque sandbox origin. Never add
// allow-same-origin: the surrounding app carries authenticated cookies.
import { t } from './i18n.mjs';
import { visualizationDocument } from './visualize-document.mjs';
import './link-open.mjs';
import { confirmedPreview, currentPreviewPolicy } from './preview-confirm.mjs';
export { VISUALIZE_CSP, visualizationDocument } from './visualize-document.mjs';

if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', event => {
  if (event.data?.type !== 'ply-visualize-height' || !Number.isFinite(event.data.height)) return;
  // No commands or arbitrary styles cross this boundary: only bounded height,
  // and only from a currently mounted visualization's own WindowProxy.
  for (const frame of document.querySelectorAll('iframe.visualize-frame:not(.visualize-fill)')) {
    if (frame.contentWindow !== event.source) continue;
    frame.style.height = `${Math.min(900, Math.max(120, event.data.height))}px`;
  }
});

/** Scripts run, but in an opaque origin with no referrer or device permissions.
 * Shared by visualizations and the HTML file preview. */
export function isolateFrame(frame) {
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  return frame;
}

// 隔離の origin（ADR 0292 の 3）。ブラウザーの一本化の旗が on のとき、画面の起動が port と「一度だけ読み込む」の印の頼み方を渡す。
// 渡されるまで（旗が off・リモートの画面）は、どの可視化も今のまま srcdoc で描く
let isolated = null;
/** @param {{ port: number, mintOnce?: (origins: string[]) => Promise<string|null> } | null} options */
export function configureIsolatedOrigin(options) {
  isolated = Number.isInteger(options?.port) && options.port > 0 ? { port: options.port, mintOnce: options.mintOnce ?? null } : null;
}
const BUNDLE_HASH = /^[0-9a-f]{64}$/;
/**
 * 束の URL（隔離の origin の /viz/<束のハッシュ>/<入口>）。隔離の origin が無い・束の形が違うときは null。
 * embed: conversation（会話の枠）| panel（右の欄）| tab（別のタブ。高さの知らせ・橋を入れない）
 */
export function isolatedVisualizationUrl(bundle, { embed = 'panel', theme = '', once = null } = {}) {
  if (!isolated || !BUNDLE_HASH.test(bundle?.hash ?? '') || typeof bundle.entry !== 'string' || !bundle.entry) return null;
  const entry = bundle.entry.split('/').map(encodeURIComponent).join('/');
  const params = new URLSearchParams({ embed });
  if (['light', 'dark'].includes(theme)) params.set('theme', theme);
  if (once) params.set('once', once);
  return `http://localhost:${isolated.port}/viz/${bundle.hash}/${entry}?${params}`;
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
  // 隔離の origin の応答のヘッダーの sandbox と同じ（ADR 0292 の 3）。allow-same-origin は付けない
  frame.setAttribute('sandbox', 'allow-scripts allow-downloads allow-forms');
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
