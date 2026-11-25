// 登録した Claude アカウントのコネクターの認証（ADR 0340・0350・0351。専用フォルダ方式だけ）。LLM も本物の CLI も本物の資格情報も使わない。トークン・メール・組織の id はすべて偽の値。
//   1. 版の確認（supportedConnectorVersions）
//   2. 設定の反映（projectProfile）: 許可した項目だけ・既存の値を上書きしない・冪等（変わらなければ書かない）・元の ~/.claude.json を変えない・認証や組織の情報を写さない
//   3. 認証の解決: 成功の形（トークンを渡さない・CLAUDE_CONFIG_DIR だけ）・止める条件ごとの失敗（OS・ssh・別の認証の環境変数・履歴の場所・版・ログイン・準備）・
//      止めた理由に秘密が出ない・process.env を変えない・親の認証の環境変数は子へ渡さない（claudeOwnDirEnv）
//   4. 起動の記録（オン・オフ）: どちらも専用フォルダ（トークンなし）。差はオフの ENABLE_CLAUDEAI_MCP_SERVERS=false だけ。互換接続は同じ（ADR 0352）
//   5. 入口の設定: 未設定・オフ・別アカウント・壊れた設定はオフとして読み、書かない・保存済みの mode は読まない・キャッシュのキー
//   6. server の配線（オン・オフとも専用フォルダの認証を付ける）・認証側はネットワークも更新用トークンも使わない
//   7. 設定 › 外部 MCP のコネクターの一覧（connectorListProbe）: 会話と同じ組み立て・止める条件はログイン中へ戻らない
//   8. 付け直し（adoptTurn）も認証を通る・一覧の覚えはアカウントを消すと消える
//   9. 作業場所のキー（CLI 2.1.322 の作り方: worktree は本体・Windows は / ・ドライブ文字はそのまま）
//  10. 設定の反映の書き方（足す物が無ければ書かない・壊れた反映先で止める・直前の別の書き込みを残す・付け替えの一時的な失敗の繰り返し・状態が同じなら読まない）
//  11. 共有の settings.json の別の認証（env・apiKeyHelper・読めない・壊れている）で止める
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAll, ACCOUNT_ID, FAKE } from '../lib/claude-launch-record.mjs';
import { createClaudeConnectorSettings, CONNECTORS_FILE } from '../../core/claude-connectors.mjs';
import { OWN_DIR } from '../../core/claude-own-dir.mjs';
import {
  createClaudeConnectorsAuth, projectProfile, ConnectorsAuthError, VERIFIED_VERSIONS, claudeOwnDirEnv,
  projectKeyOf, settingsOverrides, PROFILE_IO, connectorListProbe, createClaudeConnectorsWiring, supportedConnectorVersions,
} from '../../core/claude-connectors-auth.mjs';
import { backend as claudeBackend, accountScopeKeyForTest, catalogStateKeysForTest } from '../../core/backends/claude.mjs';

export const name = 'claude-connectors-auth';
export const title = 'Claude コネクターの認証（専用フォルダ方式だけ）: 設定の反映・止める条件・オンの差分は認証の環境変数だけ・オフは何も呼ばない';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
// 偽の秘密（本物ではない）。どの出力・記録にも出てはいけない
const ACCESS = 'fake-access-token-AAAAAAAAAAAAAAAAAAAA-0001';
const EMAIL = 'fake.person@example.invalid';
const ORG = 'fake-org-uuid-0000-1111-2222';
const SECRETS = [ACCESS, EMAIL, ORG, FAKE.registered];
const leaked = text => SECRETS.filter(s => String(text).includes(s));
/** 401 のとき保存された資格情報・ホストのトークン・別の出どころへ乗り換える道を開く指定（CLI 2.1.322。ADR 0340）。確かめから外すと落ちることを 1 つずつ確かめる */
const SWITCH_ON_401 = ['ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_BG_AUTH_SNAPSHOT_PATH'];
const SWITCH_VALUE = 'fake-switch-value-SSSS-0011';
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.lstat(file).then(() => true, () => false);

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
  // 専用フォルダは共有の設定フォルダへのリンク（settings.json はファイルのシンボリックリンク）で作る。
  // Windows でリンクを作る権限が無いと準備まで進めないので、権限が要る節はここで見分ける（権限が無い PC では該当の節を飛ばす）
  const linkProbe = path.join(tmp, 'link-probe');
  await fs.writeFile(`${linkProbe}-target`, '');
  const canLink = await fs.symlink(`${linkProbe}-target`, linkProbe, 'file').then(() => true, err => {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(err.code)) throw err;
    return false;
  });
  try {
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

    // ---------------------------------------------------------------- 3. 認証の解決（専用フォルダ方式）
    {
      const usageRoot = path.join(tmp, 'auth-usage');
      const dir = path.join(usageRoot, ACCOUNT_ID); await fs.mkdir(dir, { recursive: true });
      const home = path.join(tmp, 'auth-home');
      const work = path.join(tmp, 'work');
      const calls = { versions: 0, project: 0, login: 0 };
      const projectArgs = [];
      let versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }, projectThrows = false, login = 'present', usageLogin = true;
      const make = (over = {}) => createClaudeConnectorsAuth({
        accounts: { usageDir: id => path.join(usageRoot, id), hasUsageLogin: async () => usageLogin },
        versions: async () => { calls.versions++; if (versions instanceof Error) throw versions; return versions; },
        project: async args => { calls.project++; projectArgs.push(args); if (projectThrows) throw new Error(`profile failed ${ACCESS}`); return { changed: false }; },
        loginPresent: async () => { calls.login++; return login; },
        managedFiles: [], env: {}, home, platform: 'linux', ...over,
      });
      const reset = () => { for (const k of Object.keys(calls)) calls[k] = 0; projectArgs.length = 0; versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }; projectThrows = false; login = 'present'; usageLogin = true; };
      const account = { id: ACCOUNT_ID, name: 'fake-account' };

      reset();
      const resolved = (await make()(account)).account;
      t.ok('認証: 成功 — 全アカウントが専用フォルダ（ownDir・識別子 own-dir）。コネクターがオフなら connectors は置かない（ADR 0352）',
        resolved.id === ACCOUNT_ID && resolved.name === 'fake-account' && resolved.ownDir.identity === OWN_DIR && OWN_DIR === 'own-dir' && resolved.ownDir.enabled === false
        && Object.keys(resolved).sort().join() === 'id,name,ownDir' && Object.keys(resolved.ownDir).sort().join() === 'authFailure,enabled,identity,prepare');
      t.ok('認証: 解決のときは準備（リンク・設定の反映）をしない（project 0 回）・版とログインの有無は見る', calls.project === 0 && calls.versions === 1 && calls.login === 1, JSON.stringify(calls));
      const resolvedOn = (await make()(account, { enabled: true })).account;
      t.ok('認証: コネクターがオンなら connectors に同じ認証を置く', resolvedOn.connectors === resolvedOn.ownDir && resolvedOn.ownDir.enabled === true);

      if (canLink) {
        reset();
        const home1 = path.join(tmp, 'auth-home-1');
        const ok = (await make({ home: home1 })(account, { enabled: true })).account;
        const auth = await ok.connectors.prepare({ cwd: work });
        t.ok('認証: prepare の戻りは { env: { CLAUDE_CONFIG_DIR: 専用フォルダ } } だけ（トークン・権限の並びを含まない）',
          JSON.stringify(auth) === JSON.stringify({ env: { CLAUDE_CONFIG_DIR: dir } }) && leaked(JSON.stringify(auth)).length === 0, JSON.stringify(auth));
        t.ok('認証: prepare の設定の反映は ホーム直下の .claude.json → 専用フォルダの .claude.json、作業場所つき（共有の設定フォルダへは書かない）',
          projectArgs.length === 1 && projectArgs[0].source === path.join(home1, '.claude.json') && projectArgs[0].target === path.join(dir, '.claude.json') && projectArgs[0].cwd === work, JSON.stringify(projectArgs));
        const shared = path.join(home1, '.claude');
        const linked = await Promise.all(['projects', 'skills', 'plugins', 'settings.json'].map(async name => (await fs.lstat(path.join(dir, name)).catch(() => null))?.isSymbolicLink() === true));
        t.ok('認証: prepare で専用フォルダの projects・skills・plugins・settings.json が共有の設定フォルダへのリンクになる（共有の settings.json は無ければ {} で作る）',
          linked.every(Boolean) && (await fs.readFile(path.join(shared, 'settings.json'), 'utf8')).trim() === '{}', JSON.stringify(linked));
        reset();
        // 別の専用フォルダ（上で共有の設定フォルダ A へリンク済みのものを、別の共有 B へ付け替える場合を混ぜない）
        const viaRoot = path.join(tmp, 'auth-usage-env');
        await fs.mkdir(path.join(viaRoot, ACCOUNT_ID), { recursive: true });
        await fs.mkdir(path.join(tmp, 'parent-config'), { recursive: true });
        const viaEnv = (await make({ accounts: { usageDir: id => path.join(viaRoot, id), hasUsageLogin: async () => true }, env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'parent-config') } })(account)).account;
        const offAuth = await viaEnv.ownDir.prepare({ cwd: work });
        t.ok('認証: 親に CLAUDE_CONFIG_DIR があればそれを共有の設定フォルダとする（反映元はその中の .claude.json）',
          projectArgs[0]?.source === path.join(tmp, 'parent-config', '.claude.json'), JSON.stringify(projectArgs));
        t.ok('認証: コネクターがオフのアカウントは専用フォルダに加えて claude.ai のコネクターを出さない（ENABLE_CLAUDEAI_MCP_SERVERS=false）',
          JSON.stringify(offAuth) === JSON.stringify({ env: { CLAUDE_CONFIG_DIR: path.join(viaRoot, ACCOUNT_ID), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } }), JSON.stringify(offAuth));
      } else t.skip('認証: prepare の成功の形・リンク・共有の設定フォルダの決め方（Windows でファイルのシンボリックリンクを作る権限が無い）');

      // 止める条件。どれも ConnectorsAuthError（connectors-<種類>）・設定の反映は呼ばない・メッセージに秘密なし
      const stops = [
        ['platform', 'Windows・Linux・macOS 以外の OS', () => {}, { platform: 'freebsd' }],
        ['ssh', 'macOS を ssh 経由で起動した（SSH_CONNECTION）', () => {}, { platform: 'darwin', env: { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } }],
        ['ssh', 'macOS を ssh 経由で起動した（SSH_TTY）', () => {}, { platform: 'darwin', env: { SSH_TTY: '/dev/ttys001' } }],
        ['keychain', 'macOS で鍵束の項目が無い', () => { login = 'keychain'; }, { platform: 'darwin' }],
        ['platform', 'ログインの有無を判定できない OS（loginPresent が platform を返す）', () => { login = 'platform'; }, {}],
        ['ownDirLogin', 'ログインが無い（資格情報が無い）', () => { login = 'missing'; }, {}],
        ['ownDirLogin', '専用フォルダのログインの印が無い', () => { usageLogin = false; }, {}],
        ['ownDirLogin', '専用フォルダが無い', () => {}, { accounts: { usageDir: id => path.join(usageRoot, `${id}-none`), hasUsageLogin: async () => true } }],
        ['history', 'CLAUDE_CODE_PROJECT_DIR_NAME', () => {}, { env: { CLAUDE_CODE_PROJECT_DIR_NAME: 'x' } }],
        ['version', 'CLI の版が古い', () => { versions = { cli: '2.1.321', sdk: VERIFIED_VERSIONS[0].sdk }; }, {}],
        ['version', 'SDK の版が違う', () => { versions = { cli: VERIFIED_VERSIONS[0].cli, sdk: '0.3.289' }; }, {}],
        ['version', '版が分からない（null）', () => { versions = { cli: null, sdk: null }; }, {}],
        ['version', '版を聞くのに失敗', () => { versions = new Error('boom'); }, {}],
        // 想定外の例外も止める条件に揃える（一覧の読み取りがログイン中のアカウントへ落ちないように。元の文面は出さない）
        ['login', '使用量の設定フォルダを引けない（例外）', () => {}, { accounts: { usageDir: () => { throw new Error(`usageDir ${ACCESS}`); }, hasUsageLogin: async () => true } }],
        ['login', 'ログインの有無を調べるのが例外', () => {}, { loginPresent: async () => { throw new Error(`present ${ACCESS}`); } }],
      ];
      for (const [kind, label, setup, over] of stops) {
        reset();
        await setup();
        const error = await make(over)(account).then(() => null, e => e);
        t.ok(`止める: ${kind}（${label}）→ ConnectorsAuthError(connectors-${kind})・準備（設定の反映）は呼ばない・メッセージに秘密なし`,
          error instanceof ConnectorsAuthError && error.code === `connectors-${kind}` && error.message.length > 10 && !error.message.includes('{{') && leaked(error.message).length === 0
          && calls.project === 0, `${error?.code} ${error?.message?.slice(0, 80)} ${JSON.stringify(calls)}`);
      }
      reset();
      // 止める順: OS → ssh → 版 → ログイン（版を聞く前に OS で止め、ログインを見る前に版で止める）
      await make({ platform: 'freebsd' })(account).catch(() => {});
      const afterPlatform = { ...calls };
      reset();
      await make({ platform: 'darwin', env: { SSH_CONNECTION: 'x' } })(account).catch(() => {});
      const afterSsh = { ...calls };
      reset(); versions = { cli: '2.1.321', sdk: VERIFIED_VERSIONS[0].sdk };
      await make()(account).catch(() => {});
      const afterVersion = { ...calls };
      t.ok('止める順: OS・ssh は版を聞かずに止め、版が合わなければログインを見ずに止める',
        afterPlatform.versions === 0 && afterSsh.versions === 0 && afterSsh.login === 0 && afterVersion.versions === 1 && afterVersion.login === 0, JSON.stringify({ afterPlatform, afterSsh, afterVersion }));
      reset();
      // 検査（画面用）は同じ止める条件を { ok: false, kind, … } で返す。prepare を求めなければ設定の反映・リンクの準備をしない
      login = 'missing';
      const inspected = await make().inspect(account);
      t.ok('検査: 止める条件は ok:false と種類・再ログインの要否で返す（ownDirLogin は再ログインを促す）・秘密なし',
        inspected.ok === false && inspected.kind === 'ownDirLogin' && inspected.reauth === true && leaked(JSON.stringify(inspected)).length === 0, JSON.stringify(inspected));
      reset();
      const okInspect = await make().inspect(account);
      t.ok('検査: 準備なしの成功は moves が空・識別のハッシュを返す（準備はしない）', okInspect.ok === true && okInspect.moves.length === 0 && typeof okInspect.identityHash === 'string' && okInspect.identityHash.length > 0 && calls.project === 0, JSON.stringify(okInspect));

      // 親の env にある別の認証・接続先は、止めずに子の env から外す（claudeOwnDirEnv）。専用フォルダの値だけが残る
      const parent = {
        PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: FAKE.apiKey, ANTHROPIC_AUTH_TOKEN: FAKE.authToken, CLAUDE_CODE_OAUTH_TOKEN: FAKE.parentOauth, CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'fake-refresh', ANTHROPIC_BASE_URL: 'https://x.example.invalid', CLAUDE_CODE_USE_BEDROCK: '1', claude_code_oauth_token: FAKE.parentOauth, Claude_Config_Dir: 'FAKE_LOWER',
        CLAUDE_CONFIG_DIR: 'FAKE_PARENT_CONFIG', ...Object.fromEntries(SWITCH_ON_401.map(n => [n, SWITCH_VALUE])),
      };
      const childEnv = claudeOwnDirEnv(parent, { CLAUDE_CONFIG_DIR: '/own/dir' });
      t.ok('子の env: 別の認証・接続先・401 で乗り換える道・親の CLAUDE_CONFIG_DIR は外れ、専用フォルダ（CLAUDE_CONFIG_DIR）だけが残る（大文字小文字違いの名前も外す）。ほかの env は残す',
        JSON.stringify(Object.keys(childEnv).sort()) === '["CLAUDE_CONFIG_DIR","HOME","PATH"]' && childEnv.CLAUDE_CONFIG_DIR === '/own/dir' && childEnv.PATH === '/bin' && childEnv.HOME === '/home/x', JSON.stringify(Object.keys(childEnv)));
      t.ok('子の env: 呼び出し元の env を書き換えない', parent.CLAUDE_CODE_OAUTH_TOKEN === FAKE.parentOauth && parent.CLAUDE_CONFIG_DIR === 'FAKE_PARENT_CONFIG');

      if (canLink) {
        // 設定の反映が失敗すれば止める（ownDirProfile）・メッセージにトークンを出さない・リンクの準備のあとなので共有の項目はそのまま
        // 専用フォルダごと別にする（リンクが別の共有の設定フォルダを指しているものは「想定外のリンク」で止まるため、上の節のものを使い回さない）
        const ownIn = async tag => {
          const root = path.join(tmp, `auth-usage-${tag}`);
          await fs.mkdir(path.join(root, ACCOUNT_ID), { recursive: true });
          return { usageDir: id => path.join(root, id), hasUsageLogin: async () => true };
        };
        reset();
        const accountsP = await ownIn('p');
        const prof = (await make({ accounts: accountsP, home: path.join(tmp, 'auth-home-p') })(account)).account;
        projectThrows = true;
        const profileError = await prof.ownDir.prepare({ cwd: work }).then(() => null, e => e);
        t.ok('prepare: 設定の反映が失敗すれば止める（ownDirProfile）・失敗の文面（トークンを含む）を利用者へ出さない',
          profileError instanceof ConnectorsAuthError && profileError.code === 'connectors-ownDirProfile' && leaked(profileError.message).length === 0 && !String(profileError.stack).includes(ACCESS), `${profileError?.code}`);
        // 準備の間にログインが消えたら止める（解決のときの値へ戻らない）
        reset();
        const later = (await make({ accounts: accountsP, home: path.join(tmp, 'auth-home-p') })(account)).account;
        login = 'missing';
        const gone = await later.ownDir.prepare({ cwd: work }).then(() => null, e => e);
        t.ok('prepare: 起動の前にログインが消えていれば止める（ownDirLogin）・設定の反映は呼ばない', gone?.code === 'connectors-ownDirLogin' && calls.project === 0, `${gone?.code} ${JSON.stringify(calls)}`);
        // 共有の settings.json の別の認証は、起動の前の準備でも止める（解決のあとに書かれた場合）
        reset();
        const sharedHome = path.join(tmp, 'auth-home-s');
        const later2 = (await make({ accounts: await ownIn('s'), home: sharedHome })(account)).account;
        await fs.mkdir(path.join(sharedHome, '.claude'), { recursive: true });
        await fs.writeFile(path.join(sharedHome, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fake' } }));
        const late = await later2.ownDir.prepare({ cwd: work }).then(() => null, e => e);
        t.ok('prepare: 解決のあとに共有の settings.json へ別の認証が書かれても、起動の前の準備で止める（env）', late?.code === 'connectors-env' && calls.project === 0, `${late?.code} ${JSON.stringify(calls)}`);
      }
      // 会話の CLI が専用フォルダのログインで断られたとき（authFailure）: macOS で鍵束の項目が有るなら keychainAuth、それ以外は null（期限切れ扱い）
      reset();
      const darwin = (await make({ platform: 'darwin', loginPresent: async () => 'present' })(account)).account;
      const darwinFail = await darwin.ownDir.authFailure();
      const darwinCode = darwinFail?.code ?? null;
      reset();
      const linux = (await make()(account)).account;
      t.ok('authFailure: macOS で項目が有れば keychainAuth（再ログインを促す）・Linux・Windows は null（期限切れとして扱う）',
        darwinCode === 'connectors-keychainAuth' && darwinFail?.connectorsError?.reauth === true && (await linux.ownDir.authFailure()) === null, String(darwinCode));
      restoreConsole();
      t.ok('認証: process.env は変えない・コンソールに何も出さない（秘密を含めて）',
        JSON.stringify(process.env) === savedProcessEnv && leaked(consoleLines.join('\n')).length === 0 && consoleLines.length === 0, consoleLines.slice(0, 2).join(' | ').slice(0, 120));
    }

    // ---------------------------------------------------------------- 4. 起動の記録（オン・オフ）— どちらも専用フォルダ。差はオフの ENABLE_CLAUDEAI_MCP_SERVERS だけ（ADR 0352）
    if (!canLink) t.skip('登録したアカウントの起動の記録（Windows でファイルのシンボリックリンクを作る権限が無い。専用フォルダの準備に要る）');
    else {
      const labels = ['plain/registered/none', 'parentOauth/registered/none', 'configDir/registered/none', 'emptyOauth/registered/none', 'undefinedOauth/registered/none', 'plain/registered/compat'];
      const log = { on: [], off: [] };
      const wired = which => ({
        onSetup: async ({ data }) => {
          await fs.writeFile(path.join(data, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: which === 'on' } } }));
          await fs.mkdir(path.join(data, 'claude-usage', ACCOUNT_ID), { recursive: true });
        },
        accountFor: async (accounts, id, { data, platform }) => createClaudeConnectorsWiring({
          dataDir: data,
          accounts: { usageDir: i => path.join(data, 'claude-usage', i), hasUsageLogin: async () => true, resolve: (i, o) => accounts.resolve(i, o) },
          versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
          project: async () => { log[which].push('project'); return { changed: false }; },
          loginPresent: async () => 'present', managedFiles: [], env: {}, home: path.join(data, 'home'), platform,
        }).resolve(id),
      });
      const off = await recordAll({ root: REPO, only: labels, dumpName: 'auth-off', ...wired('off') });
      const on = await recordAll({ root: REPO, only: labels, dumpName: 'auth-on', ...wired('on') });
      const ALLOWED = ['ENABLE_CLAUDEAI_MCP_SERVERS'];
      const stripEnv = (rec, keys) => rec && { ...rec, env: Object.fromEntries(Object.entries(rec.env).filter(([k]) => !keys.includes(k))) };
      const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
      const problems = [];
      for (const label of labels) {
        const compat = label.endsWith('/compat');
        for (const route of ['runTurn', 'internalTurn', 'suggestTitle', 'modelList', 'connectorList', 'usage', 'heldSpawn']) {
          const a = off[label]?.[route], b = on[label]?.[route];
          if (!a || !b) { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} ${route}: 記録の有無が違う`); continue; }
          // 保持役への変換・使用量・互換接続はオフと完全に同じ
          if (route === 'heldSpawn' || route === 'usage' || compat) { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} ${route}: オフと違う`); continue; }
          if (!a.proc || !b.proc) { problems.push(`${label} ${route}: 起動されなかった`); continue; }
          if (JSON.stringify(a.proc.argv) !== JSON.stringify(b.proc.argv)) problems.push(`${label} ${route}: argv が違う`);
          if (a.proc.cwd !== b.proc.cwd || JSON.stringify(a.proc.files) !== JSON.stringify(b.proc.files)) problems.push(`${label} ${route}: cwd か files が違う`);
          const d = diffKeys(a.proc.env, b.proc.env);
          if (d.some(k => !ALLOWED.includes(k))) problems.push(`${label} ${route}: env の想定外の差 ${d.filter(k => !ALLOWED.includes(k)).join(',')}`);
          if (JSON.stringify(a.sdk.map(o => ({ ...o, env: undefined }))) !== JSON.stringify(b.sdk.map(o => ({ ...o, env: undefined })))) problems.push(`${label} ${route}: SDK の options（env 以外）が違う`);
          if (a.sdk.length !== b.sdk.length) problems.push(`${label} ${route}: SDK の呼び出し回数が違う`);
          for (let i = 0; i < Math.min(a.sdk.length, b.sdk.length); i++) {
            const sd = diffKeys(a.sdk[i].env ?? {}, b.sdk[i].env ?? {});
            if (sd.some(k => !ALLOWED.includes(k))) problems.push(`${label} ${route}: SDK の env の想定外の差 ${sd.filter(k => !ALLOWED.includes(k)).join(',')}`);
          }
          // 会話・モデルの一覧・コネクターの一覧は同じ組み立て（ownDir.prepare()）: オン・オフとも、トークンは渡さず専用フォルダだけを渡す
          for (const [which, env] of [['off', a.proc.env], ['on', b.proc.env]]) {
            if (Object.keys(env).some(k => /^CLAUDE_CODE_OAUTH_(TOKEN|SCOPES|REFRESH_TOKEN)$/i.test(k)) || env.CLAUDE_CONFIG_DIR !== `<tmp>/data/claude-usage/${ACCOUNT_ID}`) {
              problems.push(`${label} ${route} ${which}: 認証の値が想定と違う（oauth=${Object.keys(env).filter(k => /OAUTH/i.test(k)).join('+') || 'なし'} config=${env.CLAUDE_CONFIG_DIR}）`);
            }
          }
          if (a.proc.env.ENABLE_CLAUDEAI_MCP_SERVERS !== 'false' || 'ENABLE_CLAUDEAI_MCP_SERVERS' in b.proc.env) problems.push(`${label} ${route}: オフだけ ENABLE_CLAUDEAI_MCP_SERVERS=false になっていない`);
          if (JSON.stringify(stripEnv(a.proc, ALLOWED).env) !== JSON.stringify(stripEnv(b.proc, ALLOWED).env)) problems.push(`${label} ${route}: ENABLE_CLAUDEAI_MCP_SERVERS 以外の env が違う`);
        }
      }
      t.ok(`登録したアカウントの起動の記録: ${labels.length} 組み合わせ × 経路で、オン・オフとも専用フォルダ（トークンなし）。差はオフの ENABLE_CLAUDEAI_MCP_SERVERS=false だけで、argv・cwd・ほかの env・SDK の options・保持役への変換・使用量・互換接続は同じ`,
        problems.length === 0, problems.slice(0, 6).join(' | '));
      const noCompat = Object.fromEntries([...Object.entries(on), ...Object.entries(off)].filter(([l]) => !l.endsWith('/compat')).map(([l, r]) => [l, { runTurn: r.runTurn, internalTurn: r.internalTurn, suggestTitle: r.suggestTitle, modelList: r.modelList, connectorList: r.connectorList }]));
      t.ok('登録したアカウントの会話・内部の会話・題・モデルの一覧・コネクターの一覧の記録に、親のトークンが残らない（更新用トークン・メール・組織も出ない）',
        !JSON.stringify(noCompat).includes(FAKE.registered) && !JSON.stringify(noCompat).includes(FAKE.parentOauth) && leaked(JSON.stringify(noCompat)).length === 0, leaked(JSON.stringify(noCompat)).join(','));
      t.ok('設定の反映は 会話・内部の会話・題・モデルの一覧・コネクターの一覧の 5 経路 × 互換でない 5 組み合わせで 1 回ずつ（互換接続は準備しない）。オン・オフ同じ',
        log.on.length === 5 * 5 && log.off.length === 5 * 5, `on=${log.on.length} off=${log.off.length}`);
    }

    // ---------------------------------------------------------------- 4b. 起動の直前に認証が使えなくなったら、起動しない（会話用に登録したトークンへ戻らない）
    if (!canLink) t.skip('起動の直前に認証が使えなくなったときの記録（Windows でファイルのシンボリックリンクを作る権限が無い）');
    else {
      const labels = ['plain/registered/none'];
      const variants = {
        'ログインが消えた（ownDirLogin）': () => 'missing',
      };
      for (const [variant, loginState] of Object.entries(variants)) {
        let present = 'present';
        const rec = await recordAll({
          root: REPO, only: labels, dumpName: 'auth-fail',
          onSetup: async ({ data }) => {
            await fs.writeFile(path.join(data, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: true } } }));
            await fs.mkdir(path.join(data, 'claude-usage', ACCOUNT_ID), { recursive: true });
          },
          accountFor: async (accounts, id, { data, platform }) => {
            const account = await createClaudeConnectorsWiring({
              dataDir: data,
              accounts: { usageDir: i => path.join(data, 'claude-usage', i), hasUsageLogin: async () => true, resolve: (i, o) => accounts.resolve(i, o) },
              versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
              project: async () => ({ changed: false }),
              loginPresent: async () => present, managedFiles: [], env: {}, home: path.join(data, 'home'), platform,
            }).resolve(id);
            present = loginState();   // 入口を通った「あと」に使えなくなる（起動の直前の準備で気づく）
            return account;
          },
        });
        const r = rec['plain/registered/none'];
        const launched = ['runTurn', 'internalTurn', 'suggestTitle'].filter(route => r?.[route]?.proc || r?.[route]?.sdk?.length);
        t.ok(`認証が起動の直前に使えなくなったら（${variant}）: 会話・内部の会話・題は起動しない（子プロセスも SDK も 0 回）。会話用に登録したトークンへ戻らない`,
          !!r && launched.length === 0 && ![r.runTurn, r.internalTurn, r.suggestTitle].some(x => JSON.stringify(x).includes(FAKE.registered)), `launched=${launched.join(',') || 'なし'}`);
      }
    }

    // ---------------------------------------------------------------- 5. 入口の設定（オン・オフの読み方）とキャッシュのキー
    {
      const text = { unset: null, off: JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: false } } }), other: JSON.stringify({ version: 1, accounts: { 'acct-other000001': { enabled: true } } }), broken: '{ "accounts": ',
        unknownVersion: JSON.stringify({ version: 2, accounts: { [ACCOUNT_ID]: { enabled: true } } }), unknownValue: JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: 'true' } } }),
        unknownShape: JSON.stringify({ version: 1, accounts: [{ id: ACCOUNT_ID, enabled: true }] }),
        // b1 の時代の mode だけが残った設定（enabled が無い）もオフ。mode: b1 でも enabled: false ならオフ
        legacy: JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: false, mode: 'b1' } } }) };
      const wrong = [];
      for (const [variant, body] of Object.entries(text)) {
        const data = path.join(tmp, `off-${variant}`); await fs.mkdir(data, { recursive: true });
        if (body !== null) await fs.writeFile(path.join(data, CONNECTORS_FILE), body);
        const before = (await fs.readdir(data)).sort().join();
        const read = await createClaudeConnectorSettings({ dataDir: data }).read(ACCOUNT_ID);
        if (JSON.stringify(read) !== '{"enabled":false}' || before !== (await fs.readdir(data)).sort().join()) wrong.push(`${variant}=${JSON.stringify(read)}`);
      }
      t.ok('入口の設定: 未設定・オフ・別アカウントだけオン・壊れた設定・知らない版・知らない値・知らない形・b1 の印だけ残ったものはオフと読み、ファイルを作らない・書かない', wrong.length === 0, wrong.join(' | '));
      // 保存済みの mode（b1 の時代の印）は読まない: enabled: true なら mode が何でもオン
      const modeData = path.join(tmp, 'off-mode'); await fs.mkdir(modeData, { recursive: true });
      await fs.writeFile(path.join(modeData, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: true, mode: 'b1' } } }));
      const modeSettings = createClaudeConnectorSettings({ dataDir: modeData });
      const read = await modeSettings.read(ACCOUNT_ID);
      await modeSettings.setEnabled(ACCOUNT_ID, true);
      const written = JSON.parse(await fs.readFile(path.join(modeData, CONNECTORS_FILE), 'utf8'));
      t.ok('入口の設定: 保存済みの mode は読まない（enabled だけでオン）・書き直すときに mode を捨てる',
        JSON.stringify(read) === '{"enabled":true}' && JSON.stringify(written.accounts[ACCOUNT_ID]) === '{"enabled":true}', JSON.stringify({ read, written }));
      t.ok('キャッシュのキー: コネクターのオン・オフで変わらない（account:<id>。一覧は同じ専用フォルダのログインで引く。ADR 0352）',
        accountScopeKeyForTest({ id: ACCOUNT_ID, connectors: { identity: OWN_DIR } }) === `account:${ACCOUNT_ID}`
        && accountScopeKeyForTest({ id: ACCOUNT_ID }) === `account:${ACCOUNT_ID}` && accountScopeKeyForTest(null) === 'login');
    }

    // ---------------------------------------------------------------- 6. server の配線（createClaudeConnectorsWiring）
    {
      const data = path.join(tmp, 'wiring');
      const resolves = [];
      const accounts = {
        usageDir: i => path.join(data, 'claude-usage', i), hasUsageLogin: async () => true,
        resolve: async (id, ...rest) => { resolves.push({ id, rest: rest.length }); return { id, name: 'fake-account' }; },
      };
      const wiring = (settings, over = {}) => createClaudeConnectorsWiring({
        dataDir: data, accounts, settings,
        versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
        project: async () => ({ changed: false }), loginPresent: async () => 'present', managedFiles: [], env: {}, home: path.join(tmp, 'wiring-home'), platform: 'linux', ...over,
      });
      await fs.mkdir(path.join(data, 'claude-usage', ACCOUNT_ID), { recursive: true });
      const on = wiring({ read: async () => ({ enabled: true }) });
      const offW = wiring({ read: async () => ({ enabled: false }) });
      resolves.length = 0;
      const onAccount = await on.resolve(ACCOUNT_ID);
      t.ok('配線: オンの会話は、登録（id・名前だけ）を認証側に通し、専用フォルダの認証を ownDir と connectors に置く（トークンは無い）',
        resolves.length === 1 && resolves[0].rest === 0 && onAccount.ownDir?.identity === OWN_DIR && onAccount.connectors === onAccount.ownDir && onAccount.token === undefined, JSON.stringify(resolves));
      resolves.length = 0;
      const offAccount = await offW.resolve(ACCOUNT_ID);
      t.ok('配線: オフも同じ認証側を通る（専用フォルダの ownDir あり・connectors なし・トークンなし。ADR 0352）',
        resolves.length === 1 && offAccount.ownDir?.identity === OWN_DIR && offAccount.ownDir.enabled === false && !offAccount.connectors && offAccount.token === undefined);
      const authSrc = await fs.readFile(path.join(REPO, 'core/claude-connectors-auth.mjs'), 'utf8');
      const code = authSrc.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      t.ok('認証側はトークンを渡さない・更新しない・ネットワークを使わない・期限の時計（タイマー・再起動）を持たない',
        !/refreshToken|accessToken|expiresAt|scheduleExpiry|onExpiryReached/.test(code)
        && !/\bfetch\(|oauth\/token|createConnection|node:net|node:http/.test(code)
        && !/CLAUDE_CODE_OAUTH_TOKEN\s*:/.test(code) && !/setInterval/.test(code), '');
    }

    // ---------------------------------------------------------------- 7. 設定 › 外部 MCP のコネクターの一覧（connectorListProbe・probeClaudeConnectors）
    {
      const calls = [];
      const probe = async args => { calls.push(args); return ['fake-connector']; };
      const connectors = { identity: OWN_DIR, prepare: async () => ({ env: { CLAUDE_CONFIG_DIR: 'FAKE_OWN' } }) };
      const run = (resolve, deny = []) => connectorListProbe({ defaultId: async () => ACCOUNT_ID, resolve, probe })({ deny });
      const got = await run(async () => ({ id: ACCOUNT_ID, name: 'fake-account', ownDir: connectors, connectors }), ['deny-me']);
      t.ok('一覧: 登録したアカウントは ownDir（会話と同じ組み立て）を connectors として probe に渡す',
        got[0] === 'fake-connector' && calls.length === 1 && calls[0].connectors === connectors && Object.keys(calls[0]).sort().join() === 'connectors,deny' && calls[0].deny[0] === 'deny-me');
      calls.length = 0;
      const offAuth = { ...connectors, enabled: false };
      await run(async () => ({ id: ACCOUNT_ID, name: 'fake-account', ownDir: offAuth }));
      t.ok('一覧: コネクターがオフのアカウントも ownDir を渡す（claude.ai のコネクターは出ない組み立て）', calls.length === 1 && calls[0].connectors === offAuth);
      const kinds = ['login', 'version', 'platform', 'ssh', 'keychain', 'keychainAuth', 'ownDirLogin', 'ownDirLinks', 'ownDirLinksWindows', 'ownDirProfile'];
      let bad = '';
      for (const kind of kinds) {
        calls.length = 0;
        const stop = new ConnectorsAuthError(kind, { name: 'fake-account' });
        const error = await run(async () => { throw stop; }).then(() => null, e => e);
        if (error !== stop || calls.length) { bad = `${kind}: ${error?.code} calls=${calls.length}`; break; }
      }
      t.ok(`一覧: 止める条件 ${kinds.length} 種（ConnectorsAuthError）はそのまま投げ、ログイン中のアカウントで読み直さない（probe を呼ばない）`, bad === '', bad);
      calls.length = 0;
      await run(async () => { throw new Error('アカウントが無い'); });
      await run(async () => null);
      t.ok('一覧: ほかの失敗・既定なしはログイン中のアカウントで読む（{ deny } だけ）',
        calls.length === 2 && calls.every(c => Object.keys(c).join() === 'deny'), JSON.stringify(calls.map(c => Object.keys(c))));
      // オンの解決の想定外の例外（使用量の設定フォルダを引けない・ログインの有無を調べられない）も、入口（wiring）を通した一覧で
      // ConnectorsAuthError になり、ログイン中のアカウントで読み直さない（probe を呼ばない）
      const listData = path.join(tmp, 'list-wiring');
      for (const [label, accountsOver, over, code] of [
        ['使用量の設定フォルダを引けない', { usageDir: () => { throw new Error(`usageDir ${ACCESS}`); } }, {}, 'connectors-login'],
        ['ログインの有無を調べるのが例外', {}, { loginPresent: async () => { throw new Error(`present ${ACCESS}`); } }, 'connectors-login'],
        ['ログインが無い', {}, { loginPresent: async () => 'missing' }, 'connectors-ownDirLogin'],
      ]) {
        calls.length = 0;
        const w = createClaudeConnectorsWiring({
          dataDir: listData,
          accounts: { usageDir: i => path.join(listData, 'claude-usage', i), hasUsageLogin: async () => true, resolve: async id => ({ id, name: 'fake-account' }), ...accountsOver },
          settings: { read: async () => ({ enabled: true }) },
          versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
          project: async () => ({ changed: false }), loginPresent: async () => 'present', managedFiles: [], env: {}, home: path.join(tmp, 'list-wiring-home'), platform: 'linux', ...over,
        });
        await fs.mkdir(path.join(listData, 'claude-usage', ACCOUNT_ID), { recursive: true });
        const error = await run(id => w.resolve(id)).then(() => null, e => e);
        t.ok(`一覧: オンの解決の失敗（${label}）も止める条件にして投げ、ログイン中のアカウントで読み直さない・文面に秘密なし`,
          error instanceof ConnectorsAuthError && error.code === code && calls.length === 0 && leaked(error.message).length === 0, `${error?.code} calls=${calls.length}`);
      }
      // probeClaudeConnectors: オンは prepare() の env（専用フォルダ）で起こし、起こした後の失敗の文面からトークンを伏せる。prepare() が投げれば CLI を起こさない
      const savedBin = process.env.AGENT_HOST_CLAUDE_BIN;
      const { installFakeClaude } = await import('../lib/fake-claude.mjs');
      const installed = await installFakeClaude(path.join(tmp, 'probe-bin'));
      const seen = [];
      const { setClaudeSdkForTest } = await import('../../core/backends/claude.mjs');
      const restoreSdk = setClaudeSdkForTest({ query: ({ options }) => { seen.push(options.env); throw Object.assign(new Error('boom'), { code: 'E_FAKE' }); } });
      process.env.AGENT_HOST_CLAUDE_BIN = installed.bin;
      const parentKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
      const savedParent = Object.fromEntries(parentKeys.map(k => [k, process.env[k]]));
      process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE.parentOauth; process.env.ANTHROPIC_API_KEY = FAKE.apiKey;
      try {
        const { probeClaudeConnectors } = await import('../../core/backends/claude.mjs');
        const e1 = await probeClaudeConnectors({ deny: [], connectors: { identity: OWN_DIR, prepare: async () => ({ env: { CLAUDE_CONFIG_DIR: 'FAKE_OWN' } }) } }).then(() => null, e => e);
        t.ok('一覧の読み取り（オン）: prepare() の専用フォルダだけで CLI を起こし（親のトークン・別の認証は渡さない）、失敗の code は残す',
          seen.length === 1 && seen[0].CLAUDE_CONFIG_DIR === 'FAKE_OWN' && !('CLAUDE_CODE_OAUTH_TOKEN' in seen[0]) && !('ANTHROPIC_API_KEY' in seen[0]) && !('CLAUDE_CODE_OAUTH_SCOPES' in seen[0])
          && e1?.code === 'E_FAKE' && leaked(e1.message).length === 0 && !String(e1.stack).includes(ACCESS) && !e1.message.includes(FAKE.parentOauth), `${e1?.code} seen=${seen.length} ${JSON.stringify(Object.keys(seen[0] ?? {}).filter(k => /OAUTH|API_KEY|CONFIG/.test(k)))}`);
        seen.length = 0;
        const e2 = await probeClaudeConnectors({ deny: [], connectors: { identity: OWN_DIR, prepare: async () => { throw new ConnectorsAuthError('ownDirLogin', { name: 'fake-account' }); } } }).then(() => null, e => e);
        t.ok('一覧の読み取り（オン）: prepare() が止めれば CLI を起こさない（ログイン中のアカウントでも読まない）', e2?.code === 'connectors-ownDirLogin' && seen.length === 0);
      } finally {
        restoreSdk();
        if (savedBin === undefined) delete process.env.AGENT_HOST_CLAUDE_BIN; else process.env.AGENT_HOST_CLAUDE_BIN = savedBin;
        for (const k of parentKeys) { if (savedParent[k] === undefined) delete process.env[k]; else process.env[k] = savedParent[k]; }
      }
    }

    // ---------------------------------------------------------------- 8. 付け直し（adoptTurn）と一覧の覚えの消し方
    {
      const saved = claudeBackend.adoptTurn;
      const seen = [];
      claudeBackend.adoptTurn = async args => { seen.push(args); return 'adopted'; };
      try {
        const prepareCalls = [];
        const connectors = { identity: OWN_DIR, prepare: async o => { prepareCalls.push(o); return { env: { CLAUDE_CONFIG_DIR: 'FAKE_OWN' } }; } };
        // 登録したアカウントは入口（配線）が専用フォルダの認証（ownDir）を付けて作る。トークンは持たない（ADR 0352）
        const on = { id: ACCOUNT_ID, name: 'fake-account', ownDir: connectors, connectors };
        const args = { cwd: path.join(tmp, 'work'), card: { held: true }, source: { write() {} } };
        const r = await claudeBackend.forAccount(on).adoptTurn(args);
        t.ok('付け直し: オンのアカウントは起動の直前に prepare()（リンク・設定の反映）を通り、トークンは渡さず専用フォルダの env を渡す',
          r === 'adopted' && prepareCalls.length === 1 && prepareCalls[0].cwd === args.cwd && seen.length === 1 && !seen[0].oauthToken
          && JSON.stringify(seen[0].connectorsEnv) === JSON.stringify({ CLAUDE_CONFIG_DIR: 'FAKE_OWN' }) && seen[0].connectors === connectors && seen[0].card === args.card && seen[0].source === args.source, JSON.stringify({ prepare: prepareCalls.length, seen: seen.length }));
        seen.length = 0;
        const failingAuth = { identity: OWN_DIR, prepare: async () => { throw new ConnectorsAuthError('ownDirLogin', { name: 'fake-account' }); } };
        const failing = { ...on, ownDir: failingAuth, connectors: failingAuth };
        const e = await claudeBackend.forAccount(failing).adoptTurn(args).then(() => null, x => x);
        t.ok('付け直し: prepare() が止めれば付け直さない（会話用トークンへ戻らない）', e?.code === 'connectors-ownDirLogin' && seen.length === 0);
        seen.length = 0;
        await claudeBackend.forAccount({ ...on, endpoint: null }).adoptTurn({ ...args, endpoint: { baseUrl: 'https://compat.example.invalid' } });
        const offAuth = { identity: OWN_DIR, enabled: false, prepare: async () => ({ env: { CLAUDE_CONFIG_DIR: 'FAKE_OWN', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } }) };
        await claudeBackend.forAccount({ id: ACCOUNT_ID, name: 'fake-account', ownDir: offAuth }).adoptTurn(args);
        t.ok('付け直し: 互換の接続先は専用フォルダの認証を足さない・コネクターがオフのアカウントも専用フォルダの env（claude.ai のコネクターを出さない）で付け直す',
          seen.length === 2 && prepareCalls.length === 1 && !('connectorsEnv' in seen[0]) && !seen[0].oauthToken && !seen[1].oauthToken
          && JSON.stringify(seen[1].connectorsEnv) === JSON.stringify({ CLAUDE_CONFIG_DIR: 'FAKE_OWN', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }), JSON.stringify(seen.map(s => Object.keys(s))));
      } finally { claudeBackend.adoptTurn = saved; }
      const near = `${ACCOUNT_ID}2`;   // 先頭が同じ別のアカウント（消さない）
      const touched = [{ id: ACCOUNT_ID }, { id: ACCOUNT_ID, connectors: { identity: OWN_DIR } }, { id: near }];
      const before = catalogStateKeysForTest(touched);
      claudeBackend.invalidateModels(ACCOUNT_ID);
      const after = catalogStateKeysForTest();
      t.ok('一覧の覚え: アカウントを消す・入れ替えると、そのアカウントのキー（オン・オフ共通）を消す。先頭が同じ別のアカウントは残す',
        before.includes(`account:${ACCOUNT_ID}`) && !after.includes(`account:${ACCOUNT_ID}`) && after.includes(`account:${near}`), after.join(','));
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
      // 入口: 解決のとき（版・ログインの確認のあと）と起動の直前（prepare）の両方で止める。メッセージに値を出さない
      const home = path.join(tmp, 'settings-home'); const shared = path.join(home, '.claude');
      const usageRoot = path.join(tmp, 'settings-usage'); await fs.mkdir(path.join(usageRoot, ACCOUNT_ID), { recursive: true });
      await fs.mkdir(shared, { recursive: true });
      const sfile = path.join(shared, 'settings.json');
      const make = () => createClaudeConnectorsAuth({
        accounts: { usageDir: i => path.join(usageRoot, i), hasUsageLogin: async () => true },
        versions: async () => ({ cli: VERIFIED_VERSIONS[0].cli, sdk: VERIFIED_VERSIONS[0].sdk }),
        project: async () => ({ changed: false }), loginPresent: async () => 'present', managedFiles: [], env: {}, home, platform: 'linux',
      });
      const account = { id: ACCOUNT_ID, name: 'fake-account' };
      const stopsAt = [];
      for (const [label, body, code] of [['env の ANTHROPIC_API_KEY', JSON.stringify({ env: { ANTHROPIC_API_KEY: SETTING_SECRET } }), 'connectors-env'],
        ['apiKeyHelper', JSON.stringify({ apiKeyHelper: `echo ${SETTING_SECRET}` }), 'connectors-env'],
        ['壊れている', `{ "apiKeyHelper": "${SETTING_SECRET}`, 'connectors-env'],
        ['履歴の置き場', JSON.stringify({ env: { CLAUDE_CODE_PROJECT_DIR_NAME: SETTING_SECRET } }), 'connectors-history']]) {
        await fs.writeFile(sfile, body);
        const e = await make()(account).then(() => null, x => x);
        if (e?.code !== code || e.message.includes(SETTING_SECRET) || leaked(e.message).length) stopsAt.push(`${label}: ${e?.code}`);
      }
      t.ok('settings.json の確かめ: 別の認証（env・apiKeyHelper）・読めない設定・履歴の置き場は、解決のときに止める。メッセージに値を出さない', stopsAt.length === 0, stopsAt.join(' | '));
      await fs.writeFile(sfile, JSON.stringify({ env: { FOO: 'bar' } }));
      const resolved = (await make()(account)).account;
      t.ok('settings.json の確かめ: 関係の無い env だけなら通る', resolved.ownDir?.identity === OWN_DIR);
      if (canLink) {
        await fs.writeFile(sfile, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SETTING_SECRET } }));
        const late = await resolved.ownDir.prepare({ cwd: tmp }).then(() => null, x => x);
        t.ok('settings.json の確かめ: 解決のあとに別の認証が書かれても、起動の直前（prepare）で止める。メッセージに値を出さない', late?.code === 'connectors-env' && !late.message.includes(SETTING_SECRET) && leaked(late.message).length === 0, `late=${late?.code}`);
      } else t.skip('settings.json の確かめ: 起動の直前（prepare）の止め方（Windows でファイルのシンボリックリンクを作る権限が無い）');
      // 401 で乗り換える道を開く指定（ADR 0340）: settings.json の env にあっても（小文字の名前でも）env で止める
      const switchBad = [];
      for (const name of SWITCH_ON_401) {
        for (const key of [name, name.toLowerCase()]) {
          await fs.writeFile(file, JSON.stringify({ env: { [key]: SWITCH_VALUE } }));
          const got = await settingsOverrides(dir);
          if (JSON.stringify(got) !== JSON.stringify({ auth: [name], history: [] })) switchBad.push(`overrides ${key}: ${JSON.stringify(got)}`);
          await fs.writeFile(sfile, JSON.stringify({ env: { [key]: SWITCH_VALUE } }));
          const e = await make()(account).then(() => null, x => x);
          if (e?.code !== 'connectors-env' || !e.message.includes(name) || e.message.includes(SWITCH_VALUE) || leaked(e.message).length) switchBad.push(`resolve ${key}: ${e?.code}`);
        }
      }
      t.ok('settings.json の確かめ: 401 で乗り換える道を開く 7 つの指定（大文字小文字を問わない）は、解決のときに env で止める。メッセージに値を出さない',
        switchBad.length === 0, switchBad.slice(0, 3).join(' | '));
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
