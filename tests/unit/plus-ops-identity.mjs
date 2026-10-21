// Plus のアカウントを名指しする欄（uid・email）を、agent（CLI の pleiad plus status・ply_control・pleiad mcp）に出さない（docs/plus.md「状態」）。
// サーバーを立てずに、偽の依存を渡した invoke で確かめる。
//   - plus.status: 状態の上の段の uid（core/plus/session.mjs の statusShape）と account の uid・email
//   - voice.status・delegation.routing: 混ぜて返す Plus の行（plus.email）
//   - 画面（人）には今のまま返す
import { registry } from '../../core/ops/index.mjs';

export const name = 'plus-ops-identity';
export const title = 'Plus の操作: agent には uid・メールを出さない（画面には今のまま）';

// 偽の値。どの欄に紛れても文字列で見つかるように、ほかの値と重ならない形にする
const UID = 'fake-uid-7f3a9c1e5b';
const EMAIL = 'someone@example.invalid';

const human = { by: 'human', via: 'ui', local: true };
const cli = { by: 'agent', via: 'cli', sessionId: 'me' };
const mcp = { by: 'agent', via: 'mcp', sessionId: 'me' };

const plusRow = () => ({ available: true, state: 'on', signedIn: true, status: 'plus', email: EMAIL, reachable: true, limitReached: false, resetAt: null, profileUrl: null });

export default async function (t) {
  const deps = {
    locale: 'ja', modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }),
    plus: {
      status: async () => ({
        available: true, state: 'on', needsUpdate: false, signedIn: true, login: { phase: 'idle' },
        account: { uid: UID, email: EMAIL, provider: 'google', status: 'plus', plan: { id: 'p', name: 'Plus' }, limits: null, usage: null, sync: { enabled: false } },
        accountReadAt: 1, uid: UID, reachable: true, error: null, urls: { account: null, profile: null }, host: null, checkedAt: 'x',
      }),
    },
    voice: { status: async () => ({ hasKey: false, keyRef: null, via: 'plus', plus: plusRow(), storage: null, today: { callSeconds: 0, sttSeconds: 0, ttsChars: 0 }, active: 0 }) },
    prefs: async () => ({}),
    delegation: {
      routing: async () => ({ settings: { enabled: true }, warnings: [], candidates: [],
        keys: { openrouter: { via: 'plus', hasKey: false, keyRef: null, plus: plusRow() }, other: { via: null, hasKey: false, keyRef: null, plus: null } } }),
    },
  };
  const run = (p, id, args = {}) => registry.invoke(p, id, args, deps);
  const leaks = (r) => { const s = JSON.stringify(r); return s.includes(UID) || s.includes(EMAIL); };

  const viaCli = await run(cli, 'plus.status');
  t.ok('plus.status（CLI の pleiad plus status）: 返りに uid もメールも含まない', viaCli.ok && !leaks(viaCli.result));
  t.ok('plus.status: 上の段の uid も account の uid・email も伏せ字（欄は残る）',
    viaCli.ok && viaCli.result.uid === '••••' && viaCli.result.account.uid === '••••' && viaCli.result.account.email === '••••'
    && viaCli.result.signedIn === true && viaCli.result.account.status === 'plus');
  const viaMcp = await run(mcp, 'plus.status');
  t.ok('plus.status（ply_control）: uid もメールも含まない', viaMcp.ok && !leaks(viaMcp.result));
  const viaUi = await run(human, 'plus.status');
  t.ok('plus.status（画面）: 今のまま返す', viaUi.ok && viaUi.result.uid === UID && viaUi.result.account.email === EMAIL);

  const voice = await run(cli, 'voice.status');
  t.ok('voice.status: agent には Plus の行のメールを出さない', voice.ok && !leaks(voice.result) && voice.result.plus.email === '••••' && voice.result.plus.signedIn === true);
  t.ok('voice.status（画面）: 今のまま返す', (await run(human, 'voice.status')).result.plus.email === EMAIL);

  const routing = await run(mcp, 'delegation.routing');
  t.ok('delegation.routing: agent には keys の Plus の行のメールを出さない（plus が null の行はそのまま）',
    routing.ok && !leaks(routing.result) && routing.result.keys.openrouter.plus.email === '••••' && routing.result.keys.other.plus === null);
}
