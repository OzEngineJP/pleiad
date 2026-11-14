// ==================== 鍵付きの項目（変更できない理由）の吹き出し ====================
// 追補 1（2026-11-15 承認）。見た目は .tc-when-pop（web/tools.css）と同じ浮く面（--surface-paper + 影）。
// 対象（[data-tip]）へホバー（150ms）・キーボードのフォーカス（:focus-visible）・タップのいずれでも同じ吹き出しを出す。
// 押しても状態は変えず（click を止める）、Esc（焦点を残す）・外を押す・フォーカスが外れる・スクロールで相手が見えなくなる・窓のリサイズで消す。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

export const LOCK_REASONS = new Set(['own', 'workspace', 'relay', 'admin', 'linked']);

// i18n-dynamic: context.lockReason.
/** セル（{ mode, reason? }）から理由のキーを選ぶ。reason が無ければ mode から決める */
export function lockReasonKey(cell) {
  if (LOCK_REASONS.has(cell?.reason)) return cell.reason;
  return cell?.mode === 'blocked' ? 'relay' : 'own';
}

/** エージェント名とセルから吹き出しの文を作る */
export function lockReasonText(agentName, cell) {
  return t(`context.lockReason.${lockReasonKey(cell)}`, { agent: agentName });
}

/** 読み上げ名「{元の名前}（{理由}）」を作る */
export function lockAriaLabel(baseLabel, reason) {
  return t('context.lockAria', { label: baseLabel, reason });
}

let bound = false, tip = null, who = null, tapped = null, tm = null, lastPointer = '';

function resetState() {
  clearTimeout(tm);
  tm = null;
  who = null;
  tapped = null;
  lastPointer = '';
  if (tip) {
    tip.classList.remove('on');
    if (tip.style) tip.style.transform = '';
    if (tip.isConnected === false) tip = null;
  }
}

function isFocusVisible(node) {
  try { return Boolean(node?.matches?.(':focus-visible')); } catch { return false; }
}

function clipRectOf(node) {
  const vw = globalThis.innerWidth || 0, vh = globalThis.innerHeight || 0;
  let top = 0, bottom = vh, left = 0, right = vw;
  // スクロール枠と固定のタブ帯（.cx-tabs）の重なりを差し引き、隠れた相手には出さない
  let p = node.parentElement;
  while (p && p !== document.documentElement) {
    const oy = globalThis.getComputedStyle?.(p)?.overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'clip' || oy === 'hidden') {
      const pr = p.getBoundingClientRect?.();
      if (pr) {
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
    }
    p = p.parentElement;
  }
  const tabs = node.closest?.('.cx, .scx')?.querySelector?.('.cx-tabs');
  if (tabs && globalThis.getComputedStyle?.(tabs)?.position === 'sticky') {
    const tr = tabs.getBoundingClientRect?.();
    if (tr && tr.height > 0) top = Math.max(top, tr.bottom);
  }
  return { top, bottom, left, right, vw, vh };
}

/** 出ている吹き出しを消す */
export function hideLockTip() {
  clearTimeout(tm);
  tm = null;
  who = null;
  tapped = null;
  tip?.classList?.remove('on');
}

function place(anchor) {
  if (!tip || !anchor || anchor.isConnected === false) { hideLockTip(); return; }
  const r = anchor.getBoundingClientRect?.();
  if (!r || r.width === 0 || r.height === 0) { hideLockTip(); return; }
  const clip = clipRectOf(anchor);
  if (r.bottom <= clip.top || r.top >= clip.bottom || r.right <= clip.left || r.left >= clip.right) { hideLockTip(); return; }
  const tr = tip.getBoundingClientRect?.();
  const tw = tr?.width ?? 0, th = tr?.height ?? 0;
  const x = Math.max(8, Math.min(r.right - tw, (clip.vw || 9999) - tw - 8));
  let y = r.top - th - 8;
  if (y < clip.top + 4) y = r.bottom + 8;
  tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function show(anchor) {
  if (!anchor?.dataset?.tip || anchor.isConnected === false) return;
  const host = anchor.closest?.('dialog') ?? document.body ?? document.documentElement;
  if (!host?.append) return;
  if (!tip) {
    tip = el('div', 'cx-tip');
    tip.setAttribute('aria-hidden', 'true');
  }
  if (tip.parentElement !== host) host.append(tip);
  who = anchor;
  tip.textContent = anchor.dataset.tip;
  place(anchor);
  if (who === anchor) tip.classList.add('on');
}

/** 1 回だけ文書へリスナーを付ける（Node の DOM スタブなど addEventListener が無いときは何もしない） */
export function ensureLockTips() {
  if (bound || typeof document?.addEventListener !== 'function') return;
  bound = true;
  const targetOf = e => e.target?.closest?.('[data-tip]') ?? null;
  document.addEventListener('pointerover', e => {
    const tNode = targetOf(e);
    if (!tNode || e.pointerType === 'touch') return;
    if (e.relatedTarget?.closest?.('[data-tip]') === tNode) return;
    if (who === tNode && tip?.classList?.contains('on')) { clearTimeout(tm); return; }
    clearTimeout(tm);
    tm = setTimeout(() => { if (tNode.isConnected !== false) show(tNode); }, 150);
  });
  document.addEventListener('pointerout', e => {
    const tNode = targetOf(e);
    if (!tNode) return;
    if (e.relatedTarget?.closest?.('[data-tip]') === tNode) return;
    clearTimeout(tm);
    if (who === tNode && !isFocusVisible(tNode) && tapped !== tNode) hideLockTip();
  });
  document.addEventListener('focusin', e => {
    const tNode = targetOf(e);
    if (!tNode) return;
    clearTimeout(tm);
    if (isFocusVisible(tNode)) { tapped = null; show(tNode); }
  });
  document.addEventListener('focusout', e => {
    const tNode = targetOf(e);
    if (tNode && who === tNode) hideLockTip();
  });
  document.addEventListener('pointerdown', e => {
    lastPointer = e.pointerType || '';
    if (!targetOf(e)) hideLockTip();
  }, true);
  document.addEventListener('click', e => {
    const tNode = targetOf(e);
    if (!tNode) return;
    e.preventDefault();
    e.stopPropagation();
    if (lastPointer === 'touch' || e.pointerType === 'touch') {
      if (tapped === tNode && who === tNode && tip?.classList?.contains('on')) hideLockTip();
      else { tapped = tNode; show(tNode); }
    } else {
      tapped = null;
      show(tNode);
    }
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && who && tip?.classList?.contains('on')) {
      e.preventDefault();
      e.stopPropagation();
      hideLockTip();
    }
  }, true);
  globalThis.window?.addEventListener?.('scroll', () => { if (who) place(who); }, { passive: true, capture: true });
  globalThis.window?.addEventListener?.('resize', hideLockTip, { passive: true });
}

/** テスト間で状態を初期化する */
export const _resetLockTipForTest = () => {
  tip?.remove?.();
  tip = null;
  bound = false;
  resetState();
};
