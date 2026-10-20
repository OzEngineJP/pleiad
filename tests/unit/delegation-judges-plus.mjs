// 仮想のキー「Pleiad Plus」の委譲先の自動選択（core/delegation-judges.mjs + core/api-keys.mjs の useEndpoint）。
// 偽の Plus（tests/lib/fake-plus.mjs）の中継の口へ ID トークンを付けて送り、誤りの code ごとの振る舞いを確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { judgeDifficulty, PLUS_JUDGE_TIMEOUT_MS } from '../../core/delegation-judges.mjs';
import { SIGNALS } from '../../core/delegation-routing.mjs';
import { createApiKeys } from '../../core/api-keys.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';

export const name = 'delegation-judges-plus';
export const title = '仮想のキー Pleiad Plus の自動選択: 中継の口へ ID トークンで送る・誤りの code・credit_exhausted の記憶・待ち時間';

const DECISIONS = '/v1/proxy/openrouter/alpha/decisions';
const CHAT = '/v1/proxy/openrouter/v1/chat/completions';
const jevAnswer = (p) => ({ answers: Object.fromEntries(SIGNALS.map((k) => [k, { type: 'noul', noul: p[k] ?? 0 }])) });
const qwenAnswer = (signals) => ({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'routing_v3', arguments: JSON.stringify({ signals }) } }] } }] });
const zero = Object.fromEntries(SIGNALS.map((k) => [k, false]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pleiad Plus のセッションの身代わり（getIdToken は偽の Plus の発行する JWT を返す） */
function fakeSession(plus, over = {}) {
  const snap = { signedIn: true, available: true, state: 'on', uid: 'u-1', account: { status: 'plus', usage: { credits: 10 }, limits: { creditsPerMonth: 100 } }, ...over };
  const calls = { token: 0, forced: 0, status: 0 };
  return {
    snapshot: () => snap,
    getIdToken: async ({ force } = {}) => { calls.token++; if (force) calls.forced++; return plus.issueIdToken(snap.uid ?? 'u-1'); },
    status: async () => { calls.status++; return snap; },
    set: (o) => Object.assign(snap, o),
    calls,
  };
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-judges-plus-'));
  const plus = await startFakePlus();
  const secrets = createSecretStore({ file: path.join(root, 'api-key-secrets.json'), cipher: plainCipher });
  const session = fakeSession(plus);
  const apiKeys = createApiKeys({ dataDir: root, secrets, plus: { apiBase: () => plus.url, session: () => session } });
  await apiKeys.init();
  await apiKeys.setUse('judge:jev', 'plus');
  const endpointOf = () => apiKeys.useEndpoint('judge:jev');
  const judge = (over = {}) => judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', endpointOf, ...over });
  const callsTo = (path) => plus.state.calls.filter((c) => c.path === path);
  try {
    // ---- 判定が中継の口に ID トークン付きで届く
    plus.state.proxy[DECISIONS] = { status: 200, body: jevAnswer({ diagnose: 1 }) };
    plus.state.proxy[CHAT] = { status: 200, body: qwenAnswer({ ...zero, choose: true }) };
    const ok = await judge();
    const jevCalls = callsTo(DECISIONS);
    t.ok('Jev の判定が <PLUS_API>/v1/proxy/openrouter/alpha/decisions に届き、判定が返る', ok.judge === 'jev' && ok.signals.diagnose === true && jevCalls.length === 1);
    t.ok('Authorization は ID トークン（Bearer の JWT）', /^Bearer .+\..+\..+$/.test(jevCalls[0].auth ?? ''));
    const q = await judge({ judge: 'qwen' });
    t.ok('Qwen も同じ中継の口（…/v1/chat/completions）に届く', q.judge === 'qwen' && q.signals.choose === true && callsTo(CHAT).length === 1);
    t.ok('plus のときの待ち時間の上限は 8 秒（PLUS_JUDGE_TIMEOUT_MS）', PLUS_JUDGE_TIMEOUT_MS === 8000);

    // ---- 誤りの表
    plus.state.proxy[DECISIONS] = { status: 429, body: { error: { code: 'rate_limited', message: 'x' } } };
    const rl = await judge();
    t.ok('429 rate_limited: 試し直さず mid（もう一方の判定は送らない）', rl.judge === 'none' && rl.fallback === 'rate_limited' && callsTo(DECISIONS).length === 2 && callsTo(CHAT).length === 1);

    plus.state.proxy[DECISIONS] = { status: 403, body: { error: { code: 'not_plus', message: 'x' } } };
    const np = await judge();
    t.ok('403 not_plus: mid・セッションに状態を読み直させる', np.judge === 'none' && np.fallback === 'not_plus' && session.calls.status === 1);
    plus.state.proxy[DECISIONS] = { status: 403, body: { error: { code: 'account_disabled', message: 'x' } } };
    const ad = await judge();
    t.ok('403 account_disabled: mid・読み直させる', ad.judge === 'none' && ad.fallback === 'account_disabled' && session.calls.status === 2);

    let hits = 0;
    plus.state.proxy[DECISIONS] = () => (++hits === 1 ? { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } } : { status: 200, body: jevAnswer({ diagnose: 1 }) });
    const re = await judge();
    t.ok('401 unauthenticated: ID トークンを 1 回だけ取り直して送り直す', re.judge === 'jev' && hits === 2 && session.calls.forced === 1);

    plus.state.proxy[DECISIONS] = { status: 502, body: { error: { code: 'upstream_error', message: 'x' } } };
    const up = await judge();
    t.ok('502 upstream_error: 今の 5xx と同じ（もう一方の判定を試す）', up.judge === 'qwen' && up.fallback === 'upstream_error' && callsTo(CHAT).length === 2);

    // ---- 429 credit_exhausted: resetAt まで送らず mid（中継の中ではその月の枠を使い切っている）
    session.set({ account: { status: 'plus', usage: { credits: 100 }, limits: { creditsPerMonth: 100 } } });
    const resetAt = new Date(Date.now() + 86400_000).toISOString();
    const before = callsTo(DECISIONS).length;
    plus.state.proxy[DECISIONS] = { status: 429, body: { error: { code: 'credit_exhausted', message: 'x', resetAt } } };
    const ex = await judge();
    t.ok('429 credit_exhausted: もう一方も試さず mid・resetAt を覚える', ex.judge === 'none' && ex.fallback === 'credit_exhausted' && ex.resetAt === resetAt && callsTo(DECISIONS).length === before + 1);
    const ex2 = await judge();
    t.ok('resetAt までは plus へ送らず credit_exhausted で mid（毎回 429 を受けない）', ex2.judge === 'none' && ex2.fallback === 'credit_exhausted' && callsTo(DECISIONS).length === before + 1 && callsTo(CHAT).length === 2);
    t.ok('覚えた値は apiKeys.plusCredit から読める（画面の状態に出す）', (await apiKeys.plusCredit())?.resetAt === resetAt);
    session.set({ account: { status: 'plus', usage: { credits: 1 }, limits: { creditsPerMonth: 100 } } });
    plus.state.proxy[DECISIONS] = { status: 200, body: jevAnswer({ diagnose: 1 }) };
    const ex3 = await judge();
    t.ok('アカウントの読み直しが上限未満を示したら、また送る', ex3.judge === 'jev' && callsTo(DECISIONS).length === before + 2);

    // ---- plus のときの待ち時間の上限（8 秒。3 秒では切れない）
    session.set({ account: { status: 'plus' } });
    plus.state.proxy[DECISIONS] = async () => { await sleep(3500); return { status: 200, body: jevAnswer({ diagnose: 1 }) }; };
    const slow = await judge();
    t.ok('中継が 3.5 秒で返っても答えを使う（3 秒の上限では切れない）', slow.judge === 'jev' && slow.signals.diagnose === true);
  } finally {
    await plus.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
