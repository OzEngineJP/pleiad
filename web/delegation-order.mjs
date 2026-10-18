// 設定 › 委譲の候補の並べ替え（docs/design-system.md「設定 › 委譲」）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

/** 順序を変えた配列。移動できない・順序が同じなら null。元の配列には触れない。 */
export function moveCandidate(list, candidate, to) {
  const from = list.indexOf(candidate);
  if (from < 0 || !Number.isInteger(to) || to < 0 || to >= list.length || from === to) return null;
  const next = [...list];
  next.splice(from, 1); next.splice(to, 0, candidate);
  return next;
}

export function candidateOrder({ root, current, move, settled, showMenu, announce }) {
  let drag = null, suppressClick = false, suppressTimer;
  root.addEventListener('pointerdown', () => { suppressClick = false; clearTimeout(suppressTimer); }, true);
  root.addEventListener('click', e => {
    if (suppressClick && e.detail > 0) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  function handle(tier, candidate, name) {
    const b = el('button', 'rt-grip');
    b.type = 'button'; b.dataset.fk = `order|${tier}|${candidate}`;
    b.disabled = current(tier).length < 2;
    b.setAttribute('aria-label', t('routing.settings.candidateOrder', { name }));
    b.setAttribute('aria-haspopup', 'menu');
    b.title = t('routing.settings.orderHelp');
    b.setAttribute('aria-description', b.title);
    b.innerHTML = '<svg viewBox="0 0 8 14" aria-hidden="true">' + [2, 7, 12].map(y => `<circle cx="2" cy="${y}" r="1.3"/><circle cx="6" cy="${y}" r="1.3"/>`).join('') + '</svg>';
    b.onclick = () => {
      const list = current(tier), i = list.indexOf(candidate), r = b.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: t('routing.settings.orderFirst'), disabled: i <= 0, onClick: () => move(tier, candidate, 0) },
        { label: t('routing.settings.orderUp'), disabled: i <= 0, onClick: () => move(tier, candidate, current(tier).indexOf(candidate) - 1) },
        { label: t('routing.settings.orderDown'), disabled: i < 0 || i === list.length - 1, onClick: () => move(tier, candidate, current(tier).indexOf(candidate) + 1) },
        { label: t('routing.settings.orderLast'), disabled: i < 0 || i === list.length - 1, onClick: () => move(tier, candidate, current(tier).length - 1) },
      ], name);
    };
    b.onkeydown = e => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const list = current(tier), i = list.indexOf(candidate);
      move(tier, candidate, e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : i + (e.key === 'ArrowUp' ? -1 : 1));
    };
    b.onpointerdown = e => {
      if (drag || b.disabled || e.button !== 0 || !e.isPrimary) return;
      const row = b.closest('.rt-cand-row'), list = row.parentElement;
      b.focus({ preventScroll: true });
      drag = { tier, candidate, name, row, list, button: b, pointer: e.pointerId, original: [...current(tier)],
        x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, rect: row.getBoundingClientRect(), active: false, animations: [] };
      document.addEventListener('pointermove', pointerMove, { passive: false, capture: true });
      document.addEventListener('pointerup', pointerUp, true);
      document.addEventListener('pointercancel', cancel, true);
      document.addEventListener('keydown', key, true);
      window.addEventListener('blur', cancel);
      window.addEventListener('resize', cancel);
      b.setPointerCapture(e.pointerId);
      drag.raf = requestAnimationFrame(tick);
    };
    return b;
  }

  function pointerMove(e) {
    if (!drag || drag.pointer !== e.pointerId) return;
    const d = drag; d.lastX = e.clientX; d.lastY = e.clientY;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    e.preventDefault();
    if (!d.active) {
      d.active = true;
      const style = getComputedStyle(d.row);
      d.ghost = d.row.cloneNode(true);
      for (const prop of ['gridTemplateColumns', 'gridTemplateAreas', 'gap', 'padding']) d.ghost.style[prop] = style[prop];
      d.ghost.classList.add('rt-order-ghost'); d.ghost.setAttribute('aria-hidden', 'true'); d.ghost.inert = true;
      d.ghost.querySelectorAll('.pop').forEach(p => p.remove());
      d.ghost.style.width = `${d.rect.width}px`; d.ghost.style.left = `${d.rect.left}px`;
      d.gap = el('li', 'rt-order-gap'); d.gap.style.height = `${d.rect.height}px`; d.gap.setAttribute('aria-hidden', 'true');
      d.row.before(d.gap); d.row.classList.add('rt-order-source');
      document.body.append(d.ghost);
    }
    position();
  }
  function stopAnimations(d) { for (const a of d.animations) a.cancel(); d.animations = []; }
  function visibleBounds(list) {
    const bounds = list.getBoundingClientRect();
    const visible = { left: Math.max(0, bounds.left), right: Math.min(innerWidth, bounds.right), top: Math.max(0, bounds.top), bottom: Math.min(innerHeight, bounds.bottom) };
    for (let parent = list.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), r = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { visible.left = Math.max(visible.left, r.left); visible.right = Math.min(visible.right, r.right); }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { visible.top = Math.max(visible.top, r.top); visible.bottom = Math.min(visible.bottom, r.bottom); }
    }
    return visible;
  }
  function position() {
    const d = drag;
    if (!d?.active) return;
    const bounds = visibleBounds(d.list);
    d.valid = d.lastX >= bounds.left && d.lastX <= bounds.right && d.lastY >= bounds.top && d.lastY <= bounds.bottom;
    d.ghost.style.top = `${d.lastY - (d.y - d.rect.top)}px`;
    d.ghost.style.opacity = d.valid ? '1' : '.45';
    if (!d.valid) return;
    const rows = [...d.list.children].filter(e => e !== d.row && e !== d.gap);
    const top = d.list.getBoundingClientRect().top;
    const target = rows.find(e => d.lastY < top + e.offsetTop + e.offsetHeight / 2);
    let next = d.gap.nextElementSibling;
    if (next === d.row) next = next.nextElementSibling;
    if (next === (target ?? null)) return;
    const before = new Map(rows.map(e => [e, e.getBoundingClientRect().top]));
    stopAnimations(d);
    d.list.insertBefore(d.gap, target ?? null);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) for (const row of rows) {
      const dy = before.get(row) - row.getBoundingClientRect().top;
      if (dy) d.animations.push(row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' }));
    }
  }
  function tick() {
    const d = drag;
    if (!d) return;
    if (!d.row.isConnected || !d.list.getClientRects().length) { finish(false); return; }
    if (d.active) {
      let scroller = d.list.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      scroller ??= document.scrollingElement;
      const r = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom), edge = Math.min(56, (bottom - top) / 5);
      const bounds = d.list.getBoundingClientRect();
      if (d.lastX >= bounds.left && d.lastX <= bounds.right) {
        const delta = d.lastY < top + edge ? -10 : d.lastY > bottom - edge ? 10 : 0;
        if (delta) { scroller.scrollTop += delta; position(); }
      }
    }
    d.raf = requestAnimationFrame(tick);
  }
  function key(e) {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
  }
  function pointerUp(e) {
    if (drag?.pointer !== e.pointerId) return;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    position(); finish(true);
  }
  function cancel(e) { if (!e || e.type !== 'pointercancel' || e.pointerId === drag?.pointer) finish(false); }
  function finish(commit) {
    const d = drag;
    if (!d) return;
    drag = null;
    cancelAnimationFrame(d.raf); stopAnimations(d);
    document.removeEventListener('pointermove', pointerMove, true);
    document.removeEventListener('pointerup', pointerUp, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel);
    if (d.button.hasPointerCapture(d.pointer)) d.button.releasePointerCapture(d.pointer);
    let to = -1;
    if (d.active) {
      const ids = [...d.list.children].filter(e => e !== d.row).map(e => e === d.gap ? d.candidate : e.dataset.candidate);
      if (commit && d.valid && JSON.stringify(current(d.tier)) === JSON.stringify(d.original)) to = ids.indexOf(d.candidate);
      d.gap.remove(); d.ghost.remove(); d.row.classList.remove('rt-order-source');
      suppressClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressClick = false; }, 300);
      if (to >= 0) move(d.tier, d.candidate, to);
      else announce(t('routing.settings.orderCancelled'));
    }
    settled(d.active ? d.button.dataset.fk : '');
  }
  return { handle, get busy() { return Boolean(drag); }, cancel: () => finish(false) };
}
