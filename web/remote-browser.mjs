// ホストの内蔵ブラウザーの映像を、ホストの画面ではない端末の右パネル「ブラウザー」で見る（docs/inapp-browser.md「リモートから見る」）。
// ホストの内蔵ブラウザーのタブの画面（JPEG）を WS の screencast で受けて描き、タップ・スクロール・文字の入力・少数のキーを送り返す。
// 右パネルの部品（タブの列・戻る・進む・再読み込み・アドレス欄。web/browser-panel.mjs）はホストの画面と同じものを使い、
// ここはその部品が話しかける相手（bridge。ホストの画面では preload の plyDesktop.browser）の代わりと、本文の映像・画質・文字入力を持つ。
// ページの大きさは映像の箱の大きさ（ホストがビューポートをこの大きさにする）。座標はフレームの metadata で変換する。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { notify } from './file-actions.mjs';
import { createFrameSink, framesPerSecond } from './screencast-frame.mjs';

const TAP_SLOP = 10;   // これより動いたらスクロール
const RESIZE_STEP = 24;   // 箱の大きさがこれ以上変わったら、ページの大きさを合わせ直す
const VISIBLE_WAIT = 3000;   // パネルが見えるのを待つ上限（ms）。待ち切れなければ窓の大きさで始める

/** object-fit: contain で箱に収めた画像の、実際に描かれた範囲 */
export function containRect(box, natural) {
  if (!natural.width || !natural.height || !box.width || !box.height) return { left: box.left, top: box.top, width: 0, height: 0 };
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale, height = natural.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** 表示上の点（clientX/Y）をページの CSS px へ。画像の外なら null。metadata はフレームの deviceWidth / deviceHeight / offsetTop */
export function toPageCoords(point, rect, metadata) {
  if (!rect.width || !rect.height || !metadata?.deviceWidth || !metadata?.deviceHeight) return null;
  const rx = (point.x - rect.left) / rect.width, ry = (point.y - rect.top) / rect.height;
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null;
  const top = Number(metadata.offsetTop) || 0;
  return { x: Math.round(rx * metadata.deviceWidth), y: Math.round(ry * (metadata.deviceHeight + top) - top) };
}

/** 表示上の移動量（px）をページの CSS px へ */
export function toPageDelta(delta, rect, metadata) {
  if (!rect.width || !metadata?.deviceWidth) return 0;
  return delta * metadata.deviceWidth / rect.width;
}

export { framesPerSecond };

const blankUrl = url => !url || url === 'about:blank';

/**
 * ホストの screencast の状態（desktop/browser-screencast.cjs の state()）を、右パネルの部品が読むタブの列の形にする。
 * 戻る・進む・読み込み中は見ているタブのもの。ほかのタブは列の一覧が持つ分だけ
 */
export function panelStateOf(state, sessionId) {
  if (!state) return { tabs: [], current: null, sessionId };
  const current = state.tabId ?? null;
  const tabs = (Array.isArray(state.tabs) ? state.tabs : []).map(tab => (tab.id === current
    ? { ...tab, url: state.url ?? tab.url, title: state.title ?? tab.title, loading: !!state.loading, canGoBack: !!state.canGoBack, canGoForward: !!state.canGoForward, external: false }
    : { ...tab, canGoBack: false, canGoForward: false, external: false }));
  return { tabs, current, sessionId };
}

/**
 * @param cmd WS のコマンド。getSessionId は今の会話。
 * 返す bridge は createBrowserPanel({ bridge }) へ渡し、viewport はパネルの本文の枠へ入れる
 */
export function createRemoteBrowser({ cmd, getSessionId }) {
  let sessionId = null;   // サーバーへ見始めている会話（見ていなければ null）
  let wanted = null;   // パネルが「今の会話」として知らせてきた会話
  let wantTab = null;   // 次に見始めるとき、このタブを見る
  let wantSnapshot = null;   // 次に見始めるとき、会話に残った可視化の写し（{ sessionId, id | at }）を開く
  let visible = false, ended = false, quality = 'auto';
  let starting = null, visibleWaiters = [];
  let panelState = { tabs: [], current: null, sessionId: null };
  let listener = null;

  // ---- 本文: 映像・画質と文字入力
  const root = el('div', 'rbv');
  const screen = el('div', 'rbv-screen'); screen.setAttribute('aria-label', t('browser.remote.screen'));
  const img = el('img', 'rbv-frame'); img.alt = ''; img.draggable = false;
  screen.append(img);
  const sink = createFrameSink({ img, onAck: seq => { if (sessionId) cmd('browserScreencastAck', { sessionId, seq }).catch(() => {}); } });
  const status = el('span', 'rbv-status weak', t('browser.remote.connecting')); status.setAttribute('role', 'status');
  const qualityButton = el('button', 'btn rbv-tool'); qualityButton.type = 'button';
  const textButton = el('button', 'btn rbv-tool', t('browser.remote.textInput')); textButton.type = 'button';
  textButton.setAttribute('aria-expanded', 'false');
  const toolRow = el('div', 'rbv-tool-row'); toolRow.append(qualityButton, textButton);
  const tools = el('div', 'rbv-tools'); tools.append(status, toolRow);
  const text = el('div', 'rbv-text'); text.hidden = true;
  const textInput = el('input'); textInput.setAttribute('aria-label', t('browser.remote.textLabel')); textInput.placeholder = t('browser.remote.textPlaceholder');
  textInput.setAttribute('enterkeyhint', 'send');
  const textSend = el('button', 'btn primary', t('browser.remote.textSend')); textSend.type = 'button';
  text.append(textInput, textSend);
  root.append(screen, tools, text);

  const failed = error => notify(error?.message || t('browser.remote.failed'));
  const blocked = () => ended || !sessionId;
  const send = input => (sessionId ? cmd('browserScreencastInput', { sessionId, input }) : Promise.resolve());

  qualityButton.onclick = () => { quality = quality === 'auto' ? 'low' : 'auto'; paintTools(); if (sessionId) begin({ keep: true }).catch(failed); };
  textButton.onclick = () => {
    text.hidden = !text.hidden; textButton.setAttribute('aria-expanded', String(!text.hidden));
    if (!text.hidden) textInput.focus();
  };
  const sendText = async withEnter => {
    if (blocked()) return;
    const value = textInput.value;
    if (value) await send({ type: 'text', text: value });
    textInput.value = '';
    if (withEnter) await send({ type: 'key', key: 'Enter' });
  };
  textSend.onclick = () => sendText(false).catch(() => {});
  textInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    // 空の欄の Backspace はページの 1 文字を消す。Enter は入力してから Enter を送る
    if (event.key === 'Enter') { event.preventDefault(); sendText(true).catch(() => {}); }
    else if (event.key === 'Backspace' && !textInput.value) { event.preventDefault(); if (!blocked()) send({ type: 'key', key: 'Backspace' }).catch(() => {}); }
  });

  // ---- 画面への入力: タップ・ドラッグでスクロール・ホイール
  let down = null, lastScroll = 0, pendingDy = 0, pendingDx = 0, at = null;
  const rect = () => containRect(img.getBoundingClientRect(), { width: img.naturalWidth, height: img.naturalHeight });
  screen.addEventListener('pointerdown', event => {
    if (!sink.frame || event.button > 0) return;
    down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, id: event.pointerId };
    try { screen.setPointerCapture(event.pointerId); } catch {}
  });
  const flushScroll = () => {
    if (!at || (!pendingDx && !pendingDy)) return;
    const r = rect();
    const dx = toPageDelta(pendingDx, r, sink.frame?.metadata), dy = toPageDelta(pendingDy, r, sink.frame?.metadata);
    pendingDx = pendingDy = 0; lastScroll = performance.now();
    if (!blocked()) send({ type: 'scroll', x: at.x, y: at.y, dx, dy }).catch(() => {});
  };
  screen.addEventListener('pointermove', event => {
    if (!down || event.pointerId !== down.id) return;
    if (!down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < TAP_SLOP) return;
    if (!down.moved) { down.moved = true; at = toPageCoords(down, rect(), sink.frame?.metadata) ?? { x: 0, y: 0 }; }
    // 指を上へ動かすとページは下へ（端末の触り方と同じ向き）
    pendingDx += down.lastX - event.clientX; pendingDy += down.lastY - event.clientY;
    down.lastX = event.clientX; down.lastY = event.clientY;
    if (performance.now() - lastScroll > 60) flushScroll();
  });
  const finish = event => {
    if (!down || event.pointerId !== down.id) return;
    const was = down; down = null;
    if (was.moved) { flushScroll(); return; }
    if (event.type === 'pointercancel') return;
    const point = toPageCoords({ x: event.clientX, y: event.clientY }, rect(), sink.frame?.metadata);
    if (!point || blocked()) return;
    send({ type: 'tap', ...point }).catch(() => {});
  };
  screen.addEventListener('pointerup', finish);
  screen.addEventListener('pointercancel', finish);
  screen.addEventListener('wheel', event => {
    if (!sink.frame) return;
    event.preventDefault();
    const point = toPageCoords({ x: event.clientX, y: event.clientY }, rect(), sink.frame.metadata);
    if (!point || blocked()) return;
    at = point; pendingDx += event.deltaX; pendingDy += event.deltaY;
    if (performance.now() - lastScroll > 60) flushScroll();
  }, { passive: false });

  function paintTools() {
    qualityButton.textContent = t('browser.remote.quality', { level: quality === 'auto' ? t('browser.remote.qualityAuto') : t('browser.remote.qualityLow') });
    if (ended) status.textContent = t('browser.remote.ended');
    else if (!sink.frame) status.textContent = t('browser.remote.connecting');
    else status.textContent = t('browser.remote.connectedFps', { fps: sink.fps() });
  }
  paintTools();

  // ---- 見始める・止める
  function deliver() { listener?.(panelState); }
  function apply(state) {
    panelState = panelStateOf(state, wanted);
    deliver();
  }
  function whenVisible() {
    if (visible) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, VISIBLE_WAIT);
      visibleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  /** 箱の大きさ（CSS px）をページの大きさにする。端末の画素の倍率は画質で上限を決める（ホストが丸める） */
  const boxSize = () => {
    const box = screen.getBoundingClientRect();
    return { width: Math.round(box.width) || window.innerWidth, height: Math.round(box.height) || window.innerHeight, scale: window.devicePixelRatio || 1 };
  };
  let lastBox = null;
  /** 見始める。keep: 見ているタブのまま（画質・大きさだけ変える） */
  async function begin({ keep = false } = {}) {
    await whenVisible();
    const id = wanted ?? getSessionId();
    if (!id) return;
    const tab = wantTab ?? (keep || sessionId === id ? panelState.current : null);
    const snapshot = wantSnapshot;
    wantTab = wantSnapshot = null;
    const size = boxSize(); lastBox = size;
    const result = await cmd('browserScreencast', { sessionId: id, ...(tab ? { tabId: tab } : {}), ...(snapshot ? { visualization: snapshot } : {}), quality, ...size });
    const changed = sessionId !== id;
    sessionId = id; ended = false; wanted = id;
    if (changed) sink.reset();
    if (result?.state) apply(result.state);
    paintTools();
  }
  /** 見ていなければ見始め、見始めの途中ならそれを待つ。tabId を渡すとそのタブを見る */
  function ensure(tabId = null, snapshot = null) {
    if (tabId) wantTab = tabId;
    if (snapshot) wantSnapshot = snapshot;
    const run = async () => {
      // 見始めの途中で別のタブを頼まれたら、もう一度だけ見始め直す
      for (let round = 0; round < 2; round++) {
        if (sessionId && !ended && !wantTab && !wantSnapshot && sessionId === (wanted ?? sessionId)) return;
        await begin();
        if (!sessionId) return;
      }
    };
    starting ??= run().finally(() => { starting = null; });
    return starting;
  }
  function stopWatching() {
    if (sessionId) cmd('browserScreencastStop', { sessionId }).catch(() => {});
    sessionId = null; ended = false; lastBox = null;
    sink.reset(); paintTools();
  }

  // 箱の大きさが変わったら、ページの大きさを合わせ直す（パネルの幅・広げる・狭い画面の全面表示）
  let resizeTimer = 0;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (!visible || !sessionId || ended || !lastBox) return;
    const box = screen.getBoundingClientRect();
    if (Math.abs(box.width - lastBox.width) < RESIZE_STEP && Math.abs(box.height - lastBox.height) < RESIZE_STEP) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (visible && sessionId && !ended) begin({ keep: true }).catch(() => {}); }, 350);
  });
  observer?.observe(screen);

  const nav = (action, extra = {}) => {
    if (!sessionId || ended) return ensure().then(() => panelState);
    return cmd('browserScreencastNav', { sessionId, action, ...extra }).then(result => {
      if (result?.state) apply(result.state);
      return panelState;
    });
  };

  /** 右パネルの部品が話しかけるときの口（ホストの画面の plyDesktop.browser.command と同じ形） */
  async function command(action, args = {}) {
    switch (action) {
      case 'state': return panelState;
      case 'context': {
        const id = args.sessionId ?? null;
        if (id !== wanted) {
          wanted = id;
          panelState = { ...panelState, sessionId: id };
          if (sessionId && sessionId !== id) { stopWatching(); if (visible) ensure().catch(failed); }
        }
        return panelState;
      }
      case 'select':
        // 見ていない間（開いた直後）は、見始めるときにそのタブを選ぶ
        if (!sessionId || ended) { await ensure(args.id); return panelState; }
        return nav('select', { tabId: args.id });
      case 'close': return nav('close', { tabId: args.id });
      case 'back': case 'forward': case 'reload': case 'stop': return nav(action);
      case 'newTab': {
        await ensure();
        // 空のタブしか無い（見始めたときに作られた）間は、もう 1 つ作らない
        const only = panelState.tabs.length === 1 ? panelState.tabs[0] : null;
        if (only && blankUrl(only.url)) return panelState;
        return nav('newTab');
      }
      case 'open': {
        if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) { notify(t('browser.invalid')); return panelState; }
        await ensure();
        const current = panelState.tabs.find(tab => tab.id === panelState.current);
        if (args.newTab && current && !blankUrl(current.url)) await nav('newTab');
        return nav('open', { url: args.url });
      }
      case 'freeze': case 'unfreeze': return {};
      default: return { ok: false };
    }
  }

  const bridge = {
    command,
    onState(fn) { listener = fn; },
    /** パネルが見えるようになった・隠れた。見えている間だけ見る（映像は隠れたら止める） */
    layout({ visible: shown }) {
      if (!!shown === visible) return;
      visible = !!shown;
      if (visible) { for (const wake of visibleWaiters.splice(0)) wake(); ensure().catch(failed); }
      else {
        stopWatching();
        // 見始めの途中で隠れたら、見始めた後で止める
        starting?.then(() => { if (!visible) stopWatching(); }, () => {});
      }
    },
  };

  /** ファイルを開いたタブ（browser.openFile の戻りの tabId）を見る。パネルが開いていなければ開いた後で見始める */
  function watchTab(tabId) { return ensure(tabId); }
  /** 会話に残った可視化の写しをホストの内蔵ブラウザーで開いて見る（query は { sessionId, id | at }） */
  function watchSnapshot(query) { return ensure(null, { sessionId: query.sessionId, ...(query.id ? { id: query.id } : { at: query.at }) }); }

  function onMessage(message) {
    // エージェントの Chrome の窓の映像（source: 'chrome'）は右パネル（web/chrome-panel.mjs）のもの
    if (message.source === 'chrome' || message.sessionId !== sessionId) return;
    if (message.type === 'frame' && typeof message.data === 'string') {
      sink.push(message); paintTools();
    } else if (message.type === 'state') {
      apply(message.state);
    } else if (message.type === 'ended') {
      if (message.reason === 'closed') {
        // 最後のタブを閉じた: タブの列を空にして知らせる（右パネルが閉じる）。見るものは無くなった
        sessionId = null; sink.reset();
        panelState = { tabs: [], current: null, sessionId: wanted };
        deliver();
      } else { ended = true; }
      paintTools();
    }
  }

  /** 接続し直したら見続ける（サーバーは接続が切れた端末を外している） */
  function reconnected() {
    if (!visible || !sessionId) return;
    sessionId = null; wantTab = panelState.current;
    ensure().catch(() => { ended = true; paintTools(); });
  }

  bridge.watchSnapshot = watchSnapshot;
  return { bridge, viewport: root, onMessage, reconnected, watchTab, watchSnapshot, get watching() { return !!sessionId; } };
}
