// 右の欄の Chrome の映像（docs/inapp-browser.md、ADR 0294・0297）。
// 会話の専用の Chrome の窓（エージェントが操作する、画面の外の見えない窓）の「今のタブ」の映像を、WS の screencast（source: 'chrome'）で受けて映す。
// タブの列・アドレスバーは web/browser-unify.mjs が mountBrowserChrome で映像の上に置き、映像からの入力は useInput（web/screencast-frame.mjs の createScreencastInput）で送る。
// 見る会話: パネルは開いた会話（owner）のもの。映すのはその会話か、窓のある直接の子の会話（sessionId）。子の Chrome を見ても会話は移らない（open(element, { target })）。
//   子の会話へ移るのは ⋮「会話を開く」だけ。状態の一行・引き継ぎは、映している会話に向く（呼ぶ側が target() で引く）
// ページの大きさは measure() が返す映像の箱の大きさ（「この端末で操作する」がサーバーへ渡す）
// 右パネルの枠は web/file-preview.mjs の openPanel（git パネルと同じ）。ここは中身だけを作る。
//     映像の上の層（押した位置の輪）は mountOverlay で映像の箱へ重ねる。輪の位置に要る映像の元の大きさは frameSize（フレームの metadata）
//   - 撮影を断っている間（state.suspended）は薄い幕。PC で操作している間のリモートの端末は、幕に「この端末で操作する」を出す（canOperateHere・operateHere）
//   - 見ているウィンドウが閉じたら、映像を薄くして約 1 秒おいてから、エージェントが操作するウィンドウへ戻る
//   - 映像の描画と ack は web/screencast-frame.mjs
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { notify } from './file-actions.mjs';
import { createFrameSink, createScreencastInput } from './screencast-frame.mjs';
import { containRect, pageMetadata } from './page-coords.mjs';
import { browserIcon } from './tab-strip.mjs';
import { runMark } from './arc.mjs';

/** 右の欄の ⋮ の行のアイコン（web/browser-unify.mjs のメニューと同じ線の絵） */
const menuIcon = kind => { const svg = browserIcon(kind); svg.classList.add('i'); return svg; };

const KEY = 'chrome-window';
/** 表示の箱がこれ以上（CSS px）変わったら、映像の大きさを取り直す */
const RESIZE_STEP = 24;
/** 映すウィンドウ・会話が替わるときの溶かす長さ（--dur と同じ）と、見ているウィンドウが閉じたあと戻るまで */
const FADE_MS = 240;
const HOLD_MS = 1000;

/** 会話の Chrome の窓の知らせ（サーバーの chromeWindow イベント）を会話ごとに覚える。入口の表示と弧が読む */
export function createWindowTable() {
  const rows = new Map();   // sessionId -> { windows, operating, windowIds, currentWindowId, pinnedWindowId, numbers, counter }
  return {
    /** イベントを当てる。変わったら true */
    apply(ev) {
      const id = ev?.sessionId;
      if (typeof id !== 'string' || !id) return false;
      const before = rows.get(id);
      if (!(ev.windows > 0)) { rows.delete(id); return Boolean(before); }
      const windowIds = Array.isArray(ev.windowIds) ? ev.windowIds.filter(Number.isSafeInteger) : [];
      // ウィンドウの番号は、見え始めた順に付けて変えない（途中のウィンドウが閉じても、残りの番号は動かない）。全部閉じたら 1 から
      const numbers = new Map(before?.numbers ?? []);
      let counter = before?.counter ?? 0;
      for (const windowId of windowIds) if (!numbers.has(windowId)) numbers.set(windowId, ++counter);
      for (const windowId of [...numbers.keys()]) if (!windowIds.includes(windowId)) numbers.delete(windowId);
      const next = { windows: Number(ev.windows), operating: ev.operating === true, windowIds,
        currentWindowId: Number.isSafeInteger(ev.currentWindowId) ? ev.currentWindowId : null,
        pinnedWindowId: Number.isSafeInteger(ev.pinnedWindowId) && windowIds.includes(ev.pinnedWindowId) ? ev.pinnedWindowId : null,
        numbers, counter };
      rows.set(id, next);
      return !before || before.windows !== next.windows || before.operating !== next.operating ||
        before.currentWindowId !== next.currentWindowId || before.pinnedWindowId !== next.pinnedWindowId || before.windowIds.join(',') !== next.windowIds.join(',');
    },
    has: id => (rows.get(id)?.windows ?? 0) > 0,
    count: id => rows.get(id)?.windows ?? 0,
    /** ウィンドウの並び（windowId は Chrome のウィンドウの id。知らされていなければ null）。current は今エージェントが操作するウィンドウ */
    list(id) {
      const row = rows.get(id);
      if (!row) return [];
      const ids = row.windowIds.length ? row.windowIds : Array.from({ length: row.windows }, () => null);
      return ids.map((windowId, index) => ({ number: windowId === null ? index + 1 : row.numbers.get(windowId) ?? index + 1, windowId,
        current: windowId !== null && windowId === row.currentWindowId, pinned: windowId !== null && windowId === row.pinnedWindowId }));
    },
    ids: id => rows.get(id)?.windowIds ?? [],
    /** エージェントが今操作するウィンドウ（なければ null） */
    current: id => rows.get(id)?.currentWindowId ?? null,
    /** 人が固定しているウィンドウ（なければ null） */
    pinned: id => rows.get(id)?.pinnedWindowId ?? null,
    numberOf: (id, windowId) => rows.get(id)?.numbers.get(windowId) ?? null,
    operating: id => rows.get(id)?.operating === true,
    clear() { rows.clear(); },
  };
}

/**
 * 閉じる前の確かめ（小さなダイアログ）。パネルの本体（position: relative）の中に重ねる。
 * 「やめる」に焦点。Esc・外側を押すのも「やめる」。引き継ぎ中・依頼待ちのときは注意の一文を足す。
 */
export function createCloseDialog({ t }) {
  const root = el('div', 'cp-dlg'); root.hidden = true;
  let returnTo = null, serial = 0;

  function dismiss(restore = true) {
    if (root.hidden) return;
    root.hidden = true; root.replaceChildren();
    const target = returnTo; returnTo = null;
    if (restore && target && !target.disabled) target.focus?.();
  }

  /**
   * @param number 閉じるウィンドウの番号（知らなければ null）
   * @param many   ウィンドウが 2 つ以上ある（番号を題に入れる）
   * @param agent  エージェントが操作しているウィンドウか（番号の横に印を添える）
   * @param running エージェントが操作中か
   * @param risk   'human'（引き継ぎ中）| 'waiting'（依頼待ち）| null
   * @param run    「閉じる」で呼ぶ
   * @param trigger 閉じたあとに焦点を返すボタン
   */
  function ask({ number = null, many = false, agent = false, running = false, risk = null, run, trigger = null }) {
    returnTo = trigger;
    const id = ++serial;
    const card = el('div', 'cp-dlg-card'); card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-modal', 'true');
    const pic = el('div', 'cp-dlg-pic'); pic.setAttribute('aria-hidden', 'true');
    const chip = el('span', 'cp-dlg-chip', number == null ? '' : String(number));
    if (agent) chip.append(running ? runMark() : el('span', 'cp-dlg-dot'));
    pic.append(chip);
    const title = el('p', 'cp-dlg-t', many && number != null ? t('browser.chromeWindow.closeAskNumber', { n: number }) : t('browser.chromeWindow.closeAsk'));
    title.id = `cp-dlg-t${id}`; card.setAttribute('aria-labelledby', title.id);
    card.append(pic, title);
    if (risk) {
      const note = el('p', 'cp-dlg-n', risk === 'human' ? t('browser.chromeWindow.closeRiskHuman') : t('browser.chromeWindow.closeRiskWaiting'));
      note.id = `cp-dlg-n${id}`; card.setAttribute('aria-describedby', note.id);
      card.append(note);
    }
    const no = el('button', 'btn btn-quiet', t('pending.cancel')); no.type = 'button';
    const yes = el('button', 'btn cp-dlg-yes', t('browser.chromeWindow.closeYes')); yes.type = 'button';
    const buttons = el('div', 'cp-dlg-b'); buttons.append(no, yes);
    card.append(buttons);
    no.onclick = () => dismiss();
    yes.onclick = () => { returnTo = null; root.hidden = true; root.replaceChildren(); run?.(); };
    root.onclick = event => { if (event.target === root) dismiss(); };
    root.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); dismiss(); }
      else if (event.key === 'Tab') { event.preventDefault(); const active = globalThis.document?.activeElement; (active === no ? yes : no).focus?.(); }
    };
    root.replaceChildren(card);
    root.hidden = false;
    no.focus?.();
    return { no, yes, card };
  }

  return { root, ask, dismiss, get open() { return !root.hidden; } };
}

/**
 * @param cmd       WS のコマンド
 * @param preview   web/file-preview.mjs の返り値（openPanel・close・panelOpen）
 * @param session   今の会話の id
 * @param canOperateHere (会話の id) → PC で操作している間の幕に「この端末で操作する」を出すか（リモートの端末だけ）
 * @param operateHere    (会話の id) → 「この端末で操作する」を押した（PC の引き継ぎを端末へ移す）
 * @param menuItems (会話の id) → ⋮ の先頭に足す行（リモートの端末の「PC で操作する」など）
 * @param openConversation (会話の id) → ⋮「会話を開く」（子の会話を映しているとき）
 */
export function setupChromePanel({ cmd, preview, session = () => null, windows = createWindowTable(), closeRisk = () => null,
  canOperateHere = () => false, operateHere = null, menuItems = () => [], openConversation = null } = {}) {
  let unifiedHeader = null; const tabListeners = new Set();
  let unifiedInput = null, inputOptions = null;   // 映像からの入力（useInput。web/screencast-frame.mjs の createScreencastInput）
  let root = null, parts = null, sessionId = null, owner = null, state = null, frameMeta = null, video = { lag: false, stale: false }, ended = false, connecting = false, observer = null, lastBox = null, resizeTimer = 0;
  // 端末内のページを置いて、映像を止めている間（mountPage）
  let pagePaused = false;
  let watchGeneration = 0, pinGeneration = 0, stateVersion = 0;
  let pendingTab = null, pinRequest = null, targetListeners = new Set();   // 開始待ちのタブと、送信後の完了待ちを分ける
  const inFlightPins = new Set();
  let opener = null, openListeners = new Set(), notifyOpenChange = open => { for (const fn of openListeners) { try { fn(open); } catch {} } }, closing = false, hold = null, holdTimer = 0, fadeTimer = 0, fadePending = false, lastShown;   // hold: 閉じたウィンドウを薄くして残している間

  function build() {
    const veil = el('div', 'cp-veil'); veil.hidden = true;
    const veilText = el('span', 'cp-veil-text');
    const here = el('button', 'btn btn-primary cp-veil-here', t('browser.chromeWindow.operateHere')); here.type = 'button'; here.hidden = true;
    const veilBox = el('div', 'cp-veil-box'); veilBox.append(veilText, here); veil.append(veilBox);
    here.onclick = () => {
      const id = sessionId;
      if (!id || !operateHere || here.disabled) return;
      here.disabled = true;
      Promise.resolve().then(() => operateHere(id)).catch(error => notify(error?.message || t('chromeControl.failed'))).finally(() => { here.disabled = false; });
    };
    const img = el('img', 'cp-frame'); img.alt = ''; img.draggable = false;
    const ghost = el('img', 'cp-ghost'); ghost.alt = ''; ghost.draggable = false; ghost.setAttribute('aria-hidden', 'true');   // 映すものが替わる間、前の絵を重ねて溶かす
    // 遅れ・途切れの札（ADR 0297 §5。起きたときだけ出す。札の見た目は承認済みモック v6 の pill と灰色の幕）
    const pill = { position: 'absolute', background: 'rgba(15,19,48,.78)', color: '#f4f6ff', borderRadius: '999px', fontSize: '12px', padding: '2px 10px', zIndex: '2' };
    const lag = el('div', 'cp-lag', t('browser.video.lag')); lag.hidden = true;
    Object.assign(lag.style, pill, { left: '10px', top: '10px' });
    const stale = el('div', 'cp-stale'); stale.hidden = true;
    Object.assign(stale.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', background: 'rgba(236,238,244,.55)', backdropFilter: 'grayscale(1)', zIndex: '2' });
    const staleText = el('span', 'cp-stale-text', t('browser.video.stale'));
    Object.assign(staleText.style, { background: 'rgba(15,19,48,.78)', color: '#f4f6ff', borderRadius: '999px', fontSize: '13px', padding: '4px 14px' });
    stale.append(staleText);
    const screen = el('div', 'cp-screen'); screen.tabIndex = 0; screen.setAttribute('role', 'img');
    screen.append(img, ghost, veil, lag, stale);
    const dialog = createCloseDialog({ t });
    const empty = el('div', 'cp-empty'); empty.hidden = true;
    // 第 10 段のプロフィール pill をここへ差し込む。空の間は幅を取らない。
    const profileSlot = el('div', 'cp-profile-slot'); profileSlot.dataset.slot = 'chrome-profile';
    const node = el('div', 'cp');
    if (unifiedHeader) { node.classList.add('bu-panel'); node.append(unifiedHeader); }
    node.append(screen, empty, dialog.root);
    const sink = createFrameSink({ img,
      onAck: seq => { if (sessionId) cmd('browserScreencastAck', { sessionId, source: 'chrome', seq }).catch(() => {}); },
      onMark: seq => { if (sessionId) cmd('browserScreencastAck', { sessionId, source: 'chrome', seq, mark: true }).catch(() => {}); } });
    const fit = metadata => {
      // 映像の箱を窓の縦横比に合わせる（余白のない映像にする）。最初のフレームと、窓の形が変わったときだけ
      const w = Number(metadata?.deviceWidth), h = Number(metadata?.deviceHeight);
      if (w > 0 && h > 0) { const ratio = `${Math.round(w)} / ${Math.round(h)}`; if (screen.style.aspectRatio !== ratio) screen.style.aspectRatio = ratio; }
    };
    return { node, profileSlot, screen, img, ghost, dialog, veil, veilText, here, empty, sink, fit, lag, stale };
  }

  const isOpen = () => preview.panelOpen(KEY);
  /** 映像に触れる・打つと、映しているタブを人の操作にしてページへ送る（B2。PC もスマホも） */
  function ensureInput() {
    if (!inputOptions || unifiedInput || !parts) return;
    unifiedInput = createScreencastInput({ surface: parts.screen, img: parts.img, getFrame: () => parts.sink.frame, phone: inputOptions.phone(),
      showMenu: inputOptions.showMenu,
      send: input => {
        const id = sessionId;
        if (!id || ended) return Promise.reject(new Error(t('browser.chromeWindow.inputFailed')));
        return cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: state?.tabId ?? undefined, input });
      },
      openLink: url => {
        const id = sessionId;
        if (id) return cmd('chromeNavigate', { sessionId: id, targetId: state?.tabId ?? undefined, action: 'navigate', input: url }).catch(() => {});
        return Promise.resolve();
      },
      onError: error => notify(error?.message || t('browser.chromeWindow.inputFailed')) });
  }

  /** 人が固定しているウィンドウ（タブの列でタブを選ぶと固定される）。なければ null */
  function pinnedNow() {
    const pin = windows.pinned(sessionId);
    return pin != null && windows.ids(sessionId).includes(pin) ? pin : null;
  }
  /** 映像に映っているウィンドウ。閉じたウィンドウを薄くして残している間は、それ */
  function shownNow() {
    if (hold) return hold.windowId;
    return pinnedNow() ?? windows.current(sessionId) ?? windows.ids(sessionId)[0] ?? null;
  }

  /** 映す会話を替える（会話は移らない） */
  function retarget(id) {
    if (!parts || !isOpen() || !id || id === sessionId) return;
    watchGeneration++; pinGeneration++; pendingTab = null; pinRequest = null;
    const old = sessionId;
    if (old && !pagePaused) cmd('browserScreencastStop', { sessionId: old, source: 'chrome' }).catch(() => {});
    pagePaused = false;   // 新しい会話の映像は受ける（端末内のページを置くなら browser-unify がまた mountPage する）
    startFade();   // 前の絵を重ね、新しい会話の絵が来たら溶かす
    clearTimeout(holdTimer);
    hold = null; lastShown = undefined;
    parts.dialog.dismiss(false);
    sessionId = id; state = null; frameMeta = null; ended = false;
    parts.sink.reset(); unifiedInput?.reset();
    connecting = !pagePaused && windows.has(id);
    paint();
    notifyTarget();
    if (connecting) watch(id);
  }
  const notifyTarget = () => { for (const fn of [...targetListeners]) { try { fn(sessionId); } catch {} } };

  /** 前の絵を重ね、新しい絵が来たら溶かして消す（動きを減らす設定では CSS が出し入れだけにする） */
  function startFade() {
    if (!parts?.img.getAttribute?.('src')) return;
    parts.ghost.setAttribute('src', parts.img.getAttribute('src'));
    parts.ghost.classList.remove('out'); parts.ghost.dataset.on = '';
    fadePending = true;
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(endFade, 1500);
  }
  function fadeOutGhost() {
    if (!fadePending || !parts) return;
    fadePending = false;
    parts.ghost.classList.add('out');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(endFade, FADE_MS + 40);
  }
  function endFade() {
    clearTimeout(fadeTimer); fadePending = false;
    if (!parts) return;
    parts.ghost.removeAttribute('src'); parts.ghost.classList.remove('out'); delete parts.ghost.dataset.on;
  }

  /** 見ているウィンドウが閉じた。映像を薄くして残し、約 1 秒おいてから戻る */
  function startHold(windowId, number, index) {
    clearTimeout(holdTimer);
    hold = { windowId, number, index };
    holdTimer = setTimeout(() => { hold = null; if (parts) paint(); }, HOLD_MS);
  }

  /** 閉じる前の確かめ（いつも出す）。映像に映っているウィンドウを閉じる */
  function askClose(trigger) {
    const id = sessionId;
    if (!id || !windows.has(id) || closing || !parts) return;
    const shown = shownNow();
    const rows = windows.list(id);
    const number = shown != null ? windows.numberOf(id, shown) : rows.length === 1 ? rows[0].number : null;
    parts.dialog.ask({ number, many: windows.count(id) > 1, agent: shown != null && shown === windows.current(id), running: windows.operating(id),
      risk: closeRisk(id), trigger, run: () => closeShown(id, shown) });
  }
  async function closeShown(id, windowId) {
    if (closing) return;
    closing = true;
    try {
      const result = await cmd('chromeCloseWindow', windowId != null && windows.count(id) > 1 ? { sessionId: id, windowId } : { sessionId: id });
      if (result?.failed) notify(t('browser.chromeWindow.closeFailed'));
    } catch (error) { notify(error?.message || t('browser.chromeWindow.closeFailed')); }
    finally { closing = false; }
  }

  function paint() {
    if (!parts) return;
    // 右の欄の映像は、そのまま触れる（誰が操作中かはアドレスバーの札が示す）
    parts.screen.setAttribute('aria-label', t('browser.chromeWindow.screenUnified'));
    parts.veil.hidden = !state?.suspended || ended;
    const here = Boolean(operateHere) && canOperateHere(sessionId) === true;
    parts.veilText.textContent = here ? t('browser.chromeWindow.operatingOnPc') : t('browser.chromeWindow.suspended');
    parts.here.hidden = !here;
    parts.screen.classList.toggle('ended', ended || hold !== null);
    const noWindow = !windows.has(sessionId) && !connecting;
    const localPage = 'localPage' in parts.screen.dataset;
    parts.screen.hidden = noWindow && !localPage; parts.empty.hidden = !noWindow || localPage;
    parts.empty.textContent = t('browser.chromeWindow.none');
    parts.lag.hidden = !video.lag || ended;
    parts.stale.hidden = !video.stale || ended;
    for (const listener of tabListeners) listener();
    // 映すウィンドウが替わる（エージェントが別のウィンドウへ移った）ときは前の絵を重ねて溶かす。最初の描画・閉じたウィンドウの保持中は溶かさない
    const shown = shownNow();
    if (lastShown !== undefined && shown !== lastShown && lastShown != null && shown != null && parts.sink.frame) startFade();
    lastShown = shown;
  }

  async function start() {
    if (!sessionId || pagePaused) return;
    const previousGeneration = watchGeneration;
    const id = sessionId, generation = ++watchGeneration, version = stateVersion;
    for (const pin of inFlightPins) if (pin.generation === previousGeneration && pin.sessionId === id) pin.generation = generation;
    if (pinRequest?.generation === previousGeneration && pinRequest.sessionId === id) pinRequest.generation = generation;
    const box = parts.screen.getBoundingClientRect();
    lastBox = { width: box.width, height: box.height };
    connecting = true;
    // 映像の高さは窓の形で決まる（箱は映像の縦横比に合わせる）ので、高さで縛らないよう、画面の高さまで許す
    let result;
    try { result = await cmd('browserScreencast', {
      sessionId:id, source: 'chrome',
      width: Math.round(box.width) || 480, height: Math.max(Math.round(box.height), Math.round(window.innerHeight * 0.9)) || 320,
      scale: window.devicePixelRatio || 1,
      ...(inputOptions ? { device: inputOptions.phone() ? 'phone' : 'pc' } : {}),
    }); } catch (error) {
      if (generation !== watchGeneration) return;
      throw error;
    }
    // 閉じる・再接続・端末内の表示へ移る前の応答は、今の選択に混ぜない。
    if (generation !== watchGeneration || sessionId !== id || pagePaused || !isOpen()) return;
    connecting = false; ended = false;
    if (Number.isSafeInteger(result?.state?.sequence) || version === stateVersion) acceptState(result?.state);
    // タブの列で選んだタブ（映していない間に選んだ）は、映し始めてから固定する
    const tab = pendingTab;
    pendingTab = null;
    if (!pagePaused && tab?.sessionId === sessionId) sendTabPin(tab);
    else if (!pagePaused && !pinRequest && result?.state) for (const listener of tabListeners) listener({ type:'state' });
    paint();
  }
  function sendTabPin({ sessionId: id, windowId, tabId }) {
    const request = ++pinGeneration, generation = watchGeneration;
    const pin = { request, generation, sessionId:id, tabId };
    pinRequest = pin;
    inFlightPins.add(pin);
    return cmd('chromePinWindow', { sessionId: id, windowId, tabId }).then(result => {
      if (!livePin(pin)) return;
      // 前の要求の応答も、より新しいサーバー状態なら保存する。表示の選択とは別に持つ。
      const changed = acceptState(result?.state);
      if (currentPin(pin)) {
        pinRequest = null;
        announceState();   // 別端末に上書きされ、対象が違っていても成功応答で要求は終わる。
      } else if (!pinRequest && changed) announceState();
      paint();
    }).catch(error => {
      if (!currentPin(pin)) return;
      pinRequest = null;
      for (const listener of tabListeners) listener({ type:'pin-failed', sessionId:id, tabId });
      announceState();
      paint();
      notify(error?.message || t('browser.chromeWindow.pinFailed'));
    }).finally(() => inFlightPins.delete(pin));
  }
  function currentPin(pin) {
    return pinRequest === pin && pin.request === pinGeneration && livePin(pin);
  }
  function livePin(pin) {
    return pin.generation === watchGeneration && sessionId === pin.sessionId && !pagePaused && isOpen();
  }
  function announceState() {
    if (pendingTab || pinRequest || pagePaused || !state) return;
    for (const listener of tabListeners) listener({ type:'state' });
  }
  function acceptState(next) {
    if (!next) return false;
    if (Number.isSafeInteger(state?.sequence)
      && (!Number.isSafeInteger(next.sequence) || next.sequence <= state.sequence)) return false;
    if (unifiedInput && state?.tabId && next.tabId !== state.tabId) unifiedInput.reset();
    state = next;
    stateVersion++;
    return true;
  }

  function watchSize() {
    observer?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      if (!isOpen() || !sessionId || !lastBox) return;
      const box = parts.screen.getBoundingClientRect();
      if (Math.abs(box.width - lastBox.width) < RESIZE_STEP && Math.abs(box.height - lastBox.height) < RESIZE_STEP) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (isOpen() && !ended && !pagePaused) start().catch(() => { connecting = false; }); }, 350);
    });
    observer.observe(parts.screen);
  }

  function stopWatching() {
    watchGeneration++; pinGeneration++;
    pinRequest = null;
    observer?.disconnect(); observer = null;
    clearTimeout(resizeTimer); clearTimeout(holdTimer);
    hold = null; lastShown = undefined;
    endFade(); parts?.dialog.dismiss(false);
    if (sessionId && !pagePaused) cmd('browserScreencastStop', { sessionId, source: 'chrome' }).catch(() => {});
    sessionId = null; owner = null; state = null; frameMeta = null; ended = false; connecting = false; lastBox = null; pagePaused = false; pendingTab = null;
    parts?.sink.reset(); unifiedInput?.reset();
  }

  /** パネルを開く。id は映す会話（今の会話か、その子の会話） */
  function show(id, element) {
    if (!parts) { parts = build(); root = parts.node; }
    if (sessionId && sessionId !== id) stopWatching();
    if (pendingTab?.sessionId !== id) pendingTab = null;   // 開く前にタブの列で選んだタブは残す（start が固定する）
    owner = session(); sessionId = id; state = null; frameMeta = null; ended = false;
    hold = null; lastShown = undefined;
    clearTimeout(holdTimer); endFade();
    parts.sink.reset(); ensureInput(); unifiedInput?.reset();
    opener = element;
    const label = t('browser.chromeWindow.panel');
    preview.openPanel({ key: KEY, title: label, subtitle: '', label, element, body: root, wide: true,
      toolbar: [parts.profileSlot],
      onClose: () => { stopWatching(); opener?.setAttribute?.('aria-expanded', 'false'); notifyOpenChange(false); notifyTarget(); } });
    notifyOpenChange(true);
    notifyTarget();
  }

  /** target: 映す会話（子の会話の Chrome を、会話を移らずに見る）。省けば今の会話 */
  function open(element = null, { target = null } = {}) {
    const current = session();
    const id = target ?? current;
    if (!current || !id || (!unifiedHeader && !windows.has(id))) return;
    if (isOpen() && owner === current) {
      // 同じ会話のパネルが開いていて、別の会話を指したら映す会話だけ替える
      if (target != null && target !== sessionId) { retarget(target); return; }
      // 映像をもう見ているなら（選んでいるタブをもう一度押した）、映像を最初からにしない（子を映していればそのまま）
      if (pagePaused || (!ended && (connecting || parts?.sink.frame))) return;
    }
    show(id, element);
    connecting = !pagePaused && windows.has(id);   // 窓がまだ無いなら接続中にしない（窓ができたら windowEvent が見始める）
    paint();
    if (connecting) watch(id);
  }

  /** 映像を受け始める（パネルを開いた次の描画で、箱の大きさが決まってから） */
  function watch(id) {
    requestAnimationFrame(() => {
      if (!isOpen() || sessionId !== id) return;
      watchSize();
      start().catch(error => {
        connecting = false;
        if (error?.code === 'no-window') { paint(); return; }
        notify(error?.message || t('browser.chromeWindow.failed'));
        close();
      });
    });
  }

  function close() { if (isOpen()) preview.close(true); }
  function toggle(element) { if (isOpen()) close(); else open(element); }

  return {
    open, toggle, close, isOpen,
    /**
     * タブの列（web/browser-unify.mjs）で選んだタブを映すよう固定する。映していない間（パネルが閉じている・開いた直後・
     * 端末内のページで映像を止めている）は、映し始めてから固定する（映像を見ていない会話は固定できない）
     */
    pinTab(id, { windowId = null, tabId }) {
      pinGeneration++;
      pinRequest = null;
      const pin = { sessionId: id, windowId, tabId };
      if (isOpen() && sessionId === id && !pagePaused && !connecting && !ended && state) { pendingTab = null; return sendTabPin(pin); }
      pendingTab = pin;
      return Promise.resolve();
    },
    /** 端末内のタブを選び直したら、映像の開始待ちの選択を取り消す。 */
    cancelTabPin() { pendingTab = null; pinRequest = null; pinGeneration++; },
    /** タブ列とアドレスバーを映像の上へ置き、状態表示の挿入口をバーへ移す。 */
    mountBrowserChrome(node) {
      if (!parts) { parts = build(); root = parts.node; }
      unifiedHeader = node;
      root.classList.add('bu-panel'); root.prepend(node);
    },
    browserMenuItems(anchor) {
      const items = [...(sessionId ? menuItems(sessionId) ?? [] : [])];
      const profile = parts?.profileSlot.querySelector('button');
      if (profile) items.push({ label:t('browser.chromeWindow.profileActions'), icon:menuIcon('profile'), onClick:() => profile.click() });
      if (sessionId && owner && sessionId !== owner && openConversation) {
        const id = sessionId; items.push({ label:t('browser.chromeWindow.openConversation'), icon:menuIcon('chat'), onClick:() => openConversation(id) });
      }
      items.push({ label:t('browser.chromeWindow.closeShown'), icon:menuIcon('window'), disabled:!windows.list(sessionId).length || closing, onClick:() => askClose(anchor) });
      return items;
    },
    get tabId() { return state?.tabId ?? null; },
    /** 映像の今の状態（タブの並び・エージェントの今のタブ agentTabId・映しているタブ tabId）。まだ無ければ null */
    get screencastState() { return state; },
    /** 映像からの入力を使う（{ phone: () => スマホか }） */
    useInput(options) { if (inputOptions) return; inputOptions = options; ensureInput(); },
    onTabChange(fn) { tabListeners.add(fn); },
    /** 映像の上に重ねる層（web/chrome-control.mjs の overlay）。映像の箱（position: relative）の中へ置く。null で外す */
    mountOverlay(node) {
      if (!parts) { parts = build(); root = parts.node; }
      parts.screen.querySelector('[data-slot="overlay"]')?.remove();
      if (node) { node.dataset.slot = 'overlay'; parts.screen.append(node); }
    },
    /**
     * 端末内に描く Pleiad のページ（web/browser-unify.mjs）。映像の箱いっぱいに重ね、置いている間は映像を絵として読ませない。null で外す。
     * 置いている間は下の映像（見えない）を止めて通信と電池を使わない。外したら映し直す（ADR 0295 の追記 2）
     */
    get workspace() { if (!parts) { parts = build(); root = parts.node; } return root; },
    mountPage(node) {
      if (!parts) { parts = build(); root = parts.node; }
      const mounted = parts.screen.querySelector('[data-slot="page"]');
      if (mounted) mounted.hidden = !node;
      if (node) {
        parts.screen.hidden = false; parts.empty.hidden = true;
        node.dataset.slot = 'page'; node.hidden = false; if (node.parentElement !== parts.screen) parts.screen.append(node); parts.screen.dataset.localPage = ''; parts.screen.removeAttribute('role'); parts.screen.tabIndex = -1;
        if (!pagePaused && isOpen() && sessionId) {
          watchGeneration++; connecting = false;
          pagePaused = true;
          clearTimeout(resizeTimer);
          cmd('browserScreencastStop', { sessionId, source: 'chrome' }).catch(() => {});
        }
        return;
      }
      if ('localPage' in parts.screen.dataset) { delete parts.screen.dataset.localPage; parts.screen.setAttribute('role', 'img'); parts.screen.tabIndex = 0; }
      if (!pagePaused) return;
      pagePaused = false;
      if (isOpen() && sessionId && !ended) start().catch(() => { connecting = false; });
    },
    /** ページの CSS px の点を画面の点へ（ページから頼まれたメニューの位置）。映像がまだ無ければ映像の箱の中央 */
    toScreen(point) {
      if (!parts) return null;
      const meta = pageMetadata(frameMeta ?? {}), box = parts.screen.getBoundingClientRect(), width = Number(meta.deviceWidth), height = Number(meta.deviceHeight), top = meta.offsetTop;
      const rect = containRect(parts.img.getBoundingClientRect(), { width:parts.img.naturalWidth || width, height:parts.img.naturalHeight || height });
      if (!rect.width || !(width > 0) || !(height > 0) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return { x:box.left + box.width / 2, y:box.top + box.height / 2 };
      return { x:rect.left + point.x / width * rect.width, y:rect.top + (point.y + top) / (height + top) * rect.height };
    },
    /** 映像の元のページの大きさ（レイアウトの CSS 画素。最後のフレームの metadata）。まだ無ければ null */
    frameSize() {
      const meta = pageMetadata(frameMeta ?? {}), width = Number(meta.deviceWidth), height = Number(meta.deviceHeight);
      return width > 0 && height > 0 ? { width, height } : null;
    },
    /** 第 10 段がプロフィール pill を差し込む口。⋮「Chrome のプロフィール」がその pill を押す */
    get profileSlot() { if (!parts) { parts = build(); root = parts.node; } return parts.profileSlot; },
    windows,
    /** サーバーの chromeWindow イベント。表示中の会話の窓が無くなったら閉じた表示にする */
    windowEvent(ev) {
      const watching = isOpen() && ev?.sessionId === sessionId && Boolean(parts);
      const before = watching ? { shown: shownNow(), ids: windows.ids(sessionId), number: windows.numberOf(sessionId, shownNow()) } : null;
      const changed = windows.apply(ev);
      if (watching && ev.windows > 0) {
        const ids = windows.ids(sessionId);
        // 見ていたウィンドウが閉じた: 映像を薄くして残し、約 1 秒おいて戻る
        if (!hold && before.shown != null && before.ids.includes(before.shown) && ids.length && !ids.includes(before.shown) && parts.sink.frame) {
          startHold(before.shown, before.number, before.ids.indexOf(before.shown));
        }
      }
      if (watching && changed) paint();
      if (changed && isOpen() && ev.sessionId === sessionId && !(ev.windows > 0)) {
        ended = true; paint();
      }
      else if (!pagePaused && isOpen() && ev.sessionId === sessionId && ev.windows > 0 && (ended || !parts?.sink.frame) && !connecting) {
        // 窓ができた（最初の窓・閉じた後の新しい窓）。残っている古いフレームを捨てて見直す
        ended = false; connecting = true; parts?.sink.reset(); frameMeta = null; paint(); watch(sessionId);
      }
      return changed;
    },
    /** WS の screencast メッセージ（source: 'chrome'）。ほかは無視 */
    onMessage(message) {
      if (message.source !== 'chrome' || !isOpen() || message.sessionId !== sessionId) return;
      if (message.type === 'frame' && typeof message.data === 'string' && hold) {
        // 閉じたウィンドウを薄く残している間は、新しい絵を映さない（届いたことだけ返して、次を止めない）
        cmd('browserScreencastAck', { sessionId, source: 'chrome', seq: message.seq }).catch(() => {});
      }
      else if (message.type === 'frame' && typeof message.data === 'string') { fadeOutGhost(); frameMeta = message.metadata ?? null; parts.fit(message.metadata); parts.sink.push(message); ended = false; connecting = false; paint(); }
      else if (message.type === 'mark') parts.sink.push(message);
      else if (message.type === 'video') { video = { lag: message.lag === true, stale: message.stale === true }; paint(); }
      else if (message.type === 'interaction') {
        // 入力欄の位置・ダイアログのシート（B2）。映しているタブの分だけ
        const tabId = message.interaction?.tabId;
        if (unifiedInput && message.interaction && (!tabId || tabId === state?.tabId)) unifiedInput.receive(message.interaction);
      }
      else if (message.type === 'state') {
        if (!acceptState(message.state)) return;
        announceState();
        paint();
      }
      else if (message.type === 'ended') { ended = true; paint(); }
    },
    /**
     * 「この端末で操作する」: パネルを開き（開けなければ null）、映像の箱の大きさ（CSS px と倍率）を返す。
     * ページの大きさはこの箱にする（高さは窓の形で箱が決まるので、画面の高さから取る）
     */
    async measure(element = null, { target = null } = {}) {
      if (!isOpen() || (target && target !== sessionId)) open(element, { target });
      if (!isOpen() || !parts) return null;
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const box = parts.screen.getBoundingClientRect();
      const width = Math.round(box.width) || 390;
      return { width, height: Math.max(240, Math.round(window.innerHeight * 0.7)), scale: window.devicePixelRatio || 1 };
    },
    /** 引き継ぎの状態など、外の状態が変わった。描き直す */
    refresh() { if (parts && isOpen()) paint(); },
    /** 接続し直したら見続ける（サーバーは接続が切れた端末を外している） */
    reconnected() {
      watchGeneration++; pinGeneration++;
      pendingTab = null; pinRequest = null;
      const paused = pagePaused;
      state = null;
      for (const listener of tabListeners) listener({ type:'reconnected' });
      // 端末内のページを外す処理が映像を再開する。映像を見ていた場合はここで再開する。
      if (isOpen() && sessionId && !paused) start().catch(() => { ended = true; paint(); });
    },
    /** 別の会話へ移った・会話を閉じた。開いているパネルは閉じる */
    reset() { if (isOpen() && session() !== owner) close(); },
    onOpenChange(fn) { if (typeof fn === 'function') openListeners.add(fn); },
    /** 映す会話が替わった（開いた・閉じた・子の会話を映した）。fn(映している会話の id か null) */
    onTargetChange(fn) { if (typeof fn === 'function') targetListeners.add(fn); },
    /** 映している会話（開いていなければ null）。状態の一行・引き継ぎはこの会話に向く */
    get sessionId() { return sessionId; },
    /** パネルを開いた会話 */
    get owner() { return owner; },
  };
}
