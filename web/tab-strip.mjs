import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';

const paths = {
  back: 'm14 5-7 7 7 7', forward: 'm10 5 7 7-7 7', reload: 'M20 10a8 8 0 1 0-1 8M20 4v6h-6',
  close: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14',
  file: 'M14 2H6v20h12V6l-4-4v5h5M9 12h6M9 16h6', dir: 'M3 6h7l2 3h9v11H3z',
  viz: 'M4 19V9m8 10V3m8 16v-7M2 21h20',
  web: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  tree: 'M4 3v14h6M4 8h6M13 6h7v4h-7zM13 15h7v4h-7z',
  source: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20', preview: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  more: 'M12 4v.01M12 12v.01M12 20v.01', panel: 'M7 4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4ZM3 9.5h18M10.5 4v5.5',
  git: 'M6 3v12a4 4 0 0 0 8 0V9M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4M14 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  plugins: 'M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0', chat: 'M4 5h16v11H9l-5 4z', window: 'M3 4h18v16H3zM3 9h18',
  new: 'M12 5v14M5 12h14', attachment: 'm9 12 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9',
  saved: 'M12 7v5l3.5 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', external: 'M14 4h6v6M20 4l-9 9M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4',
};
export function browserIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', kind === 'more' ? '4' : kind === 'panel' ? '1.6' : '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', paths[kind] ?? paths.file); svg.append(p); return svg;
}
export function browserButton(kind, label, run) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'bu-icon'; b.title = label; b.setAttribute('aria-label', label); b.append(browserIcon(kind)); b.onclick = run; return b;
}

export function tabIcon(tab) {
  let icon = browserIcon(tab.page?.kind ?? 'web');
  if (!tab.page && typeof tab.favicon === 'string' && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd.microsoft.icon);base64,/i.test(tab.favicon) && tab.favicon.length <= 87520) {
    icon = document.createElement('img'); icon.src = tab.favicon; icon.alt = '';
  }
  icon.classList.add('bu-favicon'); icon.classList.toggle('bu-loading', tab.loading === true);
  return icon;
}

/** Accessible tab list with one roving keyboard focus. externalNew: ＋を列の外へ出す（右端に固定する用に add を返す） */
export function createTabStrip({ onPick = () => {}, onClose = () => {}, onNew = () => {}, onMenu = () => {}, externalNew = false,
  label = tab => tab.title || tab.page?.path || tab.url || t('tabs:strip.new') } = {}) {
  const root = document.createElement('div'); root.className = 'bu-tabs'; root.setAttribute('role', 'tablist'); root.setAttribute('aria-label', t('tabs:strip.label'));
  const add = browserButton('plus', t('tabs:strip.new'), onNew); add.classList.add('bu-new');
  let tabs = [], selected = null;
  function fit() { root.classList.toggle('bu-favicons', (root.clientWidth - (externalNew ? 14 : 46)) / Math.max(tabs.length, 1) < 64); }
  function update(next = [], current = null) {
    tabs = next; selected = current;
    const focused = root.contains(document.activeElement) ? document.activeElement.closest('[data-target]')?.dataset.target : null;
    root.replaceChildren(...tabs.map((tab, index) => {
      const item = document.createElement('div'); item.className = 'bu-tab'; item.dataset.target = tab.targetId;
      item.oncontextmenu = event => onMenu(tab, event);
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'bu-tab-pick'; pick.setAttribute('role', 'tab');
      pick.setAttribute('aria-selected', String(tab.targetId === selected)); pick.tabIndex = tab.targetId === selected || (!selected && index === 0) ? 0 : -1;
      pick.title = label(tab);
      const icon = tabIcon(tab);
      const title = document.createElement('span'); title.className = 'bu-tab-title'; title.textContent = pick.title;
      // エージェントの印（inapp-browser.md。操作中だけ弧。最後に操作した idle の点は出さない）
      if (tab.agent && tab.agentRunning) {
        const mark = document.createElement('span'); mark.className = 'bu-agent'; mark.setAttribute('aria-hidden', 'true');
        mark.append(runMark());
        pick.setAttribute('aria-label', `${pick.title}, ${t('browser.chromeWindow.chipAgentRunning', { name: tab.agentName ?? 'Claude' })}`);
        pick.append(icon, mark, title);
      } else pick.append(icon, title);
      pick.onclick = () => onPick(tab);
      pick.onkeydown = event => {
        let at = tabs.findIndex(row => row.targetId === tab.targetId);
        if (event.key === 'ArrowRight') at = (at + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') at = (at - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') at = 0;
        else if (event.key === 'End') at = tabs.length - 1;
        else if (event.key === 'Delete') { event.preventDefault(); onClose(tab); return; }
        else return;
        event.preventDefault(); onPick(tabs[at]); root.querySelectorAll('[role=tab]')[at]?.focus();
      };
      const close = browserButton('close', t('tabs:strip.close', { title: pick.title }), () => onClose(tab)); close.classList.add('bu-tab-close');
      item.classList.toggle('on', tab.targetId === selected); item.append(pick, close); return item;
    }), ...(externalNew ? [] : [add]));
    fit(); if (focused) [...root.querySelectorAll('[data-target]')].find(row => row.dataset.target === focused)?.querySelector('[role=tab]')?.focus();
  }
  const observer = new ResizeObserver(fit); observer.observe(root);
  return { root, add, update, destroy() { observer.disconnect(); } };
}
