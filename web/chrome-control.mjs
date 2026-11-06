// エージェントの Chrome の窓の「状態の一行」と止める・引き継ぐ・戻す（docs/design-system.md「Chrome の窓の状態の一行」、ADR 0148・0154）。
//   - createChromeControlView: 状態の一行（role=status。ボタンは「止める」「引き継ぐ」「Claude に戻す」）・一時停止中の帯（会話の中）・
//     映像の上に重ねる、エージェントが押した位置の輪。単体で描けて試せる。右パネルの「Chrome の窓」へは web/chrome-panel.mjs の mountStatus（root）・mountOverlay（overlay）で差し込む。
//     撮影を断っている間の薄い幕と「映像を止めています」は映像の側（web/chrome-panel.mjs の .cp-veil）が出す（二重にしない）
//   - chromeControlStore: サーバーの chromeControl・chromeTap イベント（会話ごと）の置き場。右パネルが会話の状態を引く・聞く
//   - renderChromeHandoverLine: 引き継いで戻したときの会話の行（present kind: 'chromeHandover'）
// 状態は core/chrome/control.mjs の 4 つ（running・idle・stopped・paused）。色は既存のトークンだけ。動きは --dur・--ease-out（動きを減らす設定では入れ替えだけ）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { chevRightIcon } from './icons.mjs';

/** Called only by the unified browser; legacy control remains unchanged. */
export function ensureBrowserControlStyles() {
  if (document.getElementById('browser-control-styles')) return;
  const style = el('style'); style.id = 'browser-control-styles';
  style.textContent = `
.b2-control{position:relative;flex:0 1 84px;min-width:26px;container-type:inline-size;width:84px}
.b2-control[hidden],.b2-pop[hidden],.b2-strip[hidden],.b2-full[hidden],.b2-sheet[hidden],.b2-fallback[hidden]{display:none!important}
.b2-chip{display:flex;align-items:center;justify-content:center;gap:6px;height:26px;width:100%;border:0;border-radius:13px;background:transparent;color:var(--ink);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.b2-chip:hover,.b2-chip[aria-expanded=true]{background:var(--surface-2)}
.b2-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ink-blue);flex:none}
.b2-dot[hidden]{display:none}
.b2-dot[data-holder=human]{background:var(--ink-strong)}.b2-dot[data-waiting=true]{background:var(--ink-mark)}
.b2-tab-dot{margin-inline-start:5px;vertical-align:middle}
.b2-pop{position:fixed;z-index:90;width:256px;box-sizing:border-box;padding:14px;border-radius:12px;background:var(--surface-paper);box-shadow:0 8px 28px var(--shadow);color:var(--ink);text-align:left;font-size:13px}
.b2-pop-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}.b2-pop-sub{margin:4px 0 12px 15px;color:var(--ink-weak);font-size:12px;line-height:1.65}
.b2-actions{display:flex;justify-content:flex-end;gap:8px}.b2-action{border:0;border-radius:var(--r-pill,16px);background:var(--surface-2);color:var(--ink);padding:6px 13px;font:inherit;cursor:pointer}.b2-action.primary{color:var(--ink-blue);background:var(--fill-blue,var(--surface-2))}
.b2-strip{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;height:52px;border-radius:var(--r-m,10px);padding:0 6px;background:var(--surface-2);color:var(--ink);font-size:14px}
.b2-strip-open{display:flex;align-items:center;gap:10px;flex:1;min-width:0;height:100%;border:0;padding:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}.b2-strip-resume{flex:none;font-size:13px;padding:6px 14px}.b2-strip-resume[hidden],.b2-chevron[hidden]{display:none}
.b2-thumb{width:60px;height:40px;object-fit:cover;object-position:top;border-radius:8px;background:var(--surface-paper);flex:none}.b2-strip-info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1px;line-height:1.25}.b2-domain{font-size:13px;font-weight:600;color:var(--ink-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.b2-strip-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-weak)}.b2-count{flex:none;box-sizing:border-box;display:grid;place-items:center;min-width:20px;height:20px;padding:0 3px;border:2px solid currentColor;border-radius:5px;font-size:11px;font-weight:700;line-height:1;color:var(--ink)}.b2-chevron{display:grid;place-items:center;width:22px;height:22px;flex:none;margin-right:2px;color:var(--ink-weak)}.b2-chevron svg{width:18px;height:18px}
.b2-full{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;background:var(--surface-1);transform:translateY(100%);transition:transform 260ms var(--ease-out,ease-out)}.b2-full[data-open=true]{transform:translateY(0)}.b2-full-close{align-self:flex-start;min-height:44px;margin:0 8px;background:transparent;border:0;color:var(--ink);font:inherit;cursor:pointer}.b2-full-content{flex:1;min-height:0;display:flex;flex-direction:column}
.b2-input-surface{position:relative;overflow:hidden;touch-action:none;outline:none}.b2-input-surface:focus-visible{outline:2px solid var(--line-blue);outline-offset:-2px}.b2-ripple{position:absolute;pointer-events:none;width:28px;height:28px;margin:-14px;border-radius:50%;box-shadow:0 0 0 2px var(--line-blue);animation:b2-ripple 550ms var(--ease-out,ease-out) forwards;z-index:3}
@keyframes b2-ripple{from{opacity:.8;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
.b2-phone-input{position:absolute;z-index:4;border:0;padding:0;margin:0;resize:none;opacity:.01;background:transparent;color:transparent;caret-color:transparent;font-size:16px;pointer-events:none;outline:none}
.b2-fallback{position:fixed;z-index:96;left:8px;right:8px;bottom:8px;display:flex;gap:8px;padding:8px;border-radius:12px;background:var(--surface-1);box-shadow:0 8px 28px var(--shadow)}.b2-fallback input{min-width:0;flex:1;font:inherit;font-size:16px;color:var(--ink);background:var(--surface-2);border:0;padding:10px;border-radius:8px}
.b2-sheet{position:fixed;inset:0;z-index:100;display:flex;align-items:flex-end;justify-content:center;background:var(--surface-veil)}.b2-sheet-body{width:min(100%,480px);max-height:70dvh;overflow:auto;padding:20px;box-sizing:border-box;border-radius:16px 16px 0 0;background:var(--surface-1);color:var(--ink);box-shadow:0 -8px 28px var(--shadow)}.b2-sheet-title{font-size:16px;font-weight:600;margin:0 0 12px}.b2-sheet-message{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.b2-sheet-option{display:flex;align-items:center;gap:10px;min-height:44px;font-size:14px}.b2-sheet input[type=text]{box-sizing:border-box;width:100%;font:inherit;font-size:16px;padding:10px;margin:10px 0}.b2-sheet-error{color:var(--ink-strong);font-size:13px;margin:8px 0}
@container(max-width:40px){.b2-chip-label{display:none}}
@media(prefers-reduced-motion:reduce){.b2-full{transition:none}.b2-ripple{animation:none;opacity:.7}}
`;
  document.head.append(style);
}

/** Mount inside the address-bar slot; update from chromeControl + tab:holder. */
export function createControlBadge({ mount, onStop = () => {}, onResume = () => {} } = {}) {
  ensureBrowserControlStyles();
  const root = el('div', 'b2-control'), button = el('button', 'b2-chip'), dot = el('span', 'b2-dot'), label = el('span', 'b2-chip-label');
  const popup = el('div', 'b2-pop'), heading = el('div', 'b2-pop-title'), stateDot = el('span', 'b2-dot'), title = el('span');
  const subtitle = el('p', 'b2-pop-sub'), actions = el('div', 'b2-actions'), action = el('button', 'b2-action');
  button.type = action.type = 'button'; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
  dot.setAttribute('aria-hidden', 'true'); stateDot.setAttribute('aria-hidden', 'true');
  heading.append(stateDot, title); actions.append(action); popup.append(heading, subtitle, actions);
  popup.setAttribute('role', 'dialog'); popup.hidden = true; button.append(dot, label); root.append(button); document.body.append(popup); mount?.append(root);
  let state = {}, pending = false;
  const close = (restore = false) => { popup.hidden = true; button.setAttribute('aria-expanded', 'false'); if (restore) button.focus(); };
  const outside = event => { if (!root.contains(event.target) && !popup.contains(event.target)) close(); };
  const key = event => { if (event.key === 'Escape' && !popup.hidden) { event.stopPropagation(); close(true); } };
  const place = () => { const rect = button.getBoundingClientRect(); popup.style.top = `${rect.bottom + 8}px`; popup.style.left = `${Math.max(8, Math.min(innerWidth - 264, rect.right - 256))}px`; };
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); window.addEventListener('resize', close);
  button.addEventListener('click', () => { const open = popup.hidden; popup.hidden = !open; button.setAttribute('aria-expanded', String(open)); if (open) { place(); action.focus(); } });
  action.addEventListener('click', async () => {
    if (pending) return; pending = true; action.disabled = true;
    try { await (state.holder === 'human' || state.paused ? onResume() : onStop()); close(true); }
    catch { subtitle.textContent = t('control:failed'); }
    finally { pending = false; action.disabled = false; }
  });
  function update(next = {}) {
    state = next;
    root.hidden = !next.agentUsed;
    const human = next.holder === 'human', name = next.name || 'Claude';
    label.textContent = human ? t('control:you') : name;
    title.textContent = human ? t('control:humanOperating') : next.paused ? t('control:stopped') : next.waiting ? t('control:waiting') : t('control:agentOperating', { name });
    subtitle.textContent = human ? t('control:returnsAfterIdle') : next.paused ? t('control:resumeHint', { name }) : t('control:touchHint');
    button.setAttribute('aria-label', title.textContent); popup.setAttribute('aria-label', title.textContent);
    action.textContent = human || next.paused ? t('control:resume') : t('control:stop');
    action.classList.toggle('primary', human || !!next.paused);
    for (const node of [dot, stateDot]) { node.dataset.holder = human ? 'human' : 'ai'; node.dataset.waiting = String(!!next.waiting); }
    if (root.hidden) close();
  }
  update();
  return { element: root, update, close, destroy() { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', close); root.remove(); popup.remove(); } };
}

/** Mount beside a tab title; active means the agent is currently operating this tab. */
export function createTabActivityDot({ mount } = {}) {
  ensureBrowserControlStyles();
  const element = el('span', 'b2-dot b2-tab-dot'); element.hidden = true; element.setAttribute('aria-hidden', 'true'); mount?.append(element);
  return { element, update({ active = false, holder = 'ai', waiting = false } = {}) { element.hidden = !active && holder !== 'human'; element.dataset.holder = holder; element.dataset.waiting = String(waiting); } };
}

/** Supply browser content (tabs/address/frame). Mount the strip above the phone composer. */
/** onActivate: 帯を押したときに全画面へ移さず、呼び出し側が開く（旗が on の右の欄。web/browser-unify.mjs）。
 *  onResume: 人が操作している間は「›」の代わりに「任せる」を出す（モックの §1） */
export function createPhoneBrowserStrip({ mount, content, backMount, onOpen = () => {}, onClose = () => {}, onActivate = null, onResume = null } = {}) {
  ensureBrowserControlStyles();
  const element = el('div', 'b2-strip'), opener = el('button', 'b2-strip-open'), thumb = el('img', 'b2-thumb'), info = el('span', 'b2-strip-info'), domain = el('span', 'b2-domain');
  const status = el('span', 'b2-strip-status'), dot = el('span', 'b2-dot'), statusText = el('span'), count = el('span', 'b2-count'), arrow = el('span', 'b2-chevron');
  const resume = el('button', 'b2-action primary b2-strip-resume', t('control:resume'));
  arrow.innerHTML = chevRightIcon;
  thumb.alt = ''; dot.setAttribute('aria-hidden', 'true'); arrow.setAttribute('aria-hidden', 'true'); opener.type = resume.type = 'button'; opener.setAttribute('aria-expanded', 'false'); resume.hidden = true;
  status.append(dot, statusText); info.append(domain, status); opener.append(thumb, info, count, arrow); element.append(opener, resume); mount?.append(element);
  resume.addEventListener('click', async () => { resume.disabled = true; try { await onResume?.(); } catch {} finally { resume.disabled = false; } });
  const fullscreen = el('div', 'b2-full'), back = el('button', 'b2-full-close', t('control:backToConversation')), body = el('div', 'b2-full-content');
  back.type = 'button'; fullscreen.hidden = true; fullscreen.setAttribute('role', 'dialog'); fullscreen.setAttribute('aria-label', t('control:browser'));
  if (backMount) { back.textContent = '‹'; back.setAttribute('aria-label', t('control:backToConversation')); back.style.fontSize = '24px'; back.style.minWidth = '36px'; backMount.append(back); fullscreen.append(body); }
  else fullscreen.append(back, body);
  document.body.append(fullscreen);
  let placeholder = null, timer = null, ticker = null, openState = false;
  function close() {
    if (!openState) return; openState = false; fullscreen.dataset.open = 'false'; opener.setAttribute('aria-expanded', 'false');
    clearTimeout(timer); timer = setTimeout(() => { if (openState) return; fullscreen.hidden = true; if (placeholder && content) { placeholder.replaceWith(content); placeholder = null; } onClose(); opener.focus(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
  }
  function open() {
    if (openState) return; openState = true; clearTimeout(timer);
    if (content && !placeholder) { placeholder = document.createComment('browser-position'); content.replaceWith(placeholder); body.append(content); }
    fullscreen.hidden = false; fullscreen.getBoundingClientRect(); fullscreen.dataset.open = 'true'; opener.setAttribute('aria-expanded', 'true'); back.focus(); onOpen();
  }
  const key = event => { if (event.key === 'Escape' && openState) { event.stopPropagation(); close(); } };
  fullscreen.addEventListener('keydown', key); back.addEventListener('click', close); opener.addEventListener('click', () => onActivate ? onActivate() : open());
  return { element, fullscreen, back, open, close,
    /** title: Pleiad のページのタブはホスト名（localhost）でなく、ファイルの名前やページの名前を出す */
    update({ url = '', title = '', tabs = 0, holder = 'ai', name = 'Claude', image = null, remaining = null, last = null, pinned = false } = {}) {
      if (title) domain.textContent = title;
      else try { domain.textContent = new URL(url).hostname || t('control:browser'); } catch { domain.textContent = t('control:browser'); }
      const human = holder === 'human' && !!onResume; resume.hidden = !human; arrow.hidden = human;
      count.textContent = String(tabs); count.setAttribute('aria-label', t('control:tabCount', { count: tabs }));
      clearInterval(ticker); ticker = null;
      const deadline = !pinned && holder === 'human' ? Number.isFinite(last) ? last + 60_000 : Number.isFinite(remaining) ? Date.now() + remaining * 1000 : null : null;
      const renderStatus = () => { statusText.textContent = holder === 'human' ? deadline == null ? t('control:humanOperating') : t('control:returnsIn', { seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) }) : t('control:agentOperating', { name }); };
      renderStatus(); if (deadline != null) ticker = setInterval(renderStatus, 1000);
      dot.dataset.holder = holder; if (image) thumb.src = image; else thumb.removeAttribute('src');
    },
    destroy() { clearTimeout(timer); clearInterval(ticker); if (placeholder && content) placeholder.replaceWith(content); back.remove(); element.remove(); fullscreen.remove(); } };
}

export const CONTROL_STATES = ['running', 'idle', 'stopped', 'paused'];

/** 状態の一行の語（running は {{name}} が操作中。リモートの端末で PC が引き継いでいる間は「PC で操作中」）。state が無ければ null */
export function statusText(state, name, error = null, { by = null, remote = false } = {}) {
  if (error === 'conceal-failed') return t('chromeControl.error.concealFailed');
  if (state === 'running') return t('chromeControl.status.running', { name });
  if (state === 'idle') return t('chromeControl.status.idle');
  if (state === 'paused') return remote && by === 'pc' ? t('chromeControl.status.pausedPc') : t('chromeControl.status.paused');
  if (state === 'stopped') return t('chromeControl.status.stopped');
  return null;
}

/** 状態ごとに出すボタン（上から順）。止めた・待機中は「引き継ぐ」だけ。一時停止中は「戻す」だけ（待機中の「Chrome で開く」は「引き継ぐ」に一本化。ADR 0154） */
export function actionsFor(state) {
  if (state === 'running') return ['stop', 'takeOver'];
  if (state === 'paused') return ['resume'];
  if (state === 'idle' || state === 'stopped') return ['takeOver'];
  return [];
}

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
 * @param {(action: 'takeOver'|'resume'|'stop') => Promise<any>} o.run  押されたときに呼ぶ（browser.chromeTakeOver・chromeResume・chromeStop の呼び出し）
 * @param {() => string} [o.getName]  エージェントの名前（「Claude が操作中」「Claude に戻す」）
 * @param {(error: Error, action: string) => void} [o.onError]
 * @returns {{ root: HTMLElement, banner: HTMLElement, overlay: HTMLElement, apply: (next: {state: string, since?: number|null, error?: string|null}|null) => void,
 *            ring: (x: number, y: number, size?: {width: number, height: number}) => void, state: () => string|null, refresh: () => void }}
 */
export function createChromeControlView({ run, getName = () => 'Claude', onError = () => {}, remote = () => false } = {}) {
  let current = null, showBanner = true;
  let busy = false;
  const root = el('div', 'cc'); root.hidden = true;
  const status = el('span', 'cc-status'); status.setAttribute('role', 'status');
  const dot = el('span', 'cc-dot'); dot.setAttribute('aria-hidden', 'true');
  const text = el('span', 'cc-text');
  status.append(dot, text);
  const buttons = new Map();
  const labels = { stop: () => t('chromeControl.stop'), takeOver: () => t('chromeControl.takeOver'), resume: () => t('chromeControl.resume', { name: getName() }) };
  const act = action => {
    if (busy) return;
    busy = true; paint();
    Promise.resolve().then(() => run(action)).catch(error => onError(error, action)).finally(() => { busy = false; paint(); });
  };
  for (const action of ['stop', 'takeOver', 'resume']) {
    const b = el('button', 'btn cc-btn', labels[action]()); b.type = 'button';
    b.hidden = true; b.onclick = () => act(action);
    buttons.set(action, b);
  }
  root.append(status, ...buttons.values());

  // 一時停止中の帯（会話の中。「一時停止中 · あなたが Chrome で操作しています」）
  // 帯は role=status にしない（状態の一行が同じことを読み上げるので、二重にしない）
  const banner = el('div', 'cc-banner'); banner.hidden = true;
  const bannerText = el('span', 'cc-banner-text');
  const bannerBtn = el('button', 'btn cc-btn', labels.resume()); bannerBtn.type = 'button';
  bannerBtn.onclick = () => act('resume');
  banner.append(bannerText, bannerBtn);

  // 映像の上に重ねる層（親が position: relative の枠に入れる）。押した位置の輪だけを出す
  const overlay = el('div', 'cc-overlay'); overlay.setAttribute('aria-hidden', 'true');

  function paint() {
    const state = current?.state ?? null;
    root.hidden = !state;
    root.dataset.state = state ?? '';
    banner.hidden = state !== 'paused' || !showBanner;
    overlay.dataset.state = state ?? '';
    if (!state) return;
    text.textContent = statusText(state, getName(), current.error, { by: current.by, remote: remote() === true });
    const allowed = actionsFor(state);
    for (const [action, b] of buttons) {
      b.hidden = !allowed.includes(action);
      b.textContent = labels[action]();
      b.disabled = busy;
    }
    bannerText.textContent = current.error === 'conceal-failed' ? t('chromeControl.error.concealFailed') : t('chromeControl.banner');
    bannerBtn.textContent = labels.resume(); bannerBtn.disabled = busy;
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
    root, banner, overlay, ring,
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

/** 今の会話のエージェントの名前（会話の行の「Claude に戻しました」。web/client.mjs が入れる） */
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

/** 引き継いで戻したときの会話の行（present kind: 'chromeHandover'。chromeHandover: { seconds }）。「あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒」 */
export function renderChromeHandoverLine(ev) {
  const row = el('div', 'cc-line');
  const icon = el('span', 'cc-line-ic'); icon.setAttribute('aria-hidden', 'true'); icon.append(handIcon());
  row.append(icon, el('span', 'cc-line-t', t('chromeControl.handover', { name: agentName(), duration: durationText(ev?.chromeHandover?.seconds) })));
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

export const chromeControlStore = createChromeControlStore();
