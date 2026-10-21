// 端末の側（docs/remote.md §3.1・§3.3・§7）。端末の鍵と、ペアリングしたホストの資格情報の置き場、
// QR（pleiad://pair?...）でのペアリング、ホストごとの端末内プロキシ（device-proxy.mjs）の管理。
// デスクトップ版の main プロセス（desktop/main.cjs から import()）と試験が同じものを使う。
//
//   <dir>/secrets.json  端末の静的鍵（deviceKey）と、ホストごとの中継用トークン（host:<hostId>・host-plus:<hostId> に
//                       { token, key? }）。key はそのホストにだけ使う端末の鍵（取り消された鍵は二度と入れないので、
//                       ペアリングのたびに作る。key の無い前の版の記録は deviceKey を使う）。core/secret-store.mjs
//                       （デスクトップは safeStorage で包む cipher を渡す。試験・暗号化できない起動は 0600 の平文）
//   <dir>/hosts.json    { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                         pairedAt, lastConnectedAt, revokedAt, reapproveAt? }] }（秘密は入れない。port は §7.1 のホストごとに覚えるポート。
//                         前の版が書いた agentUse は読まない。ホストの許可だけで任せられる。ADR 0239）
//   <dir>/static/<hostId>.bin  そのホストの画面の殻の束（core/remote/static-bundle.mjs。docs/remote.md §8.6）
//
//   const device = createRemoteDevice({ dir, cipher, app: '0.1.0', name: os.hostname() });
//   const host = await device.pair(payload, { onCode: code => show(code) });   // ホストで承認されたら解決
//   const proxy = await device.open(host.hostId);                               // proxy.url を窓で開く
//   device.on('status', ({ hostId, state }) => ...);
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSecretStore, plainCipher, withFileLock } from '../secret-store.mjs';
import { Handshake, generateKeyPair, keyPairFromPrivate, prologueFor, derivePairing, confirmationCode, hostIdFor } from './noise.mjs';
import { parsePairingPayload, relayWsUrl, cleanLabel, PAIRING_TTL_MS } from './pairing.mjs';
import { openRelaySocket, DeviceLink } from './device-link.mjs';
import { DeviceProxy } from './device-proxy.mjs';
import { AgentLink } from './agent-link.mjs';
import { readJson, writeJson } from './devices.mjs';
import { t } from '../i18n.mjs';

const HOST_ID = /^[a-z2-7]{26}$/;
const secretKeyOf = (hostId, via = 'own') => via === 'plus' ? `host-plus:${hostId}` : `host:${hostId}`;
const keyText = k => Buffer.from(k).toString('base64url');

function publicRecord(h) {
  return {
    hostId: h.hostId, hostName: h.hostName ?? '', label: h.label ?? '', relayUrl: h.relayUrl,
    deviceId: h.deviceId, port: h.port ?? 0, pairedAt: h.pairedAt ?? null,
    lastConnectedAt: h.lastConnectedAt ?? null, revokedAt: h.revokedAt ?? null,
    ...(h.reapproveAt ? { reapproveAt: h.reapproveAt } : {}),
    via: h.via ?? 'own',
    ...(h.via === 'plus' && h.uid ? { uid: h.uid } : {}),
  };
}

/** 端末の鍵とホストの資格情報の置き場。 */
export function createDeviceStore({ dir, cipher = plainCipher }) {
  const hostsFile = path.join(dir, 'hosts.json');
  const secrets = createSecretStore({ file: path.join(dir, 'secrets.json'), cipher });
  let keyPair = null;
  let queue = Promise.resolve();
  const locked = fn => { const run = queue.catch(() => {}).then(() => withFileLock(`${hostsFile}.lock`, fn)); queue = run; return run; };

  async function readHosts() {
    const raw = await readJson(hostsFile, { version: 1, hosts: [] });
    if (raw?.version !== 1 || !Array.isArray(raw.hosts)) throw new Error(t('remote.store.badFormat', { file: 'hosts.json' }));
    return raw;
  }

  return {
    dir,
    secrets,
    storageStatus: () => secrets.status(),

    /** 端末の静的鍵。無ければ作る（プロセスをまたいで 1 つになるよう、秘密の置き場の排他の中で）。 */
    async identity() {
      if (keyPair) return keyPair;
      const priv = await secrets.update('deviceKey', cur => cur ?? generateKeyPair().privateKey.toString('base64url'));
      keyPair = keyPairFromPrivate(Buffer.from(priv, 'base64url'));
      return keyPair;
    },

    /** そのホストの記録に使う端末の鍵（記録に鍵が無ければ deviceKey）。記録が無ければ null */
    async keyFor(hostId, via = 'own') {
      const secret = await secrets.get(secretKeyOf(hostId, via));
      if (!secret?.token) return null;
      return secret.key ? keyPairFromPrivate(Buffer.from(secret.key, 'base64url')) : this.identity();
    },

    /** ペアリングしたホストの一覧（秘密を含まない）。 */
    async hosts() { return (await readHosts()).hosts.map(publicRecord); },
    async host(hostId, via = 'own') { return (await this.hosts()).find(h => h.hostId === hostId && (h.via ?? 'own') === via) ?? null; },

    /** つなぐのに要るもの一式（トークンを含む。プロセスの外に出さない）。無ければ null。 */
    async credentials(hostId, via = 'own') {
      const h = (await readHosts()).hosts.find(x => x.hostId === hostId && (x.via ?? 'own') === via);
      if (!h) return null;
      const secret = await secrets.get(secretKeyOf(hostId, via));
      if (!secret?.token) return null;
      return { ...publicRecord(h), hostPublicKey: Buffer.from(h.hostPublicKey, 'base64url'), token: secret.token };
    },

    /** ペアリングの結果を置く。(hostId, relayUrl) または via: 'plus' の記録を置き換える。creds.keyPair はこの記録に使う端末の鍵 */
    async saveHost(creds) {
      if (!HOST_ID.test(creds.hostId ?? '')) throw new Error('invalid hostId');
      const via = creds.via ?? 'own';
      await secrets.set(secretKeyOf(creds.hostId, via), { token: creds.token, ...(creds.keyPair ? { key: keyText(creds.keyPair.privateKey) } : {}) });
      return locked(async () => {
        const data = await readHosts();
        const prev = data.hosts.find(h => h.hostId === creds.hostId && (h.via ?? 'own') === via && (via === 'plus' || h.relayUrl === creds.relayUrl));
        const rec = {
          hostId: creds.hostId, hostName: cleanLabel(creds.hostName), label: prev?.label ?? '',
          relayUrl: creds.relayUrl, hostPublicKey: Buffer.from(creds.hostPublicKey).toString('base64url'),
          deviceId: creds.deviceId, port: prev?.port ?? 0, pairedAt: new Date().toISOString(),
          lastConnectedAt: null, revokedAt: null,
          via,
          ...(via === 'plus' && creds.uid ? { uid: creds.uid } : {}),
        };
        data.hosts = data.hosts.filter(h => {
          const hVia = h.via ?? 'own';
          if (via === 'plus') return !(h.hostId === creds.hostId && hVia === 'plus');
          return !(h.hostId === creds.hostId && hVia === 'own' && h.relayUrl === creds.relayUrl);
        }).concat(rec);
        await writeJson(hostsFile, data);
        return publicRecord(rec);
      });
    },

    /** 秘密でない項目を変える（port・label・hostName・lastConnectedAt・revokedAt・reapproveAt・relayUrl）。reapproveAt は PC の画面でもう一度の許可が要ると断られた時刻 */
    async updateHost(hostId, patch, via = 'own') {
      return locked(async () => {
        const data = await readHosts();
        const h = data.hosts.find(x => x.hostId === hostId && (x.via ?? 'own') === via);
        if (!h) return null;
        for (const k of ['port', 'label', 'hostName', 'lastConnectedAt', 'revokedAt', 'reapproveAt', 'relayUrl']) if (k in patch) h[k] = patch[k];
        if (!h.reapproveAt) delete h.reapproveAt;
        await writeJson(hostsFile, data);
        return publicRecord(h);
      });
    },

    /** 一覧から消し、トークンも消す。 */
    async removeHost(hostId, via = 'own') {
      await secrets.delete(secretKeyOf(hostId, via));
      return locked(async () => {
        const data = await readHosts();
        const hit = data.hosts.find(h => h.hostId === hostId && (h.via ?? 'own') === via) ?? null;
        data.hosts = data.hosts.filter(h => !(h.hostId === hostId && (h.via ?? 'own') === via));
        await writeJson(hostsFile, data);
        return hit ? publicRecord(hit) : null;
      });
    },
  };
}

function pairError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function pairErrorForClose(closeCode) {
  if (closeCode === 4401) return pairError('ticket', t('remote.pair.ticket'), { closeCode });
  if (closeCode === 4403) return pairError('blocked', t('remote.pair.denied'), { closeCode });
  if (closeCode === 4429) return pairError('rate', t('remote.pair.rate'), { closeCode });
  if (closeCode === 4404 || closeCode === 4408) return pairError('host-offline', t('remote.pair.hostOffline'), { closeCode });
  return pairError('cancelled', t('remote.pair.cancelled'), { closeCode });
}

/**
 * QR の文字列でペアリングする（§3.3）。ハンドシェイクのあと onCode(確認コード 6 桁) を呼び、ホストの承認を待つ。
 * 承認されたら { hostId, hostPublicKey, relayUrl, deviceId, token, hostName } で解決する。
 * 断られた・期限切れ・つながらないときは reject（err.code: 'denied' | 'expired' | 'ticket' | 'rate' | 'host-offline' |
 * 'offline' | 'cancelled' | 'aborted' | 'timeout' | 'handshake' | 'payload'）。signal で中断できる。
 */
export async function pairWithHost({ payload, keyPair, name = '', platform = 'desktop', app = '', onCode = () => {}, signal, timeoutMs = PAIRING_TTL_MS + 30_000, connectTimeoutMs = 15_000 }) {
  let p;
  try { p = parsePairingPayload(payload); }
  catch (e) { throw pairError('payload', e.message); }
  const { psk, ticket } = derivePairing(p.secret);
  if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
  const sock = openRelaySocket(relayWsUrl(p.relayUrl, '/v1/device'), {
    'x-pleiad-host': p.hostId, 'x-pleiad-pairing': ticket.toString('base64url'),
  }, { openTimeoutMs: connectTimeoutMs });
  const onAbort = () => sock.ws.terminate();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const o = await sock.opened;
    if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
    if (!o.open) {
      if (o.closeCode != null) throw pairErrorForClose(o.closeCode);
      throw pairError('offline', t('remote.device.offline'), o.status ? { httpStatus: o.status } : {});
    }
    const hs = new Handshake({ pattern: 'IKpsk2', initiator: true, prologue: prologueFor(p.hostId), staticKey: keyPair, remoteStatic: p.publicKey, psk });
    sock.ws.send(hs.writeMessage(Buffer.from(JSON.stringify({ proto: 1, name: cleanLabel(name), platform, app: String(app) }))));
    let m2;
    try { m2 = await sock.next(connectTimeoutMs); }
    catch (e) {
      if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
      if (e.closeCode != null) throw pairErrorForClose(e.closeCode);
      throw pairError('host-offline', t('remote.pair.noResponse'));
    }
    try { hs.readMessage(m2); }
    catch { throw pairError('handshake', t('remote.pair.keyMismatch')); }
    const transport = hs.split();
    const code = confirmationCode(hs.handshakeHash);
    sock.ws.send(transport.encrypt(Buffer.from(JSON.stringify({ type: 'pair' }))));
    try { onCode(code); } catch { /* 表示の失敗でペアリングは止めない */ }
    let msg;
    try { msg = JSON.parse(transport.decrypt(await sock.next(timeoutMs)).toString('utf8')); }
    catch (e) {
      if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
      if (e.closeCode != null) throw pairErrorForClose(e.closeCode);
      if (e.code === 'timeout') throw pairError('timeout', t('remote.pair.timeout'));
      throw pairError('handshake', t('remote.pair.unreadable'));
    }
    if (msg?.type === 'denied') throw pairError('denied', t('remote.pair.denied'));
    if (msg?.type === 'expired') throw pairError('expired', t('remote.pair.expired'));
    if (msg?.type !== 'approved' || typeof msg.deviceId !== 'string' || typeof msg.token !== 'string') throw pairError('handshake', t('remote.pair.badResponse'));
    return {
      hostId: p.hostId, hostPublicKey: p.publicKey, relayUrl: p.relayUrl,
      deviceId: msg.deviceId, token: msg.token, hostName: cleanLabel(msg.hostName || p.hostName),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (sock.ws.readyState === sock.ws.OPEN) sock.ws.close(1000); else sock.ws.terminate();
  }
}

/**
 * 端末の全体。ホストの一覧・ペアリング・ホストごとのプロキシ。
 *   dir: 置き場（デスクトップは userData の下）、cipher: 秘密を包むもの（desktop/secret-bridge.cjs の safeStorageCipher）
 *   app: アプリの版、name: この端末の名前（ホストの端末一覧に出る）、platform: 'desktop' など
 *   proxyOptions: DeviceProxy に足すもの（backoff・connectTimeoutMs・requestWaitMs。試験で縮める）
 * 出来事: 'status' ({ hostId, state, ... })。プロキシの状態が変わるたび
 */

/** ホストの断りの理由 → err.code と表示 */
// i18n-dynamic: remote.pair.account
// i18n-dynamic: remote.pair.reapprove
// i18n-dynamic: remote.pair.revoked
const ADMIT_DENIED = {
  account: ['blocked', 'remote.pair.account'], devices: ['limit', 'remote.device.limit'], rate: ['rate', 'remote.pair.rate'],
  unavailable: ['unavailable', 'remote.device.paused'], approval: ['reapprove', 'remote.pair.reapprove'],
  revoked: ['revoked', 'remote.pair.revoked'], rejected: ['denied', 'remote.pair.denied'],
  update_required: ['update', 'remote.pair.update'],
};
export function admitDeniedError(reason) {
  const [code, key] = ADMIT_DENIED[reason] ?? ['denied', 'remote.pair.denied'];
  return pairError(code, t(key), { reason: reason || 'denied' });
}

/**
 * 端末の券（core/plus/tickets.mjs の purpose 'device'）が取れなかったときの誤り。中継の切断の理由と同じに決める:
 * 426 → 'update'、404・403 host_removed（そのホストが台帳に無い）→ 'unknown-host'、
 * 403 account_disabled・not_plus → 'blocked'、503（Plus が止まっている）→ 'unavailable'、ほか → 'offline'
 */
export function ticketIssueError(e) {
  if (e?.status === 426) return pairError('update', t('remote.pair.update'));
  if (e?.status === 404 || (e?.status === 403 && e.code === 'host_removed')) return pairError('unknown-host', t('remote.device.unknownHost'));
  if (e?.status === 403 && (e.code === 'account_disabled' || e.code === 'not_plus')) return pairError('blocked', t('remote.pair.account'));
  if (e?.status === 503) return pairError('unavailable', t('remote.device.paused'));
  return pairError('offline', t('remote.device.offline'), e?.status ? { httpStatus: e.status } : {});
}

/**
 * Pleiad Plus の同じアカウントのホストへの受け入れ（Noise IK。docs/remote.md §3.4）。
 * 相手の静的鍵 publicKey と hostId を照合し、{ type: mode } を送る。
 * 券（ticket: { relay, admission }。keyPair の鍵で取ったもの）があれば中継に X-Pleiad-Ticket で relay を、msg1 に
 * plus:{ ticket: admission } を載せる。券の無い前の版の api の間は X-Pleiad-Account と plus:{ idToken }。
 *   mode 'admit': 許可済みの鍵のつなぎ直し（窓を出さない）。許可の無い鍵は reapprove で断られる
 *   mode 'pair':  人の操作。許可の無い鍵は PC の承認の窓へ回り、{ type: 'waiting' } のあと onCode(確認コード) を呼んで承認を待つ
 * approved で { hostId, hostPublicKey, relayUrl, deviceId, token, hostName } で解決する。
 * 断られたら reject（err.code: 'reapprove' | 'revoked' | 'denied' | 'expired' | 'blocked' | 'limit' | 'rate' | 'unavailable' | 'update' ほか pairWithHost と同じ）
 */
export async function admitWithHost({ hostId, hostPublicKey, relayUrl, keyPair, idToken = null, ticket = null, name = '', platform = 'desktop', app = '', mode = 'admit', onCode = () => {}, signal, timeoutMs = 20_000, pairTimeoutMs = PAIRING_TTL_MS + 30_000, connectTimeoutMs = 15_000 }) {
  if (!HOST_ID.test(hostId ?? '')) throw pairError('bad-host', t('remote.pair.keyMismatch'));
  const pubKey = Buffer.isBuffer(hostPublicKey) ? hostPublicKey : Buffer.from(String(hostPublicKey ?? ''), 'base64url');
  if (pubKey.length !== 32 || hostIdFor(pubKey) !== hostId) {
    throw pairError('bad-host', t('remote.pair.keyMismatch'));
  }
  const useTicket = typeof ticket?.relay === 'string' && ticket.relay && typeof ticket.admission === 'string' && ticket.admission;
  if (!useTicket && (!idToken || typeof idToken !== 'string')) {
    throw pairError('account', t('remote.pair.ticket'));
  }
  if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
  const sock = openRelaySocket(relayWsUrl(relayUrl, '/v1/device'), useTicket
    ? { 'x-pleiad-host': hostId, 'x-pleiad-ticket': ticket.relay }
    : { 'x-pleiad-host': hostId, 'x-pleiad-account': idToken }, { openTimeoutMs: connectTimeoutMs });
  const onAbort = () => sock.ws.terminate();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const o = await sock.opened;
    if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
    if (!o.open) {
      if (o.closeCode != null) throw pairErrorForClose(o.closeCode);
      throw pairError('offline', t('remote.device.offline'), o.status ? { httpStatus: o.status } : {});
    }
    const hs = new Handshake({ pattern: 'IK', initiator: true, prologue: prologueFor(hostId), staticKey: keyPair, remoteStatic: pubKey });
    sock.ws.send(hs.writeMessage(Buffer.from(JSON.stringify({
      proto: 1, name: cleanLabel(name), platform, app: String(app), plus: useTicket ? { ticket: ticket.admission } : { idToken },
    }))));
    let m2;
    try { m2 = await sock.next(connectTimeoutMs); }
    catch (e) {
      if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
      if (e.closeCode != null) throw pairErrorForClose(e.closeCode);
      throw pairError('host-offline', t('remote.pair.noResponse'));
    }
    try { hs.readMessage(m2); }
    catch { throw pairError('handshake', t('remote.pair.keyMismatch')); }
    const transport = hs.split();
    const code = confirmationCode(hs.handshakeHash);
    sock.ws.send(transport.encrypt(Buffer.from(JSON.stringify({ type: mode === 'pair' ? 'pair' : 'admit' }))));
    const read = async ms => {
      try { return JSON.parse(transport.decrypt(await sock.next(ms)).toString('utf8')); }
      catch (e) {
        if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
        if (e.closeCode != null) throw pairErrorForClose(e.closeCode);
        if (e.code === 'timeout') throw pairError('timeout', t('remote.pair.timeout'));
        throw pairError('handshake', t('remote.pair.unreadable'));
      }
    };
    let msg = await read(timeoutMs);
    if (msg?.type === 'waiting' && mode === 'pair') {
      try { onCode(code); } catch { /* 表示の失敗で受け入れは止めない */ }
      msg = await read(pairTimeoutMs);
    }
    if (msg?.type === 'denied') throw admitDeniedError(msg.reason);
    if (msg?.type === 'expired') throw pairError('expired', t('remote.pair.expired'));
    if (msg?.type !== 'approved' || typeof msg.deviceId !== 'string' || typeof msg.token !== 'string') {
      throw pairError('handshake', t('remote.pair.badResponse'));
    }
    return {
      hostId, hostPublicKey: pubKey, relayUrl,
      deviceId: msg.deviceId, token: msg.token, hostName: cleanLabel(msg.hostName || name),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (sock.ws.readyState === sock.ws.OPEN) sock.ws.close(1000); else sock.ws.terminate();
  }
}

export function createRemoteDevice({ dir, cipher = plainCipher, app = '', name = '', platform = 'desktop', proxyOptions = {}, log = () => {} }) {
  const store = createDeviceStore({ dir, cipher });
  const events = new EventEmitter();
  const proxies = new Map();   // hostId -> Promise<DeviceProxy>
  const agents = new Map();    // hostId -> { link: DeviceLink, agent: AgentLink }。この PC の AI からホストへ任せる線（取り消されていないホストすべて。窓を開かなくても持つ）

  /** ホストごとの画面の殻の束（docs/remote.md §8.6）。忘れたホストの分は remove で消す */
  const staticCacheFile = hostId => path.join(dir, 'static', `${hostId}.bin`);

  async function list() {
    const hosts = await store.hosts();
    return Promise.all(hosts.map(async h => {
      const px = proxies.has(h.hostId) ? await proxies.get(h.hostId).catch(() => null) : null;
      const st = px?.status;
      const ag = agents.get(h.hostId);
      return { ...h, open: Boolean(px), state: st?.state ?? (h.revokedAt ? 'revoked' : h.reapproveAt ? 'reapprove' : 'closed'), ...(st?.hostName ? { hostName: st.hostName } : {}),
        ...(ag ? { agent: ag.agent.status, agentLinkState: ag.link.state } : {}) };
    }));
  }

  async function open(hostId, { via = 'own', relayUrl = null, getIdToken = null, getTicket = null, onReadmit = null } = {}) {
    if (proxies.has(hostId)) return proxies.get(hostId);
    const run = (async () => {
      const creds = await store.credentials(hostId, via);
      if (!creds) throw Object.assign(new Error(t('remote.device.unknownHost')), { code: 'unknown-host' });
      const activeRelayUrl = (via === 'plus' && relayUrl && creds.relayUrl !== relayUrl) ? relayUrl : creds.relayUrl;
      const activeCreds = { ...creds, relayUrl: activeRelayUrl, via };
      const keyPair = await store.keyFor(hostId, via);
      const px = new DeviceProxy({
        creds: activeCreds, keyPair, port: creds.port, app, name, shell: platform === 'desktop' ? 'desktop' : 'mobile', log,
        staticCacheFile: staticCacheFile(hostId), via, getIdToken, getTicket, onReadmit, ...proxyOptions,
      });
      px.on('status', s => {
        if (s.state === 'connected') {
          const patch = { lastConnectedAt: new Date().toISOString(), revokedAt: null, reapproveAt: null, ...(s.hostName ? { hostName: cleanLabel(s.hostName) } : {}) };
          if (via === 'plus' && creds.relayUrl !== activeRelayUrl) patch.relayUrl = activeRelayUrl;
          store.updateHost(hostId, patch, via).catch(() => {});
        }
        if (s.state === 'revoked') store.updateHost(hostId, { revokedAt: new Date().toISOString() }, via).catch(() => {});
        if (s.state === 'reapprove') store.updateHost(hostId, { reapproveAt: new Date().toISOString() }, via).catch(() => {});
        events.emit('status', { hostId, ...s });
      });
      await px.start();
      if (px.port !== creds.port) await store.updateHost(hostId, { port: px.port }, via);
      return px;
    })();
    proxies.set(hostId, run);
    run.catch(() => proxies.delete(hostId));
    return run;
  }

  // ---- この PC の AI からホストへ任せる線（docs/remote.md §4.5、ADR 0146）。端末の main が持ち、ローカルのサーバーとは parentPort の橋で話す

  /** ホストの線を張る（窓のプロキシとは別のチャネル）。取り消し済み・資格が無いホストは張らない。張った AgentLink を返す */
  async function agentOpen(hostId) {
    if (agents.has(hostId)) return agents.get(hostId).agent;
    const creds = await store.credentials(hostId);
    if (!creds || creds.revokedAt) return null;
    if (agents.has(hostId)) return agents.get(hostId).agent;
    const keyPair = await store.keyFor(hostId);
    const link = new DeviceLink({ creds, keyPair, app, name, shell: platform === 'desktop' ? 'desktop' : 'mobile', log, ...(proxyOptions.backoff ? { backoff: proxyOptions.backoff } : {}),
      ...(proxyOptions.connectTimeoutMs ? { connectTimeoutMs: proxyOptions.connectTimeoutMs } : {}) });
    const agent = new AgentLink({ link, log, ...(proxyOptions.agentRequestTimeoutMs ? { requestTimeoutMs: proxyOptions.agentRequestTimeoutMs } : {}) });
    link.on('status', s => {
      if (s.state === 'connected') store.updateHost(hostId, { lastConnectedAt: new Date().toISOString(), revokedAt: null, ...(s.hostName ? { hostName: cleanLabel(s.hostName) } : {}) }).catch(() => {});
      if (s.state === 'revoked') store.updateHost(hostId, { revokedAt: new Date().toISOString() }).catch(() => {});
    });
    agent.on('state', st => events.emit('agent-state', { hostId, ...st }));
    agents.set(hostId, { link, agent });
    agent.start();
    link.start();
    return agent;
  }

  async function agentClose(hostId) {
    const entry = agents.get(hostId);
    if (!entry) return;
    agents.delete(hostId);
    entry.agent.stop();
    entry.link.stop();
    events.emit('agent-state', { hostId, state: 'offline', allowed: false, hostName: '' });
  }

  /** hosts.json のホストに合わせて線を張る・閉じる（起動のとき・ホストが増減したとき）。任せられるかはホストの許可が決める（ADR 0239） */
  async function agentSync() {
    const hosts = await store.hosts();
    const want = new Set(hosts.filter(h => !h.revokedAt).map(h => h.hostId));
    for (const id of [...agents.keys()]) if (!want.has(id)) await agentClose(id);
    for (const id of want) await agentOpen(id).catch(e => log(`remote agent: ${e.message}`));
  }

  /** 資格を作り直したホストの、開いているプロキシ（同じ via のもの）と線を新しい資格と鍵で張り直す */
  async function reconnect(hostId, via, keyPair) {
    const creds = await store.credentials(hostId, via);
    if (!creds) return;
    if (proxies.has(hostId)) {
      const px = await proxies.get(hostId).catch(() => null);
      if (px && px.link.via === via) px.retryNow({ ...creds, via }, keyPair);
    }
    if (via === 'own' && agents.has(hostId)) agents.get(hostId).link.retryNow(creds, keyPair);
  }

  async function close(hostId) {
    const run = proxies.get(hostId);
    if (!run) return;
    proxies.delete(hostId);
    const px = await run.catch(() => null);
    await px?.close();
  }

  return {
    store,
    on: (...a) => events.on(...a),
    off: (...a) => events.off(...a),
    identity: () => store.identity(),
    list,
    /**
     * ペアリングして保存する。鍵はペアリングのたびに作る（取り消された鍵は QR でも入れず、QR は一度きりなのでやり直せない）。
     * 開いているプロキシ・線は新しい資格と鍵で張り直す
     */
    async pair(payload, { onCode, signal, timeoutMs } = {}) {
      const keyPair = generateKeyPair();
      const creds = await pairWithHost({ payload, keyPair, name, platform, app, onCode, signal, timeoutMs });
      const rec = await store.saveHost({ ...creds, keyPair });
      await reconnect(rec.hostId, 'own', keyPair);
      return rec;
    },
    open,
    /** 開いているプロキシ（無ければ null）。 */
    async proxy(hostId) { return proxies.has(hostId) ? proxies.get(hostId).catch(() => null) : null; },
    close,
    async rename(hostId, label, via = 'own') { return store.updateHost(hostId, { label: cleanLabel(label) }, via); },
    /** ペアリングを忘れる（ホストの端末一覧からは消えない。ホストで取り消す）。 */
    async remove(hostId, via = 'own') {
      await close(hostId); await agentClose(hostId);
      const remaining = (await store.hosts()).filter(h => h.hostId === hostId && (h.via ?? 'own') !== via);
      if (!remaining.length) {
        await fs.rm(staticCacheFile(hostId), { force: true }).catch(() => {});
      }
      return store.removeHost(hostId, via);
    },
    /**
     * Plus のホストに受け入れてもらい、保存する（docs/remote.md §3.4）。
     *   mode 'admit': 許可済みの鍵のつなぎ直し（窓を出さない。中継のトークンの出し直し）
     *   mode 'pair':  人の操作。許可の無い鍵は PC の承認の窓へ回り、onCode(確認コード) のあと承認を待つ
     * 鍵は Plus の記録の鍵 → 同じホストの QR の記録の鍵（許可済みなら窓を出さずに通る）→ 端末の鍵の順に使う。
     * 'pair' で鍵が取り消されていたら、新しい鍵で一度だけやり直す（PC の承認の窓へ回る）
     * ticketFor(keyPair) は、その鍵の端末の券 { relay, admission } を返す（券の無い前の版の api なら null で、idToken を使う）
     */
    async admit({ hostId, hostPublicKey, relayUrl, idToken = null, ticketFor = null, uid, mode = 'admit', onCode, signal }) {
      const keyPair = (await store.keyFor(hostId, 'plus')) ?? (await store.keyFor(hostId, 'own')) ?? (await store.identity());
      const run = async kp => {
        let ticket = null;
        if (ticketFor) {
          try { ticket = await ticketFor(kp); } catch (e) { throw typeof e?.status === 'number' ? ticketIssueError(e) : e; }
        }
        return admitWithHost({ hostId, hostPublicKey, relayUrl, keyPair: kp, idToken, ticket, name, platform, app, mode, onCode, signal });
      };
      let used = keyPair, creds;
      try { creds = await run(keyPair); }
      catch (e) {
        if (!(mode === 'pair' && e.code === 'revoked')) throw e;
        used = generateKeyPair();
        creds = await run(used);
      }
      const rec = await store.saveHost({ ...creds, via: 'plus', uid, keyPair: used });
      if (mode === 'pair') await reconnect(hostId, 'plus', used);
      return rec;
    },
    async closeAll() { await Promise.all([...proxies.keys()].map(close)); await Promise.all([...agents.keys()].map(agentClose)); },
    agentSync,
    /** 張ってある線（無ければ null） */
    agent: hostId => agents.get(hostId)?.agent ?? null,
  };
}
