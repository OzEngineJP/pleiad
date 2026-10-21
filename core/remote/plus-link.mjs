// Pleiad Plus の公式の中継への「つながり（link）」の provider と、つなぎに来た端末の受け入れ（docs/plus.md）。
// connector.mjs の setPlusProvider() に渡す形（docs/remote.md §6.4）。自分の中継（own）の振る舞いは変えない。
//
// provider が決めること:
//   ready()    「ほかの端末からの操作を許可する」・ログイン中・account.status === 'plus'・plus.connect・
//              この PC の登録が registered、の全部がそろったときだけ true。
//              そろっていても 4401 'account' で止まっている間は { error: account }（中継へ張りに行かない）
//   url(path)  /v1/auth/config の urls.relay を行き先にする
//   headers()  { 'x-pleiad-host': hostId, 'x-pleiad-account': <ID トークン> }。トークンは張るたびに取る
//   owns(d)    via:'plus' で、plusUid が今のアカウントの uid の端末だけ
//   allowPairing  false（公式の中継はペアリングを受けない。ホストも受けない）
//   onClose()  4401 'account' → 止まる（error 'account'。張り直さない）。4429 'account limit' → 'limit'。
//              4401 'host' → この PC の登録が外れた（error 'host'）。onHostLost で登録を確かめ直す（登録し直すと張り直す）。
//              ほかの 4401 → ID トークンを取り直して 1 回だけ張り直す（また 4401 なら 'auth'）。
//              1013 → 今の backoff で張り直す。ほか → 今と同じ
//
// 4401 'account' の止まりを解く（update() で。解いたあとは refreshPlus が張り直す）:
//   張る条件がいったん崩れた（account が plus でなくなった・plus.connect か enabled を切った・ログアウト・登録）、
//   ほかのアカウントになった、または止まったあとに GET /v1/account を読めて plus のまま（accountReadAt が進んだ）。
//   止まっている間に session の知らせや設定の書き換えで見直しが来ても、これらが無ければ張りに行かない
//
// 受け入れ（onIncomingAdmit）: 中継が deviceId の無い端末を incoming {admit:true} で知らせたとき（ADR 0245）。
//   Noise IK の応答側でハンドシェイクし、メッセージ 1 の plus を verifyAdmission で確かめる（今のアカウントのものでなければ
//   窓を出さずに断る）。同じアカウントであることは承認の代わりにしない。端末はメッセージ 2 のあと 1 通だけ送る:
//     { type: 'admit' }  裏でのつなぎ直し。PC の画面か許可済みの端末で許可した鍵なら中継用トークンを出し直す。
//                        許可していない鍵は { denied, reason: 'approval' }（窓は出さない）
//     { type: 'pair' }   人が選んだつなぎ。許可済みの鍵なら同じく通す。無ければ { waiting } を返して、
//                        PC の画面の承認の窓（QR と同じ窓・同じ確認コード）へ回す。許可で approved、拒否で denied 'rejected'
//   取り消した鍵は 'revoked'、拒否してから 1 時間は 'rejected'。台数（limits.devicesPerHost）と 1 時間 20 件の上限の中だけ。
//   ID トークンはログにも状態にも残さない。
import WebSocket from 'ws';
import { Handshake, prologueFor, confirmationCode } from './noise.mjs';
import { relayWsUrl, cleanLabel } from './pairing.mjs';
import { t } from '../i18n.mjs';

const HOST_CLOSE = { BAD_REQUEST: 4400, UNAUTHORIZED: 4401 };

function parseJson(buf) {
  try { const v = JSON.parse(Buffer.from(buf).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

function closeWs(ws, code, reason = '') {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try { ws.close(code, reason); } catch { ws.terminate(); return; }
  setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 2000).unref();
}

/** 確かめに落ちた理由（端末へ返す denied の reason）。 */
export class AdmissionError extends Error {
  constructor(reason, message = reason) { super(message); this.reason = reason; }
}

/**
 * @param {object} o
 * @param {object} o.session    createPlusSession（snapshot()・getIdToken()）
 * @param {object} o.verifier   createIdTokenVerifier（verify(idToken) → { uid }）
 * @param {object} o.remote     createRemoteHost（store・revoke・status。張り直しの制御は refreshPlus で外から行う）
 * @param {(o: { hello, remoteStatic: Buffer, hostId: string, uid: string|null }) => Promise<{ uid: string }>} [o.verifyAdmission]
 *        メッセージ 1 の plus を確かめる。通らなければ AdmissionError（reason は端末へ返す）を投げる。
 *        既定は ID トークンを verifier で確かめ、uid が今のアカウントと同じこと。受け入れの券の確かめはここに差し込む
 * @param {(device) => void} [o.onAdmitted]  端末を登録したあと（台帳への PATCH deviceCount のきっかけ）
 * @param {(line: string) => void} [o.log]
 * @param {Function} [o.now]
 * @param {number} [o.admitLimit]      1 時間の申し込みの上限（既定 20）
 * @param {number} [o.admitWindowMs]   上限を数える窓（既定 1 時間）
 */
export function createPlusLink({ session, verifier, remote, verifyAdmission = null, onAdmitted = () => {}, onHostLost = () => {}, log = () => {},
  now = Date.now, admitLimit = 20, admitWindowMs = 60 * 60_000 } = {}) {
  // 張る条件と判定の材料。update() で外（server の同期の手）から写す
  const st = {
    enabled: false, signedIn: false, uid: null, accountStatus: null, accountReadAt: 0,
    connect: false, hostState: null, limits: null, relayUrl: null,
  };
  let held = null;             // 4401 'account' で止まっている間 { uid, readAt }（止まったときの uid と accountReadAt）
  let forceToken = false;      // ほかの 4401 のあと、次に張るときは ID トークンを取り直す
  let authRetried = false;     // その取り直しをもう使ったか
  const requestTimes = [];     // 直近の承認の窓への申し込みの時刻（上限を数える）

  const wanted = () => Boolean(
    st.enabled && st.signedIn && st.accountStatus === 'plus' && st.connect && st.hostState === 'registered'
  );
  const accountError = () => ({ code: 'account', message: t('remote.plus.closed.account') });
  const ready = () => {
    if (!wanted()) return false;
    return held ? { error: accountError() } : true;
  };

  /** 既定の確かめ: ID トークンの uid が今のアカウントと同じこと。 */
  async function verifyIdToken({ hello }) {
    let v;
    try { v = await verifier.verify(hello.plus?.idToken); } catch { throw new AdmissionError('account'); }
    if (!v?.uid || v.uid !== st.uid) throw new AdmissionError('account');
    return { uid: v.uid };
  }

  /** 承認の窓へ回してよいか。台数（同じ鍵は数えない）と 1 時間の申し込みの数。 */
  async function checkRequest({ publicKey }) {
    const key = publicKey.toString('base64url');
    const devices = await remote.store.devices();
    const rest = devices.filter(d => d.via === 'plus' && d.publicKey !== key);
    const limit = st.limits?.devicesPerHost;
    if (limit == null) return 'unavailable';        // limits を一度も読めていない
    if (rest.length >= limit) return 'devices';
    const since = now() - admitWindowMs;
    while (requestTimes.length && requestTimes[0] <= since) requestTimes.shift();
    if (requestTimes.length >= admitLimit) return 'rate';
    return null;
  }

  async function onIncomingAdmit(ctx) {
    const { ws, timer } = ctx;
    // 1. Plus のつながりが今オフ → 平文のまま 4401 'plus off'（ハンドシェイクに応じない）
    if (ready() !== true) {
      const close = () => { clearTimeout(timer); closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'plus off'); };
      if (ws.readyState === WebSocket.OPEN) close(); else ws.once('open', close);
      return;
    }
    ws.once('message', (data, isBinary) => {
      onHello(ctx, data, isBinary).catch(e => { log(`plus admit: ${e.message}`); closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'admit'); });
    });
  }

  async function onHello(ctx, data, isBinary) {
    const { ws, timer, identity, hostName } = ctx;
    if (!isBinary) return closeWs(ws, HOST_CLOSE.BAD_REQUEST, 'binary expected');
    let hs, hello;
    try {
      hs = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor(identity.hostId), staticKey: identity });
      hello = parseJson(hs.readMessage(Buffer.from(data)));
    } catch { return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'handshake'); }
    ws.send(hs.writeMessage());
    const code = confirmationCode(hs.handshakeHash);
    const transport = hs.split();
    const publicKey = Buffer.from(hs.remoteStatic);
    const send = obj => { if (ws.readyState === WebSocket.OPEN) ws.send(transport.encrypt(Buffer.from(JSON.stringify(obj), 'utf8'))); };
    const refuse = reason => { clearTimeout(timer); send({ type: 'denied', reason }); closeWs(ws, 1000); };
    // 端末はメッセージ 2 のあとすぐ { type: 'admit' | 'pair' } を送る。確かめの await の間に届いても取りこぼさないよう先に受けておく
    let nextResolve;
    const next = new Promise(res => { nextResolve = res; });
    ws.once('message', data2 => nextResolve(data2));

    // 2. メッセージ 1 の plus を確かめる（別のアカウントのものは窓を出さずに断る）
    let uid;
    try {
      ({ uid } = await (verifyAdmission ?? verifyIdToken)({ hello, remoteStatic: publicKey, hostId: identity.hostId, uid: st.uid }));
    } catch (e) {
      if (!(e instanceof AdmissionError)) log(`plus admit: ${e.message}`);
      return refuse(e instanceof AdmissionError ? e.reason : 'account');
    }
    // 3. 取り消した鍵・拒否してから 1 時間たっていない鍵
    if (ctx.isRevoked(publicKey)) return refuse('revoked');
    if (ctx.deniedRecently(publicKey)) return refuse('rejected');

    const label = {
      name: cleanLabel(hello.name) || t('remote.unnamedDevice'),
      platform: cleanLabel(hello.platform, 32) || 'unknown',
      app: cleanLabel(hello.app, 32) || null,
    };
    let msg;
    try { msg = parseJson(transport.decrypt(Buffer.from(await next))); } catch { msg = null; }
    if (msg?.type !== 'admit' && msg?.type !== 'pair') { clearTimeout(timer); return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'admit'); }

    // 4. 許可済みの鍵なら、窓を出さずに中継用トークンを出し直す
    const known = await ctx.admitKnown({ ...label, publicKey, plusUid: uid });
    if (known) {
      clearTimeout(timer);
      send({ type: 'approved', deviceId: known.device.id, token: known.token, hostName });
      closeWs(ws, 1000);
      onAdmitted(known.device);
      return;
    }
    // 5. 許可していない鍵: 裏のつなぎ直しでは窓を出さない。人が選んだつなぎなら PC の画面の承認の窓へ
    if (msg.type === 'admit') return refuse('approval');
    const denied = await checkRequest({ publicKey });
    if (denied) return refuse(denied);
    requestTimes.push(now());
    clearTimeout(timer);
    send({ type: 'waiting' });
    ctx.request({ ...label, publicKey, plusUid: uid, code, send, onApproved: onAdmitted });
  }

  const provider = {
    name: 'plus',
    ready,
    url: path => relayWsUrl(st.relayUrl, path),
    async headers() {
      const identity = await remote.store.peekIdentity();
      const token = await session.getIdToken({ force: forceToken });
      forceToken = false;
      return { 'x-pleiad-host': identity.hostId, 'x-pleiad-account': token };
    },
    owns: d => Boolean(d && d.via === 'plus' && d.plusUid === st.uid),
    allowPairing: false,
    onIncomingAdmit: ctx => onIncomingAdmit(ctx),
    onClose(code, reason) {
      if (code === 4401 && reason === 'account') {
        held = { uid: st.uid, readAt: st.accountReadAt ?? 0 };
        return { error: accountError() };
      }
      if (code === 4429 && reason === 'account limit') return { error: { code: 'limit', message: t('remote.plus.closed.limit') } };
      if (code === 4401 && reason === 'host') {
        try { onHostLost(); } catch {}
        return { error: { code: 'host', message: t('remote.plus.closed.host') } };
      }
      if (code === 4401) {
        // ID トークンを取り直して 1 回だけ張り直す。また 4401 なら 'auth'
        if (!authRetried) { authRetried = true; forceToken = true; return 'retry'; }
        return { error: { code: 'auth', message: t('remote.plus.closed.auth') } };
      }
      if (code !== 1013) authRetried = false;   // 1013 は今の backoff で張り直す。ほかも今と同じ
      return null;
    },
  };

  return {
    provider,
    /** 張る条件と判定の材料を写す（account・accountReadAt・ログイン・plus.connect・enabled・登録・limits・relay の URL） */
    update(patch) {
      Object.assign(st, patch ?? {});
      if (held && (!wanted() || st.uid !== held.uid || (st.accountReadAt ?? 0) > held.readAt)) held = null;
    },
  };
}
