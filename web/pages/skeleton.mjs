// 待っている間の骨組み（ADR 0321）。種類ごとに、届く中身と同じ並び・同じ行の高さで描く（入れ替わっても動かない）。
// 押せず、読み上げもしない（aria-hidden）。光は .history-line と同じ 1.6 秒（content.css の .sk）。
import { node, icon } from './bridge.mjs';
import { folderIcon, fileIcon } from '../icons.mjs';

/** 待ちがこれ（ms）を超えたときだけ骨組みを出す */
export const SKELETON_DELAY = 150;

const line = (width, height, className = '') => {
  const el = node('span', `history-line${className ? ` ${className}` : ''}`);
  if (width != null) el.style.width = typeof width === 'number' ? `${width}%` : width;
  if (height != null) el.style.height = `${height}px`;
  return el;
};
const sk = (kind, ...children) => { const el = node('div', `sk sk-${kind}`); el.setAttribute('aria-hidden', 'true'); el.append(...children); return el; };
const row = (className, ...children) => { const el = node('div', className); el.append(...children); return el; };
const glyph = (svg, className) => { svg.classList.add(...className.split(' ')); return svg; };

const DOC = [[44, 20], [94], [98], [61], [28, 15], [96], [90], [97], [43]];
const CODE = [46, 30, 0, 72, 80, 38, 12, 0, 34, 58, 22];
const DIR = [52, 34, 41, 30, 47, 36];
const TABLE = [40, 56, 34, 48];

const BUILDERS = {
  doc: () => sk('doc', ...DOC.map(([w, h]) => line(w, h))),
  code: () => sk('code', ...CODE.map(w => row('r', line(16, 11, 'g'), ...(w ? [line(w, 11)] : [])))),
  image: () => sk('img', line()),
  dir: () => sk('dir', row('r h', line(8), line(null)), ...DIR.map(w => row('r', glyph(icon(fileIcon), 'file-icon'), line(w), line(40)))),
  table: () => sk('table', row('r h', ...TABLE.map(() => row('c', line(60)))),
    ...Array.from({ length:6 }, () => row('r', ...TABLE.map(w => row('c', line(w)))))),
  pdf: () => sk('pdf', row('c', line(84, 11), line(70, 11), line(84, 11)), line()),
  plugins: () => sk('plug', line(32, 11, 't'), ...Array.from({ length:2 }, () => line(null, null, 'b')), line(24, 11, 't'),
    ...Array.from({ length:3 }, () => line(null, null, 'b'))),
};

const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'toml', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'sh', 'ps1', 'sql', 'xml', 'vue', 'svelte', 'php', 'lua', 'kt', 'swift', 'ini', 'env', 'log']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const TABLE_EXT = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods']);

/** ページの種類（と開くファイルの拡張子）から、届く中身に近い骨組みの種類を決める */
export function kindFor(page, path = '') {
  if (page === 'dir') return 'dir';
  if (page === 'plugins') return 'plugins';
  if (page === 'attachment') return 'doc';
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TABLE_EXT.has(ext)) return 'table';
  if (ext === 'pdf') return 'pdf';
  if (CODE_EXT.has(ext)) return 'code';
  return 'doc';
}

export function skeleton(kind) { return (BUILDERS[kind] ?? BUILDERS.doc)(); }

/** 新しいタブの「最近のファイル」の骨組み（3 行） */
export function recentSkeleton() {
  return sk('recent', ...[40, 30, 34].map(w => row('sk-row', glyph(icon(fileIcon), 'file-icon'), line(w), line(22, null, 'src'))));
}
/** 新しいタブの「作業フォルダー」の骨組み（フォルダーの行 1 つ + 6 項目の格子） */
export function foldersSkeleton() {
  return sk('folders', row('sk-row', glyph(glyph(icon(folderIcon), 'file-icon'), 'folder'), line(null, null, 'nm')),
    row('sk-grid', ...[44, 30, 52, 40, 46, 26].map(w => row('sk-row', glyph(icon(fileIcon), 'file-icon'), line(w)))));
}
/** フォルダーの 6 項目の格子だけの骨組み（フォルダーの行は届いているが、中身がまだのとき） */
export function gridSkeleton() {
  return sk('grid-only', row('sk-grid', ...[44, 30, 52, 40, 46, 26].map(w => row('sk-row', glyph(icon(fileIcon), 'file-icon'), line(w)))));
}
/** 「変更」の右に置く件数の骨組み（ボタンの大きさは変えない） */
export const countSkeleton = () => { const el = line(null, null, 'cnt'); el.setAttribute('aria-hidden', 'true'); return el; };

/** 待ちが SKELETON_DELAY を超えたときだけ place() を呼ぶ。返す関数で取り消す（届いたら呼ぶ）。 */
export function afterDelay(place, delay = SKELETON_DELAY) {
  const timer = setTimeout(place, delay);
  return () => clearTimeout(timer);
}
