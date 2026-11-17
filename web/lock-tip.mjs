// ==================== 鍵付きの項目（変更できない理由）の吹き出し ====================
// 追補 1（2026-11-15 承認）。見た目は .tc-when-pop（web/tools.css）と同じ浮く面（--surface-paper + 影）。
// 対象（[data-tip]）へホバー（150ms）・キーボードのフォーカス（:focus-visible）・タップのいずれでも同じ吹き出しを出す。
// 押しても状態は変えず（click を止める）、Esc（焦点を残す）・外を押す・フォーカスが外れる・スクロールで相手が見えなくなる・窓のリサイズで消す。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

// nolinks: ユーザーの設定だけ止められるエージェント（Devin）で、この PC ではリンクを作れない（Windows の開発者モードが off。ADR 0336）
// bundled: 止めると Hooks・プラグインも一緒に止まる（Antigravity の Skills。ADR 0337）
// devinHooks: その場所では Pleiad が Devin へ Hook を渡すため、Devin の取り込みが止まって読まれない（ADR 0338。段 2 のレビュー S2）
export const LOCK_REASONS = new Set(['own', 'workspace', 'relay', 'admin', 'linked', 'nolinks', 'bundled', 'devinHooks']);

// i18n-dynamic: context.lockReason.
/** セル（{ mode, reason? }）から理由のキーを選ぶ。reason が無ければ mode から決める */
export function lockReasonKey(cell) {
  if (LOCK_REASONS.has(cell?.reason)) return cell.reason;
  return cell?.mode === 'blocked' ? 'relay' : 'own';
}

/** エージェント名とセルから吹き出しの文を作る。cell.tip があればそれ（Hooks の表は理由の細目 detail ごとの文。web/hooks-matrix.mjs） */
export function lockReasonText(agentName, cell) {
  if (typeof cell?.tip === 'string' && cell.tip) return cell.tip;
  return t(`context.lockReason.${lockReasonKey(cell)}`, { agent: agentName });
}

/**
 * 理由が 2 つ以上あるとき、理由ごとに 1 行にした文字列（同じ文は 1 回）。無ければ null。
 * 吹き出し（.cx-tip の white-space: pre-line）はこの改行をそのまま行の区切りにする。「／」でつないで 1 文にはしない
 */
export function joinLockReasons(reasons) {
  const lines = [...new Set([].concat(reasons ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  return lines.length ? lines.join('\n') : null;
}

/**
 * 読み上げ用の理由。改行は読み上げでは区切りにならないので、理由が 2 つ以上なら 1 つずつ文として終える（「…。…。」）。
 * 1 つだけならそのまま。文の終わりの記号がすでにある行は足さない
 */
export function spokenLockReason(reason) {
  const lines = String(reason ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return lines[0] ?? '';
  return lines.map((l) => (/[。．.!?！？]$/.test(l) ? l : t('context.lockAriaSentence', { reason: l }))).join(' ');
}

/** 読み上げ名「{元の名前}（{理由}）」を作る。理由が複数行なら文として区切って読ませる */
export function lockAriaLabel(baseLabel, reason) {
  return t('context.lockAria', { label: baseLabel, reason: spokenLockReason(reason) });
}

let bound = false, tip = null, who = null, tapped = null, tm = null, lastPointer = '', watch = null;

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
  watch?.disconnect?.();
  tip?.classList?.remove('on');
}

/** ロゴ・名前だけの描き直しで、開いている鍵の吹き出しを同じ位置の新しい相手へ移す。 */
export function preserveLockTip(root) {
  if (!who || !tip?.classList.contains('on') || !root.contains(who)) return () => {};
  const route = [], wasTapped = tapped === who;
  for (let node = who; node !== root; node = node.parentElement) route.unshift(Array.from(node.parentElement.children).indexOf(node));
  return () => {
    const anchor = route.reduce((node, index) => node?.children[index], root);
    if (!anchor?.dataset?.tip) { hideLockTip(); return; }
    if (wasTapped) tapped = anchor;
    show(anchor);
  };
}

/** 出ている間だけ、相手が描き直しで外されていないかを見る（外されたら消す。マウスがまだ同じ鍵の上なら出し直す） */
function watchAnchor() {
  if (typeof MutationObserver !== 'function' || !document.body) return;
  watch ??= new MutationObserver(() => {
    if (!who || who.isConnected !== false) return;
    hideLockTip();
    let again = null;
    try { again = document.querySelector('[data-tip]:hover'); } catch { /* :hover を使えない環境では出し直さない */ }
    if (again) tm = setTimeout(() => { if (again.isConnected !== false) show(again); }, 150);
  });
  watch.disconnect();
  watch.observe(document.body, { childList: true, subtree: true });
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
  if (who === anchor) { tip.classList.add('on'); watchAnchor(); }
}

/** 1 回だけ文書へリスナーを付ける（Node の DOM スタブなど addEventListener が無いときは何もしない） */
export function ensureLockTips() {
  if (bound || typeof document?.addEventListener !== 'function') return;
  bound = true;
  const targetOf = e => e.target?.closest?.('[data-tip]') ?? null;
  // 全体のスイッチの中の鍵（data-tip-pass）。スイッチにフォーカスが来たら、その鍵の理由を出す（押す動きは止めない）
  const passOf = node => { try { return node?.querySelector?.(':scope > [data-tip-pass]') ?? null; } catch { return null; } };
  const focusTargetOf = e => targetOf(e) ?? passOf(e.target);
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
    const tNode = focusTargetOf(e);
    if (!tNode) return;
    clearTimeout(tm);
    if (isFocusVisible(tNode.hasAttribute?.('data-tip-pass') ? e.target : tNode)) { tapped = null; show(tNode); }
  });
  document.addEventListener('focusout', e => {
    const tNode = focusTargetOf(e);
    if (tNode && who === tNode) hideLockTip();
  });
  document.addEventListener('pointerdown', e => {
    lastPointer = e.pointerType || '';
    if (!targetOf(e)) hideLockTip();
  }, true);
  document.addEventListener('click', e => {
    const tNode = targetOf(e);
    if (!tNode) return;
    const touch = lastPointer === 'touch' || e.pointerType === 'touch';
    // 全体のスイッチの中の鍵は、マウス・キーボードの押しは通す（スイッチとして押せる）。タッチで鍵そのものを押したときだけ理由を出す
    if (tNode.hasAttribute?.('data-tip-pass') && !touch) { hideLockTip(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (touch) {
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
  watch?.disconnect?.();
  watch = null;
  tip?.remove?.();
  tip = null;
  bound = false;
  resetState();
};
