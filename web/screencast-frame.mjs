// 映像のフレームを <img> に描き、描き終えたら ack を返す部品（docs/inapp-browser.md「リモートから見る」）。
// 右パネルの「ブラウザー」の映像（web/remote-browser.mjs）とエージェントの Chrome の窓の右パネル（web/chrome-panel.mjs）が共有する。
// フレームは WS の screencast メッセージ（{ seq, data（JPEG の base64）, metadata }）。ホストは ack を受けるまで次を出さないので、
// 描き終えた（load）ときに onAck(seq) を呼ぶ。

import { containRect, toPageCoords, toPageDelta } from './page-coords.mjs';
import { createPhoneInput } from './phone-input.mjs';
import { ensureBrowserControlStyles } from './chrome-control.mjs';

/** 直近の時刻の列から fps（3 秒の窓） */
export function framesPerSecond(times, now) {
  const recent = times.filter(time => now - time <= 3000);
  return recent.length < 2 ? recent.length : Math.round(recent.length / 3 * 10) / 10;
}

/** Direct input for unified video. The caller binds send(input) to its session and tab. */
export function createScreencastInput({ surface, img, getFrame, send = () => {}, phone = false, onError = () => {} }) {
  ensureBrowserControlStyles();
  surface.classList.add('b2-input-surface'); surface.tabIndex = 0;
  img.draggable = false;
  let zoom = 1, panX = 0, panY = 0, keyboardPan = 0, pendingTap = null, tapTimer = null, lastTap = 0, lastTapPoint = null;
  let gesture = null, longTimer = null, pinch = null, alive = true;
  const pointers = new Map(), disposers = [];
  // Mobile pages without a viewport meta are painted at a page scale below one.
  // CDP input and field rectangles still use layout CSS pixels.
  const metadata = () => { const value = getFrame?.()?.metadata ?? {}, scale = value.pageScaleFactor > 0 ? value.pageScaleFactor : 1;
    return { ...value, deviceWidth: value.deviceWidth / scale, deviceHeight: value.deviceHeight / scale, offsetTop: (value.offsetTop || 0) / scale }; };
  const rect = () => containRect(img.getBoundingClientRect(), { width: img.naturalWidth || metadata().deviceWidth, height: img.naturalHeight || metadata().deviceHeight });
  const coords = event => toPageCoords({ x: event.clientX, y: event.clientY }, rect(), metadata());
  const listen = (node, type, handler, options) => { node.addEventListener(type, handler, options); disposers.push(() => node.removeEventListener(type, handler, options)); };
  const transmit = value => alive ? Promise.resolve().then(() => send(value)) : Promise.reject(new Error('closed'));
  const dispatch = value => { transmit(value).catch(onError); };
  const flushTap = () => { clearTimeout(tapTimer); tapTimer = null; if (pendingTap) { const value = pendingTap; pendingTap = null; dispatch(value); } };
  const cancelTap = () => { clearTimeout(tapTimer); tapTimer = null; pendingTap = null; };
  const transform = () => { img.style.transformOrigin = '50% 50%'; img.style.transform = `translate(${panX}px,${panY + keyboardPan}px) scale(${zoom})`; };
  const phoneInput = createPhoneInput({ surface, phone, onError, getRect: rect, getKeyboardRect: () => { const box = rect(); return { ...box, top: box.top - keyboardPan }; }, getMetadata: metadata,
    send: value => { flushTap(); return transmit(value); }, onPan: offset => { keyboardPan = offset; transform(); } });
  function ripple(event) {
    const box = surface.getBoundingClientRect(), ring = document.createElement('span'); ring.className = 'b2-ripple'; ring.style.left = `${event.clientX - box.left}px`; ring.style.top = `${event.clientY - box.top}px`;
    surface.append(ring); setTimeout(() => ring.remove(), 600);
  }
  listen(surface, 'pointerdown', event => {
    if (event.target !== surface && event.target !== img) return;
    if (event.button !== 0) return;
    const point = coords(event); if (!point) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); surface.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      clearTimeout(longTimer); cancelTap(); phoneInput?.blur();
      const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, panX, panY }; gesture = null; return;
    }
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, point, moved: false, long: false, dragging: false };
    if (phone) longTimer = setTimeout(() => { if (gesture && !gesture.moved) { gesture.long = true; ripple(event); } }, 480);
    if (!phone) surface.focus({ preventScroll: true });
  });
  listen(surface, 'pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()]; zoom = Math.min(3, Math.max(1, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance)));
      panX = pinch.panX + (a.x + b.x) / 2 - pinch.x; panY = pinch.panY + (a.y + b.y) / 2 - pinch.y; transform(); return;
    }
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.lastX, dy = event.clientY - gesture.lastY;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) { gesture.moved = true; clearTimeout(longTimer); cancelTap(); }
    if (!gesture.moved) return;
    const point = coords(event); if (!point) return;
    if (gesture.long) {
      if (!gesture.dragging) { gesture.dragging = true; dispatch({ type: 'drag', phase: 'start', ...gesture.point }); }
      dispatch({ type: 'drag', phase: 'move', ...point });
    } else if (zoom > 1) { panX += dx; panY += dy; transform(); }
    else dispatch({ type: 'scroll', ...point, dx: -toPageDelta(dx, rect(), metadata()), dy: -toPageDelta(dy, rect(), metadata()) });
    gesture.lastX = event.clientX; gesture.lastY = event.clientY;
  });
  const finish = (event, cancelled = false) => {
    pointers.delete(event.pointerId); clearTimeout(longTimer);
    if (pinch) { if (!pointers.size) pinch = null; return; }
    const current = gesture; gesture = null;
    if (!current || current.id !== event.pointerId) return;
    if (current.dragging) { dispatch({ type: 'drag', phase: 'end', ...(coords(event) ?? current.point) }); return; }
    if (cancelled || current.moved) return;
    const point = coords(event); if (!point) return;
    if (current.long) { dispatch({ type: 'context', ...point }); return; }
    if (phone && lastTap && event.timeStamp - lastTap < 280 && pendingTap && lastTapPoint && Math.hypot(event.clientX - lastTapPoint.x, event.clientY - lastTapPoint.y) < 24) {
      cancelTap(); lastTap = 0; zoom = zoom > 1 ? 1 : 2; panX = panY = 0; phoneInput?.blur(); transform(); return;
    }
    ripple(event); lastTap = event.timeStamp; lastTapPoint = { x: event.clientX, y: event.clientY };
    // Focus within this gesture, not after awaiting the remote tap.
    if (phoneInput && !phoneInput.beforeTap(point)) return;
    if (phone) { flushTap(); pendingTap = { type: 'tap', ...point }; tapTimer = setTimeout(flushTap, 280); }
    else dispatch({ type: 'tap', ...point });
  };
  listen(surface, 'pointerup', event => finish(event)); listen(surface, 'pointercancel', event => finish(event, true));
  listen(surface, 'wheel', event => { const point = coords(event); if (!point) return; event.preventDefault(); if (zoom > 1) { panX -= event.deltaX; panY -= event.deltaY; transform(); } else dispatch({ type: 'scroll', ...point, dx: toPageDelta(event.deltaX, rect(), metadata()), dy: toPageDelta(event.deltaY, rect(), metadata()) }); }, { passive: false });
  listen(surface, 'contextmenu', event => { const point = coords(event); if (!point) return; event.preventDefault(); if (!phone) dispatch({ type: 'context', ...point }); });
  listen(surface, 'keydown', event => {
    if (phone || event.target !== surface || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key.length === 1) { event.preventDefault(); dispatch({ type: 'text', text: event.key }); }
    else if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); dispatch({ type: 'key', key: event.key }); }
  });
  listen(surface, 'paste', event => { if (event.target !== surface) return; const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); dispatch({ type: 'text', text: text.slice(0, 2000) }); } });
  return { phoneInput, receive(message) { phoneInput?.receive(message); },
    reset() { cancelTap(); clearTimeout(longTimer); pointers.clear(); gesture = pinch = null; zoom = 1; panX = panY = keyboardPan = 0; transform(); phoneInput?.reset(); },
    destroy() { alive = false; cancelTap(); clearTimeout(longTimer); for (const dispose of disposers) dispose(); phoneInput?.destroy(); surface.classList.remove('b2-input-surface'); img.style.transform = ''; },
    get zoom() { return zoom; } };
}

/**
 * @param img     フレームを描く <img>
 * @param onAck   描き終えた seq で呼ぶ
 * @param onMark  印（type: 'mark'）が届いた seq で呼ぶ（すぐ返事を返す。ホストは印とフレームの返事の差で中身を運ぶ時間を測る）
 * @param now     時刻（ms）。テストで差し替える
 */
export function createFrameSink({ img, onAck = () => {}, onMark = () => {}, now = () => performance.now() }) {
  let frame = null, times = [];
  img.addEventListener('load', () => {
    const seq = img.dataset.seq;
    if (seq) onAck(Number(seq));
  });
  return {
    /** メッセージを描く。フレームなら <img> へ、印ならそのまま返事へ */
    push(message) {
      if (message?.type === 'mark') { onMark(Number(message.seq)); return; }
      frame = { seq: message.seq, metadata: message.metadata ?? {} };
      times.push(now()); if (times.length > 40) times.shift();
      img.dataset.seq = String(message.seq);
      img.src = `data:image/jpeg;base64,${message.data}`;
    },
    /** 絵を捨てる（別の会話・閉じた・窓が替わった） */
    reset() { frame = null; times = []; img.removeAttribute('src'); delete img.dataset.seq; },
    get frame() { return frame; },
    fps() { return framesPerSecond(times, now()); },
  };
}
