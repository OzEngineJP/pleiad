// エージェントの Chrome の窓の映像を、見ている端末へ配る（ADR 0148・0294・0297）。撮影元は core/chrome/screencast.mjs（bridge）。
//   - createScreencastHub: 会話ごとに見ている端末を束ね、フレームを配る。見る端末がいなくなったら止める
//   - screencastCommand: WS のコマンド（args.source === 'chrome'）を hub と bridge へ渡す
// 映像の送り方（ADR 0297。ADR 0148 の画質の選び方を置き換える）:
//   - フレームが届いたら、見ている端末を待たずにすぐ撮影元へ ack を返す（Chrome は ack のあと次を出す。返事を待つと 5 fps を超えない）
//   - 見る人（接続）ごとに「届いていない 1 枚」だけを持つ。見る人の返事（browserScreencastAck）が来たら、そのときの最新の 1 枚をすぐ送る。
//     返事を待つ間に届いたフレームは最新で上書きする。遅い端末は自分の分だけ fps が下がり、ほかの見る人には響かない
//   - 各フレームの直前に小さな印（type: 'mark'）を送り、見る人は印にもフレームにも返事を返す（ack の args.mark）。
//     S = フレームの返事の時刻 − 印の返事の時刻（往復の遅れを除いた、中身を運ぶのにかかった時間）で、段を自動で上下する
//   - 段は SCREENCAST_TIERS（k 0.4/0.67/1 × q 30/55/80 の 7 段）。段ごとの撮影の口は bridge の能力で分かれる:
//       · bridge.setFormats がある（core/chrome/screencast.mjs）: 段ごとに中継のセッションを分ける（フレームは stream（段）つきで届く）
//       · 無い: 見ている人の中で一番低い段にそろえ、変わったら start を掛け直す（画質だけ。大きさは端末の箱のまま）
//   - 300 ms 静まったら screencast 自体を最上段へ切り替える。変更が続いたら各端末の通信量に応じた段へ戻す（ADR 0297 §4）
//   - 段 0 でも S の中央値が 50 ms を超え続ける → lag、返事が 3 秒来ない → stale を、type: 'video' のメッセージで見る人へ知らせる
// hub は source を messages に載せる（画面は source: 'chrome' の映像だけを受ける）。
// 撮影元が居なくなった（bridge.onAway）ときは、見ている端末へ ended('away') を送って畳む。

/**
 * WS のコマンドを処理する（core/server.mjs から呼ぶ）。戻り値は { ok, result } か { ok: false, code }。
 * 映像はエージェントの Chrome の窓だけ（args.source === 'chrome'、chrome = { hub, bridge }）。ホストの画面もリモートも見られる。
 * 入力はどの端末からも受け、触ったタブを人の操作にする（ADR 0296。bridge は core/chrome/screencast.mjs）。その会話を見ている接続からだけ。
 */
export async function screencastCommand({ command, args = {}, client, chrome = null }) {
  if (args.source !== 'chrome' || !chrome?.hub || !chrome.bridge?.ready) return { ok: false, code: 'unavailable' };
  const { hub, bridge } = chrome;
  const sessionId = args.sessionId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return { ok: false, code: 'invalid-session' };
  try {
    switch (command) {
      case 'browserScreencast': {
        const tabId = typeof args.tabId === 'string' && args.tabId.length <= 100 ? args.tabId : undefined;
        return { ok: true, result: await hub.watch(client, sessionId, { tabId, width: args.width, height: args.height, scale: args.scale, device: args.device }) };
      }
      case 'browserScreencastStop': await hub.unwatch(client, sessionId); return { ok: true, result: {} };
      // args.mark は印（type: 'mark'）への返事。フレームの返事と区別して、中身を運ぶ時間 S を測る
      case 'browserScreencastAck': hub.received(client, sessionId, Number(args.seq), { mark: args.mark === true }); return { ok: true, result: {} };
      case 'browserScreencastInput': {
        if (!hub.watching(client, sessionId)) return { ok: false, code: 'not-watching' };
        const viewer = hub.viewer?.(client, sessionId);
        const result = await bridge.request('input', sessionId, { input: args.input, client, tabId: args.tabId, device: viewer?.device, viewport: viewer?.box });
        return { ok: true, result: result ?? {} };
      }
      default: return { ok: false, code: 'unknown' };
    }
  } catch (error) {
    const code = String(error?.message ?? '');
    return { ok: false, code: ['invalid-input', 'not-watching', 'no-window', 'no-tab', 'view-only'].includes(code) ? code : 'failed' };
  }
}

/** 映像の段（k は見る人の映像の枠〔表示の大きさ × 画素の倍率〕に掛ける大きさ、q は JPEG の画質）。およその中身の量の順（ADR 0297 §3） */
export const SCREENCAST_TIERS = [
  { k: 0.4, q: 30 }, { k: 0.4, q: 55 },
  { k: 0.67, q: 30 }, { k: 0.67, q: 55 }, { k: 0.67, q: 80 },
  { k: 1, q: 55 }, { k: 1, q: 80 },
];
const START_TIER = 3;
const TOP_TIER = SCREENCAST_TIERS.length - 1;
const SLOW_MS = 50;      // S の中央値がこれを超えたら 1 段下げる（直近 3 枚）
const FAST_MS = 25;      // S の中央値がこれ以下なら 1 段上げる（直近 5 枚）
const STILL_MS = 300;    // 静まってから最上段へ切り替えるまで
const STALE_MS = 3000;   // 返事が来なくなってから「つなぎ直しています」とするまで
const RETRY_BLOCK_MS = 30_000;   // 上げて失敗した段へ、もう一度上げるまでの間隔
const FORMAT_RETRY_MS = 1000;
const FORMAT_RETRY_MAX_MS = 8000;
const FORMAT_FAILURE_LIMIT = 5;
const sameViewport = (a, b) => Number.isFinite(a?.deviceWidth) && Number.isFinite(a?.deviceHeight) && Number.isFinite(b?.deviceWidth) && Number.isFinite(b?.deviceHeight)
  && ['deviceWidth', 'deviceHeight', 'pageScaleFactor', 'offsetTop', 'scrollOffsetX', 'scrollOffsetY'].every(key => Number.isFinite(a[key]) && a[key] === b[key]);

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
 * @param bridge core/chrome/screencast.mjs（テストでは偽物）
 *   bridge.setFormats(sessionId, formats) があれば段ごとのセッションに分かれ、フレームは { id, stream, data, metadata } で届く。
 * client は { send(message) }。message は WS の { kind: 'screencast', type: mark|frame|state|ended|video, sessionId, ... }
 */
export function createScreencastHub({ bridge, source = null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const tag = source ? { source } : {};
  const sessions = new Map();   // sessionId -> entry
  const splitTiers = typeof bridge.setFormats === 'function';

  function entryOf(sessionId) { return sessions.get(sessionId) ?? null; }
  const deliver = (client, message) => { try { client.send(message); } catch {} };
  const syncViewers = (sessionId, entry) => bridge.setViewers?.(sessionId, [...entry.clients].map(([client, viewer]) => ({ client, device: viewer.device, box: viewer.box })));
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
  const tierOf = (entry, viewer) => entry.sharp ? TOP_TIER : viewer.tier;

  bridge.onFrame((sessionId, frame) => {
    const entry = entryOf(sessionId);
    if (!entry || !frame || typeof frame.data !== 'string') return;
    // 撮影元へはすぐ返事を返す（見る人を待たない。Chrome は返事が無いと 3 枚で止まる）
    bridge.ack(sessionId, frame.id, frame.stream);
    // 変更しない撮影元の絵は、別の段の張り直しを待たずに送り続ける。
    const candidates = (frame.format ? [entry, entry.transition] : [entry.transition, entry]).filter(Boolean);
    const config = candidates.find(candidate => {
      const expected = candidate.multi ? candidate.formats?.find(f => f.tier === frame.stream)
        : candidate.shared && { quality:candidate.shared.quality, maxWidth:clampDim(candidate.shared.width * Math.max(1, Math.min(2, candidate.shared.scale))), maxHeight:clampDim(candidate.shared.height * Math.max(1, Math.min(2, candidate.shared.scale))) };
      return expected && (!frame.format || ['quality','maxWidth','maxHeight'].every(key => frame.format[key] === expected[key]));
    });
    if (!config) return;
    const streamKey = config.multi ? frame.stream : 'shared';
    const stream = entry.streams.get(streamKey) ?? { frameSeq: 0, latest: null };
    const format = JSON.stringify(config.multi ? config.formats.find(f => f.tier === streamKey) : config.shared);
    const tabId = frame.tabId ?? entry.state?.tabId;
    // 重複は再送しない。静止中も最上段の screencast が生きているので、細かい更新を低画質との比較で失うことはない。
    if (format && frame.data && stream.latest?.data === frame.data && stream.format === format && stream.tabId === tabId
      && sameViewport(stream.latest.metadata, frame.metadata)) {
      return;
    }
    stream.frameSeq += 1;
    stream.latest = frame;
    stream.format = format;
    stream.tabId = tabId;
    entry.streams.set(streamKey, stream);
    entry.stats.frames++;
    entry.stats.bytes += Math.floor(frame.data.length * 3 / 4);
    entry.stats.maxBytes = Math.max(entry.stats.maxBytes, Math.floor(frame.data.length * 3 / 4));
    entry.statsAt = now();
    entry.firstAt ??= entry.statsAt;
    if (config !== entry) return; // 開始の応答より先に来た絵は、成功を確かめてから送る。
    if (resumeRetries(entry)) void syncFormats(sessionId, entry);
    entry.changedAt = now();
    for (const [client, viewer] of entry.clients) {
      if (keyOf(entry, tierOf(entry, viewer)) !== streamKey) continue;
      send(client, sessionId, entry, viewer);
    }
    if (entry.sharp) {
      // 張り直しの最初の絵は動きと数えない。その後 300 ms 内に変更が続いたときだけ低い段へ戻す。
      if (entry.firstSharp) entry.firstSharp = false;
      else if (entry.motionAt != null && now() - entry.motionAt < STILL_MS) setSharp(sessionId, entry, false);
      else entry.motionAt = now();
    } else armQuiet(sessionId, entry);
  });
  bridge.onState((sessionId, state) => {
    const entry = entryOf(sessionId);
    if (!entry) return;
    if (entry.state?.tabId !== state?.tabId) {
      for (const stream of entry.streams.values()) {
        if (stream.tabId && stream.tabId !== state?.tabId) stream.format = null;
        else stream.tabId = state?.tabId;
      }
      entry.firstSharp = true;
      entry.motionAt = null;
      if (retryContextChanged(entry)) void syncFormats(sessionId, entry);
    }
    entry.state = state;
    for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'state', sessionId, state });
    for (const [client, viewer] of entry.clients) send(client, sessionId, entry, viewer);
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
  function send(client, sessionId, entry, viewer) {
    if (viewer.pending) return;
    const key = keyOf(entry, tierOf(entry, viewer));
    const stream = entry.streams.get(key);
    const format = JSON.stringify(entry.multi ? entry.formats?.find(f => f.tier === key) : entry.shared);
    const frame = stream && stream.format === format ? stream.latest : null;
    if (!frame || (stream.tabId && entry.state?.tabId && stream.tabId !== entry.state.tabId)
      || (viewer.sent?.key === key && viewer.sent.frameSeq === stream.frameSeq)) return;
    const seq = ++entry.seq;
    viewer.pending = { seq, markAt: null, sharp: entry.sharp };
    viewer.sent = { key, frameSeq: stream.frameSeq, seq };
    armStale(client, sessionId, entry, viewer);
    deliver(client, { kind: 'screencast', ...tag, type: 'mark', sessionId, seq });
    deliver(client, { kind: 'screencast', ...tag, type: 'frame', sessionId, seq, data: frame.data, metadata: frame.metadata ?? {} });
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

  /** 300 ms 静まったら、会話の映像そのものを最上段にする。遅い端末の返事はほかの端末を待たせない。 */
  function armQuiet(sessionId, entry) {
    clearTimer(entry.quietTimer); entry.quietTimer = null;
    if (entry.wantedSharp || !entry.clients.size) return;
    entry.quietTimer = setTimer(() => {
      entry.quietTimer = null;
      if (entryOf(sessionId) === entry && entry.clients.size) setSharp(sessionId, entry, true);
    }, Math.max(0, entry.changedAt + STILL_MS - now()));
  }
  function setSharp(sessionId, entry, sharp) {
    entry.wantedSharp = sharp;
    void syncFormats(sessionId, entry);
    for (const [client, viewer] of entry.clients) send(client, sessionId, entry, viewer);
    if (!sharp) armQuiet(sessionId, entry);
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
    armQuiet(sessionId, entry);
  }

  /** 次に使う設定。要求中も、配信に成功した設定は entry に残しておく。 */
  function desiredFormats(entry, multi = entry.multi) {
    if (multi) {
      const formats = new Map();   // 段 -> その段の最大の枠
      for (const viewer of entry.clients.values()) {
        const tier = entry.wantedSharp ? TOP_TIER : viewer.tier, f = tierFormat(tier, viewer.box);
        const cur = formats.get(tier);
        formats.set(tier, cur ? { tier, quality: f.quality, maxWidth: Math.max(cur.maxWidth, f.maxWidth), maxHeight: Math.max(cur.maxHeight, f.maxHeight) } : f);
      }
      return { multi:true, formats:[...formats.values()].sort((a, b) => a.tier - b.tier), shared:null, sharp:entry.wantedSharp };
    }
    let lowest = null;
    for (const viewer of entry.clients.values()) if (!lowest || viewer.tier < lowest.tier) lowest = viewer;
    const tier = entry.wantedSharp ? TOP_TIER : lowest.tier;
    const boxes = entry.wantedSharp ? [...entry.clients.values()] : [lowest];
    const options = { width:Math.max(...boxes.map(v => v.box.width)), height:Math.max(...boxes.map(v => v.box.height)),
      scale:Math.max(...boxes.map(v => v.box.scale)), quality: SCREENCAST_TIERS[tier].q };
    return { multi:false, formats:null, shared:options, sharp:entry.wantedSharp };
  }

  /** 中身の変更は失敗回数を保って 1 回だけ再開する。要求中の復元画像では再開しない。 */
  function resumeRetries(entry) {
    if (!entry.retryPaused || entry.syncing) return false;
    entry.retryPaused = false;
    // 直前の失敗で決めた期限は、変更が来ても短縮しない。
    return true;
  }

  function retryContextChanged(entry) {
    entry.retryRevision += 1;
    entry.retryFailures = 0;
    return resumeRetries(entry);
  }

  function armRetry(sessionId, entry) {
    if (entry.retryPaused || entry.retryTimer || entryOf(sessionId) !== entry || !entry.clients.size) return;
    entry.retryTimer = setTimer(() => {
      entry.retryTimer = null;
      void syncFormats(sessionId, entry);
    }, Math.max(0, entry.retryAt - now()));
  }

  /** 張り直しは直列に行う。すべての呼び出し経路で、失敗後の再試行の期限を守る。 */
  function syncFormats(sessionId, entry) {
    if (entryOf(sessionId) !== entry || !entry.clients.size) return Promise.resolve();
    if (entry.syncing) { entry.resync = true; return entry.syncing; }
    if (entry.retryPaused) return Promise.resolve();
    if (entry.retryAt > now()) { armRetry(sessionId, entry); return Promise.resolve(); }
    clearTimer(entry.retryTimer); entry.retryTimer = null;
    let revision = entry.retryRevision;
    let failures = entry.retryFailures;
    const run = async () => {
      do {
        entry.resync = false;
        let next = desiredFormats(entry);
        const changed = next.multi !== entry.multi || JSON.stringify(next.multi ? next.formats : next.shared) !== JSON.stringify(entry.multi ? entry.formats : entry.shared);
        if (changed || entry.retryNeeded) {
          revision = entry.retryRevision;
          failures = entry.retryFailures;
          entry.transition = next;
          if (next.multi) {
            const answer = await bridge.setFormats(sessionId, next.formats);
            if (answer?.multi === false) {
              next = desiredFormats(entry, false);
              entry.transition = next;
              await bridge.request('start', sessionId, { options:next.shared });
            }
          } else await bridge.request('start', sessionId, { options:next.shared });
          entry.retryFailures = 0;
          entry.retryAt = 0;
        }
        if (entryOf(sessionId) !== entry) return;
        const wasSharp = entry.sharp;
        Object.assign(entry, next);
        for (const [key, stream] of entry.streams) {
          const active = next.multi ? next.formats.find(f => f.tier === key) : key === 'shared' && next.shared;
          if (!active || stream.format !== JSON.stringify(active)) stream.format = null;
        }
        entry.transition = null;
        entry.retryNeeded = false;
        if (changed || wasSharp !== entry.sharp) {
          // 開始の応答までに最初の絵を受けた場合、その次の変更から動きを数える。
          entry.firstSharp = ![...entry.streams.values()].some(s => s.format === JSON.stringify(next.multi ? next.formats.find(f => f.tier === TOP_TIER) : next.shared));
          entry.motionAt = null;
        }
        for (const [client, viewer] of entry.clients) send(client, sessionId, entry, viewer);
      } while (entry.resync && entry.clients.size && entryOf(sessionId) === entry);
    };
    // 送信・ack からの再入でも、要求中であることを先に確定する。
    entry.syncing = Promise.resolve().then(run).catch(error => {
      entry.transition = null;
      entry.retryNeeded = true;
      if (entryOf(sessionId) === entry && entry.clients.size) {
        entry.retryFailures = Math.min(FORMAT_FAILURE_LIMIT, failures + 1);
        entry.retryAt = now() + Math.min(FORMAT_RETRY_MAX_MS, FORMAT_RETRY_MS * 2 ** (entry.retryFailures - 1));
        // 配信を復元できたら一定回数で保つ。復元も失敗して無配信なら、待ちの上限を保って復旧を続ける。
        const contextChanged = entry.retryRevision !== revision;
        entry.retryPaused = !contextChanged && entry.retryFailures >= FORMAT_FAILURE_LIMIT && error?.screencastRestored !== false;
        if (contextChanged) entry.retryFailures = 0;
        armRetry(sessionId, entry);
      }
    }).finally(() => { entry.syncing = null; });
    return entry.syncing;
  }

  function dropViewer(client, sessionId, entry, viewer) {
    clearTimer(viewer.staleTimer);
    entry.clients.delete(client);
    retryContextChanged(entry);
    if (entry.dialog?.owner === client) {
      entry.dialog.owner = null;
      for (const remaining of entry.clients.keys()) deliver(remaining, { kind: 'screencast', ...tag, type: 'interaction', sessionId, interaction: entry.dialog.message });
    }
    Promise.resolve(syncViewers(sessionId, entry)).catch(() => {});
  }

  function drop(sessionId) {
    const entry = entryOf(sessionId);
    if (!entry) return;
    clearTimer(entry.quietTimer);
    clearTimer(entry.retryTimer);
    for (const viewer of entry.clients.values()) clearTimer(viewer.staleTimer);
    sessions.delete(sessionId);
    Promise.resolve(bridge.setViewers?.(sessionId, [])).catch(() => {});
  }

  /** 見始める。tabId があればその会話のそのタブを見る。同じ会話を見ている端末とはタブを共有する */
  async function watch(client, sessionId, { tabId, width, height, scale, device } = {}) {
    const box = { width: Number(width) || 800, height: Number(height) || 800, scale: Math.min(Number(scale) || 1, 2) };
    let entry = entryOf(sessionId);
    const created = !entry;
    if (!entry) {
      entry = { clients: new Map(), seq: 0, streams: new Map(), state: null, stats: { frames: 0, bytes: 0, maxBytes: 0 }, firstAt: null, statsAt: null,
        multi: splitTiers, formats: null, shared: null, sharp:false, wantedSharp:false, firstSharp:true, motionAt:null, quietTimer:null, changedAt:now(),
        retryAt:0, retryFailures:0, retryPaused:false, retryRevision:0 };
      sessions.set(sessionId, entry);
    }
    const previous = entry.clients.get(client);
    if (!previous || JSON.stringify(previous.box) !== JSON.stringify(box) || previous.device !== (device === 'phone' ? 'phone' : 'pc')) retryContextChanged(entry);
    const viewer = previous ?? { tier: START_TIER, samples: [], blocked: new Map(), raised: null,
      pending: null, sent: null, lag: false, stale: false, staleTimer: null,
      sentFlags: null };
    viewer.box = box;
    viewer.device = device === 'phone' ? 'phone' : 'pc';
    entry.clients.set(client, viewer);
    let result;
    try {
      // 見る人の端末を知らせる口（setViewers）が無い橋は、待たずに start を送る
      const synced = syncViewers(sessionId, entry);
      if (synced) await synced;
      if (entry.multi && !entry.formats) {
        const f = tierFormat(viewer.tier, box);
        entry.formats = [f];
        result = await bridge.request('start', sessionId, { options: { tabId, formats: entry.formats } });
      } else if (entry.multi) {
        result = { tabId: entry.state?.tabId ?? null, state: entry.state };
        await syncFormats(sessionId, entry);
      } else if (created) {
        const options = { tabId, width: box.width, height: box.height, scale: box.scale, quality: SCREENCAST_TIERS[lowestTierOf(entry)].q };
        entry.shared = { width: box.width, height: box.height, scale: box.scale, quality: SCREENCAST_TIERS[lowestTierOf(entry)].q };
        result = await bridge.request('start', sessionId, { options });
      } else {
        result = { tabId:entry.state?.tabId ?? null, state:entry.state };
        await syncFormats(sessionId, entry);
      }
    } catch (error) {
      dropViewer(client, sessionId, entry, viewer);
      if (created && !entry.clients.size) drop(sessionId);
      throw error;
    }
    if (result?.state && (!Number.isSafeInteger(entry.state?.sequence)
      || result.state.sequence > entry.state.sequence)) entry.state = result.state;
    if (entry.fields) deliver(client, { kind: 'screencast', ...tag, type: 'interaction', sessionId, interaction: entry.fields });
    if (!entry.multi) void syncFormats(sessionId, entry);   // 分けられない撮影は全員の段でそろえ直す
    send(client, sessionId, entry, viewer);
    armQuiet(sessionId, entry);
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
    if (!pending) {
      if (viewer.sent?.seq === seq) clearStale(client, sessionId, viewer);
      return;
    }
    if (pending.seq !== seq) return;
    clearStale(client, sessionId, viewer);
    armStale(client, sessionId, entry, viewer);   // 印の返事が来ても時計を戻す（途切れは「返事が 3 秒来ない」）
    if (mark) { pending.markAt = now(); return; }
    viewer.pending = null;
    if (pending.markAt != null && !pending.sharp) measure(client, sessionId, entry, viewer, now() - pending.markAt);
    send(client, sessionId, entry, viewer);
    armQuiet(sessionId, entry);
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
