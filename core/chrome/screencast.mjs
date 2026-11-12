// エージェントの Chrome の窓の映像（docs/inapp-browser.md、ADR 0154・ADR 0294・ADR 0296・ADR 0297）。
//
// 会話の範囲の映すタブ（AI のタブ = エージェントが CLAIMS のコマンドで操作したタブの履歴の、残っている一番新しいもの。core/chrome/relay.mjs の view.current。
// 無ければ映すだけ窓の最初のタブ = view.shown。人が右パネルで選んだタブはそちら。ADR 0321）に、
// 中継自身のセッション（エージェントのものとは別）を付け、タブの focus emulation を保たせて（host.focus）Page.startScreencast を回す。
//   - 映像の段ごとに 1 つのセッション（ADR 0297 §3）。見る人の段が違うと、段ごとの画質・大きさの screencast を同じタブへ並べて回す。
//     段の一覧は hub が setFormats で渡す（formats: [{ tier, quality, maxWidth, maxHeight }]）。段ごとのセッションを開けない
//     Chrome では、見ている人の一番低い段の 1 つにそろえる（multi: false を返す）。フレームは stream（段）つきで流す
//   - 見る人がいる間だけ付け、いなくなったら（stop）止めて focus emulation の理由（relay の view.focus）も手放す。focus emulation 自体は relay が 1 タブ 1 セッションで持ち、
//     ターンの間と映像を見ている間の両方が無くなったときだけ Chrome から外す（Chrome は 1 つのセッションが外すとほかが有効にしていても外れるため。ADR 0154 の実機）
//   - 今のタブが替わったら（エージェントが別のタブに触れた・タブが閉じた）付け替える
//   - 撮影を断つ口: suspend(sessionId[, windowId]) / resume。断っている間は screencast を止め（フレームを撮らない・流さない）、focus emulation も外す。
//     「PC で操作する」（core/chrome/control.mjs）が呼ぶ。状態に { suspended: true } を載せて見る側に知らせる。
//     **suspend と resume は呼ぶ側が対にする**（断りは会話の寿命と結ぶ: 会話を消す・Chrome の接続が切れると消え、id が替わると新しい id へ付け替える。
//     windowId なしの resume は、その会話の窓ごとの断りも全部外す）。suspend は呼んだ時に同期で効く（順番待ちの中の付け替え・開始の途中でもフレームを流さない）
//   - 人が映すウィンドウ・タブを選べる（pin(sessionId, windowId, tabId)。右の欄のタブの列）。固定の間は、エージェントがほかへ移っても映像は動かず、
//     固定したタブ、またはウィンドウの中の今のタブ（無ければ最初のタブ）を映す。解くのは pin(sessionId, null)・固定したタブ・ウィンドウが消えたとき・映像の見張りが終わったとき（パネルを閉じる・会話を消す・Chrome の接続が切れる）。
//     固定は会話に 1 つ（端末ごとではない）。エージェントの操作の宛先には影響しない。ウィンドウの変化は onPin で知らせる。
//     「PC で操作する」で映像を止めている間は選べない
//   - 人が操作しているタブ（持ち手が human）から、ページが新しいタブ・ウィンドウを開いたら（openerId のあるタブ）、そのタブへ自動で移る（固定。前の固定を覚える）。
//     そのタブが閉じたら前の固定（開いた元のタブ）へ戻る
//   - 状態に、タブの並びと題（list）・エージェントの今のタブ（agentTabId）・固定したタブ（pinnedTabId）を載せる（タブの列。見ている端末にだけ届く。ログには出さない）
//   - focus emulation の理由は、映像の見張り（watch）ごとの札で数える（relay の view.focus の owner）。閉じてすぐ開き直しても、古い見張りの「手放す」が新しい見張りの理由を消さない
// core/browser-screencast.mjs の createScreencastHub の bridge の形（ready・request・ack・onFrame・onState・onEnded・onAway）に、
// 段の口（setFormats）を足した形で使う。
// 見る側の入力（タップ・文字）は、入力の口のセッションで今のタブへ送り、中継のタブごとの持ち手（relay.unify.tabHolder。ADR 0296）でそのタブを人の操作にする。
// ただし AI のタブ（host.current）は、人が引き継ぐ（持ち手が人になる）までは見るだけで、入力は 'view-only' で断る（カーソルの問い合わせを除く。ADR 0321）。人が開いたタブは今までどおり触れる。
// ページの大きさは変えない（見る人・操作する人・見る人の増減のどれでも。変えると AI の snapshot・クリックの座標が古い画面のものになるため）。
// 人が操作するのは今の実ページをそのまま映したもので、座標は届いたフレームの metadata（端末の大きさ ÷ ページの倍率）で止める。
// ページの大きさを変えるのは AI 自身（中継のセッション経由）と「PC で操作する」の窓だけ。
// 移動は受けない（アドレスバーの chromeNavigate）。URL は状態に載せない。
import { inputCommands, createPageInput } from './input.mjs';

const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 端末の表示の大きさ・倍率・画質を、送ってよい範囲に丸める（フレームの最大の大きさ = 表示の大きさ × 倍率） */
export function chromeScreencastSettings({ width, height, scale, quality } = {}) {
  const s = clamp(scale, 1, 2, 1);
  return {
    quality: Math.round(clamp(quality, 20, 80, 50)),
    maxWidth: Math.round(clamp(Number(width) * s, 200, 1920, 800)),
    maxHeight: Math.round(clamp(Number(height) * s, 200, 1920, 800)),
  };
}

/**
 * @param {object} deps
 * @param deps.host  core/chrome/relay.mjs の view（onChange・summary・tabs・current・attach・focus）
 * @param deps.relay core/chrome/relay.mjs の中継（unify.tabHolder）。映像から入力し、そのタブを人の操作にする（ADR 0296・0297）。ページの大きさは変えない
 */
export function createChromeScreencast({ host, relay, log = () => {} } = {}) {
  const watches = new Map();   // 会話の id -> { formats: Map<段の鍵, 撮る形>, views: Map<段の鍵, セッション>, view（代表。入力・大きさ）, tabId, generation, queue, suspended, announced, pageScaleFactor, deviceWidth, deviceHeight（届いたフレームの metadata）, pin, known, multi }
  let stateSequence = 0;   // このサーバーで発行した状態の順。見張りを閉じて開き直しても戻さない。
  const lastFrames = new Map(); // 人が窓を直接閉じたときの最後の映像（JPEG）。一時停止中も更新しない
  const suspended = new Set(); // 'sessionId' か 'sessionId#windowId'
  const listeners = { frame: new Set(), state: new Set(), ended: new Set(), away: new Set(), pin: new Set(), interaction: new Set() };
  const emit = (kind, ...args) => { for (const fn of [...listeners[kind]]) { try { fn(...args); } catch { /* 聞き手の失敗は映像を壊さない */ } } };

  const isSuspended = (sessionId, windowId = null) => suspended.has(sessionId) || (windowId != null && suspended.has(`${sessionId}#${windowId}`));
  const windowOf = (sessionId, tabId) => (tabId ? host.tabs(sessionId).find(tab => tab.targetId === tabId)?.windowId ?? null : null);
  const keysOf = sessionId => [...suspended].filter(key => key === sessionId || key.startsWith(`${sessionId}#`));
  /** 会話の断りを全部消す（会話を消した・Chrome の接続が切れた） */
  const dropSuspension = sessionId => { for (const key of keysOf(sessionId)) suspended.delete(key); };
  /** 会話の id が替わった: 断りも新しい id へ付け替える */
  const moveSuspension = (from, to) => { for (const key of keysOf(from)) { suspended.delete(key); suspended.add(`${to}${key.slice(from.length)}`); } };

  /** タブの並びと題・開いた元（relay の view.items。古い口しか無ければ題なし） */
  const itemsOf = sessionId => host.items?.(sessionId) ?? host.tabs(sessionId).map(tab => ({ ...tab, title: '', openerId: null }));
  function stateOf(sessionId, watch) {
    const summary = host.summary(sessionId);
    return { sequence:++stateSequence, tabId: watch.tabId ?? null, agent: summary.operating, suspended: watch.suspended, tabs: summary.tabs, pinnedWindowId: pinWindowOf(sessionId, watch), pinnedTabId: watch.pin?.tabId ?? null,
      agentTabId: host.current(sessionId), list: itemsOf(sessionId).map(item => ({ tabId: item.targetId, windowId: item.windowId ?? null, title: item.title ?? '' })) };
  }
  /** 固定しているウィンドウ（タブを固定していれば、そのタブの今の窓）。無ければ null */
  function pinWindowOf(sessionId, watch) {
    const pin = watch.pin;
    if (!pin) return null;
    if (pin.tabId) return host.tabs(sessionId).find(tab => tab.targetId === pin.tabId)?.windowId ?? pin.windowId ?? null;
    return pin.windowId;
  }
  /** 固定を変える（next: { windowId, tabId, auto, back } か null）。固定したウィンドウが変わったときだけ聞き手（chromeWindow の配信）へ知らせる */
  function setPin(sessionId, watch, next) {
    const before = watch.pin, beforeWindow = pinWindowOf(sessionId, watch);
    watch.pin = next ?? null;
    const changed = (before?.windowId ?? null) !== (watch.pin?.windowId ?? null) || (before?.tabId ?? null) !== (watch.pin?.tabId ?? null);
    const window = pinWindowOf(sessionId, watch);
    if (window !== beforeWindow) emit('pin', sessionId, window);
    return changed;
  }
  const alive = (pin, tabs) => pin.tabId ? tabs.some(tab => tab.targetId === pin.tabId) : tabs.some(tab => tab.windowId === pin.windowId);
  /**
   * 映すタブを決める: 固定したタブがあればそれ、固定したウィンドウがあればその中（今のタブがそこにあればそれ、無ければ最初のタブ）、無ければ AI のタブ（無ければ最初のタブ）。
   * 固定したタブ・ウィンドウが消えていれば、自動で移った分は前の固定（開いた元のタブ）へ戻し、人が選んだ分は固定を解く
   */
  function targetOf(sessionId, watch) {
    const current = host.current(sessionId);
    const tabs = host.tabs(sessionId);
    while (watch.pin && !alive(watch.pin, tabs)) setPin(sessionId, watch, watch.pin.auto ? watch.pin.back : null);
    const pin = watch.pin;
    // AI のタブが無いとき（まだ操作していない・閉じた）は、映すだけ最初のタブにする。AI のタブ扱い（印・見るだけ）にはならない（host.current は null のまま。ADR 0321）
    if (!pin) return current ?? tabs[0]?.targetId ?? null;
    if (pin.tabId) return pin.tabId;
    const inWindow = tabs.filter(tab => tab.windowId === pin.windowId);
    return (inWindow.find(tab => tab.targetId === current) ?? inWindow[0]).targetId;
  }
  /** 人が操作しているタブ（か、そこから自動で移ったタブ）から、ページが開いた新しいタブ（開いた元が範囲のタブ）へ移る。知っているタブの一覧はいつも更新する */
  function followOpened(sessionId, watch) {
    const items = itemsOf(sessionId);
    const known = watch.known;
    watch.known = new Set(items.map(item => item.targetId));
    if (watch.suspended) return;
    for (const item of items) {
      if (known.has(item.targetId) || !item.openerId || !watch.known.has(item.openerId)) continue;
      const followed = watch.pin?.auto && watch.pin.tabId === item.openerId;   // ログインのポップアップが、さらに窓を開くとき
      if (!followed && relay.unify.tabHolder.holder(sessionId, item.openerId)?.holder !== 'human') continue;
      setPin(sessionId, watch, { windowId: item.windowId ?? null, tabId: item.targetId, auto: true, back: watch.pin });
    }
  }
  const pushState = (sessionId, watch) => {
    if (watches.get(sessionId) !== watch) return;
    watch.announced = watch.suspended;   // 端末へ知らせた断りの状態（suspend が同期で立てた分も、follow が知らせる）
    emit('state', sessionId, stateOf(sessionId, watch));
  };

  /** 段ごとの撮る形（formats の 1 要素）を、startScreencast の引数にする */
  const screencastParams = format => ({ format: 'jpeg', quality: format.quality, maxWidth: format.maxWidth, maxHeight: format.maxHeight, everyNthFrame: 1 });

  /** 1 つの映像のセッションを外す（screencast を止めてから detach。ページの大きさは入力の口のセッションが持つ） */
  async function detachView(watch, key, sessionId) {
    const view = watch.views.get(key);
    if (!view) return;
    if (view.streamToken) view.streamToken.active = false;
    watch.views.delete(key);
    if (watch.view === view) watch.view = watch.views.values().next().value ?? null;
    await view.send('Page.stopScreencast').catch(() => {});
    await view.detach().catch(() => {});
  }

  /** 映像のセッションを全部外し、focus emulation を手放す */
  async function release(watch, sessionId) {
    const tabId = watch.tabId;
    watch.tabId = null; watch.pageScaleFactor = 1; watch.deviceWidth = null; watch.deviceHeight = null; watch.generation += 1;
    if (watch.pageInput) { await watch.pageInput.dispose(); watch.pageInput = null; }
    if (watch.inputView) { await watch.inputView.detach().catch(() => {}); watch.inputView = null; }
    for (const key of [...watch.views.keys()]) await detachView(watch, key, sessionId);
    watch.view = null;
    if (tabId) await host.focus(sessionId, tabId, false, watch).catch(() => {});   // ターンの間・ほかの見張りがいれば、その分は残る
  }

  /** 1 つの段のセッションを、今のタブへ付けて screencast を始める */
  async function attachStream(sessionId, watch, targetId, key, format, generation) {
    const token = { active:true };
    const view = await host.attach(sessionId, targetId, (method, params) => {
      if (token.active) onViewEvent(sessionId, watch, generation, key, method, params, targetId, format);
    });
    view.streamToken = token;
    if (watches.get(sessionId) !== watch || watch.generation !== generation) { token.active = false; await view.detach().catch(() => {}); return false; }
    try {
      await view.send('Page.startScreencast', screencastParams(format));
      view.format = format;
    } catch (error) {
      token.active = false;
      await view.detach().catch(() => {});
      throw error;
    }
    if (watches.get(sessionId) !== watch || watch.generation !== generation) {
      token.active = false;
      await view.send('Page.stopScreencast').catch(() => {});
      await view.detach().catch(() => {});
      return false;
    }
    watch.views.set(key, view);
    watch.view ??= view;
    return true;
  }

  /** 今のタブへ、段の一覧どおりのセッションを揃える（足りない分を付け、余分を外し、変わった分は掛け直す） */
  async function syncStreams(sessionId, watch, targetId, generation) {
    const wanted = watch.formats;
    for (const key of [...watch.views.keys()]) if (!wanted.has(key)) await detachView(watch, key, sessionId);
    let failed = null;
    for (const [key, format] of wanted) {
      const view = watch.views.get(key);
      if (view) {
        const same = view.format && view.format.quality === format.quality && view.format.maxWidth === format.maxWidth && view.format.maxHeight === format.maxHeight;
        if (!same) {
          await detachView(watch, key, sessionId);
          try { await attachStream(sessionId, watch, targetId, key, format, generation); }
          catch (error) { failed = error; break; }
        }
        continue;
      }
      if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
      try { await attachStream(sessionId, watch, targetId, key, format, generation); }
      catch (error) { failed = error; break; }
    }
    // 2 つ目以降のセッションが付けられない（この Chrome は段ごとに分けられない）: 一番低い段の 1 つにそろえる
    if (failed && watch.views.size && wanted.size > 1 && watch.multi !== false) {
      watch.multi = false;
      const lowest = [...wanted.values()].reduce((a, b) => (a.tier <= b.tier ? a : b));
      watch.formats = new Map([[lowest.tier, lowest]]);
      for (const key of [...watch.views.keys()]) if (key !== lowest.tier) await detachView(watch, key, sessionId);
      if (!watch.views.has(lowest.tier)) await attachStream(sessionId, watch, targetId, lowest.tier, lowest, generation);
      return;
    }
    if (failed) throw failed;
  }

  // 設定の変更は会話ごとに直列化する。失敗した設定を確定せず、前の配信を復元して呼び出し元へ失敗を返す。
  function changeFormats(sessionId, watch, formats) {
    const run = watch.queue.then(async () => {
      if (watches.get(sessionId) !== watch) throw new Error('not-watching');
      const previous = watch.formats;
      watch.formats = formats;
      if (!watch.tabId) return;
      try { await syncStreams(sessionId, watch, watch.tabId, watch.generation); }
      catch (error) {
        watch.formats = previous;
        if (watches.get(sessionId) !== watch) throw error;
        let restored = false;
        try { await syncStreams(sessionId, watch, watch.tabId, watch.generation); restored = watch.views.size > 0; }
        catch (restoreError) { log(`chrome-screencast: restore failed: ${restoreError?.message ?? restoreError}`); }
        throw Object.assign(new Error(error?.message ?? String(error), { cause:error }), { screencastRestored:restored });
      }
    });
    watch.queue = run.catch(() => {});
    return run;
  }

  async function attachTo(sessionId, watch, targetId) {
    const generation = ++watch.generation;
    await syncStreams(sessionId, watch, targetId, generation);
    if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
    if (watch.views.size) watch.tabId = targetId;
    if (watch.tabId) {
      const view = await host.attach(sessionId, targetId, (method, params) => {
        if (watch.generation === generation) watch.pageInput?.event(method, params);
      });
      if (watch.generation !== generation || watches.get(sessionId) !== watch) { await view.detach(); return; }
      watch.inputView = view;
      // 見るだけの AI のタブの確認の窓は、人がタブを替えた・パネルを閉じたくらいでは閉じない（AI が答える窓。ADR 0321）
      watch.pageInput = createPageInput({ send: (method, params) => view.send(method, params), keepDialogs: () => viewOnly(sessionId, targetId), emit: message => {
        if (watch.generation === generation) emit('interaction', sessionId, { ...message, tabId: targetId }, message.type === 'fields' ? null : watch.inputClient);
      } });
      await watch.pageInput.start().catch(() => {}); // Unsupported pages retain keyboard fallback.
    }
    await host.focus(sessionId, targetId, true, watch);
  }

  function onViewEvent(sessionId, watch, generation, key, method, params, targetId, format) {
    if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
    if (method === 'Page.screencastFrame') {
      // 撮影を断っている間は流さない（順番待ちの外でも、断りの鍵を直に見る）
      if (watch.suspended || isSuspended(sessionId, windowOf(sessionId, watch.tabId)) || typeof params.data !== 'string') return;
      const m = params.metadata ?? {};
      watch.pageScaleFactor = m.pageScaleFactor > 0 ? m.pageScaleFactor : 1;
      if (Number.isFinite(m.deviceWidth)) watch.deviceWidth = m.deviceWidth;
      if (Number.isFinite(m.deviceHeight)) watch.deviceHeight = m.deviceHeight;
      lastFrames.set(sessionId, params.data);
      emit('frame', sessionId, { id: params.sessionId, stream: key, tabId:targetId, format, data: params.data,
        metadata: { deviceWidth: m.deviceWidth, deviceHeight: m.deviceHeight, pageScaleFactor: m.pageScaleFactor, offsetTop: m.offsetTop, scrollOffsetX: m.scrollOffsetX, scrollOffsetY: m.scrollOffsetY } });
    } else if (method === 'Target.detachedFromTarget') {
      // Chrome の側で外れた（タブが閉じた・移った）。このタブの映像の理由を手放してから、タブが残っていれば付け直す（付け直せばまた理由を持つ）
      const gone = watch.tabId;
      const view = watch.views.get(key);
      watch.views.delete(key);
      if (watch.view === view) watch.view = watch.views.values().next().value ?? null;
      watch.tabId = null; watch.generation += 1;
      for (const rest of [...watch.views.keys()]) detachView(watch, rest, sessionId).catch(() => {});
      if (gone) host.focus(sessionId, gone, false, watch).catch(() => {});
      follow(sessionId, watch).catch(() => {});
    }
  }

  /** 今のタブ（と撮影を断つかどうか）に映像のセッションを合わせる。同じ会話の呼び出しは順に流す */
  function follow(sessionId, watch) {
    const next = targetOf(sessionId, watch);
    if (next !== watch.tabId || isSuspended(sessionId, windowOf(sessionId, next))) watch.pageInput?.cancelDialogs().catch(() => {});
    const run = watch.queue.then(async () => {
      if (watches.get(sessionId) !== watch) return;
      const targetId = targetOf(sessionId, watch);
      const windowId = targetId ? host.tabs(sessionId).find(tab => tab.targetId === targetId)?.windowId ?? null : null;
      const hold = isSuspended(sessionId, windowId);
      const changed = hold !== watch.announced;
      watch.suspended = hold;
      if (!targetId) { await release(watch, sessionId); pushState(sessionId, watch); return; }   // 窓が無い間は待つ（タブが増えたら付く）
      if (hold) { await release(watch, sessionId); if (changed) pushState(sessionId, watch); return; }
      if (watch.tabId === targetId && watch.views.size && sameKeys(watch)) { if (changed) pushState(sessionId, watch); return; }
      await release(watch, sessionId);
      await attachTo(sessionId, watch, targetId);
      pushState(sessionId, watch);
    });
    watch.queue = run.catch(() => {});
    return run;
  }
  const sameKeys = watch => {
    if (watch.views.size !== watch.formats.size) return false;
    for (const key of watch.views.keys()) if (!watch.formats.has(key)) return false;
    return true;
  };

  function end(sessionId, reason) {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watches.delete(sessionId);
    setPin(sessionId, watch, null);
    release(watch, sessionId).catch(() => {});
    emit('ended', sessionId, reason);
  }

  const off = host.onChange((sessionId, kind, extra) => {
    if (kind === 'reset' || kind === 'forget') { lastFrames.delete(sessionId); dropSuspension(sessionId); end(sessionId, 'closed'); return; }
    if (kind === 'rebind') {
      if (lastFrames.has(extra)) { lastFrames.set(sessionId, lastFrames.get(extra)); lastFrames.delete(extra); }
      moveSuspension(extra, sessionId);
      end(extra, 'closed');
      return;
    }
    const watch = watches.get(sessionId);
    if (!watch) return;
    if (kind === 'operating' || kind === 'title') { pushState(sessionId, watch); return; }
    // tabs / current。窓のタブが 1 つも無くなったら、映像の持ち主（窓）が消えた
    if (!host.summary(sessionId).tabs) { end(sessionId, 'closed'); return; }
    if (kind === 'tabs') followOpened(sessionId, watch);
    // タブの並び・エージェントの今のタブも状態に載るので、付け替えの後に知らせる
    follow(sessionId, watch).then(() => pushState(sessionId, watch), error => { log(`chrome-screencast: follow failed: ${error?.message ?? error}`); });
  });

  async function start(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
    if (!host.summary(sessionId).tabs) throw new Error('no-window');
    // 段の一覧（hub が見る人ごとに決める）か、昔の形（1 つの画質と大きさ）か
    const formats = Array.isArray(options.formats) && options.formats.length
      ? new Map(options.formats.map(format => [format.tier ?? 0, { tier: format.tier ?? 0, quality: Math.round(clamp(format.quality, 20, 100, 55)), maxWidth: Math.round(clamp(format.maxWidth, 100, 4096, 800)), maxHeight: Math.round(clamp(format.maxHeight, 100, 4096, 800)) }]))
      : new Map([[0, { tier: 0, ...chromeScreencastSettings(options) }]]);
    let watch = watches.get(sessionId);
    if (watch) {
      // 大きさ・画質が替わった・段が替わった: 順に揃え直す
      await changeFormats(sessionId, watch, formats);
    } else {
      watch = { formats, views: new Map(), view: null, tabId: null, generation: 0, queue: Promise.resolve(), suspended: false, announced: false, pin: null, multi: true, known: new Set(itemsOf(sessionId).map(item => item.targetId)) };
      watches.set(sessionId, watch);
    }
    try { await follow(sessionId, watch); }
    catch (error) { if (watches.get(sessionId) === watch) { watches.delete(sessionId); await release(watch, sessionId); } throw error; }
    return { tabId: watch.tabId, state: stateOf(sessionId, watch) };
  }

  async function stop(sessionId) {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watches.delete(sessionId);
    setPin(sessionId, watch, null);
    await watch.pageInput?.cancelDialogs();
    await watch.queue;
    await release(watch, sessionId);
  }

  /** 見る人の段の一覧に合わせて、段ごとのセッションを揃え直す（hub が見る人の増減・段の上下で呼ぶ） */
  function setFormats(sessionId, formats) {
    const watch = watches.get(sessionId);
    if (!watch) return Promise.resolve({ multi: false });
    const next = new Map((Array.isArray(formats) ? formats : []).map(format => [format.tier ?? 0,
      { tier: format.tier ?? 0, quality: Math.round(clamp(format.quality, 20, 100, 55)), maxWidth: Math.round(clamp(format.maxWidth, 100, 4096, 800)), maxHeight: Math.round(clamp(format.maxHeight, 100, 4096, 800)) }]));
    if (!next.size) return Promise.resolve({ multi: watch.multi !== false });
    return changeFormats(sessionId, watch, next).then(() => ({ multi: watch.multi !== false }));
  }

  /** 映すタブ（tabId）・ウィンドウ（windowId）を固定する・解いて今のタブを追う（どちらも null）。映像の見張りが無い間は固定しない */
  async function pin(sessionId, windowId, tabId = null) {
    const watch = watches.get(sessionId);
    if (!watch) throw new Error('not-watching');
    if (watch.suspended) throw new Error('operating');   // PC で引き継いでいる間（映像を止めている）は切り替えない
    const tabs = host.tabs(sessionId);
    let next = null;
    if (tabId != null) {
      const tab = tabs.find(item => item.targetId === tabId);
      if (!tab) throw new Error('no-tab');
      next = { windowId: tab.windowId ?? null, tabId, auto: false, back: null };
    } else if (windowId != null) {
      if (!tabs.some(tab => tab.windowId === windowId)) throw new Error('no-window');
      next = { windowId, tabId: null, auto: false, back: null };
    }
    const changed = setPin(sessionId, watch, next);
    await follow(sessionId, watch);
    if (changed) pushState(sessionId, watch);
    return { pinnedWindowId: pinWindowOf(sessionId, watch), pinnedTabId: watch.pin?.tabId ?? null, state: stateOf(sessionId, watch) };
  }

  const on = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  return {
    ready: true,
    async request(action, sessionId, args = {}) {
      switch (action) {
        case 'start': return start(sessionId, args.options ?? {});
        case 'stop': await stop(sessionId); return {};
        case 'pin': return pin(sessionId, args.windowId ?? null, args.tabId ?? null);
        case 'input': return input(sessionId, args.input, args);
        default: throw new Error('unknown');   // 移動・タブの開け閉めはアドレスバーとタブの列（chromeNavigate）
      }
    },
    ack(sessionId, frameId, stream = null) {
      const watch = watches.get(sessionId);
      const view = (stream != null && watch?.views.get(stream)) ?? watch?.view;
      if (view && Number.isInteger(frameId)) view.send('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {});
    },
    setFormats,
    onFrame: on('frame'), onState: on('state'), onEnded: on('ended'), onAway: on('away'),
    /** 固定したウィンドウの変化（sessionId, windowId|null）。chromeWindow の配信が聞く */
    onPin: on('pin'),
    onInteraction: on('interaction'),
    /** 今固定しているウィンドウの id（タブを固定していればその窓。無ければ null） */
    pinned: sessionId => { const watch = watches.get(sessionId); return watch ? pinWindowOf(sessionId, watch) : null; },

    /**
     * 撮影を断つ（「PC で操作する」の間）。windowId があればその窓が今のタブの窓のときだけ、無ければ会話の窓すべて。
     * 断っている間は screencast を止めて focus emulation も外し、フレームを流さない。見ている端末には state.suspended を送る
     */
    suspend(sessionId, windowId = null) {
      suspended.add(windowId == null ? sessionId : `${sessionId}#${windowId}`);
      const watch = watches.get(sessionId);
      if (watch && isSuspended(sessionId, windowOf(sessionId, watch.tabId))) watch.suspended = true;   // 順番待ちを待たずに、今から流さない
      return refollow(sessionId);
    },
    resume(sessionId, windowId = null) {
      if (windowId == null) dropSuspension(sessionId); else suspended.delete(`${sessionId}#${windowId}`);
      return refollow(sessionId);
    },
    isSuspended,
    lastFrame(sessionId) { return lastFrames.get(sessionId) ?? null; },
    forgetFrame(sessionId) { lastFrames.delete(sessionId); },
    close() { off(); lastFrames.clear(); for (const sessionId of [...watches.keys()]) end(sessionId, 'closed'); },
  };

  /** AI のタブ（host.current）で、持ち手が人でない = 見るだけ（人が開いたタブ・人が引き継いだタブは触れる。ADR 0321） */
  function viewOnly(sessionId, tabId) { return tabId != null && host.current(sessionId) === tabId && relay.unify.tabHolder.holder(sessionId, tabId)?.holder !== 'human'; }

  /** 見る側からの入力を、入力の口のセッションで今のタブへ送り、そのタブを人の操作にする（AI のタブは引き継ぐまで断る） */
  async function input(sessionId, value, context = {}) {
    const watch = watches.get(sessionId);
    if (!watch?.inputView) throw new Error('not-watching');
    // A delayed packet from the previous tab must never reach the newly selected tab.
    if (context.tabId !== watch.tabId) throw new Error('no-tab');
    // AI のタブは、人が引き継ぐ（持ち手が人になる）までは見るだけ。画面の封じだけに頼らず、ここでも断る（ADR 0321）。読むだけのカーソルの問い合わせは通す
    if (value?.type !== 'cursor' && viewOnly(sessionId, context.tabId)) throw new Error('view-only');
    const scale = watch.pageScaleFactor || 1;
    // はみ出しの止めどころは、届いたフレームの大きさ（metadata の端末の大きさ ÷ ページの倍率）。override の有無に依らない
    const dims = Number.isFinite(watch.deviceWidth) && Number.isFinite(watch.deviceHeight) ? { width: watch.deviceWidth / scale, height: watch.deviceHeight / scale } : {};
    const commands = inputCommands(value, dims);
    const sheet = ['dialog', 'field', 'select', 'files'].includes(value?.type);
    // 読むための問い合わせ（copy は選択、menu は点の下のもの、cursor はカーソルだけ）
    const query = ['copy', 'menu', 'cursor'].includes(value?.type);
    if (!commands.length && !sheet && !query) throw new Error('invalid-input');
    const point = Number.isFinite(value?.x) && Number.isFinite(value?.y)
      ? { x: Math.min(dims.width ?? 1600, Math.max(0, value.x)), y: Math.min(dims.height ?? 2400, Math.max(0, value.y)) } : null;
    if (value?.type === 'menu' && !point) throw new Error('invalid-input');
    // Chrome holds the triggering input response until its modal dialog is answered.
    // The answer must bypass that response's queue, while still checking the watched tab.
    if (value?.type === 'dialog') {
      if (!await watch.pageInput.input(value)) throw new Error('invalid-input');
      relay.unify.tabHolder.touch({ sessionId, targetId: context.tabId, by: context.device === 'phone' ? 'device' : 'pc',
        viewport: context.device === 'phone' ? context.viewport : null });
      return {};
    }
    // カーソルは見た目の問い合わせ。順番待ちに入れず、人の操作にもしない（映像の上を通るだけで AI を止めない。ADR 0296）
    if (value?.type === 'cursor') {
      const info = point && watch.pageInput ? await watch.pageInput.input({ type: 'cursor', ...point }).catch(() => null) : null;
      return { info: info ?? null };
    }
    const run = watch.queue.then(async () => {
      if (watches.get(sessionId) !== watch || watch.tabId !== context.tabId || !watch.inputView) throw new Error('no-tab');
      if (viewOnly(sessionId, watch.tabId)) throw new Error('view-only');   // 順番待ちの間に AI へ戻った
      watch.inputClient = context.client;
      if (sheet && !await watch.pageInput.input(value)) throw new Error('invalid-input');
      relay.unify.tabHolder.touch({ sessionId, targetId: watch.tabId, by: context.device === 'phone' ? 'device' : 'pc',
        viewport: context.device === 'phone' ? context.viewport : null });
      // コピー・右クリックのメニューは選択や点の下のものを読んで返す（ページの値は問い合わせの中に留める）
      if (query) {
        const probe = value.type === 'menu' ? { type: 'inspect', ...point } : { type: 'selection' };
        return { info: watch.pageInput ? await watch.pageInput.input(probe).catch(() => null) : null };
      }
      // Dispatch the first tap against the geometry that produced the frame.
      for (const [method, params] of commands) await watch.inputView.send(method, params);
      if (value?.type === 'tap' && context.device === 'phone') await watch.pageInput.afterTap().catch(() => {});
      return {};
    });
    watch.queue = run.catch(() => {});
    return run;
  }

  function refollow(sessionId) {
    const watch = watches.get(sessionId);
    return watch ? follow(sessionId, watch).catch(() => {}) : Promise.resolve();
  }
}
