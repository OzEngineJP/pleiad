// 端末から PC の Chrome の窓を操作する（「この端末で操作する」。by: 'device'。ADR 0296）と、ビューアの⋯「Chrome で開く」（openForConversation）。偽の Chrome・偽の OS の層。
//   - core/chrome/input.mjs の変換は決まった CDP の形になる
//   - 端末が「この端末で操作する」を押すと、見ているタブをその端末の人の操作にする（core/chrome/tab-holder.mjs の touch）。窓は見せず、映像も止めず、
//     会話の一時停止もしない。ページの大きさは見る・操作するのどれでも変えない（AI が決めた大きさの実ページをそのまま操作する）。任せると AI に戻す
//   - 「PC で操作する」の窓を出している所へ端末が後から押しても今の状態を返すだけ。fromPc のときは PC の窓を隠してから端末へ移す
//   - openForConversation は接続が無ければ Chrome の許可を待つ（接続の案内のカードは出さない）。開いたタブを今のタブにする
import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';
import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub } from '../../core/browser-screencast.mjs';
import { HUMAN_MESSAGE, RESNAPSHOT_MESSAGE } from '../../core/chrome/tab-holder.mjs';
import { inputCommands, deviceViewport } from '../../core/chrome/input.mjs';
import { browserOps } from '../../core/ops/browser.mjs';

export const name = 'chrome-device';
export const title = '端末から Chrome の窓を操作する（ADR 0296）: 入力の変換・この端末で操作するは見ているタブだけを端末の人の操作にする・窓は見せず映像も会話も止めない・ページの大きさは見る・操作するのどれでも変えない・PC の窓を出している所へ後から押したほうは今の状態を返す・Chrome で開く（偽の Chrome・偽の OS の層）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => { const msg = JSON.parse(data.toString()); if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
    ws.once('open', () => resolve({
      ws,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

const TIMING = { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200, boundsWaitMs: 100 };

async function rig({ permission = 'auto', handoff = null } = {}) {
  const chrome = await startFakeChrome({ permission });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const logs = [];
  const scope = createChromeWindows({ os: os_, locate, log: line => logs.push(line), timing: TIMING });
  const relay = createChromeRelay({ connection: conn, os: os_, locate, scope, log: line => logs.push(line), ...(handoff ? { handoff } : {}) });
  const bridge = createChromeScreencast({ host: relay.view, relay, log: line => logs.push(line) });
  // control が映像の口（suspend・resume）に何を頼んだかも残す
  const captureLog = [];
  const capture = {
    suspend: id => { captureLog.push(['suspend', id]); return bridge.suspend(id); },
    resume: id => { captureLog.push(['resume', id]); return bridge.resume(id); },
  };
  const control = createChromeControl({ relay, os: os_, capture, log: line => logs.push(line) });
  const hub = createScreencastHub({ bridge, source: 'chrome' });
  const messages = [];
  const client = { send: message => messages.push(message) };
  const live = [];
  return {
    chrome, fake: chrome.browser, os: os_, conn, scope, relay, bridge, control, hub, client, messages, captureLog, logs,
    /** そのタブの持ち手（無ければ AI） */
    held: (sessionId, targetId) => relay.unify.tabHolder.holder(sessionId, targetId) ?? { holder: 'ai' },
    async agent(sessionId) { const a = await agent(await relay.endpoint(sessionId)); live.push(a); return a; },
    async stop() { for (const a of live) { try { a.close(); } catch { /* 閉じていてもよい */ } } hub.close?.(); bridge.close(); control.close(); relay.close(); await conn.close(); await chrome.stop(); },
  };
}

const concealed = (r, targetId) => {
  const windowId = r.fake.targets().find(x => x.targetId === targetId)?.windowId;
  const h = r.os.hwnds().find(x => x.windowId === windowId);
  return h?.concealed === true && h.alpha === 0;
};
/** mark より後に送った、ページの大きさを触る呼び出し（override・戻す口・窓の大きさ） */
const sizeCalls = (r, mark = 0) => r.chrome.calls.slice(mark).filter(c => /^(Emulation\.(set|clear)DeviceMetricsOverride|Browser\.setContentsSize)$/.test(c.method));
const DEVICE = { width: 390, height: 700, scale: 2 };

export default async function (t) {
  // ===== 1. 入力の変換（core/chrome/input.mjs）: 決まった CDP の形 =====
  {
    const tap = inputCommands({ type: 'tap', x: 100, y: 200 }, { width: 390, height: 700 });
    t.ok('タップは mouseMoved → mousePressed → mouseReleased（左・1 回）', JSON.stringify(tap) === JSON.stringify([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 200, button: 'none', buttons: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 200, button: 'left', buttons: 0, clickCount: 1 }],
    ]), JSON.stringify(tap));
    const enter = inputCommands({ type: 'key', key: 'Enter' });
    t.ok('Enter は keyDown（text は \\r）と keyUp。仮想キーは 13', enter[0][1].type === 'keyDown' && enter[0][1].text === '\r' && enter[0][1].windowsVirtualKeyCode === 13 && enter[1][1].type === 'keyUp');
    t.ok('座標は端末のページの大きさに丸める', JSON.stringify(inputCommands({ type: 'tap', x: 5000, y: -3 }, { width: 390, height: 700 })[0][1]) === JSON.stringify({ type: 'mouseMoved', x: 390, y: 0, button: 'none', buttons: 0 }));
    t.ok('知らない入力・決めていないキーは送らない', inputCommands({ type: 'drag' }).length === 0 && inputCommands({ type: 'key', key: 'F12' }).length === 0 && inputCommands(undefined).length === 0);
    const v = deviceViewport({ width: 100.4, height: 9999, scale: 5 });
    t.ok('端末の箱の大きさは範囲に丸める（幅 240〜1600・高さ 240〜2400・倍率 1〜3）', v.width === 240 && v.height === 2400 && v.scale === 3, JSON.stringify(v));
    t.ok('大きさが数でなければ null（引き継げない）', deviceViewport({ width: 'x', height: 700 }) === null && deviceViewport() === null);
  }

  // ===== 2. 「この端末で操作する」: 見ているタブだけを端末の人の操作にする。窓は見せず・映像は止めず・会話も止めず・ページの大きさは端末の箱 =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const tab = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const other = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tab, flatten: true })).result.sessionId;
      const sidOther = (await a.cmd('Target.attachToTarget', { targetId: other, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid);   // 今のタブ（AI のタブ）を 1 つ目に戻す（準備の getFrameTree では移らない。ADR 0321）
      await until(() => r.relay.view.current('one') === tab);
      // AI が自分でページの大きさを決めた（agent-browser の set viewport。中継のセッション経由）
      const windowId = r.fake.targets().find(x => x.targetId === tab)?.windowId;
      await a.cmd('Browser.setContentsSize', { windowId, width: 1200, height: 800 });
      const mark0 = r.chrome.calls.length;
      await r.hub.watch(r.client, 'one', { device: 'phone', ...DEVICE, quality: 'auto' });
      t.ok('映像を見始めた（中継自身のセッション）', await until(() => r.fake.screencasting(tab)));
      t.ok('見始めるだけではページの大きさを変えない（AI が決めた大きさを押し戻さない・override も戻す口も窓の大きさも送らない）',
        sizeCalls(r, mark0).length === 0, JSON.stringify(sizeCalls(r, mark0).map(c => c.method)));

      const invalid = await r.control.takeOver('one', { by: 'device' }).then(() => null, error => error);
      t.ok('端末の箱の大きさが無ければ INVALID（人の操作にしない・接続も切らない）', invalid?.code === 'INVALID' && r.control.state('one').state === 'running' && r.held('one', tab).holder === 'ai' && a.ws.readyState === 1, JSON.stringify(invalid?.code));
      const reveals = r.os.calls('reveal').length;
      const mark = r.chrome.calls.length;
      const took = await r.control.takeOver('one', { by: 'device', ...DEVICE });
      const held = r.held('one', tab);
      t.ok('端末から → 見ているタブをその端末の人の操作にする（by: device・箱の大きさ・時間で AI に戻せる形）', held.holder === 'human' && held.by === 'device' && held.viewport?.width === 390 && !held.pinned && r.held('one', other).holder === 'ai', JSON.stringify(held));
      t.ok('会話は止めない（running のまま・一時停止にしない）', took.state === 'running' && took.by === null && !r.relay.state('one').paused, JSON.stringify(took));
      t.ok('窓は PC の画面に見せない（reveal も前に出すも呼ばない。隠れたまま）', r.os.calls('reveal').length === reveals && concealed(r, tab));
      t.ok('映像は止めない（suspend を呼ばない・screencast も続く）', r.captureLog.length === 0 && !r.bridge.isSuspended('one') && r.fake.screencasting(tab), JSON.stringify(r.captureLog));
      const held1 = (await a.cmd('Runtime.evaluate', { expression: '1' }, sid)).error?.message;
      const passed = (await a.cmd('Runtime.evaluate', { expression: '1' }, sidOther)).error;
      t.ok('エージェントの接続は切らない。そのタブへの操作は断り、ほかのタブは通る', a.ws.readyState === 1 && held1 === HUMAN_MESSAGE && !passed, JSON.stringify([held1, passed]));
      t.ok('端末の人の操作でもページの大きさを変えない（AI が決めた大きさの実ページをそのまま操作する）',
        sizeCalls(r, mark).length === 0, JSON.stringify(sizeCalls(r, mark).map(c => c.method)));

      // 端末の箱が変わった（回転）: ページの大きさはやはり変えない
      const markRot = r.chrome.calls.length;
      await r.control.takeOver('one', { by: 'device', width: 700, height: 390, scale: 2 });
      t.ok('回転してもページの大きさを変えない', sizeCalls(r, markRot).length === 0, JSON.stringify(sizeCalls(r, markRot).map(c => c.method)));

      const mark2 = r.chrome.calls.length;
      const back = await r.control.resume('one');
      t.ok('任せる → そのタブを AI に戻す（窓は隠れたまま）', back.state === 'running' && r.held('one', tab).holder === 'ai' && concealed(r, tab), JSON.stringify(back));
      t.ok('任せるときもページの大きさを触らない（戻す override も戻す口も窓の大きさも送らない）', sizeCalls(r, mark2).length === 0, JSON.stringify(sizeCalls(r, mark2).map(c => c.method)));
      const read = (await a.cmd('Page.captureScreenshot', {}, sid)).error;
      t.ok('戻した直後でも、読むだけのコマンドは通る（新しい画面を撮れる）', !read);
      const firstOp = (await a.cmd('Runtime.evaluate', { expression: '1' }, sid)).error?.message;
      t.ok('戻した直後の最初の操作は RESNAPSHOT で断る（新しい画面を撮らせる）', firstOp === RESNAPSHOT_MESSAGE, JSON.stringify(firstOp));
      t.ok('その次の操作は通る', !(await a.cmd('Runtime.evaluate', { expression: '2' }, sid)).error);

      // AI が自分で新しい大きさを決め直したあと、見る人が居なくなっても、その大きさを人の古い値・既定値へ戻さない
      await a.cmd('Browser.setContentsSize', { windowId, width: 620, height: 720 });
      await a.cmd('Emulation.setDeviceMetricsOverride', { width: 300, height: 500, deviceScaleFactor: 1, mobile: false }, sid);
      const markAi = r.chrome.calls.length;
      await r.hub.unwatch(r.client, 'one');   // 最後の見る人（入力の口のセッションを外す）
      t.ok('AI が決め直した大きさを、最後の見る人がやめても人の古い値へ戻さない（窓にも emulation にも触らない）',
        sizeCalls(r, markAi).length === 0, JSON.stringify(sizeCalls(r, markAi).map(c => c.method)));

      // 閲覧の増減・リサイズ・スマホの箱の変化・やめる・見直す — どれもページの大きさを変えない
      const mark3 = r.chrome.calls.length;
      const pcClient = { send() {} };
      await r.hub.watch(pcClient, 'one', { width: 560, height: 700, quality: 'auto' });          // PC の欄も開く
      await r.hub.watch(r.client, 'one', { device: 'phone', width: 700, height: 390, scale: 2, quality: 'auto' });   // スマホが回転した箱で見直す
      await r.hub.watch(pcClient, 'one', { width: 640, height: 700, quality: 'auto' });          // PC の欄のリサイズ
      await r.hub.unwatch(pcClient, 'one');
      await r.hub.unwatch(r.client, 'one');                                                    // 最後の見る人もやめる（入力の口のセッションを外す）
      await r.hub.watch(r.client, 'one', { width: 560, height: 700, quality: 'auto' });          // 見直す
      t.ok('見る人の増減・リサイズ・やめる・見直す — どれもページの大きさを変えない（override・戻す口・窓の大きさを触らない）',
        sizeCalls(r, mark3).length === 0, JSON.stringify(sizeCalls(r, mark3).map(c => c.method)));

      // 別の会話からの閲覧も、お互いのページの大きさを変えない
      const b = await r.agent('two');
      const tab2 = (await b.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await until(() => r.relay.view.current('two') === tab2);
      const mark4 = r.chrome.calls.length;
      const client2 = { send() {} };
      await r.hub.watch(client2, 'two', { device: 'phone', ...DEVICE, quality: 'auto' });
      await until(() => r.fake.screencasting(tab2));
      await r.hub.unwatch(client2, 'two');
      t.ok('ほかの会話の閲覧もページの大きさを変えない', sizeCalls(r, mark4).length === 0,
        JSON.stringify(sizeCalls(r, mark4).map(c => c.method)));
    } finally { await r.stop(); }
  }

  // ===== 3. 「PC で操作する」の窓を出している所へ端末が押す: fromPc でなければ今の状態を返すだけ。fromPc なら PC の窓を隠してから端末へ移す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const tab = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await until(() => r.relay.view.current('one') === tab);
      const onPc = await r.control.takeOver('one');
      const ops = () => r.captureLog.map(([op]) => op);
      t.ok('（前提）PC で操作する → paused・by: pc・PC の持ち手で固定・映像を断つ', onPc.state === 'paused' && onPc.by === 'pc' && r.held('one', tab).by === 'pc' && r.held('one', tab).pinned === true && ops().includes('suspend') && !ops().includes('resume'), JSON.stringify([onPc, r.captureLog]));
      const late = await r.control.takeOver('one', { by: 'device', ...DEVICE });
      t.ok('後から端末が押しても、今の状態（by: pc）を返すだけ（PC の持ち手のまま）', late.state === 'paused' && late.by === 'pc' && r.held('one', tab).by === 'pc' && r.held('one', tab).pinned === true, JSON.stringify(late));
      r.os.opts.concealFails = true;
      const stuck = await r.control.takeOver('one', { by: 'device', ...DEVICE, fromPc: true });
      t.ok('fromPc でも PC の窓を隠せなければ移さない（by: pc のまま・conceal-failed・映像は断ったまま）', stuck.by === 'pc' && stuck.error === 'conceal-failed' && r.held('one', tab).by === 'pc' && !ops().includes('resume'), JSON.stringify(stuck));
      r.os.opts.concealFails = false;
      const moved = await r.control.takeOver('one', { by: 'device', ...DEVICE, fromPc: true });
      const held = r.held('one', tab);
      t.ok('fromPc: PC の窓を隠して端末の人の操作へ移す（paused は解け、理由も消える）', moved.state === 'running' && moved.by === null && moved.error === null && concealed(r, tab) && held.holder === 'human' && held.by === 'device' && !held.pinned, JSON.stringify([moved, held]));
      t.ok('fromPc: 映像の断りを解く', ops().includes('resume') && !r.bridge.isSuspended('one'), JSON.stringify(r.captureLog));
      await r.control.resume('one');
      t.ok('任せると AI に戻す', r.held('one', tab).holder === 'ai');
    } finally { await r.stop(); }
  }

  // ===== 4. 窓の無い会話・見ていない間に押した =====
  {
    const r = await rig();
    try {
      const none = await r.control.takeOver('nobody', { by: 'device', width: 390, height: 700 }).then(() => null, error => error);
      t.ok('会話が中継に無ければ NO_WINDOW', none?.code === 'NO_WINDOW');
      const a = await r.agent('one');
      const early = await r.control.takeOver('one', { by: 'device', width: 390, height: 700 }).then(() => null, error => error);
      t.ok('タブがまだ無ければ NO_WINDOW（何も残さない）', early?.code === 'NO_WINDOW' && r.control.state('one').state === 'running' && a.ws.readyState === 1);
      const tab = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await until(() => r.relay.view.current('one') === tab);
      await r.control.takeOver('one', { by: 'device', width: 400, height: 640, scale: 1 });
      t.ok('映像を見ていなくても端末の人の操作にできる', r.held('one', tab).holder === 'human' && r.held('one', tab).viewport?.width === 400, JSON.stringify(r.held('one', tab)));
      const mark = r.chrome.calls.length;
      await r.hub.watch(r.client, 'one', { device: 'phone', width: 400, height: 640, scale: 1, quality: 'auto' });
      t.ok('端末の人の操作のまま見始めても、ページの大きさを変えない', sizeCalls(r, mark).length === 0, JSON.stringify(sizeCalls(r, mark).map(c => c.method)));
      const mark2 = r.chrome.calls.length;
      await r.hub.unwatch(r.client, 'one');
      t.ok('そのまま見るのをやめても、ページの大きさを触らない（override・戻す口・窓の大きさを送らない）', sizeCalls(r, mark2).length === 0, JSON.stringify(sizeCalls(r, mark2).map(c => c.method)));
      await r.control.resume('one');
      t.ok('見ていない間に任せても AI に戻る', r.held('one', tab).holder === 'ai');
    } finally { await r.stop(); }
  }

  // ===== 5. ops: chromeTakeOver の by: device の引数 =====
  {
    const op = browserOps.find(o => o.id === 'browser.chromeTakeOver');
    const calls = [];
    const ctx = { locale: 'ja', chrome: { status: () => ({ state: 'connected' }) }, chromeControl: {
      takeOver: async (sessionId, options) => {
        calls.push([sessionId, options]);
        if (options.by === 'device' && !Number.isFinite(options.width)) throw Object.assign(new Error('x'), { code: 'INVALID' });
        return { sessionId, state: 'paused', since: 1, error: null, by: options.by };
      } } };
    await op.handler(ctx, { sessionId: 's', by: 'device', width: 390, height: 700, scale: 2 });
    await op.handler(ctx, { sessionId: 's', width: 390 });
    t.ok('chromeTakeOver: by: device は大きさを渡し、それ以外は by: pc（大きさは捨てる）', JSON.stringify(calls) === JSON.stringify([['s', { by: 'device', width: 390, height: 700, scale: 2 }], ['s', { by: 'pc' }]]), JSON.stringify(calls));
    const invalid = await op.handler(ctx, { sessionId: 's', by: 'device' }).then(() => null, error => error);
    t.ok('大きさが無ければ INVALID（画面の言語の字）', invalid?.code === 'INVALID' && typeof invalid.message === 'string' && invalid.message.length > 0, JSON.stringify(invalid?.message));
    t.ok('入力の形: by は pc か device・大きさは正の数', op.input.safeParse({ sessionId: 's', by: 'phone' }).success === false && op.input.safeParse({ sessionId: 's', by: 'device', width: -1 }).success === false && op.input.safeParse({ sessionId: 's', by: 'device', width: 390, height: 700, scale: 2 }).success === true && op.input.safeParse({ sessionId: 's', by: 'device', width: 390, height: 700, fromPc: true }).success === true);
  }

  // ===== 6. ビューアの⋯「Chrome で開く」（relay.openForConversation） =====
  {
    const connects = [];
    const handoff = { connect: id => { connects.push(id); return null; } };
    const r = await rig({ permission: 'hold', handoff });
    try {
      const notHttp = await r.relay.openForConversation('fresh', 'file:///C:/secret.txt').then(() => null, error => error);
      t.ok('http(s) でない URL は断る（接続も始めない）', notHttp && /denied/.test(notHttp.message) && r.chrome.pending() === 0, String(notHttp?.message));
      const opening = r.relay.openForConversation('fresh', 'https://a.example/');
      t.ok('接続が無ければ Chrome の許可を待つ', await until(() => r.chrome.pending() === 1));
      t.ok('待つ間に接続の案内のカードは出さない（handoff.connect を呼ばない）', connects.length === 0);
      r.chrome.approve();
      const { targetId } = await opening;
      const target = r.fake.targets().find(x => x.targetId === targetId);
      t.ok('許可されると会話の窓に URL を開く', target?.url === 'https://a.example/', JSON.stringify(target));
      t.ok('開いたタブを会話の範囲に入れる（映像が追う）。人が開いたタブは AI のタブにはしない（ADR 0320）', r.relay.view.tabs('fresh').some(x => x.targetId === targetId) && r.relay.view.shown('fresh') === targetId && r.relay.view.current('fresh') === null);
      t.ok('窓は画面の外に隠す（エージェントの窓と同じ）', await until(() => concealed(r, targetId)));
      t.ok('ターンは始めない（エージェントには知らせない。状態は idle）', r.control.state('fresh').state === 'idle');
      const second = await r.relay.openForConversation('fresh', 'https://b.example/');
      t.ok('つながっていれば待たずに同じ会話の範囲へ開く', second.targetId !== targetId && r.relay.view.tabs('fresh').length === 2 && r.relay.view.current('fresh') === null);
    } finally { await r.stop(); }
  }
  {
    const r = await rig({ permission: 'hold' });
    try {
      const ac = new AbortController();
      const waiting = r.relay.openForConversation('other', 'https://c.example/', { signal: ac.signal }).then(() => 'opened', () => 'rejected');
      await until(() => r.chrome.pending() === 1);
      ac.abort();
      t.ok('許可の待ちは signal でやめられる（タブは開かない）', await waiting === 'rejected' && r.relay.view.tabs('other').length === 0);
    } finally { await r.stop(); }
  }
}
