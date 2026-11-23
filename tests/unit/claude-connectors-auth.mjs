// 登録した Claude アカウントのコネクターの認証（ADR 0340 段 2。方式 (b1)）。LLM も本物の CLI も本物の資格情報も使わない。トークン・メール・組織の id はすべて偽の値。
//   1. 資格情報の読み取り: アクセス用トークン・期限・権限だけを返す（更新用トークンは返さない）・無い／形違い／壊れて見える間の読み直し
//   2. 設定の反映（projectProfile）: 許可した項目だけ・既存の値を上書きしない・冪等（変わらなければ書かない）・元の ~/.claude.json を変えない・認証や組織の情報を写さない
//   3. 認証の解決: 成功の形（会話用トークンへ戻さない）・止める条件ごとの失敗（OS・別の認証の環境変数・履歴の場所・版・持ち主・ログイン・形・期限・反映）・
//      更新は CLI に任せる（期限が近いときだけ 1 回）・止めた理由に秘密が出ない・process.env を変えない
//   4. 起動の記録（オン）: オフの記録との差が「認証に要る 3 つの環境変数」だけ（argv・cwd・ほかの env・SDK の options・保持役への変換は同じ）。互換接続は同じ
//   5. オフ・未設定・別アカウント・壊れた設定: 認証側のどの関数（持ち主の確認・版・資格情報の読み取り・更新・設定の反映・印付け・時計・待ち）も 0 回・ファイルの作成 0・タイマー 0
//   6. 使用量の読み取りの排他（印を付けたフォルダだけ・印の前から走っていた読み取りも待つ・オフで印を外す）・server の配線（入口の設定と印・更新の口）
//   7. 設定 › 外部 MCP のコネクターの一覧（connectorListProbe）: オンは会話と同じ組み立て・止める条件はログイン中へ戻らない・オフは今までの呼び方
//   8. 付け直し（adoptTurn）も認証を通る・一覧の覚えは入口オンのキーも一緒に消える
//   9. 作業場所のキー（CLI 2.1.322 の作り方: worktree は本体・Windows は / ・ドライブ文字はそのまま）
//  10. 設定の反映の書き方（足す物が無ければ書かない・壊れた反映先で止める・直前の別の書き込みを残す・付け替えの一時的な失敗の繰り返し・状態が同じなら読まない）
//  11. 共有の settings.json の別の認証（env・apiKeyHelper・読めない・壊れている）で止める
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAll, ACCOUNT_ID, FAKE } from '../lib/claude-launch-record.mjs';
import { createClaudeConnectorsGate, CONNECTORS_FILE, identitySuffix } from '../../core/claude-connectors.mjs';
import {
  createClaudeConnectorsAuth, readAccessCredentials, readMacAccessCredentials, projectProfile, ConnectorsAuthError, VERIFIED_VERSIONS, IDENTITY, REFRESH_WINDOW_MS, READ_ATTEMPTS,
  projectKeyOf, settingsOverrides, PROFILE_IO, connectorListProbe, createClaudeConnectorsWiring, supportedConnectorVersions, createConnectorVerification,
} from '../../core/claude-connectors-auth.mjs';
import { withUsageLock, createUsageReadsForTest } from '../../core/backends/claude-usage.mjs';
import { backend as claudeBackend, accountScopeKeyForTest, catalogStateKeysForTest } from '../../core/backends/claude.mjs';

export const name = 'claude-connectors-auth';
export const title = 'Claude コネクターの認証（段 2）: アクセス用トークンだけを使う・設定の反映・止める条件・オンの差分は 3 つの環境変数だけ・オフは何も呼ばない';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const T0 = Date.parse('2026-11-18T12:00:00Z');
// 偽の秘密（本物ではない）。どの出力・記録にも出てはいけない
const ACCESS = 'fake-access-token-AAAAAAAAAAAAAAAAAAAA-0001';
const ACCESS2 = 'fake-access-token-BBBBBBBBBBBBBBBBBBBB-0002';
const REFRESH = 'fake-refresh-token-RRRRRRRRRRRRRRRRRRRR-0003';
const EMAIL = 'fake.person@example.invalid';
const ORG = 'fake-org-uuid-0000-1111-2222';
const SCOPES = ['user:inference', 'user:profile', 'user:mcp_servers', 'user:file_upload'];
const SECRETS = [ACCESS, ACCESS2, REFRESH, EMAIL, ORG, FAKE.registered];
const credsJson = ({ token = ACCESS, expiresAt = T0 + 8 * 3600_000, scopes = SCOPES, refreshTokenExpiresAt } = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: REFRESH, expiresAt, refreshTokenExpiresAt, scopes, subscriptionType: 'max' }, oauthAccount: { emailAddress: EMAIL, organizationUuid: ORG } });
const leaked = text => SECRETS.filter(s => String(text).includes(s));
/** 401 のとき保存された資格情報・ホストのトークン・別の出どころへ乗り換える道を開く指定（CLI 2.1.322。ADR 0340）。確かめから外すと落ちることを 1 つずつ確かめる */
const SWITCH_ON_401 = ['ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_BG_AUTH_SNAPSHOT_PATH'];
const SWITCH_VALUE = 'fake-switch-value-SSSS-0011';
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

export default async function (t) {
  const pin = JSON.parse(await fs.readFile(new URL('../../core/claude-sdk-pin.json', import.meta.url), 'utf8'));
  t.ok('SDK の固定値と確認済み一覧が一致する', VERIFIED_VERSIONS.length > 0 && VERIFIED_VERSIONS.every(v => v.sdk === pin.version));
  for (const cli of ['2.1.322', '2.1.328', '2.2.0']) {
    t.ok(`CLI ${cli} は下限以上`, supportedConnectorVersions({ cli, sdk: pin.version }));
  }
  for (const cli of ['2.1.321', '2.0.999', null, '', 'unknown', '2.1.328-beta', '2.1.328junk']) {
    t.ok(`古い・不明な CLI は停止 (${cli})`, !supportedConnectorVersions({ cli, sdk: pin.version }));
  }
  t.ok('新しい SDK も完全一致しなければ停止', !supportedConnectorVersions({ cli: '2.2.0', sdk: '0.3.289' }));
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-cn-auth-')));
  const consoleLines = [];
  const savedConsole = {};
  // 認証側が出力した行だけを集める（試験の判定の行は、runner が console.log で出すので、そのまま通す）
  const RUNNER_LINE = /^\s*(OK|NG|SKIP)\s/;
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    savedConsole[k] = console[k];
    console[k] = (...a) => { const text = a.map(String).join(' '); if (RUNNER_LINE.test(text)) savedConsole[k].apply(console, a); else consoleLines.push(text); };
  }
  const restoreConsole = () => { for (const [k, v] of Object.entries(savedConsole)) console[k] = v; };
  const savedProcessEnv = JSON.stringify(process.env);
  try {
    {
      const dir = path.join(tmp, 'verification-usage'), home = path.join(tmp, 'verification-home');
      const shared = path.join(home, '.claude');
      await fs.mkdir(dir, { recursive: true }); await fs.mkdir(shared, { recursive: true });
      await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL } }));
      const args = { account: { id: ACCOUNT_ID, name: 'fake' }, ver: { cli: '2.1.328', sdk: '0.3.288' }, auth: { token: ACCESS, env: {} }, dir, shared, home, expectedIdentity: hashConnectorIdentity([ORG, EMAIL]) };
      let calls = 0;
      const good = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { account: { organization: ORG, email: EMAIL, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' }, connectors: ['alpha'] }; };
      const dataDir = path.join(tmp, 'verification-data');
      const verify = createConnectorVerification({ dataDir, probe: good });
      await Promise.all([verify(args), verify(args), verify(args)]);
      t.ok('初回確認: 同時起動は一組だけ（専用・共有の二起動）', calls === 2);
      await createConnectorVerification({ dataDir, probe: () => { throw new Error('記録があれば呼ばない'); } })(args);
      t.ok('初回確認: 保存した版は再起動後も起動しない', calls === 2);
      const record = await fs.readFile(path.join(dataDir, 'claude-connectors-verification', (await fs.readdir(path.join(dataDir, 'claude-connectors-verification')))[0]), 'utf8');
      t.ok('初回確認: 記録に秘密がない', leaked(record).length === 0);
      const previousCalls = calls;
      await verify({ ...args, ver: { ...args.ver, cli: '2.2.0' } });
      t.ok('初回確認: CLI が変われば確認し直す', calls === previousCalls + 2);
      let listCalls = 0;
      for (const [label, profile] of [['別の人', { organizationUuid: ORG, emailAddress: 'other@example.invalid' }], ['欠落', {}]]) {
        await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: profile }));
        const error = await verify(args).then(() => null, e => e);
        t.ok(`使用量の本人情報が${label}なら記録済みでも停止`, error?.code === 'connectors-owner');
      }
      await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL } }));
      await createConnectorVerification({ dataDir: path.join(tmp, 'no-sdk-person'), probe: async () => ({account: {tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty'}, connectors: []}) })(args);
      t.ok('SDK が本人を返さなくても使用量の本人情報と共有の認証元で照合できる', true);
      for (const [label, probe, kind] of [
        ...['shared-login', 'missing', 'provider'].map(label => [label, async () => ({ account: label === 'missing' ? {} : { tokenSource: label === 'shared-login' ? 'oauth' : 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: label === 'provider' ? 'bedrock' : 'firstParty' }, connectors: ['alpha'] }), 'owner']),
        ['持ち主違い', async () => ({ account: { organization: ORG, email: 'other@example.invalid' }, connectors: [] }), 'owner'],
        ['一覧混入', async () => ({ account: { organization: ORG, email: EMAIL, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' }, connectors: [++listCalls === 1 ? 'alpha' : 'beta'] }), 'verificationList'],
        ['ホームの本人変更', async () => { await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: String(Math.random()) } })); return good(); }, 'verificationWrites'],
        ['ホームの組織変更', async () => { await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'fake-other-organization', emailAddress: EMAIL } })); return good(); }, 'verificationWrites'],
        ['時間切れ', () => new Promise(() => {}), 'verificationTimeout'],
      ]) {
        await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL } }));
        const check = createConnectorVerification({ dataDir: path.join(tmp, `v-${label}`), probe, timeoutMs: 100 });
        let error;
        try { await check(args); } catch (e) { error = e; }
        t.ok(`初回確認: ${label}で停止`, error?.code === `connectors-${kind}`, error?.code);
        const records = await fs.readdir(path.join(tmp, `v-${label}`, 'claude-connectors-verification')).catch(() => []);
        t.ok(`初回確認: ${label}の失敗は記録しない`, records.length === 0);
        await createConnectorVerification({ dataDir: path.join(tmp, `v-${label}`), probe: good })(args);
        t.ok(`初回確認: ${label}の失敗後は待ち続けず再試行できる`, true);
      }
      for (const state of ['present', 'missing', 'unreadable']) {
        const homeFile = path.join(home, '.claude.json');
        if (state === 'missing') await fs.rm(homeFile, { force: true });
        else await fs.writeFile(homeFile, state === 'present' ? JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL }, count: 0 }) : '{broken');
        const check = createConnectorVerification({ dataDir: path.join(tmp, `allowed-${state}`), probe: async () => {
          await fs.writeFile(path.join(shared, '.claude.json'), JSON.stringify({ count: Math.random() }));
          await fs.writeFile(path.join(shared, 'settings.json'), JSON.stringify({ count: Math.random() }));
          await fs.writeFile(path.join(shared, 'unrelated.json'), '{}');
          if (state === 'present') await fs.writeFile(homeFile, JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL }, count: Math.random() }));
          else if (state === 'unreadable') await fs.writeFile(homeFile, '{different broken');
          return good();
        } });
        await check(args);
        t.ok(`初回確認: 共有の書込み・ホームの本人以外の変更を許可 (${state})`, true);
      }
      t.ok('初回確認: 記録の一時ファイルが残らない', (await fs.readdir(path.join(dataDir, 'claude-connectors-verification'))).every(f => f.endsWith('.json')));
    }
    // ---------------------------------------------------------------- 1. 資格情報の読み取り
    {
      const dir = path.join(tmp, 'cred'); await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, '.credentials.json');
      await fs.writeFile(file, credsJson());
      const ok = await readAccessCredentials(dir);
      t.ok('資格情報: アクセス用トークン・期限・権限だけを返す（更新用トークン・メール・組織は返さない）',
        ok.token === ACCESS && ok.expiresAt === T0 + 8 * 3600_000 && JSON.stringify(ok.scopes) === JSON.stringify(SCOPES)
        && Object.keys(ok).sort().join() === 'expiresAt,scopes,token' && leaked(JSON.stringify(ok).replace(ACCESS, '')).length === 0, JSON.stringify(Object.keys(ok)));
      t.ok('資格情報: 権限の並びは記録のまま（順序を保つ）', ok.scopes.join(' ') === SCOPES.join(' '));
      await fs.rm(file);
      t.ok('資格情報: 無ければ null（読み直さない）', await readAccessCredentials(dir) === null);
      const bad = {
        'accessToken が無い': JSON.stringify({ claudeAiOauth: { expiresAt: T0, scopes: SCOPES } }),
        'accessToken が短い': JSON.stringify({ claudeAiOauth: { accessToken: 'short', expiresAt: T0, scopes: SCOPES } }),
        '期限が数でない': JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, expiresAt: 'soon', scopes: SCOPES } }),
        '権限が空': JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, expiresAt: T0, scopes: [] } }),
        '権限に空白入りの値': JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, expiresAt: T0, scopes: ['a b'] } }),
        'claudeAiOauth が無い': JSON.stringify({ mcpOAuth: {} }),
      };
      for (const [label, text] of Object.entries(bad)) {
        await fs.writeFile(file, text);
        const got = await readAccessCredentials(dir);
        t.ok(`資格情報: 形が違う（${label}）→ malformed`, got?.malformed === true && !got.token, JSON.stringify(got));
      }
      // 壊れて見える間（CLI の書き換え中）は読み直す
      const seq = ['{ "claudeAiOauth": ', '', credsJson()]; let reads = 0, sleeps = 0;
      const got = await readAccessCredentials(dir, { readFile: async () => seq[reads++], sleep: async () => { sleeps++; } });
      t.ok('資格情報: 壊れて見える間は読み直し、読めたらその値を返す', got?.token === ACCESS && reads === 3 && sleeps === 2, `reads=${reads} sleeps=${sleeps}`);
      reads = 0;
      const stuck = await readAccessCredentials(dir, { readFile: async () => { reads++; return '{ broken'; }, sleep: async () => {} });
      t.ok(`資格情報: ずっと壊れていれば ${READ_ATTEMPTS} 回で諦めて malformed`, stuck?.malformed === true && reads === READ_ATTEMPTS, `reads=${reads}`);
      reads = 0;
      const denied = await readAccessCredentials(dir, { readFile: async () => { reads++; throw Object.assign(new Error('x'), { code: 'EACCES' }); }, sleep: async () => {} });
      t.ok('資格情報: 読めない（権限）は読み直したうえで null', denied === null && reads === READ_ATTEMPTS, `reads=${reads}`);
    }

    // ---------------------------------------------------------------- 2. 設定の反映（projectProfile）
    {
      const root = path.join(tmp, 'proj', 'repo'); const sub = path.join(root, 'pkg', 'src');
      await fs.mkdir(path.join(root, '.git'), { recursive: true }); await fs.mkdir(sub, { recursive: true });
      const otherProject = path.join(tmp, 'proj', 'other');
      const home = path.join(tmp, 'ph'); await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      const source = path.join(home, '.claude.json'), target = path.join(home, '.claude', '.claude.json');
      const key = root.replaceAll('\\', '/');   // どちらの形のキーでも引く
      await fs.writeFile(source, JSON.stringify({
        userID: 'fake-user-id', oauthAccount: { emailAddress: EMAIL, organizationUuid: ORG }, cachedGrowthBookFeatures: { x: 1 }, cachedModels: ['m'],
        mcpServers: { alpha: { type: 'http', url: 'https://alpha.example.invalid' }, beta: { type: 'stdio', command: 'beta' } },
        projects: {
          [key]: { mcpServers: { gamma: { type: 'stdio', command: 'gamma' } }, allowedTools: ['Bash(ls)'], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
            history: [{ display: 'secret prompt' }], lastCost: 1.5, lastSessionId: 'sess-secret', enabledMcpjsonServers: ['x'] },
          [otherProject]: { hasTrustDialogAccepted: true, mcpServers: { delta: { command: 'delta' } } },
        },
      }));
      await fs.writeFile(target, JSON.stringify({ oauthAccount: { emailAddress: 'someone.else@example.invalid' }, mcpServers: { alpha: { type: 'http', url: 'https://mine.example.invalid' } }, projects: { [key]: { allowedTools: ['mine'] } } }));
      const sourceSha = await sha(source);
      const first = await projectProfile({ source, target, cwd: sub });
      const out = await readJson(target);
      const proj = out.projects[key];
      t.ok('反映: 最上位は mcpServers だけを足す（既にある名前は反映先が勝ち・無い名前を足す）・認証・組織・モデル・利用者の id は写さない',
        first.changed === true && out.mcpServers.alpha.url === 'https://mine.example.invalid' && out.mcpServers.beta.command === 'beta'
        && out.oauthAccount.emailAddress === 'someone.else@example.invalid' && !('userID' in out) && !('cachedGrowthBookFeatures' in out) && !('cachedModels' in out), JSON.stringify(Object.keys(out)));
      t.ok('反映: 作業場所（Git のルート）ごとの許可した項目だけを足す・既にある値は上書きしない・履歴や直近のセッションは写さない・別の作業場所は写さない',
        JSON.stringify(proj.allowedTools) === '["mine"]' && proj.mcpServers?.gamma?.command === 'gamma' && proj.hasTrustDialogAccepted === true && proj.hasCompletedProjectOnboarding === true
        && !('history' in proj) && !('lastCost' in proj) && !('lastSessionId' in proj) && !('enabledMcpjsonServers' in proj) && Object.keys(out.projects).length === 1, JSON.stringify(proj));
      t.ok('反映: 元の（ホーム直下の）.claude.json は 1 バイトも変わらない', await sha(source) === sourceSha);
      const mtime = (await fs.stat(target)).mtimeMs;
      const bytes = await fs.readFile(target, 'utf8');
      await new Promise(r => setTimeout(r, 30));
      const second = await projectProfile({ source, target, cwd: sub });
      t.ok('反映: 2 回目は変わらず（書かない・更新時刻も内容も同じ）', second.changed === false && (await fs.stat(target)).mtimeMs === mtime && await fs.readFile(target, 'utf8') === bytes);
      t.ok('反映: 一時ファイルが残らない', (await fs.readdir(path.dirname(target))).every(n => !n.endsWith('.tmp')), (await fs.readdir(path.dirname(target))).join(','));
      // 反映先が無い → 許可した項目だけで作る
      const fresh = path.join(home, 'fresh', '.claude.json');
      const made = await projectProfile({ source, target: fresh, cwd: root });
      const madeJson = await readJson(fresh);
      t.ok('反映: 反映先が無ければ作る（許可した項目だけ。認証の項目は無い）',
        made.changed === true && Object.keys(madeJson).sort().join() === 'mcpServers,projects' && !JSON.stringify(madeJson).includes(EMAIL) && !JSON.stringify(madeJson).includes(ORG));
      // 元が無い・同じ物・壊れている
      const none = await projectProfile({ source: path.join(home, 'nothing.json'), target: path.join(home, 'x', '.claude.json'), cwd: root });
      t.ok('反映: 元が無ければ何もしない（反映先も作らない）', none.changed === false && !(await fs.stat(path.join(home, 'x')).then(() => true, () => false)));
      const same = await projectProfile({ source: target, target, cwd: root });
      t.ok('反映: 元と反映先が同じ物（CLAUDE_CONFIG_DIR を親が指定したとき）なら何もしない', same.changed === false);
      const brokenSource = path.join(home, 'broken.json'); await fs.writeFile(brokenSource, '{ "mcpServers": ');
      const before = await sha(target);
      const failed = await projectProfile({ source: brokenSource, target, cwd: root }).then(() => null, e => e);
      t.ok('反映: 元が壊れていれば投げ（認証側が止める）、反映先は変えない', failed instanceof Error && await sha(target) === before);
    }

    // ---------------------------------------------------------------- 3. 認証の解決
    {
      const usageRoot = path.join(tmp, 'auth-usage');
      const dir = path.join(usageRoot, ACCOUNT_ID); await fs.mkdir(dir, { recursive: true });
      const credFile = path.join(dir, '.credentials.json');
      const home = path.join(tmp, 'auth-home');
      const calls = { versions: 0, owner: 0, refresh: 0, project: 0, guard: 0 };
      const projectArgs = [];
      const loginFailures = [];
      let owner = 'ok', versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }, refreshWrites = null, refreshThrows = false, projectThrows = false;
      let now = T0;
      const make = (over = {}) => createClaudeConnectorsAuth({
        accounts: { usageDir: id => path.join(usageRoot, id), ownerStatus: async () => { calls.owner++; if (owner instanceof Error) throw owner; return owner; } },
        versions: async () => { calls.versions++; if (versions instanceof Error) throw versions; return versions; },
        refresh: async d => { calls.refresh++; if (d !== dir) throw new Error('別の設定フォルダ'); if (refreshWrites) await fs.writeFile(credFile, refreshWrites); if (refreshThrows) throw refreshThrows; },
        guard: () => { calls.guard++; },
        onLoginExpired: async (id, reason) => { loginFailures.push({ id, reason }); },
        project: async args => { calls.project++; projectArgs.push(args); if (projectThrows) throw new Error(`profile failed ${ACCESS}`); return { changed: false }; },
        env: {}, home, platform: 'linux', now: () => now, ...over,
      });
      const reset = () => { for (const k of Object.keys(calls)) calls[k] = 0; projectArgs.length = 0; loginFailures.length = 0; owner = 'ok'; versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }; refreshWrites = null; refreshThrows = false; projectThrows = false; now = T0; };
      const account = { id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered };
      await fs.writeFile(credFile, credsJson());

      reset();
      const resolved = (await make()(account)).account;
      const fresh = await resolved.connectors.fresh({ cwd: path.join(tmp, 'work') });
      t.ok('認証: 成功 — 会話用に登録したトークンは使わず、アクセス用トークンに置き換わる（識別子 b1）',
        resolved.token === ACCESS && resolved.token !== FAKE.registered && resolved.id === ACCOUNT_ID && resolved.name === 'fake-account' && resolved.connectors.identity === IDENTITY && IDENTITY === 'b1'
        && !JSON.stringify(resolved).includes(FAKE.registered) && Object.keys(resolved).sort().join() === 'connectors,id,name,token');
      t.ok('認証: 成功 — 起動の直前の値は { token: アクセス用, env: 共有の設定フォルダ + 権限の並び } の 3 つだけ（更新用トークンは持たない）',
        fresh.token === ACCESS && JSON.stringify(Object.keys(fresh.env).sort()) === '["CLAUDE_CODE_OAUTH_SCOPES","CLAUDE_CONFIG_DIR"]'
        && fresh.env.CLAUDE_CONFIG_DIR === path.join(home, '.claude') && fresh.env.CLAUDE_CODE_OAUTH_SCOPES === SCOPES.join(' ') && leaked(JSON.stringify(fresh).replace(ACCESS, '')).length === 0, JSON.stringify(fresh));
      t.ok('認証: 成功 — 設定の反映は ホーム直下の .claude.json → 共有の設定フォルダの .claude.json、作業場所つき',
        projectArgs.length === 1 && projectArgs[0].source === path.join(home, '.claude.json') && projectArgs[0].target === path.join(home, '.claude', '.claude.json') && projectArgs[0].cwd === path.join(tmp, 'work'));
      t.ok('認証: 成功 — 期限が十分ならアクセス用トークンの更新（refresh）は呼ばない・印付け（guard）は解決のとき 1 回', calls.refresh === 0 && calls.guard === 1, JSON.stringify(calls));
      reset();
      const viaEnv = (await make({ env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'parent-config') } })(account)).account;
      t.ok('認証: 親に CLAUDE_CONFIG_DIR があればそれを共有の設定フォルダとする（足す値が親の値と同じ）',
        (await viaEnv.connectors.fresh({ cwd: tmp })).env.CLAUDE_CONFIG_DIR === path.join(tmp, 'parent-config'));

      // 止める条件
      const stops = [
        ['platform', 'macOS（キーチェーンは確かめていない）', () => {}, { platform: 'darwin' }, false],
        ['platform', 'Windows・Linux 以外の OS', () => {}, { platform: 'freebsd' }, false],
        ['env', 'ANTHROPIC_API_KEY', () => {}, { env: { ANTHROPIC_API_KEY: 'fake-api-key-0003' } }, false],
        ['env', 'ANTHROPIC_AUTH_TOKEN', () => {}, { env: { ANTHROPIC_AUTH_TOKEN: 'fake-auth-0004' } }, false],
        ['env', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', () => {}, { env: { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: REFRESH } }, false],
        ['env', 'ANTHROPIC_BASE_URL', () => {}, { env: { ANTHROPIC_BASE_URL: 'https://x.example.invalid' } }, false],
        ['env', 'CLAUDE_CODE_USE_BEDROCK', () => {}, { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, false],
        ['history', 'CLAUDE_CODE_PROJECT_DIR_NAME', () => {}, { env: { CLAUDE_CODE_PROJECT_DIR_NAME: 'x' } }, false],
        ['version', 'CLI の版が古い', () => { versions = { cli: '2.1.321', sdk: VERIFIED_VERSIONS[0].sdk }; }, {}, false],
        ['version', 'SDK の版が違う', () => { versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: '0.3.289' }; }, {}, false],
        ['version', '版が分からない（null）', () => { versions = { cli: null, sdk: null }; }, {}, false],
        ['version', '版を聞くのに失敗', () => { versions = new Error('boom'); }, {}, false],
        ['owner', '持ち主が食い違う', () => { owner = 'mismatch'; }, {}, false],
        ['owner', '持ち主を確認できない', () => { owner = 'unknown'; }, {}, false],
        // 想定外の例外も止める条件に揃える（一覧の読み取りがログイン中のアカウントへ落ちないように。元の文面は出さない）
        ['owner', '持ち主の確かめが例外（アカウントの一覧・使用量のログインを読めない）', () => { owner = new Error(`EACCES ${ACCESS}`); }, {}, false],
        ['login', '使用量の設定フォルダを引けない（例外）', () => {}, { accounts: { usageDir: () => { throw new Error(`usageDir ${ACCESS}`); }, ownerStatus: async () => 'ok' } }, false],
        ['login', '想定外の例外（印付けが投げる）', () => {}, { guard: () => { throw new Error(`guard ${ACCESS}`); } }, false],
        ['login', '資格情報が無い', async () => { await fs.rm(credFile, { force: true }); }, {}, true],
        ['format', '資格情報の形が違う', async () => { await fs.writeFile(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })); }, {}, true],
      ];
      for (const [kind, label, setup, over, readsCred] of stops) {
        reset(); await fs.writeFile(credFile, credsJson());
        await setup();
        let reads = 0;   // 資格情報の読み取りだけを数える（共有の settings.json の確かめは版・持ち主より前に読む）
        const error = await make({ ...over, readFile: async (...a) => { if (String(a[0]).endsWith('.credentials.json')) reads++; return fs.readFile(...a); }, sleep: async () => {} })(account).then(() => null, e => e);
        t.ok(`止める: ${kind}（${label}）→ ConnectorsAuthError(connectors-${kind})・会話用トークンへ戻さない・refresh/反映は呼ばない${readsCred ? '' : '・資格情報を読まない'}・メッセージに秘密なし`,
          error instanceof ConnectorsAuthError && error.code === `connectors-${kind}` && error.message.length > 10 && !error.message.includes('{{') && leaked(error.message).length === 0
          && calls.refresh === 0 && calls.project === 0 && (readsCred || reads === 0), `${error?.code} ${error?.message?.slice(0, 80)} reads=${reads} ${JSON.stringify(calls)}`);
      }
      await fs.writeFile(credFile, credsJson()); reset();

      // 401 のとき、渡したトークンを捨てて共有の .credentials.json・ホストのトークン・別の出どころへ乗り換える道を開く指定（CLI 2.1.322。ADR 0340）。
      // 親の env に 1 つでもあれば env で止め、版（CLI を起こす）も持ち主も聞かず、印付け・refresh・反映もせず、ファイルを 1 つも読まない
      for (const name of SWITCH_ON_401) {
        reset(); await fs.writeFile(credFile, credsJson());
        let reads = 0;
        const error = await make({ env: { [name]: SWITCH_VALUE }, readFile: async (...a) => { reads++; return fs.readFile(...a); }, sleep: async () => {} })(account).then(() => null, e => e);
        t.ok(`止める: env（401 で乗り換える道を開く ${name}）→ connectors-env・名前だけ出す・何も起動しない（版・持ち主・印付け・refresh・反映 0 回・ファイルを読まない）`,
          error instanceof ConnectorsAuthError && error.code === 'connectors-env' && error.message.includes(name) && !error.message.includes(SWITCH_VALUE) && leaked(error.message).length === 0
          && Object.values(calls).every(n => n === 0) && reads === 0, `${error?.code} ${error?.message?.slice(0, 80)} reads=${reads} ${JSON.stringify(calls)}`);
      }
      reset();
      const emptySwitch = await make({ env: Object.fromEntries(SWITCH_ON_401.map(n => [n, ''])) })(account).then(r => r.account, e => e);
      t.ok('止める: 401 で乗り換える道を開く指定も、空の値なら止めない（今の確かめと同じ扱い）', emptySwitch?.token === ACCESS, emptySwitch?.code);
      await fs.writeFile(credFile, credsJson()); reset();

      // 期限と更新（更新は CLI に任せる）
      reset(); now = T0;
      await fs.writeFile(credFile, credsJson({ expiresAt: T0 + REFRESH_WINDOW_MS - 1000 }));
      refreshWrites = credsJson({ token: ACCESS2, expiresAt: T0 + 8 * 3600_000 });
      const near = (await make()(account)).account;
      const renewed = await near.connectors.fresh({ cwd: tmp });
      t.ok('更新: 期限が近ければ起動の前に refresh（CLI に更新させる）を 1 回流し、読み直した新しいアクセス用トークンを渡す', calls.refresh === 1 && renewed.token === ACCESS2 && near.token === ACCESS, JSON.stringify({ calls, same: renewed.token === ACCESS2 }));
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 + 57 * 60_000 }));
      const withOldMarker = make({ accounts: { usageDir: () => dir, ownerStatus: async () => 'ok', isUsageExpired: async () => true } });
      const inspected = await withOldMarker.inspect(account);
      const far = await (await withOldMarker(account)).account.connectors.fresh({ cwd: tmp });
      t.ok('残り 57 分: ログイン切れの印があっても検査と起動は通り、CLI に更新を頼まない', inspected.ok && far.token === ACCESS && calls.refresh === 0);
      // 会話の CLI が断られたトークン（stale）を添えた取り直し（#229）
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 + 57 * 60_000 })); refreshWrites = credsJson({ token: ACCESS2, expiresAt: T0 + 8 * 3600_000 });
      const revoked = await (await make()(account)).account.connectors.fresh({ cwd: tmp, stale: ACCESS });
      t.ok('取り直し: 断られたトークン（stale）がまだ設定フォルダにあれば、期限が先でも refresh を 1 回流して新しいトークンを渡す', revoked.token === ACCESS2 && calls.refresh === 1, JSON.stringify(calls));
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 + 57 * 60_000 }));
      const sameError = await (await make()(account)).account.connectors.fresh({ cwd: tmp, stale: ACCESS }).then(() => null, e => e);
      t.ok('取り直し: refresh しても断られたトークンのままなら expired で止める（同じトークンで起こし直さない）', sameError?.code === 'connectors-expired' && calls.refresh === 1 && calls.project === 0, `${sameError?.code} ${JSON.stringify(calls)}`);
      reset(); await fs.writeFile(credFile, credsJson({ token: ACCESS2, expiresAt: T0 + 57 * 60_000 }));
      const already = await (await make()(account)).account.connectors.fresh({ cwd: tmp, stale: ACCESS });
      t.ok('取り直し: 設定フォルダがもう別のトークン（使用量の読み取りなどが更新済み）なら、refresh せずにそれを渡す', already.token === ACCESS2 && calls.refresh === 0, JSON.stringify(calls));
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 + 4 * 60_000 }));
      const unchanged =await (await make()(account)).account.connectors.fresh({ cwd: tmp });
      t.ok('残り 4 分: 更新を頼み、書き換わらなくても有効なアクセス用トークンで起動する', unchanged.token === ACCESS && calls.refresh === 1 && loginFailures.length === 0);
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 - 1000 }));
      const stale = (await make()(account)).account;
      const staleError = await stale.connectors.fresh({ cwd: tmp }).then(() => null, e => e);
      t.ok('期限後: 更新後も期限切れなら起動を止める。ログイン切れの印は付けない', staleError?.code === 'connectors-expired' && calls.refresh === 1 && calls.project === 0 && loginFailures.length === 0);
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 - 1000 })); refreshThrows = new Error('一時的な失敗');
      const failed = (await make()(account)).account;
      const failedError = await failed.connectors.fresh({ cwd: tmp }).then(() => null, e => e);
      t.ok('更新: refresh が失敗し期限切れのままなら止める（expired）。失敗の文面（トークンを含む）は利用者へ出さない',
        failedError?.code === 'connectors-expired' && leaked(failedError.message).length === 0 && !String(failedError.stack).includes(ACCESS), `${failedError?.code}`);
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 - 1000 })); refreshThrows = new Error('一時的な失敗'); refreshWrites = credsJson({ token: ACCESS2 });
      const recovers = (await make()(account)).account;
      t.ok('更新: refresh が例外でも、ログインが更新されていれば（読み直して期限が十分）使える', (await recovers.connectors.fresh({ cwd: tmp }).catch(() => ({}))).token === ACCESS2);
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 - 1000 }));
      refreshThrows = new Error('invalid_grant ' + ACCESS);
      const rejected = await (await make()(account)).account.connectors.fresh().then(() => null, e => e);
      t.ok('CLI が認証を拒否したらログイン切れの印を付け、元の認証エラーは返さない', rejected?.code === 'connectors-expired' && !leaked(rejected.message).length && loginFailures[0]?.reason === 'no-login');
      reset(); await fs.writeFile(credFile, credsJson({ refreshTokenExpiresAt: T0 }));
      const expiredRefresh = make();
      const refreshInspection = await expiredRefresh.inspect(account);
      const refreshError = await (await expiredRefresh(account)).account.connectors.fresh().then(() => null, e => e);
      t.ok('更新用トークンが期限切れ: 検査も起動も止め、起動時にログイン切れの印を付ける', refreshInspection.kind === 'expired' && refreshError?.code === 'connectors-expired' && calls.refresh === 0 && loginFailures[0]?.reason === 'refresh-token-expired');
      reset(); await fs.writeFile(credFile, credsJson());
      const later = (await make()(account)).account;
      await fs.writeFile(credFile, credsJson({ token: ACCESS2 }));
      t.ok('更新: 起動のたびに資格情報を読み直す（古い値を持ち越さない）', (await later.connectors.fresh({ cwd: tmp })).token === ACCESS2);
      await fs.rm(credFile, { force: true });
      const goneError = await later.connectors.fresh({ cwd: tmp }).then(() => null, e => e);
      t.ok('更新: 起動の前にログインが消えていれば止める（login）・解決のときの値へ戻らない', goneError?.code === 'connectors-login');
      await fs.writeFile(credFile, credsJson()); reset(); projectThrows = true;
      const profileError = await (await make()(account)).account.connectors.fresh({ cwd: tmp }).then(() => null, e => e);
      t.ok('設定の反映が失敗すれば止める（profile）・メッセージにトークンを出さない', profileError?.code === 'connectors-profile' && leaked(profileError.message).length === 0);
      restoreConsole();
      t.ok('認証: process.env は変えない・コンソールに何も出さない（秘密を含めて）',
        JSON.stringify(process.env) === savedProcessEnv && leaked(consoleLines.join('\n')).length === 0 && consoleLines.length === 0, consoleLines.slice(0, 2).join(' | ').slice(0, 120));
    }

    // ---------------------------------------------------------------- 4. 起動の記録（オン）— オフの記録との差は認証の 3 つだけ
    {
      const labels = ['plain/registered/none', 'parentOauth/registered/none', 'configDir/registered/none', 'emptyOauth/registered/none', 'undefinedOauth/registered/none', 'plain/registered/compat'];
      const enabled = JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: true } } });
      const off = await recordAll({ root: REPO, only: labels, dumpName: 'auth-off' });
      const log = [];
      const on = await recordAll({
        root: REPO, only: labels, dumpName: 'auth-on',
        onSetup: async ({ data }) => {
          await fs.writeFile(path.join(data, CONNECTORS_FILE), enabled);
          await fs.mkdir(path.join(data, 'claude-usage', ACCOUNT_ID), { recursive: true });
          await fs.writeFile(path.join(data, 'claude-usage', ACCOUNT_ID, '.credentials.json'), credsJson({ expiresAt: Date.now() + 8 * 3600_000 }));
        },
        accountFor: async (accounts, id, { data }) => {
          const { gate } = createClaudeConnectorsGate({
            dataDir: data,
            resolveAuth: createClaudeConnectorsAuth({
              accounts: { usageDir: i => path.join(data, 'claude-usage', i), ownerStatus: async () => 'ok' },
              versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
              refresh: async () => { log.push('refresh'); },
              project: async () => { log.push('project'); return { changed: false }; },
              home: path.join(data, 'home'),
            }),
          });
          return gate(await accounts.resolve(id));
        },
      });
      const ALLOWED = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CONFIG_DIR'];
      const stripEnv = (rec, keys) => rec && { ...rec, env: Object.fromEntries(Object.entries(rec.env).filter(([k]) => !keys.includes(k))) };
      const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
      const problems = [];
      for (const label of labels) {
        const compat = label.endsWith('/compat');
        for (const route of ['runTurn', 'internalTurn', 'suggestTitle', 'modelList', 'connectorList', 'usage', 'heldSpawn']) {
          const a = off[label]?.[route], b = on[label]?.[route];
          if (!a || !b) { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} ${route}: 記録の有無が違う`); continue; }
          if (route === 'heldSpawn' || route === 'usage' || compat) { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} ${route}: オフと違う`); continue; }
          // proc: argv・cwd・files は同じ。env の差は許した 3 つだけ
          if (!a.proc || !b.proc) { problems.push(`${label} ${route}: 起動されなかった`); continue; }
          if (JSON.stringify(a.proc.argv) !== JSON.stringify(b.proc.argv)) problems.push(`${label} ${route}: argv が違う`);
          if (a.proc.cwd !== b.proc.cwd || JSON.stringify(a.proc.files) !== JSON.stringify(b.proc.files)) problems.push(`${label} ${route}: cwd か files が違う`);
          const d = diffKeys(a.proc.env, b.proc.env);
          if (d.some(k => !ALLOWED.includes(k))) problems.push(`${label} ${route}: env の想定外の差 ${d.filter(k => !ALLOWED.includes(k)).join(',')}`);
          // SDK の options: env 以外は同じ。env の差は許した 3 つだけ
          if (JSON.stringify(a.sdk.map(o => ({ ...o, env: undefined }))) !== JSON.stringify(b.sdk.map(o => ({ ...o, env: undefined })))) problems.push(`${label} ${route}: SDK の options（env 以外）が違う`);
          if (a.sdk.length !== b.sdk.length) problems.push(`${label} ${route}: SDK の呼び出し回数が違う`);
          for (let i = 0; i < Math.min(a.sdk.length, b.sdk.length); i++) {
            const sd = diffKeys(a.sdk[i].env ?? {}, b.sdk[i].env ?? {});
            if (sd.some(k => !ALLOWED.includes(k))) problems.push(`${label} ${route}: SDK の env の想定外の差 ${sd.filter(k => !ALLOWED.includes(k)).join(',')}`);
          }
          // コネクターの一覧（connectorList）も会話と同じ組み立て（connectors.fresh()）で 3 つを渡す
          const env = b.proc.env;
          const shared = label.startsWith('configDir') ? 'FAKE_CONFIG_DIR' : '<tmp>/data/home/.claude';
          if (env.CLAUDE_CODE_OAUTH_TOKEN !== ACCESS || env.CLAUDE_CODE_OAUTH_SCOPES !== SCOPES.join(' ') || env.CLAUDE_CONFIG_DIR !== shared) {
            problems.push(`${label} ${route}: 認証の値が想定と違う（token=${env.CLAUDE_CODE_OAUTH_TOKEN === ACCESS ? 'access' : env.CLAUDE_CODE_OAUTH_TOKEN === FAKE.registered ? 'registered' : '?'} config=${env.CLAUDE_CONFIG_DIR}）`);
          }
          const rest = JSON.stringify(stripEnv(a.proc, ALLOWED).env) === JSON.stringify(stripEnv(b.proc, ALLOWED).env);
          if (!rest) problems.push(`${label} ${route}: 3 つ以外の env が違う`);
        }
      }
      t.ok(`オンの起動の記録: ${labels.length} 組み合わせ × 経路で、オフとの差は認証の 3 つの環境変数（アクセス用トークン・権限・共有の設定フォルダ）だけ。argv・cwd・ほかの env・SDK の options・保持役への変換・使用量・互換接続は同じ`,
        problems.length === 0, problems.slice(0, 6).join(' | '));
      const everything = JSON.stringify({ off, on });
      t.ok('オンの記録に会話用に登録したトークンは残らない（アクセス用に置き換わる）。更新用トークン・メール・組織は env にも argv にも出ない',
        !JSON.stringify(Object.fromEntries(Object.entries(on).filter(([l]) => !l.endsWith('/compat')).map(([l, r]) => [l, { ...r, usage: null, heldSpawn: null }]))).includes(FAKE.registered)
        && leaked(everything.replaceAll(FAKE.registered, '').replaceAll(ACCESS, '')).length === 0, leaked(everything.replaceAll(FAKE.registered, '').replaceAll(ACCESS, '')).join(','));
      t.ok('オン: 更新（refresh）は期限が十分なので流れない・設定の反映は起動のたびに 1 回ずつ（会話・内部の会話・題・モデルの一覧・コネクターの一覧 の 5 経路 × 組み合わせ）',
        !log.includes('refresh') && log.filter(l => l === 'project').length === 5 * 5, JSON.stringify([...new Set(log)]) + ' x' + log.length);
    }

    // ---------------------------------------------------------------- 4b. 起動の直前に認証が使えなくなったら、起動しない（会話用に登録したトークンへ戻らない）
    {
      const labels = ['plain/registered/none'];
      const variants = {
        'ログインが消えた（login）': async ({ credFile }) => { await fs.rm(credFile, { force: true }); },
        '期限切れで更新も効かない（expired）': async ({ credFile }) => { await fs.writeFile(credFile, credsJson({ expiresAt: Date.now() - 1000 })); },
      };
      for (const [variant, breakIt] of Object.entries(variants)) {
        let refreshed = 0;
        const rec = await recordAll({
          root: REPO, only: labels, dumpName: 'auth-fail',
          onSetup: async ({ data }) => {
            await fs.writeFile(path.join(data, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: true } } }));
            await fs.mkdir(path.join(data, 'claude-usage', ACCOUNT_ID), { recursive: true });
            await fs.writeFile(path.join(data, 'claude-usage', ACCOUNT_ID, '.credentials.json'), credsJson({ expiresAt: Date.now() + 8 * 3600_000 }));
          },
          accountFor: async (accounts, id, { data }) => {
            const credFile = path.join(data, 'claude-usage', ACCOUNT_ID, '.credentials.json');
            const { gate } = createClaudeConnectorsGate({
              dataDir: data,
              resolveAuth: createClaudeConnectorsAuth({
                accounts: { usageDir: i => path.join(data, 'claude-usage', i), ownerStatus: async () => 'ok' },
                versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
                refresh: async () => { refreshed++; },
                project: async () => ({ changed: false }),
                home: path.join(data, 'home'),
                sleep: async () => {},
              }),
            });
            const account = await gate(await accounts.resolve(id));
            await breakIt({ credFile });   // 入口を通った「あと」に使えなくなる（起動の直前の取り直しで気づく）
            return account;
          },
        });
        const r = rec['plain/registered/none'];
        const launched = ['runTurn', 'internalTurn', 'suggestTitle'].filter(route => r?.[route]?.proc || r?.[route]?.sdk?.length);
        t.ok(`認証が起動の直前に使えなくなったら（${variant}）: 会話・内部の会話・題は起動しない（子プロセスも SDK も 0 回）。会話用に登録したトークンへ戻らない`,
          !!r && launched.length === 0 && !JSON.stringify(r).includes(FAKE.registered), `launched=${launched.join(',') || 'なし'} registeredInRecord=${JSON.stringify(r ?? {}).includes(FAKE.registered)} refreshed=${refreshed}`);
      }
    }

    // ---------------------------------------------------------------- 5. オフは認証側の何も呼ばない
    {
      const text = { unset: null, off: JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: false } } }), other: JSON.stringify({ version: 1, accounts: { 'acct-other000001': { enabled: true } } }), broken: '{ "accounts": ' };
      for (const [variant, body] of Object.entries(text)) {
        const data = path.join(tmp, `off-${variant}`); await fs.mkdir(data, { recursive: true });
        if (body !== null) await fs.writeFile(path.join(data, CONNECTORS_FILE), body);
        const before = (await fs.readdir(data)).sort().join();
        let touched = 0, timers = 0;
        const boom = what => async () => { touched++; throw new Error(`呼ばれた: ${what}`); };
        const resolveAuth = createClaudeConnectorsAuth({
          accounts: { usageDir: () => { touched++; throw new Error('usageDir'); }, ownerStatus: boom('ownerStatus') }, versions: boom('versions'), refresh: boom('refresh'),
          verify: boom('verify'), guard: () => { touched++; }, project: boom('project'), readFile: boom('readFile'), sleep: boom('sleep'), now: () => { touched++; return 0; }, env: new Proxy({}, { get: () => { touched++; return undefined; }, ownKeys: () => { touched++; return []; } }),
        });
        const { gate } = createClaudeConnectorsGate({ dataDir: data, resolveAuth });
        const origSet = globalThis.setTimeout, origInt = globalThis.setInterval;
        globalThis.setTimeout = (...a) => { timers++; return origSet(...a); }; globalThis.setInterval = (...a) => { timers++; return origInt(...a); };
        let same, noId;
        try {
          const account = { id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered };
          const shape = JSON.stringify(account);
          same = (await gate(account)) === account && JSON.stringify(account) === shape;
          noId = (await gate({ name: 'x' })) !== null && (await gate(null)) === null;
        } finally { globalThis.setTimeout = origSet; globalThis.setInterval = origInt; }
        t.ok(`オフ（${variant}）: 同じ account をそのまま返し、認証側の持ち主確認・版・資格情報・更新・反映・印付け・時計・待ち・環境の読み取りは 0 回・ファイルの作成 0・タイマー 0`,
          same && noId && touched === 0 && timers === 0 && before === (await fs.readdir(data)).sort().join(), `touched=${touched} timers=${timers}`);
      }
      t.ok('キャッシュのキー: オンの識別子 b1 のときだけ接尾辞。オフ（識別子なし）は今までの文字列',
        accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: { identity: IDENTITY } }) === `account:${ACCOUNT_ID}:cn:b1` && identitySuffix(IDENTITY) === ':cn:b1'
        && accountScopeKeyForTest({ id: ACCOUNT_ID }) === `account:${ACCOUNT_ID}` && accountScopeKeyForTest(null) === 'login');
    }

    // ---------------------------------------------------------------- 6. 使用量の読み取りの排他・server の配線
    {
      const order = [];
      const slow = (label, ms, fail = false) => () => new Promise((resolve, reject) => { order.push(`start ${label}`); setTimeout(() => { order.push(`end ${label}`); fail ? reject(new Error(label)) : resolve(label); }, ms); });
      const d1 = path.join(tmp, 'lock-a'), d2 = path.join(tmp, 'lock-b');
      const results = await Promise.allSettled([withUsageLock(d1, slow('a1', 40)), withUsageLock(d1, slow('a2', 5, true)), withUsageLock(d1, slow('a3', 5)), withUsageLock(d2, slow('b1', 5))]);
      const seq = order.join(',');
      t.ok('排他: 同じ設定フォルダは順に（前が終わってから次を始める）・失敗しても次は流れる・別のフォルダは待たない',
        seq.indexOf('end a1') < seq.indexOf('start a2') && seq.indexOf('end a2') < seq.indexOf('start a3') && seq.indexOf('end b1') < seq.indexOf('end a1')
        && results[0].value === 'a1' && results[1].status === 'rejected' && results[2].value === 'a3' && results[3].value === 'b1', seq);
      // 偽の読み取り（label ごとに始まり・終わりを記録。ms 後に終わる）で、順番の口の動きを確かめる
      const fakeReads = () => {
        const log = [], live = new Set(); let overlap = false;
        const reads = createUsageReadsForTest(options => {
          const label = options.label;
          log.push(`start ${label}`); live.add(label);
          if (live.size > 1) overlap = true;
          return new Promise(resolve => setTimeout(() => { live.delete(label); log.push(`end ${label}`); resolve(label); }, options.ms ?? 5));
        });
        return { reads, log, overlapped: () => overlap };
      };
      {
        const { reads, log, overlapped } = fakeReads();
        const d = path.join(tmp, 'usage-pre');
        const pre = reads.read({ configDir: d, label: 'pre', ms: 40 });   // 印を付ける前から走っている読み取り（入口をオンにした直後の会話）
        reads.guard(d, () => true);
        const refreshed = reads.refresh(d);                                // 会話の前の更新（期限が近い）
        const after = reads.read({ configDir: d, label: 'after', ms: 5 }); // 印の後の読み取り
        await Promise.all([pre, refreshed, after]);
        const seq = log.join(',');
        t.ok('排他（項目 2）: 印を付ける前から走っていた読み取りが終わってから更新が始まり、印の後の読み取りは更新の後（同じ設定フォルダで CLI が重ならない）',
          !overlapped() && seq.indexOf('end pre') < seq.indexOf('start undefined') && seq.indexOf('end undefined') < seq.indexOf('start after'), seq);
      }
      {
        const { reads, log, overlapped } = fakeReads();
        const d = path.join(tmp, 'usage-off');
        let on = true;
        reads.guard(d, async () => on);
        await Promise.all([reads.read({ configDir: d, label: 'g1', ms: 20 }), reads.read({ configDir: d, label: 'g2', ms: 5 })]);
        const guardedSeq = log.join(','); const wasOverlapped = overlapped();
        on = false;   // 入口をオフにした
        await reads.read({ configDir: d, label: 'off1', ms: 5 });
        log.length = 0;
        const a = reads.read({ configDir: d, label: 'm1', ms: 20 });
        const startedNow = log.join(',');   // 今までの道は呼んだその場で読み始める（待たない）
        const b = reads.read({ configDir: d, label: 'm2', ms: 5 });
        await Promise.all([a, b]);
        t.ok('印（項目 6）: オンの間は順に流れ、オフにすると次の読み取りで印が外れる。以後は今までと同じ道（呼んだその場で始まり・重なってよい）',
          !wasOverlapped && guardedSeq.indexOf('end g1') < guardedSeq.indexOf('start g2') && !reads.isGuarded(d) && startedNow === 'start m1' && overlapped() && log.indexOf('start m2') < log.indexOf('end m1'),
          `${guardedSeq} | ${startedNow} | ${log.join(',')}`);
      }
      {
        // オフにした後の最初の読み取り（印を外す読み取り）も、更新が待っていなければ今までの道（印の前から走っていた読み取りを待たない）
        const { reads, log } = fakeReads();
        const d = path.join(tmp, 'usage-off-first');
        const pre = reads.read({ configDir: d, label: 'pre', ms: 40 });   // 印を付ける前から走っている読み取り
        reads.guard(d, async () => false);                                 // 印を付けた後、次の読み取りの前に入口がオフになった
        const first = reads.read({ configDir: d, label: 'first', ms: 5 });
        await Promise.all([pre, first]);
        const seq = log.join(',');
        t.ok('印（項目 6）: オフにした後の最初の読み取りも、更新が待っていなければ今までと同じ道（印の前から走っていた読み取りを待たずに始まる）',
          !reads.isGuarded(d) && seq.indexOf('start first') >= 0 && seq.indexOf('start first') < seq.indexOf('end pre'), seq);
      }
      {
        const { reads, log } = fakeReads();
        const d = path.join(tmp, 'usage-never');
        const a = reads.read({ configDir: d, label: 'n1', ms: 20 });
        const sync1 = log.join(',');
        const b = reads.read({ configDir: d, label: 'n2', ms: 5 });
        const sync2 = log.join(',');
        const c = reads.read({ label: 'login', ms: 5 });
        const sync3 = log.join(',');
        await Promise.all([a, b, c]);
        t.ok('排他: 印を付けたことの無いフォルダ・フォルダ指定なし（ログイン中）は今までと同じ道（呼んだその場で始まり、待たずに重なる）',
          sync1 === 'start n1' && sync2 === 'start n1,start n2' && sync3 === 'start n1,start n2,start login' && log.indexOf('start n2') < log.indexOf('end n1'), log.join(','));
      }
      // server の組み立て（createClaudeConnectorsWiring）: 入口の設定・認証・印・更新の口
      {
        const data = path.join(tmp, 'wiring'); const usageDir = path.join(data, 'claude-usage', ACCOUNT_ID);
        await fs.mkdir(usageDir, { recursive: true });
        await fs.writeFile(path.join(data, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: true } } }));
        await fs.writeFile(path.join(usageDir, '.credentials.json'), credsJson({ expiresAt: T0 + REFRESH_WINDOW_MS - 1000 }));
        const guards = [], refreshed = [];
        const { gate } = createClaudeConnectorsWiring({
          dataDir: data,
          accounts: { usageDir: i => path.join(data, 'claude-usage', i), ownerStatus: async () => 'ok' },
          versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
          usage: {
            guard: (dir, active) => guards.push({ dir, active }),
            refresh: async dir => { refreshed.push(dir); await fs.writeFile(path.join(dir, '.credentials.json'), credsJson({ token: ACCESS2, expiresAt: T0 + 8 * 3600_000 })); },
          },
          env: {}, home: path.join(tmp, 'wiring-home'), platform: 'linux', now: () => T0, project: async () => ({ changed: false }),
        });
        const account = await gate({ id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered });
        const fresh = await account.connectors.fresh({ cwd: tmp });
        const activeOn = await guards[0]?.active();
        await fs.writeFile(path.join(data, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: false } } }));
        const activeOff = await guards[0]?.active();
        t.ok('server の組み立て: オンのアカウントの使用量の設定フォルダに印を付け、その印は入口の設定がオンの間だけ効く（オフにすると active() が false）。期限が近いときの更新は usage.refresh（順番の口）を通る',
          guards.length === 1 && guards[0].dir === usageDir && activeOn === true && activeOff === false && refreshed.length === 1 && refreshed[0] === usageDir && fresh.token === ACCESS2,
          JSON.stringify({ guards: guards.length, activeOn, activeOff, refreshed: refreshed.length }));
      }
      const authSrc = await fs.readFile(path.join(REPO, 'core/claude-connectors-auth.mjs'), 'utf8');
      t.ok('認証側は更新用トークンを取り出さない・私的な更新の口を呼ばない・ホーム直下の .claude.json へ書かない・ネットワークを使わない',
        !/\brefreshToken\b/.test(authSrc.replace(/\/\/.*$/gm, '')) && !/fetch\(|https?:\/\/|oauth\/token|createConnection|net\./.test(authSrc.replace(/\/\/.*$/gm, '')) && !/writeFile\([^)]*source/.test(authSrc));
    }

    // ---------------------------------------------------------------- 7. 設定 › 外部 MCP のコネクターの一覧（connectorListProbe・probeClaudeConnectors）
    {
      const calls = [];
      const probe = async args => { calls.push(args); return ['fake-connector']; };
      const connectors = { identity: IDENTITY, fresh: async () => ({ token: ACCESS, env: {} }) };
      const run = (resolve, deny = []) => connectorListProbe({ defaultId: async () => ACCOUNT_ID, resolve, probe })({ deny });
      const got = await run(async () => ({ id: ACCOUNT_ID, name: 'fake-account', token: ACCESS, connectors }), ['deny-me']);
      t.ok('一覧（項目 1）: オンのアカウントは connectors（会話と同じ組み立て）を probe に渡す',
        got[0] === 'fake-connector' && calls.length === 1 && calls[0].connectors === connectors && calls[0].token === ACCESS && calls[0].deny[0] === 'deny-me');
      for (const kind of ['login', 'format', 'expired', 'owner', 'version', 'platform', 'env', 'history', 'profile']) {
        calls.length = 0;
        const stop = new ConnectorsAuthError(kind, { name: 'fake-account' });
        const error = await run(async () => { throw stop; }).then(() => null, e => e);
        if (error !== stop || calls.length) { t.ok(`一覧（項目 1）: 止める条件 ${kind} はそのまま投げ、probe を呼ばない`, false, `${error?.code} calls=${calls.length}`); break; }
      }
      t.ok('一覧（項目 1）: 止める条件 9 種（ConnectorsAuthError）はそのまま投げ、ログイン中のアカウントで読み直さない（probe を呼ばない）', calls.length === 0);
      calls.length = 0;
      await run(async () => ({ id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered }));
      await run(async () => { throw new Error('アカウントが無い'); });
      await run(async () => null);
      t.ok('一覧: オフ・ほかの失敗・既定なしは今までの呼び方（{ deny, token } だけ。失敗と既定なしはログイン中 = token null）',
        calls.length === 3 && calls.every(c => Object.keys(c).join() === 'deny,token') && calls[0].token === FAKE.registered && calls[1].token === null && calls[2].token === null, JSON.stringify(calls.map(c => Object.keys(c))));
      // オンの解決の想定外の例外（持ち主の確かめが読めない・使用量の設定フォルダを引けない）も、入口（gate）を通した一覧で
      // ConnectorsAuthError になり、ログイン中のアカウントで読み直さない（probe を呼ばない）
      for (const [label, accounts, code] of [
        ['持ち主の確かめが例外', { usageDir: i => path.join(tmp, 'list-wiring', 'claude-usage', i), ownerStatus: async () => { throw new Error(`EACCES ${ACCESS}`); } }, 'connectors-owner'],
        ['使用量の設定フォルダを引けない', { usageDir: () => { throw new Error(`usageDir ${ACCESS}`); }, ownerStatus: async () => 'ok' }, 'connectors-login'],
      ]) {
        calls.length = 0;
        const { gate } = createClaudeConnectorsWiring({
          dataDir: path.join(tmp, 'list-wiring'), accounts,
          settings: { read: async () => ({ enabled: true }) },
          versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
          usage: { guard: () => {}, refresh: async () => {} },
          env: {}, home: path.join(tmp, 'list-wiring-home'), platform: 'linux', now: () => T0, project: async () => ({ changed: false }),
        });
        const error = await run(id => gate({ id, name: 'fake-account', token: FAKE.registered })).then(() => null, e => e);
        t.ok(`一覧（項目 1）: オンの解決の想定外の例外（${label}）も止める条件にして投げ、ログイン中のアカウントで読み直さない・文面に秘密なし`,
          error instanceof ConnectorsAuthError && error.code === code && calls.length === 0 && leaked(error.message).length === 0, `${error?.code} calls=${calls.length}`);
      }
      // 401 で乗り換える道を開く指定が親の env にあれば、入口（gate）を通した一覧も env で止め、版を聞かず、ログイン中のアカウントで読み直さない
      const switchList = [];
      for (const name of SWITCH_ON_401) {
        calls.length = 0;
        let asked = 0;
        const { gate } = createClaudeConnectorsWiring({
          dataDir: path.join(tmp, 'list-wiring'),
          accounts: { usageDir: i => path.join(tmp, 'list-wiring', 'claude-usage', i), ownerStatus: async () => { asked++; return 'ok'; } },
          settings: { read: async () => ({ enabled: true }) },
          versions: async () => { asked++; return { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }; },
          usage: { guard: () => { asked++; }, refresh: async () => { asked++; } },
          env: { [name]: SWITCH_VALUE }, home: path.join(tmp, 'list-wiring-home'), platform: 'linux', now: () => T0, project: async () => { asked++; return { changed: false }; },
        });
        const error = await run(id => gate({ id, name: 'fake-account', token: FAKE.registered })).then(() => null, e => e);
        if (!(error instanceof ConnectorsAuthError) || error.code !== 'connectors-env' || calls.length || asked || error.message.includes(SWITCH_VALUE)) switchList.push(`${name}: ${error?.code} calls=${calls.length} asked=${asked}`);
      }
      t.ok('一覧（項目 1）: 401 で乗り換える道を開く 7 つの指定が親の env にあれば、入口を通した一覧も env で止め、版・持ち主を聞かず、ログイン中のアカウントで読み直さない（probe を呼ばない）',
        switchList.length === 0, switchList.slice(0, 3).join(' | '));
      // probeClaudeConnectors: オンは fresh() の値で起こし、起こした後の失敗の文面からトークンを伏せる。fresh() が投げれば CLI を起こさない
      const savedBin = process.env.AGENT_HOST_CLAUDE_BIN;
      const { installFakeClaude } = await import('../lib/fake-claude.mjs');
      const installed = await installFakeClaude(path.join(tmp, 'probe-bin'));
      const seen = [];
      const { setClaudeSdkForTest } = await import('../../core/backends/claude.mjs');
      const restoreSdk = setClaudeSdkForTest({ query: ({ options }) => { seen.push(options.env); throw Object.assign(new Error(`boom ${ACCESS} ${FAKE.registered}`), { code: 'E_FAKE' }); } });
      process.env.AGENT_HOST_CLAUDE_BIN = installed.bin;
      try {
        const { probeClaudeConnectors } = await import('../../core/backends/claude.mjs');
        const env3 = { CLAUDE_CONFIG_DIR: 'FAKE_SHARED', CLAUDE_CODE_OAUTH_SCOPES: SCOPES.join(' ') };
        const e1 = await probeClaudeConnectors({ deny: [], token: FAKE.registered, connectors: { identity: IDENTITY, fresh: async () => ({ token: ACCESS, env: env3 }) } }).then(() => null, e => e);
        t.ok('一覧の読み取り（オン）: fresh() のトークンと 2 つの env で CLI を起こし、失敗の文面にトークンを出さない（code は残す）',
          seen.length === 1 && seen[0].CLAUDE_CODE_OAUTH_TOKEN === ACCESS && seen[0].CLAUDE_CONFIG_DIR === 'FAKE_SHARED' && seen[0].CLAUDE_CODE_OAUTH_SCOPES === SCOPES.join(' ')
          && e1?.code === 'E_FAKE' && leaked(e1.message).length === 0 && !String(e1.stack).includes(ACCESS), `${e1?.code} seen=${seen.length}`);
        seen.length = 0;
        const e2 = await probeClaudeConnectors({ deny: [], token: FAKE.registered, connectors: { identity: IDENTITY, fresh: async () => { throw new ConnectorsAuthError('expired', { name: 'fake-account' }); } } }).then(() => null, e => e);
        t.ok('一覧の読み取り（オン）: fresh() が止めれば CLI を起こさない（会話用トークンでもログイン中でも読まない）', e2?.code === 'connectors-expired' && seen.length === 0);
      } finally {
        restoreSdk();
        if (savedBin === undefined) delete process.env.AGENT_HOST_CLAUDE_BIN; else process.env.AGENT_HOST_CLAUDE_BIN = savedBin;
      }
    }

    // ---------------------------------------------------------------- 8. 付け直し（adoptTurn）と一覧の覚えの消し方
    {
      const saved = claudeBackend.adoptTurn;
      const seen = [];
      claudeBackend.adoptTurn = async args => { seen.push(args); return 'adopted'; };
      try {
        const freshCalls = [];
        const env3 = { CLAUDE_CONFIG_DIR: 'FAKE_SHARED', CLAUDE_CODE_OAUTH_SCOPES: SCOPES.join(' ') };
        const on = { id: ACCOUNT_ID, name: 'fake-account', token: ACCESS, connectors: { identity: IDENTITY, fresh: async o => { freshCalls.push(o); return { token: ACCESS2, env: env3 }; } } };
        const args = { cwd: path.join(tmp, 'work'), card: { held: true }, source: { write() {} } };
        const r = await claudeBackend.forAccount(on).adoptTurn(args);
        t.ok('付け直し（項目 4）: オンのアカウントは起動の直前に fresh()（期限・設定の反映）を通り、取り直したトークンと env を渡す（解決のときのトークンではない）',
          r === 'adopted' && freshCalls.length === 1 && freshCalls[0].cwd === args.cwd && seen.length === 1 && seen[0].oauthToken === ACCESS2
          && JSON.stringify(seen[0].connectorsEnv) === JSON.stringify(env3) && seen[0].card === args.card && seen[0].source === args.source, JSON.stringify({ fresh: freshCalls.length, seen: seen.length }));
        seen.length = 0;
        const failing = { ...on, connectors: { identity: IDENTITY, fresh: async () => { throw new ConnectorsAuthError('expired', { name: 'fake-account' }); } } };
        const e = await claudeBackend.forAccount(failing).adoptTurn(args).then(() => null, x => x);
        t.ok('付け直し（項目 4）: fresh() が止めれば付け直さない（会話用トークン・解決のときのトークンへ戻らない）', e?.code === 'connectors-expired' && seen.length === 0);
        seen.length = 0;
        await claudeBackend.forAccount({ ...on, endpoint: null }).adoptTurn({ ...args, endpoint: { baseUrl: 'https://compat.example.invalid' } });
        await claudeBackend.forAccount({ id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered }).adoptTurn(args);
        t.ok('付け直し: 互換の接続先はコネクターの認証を足さない・オフのアカウントは今までどおり（会話用トークン、env を足さない）',
          seen.length === 2 && freshCalls.length === 1 && !('connectorsEnv' in seen[0]) && seen[0].oauthToken === null && seen[1].oauthToken === FAKE.registered && !('connectorsEnv' in seen[1]), JSON.stringify(seen.map(s => Object.keys(s))));
      } finally { claudeBackend.adoptTurn = saved; }
      const near = `${ACCOUNT_ID}2`;   // 先頭が同じ別のアカウント（消さない）
      const touched = [{ id: ACCOUNT_ID }, { id: ACCOUNT_ID, connectors: { identity: IDENTITY } }, { id: near }, { id: near, connectors: { identity: IDENTITY } }];
      const before = catalogStateKeysForTest(touched);
      claudeBackend.invalidateModels(ACCOUNT_ID);
      const after = catalogStateKeysForTest();
      t.ok('一覧の覚え（項目 5）: アカウントを消す・入れ替えると、オフのキーと入口オンのキー（:cn:b1）の両方を消す。先頭が同じ別のアカウントは残す',
        [`account:${ACCOUNT_ID}`, `account:${ACCOUNT_ID}:cn:b1`].every(k => before.includes(k) && !after.includes(k)) && [`account:${near}`, `account:${near}:cn:b1`].every(k => after.includes(k)), after.join(','));
      claudeBackend.invalidateModels(near);
    }

    // ---------------------------------------------------------------- 9. 作業場所のキー（CLI 2.1.322 の作り方）
    {
      // 偽のファイル操作（win32 は大文字小文字を区別せずに引く。realpath は渡された形のまま。CLI が使う JS の realpath と同じく大文字小文字を直さない）
      const fakeIo = (entries, platform) => {
        const P = platform === 'win32' ? path.win32 : path.posix;
        const norm = p => { const r = P.resolve(p); return platform === 'win32' ? r.toLowerCase() : r; };
        const table = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v]));
        const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const get = p => { const v = table.get(norm(p)); if (v === undefined) throw enoent(); return v; };
        const st = v => ({ isDirectory: () => v === 'dir', isFile: () => v !== 'dir', isSymbolicLink: () => false });
        return { realpath: async p => P.resolve(p), lstat: async p => st(get(p)), stat: async p => st(get(p)), readFile: async p => { const v = get(p); if (v === 'dir') throw enoent(); return v; } };
      };
      const winTree = {
        'C:\\Code\\main\\.git': 'dir', 'C:\\Code\\main\\.git\\worktrees\\wt': 'dir',
        'C:\\Code\\main\\.git\\worktrees\\wt\\commondir': '../..\n', 'C:\\Code\\main\\.git\\worktrees\\wt\\gitdir': 'C:/Code/wt/.git\n',
        'C:\\Code\\wt\\.git': 'gitdir: C:/Code/main/.git/worktrees/wt\n', 'd:\\Repo\\.git': 'dir',
      };
      const win = cwd => projectKeyOf(cwd, { platform: 'win32', io: fakeIo(winTree, 'win32') });
      const winKeys = { main: await win('C:\\Code\\main\\pkg\\src'), wt: await win('C:\\Code\\wt\\src'), lower: await win('d:\\Repo\\pkg'), slash: await win('D:/Repo/pkg'), none: await win('E:\\nowhere\\x') };
      t.ok('作業場所のキー（Windows）: Git のルート・worktree は本体の作業ツリー・\\ は / に・ドライブ文字の大文字小文字はそのまま・Git の外は作業場所そのもの',
        winKeys.main === 'C:/Code/main' && winKeys.wt === 'C:/Code/main' && winKeys.lower === 'd:/Repo' && winKeys.slash === 'D:/Repo' && winKeys.none === 'E:/nowhere/x', JSON.stringify(winKeys));
      const broken = { ...winTree, 'C:\\Code\\main\\.git\\worktrees\\wt\\gitdir': 'C:/Elsewhere/.git\n' };
      const noCommon = Object.fromEntries(Object.entries(winTree).filter(([k]) => !k.endsWith('commondir')));
      t.ok('作業場所のキー（Windows）: worktree の確かめが一つでも合わなければ（戻りの指す先が違う・commondir が無い）worktree の場所のまま',
        await projectKeyOf('C:\\Code\\wt\\src', { platform: 'win32', io: fakeIo(broken, 'win32') }) === 'C:/Code/wt'
        && await projectKeyOf('C:\\Code\\wt\\src', { platform: 'win32', io: fakeIo(noCommon, 'win32') }) === 'C:/Code/wt');
      const posixTree = { '/home/u/main/.git': 'dir', '/home/u/main/.git/worktrees/wt': 'dir', '/home/u/main/.git/worktrees/wt/commondir': '../..\n',
        '/home/u/main/.git/worktrees/wt/gitdir': '/home/u/wt/.git\n', '/home/u/wt/.git': 'gitdir: /home/u/main/.git/worktrees/wt\n' };
      const px = cwd => projectKeyOf(cwd, { platform: 'linux', io: fakeIo(posixTree, 'linux') });
      t.ok('作業場所のキー（Linux）: Git のルート・worktree は本体', await px('/home/u/main/a/b') === '/home/u/main' && await px('/home/u/wt/x') === '/home/u/main' && await px('/srv/none') === '/srv/none');
      // 本物のファイルで（git が作る形の worktree）。設定の反映も本体のキーへ足す
      const base = path.join(tmp, 'keys'); const main = path.join(base, 'main'); const wt = path.join(base, 'wt');
      const fwd = p => p.replaceAll('\\', '/');
      await fs.mkdir(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true }); await fs.mkdir(path.join(wt, 'src', 'deep'), { recursive: true });
      await fs.writeFile(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
      await fs.writeFile(path.join(main, '.git', 'worktrees', 'wt', 'gitdir'), `${fwd(path.join(wt, '.git'))}\n`);
      await fs.writeFile(path.join(wt, '.git'), `gitdir: ${fwd(path.join(main, '.git', 'worktrees', 'wt'))}\n`);
      const want = process.platform === 'win32' ? fwd(main) : main;
      const realKey = await projectKeyOf(path.join(wt, 'src', 'deep'));
      const home = path.join(tmp, 'keys-home'); await fs.mkdir(home, { recursive: true });
      const source = path.join(home, 'source.json'), target = path.join(home, 'target.json');
      await fs.writeFile(source, JSON.stringify({ projects: { [want]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] }, [fwd(wt)]: { allowedTools: ['wrong'] } } }));
      await projectProfile({ source, target, cwd: path.join(wt, 'src'), memo: new Map(), sources: new Map() });
      const out = await readJson(target);
      t.ok('作業場所のキー（本物のファイル）: worktree の中の作業場所は本体の作業ツリーのキーになり、設定の反映もそのキーへ足す',
        realKey === want && Object.keys(out.projects).join() === want && out.projects[want].allowedTools[0] === 'Bash(ls)', `${realKey === want} ${Object.keys(out.projects ?? {}).length}`);
      if (process.platform === 'win32') {
        const lowered = main.replace(/^[A-Z]:/, d => d.toLowerCase());
        t.ok('作業場所のキー（本物の Windows）: 小文字のドライブ文字で開いた作業場所は小文字のまま（CLI の JS の realpath と同じ）', await projectKeyOf(path.join(lowered, 'x')) === fwd(lowered));
      }
    }

    // ---------------------------------------------------------------- 10. 設定の反映の書き方
    {
      const home = path.join(tmp, 'pw'); await fs.mkdir(home, { recursive: true });
      const source = path.join(home, 'source.json');
      await fs.writeFile(source, JSON.stringify({ mcpServers: { alpha: { command: 'alpha' }, beta: { command: 'beta' } } }));
      const counting = (hooks = {}) => {
        const counts = { readFile: 0, writeFile: 0, rename: 0 };
        const io = { ...PROFILE_IO };
        for (const k of Object.keys(counts)) io[k] = async (...a) => { counts[k]++; return hooks[k] ? hooks[k](PROFILE_IO[k], ...a) : PROFILE_IO[k](...a); };
        return { io, counts };
      };
      const quick = { sleep: async () => {}, memo: new Map(), sources: new Map() };
      const leftovers = async () => (await fs.readdir(home)).filter(n => n.endsWith('.tmp') || n.endsWith('.lock'));
      // 足す物が無ければ書かない
      const full = path.join(home, 'full.json');
      await fs.writeFile(full, JSON.stringify({ mcpServers: { alpha: { command: 'mine' }, beta: { command: 'beta' } }, numStartups: 3 }));
      const fullSha = await sha(full);
      const c1 = counting();
      const r1 = await projectProfile({ source, target: full, io: c1.io, ...quick });
      t.ok('反映の書き方（項目 7）: 足す物が無ければ書かない（一時ファイル・付け替え・印のどれも作らない）',
        r1.changed === false && c1.counts.writeFile === 0 && c1.counts.rename === 0 && await sha(full) === fullSha && (await leftovers()).length === 0, JSON.stringify(c1.counts));
      // 壊れた・オブジェクトでない反映先は上書きしない
      for (const [label, body] of [['壊れた JSON', '{ "mcpServers": '], ['配列', '[1, 2]'], ['文字列', '"text"'], ['null', 'null']]) {
        const target = path.join(home, `bad-${label.length}.json`);
        await fs.writeFile(target, body);
        const c = counting();
        const error = await projectProfile({ source, target, io: c.io, ...quick, memo: new Map() }).then(() => null, e => e);
        if (!(error instanceof Error) || await fs.readFile(target, 'utf8') !== body || c.counts.writeFile !== 0) {
          t.ok(`反映の書き方（項目 7）: 反映先が ${label} なら投げ、書かない`, false, `${error} writes=${c.counts.writeFile}`); break;
        }
      }
      t.ok('反映の書き方（項目 7）: 反映先が壊れた JSON・配列・文字列・null なら投げ（入口は profile で止める）、{} で上書きしない', (await leftovers()).length === 0);
      // 付け替えの直前に別の書き手（印を取らない）が書いた → 読み直してやり直し、その書き込みを残したうえで足す
      const raced = path.join(home, 'raced.json');
      await fs.writeFile(raced, JSON.stringify({ mcpServers: { alpha: { command: 'mine' } } }));
      let raceOnce = true;
      const c2 = counting({ writeFile: async (real, file, ...rest) => {
        const r = await real(file, ...rest);
        if (raceOnce && String(file).endsWith('.tmp')) { raceOnce = false; await fs.writeFile(raced, JSON.stringify({ mcpServers: { alpha: { command: 'mine' }, other: { command: 'cli-wrote' } }, numStartups: 7 })); }
        return r;
      } });
      const r2 = await projectProfile({ source, target: raced, io: c2.io, ...quick, memo: new Map() });
      const racedOut = await readJson(raced);
      t.ok('反映の書き方（項目 7）: 付け替えの直前に別の書き込みがあれば読み直してやり直し、その書き込み（別の項目・別のサーバー）を残して足りない分だけ足す',
        r2.changed === true && racedOut.numStartups === 7 && racedOut.mcpServers.other?.command === 'cli-wrote' && racedOut.mcpServers.alpha.command === 'mine' && racedOut.mcpServers.beta?.command === 'beta'
        && c2.counts.writeFile === 2 && c2.counts.rename === 1 && (await leftovers()).length === 0, JSON.stringify({ counts: c2.counts, keys: Object.keys(racedOut) }));
      // Windows の付け替えの一時的な失敗（EPERM・EBUSY）は少し待って繰り返す
      const busy = path.join(home, 'busy.json');
      await fs.writeFile(busy, '{}');
      let fails = ['EPERM', 'EBUSY'];
      const c3 = counting({ rename: async (real, ...a) => { const code = fails.shift(); if (code) throw Object.assign(new Error(code), { code }); return real(...a); } });
      const r3 = await projectProfile({ source, target: busy, io: c3.io, ...quick, memo: new Map() });
      t.ok('反映の書き方（項目 7）: 付け替えが EPERM・EBUSY で断られたら繰り返し、通れば足した内容になる（一時ファイルを残さない）',
        r3.changed === true && c3.counts.rename === 3 && (await readJson(busy)).mcpServers.beta.command === 'beta' && (await leftovers()).length === 0, JSON.stringify(c3.counts));
      const stuck = path.join(home, 'stuck.json');
      await fs.writeFile(stuck, '{}');
      const c4 = counting({ rename: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
      const e4 = await projectProfile({ source, target: stuck, io: c4.io, ...quick, memo: new Map() }).then(() => null, e => e);
      t.ok('反映の書き方: ずっと断られれば投げ（入口は profile で止める）、反映先は変えず一時ファイルも残さない',
        e4 instanceof Error && await fs.readFile(stuck, 'utf8') === '{}' && (await leftovers()).length === 0 && c4.counts.rename > 1, `${e4} renames=${c4.counts.rename}`);
      // 書いた後に読み直して確かめる（付け替えの直後に別の書き手が古い内容で上書きした → やり直す）
      const clobbered = path.join(home, 'clobbered.json');
      await fs.writeFile(clobbered, '{"numStartups":1}');
      let clobberOnce = true;
      const c5 = counting({ rename: async (real, ...a) => { const r = await real(...a); if (clobberOnce) { clobberOnce = false; await fs.writeFile(clobbered, '{"numStartups":2}'); } return r; } });
      const r5 = await projectProfile({ source, target: clobbered, io: c5.io, ...quick, memo: new Map() });
      const clobOut = await readJson(clobbered);
      t.ok('反映の書き方（項目 7）: 書いた後に読み直し、足した項目が無ければ（直後に上書きされた）やり直す',
        r5.changed === true && c5.counts.rename === 2 && clobOut.numStartups === 2 && clobOut.mcpServers?.beta?.command === 'beta', JSON.stringify({ counts: c5.counts, keys: Object.keys(clobOut) }));
      // CLI と同じ印（<反映先>.lock）が新しければ待ち、外れてから書く
      const locked = path.join(home, 'locked.json');
      await fs.writeFile(locked, '{}');
      await fs.mkdir(`${locked}.lock`);
      setTimeout(() => { fs.rmdir(`${locked}.lock`).catch(() => {}); }, 150);
      const startedAt = Date.now();
      const r6 = await projectProfile({ source, target: locked, memo: new Map(), sources: new Map() });
      t.ok('反映の書き方: CLI の設定の保存と同じ印（.lock）が付いている間は待ち、外れてから書く（印は残さない）',
        r6.changed === true && Date.now() - startedAt >= 100 && (await readJson(locked)).mcpServers.beta.command === 'beta' && (await leftovers()).length === 0, `${Date.now() - startedAt}ms`);
      // 状態（mtime・大きさ）が同じなら読まない。変われば読み直して足す
      const memoTarget = path.join(home, 'memo.json');
      await fs.writeFile(memoTarget, '{}');
      const memo = new Map(), sources = new Map();
      await projectProfile({ source, target: memoTarget, memo, sources });
      const c7 = counting();
      const r7 = await projectProfile({ source, target: memoTarget, io: c7.io, memo, sources });
      await fs.writeFile(memoTarget, '{"numStartups":9}');   // 別の書き手が足した分を消した
      const c8 = counting();
      const r8 = await projectProfile({ source, target: memoTarget, io: c8.io, memo, sources });
      t.ok('反映の書き方（項目 7）: 前に確かめた状態（両方の mtime・大きさ）と同じならファイルを読まない。反映先が変われば読み直して足す',
        r7.changed === false && c7.counts.readFile === 0 && c7.counts.writeFile === 0 && r8.changed === true && c8.counts.readFile > 0 && (await readJson(memoTarget)).numStartups === 9,
        JSON.stringify({ second: c7.counts, third: c8.counts }));
    }

    // ---------------------------------------------------------------- 11. 共有の settings.json の別の認証で止める
    {
      const dir = path.join(tmp, 'settings'); await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'settings.json');
      const SETTING_SECRET = 'fake-settings-secret-SSSSSSSSSSSS-0009';
      const cases = [
        ['無い', null, { auth: [], history: [] }],
        ['空', '', { auth: [], history: [] }],
        ['関係の無い env', JSON.stringify({ env: { FOO: 'bar' }, model: 'opus' }), { auth: [], history: [] }],
        ['空の値', JSON.stringify({ env: { ANTHROPIC_API_KEY: '' } }), { auth: [], history: [] }],
        ['ANTHROPIC_API_KEY', JSON.stringify({ env: { ANTHROPIC_API_KEY: SETTING_SECRET } }), { auth: ['ANTHROPIC_API_KEY'], history: [] }],
        ['小文字の anthropic_auth_token', JSON.stringify({ env: { anthropic_auth_token: SETTING_SECRET } }), { auth: ['ANTHROPIC_AUTH_TOKEN'], history: [] }],
        ['CLAUDE_CODE_OAUTH_TOKEN（渡す値を上書きする）', JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: SETTING_SECRET } }), { auth: ['CLAUDE_CODE_OAUTH_TOKEN'], history: [] }],
        ['CLAUDE_CODE_USE_BEDROCK', JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: 1 } }), { auth: ['CLAUDE_CODE_USE_BEDROCK'], history: [] }],
        ['apiKeyHelper', JSON.stringify({ apiKeyHelper: `echo ${SETTING_SECRET}` }), { auth: ['apiKeyHelper'], history: [] }],
        ['CLAUDE_CODE_PROJECT_DIR_NAME', JSON.stringify({ env: { CLAUDE_CODE_PROJECT_DIR_NAME: 'x' } }), { auth: [], history: ['CLAUDE_CODE_PROJECT_DIR_NAME'] }],
        ['壊れた JSON', '{ "env": ', null],
        ['配列', '[]', null],
        ['env が配列', JSON.stringify({ env: ['ANTHROPIC_API_KEY'] }), null],
        ['env が文字列', JSON.stringify({ env: 'ANTHROPIC_API_KEY=x' }), null],
        ['コメント入り（JSONC）', '{ // c\n "env": {} }', null],
      ];
      const bad = [];
      for (const [label, body, want] of cases) {
        if (body === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, body);
        const got = await settingsOverrides(dir);
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${label}: ${JSON.stringify(got)}`);
      }
      const denied = await settingsOverrides(dir, { readFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
      t.ok('settings.json の確かめ（項目 8）: env の認証・接続先・渡す 3 つの名前（大文字小文字を問わない）と apiKeyHelper を名前だけ返す。読めない・壊れている・形が違う（JSONC を含む）は null（止める側）',
        bad.length === 0 && denied === null, bad.slice(0, 3).join(' | '));
      // 入口: 解決のときと起動の直前（fresh）の両方で止める。メッセージに値を出さない
      const home = path.join(tmp, 'settings-home'); const shared = path.join(home, '.claude');
      const usageRoot = path.join(tmp, 'settings-usage'); await fs.mkdir(path.join(usageRoot, ACCOUNT_ID), { recursive: true });
      await fs.writeFile(path.join(usageRoot, ACCOUNT_ID, '.credentials.json'), credsJson());
      await fs.mkdir(shared, { recursive: true });
      const sfile = path.join(shared, 'settings.json');
      let versionsCalled = 0;
      const make = () => createClaudeConnectorsAuth({
        accounts: { usageDir: i => path.join(usageRoot, i), ownerStatus: async () => 'ok' },
        versions: async () => { versionsCalled++; return { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }; },
        refresh: async () => {}, project: async () => ({ changed: false }), env: {}, home, platform: 'linux', now: () => T0, sleep: async () => {},
      });
      const account = { id: ACCOUNT_ID, name: 'fake-account', token: FAKE.registered };
      const stopsAt = [];
      for (const [label, body, code] of [['env の ANTHROPIC_API_KEY', JSON.stringify({ env: { ANTHROPIC_API_KEY: SETTING_SECRET } }), 'connectors-env'],
        ['apiKeyHelper', JSON.stringify({ apiKeyHelper: `echo ${SETTING_SECRET}` }), 'connectors-env'],
        ['壊れている', `{ "apiKeyHelper": "${SETTING_SECRET}`, 'connectors-env'],
        ['履歴の置き場', JSON.stringify({ env: { CLAUDE_CODE_PROJECT_DIR_NAME: SETTING_SECRET } }), 'connectors-history']]) {
        await fs.writeFile(sfile, body); versionsCalled = 0;
        const e = await make()(account).then(() => null, x => x);
        if (e?.code !== code || e.message.includes(SETTING_SECRET) || leaked(e.message).length || versionsCalled) stopsAt.push(`${label}: ${e?.code} versions=${versionsCalled}`);
      }
      await fs.writeFile(sfile, JSON.stringify({ env: { FOO: 'bar' } }));
      const resolved = (await make()(account)).account;
      await fs.writeFile(sfile, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SETTING_SECRET } }));
      const late = await resolved.connectors.fresh({ cwd: tmp }).then(() => null, x => x);
      t.ok('settings.json の確かめ（項目 8）: 別の認証（env・apiKeyHelper）・読めない設定・履歴の置き場は、解決のとき（版を聞く前）にも起動の直前（fresh）にも止める。メッセージに値を出さない',
        stopsAt.length === 0 && late?.code === 'connectors-env' && !late.message.includes(SETTING_SECRET), `${stopsAt.join(' | ')} late=${late?.code}`);
      // 401 で乗り換える道を開く指定（ADR 0340）: settings.json の env にあっても（小文字の名前でも）、解決のとき（版を聞く前）にも起動の直前（fresh）にも env で止める
      const switchBad = [];
      for (const name of SWITCH_ON_401) {
        for (const key of [name, name.toLowerCase()]) {
          await fs.writeFile(file, JSON.stringify({ env: { [key]: SWITCH_VALUE } }));
          const got = await settingsOverrides(dir);
          if (JSON.stringify(got) !== JSON.stringify({ auth: [name], history: [] })) switchBad.push(`overrides ${key}: ${JSON.stringify(got)}`);
          await fs.writeFile(sfile, JSON.stringify({ env: { [key]: SWITCH_VALUE } })); versionsCalled = 0;
          const e = await make()(account).then(() => null, x => x);
          if (e?.code !== 'connectors-env' || !e.message.includes(name) || e.message.includes(SWITCH_VALUE) || leaked(e.message).length || versionsCalled) switchBad.push(`resolve ${key}: ${e?.code} versions=${versionsCalled}`);
        }
        await fs.writeFile(sfile, JSON.stringify({ env: { FOO: 'bar' } }));
        const ok = (await make()(account)).account;
        await fs.writeFile(sfile, JSON.stringify({ env: { [name]: SWITCH_VALUE } }));
        const lateSwitch = await ok.connectors.fresh({ cwd: tmp }).then(() => null, x => x);
        if (lateSwitch?.code !== 'connectors-env' || lateSwitch.message.includes(SWITCH_VALUE)) switchBad.push(`fresh ${name}: ${lateSwitch?.code}`);
      }
      t.ok('settings.json の確かめ: 401 で乗り換える道を開く 7 つの指定（大文字小文字を問わない）は、解決のとき（版を聞く前）にも起動の直前（fresh）にも env で止める。メッセージに値を出さない',
        switchBad.length === 0, switchBad.slice(0, 3).join(' | '));
    }
    {
      const dir = '/private/test-usage';
      let args, options, fileReads = 0;
      const run = async (file, argv, opts) => { args = [file, ...argv]; options = opts; return { exitCode: 0, stdout: credsJson() }; };
      const readFile = async () => { fileReads++; return credsJson(); };
      const cred = await readMacAccessCredentials(dir, { run, readFile });
      const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
      t.ok('macOS: 明示した設定フォルダーのハッシュ付き項目を読み、アクセス用の3項目だけ返す',
        args.at(-1) === `Claude Code-credentials-${hash}` && args.includes('claude-code-user')
        && options.timeoutMs === 10_000 && cred.token === ACCESS && Object.keys(cred).sort().join() === 'expiresAt,scopes,token' && fileReads === 0);
      await readMacAccessCredentials(dir, { configDir: null, run, readFile });
      t.ok('macOS: 設定フォルダー無指定はハッシュなしの項目名', args.at(-1) === 'Claude Code-credentials');
      for (const code of [44, 37, 50, 'ENOENT']) {
        const value = await readMacAccessCredentials(dir, { run: async () => ({ exitCode: typeof code === 'number' ? code : null, startCode: typeof code === 'string' ? code : undefined }), readFile });
        t.ok(`macOS: 項目なし・鍵束なし・利用不可 (${code}) はファイル保存を読む`, value?.token === ACCESS);
      }
      fileReads = 0;
      for (const failure of [{ code: 36 }, { code: 51 }, { code: 128 }, { code: 1 }, { code: 44, killed: true }]) {
        const value = await readMacAccessCredentials(dir, { run: async () => ({ exitCode: failure.code, timedOut: failure.killed }), readFile });
        t.ok(`macOS: ロック・拒否・確認待ち (${failure.code}, ${!!failure.killed}) はファイルへ乗り換えない`, value === null && fileReads === 0);
      }
      const bad = await readMacAccessCredentials(dir, { run: async () => ({ exitCode: 0, stdout: '{' }), readFile });
      t.ok('macOS: 壊れたキーチェーン項目はファイルへ乗り換えない', bad?.malformed === true && fileReads === 0);
    }
    if (process.platform !== 'win32') {
      const dir = path.join(tmp, 'profile-links');
      await fs.mkdir(dir);
      const source = path.join(dir, 'source.json');
      const target = path.join(dir, 'target.json');
      const link = path.join(dir, 'link.json');
      await fs.writeFile(source, JSON.stringify({ mcpServers: { example: { command: 'example' } } }));
      await fs.writeFile(target, '{}');
      await fs.symlink(target, link);
      await Promise.all([projectProfile({ source, target: link }), projectProfile({ source, target })]);
      t.ok('設定の反映: リンクと実体への同時更新でもリンクを残して実体に反映する',
        (await fs.lstat(link)).isSymbolicLink() && !!(await readJson(target)).mcpServers?.example);
      await fs.unlink(target);
      const error = await projectProfile({ source, target: link }).then(() => null, e => e);
      t.ok('設定の反映: 壊れたリンクは作り替えず停止する',
        !!error && (await fs.lstat(link)).isSymbolicLink());
    }
  } finally {
    restoreConsole();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
import { hashConnectorIdentity } from '../../core/claude-connectors.mjs';
