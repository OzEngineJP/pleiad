import { node, text, icon, api, pageUrl, fileActions, vizActions, request, date } from './bridge.mjs';
import { folderIcon, fileIcon } from '../icons.mjs';
import { browserIcon } from '../tab-strip.mjs';
import { fileRow } from './dir.mjs';

const glyph = (svg, className) => { svg.classList.add(className); return svg; };
const VIZ_SHOWN = 5;

export async function renderNew(root) {
  document.title = `${text('newTab')} · Pleiad`;
  const data = await api('recent'); root.classList.add('new-page');
  const conversation = node('section'); conversation.append(node('h2', '', text('new.conversation')));
  const shortcuts = node('div', 'shortcuts');
  for (const kind of ['git', 'plugins']) {
    const link = node('a', 'shortcut'); link.href = pageUrl(kind);
    // i18n-dynamic: new.
    const label = node('span', '', text(`new.${kind}`));
    if (kind === 'git') {
      try { const changes = await api('git', { kind:'changes' }); if (changes.changes) label.textContent = text('new.changes', { count:changes.changes.total?.files ?? changes.changes.files.length }); } catch { /* Keep the entry available when git cannot be read. */ }
    }
    link.append(glyph(browserIcon(kind), 'shortcut-icon'), label); shortcuts.append(link);
  }
  conversation.append(shortcuts); root.append(conversation);
  const visualizations = data.visualizations ?? [];
  if (visualizations.length) {
    const section = node('section', 'viz-section'); section.append(node('h2', '', text('new.visualizations')));
    const list = node('div', 'viz-list');
    // 行を押すと元の HTML を開く（消えた・記録の無いものは保存した版）。iframe の外にいる単独の画面は隔離の URL へ行く
    const hosted = parent !== window || typeof globalThis.plyPage === 'function';
    const rows = visualizations.map(item => {
      const row = node('div', 'viz-row');
      const missing = item.missing === true || !item.path;
      // 主操作はリンク（行の ⋯ と兄弟。開く先は元の HTML、消えた・記録の無いものは保存した版）。iframe の外にいる単独の画面は隔離の URL へ行く
      const link = node('a', 'viz-link'); link.title = item.title;
      link.href = missing ? item.url : pageUrl('file', item.path);
      link.append(glyph(browserIcon('viz'), 'viz-icon'), node('span', 'viz-title', item.title));
      row.append(link);
      const when = node('span', 'viz-time', item.at ? date(item.at) : '');
      row.append(when);
      if (missing) { const badge = node('span', 'viz-saved', text('new.savedVersion')); row.append(badge); row.classList.add('viz-missing'); }
      vizActions(row, { hash:item.hash, entry:item.entry, title:item.title, path:item.path ?? '', missing:item.missing === true });
      if (hosted) link.addEventListener('click', event => { event.preventDefault();
        request('open-viz', { viz:{ hash:item.hash, entry:item.entry, title:item.title },
          ...(item.path ? { path:item.path } : {}), missing:item.missing === true }); });
      return row;
    });
    list.replaceChildren(...rows.slice(0, VIZ_SHOWN)); section.append(list);
    if (rows.length > VIZ_SHOWN) {
      const toggle = node('button', 'viz-toggle', text('new.showAll', { count:rows.length })); toggle.type = 'button';
      let all = false;
      toggle.addEventListener('click', () => { all = !all; list.replaceChildren(...(all ? rows : rows.slice(0, VIZ_SHOWN))); toggle.textContent = text(all ? 'new.showLess' : 'new.showAll', { count:rows.length }); });
      section.append(toggle);
    }
    root.append(section);
  }
  const recent = node('section'); recent.append(node('h2', '', text('new.recent')));
  if (!data.files.length) recent.append(node('p', 'empty', text('new.emptyRecent')));
  for (const file of data.files) {
    const row = node('div', 'recent-row'), link = node('a', 'recent-link'); link.href = pageUrl('file', file.path);
    link.append(glyph(icon(fileIcon), 'file-icon'), node('span', 'recent-name', file.name));
    const parts = [file.actor, text(`new.sources.${file.source}`)];
    const elapsed = Date.now() - new Date(file.at).getTime();
    if (Number.isFinite(elapsed)) { const minutes = Math.max(0, Math.floor(elapsed / 60000)); parts.push(new Intl.RelativeTimeFormat(document.documentElement.lang, { numeric:'auto' }).format(-minutes, 'minute')); }
    row.append(link, node('span', 'recent-source', parts.filter(Boolean).join(' · '))); fileActions(row, file.path); recent.append(row);
  }
  root.append(recent);
  const folders = node('section'); folders.append(node('h2', '', text('new.folders')));
  if (!data.folders.length) folders.append(node('p', 'empty', text('new.emptyFolders')));
  for (const folder of data.folders) {
    const row = node('div', 'folder-row'), link = node('a'); link.href = pageUrl('dir', folder.path); link.title = folder.path; link.append(glyph(glyph(icon(folderIcon), 'file-icon'), 'folder'), node('span', '', folder.name)); row.append(link); fileActions(row, folder.path, 'directory'); folders.append(row);
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
