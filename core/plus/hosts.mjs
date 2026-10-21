// この PC（ホスト）を、鍵を持っている証明つきで Pleiad Plus に登録する（docs/plus.md「この PC の登録」）。
//
// いつ: 起動したとき・ログインした直後・アカウントが変わったとき・ホストの鍵（identity）を作った直後。
//   ログインしていて account.status === 'plus' のときだけ行う。
//   ホストの鍵はこのモジュールが store.identity() で取る（登録には鍵が要る。作るのはこの 1 か所だけで、
//   リモートの接続口（connector.mjs）が有効化されたときに作る鍵と同じ仕組み・同じ置き場）。
//
// 手順（api の口の仕様どおり。証明は X25519 + HKDF + HMAC）:
//   1. GET /v1/hosts → 自分の hostId があり publicKey が同じなら、違う欄だけ PATCH して終わる
//   2. 無ければ POST /v1/hosts/challenge { hostId, publicKey } → { challengeId, nonce, serverPublicKey, expiresAt }
//   3. proof = base64url(HMAC-SHA256(HKDF-SHA256(X25519(ホストの秘密鍵, serverPublicKey), "pleiad host proof v1"), nonce ‖ utf8(hostId) ‖ utf8("register")))
//   4. PUT /v1/hosts/{hostId} { challengeId, proof, publicKey, name, platform, appVersion, syncPublicKey }
//   同期の公開鍵（syncPublicKey。core/plus/sync/keys.mjs）は、受け入れの v2 を知らない前の版の api にだけ送る
//   （載せずに登録済みなら 1 の PATCH で足す）。v2 の api では台帳の同期の公開鍵は同期の口（申し込み・始め直し・回復）でだけ変わり、
//   PUT・PATCH に載せると 400 bad_request syncPublicKey になる。api の版は /v1/auth/config の admission（無ければ前の版）で知り、
//   覚えが古くて 400 が返ったら、載せずに 1 回だけやり直す。
//
// その後: ホスト名が変わったら PATCH { name }、via:'plus' の端末の数が変わったら PATCH { deviceCount }。
//
// 誤り: 409 host_taken → state 'taken'（自動ではやり直さない。人の「つなぎ直す」で鍵を作り直す）、
//   429 host_limit → 'limit'、422 bad_proof → 新しい challenge で 1 回だけやり直し、
//   ネットの誤り・5xx → 'error' で 1 分おきにやり直す。
//
// 登録の外れ（docs/plus.md「同期の始め直しと登録の外れ」）: 同期の 403 host・中継の 4401 host・30 分ごとの見直し（recheck）で
//   台帳に自分が無いと分かったら登録し直す（鍵の行が戻る）。GET /v1/hosts の removed に自分が by: 'user' で載っていれば
//   登録し直さず 'removed' で待つ（人の「この PC を登録し直す」= reregister で登録する）。
//   外れていたのを登録し直したときは、状態に notice: 'reregistered' を載せる。
//   v2 の api では外された PC は同じ鍵では戻れない（403 host_removed。誰が外したかに関係なく）。
//   'removed' に error.permanent: true を載せて待ち、やり直しの時計も回さない。戻すのは人の「つなぎ直す」（ホストの鍵を作り直す）。
//
// 状態は { state, hostId, error, notice? } の形で session.setHost() と onHostState() に渡す
// （state: none / registering / registered / removed / taken / limit / error）。
import crypto from 'node:crypto';
import { dh, hkdfLabel, hostIdFor } from '../remote/noise.mjs';
import { cleanLabel } from '../remote/pairing.mjs';

const PROOF_INFO = 'pleiad host proof v1';
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBuf = s => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * ホストの鍵を持っている証明（登録は purpose 'register'、同期の券は 'sync'。core/plus/sync/ticket.mjs）。
 * base64url(HMAC-SHA256(HKDF(X25519(秘密鍵, serverPublicKey), "pleiad host proof v1"), nonce ‖ utf8(hostId) ‖ utf8(purpose)))
 */
export function hostProof({ privateKey, hostId, nonce, serverPublicKey, purpose }) {
  const shared = dh(privateKey, b64urlToBuf(serverPublicKey));
  const k = hkdfLabel(shared, PROOF_INFO);
  const mac = crypto.createHmac('sha256', k);
  mac.update(b64urlToBuf(nonce));
  mac.update(Buffer.from(hostId, 'utf8'));
  mac.update(Buffer.from(purpose, 'utf8'));
  return b64url(mac.digest());
}

/** v2 の api が、PUT・PATCH に載せた同期の公開鍵を断った（400 bad_request syncPublicKey） */
const refusedSyncKey = e => e?.status === 400 && e?.code === 'bad_request' && /syncPublicKey/.test(String(e?.message ?? ''));

/** 台帳へ送るホスト名。1〜64 字・制御文字は除く（cleanLabel と同じ整え方） */
const hostNameFor = name => cleanLabel(name, 64) || 'host';

const PLATFORM = { win32: 'win32', darwin: 'darwin', linux: 'linux' };

/**
 * @param {object} o
 * @param {object} o.session   createPlusSession（signedIn・account・client・setHost・getIdToken）
 * @param {object} o.store     リモートの置き場（connector.mjs の remote.store。identity() / peekIdentity()）
 * @param {string} [o.appVersion]
 * @param {string} [o.platform]
 * @param {() => string} o.hostName   今のホスト名（cfg.hostName）
 * @param {() => number} o.plusDevices  via:'plus' の端末の数（PATCH deviceCount 用）
 * @param {(state: { state, hostId, error }) => void} [o.onHostState] 状態が変わるたび（session.setHost に加えて呼ぶ）
 * @param {() => Promise<string|null>} [o.syncPublicKey] 同期の公開鍵（raw 32 バイトの base64url）。無ければ送らない
 * @param {() => Promise<1|2|null>} [o.apiAdmission] api の受け入れの版（/v1/auth/config の admission。null = 前の版の api）
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.retryMs]  ネットの誤り・5xx のやり直しの間隔（既定 1 分）
 * @param {number} [o.recheckMs]  登録が外れていないかの見直しの間隔（既定 30 分。0 で見直さない）
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval: Function }} [o.timers] 試験の時計用
 */
export function createPlusHost({ session, store, appVersion = '', platform = process.platform,
  hostName, plusDevices, onHostState = () => {}, log = () => {}, retryMs = 60_000, recheckMs = 30 * 60_000,
  syncPublicKey = async () => null, apiAdmission = async () => null, timers = { setTimeout, clearTimeout, setInterval } } = {}) {
  let host = { state: 'none', hostId: null, error: null };
  let chain = Promise.resolve();
  let activeRegistration = null;
  let retryTimer = null;
  let registered = null;      // { hostId, publicKey, name, platform, deviceCount } — 最後に台帳へ送った/返ってきた値
  let badProofRetried = false;
  let rechecking = null;
  let recheckTimer = null;
  let v2Seen = false;         // api が同期の公開鍵を断った（v2 の api）。覚えの admission が古くても送らない

  function setHost(next) {
    host = next;
    session.setHost(next);
    onHostState(next);
    if (next.state === 'registered' && !recheckTimer && recheckMs > 0) {
      recheckTimer = timers.setInterval(() => { void recheck(); }, recheckMs);
      recheckTimer?.unref?.();
    }
  }

  const eligible = () => {
    const s = session.snapshot?.() ?? {};
    return s.signedIn === true && s.account?.status === 'plus';
  };

  /** 外された PC（v2 の api では同じ鍵で戻れない） */
  function removedForGood(hostId) {
    log('plus host: removed (permanent)');
    registered = null;
    setHost({ state: 'removed', hostId, error: { code: 'host_removed', permanent: true } });
  }

  /** PUT・PATCH を送る。同期の公開鍵を v2 の api に断られたら、載せずに 1 回だけやり直す */
  async function sendHost(method, path, body) {
    try { return await session.client.request(method, path, { body }); }
    catch (e) {
      if (!refusedSyncKey(e) || body.syncPublicKey === undefined) throw e;
      v2Seen = true;
      const { syncPublicKey: _drop, ...rest } = body;
      if (method === 'PATCH' && !Object.keys(rest).length) return null;
      return await session.client.request(method, path, { body: rest });
    }
  }

  /** force: 利用者が外した PC でも登録し直す（人の「この PC を登録し直す」） */
  async function registerOnce({ force = false } = {}) {
    const identity = await store.identity();   // 登録には鍵が要る。無ければここで作る（store が直列化する）
    const { hostId } = identity;
    const publicKey = identity.publicKey.toString('base64url');
    const body = { name: hostNameFor(hostName()), platform: PLATFORM[platform] ?? 'linux', appVersion };
    const admission = v2Seen ? 2 : await apiAdmission().catch(() => null);
    const legacyApi = admission == null;
    // 同期の公開鍵を載せるのは前の版の api にだけ
    const syncPub = legacyApi ? await syncPublicKey() : null;

    setHost({ state: 'registering', hostId, error: null });
    // 1. すでに載っているか
    const list = await session.client.request('GET', '/v1/hosts');
    const mine = Array.isArray(list?.hosts) ? list.hosts.find(h => h?.hostId === hostId) : null;
    if (mine && mine.publicKey === publicKey) {
      registered = { hostId, publicKey, name: mine.name, platform: mine.platform, deviceCount: mine.deviceCount ?? null };
      const patch = {};
      if (mine.name !== body.name) patch.name = body.name;
      if (mine.platform !== body.platform) patch.platform = body.platform;
      if (syncPub && mine.syncPublicKey !== syncPub) patch.syncPublicKey = syncPub;
      if (Object.keys(patch).length) {
        await sendHost('PATCH', `/v1/hosts/${hostId}`, patch);
        const { syncPublicKey: _sent, ...kept } = patch;
        registered = { ...registered, ...kept };
      }
      setHost({ state: 'registered', hostId, error: null });
      return;
    }
    // 利用者がこの PC を外した: 人が登録し直すまで待つ（運営が外した・記録が無いときは登録し直す）
    const removed = !mine && Array.isArray(list?.removed) ? list.removed.find(r => r?.hostId === hostId) : null;
    // v2 の api: 誰が外しても戻れない（PUT は 403 host_removed）
    if (removed && !legacyApi) return removedForGood(hostId);
    if (removed?.by === 'user' && !force) {
      log('plus host: removed by user');
      registered = null;
      setHost({ state: 'removed', hostId, error: { code: 'host_removed' } });
      return;
    }
    const wasLost = !mine && (Boolean(removed) || registered?.hostId === hostId);   // つなぎ直し（hostId が替わる）は外れではない
    // 2-4. challenge → proof → PUT
    const challenge = await session.client.request('POST', '/v1/hosts/challenge', { body: { hostId, publicKey } });
    const put = {
      challengeId: challenge.challengeId,
      proof: hostProof({ privateKey: identity.privateKey, hostId, nonce: challenge.nonce, serverPublicKey: challenge.serverPublicKey, purpose: 'register' }),
      publicKey,
      ...body,
      ...(syncPub ? { syncPublicKey: syncPub } : {}),
    };
    const out = await sendHost('PUT', `/v1/hosts/${hostId}`, put);
    registered = { hostId, publicKey, name: body.name, platform: body.platform, deviceCount: out?.host?.deviceCount ?? null };
    badProofRetried = false;
    if (wasLost) log('plus host: registered again');
    setHost({ state: 'registered', hostId, error: null, ...(wasLost ? { notice: 'reregistered' } : {}) });
  }

  async function run({ force = false } = {}) {
    retryTimer && timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (!eligible()) return;
    try {
      await registerOnce({ force });
    } catch (e) {
      const code = e?.code;
      const hostId = host.hostId ?? (await store.peekIdentity().catch(() => null))?.hostId ?? null;
      if (e?.status === 409 && code === 'host_taken') {
        log('plus host: host_taken');
        setHost({ state: 'taken', hostId, error: { code: 'host_taken' } });
        return;
      }
      if (e?.status === 403 && code === 'host_removed') {
        removedForGood(hostId);
        return;
      }
      if (e?.status === 429 && code === 'host_limit') {
        log('plus host: host_limit');
        setHost({ state: 'limit', hostId, error: { code: 'host_limit' } });
        return;
      }
      if (e?.status === 422 && code === 'bad_proof' && !badProofRetried) {
        badProofRetried = true;
        try { await registerOnce({ force }); }
        catch (e2) { fail(e2, hostId); }
        return;
      }
      fail(e, hostId);
    }
  }

  function fail(e, hostId) {
    // ネットの誤り・5xx・残った 422 は error。1 分おきにやり直す
    log(`plus host: ${e?.code ?? 'error'} (${e?.status ?? '-'})`);
    setHost({ state: 'error', hostId, error: { code: e?.code ?? 'error' } });
    retryTimer = timers.setTimeout(() => { retryTimer = null; void maybeRegister(); }, retryMs);
    retryTimer?.unref?.();
  }

  /** 条件を満たすときだけ登録を直列に行う。条件が変わったときに呼ぶ。 */
  function maybeRegister() {
    if (activeRegistration) return activeRegistration;
    chain = chain.catch(() => {}).then(() => (eligible() ? run() : undefined));
    const current = chain.finally(() => {
      if (activeRegistration === current) activeRegistration = null;
    });
    activeRegistration = current;
    return current;
  }

  /** 人の「この PC を登録し直す」: 利用者が外した PC でも登録する */
  function reregister() {
    chain = chain.catch(() => {}).then(() => (eligible() ? run({ force: true }) : undefined));
    return chain;
  }

  /**
   * 登録が外れていないか確かめ直す（同期の 403 host・中継の 4401 host・30 分ごと）。
   * 台帳に自分が無ければ maybeRegister（利用者が外したなら removed で止まる）。同時に 1 本だけ
   */
  function recheck() {
    if (rechecking) return rechecking;
    rechecking = (async () => {
      if (!eligible() || host.state !== 'registered' || !host.hostId) return;
      const list = await session.client.request('GET', '/v1/hosts');
      const listed = Array.isArray(list?.hosts) && list.hosts.some(h => h?.hostId === host.hostId);
      if (listed) return;
      log('plus host: registration lost');
      await maybeRegister();
    })().catch(e => log(`plus host: recheck failed (${e?.code ?? 'error'})`)).finally(() => { rechecking = null; });
    return rechecking;
  }

  /** PATCH { name }（ホスト名が変わったとき。未登録なら次の登録で送る） */
  async function syncName() {
    const next = hostNameFor(hostName());
    if (host.state === 'registered' && registered && registered.name !== next) {
      await session.client.request('PATCH', `/v1/hosts/${registered.hostId}`, { body: { name: next } });
      registered.name = next;
    }
  }

  /** PATCH { deviceCount }（via:'plus' の端末の数が変わったとき。0〜64） */
  async function syncDeviceCount() {
    const next = Math.max(0, Math.min(64, plusDevices()));
    if (host.state === 'registered' && registered && registered.deviceCount !== next) {
      await session.client.request('PATCH', `/v1/hosts/${registered.hostId}`, { body: { deviceCount: next } });
      registered.deviceCount = next;
    }
  }

  return {
    maybeRegister,
    recheck,
    reregister,
    /** ホスト名・端末数の変更の通知（失敗は記録だけ。次の登録で帳尻が合う） */
    syncName: () => syncName().catch(e => log(`plus host: name patch failed (${e?.code ?? e})`)),
    syncDeviceCount: () => syncDeviceCount().catch(e => log(`plus host: deviceCount patch failed (${e?.code ?? e})`)),
    /** 今の状態（{ state, hostId, error }） */
    host: () => host,
  };
}
