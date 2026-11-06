import { node, text, size, date, metadata, pageUrl, fileActions, api } from './bridge.mjs';

export function fileRow(file) {
  const row = node('div', 'file-row');
  const link = node('a', 'file-name'); link.href = pageUrl(file.kind === 'directory' ? 'dir' : 'file', file.path);
  link.append(node('span', 'file-icon', file.kind === 'directory' ? '▱' : '▤'), node('span', '', file.name));
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

export async function renderTree(container, tree, selected) {
  container.replaceChildren();
  async function branch(parent, items) {
    for (const item of items ?? []) {
      const folder = item.kind === 'directory';
      const line = node('div', 'tree-line');
      const toggle = node('button', 'tree-toggle', folder ? '›' : ''); toggle.type = 'button';
      toggle.disabled = !folder; toggle.setAttribute('aria-label', text('expandFolder', { name:item.name }));
      const link = node('a', item.id === selected ? 'selected' : '', item.name); link.href = pageUrl(folder ? 'dir' : 'file', item.id);
      line.append(toggle, link); fileActions(line, item.id, item.kind); parent.append(line);
      if (folder) {
        const children = node('div', 'tree-children'); children.hidden = !item.children; parent.append(children);
        if (item.children) { toggle.textContent = '⌄'; await branch(children, item.children); more(children, item.id, item); }
        let loaded = Boolean(item.children);
        toggle.addEventListener('click', async () => {
          children.hidden = !children.hidden; toggle.textContent = children.hidden ? '›' : '⌄';
          if (!loaded) {
            try { const result = await api('tree', { path:item.id }); await branch(children, result.children); more(children, item.id, result); loaded = true; }
            catch { children.replaceChildren(node('p', 'empty', text('errors.read-failed'))); }
          }
        });
      }
    }
  }
  function more(parent, path, result) {
    if (!result.more) return;
    const load = node('button', 'load-more', text('more')); load.type = 'button'; parent.append(load);
    load.addEventListener('click', async () => {
      load.disabled = true;
      try { const next = await api('tree', { path, offset:result.next }); load.remove(); await branch(parent, next.children); more(parent, path, next); }
      catch { load.textContent = text('errors.read-failed'); load.disabled = false; }
    });
  }
  await branch(container, tree);
}
