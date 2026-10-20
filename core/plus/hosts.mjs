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
//   4. PUT /v1/hosts/{hostId} { challengeId, proof, publicKey, name, platform, appVersion }
//
// その後: ホスト名が変わったら PATCH { name }、via:'plus' の端末の数が変わったら PATCH { deviceCount }。
//
// 誤り: 409 host_taken → state 'taken'（自動ではやり直さない。人の「つなぎ直す」で鍵を作り直す）、
//   429 host_limit → 'limit'、422 bad_proof → 新しい challenge で 1 回だけやり直し、
//   ネットの誤り・5xx → 'error' で 1 分おきにやり直す。
//
// 状態は { state, hostId, error } の形で session.setHost() と onHostState() に渡す
// （state: none / registering / registered / taken / limit / error）。
import crypto from 'node:crypto';
import { dh, hkdfLabel, hostIdFor } from '../remote/noise.mjs';
import { cleanLabel } from '../remote/pairing.mjs';

const PROOF_INFO = 'pleiad host proof v1';
const PROOF_PURPOSE = 'register';
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBuf = s => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

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
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.retryMs]  ネットの誤り・5xx のやり直しの間隔（既定 1 分）
 */
export function createPlusHost({ session, store, appVersion = '', platform = process.platform,
  hostName, plusDevices, onHostState = () => {}, log = () => {}, retryMs = 60_000 } = {}) {
  let host = { state: 'none', hostId: null, error: null };
  let chain = Promise.resolve();
  let retryTimer = null;
  let registered = null;      // { hostId, publicKey, name, platform, deviceCount } — 最後に台帳へ送った/返ってきた値
  let badProofRetried = false;

  function setHost(next) {
    host = next;
    session.setHost(next);
    onHostState(next);
  }

  const eligible = () => {
    const s = session.snapshot?.() ?? {};
    return s.signedIn === true && s.account?.status === 'plus';
  };

  function proof({ publicKey, privateKey, hostId, nonce, serverPublicKey }) {
    const shared = dh(privateKey, b64urlToBuf(serverPublicKey));
    const k = hkdfLabel(shared, PROOF_INFO);
    const mac = crypto.createHmac('sha256', k);
    mac.update(b64urlToBuf(nonce));
    mac.update(Buffer.from(hostId, 'utf8'));
    mac.update(Buffer.from(PROOF_PURPOSE, 'utf8'));
    return b64url(mac.digest());
  }

  async function registerOnce() {
    const identity = await store.identity();   // 登録には鍵が要る。無ければここで作る（store が直列化する）
    const { hostId } = identity;
    const publicKey = identity.publicKey.toString('base64url');
    const body = { name: hostNameFor(hostName()), platform: PLATFORM[platform] ?? 'linux', appVersion };

    setHost({ state: 'registering', hostId, error: null });
    // 1. すでに載っているか
    const list = await session.client.request('GET', '/v1/hosts');
    const mine = Array.isArray(list?.hosts) ? list.hosts.find(h => h?.hostId === hostId) : null;
    if (mine && mine.publicKey === publicKey) {
      registered = { hostId, publicKey, name: mine.name, platform: mine.platform, deviceCount: mine.deviceCount ?? null };
      const patch = {};
      if (mine.name !== body.name) patch.name = body.name;
      if (mine.platform !== body.platform) patch.platform = body.platform;
      if (Object.keys(patch).length) {
        await session.client.request('PATCH', `/v1/hosts/${hostId}`, { body: patch });
        registered = { ...registered, ...patch };
      }
      setHost({ state: 'registered', hostId, error: null });
      return;
    }
    // 2-4. challenge → proof → PUT
    const challenge = await session.client.request('POST', '/v1/hosts/challenge', { body: { hostId, publicKey } });
    const put = {
      challengeId: challenge.challengeId,
      proof: proof({ ...identity, hostId, nonce: challenge.nonce, serverPublicKey: challenge.serverPublicKey }),
      publicKey,
      ...body,
    };
    const out = await session.client.request('PUT', `/v1/hosts/${hostId}`, { body: put });
    registered = { hostId, publicKey, name: body.name, platform: body.platform, deviceCount: out?.host?.deviceCount ?? null };
    badProofRetried = false;
    setHost({ state: 'registered', hostId, error: null });
  }

  async function run() {
    retryTimer && clearTimeout(retryTimer);
    retryTimer = null;
    if (!eligible()) return;
    try {
      await registerOnce();
    } catch (e) {
      const code = e?.code;
      const hostId = host.hostId ?? (await store.peekIdentity().catch(() => null))?.hostId ?? null;
      if (e?.status === 409 && code === 'host_taken') {
        log('plus host: host_taken');
        setHost({ state: 'taken', hostId, error: { code: 'host_taken' } });
        return;
      }
      if (e?.status === 429 && code === 'host_limit') {
        log('plus host: host_limit');
        setHost({ state: 'limit', hostId, error: { code: 'host_limit' } });
        return;
      }
      if (e?.status === 422 && code === 'bad_proof' && !badProofRetried) {
        badProofRetried = true;
        try { await registerOnce(); setHost({ state: 'registered', hostId, error: null }); }
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
    retryTimer = setTimeout(() => { retryTimer = null; void maybeRegister(); }, retryMs);
    retryTimer.unref?.();
  }

  /** 条件を満たすときだけ登録を直列に行う。条件が変わったときに呼ぶ。 */
  function maybeRegister() {
    chain = chain.catch(() => {}).then(() => (eligible() ? run() : undefined));
    return chain;
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
    /** ホスト名・端末数の変更の通知（失敗は記録だけ。次の登録で帳尻が合う） */
    syncName: () => syncName().catch(e => log(`plus host: name patch failed (${e?.code ?? e})`)),
    syncDeviceCount: () => syncDeviceCount().catch(e => log(`plus host: deviceCount patch failed (${e?.code ?? e})`)),
    /** 今の状態（{ state, hostId, error }） */
    host: () => host,
  };
}
