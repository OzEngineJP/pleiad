import { isComposingKey } from './keyboard.mjs';

// The first outside gesture belongs to dismissal, including its later click.
export function dismissPopup({ doc = document, isOpen, surfaces, opener, close,
  outside = () => true, escape = null }) {
  const target = () => typeof opener === 'function' ? opener() : opener;
  const finish = () => { close(); target()?.focus({ preventScroll: true }); };
  let swallowClick = false, disposed = false;
  const consume = e => { e.preventDefault?.(); e.stopImmediatePropagation?.(); };
  const pointer = e => {
    swallowClick = false;
    if (disposed) { detach(); return; }
    if (!isOpen()) return;
    const path = e.composedPath?.() ?? [];
    const hit = node => node && (path.includes(node) || node.contains?.(e.target));
    const anchor = target();
    if (surfaces().some(hit) || (anchor !== doc.body && anchor !== doc.documentElement && hit(anchor)) || !outside()) return;
    consume(e); swallowClick = true; finish();
  };
  const click = e => {
    if (!swallowClick) return;
    swallowClick = false; consume(e);
    if (disposed) detach();
  };
  const up = e => { if (swallowClick) consume(e); };
  const key = e => {
    if (!isOpen() || e.key !== 'Escape' || isComposingKey(e)) return;
    consume(e);
    if (!escape || escape(e) !== false) finish();
  };
  doc.addEventListener('pointerdown', pointer, true);
  doc.addEventListener('click', click, true);
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('keydown', key, true);
  function detach() {
    doc.removeEventListener('pointerdown', pointer, true);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('pointerup', up, true);
  }
  return () => {
    disposed = true;
    if (!swallowClick) detach();
    doc.removeEventListener('keydown', key, true);
  };
}
