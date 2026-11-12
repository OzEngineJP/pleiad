// wait_until の問いに仮想のキー Pleiad Plus を使う（2026-11-13、docs/computer-use.md「wait_until の待ち方」）。
// 偽の Plus（tests/lib/fake-plus.mjs）の中継の口 /v1/proxy/openrouter/alpha/decisions へ ID トークン付きで送る。
// 使えない理由（上限・ログインしていない・Plus ではない・メンテナンス）は送る前に分かり、画面の差分だけで待って unverified を返す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../lib/computer-harness.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { computerDisplay } from '../../core/computer-use/display.mjs';
import { createApiKeys } from '../../core/api-keys.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';

export const name = 'computer-wait-until-plus';
export const title = 'wait_until × Pleiad Plus: 中継へ送る・上限／未ログイン／Plus でない／メンテは送らず unverified・途中の拒否は error・401 は 1 回だけ送り直す';

const DECISIONS = '/v1/proxy/openrouter/alpha/decisions';
const yes = p => ({ answers: { done: { type: 'noul', noul: p } } });
const UNTIL = 'Is it done?';

function fakeSession(plus, over = {}) {
  const snap = { signedIn: true, available: true, state: 'on', uid: 'u-1', account: { status: 'plus', usage: { credits: 10 }, limits: { creditsPerMonth: 100 } }, ...over };
  const calls = { token: 0, forced: 0, status: 0 };
  return {
    snapshot: () => snap,
    getIdToken: async ({ force } = {}) => { calls.token++; if (force) calls.forced++; return plus.issueIdToken(snap.uid ?? 'u-1'); },
    status: async () => { calls.status++; return snap; },
    set: o => Object.assign(snap, o),
    calls,
  };
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-wait-plus-'));
  const plus = await startFakePlus();
  const secrets = createSecretStore({ file: path.join(root, 'api-key-secrets.json'), cipher: plainCipher });
  const session = fakeSession(plus);
  const apiKeys = createApiKeys({ dataDir: root, secrets, plus: { apiBase: () => plus.url, session: () => session } });
  await apiKeys.init();
  await apiKeys.setUse('computer:decider', 'plus');
  const h = await createHarness({ waitMs: 400, decider: { route: () => apiKeys.useRoute('computer:decider') } });
  const mark = r => computerDisplay(r.content[0].text)?.computer;
  const body = r => computerDisplay(r.content[0].text)?.text ?? '';
  const sent = () => plus.state.calls.filter(c => c.path === DECISIONS);
  const plusAccount = () => ({ status: 'plus', usage: { credits: 10 }, limits: { creditsPerMonth: 100 } });
  try {
    const a = h.connect({ sessionId: 'p1' });
    const call = args => a.call('wait_until', { title: 'x', until: UNTIL, ...args });
    h.driver.setFrames(() => 90);

    // ---- はい
    plus.state.proxy[DECISIONS] = { status: 200, body: yes(0.93) };
    const r1 = await call();
    t.ok('Plus を選ぶと中継へ ID トークン付きで 1 回送り、success・yes・via は付かない', mark(r1).wait.status === 'success' && mark(r1).wait.answer === 'yes' && !('via' in mark(r1).wait)
      && sent().length === 1 && /^Bearer .+\..+\..+$/.test(sent()[0].auth ?? ''), JSON.stringify(mark(r1).wait));

    // ---- 401 unauthenticated → ID トークンを取り直して 1 回だけ送り直す
    let n = 0;
    const before = sent().length, forced = session.calls.forced;
    plus.state.proxy[DECISIONS] = () => (++n === 1 ? { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } } : { status: 200, body: yes(0.9) });
    const r2 = await call();
    t.ok('401 unauthenticated: ID トークンを取り直して 1 回だけ送り直し、success', mark(r2).wait.status === 'success' && sent().length === before + 2 && session.calls.forced === forced + 1, JSON.stringify(mark(r2).wait));
    plus.state.proxy[DECISIONS] = { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } };
    const b2 = sent().length;
    const r2b = await call();
    t.ok('401 が続けば送り直しは 1 回まで（2 回送って error・via plus）', mark(r2b).wait.status === 'error' && mark(r2b).wait.via === 'plus' && sent().length === b2 + 2, JSON.stringify(mark(r2b).wait));

    // ---- not_plus → error・アカウントを読み直す
    const st = session.calls.status;
    plus.state.proxy[DECISIONS] = { status: 403, body: { error: { code: 'not_plus', message: 'x' } } };
    const r3 = await call();
    t.ok('not_plus: error・reason not_plus・via plus・アカウントを読み直す', mark(r3).wait.status === 'error' && mark(r3).wait.reason === 'not_plus' && mark(r3).wait.via === 'plus' && session.calls.status > st, JSON.stringify(mark(r3).wait));

    // ---- 途中で credit_exhausted → error・上限を覚える → 次は送らず unverified
    const resetAt = '2099-12-01T00:00:00.000Z';
    plus.state.proxy[DECISIONS] = { status: 429, body: { error: { code: 'credit_exhausted', message: 'x', resetAt } } };
    const r4 = await call();
    t.ok('途中の credit_exhausted: error・reason credit_exhausted・via plus・reset_at', mark(r4).wait.status === 'error' && mark(r4).wait.reason === 'credit_exhausted' && mark(r4).wait.via === 'plus' && mark(r4).wait.reset_at === resetAt, JSON.stringify(mark(r4).wait));
    session.set({ account: { status: 'plus', usage: { credits: 100 }, limits: { creditsPerMonth: 100 } } });  // 使い切った（記憶は、アカウントの使用量がまだ上限のときだけ残る）
    const b4 = sent().length;
    const r5 = await call();
    t.ok('上限を覚えている間は画面を送らず、画面の差分だけで待って unverified・plus_credit・reset_at', sent().length === b4 && mark(r5).wait.status === 'unverified' && mark(r5).wait.reason === 'plus_credit' && mark(r5).wait.via === 'plus'
      && mark(r5).wait.reset_at === resetAt && mark(r5).wait.checks === 0, JSON.stringify(mark(r5).wait) + ' ' + body(r5));

    // ---- 使えない状態（送る前に分かる）。上限の記憶は endpoint ごとなので、毎回 api-keys と harness を作り直す
    for (const [reason, over] of [['plus_logged_out', { signedIn: false }], ['plus_not_plus', { account: { status: 'free' } }], ['plus_maintenance', { state: 'maintenance' }]]) {
      const apiKeys2 = createApiKeys({ dataDir: root, secrets, plus: { apiBase: () => plus.url, session: () => session } });
      await apiKeys2.init();
      const hh = await createHarness({ waitMs: 400, decider: { route: () => apiKeys2.useRoute('computer:decider') } });
      try {
        session.set(over);
        hh.driver.setFrames(() => 90);
        const b = sent().length;
        const r = await hh.connect({ sessionId: 'p-' + reason }).call('wait_until', { title: 'x', until: UNTIL });
        t.ok(`${reason}: 送らず、unverified・${reason}・via plus（画面の差分だけで待つ）`, sent().length === b && mark(r).wait.status === 'unverified' && mark(r).wait.reason === reason && mark(r).wait.via === 'plus' && mark(r).wait.checks === 0, JSON.stringify(mark(r).wait) + ' ' + body(r));
      } finally { await hh.close(); session.set({ signedIn: true, available: true, state: 'on', account: plusAccount() }); }
    }

    // ---- 使わない（何も選んでいない）は今までどおり
    await apiKeys.setUse('computer:decider', null);
    const b6 = sent().length;
    const r6 = await call();
    t.ok('使わない: 送らず unverified・no_key・via なし（今までどおり）', sent().length === b6 && mark(r6).wait.status === 'unverified' && mark(r6).wait.reason === 'no_key' && !('via' in mark(r6).wait), JSON.stringify(mark(r6).wait));
  } finally { await h.close(); await plus.close?.(); await fs.rm(root, { recursive: true, force: true }); }
}
