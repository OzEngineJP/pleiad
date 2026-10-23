// 狭い画面の脇のスワイプ（docs/design-system.md「狭い画面・タッチ」、ADR 0262）。
// 判定は DOM から分け、確定とアクセシビリティの後始末は既存の setDrawer に任せる。
export function outsideGestureEdges(x, y, width, height, insets = {}) {
  return x >= Math.max(24, Number(insets.left) || 0)
    && x <= width - Math.max(24, Number(insets.right) || 0)
    && y <= height - Math.max(28, Number(insets.bottom) || 0);
}

export function createDrawerGesture({ x, y, time, width, open }) {
  let active = false, rejected = false, position = open ? width : 0;
  let samples = [{ x, time }], lastMove = time, lastX = x;
  return {
    get active() { return active; },
    move(nextX, nextY, now) {
      if (rejected) return null;
      const dx = nextX - x, dy = nextY - y;
      if (!active) {
        if (Math.abs(dy) >= 10) { rejected = true; return null; }
        if (Math.abs(dx) < 12) return null;
        if (Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
        if (open ? dx > 0 : dx < 0) { rejected = true; return null; }
        active = true;
      }
      if (nextX !== lastX) { lastMove = now; lastX = nextX; }
      samples.push({ x: nextX, time: now });
      samples = samples.filter(p => now - p.time <= 100);
      position = Math.max(0, Math.min(width, (open ? width : 0) + dx));
      return position / width;
    },
    finish(now, cancel = false) {
      if (cancel || !active) return open;
      const recent = samples.filter(p => now - p.time <= 100);
      const first = recent[0], last = recent.at(-1);
      const velocity = now - lastMove < 100 && last?.time > first?.time
        ? (last.x - first.x) / (last.time - first.time) : 0;
      if (velocity >= 0.5) return true;
      if (velocity <= -0.5) return false;
      return position / width >= 0.45;
    },
  };
}

export function excludedDrawerTarget(target, { open, boundary, style = getComputedStyle }) {
  for (let n = target; n && n !== boundary; n = n.parentElement) {
    if (n.matches('pre,table,iframe,input,textarea,select,a,[contenteditable]:not([contenteditable="false"]),[data-no-drawer-swipe],.tc-term,[role="tablist"]')
      || n.isContentEditable || (!open && n.matches('button,summary,[role="button"],[draggable="true"]'))) return true;
    const css = style(n);
    if (css.touchAction === 'none' || (n.scrollWidth > n.clientWidth + 1 && /^(auto|scroll)$/.test(css.overflowX))) return true;
  }
  return false;
}

export function drawerBlockingOverlay(doc) {
  return [...doc.querySelectorAll('dialog[open], .pop')].some(n => n.getClientRects().length && doc.defaultView.getComputedStyle(n).visibility !== 'hidden');
}

export function setupDrawerSwipe({ doc = document, sidebar, veil, narrowView, isOpen, setDrawer }) {
  const root = doc.documentElement, win = doc.defaultView;
  let drag = null, suppressUntil = 0;
  const allowed = () => narrowView.matches && !doc.body.classList.contains('settings');
  const selection = () => Boolean(win.getSelection()?.toString());
  function clearVisuals() {
    root.classList.remove('side-dragging');
    sidebar.style.removeProperty('transform');
    veil.style.removeProperty('opacity');
  }
  function finish(cancel = false) {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.gesture.active) {
      // 描かれた追従位置を遷移の始点にしてから、通常の開閉へ戻す。
      sidebar.getBoundingClientRect();
      root.classList.remove('side-dragging');
      setDrawer(d.gesture.finish(win.performance.now(), cancel));
      clearVisuals();
      suppressUntil = win.performance.now() + 350;
    }
    if (root.hasPointerCapture(d.id)) root.releasePointerCapture(d.id);
  }
  root.addEventListener('pointerdown', e => {
    suppressUntil = 0;
    if (drag || !allowed() || e.pointerType !== 'touch' || !e.isPrimary || e.button !== 0 || e.defaultPrevented || selection()) return;
    const open = isOpen();
    if (!(open ? sidebar.contains(e.target) || veil.contains(e.target) : e.target.closest('main'))) return;
    if (drawerBlockingOverlay(doc) || excludedDrawerTarget(e.target, { open, boundary: root })) return;
    if (!outsideGestureEdges(e.clientX, e.clientY, win.innerWidth, win.innerHeight, win.plyRemote?.gestureInsets?.())) return;
    const width = sidebar.getBoundingClientRect().width;
    drag = { id: e.pointerId, width, gesture: createDrawerGesture({ x: e.clientX, y: e.clientY, time: win.performance.now(), width, open }) };
  });
  root.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!allowed() || e.defaultPrevented || selection()) return finish(true);
    const progress = drag.gesture.move(e.clientX, e.clientY, win.performance.now());
    if (progress === null) return;
    if (!root.hasPointerCapture(e.pointerId)) root.setPointerCapture(e.pointerId);
    root.classList.add('side-dragging');
    sidebar.style.transform = `translateX(${(progress - 1) * drag.width}px)`;
    veil.style.opacity = String(progress);
  });
  // touch-action は auto のまま。横の意図が確定した操作だけ既定のパンを止める。
  // スクロールする祖先に pan-y を置くと、子のコード・表の横スクロールまで奪ってしまう。
  root.addEventListener('touchmove', e => {
    if (drag?.gesture.active && e.touches.length === 1 && e.cancelable) e.preventDefault();
  }, { passive: false });
  root.addEventListener('pointerup', e => { if (drag?.id === e.pointerId) finish(); });
  root.addEventListener('pointercancel', e => { if (drag?.id === e.pointerId) finish(true); });
  root.addEventListener('lostpointercapture', e => { if (e.target === root && drag?.id === e.pointerId) finish(true); });
  root.addEventListener('click', e => {
    if (win.performance.now() >= suppressUntil) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  // 長押しのメニューや先に成立したドラッグから横取りしない。
  for (const type of ['contextmenu', 'dragstart']) root.addEventListener(type, () => finish(true), true);
  win.addEventListener('blur', () => finish(true));
  win.addEventListener('resize', () => finish(true));
  // 幅変更時の setDrawer と同じリスナー内から呼ぶ。設定・ボタンによる開閉にも追従を残さない。
  return { cancel: () => finish(true) };
}
