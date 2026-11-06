import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs, fakeMainPort } from '../lib/fake-chrome-os.mjs';
import { startHolder } from '../lib/holder-harness.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay, PAUSED_MESSAGE } from '../../core/chrome/relay.mjs';
import { HUMAN_MESSAGE, RESNAPSHOT_MESSAGE } from '../../core/chrome/tab-holder.mjs';
import { createChromeWindows, WINDOW_DIP } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';
import { openChromeLink } from '../../core/chrome/link.mjs';
import { parentPortChromeOs } from '../../core/chrome/os.mjs';

export const name = 'chrome-persist';
export const title = '通常再起動を越えるエージェントのブラウザー: 中継の端点（同じポート・同じ鍵）・隠した窓の復元・付け直せない窓の処理・main が居ない間の待ち（本物の保持役と接続の子・偽の Chrome と偽の OS の層。ADR 0167）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (cond, ms = 5000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) throw new Error(`timeout: ${what || cond.toString().slice(0, 80)}`);
    await sleep(10);
  }
};

/** エージェントの側（agent-browser の代わり） */
function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
    });
    ws.once('open', () => resolve({
      ws,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', code => done(code))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

export default async function (t) {
  const holder = await startHolder();
  const cleanups = [];
  const clearChildren = async () => {
    for (let i = 0; i < 30; i++) {
      const { client } = await holder.connect();
      const children = client.welcome?.children ?? [];
      let alive = false;
      for (const child of children) {
        if (!child.alive) { client.release(child.id); continue; }
        alive = true;
        await client.attach(child.id).catch(() => null);
        client.kill(child.id, { tree: true });
      }
      client.close();
      if (!alive) return;
      await sleep(150);
    }
    throw new Error('connection child did not go away');
  };
  /** server.mjs の起動と同じ順: 接続の子 → 中継の restore → 接続の adopt → 以後の変化を預ける → 層が使えれば readopt */
  const newServer = async (chrome, os, { timing, carryExtra, relayOptions, readoptOnReady = false, manual = false } = {}) => {
    const { client } = await holder.connect();
    const link = await openChromeLink({ holder: client, runtimeRoot: holder.root, runtimeKey: 'persist' });
    const locate = { browser: 'chrome', userDataDir: chrome.userDataDir };
    const conn = createChromeConnection({ locate, os, link, pollMs: 20 });
    const logs = [];
    const relay = createChromeRelay({ connection: conn, os, locate, scope: createChromeWindows({ os, locate, log: line => logs.push(line), ...(timing ? { timing } : {}) }),
      authorize: async () => ({ allow: true }), deniedMessage: () => 'DENIED', log: line => logs.push(line), ...(carryExtra ? { carryExtra } : {}), ...(relayOptions ?? {}) });
    await relay.restore(link.welcome.carry, { staleSessions: link.welcome.sessions });
    const adopted = await conn.adopt();
    // control（server.mjs と同じく、restore の後に作る。一時停止・PC で操作するのまま持ち越した会話の撮影を断つ）
    const captureLog = [];
    const control = createChromeControl({ relay, os, capture: { suspend: id => captureLog.push(`suspend:${id}`), resume: id => captureLog.push(`resume:${id}`) }, log: line => logs.push(line) });
    relay.onCarry(carry => link.setCarry(carry));
    if (manual) return { link, conn, relay, control, captureLog, logs, adopted };   // rejoin・readopt は試験が呼ぶ
    await relay.rejoin();
    // server.mjs と同じく、層が（遅れて・入れ替わって）戻るたびに引き継ぎ直す
    if (readoptOnReady) os.onReady(() => { relay.readopt().catch(() => {}); });
    if (os.capabilities().supported) await relay.readopt();
    return { link, conn, relay, control, captureLog, logs, adopted };
  };
  /** 通常のサーバー終了: carry を flush してから保持役の接続の子とのパイプを閉じる */
  const leave = async s => {
    await s.link.flush();
    s.relay.releaseForRestart();
    s.link.socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
    cleanups.unshift(async () => { s.relay.close(); await s.conn.close(); });
  };
  const tabsIn = (chrome, windowId) => chrome.browser.targets().filter(x => x.type === 'page' && x.windowId === windowId);

  try {
    // ===== 1. 更新を越える: 同じポート・同じ鍵の端点・隠した窓は閉じない・窓は新しいサーバーの範囲に戻る =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-1');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const created = await ag.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      const carried = a.relay.snapshot();
      t.ok('窓を開くと隠した窓の印（token）が carry に載る', tabId && carried.windows.length === 1 && carried.windows[0].windows[0].windowId === windowId && /^fake:/.test(carried.windows[0].windows[0].token) && carried.port === a.relay.port, JSON.stringify(carried));
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      const closeCode = await Promise.race([ag.closed, sleep(3000).then(() => 'timeout')]);
      t.ok('A の通常終了でエージェントの接続が切れる', closeCode !== 'timeout' && closeCode !== 1000, String(closeCode));
      t.ok('A が終了しても、隠した窓とタブは保持役に残る', os.hwnds().some(h => h.agent && h.concealed && !h.closed) && tabsIn(chrome, windowId).length === 1 && os.calls('closeAgent').length === 0);

      const b = await newServer(chrome, os);
      t.ok('新しいサーバー: 接続の子から接続を引き継ぐ（確認なし）', b.adopted === true && b.conn.state().state === 'connected', JSON.stringify(b.conn.state()));
      t.ok('新しいサーバー: 端点は同じポート・同じ鍵（エージェントの接続先が更新を越えて同じ）', await b.relay.endpoint('conv-1') === url && b.relay.port === carried.port, `${await b.relay.endpoint('conv-1')} ${url}`);
      t.ok('新しいサーバー: 隠した窓の印を層が引き継ぎ、窓は閉じない', os.calls('adoptAgent').length >= 1 && os.hwnds().some(h => h.agent && h.concealed && !h.closed) && tabsIn(chrome, windowId).length === 1);
      const ag2 = await agent(url);
      await ag2.cmd('Target.setDiscoverTargets', { discover: true });
      await until(async () => (await ag2.cmd('Target.getTargets')).result.targetInfos.length === 1, 3000, 'restored tab in scope');
      const targets = (await ag2.cmd('Target.getTargets')).result.targetInfos;
      t.ok('つなぎ直したエージェントには、持ち越した窓のタブが見える（会話の範囲に戻っている）', targets.length === 1 && targets[0].targetId === tabId, JSON.stringify(targets));
      ag2.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 1a. 更新の後、エージェントがつながる前から、持ち越した窓のタブは会話の範囲に戻っている（Chrome は発見中の接続へ targetCreated を送り直さない）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-1a');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      // ターンの外（turnLive が false）: 上りがつながっていなければ、エージェントは「ターンの外では確認を出せない」と断られる
      const b = await newServer(chrome, os, { relayOptions: { turnLive: () => false } });
      await until(() => b.relay.view.tabs('conv-1a').length === 1, 3000, 'carried tab back in scope before any agent connects');
      t.ok('新しいサーバー: エージェントがつながる前に、持ち越した窓のタブが会話の範囲（映像の一覧）に戻っている', b.relay.view.sessions().includes('conv-1a') && b.relay.view.tabs('conv-1a')[0].targetId === tabId && b.relay.view.tabs('conv-1a')[0].windowId === windowId, JSON.stringify(b.relay.view.tabs('conv-1a')));
      const ag2 = await agent(url);
      const listed = await ag2.cmd('Target.getTargets');
      t.ok('ターンの外でつないだエージェントも、断られずに持ち越したタブが見える（Chrome とはつながっている）', listed.error === undefined && listed.result?.targetInfos.length === 1 && listed.result.targetInfos[0].targetId === tabId, JSON.stringify(listed));
      ag.close(); ag2.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 1b. 最大化のまま開いた最初の窓（chrome.exe の窓）: 大きさを決めて通常に戻っても隠した位置のまま。更新を越えて引き継げる =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      chrome.browser.launchMaximized(true);
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-1b'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const first = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === first)?.windowId;
      const hw = os.hwnds().find(h => h.windowId === windowId);
      t.ok('最大化で開いた最初の窓は、大きさを決めて通常に戻っても、隠した位置（画面の外）のまま', chrome.browser.windowBounds(windowId)?.windowState === 'normal' && hw?.concealed === true && hw.rect.left === 6000, JSON.stringify(hw));
      // 実物の Chrome は、最大化の窓への大きさの依頼では戻すだけで大きさを当てない。先に通常へ戻し、戻ってから大きさを送る
      const sets = chrome.calls.filter(c => c.method === 'Browser.setWindowBounds' && c.params.windowId === windowId).map(c => c.params.bounds);
      t.ok('最大化の窓は、先に通常へ戻して（windowState: normal だけ）から大きさを送る。大きさが WINDOW_DIP になる',
        sets.length === 2 && JSON.stringify(sets[0]) === JSON.stringify({ windowState: 'normal' }) && sets[1].width === WINDOW_DIP.width && sets[1].height === WINDOW_DIP.height && sets[1].windowState === undefined
          && chrome.browser.windowBounds(windowId)?.width === WINDOW_DIP.width && chrome.browser.windowBounds(windowId)?.height === WINDOW_DIP.height, JSON.stringify({ sets, bounds: chrome.browser.windowBounds(windowId) }));
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      const b = await newServer(chrome, os);
      t.ok('更新を越えた先でも、その最初の窓を引き継げる（引き継げない窓として閉じない）', !b.logs.some(line => line.includes('could not be taken over')) && tabsIn(chrome, windowId).length === 1
        && b.relay.snapshot().windows.length === 1 && os.hwnds().some(h => h.windowId === windowId && h.agent && h.concealed && !h.closed), JSON.stringify({ logs: b.logs, hwnds: os.hwnds() }));
      ag.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 1c. 最大化で開いた最初の窓が、隠し直した後に遅れて画面の中へ動いた（透明のまま）: 更新の先で引き継いで隠し直す（閉じない）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      chrome.browser.launchMaximized(true);
      const os = fakeChromeOs({ chrome });
      os.opts.restoreMoveMs = 150;   // 通常へ戻した後、窓が画面の中へ動くのが遅れる（隠し直した後に効く）
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-1c'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const first = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === first)?.windowId;
      const hwOf = () => os.hwnds().find(h => h.windowId === windowId);
      await until(() => hwOf()?.rect.left === 10, 3000, 'restored window moved onto a screen');
      t.ok('（前提）隠した窓が、遅れて画面の中へ動いた（スタイルは隠した姿・透明のまま）', hwOf().alpha === 0 && hwOf().ex.transparent && !hwOf().ex.appwindow, JSON.stringify(hwOf()));
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      const b = await newServer(chrome, os);
      t.ok('画面の中で透明のままの窓も、更新の先で引き継ぐ（引き継げない窓として閉じない）', !b.logs.some(line => line.includes('could not be taken over')) && tabsIn(chrome, windowId).length === 1
        && b.relay.snapshot().windows.length === 1 && hwOf()?.agent && hwOf()?.concealed && !hwOf()?.closed, JSON.stringify({ logs: b.logs, hw: hwOf() }));
      t.ok('引き継いだ窓は、画面の外へ隠し直す', hwOf()?.rect.left === 6000 && os.calls('concealOnAdopt').length === 1, JSON.stringify(hwOf()));
      ag.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 2. 層が窓を引き継げなかったとき: 記録を捨て、その窓のタブを CDP で閉じる =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-2'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await leave(a);
      os.opts.adoptFails = true;
      const b = await newServer(chrome, os);
      await until(() => tabsIn(chrome, windowId).length === 0, 3000, 'tab of the lost window closed');
      t.ok('引き継げなかった窓: そのタブは CDP で閉じる（見えない窓を残さない）', tabsIn(chrome, windowId).length === 0 && b.relay.snapshot().windows.length === 0);
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 3. main が居ない間（層が pending）: 窓を開く依頼は待ち、戻ったら開く。戻らなければ「更新中」で失敗 =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os, { timing: { readyWaitMs: 5000 } });
      const ag = await agent(await a.relay.endpoint('conv-3'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      os.setPending(true);
      const pendingCreate = ag.cmd('Target.createTarget', { url: 'about:blank' });
      await sleep(150);
      const early = await Promise.race([pendingCreate.then(() => 'done'), sleep(100).then(() => 'waiting')]);
      os.setPending(false);
      const reply = await pendingCreate;
      t.ok('main が居ない間: 窓を開く依頼は待ち、層が戻ったら開く', early === 'waiting' && !!reply.result?.targetId, JSON.stringify(reply));
      ag.close();
      await a.relay.close(); await a.conn.close(); await a.link.quit();

      await clearChildren();
      const chrome2 = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome2.stop());
      const os2 = fakeChromeOs({ chrome: chrome2 });
      const c = await newServer(chrome2, os2, { timing: { readyWaitMs: 150 } });
      const ag2 = await agent(await c.relay.endpoint('conv-3b'));
      await ag2.cmd('Target.setDiscoverTargets', { discover: true });
      os2.setPending(true);
      const failed = await ag2.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('main が戻らないとき: 「更新中」で失敗し、窓は作らない', /updating/i.test(failed.error?.message ?? '') && chrome2.browser.targets().filter(x => x.type === 'page').length === 2, JSON.stringify(failed));
      ag2.close();
      await c.relay.close(); await c.conn.close(); await c.link.quit();
    }

    // ===== 4. main が居ない間に終わるときは、隠した窓のタブを CDP で閉じる =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-4'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      os.setPending(true);
      a.relay.close();
      await until(() => tabsIn(chrome, windowId).length === 0, 3000, 'tab closed by CDP');
      t.ok('層が居ないまま終わる: 隠した窓のタブを CDP で閉じる', tabsIn(chrome, windowId).length === 0);
      await a.conn.close(); await a.link.quit();
    }

    // ===== 4b. サーバーが居ない間に Chrome との接続が切れた: 子の預かり物は残り、次のサーバーが隠した窓を閉じる（誰にも戻せない窓を残さない）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-4b'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      await ag.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('前提: 隠した窓がある', os.hwnds().filter(h => h.agent && h.concealed && !h.closed).length === 1);
      await leave(a);
      chrome.dropConnections();   // 出ていった後、次のサーバーが来る前に、Chrome との接続が切れた
      await sleep(300);
      const b = await newServer(chrome, os);
      t.ok('新しいサーバー: 接続は切れたまま（拾えない）', b.adopted === false && b.conn.state().state !== 'connected', JSON.stringify(b.conn.state()));
      t.ok('新しいサーバー: 預かり物から端点を取り戻す（同じ会話の鍵）', b.relay.snapshot().entries.some(e => e.id === 'conv-4b'));
      t.ok('接続が無いまま層が戻ったら、引き継いだ隠した窓を閉じる（隠れたまま残らない）', os.hwnds().filter(h => h.agent && !h.closed).length === 0 && os.calls('closeAgent').length === 1, JSON.stringify(os.hwnds()));
      t.ok('閉じた窓は carry からも消える', b.relay.snapshot().windows.length === 0, JSON.stringify(b.relay.snapshot().windows));
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 5. 「PC で操作する」のまま更新を越える: 窓は見せたまま・paused（by: pc）に戻り、そのタブはエージェントに触らせない。「任せる」で隠して AI に戻す（ADR 0167・0296）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-5');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await until(() => a.relay.view.current('conv-5') === tabId, 3000, 'current tab');
      const onPc = await a.control.takeOver('conv-5');
      const shown = () => os.hwnds().filter(h => h.agent && !h.concealed && !h.closed);
      t.ok('前提: PC で操作すると窓は見える形になり、carry には見せている窓の印だけが載る（会話の一時停止はしない）',
        onPc.state === 'paused' && onPc.by === 'pc' && shown().length === 1 && !a.relay.snapshot().entries[0].paused && a.relay.snapshot().windows[0].revealed === true, JSON.stringify(a.relay.snapshot()));
      await leave(a);
      ag.close();
      const concealCalls = os.calls('conceal').length;
      const closeCalls = os.calls('closeAgent').length;

      const b = await newServer(chrome, os);
      const state = b.control.state('conv-5');
      t.ok('新しいサーバー: control は「PC で操作する」（paused・by: pc）と見て、撮影を断つ',
        state.state === 'paused' && state.by === 'pc' && b.captureLog.includes('suspend:conv-5') && !b.relay.state('conv-5')?.paused, JSON.stringify([state, b.captureLog]));
      t.ok('新しいサーバー: 人が操作している窓は見える形のまま・隠さない・閉じない（層は revealed で引き継ぐ）',
        shown().length === 1 && os.calls('conceal').length === concealCalls && os.calls('closeAgent').length === closeCalls && tabsIn(chrome, windowId).length === 1
        && os.calls('adoptAgent').at(-1)?.revealed === true, JSON.stringify(os.calls('adoptAgent')));
      t.ok('新しいサーバー: 見せている窓の印も持ち越す（任せるまで popup も隠さない）', b.relay.scope.isRevealed('conv-5') === true);

      // エージェントがつなぎ直しても、人の窓のタブへの操作は断られる
      const ag2 = await agent(url);
      await ag2.cmd('Target.setDiscoverTargets', { discover: true });
      const sid = (await ag2.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      await until(() => b.relay.unify.tabHolder.holder('conv-5', tabId)?.holder === 'human', 3000, 'carried pc holder');
      const held = b.relay.unify.tabHolder.holder('conv-5', tabId);
      const refused = await ag2.cmd('Runtime.evaluate', { expression: '1' }, sid);
      t.ok('更新の後、つなぎ直したエージェントの人の窓のタブへの操作は断られる（PC の持ち手で固定）',
        held.by === 'pc' && held.pinned === true && refused.error?.message === HUMAN_MESSAGE, JSON.stringify([held, refused]));

      // 任せる: 窓は画面の外の見えない窓に戻り、タブは AI に戻る（最初の操作は snapshot の撮り直しを頼む）
      await b.control.resume('conv-5');
      t.ok('更新の後に「任せる」: 窓は隠れ、paused が解け、撮影も戻る',
        b.control.state('conv-5').state !== 'paused' && shown().length === 0 && os.hwnds().some(h => h.agent && h.concealed && !h.closed) && b.captureLog.includes('resume:conv-5') && b.relay.scope.isRevealed('conv-5') === false);
      const first = await ag2.cmd('Runtime.evaluate', { expression: '1' }, sid);
      const second = await ag2.cmd('Runtime.evaluate', { expression: '1' }, sid);
      t.ok('任せた後のエージェントの最初の操作は撮り直しを頼まれ、次から通る', first.error?.message === RESNAPSHOT_MESSAGE && !second.error, JSON.stringify([first, second]));
      ag2.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 5b. 前の版（引き継ぎ＝会話の一時停止の形）から一時停止のまま更新した: 一時停止は解けず、全部断る。「任せる」で隠して解く（ADR 0154・0167）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-5b');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await a.control.takeOver('conv-5b');
      // 前の版の carry の形にする（一時停止の印 at・by を足す）
      const pausedAt = 1_700_000_000_000;
      const carry = a.relay.snapshot();
      carry.entries[0].paused = { at: pausedAt, by: 'pc' };
      a.link.setCarry(carry);
      await leave(a);
      ag.close();
      const shown = () => os.hwnds().filter(h => h.agent && !h.concealed && !h.closed);

      const b = await newServer(chrome, os);
      const paused = b.relay.state('conv-5b')?.paused;
      t.ok('前の版の一時停止: 新しいサーバーでも解けない（始まりの時刻 at と by も同じ）', !!paused && paused.at === pausedAt && paused.by === 'pc', JSON.stringify(paused));
      t.ok('前の版の一時停止: control も paused と見る（撮影を断つ・since）',
        b.control.state('conv-5b').state === 'paused' && b.control.state('conv-5b').since === pausedAt && b.captureLog.includes('suspend:conv-5b'), JSON.stringify([b.control.state('conv-5b'), b.captureLog]));
      t.ok('前の版の一時停止: 窓は見える形のまま', shown().length === 1 && tabsIn(chrome, windowId).length === 1);
      const pagesBefore = chrome.browser.targets().filter(x => x.type === 'page').length;
      b.relay.unify.tabHolder.touch({ sessionId: 'conv-5b', targetId: tabId });   // 一時停止はタブの持ち手より先に断る
      const ag2 = await agent(url);
      const replies = [];
      replies.push(await ag2.cmd('Target.getTargets'));
      replies.push(await ag2.cmd('Target.setDiscoverTargets', { discover: true }));
      replies.push(await ag2.cmd('Target.createTarget', { url: 'about:blank' }));
      replies.push(await ag2.cmd('Target.attachToTarget', { targetId: tabId, flatten: true }));
      t.ok('前の版の一時停止: つなぎ直したエージェントのコマンドは全部 PAUSED で断られる（人の窓へ通らない）',
        replies.every(r => r.error?.message === PAUSED_MESSAGE) && tabsIn(chrome, windowId).length === 1 && chrome.browser.targets().filter(x => x.type === 'page').length === pagesBefore, JSON.stringify(replies));
      const revealsBefore = os.calls('reveal').length;
      const pressed = await b.control.takeOver('conv-5b');
      t.ok('前の版の一時停止: その間に PC で操作するを押しても今の状態を返すだけ（窓を出し直さない）', pressed.state === 'paused' && os.calls('reveal').length === revealsBefore, JSON.stringify(pressed));
      os.opts.concealFails = true;
      const stuck = await b.control.resume('conv-5b');
      t.ok('前の版の一時停止: 窓を隠せなければ解かない（conceal-failed）', stuck.state === 'paused' && stuck.error === 'conceal-failed' && b.relay.state('conv-5b').paused !== null, JSON.stringify(stuck));
      os.opts.concealFails = false;
      b.relay.unify.tabHolder.forget({ sessionId: 'conv-5b', targetId: tabId });
      await b.control.resume('conv-5b');
      ag2.close();
      const ag3 = await agent(url);
      await ag3.cmd('Target.setDiscoverTargets', { discover: true });
      await until(async () => (await ag3.cmd('Target.getTargets')).result?.targetInfos?.length === 1, 3000, 'resumed tab in scope');
      t.ok('前の版の一時停止に「任せる」: 窓は隠れ、一時停止が解け、撮影も戻り、エージェントのコマンドが通る',
        b.control.state('conv-5b').state !== 'paused' && !b.relay.state('conv-5b').paused && shown().length === 0 && b.captureLog.includes('resume:conv-5b') && b.relay.scope.isRevealed('conv-5b') === false);
      ag3.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 7. 「この端末で操作する」の間に更新: 会話の一時停止は無いので carry に載らず、窓も見せない。openForConversation は新しい待ち受けでも動く =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-7');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await until(() => a.relay.view.current('conv-7') === tabId, 3000, 'current tab');
      const took = await a.control.takeOver('conv-7', { by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('前提: この端末で操作する → 会話は running のまま・そのタブは端末の人の操作・窓は見せない',
        took.state !== 'paused' && took.by === null && a.relay.unify.tabHolder.holder('conv-7', tabId)?.by === 'device' && os.hwnds().filter(h => h.agent && !h.concealed && !h.closed).length === 0, JSON.stringify(took));
      const entry = a.relay.snapshot().entries.find(e => e.id === 'conv-7');
      t.ok('carry には一時停止も見せている窓の印も載らない', entry && !entry.paused && !a.relay.snapshot().windows.some(w => w.revealed), JSON.stringify(entry));
      await leave(a);
      ag.close();

      const b = await newServer(chrome, os);
      const state = b.control.state('conv-7');
      t.ok('新しいサーバー: paused にしない・撮影も断たない', state.state !== 'paused' && !b.captureLog.includes('suspend:conv-7'), JSON.stringify([state, b.captureLog]));

      // openForConversation: 同じポート・同じ鍵の新しい待ち受けで、新しい会話の窓を開く
      const port = b.relay.snapshot().port;
      const opened = await b.relay.openForConversation('conv-8', 'http://127.0.0.1:1/');
      t.ok('新しい待ち受けでも openForConversation が窓を開く（同じポート）', typeof opened.targetId === 'string' && b.relay.snapshot().port === port && chrome.browser.targets().some(x => x.targetId === opened.targetId), JSON.stringify(opened));
      await leave(b);
      const c = await newServer(chrome, os);
      t.ok('開いた会話も次の更新で引き継がれる（窓の印・同じポート）', c.relay.snapshot().port === port && c.relay.snapshot().windows.some(w => w.id === 'conv-8'), JSON.stringify(c.relay.snapshot()));
      await c.relay.close(); await c.conn.close(); await c.link.quit();
    }

    // ===== 6. 見せている窓を層が引き継げなかったとき: 人の窓のタブは CDP で閉じない（記録だけ捨てる）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-6'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await until(() => a.relay.view.current('conv-6') === tabId, 3000, 'current tab');
      await a.control.takeOver('conv-6');
      await leave(a);
      os.opts.adoptFails = true;
      const b = await newServer(chrome, os);
      await sleep(300);
      t.ok('見せている窓を引き継げなくても、人が操作中の窓のタブは閉じない。「PC で操作する」も解けない', tabsIn(chrome, windowId).length === 1 && b.control.state('conv-6').state === 'paused' && b.control.state('conv-6').by === 'pc', JSON.stringify(b.control.state('conv-6')));
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 8. 中継の外の預かり物（仮の id のプロフィール選択・ログイン待ちの鍵の材料）も、中継の持ち越しに載って戻る =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const extra = { profiles: [{ id: 'turn-1', browser: 'chrome', dir: 'Profile 1' }], logins: [{ sessionId: 'child-1', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example' }] };
      const restored = [];
      const a = await newServer(chrome, os, { carryExtra: { snapshot: () => extra, restore: value => restored.push(value) } });
      a.relay.touch();
      await leave(a);
      const b = await newServer(chrome, os, { carryExtra: { snapshot: () => extra, restore: value => restored.push(value) } });
      t.ok('預かり物は、更新の後の新しいサーバーの restore に同じ形で戻る', restored.length === 1 && JSON.stringify(restored[0]) === JSON.stringify(extra), JSON.stringify(restored));
      // 大きすぎる預かり物は載せず、restore が投げても中継の復元（窓の印・端点）は続く
      const big = { profiles: [{ id: 'x'.repeat(300000), browser: 'chrome', dir: 'Default' }], logins: [] };
      const c = await newServer(chrome, os, { carryExtra: { snapshot: () => big, restore: () => {} } });
      const ag = await agent(await c.relay.endpoint('conv-9'));
      await ag.cmd('Target.createTarget', { url: 'about:blank' });
      c.relay.touch();
      await leave(c);
      const seen = [];
      const d = await newServer(chrome, os, { carryExtra: { snapshot: () => ({}), restore: value => { seen.push(value); } } });
      t.ok('大きすぎる預かり物は載せない（窓の印は残る）', seen.length === 0 && !!d.relay.state('conv-9'), JSON.stringify([seen.length, d.relay.state('conv-9')]));
      d.relay.touch();
      await leave(d);
      const e = await newServer(chrome, os, { carryExtra: { snapshot: () => ({ profiles: [{ id: 'turn-2', browser: 'chrome', dir: 'Default' }] }), restore: () => { throw new Error('boom'); } } });
      e.relay.touch();
      await leave(e);
      const f = await newServer(chrome, os, { carryExtra: { snapshot: () => ({}), restore: () => { throw new Error('boom'); } } });
      t.ok('restore が投げても、中継の復元は続き、ログに残す', !!f.relay.state('conv-9') && f.logs.some(line => /extra carry failed.*boom/.test(line)), JSON.stringify([f.relay.state('conv-9'), f.logs]));
      await f.relay.close(); await f.conn.close(); await f.link.quit();
      await b.relay.close(); await b.conn.close();
    }

    // ===== 10. 更新の先で main の層が遅れて戻る（ADR 0167）。層の口は本物（parentPortChromeOs）、main は偽（fakeMainPort）で、呼び出しは遅れて返る =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });   // main の側の層（本物は desktop/chrome-os/win32.cjs）
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-10');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      const pages = () => chrome.browser.targets().filter(x => x.type === 'page').length;
      const hidden = () => os.hwnds().filter(h => h.agent && !h.closed);
      const pagesBefore = pages();
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);

      // 新しいサーバー: 待ち受けの時点で main の層はまだ付いていない（口は pending）
      const main = fakeMainPort(os, { delayMs: 80 });
      const core = parentPortChromeOs(main.port, { timeoutMs: 5000, readyWaitMs: 150 });
      const b = await newServer(chrome, core, { readoptOnReady: true, relayOptions: { turnLive: () => false } });
      t.ok('前提: サーバーが待ち受けても、層の口は pending のまま', core.capabilities().reason === 'pending' && b.adopted === true);
      t.ok('層が付く前でも、接続は引き継がれ、窓のタブが会話の範囲（映像の一覧）に戻っている',
        b.conn.state().state === 'connected' && b.relay.view.tabs('conv-10').length === 1 && b.relay.view.tabs('conv-10')[0].targetId === tabId, JSON.stringify([b.conn.state(), b.relay.view.tabs('conv-10')]));
      const ag2 = await agent(url);
      const listed = await ag2.cmd('Target.getTargets');
      t.ok('層が付く前、ターンの外でつないだエージェントも、断られずに窓のタブが見える', listed.error === undefined && listed.result?.targetInfos.length === 1 && listed.result.targetInfos[0].targetId === tabId, JSON.stringify(listed));

      // main の層が付く。起動時の ready と chrome-os-ready-request への返事は、同じ main から重なって届く（引き継ぎの呼び出しが処理中に）
      main.ready();
      await until(() => main.sent.some(m => m.action === 'adoptAgent'), 3000, 'adoptAgent sent to main');
      main.ready();
      await sleep(500);
      t.ok('ready が重なっても、処理中の引き継ぎは失敗にならない: 窓は閉じず、タブも残る', tabsIn(chrome, windowId).length === 1 && os.calls('closeAgent').length === 0 && !b.logs.some(line => line.includes('could not be taken over')), JSON.stringify({ logs: b.logs, calls: os.calls('closeAgent').length }));
      t.ok('窓の数が増えない（隠した窓 1・Chrome のタブの数そのまま・記録も 1）', hidden().length === 1 && pages() === pagesBefore && b.relay.snapshot().windows.flatMap(e => e.windows).length === 1 && b.relay.view.tabs('conv-10').length === 1,
        JSON.stringify({ hidden: hidden().length, pages: [pages(), pagesBefore], snapshot: b.relay.snapshot().windows, tabs: b.relay.view.tabs('conv-10') }));

      // 引き継ぎの途中で main が入れ替わった（epoch が替わる）: 呼び出しは聞けなかっただけ。窓は閉じず、新しい main で引き継ぎ直す
      const sentBefore = main.sent.filter(m => m.action === 'adoptAgent').length;
      const during = b.relay.readopt();
      await until(() => main.sent.filter(m => m.action === 'adoptAgent').length > sentBefore, 3000, 'adoptAgent sent again');
      main.ready({ epoch: 'main-2' });
      const lostCount = await during;
      await sleep(500);
      t.ok('引き継ぎの途中で main が入れ替わっても、窓は「引き継げなかった窓」にならない（閉じない・記録も残る）', lostCount === 0 && tabsIn(chrome, windowId).length === 1 && os.calls('closeAgent').length === 0 && b.relay.snapshot().windows.flatMap(e => e.windows).length === 1,
        JSON.stringify({ lostCount, logs: b.logs }));
      t.ok('入れ替わった main には、onReady でもう一度引き継ぐ（窓は隠した形のまま 1 つ）', hidden().length === 1 && hidden()[0].concealed === true && core.generation() === 1 && main.sent.filter(m => m.action === 'adoptAgent').length >= sentBefore + 2,
        JSON.stringify({ hidden: hidden(), generation: core.generation(), sent: main.sent.length }));
      ag.close(); ag2.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 10c. 最初の窓を chrome.exe で開いている最中に main が入れ替わる: 返事は聞けなくても chrome.exe は窓を開いている。題（nonce）のページだけの見える窓を残さない =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const main = fakeMainPort(os, { delayMs: 40 });
      const core = parentPortChromeOs(main.port, { timeoutMs: 5000, readyWaitMs: 500 });
      main.ready();
      const b = await newServer(chrome, core, { readoptOnReady: true });
      const ag = await agent(await b.relay.endpoint('conv-10c'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const pagesBefore = chrome.browser.targets().filter(x => x.type === 'page').length;
      const opening = ag.cmd('Target.createTarget', { url: 'about:blank' });
      await until(() => main.sent.some(m => m.action === 'launchWindow'), 3000, 'launchWindow sent to main');
      main.ready({ epoch: 'main-2' });   // 窓を開く依頼の返事が届かない
      const reply = await opening;
      await sleep(300);
      const pages = chrome.browser.targets().filter(x => x.type === 'page');
      t.ok('開く最中に main が入れ替わっても、窓は開く（エージェントは新しいタブを得る）', typeof reply.result?.targetId === 'string', JSON.stringify(reply));
      t.ok('chrome.exe が開いた題（nonce）のページの窓を残さない（開いた窓は 1 つ・隠れている・記録も 1）',
        !pages.some(x => String(x.url).includes('PLY-')) && pages.length === pagesBefore + 1 && os.hwnds().filter(h => h.agent && h.concealed && !h.closed).length === 1 && os.hwnds().filter(h => !h.agent && !h.closed && pages.some(x => x.windowId === h.windowId)).length === 0 && b.relay.snapshot().windows.flatMap(e => e.windows).length === 1,
        JSON.stringify({ pages: pages.map(x => x.url), hwnds: os.hwnds().map(h => ({ id: h.id, agent: h.agent, concealed: h.concealed, closed: h.closed, gone: h.gone })), records: b.relay.snapshot().windows }));
      ag.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 10b. 接続を引き継いだだけで中継がつながっていなくても、readopt が（引き継げない窓が無くても）つなぎ、窓のタブを会話の範囲に戻す =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-10b'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      const b = await newServer(chrome, os, { manual: true });
      t.ok('前提: 接続は引き継いだが、中継はつながっていない（窓のタブはまだ会話の範囲に無い）', b.adopted === true && b.relay.view.tabs('conv-10b').length === 0, JSON.stringify(b.relay.view.tabs('conv-10b')));
      const lost = await b.relay.readopt();
      await until(() => b.relay.view.tabs('conv-10b').length === 1, 3000, 'tab back in scope after readopt');
      t.ok('readopt: 引き継げない窓が無くても中継をつなぎ、窓のタブを会話の範囲に戻す', lost === 0 && b.relay.view.tabs('conv-10b')[0].targetId === tabId && os.calls('closeAgent').length === 0, JSON.stringify({ lost, tabs: b.relay.view.tabs('conv-10b') }));
      ag.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }
  } finally {
    for (const fn of cleanups) { try { await fn(); } catch { /* 後片付け */ } }
    await clearChildren().catch(() => {});
    await holder.stop?.();
  }
}
