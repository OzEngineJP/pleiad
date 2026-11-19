// サーバー通し: 設定 › 外部 MCP のコネクターの一覧を、新しい会話の既定の Claude アカウントで読む（ADR 0327・0340 段 2）。
// 偽の CLI（AGENT_HOST_CLAUDE_BIN）・偽の API・偽の値だけ。本物の CLI・本物の資格情報・ホーム直下の .claude.json は使わない（CLAUDE_CONFIG_DIR は一時フォルダ）。
// server の accountResolve → 入口（gate）→ 認証側の組み立て（createClaudeConnectorsWiring）→ connectorListProbe → probeClaudeConnectors を本物の配線で通す。
//   1. オフ（入口の設定なし）: 今までどおり会話用に登録したトークンで読み、覚えの一覧を書く（main と同じ）
//   2. オンで止める条件に当たる（使用量のログインが無い）: ログイン中のアカウントで読み直さない（一覧のための CLI を起こさない）・覚えの一覧を書かない
//   3. オンで使える: 会話と同じ組み立て（アクセス用トークン・権限の並び・共有の設定フォルダの 3 つ）で読み、覚えの一覧を書く
//   段 3（2026-11-19）: オンのアカウントのコネクターは上の表に並べず、「claude.ai のコネクター（アカウントごと）」の行で読む（accounts.refreshConnectors）。
//   覚えはアカウントごとの覚え（CONNECTORS_CACHE_FILE。名前と要認可だけ）に書き、ログイン中の覚え（claude-connectors.json）は書かない
//   4. 段 3 のスイッチ（accounts.setConnectors。人だけ）: 止める条件に当たれば入れない（設定を書かない）・使えれば入れる・切れる。
//      オンで止める条件に当たった会話は、CLI を起こさず発言を「送れませんでした」に戻し、止めた理由（connectorsError）と直す入口（auth.mode connectorsLogin）を渡す
// 一覧の読み取りは 5 分覚える（読めた後は起こさない）ので、オフとオンは別のサーバー・別のデータ置き場で確かめる
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';
import { CONNECTORS_FILE, CONNECTORS_CACHE_FILE } from '../../core/claude-connectors.mjs';
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
  const probeLog = path.join(scratch, 'fake-claude-probe.log');
  await Promise.all([data, claudeConfig, work].map(d => fs.mkdir(d, { recursive: true })));
  await fs.writeFile(modelsFile, JSON.stringify({ labels: { [TOK_REG]: 'registered', [ACCESS]: 'access' }, accounts: { [ACCESS]: { organization: ORG, email: EMAIL } } }));
  const cli = await installFakeClaude(path.join(scratch, 'cli'));
  const api = await startFakeAnthropicApi({ [TOK_REG]: ORG });
  const server = await startServer({
    dataDir: data,
    env: {
      AGENT_HOST_BACKENDS: 'claude,fake', ...cli.env, ...QUIET_ENV,
      CLAUDE_CONFIG_DIR: claudeConfig, AGENT_HOST_ANTHROPIC_API: api.url,
      FAKE_CLAUDE_VERSION: VERIFIED_VERSIONS[0].cli, FAKE_CLAUDE_MODELS_FILE: modelsFile, FAKE_CLAUDE_ENV_LOG: envLog, FAKE_CLAUDE_PROBE_LOG: probeLog,
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
    // 行の読み直し（設定 › 外部 MCP の［読み直す］。人だけの操作）。読み終えるまで待つ
    const refreshRow = () => c.cmd('invoke', { op: 'accounts.refreshConnectors', args: { id, cwd: work } });
    const accountCache = path.join(data, CONNECTORS_CACHE_FILE);
    return { c, id, data, work, status, credFile, claudeConfig, envLines, savedList, read, enable, refreshRow, accountCache, probeLog, close };
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
      const failRow = await s.refreshRow();
      t.ok('オン・止める条件（ログインが無い）: 一覧のための CLI を起こさない（ログイン中のアカウントでも会話用トークンでも読み直さない）・覚えの一覧を書かない・行は止める理由つき',
        fail.state === 'none' && failRow?.status === 'blocked' && failRow?.blockKind === 'login' && failRow?.connectors === null
          && s.envLines().length === 0 && !fss.existsSync(s.savedList) && !fss.existsSync(s.accountCache),
        JSON.stringify({ fail, row: failRow && { status: failRow.status, kind: failRow.blockKind }, lines: s.envLines(), saved: fss.existsSync(s.savedList) }));
      await fs.writeFile(s.credFile, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 8 * 3600_000, scopes: SCOPES } }));
      const row = await s.refreshRow();
      const lines = s.envLines();
      t.ok('オン・使える: 会話と同じ組み立て — アクセス用トークン・権限の並び・共有の設定フォルダの 3 つで 1 回読み、アカウントごとの覚えに書く（ログイン中の覚えは書かない）',
        row?.status === 'ok' && Array.isArray(row?.connectors) && lines.length === 3 && lines.every(line => line.who === 'access' && line.scopes === SCOPES.join(' '))
          && lines[0].configDir !== s.claudeConfig && lines.slice(1).every(line => line.configDir === s.claudeConfig) && fss.existsSync(s.accountCache) && !fss.existsSync(s.savedList),
        JSON.stringify({ row: row && { status: row.status, n: row.connectors?.length }, lines, cache: fss.existsSync(s.accountCache), saved: fss.existsSync(s.savedList) }));
      const cacheText = fss.readFileSync(s.accountCache, 'utf8');
      t.ok('アカウントごとの覚えにトークン・メール・組織の id を書かない', ![ACCESS, REFRESH, TOK_REG, EMAIL, ORG].some(x => cacheText.includes(x)));
      const after = await s.read();
      t.ok('オン: 上の表（エージェントの設定）のためには読まない（CLI を足さない）', after.state === 'none' && s.envLines().length === 3, JSON.stringify({ after, n: s.envLines().length }));

      // 4. 段 3: スイッチと、送る前に止まった発言
      const { c } = s;
      const file = path.join(s.data, CONNECTORS_FILE);
      const enabledInFile = () => { try { return JSON.parse(fss.readFileSync(file, 'utf8')).accounts?.[s.id]?.enabled === true; } catch { return false; } };
      const setSwitch = enabled => c.cmd('invoke', { op: 'accounts.setConnectors', args: { id: s.id, enabled, cwd: s.work } });
      const offRow = await setSwitch(false);
      t.ok('スイッチ: 切ると設定に off を書き、行は enabled: false', offRow?.enabled === false && !enabledInFile(), JSON.stringify({ enabled: offRow?.enabled }));
      const credText = fss.readFileSync(s.credFile, 'utf8');
      await fs.rm(s.credFile);
      const refused = await setSwitch(true).then(() => null, e => e);
      t.ok('スイッチ: 止める条件（ログインが無い）に当たれば入れない（確かめる画面は出さず、理由を返す）・設定は off のまま',
        refused instanceof Error && !enabledInFile() && ![ACCESS, REFRESH, TOK_REG, EMAIL, ORG].some(x => String(refused.message).includes(x)), String(refused?.message));
      await fs.writeFile(s.credFile, credText);
      const onRow = await setSwitch(true);
      t.ok('スイッチ: 使えれば押すだけで入る（設定に on を書く）', onRow?.enabled === true && onRow?.status === 'ok' && enabledInFile(), JSON.stringify({ enabled: onRow?.enabled, status: onRow?.status }));
      const listed = (await c.cmd('claudeAccounts')).accounts.find(a => a.id === s.id);
      t.ok('アカウントの一覧: オンのアカウントにだけコネクターの状態（件数・要認可）を添える・秘密を出さない',
        listed?.connectors?.enabled === true && listed.connectors.status === 'ok' && ![ACCESS, REFRESH, TOK_REG, EMAIL, ORG].some(x => JSON.stringify(listed.connectors).includes(x)),
        JSON.stringify(listed?.connectors));

      // 段 4: 画面の会話・委譲・bot は同じアカウントの認証を使う（CLI と API だけ偽物）。
      const until = async fn => {
        for (let i = 0; i < 600; i++) { const value = await fn(); if (value) return value; await sleep(100); }
        throw new Error('connector routing timeout');
      };
      const launches = () => fss.existsSync(s.probeLog) ? fss.readFileSync(s.probeLog, 'utf8').trim().split('\n') : [];
      const onlyAccessSince = before => launches().length > before && launches().slice(before).every(who => who === 'access');
      let start = launches().length;
      const directSession = await c.cmd('newSession', { backend: 'claude', cwd: s.work });
      await c.cmd('setTurnSettings', { sessionId: directSession.sessionId, account: s.id });
      const direct = await c.runTurn({ sessionId: directSession.sessionId, prompt: 'hello' });
      t.ok('段4: headless サーバーの会話は使用量ログインの認証で起動する', direct.outcome === 'ok' && onlyAccessSince(start), JSON.stringify({ outcome: direct.outcome, launches: launches().slice(start) }));
      start = launches().length;
      const parent = await c.runTurn({ backend: 'fake', cwd: s.work, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'claude', account: s.id, task: 'hello' } }) });
      const made = JSON.parse(parent.events.find(e => e.type === 'tool.result').text);
      const task = await until(async () => (await c.cmd('agentTasks')).find(r => r.taskId === made.taskId && ['completed', 'failed', 'cancelled'].includes(r.status)));
      const child = (await c.cmd('listSessions')).find(r => r.id === made.sessionId);
      t.ok('段4: 委譲の子はオンのアカウントを保ち、会話用トークン・ログイン中へ戻らない', task.status === 'completed' && child?.claudeAccount === s.id && onlyAccessSince(start));
      const op = (op, args) => c.cmd('invoke', { op, args });
      const bot = await op('bots.create', { name: 'ConnectorCheck', backend: 'claude' });
      await op('bots.setAccount', { botId: bot.id, account: s.id });
      start = launches().length;
      await op('channels.post', { channelId: bot.dmChannelId, text: 'hello' });
      const botSession = await until(async () => (await op('bots.get', { botId: bot.id })).dmSessionId);
      await until(async () => (await op('channels.read', { channelId: bot.dmChannelId })).posts.some(p => p.author?.botId === bot.id && p.state === 'done'));
      const botRow = (await c.cmd('listSessions')).find(r => r.id === botSession);
      t.ok('段4: bot の会話もオンのアカウントの認証を使う', botRow?.claudeAccount === s.id && onlyAccessSince(start));

      // オンのまま止める条件に当たる会話
      await fs.rm(s.credFile);
      const before = s.envLines().length;
      const { sessionId } = await c.cmd('newSession', { backend: 'claude', cwd: s.work });
      const from = c.mark();
      const messageId = 'cn-stop-0001';
      void c.cmd('sendMessage', { sessionId, messageId, prompt: 'hello' }).catch(() => {});
      const failed = await c.waitFor(e => e.type === 'outbox' && e.sessionId === sessionId && e.messages?.some(m => m.id === messageId && m.status === 'failed'), { from, ms: 60000 })
        .then(e => e.messages.find(m => m.id === messageId), () => null);
      // 起動の前（ターンを作る前）に止まるので、知らせは送信待ちの行だけ（画面は発言の下に直す入口を出す）。ターンの途中で止まった
      // ときの失敗の知らせ（turnResult）は、出るなら直す入口と渡っていない印を持つ
      const results = c.since(from).filter(e => e.type === 'turnResult' && e.sessionId === sessionId && e.outcome === 'error');
      t.ok('止める条件の会話: 発言は送れなかった（failed）に戻り、止めた理由（kind: login・アカウントの id）を持つ',
        failed?.connectorsError?.kind === 'login' && failed.connectorsError.accountId === s.id, JSON.stringify(failed && { status: failed.status, kind: failed.connectorsError?.kind }));
      t.ok('止める条件の会話: 失敗の知らせを出すなら、直す入口（auth.mode connectorsLogin）と渡っていない印（undelivered・messageId）を持つ（黙って落ちない）',
        results.every(r => r.kind === 'auth' && r.auth?.mode === 'connectorsLogin' && r.auth.accountId === s.id && r.undelivered === true && r.messageId === messageId),
        JSON.stringify(results.map(r => ({ kind: r.kind, mode: r.auth?.mode, undelivered: r.undelivered }))));
      t.ok('止める条件の会話: CLI を起こさない（ログイン中・会話用に登録したトークンへ落ちない）', s.envLines().length === before, `${before} → ${s.envLines().length}`);
      const evText = JSON.stringify([failed, results]);
      t.ok('止める条件の会話: 知らせにトークン・メール・組織の id を出さない', ![ACCESS, REFRESH, TOK_REG, EMAIL, ORG].some(x => evText.includes(x)));
      await c.cmd('messageAction', { sessionId, messageId, action: 'cancel' });
      const cancelled = await c.waitFor(e => e.type === 'outbox' && e.sessionId === sessionId && e.messages?.some(m => m.id === messageId && m.status === 'cancelled'), { from, ms: 30000 })
        .then(e => e.messages.find(m => m.id === messageId), () => null);
      t.ok('取り消すと止めた理由も消える', cancelled?.status === 'cancelled' && !cancelled.connectorsError, JSON.stringify(cancelled && { status: cancelled.status, ce: Boolean(cancelled.connectorsError) }));
    } finally { await s.close(); }
  }
}
