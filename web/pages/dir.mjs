import { node, text, icon, size, date, metadata, pageUrl, fileActions } from './bridge.mjs';
import { folderIcon, fileIcon } from '../icons.mjs';

export function fileRow(file) {
  const row = node('div', 'file-row');
  const link = node('a', 'file-name'); link.href = pageUrl(file.kind === 'directory' ? 'dir' : 'file', file.path);
  const glyph = icon(file.kind === 'directory' ? folderIcon : fileIcon); glyph.classList.add('file-icon'); if (file.kind === 'directory') glyph.classList.add('folder');
  link.append(glyph, node('span', '', file.name));
  row.append(link, node('span', 'file-size', file.kind === 'directory' ? '—' : size(file.size)), node('time', 'file-date', date(file.modifiedAt)));
  fileActions(row, file.path, file.kind); return row;
}
export async function renderDirectory(root, file) {
  root.append(metadata(file));
  const table = node('div', 'directory');
  const head = node('div', 'file-row column-head');
  head.append(node('span', '', text('name')), node('span', '', text('size')), node('span', 'file-date', text('modified'))); table.append(head);
  for (const entry of file.items) table.append(fileRow(entry));
  if (!file.items.length) table.append(node('p', 'empty', text('emptyFolder')));
  root.append(table);
}
