// エージェントのブラウザー（PC の Chrome）の止める・PC で操作する・この端末で操作する・任せる（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0154・0296）。
//
// 窓（会話）ごとの状態:
//   running  エージェントのターンの間（第 4 段の focus emulation の付け外しと同じ合図）
//   idle     ターンの外（待機中）
//   stopped  「止める」: 接続を閉じ、次の人の送信まで再接続を断る（ターンの開始で鍵を作り直す。中継の stop / resume）
//   paused   「PC で操作する」: 見ているタブの窓を画面の中に出し、そのタブを人の操作にしている間（ADR 0296 の 1 の 6）。
//            会話の一時停止はしない（エージェントはほかのタブで続けられる。人の操作のタブの断りは core/chrome/tab-holder.mjs の門）。
//            人が本物の窓で入力したことは CDP から見えないので、窓を出している間は時間で戻さない。映像は止める（2 段階認証のコードなどを映さない）。
//            「任せる」で窓を画面の外の見えない窓に戻し、人の操作のタブを全部 AI に戻す
// 「この端末で操作する」（takeOver(sessionId, { by: 'device', width, height, scale })）は、見ているタブをその端末の人の操作にする（持ち手の口の touch。窓は出さない）。
// 状態は中継の会話の記録（turn・stopped）と「PC で操作する」の記録（pcTabs）が持ち、ここは操作（OS の層の reveal・raise・conceal の順序）と、状態の変わった便りを受け持つ。
// 自動の一時停止は作らない（ADR 0154）。
// 前の版（引き継ぎ＝会話の一時停止の形）から更新で持ち越した一時停止（中継の paused。ADR 0167 の carry）も paused として見せ、「任せる」で窓を隠してから解く。
// 新しく一時停止に入る道は無い（Chrome が閉じたときは中継が解く。「PC で操作する」も Chrome が閉じたら解く）。
//
// 撮影を断る（右パネルの映像。core/chrome/screencast.mjs の suspend / resume）: paused に入った時に suspend し、paused が解けた時に resume する。
// 解け方（任せる・止める・Chrome が閉じた・会話の削除・id の付け替え）に依らず、中継の状態の変化から対にする（付け替え・削除で消えた会話の分は次の変化で resume して片付ける。
// 映像の側も、会話の削除・接続の切断で断りを自分で消し、id の付け替えで新しい id へ移す）。
// 状態の便り（onChange）は { sessionId, state, since, error, by } の形（since: paused の始まりの時刻 ms。それ以外は null。error: 戻せなかった理由 'conceal-failed'（paused のまま）。無ければ null。
// by: 誰が操作しているか（'pc' | 'device'。paused のときだけ。'device' は持ち越した端末の一時停止だけ。それ以外は null））。ログには窓の題・URL を出さない。
// 早い者勝ち: 「PC で操作する」の窓を出している間に後から押したほうは今の状態を返すだけ。
// ただし端末が「この端末で操作する」を押したとき（takeOver(sessionId, { by: 'device', fromPc: true, ... })）は、PC に見せていた窓を隠してから端末へ移す。
// 隠せなければ移さず、conceal-failed を返す
import { deviceViewport } from './input.mjs';

export const CONTROL_STATES = Object.freeze(['running', 'idle', 'stopped', 'paused']);

export class ChromeControlError extends Error {
  /** code: NO_WINDOW（操作できる窓が無い）・NOT_CONNECTED・INVALID（端末の映像の箱の大きさが無い） */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {object} deps
 * @param deps.relay    core/chrome/relay.mjs の中継（state・scope・cdp・view・unify.tabHolder・unpause・stop・onChange・onTap）
 * @param deps.os       core/chrome/os.mjs の口（「PC で操作する」で、窓を出す画面の手がかり＝Pleiad の窓（appWindow）・無ければその時の前面（foreground）を取るのに使う）
 * @param [deps.capture] 映像の撮影を断る口（{ suspend(sessionId), resume(sessionId) }。core/chrome/screencast.mjs）。無ければ断らない
 */
export function createChromeControl({ relay, os, now = Date.now, capture = null, log = () => {} }) {
  const listeners = new Set();
  const last = new Map();      // 会話の id -> 最後に配った状態の印（同じ状態を重ねて配らない）
  const queues = new Map();    // 会話の id -> 操作の順番待ち（同じ会話の PC で操作する・任せる・止めるを順に流す）

  const errors = new Map();    // 会話の id -> 戻せなかった理由（'conceal-failed'。paused のまま画面へ返す。paused でなくなれば消す）
  const pcTabs = new Map();    // 会話の id -> { targetId, since }（「PC で操作する」で人の操作にしたタブ。窓を出している間は時間で戻さない）
  /** タブごとの持ち手の口（core/chrome/tab-holder.mjs。relay.unify.tabHolder） */
  const holder = () => relay.unify?.tabHolder ?? null;
  /** 持ち越した一時停止（前の版の引き継ぎ）。無ければ null */
  const carried = sessionId => relay.state(sessionId)?.paused ?? null;
  const held = sessionId => Boolean(carried(sessionId)) || pcTabs.has(sessionId);

  function stateOf(sessionId) {
    const s = relay.state(sessionId);
    const pc = pcTabs.get(sessionId) ?? null;
    if (!s) return pc ? { sessionId, state: 'paused', since: pc.since, error: errors.get(sessionId) ?? null, by: 'pc' } : { sessionId, state: 'idle', since: null, error: null, by: null };
    const paused = Boolean(s.paused) || Boolean(pc);
    const state = paused ? 'paused' : s.stopped ? 'stopped' : s.turn ? 'running' : 'idle';
    const by = pc ? 'pc' : s.paused ? (s.paused.by === 'device' ? 'device' : 'pc') : null;
    return { sessionId, state, since: pc?.since ?? s.paused?.at ?? null, error: paused ? errors.get(sessionId) ?? null : null, by };
  }
  const mark = state => `${state.state}:${state.since ?? ''}:${state.error ?? ''}:${state.by ?? ''}`;

  const suspended = new Set();   // 撮影を断っている会話の id（paused の間）
  const safe = (what, fn) => { try { fn(); } catch (error) { log(`chrome-control: ${what} failed: ${error?.message ?? error}`); } };
  /**
   * paused に合わせて撮影を断る・解く。中継から消えた会話（削除・付け替え）の分は resume して片付ける。
   * 持ち越した端末の一時停止は断らない（端末はその映像を見ていた）
   */
  function syncCapture(sessionId) {
    // 消えた会話の「PC で操作する」の記録を捨てる。id の付け替え（rebind）で、そのタブが今の会話へ移っていれば、記録も移す
    for (const [id, pc] of [...pcTabs]) {
      if (relay.state(id)) continue;
      pcTabs.delete(id);
      const moved = id !== sessionId && !pcTabs.has(sessionId) && relay.state(sessionId) && relay.view?.tabs?.(sessionId)?.some(tab => tab.targetId === pc.targetId);
      if (moved) { pcTabs.set(sessionId, pc); if (errors.has(id)) errors.set(sessionId, errors.get(id)); }
      errors.delete(id);
    }
    if (!capture) return;
    const saved = carried(sessionId);
    const paused = (Boolean(saved) && saved.by !== 'device') || pcTabs.has(sessionId);
    if (paused && !suspended.has(sessionId)) { suspended.add(sessionId); safe('suspend', () => capture.suspend(sessionId)); }
    else if (!paused && suspended.has(sessionId)) { suspended.delete(sessionId); safe('resume', () => capture.resume(sessionId)); }
    for (const id of [...suspended]) if (!relay.state(id)) { suspended.delete(id); safe('resume', () => capture.resume(id)); }
  }

  /** 状態を聞き手へ配る（前に配った状態と同じなら配らない） */
  function publish(sessionId) {
    syncCapture(sessionId);
    if (!held(sessionId)) errors.delete(sessionId);
    const state = stateOf(sessionId);
    if (last.get(sessionId) === mark(state)) return;
    last.set(sessionId, mark(state));
    if (state.state === 'idle' && !relay.state(sessionId)) last.delete(sessionId);
    for (const fn of [...listeners]) { try { fn(state); } catch (error) { log(`chrome-control: listener failed: ${error?.message ?? error}`); } }
  }
  const offChange = relay.onChange(publish);
  /** カードのボタン（PC で操作する・この端末で操作する）の対象: AI のタブ。AI がまだどのタブも操作していないときだけ、窓の最初のタブ（ボタンが何も起こさず終わらないように。ADR 0320） */
  function handoverTab(sessionId) { return relay.view?.current?.(sessionId) ?? relay.view?.shown?.(sessionId) ?? null; }

  /** 更新で持ち越した「PC で操作する」の窓（見せている窓の印だけが carry に載る）のタブが分かったら、そのタブを人の操作に戻す */
  function holdCarried(sessionId) {
    const pc = pcTabs.get(sessionId);
    if (!pc || pc.targetId) return;
    const targetId = handoverTab(sessionId);
    if (!targetId) return;
    pc.targetId = targetId;
    holder()?.holdByPc?.({ sessionId, targetId });
  }
  // Chrome が閉じた（中継の view の reset）。窓もタブももう無いので「PC で操作する」も解く（窓を × で閉じただけなら、「任せる」まで paused のまま）
  const offView = relay.view?.onChange?.((sessionId, kind) => {
    if (kind === 'tabs' || kind === 'current') { holdCarried(sessionId); return; }
    if (kind !== 'reset' || !pcTabs.has(sessionId)) return;
    const pc = pcTabs.get(sessionId);
    pcTabs.delete(sessionId);
    if (pc.targetId) holder()?.forget?.({ sessionId, targetId: pc.targetId });
    publish(sessionId);
  }) ?? (() => {});
  // 更新を越えた「PC で操作する」: 窓は見せている形のまま持ち越す（windows.mjs の revealed）。paused（by: pc）に戻し、「任せる」で隠せるようにする。
  // タブは今のタブ（分かってから。分かるまでは窓を見せている印だけ）
  for (const id of relay.sessionIds()) {
    if (carried(id) || pcTabs.has(id) || relay.scope?.isRevealed?.(id) !== true) continue;
    pcTabs.set(id, { targetId: null, since: now() });
    holdCarried(id);
  }
  for (const id of relay.sessionIds()) syncCapture(id);   // 更新で一時停止・PC で操作するのまま持ち越した会話の撮影を断つ

  const serial = (sessionId, work) => {
    const run = (queues.get(sessionId) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    queues.set(sessionId, tail);
    tail.then(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId); });
    return run;
  };

  /** 会話の窓を全部画面の外の見えない窓に戻す。人が窓を作り替えた（タブを引き離した）分は先に取り込む。隠せなかった窓があれば false */
  async function concealWindows(sessionId) {
    await relay.refreshWindows(sessionId).catch(error => log(`chrome-control: refreshWindows failed: ${error?.message ?? error}`));
    let result = { concealed: 0, failed: 0 };
    try { result = await relay.scope.conceal({ entryId: sessionId, cdp: relay.cdp }); }
    catch (error) { log(`chrome-control: conceal failed: ${error?.message ?? error}`); result = { concealed: 0, failed: 1 }; }
    if (result.failed > 0) log(`chrome-control: ${result.failed} window(s) could not be hidden`);
    return result.failed === 0;
  }

  /**
   * 「PC で操作する」（ADR 0296 の 1 の 6）: 見ているタブの窓を画面の中に出し、そのタブを人の操作にする（pinned）。
   * 会話の一時停止はしない（エージェントはほかのタブで続けられる）。人が本物の窓で入力したことは CDP から見えないので、窓を出している間は時間で戻さない。
   * 戻すのは「任せる」（doResume）。映像は「PC で操作中」の幕（撮影を断つ）
   */
  async function operateOnPc(sessionId) {
    if (pcTabs.has(sessionId)) return stateOf(sessionId);   // もう窓を出している（二重に押しても窓は 1 回だけ出す）
    const targetId = handoverTab(sessionId);
    const tab = targetId ? relay.view?.tabs?.(sessionId)?.find(item => item.targetId === targetId) ?? null : null;
    if (!tab || !relay.scope.windows?.(sessionId).some(window => window.ref)) throw new ChromeControlError('NO_WINDOW', 'no agent browser window to hand over');
    holder()?.holdByPc?.({ sessionId, targetId });   // 先に人の操作にする（窓が見える間にエージェントが触れない）
    pcTabs.set(sessionId, { targetId, since: now() });
    publish(sessionId);   // 撮影を断つ・状態を配る
    // 窓を出す画面の手がかり（任せるときの前面の返し先にもなる）。Pleiad 自身の窓のある画面。リモートの端末から押したときも、PC の Pleiad の窓（その時の前面ではない）。
    // Pleiad の窓が引けなければ、その時の前面
    const near = await Promise.resolve(os.appWindow?.()).catch(() => null) ?? await Promise.resolve(os.foreground()).catch(() => null);
    let result = { revealed: 0 };
    try { result = await relay.scope.reveal({ entryId: sessionId, near, front: tab.windowId ?? undefined }); }
    catch (error) { log(`chrome-control: reveal failed: ${error?.message ?? error}`); }
    if (!result.revealed) {
      pcTabs.delete(sessionId);
      holder()?.release?.(sessionId, targetId);
      publish(sessionId);
      throw new ChromeControlError('NO_WINDOW', 'the agent browser window could not be shown');
    }
    if (!result.raised) log('chrome-control: the window was shown but did not take the foreground');
    publish(sessionId);
    return stateOf(sessionId);
  }

  /** 「この端末で操作する」: 見ているタブをその端末の人の操作にする。窓は出さず、会話の一時停止もしない（ほかのタブはエージェントが続けられる） */
  async function takeOverByDevice(sessionId, { width, height, scale, fromPc = false } = {}) {
    const viewport = deviceViewport({ width, height, scale });
    if (!viewport) throw new ChromeControlError('INVALID', 'the size of the device view is needed');
    const targetId = handoverTab(sessionId);
    if (!targetId) throw new ChromeControlError('NO_WINDOW', 'no agent browser window to hand over');
    if (pcTabs.has(sessionId)) {
      if (fromPc !== true) return stateOf(sessionId);   // 早い者勝ち（PC の窓を出している）
      if (!(await concealWindows(sessionId))) { errors.set(sessionId, 'conceal-failed'); publish(sessionId); return stateOf(sessionId); }
      const pc = pcTabs.get(sessionId);
      pcTabs.delete(sessionId);
      errors.delete(sessionId);
      if (pc.targetId) holder()?.release?.(sessionId, pc.targetId);
    }
    holder()?.touch?.({ sessionId, targetId, by: 'device', viewport });
    publish(sessionId);
    return stateOf(sessionId);
  }

  /**
   * 「引き継ぐ」（右の欄の行のボタン。ADR 0320）: AI のタブを、窓を出さずにその画面の人の操作にする（持ち手の touch）。
   * 映像は AI のタブの間は見るだけで、これを押すと触れる。スマホは映像の箱の大きさ（width・height・scale）を添える（無ければ大きさは変えない）
   * tabId は画面が映している AI のタブ。今の AI のタブと違えば（押す間に AI が別のタブへ移った・古い画面）、何も替えずに今の状態を返す（画面は描き直す。ADR 0321）
   */
  async function takeOverTab(sessionId, { width, height, scale, tabId } = {}) {
    const targetId = relay.view?.current?.(sessionId) ?? null;
    if (!targetId) throw new ChromeControlError('NO_WINDOW', 'no agent tab to hand over');
    if (tabId !== targetId) return stateOf(sessionId);
    if (pcTabs.has(sessionId)) return stateOf(sessionId);   // PC の窓を出している間は、そちらが先（早い者勝ち）
    const viewport = width != null || height != null || scale != null ? deviceViewport({ width, height, scale }) : null;
    if ((width != null || height != null || scale != null) && !viewport) throw new ChromeControlError('INVALID', 'the size of the device view is needed');
    holder()?.touch?.({ sessionId, targetId, by: viewport ? 'device' : 'pc', viewport });
    publish(sessionId);
    return stateOf(sessionId);
  }

  async function doTakeOver(sessionId, { by = 'pc', width, height, scale, fromPc = false, tabId } = {}) {
    const before = relay.state(sessionId);
    if (!before) throw new ChromeControlError('NO_WINDOW', 'no agent browser window to hand over');
    if (before.paused) return stateOf(sessionId);   // 持ち越した一時停止の間は、今の状態を返すだけ（「任せる」で解く）
    if (by === 'screen') return takeOverTab(sessionId, { width, height, scale, tabId });
    if (by === 'device') return takeOverByDevice(sessionId, { width, height, scale, fromPc });
    return operateOnPc(sessionId);
  }

  /** 「任せる」: 「PC で操作する」の窓が出ていれば画面の外へ戻してから、人の操作のタブを全部 AI に戻す。持ち越した一時停止も、窓を隠してから解く */
  async function doResume(sessionId) {
    if (pcTabs.has(sessionId)) {
      if (!(await concealWindows(sessionId))) { errors.set(sessionId, 'conceal-failed'); publish(sessionId); return stateOf(sessionId); }
      const pc = pcTabs.get(sessionId);
      pcTabs.delete(sessionId);
      errors.delete(sessionId);
      if (pc.targetId) holder()?.release?.(sessionId, pc.targetId);
    }
    holder()?.releaseAll?.(sessionId);   // 人の操作のタブを全部 AI に戻す
    const saved = carried(sessionId);
    if (saved) {
      // 端末の一時停止は窓を見せていないので隠す必要は無い。PC の一時停止は、隠せなかった窓が見えたままなら解かない（paused のまま。もう一度「任せる」を押せる）
      if (saved.by !== 'device' && !(await concealWindows(sessionId))) { errors.set(sessionId, 'conceal-failed'); publish(sessionId); return stateOf(sessionId); }
      errors.delete(sessionId);
      relay.unpause(sessionId);
    }
    publish(sessionId);
    return stateOf(sessionId);
  }

  async function doStop(sessionId) {
    if (!relay.state(sessionId)) return stateOf(sessionId);
    if (held(sessionId)) {
      await doResume(sessionId);   // 「PC で操作する」の窓を戻してから止める
      if (held(sessionId)) return stateOf(sessionId);   // 窓を隠せなかった。止めずに画面へ返す
    }
    relay.stop(sessionId);
    return stateOf(sessionId);
  }

  return {
    state: stateOf,
    /** 中継が知っている会話すべての今の状態（待機中のものは除く。画面がつなぎ直したとき） */
    snapshot: () => relay.sessionIds().map(stateOf).filter(state => state.state !== 'idle'),
    /** options: { by: 'pc' | 'device', width, height, scale, fromPc }（by: 'device' は端末の映像の箱の大きさ（CSS px と倍率）を付ける。fromPc は PC で出している窓を端末へ移す） */
    takeOver: (sessionId, options) => serial(sessionId, () => doTakeOver(sessionId, options)),
    resume: sessionId => serial(sessionId, () => doResume(sessionId)),
    stop: sessionId => serial(sessionId, () => doStop(sessionId)),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** エージェントが押した位置（{ sessionId, x, y, windowId }。右パネルの輪の元） */
    onTap: fn => relay.onTap(fn),
    close() { offChange(); offView(); listeners.clear(); for (const id of [...suspended]) { suspended.delete(id); safe('resume', () => capture?.resume(id)); } },
  };
}
