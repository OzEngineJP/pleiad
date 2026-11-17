// 状態から作った HTML へ、変わった所だけ差し替える（残るノードは作り直さない。CSS の transition・フォーカス・打ちかけの文字が続く）。
// 動きの値は web/tokens.css のトークンだけ（--dur / --ease-out / --dur-slow / --ease-organic）。
// 減らす動き設定ではトークンが 0ms になり、動かさずに差し替える。
//
// 目印: data-k=キー（同じキーのノードを引き継ぐ）/ data-slot=キー（中身が出る・変わる・消えるとき、高さが追う）/
//       data-t（文字が変わったら淡く入れ替える）/ data-in（新しく入るとき下から入る）。
// 属性 style・open・inert は触らない（動きの途中の値を壊さない）。
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/** トークン（--dur など）の長さ（ミリ秒）。減らす動き設定では 0 */
export const ms = n => { const v = cssv(n); return v.endsWith('ms') ? parseFloat(v) : (parseFloat(v) * 1000 || 0); };
// slot は余白（フォーカスの輪の分）を持ったまま畳む
const padOf = o => { const c = getComputedStyle(o); return parseFloat(c.paddingTop) + parseFloat(c.paddingBottom); };

function enter(x) { const d = ms('--dur'); if (d) x.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: d, easing: cssv('--ease-out') }); }
function fade(x) { const d = ms('--dur'); if (d) x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing: cssv('--ease-out') }); }
/** 行の背景を一瞬だけ選択色にして戻す（登録・ログインが済んだ行） */
export function flash(x) { const d = ms('--dur-slow'); if (d) x.animate([{ backgroundColor: cssv('--surface-sel') }, { backgroundColor: 'transparent' }], { duration: d, easing: cssv('--ease-organic') }); }

const SKIP = new Set(['style', 'open', 'inert']);
const keyOf = c => c.nodeType === 1 ? (c.dataset.k ?? (c.dataset.slot != null ? '§' + c.dataset.slot : null)) : null;

/** root の中身を html に合わせる */
export function patch(root, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  kids(root, tpl.content, false);
}

function kids(o, n, entering) {
  const olds = [...o.childNodes], used = new Set(), byKey = new Map();
  for (const c of olds) { const k = keyOf(c); if (k != null && !byKey.has(k)) byKey.set(k, c); }
  const plain = olds.filter(c => keyOf(c) == null);
  let pi = 0;
  const pairs = [...n.childNodes].map(c => {
    const k = keyOf(c); let m = null;
    if (k != null) { const x = byKey.get(k); if (x && x.nodeName === c.nodeName && !used.has(x)) m = x; }
    else { const x = plain[pi]; if (x && x.nodeType === c.nodeType && x.nodeName === c.nodeName) { m = x; pi++; } }
    if (m) used.add(m);
    return [c, m];
  });
  for (const c of olds) if (!used.has(c)) c.remove();
  let cur = o.firstChild;
  for (const [c, m] of pairs) {
    if (m) {
      if (m !== cur) o.insertBefore(m, cur); else cur = cur.nextSibling;
      if (c.nodeType === 1) sync(m, c); else if (m.data !== c.data) m.data = c.data;
    } else {
      const x = document.importNode(c, true);
      o.insertBefore(x, cur);
      if (x.nodeType === 1 && (entering || x.dataset.in != null)) enter(x);
    }
  }
}

function sync(o, n) {
  if (o.dataset.slot != null) { attrs(o, n); slot(o, n); return; }
  const before = o.dataset.t != null ? o.textContent : null;
  attrs(o, n);
  kids(o, n, false);
  if (before != null && o.textContent !== before) fade(o);
}

function attrs(o, n) {
  for (const a of [...o.attributes]) if (!SKIP.has(a.name) && !n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (!SKIP.has(a.name) && o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  // 入力欄の値は、HTML の value が変わったときだけ入れ直す（打ちかけの文字を残す）
  if (o.nodeName === 'INPUT' && n.hasAttribute('value') && o._v !== n.getAttribute('value')) { o._v = n.getAttribute('value'); o.value = o._v; }
}

/** slot: 中身が出る・変わる・消えるとき、高さと透明度が追う。動きの途中の高さから続けるので、続けて押しても跳ばない */
function slot(o, n) {
  const empty = !n.childNodes.length;
  if (empty && !o.childNodes.length) return;
  const d = ms('--dur'), ease = cssv('--ease-out'), h0 = o.getBoundingClientRect().height;
  if (empty) {
    if (o._leaving) return;
    o._ha?.cancel();
    if (!d) { o.replaceChildren(); o.style.overflow = ''; return; }
    o._leaving = true; o.inert = true; o.style.overflow = 'hidden';
    const a = o._ha = o.animate([{ height: h0 + 'px', opacity: 1 }, { height: padOf(o) + 'px', opacity: 0 }], { duration: d, easing: ease });
    a.onfinish = () => { if (o._ha !== a) return; o.replaceChildren(); o.style.overflow = ''; o.inert = false; o._leaving = false; o._ha = null; };
    return;
  }
  const op0 = o._leaving ? parseFloat(getComputedStyle(o).opacity) : 1;
  if (o._leaving) { o._leaving = false; o.inert = false; }
  o._ha?.cancel(); o._ha = null; o.style.overflow = '';
  kids(o, n, true);
  const h1 = o.getBoundingClientRect().height;
  if (d && (Math.abs(h1 - h0) > .5 || op0 < 1)) {
    o.style.overflow = 'hidden';
    const a = o._ha = o.animate([{ height: h0 + 'px', opacity: op0 }, { height: h1 + 'px', opacity: 1 }], { duration: d, easing: ease });
    a.onfinish = () => { if (o._ha !== a) return; o.style.overflow = ''; o._ha = null; };
  }
}
