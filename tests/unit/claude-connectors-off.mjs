// 登録した Claude アカウントのコネクターの入口（ADR 0340 段 1）: オフ・未設定の会話の起動が変更前と 1 バイトも変わらないこと。LLM も本物の CLI も呼ばない。認証は固定の偽物だけ。
//   1. 入口の設定が 未設定 / 明示のオフ / 別のアカウントだけオン / 壊れた JSON / 知らない版 / 知らない値 のとき、全経路 × 全組み合わせの起動の記録が、
//      main で採った fixture（tests/fixtures/claude-launch-main.<win32|linux>.json。claude-launch-main-pinned）と同じ。新しい認証の解決はどれも「呼ばれたら失敗」の差し替え
//      起動の記録は重い（1 回の全組み合わせで約 120 回 CLI を起こす）ので、設定の違い 7 通りごとに全部を取り直さない。同じ入力からは同じ起動になるので、次の 3 つで同じことを確かめる:
//        a. 全組み合わせ × 全経路の起動の記録を 1 回取る。登録アカウントの組み合わせは、会話に渡す account を 7 通りの設定の入口の結果から順に回して選ぶ
//        b. 組み合わせごとに、7 通りすべての入口へ同じ account を通し、入口へ入る物と出る物が同じ（同じ account・中身もそのまま・process.env 全体も同じ）・新しい認証の解決 0 回
//        c. 7 通りそれぞれで、代表の組み合わせ（GATE_SCENARIOS）の起動の記録も取り、fixture と比べる
//   2. オフ・対象外では、同じ account を中身も変えずに返す・新しい認証の解決 0 回・設定の読み取りは入口自身の 1 回まで（対象外は 0 回）・ファイルの作成 0・タイマー 0
//   3. オンでも、段 1 は旧い経路のまま（認証の解決を 1 回呼び、「まだ使えない」で同じ account を返す。起動の記録も fixture と同じ）
//   4. キャッシュのキー: オフは今までの文字列、オンの識別子があるときだけ接尾辞
//   5. 設定の読み取りに書き込みの口が無い・画面・操作の一覧に出ていない・server の入口が 1 か所で入口を通る
//   6. 残った設定ファイルは、旧い accounts のコードの動きに影響しない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAll, digest, explain, scenarios, fixtureFile, ACCOUNT_ID, FAKE } from '../lib/claude-launch-record.mjs';
import { createClaudeConnectorsGate, createClaudeConnectorSettings, CONNECTORS_FILE, authNotAvailableYet, identitySuffix } from '../../core/claude-connectors.mjs';
import { createClaudeAccounts } from '../../core/claude-accounts.mjs';
import { accountScopeKeyForTest } from '../../core/backends/claude.mjs';

export const name = 'claude-connectors-off';
export const title = 'Claude コネクターの入口: 未設定・オフ・壊れた設定の起動が main の記録と同じ（認証の解決 0 回・読み取りは入口の 1 回まで）';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const OTHER = 'acct-other000001';
// account の中身の写し（自身の項目の名前と値。記号の名前・列挙されない項目も含める）。入口が中身を触っていないかを比べる
const accountShape = a => a && typeof a === 'object'
  ? JSON.stringify(Reflect.ownKeys(a).map(k => [String(k), Object.getOwnPropertyDescriptor(a, k).enumerable, a[k]])) : JSON.stringify(a ?? null);
// process.env 全体の写し（入口が env を足す・消す・変えていないかを比べる）
const envShape = () => JSON.stringify(Object.keys(process.env).sort().map(k => [k, process.env[k]]));
const SETTINGS = (accounts, version = 1) => JSON.stringify({ version, accounts });
// 入口の設定のバリエーション（text が null ならファイルを作らない）
const VARIANTS = {
  unset: null,
  explicitOff: SETTINGS({ [ACCOUNT_ID]: { enabled: false } }),
  otherOn: SETTINGS({ [OTHER]: { enabled: true } }),
  brokenJson: '{ "version": 1, "accounts": ',
  unknownVersion: SETTINGS({ [ACCOUNT_ID]: { enabled: true } }, 2),
  unknownValue: SETTINGS({ [ACCOUNT_ID]: { enabled: 'true', connectors: { x: { enabled: true } } } }),
  unknownShape: JSON.stringify({ version: 1, accounts: [{ id: ACCOUNT_ID, enabled: true }] }),
};
// 7 通りそれぞれで、入口を通した実際の起動の記録まで取る組み合わせ（親の env が最小のものと、認証の env が全部あるもの）
const GATE_SCENARIOS = ['plain/registered/none', 'allAuth/registered/none'];

/** 設定の違いごとに、設定ファイルを置いたデータ置き場と入口を作る（認証の解決は呼ばれたら失敗・呼ばれた回数と入口が変えた組み合わせを残す） */
async function openGates(base) {
  const gates = {};
  for (const [variant, text] of Object.entries(VARIANTS)) {
    const dataDir = path.join(base, variant);
    await fs.mkdir(dataDir, { recursive: true });
    if (text !== null) await fs.writeFile(path.join(dataDir, CONNECTORS_FILE), text);
    const seen = { authCalls: 0, changed: [] };
    const { gate } = createClaudeConnectorsGate({ dataDir, resolveAuth: async () => { seen.authCalls++; throw new Error('新しい認証の解決が呼ばれた'); } });
    gates[variant] = { gate, seen };
  }
  return gates;
}

export default async function (t) {
  const want = JSON.parse(await fs.readFile(fixtureFile(), 'utf8'));
  const labels = scenarios().map(([p, a, e]) => `${p}/${a}/${e}`);

  // 1. オフ・未設定・壊れた設定の起動が main の記録と同じ（新しい認証の解決は呼ばれたら失敗）
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-cn-gates-')));
  try {
    const gates = await openGates(base);
    const variants = Object.keys(gates);
    // a + b. 全組み合わせ × 全経路の起動の記録を 1 回取る。入口は組み合わせごとに 7 通りすべてを通し、起動に使う account は 7 通りから順に回して選ぶ
    let turn = 0;
    const all = digest(await recordAll({
      root: REPO,
      accountFor: async (accounts, id) => {
        const resolved = await accounts.resolve(id);
        const shape = accountShape(resolved), env = envShape();
        const used = id ? variants[turn++ % variants.length] : null;
        let picked = resolved;
        for (const variant of variants) {
          const gated = await gates[variant].gate(resolved);
          if (gated !== resolved || accountShape(resolved) !== shape || envShape() !== env) gates[variant].seen.changed.push(id || '(指定なし)');
          if (variant === used) picked = gated;
        }
        return picked;
      },
      dumpName: 'off-all',
    }));
    const bad = explain(want, all);
    t.ok(`全 ${labels.length} 組み合わせ × 経路の起動の記録が main と同じ（登録アカウントの組み合わせは、会話に渡す account を 7 通りの設定の入口の結果から順に回して選ぶ）`, bad.count === 0, bad.text);

    // c. 7 通りそれぞれで、代表の組み合わせの起動の記録
    const wantSome = Object.fromEntries(GATE_SCENARIOS.map(label => [label, want[label]]));
    for (const variant of variants) {
      const { gate, seen } = gates[variant];
      const got = digest(await recordAll({
        root: REPO,
        only: GATE_SCENARIOS,
        accountFor: async (accounts, id) => {
          const resolved = await accounts.resolve(id);
          const shape = accountShape(resolved), env = envShape();
          const gated = await gate(resolved);
          if (gated !== resolved || accountShape(resolved) !== shape || envShape() !== env) seen.changed.push(id || '(指定なし)');
          return gated;
        },
        dumpName: `off-${variant}`,
      }));
      const some = explain(wantSome, got);
      t.ok(`${variant}: 全 ${labels.length} 組み合わせで入口は同じ account を中身も変えずに返し process.env も変えない・新しい認証の解決 0 回・代表 ${GATE_SCENARIOS.length} 組み合わせの起動の記録が main と同じ`,
        some.count === 0 && seen.changed.length === 0 && seen.authCalls === 0, `calls=${seen.authCalls} changed=${[...new Set(seen.changed)].join(',')} ${some.text}`);
    }
  } finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 5 }); }

  // 3. オンでも段 1 は旧い経路のまま
  {
    let authCalls = 0;
    const got = digest(await recordAll({
      root: REPO,
      only: ['plain/registered/none', 'allAuth/registered/none', 'plain/none/none'],
      onSetup: async ({ data }) => { await fs.writeFile(path.join(data, CONNECTORS_FILE), SETTINGS({ [ACCOUNT_ID]: { enabled: true } })); },
      accountFor: async (accounts, id, { data }) => {
        const { gate } = createClaudeConnectorsGate({ dataDir: data, resolveAuth: async a => { authCalls++; return authNotAvailableYet(a); } });
        return gate(await accounts.resolve(id));
      },
    }));
    const bad = explain(Object.fromEntries(Object.keys(got).map(label => [label, want[label]])), got);
    t.ok('オン（段 1）: 認証の解決は登録アカウントの 1 組み合わせにつき 1 回だけ呼ばれ、起動の記録は旧い経路のまま（fixture と同じ）', bad.count === 0 && authCalls === 2, `calls=${authCalls} ${bad.text}`);
  }

  // 2. 設定の読み取り・ファイル・タイマーの回数
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-cn-off-')));
  try {
    const origRead = fs.readFile, origSet = globalThis.setTimeout, origInt = globalThis.setInterval;
    for (const [variant, text] of Object.entries(VARIANTS)) {
      const data = path.join(tmp, variant);
      await fs.mkdir(data, { recursive: true });
      if (text !== null) await fs.writeFile(path.join(data, CONNECTORS_FILE), text);
      const before = (await fs.readdir(data)).sort().join();
      const reads = []; let timers = 0, auth = 0;
      fs.readFile = (p, ...rest) => { reads.push(String(p)); return origRead(p, ...rest); };
      globalThis.setTimeout = (...a) => { timers++; return origSet(...a); };
      globalThis.setInterval = (...a) => { timers++; return origInt(...a); };
      const account = { id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered };
      let sameAccount, sameNull, sameLogin, untouched;
      try {
        const { gate } = createClaudeConnectorsGate({ dataDir: data, resolveAuth: async () => { auth++; return null; } });
        const noIdIn = { name: 'x' };
        const shapes = [account, noIdIn].map(accountShape);
        const nullAccount = await gate(null), noId = await gate(noIdIn);
        sameNull = nullAccount === null && noId === noIdIn;
        const readsForUnspecified = reads.length;
        sameAccount = await gate(account);
        sameLogin = readsForUnspecified === 0;
        // 同じ物を返すだけでなく、中身も触らない（項目を足す・消す・変えるのも、起動の記録に出ない経路で効くことがあるため）
        untouched = JSON.stringify([account, noIdIn].map(accountShape)) === JSON.stringify(shapes);
      } finally { fs.readFile = origRead; globalThis.setTimeout = origSet; globalThis.setInterval = origInt; }
      const after = (await fs.readdir(data)).sort().join();
      t.ok(`${variant}: 指定なし・id 無しは設定を読まない / オフの登録アカウントは入口自身の 1 回だけ読み、同じ account を中身も変えずに返す / 認証 0 回・作成 0・タイマー 0`,
        sameNull && sameLogin && sameAccount === account && untouched && reads.length === 1 && reads[0].endsWith(CONNECTORS_FILE) && auth === 0 && before === after && timers === 0,
        JSON.stringify({ sameNull, sameLogin, same: sameAccount === account, untouched, reads: reads.length, auth, before, after, timers }));
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }); }

  // 4. キャッシュのキー
  t.ok('キー: オフは今までの文字列（login / account:<id>。文字列でもオブジェクトでも、識別子が空・無しでも同じ）',
    accountScopeKeyForTest(null) === 'login' && accountScopeKeyForTest('') === 'login' && accountScopeKeyForTest({ id: ACCOUNT_ID }) === `account:${ACCOUNT_ID}`
    && accountScopeKeyForTest(ACCOUNT_ID) === `account:${ACCOUNT_ID}` && accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: {} }) === `account:${ACCOUNT_ID}`
    && accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: { identity: '' } }) === `account:${ACCOUNT_ID}`
    && identitySuffix('') === '' && identitySuffix(undefined) === '');
  t.ok('キー: オンの識別子があるときだけ接尾辞（アカウントごと・識別子ごとに別のキー）',
    accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: { identity: 'abc' } }) === `account:${ACCOUNT_ID}:cn:abc`
    && accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: { identity: 'abc' } }) !== accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: { identity: 'def' } }));

  // 5. 書き込みの口・画面・操作の一覧に出ていない / server の入口
  const settings = createClaudeConnectorSettings({ dataDir: os.tmpdir() });
  t.ok('設定の読み取りは read だけ（書き込みの口が無い）', JSON.stringify(Object.keys(settings).sort()) === JSON.stringify(['file', 'read']));
  const hits = [];
  for (const dir of ['core/ops', 'web', 'mobile', 'bin', 'desktop']) {
    for (const f of await fs.readdir(path.join(REPO, dir), { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (!f.isFile() || !/\.(mjs|js|html|css|json)$/.test(f.name)) continue;
      const p = path.join(f.parentPath ?? f.path, f.name);
      if (/claude-account-connectors|CONNECTORS_FILE|claude-connectors\.mjs/.test(await fs.readFile(p, 'utf8').catch(() => ''))) hits.push(path.relative(REPO, p));
    }
  }
  t.ok('入口の設定は ops・画面・CLI・モバイル・デスクトップに出ていない', hits.length === 0, hits.join(', '));
  const server = await fs.readFile(path.join(REPO, 'core/server.mjs'), 'utf8');
  const gateCalls = [...server.matchAll(/claudeAccountConnectors\.gate\(/g)].length;
  t.ok('server は入口を accountResolve の 1 か所だけで呼び、登録アカウントを引いた直後に通す',
    gateCalls === 1 && /return claudeAccountConnectors\.gate\(await claudeAccounts\.resolve\(id\)\);/.test(server));

  // 6. 残った設定ファイルは旧い accounts のコードに影響しない
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-cn-left-')));
  try {
    await fs.writeFile(path.join(dir, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: ACCOUNT_ID, name: 'fake-account', createdAt: '2026-01-01T00:00:00.000Z' }] }));
    await fs.writeFile(path.join(dir, CONNECTORS_FILE), SETTINGS({ [ACCOUNT_ID]: { enabled: true } }));
    const secrets = { get: async () => ({ token: FAKE.registered }), keys: async () => [], status: async () => null, set: async () => {}, delete: async () => {} };
    const accounts = createClaudeAccounts({ dataDir: dir, secrets, cliConfig: path.join(dir, 'no-cli.json') });
    const resolved = await accounts.resolve(ACCOUNT_ID);
    const listed = await accounts.list();
    t.ok('設定ファイルが残っていても、旧い accounts は今までどおり読める（resolve・list）',
      resolved?.token === FAKE.registered && Object.keys(resolved).sort().join() === 'id,name,token' && JSON.stringify(listed).includes(ACCOUNT_ID) && !JSON.stringify(listed).includes('connectors'));
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
}
