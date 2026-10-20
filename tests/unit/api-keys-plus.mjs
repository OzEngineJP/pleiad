// 仮想のキー「Pleiad Plus」（core/api-keys.mjs の plus。docs/plus.md「キー無しの機能」）。
// 値を持たない・judge:jev と voice にだけ選べる・useEndpoint の表・ログイン時の自動の選択・中継の credit_exhausted の記憶。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiKeys, ApiKeyError } from '../../core/api-keys.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';

export const name = 'api-keys-plus';
export const title = '仮想のキー Pleiad Plus: 選べる使い道・useEndpoint・秘密に書かない・ログインの自動選択・credit_exhausted';

const A = 'sk-or-v1-' + 'a'.repeat(24);
const API = 'https://plus.test';
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** Pleiad Plus のセッションの身代わり。snapshot の中身は set() で変える */
function fakeSession(over = {}) {
  const snap = { signedIn: true, available: true, state: 'on', uid: 'u-1', account: { status: 'plus', usage: { credits: 10 }, limits: { creditsPerMonth: 100 } }, ...over };
  const calls = { token: 0, forced: 0, status: 0 };
  return {
    snapshot: () => snap,
    getIdToken: async ({ force } = {}) => { calls.token++; if (force) calls.forced++; return `tok-${calls.token}`; },
    status: async () => { calls.status++; return snap; },
    set: (o) => Object.assign(snap, o),
    calls,
  };
}

function wire(dir, { session, apiBase = API, env = {}, events = [] } = {}) {
  const secrets = createSecretStore({ file: path.join(dir, 'api-key-secrets.json'), cipher: plainCipher });
  const apiKeys = createApiKeys({ dataDir: dir, secrets, env,
    plus: session === undefined ? null : { apiBase: () => apiBase, session: () => session },
    onChange: (c) => events.push(c) });
  return { apiKeys, secrets, events };
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-apikeys-plus-'));
  let n = 0;
  const fresh = async () => { const d = path.join(root, `d${++n}`); await fs.mkdir(d, { recursive: true }); return d; };
  try {
    // ---- 選べる使い道
    {
      const d = await fresh();
      const session = fakeSession();
      const { apiKeys, secrets } = wire(d, { session });
      await apiKeys.init();
      t.ok('judge:jev と voice に plus を選べる', (await apiKeys.setUse('judge:jev', 'plus')).id === 'plus' && (await apiKeys.setUse('voice', 'plus')).id === 'plus');
      const err = await rejects(apiKeys.setUse('computer:decider', 'plus'));
      t.ok('computer:decider には選べない（UNSUPPORTED_USE）', err instanceof ApiKeyError && err.code === 'UNSUPPORTED_USE');
      const list = await apiKeys.list();
      const v = list.virtual?.[0];
      t.ok('一覧に { id:"plus", provider:"plus", label:"Pleiad Plus", virtual:true } が出る（値を持たないことが分かる）',
        v && v.id === 'plus' && v.provider === 'plus' && v.label === 'Pleiad Plus' && v.virtual === true && v.uses.length === 2);
      t.ok('秘密の置き場に plus の値は書かれない', !(await secrets.keys('key:')).includes('key:plus') && (await apiKeys.useKey('voice')) === null);
      t.ok('削除・値の確認・probe の対象にしない',
        (await rejects(apiKeys.remove('plus')))?.code === 'NOT_FOUND' && (await rejects(apiKeys.replace('plus', A)))?.code === 'NOT_FOUND' && (await rejects(apiKeys.check('plus')))?.code === 'NOT_FOUND');
      // id が plus の実のキーは読み込みで捨てず、仮想のキーとは別に扱う
      const d2 = await fresh();
      await fs.writeFile(path.join(d2, 'api-keys.json'), JSON.stringify({ version: 1, migration: { done: true },
        keys: [{ id: 'plus', provider: 'openrouter', label: 'id がぶつかった実のキー' }], uses: { voice: 'plus' } }));
      const w2 = wire(d2, { session });
      await w2.apiKeys.init();
      t.ok('台帳に id=plus の実のキーがあっても捨てない（仮想のキーと id はぶつからない）', (await w2.apiKeys.list()).keys.some((k) => k.id === 'plus' && k.provider === 'openrouter'));
    }

    // ---- useEndpoint の表
    {
      const d = await fresh();
      const session = fakeSession();
      const { apiKeys } = wire(d, { session, env: { AGENT_HOST_OPENROUTER_API: 'https://or.test/api' } });
      await apiKeys.init();
      const { id } = await apiKeys.add({ provider: 'openrouter', label: 'x', key: A });
      t.ok('選んでいなければ useEndpoint は null', (await apiKeys.useEndpoint('judge:jev')) === null && (await apiKeys.useEndpoint('voice')) === null);
      await apiKeys.setUse('judge:jev', id);
      const ep = await apiKeys.useEndpoint('judge:jev');
      t.ok('OpenRouter のキー（judge:jev）: kind=openrouter・AGENT_HOST_OPENROUTER_API の送り先・キーの Bearer',
        ep.kind === 'openrouter' && ep.baseUrl === 'https://or.test/api' && (await ep.authorization()) === `Bearer ${A}`);
      await apiKeys.setUse('voice', id);
      const vep = await apiKeys.useEndpoint('voice');
      t.ok('OpenRouter のキー（voice）: kind=openrouter・voice の送り先・キーの Bearer',
        vep.kind === 'openrouter' && vep.baseUrl === 'https://openrouter.ai/api/v1' && (await vep.authorization()) === `Bearer ${A}`);
      await apiKeys.setUse('judge:jev', 'plus');
      await apiKeys.setUse('voice', 'plus');
      const jep = await apiKeys.useEndpoint('judge:jev'), pep = await apiKeys.useEndpoint('voice');
      t.ok('plus（judge:jev）: kind=plus・<PLUS_API>/v1/proxy/openrouter・ID トークンの Bearer',
        jep.kind === 'plus' && jep.baseUrl === `${API}/v1/proxy/openrouter` && (await jep.authorization()) === 'Bearer tok-1');
      t.ok('plus（voice）: <PLUS_API>/v1/proxy/voice。AGENT_HOST_OPENROUTER_API は効かない',
        pep.baseUrl === `${API}/v1/proxy/voice` && !pep.baseUrl.includes('or.test'));
      t.ok('authorization は呼ぶたびに ID トークンを取る（force で取り直し）', (await jep.authorization({ force: true })) === 'Bearer tok-2' && session.calls.forced === 1);
      t.ok('hasUse は endpoint があるときだけ true（値は読まない）', (await apiKeys.hasUse('voice')) === true && (await apiKeys.hasUse('judge:jev')) === true);

      for (const [label, over] of [
        ['ログアウト', { signedIn: false }],
        ['status free', { account: { status: 'free' } }],
        ['status disabled', { account: { status: 'disabled' } }],
        ['state off', { state: 'off', available: false }],
        ['maintenance', { state: 'maintenance' }],
      ]) {
        session.set(over);
        t.ok(`${label} なら useEndpoint は null（キーが無いのと同じ扱い）`, (await apiKeys.useEndpoint('judge:jev')) === null && (await apiKeys.hasUse('judge:jev')) === false);
        session.set({ signedIn: true, available: true, state: 'on', account: { status: 'plus' } });
      }
      const failing = fakeSession();
      failing.getIdToken = async () => { throw new Error('x'); };
      const w3 = wire(await fresh(), { session: failing });
      await w3.apiKeys.init();
      await w3.apiKeys.setUse('voice', 'plus');
      const fep = await w3.apiKeys.useEndpoint('voice');
      const err = await rejects(fep.authorization());
      t.ok('ID トークンを取れなければ authorization は PLUS_SIGNED_OUT（null ではなく投げる）', err instanceof ApiKeyError && err.code === 'PLUS_SIGNED_OUT');
    }

    // ---- ログイン時の自動の選択
    {
      const d = await fresh();
      const session = fakeSession();
      const events = [];
      const { apiKeys } = wire(d, { session, events });
      await apiKeys.init();
      t.ok('両方とも「使わない」でログイン → 両方に plus を選び { uses, autoPlus } を出す',
        (await apiKeys.plusSignedIn()) === true && (await apiKeys.list()).uses['judge:jev'] === 'plus' && (await apiKeys.list()).uses.voice === 'plus'
          && events.some((c) => c.autoPlus === true && c.uses?.join() === 'judge:jev,voice'));
      t.ok('もう選んでいるなら何もしない（2 回目は emit しない）', (await apiKeys.plusSignedIn()) === false);
      const d2 = await fresh();
      const w2 = wire(d2, { session });
      await w2.apiKeys.init();
      const { id } = await w2.apiKeys.add({ provider: 'openrouter', label: 'x', key: A });
      await w2.apiKeys.setUse('voice', id);
      t.ok('片方でもキーを選んでいれば自動の選択は何もしない', (await w2.apiKeys.plusSignedIn()) === false && (await w2.apiKeys.list()).uses['judge:jev'] === null);
      const d3 = await fresh();
      const w3 = wire(d3, { session });
      await w3.apiKeys.init();
      await w3.apiKeys.setUse('judge:jev', 'plus');
      session.set({ signedIn: false });
      t.ok('ログアウトしても plus の選択は消えない', (await w3.apiKeys.list()).uses['judge:jev'] === 'plus');
      // 台帳に残る: 読み込み直しても plus のまま
      const w4 = wire(d3, { session });
      await w4.apiKeys.init();
      t.ok('plus の選択は api-keys.json に残り、読み込み直しても続く', JSON.parse(await fs.readFile(path.join(d3, 'api-keys.json'), 'utf8')).uses['judge:jev'] === 'plus'
        && (await w4.apiKeys.list()).uses['judge:jev'] === 'plus');
    }

    // ---- credit_exhausted の記憶（判定と通話で共有）
    {
      const session = fakeSession();
      const { apiKeys } = wire(await fresh(), { session });
      await apiKeys.init();
      await apiKeys.setUse('judge:jev', 'plus');
      const ep = await apiKeys.useEndpoint('judge:jev');
      // 中継が credit_exhausted を返した直後は、アカウントもその月の枠を使い切った表示になっている
      session.set({ account: { status: 'plus', usage: { credits: 100 }, limits: { creditsPerMonth: 100 } } });
      const future = new Date(Date.now() + 86400_000).toISOString();
      ep.noteCredit(future);
      t.ok('credit_exhausted の resetAt を覚えている間は blocked（送らない）', ep.creditBlocked() === true && (await apiKeys.plusCredit())?.resetAt === future);
      session.set({ account: { status: 'plus', usage: { credits: 5 }, limits: { creditsPerMonth: 100 } } });
      t.ok('アカウントの読み直しが上限未満を示したら解ける', ep.creditBlocked() === false && (await apiKeys.plusCredit()) === null);
      ep.noteCredit(new Date(Date.now() - 1000).toISOString());
      t.ok('resetAt を過ぎていれば解ける', ep.creditBlocked() === false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
