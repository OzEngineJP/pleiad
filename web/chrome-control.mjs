// エージェントの Chrome の窓を誰が操作しているかの表示（docs/design-system.md「Chrome の窓」、ADR 0148・0154・0296）。
//   - createControlBadge: アドレスバーのすぐ下に出す、人のタブがある間の「AI に戻す」（web/browser-unify.mjs が置く）
//   - createChromeControlView: 一時停止中の帯（会話の中）と、映像の上に重ねる、エージェントが押した位置の輪。単体で描けて試せる。
//     輪は web/chrome-panel.mjs の mountOverlay で映像の箱へ差し込む。撮影を断っている間の薄い幕は映像の側（web/chrome-panel.mjs の .cp-veil）が出す（二重にしない）
//   - chromeControlStore: サーバーの chromeControl・chromeTap イベント（会話ごと）の置き場。右パネルが会話の状態を引く・聞く
//   - renderChromeHandoverLine: 引き継いで戻したときの会話の行（present kind: 'chromeHandover'）
// 状態は core/chrome/control.mjs の 4 つ（running・idle・stopped・paused）。色は既存のトークンだけ。動きは --dur・--ease-out（動きを減らす設定では入れ替えだけ）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';

/** Called only by the unified browser; legacy control remains unchanged. */
export function ensureBrowserControlStyles() {
  if (document.getElementById('browser-control-styles')) return;
  const style = el('style'); style.id = 'browser-control-styles';
  style.textContent = `
 .b2-control{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:4px 12px;font-size:12px;color:var(--ink-weak);min-height:38px;box-sizing:border-box}
.b2-control[hidden],.b2-sheet[hidden],.b2-fallback[hidden],.b2-phone-note[hidden]{display:none!important}
.b2-action{border:0;border-radius:var(--r-pill);background:none;color:var(--ink-blue);padding:6px 10px;font:inherit;cursor:pointer}
.b2-actions{display:flex;justify-content:flex-end;gap:8px}.b2-action.primary{color:var(--ink-blue);background:var(--fill-blue,var(--surface-2))}
.b2-action:hover{background:var(--surface-2)}
.b2-pause,.b2-grow,.b2-control .run{display:none}
.b2-control[data-mode="ai"] .run{display:inline-grid;flex:none}
/* Row while the AI tab is shown (ADR 0321): same height as the human row; the video stays view-only until the button is pressed */
.b2-action.primary{font-weight:600}
.b2-action:focus-visible{outline:2px solid var(--line-blue);outline-offset:2px}
.b2-action.nudge{animation:b2-nudge .9s ease-out}
@keyframes b2-nudge{0%,40%{background:color-mix(in srgb,var(--line-blue) 26%,transparent);box-shadow:0 0 0 2px var(--line-blue)}}
/* On phones, use one row: pause mark, “You are in control”, and “Return to AI” (approved 2026-11-08; temporary/mockups/phone-browser-header.html .bu-held). */
@media(max-width:600px){
 .b2-control{justify-content:flex-start;gap:8px;padding:0 6px 0 14px;min-height:44px;box-sizing:border-box;font-size:13px;color:var(--ink);border-bottom:1px solid var(--line)}
 .b2-control[data-mode="human"] .b2-pause{display:block;position:relative;width:14px;height:14px;flex:none}
 .b2-control[data-mode="ai"] .run{display:inline-grid;flex:none}
 .b2-control .b2-pause::before,.b2-control .b2-pause::after{content:"";position:absolute;top:3px;width:2px;height:8px;border-radius:1px;background:currentColor}
 .b2-control .b2-pause::before{left:4px}.b2-control .b2-pause::after{right:4px}
 .b2-control .b2-grow{display:block;flex:1}
 .b2-control .b2-action{height:36px;padding:0 14px;border:1px solid var(--line);background:var(--surface-paper);color:var(--ink);font-weight:600}
}
.b2-input-surface{position:relative;overflow:hidden;touch-action:none;outline:none}.b2-input-surface:focus-visible{outline:2px solid var(--line-blue);outline-offset:-2px}.b2-ripple{position:absolute;pointer-events:none;width:28px;height:28px;margin:-14px;border-radius:50%;box-shadow:0 0 0 2px var(--line-blue);animation:b2-ripple 550ms var(--ease-out,ease-out) forwards;z-index:3}
@keyframes b2-ripple{from{opacity:.8;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
.b2-phone-input{position:absolute;z-index:4;border:0;padding:0;margin:0;resize:none;opacity:.01;background:transparent;color:transparent;caret-color:transparent;font-size:16px;pointer-events:none;outline:none}
.b2-phone-note{position:fixed;z-index:96;left:8px;right:8px;bottom:8px;padding:6px 10px;border-radius:8px;background:var(--surface-1);box-shadow:0 4px 16px var(--shadow);color:var(--ink-weak);font-size:12px;line-height:1.5;text-align:center;pointer-events:none}
.b2-fallback{position:fixed;z-index:96;left:8px;right:8px;bottom:8px;display:flex;gap:8px;padding:8px;border-radius:12px;background:var(--surface-1);box-shadow:0 8px 28px var(--shadow)}.b2-fallback input{min-width:0;flex:1;font:inherit;font-size:16px;color:var(--ink);background:var(--surface-2);border:0;padding:10px;border-radius:8px}
.b2-sheet{position:fixed;inset:0;z-index:100;display:flex;align-items:flex-end;justify-content:center;background:var(--surface-veil)}.b2-sheet-body{width:min(100%,480px);max-height:70dvh;overflow:auto;padding:20px;box-sizing:border-box;border-radius:16px 16px 0 0;background:var(--surface-1);color:var(--ink);box-shadow:0 -8px 28px var(--shadow)}.b2-sheet-title{font-size:16px;font-weight:600;margin:0 0 12px}.b2-sheet-message{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.b2-sheet-option{display:flex;align-items:center;gap:10px;min-height:44px;font-size:14px}.b2-sheet input[type=text]{box-sizing:border-box;width:100%;font:inherit;font-size:16px;padding:10px;margin:10px 0}.b2-sheet-error{color:var(--ink-strong);font-size:13px;margin:8px 0}
@media(prefers-reduced-motion:reduce){.b2-ripple{animation:none;opacity:.7}.b2-action.nudge{animation:none;outline:2px solid var(--line-blue);outline-offset:2px}}
`;
  document.head.append(style);
}

/**
 * 映像の上の 1 行（アドレスバーのすぐ下）。2 つの形を、同じ高さで入れ替える（ADR 0321）:
 *  - mode 'ai': AI のタブを見ている間。「<名前> が Chrome を操作中 [引き継ぐ]」。映像は見るだけで、[引き継ぐ] を押すと触れる
 *  - mode 'human'（既定）: 人が操作している間。「あなたが操作中 [AI に戻す]」
 * 構成は「II か AI の印・文・押し広げ（.b2-grow）・ボタン」。PC は右寄せの小さな札、スマホはアドレスバーのすぐ下の 1 行（承認済み 2026-11-08・2026-11-12）。
 * role=status で、形が替わるたびに読み上げる。nudge() は見るだけの映像に触れたときに [引き継ぐ] を短く強調する（動きを減らす設定では輪郭だけ）。
 */
export function createControlBadge({ mount, onResume = () => {}, onTakeOver = () => {} } = {}) {
  ensureBrowserControlStyles();
  const element = el('div', 'b2-control'), pause = el('span', 'b2-pause'), run = runMark(), label = el('span', ''), grow = el('span', 'b2-grow');
  pause.setAttribute('aria-hidden', 'true'); run.setAttribute('aria-hidden', 'true');
  element.setAttribute('role', 'status');
  const button = el('button', 'b2-action'); button.type = 'button'; element.hidden = true;
  let mode = null, nudgeTimer = 0;
  const press = fn => async () => { button.disabled = true; try { await fn(); } finally { button.disabled = false; } };
  button.onclick = () => (mode === 'ai' ? press(onTakeOver) : press(onResume))();
  function paint(next, name) {
    if (next === mode && label.dataset.name === (name ?? '')) return;
    mode = next; label.dataset.name = name ?? '';
    element.dataset.mode = mode;
    if (mode === 'ai') { label.textContent = t('browser.entryState.working', { name: name || 'AI' }); button.textContent = t('control:takeOver'); button.classList.add('primary'); }
    else { label.textContent = t('control:humanOperating'); button.textContent = t('tabs:display.resume'); button.classList.remove('primary'); }
    button.classList.remove('nudge');
  }
  element.append(pause, run, label, grow, button); mount?.append(element);
  paint('human');
  return {
    element, button,
    update({ visible = false, mode: next = 'human', name = '' } = {}) { paint(next === 'ai' ? 'ai' : 'human', name); element.hidden = !visible; },
    /** 見るだけの映像に触れた。[引き継ぐ] を短く強調する（続けて触れても 0.9 秒の間は重ねない） */
    nudge() {
      if (mode !== 'ai' || element.hidden || button.classList.contains('nudge')) return;
      button.classList.add('nudge');
      clearTimeout(nudgeTimer); nudgeTimer = setTimeout(() => button.classList.remove('nudge'), 900);
    },
    destroy() { clearTimeout(nudgeTimer); element.remove(); },
  };
}

export const CONTROL_STATES = ['running', 'idle', 'stopped', 'paused'];

/** 経過時間（1 分 12 秒・45 秒） */
export function durationText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? t('chromeControl.duration.minutes', { m, s }) : t('chromeControl.duration.seconds', { s });
}

/** 押した位置の輪が残る時間（ms）。輪の動きは CSS（動きを減らす設定では薄く出て消えるだけ） */
const RING_MS = 700;

/**
 * @param {object} o
 * @param {() => Promise<any>} o.resume  帯の「AI に戻す」を押したときに呼ぶ（browser.chromeResume。人のタブを全部戻すのはサーバー側）
 * @param {() => string} [o.getName]  エージェントの名前（行・記録のための呼び名。戻すボタンの語は「AI に戻す」で固定）
 * @param {(error: Error) => void} [o.onError]
 * @returns {{ banner: HTMLElement, overlay: HTMLElement, apply: (next: {state: string, since?: number|null, error?: string|null}|null) => void,
 *            ring: (x: number, y: number, size?: {width: number, height: number}) => void, state: () => string|null, refresh: () => void }}
 */
export function createChromeControlView({ resume, getName = () => 'Claude', onError = () => {} } = {}) {
  let current = null, showBanner = true;
  let busy = false;
  const label = () => t('chromeControl.resume', { name: getName() });
  const act = () => {
    if (busy) return;
    busy = true; paint();
    Promise.resolve().then(() => resume()).catch(error => onError(error)).finally(() => { busy = false; paint(); });
  };

  // 一時停止中の帯（会話の中。「一時停止中 · あなたが Chrome で操作しています」）
  // 帯は role=status にしない（アドレスバーの札が同じことを示すので、二重にしない）
  const banner = el('div', 'cc-banner'); banner.hidden = true;
  const bannerText = el('span', 'cc-banner-text');
  const bannerBtn = el('button', 'btn cc-btn', label()); bannerBtn.type = 'button';
  bannerBtn.onclick = act;
  banner.append(bannerText, bannerBtn);

  // 映像の上に重ねる層（親が position: relative の枠に入れる）。押した位置の輪だけを出す
  const overlay = el('div', 'cc-overlay'); overlay.setAttribute('aria-hidden', 'true');

  function paint() {
    const state = current?.state ?? null;
    banner.hidden = state !== 'paused' || !showBanner;
    overlay.dataset.state = state ?? '';
    if (!state) return;
    bannerText.textContent = current.error === 'conceal-failed' ? t('chromeControl.error.concealFailed') : t('chromeControl.banner');
    bannerBtn.textContent = label(); bannerBtn.disabled = busy;
  }

  /** 押した位置に輪を出す。(x, y) は押した位置（ページの CSS 画素）、size は映像の元のページの大きさ。大きさが分からなければ出さない（位置を偽らない） */
  function ring(x, y, size = null) {
    const w = Number(size?.width), h = Number(size?.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return;
    const node = el('span', 'cc-ring');
    node.style.left = `${Math.max(0, Math.min(100, (x / w) * 100))}%`;
    node.style.top = `${Math.max(0, Math.min(100, (y / h) * 100))}%`;
    overlay.append(node);
    setTimeout(() => node.remove(), RING_MS);
  }

  return {
    banner, overlay, ring,
    /** banner: 会話の中の一時停止の帯を出すか（右パネルが子の会話を映している間は、帯の会話と状態の会話が違うので出さない） */
    apply(next, { banner = true } = {}) { showBanner = banner; current = next && CONTROL_STATES.includes(next.state) ? { state: next.state, since: next.since ?? null, error: next.error ?? null, by: next.by ?? null } : null; paint(); },
    state: () => current?.state ?? null,
    refresh: paint,
  };
}

/**
 * サーバーの chromeControl（会話ごとの状態）と chromeTap（押した位置）の置き場。画面（web/client.mjs）が event を渡し、右パネルが get・onChange・onTap で引く。
 * 待機中（idle）の会話は持たない
 */
export function createChromeControlStore() {
  const states = new Map();
  const changes = new Set(), taps = new Set();
  const fire = (set, ...args) => { for (const fn of [...set]) { try { fn(...args); } catch { /* 聞き手の失敗は置き場を壊さない */ } } };
  return {
    event(ev) {
      if (!ev?.sessionId) return;
      if (ev.type === 'chromeControl') {
        if (!CONTROL_STATES.includes(ev.state)) return;
        const was = states.get(ev.sessionId);
        const before = was?.state ?? 'idle';
        const by = ev.state === 'paused' && (ev.by === 'device' || ev.by === 'pc') ? ev.by : null;
        if (ev.state === 'idle') states.delete(ev.sessionId); else states.set(ev.sessionId, { state: ev.state, since: ev.since ?? null, error: ev.error ?? null, by });
        if (before !== ev.state || (was?.error ?? null) !== (ev.error ?? null) || (was?.by ?? null) !== by) fire(changes, ev.sessionId, ev.state, ev.since ?? null);
      } else if (ev.type === 'chromeTap') fire(taps, { sessionId: ev.sessionId, x: ev.x, y: ev.y, windowId: ev.windowId ?? null });
    },
    /** 会話の今の状態（イベントが無い会話は idle）。by は一時停止中に誰が操作しているか（pc・device。第 7 段） */
    get: sessionId => states.get(sessionId) ?? { state: 'idle', since: null, error: null, by: null },
    onChange(fn) { changes.add(fn); return () => changes.delete(fn); },
    onTap(fn) { taps.add(fn); return () => taps.delete(fn); },
    /** 全部の会話の状態を捨てる（接続し直したとき。サーバーは続けて今の分を送る）。持っていた状態は idle として聞き手へ知らせる */
    clear() { const ids = [...states.keys()]; states.clear(); for (const id of ids) fire(changes, id, 'idle', null); },
  };
}

/** 今の会話のエージェント名（閉じた行に使う。web/client.mjs が入れる） */
let agentName = () => 'Claude';
export const setChromeHandoverAgentName = fn => { if (typeof fn === 'function') agentName = fn; };
// 閉じた窓の静止画は、持ち主の会話を見ている要求にだけサーバーが見せる（core/chrome/window-shots.mjs）。今見ている会話の id を渡す
let currentSession = () => null;
export const setChromeClosedSession = fn => { if (typeof fn === 'function') currentSession = fn; };

const handIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5l-2 3-2-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' }));
  return svg;
};

/** 引き継いで戻したときの会話の行（present kind: 'chromeHandover'。chromeHandover: { seconds }）。「あなたが引き継ぎ · AI に戻しました · 1 分 12 秒」 */
export function renderChromeHandoverLine(ev) {
  const row = el('div', 'cc-line');
  const icon = el('span', 'cc-line-ic'); icon.setAttribute('aria-hidden', 'true'); icon.append(handIcon());
  row.append(icon, el('span', 'cc-line-t', t('chromeControl.handover', { duration: durationText(ev?.chromeHandover?.seconds) })));
  return row;
}

/** 窓を閉じた行と、最後の静止画。画像が無いときも行は残す。 */
export function renderChromeClosedLine(ev) {
  // i18n-dynamic: chromeControl.closed.
  const box = el('div', 'cc-closed');
  const by = ['agent', 'idle'].includes(ev?.chromeClosed?.by) ? ev.chromeClosed.by : 'human';
  const row = el('div', 'cc-line');
  row.append(el('span', 'cc-line-t', t(`chromeControl.closed.${by}`, { name: agentName() })));
  box.append(row);
  if (typeof ev?.path === 'string' && ev.path) {
    const shot = el('img', 'cc-closed-shot');
    const owner = currentSession();
    shot.src = `/local-file?path=${encodeURIComponent(ev.path)}${owner ? `&sessionId=${encodeURIComponent(owner)}` : ''}`;
    shot.alt = t('chromeControl.closed.image');
    shot.loading = 'lazy';
    shot.dataset.filePath = ev.path;
    box.append(shot);
  }
  return box;
}

/**
 * タブごとの持ち手（tab:holder イベント）の置き場。会話に「人が触っているタブ」があるかを会話単位で答える（ADR 0296）。
 * 見ているタブの持ち手だけで判断すると、別のタブを開いたときに「AI に戻す」が消えるので、会話の全部のタブで持つ。
 * tab:info の棚と揃える: 棚から消えたタブ・棚の張り替え（reset）では、その会話の持ち手も捨てる
 */
export function createTabHolderStore() {
  const tabs = new Map();   // sessionId -> Map<targetId, { holder, by, pinned }>
  const listeners = new Set();
  const human = entry => entry?.holder === 'human';
  const countHuman = map => { let n = 0; for (const e of map?.values() ?? []) if (human(e)) n++; return n; };
  const fire = (sessionId, any) => { for (const fn of [...listeners]) { try { fn(sessionId, any); } catch { /* 聞き手の失敗は置き場を壊さない */ } } };
  return {
    event(ev) {
      const sessionId = ev?.sessionId;
      if (!sessionId) return;
      if (ev.type === 'tab:info') {
        if (ev.reset === true) {
          // 棚の張り替え。会話の持ち手は全部捨てる
          const map = tabs.get(sessionId);
          if (!map?.size) return;
          const was = countHuman(map) > 0;
          tabs.delete(sessionId);
          if (was) fire(sessionId, false);
          return;
        }
        if (ev.removed === true && ev.targetId) {
          // 棚から消えたタブの持ち手も消す（普通の題・URL の便りでは触らない）
          const map = tabs.get(sessionId);
          if (!map?.has(ev.targetId)) return;
          const was = human(map.get(ev.targetId));
          map.delete(ev.targetId); if (!map.size) tabs.delete(sessionId);
          if (was && countHuman(map) === 0) fire(sessionId, false);
        }
        return;
      }
      if (ev.type !== 'tab:holder' || !ev.targetId) return;
      let map = tabs.get(sessionId);
      if (!map) { map = new Map(); tabs.set(sessionId, map); }
      const before = countHuman(map) > 0;
      if (ev.holder === 'human') map.set(ev.targetId, { holder: 'human', by: ev.by ?? null, pinned: ev.pinned === true });
      else { map.delete(ev.targetId); if (!map.size) tabs.delete(sessionId); }
      const after = countHuman(map) > 0;
      if (before !== after) fire(sessionId, after);
    },
    /** 会話に人が触っているタブがあるか（見ているタブとは無関係） */
    anyHuman: sessionId => countHuman(tabs.get(sessionId)) > 0,
    /** タブの今の持ち手（無ければ ai） */
    holderOf: (sessionId, targetId) => tabs.get(sessionId)?.get(targetId) ?? { holder: 'ai', by: null, pinned: false },
    /** 人が触っているタブの一覧（{ targetId, holder, by, pinned }） */
    held: sessionId => [...(tabs.get(sessionId) ?? new Map())].filter(([, e]) => human(e)).map(([targetId, e]) => ({ targetId, ...e })),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** 全部の会話の持ち手を捨てる（接続し直したとき。サーバーは続けて今の分を送る） */
    clear() { const had = [...tabs.entries()].filter(([, map]) => countHuman(map) > 0).map(([id]) => id); tabs.clear(); for (const id of had) fire(id, false); },
  };
}

export const chromeControlStore = createChromeControlStore();
