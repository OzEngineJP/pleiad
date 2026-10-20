// Pleiad Plus の ID トークン検証（core/plus/verify.mjs）。偽の Plus（tests/lib/fake-plus.mjs）の鍵で署名した JWT を確かめる。
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';

export const name = 'plus-verify';
export const title = 'Plus の ID トークン検証: 正しいトークンが通り、alg・kid・iss・aud・exp・iat・sub を崩すと落ちる。60 秒のずれは許す';

export default async function (t) {
  const plus = await startFakePlus();
  try {
    const projectId = () => 'test-project';
    const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId });
    const ok = await verifier.verify(plus.issueIdToken('user-1'));
    t.ok('正しいトークンが通る', ok.uid === 'user-1' && ok.email === 'user-1@example.com');

    const fails = async (token, why) => verifier.verify(token).then(() => ({ why, ok: true }), e => ({ why, ok: false, code: e.code }));
    for (const [label, extra] of [
      ['iss が違う', { iss: 'https://securetoken.google.com/other' }],
      ['aud が違う', { aud: 'other' }],
      ['exp が過去', { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }],
      ['iat が未来（61 秒超）', { iat: Math.floor(Date.now() / 1000) + 120 }],
      ['sub が空', { sub: '' }],
      ['aud が配列で混ざる', { aud: ['other', 'test-project'] }],
    ]) {
      const r = await fails(plus.issueIdToken('user-1', extra), label);
      t.ok(`${label} → bad_token`, !r.ok && r.code === 'bad_token');
    }
    // 60 秒のずれまでは通る
    const skew = await verifier.verify(plus.issueIdToken('user-1', { exp: Math.floor(Date.now() / 1000) - 30 }));
    t.ok('exp が 30 秒過去（ずれ 60 秒以内）は通る', skew.uid === 'user-1');

    // alg を none に替える（署名なし）
    const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://securetoken.google.com/test-project', aud: 'test-project', sub: 'u', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`;
    const r1 = await fails(noneToken, 'alg none');
    t.ok('alg が RS256 でない → bad_token', !r1.ok && r1.code === 'bad_token');
    // 知らない kid（JWT のヘッダーだけ差し替え）
    const good = plus.issueIdToken('user-1');
    const parts = good.split('.');
    const badKid = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'no-such', typ: 'JWT' })).toString('base64url')}.${parts[1]}.${parts[2]}`;
    const r2 = await fails(badKid, 'kid');
    t.ok('kid が JWKS に無い → bad_token', !r2.ok && r2.code === 'bad_token');
    // 署名を崩す（payload を書き換えて署名はそのまま）
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ iss: 'https://securetoken.google.com/test-project', aud: 'test-project', sub: 'evil', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${parts[2]}`;
    const r3 = await fails(tampered, 'sig');
    t.ok('署名が合わない → bad_token', !r3.ok && r3.code === 'bad_token');
    // projectId の向きが変わると落ちる
    const other = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'other-project' });
    const r4 = await other.verify(good).then(() => null, e => e);
    t.ok('projectId が違う → bad_token', r4?.code === 'bad_token');
    // 形が壊れている
    const r5 = await fails('not-a-jwt', 'shape');
    t.ok('形が壊れている → bad_token', !r5.ok && r5.code === 'bad_token');
  } finally {
    await plus.close();
  }
}
