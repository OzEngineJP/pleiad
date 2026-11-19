import { dismissPopup } from './dismiss-popup.mjs';
// 会話の ToDo のパネル（承認済み 2026-11-19。モック temporary/mockups/session-todo.html の createTodo・createFrame を移したもの。ADR 0342）。
// - 頭の ToDo の入口（PC）・⋮ のメニュー（700px 以下）から開く。PC は浮く面、狭い画面は下からのシート。大きく表示できる
// - 普段は見るだけ（完了の印は押せない）。鉛筆で編集の状態へ入り、「編集を終了」か Esc で戻る
// - 依存が無ければリスト、枝分かれ・合流があれば自動でフロー（つかんで動かす・拡大縮小）。手でリストへ戻せる
// - 書き換えは todos.* の操作（ifRev 付き）だけ。返った一覧をそのまま映す。AI の変更は todosChanged で届き、
//   見ている間は 1.2 秒光らせて「Claude が完了」などの印を出す。閉じている間は入口に未確認の点を出す
// 計算（配置・依存の正規化）は web/session-todo-model.mjs
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { reducedMotion, solveSpring, springPreset } from './motion.mjs';
import { expandIcon, collapseIcon, linkIcon, chevRightIcon, moreIcon } from './icons.mjs';
import {
  isFlowGraph, materialize, normalizeAfter, reaches, kindOf, leaves, changesFor,
  layoutList, layoutFlow, linkParts, linkInput, afterMap,
} from './session-todo-model.mjs';

/* ---- 動き: web/motion.mjs のばね（smooth・snappy）を 0→1 の進みにして、1 本の rAF で回す ---- */
const progress = (name) => { const pr = springPreset(name); return (s) => 1 - solveSpring(pr, 1, 0, s)[0]; };
let SPR = null;
const spr = () => (SPR ??= { smooth: { p: progress('smooth'), dur: 0.7 }, snappy: { p: progress('snappy'), dur: 0.45 } });
const tweens = new Set();
let raf = 0;
function tick(now) {
  raf = 0;
  for (const tw of [...tweens]) {
    const s = (now - tw.t0) / 1000, done = s >= tw.spr.dur;
    tw.step(done ? 1 : tw.spr.p(Math.max(0, s)));
    if (done) { tweens.delete(tw); tw.end?.(); }
  }
  if (tweens.size) raf = requestAnimationFrame(tick);
}
function run(how, step, end) {
  if (!how || reducedMotion() || typeof requestAnimationFrame !== 'function') { step(1); end?.(); return null; }
  const tw = { t0: performance.now(), spr: how, step, end };
  tweens.add(tw);
  if (!raf) raf = requestAnimationFrame(tick);
  return tw;
}
const lerp = (a, b, p) => a + (b - a) * p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---- 印（静的な SVG の文字列だけを innerHTML で入れる） ---- */
const PENCIL = '<svg class="i" viewBox="0 0 16 16" style="stroke-width:1.1" aria-hidden="true"><path d="M10.5 2.8l2.7 2.7L5.5 13.2l-3.4.7.7-3.4z"/></svg>';
const GRIP = '<svg viewBox="0 0 12 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.1"/><circle cx="8" cy="3.5" r="1.1"/><circle cx="4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="4" cy="12.5" r="1.1"/><circle cx="8" cy="12.5" r="1.1"/></svg>';
const PORT = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5"/></svg>';
const KIND = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg>',
  dir: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  url: '<svg viewBox="0 0 16 16" style="stroke-width:1.1" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-1.8 1.8-1.8 10.2 0 12M8 2c1.8 1.8 1.8 10.2 0 12"/></svg>',
};
export const TODO_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7l2.2 2.2L9.5 5M13 7.5h7.5M3.5 16.5l2.2 2.2 3.8-4.2M13 17h7.5"/></svg>';
function markSvg(kind) {
  if (kind === 'done') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="ck-path" pathLength="1" d="M3.2 8.6l3.1 3.1 6.5-7.2"/></svg>';
  if (kind === 'doing') return '<svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12"/></svg>';
  if (kind === 'wait') return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="dotted" cx="8" cy="8" r="6"/></svg>';
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg>';
}
// i18n-dynamic: todo.status.
// i18n-dynamic: todo.view.
// i18n-dynamic: todo.links.kind.
// i18n-dynamic: todo.links.itemLabel
// i18n-dynamic: todo.links.missingLabel
const statusLabel = (kind) => t(`todo.status.${kind}`);

/* 大きさの定数（モックのとおり。狭い画面は指で押せる大きさ） */
const K_WIDE = Object.freeze({ NW: 164, NH: 58, GX: 12, GY: 32, ROW: 34, GAP: 2, EGAP: 4, MB: 40, MAPW: 84, MAPH: 64 });
const K_NARROW = Object.freeze({ NW: 156, NH: 84, GX: 10, GY: 32, ROW: 48, GAP: 2, EGAP: 6, MB: 56, MAPW: 64, MAPH: 56 });
const OX = 8, OY = 2, MX = 8, ZMIN = 0.25, ZMAX = 2;
/** AI の変更の印の文言（todo.by.*）。action は core/todos.mjs の changed */
const BY_KEY = { done: 'done', started: 'started', added: 'added', reopened: 'changed', moved: 'changed', updated: 'changed' };

/**
 * @param {object} o
 * @param {HTMLElement} o.host        パネルと幕を入れる面（body > main。position:relative）
 * @param {HTMLElement} o.header      会話の頭（パネルの上端をその下に合わせる）
 * @param {HTMLElement} o.entry       頭の ToDo の入口（PC）
 * @param {MediaQueryList} o.narrow   700px 以下
 * @param {(command: string, args: object) => Promise<any>} o.cmd
 * @param {(text: string) => void} [o.notify]
 * @param {(link: object) => void} o.openLink          成果物を開く（ファイル・フォルダーは Pleiad のページ、URL はブラウザー）
 * @param {(x: number, y: number, link: object, missing: boolean) => void} [o.linkMenu]  右クリックのメニュー
 * @param {(backend: string) => Node} [o.logo]          エージェントのロゴ
 * @param {(backend: string) => string} [o.labelOf]     エージェントの名前
 * @param {() => void} [o.onChange]   件数・未確認の点が変わった（⋮ の点と件数を描き直す）
 */
export function createSessionTodo(o) {
  const { host, header, entry, narrow } = o;
  const K = () => (narrow.matches ? K_NARROW : K_WIDE);

  /* ---- 枠（幕・面）---- */
  const veil = el('div', 'veil todo-veil');
  const root = el('div', 'pop todo-pop');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('todo.title'));
  root.hidden = true;
  host.append(veil, root);

  const grab = el('div', 'sheet-grab');
  const head = el('div', 'td-head');
  const ttl = el('div', 'td-ttl');
  const countEl = el('span', 'td-count');
  ttl.append(el('b', null, t('todo.title')), countEl);
  const seg = el('span', 'seg td-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('todo.view.label'));
  seg.hidden = true;
  for (const v of ['flow', 'list']) { const b = el('button', null, t(`todo.view.${v}`)); b.type = 'button'; b.dataset.v = v; seg.append(b); }
  const editBtn = el('button', 'td-edit');
  editBtn.type = 'button';
  const editIc = el('span', 'ic'); editIc.innerHTML = PENCIL;
  const editLb = el('span', 'lb'); const editLt = el('span', null, t('todo.editEnd')); editLb.append(editLt);
  editBtn.append(editIc, editLb);
  const maxBtn = el('button', 'td-hbtn td-max'); maxBtn.type = 'button';
  const closeBtn = el('button', 'td-hbtn td-close', '×'); closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('todo.close')); closeBtn.title = t('todo.close');
  head.append(ttl, el('span', 'sp'), seg, editBtn, maxBtn, closeBtn);

  const stage = el('div', 'td-stage');
  const body = el('div', 'td-body');
  const emptyEl = el('div', 'td-empty');
  const emptyAdd = el('button', null, t('todo.add')); emptyAdd.type = 'button';
  emptyEl.append(el('div', null, t('todo.empty')), emptyAdd);
  const canvas = el('div', 'td-canvas');
  canvas.setAttribute('role', 'list');
  const svg = svgEl('svg', { class: 'td-edges', 'aria-hidden': 'true' });
  canvas.append(svg);
  body.append(emptyEl, canvas);
  const foldBtn = el('button', 'td-fold', t('todo.fold')); foldBtn.type = 'button'; foldBtn.hidden = true;
  // フローの下端の帯: 拡大縮小と位置の手がかりを、中身の上に重ねず不透明な帯に入れる（モックの重なりを直した形）
  const bar = el('div', 'td-bar');
  const mapEl = el('div', 'td-map'); mapEl.setAttribute('aria-hidden', 'true');
  const zoom = el('div', 'td-zoom'); zoom.setAttribute('role', 'group'); zoom.setAttribute('aria-label', t('todo.zoom.label'));
  const zOut = el('button', 'z-out', '−'); zOut.type = 'button'; zOut.setAttribute('aria-label', t('todo.zoom.out')); zOut.title = t('todo.zoom.outTitle');
  const zIn = el('button', 'z-in', '＋'); zIn.type = 'button'; zIn.setAttribute('aria-label', t('todo.zoom.in')); zIn.title = t('todo.zoom.inTitle');
  const zFit = el('button', 'z-fit', t('todo.zoom.fit')); zFit.type = 'button'; zFit.title = t('todo.zoom.fitTitle');
  zoom.append(zOut, zIn, zFit);
  bar.append(mapEl, zoom);
  stage.append(body, foldBtn, bar);
  const addWrap = el('div', 'td-addwrap');
  const addClip = el('div', 'td-addclip'); addClip.inert = true;
  const addForm = el('form', 'td-add');
  const addInput = el('input', 'field');
  addInput.type = 'text'; addInput.placeholder = t('todo.add'); addInput.setAttribute('aria-label', t('todo.add')); addInput.autocomplete = 'off';
  addForm.append(addInput); addClip.append(addForm); addWrap.append(addClip);
  root.append(grab, head, stage, addWrap);
  root.dataset.mode = 'view';

  /* ---- 状態 ---- */
  const S = { session: null, rev: -1, items: [], flow: false, view: 'auto', expand: false, L: null, loading: 0 };
  const badges = new Map();       // id → { text, backend }（AI が変えた印。パネルを閉じるまで）
  const unseen = new Set();       // 閉じている間に AI が変えた id（開いたときに光らせる）
  let tw = null, vtw = null, Vgoal = null, drive = false, Wover = null, menu = null, isMax = false, edit = false, rename = null, skipClick = false;
  let isOpen = false, busy = false;
  const V = { x: 0, y: 0, z: 1, mode: 'home' };
  const els = new Map(), edgeEls = new Map();
  let stackEl = null, mapBox = null, mapOn = false;

  const byId = (id) => S.items.find((i) => i.id === id);
  const flowView = () => S.flow && S.view !== 'list';
  const deps = () => materialize(S.items, S.flow);
  const depsOf = (id) => deps().get(id) ?? [];
  const MB = () => (flowView() ? (mapOn ? Math.max(K().MB, K().MAPH + 12) : K().MB) : 0);

  /* ---- 行・箱の要素 ---- */
  function itemEl(cls) {
    const node = el('div', cls);
    const grip = el('span', 'td-grip'); grip.setAttribute('aria-hidden', 'true'); grip.innerHTML = GRIP;
    const mark = el('button', 'td-mark'); mark.type = 'button'; mark.setAttribute('role', 'checkbox');
    const text = el('span', 'td-text');
    const foot = el('span', 'td-foot'); foot.hidden = true;
    const by = el('span', 'td-by'); by.setAttribute('role', 'img'); by.hidden = true;
    const byLogo = el('span', 'td-logo'), byText = el('span');
    by.append(byLogo, byText);
    const badge = el('button', 'td-badge'); badge.type = 'button'; badge.hidden = true;
    badge.setAttribute('aria-haspopup', 'dialog'); badge.setAttribute('aria-expanded', 'false');
    badge.innerHTML = linkIcon;
    const badgeN = el('span'); badge.append(badgeN);
    foot.append(by, badge);
    const more = el('button', 'td-more'); more.type = 'button'; more.innerHTML = moreIcon;
    more.setAttribute('aria-label', t('todo.more')); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    const port = el('span', 'td-port'); port.setAttribute('aria-hidden', 'true'); port.innerHTML = PORT;
    node.append(grip, mark, text, foot, more, port);
    node._p = { mark, text, foot, by, byLogo, byText, badge, badgeN, more };
    return node;
  }
  const meas = itemEl('td-item td-meas');
  meas.setAttribute('aria-hidden', 'true'); meas.inert = true;
  // 高さ 0 の箱で包む（1 件も無いとき、見えない測り役が面の下にはみ出してスクロールバーを出さない。offsetHeight は切られても測れる）
  const measBox = el('div', 'td-meas-box'); measBox.append(meas); canvas.append(measBox);
  const byText = (id) => badges.get(id)?.text ?? '';
  function fillFoot(p, it) {
    const n = it.links.length, b = badges.get(it.id), bt = b?.text ?? '';
    p.by.hidden = !bt; p.byText.textContent = bt;
    if (b && p.byLogo._be !== b.backend) { p.byLogo._be = b.backend; p.byLogo.replaceChildren(...(b.backend && o.logo ? [o.logo(b.backend)] : [])); }
    p.badge.hidden = !n; p.badgeN.textContent = n > 99 ? '99+' : String(n);
    p.foot.hidden = !bt && !n;
  }
  function rowH(it, W) {
    meas.style.width = `${W}px`; meas._p.text.textContent = it.text; fillFoot(meas._p, it);
    return Math.max(K().ROW, meas.offsetHeight);
  }
  const gapNow = () => (edit ? K().EGAP : K().GAP);
  const layout = (W) => (flowView() ? layoutFlow(S.items, deps(), W, K(), S.expand) : layoutList(S.items, W, rowH, gapNow()));
  function setRect(node, r) {
    node._r = r;
    node.style.transform = `translate(${r.x}px,${r.y}px)`;
    node.style.width = `${r.w}px`; node.style.height = `${r.h}px`;
    node.style.opacity = r.o < 1 ? String(r.o) : '';
  }
  const canvasW = () => (Wover != null ? Wover : body.clientWidth - 16);

  /* ---- 線 ---- */
  function edgePath(e) {
    const ra = e.a === '#done' ? stackEl?._r : els.get(e.a)?._r, rb = els.get(e.b)?._r;
    if (!ra || !rb) return '';
    const p0 = { x: ra.x + ra.w / 2, y: ra.y + ra.h }, pn = { x: rb.x + rb.w / 2, y: rb.y - 1 };
    const pts = [p0, ...e.via, pn];
    let d = `M${p0.x} ${p0.y}`;
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], my = (a.y + b.y) / 2; d += `C${a.x} ${my} ${b.x} ${my} ${b.x} ${b.y}`; }
    if (pn.y - p0.y > 9) d += `M${pn.x - 3.5} ${pn.y - 5}L${pn.x} ${pn.y}L${pn.x + 3.5} ${pn.y - 5}`;
    return d;
  }
  function drawEdges() { if (!S.L) return; for (const e of S.L.E) edgeEls.get(e.key)?.setAttribute('d', edgePath(e)); }
  function syncEdges(E) {
    const keep = new Set(E.map((e) => e.key));
    for (const [k, p] of edgeEls) if (!keep.has(k)) { edgeEls.delete(k); p.classList.add('out'); setTimeout(() => p.remove(), 140); }
    for (const e of E) {
      let p = edgeEls.get(e.key);
      if (!p) {
        p = svgEl('path', { class: 'td-edge new', pathLength: '1' });
        p.addEventListener('animationend', () => p.classList.remove('new'));
        svg.append(p); edgeEls.set(e.key, p);
      }
      const src = e.a === '#done' ? null : byId(e.a);
      p.classList.toggle('pend', !!src && src.status !== 'done');
    }
  }

  /* ---- 見ている場所（つかんで動かす・拡大縮小）---- */
  const liveVp = () => ({ w: body.clientWidth, h: body.clientHeight });
  function clampV(v, vp) {
    const z = clamp(v.z, ZMIN, ZMAX), B = S.L.B;
    const rng = (c0, c1, a0, a1) => (c1 - c0 <= a1 - a0 ? [a0 - c0, a1 - c1] : [a1 - c1, a0 - c0]);
    const [xl, xh] = rng(OX + B.x0 * z, OX + B.x1 * z, MX, vp.w - MX), [yl, yh] = rng(OY + B.y0 * z, OY + B.y1 * z, OY, vp.h - MB());
    return { x: clamp(v.x, xl, xh), y: clamp(v.y, yl, yh), z };
  }
  function fitV(vp) {
    const B = S.L.B, bw = B.x1 - B.x0, bh = B.y1 - B.y0, aw = vp.w - 2 * MX, ah = vp.h - OY - MB();
    if (bw <= 0 || bh <= 0) return { x: 0, y: 0, z: 1 };
    const z = clamp(Math.min(aw / bw, ah / bh), ZMIN, 1);
    return { x: MX + (aw - bw * z) / 2 - OX - B.x0 * z, y: z < 1 ? Math.max(0, (ah - bh * z) / 2) : 0, z };
  }
  function homeV(vp) {
    const B = S.L.B;
    if (B.x1 - B.x0 <= vp.w - 2 * MX + 0.5 && B.y1 - B.y0 <= vp.h - OY - MB() + 0.5) return { x: 0, y: 0, z: 1 };
    const it = S.items.find((i) => i.status === 'doing'), r = it && S.L.R.get(it.id);
    return clampV({ x: vp.w / 2 - OX - (r ? r.x + r.w / 2 : (B.x0 + B.x1) / 2), y: r ? (vp.h - MB()) / 2 - OY - (r.y + r.h / 2) : 0, z: 1 }, vp);
  }
  function targetV(vp, base) {
    if (!flowView()) return { x: 0, y: 0, z: 1 };
    if (V.mode === 'fit' || (V.mode === 'home' && isMax)) return fitV(vp);
    if (V.mode === 'home') return homeV(vp);
    return clampV(base, vp);
  }
  function applyV() {
    const id = Math.abs(V.x) < 0.01 && Math.abs(V.y) < 0.01 && Math.abs(V.z - 1) < 0.0001;
    canvas.style.transform = id ? '' : `translate(${Math.round(V.x * 2) / 2}px,${Math.round(V.y * 2) / 2}px) scale(${V.z})`;
    zIn.setAttribute('aria-disabled', V.z >= ZMAX - 0.001 ? 'true' : 'false');
    zOut.setAttribute('aria-disabled', V.z <= ZMIN + 0.001 ? 'true' : 'false');
    updateMap();
  }
  function stopV() { drive = false; if (vtw) { tweens.delete(vtw); vtw = null; } Vgoal = null; }
  function setV(T, mode) { stopV(); const c = clampV(T, liveVp()); V.mode = mode; V.x = c.x; V.y = c.y; V.z = c.z; applyV(); }
  function animV(T, how, mode) {
    stopV(); V.mode = mode;
    const V0 = { x: V.x, y: V.y, z: V.z };
    Vgoal = T;
    vtw = run(how, (p) => { V.x = lerp(V0.x, T.x, p); V.y = lerp(V0.y, T.y, p); V.z = lerp(V0.z, T.z, p); applyV(); }, () => { vtw = null; Vgoal = null; });
    if (!vtw) Vgoal = null;
  }
  const zoomAt = (b, px, py, z1) => { z1 = clamp(z1, ZMIN, ZMAX); const cx = (px - OX - b.x) / b.z, cy = (py - OY - b.y) / b.z; return { x: px - OX - cx * z1, y: py - OY - cy * z1, z: z1 }; };
  function zoomBy(f) { const vp = liveVp(), b = Vgoal || V; animV(clampV(zoomAt(b, vp.w / 2, (vp.h - MB()) / 2, b.z * f), vp), spr().snappy, 'user'); }
  function panBy(dx, dy) { const b = Vgoal || V; animV(clampV({ x: b.x + dx, y: b.y + dy, z: b.z }, liveVp()), spr().snappy, 'user'); }
  function fitNow() { animV(fitV(liveVp()), spr().smooth, 'fit'); }
  zIn.onclick = () => { if (zIn.getAttribute('aria-disabled') !== 'true') zoomBy(1.25); };
  zOut.onclick = () => { if (zOut.getAttribute('aria-disabled') !== 'true') zoomBy(0.8); };
  zFit.onclick = fitNow;

  /* 位置の手がかり: 全体が収まっていない間だけ、下端の帯の左に出す。出ている間は帯が高くなり、中身はその上までに収める */
  function buildMap() {
    mapBox = null;
    const L = S.L;
    if (!L || !flowView()) { setMapOn(false); mapEl.replaceChildren(); return; }
    const k = K(), B = L.B, pd = 10, vw = B.x1 - B.x0 + 2 * pd, vh = B.y1 - B.y0 + 2 * pd, s = Math.min(k.MAPW / vw, k.MAPH / vh);
    const box = svgEl('svg', { width: (vw * s).toFixed(1), height: (vh * s).toFixed(1), viewBox: `${B.x0 - pd} ${B.y0 - pd} ${vw} ${vh}` });
    box.append(svgEl('rect', { class: 'mv', rx: '10' }));
    const rect = (r, cls) => svgEl('rect', { class: cls, x: r.x, y: r.y, width: r.w, height: r.h, rx: '8' });
    for (const it of S.items) { const r = L.R.get(it.id); if (r && r.o !== 0) box.append(rect(r, it.status === 'doing' ? 'mb doing' : 'mb')); }
    if (L.stack) box.append(rect(L.R.get('#done'), 'mb'));
    mapEl.replaceChildren(box);
    mapBox = { x: B.x0 - pd, y: B.y0 - pd, s };
  }
  function setMapOn(on) {
    if (mapOn === on) return;
    mapOn = on;
    mapEl.classList.toggle('on', on);
    root.style.setProperty('--td-mb', `${MB()}px`);
  }
  function updateMap() {
    if (!mapBox || !flowView()) { setMapOn(false); return; }
    const vp = liveVp(), B = S.L.B, x0 = (-OX - V.x) / V.z, x1 = (vp.w - OX - V.x) / V.z, y0 = (-OY - V.y) / V.z, y1 = (vp.h - MB() - OY - V.y) / V.z;
    const all = x0 <= B.x0 + 2 && x1 >= B.x1 - 2 && y0 <= B.y0 + 2 && y1 >= B.y1 - 2;
    // 手がかりを出すと帯が高くなって見える範囲が狭まるので、出すかどうかは帯の低いときの範囲で決める（行ったり来たりしない）
    const y1low = (vp.h - K().MB - OY - V.y) / V.z;
    const fits = x0 <= B.x0 + 2 && x1 >= B.x1 - 2 && y0 <= B.y0 + 2 && y1low >= B.y1 - 2;
    setMapOn(!fits && vp.w > 0);
    const mv = mapEl.querySelector('.mv');
    if (!mv) return;
    void all;
    mv.setAttribute('x', x0); mv.setAttribute('y', y0); mv.setAttribute('width', Math.max(0, x1 - x0)); mv.setAttribute('height', Math.max(0, y1 - y0));
  }
  mapEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!mapBox) return;
    const go = (ev) => {
      const r = mapEl.firstChild.getBoundingClientRect(), vp = liveVp(), cx = mapBox.x + (ev.clientX - r.left) / mapBox.s, cy = mapBox.y + (ev.clientY - r.top) / mapBox.s;
      setV({ x: vp.w / 2 - OX - cx * V.z, y: (vp.h - MB()) / 2 - OY - cy * V.z, z: V.z }, 'user');
    };
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    go(e); addEventListener('pointermove', go); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  body.addEventListener('wheel', (e) => {
    if (!flowView()) return;
    e.preventDefault();
    const r = body.getBoundingClientRect(), dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    setV(zoomAt(V, e.clientX - r.left, e.clientY - r.top, V.z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018))), 'user');
  }, { passive: false });
  body.addEventListener('scroll', () => {   // フォーカスで中身が送られたら、移動に置き換える
    if (!flowView() || (!body.scrollTop && !body.scrollLeft)) return;
    const T = { x: V.x - body.scrollLeft, y: V.y - body.scrollTop, z: V.z };
    body.scrollTop = 0; body.scrollLeft = 0; setV(T, 'user');
  });
  const ptrs = new Map();
  let pan = null, pinch = null;
  const bodyPt = (x, y) => { const r = body.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };
  function ptrMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2 && pinch) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), m = bodyPt((a.x + b.x) / 2, (a.y + b.y) / 2), z = clamp(pinch.z * d / pinch.d, ZMIN, ZMAX);
      setV({ x: m.x - OX - pinch.cx * z, y: m.y - OY - pinch.cy * z, z }, 'user');
      if (pan) pan.moved = true;
      return;
    }
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x0, dy = e.clientY - pan.y0;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      pan.moved = true; root.dataset.pan = 'on'; document.documentElement.style.userSelect = 'none'; getSelection()?.removeAllRanges(); closeMenu(); stopV();
    }
    const c = clampV({ x: pan.vx + dx, y: pan.vy + dy, z: V.z }, liveVp());
    if (c.x !== V.x || c.y !== V.y) { V.mode = 'user'; V.x = c.x; V.y = c.y; applyV(); }
  }
  function ptrUp(e) {
    if (!ptrs.delete(e.pointerId)) return;
    if (ptrs.size === 1 && pinch) { pinch = null; const [id, p] = [...ptrs.entries()][0]; pan = { id, x0: p.x, y0: p.y, vx: V.x, vy: V.y, moved: true }; return; }
    if (ptrs.size) return;
    removeEventListener('pointermove', ptrMove); removeEventListener('pointerup', ptrUp); removeEventListener('pointercancel', ptrUp);
    if (pan?.moved) { skipClick = true; setTimeout(() => { skipClick = false; }, 60); }
    pan = null; pinch = null; delete root.dataset.pan; document.documentElement.style.userSelect = '';
  }
  body.addEventListener('pointerdown', (e) => {
    if (!flowView() || e.target.closest('input') || (edit && e.target.closest('.td-port'))) return;
    if (e.pointerType === 'mouse' && e.button > 1) return;
    if (e.pointerType === 'mouse' && !e.target.closest('input,button')) body.focus({ preventScroll: true });
    if (!ptrs.size) { addEventListener('pointermove', ptrMove); addEventListener('pointerup', ptrUp); addEventListener('pointercancel', ptrUp); }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) pan = { id: e.pointerId, x0: e.clientX, y0: e.clientY, vx: V.x, vy: V.y, moved: false };
    else if (ptrs.size === 2) {
      stopV();
      const [a, b] = [...ptrs.values()], m = bodyPt((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z: V.z, cx: (m.x - OX - V.x) / V.z, cy: (m.y - OY - V.y) / V.z };
    }
  });
  body.addEventListener('mousedown', (e) => { if (!e.target.closest('input') && (flowView() || (edit && e.target.closest('.td-item')))) e.preventDefault(); });
  root.addEventListener('click', (e) => { if (skipClick) { skipClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  stage.addEventListener('keydown', (e) => {
    if (!flowView() || e.target.closest('input') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowLeft') panBy(48, 0);
    else if (k === 'ArrowRight') panBy(-48, 0);
    else if (k === 'ArrowUp') panBy(0, 48);
    else if (k === 'ArrowDown') panBy(0, -48);
    else if (k === '+' || k === '=' || k === ';') zoomBy(1.25);
    else if (k === '-') zoomBy(0.8);
    else if (k === '0') fitNow();
    else return;
    e.preventDefault();
  });

  /* ---- 描く ---- */
  function apply(anim, how) {
    const fv = flowView(), now = fv ? 'flow' : 'list';
    if (root.dataset.view !== now) {
      V.mode = 'home';
      if (fv && body.scrollTop) V.y -= body.scrollTop;
      root.dataset.view = now; body.scrollTop = 0; body.scrollLeft = 0;
      if (fv) { body.tabIndex = 0; body.setAttribute('role', 'group'); body.setAttribute('aria-label', t('todo.flowLabel')); }
      else { body.removeAttribute('tabindex'); body.removeAttribute('role'); body.removeAttribute('aria-label'); }
    }
    root.dataset.drag = !S.flow && !fv ? 'on' : 'off';
    root.style.setProperty('--td-mb', `${MB()}px`);
    const W = canvasW();
    if (W <= 0) return;
    const L = layout(W);
    S.L = L;
    const moves = [];
    for (const it of S.items) {
      const node = els.get(it.id), to = L.R.get(it.id);
      if (!node || !to) continue;
      node.classList.toggle('gone', to.o === 0);
      if (node._drag) continue;
      moves.push([node, node._r || { ...to, y: to.y + 12, o: 0 }, to]);
    }
    if (L.stack) {
      if (!stackEl) {
        stackEl = el('button', 'td-stack'); stackEl.type = 'button'; stackEl.setAttribute('aria-expanded', 'false');
        canvas.append(stackEl);
        stackEl.onclick = () => { S.expand = true; refresh(); };
      }
      const pm = el('span', 'td-pm'); pm.setAttribute('role', 'img'); pm.setAttribute('aria-label', statusLabel('done')); pm.innerHTML = markSvg('done');
      const chev = el('span', 'td-chev'); chev.innerHTML = chevRightIcon;
      stackEl.replaceChildren(pm, el('span', null, t('todo.stack', { n: L.stack })), chev);
      const to = L.R.get('#done');
      moves.push([stackEl, stackEl._r || { ...to, o: 0 }, to]);
      stackEl._dead = false;
    } else if (stackEl) { const dead = stackEl; dead._dead = true; moves.push([dead, dead._r, { ...dead._r, o: 0 }]); }
    foldBtn.hidden = !(fv && S.expand && S.items.length > 8);
    syncEdges(L.E); buildMap();
    const h0 = canvas._h == null ? L.H : canvas._h, w0 = canvas._w == null ? L.CW : canvas._w;
    if (tw) tweens.delete(tw);
    stopV(); drive = true;
    const V0 = { x: V.x, y: V.y, z: V.z };
    tw = run(anim === false ? null : (how || spr().smooth), (p) => {
      for (const [node, f, to] of moves) setRect(node, { x: lerp(f.x, to.x, p), y: lerp(f.y, to.y, p), w: lerp(f.w, to.w, p), h: lerp(f.h, to.h, p), o: lerp(f.o, to.o, p) });
      canvas._h = lerp(h0, L.H, p); canvas._w = lerp(w0, L.CW, p);
      canvas.style.height = `${canvas._h}px`; canvas.style.width = `${canvas._w}px`;
      svg.setAttribute('width', canvas._w); svg.setAttribute('height', canvas._h);
      drawEdges();
      if (drive) { const T = targetV(liveVp(), V0); V.x = lerp(V0.x, T.x, p); V.y = lerp(V0.y, T.y, p); V.z = lerp(V0.z, T.z, p); }
      applyV();
    }, () => { tw = null; if (stackEl?._dead) { stackEl.remove(); stackEl = null; } });
  }
  function paint(it) {
    const node = els.get(it.id), p = node._p, kind = kindOf(it, S.flow);
    if (node.dataset.kind !== kind) {
      node.classList.toggle('just', kind === 'done' && !!node.dataset.kind);
      node.dataset.kind = kind; p.mark.innerHTML = markSvg(kind);
    }
    p.mark.setAttribute('aria-checked', it.status === 'done' ? 'true' : 'false');
    p.mark.setAttribute('aria-label', t('todo.markLabel', { text: it.text, status: statusLabel(kind) }));
    p.mark.title = statusLabel(kind);
    if (edit) p.mark.removeAttribute('aria-disabled'); else p.mark.setAttribute('aria-disabled', 'true');
    p.mark.tabIndex = edit ? 0 : -1; p.more.tabIndex = edit ? 0 : -1;
    p.text.textContent = it.text; p.text.title = it.text;
    fillFoot(p, it);
    const bt = byText(it.id), n = it.links.length;
    p.by.title = bt; p.by.setAttribute('aria-label', bt);
    const lab = t('todo.links.count', { n });
    p.badge.title = lab; p.badge.setAttribute('aria-label', lab);
  }
  function stats() { return { done: S.items.filter((i) => i.status === 'done').length, n: S.items.length }; }
  function entryLabel() {
    const st = stats();
    const base = st.n ? t('todo.entryCount', { done: st.done, total: st.n }) : t('todo.entry');
    // 点だけでは読み上げに伝わらない。閉じている間の AI の変更は名前にも足す
    return unseen.size && !isOpen ? `${base} · ${t('todo.unseen')}` : base;
  }
  function refresh(anim, how) {
    for (const it of S.items) {
      if (!els.has(it.id)) { const node = itemEl('td-item'); node.setAttribute('role', 'listitem'); node.dataset.id = it.id; canvas.append(node); els.set(it.id, node); }
      paint(it);
    }
    for (const [id, node] of els) if (!byId(id)) { els.delete(id); node.style.transition = 'opacity 120ms'; node.style.opacity = '0'; node.style.pointerEvents = 'none'; setTimeout(() => node.remove(), 130); }
    const st = stats();
    countEl.textContent = st.n ? `${st.done}/${st.n}` : '';
    emptyEl.hidden = st.n > 0;
    seg.hidden = !S.flow;
    for (const b of seg.children) { const on = (b.dataset.v === 'flow') === flowView(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (isOpen) apply(anim, how);
    const label = entryLabel();
    entry.setAttribute('aria-label', label); entry.title = label;
    o.onChange?.();
  }
  function flash(id) {
    const node = els.get(id);
    if (!node) return;
    if (!isOpen || root.offsetWidth === 0) { unseen.add(id); return; }
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1250);
  }

  /* ---- 書く: todos.* を ifRev 付きで呼び、返った一覧を映す ---- */
  function setItems(list, rev) {
    S.items = [...list].sort((a, b) => a.order - b.order);
    S.rev = rev;
    const f = isFlowGraph(S.items);
    if (!f && S.flow) S.view = 'auto';
    S.flow = f;
    for (const id of [...badges.keys()]) if (!byId(id)) badges.delete(id);
    for (const id of [...unseen]) if (!byId(id)) unseen.delete(id);
  }
  async function send(op, args, touched = []) {
    const sid = S.session;
    if (!sid || busy) return null;
    busy = true;
    try {
      const res = await o.cmd('invoke', { op, args: { sessionId: sid, ...args, ifRev: S.rev } });
      const out = res?.result ?? res;
      if (S.session !== sid || !out?.items) return out;
      for (const id of touched) badges.delete(id);
      if (out.rev > S.rev) setItems(out.items, out.rev);
      return out;
    } catch (e) {
      if (S.session !== sid) return null;
      if (e?.code === 'TODO_CONFLICT') o.notify?.(t('todo.conflict'));
      else o.notify?.(t('todo.failed'));
      await reload();
      return null;
    } finally { busy = false; }
  }
  async function reload() {
    const sid = S.session;
    if (!sid) return;
    const token = ++S.loading;
    try {
      const res = await o.cmd('invoke', { op: 'todos.list', args: { sessionId: sid } });
      const out = res?.result ?? res;
      if (S.session !== sid || token !== S.loading || !out?.items) return;
      setItems(out.items, out.rev);
      refresh(isOpen ? undefined : false);
    } catch { /* 読めなければ今の並びのまま */ }
  }
  async function setStatus(it, status) { await send('todos.update', { items: [{ id: it.id, status }] }, [it.id]); refresh(); }
  async function renameItem(it, text) { await send('todos.update', { items: [{ id: it.id, text }] }, [it.id]); refresh(true, spr().snappy); }
  async function addItem(text) {
    const after = S.flow ? leaves(S.items, afterMap(S.items)) : undefined;
    await send('todos.add', { items: [{ text, ...(after ? { after } : {}) }] });
    refresh(true, spr().snappy);
  }
  /** 並びと依存を組み替えた結果を送る */
  async function sendGraph(nextDeps, items = S.items, touched = []) {
    const { order, after } = normalizeAfter(items, nextDeps);
    const changes = changesFor(items, order, after);
    if (!changes.length) return true;
    return Boolean(await send('todos.update', { items: changes }, touched));
  }
  async function removeItem(it) {
    // 消す項目を待っていた項目は、消す項目が待っていた項目を待つようにつなぎ直してから消す
    if (S.flow) {
      const d = deps(), rest = S.items.filter((x) => x.id !== it.id), next = new Map();
      for (const x of rest) { const own = d.get(x.id) ?? []; next.set(x.id, own.includes(it.id) ? [...new Set([...own.filter((y) => y !== it.id), ...(d.get(it.id) ?? [])])] : own); }
      if (!(await sendGraph(next, rest))) { refresh(); return; }
    }
    await send('todos.remove', { ids: [it.id] });
    refresh();
  }
  async function toggleDep(it, other) {
    const d = deps(), own = d.get(it.id) ?? [];
    d.set(it.id, own.includes(other.id) ? own.filter((x) => x !== other.id) : [...own, other.id]);
    await sendGraph(d, S.items, [it.id]);
    refresh();
  }
  async function moveTo(it, beforeId) {
    // リストの並べ替え。依存が 1 本道として残っていれば外す（並びが先に終える順になる）
    const changes = [{ id: it.id, before: beforeId ?? null }];
    for (const x of S.items) if (x.after?.length) { const c = x.id === it.id ? changes[0] : (changes[changes.push({ id: x.id }) - 1]); c.after = []; }
    await send('todos.update', { items: changes });
    refresh(true, spr().snappy);
  }

  /* ---- 閲覧と編集 ---- */
  function setEditWidth() {
    const pad = narrow.matches ? 26 : 22;
    editBtn.style.setProperty('--td-edit-w', `${Math.ceil(editLt.offsetWidth) + pad}px`);
  }
  function setEdit(v, focusAdd, anim) {
    v = !!v;
    if (edit === v) return;
    if (rename) rename(true);
    closeMenu(); edit = v;
    root.dataset.mode = v ? 'edit' : 'view'; addClip.inert = !v;
    const l = v ? t('todo.editEnd') : t('todo.edit');
    editBtn.setAttribute('aria-label', l); editBtn.title = l; editBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
    if (v) setEditWidth();
    refresh(anim);
    if (v && focusAdd) addInput.focus({ preventScroll: true });
  }
  editBtn.setAttribute('aria-label', t('todo.edit')); editBtn.title = t('todo.edit'); editBtn.setAttribute('aria-pressed', 'false');
  editBtn.onclick = () => setEdit(!edit);
  emptyAdd.onclick = () => setEdit(true, true);
  function startRename(it) {
    if (!edit) return;
    if (rename) rename(true);
    const node = els.get(it.id), tx = node._p.text, inp = el('input', 'td-rename');
    inp.type = 'text'; inp.setAttribute('aria-label', t('todo.menu.rename')); inp.autocomplete = 'off';
    inp.value = it.text; tx.hidden = true; tx.after(inp); inp.focus({ preventScroll: true }); inp.select();
    let fin = false;
    const finish = (ok) => {
      if (fin) return;
      fin = true; rename = null;
      const v = inp.value.trim();
      inp.remove(); tx.hidden = false;
      if (ok && v && v !== it.text) renameItem(it, v);
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
    inp.addEventListener('blur', () => finish(true));
    rename = finish;
  }

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = addInput.value.trim();
    if (!v) return;
    addInput.value = '';
    await addItem(v);
    if (!flowView()) body.scrollTop = body.scrollHeight;
  });
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.view = b.dataset.v; refresh(); });
  foldBtn.onclick = () => { S.expand = false; refresh(); };
  canvas.addEventListener('click', (e) => {
    const node = e.target.closest('.td-item');
    if (!node) return;
    const it = byId(node.dataset.id);
    if (!it) return;
    if (e.target.closest('.td-mark')) { if (edit) setStatus(it, it.status === 'done' ? 'todo' : 'done'); }
    else if (e.target.closest('.td-more')) openMenu(it, node._p.more);
    else if (e.target.closest('.td-badge')) openLinks(it, node._p.badge);
    else if (e.target.closest('.td-text')) startRename(it);
  });

  /* 並べ替え（編集の状態のリストで、依存が無いとき。タッチは左のつまみだけ） */
  canvas.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.td-item');
    if (!node || e.button) return;
    if (flowView()) { if (edit && e.target.closest('.td-port')) startLink(e, node); return; }
    if (!edit || S.flow) return;
    if (!e.target.closest('.td-grip') && (e.pointerType !== 'mouse' || e.target.closest('button,input'))) return;
    const it = byId(node.dataset.id), y0 = e.clientY, r0 = { ...node._r }, start = S.items.map((x) => x.id);
    let moved = false;
    const mv = (ev) => {
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) < 4) return;
      if (!moved) { moved = true; node._drag = true; node.classList.add('drag'); closeMenu(); if (rename) rename(true); }
      setRect(node, { ...r0, y: clamp(r0.y + dy, -6, S.L.H - r0.h + 6) });
      const cy = node._r.y + node._r.h / 2, rest = S.items.filter((x) => x !== it);
      let idx = 0, acc = 0;
      for (const x of rest) { const h = S.L.R.get(x.id)?.h ?? K().ROW; if (cy > acc + h / 2) idx++; acc += h + gapNow(); }
      if (S.items.indexOf(it) !== idx) { rest.splice(idx, 0, it); S.items = rest; apply(true, spr().snappy); }
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (!moved) return;
      node._drag = false; node.classList.remove('drag');
      skipClick = true; setTimeout(() => { skipClick = false; }, 60);
      const i = S.items.indexOf(it), changed = S.items.some((x, k) => x.id !== start[k]);
      if (changed) moveTo(it, S.items[i + 1]?.id ?? null); else refresh(true, spr().snappy);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  /* 箱の丸から別の箱へドラッグして、依存を付ける */
  function startLink(e, node) {
    e.preventDefault(); e.stopPropagation();
    const src = byId(node.dataset.id), cr = () => canvas.getBoundingClientRect();
    const p = svgEl('path', { class: 'td-edge temp' });
    svg.append(p); root.dataset.link = 'on';
    const r = node._r, x0 = r.x + r.w / 2, y0 = r.y + r.h;
    let aim = null;
    const pick = (ev) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY), n = hit?.closest('.td-item');
      if (!n || !canvas.contains(n) || n === node) return null;
      const it = byId(n.dataset.id), d = deps();
      return it && !reaches(src.id, it.id, d) && !(d.get(it.id) ?? []).includes(src.id) ? n : null;
    };
    const mv = (ev) => {
      const c = cr();
      p.setAttribute('d', `M${x0} ${y0}L${(ev.clientX - c.left) / V.z} ${(ev.clientY - c.top) / V.z}`);
      const n = pick(ev);
      if (aim && aim !== n) aim.classList.remove('aim');
      aim = n;
      if (aim) aim.classList.add('aim');
    };
    const up = (ev) => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      p.remove(); delete root.dataset.link;
      const n = ev.type === 'pointerup' ? pick(ev) : null;
      if (aim) aim.classList.remove('aim');
      if (n) toggleDep(byId(n.dataset.id), src);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  /* 行の「…」のメニューと、成果物の一覧 */
  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    root.querySelectorAll('.td-more[aria-expanded=true],.td-badge[aria-expanded=true]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
  function place(m, btn) {
    const rr = root.getBoundingClientRect(), br = btn.isConnected && btn.offsetWidth ? btn.getBoundingClientRect() : rr;
    let top = br.bottom - rr.top + 4;
    if (top + m.offsetHeight > rr.height - 6) top = Math.max(6, rr.height - m.offsetHeight - 6);
    m.style.top = `${top}px`;
    m.style.left = `${clamp(br.right - rr.left - m.offsetWidth, 6, Math.max(6, rr.width - m.offsetWidth - 6))}px`;
  }
  // 依存を変えるとリスト ⇄ フローの変形で行が動く。動き終わるまで（最長 0.8 秒）メニューを行に付いて行かせる（面の外で切れない）
  function follow(m, btn) {
    const until = performance.now() + 800;
    const step = () => { if (menu !== m) return; place(m, btn); if (performance.now() < until) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function li(m, label, fn, opt = {}) {
    const b = el('button', 'li', label); b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (opt.cls) b.classList.add(opt.cls);
    if (opt.off) b.setAttribute('aria-disabled', 'true'); else b.onclick = fn;
    m.append(b);
    return b;
  }
  function openMenu(it, btn) {
    const again = menu && menu._for === it.id;
    closeMenu();
    if (again) return;
    const m = el('div', 'pop menu td-menu'); m.setAttribute('role', 'menu'); m._for = it.id;
    m._btn = btn; menu = m; root.append(m); btn.setAttribute('aria-expanded', 'true');
    const main = () => {
      m.replaceChildren();
      const cur = byId(it.id) ?? it;
      if (cur.status === 'todo') li(m, t('todo.menu.start'), () => { closeMenu(); setStatus(cur, 'doing'); });
      else li(m, t('todo.menu.reopen'), () => { closeMenu(); setStatus(cur, 'todo'); });
      li(m, t('todo.menu.rename'), () => { closeMenu(); startRename(cur); });
      li(m, t('todo.menu.deps'), sub);
      li(m, t('todo.menu.links'), () => { const p = els.get(cur.id)._p; closeMenu(); openLinks(cur, cur.links.length ? p.badge : p.more); });
      if (!S.flow && !flowView()) {
        const i = S.items.findIndex((x) => x.id === cur.id);
        li(m, t('todo.menu.up'), () => { closeMenu(); moveTo(cur, S.items[i - 1].id); }, { off: i === 0 });
        li(m, t('todo.menu.down'), () => { closeMenu(); moveTo(cur, S.items[i + 2]?.id ?? null); }, { off: i === S.items.length - 1 });
      }
      m.append(el('div', 'sep'));
      li(m, t('todo.menu.remove'), () => { closeMenu(); removeItem(cur); }, { cls: 'danger' });
    };
    const sub = () => {
      m.replaceChildren();
      const hd = el('div', 'head');
      const back = el('button', 'back', '‹'); back.type = 'button'; back.setAttribute('aria-label', t('todo.menu.back'));
      back.onclick = () => { main(); place(m, btn); m.querySelector('.li')?.focus({ preventScroll: true }); };
      hd.append(back, el('span', null, t('todo.menu.depsHead')));
      m.append(hd);
      const d = deps();
      for (const x of S.items) {
        if (x.id === it.id) continue;
        const on = (d.get(it.id) ?? []).includes(x.id), off = !on && reaches(x.id, it.id, d);
        const b = el('button', 'li'); b.type = 'button'; b.setAttribute('role', 'menuitemcheckbox');
        const ck = el('span', 'ck', on ? '✓' : ''); ck.setAttribute('aria-hidden', 'true');
        b.append(ck, el('span', 'lbl', x.text));
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.dataset.id = x.id;
        if (off) b.setAttribute('aria-disabled', 'true');
        // 作り直した後も同じ行にフォーカスを残す（Esc・矢印で続けて操作できる）
        else b.onclick = async () => {
          const cur = byId(it.id); if (!cur) return closeMenu();
          await toggleDep(cur, x);
          if (menu !== m) return;
          sub(); follow(m, btn);
          [...m.querySelectorAll('.li')].find((n) => n.dataset.id === x.id)?.focus({ preventScroll: true });
        };
        m.append(b);
      }
      place(m, btn);
    };
    main(); place(m, btn);
    m.querySelector('.li')?.focus({ preventScroll: true });
  }
  async function openLinks(it, btn) {
    const key = `L${it.id}`, again = menu && menu._for === key;
    closeMenu();
    if (again) return;
    const m = el('div', 'pop menu td-menu td-links'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', t('todo.links.title')); m._for = key;
    m._btn = btn; menu = m; root.append(m); btn.setAttribute('aria-expanded', 'true');
    const missing = new Set();
    const draw = () => {
      const cur = byId(it.id);
      if (!cur) { closeMenu(); return; }
      const hd = el('div', 'head'); hd.append(el('span', null, t('todo.links.title')));
      m.replaceChildren(hd);
      for (const l of cur.links) {
        const p = linkParts(l), gone = missing.has(l.id);
        const row = el('div', 'td-lrow'), a = el('button', 'li td-link'); a.type = 'button';
        const ic = el('span', 'td-kind'); ic.innerHTML = KIND[l.kind] ?? KIND.file;
        a.append(ic, el('span', 'nm', p.name), el('span', 'wh', gone ? t('todo.links.missing') : p.where));
        a.title = l.url ?? l.path ?? '';
        a.setAttribute('aria-label', t(gone ? 'todo.links.missingLabel' : 'todo.links.itemLabel', { kind: t(`todo.links.kind.${l.kind}`), name: p.name }));
        if (gone) a.setAttribute('aria-disabled', 'true');
        else a.onclick = () => { closeMenu(); o.openLink(l); };
        if (l.kind !== 'url' && o.linkMenu) a.addEventListener('contextmenu', (e) => { e.preventDefault(); o.linkMenu(e.clientX, e.clientY, l, gone); });
        row.append(a);
        if (edit) {
          const x = el('button', 'td-unlink', '×'); x.type = 'button'; x.setAttribute('aria-label', t('todo.links.unlink')); x.title = t('todo.links.unlink');
          x.onclick = async () => {
            await send('todos.update', { items: [{ id: cur.id, removeLinks: [l.id] }] }, [cur.id]);
            refresh(true, spr().snappy);
            if (menu !== m) return;
            if (!btn.isConnected || !btn.offsetWidth) btn = els.get(cur.id)?._p.more ?? btn;
            draw(); place(m, btn);
          };
          row.append(x);
        }
        m.append(row);
      }
      if (edit) {
        const f = el('form', 'td-linkadd'), inp = el('input', 'field');
        inp.type = 'text'; inp.placeholder = t('todo.links.add'); inp.setAttribute('aria-label', t('todo.links.add')); inp.autocomplete = 'off';
        f.append(inp);
        f.onsubmit = async (e) => {
          e.preventDefault();
          const v = inp.value.trim();
          if (!v) return;
          await send('todos.update', { items: [{ id: cur.id, addLinks: [linkInput(v)] }] }, [cur.id]);
          refresh(true, spr().snappy);
          if (menu !== m) return;
          btn = els.get(cur.id)?._p.badge ?? btn; btn.setAttribute('aria-expanded', 'true');
          draw(); place(m, btn); m.querySelector('.td-linkadd input')?.focus({ preventScroll: true });
        };
        m.append(f);
      }
    };
    draw(); place(m, btn);
    // 開いたときに、ファイル・フォルダーが今あるかを確かめる（無ければ「見つかりません」にして押せなくする）
    if (it.links.some((l) => l.kind !== 'url')) {
      try {
        const res = await o.cmd('invoke', { op: 'todos.checkLinks', args: { sessionId: S.session, id: it.id } });
        const out = res?.result ?? res;
        if (menu !== m) return;
        for (const x of out?.links ?? []) if (!x.exists) missing.add(x.id);
        if (missing.size) { draw(); place(m, btn); }
      } catch { /* 確かめられなければ、押してから開く側が知らせる */ }
    }
  }
  root.addEventListener('pointerdown', (e) => { if (menu && !e.target.closest('.td-menu,.td-more,.td-badge')) closeMenu(); });
  dismissPopup({ isOpen: () => isOpen, surfaces: () => [root],
    opener: () => entry.offsetWidth ? entry : o.moreButton,
    close, outside: () => !isMax,
    escape: () => {
      if (menu) { const button = menu._btn; closeMenu(); button?.focus({ preventScroll: true }); }
      else if (rename) rename(false);
      else if (edit) { setEdit(false); editBtn.focus({ preventScroll: true }); }
      else if (isMax) toggleMax();
      else return true;
      return false;
    } });

  /* ---- 枠: 開く・閉じる・大きく表示 ---- */
  const placeTop = () => { root.style.setProperty('--td-top', `${header.offsetTop + header.offsetHeight}px`); };
  const setFrame = (r) => { root.classList.add('free'); root.style.left = `${r.l}px`; root.style.top = `${r.t}px`; root.style.width = `${r.w}px`; root.style.height = `${r.h}px`; };
  const clearFrame = () => { root.classList.remove('free'); root.style.left = root.style.top = root.style.width = root.style.height = ''; };
  function setMaxButton() {
    maxBtn.innerHTML = isMax ? collapseIcon : expandIcon;
    const l = isMax ? t('todo.restore') : t('todo.max');
    maxBtn.title = l; maxBtn.setAttribute('aria-label', l);
  }
  setMaxButton();
  function shown() {
    V.mode = 'home'; apply(false);
    for (const id of [...unseen]) { unseen.delete(id); flash(id); }
    if (!flowView()) {
      const it = S.items.find((i) => i.status === 'doing'), r = it && S.L?.R.get(it.id);
      if (r && S.L.H > body.clientHeight) body.scrollTop = Math.max(0, r.y - 60);
    }
  }
  function paintDot() {
    const dot = entry.querySelector('.entry-dot');
    if (dot) dot.hidden = !unseen.size || isOpen;
    const label = entryLabel();
    entry.setAttribute('aria-label', label); entry.title = label;
    o.onChange?.();
  }
  function open() {
    if (isOpen || !S.session) return;
    isOpen = true;
    placeTop();
    root.hidden = false; root.classList.remove('out'); root.classList.add('in');
    entry.setAttribute('aria-expanded', 'true'); entry.classList.add('on');
    if (narrow.matches) veil.classList.add('on');
    shown(); paintDot();
    (edit ? editBtn : closeBtn).focus({ preventScroll: true });
  }
  function close() {
    if (!isOpen) return;
    isOpen = false; closeMenu();
    if (rename) rename(true);
    if (isMax) { isMax = false; root.classList.remove('max'); setMaxButton(); }
    veil.classList.remove('on'); root.classList.remove('in'); root.classList.add('out');
    entry.setAttribute('aria-expanded', 'false'); entry.classList.remove('on');
    setTimeout(() => {
      if (isOpen) return;
      root.hidden = true; root.classList.remove('out'); clearFrame();
      const had = badges.size > 0;
      badges.clear();
      if (edit) setEdit(false, false, false); else if (had) for (const it of S.items) paint(it);
      Wover = null;
    }, reducedMotion() ? 0 : 130);
    paintDot();
  }
  const maxRect = (ar) => {
    const n = narrow.matches, w = n ? ar.width : Math.min(1040, ar.width * 0.94), h = n ? ar.height : Math.min(720, ar.height * 0.86);
    return { l: (ar.width - w) / 2, t: (ar.height - h) / 2, w, h };
  };
  function snapshot() { return { h: canvas._h, w: canvas._w, v: { ...V }, r: [...els.values(), ...(stackEl ? [stackEl] : [])].map((n) => [n, n._r]) }; }
  function restore(s) { canvas._h = s.h; canvas._w = s.w; for (const [n, r] of s.r) if (r) setRect(n, r); Object.assign(V, s.v); applyV(); }
  function relayout(W, anim) { Wover = W == null ? null : W; apply(anim); }
  function toggleMax() {
    const ar = host.getBoundingClientRect(), pr = root.getBoundingClientRect(), from = { l: pr.left - ar.left, t: pr.top - ar.top, w: pr.width, h: pr.height };
    isMax = !isMax;
    let to;
    if (isMax) to = maxRect(ar);
    else {
      const snap = snapshot();
      clearFrame(); root.classList.remove('max', 'in'); relayout(null, false);
      const r = root.getBoundingClientRect();
      to = { l: r.left - ar.left, t: r.top - ar.top, w: r.width, h: r.height };
      restore(snap);
    }
    root.classList.remove('in'); root.classList.toggle('max', isMax); setFrame(from);
    if (!narrow.matches) veil.classList.toggle('on', isMax);
    V.mode = 'home'; setMaxButton(); closeMenu();
    relayout(to.w - 16 - (body.offsetWidth - body.clientWidth), true);
    run(spr().smooth, (p) => setFrame({ l: lerp(from.l, to.l, p), t: lerp(from.t, to.t, p), w: lerp(from.w, to.w, p), h: lerp(from.h, to.h, p) }),
      () => { if (!isMax) clearFrame(); relayout(null, false); });
  }
  entry.addEventListener('click', () => (isOpen ? close() : open()));
  closeBtn.onclick = () => { close(); (entry.offsetWidth ? entry : o.moreButton)?.focus({ preventScroll: true }); };
  maxBtn.onclick = toggleMax;

  narrow.addEventListener?.('change', () => {
    if (!isOpen) return;
    if (isMax) { isMax = false; root.classList.remove('max'); clearFrame(); setMaxButton(); }
    veil.classList.toggle('on', narrow.matches);
    placeTop();
    if (edit) setEditWidth();
    relayout(null, false);
  });
  if (typeof ResizeObserver === 'function') {
    let last = 0;
    new ResizeObserver(() => { const w = body.clientWidth; if (!isOpen || w === last || tw) return; last = w; if (Wover == null) apply(false); }).observe(body);
  }

  /* ---- 会話の切り替えと、届いた変更 ---- */
  function clearView() {
    closeMenu();
    if (rename) rename(false);
    if (edit) setEdit(false, false, false);
    badges.clear(); unseen.clear();
    S.items = []; S.rev = -1; S.flow = false; S.view = 'auto'; S.expand = false; S.L = null;
    for (const node of els.values()) node.remove();
    els.clear();
    for (const p of edgeEls.values()) p.remove();
    edgeEls.clear();
    stackEl?.remove(); stackEl = null;
    canvas._h = canvas._w = null; Object.assign(V, { x: 0, y: 0, z: 1, mode: 'home' });
  }
  async function load(sessionId) {
    if (S.session === sessionId) return;
    clearView();
    S.session = sessionId || null;
    entry.hidden = !S.session;
    if (!S.session) { close(); refresh(false); paintDot(); return; }
    refresh(false);
    await reload();
    paintDot();
  }
  function reset() { load(null); }
  function onEvent(ev) {
    if (ev?.type !== 'todosChanged' || ev.sessionId !== S.session || !(ev.rev > S.rev)) return;
    const before = new Map(S.items.map((i) => [i.id, i]));
    setItems(ev.items ?? [], ev.rev);
    const agent = ev.by?.kind === 'agent';
    const touched = [];
    let bump = null;
    for (const c of ev.changed ?? []) {
      if (!byId(c.id)) continue;
      if (!agent) { badges.delete(c.id); continue; }
      let key = BY_KEY[c.action];
      if (!key) continue;
      const old = before.get(c.id), now = byId(c.id);
      if (c.action === 'updated' && old && now.links.length > old.links.length) { key = 'links'; bump = c.id; }
      const name = o.labelOf?.(ev.by.backend) ?? ev.by.backend ?? '';
      // i18n-dynamic: todo.by.
      badges.set(c.id, { text: t(`todo.by.${key}`, { name }), backend: ev.by.backend ?? null });
      touched.push(c.id);
    }
    refresh();
    if (!agent) return;
    for (const id of touched) flash(id);
    if (bump && isOpen) { const b = els.get(bump)?._p.badge; if (b) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); } }
    paintDot();
  }

  return {
    load, reset, onEvent, open, close, isOpen: () => isOpen,
    toggle: () => (isOpen ? close() : open()),
    stats, label: entryLabel,
    hasUnseen: () => unseen.size > 0 && !isOpen,
    sessionId: () => S.session,
  };
}
