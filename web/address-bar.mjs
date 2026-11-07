import { t } from './i18n.mjs';
import { browserButton } from './tab-strip.mjs';

// i18n-dynamic: tabs:address.reasons.
// i18n-dynamic: tabs:address.locations.

/** Absolute breadcrumbs retain the root (including drive letters). */
export function addressCrumbs(file) {
  const separator = file.includes('\\') ? '\\' : '/';
  const names = file.split(/[\\/]/).filter(Boolean);
  const root = /^[a-z]:/i.test(file) ? names.shift() + separator : separator;
  const crumbs = [{ name: root, path: root }];
  for (const name of names) crumbs.push({ name, path: crumbs.at(-1).path.replace(/[\\/]$/, '') + separator + name });
  return crumbs;
}

export const hasFileViews = tab => tab?.page?.kind === 'file' && /\.(?:md|markdown|html?|csv|tsv|svg)$/i.test(tab.page.path ?? '');

export function createAddressBar({ navigate = async () => {}, suggest = async () => ({}), cwd = () => '', onMenu = () => {}, onTabs = () => {}, onClose = () => {}, onDisplay = null, mobile = () => matchMedia('(max-width: 600px)').matches } = {}) {
  const root = document.createElement('div'); root.className = 'bu-toolbar';
  const back = browserButton('back', t('tabs:address.back'), () => run('back'));
  const forward = browserButton('forward', t('tabs:address.forward'), () => run('forward'));
  forward.classList.add('bu-forward');
  const reload = browserButton('reload', t('tabs:address.reload'), () => run('reload'));
  const conversation = browserButton('back', t('tabs:address.conversation'), onClose); conversation.classList.add('bu-conversation');
  const omni = document.createElement('div'); omni.className = 'bu-omni';
  const tree = browserButton('tree', t('tabs:address.tree'), () => run('tree')); tree.classList.add('bu-tree');
  const crumbs = document.createElement('div'); crumbs.className = 'bu-crumbs'; crumbs.tabIndex = 0; crumbs.setAttribute('role', 'button'); crumbs.setAttribute('aria-label', t('tabs:address.edit'));
  const views = document.createElement('div'); views.className = 'bu-views'; views.setAttribute('role', 'group'); views.setAttribute('aria-label', t('tabs:address.view'));
  const preview = browserButton('preview', t('tabs:address.preview'), () => setView('preview'));
  const source = browserButton('source', t('tabs:address.source'), () => setView('source'));
  for (const [button, key] of [[preview, 'preview'], [source, 'source']]) {
    const label = document.createElement('span'); label.textContent = t(`tabs:address.${key}`); button.append(label); views.append(button);
  }
  const input = document.createElement('input'); input.className = 'bu-address-input'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label', t('tabs:address.edit')); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('enterkeyhint', 'go'); input.hidden = true;
  const list = document.createElement('div'); list.className = 'bu-suggestions'; list.hidden = true; list.setAttribute('role', 'listbox');
  const error = document.createElement('div'); error.className = 'bu-address-error'; error.setAttribute('role', 'status'); error.hidden = true;
  const count = document.createElement('button'); count.type = 'button'; count.className = 'bu-count'; count.onclick = onTabs;
  const menu = browserButton('more', t('tabs:address.more'), () => onMenu(menu, { viewHidden: views.hidden, view, tab }));
  menu.classList.add('bu-more');
  const display = document.createElement('button'); display.type = 'button'; display.className = 'bu-display';
  display.setAttribute('aria-haspopup', 'menu'); display.onclick = () => onDisplay?.(display, tab);
  omni.append(tree, crumbs, views, input); root.append(conversation, back, forward, reload, omni, display, count, menu, list, error);
  let tab = null, view = 'preview', ticket = 0, timer = 0, active = -1, suggestions = [], blockedInput = null;
  const savedViews = new Map();
  const reason = code => t(`tabs:address.reasons.${code}`, { defaultValue: t('tabs:address.failed') });
  function failed(e) { error.textContent = reason(e?.code ?? e?.message); error.hidden = false; }
  async function run(action, extra = {}) { error.hidden = true; try { await navigate(action, extra); return true; } catch (e) { failed(e); return false; } }
  async function setView(next) {
    const targetId = tab?.targetId;
    if (await run('view', { view:next })) {
      savedViews.set(targetId, { url:tab?.url, view:next });
      if (targetId === tab?.targetId) { view = next; show(tab); }
    }
  }
  function edit() {
    if (!input.hidden) return;
    ticket++; clearTimeout(timer); suggestions = []; blockedInput = null; active = -1; list.hidden = true; error.hidden = true; crumbs.hidden = true; tree.hidden = true; views.hidden = true;
    input.hidden = false; input.value = tab?.page?.path ?? (tab?.page?.kind === 'viz' ? tab.title : tab?.page?.kind === 'new' ? '' : tab?.url ?? ''); input.focus(); input.select();
    root.classList.add('bu-editing');
  }
  function cancel() { ticket++; clearTimeout(timer); input.hidden = true; list.hidden = true; error.hidden = true; root.classList.remove('bu-editing'); show(tab); }
  async function submit(value = input.value) {
    if (blockedInput === value) return;
    clearTimeout(timer); const currentTicket = ++ticket; error.hidden = true; list.hidden = true;
    try { await navigate('navigate', { input: value }); if (ticket === currentTicket) cancel(); }
    catch (e) { if (ticket === currentTicket) { blockedInput = value; failed(e); } }
  }
  async function complete() {
    const request = ++ticket, value = input.value;
    try {
      const result = await suggest(value);
      if (request !== ticket || input.hidden || input.value !== value) return;
      suggestions = result.suggestions ?? []; active = -1;
      list.replaceChildren(...suggestions.map((suggestion, index) => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'bu-suggestion'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
        if (suggestion.path.toLowerCase().startsWith(value.toLowerCase())) {
          const match = document.createElement('strong'); match.textContent = suggestion.path.slice(0, value.length); row.append(match, document.createTextNode(suggestion.path.slice(value.length)));
        } else row.textContent = suggestion.path;
        row.onpointerdown = event => event.preventDefault(); row.onclick = () => submit(suggestion.path); row.dataset.index = index; return row;
      }));
      list.hidden = !suggestions.length; error.hidden = !result.reason; if (result.reason) error.textContent = reason(result.reason);
      blockedInput = result.reason ? value : null;
      const first = suggestions[0]?.path;
      if (!result.reason && first?.toLowerCase().startsWith(value.toLowerCase()) && first.length > value.length && document.activeElement === input) {
        input.value = first; input.setSelectionRange(value.length, first.length);
      }
    } catch (e) { if (request === ticket) failed(e); }
  }
  input.oninput = () => { ++ticket; blockedInput = null; error.hidden = true; active = -1; suggestions = []; list.hidden = true; clearTimeout(timer); timer = setTimeout(complete, 120); };
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); crumbs.focus(); }
    if (event.key === 'Enter') { event.preventDefault(); submit(active >= 0 && !list.hidden ? suggestions[active].path : input.value); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && suggestions.length && !list.hidden) {
      event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      [...list.children].forEach((row, i) => row.setAttribute('aria-selected', String(i === active)));
    }
  };
  root.addEventListener('focusout', () => setTimeout(() => { if (!input.hidden && !root.contains(document.activeElement)) cancel(); }, 0));
  omni.onclick = event => { if (event.target === omni || event.target === crumbs || event.target.closest('.bu-separator,.bu-ellipsis') || (mobile() && !tree.contains(event.target))) edit(); };
  crumbs.onkeydown = event => { if (event.target === crumbs && ['Enter', ' '].includes(event.key)) { event.preventDefault(); edit(); } };
  function fit() {
    if (!input.hidden) return;
    root.classList.toggle('bu-mobile', mobile()); root.classList.toggle('bu-tight', root.clientWidth < 360);
    // Without a tab there is nothing to switch, so the view buttons stay out.
    if (!tab) { views.hidden = true; return; }
    const file = Boolean(tab.page?.path), isFile = hasFileViews(tab);
    views.classList.remove('bu-icons'); views.hidden = !isFile || mobile();
    const items = [...crumbs.children]; for (const item of items) item.hidden = false;
    crumbs.classList.add('bu-measure');
    const ellipsis = crumbs.querySelector('.bu-ellipsis'); if (ellipsis) ellipsis.hidden = true;
    const folders = items.filter(item => item.classList.contains('bu-crumb'));
    const hide = folder => { folder.hidden = true; if (folder.nextSibling?.classList.contains('bu-separator')) folder.nextSibling.hidden = true; if (ellipsis) ellipsis.hidden = false; };
    if (file && tab.page.kind !== 'attachment' && !mobile()) {
      // Keep the filename longest: ancestors, view labels, parent, view controls, then status text.
      for (const folder of folders.slice(0, -2)) { if (crumbs.scrollWidth <= crumbs.clientWidth) break; hide(folder); }
      if (crumbs.scrollWidth > crumbs.clientWidth) views.classList.add('bu-icons');
      if (crumbs.scrollWidth > crumbs.clientWidth && folders.length > 2) hide(folders.at(-2));
      if (crumbs.scrollWidth > crumbs.clientWidth) views.hidden = true;
    }
    crumbs.classList.remove('bu-measure');
  }
  function show(next, total = Number(count.textContent) || 0) {
    const changed = tab?.targetId !== next?.targetId;
    tab = next; if (changed && !input.hidden) { cancel(); return; }
    const saved = savedViews.get(tab?.targetId);
    if (saved && saved.url === tab?.url) view = saved.view;
    else { try { view = new URL(tab?.url).searchParams.get('view') === 'source' ? 'source' : 'preview'; } catch { view = 'preview'; } }
    display.hidden = !onDisplay || !tab; display.textContent = t(tab?.local && tab.mode !== 'chrome' ? 'tabs:display.page' : 'tabs:display.chrome') + ' ⌄';
    count.textContent = String(total); count.setAttribute('aria-label', t('tabs:strip.count', { count: total }));
    if (!input.hidden) return;
    back.disabled = !tab?.canGoBack; forward.disabled = !tab?.canGoForward; reload.disabled = !tab;
    const file = Boolean(tab?.page?.path); omni.classList.toggle('bu-file', file); tree.hidden = !['file', 'dir'].includes(tab?.page?.kind) && !(tab?.page?.kind === 'viz' && file);
    crumbs.hidden = false; crumbs.replaceChildren();
    if (file && tab.page.kind !== 'attachment' && !mobile()) {
      const all = addressCrumbs(tab.page.path);
      all.forEach((part, index) => {
        const current = index === all.length - 1;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'bu-crumb' + (current ? ' bu-current' : ''); b.textContent = part.name; b.title = part.path;
        const open = event => { event.stopPropagation(); if (current) edit(); else run(event.ctrlKey || event.metaKey || event.button === 1 ? 'new' : 'navigate', { input: part.path }); };
        b.onclick = open; b.onauxclick = event => { if (event.button === 1) { event.preventDefault(); open(event); } };
        crumbs.append(b);
        if (index < all.length - 1) { const sep = document.createElement('span'); sep.className = 'bu-separator'; sep.textContent = '›'; crumbs.append(sep); }
        if (index === 0) { const dots = document.createElement('span'); dots.className = 'bu-ellipsis'; dots.textContent = '…'; dots.hidden = true; crumbs.append(dots); }
      });
    } else if (['git', 'plugins', 'new', 'attachment', 'viz', 'html'].includes(tab?.page?.kind)) {
      const kind = tab.page.kind;
      if (kind === 'git' && cwd()) {
        const folder = document.createElement('button'); folder.type = 'button'; folder.className = 'bu-crumb'; folder.textContent = cwd().split(/[\\/]/).filter(Boolean).at(-1); folder.onclick = event => { event.stopPropagation(); if (mobile()) edit(); else run('navigate', {input:cwd()}); };
        crumbs.append(folder, document.createTextNode(' › '));
      }
      const label = t(`tabs:address.locations.${kind}`);
      // アプリのタブは題をパンの列に足す（HTML は ?title=、可視化は開いた束の題）
      const named = kind === 'attachment' && file ? tab.page.path.split(/[\\/]/).at(-1)
        : kind === 'html' && tab.page.title ? tab.page.title : '';
      crumbs.append(document.createTextNode(label + (named ? ` › ${named}` : '')));
      crumbs.title = label;
    } else {
      let text = tab?.page?.path ?? (tab?.page?.kind === 'viz' ? tab.title : tab?.url) ?? '';
      if (mobile() && !file) { try { text = new URL(text).host; } catch {} }
      if (mobile() && file) {
        // The phone is narrow, so it shows "… › name". Tapping edits the full absolute path, the same as on PC (ADR 0294 2.5).
        const name = text.split(/[\\/]/).filter(Boolean).at(-1) ?? text, label = document.createElement('span'); label.className = 'bu-phone-filename'; label.textContent = name;
        crumbs.append(document.createTextNode(text !== name ? '… › ' : ''), label);
      } else crumbs.textContent = text;
      crumbs.title = text;
    }
    preview.classList.toggle('on', view === 'preview'); source.classList.toggle('on', view === 'source');
    preview.setAttribute('aria-pressed', String(view === 'preview')); source.setAttribute('aria-pressed', String(view === 'source')); fit();
  }
  const observer = new ResizeObserver(() => { if (input.hidden) show(tab); }); observer.observe(root);
  return { root, show, edit, setView, destroy() { observer.disconnect(); clearTimeout(timer); ++ticket; } };
}
