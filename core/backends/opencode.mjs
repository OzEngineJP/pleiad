// OpenCode v2 の公開 backend。HTTP/SSE は opencode-v2.mjs で内部の会話イベントへ写す。
// MCP は account と native session ID で中継し、指示・Hooks は v2 plugin で渡す。
// 共有プロセスは保持役が --stdio の stdin を維持する。コンテキストの担当が異なる
// ターンは設定と HOME を隔離し、終了後に専用プロセスを止める（docs/multi-backend.md §2.10）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.mjs';
import { createLoginWatch, loginTimeoutError } from '../auth/login-watch.mjs';
import { loadSqlite } from '../db.mjs';
import { cliCommand } from '../cli-installation.mjs';
import * as store from '../store.mjs';
import { opencodeRelay, RELAY_SERVERS } from '../opencode-relay.mjs';
import { createOpencodeServer } from './opencode-server.mjs';
import { createTurnMapper, messagesToNormalized, sessionRow, errorOf, retryOf } from './opencode-normalize.mjs';
import { writePlugin, writeRelayConfig } from './opencode-plugin.mjs';
import { createHookRunner } from './opencode-hooks.mjs';
import { managedLaunch } from './opencode-context.mjs';
import { configureOpencodeHeld, acquireHeldOpencode, heldOpencode, accountHeldOpencode, writeOpencodeEnvFile, adoptOpencodeEnvFile } from './opencode-held.mjs';
import { computerPrompt } from './computer-delivery.mjs';
import { undelivered } from './undelivered.mjs';
import { accountKey, opencodeData, prepareAccount, readAccountAuth, loginAccount, prepareCredentialImport, importLegacyCredentials } from './opencode-accounts.mjs';
import { opencodeUsage } from './opencode-usage.mjs';
import { v2Message, replayV2Messages } from './opencode-v2.mjs';
import crypto from 'node:crypto';
import {backupV1Database,verifyV1Conversation,v2MigrationComplete,opencodeDatabase} from './opencode-migration.mjs';
import { CAPABILITY_STATES, AGENT_TRAITS } from './agent-marks.mjs';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_MS = 3_000;
// 待っているログインの見張りをやめる口（authCancel）
const loginWatch = createLoginWatch('OpenCode');
const nativeMessageId = (id, account) => id ? 'msg_'+crypto.createHash('sha256').update(`${account}:${id}`).digest('hex').slice(0,40) : undefined;
const databaseFor=account=>opencodeDatabase(opencodeData(account),account?{}:process.env);
const instructionOmissions=messages=>{
  const omitted=messages.filter(m=>m.info.type==='synthetic' && m.info.metadata?.instruction?.paths);
  return {omitMessageIDs:omitted.map(m=>m.info.id),omitTexts:omitted.map(m=>m.info.text).filter(Boolean)};
};
function instructionContext(srv,account) {
  const cache=new Map();
  return {
    context(id,{fresh=false}={}) {
      if(fresh)cache.delete(id);
      if(!cache.has(id)) {
        const pending=Promise.resolve().then(async()=>instructionOmissions(srv.running?await srv.request('GET',`/session/${id}/message`):messagesFromDb(id,account)??[]));
        cache.set(id,pending);pending.catch(()=>cache.delete(id));
      }
      return cache.get(id);
    },
    invalidate:id=>cache.delete(id),
  };
}
const beforeOpenCode=account=>()=>{
  const file=databaseFor(account);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  prepareCredentialImport(file,account);
  backupV1Database(file);
  backupV1Database(path.join(path.dirname(file),'opencode-next.db'));
};
/** 1 つの接続先の候補をそのまま全部出す上限。超える接続先（OpenRouter など）は既定と設定に書いたモデルだけ出す */
const PROVIDER_MODELS_MAX = 40;

const hint = (key, shape) => ({ get label() { return t(`tools.${key}`); }, shape });
const TOOL_HINTS = {
  bash: hint('run', 'shell'),
  shell: hint('run', 'shell'),
  read: hint('read', 'read'),
  write: hint('write', 'write'),
  edit: hint('edit', 'edit'),
  patch: hint('edit', 'edit'),
  glob: hint('find', 'search'),
  grep: hint('search', 'search'),
  list: hint('list', 'read'),
  webfetch: hint('fetch', 'web'),
  websearch: hint('webSearch', 'web'),
  task: hint('delegate', 'delegate'),
  subagent: hint('delegate', 'delegate'),
};

// ---- 承認モード（会話の権限の規則。最初に `*` を置いて、それより前に足した規則を上書きする）
const rule = (permission, action, pattern = '*') => ({ permission, pattern, action });
// ply_context の指示・Skill・MCP の資源の読み出しは読むだけ（外部 MCP のツールは OpenCode が聞く）
const READS = ['read', 'glob', 'grep', 'list', 'lsp', 'todoread', 'todowrite', 'skill', 'question', 'task', 'subagent',
  'ply_context_instructions_for_path', 'ply_context_load_skill', 'ply_context_mcp_resources', 'ply_context_mcp_prompts'];
const RULES = {
  ask: [rule('*', 'ask'), ...READS.map((p) => rule(p, 'allow'))],
  edit: [rule('*', 'ask'), ...READS.map((p) => rule(p, 'allow')), rule('edit', 'allow')],
  // 作業場所の中は聞かない。外は断る（聞かない約束のモードで、外へ出るときだけ聞くことはしない）
  full: [rule('*', 'allow'), rule('external_directory', 'deny'), rule('doom_loop', 'allow')],
  yolo: [rule('*', 'allow'), rule('external_directory', 'allow'), rule('doom_loop', 'allow')],
  plan: [rule('*', 'ask'), ...READS.map((p) => rule(p, 'allow')), rule('edit', 'deny')],
};
/**
 * 会話の権限の規則と、その組み合わせの印（変わったら入れ直す）。
 * - Skills を Pleiad が担当するターンは、OpenCode の組み込みの skill のツールも止める（中身の無いツールを見せない）
 * - ply_shell（ADR 0227）は聞かない（承認は橋が会話の承認モードで決める。二重に聞かない）。
 *   エージェントのシェルを切る会話（shellRuntime.nativeOff）は bash を全面拒否にする（OpenCode は全面拒否のツールを一覧から外す）
 */
export function sessionPermission(mode, { noSkill = false, shellRuntime = null } = {}) {
  const noShell = Boolean(shellRuntime?.nativeOff);
  const permission = [...RULES[modeOf(mode)], ...(shellRuntime ? [rule('ply_shell_*', 'allow')] : []), ...(noSkill ? [rule('skill', 'deny')] : []), ...(noShell ? [rule('bash', 'deny'),rule('shell','deny')] : [])];
  return { permission, permissionKey: `${modeOf(mode)}${shellRuntime ? '+plyshell' : ''}${noSkill ? '+noskill' : ''}${noShell ? '+noshell' : ''}` };
}
const MODES = {
  ask: { get label() { return t('modes.ask'); }, get short() { return t('modesShort.ask'); }, get note() { return t('opencode.modes.ask'); }, scope: 'workspace', autonomy: 'ask', enforced: true },
  edit: { get label() { return t('modes.acceptEdits'); }, get short() { return t('modesShort.acceptEdits'); }, get note() { return t('opencode.modes.edit'); }, scope: 'workspace', autonomy: 'judge', enforced: true },
  full: { get label() { return t('modes.full'); }, get short() { return t('modesShort.full'); }, get note() { return t('opencode.modes.full'); }, scope: 'workspace', autonomy: 'never', enforced: true },
  yolo: { label: 'Bypass', get note() { return t('opencode.modes.yolo'); }, scope: 'full', autonomy: 'never', enforced: false },
  plan: { get label() { return t('modes.plan'); }, get short() { return t('modesShort.plan'); }, get note() { return t('opencode.modes.plan'); }, scope: 'readonly', autonomy: 'ask', enforced: true },
};
const vocab = ({ label, short, note, scope, autonomy, enforced }) => ({ label, ...(short ? { short } : {}), note, scope, autonomy, enforced });
const modeOf = (mode) => (Object.hasOwn(MODES, mode) ? mode : 'ask');

// ---- 共有のサーバー
const directories = new Map();   // 会話の id -> 作業場所（OpenCode の instance を選ぶ ?directory=）
const appliedMode = new Map();   // 会話の id -> 最後に入れた承認モード（同じなら PATCH しない。規則は後ろに足していく形なので）
const liveModes = new Map();     // 実行中の会話 -> 途中変更後の承認モード
const liveModelRefs = new Map(); // 実行中の会話 -> 途中変更後のモデル
const turnsBySession = new Map(); // 会話の id（と子の会話の id） -> 走っているターンの受け口
let providersCache = null;       // { at, data }（/config/providers）
const accountServers = new Map();
const removingAccounts = new Set();
const loggingInAccounts = new Set();
const accountTurns = new Map();
const sessionAccounts = new Map();
const sessionKey = (id, srv = server) => `${srv.accountKey ?? 'login'}:${id}`;

function selectedAccount(sessionId, options = {}) {
  const remembered = sessionAccounts.get(sessionId);
  const account = options.account === undefined ? remembered : options.account;
  if (remembered && accountKey(remembered) !== accountKey(account)) throw new Error('OpenCode session belongs to a different account');
  return account ?? null;
}

function rememberSession(id, account) {
  const previous = sessionAccounts.get(id);
  if (previous && accountKey(previous) !== accountKey(account)) throw new Error('OpenCode session account mismatch');
  // Credentials belong in the private auth file, never in session/holder metadata.
  if (account) sessionAccounts.set(id, { id: account.id, dir: account.dir });
}

function serverFor(account = null) {
  if (!account) return server;
  const key = accountKey(account);
  if (removingAccounts.has(key)) throw new Error(t('accounts.backend.removing', { agent: 'OpenCode' }));
  if (loggingInAccounts.has(key)) throw new Error(t('accounts.backend.loginRunning', { agent: 'OpenCode' }));
  prepareAccount(account);
  if (!accountServers.has(key)) {
    const srv = createOpencodeServer({ command: () => cliCommand('opencode'),
      beforeStart:beforeOpenCode(account),
      afterStart:request=>importLegacyCredentials(request,databaseFor(account),account),
      account: { id: account.id, dir: account.dir },
      held: { acquire: args => acquireHeldOpencode({ ...args, account }) },
      origin: () => opencodeRelay.whenOrigin(), currentOrigin: () => opencodeRelay.origin(),
      busy: () => [...turnsBySession.keys()].some(k => k.startsWith(`${key}:`)) || (heldOpencode(account)?.cards.size ?? 0) > 0,
      env: async () => ({ ...(await serverEnv({},account)), ...prepareAccount(account) }),
    });
    srv.accountKey = key;
    srv.subscribe(event => dispatch(event, srv));
    srv.onGone(err => {
      for (const [k, fn] of turnsBySession) if (k.startsWith(`${key}:`)) fn({ type: 'pleiad.gone', properties: { error: err } });
    });
    accountServers.set(key, srv);
  }
  return accountServers.get(key);
}

function accountBusy(account) {
  const key = accountKey(account);
  return (accountTurns.get(key) ?? 0) > 0 || loggingInAccounts.has(key)
    || [...turnsBySession.keys()].some(k => k.startsWith(`${key}:`)) || (accountHeldOpencode(account)?.cards.size ?? 0) > 0;
}

// 保持役に載せたとき、前のサーバーの子を引き継いだら、中継の合言葉を前の値にし、付け直すターンの会話の呼び出しを結び付けるまで待たせる
configureOpencodeHeld({
  dataDir: () => store.dataDir,
  adopt: (srv, turns) => {
    opencodeRelay.adoptSecret(srv?.secret);
    const children = {};
    for (const [sessionId, card] of Object.entries(turns ?? {})) {
      const account = srv?.account ?? card?.backendCard?.account ?? null;
      if (account) rememberSession(sessionId, account);
      for (const child of card?.backendCard?.children ?? []) children[child] = sessionId;
      if (card?.backendCard?.directory) directories.set(`${accountKey(account)}:${sessionId}`, card.backendCard.directory);
    }
    opencodeRelay.expect(Object.keys(turns ?? {}), children, srv?.account?.id ?? 'login');
  },
  forget: (sessionId, account) => {opencodeRelay.unexpect(sessionId,account);opencodeRelay.unbind(sessionId,account);},
});

const server = createOpencodeServer({
  beforeStart:beforeOpenCode(null),
  afterStart:request=>importLegacyCredentials(request,databaseFor(null)),
  command: () => cliCommand('opencode'),
  held: { acquire: acquireHeldOpencode },
  origin: () => opencodeRelay.whenOrigin(),
  currentOrigin: () => opencodeRelay.origin(),
  // 走っているターン・付け直すのを待っているターンがあれば、待ち受けが変わっても起こし直さない
  busy: () => turnsBySession.size > 0 || (heldOpencode()?.cards.size ?? 0) > 0,
  env: () => serverEnv(),
});

/**
 * OpenCode に渡す環境変数。中継とプラグインの口は Pleiad の待ち受けが決まってから。
 * 利用者の opencode.json は書き換えずに、Pleiad のプラグインだけを足す。Pleiad が起こした OpenCode は勝手に自分を更新しない（ADR 0037）。
 * config は OPENCODE_CONFIG_CONTENT に合わせる設定（Pleiad 担当のコンテキストの専用のサーバーが、作業場所の設定を渡し直す）
 */
async function serverEnv(config = {}, account = null) {
  await opencodeRelay.whenOrigin();
  const plugin = writePlugin(store.dataDir);
  return {
    OPENCODE_DB:databaseFor(account),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...(Array.isArray(config.plugins) ? config.plugins : []), plugin], update: 'disable' }),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    PLEIAD_OPENCODE_ENV_URL: opencodeRelay.envUrl(),
    PLEIAD_OPENCODE_HOOK_URL: opencodeRelay.hookUrl(),
    PLEIAD_OPENCODE_SECRET: opencodeRelay.secret,
    PLEIAD_OPENCODE_RELAY_FILE: writeRelayConfig(store.dataDir,account?.id ?? 'login',{env:opencodeRelay.envUrl(),hook:opencodeRelay.hookUrl()}),
  };
}

// 出来事は 1 本の流れで全部来る。会話の id で、走っているターンへ配る
const dispatch = (event, srv = server) => {
  const sid = event.properties?.sessionID ?? event.properties?.info?.sessionID ?? event.properties?.part?.sessionID;
  if (!sid) return;
  turnsBySession.get(sessionKey(sid, srv))?.(event);
};
server.subscribe(event => dispatch(event, server));

/**
 * Pleiad 担当のコンテキストのターンの専用のサーバー（opencode-context.mjs）。OpenCode 自身の指示・Skills・MCP のうち Pleiad が担当する種類を読ませない。
 * 保持役には載せない（ターンの終わりに止める。無停止の更新の切り替えは、このターンが終わるのを待つ。Codex の専用の app-server と同じ）
 */
async function managedServer(contextRuntime, cwd, account = null) {
  const accountEnv = prepareAccount(account);
  const launch = await managedLaunch({ owners: contextRuntime.owners, cwd, dataDir: account?.dir ?? store.dataDir,
    dataHome:path.dirname(opencodeData(account)), ...(account ? {homeSource:path.join(account.dir,'home')} : {}),
    ...(account ? { source: accountEnv.OPENCODE_CONFIG_DIR } : {}) });
  const srv = createOpencodeServer({
    beforeStart:beforeOpenCode(account),
    afterStart:request=>importLegacyCredentials(request,databaseFor(account),account),
    account: account ? {id:account.id,dir:account.dir} : null,
    command: () => cliCommand('opencode'),
    origin: () => opencodeRelay.whenOrigin(),
    currentOrigin: () => opencodeRelay.origin(),
    env: async () => ({ ...(await serverEnv(launch.config,account)), ...accountEnv, ...launch.env,
      PLEIAD_OPENCODE_INSTRUCTION_OWNER:contextRuntime.owners?.instruction ?? 'native',
      ...(account ? { OPENCODE_CONFIG_DIR: path.join(launch.env.XDG_CONFIG_HOME, 'opencode') } : {}) }),
  });
  srv.accountKey = accountKey(account);
  srv.subscribe(event => dispatch(event, srv));
  return srv;
}
server.onGone((err) => { for (const [key, fn] of turnsBySession) if (key.startsWith('login:')) fn({ type: 'pleiad.gone', properties: { error: err } }); });

async function directoryOf(sessionId, srv = server) {
  if (directories.has(sessionKey(sessionId, srv))) return directories.get(sessionKey(sessionId, srv));
  const s = await srv.request('GET', `/session/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (s?.directory) directories.set(sessionKey(sessionId, srv), s.directory);
  return s?.directory ?? null;
}

async function providers(cwd, srv = server) {
  // 控えは共有のサーバーの分だけ（専用のサーバーはターンごとに起こす）
  if (srv !== server) return srv.request('GET', '/config/providers', { directory: cwd || null });
  if (providersCache && Date.now() - providersCache.at < 60_000) return providersCache.data;
  const data = await server.request('GET', '/config/providers', { directory: cwd || null });
  providersCache = { at: Date.now(), data };
  return data;
}

/** OpenCode の資格情報のファイル（auth.json）の更新時刻。無ければ 0（OpenCode の置き場は XDG_DATA_HOME、無ければ ~/.local/share/opencode） */
function authStamp() {
  return crypto.createHash('sha256').update(JSON.stringify(readAccountAuth())).digest('hex');
}

/**
 * サーバーが動いていないときの会話の行。OpenCode の会話の DB（opencode.db の session の表）を読み取りだけで開く。
 * 一覧を作るたびに約 760 MB のサーバーを起こさないため（画面を開いただけで起きていた）。読めなければ null
 */
function sessionsFromDb({ limit = 100, id = null, account = null } = {}) {
  const file = databaseFor(account);
  if (!fs.existsSync(file)) return [];
  let db = null;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
    const table = v2MigrationComplete(db) ? 'session_v2' : 'session';
    const cols = 'id, parent_id, directory, title, time_created, time_updated';
    const rows = id
      ? db.prepare(`select ${cols} from ${table} where id = ?`).all(id)
      : db.prepare(`select ${cols} from ${table} where parent_id is null and time_archived is null order by time_updated desc limit ?`).all(limit);
    return rows.map((r) => ({ id: r.id, parentID: r.parent_id ?? undefined, directory: r.directory, title: r.title, time: { created: Number(r.time_created), updated: Number(r.time_updated) } }));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** サーバーが動いていないときの会話の発言（message・part の表。中身は API の返りと同じ JSON）。読めなければ null */
function messagesFromDb(sessionId, account = null) {
  const file = databaseFor(account);
  if (!fs.existsSync(file)) return null;
  let db = null;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
    if(v2MigrationComplete(db)) {
      return db.prepare('select id, type, data, time_created from session_message where session_id = ? order by seq').all(sessionId)
        .map(row=>v2Message({...JSON.parse(row.data),id:row.id,type:row.type},sessionId));
    }
    const messages = db.prepare('select id, data from message where session_id = ? order by time_created, id').all(sessionId);
    const parts = db.prepare('select id, message_id, data from part where session_id = ? order by time_created, id').all(sessionId);
    const byMessage = new Map();
    for (const p of parts) {
      const list = byMessage.get(p.message_id) ?? [];
      list.push({ ...JSON.parse(p.data), id: p.id, messageID: p.message_id, sessionID: sessionId });
      byMessage.set(p.message_id, list);
    }
    return messages.map((m) => ({ info: { ...JSON.parse(m.data), id: m.id, sessionID: sessionId }, parts: byMessage.get(m.id) ?? [] }));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** つないだ接続先の名前（資格情報のファイルのキーだけを読む。値は読まない） */
function connectedFromFile() {
  return Object.keys(readAccountAuth());
}

/** "provider/model" -> { providerID, modelID }。"" や形の違うものは null（OpenCode の既定に従う） */
function modelRef(model) {
  const m = /^([^/]+)\/(.+)$/.exec(String(model ?? ''));
  return m ? { providerID: m[1], modelID: m[2] } : null;
}

function modelInfo(data, ref) {
  if (!ref) return null;
  return (data?.providers ?? []).find((p) => p.id === ref.providerID)?.models?.[ref.modelID] ?? null;
}

/** 既定のモデル（OpenCode の設定の model、無ければ opencode の既定） */
async function defaultModelRef(cwd, srv = server) {
  const config = await srv.request('GET', '/config', { directory: cwd || null }).catch(() => null);
  const ref = modelRef(config?.model);
  if (ref) return ref;
  const data = await providers(cwd, srv).catch(() => null);
  const def = data?.default ?? {};
  const providerID = def.opencode ? 'opencode' : Object.keys(def)[0];
  return providerID ? { providerID, modelID: def[providerID] } : null;
}

/** モデルの一覧（"" は OpenCode の既定に従う）。エフォートはモデルの variants */
async function listModels(cwd, srv = server) {
  const data = await providers(cwd, srv);
  const config = await srv.request('GET', '/config', { directory: cwd || null }).catch(() => null);
  const configured = new Set(Object.entries(config?.provider ?? {}).flatMap(([pid, p]) => Object.keys(p?.models ?? {}).map((m) => `${pid}/${m}`)));
  const def = await defaultModelRef(cwd, srv).catch(() => null);
  const out = { '': { get label() { return t('opencode.models.default'); }, note: def ? `${def.providerID}/${def.modelID}` : '', ...(def ? { resolvesTo: `${def.providerID}/${def.modelID}` } : {}), efforts: [], defaultEffort: null, effortDefaultNote: t('opencode.effort.useDefault') } };
  for (const p of data?.providers ?? []) {
    const models = Object.entries(p.models ?? {});
    const keep = models.length <= PROVIDER_MODELS_MAX ? models
      : models.filter(([id]) => id === data?.default?.[p.id] || configured.has(`${p.id}/${id}`) || (def && def.providerID === p.id && def.modelID === id));
    for (const [id, m] of keep) {
      const efforts = Object.keys(m?.variants ?? {});
      out[`${p.id}/${id}`] = { label: m?.name || id, note: p.name || p.id, efforts, defaultEffort: null };
    }
  }
  // 「既定に従う」でも、実際に当たるモデルの段を選べるようにする（エフォートは variant）。
  // OpenCode は既定の variant を持たないので defaultEffort は null のまま（画面は「既定」の段を作らない）
  const resolved = def ? `${def.providerID}/${def.modelID}` : null;
  if (resolved && out[resolved]) {
    Object.assign(out[''], { efforts: out[resolved].efforts, defaultEffort: out[resolved].defaultEffort });
  }
  return out;
}

const relayBindings = new WeakMap();
/** Pleiad の待ち受けが変わった場合は、接続中でも MCP の行き先を付け直す。 */
async function ensureRelay(cwd, servers, srv = server) {
  if (!servers.length) return;
  const status = await srv.request('GET', '/mcp', { directory: cwd }).catch(() => ({}));
  let configured=relayBindings.get(srv);
  if(!configured){configured=new Map();relayBindings.set(srv,configured);}
  for (const name of servers) {
    const url=opencodeRelay.serverUrl(name,srv.relayAccount ?? 'login'),key=`${cwd}:${name}`;
    if(status?.[name]?.status==='connected' && configured.get(key)===url)continue;
    await srv.request('POST', '/mcp', { directory: cwd, body: { name, config: { type: 'remote',codemode:false, url, headers: { Authorization: `Bearer ${opencodeRelay.token(srv.relayAccount ?? 'login')}` } } } });
    const until=Date.now()+30_000;
    for(;;) {
      const connected=(await srv.request('GET','/mcp',{directory:cwd}))[name];
      if(connected?.status==='connected')break;
      if(connected?.status==='failed' || connected?.status==='needs_auth' || Date.now()>=until)throw new Error(`OpenCode could not connect the ${name} tools`);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    configured.set(key,url);
  }
}

/** Pleiad の指示（委譲・可視化・ブラウザー・コンピューター・操作の一覧・秘密情報・Pleiad が足した文・bot の人格）。毎ターン system で渡す */
function systemText({ contextRuntime, agentRuntime, visualizeInstructions, browserInstructions, computerRuntime, controlRuntime, shellRuntime, secretsRuntime, addedInstructions, botInstructions, locale }) {
  return [
    contextRuntime?.prompt, agentRuntime?.instructions, visualizeInstructions, browserInstructions,
    computerPrompt(computerRuntime, { locale, agent: 'opencode' }), controlRuntime?.instructions, shellRuntime?.instructions, secretsRuntime?.instructions, addedInstructions, botInstructions,
  ].filter(Boolean).join('\n\n');
}

/** 会話のシェルへ渡す環境変数（ブラウザー・操作の一覧・秘密情報。native environment に設定する） */
const shellEnv = ({ browserEnv, controlRuntime, secretsRuntime }) => ({ ...(browserEnv ?? {}), ...(controlRuntime?.env ?? {}), ...(secretsRuntime?.env ?? {}) });

/** 中継に結び付ける会話の口（url と headers だけ）。付け直す新しいサーバーのために札にも置く（トークンは札の connectionTokens と同じもの） */
const relayRuntimes = (args) => Object.fromEntries(Object.values(RELAY_SERVERS).filter((key) => args?.[key]?.url).map((key) => [key, { url: args[key].url, headers: { ...(args[key].headers ?? {}) } }]));

function questionsOf(list) {
  return (list ?? []).map((q) => ({
    question: String(q.question ?? ''),
    header: q.header ?? null,
    multiSelect: Boolean(q.multiple),
    options: (q.options ?? []).map((o) => ({ label: String(o.label ?? ''), description: o.description ?? null })),
  }));
}

export const backend = {
  id: 'opencode',
  label: 'OpenCode',
  get description() { return t('opencode.description'); },

  // 能力の印と性質は core/backends/agent-marks.mjs（公開文書も同じデータから作る）
  capabilities: CAPABILITY_STATES.opencode,
  traits: AGENT_TRAITS.opencode,

  subagentTools: ['task', 'subagent'],
  toolHints: TOOL_HINTS,

  modes: () => Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, vocab(m)])),
  models: (cwd, options = {}) => listModels(cwd, serverFor(options.account)),
  usage: opencodeUsage,

  async setModelLive(handle, model) {
    const sessionId = handle?.sessionId;
    if (!sessionId) return false;
    const srv = serverFor(selectedAccount(sessionId));
    const key = sessionKey(sessionId, srv);
    if (!turnsBySession.has(key)) return false;
    const ref = modelRef(model);
    if (!ref) return false;
    try {
      await srv.request('POST', `/api/session/${encodeURIComponent(sessionId)}/model`, {
        directory: await directoryOf(sessionId, srv), body: { model: { providerID: ref.providerID, id: ref.modelID } },
      });
      liveModelRefs.set(key, ref);
      return true;
    } catch { return false; }
  },

  async setModeLive(handle, mode) {
    const sessionId = handle?.sessionId;
    if (!sessionId || !Object.hasOwn(MODES, mode)) return false;
    const srv = serverFor(selectedAccount(sessionId));
    const key = sessionKey(sessionId, srv);
    if (!turnsBySession.has(key)) return false;
    const { permission, permissionKey } = sessionPermission(mode);
    const permissions = permission.map(({ permission: action, pattern: resource, action: effect }) => ({ action, resource, effect }));
    try {
      await srv.request('PATCH', `/api/session/${encodeURIComponent(sessionId)}`, {
        directory: await directoryOf(sessionId, srv), body: { permissions },
      });
      liveModes.set(key, mode);
      appliedMode.set(key, permissionKey);
      return true;
    } catch { return false; }
  },

  /** 次の発言の候補は別 session で作り、完了後に必ず削除する（ADR 0211）。 */
  async suggestNext({ prompt, signal, account = null } = {}) {
    const srv = serverFor(account);
    if (signal?.aborted) return null;
    const ac = new AbortController();
    const stop = () => ac.abort(signal?.reason);
    signal?.addEventListener('abort', stop, { once: true });
    let sessionId = null, text = '', failure = null;
    try {
      const result = await backend.runTurn({
        prompt, cwd: os.tmpdir(), mode: 'plan', suggestionOnly: true, account,
        signal: { signal: ac.signal },
        askPermission: async () => ({ allow: false }),
        emit: (event) => {
          if (event.type === 'session') sessionId = event.sessionId;
          if (event.type === 'text.delta') text += event.text;
          if (event.type === 'turnResult' && event.outcome !== 'ok') failure = event.error || event.outcome;
        },
      }, null, srv);
      sessionId ??= result?.sessionId ?? null;
    } finally {
      signal?.removeEventListener('abort', stop);
      if (sessionId) {
        await srv.request('DELETE', `/api/session/${encodeURIComponent(sessionId)}`, { directory: os.tmpdir() }).catch(() => {});
        directories.delete(sessionKey(sessionId, srv));
        appliedMode.delete(sessionKey(sessionId, srv));
        sessionAccounts.delete(sessionId);
      }
    }
    if (ac.signal.aborted) return null;
    if (failure) throw new Error(failure);
    return text;
  },

  async forAccount(account) {
    accountKey(account);
    const bound = { ...backend };
    const call = (method, args) => async (...values) => {
      const key = accountKey(account);
      if (removingAccounts.has(key)) throw new Error(t('accounts.backend.removing', { agent: 'OpenCode' }));
      if (loggingInAccounts.has(key)) throw new Error(t('accounts.backend.loginRunning', { agent: 'OpenCode' }));
      accountTurns.set(key, (accountTurns.get(key) ?? 0) + 1);
      try { return await backend[method](...args(values)); }
      finally {
        const left = (accountTurns.get(key) ?? 1) - 1;
        if (left) accountTurns.set(key, left); else accountTurns.delete(key);
      }
    };
    // Pure methods still receive the bound receiver; every I/O method below
    // injects the account after caller options, including nested wrapper calls.
    for (const [key, value] of Object.entries(bound)) if (typeof value === 'function') bound[key] = value.bind(bound);
    for (const key of ['runTurn', 'compact', 'adoptTurn', 'listSessions'])
      bound[key] = call(key, ([args = {}]) => [{ ...args, account }]);
    for (const key of ['models', 'getSession', 'getMessages', 'fork', 'listSubagents'])
      bound[key] = call(key, ([first, options = {}]) => [first, { ...options, account }]);
    for (const key of ['setTitle', 'getSubagentMessages', 'getSubagentOrigin'])
      bound[key] = call(key, ([first, second, options = {}]) => [first, second, { ...options, account }]);
    bound.usage = call('usage', ([options = {}]) => [{ ...options, accounts: [], account }]);
    for (const key of ['accountLogin', 'accountStatus', 'accountRemove'])
      bound[key] = (options = {}) => backend[key]({ ...options, account });
    bound.forAccount = next => backend.forAccount(next);
    bound.auth = {
      status: async () => {
        if (!account) return backend.auth.status();
        const status = await backend.accountStatus({ account });
        return { loggedIn: status.hasCredential, account: status.label ?? null };
      },
      login: (options = {}) => account ? backend.accountLogin({ ...options, account }) : backend.auth.login(options),
      logout: (...args) => backend.auth.logout(...args),
    };
    return bound;
  },

  async accountLogin(args) {
    const argv = cliCommand('opencode');
    if (!argv) throw new Error(t('opencode.errors.notInstalled'));
    if (accountBusy(args.account)) throw new Error(t('accounts.backend.inUse', { agent: 'OpenCode' }));
    const key = accountKey(args.account);
    if (removingAccounts.has(key)) throw new Error(t('accounts.backend.removing', { agent: 'OpenCode' }));
    loggingInAccounts.add(key);
    try {
      const result = await loginAccount({ ...args, argv });
      // The provider catalog and running CLI cache credentials at startup.
      await accountServers.get(key)?.stop();
      await accountHeldOpencode(args.account)?.stop();
      return result;
    } finally { loggingInAccounts.delete(key); }
  },

  async accountStatus({ account }) {
    return { hasCredential: Object.keys(readAccountAuth(account)).length > 0, label: Object.keys(readAccountAuth(account)).join(', ') || null };
  },

  async accountRemove({ account }) {
    const key = accountKey(account);
    if (!account || accountBusy(account) || removingAccounts.has(key)) throw new Error(t('accounts.backend.inUse', { agent: 'OpenCode' }));
    removingAccounts.add(key);
    try {
      await accountServers.get(key)?.stop();
      await accountHeldOpencode(account)?.stop();
      accountServers.delete(key);
      for (const [id, a] of sessionAccounts) if (accountKey(a) === key) sessionAccounts.delete(id);
      for (const map of [directories, appliedMode]) for (const k of map.keys()) if (k.startsWith(`${key}:`)) map.delete(k);
    } finally { removingAccounts.delete(key); }
  },

  // ---- 実行 ---------------------------------------------------------------

  /**
   * adopt は付け直し（{ card, source }。adoptTurn だけが渡す。無停止の更新）。card は前のサーバーが札に置いた欄（control.backendCard）。
   * 発言は送らず、会話の発言・承認・質問・状態を OpenCode に聞き直して続きを受ける
   */
  async runTurn(args, adopt = null, srv = null) {
    const account = selectedAccount(args.sessionId, args);
    const key = accountKey(account);
    if (removingAccounts.has(key)) throw new Error(t('accounts.backend.removing', { agent: 'OpenCode' }));
    if (loggingInAccounts.has(key)) throw new Error(t('accounts.backend.loginRunning', { agent: 'OpenCode' }));
    accountTurns.set(key, (accountTurns.get(key) ?? 0) + 1);
    try {
    if (adopt && accountKey(adopt.card?.account) !== accountKey(account)) throw new Error('OpenCode holder account mismatch');
    // Pleiad 担当のコンテキストのターンは、そのターンだけの専用のサーバーで走らせ、終わったら止める
    if (!srv && args.contextRuntime && !adopt) {
      let dedicated;
      try { dedicated = await managedServer(args.contextRuntime, args.cwd, account); }
      catch (err) { args.emit({ type: 'turnResult', outcome: 'error', error: String(err?.message ?? err) }); throw undelivered(err); }
      try { return await backend.runTurn(args, null, dedicated); } finally { await dedicated.stop(); }
    }
    srv ??= serverFor(account);
    const { prompt, cwd, mode, model, effort, emit, onPromptDelivered, askPermission, signal, control, notes = [], shellAppends = [] } = args;
    let sessionId = args.sessionId ?? null;
    const card = adopt?.card ?? null;
    const { permission, permissionKey } = args.suggestionOnly
      ? { permission: [rule('*', 'deny')], permissionKey: 'suggestion-only' }
      : sessionPermission(mode, { noSkill: args.contextRuntime?.owners?.skill === 'ply', shellRuntime: args.shellRuntime });
    let fresh = false;
    try {
      await srv.ensure();
      if(sessionId)verifyV1Conversation(databaseFor(account),sessionId);
      if (adopt) {
        // 会話も作業場所も承認モードの規則も、前のサーバーのまま
        if (card.directory) directories.set(sessionKey(sessionId, srv), card.directory);
        if (card.mode) appliedMode.set(sessionKey(sessionId, srv), card.mode);
      } else if (!sessionId) {
        const created = await srv.request('POST', '/session', { directory: cwd, body: { permission } });
        sessionId = created.id;
        directories.set(sessionKey(sessionId, srv), created.directory ?? cwd);
        appliedMode.set(sessionKey(sessionId, srv), permissionKey);
        fresh = true;
        emit({ type: 'session', sessionId, first: true, ...(model ? { model } : {}) });
      } else {
        emit({ type: 'session', sessionId, ...(model ? { model } : {}) });
      }
    } catch (err) {
      emit({ type: 'turnResult', outcome: 'error', error: String(err?.code === 'NOT_INSTALLED' ? t('opencode.errors.notInstalled') : err?.message ?? err) });
      throw undelivered(err);
    }
    rememberSession(sessionId, account);
    const directory = (await directoryOf(sessionId, srv)) ?? cwd;
    if (!adopt && appliedMode.get(sessionKey(sessionId, srv)) !== permissionKey) {
      await srv.request('PATCH', `/session/${sessionId}`, { directory, body: { permission } });
      appliedMode.set(sessionKey(sessionId, srv), permissionKey);
    }
    // Pleiad がそろえる Hooks（hooksRuntime。ADR 0049）。Claude Code の形で、Pleiad の中で走らせる（core/backends/opencode-hooks.mjs）
    const hooks = args.hooksRuntime
      ? createHookRunner(args.hooksRuntime, { onRun: (run) => emit({ type: 'hookRun', ...run }), base: { session_id: sessionId, cwd: directory } })
      : null;
    // 保持役に載せた共有のサーバー（無停止の更新）。会話のシェルの環境変数は札に入れず、データ置き場のファイルに置く（付け直す側が読む）
    const heldServer = control ? srv.held : null;
    const envFile = !heldServer ? null : adopt ? await adoptOpencodeEnvFile(store.dataDir, card.envFile) : await writeOpencodeEnvFile(store.dataDir, shellEnv(args)).catch(() => null);
    // Pleiad の MCP・会話のシェルの環境変数・ツールの前後の Hooks を、この会話に結び付ける（付け直しは、札の口とファイルの環境変数で結び直す）
    const runtimes = adopt ? (card.runtimes ?? {}) : relayRuntimes(args);
    const variables = adopt ? (envFile?.vars ?? {}) : shellEnv(args);
    const relayAccount = account?.id ?? 'login';
    const environment=Object.fromEntries(Object.entries({...process.env,...prepareAccount(account),...variables}).filter(([key,value])=>value!=null && !/^PLEIAD_OPENCODE_/i.test(key) && !/^OPENCODE_(SERVER_)?PASSWORD$/i.test(key)).map(([key,value])=>[key,String(value)]));
    const prepareEnvironment = id => srv.request('PUT', `/api/session/${id}/environment`, {body:{variables:environment}});
    await prepareEnvironment(sessionId);
    const instructions=instructionContext(srv,account);
    const servers = opencodeRelay.bind(sessionId, { runtimes, env: variables, account:relayAccount, system:systemText(args),
      resolveChild:async id=>(await srv.request('GET',`/session/${encodeURIComponent(id)}`))?.parentID,
      prepareChild:prepareEnvironment,
      context:args.contextRuntime?.owners?.instruction==='ply' ? instructions.context : null,
      hooks: {
        beforeTool: async p => {
          if(p.tool==='opencode_session_move' && modeOf(mode)!=='yolo')return {block:t('opencode.errors.moveRestricted')};
          if(p.tool==='opencode_worktree_create' && modeOf(mode)!=='yolo')return {block:t('opencode.errors.worktreeRestricted')};
          if(['opencode_session_rename','opencode_session_move'].includes(p.tool) && p.args?.sessionID && p.args.sessionID!==p.sessionID)return {block:t('opencode.errors.otherConversation')};
          if(p.tool==='execute' && ['ask','edit','plan'].includes(modeOf(liveModes.get(sessionKey(sessionId, srv)) ?? mode))) {
            const answer=await askPermission({toolName:'execute',input:p.args,sessionId,signal:signal?.signal,canAlways:false,kind:'tool',questions:null});
            if(!answer?.allow)return {block:answer?.message ?? t('opencode.errors.executeDenied')};
          }
          return hooks?.beforeTool(p,{signal:signal?.signal}) ?? {};
        },
        afterTool:p=>{if(p.tool==='read')instructions.invalidate(p.sessionID);return hooks?.afterTool(p,{signal:signal?.signal}) ?? {};},
      } });
    await ensureRelay(directory, servers, srv);

    // 「既定」でもモデルを明示して送る。省くと OpenCode は自分の覚えている最後のモデルを使い、画面の「既定」（resolvesTo）と食い違う
    // （利用者の設定の、もう使えないモデルで失敗した。2026-10-18 の実機）
    const ref = adopt ? (card.ref ?? null) : modelRef(model) ?? await defaultModelRef(directory, srv).catch(() => null);
    const data = await providers(directory, srv).catch(() => null);
    const turnKey = sessionKey(sessionId, srv);
    const currentMode = () => liveModes.get(turnKey) ?? mode;
    const currentModel = () => liveModelRefs.get(turnKey) ?? ref;
    const windowTokens = () => modelInfo(data, currentModel())?.limit?.context ?? null;

    // ターンの終わり（session.idle）を待つ口。Stop の Hooks が続けさせたら、もう一度待つ
    let settle;
    let done;
    const arm = () => { done = new Promise((resolve) => { settle = resolve; }); };
    arm();
    // 途中送信は native 発言 ID で確認する。本文が同じでも別の送信を区別する。
    const steers = (card?.steers ?? []).map(x => ({id:x.id ?? null,nativeId:x.nativeId ?? nativeMessageId(x.id,relayAccount)}));
    const children = new Set(card?.children ?? []);
    let delivered = Boolean(card?.delivered);
    let userMessageId = card?.userMessageId ?? nativeMessageId(args.messageId ?? crypto.randomUUID(),relayAccount);
    let since = card?.since ?? null;      // このターンの発言を送った時刻（付け直しは、これより後の発言を組み立て直す）
    let stopRounds = card?.stopRounds ?? 0;
    let aborted = false;
    let limitStop = false;                // 上限の再試行を見て、こちらから止めた（中断ではなく limited で終える）
    let gone = null;
    let replaying = false;
    const asked = new Set();              // 出した承認・質問の id（付け直しで、一覧と出来事の両方から届く）
    let resolveAdmission;
    const compactions=new Map();
    let admitted=Boolean(adopt);
    const initialAdmission=new Promise(resolve=>{resolveAdmission=resolve;});
    if(adopt)resolveAdmission();
    const text = [...notes, String(prompt ?? '')].join('');
    const isPrompt = (_said, messageId) => messageId === userMessageId;

    // 付け直しの組み立て直し（取り直した発言）の出来事は、画面へ出さずに実行中の写しだけを作る（server の makeEmit の replay）
    const out = (event) => emit(event, replaying ? { replay: true } : undefined);
    const mapper = createTurnMapper({
      sessionId, emit: out, windowTokens,
      onUserMessage: ({ messageId, text: said }) => {
        if (!delivered && isPrompt(said, messageId)) { delivered = true; userMessageId = messageId; onPromptDelivered?.(userMessageId); control?.touch?.(); return; }
        const i = steers.findIndex(x => x.nativeId === messageId);
        if (i >= 0) { const [x] = steers.splice(i, 1); if (x.id) out({ type: 'userMessage.delivered', messageId: x.id, nativeId: x.nativeId }); control?.touch?.(); }
      },
      onChild: ({ childId }) => {
        if (children.has(childId) && turnsBySession.get(sessionKey(childId, srv)) === route) return;
        children.add(childId);
        srv.begin(childId);
        rememberSession(childId, account);
        opencodeRelay.alias(childId, sessionId, relayAccount);
        turnsBySession.set(sessionKey(childId, srv), route);
        control?.touch?.();
      },
    });

    // 手を離した後は、このサーバーは OpenCode に何も返さない（承認の答え・中断は新しいサーバーのもの）
    const reply = (path, body) => srv.request('POST', path, { directory, body }).catch((err) => console.error('  opencode: reply failed:', String(err?.message ?? err).slice(0, 200)));
    async function onPermission(p) {
      if (asked.has(p.id)) return;
      asked.add(p.id);
      emit({ type: 'activity', state: 'waiting', label: t('activity.waitingApproval') });
      const patterns = Array.isArray(p.patterns) ? p.patterns : [];
      const answer = await askPermission({
        toolName: String(p.permission ?? 'tool'),
        input: { ...(p.metadata ?? {}), ...(patterns.length ? { patterns } : {}) },
        sessionId,
        toolUseID: p.tool?.callID ?? null,
        title: patterns.length ? `${p.permission}: ${patterns.join(', ')}`.slice(0, 300) : undefined,
        signal: signal?.signal,
        canAlways: Array.isArray(p.always) && p.always.length > 0,
        kind: 'tool',
        questions: null,
      }).catch(() => ({ allow: false }));
      await reply(`/permission/${p.id}/reply`, answer?.allow ? { reply: answer.always ? 'always' : 'once' } : { reply: 'reject', ...(answer?.message ? { message: String(answer.message) } : {}) });
    }
    async function onQuestion(p) {
      if (asked.has(p.id)) return;
      asked.add(p.id);
      emit({ type: 'activity', state: 'waiting', label: t('activity.waitingAnswer') });
      const questions = questionsOf(p.questions);
      const answer = await askPermission({ toolName: 'question', input: {}, sessionId, toolUseID: p.tool?.callID ?? null, signal: signal?.signal, canAlways: false, kind: 'question', questions })
        .catch(() => ({ allow: false }));
      if (!answer?.allow) return reply(`/question/${p.id}/reject`);
      const answers = questions.map((q) => String(answer?.answers?.[q.question] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      await reply(`/question/${p.id}/reply`, { answers });
    }
    function onEvent(event) {
      const p = event.properties ?? {};
      if(event.type==='pleiad.resync'){mapper.resync();return;}
      if(event.type==='pleiad.compaction' && p.sessionID===sessionId) {
        const m=p.message,info=m.info;
        if(compactions.get(info.id)===info.status)return;
        compactions.set(info.id,info.status);
        const phase={running:'start',completed:'complete',failed:'failed'}[info.status];
        if(phase)out({type:'compaction',phase,trigger:info.reason==='auto'?'auto':'manual',nativeId:info.id,...(phase==='complete'?{summary:info.summary ? m.parts.filter(p=>p.type==='text').map(p=>p.text).join(''):''}:{}),...(phase==='failed'?{reason:errorOf(info.error)?.message ?? 'Compaction failed'}:{})});
        return;
      }
      if(event.type==='pleiad.child' && (p.sessionID===sessionId || children.has(p.sessionID))){
        srv.begin(p.childId);
        children.add(p.childId);rememberSession(p.childId,account);opencodeRelay.alias(p.childId,sessionId,relayAccount);
        turnsBySession.set(sessionKey(p.childId,srv),route);void prepareEnvironment(p.childId).catch(err=>{gone=err;settle();});control?.touch?.();return;
      }
      if (event.type === 'pleiad.gone') { gone = p.error; settle(); return; }
      if (event.type === 'permission.asked') { void onPermission(p); return; }
      if (event.type === 'question.asked') { void onQuestion(p); return; }
      // 子の会話の出来事は、承認・質問のほかは親のターンに流さない（サブエージェントの中身は getSubagentMessages で読む）
      if ((p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID) !== sessionId) return;
      if (mapper.handle(event)) settle();
      // 待っても通らない上限の再試行（無料枠・Go の枠など。ADR 0229）。OpenCode は 5 回まで待ち直すので、こちらで止めて limited で終える
      if (mapper.limit && !limitStop && !aborted) {
        limitStop = true;
        srv.request('POST', `/session/${sessionId}/abort`, { directory }).catch(() => settle());
      }
    }
    // 付け直しは、取り直した発言を流し終えるまで出来事を溜める（取り直しと出来事の間に、取りこぼしを作らない）
    let queue = adopt ? [] : null;
    const route = (event) => (queue ? queue.push(event) : onEvent(event));
    turnsBySession.set(turnKey, route);
    liveModes.set(turnKey, mode);
    for (const child of children) { srv.begin(child); rememberSession(child, account); opencodeRelay.alias(child, sessionId, relayAccount); turnsBySession.set(sessionKey(child, srv), route); await prepareEnvironment(child); }
    // 専用のサーバー（Pleiad 担当のコンテキスト）が落ちたら、このターンに知らせる（共有のサーバーの分は全部のターンへ配る）
    const offGone = srv !== server ? srv.onGone((err) => onEvent({ type: 'pleiad.gone', properties: { error: err } })) : null;

    const onAbort = () => {
      aborted = true;
      srv.request('POST', `/session/${sessionId}/abort`, { directory }).catch(() => settle());
    };
    signal?.signal?.addEventListener?.('abort', onAbort, { once: true });

    if (control) {
      control.handle = { sessionId };
      control.steerConfirms = true;
      control.steer = async (item) => {
        await initialAdmission;
        if(!admitted)return false;
        if (signal?.signal?.aborted) return false;
        const said = String(item?.args?.prompt ?? '');
        const nativeId=nativeMessageId(item?.id ?? crypto.randomUUID(),relayAccount);
        steers.push({id:item?.id ?? null,nativeId});
        control.touch?.();
        await srv.request('POST', `/session/${sessionId}/prompt_async`, { directory, signal:signal?.signal, body: { id:nativeId, ...(currentModel() ? { model: currentModel() } : {}), parts: [{ type: 'text', text: said }] } });
        await srv.resync({snapshot:false});
        return true;
      };
    }
    // （付ける前のターンは引き継げないので、短い準備のあいだは切り替えが待つ）
    const bindHeld = () => {
      if (!heldServer) return;
      control.backendCard = () => ({ held: true, account: account ? { id: account.id, dir: account.dir } : null, directory, ref, mode: modeOf(card?.mode ?? mode), since, delivered, userMessageId, stopRounds,
        steers: steers.filter(x => x.id).map(x => ({id:x.id,nativeId:x.nativeId})), children: [...children], runtimes, envFile: envFile?.name ?? null });
      control.holder = {
        label: (c) => heldServer.putCard(sessionId, c),
        // 旧サーバーの手を離す口: 札を置いて保持役へ detach し（全部のターンをまとめて 1 回）、このターンは終える（締めるのは付け直したサーバー）
      };
      control.touch?.();
    };

    try {
      if (adopt) {
        srv.begin(sessionId,since,true);
        bindHeld();
        let snapshot;
        for(;;) {
          try {
            snapshot=await Promise.all([
              srv.request('GET',`/session/${encodeURIComponent(sessionId)}/message`,{directory}),
              srv.request('GET','/session/status',{directory}),
              srv.request('GET','/permission',{directory}),
              srv.request('GET','/question',{directory}),
            ]);
            break;
          }catch(error) {
            if(gone || signal?.signal?.aborted || error.status===401 || error.status===403)throw error;
            await new Promise(resolve=>setTimeout(resolve,500));
          }
        }
        const [list,status,permissions,questions]=snapshot;
        // このターンの発言（送った時刻より後）を組み立て直す。途中の本文は、次の部品の更新まで差分を読まない（溜めた差分と重なる）
        replaying = true;
        try {
          replayV2Messages((list ?? []).filter(m=>since>0 && Number(m.info?.time?.created)>=since),onEvent);
        } finally { replaying = false; }
        mapper.resync();
        const early = queue;
        queue = null;
        for (const event of early) onEvent(event);
        // 答えていない承認・質問を出し直す（承認の id はツールの id から決まるので、前のサーバーと同じカードになる）
        const mine = (p) => p?.sessionID === sessionId || children.has(p?.sessionID);
        for (const p of Array.isArray(permissions) ? permissions : []) if (mine(p)) void onPermission(p);
        for (const p of Array.isArray(questions) ? questions : []) if (mine(p)) void onQuestion(p);
        // 入れ替わりの間に終わっていた
        const state = status?.[sessionId]?.type;
        if (state !== 'busy' && state !== 'retry') {
          const pending=await srv.request('GET',`/api/session/${sessionId}/inbox`);
          if(!Array.isArray(pending?.data))throw new Error('OpenCode v2: invalid inbox response');
          if(!pending.data.length)await srv.resync();
        }
        // 再試行を待っている最中に引き取った。待ちの印（次の再試行の時刻）を出し直し、上限なら止める（ADR 0229）
        else if (state === 'retry') onEvent({ type: 'session.status', properties: { sessionID: sessionId, status: status[sessionId] } });
        control?.onReady?.();
        if (signal?.signal?.aborted) onAbort();
        await done;
      } else {
        // 入力欄の `!` の結果は、返答を起こさない行（noReply）で先に積む（Claude の shouldQuery: false と同じ）
        for (const line of shellAppends) {
          await srv.request('POST', `/session/${sessionId}/message`, { directory, body: { noReply: true, ...(ref ? { model: ref } : {}), parts: [{ type: 'text', text: String(line) }] } });
        }
        // 会話の始めと発言の前の Hooks（SessionStart・UserPromptSubmit）。足す文脈は system に、止める答えなら送らない
        const extra = [];
        if (hooks && fresh) { const c = await hooks.sessionStart({ signal: signal?.signal }); if (c) extra.push(c); }
        if (hooks) {
          const r = await hooks.promptSubmit(String(prompt ?? ''), { signal: signal?.signal });
          if (r.block) {
            emit({ type: 'turnResult', outcome: 'error', error: t('opencode.hooks.promptBlocked', { reason: r.block }) });
            return { sessionId };
          }
          if (r.context) extra.push(r.context);
        }
        const system = [systemText(args), ...extra].filter(Boolean).join('\n\n');
        emit({ type: 'activity', state: 'thinking' });
        const previous=await srv.request('GET',`/session/${sessionId}/delivery/${userMessageId}`);
        since = previous ? new Date(previous.time.created).getTime() : Date.now();
        srv.begin(sessionId,since);
        bindHeld();
        await srv.request('POST', `/session/${sessionId}/prompt_async`, {
          directory,signal:signal?.signal,
          body: {
            id:userMessageId,
            ...(ref ? { model: ref } : {}),
            agent: modeOf(mode) === 'plan' ? 'plan' : 'build',
            ...(effort ? { variant: String(effort) } : {}),
            ...(system ? { system } : {}),
            parts: [{ type: 'text', text }],
          },
        });
        admitted=true;resolveAdmission();
        await srv.resync({snapshot:Boolean(previous)});
        control?.onReady?.();
        if (signal?.signal?.aborted) onAbort();
        await done;
      }
      // 終わりの前の Hooks（Stop）。続けさせる理由なら、それを次の発言として渡して、もう一度終わりを待つ（3 回まで。付け直しをまたいで数える）
      for (; hooks?.has('Stop') && stopRounds < 3 && !aborted && !gone && !mapper.error && !mapper.limit; ) {
        const reason = await hooks.stop(stopRounds > 0, { signal: signal?.signal });
        if (!reason) break;
        stopRounds++;
        control?.touch?.();
        arm();
        await srv.request('POST', `/session/${sessionId}/prompt_async`, { directory,signal:signal?.signal, body: { id:nativeMessageId(`${userMessageId}:stop:${stopRounds}`,relayAccount), ...(currentModel() ? { model: currentModel() } : {}), agent: modeOf(currentMode()) === 'plan' ? 'plan' : 'build', parts: [{ type: 'text', text: reason }] } });
        await srv.resync({snapshot:false});
        await done;
      }
    } catch (err) {
      if (err?.status === 429) {
        emit({ type: 'turnResult', outcome: 'limited', error: String(err.message), pristine: mapper.pristine });
        return { sessionId };
      }
      emit({ type: 'turnResult', outcome: 'error', error: String(err?.message ?? err) });
      throw err;
    } finally {
      resolveAdmission();
      signal?.signal?.removeEventListener?.('abort', onAbort);
      offGone?.();
      if (turnsBySession.get(turnKey) === route) turnsBySession.delete(turnKey);
      liveModes.delete(turnKey);
      liveModelRefs.delete(turnKey);
      for (const child of children) if (turnsBySession.get(sessionKey(child, srv)) === route) turnsBySession.delete(sessionKey(child, srv));
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
      // 手を離したターンは、札も環境変数のファイルも新しいサーバーのもの
      heldServer?.endTurn(sessionId); void envFile?.dispose();
    }
    for (const s of steers) if (s.id) emit({ type: 'userMessage.dropped', messageId: s.id });

    const error = gone ? { message: String(gone.message ?? gone) } : mapper.error;
    // こちらで止めた上限（止めた後に届く MessageAbortedError は中断ではない）。解ける時刻は Go の枠なら next、分からなければ付けない
    if (limitStop && !aborted && !gone) {
      const { message, resetsAt } = mapper.limit;
      emit({ type: 'turnResult', outcome: 'limited', error: message, pristine: mapper.pristine, ...(resetsAt ? { resetsAt } : {}) });
    } else if (aborted || error?.aborted) emit({ type: 'turnResult', outcome: 'aborted' });
    else if (error) emit({ type: 'turnResult', outcome: error.limited ? 'limited' : 'error', error: error.message,
      ...(error.limited ? { pristine: mapper.pristine, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) } : {}),
      ...(error.auth ? { kind: 'auth', pristine: mapper.pristine } : {}) });
    else emit({ type: 'turnResult', outcome: 'ok', costUsd: mapper.usage.costUsd });
    return { sessionId };
    } finally {
      const left = (accountTurns.get(key) ?? 1) - 1;
      if (left) accountTurns.set(key, left); else accountTurns.delete(key);
    }
  },

  /**
   * 付け直し（無停止の更新。opencode-held.mjs）: 保持役の子の共有のサーバーで走っているターンを引き取る。
   * card は runTurn が札に置いた分（control.backendCard）、source は opencode-held.mjs の付け直す元。発言は送らない
   */
  async adoptTurn(args) {
    if (!args.card?.held || !args.source?.held) throw new Error('opencode: the turn was not on the holder');
    return backend.runTurn(args, { card: args.card, source: args.source });
  },

  async compact(args, srv = null) {
    // Pleiad 担当のコンテキストの会話の圧縮も、専用のサーバーで（OpenCode 自身の指示を要約の依頼に混ぜない）
    if (!srv && args.contextRuntime) {
      const dedicated = await managedServer(args.contextRuntime, args.cwd, selectedAccount(args.sessionId, args));
      try { return await backend.compact(args, dedicated); } finally { await dedicated.stop(); }
    }
    const account=selectedAccount(args.sessionId,args);
    srv ??= serverFor(account);
    const { sessionId, emit, cwd, trigger = 'manual' } = args;
    const directory = (await directoryOf(sessionId, srv)) ?? cwd;
    const servers=opencodeRelay.bind(sessionId,{account:account?.id ?? 'login',system:systemText(args),runtimes:relayRuntimes(args),
      context:args.contextRuntime?.owners?.instruction==='ply'?instructionContext(srv,account).context:null,
    });
    await ensureRelay(directory,servers,srv);
    const msgs = await srv.request('GET', `/session/${sessionId}/message`, { directory });
    const last = [...(msgs ?? [])].reverse().find((m) => m.info?.role === 'assistant' && m.info?.providerID);
    const ref = last ? { providerID: last.info.providerID, modelID: last.info.modelID } : await defaultModelRef(directory, srv);
    if (!ref) throw new Error(t('opencode.errors.noModel'));
    emit({ type: 'compaction', phase: 'start', trigger });
    const since=Date.now();
    const usageBefore=await srv.request('GET',`/session/${sessionId}`,{directory});
    let failure=null,summary=null,receipt=null;
    let stopping=null;
    const interrupt=()=>stopping ??= srv.request('POST',`/session/${sessionId}/abort`,{directory}).catch(()=>{});
    const onAbort=()=>{failure=args.signal.signal.reason ?? new Error('Interrupted');if(receipt)void interrupt();};
    args.signal?.signal?.addEventListener('abort',onAbort,{once:true});
    const emitUsage=async()=>{
      let tokens=summary?.info.tokens,cost=summary?.info.cost;
      // v2.0.32 の手動中断は message へ usage を写さない。会話の累計には保存される。
      if(!tokens && summary && usageBefore?.tokens && Number.isFinite(usageBefore.cost)) {
        const after=await srv.request('GET',`/session/${sessionId}`,{directory}).catch(()=>null);
        if(after?.tokens && Number.isFinite(after.cost)) {
          const delta=(a,b)=>Math.max(0,(a??0)-(b??0));
          tokens={input:delta(after.tokens.input,usageBefore.tokens.input),output:delta(after.tokens.output,usageBefore.tokens.output),reasoning:delta(after.tokens.reasoning,usageBefore.tokens.reasoning),cache:{read:delta(after.tokens.cache?.read,usageBefore.tokens.cache?.read)}};
          cost=delta(after.cost,usageBefore.cost);
        }
      }
      if(!tokens)return;
      emit({type:'usage',inputTokens:(tokens.input??0)+(tokens.cache?.read??0),outputTokens:(tokens.output??0)+(tokens.reasoning??0),cachedTokens:tokens.cache?.read??0,costUsd:cost??0});
    };
    const offGone=srv.onGone(error=>{failure=error;});
    let limitStop = false;
    const onEvent = (event) => {
      if (event.type === 'pleiad.gone') failure = event.properties.error;
      if (event.type === 'session.error' && !limitStop) failure = errorOf(event.properties.error);
      // 要約の依頼も上限で再試行を待つ（ADR 0229）。待ちを画面に出し、待っても通らない上限なら止めて、その理由で失敗にする
      const status = event.properties?.status;
      if (event.type === 'session.status' && status?.type === 'retry') {
        const retry = retryOf(status);
        emit({ type: 'activity', state: 'retrying', retry: { attempt: retry.attempt, next: retry.next, message: retry.message, reason: retry.reason, limit: retry.limit } });
        if (retry.definite && !limitStop) {
          limitStop = true;
          failure = { message: retry.message || 'usage limit' };
          void interrupt();
        }
      } else if (event.type === 'session.status' && status?.type === 'busy') emit({ type: 'activity', state: 'compacting' });
    };
    turnsBySession.set(sessionKey(sessionId, srv), onEvent);
    try {
      receipt=await srv.request('POST',`/session/${sessionId}/summarize`,{directory,body:{id:nativeMessageId(crypto.randomUUID(),srv.relayAccount ?? 'login')},timeoutMs:15*60_000});
      if(!receipt?.id)throw new Error('OpenCode v2: compaction admission returned no ID');
      if(args.signal?.signal?.aborted)onAbort();
      const until=since+10*60_000;
      while(Date.now()<until) {
        const rows=await srv.request('GET',`/session/${sessionId}/message`,{directory});
        const current=rows.find(m=>m.info.id===receipt.id && m.info.type==='compaction');
        if(current?.info.status==='failed'){summary=current;throw errorOf(current.info.error) ?? new Error('OpenCode compaction failed');}
        if(current?.info.status==='completed'){summary=current;break;}
        if(failure)throw failure;
        if(args.signal?.signal?.aborted)throw args.signal.signal.reason ?? new Error('Interrupted');
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(!summary)throw new Error('OpenCode compaction did not finish before the timeout');
    } catch(error) {
      if(receipt?.id && !summary) {
        await interrupt();
        // interrupt の受付は圧縮の cleanup より早い。終端の課金が保存されるまで待つ。
        const until=Date.now()+30000;
        do {
          const rows=srv.running?await srv.request('GET',`/session/${sessionId}/message`,{directory}).catch(()=>[]):messagesFromDb(sessionId,account)??[];
          summary=rows.find(m=>m.info.id===receipt.id && m.info.type==='compaction' && ['completed','failed'].includes(m.info.status));
          if(summary || !srv.running)break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }while(Date.now()<until);
      }
      await emitUsage();
      emit({type:'compaction',phase:'failed',trigger,reason:String(error.message ?? error)});
      return;
    } finally {
      args.signal?.signal?.removeEventListener('abort',onAbort);
      offGone();
      if(turnsBySession.get(sessionKey(sessionId,srv))===onEvent)turnsBySession.delete(sessionKey(sessionId,srv));
    }
    await emitUsage();
    const text = (summary?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
    emit({ type: 'compaction', phase: 'complete', trigger, ...(text ? { summary: text } : {}), ...(summary?.info?.id ? { nativeId: summary.info.id } : {}) });
  },

  // ---- セッション管理 -----------------------------------------------------

  async listSessions({ limit = 100, account = null } = {}) {
    const srv = serverFor(account);
    // サーバーが動いていなければ、起こさずに会話の DB から読む（Pleiad で作った会話は Pleiad の控えからも一覧に出る）
    const rows = srv.running ? await srv.request('GET', '/experimental/session', { query: { roots: true, limit } }) : sessionsFromDb({ limit, account });
    if(rows===null)throw new Error('Cannot read the OpenCode conversation database');
    const list = Array.isArray(rows) ? rows : rows?.data ?? [];
    for (const s of list) if (s?.id) { rememberSession(s.id, account); if (s.directory) directories.set(sessionKey(s.id, srv), s.directory); }
    return list.filter((s) => !s.parentID).map(sessionRow).filter(Boolean).map(s => ({ ...s, ...(account ? { accountId: account.id } : {}) }));
  },

  async getSession(sessionId, options = {}) {
    if (!sessionId || !/^ses_/.test(sessionId)) return null;
    const account = selectedAccount(sessionId, options), srv = serverFor(account);
    if (!srv.running) {
      const [row] = sessionsFromDb({ id: sessionId, account }) ?? [];
      if (row) rememberSession(row.id, account);
      if (row?.directory) directories.set(sessionKey(row.id, srv), row.directory);
      return sessionRow(row ?? null);
    }
    const s = await srv.request('GET', `/session/${encodeURIComponent(sessionId)}`, { directory: directories.get(sessionKey(sessionId, srv)) ?? null }).catch(() => null);
    if (s) rememberSession(s.id, account);
    if (s?.directory) directories.set(sessionKey(s.id, srv), s.directory);
    return sessionRow(s);
  },

  async getMessages(sessionId, options = {}) {
    if (!sessionId) return [];
    const account = selectedAccount(sessionId, options), srv = serverFor(account);
    // サーバーが動いていなければ、起こさずに会話の DB から読む（全文検索の索引作りが全部の会話を読むので、起動のたびに起きていた）
    if (!srv.running) {
      const stored = messagesFromDb(sessionId, account);
      if (stored) return messagesToNormalized(stored, options);
    }
    const directory = await directoryOf(sessionId, srv);
    const list = await srv.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory });
    rememberSession(sessionId, account);
    return messagesToNormalized(list, options);
  },

  async setTitle(sessionId, title, options = {}) {
    const srv = serverFor(selectedAccount(sessionId, options));
    const directory = await directoryOf(sessionId, srv);
    await srv.request('PATCH', `/session/${encodeURIComponent(sessionId)}`, { directory, body: { title: String(title ?? '') } });
  },

  async fork(sessionId, options = {}) {
    const { upToMessageId, title } = options;
    const account = selectedAccount(sessionId, options), srv = serverFor(account);
    const directory = await directoryOf(sessionId, srv);
    const list = await srv.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory });
    const ids = (list ?? []).map((m) => m.info?.id);
    let body = {};
    if (upToMessageId) {
      const at = ids.indexOf(upToMessageId);
      if (at < 0) throw new Error(t('opencode.errors.forkMissing'));
      // OpenCode の fork は渡した発言の手前までを写す。その発言までを含めるので、次の発言の id を渡す（最後なら全部）
      if (at + 1 < ids.length) body = { messageID: ids[at + 1] };
    }
    const created = await srv.request('POST', `/session/${encodeURIComponent(sessionId)}/fork`, { directory, body });
    rememberSession(created.id, account);
    if (created?.directory) directories.set(sessionKey(created.id, srv), created.directory);
    if (title) await srv.request('PATCH', `/session/${created.id}`, { directory, body: { title: String(title) } }).catch(() => {});
    return { sessionId: created.id, ...(account ? { accountId: account.id } : {}) };
  },

  async listSubagents(sessionId, options = {}) {
    const account = selectedAccount(sessionId, options), srv = serverFor(account);
    const directory = await directoryOf(sessionId, srv);
    const kids = await srv.request('GET', `/session/${encodeURIComponent(sessionId)}/children`, { directory }).catch(() => []);
    for (const k of kids ?? []) rememberSession(k.id, account);
    return (kids ?? []).map((k) => k.id).filter(Boolean);
  },

  async getSubagentMessages(sessionId, agentId, options = {}) {
    const { limit } = options;
    const srv = serverFor(selectedAccount(sessionId, options));
    const directory = await directoryOf(sessionId, srv);
    const list = await srv.request('GET', `/session/${encodeURIComponent(agentId)}/message`, { directory }).catch(() => []);
    const messages = messagesToNormalized(list);
    return Number.isFinite(limit) ? messages.slice(-limit) : messages;
  },

  async getSubagentOrigin(sessionId, agentId, options = {}) {
    const srv = serverFor(selectedAccount(sessionId, options));
    const directory = await directoryOf(sessionId, srv);
    const list = await srv.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory }).catch(() => []);
    for (const m of list ?? []) for (const p of m.parts ?? []) if (p.type === 'tool' && ['task','subagent'].includes(p.tool) && p.state?.metadata?.sessionId === agentId) return String(p.callID ?? p.id);
    return null;
  },

  // ---- 認証 ---------------------------------------------------------------

  auth: {
    /** ログインしているか。OpenCode の無料のモデル（opencode）はログイン無しで使えるので、サーバーが答えればログイン済みとして、つないだ接続先を出す */
    async status() {
      if (!cliCommand('opencode')) return { loggedIn: false, account: null, detail: t('opencode.errors.notInstalled') };
      // サーバーが動いていなければ、起こさずに資格情報のファイルの接続先の名前だけで答える
      if (!server.running) {
        const connected = connectedFromFile();
        return { loggedIn: true, account: connected.join(', ') || t('opencode.auth.freeOnly'), detail: t('opencode.auth.detail') };
      }
      try {
        const data = await server.request('GET', '/provider');
        const connected = (data?.connected ?? []).map((id) => (data?.all ?? []).find((p) => p.id === id)?.name ?? id);
        return { loggedIn: true, account: connected.join(', ') || t('opencode.auth.freeOnly'), detail: t('opencode.auth.detail') };
      } catch (err) {
        return { loggedIn: false, account: null, detail: String(err?.message ?? err).slice(0, 200) };
      }
    },
    /** 接続先のログイン。OpenCode の接続先ごとの認可は端末の `opencode auth login` で選ぶので、そのコマンドを案内し、つないだ接続先が増えるまで待つ */
    async login({ emit }) {
      if(accountBusy(null))throw new Error(t('accounts.backend.inUse',{agent:'OpenCode'}));
      const argv = cliCommand('opencode');
      if (!argv) throw new Error(t('opencode.errors.notInstalled'));
      const command = [...argv, 'auth', 'login'].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      emit?.({ type: 'auth', phase: 'url', url: command, message: t('opencode.auth.runCommand') });
      const until = Date.now() + LOGIN_TIMEOUT_MS;
      let seen = authStamp();
      const watch = loginWatch.begin();
      try {
        while (Date.now() < until) {
          await watch.pause(LOGIN_POLL_MS);
          // 資格情報は OpenCode が auth.json に書く。走っているサーバーは読み直さないので、ファイルが変わったときだけ起こし直して確かめる
          // （サーバーは 1 本で約 760 MB。見張りのたびには起こさない）
          const stamp = authStamp();
          if (stamp === seen) continue;
          seen = stamp;
          providersCache = null;
          await server.stop();
          const now = ((await server.request('GET', '/provider').catch(() => null))?.connected) ?? [];
          watch.check();
          if (now.length) { emit?.({ type: 'auth', phase: 'done', message: t('opencode.auth.loggedIn') }); return; }
        }
      } finally { watch.end(); }
      const message = t('opencode.auth.loginTimeout');
      emit?.({ type: 'auth', phase: 'error', code: 'TIMEOUT', message });
      throw loginTimeoutError(message);
    },
    /** 待っているログインをやめる（見張りを止める）。login は CANCELLED で返る */
    async cancel() { return loginWatch.cancel(); },
    async logout() {
      throw new Error(t('opencode.auth.logoutInCli'));
    },
  },
};

/** 試験用: 共有のサーバーを止める（tests/unit/server-opencode.mjs） */
export const stopOpencodeServer = () => Promise.all([server, ...accountServers.values()].map(s => s.stop()));
/** 中継の口に結び付けるサーバー名（試験が見る） */
export const OPENCODE_RELAY_SERVERS = Object.keys(RELAY_SERVERS);
