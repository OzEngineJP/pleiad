// エージェントの Chrome の窓の映像（docs/inapp-browser.md「リモートから見る」、ADR 0148「右パネルは見るだけの映像」・ADR 0154・ADR 0297）。
//
// 会話の範囲の「今のタブ」（エージェントが最後にコマンドを送ったタブ。無ければ窓の最初のタブ。core/chrome/relay.mjs の view.current）に、
// 中継自身のセッション（エージェントのものとは別）を付け、タブの focus emulation を保たせて（host.focus）Page.startScreencast を回す。
//   - 映像の段ごとに 1 つのセッション（ADR 0297 §3）。見る人の段が違うと、段ごとの画質・大きさの screencast を同じタブへ並べて回す。
//     段の一覧は hub が setFormats で渡す（formats: [{ tier, quality, maxWidth, maxHeight }]）。段ごとのセッションを開けない
//     Chrome では、見ている人の一番低い段の 1 つにそろえる（multi: false を返す）。フレームは stream（段）つきで流す
//   - 見る人がいる間だけ付け、いなくなったら（stop）止めて focus emulation の理由（relay の view.focus）も手放す。focus emulation 自体は relay が 1 タブ 1 セッションで持ち、
//     ターンの間と映像を見ている間の両方が無くなったときだけ Chrome から外す（Chrome は 1 つのセッションが外すとほかが有効にしていても外れるため。ADR 0154 の実機）
//   - 今のタブが替わったら（エージェントが別のタブに触れた・タブが閉じた）付け替える
//   - 撮影を断つ口: suspend(sessionId[, windowId]) / resume。断っている間は screencast を止め（フレームを撮らない・流さない）、focus emulation も外す。
//     第 6 段の「あなたが操作中」が呼ぶ。状態に { suspended: true } を載せて見る側に知らせる。
//     **suspend と resume は呼ぶ側が対にする**（断りは会話の寿命と結ぶ: 会話を消す・Chrome の接続が切れると消え、id が替わると新しい id へ付け替える。
//     windowId なしの resume は、その会話の窓ごとの断りも全部外す）。suspend は呼んだ時に同期で効く（順番待ちの中の付け替え・開始の途中でもフレームを流さない）
//   - 人が映すウィンドウ・タブを選べる（pin(sessionId, windowId, tabId)。右パネルの番号チップとタブの列）。固定の間は、エージェントがほかへ移っても映像は動かず、
//     固定したタブ、またはウィンドウの中の今のタブ（無ければ最初のタブ）を映す。解くのは pin(sessionId, null)・固定したタブ・ウィンドウが消えたとき・映像の見張りが終わったとき（パネルを閉じる・会話を消す・Chrome の接続が切れる）。
//     固定は会話に 1 つ（端末ごとではない）。エージェントの操作の宛先には影響しない。ウィンドウの変化は onPin で知らせる。
//     端末が引き継いでいる間も選べる（PC が引き継いで映像を止めている間は選べない）
//   - 端末が引き継いでいる間に、ページが新しいタブ・ウィンドウを開いたら（openerId のあるタブ）、そのタブへ自動で移る（固定。前の固定を覚える）。
//     そのタブが閉じたら前の固定（開いた元のタブ）へ戻る。引き継ぎが終わったら、自動で移った分の固定は外す。エージェントはその間タブに触らないので、今のタブは動かない
//   - 状態に、タブの並びと題（list）・エージェントの今のタブ（agentTabId）・固定したタブ（pinnedTabId）を載せる（タブの列。見ている端末にだけ届く。ログには出さない）
//   - focus emulation の理由は、映像の見張り（watch）ごとの札で数える（relay の view.focus の owner）。閉じてすぐ開き直しても、古い見張りの「手放す」が新しい見張りの理由を消さない
// core/browser-screencast.mjs の createScreencastHub の bridge の形（ready・request・ack・onFrame・onState・onEnded・onAway）に、
// 段の口（setFormats）と止まった絵の口（capture）を足した形で使う。
// 見る側の入力（タップ・文字）は、中継のタブごとの持ち手（relay.unify.tabHolder。ADR 0296）があれば入力の口のセッションで今のタブへ送り、そのタブを人の操作にする。
// ページの大きさは見る人と持ち手から決める（core/chrome/viewport.mjs）。移動は受けない。URL は状態に載せない。
// 持ち手の無い形（中継を渡さない。試験だけ）では見るだけで、入力は view-only で断る。operate(sessionId, viewport) の間は、
// ページの大きさを端末の映像の箱に合わせる（Emulation.setDeviceMetricsOverride。operate(sessionId, null) で clearDeviceMetricsOverride）。タブの列の × で、タブを閉じられる（closeTab）。
import { inputCommands, deviceMetrics, createPageInput } from './input.mjs';
import { decideViewport } from './viewport.mjs';

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
 * @param [deps.relay] core/chrome/relay.mjs の中継（unify.tabHolder・onTabEvent）。無ければ映像は見るだけ（入力は断る。本番はいつも渡す）
 */
export function createChromeScreencast({ host, relay = null, log = () => {} } = {}) {
  const unified = !!relay?.unify?.tabHolder;   // タブごとの持ち手（relay.unify.tabHolder）があれば、映像から入力し、ページの大きさを見る人に合わせる（ADR 0296・0297）
  const viewers = new Map();
  const watches = new Map();   // 会話の id -> { formats: Map<段の鍵, 撮る形>, views: Map<段の鍵, セッション>, view（代表。入力・大きさ）, tabId, generation, queue, suspended, announced, metrics, pin, known, multi }
  const lastFrames = new Map(); // 人が窓を直接閉じたときの最後の映像（JPEG）。一時停止中も更新しない
  const suspended = new Set(); // 'sessionId' か 'sessionId#windowId'
  const operated = new Map();  // 会話の id -> 端末の映像の箱（{ width, height, scale }。端末が引き継いでいる間）
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
    return { tabId: watch.tabId ?? null, agent: summary.operating, suspended: watch.suspended, tabs: summary.tabs, pinnedWindowId: pinWindowOf(sessionId, watch), pinnedTabId: watch.pin?.tabId ?? null,
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
   * 映すタブを決める: 固定したタブがあればそれ、固定したウィンドウがあればその中（今のタブがそこにあればそれ、無ければ最初のタブ）、無ければ今のタブ。
   * 固定したタブ・ウィンドウが消えていれば、自動で移った分は前の固定（開いた元のタブ）へ戻し、人が選んだ分は固定を解く
   */
  function targetOf(sessionId, watch) {
    const current = host.current(sessionId);
    const tabs = host.tabs(sessionId);
    while (watch.pin && !alive(watch.pin, tabs)) setPin(sessionId, watch, watch.pin.auto ? watch.pin.back : null);
    const pin = watch.pin;
    if (!pin) return current;
    if (pin.tabId) return pin.tabId;
    const inWindow = tabs.filter(tab => tab.windowId === pin.windowId);
    return (inWindow.find(tab => tab.targetId === current) ?? inWindow[0]).targetId;
  }
  /** 端末が引き継いでいる間に、ページが開いた新しいタブ（開いた元が範囲のタブ）へ移る。知っているタブの一覧はいつも更新する */
  function followOpened(sessionId, watch) {
    const items = itemsOf(sessionId);
    const known = watch.known;
    watch.known = new Set(items.map(item => item.targetId));
    if (!operated.has(sessionId) || watch.suspended) return;
    for (const item of items) {
      if (known.has(item.targetId) || !item.openerId || !watch.known.has(item.openerId)) continue;
      setPin(sessionId, watch, { windowId: item.windowId ?? null, tabId: item.targetId, auto: true, back: watch.pin });
    }
  }
  /** 自動で移った分の固定を外す（引き継ぎが終わった） */
  function dropAutoPins(sessionId, watch) {
    let changed = false;
    while (watch.pin?.auto) changed = setPin(sessionId, watch, watch.pin.back) || changed;
    return changed;
  }
  const pushState = (sessionId, watch) => {
    if (watches.get(sessionId) !== watch) return;
    watch.announced = watch.suspended;   // 端末へ知らせた断りの状態（suspend が同期で立てた分も、follow が知らせる）
    emit('state', sessionId, stateOf(sessionId, watch));
  };

  /** 段ごとの撮る形（formats の 1 要素）を、startScreencast の引数にする */
  const screencastParams = format => ({ format: 'jpeg', quality: format.quality, maxWidth: format.maxWidth, maxHeight: format.maxHeight, everyNthFrame: 1 });

  /** 1 つの映像のセッションを外す（screencast を止め、大きさを戻してから detach） */
  async function detachView(watch, key, sessionId) {
    const view = watch.views.get(key);
    if (!view) return;
    watch.views.delete(key);
    if (watch.view === view) watch.view = watch.views.values().next().value ?? null;
    await view.send('Page.stopScreencast').catch(() => {});
    if (view.metrics) await view.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await view.detach().catch(() => {});
  }

  /** 映像のセッションを全部外し、focus emulation を手放す */
  async function release(watch, sessionId) {
    const tabId = watch.tabId;
    watch.tabId = null; watch.viewport = null; watch.pageScaleFactor = 1; watch.generation += 1;
    if (watch.pageInput) { await watch.pageInput.dispose(); watch.pageInput = null; }
    if (watch.inputView) { await watch.inputView.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await watch.inputView.detach().catch(() => {}); watch.inputView = null; }
    for (const key of [...watch.views.keys()]) await detachView(watch, key, sessionId);
    watch.view = null;
    if (tabId) await host.focus(sessionId, tabId, false, watch).catch(() => {});   // ターンの間・ほかの見張りがいれば、その分は残る
  }

  /** 1 つの段のセッションを、今のタブへ付けて screencast を始める */
  async function attachStream(sessionId, watch, targetId, key, format, generation) {
    const view = await host.attach(sessionId, targetId, (method, params) => onViewEvent(sessionId, watch, generation, key, method, params));
    if (watches.get(sessionId) !== watch || watch.generation !== generation) { await view.detach().catch(() => {}); return false; }
    try {
      if (operated.has(sessionId)) { await view.send('Emulation.setDeviceMetricsOverride', deviceMetrics(operated.get(sessionId))); view.metrics = true; }
      await view.send('Page.startScreencast', screencastParams(format));
    } catch (error) {
      await view.detach().catch(() => {});
      throw error;
    }
    watch.views.set(key, view);
    watch.view ??= view;
    return true;
  }

  /** 今のタブへ、段の一覧どおりのセッションを揃える（足りない分を付け、余分を外し、変わった分は掛け直す） */
  async function syncStreams(sessionId, watch, targetId, generation) {
    const wanted = watch.formats;
    for (const key of [...watch.views.keys()]) if (!wanted.has(key)) await detachView(watch, key, sessionId);
    let failed = false;
    for (const [key, format] of wanted) {
      const view = watch.views.get(key);
      if (view) {
        const same = view.format && view.format.quality === format.quality && view.format.maxWidth === format.maxWidth && view.format.maxHeight === format.maxHeight;
        if (!same) {
          await view.send('Page.stopScreencast').catch(() => {});
          await view.send('Page.startScreencast', screencastParams(format)).catch(() => { failed = true; });
          if (!failed) view.format = format;
        }
        continue;
      }
      if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
      try { await attachStream(sessionId, watch, targetId, key, format, generation); }
      catch { failed = true; break; }
    }
    // 2 つ目以降のセッションが付けられない（この Chrome は段ごとに分けられない）: 一番低い段の 1 つにそろえる
    if (failed && watch.views.size && wanted.size > 1 && watch.multi !== false) {
      watch.multi = false;
      const lowest = [...wanted.values()].reduce((a, b) => (a.tier <= b.tier ? a : b));
      watch.formats = new Map([[lowest.tier, lowest]]);
      for (const key of [...watch.views.keys()]) if (key !== lowest.tier) await detachView(watch, key, sessionId);
      if (!watch.views.has(lowest.tier)) await attachStream(sessionId, watch, targetId, lowest.tier, lowest, generation).catch(() => {});
    }
  }

  async function attachTo(sessionId, watch, targetId) {
    const generation = ++watch.generation;
    await syncStreams(sessionId, watch, targetId, generation);
    if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
    if (watch.views.size) watch.tabId = targetId;
    if (unified && watch.tabId) {
      const view = await host.attach(sessionId, targetId, (method, params) => {
        if (watch.generation === generation) watch.pageInput?.event(method, params);
      });
      if (watch.generation !== generation || watches.get(sessionId) !== watch) { await view.detach(); return; }
      watch.inputView = view;
      watch.pageInput = createPageInput({ send: (method, params) => view.send(method, params), emit: message => {
        if (watch.generation === generation) emit('interaction', sessionId, { ...message, tabId: targetId }, message.type === 'fields' ? null : watch.inputClient);
      } });
      await watch.pageInput.start().catch(() => {}); // Unsupported pages retain keyboard fallback.
      await syncViewport(sessionId, watch);
    }
    await host.focus(sessionId, targetId, true, watch);
  }

  function onViewEvent(sessionId, watch, generation, key, method, params) {
    if (watches.get(sessionId) !== watch || watch.generation !== generation) return;
    if (method === 'Page.screencastFrame') {
      // 撮影を断っている間は流さない（順番待ちの外でも、断りの鍵を直に見る）
      if (watch.suspended || isSuspended(sessionId, windowOf(sessionId, watch.tabId)) || typeof params.data !== 'string') return;
      const m = params.metadata ?? {};
      if (unified) watch.pageScaleFactor = m.pageScaleFactor > 0 ? m.pageScaleFactor : 1;
      lastFrames.set(sessionId, params.data);
      emit('frame', sessionId, { id: params.sessionId, stream: key, data: params.data,
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
    if (kind === 'reset' || kind === 'forget') { lastFrames.delete(sessionId); dropSuspension(sessionId); operated.delete(sessionId); end(sessionId, 'closed'); return; }
    if (kind === 'rebind') {
      if (lastFrames.has(extra)) { lastFrames.set(sessionId, lastFrames.get(extra)); lastFrames.delete(extra); }
      moveSuspension(extra, sessionId);
      if (operated.has(extra)) { operated.set(sessionId, operated.get(extra)); operated.delete(extra); }
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
      watch.formats = formats;
      // 大きさ・画質が替わった・段が替わった: 順に揃え直す
      if (watch.tabId) {
        const run = watch.queue.then(async () => {
          if (watches.get(sessionId) !== watch || !watch.tabId) return;
          await syncStreams(sessionId, watch, watch.tabId, watch.generation);
        });
        watch.queue = run.catch(() => {});
        await run.catch(() => {});
      }
    } else {
      watch = { formats, views: new Map(), view: null, tabId: null, generation: 0, queue: Promise.resolve(), suspended: false, announced: false, metrics: false, pin: null, multi: true, known: new Set(itemsOf(sessionId).map(item => item.targetId)) };
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
    watch.formats = next;
    const run = watch.queue.then(async () => {
      if (watches.get(sessionId) !== watch || !watch.tabId) return;
      await syncStreams(sessionId, watch, watch.tabId, watch.generation);
    });
    watch.queue = run.catch(() => {});
    return run.then(() => ({ multi: watch.multi !== false }), () => ({ multi: watch.multi !== false }));
  }

  /** 止まった絵を鮮明にする 1 枚（ページが変わらずフレームが来ない間、hub が見る人ごとに頼む） */
  async function capture(sessionId, { quality = 80 } = {}) {
    const watch = watches.get(sessionId);
    const view = watch?.view;
    if (!watch || !view || watch.suspended) throw new Error('not-watching');
    const shot = await view.send('Page.captureScreenshot', { format: 'jpeg', quality: Math.round(clamp(quality, 20, 100, 80)) });
    return { data: typeof shot?.data === 'string' ? shot.data : null };
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

  /**
   * タブを閉じる（端末が引き継いでいる間のタブの列の ×）。最後のタブは閉じない（窓を閉じるのは ⋯ の確かめを通す）。
   * 映しているタブを閉じるなら、開いた元のタブ（無ければ隣のタブ）へ先に自動で移る（自動で移ったタブは、閉じた後に前の固定へ戻る）
   */
  async function closeTab(sessionId, tabId) {
    if (!operated.has(sessionId)) throw new Error('view-only');
    const watch = watches.get(sessionId);
    if (!watch) throw new Error('not-watching');
    const items = itemsOf(sessionId);
    const tab = items.find(item => item.targetId === tabId);
    if (!tab) throw new Error('no-tab');
    if (items.length < 2) throw new Error('last-tab');
    if (watch.tabId === tabId && !watch.pin?.auto) {
      const same = items.filter(item => item.windowId === tab.windowId);
      const index = same.indexOf(tab);
      const next = items.find(item => item.targetId === tab.openerId) ?? same[index - 1] ?? same[index + 1] ?? items.find(item => item.targetId !== tabId);
      setPin(sessionId, watch, { windowId: next.windowId ?? null, tabId: next.targetId, auto: true, back: null });   // 選んだタブが無くなった代わり。引き継ぎが終われば外す
    }
    try { await host.closeTab(sessionId, tabId); }
    finally { refollow(sessionId); }
    return {};
  }

  const on = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  const offTab = unified ? relay.onTabEvent?.((type, payload) => {
    if (type !== 'tab:holder') return;
    const watch = watches.get(payload.sessionId);
    if (!watch || payload.targetId !== watch.tabId) return;
    const run = watch.queue.then(() => syncViewport(payload.sessionId, watch));
    watch.queue = run.catch(() => {});
  }) : null;
  return {
    ready: true,
    unified,
    async request(action, sessionId, args = {}) {
      switch (action) {
        case 'start': return start(sessionId, args.options ?? {});
        case 'stop': await stop(sessionId); return {};
        case 'pin': return pin(sessionId, args.windowId ?? null, args.tabId ?? null);
        case 'closeTab': return closeTab(sessionId, args.tabId);
        case 'input': return input(sessionId, args.input, args);
        default: throw new Error('view-only');   // 移動・エージェントの操作は受けない。入力も端末が引き継いでいる間だけ
      }
    },
    ack(sessionId, frameId, stream = null) {
      const watch = watches.get(sessionId);
      const view = (stream != null && watch?.views.get(stream)) ?? watch?.view;
      if (view && Number.isInteger(frameId)) view.send('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {});
    },
    setFormats,
    capture,
    onFrame: on('frame'), onState: on('state'), onEnded: on('ended'), onAway: on('away'),
    /** 固定したウィンドウの変化（sessionId, windowId|null）。chromeWindow の配信が聞く */
    onPin: on('pin'),
    onInteraction: on('interaction'),
    async setViewers(sessionId, list) {
      if (!unified) return;
      if (list.length) viewers.set(sessionId, list); else viewers.delete(sessionId);
      const watch = watches.get(sessionId);
      if (!watch) return;
      const run = watch.queue.then(() => syncViewport(sessionId, watch));
      watch.queue = run.catch(() => {});
      await run;
    },
    /** 今固定しているウィンドウの id（タブを固定していればその窓。無ければ null） */
    pinned: sessionId => { const watch = watches.get(sessionId); return watch ? pinWindowOf(sessionId, watch) : null; },

    /**
     * 撮影を断つ（第 6 段の「あなたが操作中」）。windowId があればその窓が今のタブの窓のときだけ、無ければ会話の窓すべて。
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
    /**
     * 端末が引き継いだ（viewport = { width, height, scale }）・戻した（null）。引き継いでいる間だけ入力を通し、ページの大きさを端末に合わせる。
     * 映像のセッションが付いていなければ、付いたとき（start・付け替え）に合わせる
     */
    operate(sessionId, viewport) {
      if (viewport) operated.set(sessionId, viewport); else operated.delete(sessionId);
      const watch = watches.get(sessionId);
      if (!watch) return Promise.resolve();
      if (!viewport && dropAutoPins(sessionId, watch)) { refollow(sessionId).then(() => pushState(sessionId, watch)); }
      const run = watch.queue.then(async () => {
        for (const view of watch.views.values()) {
          if (viewport) { await view.send('Emulation.setDeviceMetricsOverride', deviceMetrics(viewport)); view.metrics = true; }
          else if (view.metrics) { view.metrics = false; await view.send('Emulation.clearDeviceMetricsOverride'); }
        }
      });
      watch.queue = run.catch(() => {});
      return run.catch(error => log(`chrome-screencast: metrics failed: ${error?.message ?? error}`));
    },
    operating: sessionId => operated.has(sessionId),
    watching: () => [...watches.keys()],
    lastFrame(sessionId) { return lastFrames.get(sessionId) ?? null; },
    forgetFrame(sessionId) { lastFrames.delete(sessionId); },
    close() { off(); offTab?.(); viewers.clear(); lastFrames.clear(); for (const sessionId of [...watches.keys()]) end(sessionId, 'closed'); },
  };

  /** 端末からの入力を、入力の口のセッションで今のタブへ送る。タブごとの持ち手（relay）が無ければ見るだけ（view-only） */
  async function input(sessionId, value, context = {}) {
    if (!unified) throw new Error('view-only');
    const watch = watches.get(sessionId);
    if (!watch?.inputView) throw new Error('not-watching');
    // A delayed packet from the previous tab must never reach the newly selected tab.
    if (context.tabId !== watch.tabId) throw new Error('no-tab');
    const scale = watch.pageScaleFactor || 1;
    const commands = inputCommands(value, watch.viewport ? { width: watch.viewport.width / scale, height: watch.viewport.height / scale } : {});
    const sheet = ['dialog', 'field', 'select', 'files'].includes(value?.type);
    if (!commands.length && !sheet) throw new Error('invalid-input');
    // Chrome holds the triggering input response until its modal dialog is answered.
    // The answer must bypass that response's queue, while still checking the watched tab.
    if (value?.type === 'dialog') {
      if (!await watch.pageInput.input(value)) throw new Error('invalid-input');
      relay.unify.tabHolder.touch({ sessionId, targetId: context.tabId, by: context.device === 'phone' ? 'device' : 'pc',
        viewport: context.device === 'phone' ? context.viewport : null });
      return {};
    }
    const run = watch.queue.then(async () => {
      if (watches.get(sessionId) !== watch || watch.tabId !== context.tabId || !watch.inputView) throw new Error('no-tab');
      watch.inputClient = context.client;
      if (sheet && !await watch.pageInput.input(value)) throw new Error('invalid-input');
      relay.unify.tabHolder.touch({ sessionId, targetId: watch.tabId, by: context.device === 'phone' ? 'device' : 'pc',
        viewport: context.device === 'phone' ? context.viewport : null });
      // Dispatch the first tap against the geometry that produced the frame. Resize after it.
      for (const [method, params] of commands) await watch.inputView.send(method, params);
      if (value?.type === 'tap' && context.device === 'phone') await watch.pageInput.afterTap().catch(() => {});
      await syncViewport(sessionId, watch);
      return {};
    });
    watch.queue = run.catch(() => {});
    return run;
  }

  async function syncViewport(sessionId, watch) {
    if (!unified || !watch.inputView || !watch.tabId) return;
    const list = viewers.get(sessionId) ?? [];
    const holder = relay.unify.tabHolder.holder(sessionId, watch.tabId);
    // 操作中のスマホの箱が変わった（キーボードを閉じた）ら今の箱で。触ったときの箱のままだと、次に触るまで縮んだまま
    const typing = list.find(viewer => viewer.device === 'phone' && viewer.client && viewer.client === watch.inputClient)?.box;
    const viewport = decideViewport({ operating: holder?.holder === 'human' && holder.by === 'device' ? typing ?? holder.viewport : null,
      panel: list.find(viewer => viewer.device !== 'phone')?.box,
      watching: list.find(viewer => viewer.device === 'phone')?.box });
    const { source, ...metrics } = viewport;
    if (JSON.stringify(metrics) === JSON.stringify(watch.viewport)) return;
    await watch.inputView.send('Emulation.setDeviceMetricsOverride', metrics);
    watch.viewport = metrics;
    emit('interaction', sessionId, { type: 'viewport', tabId: watch.tabId, ...metrics, source });
  }

  function refollow(sessionId) {
    const watch = watches.get(sessionId);
    return watch ? follow(sessionId, watch).catch(() => {}) : Promise.resolve();
  }
}
