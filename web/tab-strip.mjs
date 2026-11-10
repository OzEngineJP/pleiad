import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { createSpring, reducedMotion } from './motion.mjs';

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
  chevron: 'm6 9 6 6 6-6',
};
/** 線の絵。strokeWidth を渡すと線の太さを替える（タブの ✕ は 16px に 1.9 = 1.27px。パネルの ✖ 18px × 1.7 と同じ太さ） */
export function browserIcon(kind, strokeWidth = null) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth ?? (kind === 'more' ? 4 : kind === 'panel' ? 1.6 : 1.7))); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
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

// ---- タブの列の寸法（docs/design-system.md「内蔵ブラウザーのタブの列」） ----
const TAB_MIN = 96;          // これより細くしない。入らなければ横に流す
const NARROW_AT = 120;       // 1 枚あたりこれを切ったら、選んでいないタブの ✕ はホバーだけ（選んだタブは 120px を保つ）
const FADE = 24;             // 端のぼかしの幅。流すときはこの内側まで出す
const CLOSING_RIGHT = 60, CLOSING_BELOW = 40, TOUCH_HOLD = 2000;   // 続けて閉じる間、幅を止めておく範囲（Chrome の closing mode）

const clamp01 = x => Math.min(1, Math.max(0, x));
const rectOf = el => { try { return typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null; } catch { return null; } };
const widthOf = el => rectOf(el)?.width ?? 0;
const styleOf = el => { try { return typeof getComputedStyle === 'function' && el ? getComputedStyle(el) : null; } catch { return null; } };
const px = value => parseFloat(value) || 0;
const parentOf = el => el?.parentElement ?? el?.parent ?? null;
const docOn = (type, fn, opts) => { if (typeof document.addEventListener === 'function') document.addEventListener(type, fn, opts); };
const docOff = (type, fn, opts) => { if (typeof document.removeEventListener === 'function') document.removeEventListener(type, fn, opts); };
let listSeq = 0;

/**
 * タブの列（ロービングの 1 つのフォーカス）。返す items を左から並べる: タブ・＋・空き・∨（入りきらないときだけ）・✖（パネルを閉じる）。
 * ＋ は最後のタブのすぐ右、列が埋まったら右端で止まる。タブは 96px（選んだタブは 120px）まで縮み、それ以上は横に流す（端をぼかす）。
 * 開く・閉じる・幅の変化は web/motion.mjs の smooth のばね、一覧（∨）だけ snappy。update は差分で描く:
 * 消えたタブは縮んで消え、1 枚だけ増えたタブは 0 から伸びる。全部入れ替わったとき（会話の切り替え）は動かさずに描き直す
 */
export function createTabStrip({ onPick = () => {}, onClose = () => {}, onNew = () => {}, onMenu = () => {}, onPanelClose = null, shortcut = null,
  label = tab => tab.title || tab.page?.path || tab.url || t('tabs:strip.new') } = {}) {
  const root = document.createElement('div'); root.className = 'bu-tabs'; root.setAttribute('role', 'tablist'); root.setAttribute('aria-label', t('tabs:strip.label'));
  const add = browserButton('plus', t('tabs:strip.new'), () => onNew()); add.classList.add('bu-new');
  const gap = document.createElement('span'); gap.className = 'bu-tabrow-gap'; gap.setAttribute('aria-hidden', 'true');
  const list = browserButton('chevron', t('tabs:strip.all'), () => (listState ? closeList(true) : openList())); list.classList.add('bu-list');
  list.setAttribute('aria-haspopup', 'listbox'); list.setAttribute('aria-expanded', 'false'); list.hidden = true;
  const closeLabel = t('tabs:address.closePanel');
  const panelClose = browserButton('close', closeLabel, () => onPanelClose?.()); panelClose.classList.add('bu-panel-close');
  if (shortcut?.label) panelClose.title = `${closeLabel}（${shortcut.label}）`;
  if (shortcut?.aria) panelClose.setAttribute('aria-keyshortcuts', shortcut.aria);
  panelClose.hidden = !onPanelClose;

  let tabs = [], selected = null;
  const items = new Map();   // targetId → 生きているタブ（{ id, el, pick, close, tab, sig, spring, mode, nat, w0, onGrown }）
  const ghosts = new Set();  // 閉じて縮んでいるタブ
  let closing = false, closeRect = null, touchTimer = 0, follow = false, pointerType = 'mouse';
  let spacer = null, spacerTarget = 0, listState = null;
  const spacerSpring = createSpring(0, { onUpdate: w => { if (spacer) spacer.style.width = `${Math.max(0, w)}px`; } });
  const scrollSpring = createSpring(0, { onUpdate: x => { root.scrollLeft = x; edges(); } });

  const hasLayout = () => root.isConnected === true && typeof root.getBoundingClientRect === 'function' && root.clientWidth > 0;
  const liveEntries = () => [...items.values()].filter(entry => parentOf(entry.el) === root);
  const pickOf = id => items.get(id)?.pick ?? null;
  const focusPick = id => pickOf(id)?.focus?.({ preventScroll: true });

  // ---- 幅（ばねの値で書く。40px を切ったら余白も縮め、透明度は幅に結ぶ） ----
  function applyWidth(entry, w) {
    const el = entry.el; w = Math.max(0, w);
    el.style.flex = 'none'; el.style.width = `${w}px`; el.style.minWidth = '0px';
    const k = Math.min(1, w / 40);
    el.style.paddingLeft = `${12 * k}px`; el.style.paddingRight = `${6 * k}px`;
    let opacity = 1;
    if (entry.mode === 'grow') opacity = clamp01((w / (entry.nat || 240) - 0.1) / 0.5);
    else if (entry.mode === 'ghost') opacity = clamp01((w / (entry.w0 || 1) - 0.1) / 0.5);
    el.style.opacity = opacity < 1 ? String(opacity) : '';
    if (entry.mode === 'grow' && follow) root.scrollLeft = root.scrollWidth;
    edges();
  }
  function clearWidth(el) { for (const key of ['flex', 'width', 'minWidth', 'paddingLeft', 'paddingRight', 'opacity']) el.style[key] = ''; }
  const nowWidth = entry => (entry.spring?.moving ? entry.spring.value : widthOf(entry.el));
  function springOf(entry, from) {
    if (!entry.spring) { entry.spring = createSpring(from, { onUpdate: w => applyWidth(entry, w) }); applyWidth(entry, from); }
    else if (!entry.spring.moving) entry.spring.set(from);
    else applyWidth(entry, from);
    return entry.spring;
  }

  /** 本来の幅（閉じかけと空きを除いて CSS で並べた幅）を測り、今の幅からばねで向かう */
  function retarget() {
    if (!hasLayout()) { layout(); return; }
    const live = liveEntries(), aside = [...[...ghosts].map(entry => entry.el), spacer].filter(Boolean);
    const from = live.map(nowWidth), scrollLeft = root.scrollLeft;
    for (const node of aside) node.style.display = 'none';
    for (const entry of live) clearWidth(entry.el);
    layout();
    const natural = live.map(entry => widthOf(entry.el));
    for (const node of aside) node.style.display = '';
    live.forEach((entry, i) => {
      const moving = entry.spring?.moving;
      if (!moving && Math.abs(from[i] - natural[i]) < 0.5) { entry.mode = null; finishGrow(entry); return; }
      entry.nat = natural[i];
      springOf(entry, from[i]).to(natural[i], { onEnd: () => {
        if (!closing && parentOf(entry.el) === root) { clearWidth(entry.el); entry.mode = null; }
        finishGrow(entry);
      } });
    });
    root.scrollLeft = scrollLeft;
    edges();
  }
  function finishGrow(entry) { const done = entry.onGrown; entry.onGrown = null; done?.(); }

  // ---- 入るか・狭いか・∨ を出すか ----
  function layout() {
    const row = parentOf(root);
    if (!closing && row && hasLayout()) {
      const others = [...row.children].filter(node => node !== root && node !== list && !node.hidden);
      const rowStyle = styleOf(row), between = px(rowStyle?.columnGap) || 4;
      const outer = node => { const s = styleOf(node); return (node.offsetWidth || 0) + px(s?.marginLeft) + px(s?.marginRight); };
      const used = others.reduce((sum, node) => sum + (node === gap ? 8 : outer(node)), 0) + between * others.length + px(rowStyle?.paddingLeft) + px(rowStyle?.paddingRight);
      const room = row.clientWidth - used, n = tabs.length;
      const over = n * TAB_MIN + (n > 1 ? FADE : 0) > room;
      if (list.hidden === over) list.hidden = !over;
      if (!over && listState) closeList(false);
      root.classList.toggle('bu-narrow', n > 0 && (over || room / n < NARROW_AT));
    }
    edges();
  }
  function edges() {
    const max = root.scrollWidth - root.clientWidth, x = root.scrollLeft;
    root.classList.toggle('fade-s', x > 1);
    root.classList.toggle('fade-e', x < max - 1);
  }
  /** 端のぼかしの内側まで流す */
  function reveal(id, smooth) {
    const entry = items.get(id); if (!entry || !hasLayout()) return;
    const box = rectOf(root), rect = rectOf(entry.el); if (!box || !rect) return;
    let left = root.scrollLeft;
    if (rect.left < box.left + FADE) left += rect.left - box.left - FADE;
    else if (rect.right > box.right - FADE) left += rect.right - box.right + FADE;
    else return;
    scrollTabs(left, smooth);
  }
  /** 横スクロールも同じばね（ブラウザーの smooth は遠いほど長くなるので使わない） */
  function scrollTabs(left, smooth) {
    left = Math.max(0, Math.min(left, root.scrollWidth - root.clientWidth));
    if (!smooth || reducedMotion()) { scrollSpring.stop(); root.scrollLeft = left; edges(); return; }
    if (!scrollSpring.moving) scrollSpring.set(root.scrollLeft);
    scrollSpring.to(left);
  }
  function onWheel(event) {
    if (root.scrollWidth <= root.clientWidth + 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault(); scrollSpring.stop(); follow = false;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientWidth : 1;
    root.scrollLeft += event.deltaY * unit;
  }

  // ---- 続けて閉じる間は幅を止める（ポインターが列から出たら広げる。タッチは 2 秒） ----
  function enterClosing(type) {
    if (!hasLayout()) return;
    if (!closing) {
      closing = true; follow = false;
      for (const entry of liveEntries()) { const w = nowWidth(entry); entry.spring?.stop(); entry.mode = null; finishGrow(entry); applyWidth(entry, w); }
      closeRect = rectOf(root);
      docOn('pointermove', onPointerMove);
    }
    clearTimeout(touchTimer);
    if (type === 'touch') touchTimer = setTimeout(exitClosing, TOUCH_HOLD);
  }
  function exitClosing() {
    if (!closing) return;
    closing = false; clearTimeout(touchTimer); closeRect = null; docOff('pointermove', onPointerMove);
    retarget();
    // 広げた後は位置を保つ（今のタブへ引き戻さない。見ていた所が急に飛ぶため）
    if (spacer) { spacerTarget = 0; spacerSpring.to(0, { onEnd: dropSpacer }); }
  }
  function resetClosing() {
    if (!closing) return;
    closing = false; clearTimeout(touchTimer); closeRect = null; docOff('pointermove', onPointerMove);
    for (const entry of liveEntries()) clearWidth(entry.el);
  }
  function onPointerMove(event) {
    if (!closing || pointerType === 'touch' || !closeRect) return;
    const r = closeRect;
    if (event.clientX < r.left || event.clientX > r.right + CLOSING_RIGHT || event.clientY < r.top || event.clientY > r.bottom + CLOSING_BELOW) exitClosing();
  }
  /** 末尾の空き: 閉じるタブと同じばねで、同じ幅だけ伸ばす（和が一定なので列が揺れない） */
  function growSpacer(w) {
    if (!spacer) { spacer = document.createElement('div'); spacer.className = 'bu-spacer'; spacer.setAttribute('aria-hidden', 'true'); root.append(spacer); spacerSpring.set(0); spacerTarget = 0; }
    spacerTarget += w; spacerSpring.to(spacerTarget);
  }
  function dropSpacer() { spacerSpring.stop(); spacer?.remove(); spacer = null; spacerTarget = 0; }
  function dropGhosts() { for (const entry of ghosts) { entry.spring?.stop(); entry.el.remove(); } ghosts.clear(); }

  function ghostify(entry) {
    const w = nowWidth(entry), overflowing = root.scrollWidth > root.clientWidth + 1;
    entry.el.classList.add('bu-ghost'); entry.el.classList.remove('on'); entry.el.inert = true;
    entry.mode = 'ghost'; entry.w0 = w || 1; entry.onGrown = null; ghosts.add(entry);
    springOf(entry, w);
    if (closing && overflowing) growSpacer(w);
    entry.spring.to(0, { onEnd: () => { ghosts.delete(entry); entry.el.remove(); } });
  }

  // ---- 1 枚のタブ ----
  function makeEntry(id) {
    const el = document.createElement('div'); el.className = 'bu-tab'; el.dataset.target = id; el.setAttribute('role', 'presentation');
    const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'bu-tab-pick'; pick.setAttribute('role', 'tab');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'bu-tab-close'; close.tabIndex = -1;
    close.append(browserIcon('close', 1.9));
    const entry = { id, el, pick, close, tab: null, sig: null, spring: null, mode: null, nat: 0, w0: 0, onGrown: null };
    el.oncontextmenu = event => onMenu(entry.tab, event);
    pick.onclick = () => onPick(entry.tab);
    pick.onkeydown = event => onPickKey(entry, event);
    close.addEventListener('pointerdown', event => { pointerType = event.pointerType || 'mouse'; });
    // ポインターで閉じたら、残りのタブの幅をその場で止める（✕ が指の下に来続ける）。キーボードでは止めない
    close.onclick = event => { if (event?.detail > 0) enterClosing(pointerType); onClose(entry.tab); };
    el.append(pick, close);
    return entry;
  }
  function paintEntry(entry, tab, index) {
    entry.tab = tab;
    const name = label(tab), running = Boolean(tab.agent && tab.agentRunning);
    const sig = [name, tab.page?.kind ?? '', tab.favicon ?? '', tab.loading === true, running, tab.agentName ?? ''].join('\u0000');
    if (sig !== entry.sig) {
      entry.sig = sig;
      const { pick, close } = entry;
      pick.title = name;
      const title = document.createElement('span'); title.className = 'bu-tab-title'; title.textContent = name;
      // エージェントの印（inapp-browser.md。操作中だけ弧。最後に操作した idle の点は出さない）
      if (running) {
        const mark = document.createElement('span'); mark.className = 'bu-agent'; mark.setAttribute('aria-hidden', 'true'); mark.append(runMark());
        pick.setAttribute('aria-label', `${name}, ${t('browser.chromeWindow.chipAgentRunning', { name: tab.agentName ?? 'Claude' })}`);
        pick.replaceChildren(tabIcon(tab), mark, title);
      } else { pick.removeAttribute('aria-label'); pick.replaceChildren(tabIcon(tab), title); }
      const closeName = t('tabs:strip.close', { title: name });
      close.title = closeName; close.setAttribute('aria-label', closeName);
    }
    const on = entry.id === selected;
    entry.el.classList.toggle('on', on);
    entry.pick.setAttribute('aria-selected', String(on));
    entry.pick.tabIndex = on || (selected == null && index === 0) ? 0 : -1;
  }

  function onPickKey(entry, event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    let at = tabs.findIndex(tab => String(tab.targetId) === entry.id);
    if (event.key === 'ArrowRight') at = (at + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') at = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') at = 0;
    else if (event.key === 'End') at = tabs.length - 1;
    else if (event.key === 'Delete') { event.preventDefault(); onClose(entry.tab); return; }
    else return;
    event.preventDefault();
    const next = tabs[at]; if (!next) return;
    onPick(next); focusPick(String(next.targetId)); reveal(String(next.targetId), true);
  }
  // Ctrl+Tab・Ctrl+Shift+Tab・Ctrl+PageUp・Ctrl+PageDown でタブを移る（デスクトップのアプリだけ。ブラウザーではそのブラウザーのタブが移る）
  function onDocumentKey(event) {
    if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== 'Tab' && event.key !== 'PageDown' && event.key !== 'PageUp') return;
    if (!document.documentElement?.classList?.contains?.('desktop') || !root.isConnected || !tabs.length) return;
    const scope = root.closest?.('#filePreview') ?? parentOf(parentOf(root));
    const target = event.target;
    if (!scope?.contains?.(target) || target?.closest?.('.bu-alltabs')) return;
    event.preventDefault();
    const dir = event.key === 'PageUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
    const at = tabs.findIndex(tab => String(tab.targetId) === selected);
    const next = tabs[(at + dir + tabs.length) % tabs.length];
    onPick(next);
    if (root.contains(target)) focusPick(String(next.targetId));
  }

  // ---- 差分で描く ----
  function update(next = [], current = null) {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const focusedId = active && root.contains(active) ? active.closest?.('[data-target]')?.dataset?.target ?? null : null;
    const nextIds = next.map(tab => String(tab.targetId)), nextSet = new Set(nextIds);
    const prevIds = [...items.keys()];
    const animate = prevIds.some(id => nextSet.has(id)) && hasLayout();
    const added = nextIds.filter(id => !items.has(id));
    const before = selected;
    for (const id of prevIds) {
      if (nextSet.has(id)) continue;
      const entry = items.get(id); items.delete(id);
      if (animate) ghostify(entry); else { entry.spring?.stop(); entry.el.remove(); }
    }
    if (!animate) { dropGhosts(); dropSpacer(); resetClosing(); scrollSpring.stop(); follow = false; }
    tabs = next; selected = current == null ? null : String(current);
    // 並びが替わったら（まれ）、動かさずに並べ直す
    const keep = nextIds.filter(id => items.has(id));
    const inDom = [...root.children].filter(node => !node.classList?.contains('bu-ghost') && node !== spacer).map(node => node.dataset?.target);
    if (keep.join('\n') !== inDom.join('\n')) { dropGhosts(); for (const id of keep) root.append(items.get(id).el); if (spacer) root.append(spacer); }
    const grow = animate && added.length === 1 ? added[0] : null;
    let prev = null;
    next.forEach((tab, index) => {
      const id = nextIds[index];
      let entry = items.get(id);
      if (!entry) {
        entry = makeEntry(id); items.set(id, entry);
        if (prev) prev.el.after(entry.el); else root.prepend(entry.el);
        if (id === grow) { entry.mode = 'grow'; springOf(entry, 0); }
      }
      paintEntry(entry, tab, index);
      prev = entry;
    });
    if (grow) {
      const entry = items.get(grow);
      scrollSpring.stop(); follow = true;
      entry.onGrown = () => { follow = false; reveal(selected, true); };
    }
    if (added.length && closing) exitClosing();   // 閉じている途中に開いたら、止めた幅を戻す
    else if (animate && !closing) retarget();
    else layout();
    if (grow) { const entry = items.get(grow); if (entry && !entry.spring?.moving) finishGrow(entry); }
    else if (!closing && (selected !== before || !animate)) reveal(selected, animate);
    else if (!closing && animate && prevIds.length > keep.length) reveal(selected, true);
    // フォーカスが閉じたタブにあったら、今のタブへ移す
    if (focusedId && !items.has(focusedId)) focusPick(selected);
    if (listState) fillList(false);
  }

  // ---- すべてのタブの一覧（∨）。出るときだけ snappy で少し弾む ----
  function openList() {
    if (list.hidden || listState) return;
    const row = parentOf(root), host = parentOf(row);
    if (!row || !host) return;
    const hostRect = rectOf(host), buttonRect = rectOf(list), rowRect = rectOf(row);
    const id = `bu-alltabs-${++listSeq}`;
    const pop = document.createElement('div'); pop.className = 'bu-alltabs';
    const input = document.createElement('input'); input.className = 'bu-alltabs-q'; input.type = 'text';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', id);
    input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-label', t('tabs:strip.search')); input.placeholder = t('tabs:strip.search');
    const ul = document.createElement('ul'); ul.id = id; ul.setAttribute('role', 'listbox'); ul.setAttribute('aria-label', t('tabs:strip.all'));
    pop.append(input, ul);
    if (hostRect && buttonRect && rowRect) {
      const bottom = rectOf(root.closest?.('#filePreview'))?.bottom ?? globalThis.innerHeight ?? rowRect.bottom + 400;
      pop.style.top = `${rowRect.bottom - hostRect.top + 4}px`;
      pop.style.right = `${Math.max(8, hostRect.right - buttonRect.right)}px`;
      pop.style.maxHeight = `${Math.max(120, bottom - rowRect.bottom - 12)}px`;
    }
    host.append(pop);
    let spring = null;
    spring = createSpring(0, { preset: 'snappy', epsilon: 0.001, onUpdate: q => {
      pop.style.opacity = String(clamp01(q));
      pop.style.transform = q >= 1 && !spring?.moving ? '' : `translateY(${(q - 1) * 4}px)`;
    } });
    listState = { pop, input, ul, id, act: 0, rows: [], spring };
    list.setAttribute('aria-expanded', 'true');
    input.addEventListener('input', () => fillList(true));
    input.addEventListener('keydown', onListKey);
    pop.addEventListener('focusout', event => { if (listState && !pop.contains(event.relatedTarget) && event.relatedTarget !== list) closeList(false); });
    pop.addEventListener('click', event => { const option = event.target?.closest?.('[role=option]'); if (option) pickFromList(option.dataset.target); });
    docOn('pointerdown', onOutsidePointer, true);
    fillList(false);
    input.focus?.({ preventScroll: true });
    pop.style.opacity = '0'; pop.style.transform = 'translateY(-4px)';
    spring.to(1);
  }
  function fillList(reset) {
    const state = listState; if (!state) return;
    const query = String(state.input.value ?? '').trim().toLowerCase();
    state.rows = tabs.filter(tab => !query || label(tab).toLowerCase().includes(query));
    state.act = reset ? 0 : Math.max(0, state.rows.findIndex(tab => String(tab.targetId) === selected));
    if (!state.rows.length) {
      const none = document.createElement('li'); none.className = 'none'; none.setAttribute('role', 'presentation'); none.textContent = t('tabs:strip.noMatch');
      state.ul.replaceChildren(none);
    } else state.ul.replaceChildren(...state.rows.map((tab, index) => {
      const li = document.createElement('li'); li.setAttribute('role', 'option'); li.id = `${state.id}-${index}`; li.dataset.target = String(tab.targetId);
      li.setAttribute('aria-selected', 'false');
      if (String(tab.targetId) === selected) li.setAttribute('aria-current', 'true');
      const text = document.createElement('span'); text.className = 't'; text.textContent = label(tab);
      li.append(tabIcon(tab), text);
      return li;
    }));
    markActive();
  }
  function markActive() {
    const state = listState; if (!state) return;
    const options = [...state.ul.querySelectorAll('[role=option]')];
    options.forEach((li, i) => { const on = i === state.act; li.classList.toggle('act', on); li.setAttribute('aria-selected', String(on)); });
    const li = options[state.act];
    if (!li) { state.input.removeAttribute('aria-activedescendant'); return; }
    state.input.setAttribute('aria-activedescendant', li.id);
    if (li.offsetTop < state.ul.scrollTop) state.ul.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > state.ul.scrollTop + state.ul.clientHeight) state.ul.scrollTop = li.offsetTop + li.offsetHeight - state.ul.clientHeight;
  }
  function onListKey(event) {
    const state = listState; if (!state) return;
    const n = state.rows.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (n) { state.act = (state.act + (event.key === 'ArrowDown' ? 1 : -1) + n) % n; markActive(); } }
    else if (event.key === 'Enter') { event.preventDefault(); if (n) pickFromList(String(state.rows[state.act].targetId)); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeList(true); }
    else if (event.key === 'Tab') closeList(false);
  }
  function pickFromList(id) {
    const tab = tabs.find(row => String(row.targetId) === id);
    closeList(false);
    if (!tab) return;
    onPick(tab); focusPick(id); reveal(id, true);
  }
  function onOutsidePointer(event) {
    if (!listState || listState.pop.contains(event.target) || list.contains(event.target)) return;
    closeList(false);
  }
  function closeList(focusButton) {
    if (!listState) return;
    const { pop, spring } = listState; listState = null;
    spring.stop(); pop.remove(); docOff('pointerdown', onOutsidePointer, true);
    list.setAttribute('aria-expanded', 'false');
    if (focusButton) list.focus?.({ preventScroll: true });
  }

  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('scroll', edges, { passive: true });
  docOn('keydown', onDocumentKey);
  let observed = null;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!closing) layout(); }) : null;
  observer?.observe(root);
  /** 列の幅が替わったら測り直す（列に付いた後で見張りを足す） */
  function relayout() {
    const row = parentOf(root);
    if (observer && row && observed !== row && typeof row.getBoundingClientRect === 'function') { observer.observe(row); observed = row; }
    if (!closing) layout();
  }
  return {
    root, add, list, panelClose,
    /** 列に並べる順（タブ・＋・空き・∨・✖） */
    items: [root, add, gap, list, panelClose],
    update, relayout, reveal: (id, smooth = true) => reveal(id == null ? selected : String(id), smooth),
    /** 今のタブにフォーカスを置く（パネルを開いたとき） */
    focusCurrent: () => { const id = selected ?? (tabs[0] ? String(tabs[0].targetId) : null); if (id) focusPick(id); return Boolean(id && pickOf(id)); },
    closeList: () => closeList(false),
    destroy() { observer?.disconnect(); closeList(false); docOff('keydown', onDocumentKey); resetClosing(); },
  };
}
