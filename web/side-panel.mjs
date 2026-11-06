// 右パネルの枠（docs/design-system.md「右パネルの枠」）。ファイル・会話のコンテキスト・git・会話の Chrome の窓が同じ 1 つの枠を使う。
// どのモードで何を出すかは、ここの *Slots だけが決める。枠（applySlots）は渡された部品だけを並べ、
// **渡されなかった部品は必ず隠す**。モードごとに出したり消したりを書き足すと、前のモードの部品が残る
// （docs/design-system.md「右パネル」）。
// 部品は名前（id）で指す。実際のボタンは web/file-preview.mjs が 1 度だけ作り、ここへ渡す。
import { t } from './i18n.mjs';

/**
 * ファイル。取得の前後で呼び直す（⋯・エクスプローラーで表示・保存は取得できてから）。
 * HTML は原文だけを見せる（描画は Pleiad のページが受け持つ）ので、プレビュー / 原文の切り替えは出さない。
 * @param {{ file?:object|null, osActions?:boolean }} s
 */
export function fileSlots({ file = null, osActions = false } = {}) {
  const local = osActions && !!file;
  return {
    mode: 'file',
    label: t('filePreview.panel'),
    kind: t('filePreview.mode.file'),
    head: ['tree', file && 'more', 'wide', 'close'].filter(Boolean),
    views: !!file && typeof file.text === 'string' && file.kind !== 'text' && file.kind !== 'directory' && file.kind !== 'html',
    toolbar: ['path', 'reload'],
    aside: true,
    footer: ['reveal', 'save', 'use'].filter(id => (id === 'reveal' ? local : id === 'save' ? !!file?.downloadable : true)),
  };
}

/**
 * 会話の Chrome の窓の映像（web/chrome-panel.mjs。ADR 0294）。見出しの行は広げると閉じるだけ、道具の列は窓の側が渡す
 */
export function chromeSlots({ label = '', toolbar = [] } = {}) {
  return { mode: 'browser', label, kind: '', head: ['wide', 'close'], views: false, toolbar, aside: false, note: '', footer: null };
}

/** ファイル以外の中身（この会話のコンテキスト）。見出しと本文と閉じるだけ */
export function customSlots({ label = '' } = {}) {
  return { mode: 'custom', label, kind: '', head: ['close'], views: false, toolbar: [], aside: false, footer: null };
}

/**
 * git（会話のブランチ・したこと・変更。ADR 0085）。見出し（git・ルートのパス）と本文、下の行（取得時刻・再読み込み・会話で使う）と閉じるだけ。
 * footer は下の行に並べるボタンの名前の列（web/file-preview.mjs の openPanel が作る）
 */
export function gitSlots({ label = '', footer = null, head = null, toolbar = null, wide = false } = {}) {
  // head・toolbar は部品の名前の列。git パネル（ADR 0135）は頭に再読み込みと広げる、道具の列にタブを置く。
  // wide は、頭にほかの部品が無くても「広げる」を出す（Chrome の窓の映像は広げると字が読みやすくなる）
  return { mode: 'custom', label, kind: '', head: head ? [...head, 'wide', 'close'] : wide ? ['wide', 'close'] : ['close'], views: false, toolbar: toolbar ?? [], aside: false, footer };
}

/**
 * 見出しの下の行。作業ディレクトリの中なら相対、外ならそのまま（区切りは / にそろえる。ファイルと同じ）。
 * パスが無ければ fallback
 */
export function subtitleFor(path, cwd, fallback = '') {
  if (!path) return fallback;
  const normalized = String(path).replaceAll('\\', '/');
  const base = String(cwd ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (!base) return normalized;
  const windows = /^[a-z]:\//i.test(normalized);
  const head = normalized.slice(0, base.length + 1);
  const inside = windows ? head.toLowerCase() === `${base}/`.toLowerCase() : head === `${base}/`;
  return inside ? normalized.slice(base.length + 1) : normalized;
}

/**
 * 設定を枠に当てる。parts は枠の要素と、id ごとのボタン（parts.buttons）。
 * config = 上の *Slots の結果 + { title, subtitle, note, status, statusTitle, body }
 * 並びは設定の順。設定に無い部品は DOM から外すか隠す
 */
export function applySlots(parts, config) {
  const pick = ids => (ids ?? []).map(id => parts.buttons[id]).filter(Boolean);
  parts.panel.dataset.mode = config.mode;
  parts.panel.classList.toggle('custom', config.mode === 'custom');
  parts.panel.setAttribute('aria-label', config.label ?? '');
  if (config.title !== undefined) { if (config.title && typeof config.title === 'object') parts.name.replaceChildren(config.title); else parts.name.textContent = config.title; }
  if (config.subtitle !== undefined) parts.path.textContent = config.subtitle;
  parts.kind.textContent = config.kind ?? '';
  parts.kind.hidden = !config.kind;
  parts.actions.replaceChildren(...pick(config.head));
  parts.switcher.hidden = !config.views;
  parts.tools.replaceChildren(...pick(config.toolbar));
  parts.toolbar.hidden = !config.views && !config.toolbar?.length;
  // パスの行は「パス」を押したときだけ開く。「パス」が無いモードでは必ず閉じる
  if (!config.toolbar?.includes('path')) parts.location.hidden = true;
  if (config.note !== undefined) { parts.note.textContent = config.note; parts.note.hidden = !config.note; }
  parts.treePane.hidden = !config.aside;
  parts.footer.hidden = !config.footer;
  parts.footActions.replaceChildren(...pick(config.footer));
  if (config.status !== undefined) parts.status.textContent = config.status;
  if (config.statusTitle !== undefined) parts.status.title = config.statusTitle;
  if (config.body) parts.content.replaceChildren(config.body);
}
