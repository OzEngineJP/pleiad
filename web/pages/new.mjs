import { node, text, api, pageUrl, fileActions } from './bridge.mjs';
import { fileRow } from './dir.mjs';

export async function renderNew(root) {
  document.title = `${text('newTab')} · Pleiad`;
  const data = await api('recent'); root.classList.add('new-page');
  const conversation = node('section'); conversation.append(node('h2', '', text('new.conversation')));
  const shortcuts = node('div', 'shortcuts');
  for (const kind of ['git', 'plugins']) {
    const link = node('a', 'shortcut'); link.href = pageUrl(kind);
    const label = node('span', '', text(`new.${kind}`));
    if (kind === 'git') {
      try { const changes = await api('git', { kind:'changes' }); if (changes.changes) label.textContent = text('new.changes', { count:changes.changes.total?.files ?? changes.changes.files.length }); } catch { /* Keep the entry available when git cannot be read. */ }
    }
    link.append(node('span', 'shortcut-icon', kind === 'git' ? '⑂' : '◈'), label); shortcuts.append(link);
  }
  for (const item of data.visualizations ?? []) { const link = node('a', 'shortcut'); link.href = item.url; link.append(node('span', 'shortcut-icon', '◉'), node('span', '', item.title)); shortcuts.append(link); }
  conversation.append(shortcuts); root.append(conversation);
  const recent = node('section'); recent.append(node('h2', '', text('new.recent')));
  if (!data.files.length) recent.append(node('p', 'empty', text('new.emptyRecent')));
  for (const file of data.files) {
    const row = node('div', 'recent-row'), link = node('a', 'recent-link'); link.href = pageUrl('file', file.path);
    link.append(node('span', 'file-icon', '▤'), node('span', 'recent-name', file.name));
    const parts = [file.actor, text(`new.sources.${file.source}`)];
    const elapsed = Date.now() - new Date(file.at).getTime();
    if (Number.isFinite(elapsed)) { const minutes = Math.max(0, Math.floor(elapsed / 60000)); parts.push(new Intl.RelativeTimeFormat(document.documentElement.lang, { numeric:'auto' }).format(-minutes, 'minute')); }
    row.append(link, node('span', 'recent-source', parts.filter(Boolean).join(' · '))); fileActions(row, file.path); recent.append(row);
  }
  root.append(recent);
  const folders = node('section'); folders.append(node('h2', '', text('new.folders')));
  if (!data.folders.length) folders.append(node('p', 'empty', text('new.emptyFolders')));
  for (const folder of data.folders) {
    const row = node('div', 'folder-row'), link = node('a'); link.href = pageUrl('dir', folder.path); link.title = folder.path; link.append(node('span', 'file-icon', '▱'), node('span', '', folder.name)); row.append(link); fileActions(row, folder.path, 'directory'); folders.append(row);
    if (folder === data.folders[0]) {
      try {
        const tree = await api('tree', { path:folder.path }), grid = node('div', 'folder-grid');
        for (const item of tree.children.slice(0, 6)) grid.append(fileRow({ ...item, path:item.id, size:0 }));
        folders.append(grid);
      } catch { /* The folder entry remains usable if its contents changed. */ }
    }
  }
  root.append(folders);
}
