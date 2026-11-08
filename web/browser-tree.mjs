import { createTree } from './tree.mjs';
import { browserButton, browserIcon } from './tab-strip.mjs';
import { t } from './i18n.mjs';
import { locateIcon, collapseAllIcon } from './icons.mjs';

/** The explorer belongs to the pane, so navigating a page does not recreate it. */
export function createBrowserTree({ host, open, menu, notify = () => {} }) {
  const root = document.createElement('aside'); root.className = 'bu-explorer'; root.id = 'browser-explorer'; root.hidden = true;
  const head = document.createElement('div'); head.className = 'bu-explorer-head';
  const title = document.createElement('span');
  const close = browserButton('close', t('tabs:tree.close'), () => { toggle(false); host.querySelector('.bu-tree')?.focus(); });
  const locate = browserButton('file', t('filePreview.treeLocate'), () => { tree.reveal(path); tree.select(path, false); tree.scrollToRow(path); tree.focus(); }); locate.innerHTML = locateIcon;
  const collapse = browserButton('dir', t('filePreview.treeCollapseAll'), () => tree.collapseAll({ keepRoots:false })); collapse.innerHTML = collapseAllIcon;
  head.append(title, locate, collapse, close);
  const list = document.createElement('div'); list.className = 'tree bu-explorer-list'; list.setAttribute('aria-label', t('tabs:address.tree'));
  const resize = document.createElement('div'); resize.className = 'bu-tree-resize'; resize.tabIndex = 0;
  resize.setAttribute('role', 'separator'); resize.setAttribute('aria-orientation', 'vertical'); resize.setAttribute('aria-label', t('tabs:tree.width'));
  root.append(head, list, resize); host.append(root);
  let sessionId, path, generation = 0, narrow = true, overlay = false, prefs = { open:true, width:208 }, loaded = null;
  const key = () => `pleiad.browser-tree.${sessionId}`;
  const save = () => { try { localStorage.setItem(key(), JSON.stringify(prefs)); } catch {} };
  const nodes = items => (items ?? []).map(item => ({ ...item, branch:item.kind === 'directory', lazy:item.kind === 'directory' && !item.children,
    children:item.children ? nodes(item.children) : undefined }));
  async function read(file, more = false, offset) {
    const q = new URLSearchParams({ sessionId, path:file, ...(more ? { list:'1' } : {}), ...(offset ? { offset } : {}) });
    const response = await fetch(`/file-preview?${q}`, { credentials:'same-origin' });
    if (!response.ok) throw new Error(t('filePreview.treeLoadFailed'));
    return response.json();
  }
  const activate = (item, event) => {
    open(item.id, event.ctrlKey || event.metaKey || event.button === 1);
    if (narrow) toggle(false);
  };
  const context = (item, x, y) => menu(item, x, y);
  const tree = createTree(list, {
    onActivate:activate, onContext:context,
    render(item, row) {
      row.append(browserIcon(item.kind === 'directory' ? 'dir' : 'file'));
      const name = document.createElement('span'); name.className = 'nm'; name.textContent = item.name; row.append(name);
      const more = browserButton('more', t('tabs:address.more'), event => { event.stopPropagation(); const r = more.getBoundingClientRect(); context(item, r.left, r.bottom); });
      more.classList.add('bu-tree-more'); more.tabIndex = -1; row.append(more);
    },
    onLoad:async item => { const result = await read(item.id, true); return { ...result, children:nodes(result.children) }; },
    onMore:async item => { const result = await read(item.id, true, item.next); const known = new Set(item.children.map(child => child.id)); return { ...result, children:[...item.children, ...nodes(result.children).filter(child => !known.has(child.id))] }; },
  });
  function layout() {
    const chrome = host.querySelector('.bu-chrome');
    root.style.top = `${chrome ? chrome.offsetTop + chrome.offsetHeight : 0}px`;
    narrow = host.clientWidth < 640 || matchMedia('(max-width:600px)').matches;
    const visible = !!path && (narrow ? overlay : prefs.open);
    root.hidden = !visible; host.querySelector('.bu-tree')?.setAttribute('aria-expanded', String(visible)); root.classList.toggle('bu-tree-overlay', narrow);
    host.querySelector('.bu-tree')?.setAttribute('aria-controls', root.id);
    const width = narrow ? Math.min(280, host.clientWidth - 48) : Math.max(160, Math.min(prefs.width, 320, host.clientWidth * .4));
    root.style.width = `${width}px`; host.style.setProperty('--bu-tree-width', visible && !narrow ? `${width}px` : '0px');
    resize.hidden = narrow; close.hidden = !narrow;
    resize.setAttribute('aria-valuemin', '160'); resize.setAttribute('aria-valuemax', String(Math.min(320, host.clientWidth * .4)));
    resize.setAttribute('aria-valuenow', String(Math.round(width)));
  }
  function width(value) { prefs.width = Math.max(160, Math.min(320, host.clientWidth * .4, value)); save(); layout(); }
  function toggle(value) { if (!path) { layout(); return; } if (narrow) overlay = value ?? !overlay; else { prefs.open = value ?? !prefs.open; save(); } layout(); if (!root.hidden) tree.focus(); }
  resize.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); width(prefs.width + (event.key === 'ArrowLeft' ? -16 : 16)); } };
  resize.onpointerdown = event => { if (event.button !== 0) return; resize.setPointerCapture(event.pointerId); event.preventDefault(); };
  resize.onpointermove = event => { if (resize.hasPointerCapture(event.pointerId)) width(event.clientX - host.getBoundingClientRect().left); };
  resize.onpointerup = event => { if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId); };
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && narrow) { event.preventDefault(); event.stopPropagation(); toggle(false); host.querySelector('.bu-tree')?.focus(); } });
  host.addEventListener('pointerdown', event => { if (narrow && !root.contains(event.target) && !event.target.closest('.bu-tree')) { overlay = false; layout(); } });
  const layoutWatch = new ResizeObserver(layout); layoutWatch.observe(host);
  const chromeRow = host.querySelector('.bu-chrome'); if (chromeRow) layoutWatch.observe(chromeRow);
  async function show(tab, id) {
    if (sessionId !== id) {
      sessionId = id; loaded = null; overlay = false; prefs = { open:true, width:208 };
      try { const saved = JSON.parse(localStorage.getItem(key())); if (typeof saved?.open === 'boolean') prefs.open = saved.open; if (Number.isFinite(saved?.width)) prefs.width = saved.width; } catch {}
    }
    const next = ['file', 'dir', 'viz', 'html'].includes(tab?.page?.kind) && tab.page.path ? tab.page.path : null;
    path = next; layout();
    if (!path || loaded === path) return;
    loaded = path; const ticket = ++generation;
    try {
      const result = await read(path);
      if (ticket !== generation || loaded !== path) return;
      const data = nodes(result.tree); title.textContent = data[0]?.name ?? ''; tree.setNodes(data[0]?.children ?? []);
      tree.reveal(path); tree.select(path, false); tree.scrollToRow(path);
    } catch (error) { if (ticket === generation) { loaded = null; notify(error.message); } }
  }
  return { root, show, toggle, dismiss() { if (narrow && overlay) toggle(false); }, get narrow() { return narrow; } };
}
