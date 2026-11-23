// 設定 › プラグインのフォルダー別の設定（ADR 0348）で、4 つのタブ（指示・Skills・外部 MCP・Hooks）がそろえて使う印。
// 行の印: この場所で変えた「● 変更」＋「戻す」、上のフォルダーから受け継いだ「website の設定」（押すとその場所へ移る）、
// 足したスキャン場所の「● 追加」＋「外す」。全体の設定では、別の設定にした場所を下の行に「website で別の設定」と添える。
// 節の頭（「スキャン場所」「ユーザースコープの指示」など）と、その「?」の説明もここでそろえる。

import { el } from './dom.mjs';
import { t } from './i18n.mjs';

const DOT = '<circle cx="5" cy="5" r="3.2"/>';

/** パスの最後の名前（フォルダー名）。C:\dev\website → website */
export const placeName = (p) => {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const m = s.match(/[^\\/]+$/);
  return m ? m[0] : s;
};

function dot() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 10 10'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = DOT;
  return s;
}

/** 「● 変更」（この場所で変えた）・「● 追加」（この場所で足した） */
export function overrideBadge(kind = 'changed') {
  const b = el('span', 'ovb');
  b.append(dot(), document.createTextNode(kind === 'added' ? t('context.scope.mark.added') : t('context.scope.mark.changed')));
  return b;
}

/** 上のフォルダーから受け継いだ印。押すとそのフォルダーの設定へ移る */
export function parentLink(path, onGo) {
  const b = el('button', 'ovp', t('context.scope.mark.from', { name: placeName(path) }));
  b.type = 'button';
  b.title = path;
  b.setAttribute('aria-label', t('context.scope.mark.fromAria', { name: placeName(path) }));
  b.onclick = (e) => { e.stopPropagation(); onGo?.(path); };
  return b;
}

/** 行の「戻す」。parent = 受け継ぐ元の場所（無ければ全体の設定） */
export function revertButton({ parent = null, name = '', onRevert, key }) {
  const b = el('button', 'tbtn rv', t('context.scope.revert'));
  b.type = 'button';
  b.setAttribute('aria-label', parent
    ? t('context.scope.revertToParentAria', { name, parent: placeName(parent) })
    : t('context.scope.revertToGlobalAria', { name }));
  if (key) b.dataset.cxFk = key;
  b.onclick = (e) => { e.stopPropagation(); onRevert?.(); };
  return b;
}

/** 全体の設定の行に添える「website で別の設定」「3 か所で別の設定」。無ければ '' */
export function elsewhereText(list) {
  const places = Array.isArray(list) ? list : [];
  if (!places.length) return '';
  if (places.length === 1) return t('context.scope.mark.elsewhereOne', { name: placeName(places[0]) });
  return t('context.scope.mark.elsewhereMany', { count: places.length });
}

/**
 * 行の印をまとめて作る。mark = { changedHere, ruleFrom, elsewhere, added }、scope = { place, parent }（全体なら place: null）。
 * 戻す・外すのボタンは呼ぶ側が付ける（行ごとに保存先が違う）。返すのは名前の横に並べる要素の配列
 */
export function rowMarks(mark, { place, onGo } = {}) {
  const out = [];
  if (!place || !mark) return out;
  if (mark.added) out.push(overrideBadge('added'));
  else if (mark.changedHere) out.push(overrideBadge('changed'));
  else if (mark.ruleFrom) out.push(parentLink(mark.ruleFrom, onGo));
  return out;
}

let tipSeq = 0;
/**
 * 節の頭。name と、説明（tip）があれば「?」。right は右端に並べる要素。
 * 「?」は、ポインターを乗せる・フォーカス・タップで開き、Esc・外を押すと閉じる
 */
export function sectionHead(name, { tip = '', right = [], level = 'h5' } = {}) {
  const head = el('div', 'cx-sec');
  const title = el(level, 'n', name);
  head.append(title);
  if (tip) {
    const id = `cxTip${++tipSeq}`;
    const q = el('button', 'qtip', '?');
    q.type = 'button';
    q.setAttribute('aria-label', t('context.scope.tipAria', { name }));
    q.setAttribute('aria-describedby', id);
    const box = el('span', 'tip', tip);
    box.id = id; box.setAttribute('role', 'tooltip');
    const close = () => { box.classList.remove('on'); box.classList.add('x'); q.setAttribute('aria-expanded', 'false'); };
    const openTip = () => { box.classList.add('on'); box.classList.remove('x'); q.setAttribute('aria-expanded', 'true'); };
    q.setAttribute('aria-expanded', 'false');
    q.onclick = (e) => { e.stopPropagation(); if (box.classList.contains('on')) close(); else openTip(); };
    q.onkeydown = (e) => { if (e.key === 'Escape' && (box.classList.contains('on') || q.matches(':focus-visible'))) { e.preventDefault(); e.stopPropagation(); close(); } };
    q.onmouseleave = () => box.classList.remove('x');
    q.onblur = () => { box.classList.remove('on', 'x'); q.setAttribute('aria-expanded', 'false'); };
    const outside = (e) => { if (!head.isConnected) { document.removeEventListener('pointerdown', outside, true); return; } if (!head.contains(e.target)) close(); };
    document.addEventListener('pointerdown', outside, true);
    head.append(q, box);
  }
  if (right.length) {
    const r = el('span', 'r');
    r.append(...right);
    head.append(r);
  }
  return head;
}

/** 「＋ スキャン場所を追加」などの文字ボタン（.tbtn）。cls に danger・weak・fill を足せる */
export function textButton(label, cls = '', onClick) {
  const b = el('button', 'tbtn' + (cls ? ` ${cls}` : ''), label);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
