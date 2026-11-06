// リモートの画面から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」、ADR 0041）。
// ページを持つのはデスクトップ版の main（desktop/browser-screencast.cjs）。ここは worker 側で、
//   - parentPortScreencast: main との口（依頼と応答、フレーム・状態・終わりの受け取り、ack）
//   - createScreencastHub: 会話ごとに見ている端末を束ね、フレームを配る。見る端末がいなくなったら止める
// 映像の送り方（ADR 0294。ADR 0148 の画質の選び方を置き換える）:
//   - フレームが届いたら、見ている端末を待たずにすぐ撮影元へ ack を返す（Chrome は ack のあと次を出す。返事を待つと 5 fps を超えない）
//   - 見る人（接続）ごとに「届いていない 1 枚」だけを持つ。見る人の返事（browserScreencastAck）が来たら、そのときの最新の 1 枚をすぐ送る。
//     返事を待つ間に届いたフレームは最新で上書きする。遅い端末は自分の分だけ fps が下がり、ほかの見る人には響かない
//   - 各フレームの直前に小さな印（type: 'mark'）を送り、見る人は印にもフレームにも返事を返す（ack の args.mark）。
//     S = フレームの返事の時刻 − 印の返事の時刻（往復の遅れを除いた、中身を運ぶのにかかった時間）で、段を自動で上下する
//   - 段は SCREENCAST_TIERS（k 0.4/0.67/1 × q 30/55/80 の 7 段）。段ごとの撮影の口は bridge の能力で分かれる:
//       · bridge.setFormats がある（core/chrome/screencast.mjs）: 段ごとに中継のセッションを分ける（フレームは stream（段）つきで届く）
//       · 無い（内蔵ブラウザー）: 見ている人の中で一番低い段にそろえ、変わったら start を掛け直す（画質だけ。大きさは端末の箱のまま）
//   - 見る人に 300 ms フレームが届かなければ、bridge.capture（あれば）で最上段の 1 枚を 1 回だけ送る（止まった絵を鮮明に）
//   - 段 0 でも S の中央値が 50 ms を超え続ける → lag、返事が 3 秒来ない → stale を、type: 'video' のメッセージで見る人へ知らせる
// 映像の出どころは 2 つ（bridge を差し替える）。内蔵ブラウザー（main が持つ。上の parentPortScreencast）と、エージェントの Chrome の窓
// （core/chrome/screencast.mjs。同じ形の bridge。args.source === 'chrome'）。Chrome の窓はホストの画面からもリモートの端末からも見られ、入力は受けない（見るだけ）。
// hub は source を messages に載せ、画面が内蔵ブラウザーの映像と取り違えないようにする。
// main が居なくなった（更新）ときは、ページ（内蔵ブラウザーのタブ）ごと消えるので、見ている端末へ ended('away') を送って畳む
// （待っていた依頼は失敗にし、新しい main の browser-screencast-ready まで ready は false。docs/zero-downtime-update/design.md §7.2）。

export function parentPortScreencast(port, { timeoutMs = 15_000 } = {}) {
  if (!port) return null;
  const pending = new Map();
  let next = 0, ready = false;
  const listeners = { frame: new Set(), state: new Set(), ended: new Set(), away: new Set() };
  port.on('message', event => {
    const message = event?.data ?? event;
    switch (message?.type) {
      case 'browser-screencast-ready': ready = true; return;
      case 'browser-screencast-frame': for (const fn of listeners.frame) fn(message.sessionId, message.frame); return;
      case 'browser-screencast-state': for (const fn of listeners.state) fn(message.sessionId, message.state); return;
      case 'browser-screencast-ended': for (const fn of listeners.ended) fn(message.sessionId, message.reason); return;
      case 'browser-screencast': {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.ok) item.resolve(message.result ?? {}); else item.reject(new Error(message.error || 'screencast failed'));
      }
    }
  });
  // 名前付きパイプの口（main が付け直す）で main が切れた。見ている端末の画は戻らないので、依頼を落とし、ready を下げて、畳ませる
  port.on('disconnect', () => {
    ready = false;
    for (const [id, item] of [...pending]) { pending.delete(id); clearTimeout(item.timer); item.reject(new Error('main is away')); }
    for (const fn of listeners.away) fn();
  });
  const on = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  return {
    get ready() { return ready; },
    request(action, sessionId, args = {}) {
      return new Promise((resolve, reject) => {
        const id = `sc${++next}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('screencast timeout')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: 'browser-screencast', id, action, sessionId, ...args });
      });
    },
    ack(sessionId, frameId) { port.postMessage({ type: 'browser-screencast-ack', sessionId, frameId }); },
    onFrame: on('frame'), onState: on('state'), onEnded: on('ended'), onAway: on('away'),
  };
}

export const SCREENCAST_COMMANDS = ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput', 'browserScreencastNav'];

/**
 * WS のコマンドを処理する（core/server.mjs から呼ぶ）。戻り値は { ok, result } か { ok: false, code }。
 * 内蔵ブラウザーの映像は、リモートの接続（ADR 0010 の isLocalRequest が false）からだけ受ける。ホストの画面には内蔵ブラウザーそのものがある。
 * args.source === 'chrome' は、エージェントの Chrome の窓の映像（chrome = { hub, bridge }）。ホストの画面もリモートも見られるが、見るだけ（移動は view-only）。
 * 入力はリモートの端末からだけ受け、端末が引き継いでいる間かは bridge（core/chrome/screencast.mjs）が決める（それ以外は view-only）。
 * 入力・移動は、その会話を見ている接続からだけ。
 * snapshotFile({ sessionId, id, at, allow? }) は可視化の写しを書き出して file: の URL を返す（見つからなければ null）。
 * allow は「読み込む」で、そのタブだけに加える https の出どころ
 */
export async function screencastCommand({ command, args = {}, local, hub, bridge, client, snapshotFile, chrome = null }) {
  const viaChrome = args.source === 'chrome';
  if (viaChrome) {
    if (!chrome?.hub || !chrome.bridge?.ready) return { ok: false, code: 'unavailable' };
    ({ hub, bridge } = chrome);
    if (command === 'browserScreencastNav' || (command === 'browserScreencastInput' && local && !bridge.unified)) return { ok: false, code: 'view-only' };
    if (command === 'browserScreencast' && (args.url != null || args.visualization)) return { ok: false, code: 'view-only' };
  } else if (local) return { ok: false, code: 'remote-only' };
  if (!hub || !bridge?.ready) return { ok: false, code: 'unavailable' };
  const sessionId = args.sessionId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return { ok: false, code: 'invalid-session' };
  try {
    switch (command) {
      case 'browserScreencast': {
        let url, fileUrl, source;
        if (args.visualization) {
          const v = args.visualization;
          const owner = typeof v.sessionId === 'string' ? v.sessionId : sessionId;
          fileUrl = await snapshotFile?.({ sessionId: owner, id: v.id, at: v.at });
          if (!fileUrl) return { ok: false, code: 'not-found' };
          // 同じ記録は同じタブ・「読み込む」で書き直せるよう、ホストの内蔵ブラウザーのタブに記録の印を付ける
          source = { kind: 'snapshot', sessionId: owner, ...(v.id ? { id: String(v.id) } : {}), ...(v.at ? { at: String(v.at) } : {}) };
        } else if (args.url != null) {
          if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) return { ok: false, code: 'invalid-url' };
          url = args.url;
        }
        const tabId = typeof args.tabId === 'string' && args.tabId.length <= 100 ? args.tabId : undefined;
        return { ok: true, result: await hub.watch(client, sessionId, { url, fileUrl, source, tabId, width: args.width, height: args.height, scale: args.scale, device: args.device }) };
      }
      case 'browserScreencastStop': await hub.unwatch(client, sessionId); return { ok: true, result: {} };
      // args.mark は印（type: 'mark'）への返事。フレームの返事と区別して、中身を運ぶ時間 S を測る
      case 'browserScreencastAck': hub.received(client, sessionId, Number(args.seq), { mark: args.mark === true }); return { ok: true, result: {} };
      case 'browserScreencastInput': case 'browserScreencastNav': {
        if (!hub.watching(client, sessionId)) return { ok: false, code: 'not-watching' };
        if (command === 'browserScreencastInput') {
          const viewer = hub.viewer?.(client, sessionId);
          const result = await bridge.request('input', sessionId, { input: args.input, client, tabId: args.tabId, device: viewer?.device, viewport: viewer?.box });
          return { ok: true, result: result ?? {} };
        }
        // select・close・newTab は内蔵ブラウザーのタブ列の操作（tabId はその会話のタブ）。見るタブが替わったら { tabId, state } が返る
        const tabId = typeof args.tabId === 'string' && args.tabId.length <= 100 ? args.tabId : undefined;
        const result = await bridge.request('navigate', sessionId, { nav: args.action, url: args.url, tabId });
        // allowOnce（止めた外部の読み込みを通して読み直す）の写しは、一時の許可付きで書き直した写しを同じタブへ開き直す
        const { rewrite, ...rest } = result ?? {};
        if (rewrite?.source?.kind === 'snapshot') {
          const { source, origins } = rewrite;
          const fileUrl = await snapshotFile?.({ sessionId: source.sessionId, id: source.id, at: source.at, allow: origins });
          if (!fileUrl) return { ok: false, code: 'not-found' };
          await bridge.request('openTab', sessionId, { fileUrl, source });
        }
        return { ok: true, result: rest };
      }
      default: return { ok: false, code: 'unknown' };
    }
  } catch (error) {
    const code = String(error?.message ?? '');
    return { ok: false, code: ['invalid-url', 'invalid-input', 'not-watching', 'no-window', 'view-only', 'no-tab'].includes(code) ? code : 'failed' };
  }
}

/** 映像の段（k は見る人の映像の枠〔表示の大きさ × 画素の倍率〕に掛ける大きさ、q は JPEG の画質）。およその中身の量の順（ADR 0294 §3） */
export const SCREENCAST_TIERS = [
  { k: 0.4, q: 30 }, { k: 0.4, q: 55 },
  { k: 0.67, q: 30 }, { k: 0.67, q: 55 }, { k: 0.67, q: 80 },
  { k: 1, q: 55 }, { k: 1, q: 80 },
];
const START_TIER = 3;
const TOP_TIER = SCREENCAST_TIERS.length - 1;
const SLOW_MS = 50;      // S の中央値がこれを超えたら 1 段下げる（直近 3 枚）
const FAST_MS = 25;      // S の中央値がこれ以下なら 1 段上げる（直近 5 枚）
const STILL_MS = 300;    // フレームが届かなくなってから最上段の 1 枚を撮るまで
const STALE_MS = 3000;   // 返事が来なくなってから「つなぎ直しています」とするまで
const RETRY_BLOCK_MS = 30_000;   // 上げて失敗した段へ、もう一度上げるまでの間隔

const clampDim = value => Math.round(Math.min(1920, Math.max(200, Number.isFinite(value) ? value : 800)));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** 見る人の映像の枠（表示の大きさ × 倍率）に段の k を掛けた、送るフレームの大きさ */
function tierFormat(tier, box) {
  const { k, q } = SCREENCAST_TIERS[tier];
  return { tier, quality: q, maxWidth: clampDim(box.width * box.scale * k), maxHeight: clampDim(box.height * box.scale * k) };
}

/**
 * @param bridge parentPortScreencast の戻り値か core/chrome/screencast.mjs（テストでは偽物）
 *   bridge.setFormats(sessionId, formats) があれば段ごとのセッションに分かれ、フレームは { id, stream, data, metadata } で届く。
 *   bridge.capture(sessionId, options) があれば、止まった絵を最上段で 1 枚撮る。
 * client は { send(message) }。message は WS の { kind: 'screencast', type: mark|frame|state|ended|video, sessionId, ... }
 */
export function createScreencastHub({ bridge, source = null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const tag = source ? { source } : {};
  const sessions = new Map();   // sessionId -> entry
  const splitTiers = typeof bridge.setFormats === 'function';
  const canCapture = typeof bridge.capture === 'function';

  function entryOf(sessionId) { return sessions.get(sessionId) ?? null; }
  const deliver = (client, message) => { try { client.send(message); } catch {} };
  const syncViewers = (sessionId, entry) => bridge.setViewers?.(sessionId, [...entry.clients.values()].map(viewer => ({ device: viewer.device, box: viewer.box })));
  bridge.onInteraction?.((sessionId, message, owner = null) => {
    const entry = entryOf(sessionId);
    if (!entry) return;
    if (message.type === 'fields') entry.fields = message;
    if (message.type === 'dialog') entry.dialog = { message, owner };
    if (message.type === 'dismiss') { entry.dialog = null; owner = null; }
    if (owner && !entry.clients.has(owner)) owner = null;
    for (const client of entry.clients.keys()) if (!owner || owner === client) deliver(client, { kind: 'screencast', ...tag, type: 'interaction', sessionId, interaction: message });
  });
  /** 段ごとのセッションに分かれている間は段が流れの鍵、そろえるときは 'shared' */
  const keyOf = (entry, tier) => (entry.multi ? tier : 'shared');
  const streamKeyOf = (entry, frame) => (entry.multi ? frame.stream : 'shared');

  bridge.onFrame((sessionId, frame) => {
    const entry = entryOf(sessionId);
    if (!entry || !frame || typeof frame.data !== 'string') return;
    // 撮影元へはすぐ返事を返す（見る人を待たない。Chrome は返事が無いと 3 枚で止まる）
    bridge.ack(sessionId, frame.id, frame.stream);
    const stream = entry.streams.get(streamKeyOf(entry, frame)) ?? { frameSeq: 0, latest: null };
    stream.frameSeq += 1;
    stream.latest = frame;
    entry.streams.set(streamKeyOf(entry, frame), stream);
    entry.stats.frames++;
    entry.stats.bytes += Math.floor(frame.data.length * 3 / 4);
    entry.stats.maxBytes = Math.max(entry.stats.maxBytes, Math.floor(frame.data.length * 3 / 4));
    entry.statsAt = now();
    entry.firstAt ??= entry.statsAt;
    for (const [client, viewer] of entry.clients) {
      viewer.stillSent = false;   // ページが変わったので、また止まれば撮る
      if (keyOf(entry, viewer.tier) === streamKeyOf(entry, frame)) send(client, sessionId, entry, viewer);
    }
  });
  bridge.onState((sessionId, state) => {
    const entry = entryOf(sessionId);
    if (!entry) return;
    entry.state = state;
    for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'state', sessionId, state });
  });
  bridge.onEnded((sessionId, reason) => {
    const entry = entryOf(sessionId);
    if (!entry) return;
    drop(sessionId);
    for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'ended', sessionId, reason });
  });
  // main が居なくなった（更新）: 見ている端末へ終わりを知らせ、全部畳む。戻った main の前の続きは無い（タブの中身は一度切れる）
  bridge.onAway?.(() => {
    for (const sessionId of [...sessions.keys()]) {
      const entry = entryOf(sessionId);
      drop(sessionId);
      for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'ended', sessionId, reason: 'away' });
    }
  });

  /** 見る人へ、その段の流れの最新の 1 枚を（返事待ちでなければ）すぐ送る。印を先に、フレームを続けて */
  function send(client, sessionId, entry, viewer, still = null) {
    if (viewer.pending) return;
    const key = keyOf(entry, viewer.tier);
    const stream = entry.streams.get(key);
    const frame = still ?? stream?.latest;
    if (!frame || (!still && viewer.sent?.key === key && viewer.sent.frameSeq === stream.frameSeq)) return;
    const seq = ++entry.seq;
    viewer.pending = { seq, markAt: null, still: Boolean(still) };
    if (!still) viewer.sent = { key, frameSeq: stream.frameSeq };
    clearTimer(viewer.stillTimer); viewer.stillTimer = null;
    armStale(client, sessionId, entry, viewer);
    deliver(client, { kind: 'screencast', ...tag, type: 'mark', sessionId, seq });
    deliver(client, { kind: 'screencast', ...tag, type: 'frame', sessionId, seq, data: frame.data, metadata: still ? (stream?.latest?.metadata ?? {}) : (frame.metadata ?? {}), ...(still ? { still: true } : {}) });
  }

  /** 返事（印・フレームどちらでも）が来た。3 秒来なければ stale を立てる */
  function armStale(client, sessionId, entry, viewer) {
    clearTimer(viewer.staleTimer);
    viewer.staleTimer = setTimer(() => {
      viewer.staleTimer = null;
      if (!viewer.pending) return;
      if (!viewer.stale) { viewer.stale = true; video(client, sessionId, viewer); }
      // 返事が来なくても、届いていない 1 枚は手放して次を送る（返事が戻れば stale は下りる）
      viewer.pending = null;
      send(client, sessionId, entry, viewer);
    }, STALE_MS);
  }
  function clearStale(client, sessionId, viewer) {
    if (!viewer.stale) return;
    viewer.stale = false;
    video(client, sessionId, viewer);
  }
  /** 遅れ・途切れの札の状態が変わったときだけ、見る人へ知らせる */
  function video(client, sessionId, viewer) {
    const flags = { lag: viewer.lag, stale: viewer.stale };
    if (flags.lag === viewer.sentFlags?.lag && flags.stale === viewer.sentFlags?.stale) return;
    viewer.sentFlags = flags;
    deliver(client, { kind: 'screencast', ...tag, type: 'video', sessionId, ...flags });
  }

  /** ページが変わらずフレームが来ない間、300 ms おいて最上段の 1 枚を 1 回だけ撮る（止まった絵を鮮明に） */
  function armStill(client, sessionId, entry, viewer) {
    clearTimer(viewer.stillTimer); viewer.stillTimer = null;
    if (!canCapture || viewer.stillSent || viewer.pending) return;
    viewer.stillTimer = setTimer(() => {
      viewer.stillTimer = null;
      if (viewer.pending || viewer.stillSent || entryOf(sessionId) !== entry || !entry.clients.has(client)) return;
      const stream = entry.streams.get(keyOf(entry, viewer.tier));
      const atSeq = stream?.frameSeq ?? 0;
      viewer.stillSent = true;
      const dims = tierFormat(TOP_TIER, viewer.box);
      Promise.resolve(bridge.capture(sessionId, { quality: dims.quality, maxWidth: dims.maxWidth, maxHeight: dims.maxHeight }))
        .then(shot => {
          if (!shot?.data || viewer.pending || entryOf(sessionId) !== entry || !entry.clients.has(client)) return;
          if ((entry.streams.get(keyOf(entry, viewer.tier))?.frameSeq ?? 0) !== atSeq) return;   // 待つ間にページが変わった
          send(client, sessionId, entry, viewer, { data: shot.data });
        })
        .catch(() => {});
    }, STILL_MS);
  }

  /** S を記録し、中央値で段を動かす。段を変えたら測った S は捨てる */
  function measure(client, sessionId, entry, viewer, s) {
    if (!Number.isFinite(s) || s < 0) return;
    viewer.samples.push(s);
    if (viewer.samples.length > 5) viewer.samples.shift();
    const down = viewer.samples.length >= 3 && median(viewer.samples.slice(-3)) > SLOW_MS;
    const up = viewer.samples.length >= 5 && median(viewer.samples.slice(-5)) <= FAST_MS;
    let tier = viewer.tier;
    if (down && tier > 0) {
      // 上げた直後の 3 枚で下げる条件に当たったら、その段へは 30 秒上げない
      if (viewer.raised) viewer.blocked.set(viewer.raised.tier, now() + RETRY_BLOCK_MS);
      viewer.raised = null;
      tier -= 1;
    } else if (!down && up && tier < TOP_TIER && (viewer.blocked.get(tier + 1) ?? 0) <= now()) {
      tier += 1;
      viewer.raised = { tier, left: 3 };
    } else if (viewer.raised && --viewer.raised.left <= 0) {
      viewer.raised = null;
    }
    if (tier !== viewer.tier) {
      viewer.tier = tier;
      viewer.samples = [];
      void syncFormats(sessionId, entry);
      send(client, sessionId, entry, viewer);   // 新しい段の流れに最新があればすぐ
    }
    const lag = viewer.tier === 0 && viewer.samples.length >= 3 && median(viewer.samples.slice(-3)) > SLOW_MS;
    if (lag !== viewer.lag) { viewer.lag = lag; video(client, sessionId, viewer); }
    armStill(client, sessionId, entry, viewer);
  }

  /** 見ている人の段の一覧を、bridge の撮影の口へ反映する */
  async function syncFormats(sessionId, entry) {
    if (entryOf(sessionId) !== entry || !entry.clients.size) return;
    if (entry.multi) {
      const formats = new Map();   // 段 -> その段の最大の枠
      for (const viewer of entry.clients.values()) {
        const f = tierFormat(viewer.tier, viewer.box);
        const cur = formats.get(viewer.tier);
        formats.set(viewer.tier, cur ? { tier: viewer.tier, quality: f.quality, maxWidth: Math.max(cur.maxWidth, f.maxWidth), maxHeight: Math.max(cur.maxHeight, f.maxHeight) } : f);
      }
      const next = [...formats.values()].sort((a, b) => a.tier - b.tier);
      if (JSON.stringify(next) === JSON.stringify(entry.formats)) return;
      entry.formats = next;
      const answer = await bridge.setFormats(sessionId, next).catch(() => null);
      if (entryOf(sessionId) === entry && answer?.multi === false) {   // 段ごとに分けられなかった: 一番低い段にそろえる
        entry.multi = false;
        await syncShared(sessionId, entry);
      }
      return;
    }
    await syncShared(sessionId, entry);
  }
  /** 段ごとに分けられない撮影（内蔵ブラウザー・分けられなかった中継）は、一番低い段の画質にそろえる（大きさは端末の箱のまま） */
  async function syncShared(sessionId, entry) {
    if (entryOf(sessionId) !== entry || !entry.clients.size) return;
    let lowest = null;
    for (const viewer of entry.clients.values()) if (!lowest || viewer.tier < lowest.tier) lowest = viewer;
    if (!lowest) return;
    const options = { width: lowest.box.width, height: lowest.box.height, scale: lowest.box.scale, quality: SCREENCAST_TIERS[lowest.tier].q };
    if (JSON.stringify(options) === JSON.stringify(entry.shared)) return;
    entry.shared = options;
    await bridge.request('start', sessionId, { options }).catch(() => {});
  }

  function dropViewer(client, sessionId, entry, viewer) {
    clearTimer(viewer.staleTimer); clearTimer(viewer.stillTimer);
    entry.clients.delete(client);
    if (entry.dialog?.owner === client) {
      entry.dialog.owner = null;
      for (const remaining of entry.clients.keys()) deliver(remaining, { kind: 'screencast', ...tag, type: 'interaction', sessionId, interaction: entry.dialog.message });
    }
    Promise.resolve(syncViewers(sessionId, entry)).catch(() => {});
  }

  function drop(sessionId) {
    const entry = entryOf(sessionId);
    if (!entry) return;
    for (const viewer of entry.clients.values()) { clearTimer(viewer.staleTimer); clearTimer(viewer.stillTimer); }
    sessions.delete(sessionId);
    Promise.resolve(bridge.setViewers?.(sessionId, [])).catch(() => {});
  }

  /** 見始める。url か fileUrl（サーバーが確かめた可視化の写し）があれば新しいタブで開き、tabId があればその会話のそのタブを見る。同じ会話を見ている端末とはタブを共有する */
  async function watch(client, sessionId, { url, fileUrl, source, tabId, width, height, scale, device } = {}) {
    const box = { width: Number(width) || 800, height: Number(height) || 800, scale: Math.min(Number(scale) || 1, 2) };
    let entry = entryOf(sessionId);
    const created = !entry;
    if (!entry) {
      entry = { clients: new Map(), seq: 0, streams: new Map(), state: null, stats: { frames: 0, bytes: 0, maxBytes: 0 }, firstAt: null, statsAt: null,
        multi: splitTiers, formats: null, shared: null };
      sessions.set(sessionId, entry);
    }
    const previous = entry.clients.get(client);
    const viewer = previous ?? { tier: START_TIER, samples: [], blocked: new Map(), raised: null,
      pending: null, sent: null, lag: false, stale: false, staleTimer: null, stillTimer: null, stillSent: false, sentFlags: null };
    viewer.box = box;
    viewer.device = device === 'phone' ? 'phone' : 'pc';
    entry.clients.set(client, viewer);
    let result;
    try {
      // 見る人の端末を知らせる口があるのは会話の Chrome（旗が on）だけ。無い橋（内蔵ブラウザー）は待たずに start を送る（今までの順のまま）
      const synced = syncViewers(sessionId, entry);
      if (synced) await synced;
      if (entry.multi && !entry.formats) {
        const f = tierFormat(viewer.tier, box);
        entry.formats = [f];
        result = await bridge.request('start', sessionId, { options: { url, fileUrl, source, tabId, formats: entry.formats } });
      } else if (entry.multi) {
        result = { tabId: entry.state?.tabId ?? null, state: entry.state };
        await syncFormats(sessionId, entry);
      } else {
        const options = { url, fileUrl, source, tabId, width: box.width, height: box.height, scale: box.scale, quality: SCREENCAST_TIERS[lowestTierOf(entry)].q };
        entry.shared = { width: box.width, height: box.height, scale: box.scale, quality: SCREENCAST_TIERS[lowestTierOf(entry)].q };
        result = await bridge.request('start', sessionId, { options });
      }
    } catch (error) {
      dropViewer(client, sessionId, entry, viewer);
      if (created && !entry.clients.size) drop(sessionId);
      throw error;
    }
    if (result?.state) entry.state = result.state;
    if (entry.fields) deliver(client, { kind: 'screencast', ...tag, type: 'interaction', sessionId, interaction: entry.fields });
    if (!entry.multi) void syncShared(sessionId, entry);   // 分けられない撮影は全員の段でそろえ直す
    send(client, sessionId, entry, viewer);
    armStill(client, sessionId, entry, viewer);
    return { tabId: result?.tabId ?? null, state: entry.state };
  }
  function lowestTierOf(entry) {
    let lowest = START_TIER;
    for (const viewer of entry.clients.values()) lowest = Math.min(lowest, viewer.tier);
    return lowest;
  }

  async function unwatch(client, sessionId) {
    const entry = entryOf(sessionId);
    const viewer = entry?.clients.get(client);
    if (!entry || !viewer) return;
    dropViewer(client, sessionId, entry, viewer);
    if (entry.clients.size) { void syncFormats(sessionId, entry); return; }
    drop(sessionId);
    await bridge.request('stop', sessionId).catch(() => {});
  }

  /** 接続が切れた端末を、見ているすべての会話から外す */
  function forget(client) {
    for (const [sessionId, entry] of sessions) if (entry.clients.has(client)) void unwatch(client, sessionId);
  }

  /** 端末が印（mark）かフレームを受け取った */
  function received(client, sessionId, seq, { mark = false } = {}) {
    const entry = entryOf(sessionId);
    const viewer = entry?.clients.get(client);
    if (!entry || !viewer) return;
    const pending = viewer.pending;
    if (!pending || pending.seq !== seq) return;
    clearStale(client, sessionId, viewer);
    armStale(client, sessionId, entry, viewer);   // 印の返事が来ても時計を戻す（途切れは「返事が 3 秒来ない」）
    if (mark) { pending.markAt = now(); return; }
    viewer.pending = null;
    if (pending.markAt != null && !pending.still) measure(client, sessionId, entry, viewer, now() - pending.markAt);
    send(client, sessionId, entry, viewer);
    armStill(client, sessionId, entry, viewer);
  }

  function watching(client, sessionId) { return !!entryOf(sessionId)?.clients.has(client); }

  function stats(sessionId) {
    const entry = entryOf(sessionId);
    if (!entry) return null;
    const seconds = entry.firstAt != null ? Math.max(1, ((entry.statsAt ?? entry.firstAt) - entry.firstAt) / 1000) : 1;
    const { frames, bytes, maxBytes } = entry.stats;
    return { frames, bytes, maxBytes, avgBytes: frames ? Math.round(bytes / frames) : 0, fps: frames > 1 ? +(frames / seconds).toFixed(2) : frames };
  }

  return { watch, unwatch, forget, received, watching, stats,
    viewer: (client, sessionId) => { const viewer = entryOf(sessionId)?.clients.get(client); return viewer ? { device: viewer.device, box: { ...viewer.box } } : null; },
    sessions: () => [...sessions.keys()] };
}
