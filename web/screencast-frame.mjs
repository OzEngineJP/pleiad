// 映像のフレームを <img> に描き、描き終えたら ack を返す部品（docs/inapp-browser.md「リモートから見る」）。
// エージェントの Chrome の窓の右パネル（web/chrome-panel.mjs）が使う。
// フレームは WS の screencast メッセージ（{ seq, data（JPEG の base64）, metadata }）。ホストは ack を受けるまで次を出さないので、
// 描き終えた（load）ときに onAck(seq) を呼ぶ。

import { containRect, pageMetadata, toPageCoords, toPageDelta } from './page-coords.mjs';
import { createPhoneInput } from './phone-input.mjs';
import { ensureBrowserControlStyles } from './chrome-control.mjs';
import { t } from './i18n.mjs';
import { menuTitle } from './link-menu.mjs';

/** 直近の時刻の列から fps（3 秒の窓） */
export function framesPerSecond(times, now) {
  const recent = times.filter(time => now - time <= 3000);
  return recent.length < 2 ? recent.length : Math.round(recent.length / 3 * 10) / 10;
}

/**
 * Direct input for unified video. The caller binds send(input) to its session and tab.
 * PC のマウスは、ドラッグをページの選択（リンク・画像はドラッグ）として送る。右クリックは手元のメニューを出し、
 * 選択のコピー・リンク・すべて選択をページの中身（Core の問い合わせ。読むだけ）で決める。
 * showMenu は web/client.mjs の右クリックメニュー、openLink はリンク先を開く頼み（Chrome のタブへ移す）。
 * viewOnly() が真の間（AI のタブ。引き継ぐまで）は、クリック・タップ・キー・ホイール・メニューをページへ送らず、人の操作にも数えない。
 * 触れたときは onBlocked() を呼ぶ（行の [引き継ぐ] を強調する）。拡大・移動（手元だけ）とカーソルの問い合わせは今までどおり（ADR 0320）。
 */
export function createScreencastInput({ surface, img, getFrame, send = () => {}, phone = false, onError = () => {}, showMenu = null, openLink = null, viewOnly = () => false, onBlocked = () => {} }) {
  ensureBrowserControlStyles();
  surface.classList.add('b2-input-surface'); surface.tabIndex = 0;
  img.draggable = false;
  let zoom = 1, panX = 0, panY = 0, keyboardPan = 0, pendingTap = null, tapTimer = null, lastTap = 0, lastTapPoint = null;
  let gesture = null, longTimer = null, pinch = null, alive = true;
  let clickStamp = 0, clickPoint = null, clickCount = 0, cursorTimer = null, cursorPoint = null;
  const pointers = new Map(), disposers = [];
  const metadata = () => pageMetadata(getFrame?.()?.metadata ?? {});   // CDP の入力と入力欄の位置はレイアウトの CSS px
  const rect = () => containRect(img.getBoundingClientRect(), { width: img.naturalWidth || metadata().deviceWidth, height: img.naturalHeight || metadata().deviceHeight });
  const coords = event => toPageCoords({ x: event.clientX, y: event.clientY }, rect(), metadata());
  const listen = (node, type, handler, options) => { node.addEventListener(type, handler, options); disposers.push(() => node.removeEventListener(type, handler, options)); };
  // 見るだけの間は、読むだけのカーソルの問い合わせのほかは送らない（送らずに、触れたことだけ知らせる）
  const blocked = value => { if (value?.type === 'cursor' || !viewOnly()) return false; onBlocked(); return true; };
  const transmit = value => alive ? (blocked(value) ? Promise.resolve(null) : Promise.resolve().then(() => send(value))) : Promise.reject(new Error('closed'));
  const dispatch = value => { transmit(value).catch(onError); };
  const flushTap = () => { clearTimeout(tapTimer); tapTimer = null; if (pendingTap) { const value = pendingTap; pendingTap = null; dispatch(value); } };
  const cancelTap = () => { clearTimeout(tapTimer); tapTimer = null; pendingTap = null; };
  const transform = () => { img.style.transformOrigin = '50% 50%'; img.style.transform = `translate(${panX}px,${panY + keyboardPan}px) scale(${zoom})`; };
  const phoneInput = createPhoneInput({ surface, phone, onError, getRect: rect, getKeyboardRect: () => { const box = rect(); return { ...box, top: box.top - keyboardPan }; }, getMetadata: metadata,
    send: value => { flushTap(); return transmit(value); }, onPan: offset => { keyboardPan = offset; transform(); }, onCopy: cut => copySelection(cut) });
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
    gesture = { id: event.pointerId, touch: event.pointerType === 'touch', x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, point, moved: false, long: false, dragging: false };
    if (phone) longTimer = setTimeout(() => { if (gesture && !gesture.moved) { gesture.long = true; if (!viewOnly()) ripple(event); } }, 480);
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
    // 長押しと、マウス・ペンのドラッグはページの選択（リンク・画像はドラッグ）。1 本指の移動はスクロール、拡大中は映像だけを動かす
    if (gesture.long || (!gesture.touch && zoom <= 1)) {
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
    if (viewOnly()) { onBlocked(); return; }   // 見るだけの映像のタップ・長押し・ダブルタップ。押した輪も出さない
    if (current.long) { dispatch({ type: 'context', ...point }); return; }
    if (phone && lastTap && event.timeStamp - lastTap < 280 && pendingTap && lastTapPoint && Math.hypot(event.clientX - lastTapPoint.x, event.clientY - lastTapPoint.y) < 24) {
      cancelTap(); lastTap = 0; zoom = zoom > 1 ? 1 : 2; panX = panY = 0; phoneInput?.blur(); transform(); return;
    }
    ripple(event); lastTap = event.timeStamp; lastTapPoint = { x: event.clientX, y: event.clientY };
    // Focus within this gesture, not after awaiting the remote tap.
    if (phoneInput && !phoneInput.beforeTap(point)) return;
    if (phone) { flushTap(); pendingTap = { type: 'tap', ...point }; tapTimer = setTimeout(flushTap, 280); }
    else {
      // 同じ場所の続けた押しは 2 回・3 回と数える（Chrome が語・行の選択に使う clickCount）
      const again = clickStamp && event.timeStamp - clickStamp < 500 && clickPoint && Math.hypot(event.clientX - clickPoint.x, event.clientY - clickPoint.y) < 24;
      clickStamp = event.timeStamp; clickPoint = { x: event.clientX, y: event.clientY }; clickCount = again ? Math.min(3, clickCount + 1) : 1;
      dispatch({ type: 'tap', clicks: clickCount, ...point });
    }
  };
  // スマホでは指を離した後の互換の mousedown が映像に入力を移し、ページの欄に重ねた入力（beforeTap で入れた）からキーボードが閉じる
  listen(surface, 'mousedown', event => { if (phone) event.preventDefault(); });
  listen(surface, 'pointerup', event => finish(event)); listen(surface, 'pointercancel', event => finish(event, true));
  listen(surface, 'wheel', event => { const point = coords(event); if (!point) return; event.preventDefault(); if (zoom > 1) { panX -= event.deltaX; panY -= event.deltaY; transform(); } else dispatch({ type: 'scroll', ...point, dx: toPageDelta(event.deltaX, rect(), metadata()), dy: toPageDelta(event.deltaY, rect(), metadata()) }); }, { passive: false });
  listen(surface, 'contextmenu', event => { const point = coords(event); if (!point) return; event.preventDefault();
    if (viewOnly()) { onBlocked(); return; }
    if (phone) { dispatch({ type: 'context', ...point }); return; }
    transmit({ type: 'menu', ...point }).then(result => pageMenu(event, result?.info)).catch(onError);
  });
  // 手元のクリップボードへ書く。失敗（権限・対応の無い端末）は押した人へだけ知らせる
  const writeClipboard = text => navigator.clipboard?.writeText ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
  const copyFailed = () => onError(new Error(t('browser.chromeWindow.menu.copyFailed')));
  /** 右クリックのメニュー。点の下のもの（選択・リンク・編集できるか）はページから読んだ結果で決める */
  function pageMenu(event, info) {
    if (!showMenu) return;
    const accel = /mac/i.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';
    const copyText = () => { if (info?.text) writeClipboard(info.text).then(ok => { if (!ok) copyFailed(); }); };
    const copyLink = () => writeClipboard(info.link).then(ok => { if (!ok) copyFailed(); });
    const items = [
      { label: t('browser.chromeWindow.menu.copy'), hint: `${accel}C`, disabled: !info?.text, onClick: copyText },
      // 切り取りは、コピーが通ってから消す（消せるのは編集できる欄の選択だけ）
      ...(info?.editable && info?.text ? [{ label: t('browser.chromeWindow.menu.cut'), hint: `${accel}X`, onClick: () => writeClipboard(info.text).then(ok => ok ? dispatch({ type: 'key', key: 'Backspace' }) : copyFailed()) }] : []),
      ...(info?.link ? [{ sep: true },
        { label: t('browser.chromeWindow.menu.copyLink'), onClick: copyLink },
        { label: t('browser.chromeWindow.menu.openLink'), onClick: () => openLink?.(info.link) }] : []),
      { sep: true },
      { label: t('browser.chromeWindow.menu.selectAll'), hint: `${accel}A`, onClick: () => dispatch({ type: 'key', key: 'a', modifiers: ['accel'] }) },
    ];
    showMenu(event.clientX, event.clientY, items, info?.link ? menuTitle(info.link) : undefined);
  }
  /** ページの選択を手元のクリップボードへ。cut は書けたときだけ、選択を消すキーを送る */
  function copySelection(cut) {
    transmit({ type: 'copy' }).then(result => {
      const info = result?.info;
      if (!info?.text || (cut && !info.editable)) return;
      writeClipboard(info.text).then(ok => {
        if (!ok) { copyFailed(); return; }
        if (cut) dispatch({ type: 'key', key: 'Backspace' });
      });
    }).catch(onError);
  }
  listen(surface, 'keydown', event => {
    if (phone || event.target !== surface || event.altKey || event.isComposing) return;
    const accel = event.ctrlKey || event.metaKey;
    if (viewOnly()) {
      // 見るだけの間は、Tab で [引き継ぐ] へ移れるよう何も奪わない。文字・矢印などを打ったときだけ強調する
      if (!accel && event.key !== 'Tab' && event.key !== 'Escape' && (event.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))) { event.preventDefault(); onBlocked(); }
      return;
    }
    if (accel) {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === 'a' || key === 'c' || key === 'x') {
        event.preventDefault();   // 手元の select-all・copy・cut イベントを抑える（重なった欄の印が手元のクリップボードへ入らない）
        if (key === 'a') dispatch({ type: 'key', key: 'a', modifiers: ['accel'] });
        else copySelection(key === 'x');
      }
      // ほかの Ctrl/⌘+キー・V（paste イベントが引き受ける）は送らない。端末の操作として扱わない
      return;
    }
    const modifiers = event.shiftKey ? ['shift'] : null;
    if (event.key.length === 1) { event.preventDefault(); dispatch({ type: 'text', text: event.key }); }
    else if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); dispatch({ type: 'key', key: event.key, ...(modifiers ? { modifiers } : {}) }); }
  });
  listen(surface, 'paste', event => { if (event.target !== surface) return; if (viewOnly()) { event.preventDefault(); onBlocked(); return; } const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); dispatch({ type: 'text', text: text.slice(0, 2000) }); } });
  // 点の下のもののカーソルを遠隔のページへ聞いて合わせる。読むだけ（人の操作にしない）。押している間・スマホでは聞かない
  const applyCursor = name => { surface.style.cursor = img.style.cursor = typeof name === 'string' && /^[a-z-]+$/i.test(name) ? name : 'auto'; };
  const askCursor = () => {
    cursorTimer = null;
    const point = cursorPoint; cursorPoint = null;
    if (!point) return;
    transmit({ type: 'cursor', ...point }).then(result => applyCursor(result?.info?.cursor)).catch(() => {});
  };
  listen(surface, 'pointermove', event => {
    if (phone || event.pointerType !== 'mouse' || pointers.size) return;
    cursorPoint = coords(event);
    if (cursorPoint && !cursorTimer) cursorTimer = setTimeout(askCursor, 90);
  });
  listen(surface, 'pointerleave', () => { cursorPoint = null; applyCursor('auto'); });
  return { phoneInput, receive(message) { phoneInput?.receive(message); },
    reset() { cancelTap(); clearTimeout(longTimer); clearTimeout(cursorTimer); cursorTimer = cursorPoint = null; pointers.clear(); gesture = pinch = null; clickStamp = clickCount = 0; clickPoint = null; zoom = 1; panX = panY = keyboardPan = 0; applyCursor('auto'); transform(); phoneInput?.reset(); },
    destroy() { alive = false; cancelTap(); clearTimeout(longTimer); clearTimeout(cursorTimer); for (const dispose of disposers) dispose(); phoneInput?.destroy(); surface.classList.remove('b2-input-surface'); img.style.transform = ''; },
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
