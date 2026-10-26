// 接続の子（core/chrome/link-child.mjs）へのサーバー側の口（ADR 0167）。
// 接続の子は保持役（core/holder/）の子で、Chrome への ws を持つ。サーバーはパイプでつなぎ、ws の代わりに LinkSocket を core/chrome/connection.mjs の WebSocketImpl に渡す。
//   openChromeLink({ holder, dataDir, root, key })  … 保持役の welcome の子から札（kind: 'chrome-link'）で接続の子を探してつなぐ。無ければ起こす。つなげなければ null（今のサーバー内の ws）
//   ChromeLink { welcome, WebSocketImpl, adopted(), setCarry(carry), flush(), quit(), onLost(fn) }
//     welcome   … 接続の子の挨拶（phase: idle | upgrading | open、port、path、upgradeAt、gen、firstId、sessions、carry）
//     adopted() … 引き継ぐ接続（phase が open か upgrading のときだけ。LinkSocket）。idle なら null
//     setCarry  … 中継の状態を預ける（変わるたびに呼ぶ。200 ms でまとめる。{ now: true } ならすぐ送る）。CARRY_MAX_BYTES を越えたら「無効」の印を預ける（welcome.carryInvalid）
//     flush     … 預けている carry を書き切る（サーバーの終わりの直前。ws は閉じず、パイプもそのまま）
//     quit      … Pleiad の終了・切るとき: 接続の子に ws（確認を待つ upgrade も）を閉じさせて終わらせる
// LinkSocket は ws パッケージの WebSocket の必要な分だけ（open・unexpected-response・error・close・message、send・terminate・close）。
// 接続の世代（gen）で、閉じた接続の遅れた知らせを今の接続に混ぜない（open ごとに増やし、opened・fail・closed に載って戻る）。
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LINK_VERSION, LINK_CARD_KIND, CARRY_MAX_BYTES, HELLO_TIMEOUT_MS, LineReader, controlLine, parseControl, linkPipeName } from './link-wire.mjs';

export { LINK_VERSION, LINK_CARD_KIND };
const CHILD = fileURLToPath(new URL('./link-child.mjs', import.meta.url));
/** サーバーが 10 分つながらなければ、保持役が接続の子を止める（Pleiad が居なくなった後に Chrome への接続を残さない） */
export const LINK_KEEP_MS = 10 * 60 * 1000;
const CARRY_DEBOUNCE_MS = 200;
const INVALID = '\0invalid';
const START_WAIT_MS = 10_000;
const START_POLL_MS = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 切り替え: 実行場所の置き場があり（保持役を使える配布版）、引き継ぎが有効で、AGENT_HOST_CHROME_LINK が off でないとき */
export function chromeLinkEnabled({ runtimeRoot, handover, env = process.env, bootValue } = {}) {
  const flag = String(bootValue ?? env.AGENT_HOST_CHROME_LINK ?? '').trim().toLowerCase();
  return Boolean(runtimeRoot) && Boolean(handover) && flag !== 'off';
}

/** 札から読み直す。形が合わなければ null */
export function readLinkCard(card) {
  if (card?.kind !== LINK_CARD_KIND || typeof card.pipe !== 'string' || typeof card.secret !== 'string' || !card.pipe || !card.secret) return null;
  return { kind: card.kind, v: card.v, pipe: card.pipe, secret: card.secret };
}

/** ws の代わり。link が出す opened・fail・closed と CDP の行を、ws のイベントとして出す */
export class LinkSocket extends EventEmitter {
  constructor(link, { url, gen, state = null }) {
    super();
    this.link = link; this.gen = gen; this.finished = false;
    this.readyState = state === 'open' ? 1 : 0;
    link.attach(this);
    if (url) queueMicrotask(() => { if (!this.finished) link.control('open', { url, gen }); });
  }

  /** 接続の子の知らせ（link が gen を確かめて渡す） */
  deliver(name, value) {
    if (this.finished) return;
    if (name === 'opened') { this.readyState = 1; this.emit('open'); }
    else if (name === 'fail') {
      this.finish();
      if (value?.status > 0) { this.emit('unexpected-response', null, { statusCode: value.status, resume() {} }); }
      else if (value?.code) this.emit('error', Object.assign(new Error(String(value.code)), { code: value.code }));
      this.emit('close', 1006);
    } else if (name === 'closed') { this.finish(); this.emit('close', value?.code ?? 1006); }
  }

  message(text) { if (!this.finished) this.emit('message', text); }

  finish() { this.finished = true; this.readyState = 3; this.link.detach(this); }

  send(data) {
    if (this.finished) throw new Error('not open');
    this.link.line(data);
  }

  /** こちらから閉じる。接続の子に ws を閉じさせ、'close' はすぐ出す（接続の子は答えない） */
  terminate() {
    if (this.finished) return;
    this.finish();
    this.link.control('close');
    queueMicrotask(() => this.emit('close', 1006));
  }
  close() { this.terminate(); }

  /** 引き継ぎ: ws は閉じずに、こちらの側だけを終える（'close' は出さない） */
  release() { this.finished = true; this.readyState = 3; }
}

/** 接続の子へパイプでつなぐ。挨拶（hello）に welcome が返れば { socket, welcome, reader }。つなげない・合わない・遅いときは null */
function connectPipe(card, { timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(card.pipe);
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); if (!value) socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const reader = new LineReader({ onLine(line) {
      const control = parseControl(line);
      if (control?.name === 'welcome' && control.value && !done) finish({ socket, welcome: control.value, reader });
    } });
    socket.on('data', chunk => reader.push(chunk));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('connect', () => socket.write(controlLine('hello', { secret: card.secret, v: LINK_VERSION })));
  });
}

class ChromeLink {
  constructor({ socket, welcome, reader, log, onGone, retire, childId = null, pipe = null }) {
    this.socket = socket; this.welcome = welcome; this.reader = reader; this.log = log;
    this.current = null;          // 今の LinkSocket
    this.gen = Number(welcome.gen) || 0;
    this.lostFns = new Set();
    this.ended = false;           // releaseForRestart・quit 済み
    this.carryTimer = null; this.carryPending = undefined; this.lastCarryJson = null;
    this.onGone = onGone;
    this.retire = retire;         // 縁が途中で切れたあと、このサーバーが内の ws を張るときに、接続の子を終わらせる（retireChild）
    this.cut = false; this.retiring = null;
    this.childId = childId; this.pipe = pipe;   // 接続の子の保持役での名前と、パイプの名前
    reader.onLine = line => this.onLine(line);
    socket.on('close', () => this.onClose());
    socket.on('error', () => {});
    const self = this;
    this.WebSocketImpl = class { constructor(url) { return new LinkSocket(self, { url, gen: ++self.gen }); } };
  }

  onLine(line) {
    const control = parseControl(line);
    if (!control) { this.current?.message(line.toString('utf8')); return; }
    const { name, value } = control;
    if (name !== 'opened' && name !== 'fail' && name !== 'closed') return;
    if (!this.current) {
      // 引き継ぎの直後（adopted() の前）に届いた知らせは、挨拶の相を書き換えて残す
      if (value?.gen === this.gen && !this.adoptedOnce) this.welcome = { ...this.welcome, phase: name === 'opened' ? 'open' : 'idle' };
      return;
    }
    if (value?.gen !== this.current.gen) return;   // 閉じた接続の遅れた知らせ
    this.current.deliver(name, value);
  }

  onClose() {
    if (this.ended) return;
    this.ended = true;
    this.cut = true;   // quit を経ない切れ方。子は ws を持ったまま次のつなぎ手（落ちた後に起動したサーバー）を待つ。このサーバーが内の ws を張るなら、先に retireChild で終わらせる
    clearTimeout(this.carryTimer);
    const socket = this.current;
    this.current = null;
    if (socket && !socket.finished) { socket.finish(); socket.emit('close', 1006); }
    for (const fn of [...this.lostFns]) { try { fn(); } catch { /* 聞き手の失敗は口を壊さない */ } }
    this.onGone?.();
  }

  // LinkSocket から
  attach(socket) {
    const previous = this.current;
    this.current = socket;
    if (previous && previous !== socket && !previous.finished) { previous.finish(); queueMicrotask(() => previous.emit('close', 1006)); }
  }
  detach(socket) { if (this.current === socket) this.current = null; }
  line(text) { if (!this.ended && !this.socket.destroyed) this.socket.write(`${text}\n`); }
  control(name, value) { if (!this.ended && !this.socket.destroyed) this.socket.write(controlLine(name, value)); }

  /** 引き継ぐ接続。phase が open か upgrading のときだけ */
  adopted() {
    const phase = this.welcome.phase;
    if (phase !== 'open' && phase !== 'upgrading') return null;
    this.adoptedOnce = true;
    return new LinkSocket(this, { gen: this.gen, state: phase });
  }

  /** now: 一時停止・停止の印が替わった。デバウンスせずすぐ送る（直後にこのサーバーが落ちても、新しいサーバーが人の操作中の窓を動かさない） */
  setCarry(carry, { now = false } = {}) {
    if (this.ended) return;
    this.carryPending = carry;
    if (now) { this.flushCarry(); return; }
    if (this.carryTimer) return;
    this.carryTimer = setTimeout(() => { this.carryTimer = null; this.flushCarry(); }, CARRY_DEBOUNCE_MS);
  }

  flushCarry() {
    clearTimeout(this.carryTimer); this.carryTimer = null;
    if (this.carryPending === undefined || this.ended) return;
    const carry = this.carryPending; this.carryPending = undefined;
    const json = JSON.stringify(carry ?? null);
    if (Buffer.byteLength(json, 'utf8') > CARRY_MAX_BYTES) {
      // 古い carry を残すと、古い一時停止・停止の印を新しいサーバーが信じてしまう。無効の印を送り、新しいサーバーは全部止めて始める
      this.log?.('chrome-link: carry too large, marked invalid');
      if (this.lastCarryJson !== INVALID) { this.lastCarryJson = INVALID; this.control('carry', { carry: null, invalid: true }); }
      return;
    }
    if (json === this.lastCarryJson) return;
    this.lastCarryJson = json;
    this.control('carry', { carry: carry ?? null });
  }

  /**
   * 縁が途中で切れたあと（quit を経ない）、接続の子を終わらせる。このサーバーが Chrome への ws を自分で張る前に呼ぶ（子が古い ws を持ったままだと二重になり、確認も重なる）。
   * 切れていなければ何もしない。何度呼んでも 1 回だけ
   */
  retireChild() {
    if (!this.cut) return Promise.resolve();
    this.retiring ??= Promise.resolve().then(() => this.retire?.()).catch(() => {});
    return this.retiring;
  }

  /** パイプがまだ生きている（quit・切れた後は false） */
  get alive() { return !this.ended; }

  onLost(fn) { this.lostFns.add(fn); return () => this.lostFns.delete(fn); }

  /**
   * 預けている carry を書き切る（サーバーの終わりの直前）。ws は閉じず、パイプもそのままにする（プロセスの終了で切れる）。
   * 接続の子は ws を持ったまま次のサーバーを待ち、起動したサーバーが welcome.carry から端点と窓の印を戻す
   */
  async flush() {
    if (this.ended) return;
    this.flushCarry();
    if (this.socket.destroyed || !this.socket.writable) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 200);
      this.socket.write('', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** Pleiad の終了・切る: 接続の子に ws を閉じさせて終わらせる */
  async quit() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.carryTimer);
    this.current?.release(); this.current = null;
    if (!this.socket.destroyed) this.socket.write(controlLine('quit'));
    // 子が終わってパイプが閉じるまで待つ（サーバーが先に終わると、子の使用中の印が少しの間残る）。待ちすぎない
    await new Promise(resolve => { this.socket.once('close', resolve); this.socket.end(); setTimeout(resolve, 1500).unref?.(); });
    this.socket.destroy();
  }
}

const cardOf = child => readLinkCard(child.label);

/** 子を止めて片付ける。kill は付いている親からしか転送されないので、先に attach する */
async function retire(holder, id, { attached = false } = {}) {
  if (!attached) { try { await holder.attach(id); } catch { return; } }   // 自分で起こした子は付いたまま（再び付けると保持役が接続を閉じる）
  holder.kill(id, { tree: true });
  await sleep(200);
  holder.release(id);
}

/**
 * 接続の子のために起こした保持役を、本当に終わるときに終わらせる。保持役の shutdown は中の子を全部止めるので、ほかの子（app-server・シェル）が居れば終わらせない。
 * client の welcome は、つなぎ直した直後のもの（子の一覧）。shutdown を送り、保持役が閉じる（disconnect）のを timeoutMs まで待つ。終わらせたら true
 */
export async function shutdownHolderIfIdle(client, { timeoutMs = 1000 } = {}) {
  if (!client?.connected) return false;
  if ((client.welcome?.children ?? []).some(child => child.alive && child.label?.kind !== LINK_CARD_KIND)) return false;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    client.once('disconnect', () => { clearTimeout(timer); resolve(); });
    if (!client.shutdown()) { clearTimeout(timer); resolve(); }
  });
  return true;
}

/** パイプにつながらなくなる（子が終わる）まで待つ。待ちすぎない */
async function waitPipeGone(pipe, ms = 2000) {
  const reachable = () => new Promise(resolve => { const s = net.connect(pipe); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
  for (const end = Date.now() + ms; Date.now() < end && await reachable();) await sleep(50);
}

/**
 * 接続の子を見つけるか起こして、つなぐ。つなげなければ null（呼び出し側は今のサーバー内の ws に落ちる）。
 * holder は保持役への口（core/holder/client.mjs の HolderClient）。onGone は接続の子との縁が切れたとき（quit を除く）
 */
export async function openChromeLink({ holder, runtimeRoot, runtimeKey = '', log = () => {}, onGone, startWaitMs = START_WAIT_MS } = {}) {
  if (!holder?.connected) return null;
  const make = (found, childId, pipe, attached = false) => new ChromeLink({ ...found, log, onGone, childId, pipe, retire: async () => { await retire(holder, childId, { attached }); await waitPipeGone(pipe); } });
  // 版が合わず終わらせる子の預かり物（carry）。起こし直した子へ引き継ぐ（隠した窓・鍵・一時停止の印を、版の入れ替わりで失わない）
  let inherited = null;
  const withInherited = link => {
    if (inherited && link.welcome.carry == null) {
      link.welcome = { ...link.welcome, carry: inherited.carry, carryInvalid: inherited.invalid };
      if (inherited.carry) link.setCarry(inherited.carry, { now: true });   // 新しい子にも預ける（無効の印は、この起動の間だけ welcome で渡す）
    }
    return link;
  };
  // 居る接続の子
  for (const child of holder.welcome?.children ?? []) {
    const card = cardOf(child);
    if (!card) continue;
    if (!child.alive) { holder.release(child.id); continue; }
    const found = await connectPipe(card);
    if (!found) { log('chrome-link: existing child unreachable, replacing'); await retire(holder, child.id); continue; }
    if (found.welcome.v !== LINK_VERSION) {
      // 版が合わない: 終わらせて起こし直す（確認が 1 回出る）
      log(`chrome-link: version mismatch (child ${found.welcome.v}, server ${LINK_VERSION}), replacing`);
      const carry = found.welcome.carry;
      if (carry && typeof carry === 'object' && !Array.isArray(carry)) inherited = { carry, invalid: false };
      else if (found.welcome.carryInvalid === true) inherited = { carry: null, invalid: true };
      found.socket.write(controlLine('quit'));
      found.socket.end();
      await sleep(200);
      await retire(holder, child.id);
      continue;
    }
    return withInherited(make(found, child.id, card.pipe));
  }
  // 起こす
  const id = `chrome-link-${crypto.randomBytes(4).toString('hex')}`;
  const card = { kind: LINK_CARD_KIND, v: LINK_VERSION, pipe: linkPipeName(crypto.randomBytes(8).toString('hex')), secret: crypto.randomBytes(16).toString('hex') };
  const env = { ...process.env, PLEIAD_LINK_PIPE: card.pipe, PLEIAD_LINK_SECRET: card.secret, PLEIAD_LINK_ROOT: runtimeRoot ?? '', PLEIAD_LINK_KEY: runtimeKey ?? '' };
  if (!holder.spawn({ id, command: process.execPath, args: [CHILD], env, policy: 'none', label: card, keepMs: LINK_KEEP_MS })) return null;
  const deadline = Date.now() + startWaitMs;
  while (Date.now() < deadline) {
    const found = await connectPipe(card, { timeoutMs: 2000 });
    if (found) return withInherited(make(found, id, card.pipe, true));
    await sleep(START_POLL_MS);
  }
  log('chrome-link: new child did not answer');
  await retire(holder, id);
  return null;
}
