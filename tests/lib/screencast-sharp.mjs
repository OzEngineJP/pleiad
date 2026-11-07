// These JPEGs have identical reduced images but different decoded sharp pixels.
// The browser suite also creates the pair with Chrome's canvas encoder.
import fs from 'node:fs/promises';

export async function checkScreencastSharp(createHub, t, fixture) {
  const pair = fixture ?? JSON.parse(await fs.readFile(new URL('../fixtures/screencast-fine-detail.json', import.meta.url), 'utf8'));
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  async function rig(echoDelay = null, viewers = 1, captureDelay = 100) {
    let time = 1000, receive, hub, current = pair.sharp, captures = 0, id = 0, tiers = [3];
    const timers = new Set(), frames = [];
    const clock = { now:() => time, setTimer(fn, ms) { const timer = { fn, at:time + ms }; timers.add(timer); return timer; }, clearTimer(timer) { timers.delete(timer); } };
    const frame = (data = pair.low) => { for (const stream of [...tiers]) receive('s', { id:++id, stream, data, metadata:pair.metadata }); };
    hub = createHub({ ...clock, bridge:{
      onFrame(fn) { receive = fn; }, onState() {}, onEnded() {}, ack() {},
      async request() { return { state:{ tabId:'tab' } }; }, async setFormats(_id, formats) { tiers = formats.map(format => format.tier); return { multi:true }; },
      capture() {
        captures++; const data = current;
        if (echoDelay !== null) clock.setTimer(() => frame(), echoDelay);
        return new Promise(resolve => clock.setTimer(() => resolve({ data }), captureDelay));
      },
    } });
    const clients = [], histories = [], held = new Set(), fast = new Set();
    async function watch() {
      const history = [];
      const client = { send(message) { if (message.type === 'frame') { history.push(message); if (clients.indexOf(client) === 0) frames.push(message); if (fast.has(client)) hub.received(client, 's', message.seq, { mark:true }); if (!held.has(client)) queueMicrotask(() => hub.received(client, 's', message.seq)); } } };
      clients.push(client);
      histories.push(history);
      await hub.watch(client, 's', { width:400 + 100 * clients.length, height:400, device:'phone' });
    }
    for (let i = 0; i < viewers; i++) await watch();
    async function advance(ms) {
      const end = time + ms;
      await flush();
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= end).sort((a,b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due); time = due.at; due.fn(); await flush();
      }
      time = end; await flush();
    }
    frame(); await flush();
    return { advance, frame, frames, watch, histories, hold(index) { held.add(clients[index]); },
      fast(index) { fast.add(clients[index]); }, get tiers() { return tiers; },
      ack(index) { held.delete(clients[index]); hub.received(clients[index], 's', histories[index].at(-1).seq); },
      get captures() { return captures; }, update() { current = pair.updatedSharp; }, close:() => Promise.all(clients.map(client => hub.unwatch(client, 's'))) };
  }
  {
    const r = await rig(); await r.advance(1400); r.update(); r.frame(); await r.advance(2000);
    t.ok('same reduced JPEG still refreshes a genuinely changed sharp JPEG without an earlier capture echo', r.frames.at(-1)?.data === pair.updatedSharp && r.captures === 2);
    t.ok('fine update does not resend the reduced JPEG', r.frames.filter(frame => !frame.still).length === 1);
    await r.close();
  }
  for (const delay of [10, 450, 1500]) {
    const r = await rig(delay); await r.advance(8000);
    t.ok(`real JPEG capture echoes at ${delay}ms converge within two captures`, r.captures >= 1 && r.captures <= 2 && r.frames.length === 2 && r.frames.at(-1)?.data === pair.sharp);
    const before = r.captures; r.update(); r.frame(); await r.advance(8000);
    t.ok(`fine JPEG update after ${delay}ms echoes reaches the viewer with at most two further captures`, r.frames.at(-1)?.data === pair.updatedSharp && r.captures > before && r.captures <= before + 2);
    await r.close();
  }
  {
    const r = await rig(); await r.advance(500); r.frame(); await r.advance(500);
    t.ok('an unchanged verification neither resends the sharp JPEG nor keeps capturing', r.captures === 2 && r.frames.length === 2);
    r.update(); r.frame(); await r.advance(1000);
    const consumed = r.captures;
    r.frame(); await r.advance(1000);
    t.ok('if a capture has no echo, only one subsequent duplicate can be consumed and the following one recovers', consumed === 2 && r.frames.at(-1)?.data === pair.updatedSharp && r.captures === 3);
    await r.close();
  }
  {
    const r = await rig(10, 2); await r.advance(8000);
    t.ok('two viewers share capture echoes and stop within two captures', r.captures <= 2 && r.frames.length === 2);
    await r.watch(); await r.advance(8000);
    const before = r.captures;
    await r.advance(8000);
    t.ok('a later viewer does not make existing viewers capture each other repeatedly', r.captures === before && before <= 4);
    r.update(); r.frame(); await r.advance(8000);
    t.ok('a fine JPEG update with three viewers converges within two further captures', r.frames.at(-1)?.data === pair.updatedSharp && r.captures <= before + 2);
    await r.close();
  }
  {
    const r = await rig(10, 2); r.hold(0); await r.advance(500);
    r.update(); r.frame(); await r.advance(1000);
    t.ok('a fast viewer receives a fine update while another still has an unacknowledged sharp image', r.histories[1].at(-1)?.data === pair.updatedSharp);
    r.ack(0); await r.advance(8000);
    t.ok('a slow viewer receives the newer sharp image even when shared verification finds it unchanged', r.histories.every(history => history.at(-1)?.data === pair.updatedSharp));
    const before = r.captures; await r.advance(8000);
    t.ok('different acknowledgement speeds still converge after the sharp update', r.captures === before);
    await r.close();
  }
  {
    const r = await rig(null, 1, 1000); await r.advance(350);
    r.update(); r.frame(pair.sharp); await r.advance(50); await r.watch(); await r.advance(1000);
    t.ok('a viewer joining after a newer screencast frame never receives the earlier in-flight sharp image', !r.histories[1].some(frame => frame.still && frame.data === pair.sharp));
    await r.advance(4000);
    t.ok('a rejected shared capture is retried for the new frame', r.histories.every(history => history.at(-1)?.data === pair.updatedSharp));
    await r.close();
  }
  {
    const r = await rig(10, 2); r.fast(0);
    for (let i = 0; i < 5; i++) { r.frame(i % 2 ? pair.low : pair.sharp); await r.advance(1); }
    r.frame(); await r.advance(1);
    t.ok('viewers can use distinct quality tiers during sharp verification', new Set(r.tiers).size === 2);
    await r.advance(8000); const before = r.captures;
    r.update(); r.frame(); await r.advance(8000);
    t.ok('capture echoes across distinct quality tiers converge and preserve the fine update', r.captures <= before + 2 && r.histories.every(history => history.at(-1)?.data === pair.updatedSharp));
    const after = r.captures; await r.advance(8000);
    t.ok('distinct quality tiers do not restart capture after settling', r.captures === after);
    await r.close();
  }
}
