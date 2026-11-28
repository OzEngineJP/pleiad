import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { chevRightIcon, openInBrowserIcon, panelIcon } from './icons.mjs';

const storageKey = 'pleiad.todoTabs';
const conversation = { type: 'conversation', key: 'conversation' };
const label = key => t(`todoTabs.${key}`); // i18n-dynamic: todoTabs.
const listRef = ({ id, name }) => ({ type: 'list', key: `list:${id}`, id, name });
function boardRef({ tenantId, workspaceId, databaseId, viewId }) {
  return { type: 'board', key: `board:${tenantId}:${workspaceId}:${databaseId}:${viewId}`,
    tenantId, workspaceId, databaseId, viewId };
}
const boardArgs = ({ tenantId, workspaceId, databaseId, viewId }) => ({ tenantId, workspaceId, databaseId, viewId });

function saved() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return { conversations: value?.conversations ?? {}, recent: value?.recent ?? [] };
  } catch { return { conversations: {}, recent: [] }; }
}
function save(value) {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
function button(className, content, fn) {
  const b = el('button', className, content);
  b.type = 'button';
  b.onclick = fn;
  return b;
}
const boardInfo = board => [board.workspaceName, board.viewName].filter(Boolean).join(' · ');
let nextPanel = 0;

export function createTodoTabs({ invoke, showNative, stage, addWrap, openLink, login }) {
  const panelId = `todo-tab-panel-${++nextPanel}`;
  const bar = el('div', 'td-tabs');
  const rail = el('div', 'td-tabrail');
  rail.setAttribute('role', 'tablist');
  rail.setAttribute('aria-label', label('lists'));
  const pinned = el('div', 'td-tab');
  const strip = el('div', 'td-tabstrip');
  strip.setAttribute('role', 'presentation');
  rail.append(pinned, strip);
  const panel = el('div', 'td-tab-panel');
  panel.id = panelId;
  panel.setAttribute('role', 'tabpanel');
  const alternate = el('div', 'td-tab-content');
  const chooser = el('section', 'td-tab-chooser');
  chooser.id = `${panelId}-chooser`;
  chooser.setAttribute('aria-labelledby', `${panelId}-chooser-title`);
  chooser.hidden = true;
  const add = button('td-tab-tool', '＋', () => toggleChooser('add', add));
  const all = button('td-tab-tool', '', () => toggleChooser('all', all));
  all.innerHTML = panelIcon;
  for (const [control, name] of [[add, 'addTab'], [all, 'allTabs']]) {
    control.title = label(name);
    control.setAttribute('aria-label', control.title);
    control.setAttribute('aria-controls', chooser.id);
    control.setAttribute('aria-expanded', 'false');
  }
  bar.append(rail, all, add);
  panel.append(stage, addWrap, alternate);

  let sessionId, tabRefs = [], active = conversation, mode = '', opener = null;
  let chooserEpoch = 0, boardEpoch = 0, boardData, plusIdentity = null;
  let rememberBoard = false;
  let titles = new Map();
  let requestFocus = false;
  function nameOf(ref) {
    if (ref.type === 'conversation') return label('conversation');
    if (ref.type === 'list') return ref.name;
    const info = titles.get(ref.key);
    if (!info) return label('board');
    const samePage = tabRefs.some(tab => tab.key !== ref.key && tab.tenantId === ref.tenantId && tab.databaseId === ref.databaseId);
    return samePage && info.viewName ? `${info.title} · ${info.viewName}` : info.title;
  }
  const tabs = () => [conversation, ...tabRefs];
  const activeButton = () => rail.querySelector('[aria-selected="true"]');
  const status = message => {
    const node = el('p', 'td-tab-state', label(message));
    node.setAttribute('role', 'status');
    return node;
  };

  function drawTabs() {
    const { tabKey, tabClose } = document.activeElement?.dataset ?? {};
    const scrollable = [];
    tabs().forEach((ref, index) => {
      const selected = active.key === ref.key;
      const row = ref === conversation ? pinned : el('div', 'td-tab');
      row.setAttribute('role', 'presentation');
      row.dataset.selected = String(selected);
      const tabName = nameOf(ref);
      const tab = button('td-tab-label', tabName, () => activate(ref, { focus: true }));
      tab.id = `${panelId}-tab-${index}`;
      const info = titles.get(ref.key);
      tab.title = info ? [info.title, boardInfo(info)].filter(Boolean).join(' · ') : tabName;
      tab.dataset.tabKey = ref.key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
      tab.setAttribute('aria-controls', panelId);
      tab.tabIndex = selected ? 0 : -1;
      row.replaceChildren(tab);
      if (ref !== conversation) {
        const close = button('td-tab-close', '×', () => remove(ref));
        close.title = t('todoTabs.closeNamed', { name: tabName });
        close.setAttribute('aria-label', close.title);
        close.tabIndex = selected ? 0 : -1;
        close.dataset.tabClose = ref.key;
        row.append(close);
        scrollable.push(row);
      }
    });
    strip.replaceChildren(...scrollable);
    all.hidden = tabRefs.length === 0;
    panel.setAttribute('aria-labelledby', activeButton().id);
    const previousClose = tabClose && rail.querySelector(`[data-tab-close="${CSS.escape(tabClose)}"]`);
    if (requestFocus || tabKey || tabClose) (requestFocus ? activeButton() : previousClose || activeButton()).focus({ preventScroll: true });
    requestFocus = false;
    const selected = activeButton().parentElement;
    if (selected === pinned) return;
    const bounds = strip.getBoundingClientRect();
    const tabBounds = selected.getBoundingClientRect();
    if (tabBounds.left < bounds.left) strip.scrollLeft -= Math.ceil(bounds.left - tabBounds.left);
    else if (tabBounds.right > bounds.right) strip.scrollLeft += Math.ceil(tabBounds.right - bounds.right);
  }
  rail.onkeydown = event => {
    const current = tabs().findIndex(ref => ref.key === event.target.dataset.tabKey);
    if (current < 0) return;
    const count = tabRefs.length + 1;
    const steps = { ArrowLeft: (current + count - 1) % count, ArrowRight: (current + 1) % count, Home: 0, End: count - 1 };
    if (event.key === 'Delete' && current > 0) { event.preventDefault(); remove(tabs()[current]); }
    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    activate(tabs()[steps[event.key]], { focus: true });
  };

  function persistTabs() {
    if (!sessionId) return;
    const value = saved();
    if (tabRefs.length) value.conversations[sessionId] = tabRefs;
    else delete value.conversations[sessionId];
    save(value);
  }
  function remember(ref) {
    if (ref === conversation) return;
    const value = saved();
    value.recent = [ref, ...value.recent.filter(previous => previous.key !== ref.key)].slice(0, 30);
    save(value);
  }
  function activate(ref, { focus = false, record = true } = {}) {
    closeChooser(false);
    active = ref;
    if (ref !== conversation && !tabRefs.some(tab => tab.key === ref.key)) {
      tabRefs.push(ref);
      persistTabs();
    }
    requestFocus = focus;
    drawTabs();
    panel.tabIndex = ref.type === 'board' ? 0 : -1;
    alternate.hidden = ref.type !== 'board';
    if (ref.type === 'board') {
      rememberBoard = record;
      showNative(null, true);
      void readBoard();
    } else {
      boardEpoch++;
      boardData = null;
      alternate.replaceChildren();
      const opened = showNative(ref.type === 'list' ? ref.id : null, false);
      if (ref.type === 'list' && record) {
        void opened.then(ok => { if (ok && active.key === ref.key) remember(ref); });
      }
    }
  }
  function remove(ref) {
    const index = tabRefs.findIndex(tab => tab.key === ref.key);
    if (index < 0) return;
    tabRefs.splice(index, 1);
    persistTabs();
    if (active.key === ref.key) activate(tabRefs[index - 1] ?? conversation, { focus: true });
    else { requestFocus = true; drawTabs(); }
  }
  function load(id, visible) {
    if (sessionId === id) return;
    sessionId = id;
    tabRefs = id ? (saved().conversations[id] ?? []) : [];
    activate(conversation, { record: false });
    if (visible) refresh();
  }

  function closeChooser(focus = true) {
    if (!mode) return false;
    mode = ''; chooserEpoch++;
    chooser.replaceChildren();
    chooser.hidden = true;
    panel.hidden = false;
    add.setAttribute('aria-expanded', 'false');
    all.setAttribute('aria-expanded', 'false');
    if (focus) (opener?.hidden ? activeButton() : opener)?.focus({ preventScroll: true });
    opener = null;
    return true;
  }
  function toggleChooser(next, from) {
    if (opener === from && mode) { closeChooser(); return; }
    closeChooser(false);
    opener = from;
    from.setAttribute('aria-expanded', 'true');
    showChooser(next);
  }
  function option(name, fn, detail, arrow = false) {
    const line = button('td-tab-option', '', fn);
    const text = el('span', 'td-tab-option-text', name);
    if (detail) text.append(el('small', '', detail));
    line.append(text);
    if (arrow) {
      const icon = el('span', 'td-tab-chevron');
      icon.innerHTML = chevRightIcon;
      line.append(icon);
    }
    return line;
  }
  function choose(ref) { activate(ref, { focus: true }); }
  function boardError(error, retry) {
    if (error?.code === 'TODO_BOARDS_SIGN_IN') {
      return [status('signInRequired'), button('td-tab-action', label('signIn'), () => {
        void Promise.resolve(login?.()).catch(() => retry());
      })];
    }
    if (error?.code === 'TODO_BOARDS_FORBIDDEN') return [status('noAccess')];
    return [status('unavailable'), button('td-tab-action', label('retry'), retry)];
  }
  function showChooser(next) {
    mode = next;
    const epoch = ++chooserEpoch;
    panel.hidden = true;
    chooser.hidden = false;
    chooser.scrollTop = 0;
    const title = el('h3', '', label(next === 'all' ? 'allTabs' : next === 'add' ? 'addTab' : next));
    title.id = `${panelId}-chooser-title`;
    title.tabIndex = -1;
    const back = button('td-tab-tool', '‹', () => showChooser('add'));
    back.setAttribute('aria-label', label('back'));
    const close = button('td-tab-tool', '×', () => closeChooser());
    close.setAttribute('aria-label', label('closePicker'));
    const top = el('div', 'td-tab-pickerhead');
    if (!['add', 'all'].includes(next)) top.append(back);
    top.append(title, close);
    const content = el('div', 'td-tab-options');
    chooser.replaceChildren(top, content);
    const stillHere = () => epoch === chooserEpoch;
    if (next === 'all') {
      content.append(...tabs().map(ref => {
        const name = nameOf(ref);
        const detail = ref.type === 'board' ? boardInfo(titles.get(ref.key) ?? {})
          : ref.type === 'list' ? label('standalone') : '';
        const pick = option(name, () => choose(ref), detail);
        if (active.key === ref.key) pick.setAttribute('aria-current', 'true');
        const row = el('div', 'td-tab-option-row');
        row.append(pick);
        if (ref !== conversation) {
          const detach = button('td-tab-close', '×', () => {
            remove(ref);
            if (mode === 'all') {
              const nextPick = row.nextElementSibling?.firstElementChild ?? row.previousElementSibling?.firstElementChild;
              row.remove();
              nextPick?.focus({ preventScroll: true });
            }
          });
          detach.title = t('todoTabs.closeNamed', { name });
          detach.setAttribute('aria-label', detach.title);
          row.append(detach);
        }
        return row;
      }));
    } else if (next === 'add') {
      const recent = el('div', 'td-tab-recents');
      content.append(recent,
        option(label('newList'), () => showChooser('newList'), '', true),
        option(label('existing'), () => showChooser('existing'), '', true),
        option(label('board'), () => showChooser('board'), '', true));
      const refs = saved().recent;
      const lists = new Map();
      const boards = new Map();
      const drawRecent = () => {
        if (!stillHere()) return;
        const options = refs.flatMap(ref => {
          const info = ref.type === 'board' ? boards.get(ref.key) : lists.get(ref.key);
          if (!info) return [];
          const pick = option(info.title ?? info.name, () => {
            if (ref.type === 'board') titles.set(ref.key, info);
            choose(ref);
          }, ref.type === 'board' ? boardInfo(info) : label('standalone'));
          pick.dataset.recentKey = ref.key;
          return [pick];
        }).slice(0, 3);
        const focus = document.activeElement?.dataset.recentKey;
        recent.replaceChildren(...(options.length ? [el('h4', '', label('recent')), ...options] : []));
        if (focus) (options.find(option => option.dataset.recentKey === focus) ?? options[0] ?? title).focus({ preventScroll: true });
      };
      if (refs.some(ref => ref.type === 'list')) {
        void invoke('todoLists.catalog').then(({ lists: results }) => {
          for (const entry of results.map(listRef)) lists.set(entry.key, entry);
          drawRecent();
        }).catch(() => {});
      }
      if (refs.some(ref => ref.type === 'board')) {
        void invoke('todoBoards.catalog').then(({ boards: results }) => {
          if (!stillHere()) return;
          for (const entry of results) boards.set(boardRef(entry).key, entry);
          drawRecent();
        }).catch(() => {});
      }
    } else if (next === 'newList') {
      const form = el('form', 'td-tab-form');
      const field = el('label', '', label('listName'));
      const input = el('input', 'field');
      input.required = true;
      input.maxLength = 80;
      const submit = button('td-tab-action', label('create'), null);
      submit.type = 'submit';
      const error = status('createFailed');
      error.hidden = true;
      field.append(input);
      form.append(field, submit, error);
      content.append(form);
      form.onsubmit = async event => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name || submit.disabled) return;
        submit.disabled = input.readOnly = true;
        try {
          const ref = listRef(await invoke('todoLists.create', { name }));
          if (stillHere()) choose(ref);
        } catch {
          if (stillHere()) error.hidden = false;
        } finally {
          submit.disabled = input.readOnly = false;
        }
      };
      input.focus({ preventScroll: true });
      return;
    } else {
      const isBoard = next === 'board';
      content.append(status('loading'));
      void invoke(isBoard ? 'todoBoards.catalog' : 'todoLists.catalog').then(result => {
        if (!stillHere()) return;
        const candidates = isBoard ? result.boards : result.lists;
        if (!candidates.length) {
          content.replaceChildren(status(isBoard ? 'noBoards' : 'noLists'));
          return;
        }
        const search = el('input', 'field td-tab-search');
        search.type = 'search';
        search.placeholder = label(isBoard ? 'searchBoards' : 'searchLists');
        search.setAttribute('aria-label', search.placeholder);
        const matches = el('div', '');
        const entries = candidates.map(info => {
          const name = isBoard ? info.title : info.name;
          const detail = isBoard ? boardInfo(info) : '';
          const pick = option(name, () => {
            const ref = isBoard ? boardRef(info) : listRef(info);
            if (isBoard) titles.set(ref.key, info);
            choose(ref);
          }, detail);
          return { pick, terms: `${name} ${detail}`.toLocaleLowerCase() };
        });
        const updateMatches = () => {
          const term = search.value.trim().toLocaleLowerCase();
          const options = entries.filter(({ terms }) => terms.includes(term)).map(({ pick }) => pick);
          matches.replaceChildren(...(options.length ? options : [status('noMatches')]));
        };
        search.oninput = updateMatches;
        updateMatches();
        content.replaceChildren(search, matches);
      }).catch(error => {
        if (!stillHere()) return;
        content.replaceChildren(...(isBoard ? boardError(error, () => showChooser(next))
          : [status('listFailed'), button('td-tab-action', label('retry'), () => showChooser(next))]));
      });
    }
    title.focus({ preventScroll: true });
  }

  function drawBoard() {
    const { title, viewName, url, columns, rows, conversation: showConversation, nextOffset } = boardData;
    const toolbar = el('div', 'td-board-head');
    const metadata = titles.get(active.key);
    toolbar.append(el('span', 'td-tab-state', boardInfo({ ...metadata, viewName })));
    const open = button('td-board-link', label('openPlus'), () => openLink?.({ kind: 'url', url }));
    open.insertAdjacentHTML('beforeend', openInBrowserIcon);
    toolbar.append(open);
    const groups = new Map(columns.map(column => [column.id, { name: column.label, rows: [] }]));
    const unset = { name: label('unset'), rows: [] };
    for (const row of rows) (groups.get(row.columnId) ?? unset).rows.push(row);
    if (unset.rows.length || !groups.size) groups.set(null, unset);
    const sections = [...groups.values()].map(group => {
      const section = el('section', 'td-board-group');
      section.append(el('h3', '', group.name));
      if (!group.rows.length) section.append(status('noTasks'));
      else {
        const items = el('ul', '');
        for (const row of group.rows) {
          const item = el('li', '', row.title);
          if (showConversation) item.append(el('small', '', row.conversationStates.length
            ? row.conversationStates.map(label).join(label('statusSeparator')) : label('noConversation')));
          items.append(item);
        }
        section.append(items);
      }
      return section;
    });
    alternate.replaceChildren(toolbar, ...sections);
    if (nextOffset !== null) {
      const more = button('td-tab-action', label('more'), () => {
        more.disabled = true;
        void readBoard({ offset: nextOffset, focus: true });
      });
      alternate.append(more);
    }
    titles.set(active.key, { ...metadata, title, viewName });
    drawTabs();
  }
  async function readBoard({ offset = 0, focus = false } = {}) {
    if (active.type !== 'board') return;
    const ref = active;
    const epoch = ++boardEpoch;
    if (!offset) {
      boardData = null;
      alternate.replaceChildren(status('loading'));
    }
    try {
      const value = await invoke('todoBoards.read', { ...boardArgs(ref), offset });
      if (epoch !== boardEpoch || active !== ref) return;
      const sameColumns = JSON.stringify(boardData?.columns) === JSON.stringify(value.columns);
      if (offset && !sameColumns) { void readBoard({ focus }); return; }
      boardData = offset ? { ...value, rows: [...boardData.rows, ...value.rows] } : value;
      if (rememberBoard) { remember(ref); rememberBoard = false; }
      drawBoard();
      if (focus && !mode) panel.focus({ preventScroll: true });
    } catch (error) {
      if (epoch !== boardEpoch || active !== ref) return;
      boardData = null;
      titles.delete(ref.key);
      drawTabs();
      alternate.replaceChildren(...boardError(error, () => void readBoard()));
    }
  }
  function refresh() {
    if (active.type === 'board') void readBoard();
    if (!tabRefs.some(ref => ref.type === 'board' && !titles.has(ref.key))) return;
    const identity = titles;
    void invoke('todoBoards.catalog').then(({ boards }) => {
      if (identity !== titles) return;
      for (const board of boards) {
        const ref = boardRef(board);
        if (tabRefs.some(tab => tab.key === ref.key)) titles.set(ref.key, board);
      }
      drawTabs();
      if (mode === 'all') showChooser('all');
    }).catch(() => {});
  }
  function plusStatus(state, visible) {
    const key = JSON.stringify([state?.signedIn, state?.uid, state?.available, state?.reachable]);
    if (key === plusIdentity) return;
    plusIdentity = key;
    titles = new Map();
    boardData = null;
    alternate.replaceChildren();
    boardEpoch++;
    drawTabs();
    if (!visible) return;
    refresh();
    if (mode === 'board' || mode === 'add') showChooser(mode);
  }

  return { bar, panel, chooser, load, closeChooser, refresh, plusStatus };
}
