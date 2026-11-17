// 登録した Claude アカウントのコネクターの認証（ADR 0340 段 2。方式 (b1)）。LLM も本物の CLI も本物の資格情報も使わない。トークン・メール・組織の id はすべて偽の値。
//   1. 資格情報の読み取り: アクセス用トークン・期限・権限だけを返す（更新用トークンは返さない）・無い／形違い／壊れて見える間の読み直し
//   2. 設定の反映（projectProfile）: 許可した項目だけ・既存の値を上書きしない・冪等（変わらなければ書かない）・元の ~/.claude.json を変えない・認証や組織の情報を写さない
//   3. 認証の解決: 成功の形（会話用トークンへ戻さない）・止める条件ごとの失敗（OS・別の認証の環境変数・履歴の場所・版・持ち主・ログイン・形・期限・反映）・
//      更新は CLI に任せる（期限が近いときだけ 1 回）・止めた理由に秘密が出ない・process.env を変えない
//   4. 起動の記録（オン）: オフの記録との差が「認証に要る 3 つの環境変数」だけ（argv・cwd・ほかの env・SDK の options・保持役への変換は同じ）。互換接続は同じ
//   5. オフ・未設定・別アカウント・壊れた設定: 認証側のどの関数（持ち主の確認・版・資格情報の読み取り・更新・設定の反映・印付け・時計・待ち）も 0 回・ファイルの作成 0・タイマー 0
//   6. 使用量の読み取りの排他（印を付けたフォルダだけ）・server の配線
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAll, ACCOUNT_ID, FAKE } from '../lib/claude-launch-record.mjs';
import { createClaudeConnectorsGate, CONNECTORS_FILE, identitySuffix } from '../../core/claude-connectors.mjs';
import {
  createClaudeConnectorsAuth, readAccessCredentials, projectProfile, ConnectorsAuthError, VERIFIED_VERSIONS, IDENTITY, EXPIRY_MARGIN_MS, READ_ATTEMPTS,
} from '../../core/claude-connectors-auth.mjs';
import { withUsageLock } from '../../core/backends/claude-usage.mjs';
import { accountScopeKeyForTest } from '../../core/backends/claude.mjs';

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
const credsJson = ({ token = ACCESS, expiresAt = T0 + 8 * 3600_000, scopes = SCOPES } = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: REFRESH, expiresAt, scopes, subscriptionType: 'max' }, oauthAccount: { emailAddress: EMAIL, organizationUuid: ORG } });
const leaked = text => SECRETS.filter(s => String(text).includes(s));
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

export default async function (t) {
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
      let owner = 'ok', versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }, refreshWrites = null, refreshThrows = false, projectThrows = false;
      let now = T0;
      const make = (over = {}) => createClaudeConnectorsAuth({
        accounts: { usageDir: id => path.join(usageRoot, id), ownerStatus: async () => { calls.owner++; return owner; } },
        versions: async () => { calls.versions++; if (versions instanceof Error) throw versions; return versions; },
        refresh: async d => { calls.refresh++; if (d !== dir) throw new Error('別の設定フォルダ'); if (refreshWrites) await fs.writeFile(credFile, refreshWrites); if (refreshThrows) throw new Error(`refresh failed ${ACCESS}`); },
        guard: () => { calls.guard++; },
        project: async args => { calls.project++; projectArgs.push(args); if (projectThrows) throw new Error(`profile failed ${ACCESS}`); return { changed: false }; },
        env: {}, home, platform: 'linux', now: () => now, ...over,
      });
      const reset = () => { for (const k of Object.keys(calls)) calls[k] = 0; projectArgs.length = 0; owner = 'ok'; versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }; refreshWrites = null; refreshThrows = false; projectThrows = false; now = T0; };
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
        ['version', 'CLI の版が違う', () => { versions = { cli: '2.1.323', sdk: VERIFIED_VERSIONS[0].sdk }; }, {}, false],
        ['version', 'SDK の版が違う', () => { versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: '0.3.289' }; }, {}, false],
        ['version', '版が分からない（null）', () => { versions = { cli: null, sdk: null }; }, {}, false],
        ['version', '版を聞くのに失敗', () => { versions = new Error('boom'); }, {}, false],
        ['owner', '持ち主が食い違う', () => { owner = 'mismatch'; }, {}, false],
        ['owner', '持ち主を確認できない', () => { owner = 'unknown'; }, {}, false],
        ['login', '資格情報が無い', async () => { await fs.rm(credFile, { force: true }); }, {}, true],
        ['format', '資格情報の形が違う', async () => { await fs.writeFile(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })); }, {}, true],
      ];
      for (const [kind, label, setup, over, readsCred] of stops) {
        reset(); await fs.writeFile(credFile, credsJson());
        await setup();
        let reads = 0;
        const error = await make({ ...over, readFile: async (...a) => { reads++; return fs.readFile(...a); }, sleep: async () => {} })(account).then(() => null, e => e);
        t.ok(`止める: ${kind}（${label}）→ ConnectorsAuthError(connectors-${kind})・会話用トークンへ戻さない・refresh/反映は呼ばない${readsCred ? '' : '・資格情報を読まない'}・メッセージに秘密なし`,
          error instanceof ConnectorsAuthError && error.code === `connectors-${kind}` && error.message.length > 10 && !error.message.includes('{{') && leaked(error.message).length === 0
          && calls.refresh === 0 && calls.project === 0 && (readsCred || reads === 0), `${error?.code} ${error?.message?.slice(0, 80)} reads=${reads} ${JSON.stringify(calls)}`);
      }
      await fs.writeFile(credFile, credsJson()); reset();

      // 期限と更新（更新は CLI に任せる）
      reset(); now = T0;
      await fs.writeFile(credFile, credsJson({ expiresAt: T0 + EXPIRY_MARGIN_MS - 1000 }));
      refreshWrites = credsJson({ token: ACCESS2, expiresAt: T0 + 8 * 3600_000 });
      const near = (await make()(account)).account;
      const renewed = await near.connectors.fresh({ cwd: tmp });
      t.ok('更新: 期限が近ければ起動の前に refresh（CLI に更新させる）を 1 回流し、読み直した新しいアクセス用トークンを渡す', calls.refresh === 1 && renewed.token === ACCESS2 && near.token === ACCESS, JSON.stringify({ calls, same: renewed.token === ACCESS2 }));
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 + EXPIRY_MARGIN_MS - 1000 }));
      const stale = (await make()(account)).account;
      const staleError = await stale.connectors.fresh({ cwd: tmp }).then(() => null, e => e);
      t.ok('更新: refresh が何も変えなければ（期限が近いまま）止める（expired）・旧いトークンも会話用トークンも渡さない・設定は反映しない',
        staleError?.code === 'connectors-expired' && calls.refresh === 1 && calls.project === 0 && leaked(staleError.message).length === 0, `${staleError?.code} ${JSON.stringify(calls)}`);
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 - 1000 })); refreshThrows = true;
      const failed = (await make()(account)).account;
      const failedError = await failed.connectors.fresh({ cwd: tmp }).then(() => null, e => e);
      t.ok('更新: refresh が失敗し期限切れのままなら止める（expired）。失敗の文面（トークンを含む）は利用者へ出さない',
        failedError?.code === 'connectors-expired' && leaked(failedError.message).length === 0 && !String(failedError.stack).includes(ACCESS), `${failedError?.code}`);
      reset(); await fs.writeFile(credFile, credsJson({ expiresAt: T0 - 1000 })); refreshThrows = true; refreshWrites = credsJson({ token: ACCESS2 });
      const recovers = (await make()(account)).account;
      t.ok('更新: refresh が例外でも、ログインが更新されていれば（読み直して期限が十分）使える', (await recovers.connectors.fresh({ cwd: tmp }).catch(() => ({}))).token === ACCESS2);
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
          if (route !== 'connectorList') {
            const env = b.proc.env;
            const shared = label.startsWith('configDir') ? 'FAKE_CONFIG_DIR' : '<tmp>/data/home/.claude';
            if (env.CLAUDE_CODE_OAUTH_TOKEN !== ACCESS || env.CLAUDE_CODE_OAUTH_SCOPES !== SCOPES.join(' ') || env.CLAUDE_CONFIG_DIR !== shared) {
              problems.push(`${label} ${route}: 認証の値が想定と違う（token=${env.CLAUDE_CODE_OAUTH_TOKEN === ACCESS ? 'access' : env.CLAUDE_CODE_OAUTH_TOKEN === FAKE.registered ? 'registered' : '?'} config=${env.CLAUDE_CONFIG_DIR}）`);
            }
          } else if (b.proc.env.CLAUDE_CODE_OAUTH_TOKEN !== ACCESS) problems.push(`${label} ${route}: 一覧の取得が会話用トークンのまま`);
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
      t.ok('オン: 更新（refresh）は期限が十分なので流れない・設定の反映は起動のたびに 1 回ずつ（会話・内部の会話・題・一覧 の 4 経路 × 組み合わせ）',
        !log.includes('refresh') && log.filter(l => l === 'project').length === 5 * 4, JSON.stringify([...new Set(log)]) + ' x' + log.length);
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
          guard: () => { touched++; }, project: boom('project'), readFile: boom('readFile'), sleep: boom('sleep'), now: () => { touched++; return 0; }, env: new Proxy({}, { get: () => { touched++; return undefined; }, ownKeys: () => { touched++; return []; } }),
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
      const usageSrc = await fs.readFile(path.join(REPO, 'core/backends/claude-usage.mjs'), 'utf8');
      t.ok('排他は印を付けたフォルダだけ（readClaudeUsage は guarded に無いフォルダ・フォルダ指定なしでは今までと同じ道）',
        /configDir && guarded\.has\(lockKey\(configDir\)\) \? withUsageLock\(/.test(usageSrc) && /readClaudeUsageNow\(\{ token, configDir \}\)\s*;?\s*\n\}/.test(usageSrc));
      const server = await fs.readFile(path.join(REPO, 'core/server.mjs'), 'utf8');
      t.ok('server: 認証側は 1 か所で組み立て、入口の resolveAuth に渡す。更新は使用量の読み取り（CLI）に任せ、印付けは guardUsageDir',
        [...server.matchAll(/createClaudeConnectorsAuth\(/g)].length === 1 && /resolveAuth: createClaudeConnectorsAuth\(\{/.test(server) && /refresh: dir => readClaudeUsage\(\{ configDir: dir \}\)/.test(server) && /guard: guardUsageDir/.test(server));
      const authSrc = await fs.readFile(path.join(REPO, 'core/claude-connectors-auth.mjs'), 'utf8');
      t.ok('認証側は更新用トークンを取り出さない・私的な更新の口を呼ばない・ホーム直下の .claude.json へ書かない・ネットワークを使わない',
        !/refreshToken/.test(authSrc.replace(/\/\/.*$/gm, '')) && !/fetch\(|https?:\/\/|oauth\/token|createConnection|net\./.test(authSrc.replace(/\/\/.*$/gm, '')) && !/writeFile\([^)]*source/.test(authSrc));
    }
  } finally {
    restoreConsole();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
