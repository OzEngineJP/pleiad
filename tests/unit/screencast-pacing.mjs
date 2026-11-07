// 映像の返事ごとの 1 枚と 7 段（ADR 0297・core/browser-screencast.mjs の hub）。
//   - フレームが届いたら見る人を待たずに撮影元へすぐ ack を返し、見る人ごとに「返事のたびに最新の 1 枚」を送る
//   - 印（mark）とフレームの返事の差 S の中央値で段が上下する（>50ms で 3 枚で下げる・≤25ms で 5 枚で上げる）
//   - 上げて失敗した段は 30 秒上げない・段 0 でも遅い → lag・返事が 3 秒来ない → stale・300 ms で最上段の 1 枚
import { createScreencastHub, SCREENCAST_TIERS } from '../../core/browser-screencast.mjs';

export const name = 'screencast-pacing';
export const title = '映像の返事ごとの 1 枚と 7 段（ADR 0297）: 見る人ごとの ack・印の時間 S・段の上下・30 秒・still・stale・lag';

/** 手で進める時計とタイマー */
function clock(start = 1000) {
  let time = start;
  const timers = new Set();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const timer = { at: time + ms, fn }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due); time = due.at; due.fn();
      }
      time = end;
    },
  };
}

/** 段ごとのセッションに分かれる偽の bridge（setFormats・capture あり） */
function fakeBridge({ multi = true } = {}) {
  const on = {};
  const requests = [], acks = [], formats = [], captures = [];
  return {
    ready: true, requests, acks, formats, captures,
    request: async (action, sessionId, args) => { requests.push([action, sessionId, args]); return action === 'start' ? { tabId: 't1', state: { tabId: 't1' } } : {}; },
    ack: (sessionId, frameId, stream) => acks.push([sessionId, frameId, stream]),
    setFormats: async (sessionId, list) => { formats.push(list); return { multi }; },
    capture: async (sessionId, options) => { captures.push(options); return { data: 'U1RJaWw=' }; },
    onFrame: fn => { on.frame = fn; }, onState: fn => { on.state = fn; }, onEnded: fn => { on.ended = fn; }, onAway: fn => { on.away = fn; },
    frame: (sessionId, id, { stream = 3, data = 'QUJD', metadata = { deviceWidth: 400 } } = {}) => on.frame(sessionId, { id, stream, data, metadata }),
    state: (sessionId, state) => on.state(sessionId, state),
    ended: (sessionId, reason) => on.ended(sessionId, reason),
  };
}
const client = () => { const got = []; return { got, send: message => got.push(message) }; };
const frames = c => c.got.filter(m => m.type === 'frame');
const videos = c => c.got.filter(m => m.type === 'video');
/** 印の返事 → フレームの返事（S = gap ms）を順に返す */
function ackRound(hub, c, sessionId, c2, gap = 10) {
  const seq = frames(c).at(-1).seq;
  hub.received(c, sessionId, seq, { mark: true });
  c2.advance(gap);
  hub.received(c, sessionId, seq);
}

export default async function (t) {
  // ---- 見る人ごとの 1 枚: 撮影元は止めない・遅い人が速い人を下げない ----
  {
    const c = clock(), bridge = fakeBridge();
    const hub = createScreencastHub({ bridge, ...c });
    const fast = client(), slow = client();
    await hub.watch(fast, 's1', { width: 400, height: 300, scale: 1 });
    await hub.watch(slow, 's1', { width: 390, height: 700, scale: 1 });
    t.ok('見始めると段の一覧（最初は段 3 の 1 つ）を渡して start を頼む',
      bridge.requests[0][0] === 'start' && bridge.requests[0][2].options.formats?.length === 1
        && bridge.requests[0][2].options.formats[0].quality === SCREENCAST_TIERS[3].q
        && bridge.requests[0][2].options.formats[0].maxWidth === Math.round(400 * SCREENCAST_TIERS[3].k),
      JSON.stringify(bridge.requests[0][2].options));

    bridge.frame('s1', 1, { stream: 3 });
    t.ok('フレームが届いたら、見る人の返事を待たずに撮影元（その段）へすぐ ack を返す', bridge.acks.length === 1 && bridge.acks[0][1] === 1 && bridge.acks[0][2] === 3);
    const m0 = fast.got.map(m => m.type).join(',');
    t.ok('見る人には印（mark）の直後にフレームが届く', m0 === 'mark,frame' && fast.got[0].seq === fast.got[1].seq, m0);

    // 遅い人が返さない間も、速い人には毎回新しい 1 枚が届く
    for (let id = 2; id <= 4; id++) {
      bridge.frame('s1', id, { stream: 3 });
      ackRound(hub, fast, 's1', c);
    }
    t.ok('遅い見る人が返事を返さなくても、速い見る人は届くたびに新しい 1 枚をもらう（遅い人の分だけ fps が下がる）',
      frames(fast).length === 4 && frames(slow).length === 1 && frames(fast).at(-1).seq === fast.got.at(-1).seq);

    // 遅い人が返すと、そのときの最新の 1 枚をすぐもらう（間に届いた分は最新で上書き）
    bridge.frame('s1', 5, { stream: 3, data: 'TkVX' });
    hub.received(slow, 's1', frames(slow)[0].seq, { mark: true });
    hub.received(slow, 's1', frames(slow)[0].seq);
    t.ok('返事のあと届くのは最新の 1 枚だけ（溜まらない）', frames(slow).length === 2 && frames(slow)[1].data === 'TkVX');

    const stats = hub.stats('s1');
    t.ok('届いたフレームの枚数と大きさを数える', stats.frames === 5 && stats.bytes > 0, JSON.stringify(stats));
    await hub.unwatch(slow, 's1'); await hub.unwatch(fast, 's1');
    t.ok('見る人がいなくなったら撮影を止める', bridge.requests.some(([a]) => a === 'stop'));
  }

  // ---- S の中央値で段が上下する ----
  {
    const c = clock(), bridge = fakeBridge();
    const hub = createScreencastHub({ bridge, ...c });
    const v = client();
    await hub.watch(v, 's1', { width: 400, height: 300, scale: 1 });
    const tier = () => bridge.formats.at(-1)?.[0]?.tier ?? 3;
    const put = async (gap, n = 1) => { for (let i = 0; i < n; i++) { bridge.frame('s1', bridge.acks.length + 1, { stream: tier() }); ackRound(hub, v, 's1', c, gap); } };

    await put(60, 3);
    t.ok('S の直近 3 枚の中央値が 50 ms を超えると 1 段下げる（段の一覧が変わる）',
      bridge.formats.at(-1)?.[0]?.tier === 2 && frames(v).at(-1).seq >= 1, JSON.stringify(bridge.formats.at(-1)));

    // 段 2 の流れで返事を続ける: 段を変えたら S は捨てて数え直す
    await put(10, 5);
    t.ok('直近 5 枚の中央値が 25 ms 以下なら 1 段上げる', bridge.formats.at(-1)?.[0]?.tier === 3, JSON.stringify(bridge.formats.at(-1)));

    // 上げた直後に下げる条件に当たる → その段へは 30 秒上げない
    await put(60, 3);
    t.ok('上げてすぐ下がる条件に当たった（段 2 へ戻る）', bridge.formats.at(-1)?.[0]?.tier === 2);
    await put(10, 5);
    const back = bridge.formats.at(-1);
    t.ok('失敗した段へは 30 秒は上げ直さない', back?.[0]?.tier === 2, JSON.stringify(back));
    c.advance(31_000);
    await put(10, 5);
    t.ok('30 秒すぎればまた上げられる', bridge.formats.at(-1)?.[0]?.tier === 3, JSON.stringify(bridge.formats.at(-1)));
  }

  // ---- 遅れの札（lag）・途切れ（stale）・止まった絵の 1 枚（still） ----
  {
    const c = clock(), bridge = fakeBridge();
    const hub = createScreencastHub({ bridge, ...c });
    const v = client();
    await hub.watch(v, 's1', { width: 400, height: 300, scale: 1 });

    // 300 ms フレームが届かなければ、最上段の 1 枚を 1 回だけ撮って送る
    bridge.frame('s1', 1, { stream: 3 });
    ackRound(hub, v, 's1', c);
    c.advance(300);
    await Promise.resolve(); await new Promise(r => setImmediate(r));
    const still = frames(v).at(-1);
    t.ok('300 ms で最上段（quality 80）の 1 枚を 1 回撮って送る', bridge.captures.length === 1 && bridge.captures[0].quality === 80 && still.still === true && still.data === 'U1RJaWw=');
    c.advance(600);
    t.ok('ページが変わるまではもう撮らない', bridge.captures.length === 1);
    hub.received(v, 's1', still.seq, { mark: true }); hub.received(v, 's1', still.seq);
    await new Promise(r => setTimeout(r, 35));   // capture echo の実時間判定窓（30 ms）を過ぎてから次のページ変更を送る
    bridge.frame('s1', 2, { stream: 3 });   // ページが変わった
    hub.received(v, 's1', frames(v).at(-1).seq, { mark: true }); hub.received(v, 's1', frames(v).at(-1).seq);
    c.advance(300);
    await new Promise(r => setImmediate(r));
    t.ok('ページが変われば、次に止まったときまた撮る', bridge.captures.length === 2);

    // 返事が 3 秒来ない → stale。返事が戻れば下りる
    await new Promise(r => setTimeout(r, 35));
    bridge.frame('s1', 3, { stream: 3 });
    c.advance(3000);
    await new Promise(r => setImmediate(r));
    t.ok('返事が 3 秒来なければ stale を知らせる', videos(v).at(-1)?.stale === true, JSON.stringify(videos(v)));
    hub.received(v, 's1', frames(v).at(-1).seq, { mark: true });
    hub.received(v, 's1', frames(v).at(-1).seq);
    t.ok('返事が戻れば stale は下りる', videos(v).at(-1)?.stale === false);

    // 段 0 まで下げても遅い → lag
    const tier = () => bridge.formats.at(-1)?.[0]?.tier ?? 3;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 3; i++) { bridge.frame('s1', bridge.acks.length + 1, { stream: tier() }); ackRound(hub, v, 's1', c, 70); }
    }
    t.ok('段 0 でも S の中央値が 50 ms を超え続けると lag を知らせる', videos(v).at(-1)?.lag === true, JSON.stringify(videos(v).at(-1)));
    for (let i = 0; i < 3; i++) { bridge.frame('s1', bridge.acks.length + 1, { stream: tier() }); ackRound(hub, v, 's1', c, 10); }
    t.ok('S が戻れば lag は下りる', videos(v).at(-1)?.lag === false);
  }

  // ---- 段ごとに分けられない撮影（内蔵ブラウザー）: 一番低い段にそろえる ----
  {
    const c = clock(), bridge = fakeBridge();
    delete bridge.setFormats; delete bridge.capture;   // 段ごとの口が無い bridge（parentPort）
    const hub = createScreencastHub({ bridge, ...c });
    const v = client();
    await hub.watch(v, 's1', { width: 400, height: 300, scale: 1 });
    bridge.frame('s1', 1, { data: 'QUJD' });
    t.ok('段ごとに分けられなくても、返事ごとの 1 枚と印は同じ（撮影元へもすぐ ack）',
      bridge.acks.length === 1 && v.got.map(m => m.type).join(',') === 'mark,frame');
    for (let i = 0; i < 3; i++) { bridge.frame('s1', 2 + i, {}); ackRound(hub, v, 's1', c, 70); }
    const restarts = bridge.requests.filter(([a]) => a === 'start');
    t.ok('段が下がったら、一番低い段の画質で撮り直す（start を掛け直す。大きさは端末の箱のまま）',
      restarts.length >= 2 && restarts.at(-1)[2].options.quality === SCREENCAST_TIERS[2].q && restarts.at(-1)[2].options.width === 400, JSON.stringify(restarts.at(-1)?.[2].options));
  }
}
