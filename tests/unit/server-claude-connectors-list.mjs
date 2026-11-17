// サーバー通し: 設定 › 外部 MCP のコネクターの一覧を、新しい会話の既定の Claude アカウントで読む（ADR 0327・0340 段 2）。
// 偽の CLI（AGENT_HOST_CLAUDE_BIN）・偽の API・偽の値だけ。本物の CLI・本物の資格情報・ホーム直下の .claude.json は使わない（CLAUDE_CONFIG_DIR は一時フォルダ）。
// server の accountResolve → 入口（gate）→ 認証側の組み立て（createClaudeConnectorsWiring）→ connectorListProbe → probeClaudeConnectors を本物の配線で通す。
//   1. オフ（入口の設定なし）: 今までどおり会話用に登録したトークンで読み、覚えの一覧を書く（main と同じ）
//   2. オンで止める条件に当たる（使用量のログインが無い）: ログイン中のアカウントで読み直さない（一覧のための CLI を起こさない）・覚えの一覧を書かない
//   3. オンで使える: 会話と同じ組み立て（アクセス用トークン・権限の並び・共有の設定フォルダの 3 つ）で読み、覚えの一覧を書く
// 一覧の読み取りは 5 分覚える（読めた後は起こさない）ので、オフとオンは別のサーバー・別のデータ置き場で確かめる
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';
import { CONNECTORS_FILE } from '../../core/claude-connectors.mjs';
import { VERIFIED_VERSIONS } from '../../core/claude-connectors-auth.mjs';

export const name = 'server-claude-connectors-list';
export const title = 'サーバー通し: コネクターの一覧の読み取り — オフは main と同じ・オンは会話と同じ組み立て・止める条件ではログイン中へ戻らず覚えを書かない';

// 偽の値（本物ではない）
const TOK_REG = 'sk-ant-oat01-' + 'C'.repeat(40);
const ACCESS = 'fake-access-token-CCCCCCCCCCCCCCCCCCCC-0101';
const REFRESH = 'fake-refresh-token-CCCCCCCCCCCCCCCCCCCC-0102';
const ORG = 'fake-org-cccc-0000-1111';
const EMAIL = 'fake.connectors@example.invalid';
const SCOPES = ['user:inference', 'user:profile', 'user:mcp_servers'];
// 別の認証・履歴の置き場の指定は空にする（実行元の環境に何があっても、止める条件の env に当たらない）
const QUIET_ENV = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_PROJECT_DIR_NAME',
  'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_BG_AUTH_SNAPSHOT_PATH'].map(k => [k, '']));

async function boot(label) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ply-srv-cn-list-${label}-`)));
  const data = path.join(scratch, 'data');
  const claudeConfig = path.join(scratch, 'claude-config');
  const work = path.join(scratch, 'work');
  const modelsFile = path.join(scratch, 'fake-claude-models.json');
  const envLog = path.join(scratch, 'fake-claude-env.log');
  await Promise.all([data, claudeConfig, work].map(d => fs.mkdir(d, { recursive: true })));
  await fs.writeFile(modelsFile, JSON.stringify({ labels: { [TOK_REG]: 'registered', [ACCESS]: 'access' } }));
  const cli = await installFakeClaude(path.join(scratch, 'cli'));
  const api = await startFakeAnthropicApi({ [TOK_REG]: ORG });
  const server = await startServer({
    dataDir: data,
    env: {
      AGENT_HOST_BACKENDS: 'claude,fake', ...cli.env, ...QUIET_ENV,
      CLAUDE_CONFIG_DIR: claudeConfig, AGENT_HOST_ANTHROPIC_API: api.url,
      FAKE_CLAUDE_VERSION: VERIFIED_VERSIONS[0].cli, FAKE_CLAUDE_MODELS_FILE: modelsFile, FAKE_CLAUDE_ENV_LOG: envLog,
    },
  });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const close = async () => {
    try { c.close(); } catch { /* 閉じている */ }
    await server.stop().catch(() => {});
    await api.close().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  };
  try {
    const saved = await c.cmd('saveClaudeAccount', { name: 'cn-fake', token: TOK_REG });
    const id = saved.id;
    const usage = path.join(data, 'claude-usage', id);
    await fs.mkdir(usage, { recursive: true });
    await fs.writeFile(path.join(usage, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL } }));
    await fs.writeFile(path.join(usage, 'ply-usage-login.json'), JSON.stringify({ at: new Date().toISOString() }));
    const credFile = path.join(usage, '.credentials.json');
    await fs.writeFile(credFile, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 8 * 3600_000, scopes: SCOPES } }));
    // 持ち主の確認（偽の API の組織 = 使用量のログインの組織）が済むまで待つ
    let status = null;
    for (let i = 0; i < 200 && status !== 'ok'; i++) {
      status = (await c.cmd('claudeAccounts')).accounts.find(a => a.id === id)?.tokenCheck?.status ?? null;
      if (status !== 'ok') await sleep(50);
    }
    await c.cmd('setPref', { key: 'account', value: id, backend: 'claude' });
    const envLines = () => (fss.existsSync(envLog) ? fss.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    const savedList = path.join(data, 'claude-connectors.json');
    // 読み取りを起こし、読み終わる（reading が消える）まで待つ
    const read = async () => {
      const first = await c.cmd('invoke', { op: 'context.mcpMatrix', args: { cwd: work, refresh: true } });
      let state = first.connectors, saw = state === 'reading';
      for (let i = 0; i < 600 && state === 'reading'; i++) {
        await sleep(50);
        state = (await c.cmd('invoke', { op: 'context.mcpMatrix', args: { cwd: work } })).connectors;
      }
      return { saw, state };
    };
    const enable = on => fs.writeFile(path.join(data, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [id]: { enabled: on } } }));
    return { id, status, credFile, claudeConfig, envLines, savedList, read, enable, close };
  } catch (error) { await close(); throw error; }
}

export default async function (t) {
  // 1. オフ
  {
    const s = await boot('off');
    try {
      const r = await s.read();
      const lines = s.envLines();
      t.ok('準備: 持ち主の確認が済む（偽の API の組織 = 使用量のログインの組織）', s.status === 'ok', String(s.status));
      t.ok('オフ: 一覧は会話用に登録したトークンで 1 回読む（権限の並びは足さない。設定フォルダは親のまま）・覚えの一覧を書く — main と同じ',
        r.saw && lines.length === 1 && lines[0].who === 'registered' && lines[0].scopes === null && lines[0].configDir === s.claudeConfig && fss.existsSync(s.savedList),
        JSON.stringify({ saw: r.saw, lines, saved: fss.existsSync(s.savedList) }));
    } finally { await s.close(); }
  }
  // 2・3. オン
  {
    const s = await boot('on');
    try {
      await s.enable(true);
      await fs.rm(s.credFile);   // 使用量のログインが無い → connectors-login で止まる
      const fail = await s.read();
      t.ok('オン・止める条件（ログインが無い）: 一覧のための CLI を起こさない（ログイン中のアカウントでも会話用トークンでも読み直さない）・覚えの一覧を書かない・読めなかった扱い',
        fail.saw && fail.state === 'none' && s.envLines().length === 0 && !fss.existsSync(s.savedList), JSON.stringify({ fail, lines: s.envLines(), saved: fss.existsSync(s.savedList) }));
      await fs.writeFile(s.credFile, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 8 * 3600_000, scopes: SCOPES } }));
      const ok = await s.read();
      const lines = s.envLines();
      t.ok('オン・使える: 会話と同じ組み立て — アクセス用トークン・権限の並び・共有の設定フォルダの 3 つで 1 回読み、覚えの一覧を書く',
        ok.saw && lines.length === 1 && lines[0].who === 'access' && lines[0].scopes === SCOPES.join(' ') && lines[0].configDir === s.claudeConfig && fss.existsSync(s.savedList),
        JSON.stringify({ ok, lines, saved: fss.existsSync(s.savedList) }));
    } finally { await s.close(); }
  }
}
