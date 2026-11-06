import { node, text, api, pageUrl, fileActions } from './bridge.mjs';

export async function renderPlugins(root) {
  document.title = `${text('new.plugins')} · Pleiad`;
  const data = await api('plugins');
  const entries = data?.report?.entries ?? [];
  for (const kind of ['instruction', 'skill', 'mcp']) {
    const group = node('section', 'plugin-group'); group.append(node('h2', '', text(`plugins.${kind}`)));
    const rows = entries.filter(e => e.kind === kind && e.status !== 'duplicate');
    if (!rows.length) group.append(node('p', 'empty', text('plugins.empty')));
    for (const entry of rows) {
      const row = node('div', 'plugin-row'), title = node(entry.path ? 'a' : 'span', 'plugin-name', entry.name ?? entry.title ?? entry.path ?? entry.id);
      if (entry.path) { title.href = pageUrl('file', entry.path); fileActions(row, entry.path); }
      row.prepend(title); if (entry.status) row.append(node('span', 'plugin-status', text(`plugins.status.${entry.status}`, { defaultValue:entry.status })));
      if (entry.description) row.append(node('p', 'plugin-description', entry.description)); group.append(row);
    }
    root.append(group);
  }
}
