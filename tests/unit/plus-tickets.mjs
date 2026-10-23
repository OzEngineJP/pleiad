// Pleiad Plus の券（core/plus/tickets.mjs）: 偽の Plus（tests/lib/fake-plus.mjs）から券を取り、署名と中身を確かめる。
// 形・署名・aud・時刻を崩すと落ちる・公開鍵は覚えて使い、取れないときは期限の切れた覚えを使う・jti は一度きり。
import crypto from 'node:crypto';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createTicketIssuer, createTicketVerifier, createJtiStore, issueTicket, TicketError, TICKET_MAX_BYTES } from '../../core/plus/tickets.mjs';
import { generateKeyPair, hostIdFor } from '../../core/remote/noise.mjs';

export const name = 'plus-tickets';
export const title = 'Plus の券: 取り方（証明・前の版の api・426）、確かめ方（形・署名・aud・時刻・鍵の覚えと期限切れの写し）、jti の一度きり';

const UID = 'user-1';
const b64url = buf => Buffer.from(buf).toString('base64url');

export default async function (t) {
  const plus = await startFakePlus();
  try {
    plus.state.accounts[UID] = { uid: UID, status: 'plus', plan: 'plus', limits: { hosts: 3, devicesPerHost: 5 }, usage: null, sync: null };
    const host = generateKeyPair();
    const hostId = hostIdFor(host.publicKey);
    plus.state.hosts[hostId] = { hostId, publicKey: b64url(host.publicKey), name: 'desk', platform: 'win32', online: true, lastSeenAt: null, syncPublicKey: null, createdAt: new Date().toISOString(), deviceCount: 0, uid: UID };
    const request = async (method, p, body) => {
      const res = await fetch(plus.url + p, {
        method,
        headers: { authorization: `Bearer ${plus.issueIdToken(UID)}`, 'content-type': 'application/json', 'x-pleiad-admission': '2' },
        body: JSON.stringify(body ?? {}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(j?.error?.code ?? `HTTP ${res.status}`), { status: res.status, code: j?.error?.code ?? null });
      return j;
    };
    const verifier = createTicketVerifier({ keysUrl: () => plus.ticketKeysUrl });

    // ---- 取る
    const hostTicket = await issueTicket({ request, purpose: 'host', keyPair: host, hostId });
    const hp = await verifier.verify(hostTicket.relay, { aud: 'relay' });
    t.ok('PC の券は中継の券（role host・sub は鍵の hostId・uid）', hp.role === 'host' && hp.sub === hostId && hp.hostId === hostId && hp.uid === UID && !hostTicket.admission, JSON.stringify(hp));
    t.ok('券の期限は発行から 300 秒', hp.exp - hp.iat === 300);

    const device = generateKeyPair();
    const devTicket = await issueTicket({ request, purpose: 'device', keyPair: device, hostId });
    const dp = await verifier.verify(devTicket.relay, { aud: 'relay' });
    const ap = await verifier.verify(devTicket.admission, { aud: 'pleiad-host' });
    t.ok('端末の券は中継の券（role device・sub は端末の鍵）と受け入れの券の 2 枚',
      dp.role === 'device' && dp.sub === hostIdFor(device.publicKey) && dp.hostId === hostId, JSON.stringify(dp));
    t.ok('受け入れの券は hostId と端末の公開鍵（devicePub）を持つ', ap.hostId === hostId && ap.devicePub === b64url(device.publicKey) && ap.uid === UID, JSON.stringify(ap));

    const wrongKey = { publicKey: device.publicKey, privateKey: generateKeyPair().privateKey };
    const bad = await issueTicket({ request, purpose: 'device', keyPair: wrongKey, hostId }).then(() => null, e => e);
    t.ok('鍵を持たない（証明が合わない）と 422 bad_proof', bad?.status === 422 && bad?.code === 'bad_proof', JSON.stringify({ status: bad?.status, code: bad?.code }));

    // ---- 前の版の api（券の口が無い）・426
    let mark = null;
    const issuer = createTicketIssuer({ request, admission: () => mark });
    plus.state.noTickets = true;
    const before = plus.state.calls.length;
    const none = await issuer.issue({ purpose: 'host', keyPair: host, hostId });
    const none2 = await issuer.issue({ purpose: 'host', keyPair: host, hostId });
    t.ok('券の口が無い api なら null（ID トークンの道へ戻る）', none === null && none2 === null);
    t.ok('戻った後しばらくは api を呼ばずに null', plus.state.calls.slice(before).filter(c => c.path === '/v1/tickets/challenge').length === 1);
    mark = 1;
    const thrown = await issuer.issue({ purpose: 'host', keyPair: host, hostId }).then(() => null, e => e);
    t.ok('券を出すと言う api（admission が数）なら、404 でも戻らずに投げる', thrown?.status === 404, String(thrown?.status));
    plus.state.noTickets = false;
    plus.state.ticketFail = [{ path: '/v1/tickets/challenge', status: 426, code: 'update_required' }];
    const upd = await issuer.issue({ purpose: 'host', keyPair: host, hostId }).then(() => null, e => e);
    t.ok('426 は投げる（呼ぶ側が「更新してください」にする）', upd?.status === 426 && upd?.code === 'update_required');
    plus.state.ticketFail = [];
    const back = await issuer.issue({ purpose: 'host', keyPair: host, hostId });
    t.ok('券の口が戻れば券を返す', typeof back?.relay === 'string');

    // ---- 確かめる（形・署名・aud・時刻）
    const now = Math.floor(Date.now() / 1000);
    const claims = (extra = {}) => ({ iss: 'pleiad-tickets', aud: 'pleiad-host', uid: UID, iat: now, exp: now + 300, jti: b64url(crypto.randomBytes(16)), hostId, devicePub: b64url(device.publicKey), ...extra });
    const reason = token => verifier.verify(token, { aud: 'pleiad-host' }).then(() => 'ok', e => (e instanceof TicketError ? e.reason : `other:${e?.message}`));
    t.ok('偽の Plus が署名した券は通る', await reason(plus.signTicket(claims())) === 'ok');
    const other = crypto.generateKeyPairSync('ed25519');
    const cases = [
      ['aud が違う（中継の券を受け入れに使う）', plus.signTicket(claims({ aud: 'relay' })), 'claims'],
      ['iss が違う', plus.signTicket(claims({ iss: 'someone' })), 'claims'],
      ['jti が無い', plus.signTicket(claims({ jti: '' })), 'claims'],
      ['uid が無い', plus.signTicket(claims({ uid: '' })), 'claims'],
      ['exp が 61 秒を超えて過去', plus.signTicket(claims({ iat: now - 500, exp: now - 61 })), 'time'],
      ['iat が 61 秒を超えて未来', plus.signTicket(claims({ iat: now + 120, exp: now + 420 })), 'time'],
      ['typ が違う', plus.signTicket(claims(), { header: { typ: 'JWT' } }), 'form'],
      ['alg が違う', plus.signTicket(claims(), { header: { alg: 'RS256' } }), 'form'],
      ['別の鍵の署名（同じ kid）', plus.signTicket(claims(), { privateKey: other.privateKey }), 'sig'],
      ['知らない kid', plus.signTicket(claims(), { kid: 'no-such', privateKey: other.privateKey }), 'kid'],
      [`${TICKET_MAX_BYTES} バイトを超える`, plus.signTicket(claims({ pad: 'x'.repeat(TICKET_MAX_BYTES) })), 'form'],
      ['区切りが足りない', 'abc.def', 'form'],
    ];
    for (const [label, token, want] of cases) {
      const got = await reason(token);
      t.ok(`${label} → ${want}`, got === want, got);
    }
    const good = plus.signTicket(claims());
    const [h, p, s] = good.split('.');
    const swapped = `${h}.${b64url(JSON.stringify({ ...claims(), uid: 'user-2' }))}.${s}`;
    t.ok('中身を差し替えると署名で落ちる', await reason(swapped) === 'sig');
    t.ok('ずれ 60 秒以内（exp が 30 秒過去）は通る', await reason(plus.signTicket(claims({ iat: now - 330, exp: now - 30 }))) === 'ok');

    // ---- 公開鍵の覚え（5 分）・知らない kid の取り直しは 30 秒に 1 回・取れないときは期限の切れた覚え
    let clock = Date.now();
    const keyFetches = () => plus.state.calls.filter(c => c.path === '/.well-known/pleiad-keys').length;
    const v2 = createTicketVerifier({ keysUrl: () => plus.ticketKeysUrl, now: () => clock });
    const f0 = keyFetches();
    await v2.verify(plus.signTicket(claims()), { aud: 'pleiad-host' });
    await v2.verify(plus.signTicket(claims()), { aud: 'pleiad-host' });
    t.ok('公開鍵は 1 回取って覚える', keyFetches() - f0 === 1, String(keyFetches() - f0));
    const unknownKid = plus.signTicket(claims(), { kid: 'rotated', privateKey: other.privateKey });
    await v2.verify(unknownKid, { aud: 'pleiad-host' }).catch(() => {});
    await v2.verify(unknownKid, { aud: 'pleiad-host' }).catch(() => {});
    t.ok('知らない kid の取り直しは 30 秒に 1 回まで', keyFetches() - f0 === 1, String(keyFetches() - f0));
    clock += 31_000;
    await v2.verify(unknownKid, { aud: 'pleiad-host' }).catch(() => {});
    t.ok('30 秒たてば知らない kid で取り直す', keyFetches() - f0 === 2, String(keyFetches() - f0));
    plus.state.ticketKeysDown = true;
    clock += 6 * 60_000;
    // 時刻を進めたので、券もその時刻で作る
    const later = Math.floor(clock / 1000);
    const lateOk = await v2.verify(plus.signTicket(claims({ iat: later, exp: later + 300 })), { aud: 'pleiad-host' }).then(() => true, e => e?.reason);
    t.ok('公開鍵が取れないときは、期限の切れた覚えで確かめる', lateOk === true, String(lateOk));
    // 期限の切れた覚えを使えるのは、取ってから 24 時間まで
    clock += 24 * 60 * 60_000;
    const dayLater = Math.floor(clock / 1000);
    const tooOld = await v2.verify(plus.signTicket(claims({ iat: dayLater, exp: dayLater + 300 })), { aud: 'pleiad-host' }).then(() => null, e => e);
    t.ok('取ってから 24 時間を過ぎた覚えは使わない（unavailable）', tooOld instanceof TicketError && tooOld.reason === 'unavailable', tooOld?.reason ?? 'passed');
    plus.state.ticketKeysDown = false;
    clock += 31_000;
    const keysBack = Math.floor(clock / 1000);
    const keysBackOk = await v2.verify(plus.signTicket(claims({ iat: keysBack, exp: keysBack + 300 })), { aud: 'pleiad-host' }).then(() => true, e => e?.reason);
    t.ok('公開鍵が取れるようになれば、また確かめる', keysBackOk === true, String(keysBackOk));
    plus.state.ticketKeysDown = true;
    const fresh = createTicketVerifier({ keysUrl: () => plus.ticketKeysUrl });
    const freshErr = await fresh.verify(plus.signTicket(claims()), { aud: 'pleiad-host' }).then(() => null, e => e);
    t.ok('覚えが無くて公開鍵が取れないときは unavailable', freshErr instanceof TicketError && freshErr.reason === 'unavailable', freshErr?.reason);
    plus.state.ticketKeysDown = false;

    // ---- jti は一度きり
    let jclock = 1_000_000;
    const jtis = createJtiStore({ now: () => jclock, max: 2 });
    const exp = Math.floor(jclock / 1000) + 300;
    t.ok('初めての jti は通る', jtis.consume('a', exp) === true);
    t.ok('同じ jti の 2 回目は断る', jtis.consume('a', exp) === false);
    jtis.consume('b', exp);
    let full = null;
    try { jtis.consume('c', exp); } catch (e) { full = e; }
    t.ok('覚えがいっぱいで古いものを捨てられないときは unavailable（捨てて通すことはしない）', full instanceof TicketError && full.reason === 'unavailable');
    jclock += (300 + 61) * 1000;
    t.ok('exp + 60 秒を過ぎた jti は捨てて、新しい jti を覚えられる', jtis.consume('c', exp + 400) === true && jtis.size() === 1, String(jtis.size()));
  } finally {
    await plus.close();
  }
}
