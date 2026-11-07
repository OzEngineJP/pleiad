// 手動時計で、撮影の応答と screencast の到着順を独立に動かす。
export async function checkScreencastDuplicates(createHub, t) {
  const metadata = { deviceWidth:400, deviceHeight:300, pageScaleFactor:1, offsetTop:0, scrollOffsetX:0, scrollOffsetY:0 };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  async function rig({ multi = false } = {}) {
    let time = 1000, receive, state, captures = 0, finish, id = 0, tier = 3;
    const timers = new Set(), messages = [], acks = [];
    const clock = {
      now:() => time,
      setTimer(fn, ms) { const timer = { fn, at:time + ms }; timers.add(timer); return timer; },
      clearTimer(timer) { timers.delete(timer); },
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
    const bridge = {
      onFrame(fn) { receive = fn; }, onState(fn) { state = fn; }, onEnded() {}, ack(...args) { acks.push(args); },
      async request() { return { tabId:'tab', state:{ tabId:'tab' } }; },
      capture() { captures++; return new Promise(resolve => { finish = resolve; }); },
      ...(multi ? { async setFormats(_id, formats) { tier = formats[0].tier; return { multi:true }; } } : {}),
    };
    const hub = createHub({ bridge, ...clock });
    const client = { send(message) { messages.push(message); } };
    const frames = () => messages.filter(message => message.type === 'frame');
    const ack = () => { const f = frames().at(-1); hub.received(client, 's', f.seq, { mark:true }); hub.received(client, 's', f.seq); };
    const frame = (data = 'PAGE', meta = metadata) => receive('s', { id:++id, stream:tier, data, metadata:meta });
    await hub.watch(client, 's', { width:400, height:300 });
    frame(); ack();
    return { ...clock, frame, ack, frames, acks, state:tabId => state('s', { tabId }), get captures() { return captures; }, get tier() { return tier; },
      finish:async () => { finish({ data:'SHARP' }); await flush(); }, close:() => hub.unwatch(client, 's') };
  }
  const realNow = Date.now;
  try {
    for (const delay of [10, 45, 500]) {
      const r = await rig(); Date.now = r.now;
      r.advance(300); r.advance(delay); r.frame();
      await r.finish();
      t.ok(`撮影応答前の同一画像（${delay} ms 後）でも鮮明な 1 枚を捨てない`, r.frames().at(-1)?.still === true && r.frames().length === 2);
      r.ack(); r.advance(500); r.frame(); await r.finish(); r.advance(1000);
      t.ok(`遅い重複（${delay} ms）を再送せず、確認撮影を含めて 2 回で止まる`, r.captures === 2 && r.frames().length === 2 && r.acks.length === 3);
      await r.close();
    }
    {
      const r = await rig(); Date.now = r.now;
      r.advance(300); await r.finish(); r.ack(); r.advance(10); r.frame('NEW_DOM');
      t.ok('鮮明な 1 枚の 10 ms 後、同じ寸法・位置の本当の更新を送る', r.frames().at(-1)?.data === 'NEW_DOM');
      r.ack(); r.advance(300); await r.finish();
      t.ok('本当の更新が止まったら再び鮮明な 1 枚を撮る', r.captures === 2 && r.frames().at(-1)?.still);
      await r.close();
    }
    {
      const r = await rig({ multi:true }); Date.now = r.now;
      for (let i = 0; i < 4; i++) { r.frame('CHANGE_' + i); r.ack(); }
      t.ok('速い返事で画質の段が 3 から 4 へ替わる', r.tier === 4);
      r.frame('TIER_4'); r.ack(); r.advance(300); r.frame('TIER_4'); await r.finish(); r.ack();
      r.advance(500); r.frame('TIER_4'); await r.finish(); r.advance(1500);
      t.ok('画質変更で画像のバイトが変わっても、新しい段で確認撮影を含めて 2 回で止まる', r.captures === 2 && r.frames().at(-1)?.still);
      await r.close();
    }
    {
      const r = await rig(); Date.now = r.now;
      r.advance(300); await r.finish(); r.ack(); r.advance(10);
      r.frame('PAGE', { ...metadata, scrollOffsetY:120 });
      t.ok('同じ画像のバイトでもスクロール位置が違えば送る', r.frames().at(-1)?.metadata.scrollOffsetY === 120 && !r.frames().at(-1)?.still);
      r.ack(); r.frame('PAGE', {});
      t.ok('位置を判定できない画像は捨てない', !r.frames().at(-1)?.still && r.frames().at(-1)?.metadata.deviceWidth === undefined);
      await r.close();
    }
    {
      const r = await rig(); Date.now = r.now;
      r.advance(300); r.state('other'); r.state('tab'); await r.finish();
      t.ok('撮影中に別のタブを経て戻っても、前の撮影の応答を表示しない', r.frames().length === 1);
      r.frame(); r.ack(); r.advance(300); await r.finish();
      t.ok('戻ったタブで同じ画像が来ても、新しい映像として鮮明な 1 枚を撮り直す', r.captures === 2 && r.frames().at(-1)?.still);
      await r.close();
    }
  } finally { Date.now = realNow; }
}
