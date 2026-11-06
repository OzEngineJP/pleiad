import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay, PAUSED_MESSAGE } from '../../core/chrome/relay.mjs';
import { HUMAN_MESSAGE, RESNAPSHOT_MESSAGE } from '../../core/chrome/tab-holder.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';

export const name = 'chrome-control';
export const title = 'エージェントの Chrome の窓の止める・PC で操作する・任せる（ADR 0148・0154・0293）: 状態機械・人の操作のタブの断り・映像を断る・止めて人の送信で解く・窓を見える形に戻して前に出す／画面の外へ戻す・窓が閉じられた／Chrome が閉じた・持ち越した一時停止・押した位置（偽の OS の層と偽の Chrome）';

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
    const raw = [];
    let next = 0;
    ws.on('message', data => {
      raw.push(data.toString());
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
    });
    ws.once('open', () => resolve({
      ws, raw,
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
const refused = url => agent(url).then(client => { client.close(); return false; }, () => true);

const TIMING = { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200, boundsWaitMs: 100 };

async function rig({ authorize, features } = {}) {
  const chrome = await startFakeChrome({ permission: 'auto' });
  const os_ = fakeChromeOs({ chrome, ...(features ? { features } : {}) });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const logs = [];
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const scope = createChromeWindows({ os: os_, locate, log: line => logs.push(line), timing: TIMING });
  const relay = createChromeRelay({ connection: conn, os: os_, locate, scope, log: line => logs.push(line), ...(authorize ? { authorize } : {}) });
  let clock = 1_000_000;
  // 映像の撮影を断る口（core/chrome/screencast.mjs の代わり）。suspend した時に OS の層の reveal がいくつ呼ばれていたかも残す（先に断つ）
  const captureLog = [];
  const capture = { suspend: id => captureLog.push({ op: 'suspend', id, reveals: os_.calls('reveal').length, lookups: os_.calls('appWindow').length + os_.calls('foreground').length }), resume: id => captureLog.push({ op: 'resume', id }) };
  const control = createChromeControl({ relay, os: os_, now: () => clock, capture, log: line => logs.push(line) });
  const events = [];
  control.onChange(state => events.push(state));
  const taps = [];
  control.onTap(tap => taps.push(tap));
  const live = [];
  return {
    chrome, conn, relay, control, logs, os: os_, scope, fake: chrome.browser, events, taps, captureLog,
    holder: (sessionId, targetId) => relay.unify.tabHolder.holder(sessionId, targetId)?.holder ?? 'ai',
    pinned: (sessionId, targetId) => relay.unify.tabHolder.holder(sessionId, targetId)?.pinned === true,
    advance: ms => { clock += ms; },
    async agent(sessionId, options = {}) {
      const a = await agent(await relay.endpoint(sessionId, options));
      live.push(a);
      return a;
    },
    async stop() { for (const a of live) { try { a.close(); } catch { /* 閉じていてもよい */ } } control.close(); relay.close(); await conn.close(); await chrome.stop(); },
  };
}

const hwndOf = (r, windowId) => r.os.hwnds().find(h => h.windowId === windowId);
const tabInfo = (r, targetId) => r.fake.targets().find(x => x.targetId === targetId);
const concealedOk = h => h?.concealed === true && h.alpha === 0 && h.ex.toolwindow && h.ex.layered && h.ex.transparent && !h.ex.appwindow;
const visibleOk = h => h && h.concealed === false && h.alpha === 255 && !h.ex.toolwindow && !h.ex.transparent && h.ex.appwindow;
const last = r => r.events.at(-1)?.state;
const suspendedNow = r => r.captureLog.filter(x => x.op === 'suspend').length > r.captureLog.filter(x => x.op === 'resume').length;

export default async function (t) {
  // ===== 1. 状態機械: running / idle / stopped。止めると再接続を断ち、次の人の送信（unlock）で解ける =====
  {
    const r = await rig();
    try {
      t.ok('会話がまだ中継に無ければ idle（便りは出さない）', r.control.state('none').state === 'idle' && r.events.length === 0);
      const a = await r.agent('one');
      t.ok('端点を渡すとターンの間（running）', r.control.state('one').state === 'running' && last(r) === 'running', JSON.stringify(r.events));
      r.relay.endTurn('one');
      t.ok('ターンが終わると idle（待機中）', r.control.state('one').state === 'idle' && last(r) === 'idle');
      const url = await r.relay.endpoint('one');
      t.ok('次のターンでまた running', r.control.state('one').state === 'running' && last(r) === 'running');
      t.ok('同じ状態は重ねて配らない', r.events.map(e => e.state).join() === 'running,idle,running', r.events.map(e => e.state).join());

      const stopped = await r.control.stop('one');
      t.ok('止める → stopped（接続を閉じる。1000 stopped）', stopped.state === 'stopped' && last(r) === 'stopped' && (await a.closed).code === 1000);
      t.ok('止めている間は再接続を断る', await refused(url));
      const key2 = await r.relay.endpoint('one');
      t.ok('ターンの開始だけでは解けない（人の送信でないとき）', key2 === url && r.control.state('one').state === 'stopped' && await refused(url));
      const b = await agent(await r.relay.endpoint('one', { unlock: true }));
      t.ok('人の送信で始まったターン（unlock）で鍵を作り直して解ける → running', r.control.state('one').state === 'running' && !(await b.cmd('Browser.getVersion')).error);
      t.ok('古い鍵は使えない', await refused(url));
      b.close();
    } finally { await r.stop(); }
  }

  // ===== 2. PC で操作する: 窓を見える形に戻して前に出し、見ているタブだけを人の操作にする → 任せるで画面の外へ戻して AI に戻す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const otherId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = tabInfo(r, tabId).windowId;
      const hw = () => hwndOf(r, windowId);
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const sidOther = (await a.cmd('Target.attachToTarget', { targetId: otherId, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, sidOther);
      await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 80, button: 'left', clickCount: 1 }, sid);   // 最後に触ったのは 1 つ目のタブ（今のタブ）
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, sid);
      t.ok('エージェントが押した位置（mousePressed の座標だけ）を onTap で配る', r.taps.length === 1 && r.taps[0].sessionId === 'one' && r.taps[0].x === 120 && r.taps[0].y === 80 && r.taps[0].windowId === windowId, JSON.stringify(r.taps));
      t.ok('PC で操作する前は窓は隠れている・映像は断らない', concealedOk(hw()) && r.captureLog.length === 0);

      const took = await r.control.takeOver('one');
      t.ok('PC で操作する → paused（since は始まりの時刻・by は pc）', took.state === 'paused' && took.since === 1_000_000 && took.by === 'pc' && last(r) === 'paused', JSON.stringify(took));
      t.ok('窓を見える形に戻した（画面の中・透明度 255・タスクバーに出る・マウスを受ける）', visibleOk(hw()), JSON.stringify(hw()));
      const reveal = r.os.calls('reveal').find(c => c.ref === hw().id), raise = r.os.calls('raise').at(-1);
      t.ok('押された直後の前面（Pleiad の窓）のある画面の中へ戻す', reveal?.ref === hw().id && reveal.near === 'pleiad-window', JSON.stringify(reveal));
      t.ok('窓を前に出す（raise）。reveal の後', raise?.ref === hw().id && r.os.getForeground() === hw().id && r.os.log.indexOf(reveal) < r.os.log.indexOf(raise));
      t.ok('撮影を断つ口（suspend）を 1 回、窓を見える形に戻す前に呼ぶ（同期で効かせる）', r.captureLog.length === 1 && r.captureLog[0].op === 'suspend' && r.captureLog[0].id === 'one' && r.captureLog[0].reveals === 0, JSON.stringify(r.captureLog));
      t.ok('見ているタブだけを人の操作にし、時間では戻さない（pinned）', r.holder('one', tabId) === 'human' && r.pinned('one', tabId) && r.holder('one', otherId) === 'ai');

      t.ok('会話の一時停止はしない（エージェントの接続は切らない）', a.ws.readyState === 1 && r.relay.state('one').paused === null);
      const onHeld = await a.cmd('Runtime.evaluate', { expression: '1' }, sid);
      t.ok('人の操作のタブへの操作は HUMAN_MESSAGE で断る', onHeld.error?.message === HUMAN_MESSAGE, JSON.stringify(onHeld.error));
      t.ok('ほかのタブとブラウザーの単位のコマンドは通る（エージェントはほかのタブで続けられる）', !(await a.cmd('Runtime.evaluate', { expression: '1' }, sidOther)).error && !(await a.cmd('Browser.getVersion')).error);
      t.ok('人の操作のタブでの断りでは押した位置の便りを出さない', r.taps.length === 1 && !(await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, sid)).result && r.taps.length === 1);
      const reveals = r.os.calls('reveal').length;
      t.ok('二重に押しても窓は 1 回だけ戻す', (await r.control.takeOver('one')).state === 'paused' && r.os.calls('reveal').length === reveals);

      r.advance(72_000);
      const back = await r.control.resume('one');
      t.ok('任せる → 窓を画面の外の見えない窓に戻す', concealedOk(hw()), JSON.stringify(hw()));
      t.ok('任せたら resume を 1 回（suspend と対）', r.captureLog.map(x => x.op).join() === 'suspend,resume' && r.captureLog[1].id === 'one', JSON.stringify(r.captureLog));
      t.ok('paused が解ける（ターンの間なので running）', back.state === 'running' && last(r) === 'running' && back.by === null, JSON.stringify(back));
      t.ok('人が前面に置いていた窓が前面のままにならない（Pleiad の窓へ返す）', r.os.getForeground() === 'pleiad-window', r.os.getForeground());
      t.ok('タブを AI に戻す', r.holder('one', tabId) === 'ai');
      const first = await a.cmd('Runtime.evaluate', { expression: '1' }, sid);
      t.ok('戻した直後のそのタブへの最初の操作は 1 回だけ撮り直しを求め、次は通る', first.error?.message === RESNAPSHOT_MESSAGE && !(await a.cmd('Runtime.evaluate', { expression: '1' }, sid)).error, JSON.stringify(first.error));
      t.ok('任せるを重ねても状態は変わらない', (await r.control.resume('one')).state === 'running' && r.captureLog.length === 2);
      t.ok('状態の便りの並び', r.events.map(e => e.state).join() === 'running,paused,running', r.events.map(e => e.state).join());
    } finally { await r.stop(); }
  }

  // ===== 3. 窓が無いとき・窓が複数のとき =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const none = await r.control.takeOver('nobody').then(() => null, error => error);
      t.ok('会話が中継に無ければ NO_WINDOW', none?.code === 'NO_WINDOW');
      const a = await r.agent('one');
      const early = await r.control.takeOver('one').then(() => null, error => error);
      t.ok('窓がまだ無い会話は NO_WINDOW。撮影も断たず、paused を残さない', early?.code === 'NO_WINDOW' && r.captureLog.length === 0 && r.control.state('one').state === 'running' && !(await a.cmd('Browser.getVersion')).error, JSON.stringify(r.captureLog));
      const one = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const two = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const w1 = tabInfo(r, one.result.targetId).windowId, w2 = tabInfo(r, two.result.targetId).windowId;
      const sid1 = (await a.cmd('Target.attachToTarget', { targetId: one.result.targetId, flatten: true })).result.sessionId;
      const sid2 = (await a.cmd('Target.attachToTarget', { targetId: two.result.targetId, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid1);
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid2);   // 最後に操作したのは 2 つ目のタブ
      await r.control.takeOver('one');
      t.ok('会話の窓を全部見える形に戻す', visibleOk(hwndOf(r, w1)) && visibleOk(hwndOf(r, w2)));
      t.ok('前に出すのはエージェントが最後に操作したタブの窓（最初の窓ではない）', r.os.getForeground() === hwndOf(r, w2).id && r.os.getForeground() !== hwndOf(r, w1).id, `${r.os.getForeground()} / ${hwndOf(r, w2).id}`);
      t.ok('人の操作にするのはそのタブだけ', r.holder('one', two.result.targetId) === 'human' && r.holder('one', one.result.targetId) === 'ai');
      await r.control.resume('one');
      t.ok('任せると全部隠れる', concealedOk(hwndOf(r, w1)) && concealedOk(hwndOf(r, w2)));
    } finally { await r.stop(); }
  }

  // ===== 4. 隠す層が使えない（窓の ref が無い）→ PC で操作できない =====
  {
    const r = await rig();
    try {
      r.os.opts.hideNonce = true; r.os.opts.hideBounds = true;
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const failed = await r.control.takeOver('one').then(() => null, error => error);
      t.ok('窓を見つけられていなければ（隠していない）PC で操作できない。paused・人の操作・撮影の断りを残さない', failed?.code === 'NO_WINDOW' && r.control.state('one').state === 'running' && r.holder('one', created.result.targetId) === 'ai' && r.captureLog.length === 0 && !(await a.cmd('Browser.getVersion')).error);
    } finally { await r.stop(); }
  }

  // ===== 4b. 隠す層の無い OS（macOS。ADR 0219）: 見えたままの窓を前に出し、任せても隠さずに解く =====
  {
    const r = await rig({ features: { dialog: true, raise: true, launch: true, conceal: false, watch: false, bounds: true } });
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const hw = () => hwndOf(r, tabInfo(r, created.result.targetId).windowId);
      t.ok('macOS: 窓は隠さずに開き、窓を覚える', !created.error && hw()?.concealed !== true && r.os.calls('conceal').length === 0 && r.scope.windows('one').some(w => w.ref), JSON.stringify(r.scope.windows('one')));
      const taken = await r.control.takeOver('one');
      t.ok('macOS: PC で操作できる（NO_WINDOW にならない）。窓を前に出し、エージェントの接続は切らない', taken.state === 'paused' && r.os.getForeground() === hw().id && a.ws.readyState === 1, JSON.stringify(taken));
      const back = await r.control.resume('one');
      t.ok('macOS: 任せると隠さずに解ける（隠せなかった扱いで paused に残らない）', back.state === 'running' && back.error == null && r.os.calls('conceal').length === 0 && r.holder('one', created.result.targetId) === 'ai', JSON.stringify(back));
    } finally { await r.stop(); }
  }

  // ===== 5. PC で操作している間に窓を × で閉じられた → paused のまま。任せるで解け、次に使うとき黙って開き直す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const windowId = tabInfo(r, created.result.targetId).windowId;
      await r.control.takeOver('one');
      r.fake.closeWindow(windowId);
      await until(() => r.scope.windows('one').length === 0);
      t.ok('窓を閉じられても paused のまま（任せるまで映像の幕を残す）', r.control.state('one').state === 'paused' && suspendedNow(r));
      const back = await r.control.resume('one');
      t.ok('任せるで解ける（隠す窓は無い）', back.state === 'running' && !suspendedNow(r), JSON.stringify(back));
      const again = await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('次に使うときに黙って開き直し、その窓も隠す', !again.error && concealedOk(hwndOf(r, tabInfo(r, again.result.targetId)?.windowId)));
    } finally { await r.stop(); }
  }

  // ===== 6. PC で操作している間の popup は動かさず、任せるときに探して隠す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      r.fake.setPage('https://open.example/', { title: 'Opener', elements: [{ role: 'link', name: 'popup', open: { url: 'https://open.example/popup', popup: true } }] });
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'https://open.example/' });
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      await r.control.takeOver('one');
      r.fake.windowOpen(created.result.targetId, 'https://open.example/popup', { popup: true });   // 人が開いたページが window.open した
      const popup = await until(() => r.fake.targets().some(x => x.url === 'https://open.example/popup'))
        ? r.fake.targets().find(x => x.url === 'https://open.example/popup') : null;
      await sleep(80);
      t.ok('PC で操作している間は、新しい窓を画面の外へ動かさない（人の窓を奪わない）', !!popup && r.fake.windowBounds(popup.windowId).left < 1000, JSON.stringify(popup && r.fake.windowBounds(popup.windowId)));
      await r.control.resume('one');
      t.ok('任せるときに探して隠す', concealedOk(hwndOf(r, popup.windowId)), JSON.stringify(hwndOf(r, popup.windowId)));
    } finally { await r.stop(); }
  }

  // ===== 7. PC で操作している間に止める → 窓を戻してから止める =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const hw = () => hwndOf(r, tabInfo(r, created.result.targetId).windowId);
      await r.control.takeOver('one');
      const stopped = await r.control.stop('one');
      t.ok('止めたら resume で対にする', r.captureLog.map(x => x.op).join() === 'suspend,resume', JSON.stringify(r.captureLog));
      t.ok('止める → 窓は隠れて、タブは AI に戻り、stopped', stopped.state === 'stopped' && concealedOk(hw()) && r.holder('one', created.result.targetId) === 'ai' && (await a.closed).code === 1000);
    } finally { await r.stop(); }
  }

  // ===== 8. Chrome が閉じた → PC で操作するも解く =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.control.takeOver('one');
      for (const h of r.os.hwnds()) r.os.killWindow(h.id);
      await r.chrome.restart();
      await a.closed;
      t.ok('Chrome が閉じたら paused を解く', await until(() => r.control.state('one').state !== 'paused'), JSON.stringify(r.control.state('one')));
      t.ok('窓の「見える形」の印も捨てる（つなぎ直した後の popup を隠せる）', r.scope.isRevealed('one') === false);
      t.ok('Chrome が閉じて paused が解けたら resume で対にする', r.captureLog.map(x => x.op).join() === 'suspend,resume', JSON.stringify(r.captureLog));
      const b = await r.agent('one');
      t.ok('つなぎ直せばコマンドが通る', !(await b.cmd('Browser.getVersion')).error);
    } finally { await r.stop(); }
  }

  // ===== 8b. PC で操作している間に会話を消す・id が替わる → 撮影の断りの対が崩れない =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('new:abc');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.control.takeOver('new:abc');
      r.relay.rebind('new:abc', 'real');
      t.ok('id が替わっても paused は新しい id に付き、新しい id へ suspend を出し直す', r.control.state('real').state === 'paused' && r.captureLog.some(x => x.op === 'suspend' && x.id === 'real'), JSON.stringify(r.captureLog));
      t.ok('古い id の分は resume で片付く', r.captureLog.some(x => x.op === 'resume' && x.id === 'new:abc'), JSON.stringify(r.captureLog));
      t.ok('古い id にも待機中（idle）の便りを配る（古い id で配ったピルを片付けさせる）', r.events.some(e => e.sessionId === 'new:abc' && e.state === 'idle') && r.control.state('new:abc').state === 'idle', JSON.stringify(r.events));
      t.ok('新しい id で任せられる', (await r.control.resume('real')).state !== 'paused');
      await r.control.takeOver('real');
      r.relay.forget('real');
      const open = new Set();
      for (const x of r.captureLog) { if (x.op === 'suspend') open.add(x.id); else open.delete(x.id); }
      t.ok('会話を消したら、断ったままの会話は残らない（suspend と resume が対になる）', open.size === 0 && r.captureLog.at(-1).op === 'resume' && r.control.state('real').state === 'idle', JSON.stringify(r.captureLog));
    } finally { await r.stop(); }
  }

  // ===== 9. 操作は順に流す（同時に PC で操作する・任せるが窓を二重に動かさない） =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      const [x, y] = await Promise.all([r.control.takeOver('one'), r.control.takeOver('one')]);
      t.ok('同時に 2 回押しても、窓を戻すのは 1 回', x.state === 'paused' && y.state === 'paused' && r.os.calls('reveal').length === 1);
      await Promise.all([r.control.resume('one'), r.control.resume('one')]);
      t.ok('同時に 2 回任せても、撮影の断りの対は 1 つ', r.captureLog.map(c => c.op).join() === 'suspend,resume' && r.control.state('one').state === 'running', JSON.stringify(r.captureLog));
    } finally { await r.stop(); }
  }

  // ===== 10. 再接続した画面へ配る今の状態（snapshot）=====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      await r.agent('two');
      r.relay.endTurn('two');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.control.takeOver('one');
      t.ok('待機中でない会話だけ（paused と running）', r.control.snapshot().map(s => `${s.sessionId}:${s.state}:${s.by}`).sort().join() === 'one:paused:pc', JSON.stringify(r.control.snapshot()));
    } finally { await r.stop(); }
  }

  // ===== 12. 人の操作のタブでの人の移動を、サイトの利用の確認にかけない =====
  {
    const asked = [];
    const r = await rig({ authorize: async request => { asked.push(request.url); return { allow: false, message: 'DENIED-BY-TEST' }; } });
    try {
      r.relay.setConfirm(true);
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const agentMove = await a.cmd('Page.navigate', { url: 'https://agent.example/' }, sid);
      t.ok('（比べ）エージェントの移動は確認にかかり、断られる', asked.length === 1 && agentMove.error?.message === 'DENIED-BY-TEST', JSON.stringify(agentMove.error));
      await r.control.takeOver('one');
      await r.fake.navigateUser(tabId, 'https://auth.example/login');
      await sleep(100);
      t.ok('PC で操作中のタブの人の移動（外部の認証サイトへ）は確認にかけない・白紙に戻さない', asked.length === 1 && tabInfo(r, tabId).url === 'https://auth.example/login', `${asked.join()} / ${tabInfo(r, tabId)?.url}`);
      r.fake.windowOpen(tabId, 'https://auth.example/popup');   // 人のページが開いたログインのポップアップ
      await sleep(250);
      const popup = r.fake.targets().find(x => x.url === 'https://auth.example/popup');
      t.ok('人の操作のタブが開いたタブ・ポップアップは確認にかけない・閉じない', asked.length === 1 && !!popup, `${asked.join()}`);
      await r.control.resume('one');
      const resnap = await a.cmd('Page.navigate', { url: 'https://agent2.example/' }, sid);
      const after = await a.cmd('Page.navigate', { url: 'https://agent2.example/' }, sid);
      t.ok('任せたあとのエージェントの移動は、撮り直しの 1 回の断りの後、また確認にかかる', resnap.error?.message === RESNAPSHOT_MESSAGE && asked.length === 2 && after.error?.message === 'DENIED-BY-TEST', `${asked.join()} / ${resnap.error?.message}`);
    } finally { await r.stop(); }
  }

  // ===== 14. 隠すのに失敗したら、paused を解かない（失敗を状態で返す） =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const hw = () => hwndOf(r, tabInfo(r, tabId).windowId);
      await r.control.takeOver('one');
      r.os.opts.concealFails = true;
      const failed = await r.control.resume('one');
      t.ok('隠せなかったら paused のまま、理由 conceal-failed を状態に載せる', failed.state === 'paused' && failed.error === 'conceal-failed' && r.control.state('one').error === 'conceal-failed', JSON.stringify(failed));
      t.ok('状態の便りで画面へ返す（次の便りでも消えない）', r.events.at(-1).state === 'paused' && r.events.at(-1).error === 'conceal-failed');
      t.ok('窓は見えたまま・映像は断ったまま', visibleOk(hw()) && r.captureLog.map(x => x.op).join() === 'suspend');
      t.ok('そのタブは人の操作のまま（エージェントの操作は断る）', r.holder('one', tabId) === 'human' && (await a.cmd('Runtime.evaluate', { expression: '1' }, sid)).error?.message === HUMAN_MESSAGE);
      const stop = await r.control.stop('one');
      t.ok('止めるも、隠せないうちは止めない（paused のまま）', stop.state === 'paused' && stop.error === 'conceal-failed' && a.ws.readyState === 1);
      r.relay.endTurn('one');
      t.ok('ターンが終わっても conceal-failed は残る（ほかの状態の変化で消さない）', r.control.state('one').error === 'conceal-failed' && r.events.at(-1).error === 'conceal-failed', JSON.stringify(r.events.at(-1)));
      await r.relay.endpoint('one');
      r.os.opts.concealFails = false;
      const ok = await r.control.resume('one');
      t.ok('もう一度「任せる」で隠せれば解ける。error も消える', ok.state === 'running' && ok.error === null && concealedOk(hw()) && r.holder('one', tabId) === 'ai' && r.captureLog.map(x => x.op).join() === 'suspend,resume', JSON.stringify(ok));
    } finally { await r.stop(); }
  }

  // ===== 15. リモートの端末から押す: 窓を戻す画面は、その時の前面でなく Pleiad の窓のある画面。先に撮影を断ってから引く =====
  {
    const r = await rig();
    try {
      r.os.setForeground('someone-elses-app');   // リモートから押したので、PC の前面は別のアプリ
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      const lookupsBefore = r.os.calls('appWindow').length + r.os.calls('foreground').length;
      await r.control.takeOver('one');
      const reveal = r.os.calls('reveal').at(-1);
      t.ok('窓を戻す画面（near）は Pleiad の窓。その時の前面ではない', reveal?.near === 'pleiad-window', JSON.stringify(reveal));
      t.ok('窓は PC で前に出る（リモートからでも PC の前面を取る）', r.os.getForeground() !== 'someone-elses-app');
      t.ok('人の操作にして撮影を断つのが先で、窓の手がかりを引くのはそのあと', r.captureLog[0].op === 'suspend' && r.captureLog[0].lookups === lookupsBefore, JSON.stringify(r.captureLog[0]));
    } finally { await r.stop(); }
    const r2 = await rig();
    try {
      r2.os.opts.noAppWindow = true;
      r2.os.setForeground('someone-elses-app');
      const b = await r2.agent('one');
      await b.cmd('Target.createTarget', { url: 'about:blank' });
      await r2.control.takeOver('one');
      t.ok('Pleiad の窓が引けなければ、その時の前面で代える', r2.os.calls('reveal').at(-1)?.near === 'someone-elses-app');
    } finally { await r2.stop(); }
  }

  // ===== 17. PC で操作している間に人がタブを引き離して作った窓も、任せるときに隠す。タブの無くなった窓の記録は捨てる =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const oldWindow = tabInfo(r, tabId).windowId;
      await r.control.takeOver('one');
      const newWindow = r.fake.detachTab(tabId);   // 人がタブを引き離して新しい窓にした
      r.os.killWindow(hwndOf(r, oldWindow).id);
      const back = await r.control.resume('one');
      t.ok('任せる: 新しい窓も隠れる（人が作った窓を見えたまま残さない）', back.state === 'running' && concealedOk(hwndOf(r, newWindow)), JSON.stringify(hwndOf(r, newWindow)));
      t.ok('元の窓（もう無い）の記録は捨て、新しい窓が会話の窓になる', JSON.stringify(r.scope.windows('one').map(w => w.windowId)) === JSON.stringify([newWindow]), JSON.stringify(r.scope.windows('one')));
    } finally { await r.stop(); }
  }

  // ===== 18. 前の版から持ち越した一時停止（中継の paused。ADR 0167 の carry）: paused として見せ、任せるで窓を隠してから解く =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const hw = () => hwndOf(r, tabInfo(r, created.result.targetId).windowId);
      r.relay.pause('one', 2_000_000);   // 持ち越しと同じ形の一時停止を作る（本番では restore だけが入れる）
      t.ok('持ち越した一時停止は paused（by は pc、since はその時刻）・映像を断つ', r.control.state('one').state === 'paused' && r.control.state('one').by === 'pc' && r.control.state('one').since === 2_000_000 && suspendedNow(r), JSON.stringify(r.control.state('one')));
      const b = await r.agent('one');
      t.ok('持ち越した一時停止の間はエージェントのコマンドを全部 PAUSED_MESSAGE で断る', (await b.cmd('Browser.getVersion')).error?.message === PAUSED_MESSAGE);
      const pressed = await r.control.takeOver('one');
      t.ok('その間に PC で操作するを押しても今の状態を返すだけ（窓を出さない）', pressed.state === 'paused' && r.os.calls('reveal').length === 0);
      r.os.opts.concealFails = true;
      const stuck = await r.control.resume('one');
      t.ok('窓を隠せなければ解かない（conceal-failed）', stuck.state === 'paused' && stuck.error === 'conceal-failed' && r.relay.state('one').paused !== null);
      r.os.opts.concealFails = false;
      const back = await r.control.resume('one');
      t.ok('任せるで窓を隠してから解く（撮影の断りも解く）', back.state === 'running' && back.error === null && r.relay.state('one').paused === null && concealedOk(hw()) && !suspendedNow(r), JSON.stringify(back));
      const c = await r.agent('one');
      t.ok('解いた後はコマンドが通る', !(await c.cmd('Browser.getVersion')).error);
    } finally { await r.stop(); }
  }
}
