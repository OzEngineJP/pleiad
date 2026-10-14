// リモートの画面から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」、ADR 0041）。
// 会話の内蔵ブラウザーのタブに webContents.debugger で Page.startScreencast を回し、フレームを worker へ渡す。
// debugger は DevTools などが先に付けていれば付け直さない。
//   - フレームは変化があったときだけ Chromium が出す。次のフレームは ack の後なので、間引きは ack を遅らせて行う（worker が決める）
//   - 見ている間はビューポートを端末の表示の大きさにする（Emulation.setDeviceMetricsOverride）。端末で読める幅になり、
//     タブが窓に載っていない・窓が最小化されていても描かれる（窓に載せる必要はある。panel.pin が窓の外に 1px で載せる）
//   - 入力は Input.dispatch*。内蔵ブラウザーは人が見るもの（エージェントの操作は PC の Chrome）なので、常に通る。
//     入力の変換は core/chrome/input.mjs（端末から操作する PC の Chrome の窓と共有）
//   - 端末の右パネルは、ホストの画面の右パネルと同じ「会話のタブ列」を持つ。state.tabs にその会話のタブを載せ、
//     start の tabId・navigate の select / close / newTab で見るタブを替える。見ているタブが閉じたら残りの先頭へ移る
//     （無くなったら closed で終わる）。openTab は見ずにタブだけ足す（端末から開いた HTML。同じファイルは同じタブ）
const { navigable, openable } = require('./browser-panel.cjs');

let inputModule = null;
const loadInput = () => (inputModule ??= import('../core/chrome/input.mjs'));
const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 端末の表示の大きさと画質を、送ってよい範囲に丸める */
function screencastSettings({ width, height, scale, quality } = {}) {
  const w = Math.round(clamp(width, 240, 1600, 390));
  const h = Math.round(clamp(height, 240, 2400, 700));
  const s = clamp(scale, 1, 2, 1);
  return { width: w, height: h, scale: s, quality: Math.round(clamp(quality, 20, 80, 50)), maxWidth: Math.round(w * s), maxHeight: Math.round(h * s) };
}

/**
 * @param panel desktop/browser-panel.cjs の戻り値（tabsFor・createFor・contentsOf・pin・onTabsChanged）
 * @param post  worker へ送る（{ type: 'browser-screencast-frame' | 'browser-screencast-state' | 'browser-screencast-ended', sessionId, ... }）
 */
function createBrowserScreencast(panel, { post = () => {} } = {}) {
  const sessions = new Map();   // sessionId -> { tabId, contents, settings, cleanup[] }

  // PC のファイル（可視化の写し・開いた HTML）の在り処は端末へ出さない
  const shownUrl = url => url === 'about:blank' ? '' : /^file:/i.test(url) ? 'file:///' : url;
  function state(sessionId) {
    const entry = sessions.get(sessionId);
    const c = entry?.contents;
    if (!c || c.isDestroyed()) return null;
    return {
      tabId: entry.tabId, url: shownUrl(c.getURL()), title: c.getTitle(), loading: c.isLoading(),
      canGoBack: c.navigationHistory.canGoBack(), canGoForward: c.navigationHistory.canGoForward(),
      // この会話の内蔵ブラウザーのタブ（ホストの画面の右パネルと同じ並び）。端末の右パネルのタブ列になる
      tabs: panel.tabsFor(sessionId).filter(tab => !tab.webContents.isDestroyed())
        .map(tab => ({ id: tab.id, url: shownUrl(tab.webContents.getURL()), title: tab.webContents.getTitle(), loading: tab.webContents.isLoading() })),
    };
  }
  let stateTimer = new Map();
  function pushState(sessionId) {
    // 読み込みの途中は細かく届くので、まとめて送る
    if (stateTimer.has(sessionId)) return;
    stateTimer.set(sessionId, setTimeout(() => {
      stateTimer.delete(sessionId);
      const value = state(sessionId);
      if (value) post({ type: 'browser-screencast-state', sessionId, state: value });
    }, 50));
  }

  function pickTab(sessionId, url) {
    if (url) return panel.createFor(sessionId, url);
    const tabs = panel.tabsFor(sessionId);
    return tabs[0] ?? panel.createFor(sessionId, 'about:blank');
  }

  async function begin(entry) {
    const { contents: c, settings } = entry;
    // 窓がほかの窓に覆われている・最小化されている間も描かせる（既定では隠れたページとして描かれない）
    c.setBackgroundThrottling?.(false);
    if (!c.debugger.isAttached()) c.debugger.attach('1.3');
    await c.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: settings.width, height: settings.height, deviceScaleFactor: settings.scale, mobile: false });
    await c.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: settings.quality, maxWidth: settings.maxWidth, maxHeight: settings.maxHeight, everyNthFrame: 1 });
  }

  function release(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    sessions.delete(sessionId);
    clearTimeout(stateTimer.get(sessionId)); stateTimer.delete(sessionId);
    for (const off of entry.cleanup) { try { off(); } catch {} }
    panel.pin(entry.tabId, false);
    return entry;
  }
  function end(sessionId, reason) {
    if (!release(sessionId)) return;
    post({ type: 'browser-screencast-ended', sessionId, reason });
  }

  const validSession = sessionId => typeof sessionId === 'string' && !!sessionId && sessionId.length <= 200;
  const tabOf = (sessionId, tabId) => panel.tabsFor(sessionId).find(tab => tab.id === tabId && !tab.webContents.isDestroyed()) ?? null;

  async function start(sessionId, { url, fileUrl, tabId, ...options } = {}) {
    if (!validSession(sessionId)) throw new Error('invalid session');
    const target = fileUrl && /^file:/i.test(fileUrl) ? fileUrl : url;
    if (url && !fileUrl && (!navigable(url) || url === 'about:blank')) throw new Error('invalid-url');
    const settings = screencastSettings(options);
    const existing = sessions.get(sessionId);
    // 開く URL が無く、同じタブ（指定が無ければ今のタブ）を見ているなら、そのまま大きさと画質だけを変える
    if (existing && !target && (!tabId || tabId === existing.tabId)) {
      existing.settings = settings;
      await existing.contents.debugger.sendCommand('Page.stopScreencast').catch(() => {});
      await begin(existing);
      pushState(sessionId);
      return { tabId: existing.tabId, state: state(sessionId) };
    }
    if (existing) await stop(sessionId);
    let tab;
    if (tabId && !target) { tab = tabOf(sessionId, tabId); if (!tab) throw new Error('no-tab'); }
    else tab = pickTab(sessionId, target);
    await attach(sessionId, tab, settings);
    return { tabId: tab.id, state: state(sessionId) };
  }

  /** そのタブを見始める。entry を作り、debugger とイベントを付けて、画面の送信を始める */
  async function attach(sessionId, tab, settings) {
    const c = tab.webContents;
    if (!c || c.isDestroyed()) throw new Error('tab destroyed');
    const entry = { tabId: tab.id, contents: c, settings, cleanup: [] };
    sessions.set(sessionId, entry);
    panel.pin(tab.id, true);
    const onMessage = (_event, method, params, childSession) => {
      if (method !== 'Page.screencastFrame' || childSession || sessions.get(sessionId) !== entry) return;
      const m = params.metadata ?? {};
      post({ type: 'browser-screencast-frame', sessionId, frame: {
        id: params.sessionId, data: params.data,
        metadata: { deviceWidth: m.deviceWidth, deviceHeight: m.deviceHeight, pageScaleFactor: m.pageScaleFactor, offsetTop: m.offsetTop, scrollOffsetX: m.scrollOffsetX, scrollOffsetY: m.scrollOffsetY },
      } });
    };
    // DevTools を開くと debugger が外れる。そこで終わりにする
    const onDetach = () => end(sessionId, 'detached');
    c.debugger.on('message', onMessage);
    c.debugger.on('detach', onDetach);
    const update = () => pushState(sessionId);
    const events = ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'];
    for (const name of events) c.on(name, update);
    // 別の文書へ移ると（描く側が替わると）画面の送信が止まることがある。移るたびにかけ直す
    const restart = () => {
      if (sessions.get(sessionId) !== entry || c.isDestroyed()) return;
      c.debugger.sendCommand('Page.stopScreencast').catch(() => {}).then(() => begin(entry)).catch(() => {});
    };
    c.on('did-navigate', restart);
    entry.cleanup.push(() => {
      c.debugger.off('message', onMessage); c.debugger.off('detach', onDetach);
      for (const name of events) c.off(name, update);
      c.off('did-navigate', restart);
      if (!c.isDestroyed()) c.setBackgroundThrottling?.(true);
      if (!c.isDestroyed() && c.debugger.isAttached()) {
        c.debugger.sendCommand('Page.stopScreencast').catch(() => {});
        c.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    });
    entry.cleanup.push(panel.onTabsChanged((change, changed) => {
      if (changed.sessionId !== sessionId) return;
      if (change === 'destroyed' && changed.id === tab.id) void follow(sessionId, entry);
      else pushState(sessionId);   // タブが増えた・減った（ホストの画面からも）。端末のタブ列を直す
    }));
    try { await begin(entry); }
    catch (error) { if (sessions.get(sessionId) === entry) release(sessionId); throw error; }
  }

  /** 見ているタブが閉じられた。同じ会話の残りのタブがあればその先頭へ移り、無ければ終わる */
  async function follow(sessionId, entry) {
    if (sessions.get(sessionId) !== entry) return;
    const next = panel.tabsFor(sessionId).find(tab => !tab.webContents.isDestroyed());
    const { settings } = entry;
    release(sessionId);
    try {
      if (!next) throw new Error('closed');
      await attach(sessionId, next, settings);
      pushState(sessionId);
    } catch { post({ type: 'browser-screencast-ended', sessionId, reason: 'closed' }); }
  }

  async function stop(sessionId) { release(sessionId); }

  /** 見ているタブを替える（端末のタブ列の選択）。ホストの画面で選んでいるタブは変えない */
  async function select(sessionId, tabId) {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error('not-watching');
    if (entry.tabId === tabId) return;
    const tab = tabOf(sessionId, tabId);
    if (!tab) throw new Error('no-tab');
    const { settings } = entry;
    release(sessionId);
    await attach(sessionId, tab, settings);
    pushState(sessionId);
  }

  /** 見ずに、その会話の内蔵ブラウザーへ PC のファイル（HTML）のタブを足す。リモートの端末から HTML を開くとき（見に行くのは端末の start の tabId） */
  function openTab(sessionId, fileUrl) {
    if (!validSession(sessionId)) throw new Error('invalid session');
    if (typeof fileUrl !== 'string' || !/^file:/i.test(fileUrl) || !openable(fileUrl)) throw new Error('invalid-url');
    return { tabId: panel.openFor(sessionId, fileUrl).id };
  }

  function ack(sessionId, frameId) {
    const c = sessions.get(sessionId)?.contents;
    if (!c || c.isDestroyed() || !Number.isInteger(frameId)) return;
    c.debugger.sendCommand('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {});
  }

  async function input(sessionId, value) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.contents.isDestroyed()) throw new Error('not-watching');
    const { inputCommands } = await loadInput();
    const commands = inputCommands(value, entry.settings);
    if (!commands.length) throw new Error('invalid-input');
    for (const [method, params] of commands) await entry.contents.debugger.sendCommand(method, params);
  }

  /** 戻り値は { tabId, state }（見るタブが替わった・タブが増えたとき）か undefined */
  async function navigate(sessionId, action, url, tabId) {
    const entry = sessions.get(sessionId);
    const c = entry?.contents;
    if (!c || c.isDestroyed()) throw new Error('not-watching');
    switch (action) {
      case 'select': await select(sessionId, tabId); return { tabId: sessions.get(sessionId)?.tabId ?? null, state: state(sessionId) };
      // 閉じるタブは、見ているタブでもほかのタブでもよい（見ているタブを閉じたら follow が残りへ移る）。その会話のタブだけ
      case 'close': {
        const target = tabOf(sessionId, tabId ?? entry.tabId);
        if (!target) throw new Error('no-tab');
        panel.closeFor(target.id);
        return;
      }
      case 'newTab': {
        const created = panel.createFor(sessionId, 'about:blank');
        await select(sessionId, created.id);
        return { tabId: created.id, state: state(sessionId) };
      }
      case 'back': if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); break;
      case 'forward': if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); break;
      case 'reload': c.reload(); break;
      case 'stop': c.stop(); break;
      case 'open':
        if (typeof url !== 'string' || !navigable(url) || url === 'about:blank') throw new Error('invalid-url');
        c.loadURL(new URL(url).href).catch(() => {});   // 失敗は Chromium のエラーページが出る
        break;
      default: throw new Error('unknown action');
    }
  }

  function close() { for (const id of [...sessions.keys()]) release(id); }

  return { start, stop, ack, input, navigate, openTab, state, close, watching: () => [...sessions.keys()] };
}

module.exports = { createBrowserScreencast, screencastSettings };
