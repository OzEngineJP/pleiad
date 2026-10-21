// 端末から中継を通ってホストへつなぐ 1 本の線（docs/remote.md §3.2・§4.4・§7.4）。
// デスクトップ版の端末内プロキシ（device-proxy.mjs）が使う。モバイルは同じ流れを Swift / Kotlin で持つ。
//
//   const link = new DeviceLink({ creds, keyPair, app: '0.1.0', name: 'my-laptop' });
//   link.on('status', s => ...);          // { state, closeCode?, reason?, since, retryAt, hostName }
//   link.start();
//   const ch = await link.ready(10_000);  // つながり次第 Channel。ホストが居ない・取り消し済みなら即座に reject
//   link.stop();
//
// 状態（state）:
//   'connecting'    中継へつなぎ、ハンドシェイクと HELLO を待っている
//   'connected'     チャネルが使える
//   'offline'       中継につながらない・通信が切れた（張り直しを待っている）
//   'host-offline'  中継は答えたがホストが居ない（4404・4408・ホストの GOAWAY shutdown）。張り直しを待っている
//   'revoked'       この端末は取り消された・資格が合わない（4401・GOAWAY revoked）。張り直さない
//   'reapprove'     （Plus）ホストの PC の画面でもう一度の許可が要る（受け入れのやり直しを reapprove で断られた）。張り直さない
//   'blocked'       （Plus）このアカウントでは公式の中継を使えない（4401 account・券の発行が 403 account_disabled・not_plus）。張り直さない
//   'paused'        （Plus）Plus が止まっている（4401 plus unavailable・券の発行が 503）。張り直さない
//   'removed'       （Plus）ホストの PC が Plus のアカウントから外された（4401 host・券の発行が 403 host_removed・404）。張り直さない
//   'stopped'       stop() した
//
// 張り直しは 0.5 秒から 30 秒まで倍々（±25% の揺らぎ）。10 秒つながり続けたら初めからに戻す。
// ストリームは持ち越さない（§4.4）。切れたらチャネルが全ストリームを捨て、プロキシが 502 / 1006 にする。
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Handshake, prologueFor } from './noise.mjs';
import { Channel, ChannelError } from './channel.mjs';
import { relayWsUrl } from './pairing.mjs';
import { t } from '../i18n.mjs';

/** 中継への WebSocket の 1 メッセージの上限（中継の 66,000 に余裕を持たせる）。 */
const RELAY_MAX_PAYLOAD = 70_000;
/** 受け入れのやり直しの失敗（err.code）→ 状態。ここに無いもの（つながらない等）は 'revoked'。unknown-host は外された PC */
const READMIT_STATES = { reapprove: 'reapprove', revoked: 'revoked', blocked: 'blocked', limit: 'limit', unavailable: 'paused', update: 'update', 'unknown-host': 'removed' };
export const LINK_BACKOFF = Object.freeze({ minMs: 500, maxMs: 30_000, stableMs: 10_000 });

/**
 * 中継の券が取れなかったとき（getTicket の誤り）の状態。中継の切断の理由と同じに決める:
 * 403 host_removed・404（ホストの PC が台帳に無い。券の無い前の版の api の 404 は getTicket が null で返す）→ 'removed'（4401 host）、
 * 403 account_disabled・not_plus → 'blocked'（4401 account）、503 → 'paused'（4401 plus unavailable）、ほかは張り直す
 */
export function ticketFailureState(e) {
  if (e?.code === 'update') return 'update';
  if ((e?.status === 403 && e.code === 'host_removed') || e?.status === 404) return 'removed';
  if (e?.status === 403 && (e.code === 'account_disabled' || e.code === 'not_plus')) return 'blocked';
  if (e?.status === 503) return 'paused';
  return 'offline';
}

/** 中継の close code とホストの GOAWAY から状態を決める。via: 'plus' のときは Plus 用の表に従う。 */
export function classifyClose({ closeCode = null, reason = '', goaway = null, via = 'own' } = {}) {
  if (via === 'plus') {
    if (goaway === 'revoked') return 'readmit';
    if (goaway === 'shutdown') return 'host-offline';
    if (closeCode === 4404 || closeCode === 4408) return 'host-offline';
    if (closeCode === 4401) {
      const r = String(reason ?? '').trim();
      if (r === 'revoked' || r === 'device token') return 'readmit';
      if (r === 'account') return 'blocked';
      if (r === 'host') return 'removed';
      if (r === 'token' || r === 'ticket') return 'offline';
      if (r === 'update required') return 'update';
      if (r === 'plus off') return 'host-offline';
      if (r === 'plus unavailable') return 'paused';
      return 'readmit';
    }
    if (closeCode === 4429) {
      const r = String(reason ?? '').trim();
      if (r === 'account limit') return 'limit';
      if (r === 'admit rate') return 'offline';
      return 'limit';
    }
    if (closeCode === 1013) return 'offline';
    return 'offline';
  }
  if (goaway === 'revoked' || closeCode === 4401) return 'revoked';
  if (goaway === 'shutdown' || closeCode === 4404 || closeCode === 4408) return 'host-offline';
  if (closeCode === 1013) return 'offline';   // 中継の差し込みの一時的な失敗（docs/remote.md §5.7）。少し待って張り直す
  return 'offline';
}

/**
 * 中継の口へ WebSocket を張る。届いたメッセージは順に溜め、next() で 1 通ずつ取るか drainTo() で流し込む。
 * ハンドシェイクのメッセージ 2 と HELLO が同じ読み出しで届いても取りこぼさない。
 * 中継の close code は closed（{ code, reason }）に入る。
 */
export function openRelaySocket(url, headers, { openTimeoutMs = 10_000, WebSocketImpl = WebSocket } = {}) {
  const ws = new WebSocketImpl(url, { headers, perMessageDeflate: false, maxPayload: RELAY_MAX_PAYLOAD, followRedirects: false, handshakeTimeout: openTimeoutMs });
  let isClosed = null;
  const closed = new Promise(res => ws.on('close', (code, reason) => {
    isClosed = { code, reason: reason?.toString('utf8') ?? '' };
    for (const w of waiters.splice(0)) w(null, isClosed);
    res(isClosed);
  }));
  ws.on('error', () => {});
  const opened = new Promise(res => {
    const timer = setTimeout(() => res({ error: 'open timeout' }), openTimeoutMs + 1000);
    timer.unref?.();
    ws.once('open', () => { clearTimeout(timer); res({ open: true }); });
    ws.once('unexpected-response', (req, r) => { clearTimeout(timer); res({ status: r.statusCode }); r.resume(); req.destroy(); });
    ws.once('error', e => { clearTimeout(timer); res({ error: e.message }); });
    ws.once('close', code => { clearTimeout(timer); res({ closeCode: code }); });
  });
  const inbox = [];
  const waiters = [];
  let sink = null;
  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (sink) return sink(buf);
    const w = waiters.shift();
    if (w) w(buf); else inbox.push(buf);
  });
  /** 次の 1 通。閉じられたら reject（closeCode 付き）、ms を過ぎても reject。 */
  const next = (ms = 10_000) => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const fail = c => reject(Object.assign(new Error(`relay connection closed (${c.code})`), { closeCode: c.code }));
    if (isClosed) return fail(isClosed);
    const w = (buf, c) => { clearTimeout(timer); if (buf) resolve(buf); else fail(c); };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(Object.assign(new Error('no response from host'), { code: 'timeout' }));
    }, ms);
    timer.unref?.();
    waiters.push(w);
  });
  /** 以後のメッセージを fn へ（溜まっていた分から順に、同期的に）。聞き手を付け終えてから呼ぶこと。 */
  const drainTo = fn => { sink = fn; for (const b of inbox.splice(0)) fn(b); };
  return { ws, closed, opened, next, drainTo };
}

/** 閉じる。閉じ終わらなければ 2 秒で断ち切る。 */
function closeSocket(ws, code = 1000) {
  if (ws.readyState === WebSocket.CLOSED) return;
  try { ws.readyState === WebSocket.CONNECTING ? ws.terminate() : ws.close(code); } catch { ws.terminate(); }
  const timer = setTimeout(() => { try { ws.terminate(); } catch {} }, 2000);
  timer.unref?.();
}

function errorFor(state, detail) {
  const e = new Error(state === 'revoked' ? t('remote.device.revoked')
    : state === 'reapprove' ? t('remote.device.reapprove')
    : state === 'blocked' ? t('remote.device.blocked')
      : state === 'limit' ? t('remote.device.limit')
        : state === 'paused' ? t('remote.device.paused')
        : state === 'update' ? t('remote.device.update')
        : state === 'removed' ? t('remote.device.removed')
          : state === 'host-offline' ? t('remote.device.hostOffline')
            : state === 'stopped' ? t('remote.device.stopped') : t('remote.device.offline'));
  e.state = state;
  if (detail?.closeCode != null) e.closeCode = detail.closeCode;
  return e;
}

export class DeviceLink extends EventEmitter {
  /**
   * creds: { hostId, hostPublicKey (Buffer), relayUrl, deviceId, token, via? }
   * keyPair: 端末の静的鍵 { publicKey, privateKey }
   * backoff: { minMs, maxMs, stableMs }（試験で縮める）
   * connectTimeoutMs: 中継への接続・ハンドシェイク・HELLO のそれぞれの待ちの上限
   */
  constructor({ creds, keyPair, app = '', name = '', shell = 'desktop', backoff = {}, connectTimeoutMs = 15_000, channelOptions = {}, log = () => {}, via = null, getIdToken = null, getTicket = null, onReadmit = null }) {
    super();
    this.creds = creds;
    this.via = via ?? creds.via ?? 'own';
    this.getIdToken = getIdToken ?? creds.getIdToken ?? null;
    this.getTicket = getTicket;
    this.onReadmit = onReadmit;
    this.tokenRetries = 0;
    this.tokenForceNext = false;
    this.readmitRetries = 0;
    this.keyPair = keyPair;
    this.app = String(app);
    this.name = String(name);
    this.shell = shell;
    this.backoff = { ...LINK_BACKOFF, ...backoff };
    this.connectTimeoutMs = connectTimeoutMs;
    this.channelOptions = channelOptions;
    this.log = log;
    this.channel = null;
    this.hostName = '';
    this.attempt = 0;
    this.running = false;
    this.generation = 0;
    this.retryTimer = null;
    this.stableTimer = null;
    this.socket = null;
    this._status = { state: 'stopped', since: new Date().toISOString(), retryAt: null };
  }

  get status() { return { ...this._status, hostName: this.hostName }; }
  get state() { return this._status.state; }

  #setStatus(state, extra = {}) {
    this._status = { state, since: new Date().toISOString(), retryAt: null, ...extra };
    this.emit('status', this.status);
  }

  /** つなぎ始める（つながっていれば何もしない）。 */
  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.#connect();
  }

  /** 止める。張り直しもしない。 */
  stop() {
    if (!this.running && this.state === 'stopped') return;
    this.running = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    this.retryTimer = null;
    const ch = this.channel;
    this.channel = null;
    ch?.close(new ChannelError('closed', 'link stopped'));
    if (this.socket) closeSocket(this.socket, 1000);
    this.socket = null;
    this.#setStatus('stopped');
  }

  /** 待たずに今すぐつなぎ直す（「再試行」、取り消し後の再ペアリングで資格が変わったときも）。 */
  retryNow(creds, keyPair) {
    if (creds) {
      this.creds = creds;
      if (creds.via) this.via = creds.via;
    }
    if (keyPair) this.keyPair = keyPair;
    if (!this.running) { this.start(); return; }
    if (this.state === 'connecting' || this.state === 'connected') { if (!creds) return; }
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ch = this.channel;
    this.channel = null;
    ch?.close(new ChannelError('closed', 'reconnecting'));
    if (this.socket) closeSocket(this.socket, 1000);
    this.socket = null;
    this.attempt = 0;
    this.#connect();
  }

  /**
   * 使えるチャネル。つながっていればすぐ、つないでいる最中なら結果を待つ（最大 ms）。
   * 張り直しを待っている・取り消し済み・止めたなら、待たずに reject（err.state に状態）。
   */
  ready(ms = 10_000) {
    if (this.state === 'connected' && this.channel && !this.channel.closed) return Promise.resolve(this.channel);
    if (this.state !== 'connecting') return Promise.reject(errorFor(this.state, this._status));
    return new Promise((resolve, reject) => {
      const onStatus = s => {
        if (s.state === 'connecting') return;
        cleanup();
        if (s.state === 'connected' && this.channel) resolve(this.channel);
        else reject(errorFor(s.state, s));
      };
      const timer = setTimeout(() => { cleanup(); reject(errorFor('offline')); }, ms);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); this.off('status', onStatus); };
      this.on('status', onStatus);
    });
  }

  #scheduleRetry(state, detail, { delayOverride = null } = {}) {
    if (!this.running) return;
    if (state === 'revoked' || state === 'reapprove' || state === 'blocked' || state === 'limit' || state === 'update' || state === 'removed') {
      this.running = false;
      this.#setStatus(state, detail);
      return;
    }
    if (state === 'paused') {
      this.running = false;
      this.#setStatus('paused', detail);
      return;
    }
    if (state === 'readmit') {
      if (this.readmitRetries >= 1 || !this.onReadmit) {
        this.running = false;
        this.#setStatus('revoked', detail);
        return;
      }
      this.readmitRetries++;
      this.#setStatus('connecting', detail);
      Promise.resolve(this.onReadmit()).then(newCreds => {
        if (!this.running) return;
        if (newCreds) {
          this.creds = newCreds;
          this.attempt = 0;
          this.readmitRetries = 0;
          this.#connect();
        } else {
          this.running = false;
          this.#setStatus('revoked', detail);
        }
      }).catch(e => {
        if (!this.running) return;
        this.running = false;
        // 受け入れのやり直しで断られた理由（device.mjs の admitWithHost の err.code）を状態にする
        this.#setStatus(READMIT_STATES[e?.code] ?? 'revoked', detail);
      });
      return;
    }
    const base = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** this.attempt);
    const delay = delayOverride != null ? delayOverride : Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    const retryAt = new Date(Date.now() + delay).toISOString();
    this.#setStatus(state, { ...detail, retryAt });
    const gen = this.generation;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (gen === this.generation && this.running) this.#connect(); }, delay);
    this.retryTimer.unref?.();
  }

  /** Plus の中継が券・トークンで断ったときの張り直し（4401 'token' / 'ticket' は取り直して 1 回だけ、4429 'admit rate' は 1 分後）。無ければ null */
  #plusRetry(closeCode, reason) {
    if (this.via !== 'plus') return null;
    const r = String(reason ?? '').trim();
    if (closeCode === 4401 && (r === 'token' || r === 'ticket')) {
      this.tokenRetries = (this.tokenRetries || 0) + 1;
      if (this.tokenRetries >= 2) return { state: 'blocked' };
      this.tokenForceNext = true;
      return { state: 'offline', opts: { delayOverride: 1000 } };
    }
    if (closeCode === 4429 && r === 'admit rate') return { state: 'offline', opts: { delayOverride: 60_000 } };
    return null;
  }

  async #connect() {
    const gen = ++this.generation;
    const live = () => gen === this.generation && this.running;
    this.#setStatus('connecting');
    const { creds } = this;
    const headers = {
      authorization: `Bearer ${creds.token}`, 'x-pleiad-host': creds.hostId, 'x-pleiad-device': creds.deviceId,
    };
    if (this.via === 'plus' && this.getTicket) {
      // 中継の券（role:device。この端末の鍵で取る）。券の無い前の版の api なら null で、ID トークンへ戻る
      let ticket = null;
      try { ticket = await this.getTicket({ hostId: creds.hostId, keyPair: this.keyPair }); }
      catch (e) {
        if (!live()) return;
        this.log(`remote device: ticket failed: ${e.message}`);
        return this.#scheduleRetry(ticketFailureState(e), { reason: 'ticket' });
      }
      if (!live()) return;
      if (ticket) headers['x-pleiad-ticket'] = ticket;
    }
    if (this.via === 'plus' && !headers['x-pleiad-ticket']) {
      let idToken = null;
      if (this.getIdToken) {
        try { idToken = await this.getIdToken({ force: this.tokenForceNext }); } catch (e) {
          this.log(`remote device: getIdToken failed: ${e.message}`);
        }
      }
      this.tokenForceNext = false;
      if (idToken) headers['x-pleiad-account'] = idToken;
    }
    let sock;
    try {
      sock = openRelaySocket(relayWsUrl(creds.relayUrl, '/v1/device'), headers, { openTimeoutMs: this.connectTimeoutMs });
    } catch (e) {
      this.log(`remote device: ${e.message}`);
      return this.#scheduleRetry('offline', { reason: 'url' });
    }
    this.socket = sock.ws;
    const fail = (state, detail = {}, retryOpts = {}) => {
      closeSocket(sock.ws, 1000);
      if (this.socket === sock.ws) this.socket = null;
      if (live()) this.#scheduleRetry(state, detail, retryOpts);
    };

    const o = await sock.opened;
    if (!live()) return closeSocket(sock.ws);
    if (!o.open) {
      // 中継の Upgrade 前の拒否（429 など）・名前解決やつながりの失敗・開いた直後に閉じられた
      const closedReason = (await Promise.race([sock.closed, Promise.resolve(null)]))?.reason ?? '';
      const reason = closedReason || o.reason || o.error || '';
      const closeCode = o.closeCode ?? (o.status ? Number(o.status) : null);
      const detail = closeCode != null ? { closeCode, reason } : { reason };
      const st = classifyClose({ closeCode, reason, via: this.via });
      const again = this.#plusRetry(closeCode, reason);
      if (again) return fail(again.state, detail, again.opts);
      return fail(st, detail);
    }

    let transport;
    try {
      const hs = new Handshake({ pattern: 'IK', initiator: true, prologue: prologueFor(creds.hostId), staticKey: this.keyPair, remoteStatic: creds.hostPublicKey });
      sock.ws.send(hs.writeMessage(Buffer.from(JSON.stringify({ proto: 1, name: this.name, app: this.app }))));
      hs.readMessage(await sock.next(this.connectTimeoutMs));
      transport = hs.split();
    } catch (e) {
      if (!live()) return closeSocket(sock.ws);
      const closed = await Promise.race([sock.closed, Promise.resolve(null)]);
      const closeCode = e.closeCode ?? closed?.code ?? null;
      const reason = closed?.reason || e.reason || '';
      const detail = { closeCode, reason };
      if (closeCode != null) {
        const st = classifyClose({ closeCode, reason, via: this.via });
        const again = this.#plusRetry(closeCode, reason);
        if (again) return fail(again.state, detail, again.opts);
        return fail(st, detail);
      }
      if (e.code === 'timeout') return fail('host-offline', { reason: 'timeout' });
      this.log(`remote device: handshake failed: ${e.message}`);
      return fail('revoked', { reason: 'handshake' });
    }

    const ch = new Channel({
      role: 'device', transport, send: b => sock.ws.send(b), hello: { app: this.app, shell: this.shell },
      bufferedAmount: () => sock.ws.bufferedAmount, ...this.channelOptions,
    });
    let goaway = null;
    let settled = false;
    const hello = new Promise(resolve => {
      // 聞き手を先に付けてから溜まった分を流す（後から付けると、drainTo の中で同期的に処理された HELLO を取りこぼす）
      ch.once('hello', h => resolve({ hello: h }));
      ch.once('close', () => resolve({ closed: true }));
      const timer = setTimeout(() => resolve({ timeout: true }), this.connectTimeoutMs);
      timer.unref?.();
      ch.once('hello', () => clearTimeout(timer));
      ch.once('close', () => clearTimeout(timer));
    });
    ch.on('goaway', g => { goaway = String(g?.code ?? ''); });
    ch.on('close', () => closeSocket(sock.ws, 1000));
    sock.ws.on('close', () => ch.close(new ChannelError('transport', 'relay connection lost')));
    sock.closed.then(c => {
      if (settled) {
        // つながっていたチャネルが切れた
        if (this.channel === ch) this.channel = null;
        clearTimeout(this.stableTimer);
        if (this.socket === sock.ws) this.socket = null;
        if (!live()) return;
        const detail = { closeCode: c.code, reason: c.reason, ...(goaway ? { goaway } : {}) };
        const st = classifyClose({ closeCode: c.code, reason: c.reason, goaway, via: this.via });
        const again = this.#plusRetry(c.code, c.reason);
        if (again) return this.#scheduleRetry(again.state, detail, again.opts);
        this.#scheduleRetry(st, detail);
      }
    });
    sock.drainTo(b => ch.receive(b));
    ch.start();
    const h = await hello;
    if (!live()) { ch.close(); return closeSocket(sock.ws); }
    if (!h.hello) {
      ch.close();
      const c = await Promise.race([sock.closed, new Promise(r => { const timer = setTimeout(r, 1000, null); timer.unref?.(); })]);
      if (!live()) return;
      const closeCode = c?.code ?? null;
      const reason = c?.reason ?? '';
      const st = classifyClose({ closeCode, reason, goaway, via: this.via });
      const detail = { ...(closeCode != null ? { closeCode } : {}), ...(reason ? { reason } : {}), ...(goaway ? { goaway } : {}), ...(h.timeout ? { reason: 'timeout' } : {}) };
      return fail(h.timeout && closeCode == null ? 'host-offline' : st, detail);
    }
    settled = true;
    this.channel = ch;
    this.tokenRetries = 0;
    this.readmitRetries = 0;
    this.hostName = typeof h.hello.hostName === 'string' ? h.hello.hostName : '';
    this.stableTimer = setTimeout(() => { if (this.channel === ch) this.attempt = 0; }, this.backoff.stableMs);
    this.stableTimer.unref?.();
    this.emit('channel', ch);
    this.#setStatus('connected');
    // 既に切れていた（HELLO の直後に閉じられた）なら、上の sock.closed が張り直しを受け持つ
    if (sock.ws.readyState === WebSocket.CLOSED && this.channel === ch) {
      this.channel = null;
      const c = await sock.closed;
      if (live() && this.state === 'connected') {
        const detail = { closeCode: c.code, reason: c.reason };
        const st = classifyClose({ closeCode: c.code, reason: c.reason, via: this.via });
        this.#scheduleRetry(st, detail);
      }
    }
  }
}
