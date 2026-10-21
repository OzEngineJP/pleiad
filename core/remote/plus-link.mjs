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
// 受け入れ（onIncomingAdmit）: 中継が deviceId の無い端末を incoming {admit:true} で知らせたとき。
//   Noise IK の応答側でハンドシェイクし、メッセージ 1 の plus.idToken を自分で検証し、
//   uid が今のアカウントと同じときだけ、確認コード無しで端末を登録する（同じアカウントであることが承認の代わり）。
//   台数の上限（limits.devicesPerHost）と 1 時間 20 台の上限の中だけ。idToken はログにも状態にも残さない。
import WebSocket from 'ws';
import { Handshake, prologueFor } from './noise.mjs';
import { relayWsUrl, cleanLabel } from './pairing.mjs';
import { t } from '../i18n.mjs';

const HOST_CLOSE = { BAD_REQUEST: 4400, UNAUTHORIZED: 4401 };
const CLOSE_AFTER_OPEN = 15_000;   // admit を待つ時間（admitInvite と同じ、ハンドシェイクの上限と揃える）

function parseJson(buf) {
  try { const v = JSON.parse(Buffer.from(buf).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

function closeWs(ws, code, reason = '') {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try { ws.close(code, reason); } catch { ws.terminate(); return; }
  setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 2000).unref();
}

/**
 * @param {object} o
 * @param {object} o.session    createPlusSession（snapshot()・getIdToken()）
 * @param {object} o.verifier   createIdTokenVerifier（verify(idToken) → { uid }）
 * @param {object} o.remote     createRemoteHost（store・revoke・status。張り直しの制御は refreshPlus で外から行う）
 * @param {(device) => void} [o.onAdmitted]  端末を登録したあと（台帳への PATCH deviceCount のきっかけ）
 * @param {(line: string) => void} [o.log]
 * @param {Function} [o.now]
 * @param {number} [o.admitLimit]      1 時間の受け入れの上限（既定 20）
 * @param {number} [o.admitWindowMs]   上限を数える窓（既定 1 時間）
 */
export function createPlusLink({ session, verifier, remote, onAdmitted = () => {}, onHostLost = () => {}, log = () => {},
  now = Date.now, admitLimit = 20, admitWindowMs = 60 * 60_000 } = {}) {
  // 張る条件と判定の材料。update() で外（server の同期の手）から写す
  const st = {
    enabled: false, signedIn: false, uid: null, accountStatus: null, accountReadAt: 0,
    connect: false, hostState: null, limits: null, relayUrl: null,
  };
  let held = null;             // 4401 'account' で止まっている間 { uid, readAt }（止まったときの uid と accountReadAt）
  let forceToken = false;      // ほかの 4401 のあと、次に張るときは ID トークンを取り直す
  let authRetried = false;     // その取り直しをもう使ったか
  const admitTimes = [];       // 直近の受け入れの時刻（上限を数える）

  const wanted = () => Boolean(
    st.enabled && st.signedIn && st.accountStatus === 'plus' && st.connect && st.hostState === 'registered'
  );
  const accountError = () => ({ code: 'account', message: t('remote.plus.closed.account') });
  const ready = () => {
    if (!wanted()) return false;
    return held ? { error: accountError() } : true;
  };

  /**
   * 端末を登録してよいかの判定。{ denied: 'account'|'devices'|'unavailable'|'rate'|null, replaceId }
   * 同じ公開鍵の via:'plus' の端末は置き換える（数に入れない。取り消しは新しい登録が終わってから行う。
   * remote.revoke は link の張り直しを伴うので、登録の途中で呼ぶとこの accept の接続まで切れる）。
   */
  async function checkAdmission({ publicKey }) {
    const devices = await remote.store.devices();
    const same = devices.find(d => d.via === 'plus' && d.publicKey === publicKey.toString('base64url'));
    const rest = devices.filter(d => d.via === 'plus' && d.id !== same?.id);
    const limit = st.limits?.devicesPerHost;
    if (limit == null) return { denied: 'unavailable' };        // limits を一度も読めていない
    if (rest.length >= limit) return { denied: 'devices' };
    const since = now() - admitWindowMs;
    while (admitTimes.length && admitTimes[0] <= since) admitTimes.shift();
    const recent = Math.max(admitTimes.length, rest.filter(d => Date.parse(d.createdAt) > since).length);
    if (recent >= admitLimit) return { denied: 'rate' };
    return { denied: null, replaceId: same?.id ?? null };
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
    const transport = hs.split();
    const send = obj => { if (ws.readyState === WebSocket.OPEN) ws.send(transport.encrypt(Buffer.from(JSON.stringify(obj), 'utf8'))); };
    const refuse = reason => { clearTimeout(timer); send({ type: 'denied', reason }); closeWs(ws, 1000); };
    // 端末はメッセージ 2 のあとすぐ { type: 'admit' } を送る。検証の await の間に届いても取りこぼさないよう先に受けておく
    let admitMsgResolve;
    const admitMsg = new Promise(res => { admitMsgResolve = res; });
    ws.once('message', data2 => admitMsgResolve(data2));

    // 2. ID トークンを自分で検証し、uid が今のアカウントと同じときだけ進める
    let uid;
    try {
      const v = await verifier.verify(hello.plus?.idToken);
      if (v.uid !== st.uid) return refuse('account');
      uid = v.uid;
    } catch { return refuse('account'); }

    // 3-5. 置き換え・台数・回数
    const { denied, replaceId } = await checkAdmission({ publicKey: hs.remoteStatic });
    if (denied) return refuse(denied);

    const label = {
      name: cleanLabel(hello.name) || t('remote.unnamedDevice'),
      platform: cleanLabel(hello.platform, 32) || 'unknown',
      app: cleanLabel(hello.app, 32) || null,
    };
    try {
      const data2 = await admitMsg;
      let msg;
      try { msg = parseJson(transport.decrypt(Buffer.from(data2))); } catch { msg = null; }
      if (msg?.type !== 'admit') return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'admit');
      clearTimeout(timer);
      const { device, token } = await ctx.admit({ ...label, publicKey: hs.remoteStatic, plusUid: uid });
      send({ type: 'approved', deviceId: device.id, token, hostName });
      closeWs(ws, 1000);
      admitTimes.push(now());
      onAdmitted(device);
      // 同じ公開鍵の古い端末を置き換える（登録が終わってから取り消す。張り直しを伴うのでここで）
      if (replaceId) await remote.revoke(replaceId);
    } catch (e) {
      log(`plus admit: ${e.message}`);
      closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'admit');
    }
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
