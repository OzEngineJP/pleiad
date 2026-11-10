import { createTree } from './tree.mjs';
import { browserButton, browserIcon } from './tab-strip.mjs';
import { t } from './i18n.mjs';
import { locateIcon, collapseAllIcon } from './icons.mjs';
import { createSpring } from './motion.mjs';

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
  let sessionId, path, generation = 0, narrow = true, overlay = false, prefs = { open:false, width:208 }, loaded = null;
  // 開け閉めは右パネルと同じばね（docs/design-system.md §8「動きの語彙」）。動きを減らす設定では端へ飛ぶ（motion.mjs が受け持つ）
  let visible = false, treeWidth = 0;
  const reveal = createSpring(0, { preset:'smooth', epsilon:0.002, onUpdate:() => paint() });
  function paint() {
    const p = Math.min(1, Math.max(0, reveal.value));
    root.hidden = !visible && !reveal.moving;
    root.inert = !visible && reveal.moving;
    host.style.setProperty('--bu-tree-width', narrow ? '0px' : `${(treeWidth * p).toFixed(2)}px`);
    if (reveal.moving) {
      // 左から差し込む。パネルの左端より外へ出た分は切る
      const off = (1 - p) * treeWidth;
      root.style.transform = `translateX(${(-off).toFixed(2)}px)`; root.style.clipPath = `inset(0 0 0 ${off.toFixed(2)}px)`;
    } else { root.style.removeProperty('transform'); root.style.removeProperty('clip-path'); }
  }
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
  function layout(animate = false) {
    const chrome = host.querySelector('.bu-chrome');
    root.style.top = `${chrome ? chrome.offsetTop + chrome.offsetHeight : 0}px`;
    narrow = host.clientWidth < 640 || matchMedia('(max-width:600px)').matches;
    visible = !!path && (narrow ? overlay : prefs.open);
    host.querySelector('.bu-tree')?.setAttribute('aria-expanded', String(visible)); root.classList.toggle('bu-tree-overlay', narrow);
    host.querySelector('.bu-tree')?.setAttribute('aria-controls', root.id);
    const width = narrow ? Math.min(280, host.clientWidth - 48) : Math.max(160, Math.min(prefs.width, 320, host.clientWidth * .4));
    root.style.width = `${width}px`; treeWidth = width;
    // 押して開け閉めしたときだけ動かす。会話の切り替え・大きさの変化では、その場で置く（途中の動きは止めない）
    const want = visible ? 1 : 0;
    if (want !== reveal.target) { if (animate) reveal.to(want); else reveal.set(want); }
    paint();
    resize.hidden = narrow; close.hidden = !narrow;
    resize.setAttribute('aria-valuemin', '160'); resize.setAttribute('aria-valuemax', String(Math.min(320, host.clientWidth * .4)));
    resize.setAttribute('aria-valuenow', String(Math.round(width)));
  }
  function width(value) { prefs.width = Math.max(160, Math.min(320, host.clientWidth * .4, value)); save(); layout(); }
  function toggle(value) { if (!path) { layout(); return; } if (narrow) overlay = value ?? !overlay; else { prefs.open = value ?? !prefs.open; save(); } layout(true); if (visible) tree.focus(); }
  resize.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); width(prefs.width + (event.key === 'ArrowLeft' ? -16 : 16)); } };
  resize.onpointerdown = event => { if (event.button !== 0) return; resize.setPointerCapture(event.pointerId); event.preventDefault(); };
  resize.onpointermove = event => { if (resize.hasPointerCapture(event.pointerId)) width(event.clientX - host.getBoundingClientRect().left); };
  resize.onpointerup = event => { if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId); };
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && narrow) { event.preventDefault(); event.stopPropagation(); toggle(false); host.querySelector('.bu-tree')?.focus(); } });
  host.addEventListener('pointerdown', event => { if (narrow && overlay && !root.contains(event.target) && !event.target.closest('.bu-tree')) { overlay = false; layout(true); } });
  // 大きさの変化ではその場で置く（ResizeObserver の記録を animate に渡さない）
  const layoutWatch = new ResizeObserver(() => layout()); layoutWatch.observe(host);
  const chromeRow = host.querySelector('.bu-chrome'); if (chromeRow) layoutWatch.observe(chromeRow);
  async function show(tab, id) {
    if (sessionId !== id) {
      // 既定は閉じる。会話ごとに開け閉めを覚える（docs/design-system.md「ファイルのツリーと更新」）
      sessionId = id; loaded = null; overlay = false; prefs = { open:false, width:208 };
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
