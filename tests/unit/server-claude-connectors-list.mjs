// サーバー通し: 設定 › 外部 MCP のコネクターの一覧を、新しい会話の既定の Claude アカウントで読む（ADR 0327・0340 段 2）。
// 偽の CLI（AGENT_HOST_CLAUDE_BIN）・偽の値だけ。本物の CLI・本物の資格情報・ホーム直下の .claude.json は使わない（CLAUDE_CONFIG_DIR は一時フォルダ）。
// server の accountResolve → 入口（gate）→ 認証側の組み立て（createClaudeConnectorsWiring）→ connectorListProbe → probeClaudeConnectors を本物の配線で通す。
//   1. オフ（入口の設定なし）: 同じ専用フォルダで、claude.ai のコネクターを切って（ENABLE_CLAUDEAI_MCP_SERVERS=false）読む。会話用のトークンは無い（ADR 0352）
//   2. オンで止める条件に当たる（使用量のログインが無い）: ログイン中のアカウントで読み直さない（一覧のための CLI を起こさない）・覚えの一覧を書かない
//   3. オンで使える: 会話と同じ組み立て（アクセス用トークン・権限の並び・共有の設定フォルダの 3 つ）で読み、覚えの一覧を書く
//   段 3（2026-11-19）: オンのアカウントのコネクターは上の表に並べず、「claude.ai のコネクター（アカウントごと）」の行で読む（accounts.refreshConnectors）。
//   覚えはアカウントごとの覚え（CONNECTORS_CACHE_FILE。名前と要認可だけ）に書き、ログイン中の覚え（claude-connectors.json）は書かない
//   4. 段 3 のスイッチ（accounts.setConnectors。人だけ）: 止める条件に当たれば入れない（設定を書かない）・使えれば入れる・切れる。
//      オンで止める条件に当たった会話は、CLI を起こさず発言を「送れませんでした」に戻し、止めた理由（connectorsError）と直す入口（auth.mode connectorsLogin）を渡す
//   コネクターは専用フォルダ方式だけ（ADR 0350。方式 b1 は無い）。オンのアカウントの CLI は CLAUDE_CONFIG_DIR だけで起動し、トークン・権限の環境変数を持たない
//   5. 更新のあとの起動（サーバーを止めて起こし直す）: オンの既存のアカウントの専用フォルダを自動で準備し（実体を共有へ移す・名前が重なれば退避する）、一覧の moved に出す
//   macOS: 専用フォルダのログインは本物のキーチェーンにあるので、2・3・4・5 は Windows・Linux で確かめる（偽の security での確かめは tests/unit/claude-own-dir.mjs）。
//      macOS では、オンにしてもログインが無ければ止まり（ownDirLogin・keychain）CLI を起こさないことだけ確かめる
// 一覧の読み取りは 5 分覚える（読めた後は起こさない）ので、オフとオンは別のサーバー・別のデータ置き場で確かめる
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { seedClaudeAccount } from '../lib/claude-account-seed.mjs';
import { CONNECTORS_FILE, CONNECTORS_CACHE_FILE } from '../../core/claude-connectors.mjs';
import { VERIFIED_VERSIONS } from '../../core/claude-connectors-auth.mjs';
import { unlinkClaudeOwnDirLinks } from '../../core/claude-own-dir.mjs';

export const name = 'server-claude-connectors-list';
export const title = 'サーバー通し: コネクターの一覧の読み取り — オフは main と同じ・オンは会話と同じ組み立て・止める条件ではログイン中へ戻らず覚えを書かない';

// 偽の値（本物ではない）
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
  await fs.writeFile(modelsFile, JSON.stringify({ labels: { [ACCESS]: 'access' }, accounts: { [ACCESS]: { organization: ORG, email: EMAIL, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' } } }));
  const cli = await installFakeClaude(path.join(scratch, 'cli'));
  const serverEnv = {
    AGENT_HOST_BACKENDS: 'claude,fake', ...cli.env, ...QUIET_ENV,
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_VERSION: VERIFIED_VERSIONS[0].cli, FAKE_CLAUDE_MODELS_FILE: modelsFile, FAKE_CLAUDE_ENV_LOG: envLog, FAKE_CLAUDE_PROBE_LOG: probeLog,
  };
  let server = await startServer({ dataDir: data, env: serverEnv });
  let c = await open({ port: server.port, token: server.token, autoAllow: true });
  const close = async () => {
    try { c.close(); } catch { /* 閉じている */ }
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  };
  try {
    const id = await seedClaudeAccount(data, 'cn-fake', { oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL } });
    const credFile = path.join(data, 'claude-usage', id, '.credentials.json');
    await fs.writeFile(credFile, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 8 * 3600_000, scopes: SCOPES } }));
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
    const out = { c, id, data, work, credFile, claudeConfig, envLines, savedList, read, enable, refreshRow, accountCache, probeLog, close };
    // 同じデータ置き場でサーバーを止めて起こし直す（更新のあとの起動）。止めたあと・起こす前に beforeStart を走らせる。out.c を新しい接続に替える
    out.restart = async beforeStart => {
      try { c.close(); } catch { /* 閉じている */ }
      await server.stop();
      await beforeStart?.();
      server = await startServer({ dataDir: data, env: serverEnv });
      c = await open({ port: server.port, token: server.token, autoAllow: true });
      out.c = c;
    };
    return out;
  } catch (error) { await close(); throw error; }
}

export default async function (t) {
  // 1. オフ
  {
    const s = await boot('off');
    try {
      const r = await s.read();
      const lines = s.envLines();
      t.ok('オフ: 一覧はアカウントの専用フォルダで、claude.ai のコネクターを切って 1 回読む（トークン・権限の環境変数なし）・覚えの一覧を書く（ADR 0352）',
        r.saw && lines.length === 1 && lines[0].who === 'login' && lines[0].scopes === null && lines[0].configDir === path.dirname(s.credFile)
          && lines[0].claudeAi === 'false' && fss.existsSync(s.savedList),
        JSON.stringify({ saw: r.saw, lines, saved: fss.existsSync(s.savedList) }));
    } finally { await s.close(); }
  }
  // 2・3. オン（macOS はログインが本物のキーチェーンにあるので、止まることだけ確かめる）
  const mac = process.platform === 'darwin';
  if (mac) {
    const s = await boot('on-mac');
    try {
      await s.enable(true);
      const r = await s.read();
      const row = await s.refreshRow();
      t.ok('オン（macOS・ログインが無い）: 止め、一覧のための CLI を起こさない・覚えの一覧を書かない',
        r.state === 'none' && row?.status === 'blocked' && Boolean(row?.blockKind) && row?.connectors === null
          && s.envLines().length === 0 && !fss.existsSync(s.savedList) && !fss.existsSync(s.accountCache),
        JSON.stringify({ r, row: row && { status: row.status, kind: row.blockKind }, lines: s.envLines().length }));
      t.skip('一覧の読み取り・スイッチ・会話の経路（macOS は本物のキーチェーンを見るため。Windows・Linux で確かめる。偽の security での確かめは claude-own-dir）');
    } finally { await s.close(); }
  } else {
    const s = await boot('on');
    try {
      await s.enable(true);
      await fs.rm(s.credFile);   // 専用フォルダのログインが無い → ownDirLogin で止まる
      const fail = await s.read();
      const failRow = await s.refreshRow();
      t.ok('オン・止める条件（ログインが無い）: 一覧のための CLI を起こさない（ログイン中のアカウントでも読み直さない）・覚えの一覧を書かない・行は止める理由つき',
        fail.state === 'none' && failRow?.status === 'blocked' && failRow?.blockKind === 'ownDirLogin' && failRow?.connectors === null
          && s.envLines().length === 0 && !fss.existsSync(s.savedList) && !fss.existsSync(s.accountCache),
        JSON.stringify({ fail, row: failRow && { status: failRow.status, kind: failRow.blockKind }, lines: s.envLines(), saved: fss.existsSync(s.savedList) }));
      await fs.writeFile(s.credFile, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 8 * 3600_000, scopes: SCOPES } }));
      const row = await s.refreshRow();
      const lines = s.envLines();
      const ownDir = path.dirname(s.credFile);
      t.ok('オン・使える: 会話と同じ組み立て — トークン・権限の環境変数なしで、アカウントの専用フォルダ（CLAUDE_CONFIG_DIR）だけで 1 回読み、アカウントごとの覚えに書く（ログイン中の覚えは書かない）',
        row?.status === 'ok' && Array.isArray(row?.connectors) && lines.length === 1 && lines.every(line => line.who === 'login' && line.scopes === null && line.configDir === ownDir && line.claudeAi === null)
          && fss.existsSync(s.accountCache) && !fss.existsSync(s.savedList),
        JSON.stringify({ row: row && { status: row.status, n: row.connectors?.length }, lines, cache: fss.existsSync(s.accountCache), saved: fss.existsSync(s.savedList) }));
      const cacheText = fss.readFileSync(s.accountCache, 'utf8');
      t.ok('アカウントごとの覚えにトークン・メール・組織の id を書かない', ![ACCESS, REFRESH, EMAIL, ORG].some(x => cacheText.includes(x)));
      const after = await s.read();
      t.ok('オン: 上の表（エージェントの設定）のためには読まない（CLI を足さない）', after.state === 'none' && s.envLines().length === 1, JSON.stringify({ after, n: s.envLines().length }));

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
        refused instanceof Error && !enabledInFile() && ![ACCESS, REFRESH, EMAIL, ORG].some(x => String(refused.message).includes(x)), String(refused?.message));
      await fs.writeFile(s.credFile, credText);
      const onRow = await setSwitch(true);
      t.ok('スイッチ: 使えれば押すだけで入る（設定に on を書く）', onRow?.enabled === true && onRow?.status === 'ok' && enabledInFile(), JSON.stringify({ enabled: onRow?.enabled, status: onRow?.status }));
      const listed = (await c.cmd('claudeAccounts')).accounts.find(a => a.id === s.id);
      t.ok('アカウントの一覧: オンのアカウントにだけコネクターの状態（件数・要認可）を添える・秘密を出さない',
        listed?.connectors?.enabled === true && listed.connectors.status === 'ok' && ![ACCESS, REFRESH, EMAIL, ORG].some(x => JSON.stringify(listed.connectors).includes(x)),
        JSON.stringify(listed?.connectors));

      // 段 4: 画面の会話・委譲・bot は同じアカウントの認証を使う（CLI と API だけ偽物）。
      const until = async fn => {
        for (let i = 0; i < 600; i++) { const value = await fn(); if (value) return value; await sleep(100); }
        throw new Error('connector routing timeout');
      };
      const launches = () => fss.existsSync(s.probeLog) ? fss.readFileSync(s.probeLog, 'utf8').trim().split('\n') : [];
      // 会話の CLI は専用フォルダだけで起動する（トークンなし = 'login'）
      const onlyOwnDirSince = before => launches().slice(before).includes('login') && !launches().slice(before).includes('access');
      let start = launches().length;
      const directSession = await c.cmd('newSession', { backend: 'claude', cwd: s.work });
      await c.cmd('setTurnSettings', { sessionId: directSession.sessionId, account: s.id });
      const direct = await c.runTurn({ sessionId: directSession.sessionId, prompt: 'hello' });
      t.ok('段4: headless サーバーの会話は専用フォルダのログインで起動する', direct.outcome === 'ok' && onlyOwnDirSince(start), JSON.stringify({ outcome: direct.outcome, launches: launches().slice(start) }));
      start = launches().length;
      const parent = await c.runTurn({ backend: 'fake', cwd: s.work, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'claude', account: s.id, task: 'hello' } }) });
      const made = JSON.parse(parent.events.find(e => e.type === 'tool.result').text);
      const task = await until(async () => (await c.cmd('agentTasks')).find(r => r.taskId === made.taskId && ['completed', 'failed', 'cancelled'].includes(r.status)));
      const child = (await c.cmd('listSessions')).find(r => r.id === made.sessionId);
      t.ok('段4: 委譲の子はオンのアカウントを保ち、ログイン中へ戻らない', task.status === 'completed' && child?.claudeAccount === s.id && onlyOwnDirSince(start), JSON.stringify({ status: task.status, launches: launches().slice(start) }));
      const op = (op, args) => c.cmd('invoke', { op, args });
      const bot = await op('bots.create', { name: 'ConnectorCheck', backend: 'claude' });
      await op('bots.setAccount', { botId: bot.id, account: s.id });
      start = launches().length;
      await op('channels.post', { channelId: bot.dmChannelId, text: 'hello' });
      const botSession = await until(async () => (await op('bots.get', { botId: bot.id })).dmSessionId);
      await until(async () => (await op('channels.read', { channelId: bot.dmChannelId })).posts.some(p => p.author?.botId === bot.id && p.state === 'done'));
      const botRow = (await c.cmd('listSessions')).find(r => r.id === botSession);
      t.ok('段4: bot の会話もオンのアカウントの認証を使う', botRow?.claudeAccount === s.id && onlyOwnDirSince(start), JSON.stringify({ launches: launches().slice(start) }));

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
      t.ok('止める条件の会話: 発言は送れなかった（failed）に戻り、止めた理由（kind: ownDirLogin・アカウントの id）を持つ',
        failed?.connectorsError?.kind === 'ownDirLogin' && failed.connectorsError.accountId === s.id, JSON.stringify(failed && { status: failed.status, kind: failed.connectorsError?.kind }));
      t.ok('止める条件の会話: 失敗の知らせを出すなら、直す入口（auth.mode connectorsLogin）と渡っていない印（undelivered・messageId）を持つ（黙って落ちない）',
        results.every(r => r.kind === 'auth' && r.auth?.mode === 'connectorsLogin' && r.auth.accountId === s.id && r.undelivered === true && r.messageId === messageId),
        JSON.stringify(results.map(r => ({ kind: r.kind, mode: r.auth?.mode, undelivered: r.undelivered }))));
      t.ok('止める条件の会話: CLI を起こさない（ログイン中のアカウントへ落ちない）', s.envLines().length === before, `${before} → ${s.envLines().length}`);
      const evText = JSON.stringify([failed, results]);
      t.ok('止める条件の会話: 知らせにトークン・メール・組織の id を出さない', ![ACCESS, REFRESH, EMAIL, ORG].some(x => evText.includes(x)));
      await c.cmd('messageAction', { sessionId, messageId, action: 'cancel' });
      const cancelled = await c.waitFor(e => e.type === 'outbox' && e.sessionId === sessionId && e.messages?.some(m => m.id === messageId && m.status === 'cancelled'), { from, ms: 30000 })
        .then(e => e.messages.find(m => m.id === messageId), () => null);
      t.ok('取り消すと止めた理由も消える', cancelled?.status === 'cancelled' && !cancelled.connectorsError, JSON.stringify(cancelled && { status: cancelled.status, ce: Boolean(cancelled.connectorsError) }));
    } finally { await s.close(); }
  }
  if (mac) t.skip('専用フォルダ方式の通し（macOS は本物のキーチェーンを見るため。偽の security での確かめは claude-own-dir）');
  else {
    const s = await boot('own-dir');
    try {
      const { c } = s;
      const dir = path.dirname(s.credFile);
      const file = path.join(s.data, CONNECTORS_FILE);
      const set = enabled => c.cmd('invoke', { op: 'accounts.setConnectors', args: { id: s.id, cwd: s.work, enabled } });
      const enabledInFile = () => { try { return JSON.parse(fss.readFileSync(file, 'utf8')).accounts?.[s.id]?.enabled === true; } catch { return false; } };
      const credentials = await fs.readFile(s.credFile, 'utf8');
      await fs.unlink(s.credFile);
      const refusedLogin = await set(true).then(() => false, () => true);
      t.ok('専用フォルダ方式: ログイン不足なら入れず、設定を保存しない（b1 へは戻さない）', refusedLogin && !enabledInFile());
      const value = JSON.parse(credentials);
      value.claudeAiOauth.expiresAt = 1;
      value.claudeAiOauth.refreshTokenExpiresAt = 1;
      await fs.writeFile(s.credFile, JSON.stringify(value));
      await fs.writeFile(path.join(dir, 'projects'), 'preserve');
      const refusedLink = await set(true).then(() => false, () => true);
      t.ok('専用フォルダ方式: リンクが作れないと設定を保存せず衝突したファイルを残す（b1 へは戻さない）',
        refusedLink && !enabledInFile() && await fs.readFile(path.join(dir, 'projects'), 'utf8') === 'preserve');
      await fs.unlink(path.join(dir, 'projects'));
      await fs.writeFile(path.join(s.claudeConfig, 'test-link-target'), '');
      try { await fs.symlink(path.join(s.claudeConfig, 'test-link-target'), path.join(dir, 'test-link'), 'file'); }
      catch (err) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(err.code)) throw err;
        t.skip('ファイル用シンボリックリンクの作成権限がない Windows');
        return;
      }
      await fs.unlink(path.join(dir, 'test-link'));
      const settingsRow = await set(true);
      const accounts = (await c.cmd('claudeAccounts')).accounts;
      t.ok('専用フォルダ方式: 入れると設定に on を書き、行とアカウント一覧が使える状態を返す（方式の選択は無い）',
        settingsRow?.enabled === true && settingsRow.status === 'ok' && enabledInFile() && !('mode' in settingsRow)
          && accounts.find(a => a.id === s.id)?.connectors?.enabled === true && !('mode' in accounts.find(a => a.id === s.id).connectors));
      const linked = ['projects', 'skills', 'plugins', 'settings.json'].every(entry => { try { return fss.lstatSync(path.join(dir, entry)).isSymbolicLink(); } catch { return false; } });
      t.ok('専用フォルダ方式: 入れるとき、専用フォルダの projects・skills・plugins・settings.json が共有の ~/.claude へのリンクになる', linked);
      const models = () => c.cmd('invoke', { op: 'agents.models', args: { backend: 'claude', cwd: s.work, account: s.id } });
      const onModels = await models().then(r => r, e => ({ error: e.message }));
      t.ok('専用フォルダ方式: モデル一覧も専用フォルダのログインで読める（会話用のトークンは要らない。ADR 0352）', !onModels.error, JSON.stringify(onModels).slice(0, 300));
      let before = s.envLines().length;
      const list = await s.refreshRow();
      const checks = s.envLines().slice(before);
      t.ok('専用フォルダ方式: 一覧の CLI はトークンと権限の環境変数なしで専用フォルダを使う',
        list?.status === 'ok' && Array.isArray(list?.connectors) && checks.length > 0 &&
        checks.every(line => line.who === 'login' && line.scopes === null && line.configDir === dir), JSON.stringify(checks));
      const { sessionId } = await c.cmd('newSession', { backend: 'claude', cwd: s.work });
      await c.cmd('setTurnSettings', { sessionId, account: s.id });
      const turns = () => fss.existsSync(s.probeLog) ? fss.readFileSync(s.probeLog, 'utf8').trim().split('\n') : [];
      before = turns().length;
      // 前に付いた期限切れの印（使用量の読み取りが控えに回っている間も残っていた。ADR 0351 の M7）
      const expiredMarker = path.join(dir, 'ply-usage-expired.json');
      await fs.writeFile(expiredMarker, JSON.stringify({ at: new Date().toISOString(), reason: 'no-login' }));
      const markedBefore = (await c.cmd('claudeAccounts')).accounts.find(a => a.id === s.id)?.usageExpired === true;
      const turn = await c.runTurn({ sessionId, prompt: 'hello' });
      const launches = turns().slice(before);
      t.ok('専用フォルダ方式: 期限の時刻が過去でも起動し、子を事前に再起動しない',
        turn.outcome === 'ok' && launches.length === 1 && launches[0] === 'login', JSON.stringify({ outcome: turn.outcome, launches }));
      let cleared = false;
      for (let i = 0; i < 100 && !cleared; i++) {
        cleared = !fss.existsSync(expiredMarker) && (await c.cmd('claudeAccounts')).accounts.find(a => a.id === s.id)?.usageExpired === false;
        if (!cleared) await sleep(50);
      }
      t.ok('専用フォルダ方式: そのアカウントのログインで会話が通ったら、前に付いた期限切れの印（ply-usage-expired.json）を外す（ADR 0351 の M7）',
        markedBefore && cleared, JSON.stringify({ markedBefore, cleared }));
      await set(false);
      const offModels = await models().then(r => r, e => ({ error: e.message }));
      t.ok('コネクターをオフにすると設定は off になり、モデル一覧は同じ専用フォルダで読める',
        !enabledInFile() && !offModels.error, JSON.stringify(offModels).slice(0, 300));

      // 更新のあとの起動: オンの既存のアカウントの専用フォルダを自動で準備する（共有へ移す・名前が重なれば退避する）。画面（一覧の moved）に出す（ADR 0350）
      await set(true);
      const shared = path.join(s.claudeConfig, 'skills');
      await fs.writeFile(path.join(shared, 'both.md'), 'shared copy');
      await s.restart(async () => {
        // 旧い形（リンクではなく実体の skills が専用フォルダにある）を作る
        await unlinkClaudeOwnDirLinks(dir);
        await fs.mkdir(path.join(dir, 'skills'));
        await fs.writeFile(path.join(dir, 'skills', 'only-mine.md'), 'own copy');
        await fs.writeFile(path.join(dir, 'skills', 'both.md'), 'own copy of both');
      });
      let moved = null;
      for (let i = 0; i < 150 && !moved; i++) {
        moved = (await s.refreshRow())?.moved ?? null;
        if (!moved) await sleep(100);
      }
      const archives = (await fs.readdir(path.join(s.data, 'claude-usage'))).filter(n => n.startsWith('both.md.pleiad-moved-'));
      t.ok('起動のとき: オンの既存のアカウントの専用フォルダを自動で準備する — 実体の skills の中身を共有へ移し（名前が重なる both.md は退避し）、リンクに替える・一覧の moved に出す',
        JSON.stringify(moved) === JSON.stringify({ shared: ['skills'], archived: ['skills'] })
          && await fs.readFile(path.join(shared, 'only-mine.md'), 'utf8') === 'own copy'
          && await fs.readFile(path.join(shared, 'both.md'), 'utf8') === 'shared copy'
          && archives.length === 1 && await fs.readFile(path.join(s.data, 'claude-usage', archives[0]), 'utf8') === 'own copy of both'
          && fss.lstatSync(path.join(dir, 'skills')).isSymbolicLink(),
        JSON.stringify({ moved, archives }));
      t.ok('起動のとき: 入口はオンのまま（方式 b1 へは戻さない）', enabledInFile() && (await s.refreshRow())?.enabled === true);
    } finally { await s.close(); }
  }
}
