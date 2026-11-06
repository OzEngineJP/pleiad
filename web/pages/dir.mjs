import { node, text, button, icon, size, date, metadata, pageUrl, fileActions, api } from './bridge.mjs';
import { folderIcon, fileIcon, chevRightIcon, locateIcon, collapseAllIcon } from '../icons.mjs';

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

// ページの上に重ねるツリー（モック v6）。見出しに根の名前と「開いているファイルを表示」「すべて折りたたむ」を置き、行は根の直下から並べる。
// 開いたときは今のファイルまでの道だけが開いていて、今の行を見える位置に出す
export async function renderTree(container, tree, selected) {
  container.replaceChildren();
  const root = tree?.[0];
  if (!root) return;
  const closers = [];
  const tool = (markup, label, action) => { const el = button(null, action, 'tree-tool'); el.append(icon(markup)); el.title = label; el.setAttribute('aria-label', label); return el; };
  const head = node('div', 'tree-head');
  head.append(node('span', 'tree-root', root.name),
    tool(locateIcon, text('treeLocate'), () => renderTree(container, tree, selected)),
    tool(collapseAllIcon, text('treeCollapseAll'), () => { for (const close of closers) close(); }));
  const list = node('div', 'tree-list');
  container.append(head, list);
  async function branch(parent, items, level) {
    for (const item of items ?? []) {
      const folder = item.kind === 'directory';
      const line = node('div', `tree-line${folder ? ' dir' : ''}${item.id === selected ? ' selected' : ''}`);
      line.style.paddingLeft = `${4 + level * 16}px`;
      const toggle = node(folder ? 'button' : 'span', 'tree-toggle');
      const link = node('a', 'tree-link'); link.href = pageUrl(folder ? 'dir' : 'file', item.id);
      link.append(icon(folder ? folderIcon : fileIcon), node('span', 'tree-name', item.name));
      if (item.id === selected) link.setAttribute('aria-current', 'page');
      line.append(toggle, link); fileActions(line, item.id, item.kind); parent.append(line);
      if (!folder) continue;
      toggle.type = 'button'; toggle.append(icon(chevRightIcon)); toggle.setAttribute('aria-label', text('expandFolder', { name:item.name }));
      const children = node('div', 'tree-children'); parent.append(children);
      let loaded = Boolean(item.children);
      const open = async value => {
        children.hidden = !value; toggle.setAttribute('aria-expanded', String(value));
        if (!value || loaded) return;
        loaded = true;
        try { const result = await api('tree', { path:item.id }); await branch(children, result.children, level + 1); more(children, item.id, result, level + 1); }
        catch { loaded = false; children.replaceChildren(node('p', 'empty', text('errors.read-failed'))); }
      };
      children.hidden = !item.children; toggle.setAttribute('aria-expanded', String(Boolean(item.children)));
      if (item.children) { await branch(children, item.children, level + 1); more(children, item.id, item, level + 1); }
      toggle.addEventListener('click', () => open(children.hidden));
      closers.push(() => open(false));
    }
  }
  function more(parent, path, result, level) {
    if (!result.more) return;
    const load = button(text('more'), async () => {
      load.disabled = true;
      try { const next = await api('tree', { path, offset:result.next }); load.remove(); await branch(parent, next.children, level); more(parent, path, next, level); }
      catch { load.textContent = text('errors.read-failed'); load.disabled = false; }
    }, 'load-more');
    load.style.marginLeft = `${24 + level * 16}px`; parent.append(load);
  }
  await branch(list, root.children, 0);
  container.querySelector('.tree-line.selected')?.scrollIntoView({ block:'nearest' });
}
