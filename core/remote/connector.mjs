// ホストの接続口（docs/remote.md §3.3・§4.2・§4.4・§6.1・§6.4、issue #13）。サーバーのプロセスの中で動く。
//
// - 中継への制御用の接続は「つながり（link）」の単位で持つ（§6.4）。自分の中継（own）と、差し込まれた provider の
//   中継（plus）を同時に張れ、link ごとに状態・張り直し・ping・accept を持つ。片方が落ちてももう片方は動き続ける
// - 中継へ外向きに制御用の WebSocket を張り（/v1/host）、つながるたびにその link が引き受ける端末一覧のハッシュを sync で送り直す。
//   切れたら 1 秒から 60 秒まで倍々（揺らぎ付き）で張り直す
// - 中継の incoming ごとにデータ用の接続（/v1/host/accept）を張り、Noise の応答側としてハンドシェイクする。
//   通常は IK（端末の静的鍵が端末一覧にあり、中継が名乗った deviceId の鍵と一致すること）、ペアリングは IKpsk2
// - 確立したら channel.mjs のチャネルに載せ、ストリームを forward.mjs の防火壁を通して既存サーバーへ流す
// - ペアリング: 入場券を中継に登録 → QR → IKpsk2 → 承認待ち（確認コード）→ 承認で deviceId と中継用トークンを発行
// - 審査の招待（ADR 0172）: 審査モードのホストだけが、長く使えて人の承認なしで通る招待を持てる。同じ秘密から導いた入場券を
//   使われるたびと 4 分ごとに中継へ置き直し、端末を台数と回数の上限の中で自動で登録する。招待の記録は秘密の置き場にあり、
//   CLI（core/review-invite.mjs）が作る・取り消す。ホストは記録を読み直して、消えた・切れた・作り直された招待で入った端末を取り消す
// - 既定は無効。有効にするまで何もつながない（鍵も作らない）
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { Handshake, prologueFor, derivePairing, confirmationCode } from './noise.mjs';
import { Channel } from './channel.mjs';
import { forwardStream, checkPath } from './forward.mjs';
import { RESET_CODE } from './frames.mjs';
import { AGENT_PATH } from './agent-protocol.mjs';
import { createRemoteStore } from './devices.mjs';
import { t } from '../i18n.mjs';
import { normalizeRelayUrl, relayWsUrl, pairingPayload, cleanLabel, PAIRING_TTL_MS } from './pairing.mjs';
import {
  isReviewMode, loadInvite, inviteDaysLeft, checkAdmission, INVITE_KEY, INVITE_MAX_DEVICES, INVITE_MAX_PER_HOUR,
  INVITE_RATE_WINDOW_MS, INVITE_REPLACE_MS, INVITE_POLL_MS, INVITE_LOG_MS,
} from './review-invite.mjs';
import { parseNotifyKey } from '../notify/crypto.mjs';
import { normalizeDeviceSettings } from '../notify/policy.mjs';

/** ホストが閉じるときの close code。中継は 3000–4999 をそのまま端末へ渡す（§5.1）。 */
export const HOST_CLOSE = Object.freeze({ BAD_REQUEST: 4400, UNAUTHORIZED: 4401, TIMEOUT: 4408, SHUTDOWN: 1001 });
const CONN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const STABLE_MS = 10_000;
const CONTROL_PING_MS = 30_000;
const DATA_MAX_PAYLOAD = 70_000;

function describeClose(code) {
  switch (code) {
    case 4400: return t('remote.relay.closed.badRequest');
    case 4401: return t('remote.relay.closed.unauthorized');
    case 4409: return t('remote.relay.closed.replaced');
    case 4429: return t('remote.relay.closed.full');
    case 1001: return t('remote.relay.closed.shutdown');
    case 1006: return t('remote.relay.closed.lost');
    default: return t('remote.relay.closed.other', { code });
  }
}

function closeWs(ws, code, reason = '') {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try { ws.close(code, reason); } catch { ws.terminate(); return; }
  setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 2000).unref();
}

/** 通知の状態（スマホへの通知。設定 › 通知の「スマホ」の一覧に出す）。鍵は出さない。 */
function publicNotify(d, registered) {
  const n = d.notify ?? {};
  return { registered, enabled: registered && n.settings?.enabled === true, muted: n.muted === true, lastSentAt: n.lastSentAt ?? null };
}

/**
 * 端末の AI からの委譲（docs/remote.md §4.5）。デスクトップ版の端末だけが対象（スマホには AI が無い）。stats は { active, waiting }（任された作業の数）。
 * 許可は「ほかの端末からの操作を許可する」の 1 つにまとめた（ADR 0239）。enabled は available と同じ（前の版の画面のために残す）
 */
function publicAgent(d, stats) {
  const available = d.platform === 'desktop';
  return { available, enabled: available, active: stats?.active ?? 0, waiting: stats?.waiting ?? 0 };
}

/**
 * もう一度の許可が要る端末か。via:'plus' で許可した機器の記録が無いものは、前の版で確認コードなしに入った端末（ADR 0248）。
 * もう一度の許可が済むまで、操作を通さない
 */
const needsReapproval = d => Boolean(d) && d.via === 'plus' && !d.approvedBy;

function publicDevice(d, connections = 0, registered = false, agentStats = null, nameOf = () => null) {
  return {
    id: d.id, name: d.name, platform: d.platform, app: d.app ?? null, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null,
    via: d.via ?? 'own',
    approvedBy: d.approvedBy ?? null,
    approvedByName: d.approvedBy && d.approvedBy !== 'host' ? nameOf(d.approvedBy) : null,
    ...(needsReapproval(d) ? { reapprove: true } : {}),
    connected: connections > 0, connections, notify: publicNotify(d, registered), agent: publicAgent(d, agentStats),
    ...(d.invite ? { invite: true } : {}),
  };
}

/** 取り消した端末（設定 › リモートの「取り消した端末」）。key は「一覧から消す」に使う公開鍵。 */
function publicRevoked(k, nameOf) {
  return {
    key: k.publicKey, name: k.name ?? '', platform: k.platform ?? null, via: k.via ?? 'own',
    createdAt: k.createdAt ?? null, revokedAt: k.revokedAt,
    by: k.by ?? 'host', byName: k.by && k.by !== 'host' ? nameOf(k.by) : null,
    approvedBy: k.approvedBy ?? null, approvedByName: k.approvedBy && k.approvedBy !== 'host' ? nameOf(k.approvedBy) : null,
  };
}

/**
 * この端末の AI からの依頼を受けてよいか。一覧にあるデスクトップ版の端末なら受ける（ADR 0239）。
 * つないだ端末は人の操作でこの PC のすべての操作ができるので、AI の依頼を別に止めても許すことは狭まらない。
 * 前の版が devices.json に書いた agentDelegation は読まない
 */
const agentAllowed = d => Boolean(d) && d.platform === 'desktop';

/** デスクトップ版の端末以外（スマホ）。通知を受ける相手。 */
const isMobile = d => d.platform !== 'desktop';
const NOTIFY_PERSIST_MS = 60_000;

/** 拒否した鍵が同じ PC へもう一度申し込めるまで（Plus からの申し込み）。 */
const DENY_COOLDOWN_MS = 60 * 60_000;
/**
 * 公式の中継からの申し込みを続けて断ったら、承認の窓を出すのを止める（PC とアカウントの uid ごと。鍵を作り直しても数える）。
 * 1 時間に 3 回断ると 1 時間止める。止めている間は PC の画面に一行と「再開する」を出す
 */
const PLUS_DENY_LIMIT = 3;
const PLUS_DENY_WINDOW_MS = 60 * 60_000;
const PLUS_PAUSE_MS = 60 * 60_000;

function publicRequest(r) {
  return {
    id: r.id, name: r.name, platform: r.platform, app: r.app, code: r.code, createdAt: r.createdAt, expiresAt: r.expiresAt,
    via: r.link?.name ?? 'own',
    ...(r.again ? { again: true, addedAt: r.addedAt ?? null } : {}),
  };
}

function parseJson(buf) {
  try { const v = JSON.parse(Buffer.from(buf).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

/**
 * @param dataDir     store.dataDir
 * @param cipher      秘密の暗号器（server の secretCipher）
 * @param target      () => ({ host, port })。ホストの既存サーバー（listen 後に呼ぶ）
 * @param token       ホストの UI トークン（接続口が差し込む。外には出さない）
 * @param appVersion  HELLO の app
 * @param emit        (event) => void。{ type: 'remoteStatus' | 'remotePairing', ... } を画面へ配る
 * @param env         AGENT_HOST_RELAY_URL / AGENT_HOST_RELAY_SECRET（設定が空のときの代わり）
 * @param agent       端末の AI 用の口 /agent（core/remote/agent-port.mjs と、server が足す stats・stopTasks）。無ければ /agent は受けない
 * @param now         審査の招待の期限と回数の数え方に使う時計（試験で進める）
 * @param reviewLimits 審査の招待の上限 { maxDevices, perHour }（既定は 8 台・1 時間 4 台。試験で変える）
 */
export function createRemoteHost({
  dataDir, cipher, target, token, appVersion = '', emit = () => {}, env = process.env,
  backoff = { minMs: 1000, maxMs: 60_000 }, log = () => {}, agent = null,
  now = Date.now, reviewLimits = {}, onIdentity = null,
}) {
  const limits = { maxDevices: reviewLimits.maxDevices ?? INVITE_MAX_DEVICES, perHour: reviewLimits.perHour ?? INVITE_MAX_PER_HOUR };
  const store = createRemoteStore({ dataDir, cipher });
  let cfg = { enabled: false, relayUrl: '', secret: '', hostName: os.hostname(), relayUrlFromEnv: false, secretFromEnv: false, plusConnect: false };
  let identity = null;
  let plusHostState = null;   // この PC の Pleiad Plus への登録の状態（core/plus/hosts.mjs が setPlusHostState で渡す）
  let offer = null;                // { secret, psk, ticketHash, expiresAt, timer }
  const requests = new Map();      // id → 承認待ち
  const deviceCache = new Map();   // id → devices.json の 1 件（照合は同期で行う）
  const revokedKeys = new Map();   // 公開鍵 → revoked.json の 1 件（取り消した鍵。照合は同期で行う）
  const deniedUntil = new Map();   // 公開鍵 → 拒否した鍵がもう一度申し込める時刻（ms。Plus からの申し込み）
  let plusRequests = { version: 1, accounts: {} };   // plus-requests.json の写し（断った時刻と、申し込みを止めている期限。uid ごと）
  let plusPauseTimer = null;       // 止めている期限が来たら状態を配り直す
  const notifyKeys = new Map();    // deviceId → 通知鍵（Buffer）。スマホへの通知を暗号化する（core/notify）
  const notifyPersisted = new Map();   // deviceId → lastSentAt を最後にファイルへ書いた時刻
  const channels = new Map();      // deviceId → Set<{ ch, ws, link }>
  let applying = Promise.resolve();
  let statusQueued = false;
  let invite = null;               // 今使える審査の招待（loadInvite の結果）。審査モードでなければ常に null
  let inviteChain = Promise.resolve();   // 招待の読み直しと自動の承認を 1 つずつ（台数と回数の数え間違いを防ぐ）
  const inviteTimers = [];
  const admitted = [];             // 招待で通した時刻（ms）。起動し直すと消えるが、直近 1 時間の数は devices.json の createdAt からも数える

  // ── つながり（link）の単位 ─────────────────────────────────
  // 1 本ぶんの状態: phase（disabled | connecting | connected | retrying | error）・error・since・retryAt・
  // generation・control・attempt・retryTimer・pingTimer・dataConns。
  // 中継の URL・張るときのヘッダー・引き受ける端末・ペアリングを受けるかは provider が決める:
  //   { name, ready(), url(path), headers({ accept }), owns(device), allowPairing, onIncomingAdmit?(ctx), onOpen?(headers), onClose?(code, reason) }
  // 試みは 1 本ずつ（inFlight）。headers() を待つ間も張る途中で、見直しが来ても別の試みを重ねない。
  // onOpen(headers) は、制御の接続が開いた試みのヘッダーを渡す（捨てた試みのヘッダーは渡らない。accept はこれを使う）。
  // headers() が linkError（{ code, message }）の付いた誤りを投げたら、張り直さずに error で止まる。
  // linkRetry（{ code, message }）なら、その誤りを出して今の backoff で張り直す（待つ）。
  // onClose() は null・'retry'（今と同じ張り直し）・{ error }（止まる）・{ retry: { code, message } }（その誤りを出して待つ）を返す。
  const ownProvider = {
    name: 'own',
    /** 張ってよいか。true / false（disabled）/ { error }（error）。 */
    ready() {
      if (!cfg.relayUrl || !cfg.secret) return { error: { code: 'config', message: t('remote.settings.needConfig') } };
      try { relayWsUrl(cfg.relayUrl, '/v1/host'); } catch (e) { return { error: { code: 'config', message: e.message } }; }
      return true;
    },
    url: path => relayWsUrl(cfg.relayUrl, path),
    headers: async () => ({ authorization: `Bearer ${cfg.secret}`, 'x-pleiad-host': identity.hostId }),
    owns: d => !d.via || d.via === 'own',
    allowPairing: true,
  };
  const makeLink = (name, provider) => ({
    name, provider,
    phase: 'disabled', error: null, since: Date.now(), retryAt: null,
    generation: 0, control: null, controlOpenedAt: 0, attempt: 0, inFlight: null,
    retryTimer: null, pingTimer: null, dataConns: new Set(),
  });
  const links = { own: makeLink('own', ownProvider), plus: makeLink('plus', null) };
  const eachLink = fn => { fn(links.own); fn(links.plus); };
  /** 端末を引き受ける link（via の無い端末は own）。 */
  const linkFor = d => (d?.via === 'plus' ? links.plus : links.own);

  const setLinkPhase = (link, next, err = null) => {
    if (link.phase !== next) link.since = Date.now();
    link.phase = next;
    link.error = err;
    queueStatus();
  };

  /** provider の ready() を状態に写す。張ってよい link なら true。 */
  function linkWanted(link) {
    // plus.connect を切った設定は、provider がまだ知らなくても張らない（切るときに一度張り直してから止まらないよう）
    if (link === links.plus && !cfg.plusConnect) { setLinkPhase(link, 'disabled'); return false; }
    const r = link.provider?.ready() ?? false;
    if (r === true) return true;
    setLinkPhase(link, r && typeof r === 'object' ? 'error' : 'disabled', r && typeof r === 'object' ? r.error ?? null : null);
    return false;
  }

  function queueStatus() {
    if (statusQueued) return;
    statusQueued = true;
    queueMicrotask(async () => {
      statusQueued = false;
      try { emit({ type: 'remoteStatus', status: await status() }); } catch (e) { log(`remote status: ${e.message}`); }
    });
  }

  async function loadConfig() {
    const s = await store.settings();
    const relayUrl = s.relayUrl || env.AGENT_HOST_RELAY_URL || '';
    // 秘密を読めない（locked）ときも、保存した許可・中継の URL は状態に出す（スイッチが保存した値と食い違って「オフ」に見えないように）
    cfg = { ...cfg, enabled: s.enabled, relayUrl, relayUrlFromEnv: !s.relayUrl && Boolean(env.AGENT_HOST_RELAY_URL), plusConnect: s.plus?.connect !== false };
    const secretStored = await store.enrollSecret();
    cfg = {
      enabled: s.enabled,
      relayUrl,
      secret: secretStored || env.AGENT_HOST_RELAY_SECRET || '',
      hostName: s.hostName || os.hostname(),
      relayUrlFromEnv: !s.relayUrl && Boolean(env.AGENT_HOST_RELAY_URL),
      secretFromEnv: !secretStored && Boolean(env.AGENT_HOST_RELAY_SECRET),
      plusConnect: s.plus?.connect !== false,
    };
    deviceCache.clear();
    notifyKeys.clear();
    revokedKeys.clear();
    for (const k of await store.revokedKeys()) revokedKeys.set(k.publicKey, k);
    plusRequests = await store.plusRequests();
    schedulePlusPause();
    for (const d of await store.devices()) {
      deviceCache.set(d.id, d);
      if (d.notify) {
        const key = parseNotifyKey(await store.notifyKey(d.id).catch(() => null));
        if (key) notifyKeys.set(d.id, key);
      }
    }
    return cfg;
  }

  // ── 中継への制御用の接続 ──────────────────────────────────────

  function sendControl(link, msg) {
    if (link.control?.readyState === WebSocket.OPEN) link.control.send(JSON.stringify(msg));
  }

  /** その link が引き受ける（owns）端末だけを sync する。ペアリングの入場券と審査の招待は、受ける link（own）にだけ置く。 */
  function syncDevices(link) {
    sendControl(link, { type: 'sync', devices: [...deviceCache.values()].filter(d => link.provider.owns(d)).map(d => ({ id: d.id, tokenHash: d.tokenHash })) });
    if (!link.provider.allowPairing) return;
    if (offer && offer.expiresAt > Date.now()) {
      sendControl(link, { type: 'pairing', ticketHash: offer.ticketHash.toString('hex'), ttlMs: offer.expiresAt - Date.now() });
    }
    placeInviteTicket(link);
  }

  async function connect(link) {
    const gen = link.generation;
    link.inFlight = gen;
    const settle = () => { if (link.inFlight === gen) link.inFlight = null; };
    let url;
    try { url = link.provider.url('/v1/host'); }
    catch (e) { scheduleRetry(link, { code: 'config', message: e.message }); return; }
    let headers;
    try { headers = await link.provider.headers(); }
    catch (e) {
      // 張り直しても直らない誤り（plus の券で台帳に無い・更新が要る）は error で止まる
      if (e?.linkError) { if (gen === link.generation) { settle(); setLinkPhase(link, 'error', e.linkError); } return; }
      // 一時的な失敗（plus のトークンの取り直しが届かない・Plus が止まっているなど）で止まらないよう張り直す
      if (gen === link.generation) scheduleRetry(link, e?.linkRetry ?? { code: 'config', message: e.message });
      return;
    }
    if (gen !== link.generation) return;
    setLinkPhase(link, link.attempt ? 'retrying' : 'connecting', link.error);
    let ws;
    try {
      ws = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 15_000, maxPayload: 1024 * 1024, followRedirects: false });
    } catch (e) { scheduleRetry(link, { code: 'config', message: e.message }); return; }
    link.control = ws;
    let failure = null;
    let settled = false;   // この試みの行き先（張り直し・断念）は 1 回だけ決める
    const retryOnce = err => {
      if (settled || gen !== link.generation) return;
      settled = true;
      if (link.control === ws) link.control = null;
      log(`remote: ${err.message}`);
      scheduleRetry(link, err);
    };
    ws.on('unexpected-response', (req, res) => {
      // 101 でない応答（中継が立つ前に前段が 502 などを返す・遮断の 429 など）。ws はこのあと 'close' を
      // 出さない（socket が張られる前なので）。ここで張り直しを予定しないと link は二度と張り直さない
      failure = res.statusCode === 429 ? t('remote.relay.rateLimited') : t('remote.relay.rejected', { status: res.statusCode });
      res.resume();
      req.destroy();
      retryOnce({ code: `relay-http-${res.statusCode}`, message: failure });
    });
    ws.on('error', e => { failure ??= t('remote.relay.unreachable', { reason: e.code || e.message }); });
    ws.on('open', () => {
      if (gen !== link.generation) return closeWs(ws, 1000);
      settle();
      link.controlOpenedAt = Date.now();
      link.provider?.onOpen?.({ ...headers });
      link.retryAt = null;
      syncDevices(link);
      setLinkPhase(link, 'connected');
      clearInterval(link.pingTimer);
      let missed = 0;
      ws.on('pong', () => { missed = 0; });
      link.pingTimer = setInterval(() => {
        if (missed >= 2) return ws.terminate();
        missed++;
        try { ws.ping(); } catch { /* 閉じかけ */ }
      }, CONTROL_PING_MS);
      link.pingTimer.unref();
    });
    ws.on('message', (data, isBinary) => {
      if (gen !== link.generation || isBinary) return;
      const msg = parseJson(data);
      if (msg.type === 'incoming') onIncoming(link, msg).catch(e => log(`remote incoming: ${e.message}`));
    });
    ws.on('close', (code, reason) => {
      if (link.control === ws) link.control = null;
      clearInterval(link.pingTimer);
      if (settled || gen !== link.generation) return;
      const stable = link.controlOpenedAt && Date.now() - link.controlOpenedAt > STABLE_MS;
      if (stable) link.attempt = 0;
      link.controlOpenedAt = 0;
      // provider が close の扱いを変えたいとき（plus 側の断りを張り直しにしないなど）。'retry' か無ければ今と同じ張り直し
      const verdict = link.provider?.onClose?.(code, Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '')) ?? null;
      if (verdict?.retry) return retryOnce(verdict.retry);
      if (verdict && verdict !== 'retry') { settled = true; settle(); setLinkPhase(link, 'error', verdict.error ?? null); return; }
      retryOnce({ code: `relay-${code}`, message: failure ?? describeClose(code) });
    });
  }

  function scheduleRetry(link, err) {
    const base = Math.min(backoff.maxMs, backoff.minMs * 2 ** link.attempt);
    const delay = Math.round(Math.min(backoff.maxMs, base * (0.75 + Math.random() * 0.5)));
    link.attempt++;
    link.inFlight = null;
    link.retryAt = Date.now() + delay;
    setLinkPhase(link, 'retrying', err);
    const gen = link.generation;
    clearTimeout(link.retryTimer);
    link.retryTimer = setTimeout(() => { if (gen === link.generation) connect(link); }, delay);
    link.retryTimer.unref?.();
  }

  /** 1 本のつながりを閉じる（制御用の接続と、その link が受けたデータ用の接続・チャネル）。 */
  function disconnectLink(link) {
    link.generation++;
    clearTimeout(link.retryTimer);
    clearInterval(link.pingTimer);
    link.retryTimer = null;
    link.retryAt = null;
    link.attempt = 0;
    if (link.control) { closeWs(link.control, 1000); link.control = null; }
    for (const set of channels.values()) for (const { ch, link: l } of set) if (l === link) ch.goaway('shutdown', 'remote stopped');
    for (const ws of link.dataConns) closeWs(ws, HOST_CLOSE.SHUTDOWN);
    link.dataConns.clear();
  }

  /** 全部のつながりとデータ用の接続を閉じる。 */
  function disconnectAll() {
    eachLink(disconnectLink);
    clearOffer(false);
    stopInviteTimers();
  }

  // ── データ用の接続 ────────────────────────────────────────────

  async function onIncoming(link, { conn, deviceId, pairing, admit }) {
    if (typeof conn !== 'string' || !CONN_ID.test(conn) || !identity) return;
    const gen = link.generation;
    let url;
    try { url = link.provider.url(`/v1/host/accept?conn=${encodeURIComponent(conn)}`); }
    catch (e) { log(`remote accept: ${e.message}`); return; }
    let headers;
    try { headers = await link.provider.headers({ accept: true }); }
    catch (e) { log(`remote accept: ${e.message}`); return; }
    if (gen !== link.generation) return;
    let ws;
    try {
      ws = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 15_000, maxPayload: DATA_MAX_PAYLOAD, followRedirects: false });
    } catch (e) { log(`remote accept: ${e.message}`); return; }
    link.dataConns.add(ws);
    ws.on('error', () => {});
    ws.on('unexpected-response', (req, res) => { res.resume(); req.destroy(); link.dataConns.delete(ws); });
    ws.on('close', () => link.dataConns.delete(ws));
    const timer = setTimeout(() => closeWs(ws, HOST_CLOSE.TIMEOUT, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    ws.once('open', () => { if (gen !== link.generation) closeWs(ws, HOST_CLOSE.SHUTDOWN); });
    if (pairing === true) {
      // ペアリング（入場券）の incoming を受けない link では閉じる
      if (!link.provider.allowPairing) { ws.once('open', () => closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'pairing')); return; }
      handlePairing(link, ws, timer);
      return;
    }
    // admit: true で deviceId の無い incoming は、その link の provider が受け入れを担う（アカウントでの受け入れ）
    if (admit === true && !deviceId) {
      if (typeof link.provider.onIncomingAdmit === 'function') {
        Promise.resolve(link.provider.onIncomingAdmit(admitCtx(link, ws, conn, timer)))
          .catch(e => { log(`remote admit: ${e.message}`); closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'admit'); });
      } else {
        ws.once('open', () => closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'admit'));
      }
      return;
    }
    handleDevice(link, ws, typeof deviceId === 'string' ? deviceId : '', timer);
  }

  /**
   * onIncomingAdmit へ渡す一式。provider が Noise の応答・検証・登録・返事を済ませて閉じる。
   * 新しい鍵を通すのは request（PC の画面の承認の窓）だけ。admitKnown は許可済みの鍵に中継用トークンを出し直すだけ
   */
  function admitCtx(link, ws, conn, timer) {
    return {
      link: link.name, ws, conn, timer,
      identity, hostName: cfg.hostName,
      /** 取り消した鍵か（台帳や中継の資格に関係なく通さない）。 */
      isRevoked: publicKey => revokedKeys.has(keyText(publicKey)),
      /** 拒否してから 1 時間たっていない鍵か。 */
      deniedRecently: publicKey => (deniedUntil.get(keyText(publicKey)) ?? 0) > now(),
      /** このアカウントからの申し込みを止めているか（続けて断ったとき。PC の画面の「再開する」で解く）。 */
      plusPaused: uid => plusPausedUntil(uid) > 0,
      /** この鍵の端末の記録（無ければ null）。この link のもの（plus）を先に、無ければ own を返す。 */
      deviceFor(publicKey) {
        const key = keyText(publicKey);
        const all = [...deviceCache.values()].filter(d => d.publicKey === key);
        return all.find(d => (d.via ?? 'own') === link.name) ?? all[0] ?? null;
      },
      /**
       * 許可済みの鍵（PC の画面か許可済みの端末で許可したもの）に、この link の中継用トークンを出し直す。
       * この link の記録があれば同じ id のまま、無ければ（QR で足した端末が Plus から来た）許可の記録を写した記録を作る。
       * 許可済みでなければ null（承認の窓へ回す）
       */
      async admitKnown({ name, platform, app, publicKey, plusUid }) {
        const key = keyText(publicKey);
        if (revokedKeys.has(key)) return null;
        const all = [...deviceCache.values()].filter(d => d.publicKey === key && !d.invite);
        const approved = all.filter(d => !needsReapproval(d));
        if (!approved.length) return null;
        const mine = all.find(d => (d.via ?? 'own') === link.name);
        const src = mine && !needsReapproval(mine) ? mine : approved[0];
        const approval = { approvedBy: src.approvedBy ?? 'host', approvedAt: src.approvedAt ?? src.createdAt ?? new Date(now()).toISOString() };
        const raw = crypto.randomBytes(32);
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        let device;
        if (mine) {
          const patch = { tokenHash, ...(link.name === 'plus' && plusUid ? { plusUid } : {}), ...(needsReapproval(mine) ? approval : {}) };
          if (!(await store.updateDevice(mine.id, patch))) return null;
          device = Object.assign(mine, patch);
        } else {
          device = { ...issueDevice({ name, platform, app, publicKey }, { via: link.name, plusUid }).device, ...approval, tokenHash };
          await store.addDevice(device);
        }
        deviceCache.set(device.id, device);
        sendControl(link, { type: 'allow', id: device.id, tokenHash: device.tokenHash });
        queueStatus();
        return { device, token: raw.toString('base64url') };
      },
      /**
       * PC の画面の承認の窓へ回す（QR と同じ窓・同じ確認コード）。許可されると端末へ approved を送り、onApproved(device) を呼ぶ。
       * 同じ鍵の申し込みは 1 つまで（前のものを切って置き換える）。5 分で切れる。
       * again は、もう一度の許可が要る端末の記録（同じ id のまま許可し直す）
       */
      request({ name, platform, app, publicKey, plusUid, code, send, onApproved }) {
        const key = keyText(publicKey);
        for (const r of [...requests.values()]) if (keyText(r.publicKey) === key) finishRequest(r, 'cancelled');
        const again = [...deviceCache.values()].find(d => d.publicKey === key && needsReapproval(d)) ?? null;
        return openRequest({ name, platform, app }, { publicKey: Buffer.from(publicKey), code, ws, send, link, timer: null, plusUid, again, onApproved });
      },
      /** 端末をこの link のものとして登録し、中継へ allow を送る（試験の provider 用。approvedBy を渡さなければ、もう一度の許可が要る端末になる）。 */
      async admit({ name, platform, app, publicKey, plusUid, approvedBy }) {
        const { device, raw } = issueDevice({ name, platform, app, publicKey }, { via: link.name, plusUid, approvedBy });
        await store.addDevice(device);
        deviceCache.set(device.id, device);
        sendControl(link, { type: 'allow', id: device.id, tokenHash: device.tokenHash });
        queueStatus();
        return { device, token: raw.toString('base64url') };
      },
    };
  }

  const keyText = publicKey => (Buffer.isBuffer(publicKey) || publicKey instanceof Uint8Array ? Buffer.from(publicKey).toString('base64url') : String(publicKey ?? ''));

  /** 最初のメッセージ（Noise のメッセージ 1）を受けて fn に渡す。文字のメッセージは形の誤り。 */
  function firstMessage(ws, fn) {
    ws.once('message', (data, isBinary) => {
      if (!isBinary) return closeWs(ws, HOST_CLOSE.BAD_REQUEST, 'binary expected');
      try { fn(Buffer.from(data)); }
      catch (e) { log(`remote handshake: ${e.message}`); closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'handshake'); }
    });
  }

  function handleDevice(link, ws, deviceId, timer) {
    const device = deviceCache.get(deviceId);
    // 届いた link が引き受けない端末は受けない（own で登録した端末が plus から来ても、その逆でも）
    if (!device || !link.provider.owns(device)) {
      clearTimeout(timer);
      ws.once('open', () => closeWs(ws, HOST_CLOSE.UNAUTHORIZED, device ? 'revoked' : 'unknown device'));
      return;
    }
    firstMessage(ws, m1 => {
      const hs = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor(identity.hostId), staticKey: identity });
      hs.readMessage(m1);
      // 中継が名乗った deviceId の鍵と、ハンドシェイクで証明された鍵が一致し、今も一覧にあること（取り消しの二重の守り）
      const current = deviceCache.get(deviceId);
      if (!current || !link.provider.owns(current) || !hs.remoteStatic.equals(Buffer.from(current.publicKey, 'base64url'))
        || revokedKeys.has(current.publicKey)) {
        clearTimeout(timer);
        return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'revoked');
      }
      // 前の版で確認コードなしに入った端末は、もう一度の許可が済むまで通さない。中継は理由を端末へ渡さないので、
      // 端末は受け入れをやり直して { denied, reason: 'approval' } で知る（ADR 0248）
      if (needsReapproval(current)) {
        clearTimeout(timer);
        return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'reapprove');
      }
      ws.send(hs.writeMessage());
      clearTimeout(timer);
      const ch = new Channel({
        role: 'host', transport: hs.split(), send: b => ws.send(b),
        hello: { app: appVersion, hostName: cfg.hostName }, bufferedAmount: () => ws.bufferedAmount,
      });
      const entry = { ch, ws, link };
      if (!channels.has(deviceId)) channels.set(deviceId, new Set());
      channels.get(deviceId).add(entry);
      ws.on('message', b => ch.receive(b));
      ch.on('stream', s => {
        // 端末の AI 用の口は接続口が自分で受ける（ローカルのサーバーへは転送しない。docs/remote.md §4.5）
        if (s.kind === 'ws' && checkPath(s.request?.path)?.pathname === AGENT_PATH) {
          const current = deviceCache.get(deviceId);
          if (!agent || !current) return s.reset(RESET_CODE.FORBIDDEN);
          return agent.attach(s, { id: deviceId, name: current.name, platform: current.platform });
        }
        forwardStream(s, { target, token, device: { id: deviceId, platform: device.platform } });
      });
      ch.on('close', err => closeWs(ws, err?.code === 'revoked' ? HOST_CLOSE.UNAUTHORIZED : err?.code === 'shutdown' ? HOST_CLOSE.SHUTDOWN : 1000));
      ws.on('close', () => {
        ch.close();
        const set = channels.get(deviceId);
        set?.delete(entry);
        if (set && !set.size) channels.delete(deviceId);
        touch(deviceId);
      });
      ch.start();
      touch(deviceId);
    });
  }

  function touch(deviceId) {
    const at = new Date().toISOString();
    const d = deviceCache.get(deviceId);
    if (d) d.lastSeenAt = at;
    store.touchDevice(deviceId, at).catch(() => {}).finally(queueStatus);
  }

  // ── ペアリング ────────────────────────────────────────────────

  function clearOffer(tellRelay) {
    if (!offer) return;
    clearTimeout(offer.timer);
    offer = null;
    if (tellRelay) eachLink(l => { if (l.provider?.allowPairing) sendControl(l, { type: 'pairing', ticketHash: null }); });
    queueStatus();
  }

  function handlePairing(link, ws, timer) {
    const o = offer && offer.expiresAt > Date.now() ? offer : null;
    // 入場券は 1 回きり（中継も消している）。次は作り直す
    clearOffer(false);
    // 画面から作った入場券が無ければ、審査の招待（あれば）。中継は使われた入場券を消したので、すぐ置き直す
    const inv = !o && invite && invite.expiresAt > now() ? invite : null;
    if (inv) placeInviteTicket();
    if (!o && !inv) {
      clearTimeout(timer);
      ws.once('open', () => closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'no pairing'));
      return;
    }
    if (!inv) emit({ type: 'remotePairing', phase: 'connecting' });
    firstMessage(ws, m1 => {
      const hs = new Handshake({ pattern: 'IKpsk2', initiator: false, prologue: prologueFor(identity.hostId), staticKey: identity, psk: (o ?? inv).psk });
      const hello = parseJson(hs.readMessage(m1));
      ws.send(hs.writeMessage());
      const transport = hs.split();
      const code = confirmationCode(hs.handshakeHash);
      const publicKey = Buffer.from(hs.remoteStatic);
      // 次の 1 通を復号できれば psk を持っていた（QR を読んだ）端末。ここで初めて承認を尋ねる
      ws.once('message', data => {
        let msg;
        try { msg = parseJson(transport.decrypt(Buffer.from(data))); } catch { msg = null; }
        clearTimeout(timer);
        if (msg?.type !== 'pair') return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'pairing');
        const label = {
          name: cleanLabel(hello.name) || t('remote.unnamedDevice'),
          platform: cleanLabel(hello.platform, 32) || 'unknown',
          app: cleanLabel(hello.app, 32) || null,
        };
        const send = obj => { if (ws.readyState === WebSocket.OPEN) ws.send(transport.encrypt(Buffer.from(JSON.stringify(obj), 'utf8'))); };
        // 取り消した鍵は、QR を読んでいても通さない（端末は鍵を作り直してペアリングし直す）
        if (revokedKeys.has(publicKey.toString('base64url'))) {
          send({ type: 'denied', reason: 'revoked' });
          return closeWs(ws, 1000);
        }
        // 審査の招待は確認コードの見比べも承認の待ちも無い。上限の中なら、ここで登録して終える
        if (inv) return admitInvite(inv, { ...label, publicKey, ws, send }, link);
        openRequest(label, { publicKey, code, ws, send, link });
      });
    });
  }

  /**
   * 承認待ちを作り、PC の画面の承認の窓へ出す（QR と Plus で共通）。
   * extra: { publicKey, code, ws, send, link, plusUid?, again?, onApproved? }
   */
  function openRequest(label, extra) {
    const at = Date.now();
    const r = {
      id: crypto.randomBytes(9).toString('base64url'),
      ...label,
      createdAt: new Date(at).toISOString(), expiresAt: new Date(at + PAIRING_TTL_MS).toISOString(),
      ...extra,
      again: extra.again?.id ?? null,
      addedAt: extra.again?.createdAt ?? null,
      timer: null,
    };
    r.timer = setTimeout(() => finishRequest(r, 'expired'), PAIRING_TTL_MS);
    r.timer.unref();
    requests.set(r.id, r);
    r.ws.on('close', () => {
      if (requests.get(r.id) !== r) return;
      finishRequest(r, 'cancelled');
    });
    emit({ type: 'remotePairing', phase: 'request', request: publicRequest(r) });
    queueStatus();
    return r;
  }

  // ── 公式の中継からの申し込みを続けて断ったとき ──────────────────

  /** このアカウントからの申し込みを止めている期限（ms）。止めていなければ 0 */
  function plusPausedUntil(uid) {
    const until = Date.parse(plusRequests.accounts[String(uid ?? '')]?.pausedUntil ?? '');
    return Number.isFinite(until) && until > now() ? until : 0;
  }
  function plusPausedStatus() {
    const until = Math.max(0, ...Object.keys(plusRequests.accounts).map(plusPausedUntil));
    return until ? { until: new Date(until).toISOString() } : null;
  }
  /** 止めている期限が来たら、状態を配り直す（画面の一行を消す） */
  function schedulePlusPause() {
    clearTimeout(plusPauseTimer);
    plusPauseTimer = null;
    const until = Date.parse(plusPausedStatus()?.until ?? '');
    if (!Number.isFinite(until)) return;
    plusPauseTimer = setTimeout(() => { plusPauseTimer = null; queueStatus(); }, Math.max(0, until - now()) + 50);
    plusPauseTimer.unref?.();
  }
  /** 公式の中継からの申し込みを断った。直近 1 時間に 3 回目なら、このアカウントからの申し込みを 1 時間止め、待っている窓も閉じる */
  async function countPlusDenial(uid) {
    if (!uid) return;
    const at = now();
    const entry = plusRequests.accounts[uid] ?? { denials: [], pausedUntil: null };
    entry.denials = [...(Array.isArray(entry.denials) ? entry.denials : []).filter(x => at - Date.parse(x) < PLUS_DENY_WINDOW_MS), new Date(at).toISOString()];
    if (entry.denials.length >= PLUS_DENY_LIMIT) {
      entry.pausedUntil = new Date(at + PLUS_PAUSE_MS).toISOString();
      entry.denials = [];
      for (const r of [...requests.values()]) if (r.link?.name === 'plus' && r.plusUid === uid) finishRequest(r, 'denied');
    }
    plusRequests.accounts[uid] = entry;
    await store.savePlusRequests(plusRequests).catch(e => log(`remote plus requests: ${e.message}`));
    schedulePlusPause();
    queueStatus();
  }

  function finishRequest(r, phaseName, extra = {}) {
    if (requests.get(r.id) !== r) return;
    requests.delete(r.id);
    clearTimeout(r.timer);
    if (phaseName === 'denied') r.send({ type: 'denied', reason: 'rejected' });
    if (phaseName === 'expired') r.send({ type: 'expired' });
    closeWs(r.ws, 1000);
    emit({ type: 'remotePairing', phase: phaseName, request: publicRequest(r), ...extra });
    queueStatus();
  }

  // ── 審査の招待（ADR 0172） ───────────────────────────────────

  const reviewMode = () => isReviewMode(env);

  /** 招待の入場券を中継へ置く（同じ秘密から同じ入場券になる）。制御用の接続が無ければ、つながったときの sync が置く。 */
  function placeInviteTicket(link = null) {
    if (!invite || invite.expiresAt <= now()) return;
    const put = l => { if (l.provider?.allowPairing) sendControl(l, { type: 'pairing', ticketHash: invite.ticketHash.toString('hex'), ttlMs: PAIRING_TTL_MS }); };
    if (link) put(link); else eachLink(put);
  }

  const inviteDevices = () => [...deviceCache.values()].filter(d => invite && d.invite === invite.id);

  function logInvite(prefix = 'review invite') {
    if (!invite) return log(`${prefix}: none`);
    log(`${prefix}: ${inviteDaysLeft(invite, now())} days left (expires ${new Date(invite.expiresAt).toISOString()}), ${inviteDevices().length}/${limits.maxDevices} devices`);
  }

  /**
   * 招待の記録を読み直し、今の招待と食い違う印の端末（取り消された・切れた・作り直された招待で入った端末）をすべて取り消す。
   * 審査モードでなければ招待は無いものとして扱う（印の付いた端末が残っていれば同じく取り消す）。
   */
  async function reconcileOnce() {
    let next = null;
    if (reviewMode()) {
      try { next = loadInvite(await store.secrets.get(INVITE_KEY), now()); }
      catch (e) { log(`review invite: cannot read the invite (${e.message})`); return; }   // 読めない間は、今の状態を変えない
      if (next?.expired) next = null;
    }
    const before = invite;
    invite = next;
    for (const d of [...deviceCache.values()]) {
      if (d.invite && d.invite !== invite?.id) {
        log(`review invite: revoking device ${d.id.slice(0, 6)} (its invite ended)`);
        await revokeDevice(d.id, { record: false }).catch(e => log(`review invite: revoke failed (${e.message})`));
      }
    }
    if (invite?.id !== before?.id) {
      admitted.length = 0;
      placeInviteTicket();
      if (reviewMode()) logInvite(invite ? 'review invite: active' : 'review invite: ended');
    }
  }
  const chainInvite = fn => { const run = inviteChain.catch(() => {}).then(fn); inviteChain = run; return run; };
  const reconcileInvite = () => chainInvite(reconcileOnce);

  function startInviteTimers() {
    stopInviteTimers();
    if (!reviewMode()) return;
    const every = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); inviteTimers.push(timer); };
    every(() => reconcileInvite().catch(() => {}), INVITE_POLL_MS);
    every(placeInviteTicket, INVITE_REPLACE_MS);
    every(() => logInvite(), INVITE_LOG_MS);
  }
  function stopInviteTimers() {
    for (const timer of inviteTimers.splice(0)) clearInterval(timer);
  }

  /** 直近 1 時間に通した数。起動し直すと admitted は消えるので、devices.json の作成時刻からも数えて大きい方を取る。 */
  function recentAdmissions(at) {
    const since = at - INVITE_RATE_WINDOW_MS;
    while (admitted.length && admitted[0] <= since) admitted.shift();
    const fromDevices = inviteDevices().filter(d => Date.parse(d.createdAt) > since).length;
    return Math.max(admitted.length, fromDevices);
  }

  /** 招待で入ってきた端末を、上限の中なら登録して approved を返す。上限を超えたら denied（承認待ちにしない）。 */
  function admitInvite(inv, info, link) {
    const { ws, send } = info;
    const refuse = (type, reason) => { send({ type, ...(reason ? { reason } : {}) }); closeWs(ws, 1000); };
    return chainInvite(async () => {
      try {
        await reconcileOnce();   // 順番を待つ間に取り消された・切れたかもしれない
        if (!invite || invite.id !== inv.id || invite.expiresAt <= now()) return refuse('expired');
        if (ws.readyState !== WebSocket.OPEN) return;
        const at = now();
        const key = info.publicKey.toString('base64url');
        // 同じ端末（同じ鍵）が入り直すときは、古い登録と入れ替える（台数に数えない）
        const again = inviteDevices().find(d => d.publicKey === key);
        const verdict = checkAdmission({ live: inviteDevices().length - (again ? 1 : 0), recent: recentAdmissions(at), ...limits });
        if (!verdict.ok) {
          log(`review invite: refused a device (${verdict.reason === 'devices' ? 'device limit' : 'hourly limit'})`);
          return refuse('denied', verdict.reason);
        }
        if (again) await revokeDevice(again.id, { record: false });
        const { device, raw } = issueDevice(info, { via: link.name, invite: invite.id });
        await store.addDevice(device);
        deviceCache.set(device.id, device);
        sendControl(link, { type: 'allow', id: device.id, tokenHash: device.tokenHash });
        send({ type: 'approved', deviceId: device.id, token: raw.toString('base64url'), hostName: cfg.hostName });
        closeWs(ws, 1000);
        admitted.push(at);
        log(`review invite: admitted device ${device.id.slice(0, 6)} (${inviteDevices().length}/${limits.maxDevices} devices)`);
        queueStatus();
      } catch (e) {
        log(`review invite: admit failed (${e.message})`);
        refuse('denied', 'error');
      }
    });
  }

  // ── 端末の登録・取り消し ──────────────────────────────────────

  /** 端末の記録と中継用トークンを作る（承認・招待・link の admit で共通）。via は受け入れた link（'own' | 'plus'）、plusUid は plus のアカウントの uid、invite は審査の招待の印。 */
  function issueDevice({ name, platform, app, publicKey }, { via = 'own', plusUid, invite, approvedBy } = {}) {
    const raw = crypto.randomBytes(32);
    const at = new Date(now()).toISOString();
    const device = {
      id: `d${crypto.randomBytes(12).toString('base64url')}`,
      name, platform, app,
      publicKey: keyText(publicKey),
      tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
      createdAt: at,
      lastSeenAt: null,
      via,
      ...(via === 'plus' && plusUid ? { plusUid } : {}),
      ...(approvedBy ? { approvedBy, approvedAt: at } : {}),
      ...(invite ? { invite } : {}),
    };
    return { device, raw };
  }

  /**
   * 取り消し: 取り消した鍵に書き、一覧から消し、中継からも消し、つながり中のチャネルを切る。
   * 同じ鍵の記録（own と plus の両方にあるとき）と、この端末が許可した端末も一緒に取り消す。
   * by は取り消した機器（'host' か端末の id）。record: false は鍵を取り消した鍵に書かない
   * （ログアウト・別のアカウント・PC の鍵の作り直し・審査の招待の終わりのように、端末の鍵を疑う理由が無い外し方）
   */
  async function revokeDevice(id, { by = 'host', record = true } = {}, seen = new Set()) {
    id = String(id ?? '');
    if (seen.has(id)) return status();
    seen.add(id);
    const d = deviceCache.get(id) ?? (await store.devices()).find(x => x.id === id) ?? null;
    if (record && d?.publicKey) {
      const entry = {
        id: d.id, publicKey: d.publicKey, revokedAt: new Date(now()).toISOString(), by,
        name: d.name ?? '', platform: d.platform ?? null, via: d.via ?? 'own',
        ...(d.approvedBy ? { approvedBy: d.approvedBy } : {}), ...(d.createdAt ? { createdAt: d.createdAt } : {}),
      };
      revokedKeys.set(d.publicKey, { ...(revokedKeys.get(d.publicKey) ?? {}), ...entry, hidden: false });
      await store.addRevoked(entry);
      // 承認待ちの同じ鍵も切る（許可されても入れない）
      for (const r of [...requests.values()]) if (keyText(r.publicKey) === d.publicKey) finishRequest(r, 'cancelled');
    }
    await removeDevice(id);
    if (!record || !d) { queueStatus(); return status(); }
    for (const other of [...deviceCache.values()]) {
      if (other.publicKey === d.publicKey || other.approvedBy === id) await revokeDevice(other.id, { by, record }, seen);
    }
    queueStatus();
    return status();
  }

  /** 一覧・中継・つながり中のチャネルから外す（取り消した鍵には書かない）。 */
  async function removeDevice(id) {
    deviceCache.delete(id);   // 照合は先に止める（消し終わるのを待つ間にハンドシェイクを通さない）
    // 任された作業も止める（ADR 0146）。口を閉じてから、動いているタスクを止める
    agent?.closeDevice(id, 'revoked');
    await agent?.stopTasks?.(id);
    await store.removeDevice(id);
    // 取り消しは両方の link へ送る（via が読めない端末や差し替えの途中でも、中継の表から消える）
    eachLink(l => sendControl(l, { type: 'revoke', id }));
    notifyKeys.delete(id);
    await store.removeNotifyKey(id).catch(() => {});
    for (const { ch } of channels.get(id) ?? []) ch.goaway('revoked', 'device revoked');
    queueStatus();
    return status();
  }

  // ── 状態 ──────────────────────────────────────────────────────

  /** 端末の id から名前（許可した端末・取り消した端末の表示）。取り消した後の端末は取り消した鍵の記録から引く */
  function deviceName(id) {
    if (!id || id === 'host') return null;
    const live = deviceCache.get(id);
    if (live) return live.name ?? '';
    for (const k of revokedKeys.values()) if (k.id === id) return k.name ?? '';
    return null;
  }

  const linkStatus = l => ({ state: l.phase, error: l.error, since: new Date(l.since).toISOString(), retryAt: l.retryAt ? new Date(l.retryAt).toISOString() : null });

  async function status() {
    const peek = identity ?? await store.peekIdentity().catch(() => null);
    const storage = await store.storageStatus().catch(() => null);
    return {
      enabled: cfg.enabled,
      configured: Boolean(cfg.relayUrl && cfg.secret),
      relayUrl: cfg.relayUrl,
      relayUrlFromEnv: cfg.relayUrlFromEnv,
      hasEnrollSecret: Boolean(cfg.secret),
      enrollSecretFromEnv: cfg.secretFromEnv,
      hostName: cfg.hostName,
      hostId: peek?.hostId ?? null,
      connection: linkStatus(links.own),
      links: { own: linkStatus(links.own), plus: linkStatus(links.plus) },
      pairing: {
        offer: offer ? { expiresAt: new Date(offer.expiresAt).toISOString() } : null,
        requests: [...requests.values()].map(publicRequest),
      },
      devices: [...deviceCache.values()].map(d => publicDevice(d, channels.get(d.id)?.size ?? 0, notifyKeys.has(d.id), agent?.stats?.(d.id), deviceName)),
      // 取り消した端末（「一覧から消す」を押したものは出さない）。鍵はずっと通さない
      revoked: [...revokedKeys.values()].filter(k => !k.hidden).map(k => publicRevoked(k, deviceName)),
      // Pleiad Plus のつながり（docs/plus.md）。connect は設定、link は link の状態、host はこの PC の登録、devices は via:'plus' の数
      plus: {
        connect: cfg.plusConnect,
        link: linkStatus(links.plus),
        host: plusHostState,
        devices: [...deviceCache.values()].filter(d => d.via === 'plus').length,
        // 続けて断ったので、公式の中継からの申し込みを止めている間 { until }（ISO 時刻）。止めていなければ null
        paused: plusPausedStatus(),
      },
      storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}), ...(storage.pending ? { pending: true } : {}) } : null,
    };
  }

  /** 設定を読み直して、有効なら link ごとに中継へつなぐ（直列に）。片方が張れなくても、もう片方は張る。 */
  function apply() {
    const run = applying.catch(() => {}).then(async () => {
      disconnectAll();
      try {
        await loadConfig();
        if (!cfg.enabled) { eachLink(l => setLinkPhase(l, 'disabled')); return; }
        const wanted = [links.own, links.plus].filter(linkWanted);
        if (!wanted.length) return;
        identity = await store.identity();
        onIdentity?.(identity);
        // 招待は、つなぐ前に読む（つながったときの sync が入場券を置く）
        await reconcileInvite();
        if (reviewMode()) logInvite();
        startInviteTimers();
        for (const l of wanted) connect(l);
      } catch (e) {
        const err = { code: e.code === 'SECRET_LOCKED' ? 'locked' : 'config', message: e.message };
        eachLink(l => setLinkPhase(l, l.provider ? 'error' : 'disabled', l.provider ? err : null));
      }
    });
    applying = run;
    return run;
  }

  /**
   * plus の link の張る条件（provider の ready()）を今の値で見直す。
   * アカウント・ログイン・plus.connect・この PC の登録が変わったときに呼ぶ。張っている間は何もしない。
   */
  function refreshPlus() {
    const run = applying.catch(() => {}).then(async () => {
      const l = links.plus;
      if (!cfg.enabled || !l.provider || !linkWanted(l)) {
        if (l.control || l.retryTimer) disconnectLink(l);
        if (!cfg.enabled || !l.provider) setLinkPhase(l, 'disabled');
        return;
      }
      // 張っている・張る途中（券を取っている間を含む）なら重ねない
      if (l.phase === 'connected' || l.phase === 'connecting' || l.inFlight === l.generation) return;
      disconnectLink(l);
      try { identity ??= await store.identity(); }
      catch (e) { setLinkPhase(l, 'error', { code: e.code === 'SECRET_LOCKED' ? 'locked' : 'config', message: e.message }); return; }
      connect(l);
    });
    applying = run;
    return run;
  }

  /** plus の link の provider を差し替える（null なら閉じる）。張り直すのはその link だけで、own は動き続ける。 */
  function setPlusProvider(provider) {
    links.plus.provider = provider ?? null;
    const run = applying.catch(() => {}).then(async () => {
      const l = links.plus;
      disconnectLink(l);
      if (!cfg.enabled || !l.provider) { setLinkPhase(l, 'disabled'); return; }
      if (!linkWanted(l)) return;
      try { identity ??= await store.identity(); }
      catch (e) {
        setLinkPhase(l, 'error', { code: e.code === 'SECRET_LOCKED' ? 'locked' : 'config', message: e.message });
        return;
      }
      connect(l);
    });
    applying = run;
    return run;
  }

  return {
    store,
    /** 起動時に 1 回。無効なら何もしない（鍵も作らない）。 */
    start: () => apply(),
    /** 秘密を読めずに止まった（locked）link があれば、設定から読み直す。暗号化の口が答えを返せるようになったときに呼ぶ */
    retryLocked() {
      if (![links.own, links.plus].some(l => l.error?.code === 'locked')) return applying;
      return apply();
    },
    status,

    /** { enabled?, relayUrl?, enrollSecret?, hostName?, plusConnect? }。enrollSecret は undefined なら残し、'' か null で消す。 */
    async setSettings(args = {}) {
      const patch = {};
      if (args.relayUrl !== undefined) patch.relayUrl = normalizeRelayUrl(args.relayUrl);
      if (args.hostName !== undefined) patch.hostName = cleanLabel(args.hostName);
      if (args.enabled !== undefined) patch.enabled = args.enabled === true;
      if (args.plusConnect !== undefined) patch.plus = { connect: args.plusConnect === true, userSet: true };
      if (args.enrollSecret !== undefined) {
        const secret = args.enrollSecret == null ? '' : String(args.enrollSecret).trim();
        if (/[\s]/.test(secret) || secret.length > 1024) throw new Error(t('remote.settings.secretWhitespace'));
        await store.setEnrollSecret(secret);
      }
      // 中継の URL・秘密が無くても許可だけは入れられる（設定 › リモートの ＋ の流れで入れる。ADR 0239）。無い間は status の configured が false
      if (Object.keys(patch).length) await store.saveSettings(patch);
      await apply();
      return status();
    },

    /** 端末を追加する。QR に入れる文字列と期限を返す。 */
    async startPairing() {
      // 中継の入場券は 1 枚だけ。画面から作ると置き換わって審査の招待が使えなくなる
      if (reviewMode()) throw new Error(t('remote.review.addDeviceDisabled'));
      if (!cfg.enabled) throw new Error(t('remote.settings.disabled'));
      if (links.own.phase !== 'connected') throw new Error(t('remote.settings.notConnected'));
      const secret = crypto.randomBytes(32);
      const { psk, ticketHash } = derivePairing(secret);
      clearOffer(false);
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      offer = { psk, ticketHash, expiresAt, timer: null };
      const mine = offer;
      offer.timer = setTimeout(() => {
        if (offer !== mine) return;
        clearOffer(true);
        emit({ type: 'remotePairing', phase: 'expired' });
      }, PAIRING_TTL_MS);
      offer.timer.unref();
      eachLink(l => { if (l.provider?.allowPairing) sendControl(l, { type: 'pairing', ticketHash: ticketHash.toString('hex'), ttlMs: PAIRING_TTL_MS }); });
      queueStatus();
      return {
        payload: pairingPayload({ relayUrl: cfg.relayUrl, hostId: identity.hostId, publicKey: identity.publicKey, secret, hostName: cfg.hostName }),
        expiresAt: new Date(expiresAt).toISOString(),
        hostId: identity.hostId,
        hostName: cfg.hostName,
      };
    },
    cancelPairing() { clearOffer(true); return status(); },

    /** 承認。deviceId と中継用トークンを発行し、端末一覧・中継へ登録して端末へ渡す。 */
    async approve(id) {
      const r = requests.get(String(id ?? ''));
      if (!r) throw new Error(t('remote.pairing.requestGone'));
      // 窓を開いている間に取り消された鍵は通さない
      if (revokedKeys.has(keyText(r.publicKey))) { finishRequest(r, 'denied'); throw new Error(t('remote.pairing.requestGone')); }
      const link = r.link ?? links.own;
      const at = new Date(now()).toISOString();
      let device, raw;
      const again = r.again ? deviceCache.get(r.again) : null;
      if (again) {
        // もう一度の許可: 同じ id のまま、許可した機器を書いてトークンを出し直す
        raw = crypto.randomBytes(32);
        const patch = {
          tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
          approvedBy: 'host', approvedAt: at,
          name: r.name, platform: r.platform, app: r.app,
          ...(r.plusUid ? { plusUid: r.plusUid } : {}),
        };
        await store.updateDevice(again.id, patch);
        device = Object.assign(again, patch);
      } else {
        ({ device, raw } = issueDevice(r, { via: link.name, plusUid: r.plusUid, approvedBy: 'host' }));
        await store.addDevice(device);
        deviceCache.set(device.id, device);
      }
      sendControl(link, { type: 'allow', id: device.id, tokenHash: device.tokenHash });
      r.send({ type: 'approved', deviceId: device.id, token: raw.toString('base64url'), hostName: cfg.hostName });
      const shown = publicDevice(device, 0, notifyKeys.has(device.id), null, deviceName);
      finishRequest(r, 'approved', { device: shown });
      r.onApproved?.(device);
      return shown;
    },
    async deny(id) {
      const r = requests.get(String(id ?? ''));
      if (!r) throw new Error(t('remote.pairing.requestGone'));
      // Pleiad Plus から来た鍵は、断ってから 1 時間は同じ鍵で頼み直せない（QR は PC の画面で始めるので要らない）
      if (r.link?.name === 'plus') deniedUntil.set(keyText(r.publicKey), now() + DENY_COOLDOWN_MS);
      finishRequest(r, 'denied');
      if (r.link?.name === 'plus') await countPlusDenial(r.plusUid);
      return status();
    },
    /** 公式の中継からの申し込みを止めていたのを解く（人だけ。ホストの PC の画面から）。断った数も数え直す */
    async resumePlusRequests() {
      plusRequests = { version: 1, accounts: {} };
      await store.savePlusRequests(plusRequests);
      schedulePlusPause();
      queueStatus();
      return status();
    },

    async devices() { return (await status()).devices; },

    // ── 端末の AI からの委譲（docs/remote.md §4.5、ADR 0146） ────────

    /** 設定 › リモートの端末の行の材料（任された作業の数など）が変わった。状態を配り直す */
    touchStatus: () => queueStatus(),

    /** この端末の AI からの依頼を受けてよいか（agent-port が使う） */
    agentAllowed: deviceId => agentAllowed(deviceCache.get(String(deviceId ?? ''))),

    /**
     * この端末から任された作業をすべて止める（人だけ。server の setRemoteDeviceAgent）。
     * 端末ごとの「AI からの依頼を受ける」は無くした（ADR 0239）。止めたくなければ、端末を取り消すか受付を切る
     */
    async setDeviceAgent(id, { stopAll } = {}) {
      id = String(id ?? '');
      const d = deviceCache.get(id);
      if (!d) throw new Error(t('remote.pairing.requestGone'));
      if (stopAll === true) await agent?.stopTasks?.(id);
      queueStatus();
      return publicDevice(d, channels.get(id)?.size ?? 0, notifyKeys.has(id), agent?.stats?.(id));
    },

    // ── スマホへの通知（ADR 0086） ───────────────────────────────

    /** 端末の画面から来た接続（forward.mjs が付ける x-pleiad-device）の端末。一覧にあるものだけ。 */
    deviceInfo(deviceId) {
      const d = deviceCache.get(String(deviceId ?? ''));
      return d ? { id: d.id, platform: d.platform, mobile: isMobile(d), agent: agentAllowed(d) } : null;
    },

    /** 端末が作った通知鍵と設定を登録する（端末の E2E の線の中のコマンド）。同じ端末なら置き換える。 */
    async registerNotify(deviceId, { key, settings } = {}) {
      const d = deviceCache.get(String(deviceId ?? ''));
      if (!d) throw new Error(t('remote.pairing.requestGone'));
      const raw = parseNotifyKey(key);
      if (!raw) throw new Error(t('notify.error.badKey'));
      const next = normalizeDeviceSettings(settings, d.notify?.settings);
      await store.setNotifyKey(d.id, raw.toString('base64url'));
      notifyKeys.set(d.id, raw);
      d.notify = { ...(d.notify ?? {}), settings: next, registeredAt: d.notify?.registeredAt ?? new Date().toISOString() };
      await store.setNotify(d.id, { settings: d.notify.settings, registeredAt: d.notify.registeredAt });
      queueStatus();
      return publicNotify(d, true);
    },

    /** ホスト側の端末ごとの切り替え（設定 › 通知 › スマホ）。 */
    async setNotifyMuted(deviceId, muted) {
      const d = deviceCache.get(String(deviceId ?? ''));
      if (!d) throw new Error(t('remote.pairing.requestGone'));
      d.notify = { ...(d.notify ?? {}), muted: muted === true };
      await store.setNotify(d.id, { muted: d.notify.muted });
      queueStatus();
      return publicNotify(d, notifyKeys.has(d.id));
    },

    /** 通知を受けられる端末（スマホで、鍵と設定を登録済み）。通知の判定（core/notify）に渡す。 */
    notifyTargets() {
      const out = [];
      for (const [id, key] of notifyKeys) {
        const d = deviceCache.get(id);
        if (!d || !isMobile(d) || !d.notify?.settings || needsReapproval(d)) continue;
        out.push({ id, platform: d.platform, key, settings: d.notify.settings, muted: d.notify.muted === true });
      }
      return out;
    },

    /** 暗号化済みの通知を中継の通知の線へ渡す。制御用の接続が無ければ false。 */
    sendNotify(deviceId, blob, ttlMs) {
      const l = linkFor(deviceCache.get(deviceId));
      if (l.control?.readyState !== WebSocket.OPEN || !deviceCache.has(deviceId)) return false;
      sendControl(l, { type: 'notify', deviceId, blob, ttlMs });
      return true;
    },

    /** 最後に送った時刻。ファイルへの書き込みは間引く。 */
    markNotified(deviceId, at) {
      const d = deviceCache.get(deviceId);
      if (!d) return;
      const iso = new Date(at).toISOString();
      d.notify = { ...(d.notify ?? {}), lastSentAt: iso };
      const last = notifyPersisted.get(deviceId) ?? 0;
      if (at - last < NOTIFY_PERSIST_MS) return;
      notifyPersisted.set(deviceId, at);
      store.setNotify(deviceId, { lastSentAt: iso }).catch(() => {}).finally(queueStatus);
    },

    /** 通知の本文の頭に付けるホスト名と hostId（hostId は公開）。接続前は null。 */
    hostInfo: () => identity ? { hostId: identity.hostId, hostName: cfg.hostName } : null,

    /**
     * 取り消し: 鍵を取り消した鍵に書き、一覧から消し、中継からも消し、つながり中のチャネルを切る。
     * この端末が許可した端末も一緒に取り消す。opts = { by: 取り消した機器（'host' か端末の id）, record: false で鍵を書かない }
     */
    revoke: (id, opts) => revokeDevice(id, opts),

    /** 取り消した端末を一覧から消す（鍵は通さないまま） */
    async hideRevoked(publicKey) {
      const key = String(publicKey ?? '');
      const hit = revokedKeys.get(key);
      if (!hit) throw new Error(t('remote.pairing.requestGone'));
      await store.hideRevoked(key);
      hit.hidden = true;
      queueStatus();
      return status();
    },

    /** この鍵は取り消してあるか（端末の画面から来た操作の確かめに使う） */
    isRevoked: publicKey => revokedKeys.has(String(publicKey ?? '')),

    /** 審査の招待の記録を今すぐ読み直す（取り消された・切れた・作り直された招待で入った端末を取り消す）。ふだんは 10 秒ごとに自分で読む */
    reconcileReviewInvite: () => reconcileInvite(),

    /** plus のつながりの provider を差し込む・外す（null なら閉じる）。 */
    setPlusProvider,

    /** plus の link の張る条件を今の値で見直す（ログイン・アカウント・plus.connect・この PC の登録が変わったとき）。 */
    refreshPlus,

    /** この PC の Pleiad Plus への登録の状態（status.plus.host に出す）。{ state, hostId, error } */
    setPlusHostState(next) { plusHostState = next ?? null; queueStatus(); },

    /**
     * ほかのアカウントに hostId を取られているときの「つなぎ直す」（人だけの操作。docs/plus.md）:
     * ホストの鍵を作り直し（hostId が変わる）、今の端末を全部取り消し、中継へ張り直す。
     * Plus への登録し直しは、onIdentity で知らせた新しい鍵で core/plus/hosts.mjs が行う。
     */
    async plusHostRebind() {
      identity = await store.regenerateIdentity();
      onIdentity?.(identity);
      // hostId が変わると own・plus のどちらの端末も張り直せないので、全部取り消す
      for (const d of [...deviceCache.values()]) await revokeDevice(d.id, { record: false });
      await apply();
      return status();
    },

    /** 終了時。設定は変えずにつながりだけ閉じる。 */
    stop() { disconnectAll(); eachLink(l => setLinkPhase(l, 'disabled')); },
  };
}
