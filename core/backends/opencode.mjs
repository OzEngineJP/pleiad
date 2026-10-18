// OpenCode（`opencode serve`）のバックエンド（docs/multi-backend.md §2.10）。
//
// - Pleiad のサーバーにつき共有の `opencode serve` を 1 本（opencode-server.mjs）。作業場所は `?directory=` で選ぶ
// - ターン: POST /session/{id}/prompt_async で送り、`/global/event` の出来事を正規化して流す（opencode-normalize.mjs）。
//   session.idle でターンの終わり
// - 承認: permission.asked / question.asked を askPermission に渡し、POST /permission|question/{id}/reply で返す
// - 承認モード: 会話の権限の規則（最後に一致したものが勝つ）。モードを替えたときだけ PATCH で後ろに足す
// - Pleiad の MCP（委譲・操作の一覧・コンピューター・ブラウザー）: 作業場所の instance に中継（core/opencode-relay.mjs）の口を POST /mcp で足し、
//   会話をそのターンの口に結び付ける。Pleiad の指示は prompt の system で毎ターン渡す
// - 無停止の更新: 共有のサーバーは保持役の子（opencode-held.mjs）。ターンは札（control.backendCard）を置き、引き継ぎでは手を離す（control.holder.handOff）。
//   新しいサーバーは adoptTurn で、会話の発言・答えていない承認と質問・会話の状態を OpenCode に聞き直して、走っているターンを組み立て直す
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.mjs';
import { loadSqlite } from '../db.mjs';
import { cliCommand } from '../cli-installation.mjs';
import * as store from '../store.mjs';
import { opencodeRelay, RELAY_SERVERS } from '../opencode-relay.mjs';
import { createOpencodeServer } from './opencode-server.mjs';
import { createTurnMapper, messagesToNormalized, sessionRow, errorOf } from './opencode-normalize.mjs';
import { writePlugin } from './opencode-plugin.mjs';
import { createHookRunner } from './opencode-hooks.mjs';
import { configureOpencodeHeld, acquireHeldOpencode, heldOpencode, writeOpencodeEnvFile, adoptOpencodeEnvFile } from './opencode-held.mjs';
import { promptHash } from '../turn-card.mjs';
import { computerPrompt } from './computer-delivery.mjs';
import { undelivered } from './undelivered.mjs';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_MS = 3_000;
/** 1 つの接続先の候補をそのまま全部出す上限。超える接続先（OpenRouter など）は既定と設定に書いたモデルだけ出す */
const PROVIDER_MODELS_MAX = 40;

const hint = (key, shape) => ({ get label() { return t(`tools.${key}`); }, shape });
const TOOL_HINTS = {
  bash: hint('run', 'shell'),
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
};

// ---- 承認モード（会話の権限の規則。最初に `*` を置いて、それより前に足した規則を上書きする）
const rule = (permission, action, pattern = '*') => ({ permission, pattern, action });
const READS = ['read', 'glob', 'grep', 'list', 'lsp', 'todoread', 'todowrite', 'skill', 'question', 'task'];
const RULES = {
  ask: [rule('*', 'ask'), ...READS.map((p) => rule(p, 'allow'))],
  edit: [rule('*', 'ask'), ...READS.map((p) => rule(p, 'allow')), rule('edit', 'allow')],
  // 作業場所の中は聞かない。外は断る（聞かない約束のモードで、外へ出るときだけ聞くことはしない）
  full: [rule('*', 'allow'), rule('external_directory', 'deny'), rule('doom_loop', 'allow')],
  yolo: [rule('*', 'allow'), rule('external_directory', 'allow'), rule('doom_loop', 'allow')],
  plan: [rule('*', 'ask'), ...READS.map((p) => rule(p, 'allow')), rule('edit', 'deny')],
};
const MODES = {
  ask: { get label() { return t('modes.ask'); }, get short() { return t('modesShort.ask'); }, get note() { return t('opencode.modes.ask'); }, scope: 'workspace', autonomy: 'ask', enforced: true },
  edit: { get label() { return t('modes.acceptEdits'); }, get short() { return t('modesShort.acceptEdits'); }, get note() { return t('opencode.modes.edit'); }, scope: 'workspace', autonomy: 'judge', enforced: true },
  full: { get label() { return t('modes.full'); }, get short() { return t('modesShort.full'); }, get note() { return t('opencode.modes.full'); }, scope: 'workspace', autonomy: 'never', enforced: true },
  yolo: { label: 'YOLO', get note() { return t('opencode.modes.yolo'); }, scope: 'full', autonomy: 'never', enforced: false },
  plan: { get label() { return t('modes.plan'); }, get short() { return t('modesShort.plan'); }, get note() { return t('opencode.modes.plan'); }, scope: 'readonly', autonomy: 'ask', enforced: true },
};
const vocab = ({ label, short, note, scope, autonomy, enforced }) => ({ label, ...(short ? { short } : {}), note, scope, autonomy, enforced });
const modeOf = (mode) => (Object.hasOwn(MODES, mode) ? mode : 'ask');

// ---- 共有のサーバー
const directories = new Map();   // 会話の id -> 作業場所（OpenCode の instance を選ぶ ?directory=）
const appliedMode = new Map();   // 会話の id -> 最後に入れた承認モード（同じなら PATCH しない。規則は後ろに足していく形なので）
const turnsBySession = new Map(); // 会話の id（と子の会話の id） -> 走っているターンの受け口
let providersCache = null;       // { at, data }（/config/providers）

// 保持役に載せたとき、前のサーバーの子を引き継いだら、中継の合言葉を前の値にし、付け直すターンの会話の呼び出しを結び付けるまで待たせる
configureOpencodeHeld({
  dataDir: () => store.dataDir,
  adopt: (srv, turns) => {
    opencodeRelay.adoptSecret(srv?.secret);
    const children = {};
    for (const [sessionId, card] of Object.entries(turns ?? {})) {
      for (const child of card?.backendCard?.children ?? []) children[child] = sessionId;
      if (card?.backendCard?.directory) directories.set(sessionId, card.backendCard.directory);
    }
    opencodeRelay.expect(Object.keys(turns ?? {}), children);
  },
  forget: (sessionId) => opencodeRelay.unexpect(sessionId),
});

const server = createOpencodeServer({
  command: () => cliCommand('opencode'),
  held: { acquire: acquireHeldOpencode },
  origin: () => opencodeRelay.whenOrigin(),
  currentOrigin: () => opencodeRelay.origin(),
  // 走っているターン・付け直すのを待っているターンがあれば、待ち受けが変わっても起こし直さない
  busy: () => turnsBySession.size > 0 || (heldOpencode()?.cards.size ?? 0) > 0,
  env: async () => {
    // 中継の口（プラグインの shell.env が会話の環境変数を取る先）は Pleiad の待ち受けが決まってから
    await opencodeRelay.whenOrigin();
    const plugin = writePlugin(store.dataDir);
    return {
      // 利用者の opencode.json は書き換えずに、Pleiad のプラグインだけを足す。Pleiad が起こした OpenCode は勝手に自分を更新しない（ADR 0037）
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [plugin], autoupdate: false }),
      PLEIAD_OPENCODE_ENV_URL: opencodeRelay.envUrl(),
      PLEIAD_OPENCODE_HOOK_URL: opencodeRelay.hookUrl(),
      PLEIAD_OPENCODE_SECRET: opencodeRelay.secret,
    };
  },
});

// 出来事は 1 本の流れで全部来る。会話の id で、走っているターンへ配る
server.subscribe((event) => {
  const sid = event.properties?.sessionID ?? event.properties?.info?.sessionID ?? event.properties?.part?.sessionID;
  if (!sid) return;
  turnsBySession.get(sid)?.(event);
});
server.onGone((err) => { for (const fn of new Set(turnsBySession.values())) fn({ type: 'pleiad.gone', properties: { error: err } }); });

async function directoryOf(sessionId) {
  if (directories.has(sessionId)) return directories.get(sessionId);
  const s = await server.request('GET', `/session/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (s?.directory) directories.set(sessionId, s.directory);
  return s?.directory ?? null;
}

async function providers(cwd) {
  if (providersCache && Date.now() - providersCache.at < 60_000) return providersCache.data;
  const data = await server.request('GET', '/config/providers', { directory: cwd || null });
  providersCache = { at: Date.now(), data };
  return data;
}

/** OpenCode の資格情報のファイル（auth.json）の更新時刻。無ければ 0（OpenCode の置き場は XDG_DATA_HOME、無ければ ~/.local/share/opencode） */
function authStamp() {
  try { return fs.statSync(path.join(opencodeData(), 'auth.json')).mtimeMs; } catch { return 0; }
}

/** OpenCode のデータの置き場（会話の DB・資格情報）。AGENT_HOST_OPENCODE_DATA で差し替える（試験は一時の場所へ向け、利用者の本物を読まない） */
function opencodeData() {
  return process.env.AGENT_HOST_OPENCODE_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
}

/**
 * サーバーが動いていないときの会話の行。OpenCode の会話の DB（opencode.db の session の表）を読み取りだけで開く。
 * 一覧を作るたびに約 760 MB のサーバーを起こさないため（画面を開いただけで起きていた）。読めなければ null
 */
function sessionsFromDb({ limit = 100, id = null } = {}) {
  const file = path.join(opencodeData(), 'opencode.db');
  if (!fs.existsSync(file)) return [];
  let db = null;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
    const cols = 'id, parent_id, directory, title, time_created, time_updated';
    const rows = id
      ? db.prepare(`select ${cols} from session where id = ?`).all(id)
      : db.prepare(`select ${cols} from session where parent_id is null and time_archived is null order by time_updated desc limit ?`).all(limit);
    return rows.map((r) => ({ id: r.id, parentID: r.parent_id ?? undefined, directory: r.directory, title: r.title, time: { created: Number(r.time_created), updated: Number(r.time_updated) } }));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** サーバーが動いていないときの会話の発言（message・part の表。中身は API の返りと同じ JSON）。読めなければ null */
function messagesFromDb(sessionId) {
  const file = path.join(opencodeData(), 'opencode.db');
  if (!fs.existsSync(file)) return null;
  let db = null;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
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
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(opencodeData(), 'auth.json'), 'utf8')) ?? {}); } catch { return []; }
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
async function defaultModelRef(cwd) {
  const config = await server.request('GET', '/config', { directory: cwd || null }).catch(() => null);
  const ref = modelRef(config?.model);
  if (ref) return ref;
  const data = await providers(cwd).catch(() => null);
  const def = data?.default ?? {};
  const providerID = def.opencode ? 'opencode' : Object.keys(def)[0];
  return providerID ? { providerID, modelID: def[providerID] } : null;
}

/** モデルの一覧（"" は OpenCode の既定に従う）。エフォートはモデルの variants */
async function listModels(cwd) {
  const data = await providers(cwd);
  const config = await server.request('GET', '/config', { directory: cwd || null }).catch(() => null);
  const configured = new Set(Object.entries(config?.provider ?? {}).flatMap(([pid, p]) => Object.keys(p?.models ?? {}).map((m) => `${pid}/${m}`)));
  const def = await defaultModelRef(cwd).catch(() => null);
  const out = { '': { get label() { return t('opencode.models.default'); }, note: def ? `${def.providerID}/${def.modelID}` : '', ...(def ? { resolvesTo: `${def.providerID}/${def.modelID}` } : {}), efforts: [], defaultEffort: null } };
  for (const p of data?.providers ?? []) {
    const models = Object.entries(p.models ?? {});
    const keep = models.length <= PROVIDER_MODELS_MAX ? models
      : models.filter(([id]) => id === data?.default?.[p.id] || configured.has(`${p.id}/${id}`) || (def && def.providerID === p.id && def.modelID === id));
    for (const [id, m] of keep) {
      const efforts = Object.keys(m?.variants ?? {});
      out[`${p.id}/${id}`] = { label: m?.name || id, note: p.name || p.id, efforts, defaultEffort: null };
    }
  }
  return out;
}

/** Pleiad の MCP を、この作業場所の instance に足す（まだ足していない・つながっていないものだけ） */
async function ensureRelay(cwd, servers) {
  if (!servers.length) return;
  const status = await server.request('GET', '/mcp', { directory: cwd }).catch(() => ({}));
  for (const name of servers) {
    if (status?.[name]?.status === 'connected') continue;
    await server.request('POST', '/mcp', { directory: cwd, body: { name, config: { type: 'remote', url: opencodeRelay.serverUrl(name), headers: { Authorization: `Bearer ${opencodeRelay.secret}` }, enabled: true } } })
      .catch((err) => console.error(`  opencode: could not add ${name}:`, String(err?.message ?? err).slice(0, 200)));
  }
}

/** Pleiad の指示（委譲・可視化・ブラウザー・コンピューター・操作の一覧・秘密情報・Pleiad が足した文・bot の人格）。毎ターン system で渡す */
function systemText({ agentRuntime, visualizeInstructions, browserInstructions, computerRuntime, controlRuntime, secretsRuntime, addedInstructions, botInstructions, locale }) {
  return [
    agentRuntime?.instructions, visualizeInstructions, browserInstructions,
    computerPrompt(computerRuntime, { locale, agent: 'opencode' }), controlRuntime?.instructions, secretsRuntime?.instructions, addedInstructions, botInstructions,
  ].filter(Boolean).join('\n\n');
}

/** 会話のシェルへ渡す環境変数（ブラウザー・操作の一覧・秘密情報。プラグインの shell.env が取る） */
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

  capabilities: {
    title: true,            // PATCH /session/{id} { title }。OpenCode の TUI と共有する
    tag: false,             // 状態タグは無い -> Pleiad の控えが正本
    fork: true,             // POST /session/{id}/fork { messageID }（その発言の手前まで写す。発言の id は振り直される）
    forkMessage: true,      // 発言の次の id を渡せば、その発言までを含めて写せる
    rewind: false,          // revert はファイルの変更まで戻すので使わない -> Pleiad の写しで戻す
    subagents: true,        // task のツールが作る子の会話（/session/{id}/children）
    liveModel: false,
    liveMode: false,
    hostTools: false,
    approvals: 'interactive',
    alwaysAllow: true,      // reply: always（OpenCode が出す always のパターンで、この会話の間）
    mcpApproval: 'agent',   // MCP のツールも権限の規則（*）を通り、OpenCode が聞く
    login: true,            // 端末で opencode auth login を案内して待つ
    claudeAccounts: false,
    compatEndpoints: false,
    compact: true,          // POST /session/{id}/summarize
    autoCompactWindow: false,
    promptSuggestions: false,
    plyAgents: true,        // ply_agents を中継の口で渡し、指示を system に入れる
    plyContext: false,      // Pleiad 担当のコンテキスト（ply_context）はまだ渡さない（OpenCode の設定がそのまま効く）
    computerUse: { images: 'inline', waitSliceMs: null },
    shell: 'host',          // 入力欄の `!` は Pleiad が走らせ、次のターンの始めに返答を起こさない行（noReply）で渡す
    effortInModelId: false, // エフォートはモデルの variants（prompt の variant）
    instructionsAtStart: false,
    failureDiagnostics: false,
    handover: true,         // 共有のサーバーを保持役に載せ、新しいサーバーがつなぎ直して付け直す（opencode-held.mjs）
  },

  subagentTools: ['task'],
  toolHints: TOOL_HINTS,

  modes: () => Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, vocab(m)])),
  models: (cwd) => listModels(cwd),

  // ---- 実行 ---------------------------------------------------------------

  /**
   * adopt は付け直し（{ card, source }。adoptTurn だけが渡す。無停止の更新）。card は前のサーバーが札に置いた欄（control.backendCard）。
   * 発言は送らず、会話の発言・承認・質問・状態を OpenCode に聞き直して続きを受ける
   */
  async runTurn(args, adopt = null) {
    const { prompt, cwd, mode, model, effort, emit, onPromptDelivered, askPermission, signal, control, notes = [], shellAppends = [] } = args;
    let sessionId = args.sessionId ?? null;
    const card = adopt?.card ?? null;
    const permission = RULES[modeOf(mode)];
    let fresh = false;
    try {
      await server.ensure();
      if (adopt) {
        // 会話も作業場所も承認モードの規則も、前のサーバーのまま
        if (card.directory) directories.set(sessionId, card.directory);
        if (card.mode) appliedMode.set(sessionId, card.mode);
      } else if (!sessionId) {
        const created = await server.request('POST', '/session', { directory: cwd, body: { permission } });
        sessionId = created.id;
        directories.set(sessionId, created.directory ?? cwd);
        appliedMode.set(sessionId, modeOf(mode));
        fresh = true;
        emit({ type: 'session', sessionId, first: true, ...(model ? { model } : {}) });
      } else {
        emit({ type: 'session', sessionId, ...(model ? { model } : {}) });
      }
    } catch (err) {
      emit({ type: 'turnResult', outcome: 'error', error: String(err?.code === 'NOT_INSTALLED' ? t('opencode.errors.notInstalled') : err?.message ?? err) });
      throw undelivered(err);
    }
    const directory = (await directoryOf(sessionId)) ?? cwd;
    if (!adopt && appliedMode.get(sessionId) !== modeOf(mode)) {
      await server.request('PATCH', `/session/${sessionId}`, { directory, body: { permission } });
      appliedMode.set(sessionId, modeOf(mode));
    }
    // Pleiad がそろえる Hooks（hooksRuntime。ADR 0049）。Claude Code の形で、Pleiad の中で走らせる（core/backends/opencode-hooks.mjs）
    const hooks = args.hooksRuntime
      ? createHookRunner(args.hooksRuntime, { onRun: (run) => emit({ type: 'hookRun', ...run }), base: { session_id: sessionId, cwd: directory } })
      : null;
    // 保持役に載せた共有のサーバー（無停止の更新）。会話のシェルの環境変数は札に入れず、データ置き場のファイルに置く（付け直す側が読む）
    const heldServer = control ? server.held : null;
    const envFile = !heldServer ? null : adopt ? await adoptOpencodeEnvFile(store.dataDir, card.envFile) : await writeOpencodeEnvFile(store.dataDir, shellEnv(args)).catch(() => null);
    // Pleiad の MCP・会話のシェルの環境変数・ツールの前後の Hooks を、この会話に結び付ける（付け直しは、札の口とファイルの環境変数で結び直す）
    const runtimes = adopt ? (card.runtimes ?? {}) : relayRuntimes(args);
    const servers = opencodeRelay.bind(sessionId, { runtimes, env: adopt ? (envFile?.vars ?? {}) : shellEnv(args),
      hooks: hooks ? { beforeTool: (p) => hooks.beforeTool(p, { signal: signal?.signal }), afterTool: (p) => hooks.afterTool(p, { signal: signal?.signal }) } : null });
    if (!adopt) await ensureRelay(directory, servers);

    // 「既定」でもモデルを明示して送る。省くと OpenCode は自分の覚えている最後のモデルを使い、画面の「既定」（resolvesTo）と食い違う
    // （利用者の設定の、もう使えないモデルで失敗した。2026-10-18 の実機）
    const ref = adopt ? (card.ref ?? null) : modelRef(model) ?? await defaultModelRef(directory).catch(() => null);
    const data = await providers(directory).catch(() => null);
    const windowTokens = () => modelInfo(data, ref)?.limit?.context ?? null;

    // ターンの終わり（session.idle）を待つ口。Stop の Hooks が続けさせたら、もう一度待つ
    let settle;
    let done;
    const arm = () => { done = new Promise((resolve) => { settle = resolve; }); };
    arm();
    // { id, text, hash } 途中送信で渡したもの（自分の発言として会話に入ったら「渡った」）。付け直したものは本文を持たず、ハッシュで照らす
    const steers = (card?.steers ?? []).map((x) => ({ id: x.id ?? null, text: null, hash: x.hash ?? null }));
    const children = new Set(card?.children ?? []);
    let delivered = Boolean(card?.delivered);
    let userMessageId = card?.userMessageId ?? null;
    let since = card?.since ?? null;      // このターンの発言を送った時刻（付け直しは、これより後の発言を組み立て直す）
    let stopRounds = card?.stopRounds ?? 0;
    let aborted = false;
    let gone = null;
    let handedOff = false;
    let replaying = false;
    const asked = new Set();              // 出した承認・質問の id（付け直しで、一覧と出来事の両方から届く）
    const text = [...notes, String(prompt ?? '')].join('');
    const isPrompt = (said, messageId) => (adopt
      ? (userMessageId ? messageId === userMessageId : !steers.some((x) => x.hash === promptHash(said)))
      : said.includes(String(prompt ?? '').slice(0, 200)));

    // 付け直しの組み立て直し（取り直した発言）の出来事は、画面へ出さずに実行中の写しだけを作る（server の makeEmit の replay）
    const out = (event) => emit(event, replaying ? { replay: true } : undefined);
    const mapper = createTurnMapper({
      sessionId, emit: out, windowTokens,
      onUserMessage: ({ messageId, text: said }) => {
        if (!delivered && isPrompt(said, messageId)) { delivered = true; userMessageId = messageId; onPromptDelivered?.(); control?.touch?.(); return; }
        const i = steers.findIndex((x) => (x.text != null ? said.includes(x.text.slice(0, 200)) : x.hash === promptHash(said)));
        if (i >= 0) { const [x] = steers.splice(i, 1); if (x.id) out({ type: 'userMessage.delivered', messageId: x.id }); control?.touch?.(); }
      },
      onChild: ({ childId }) => {
        if (children.has(childId) && turnsBySession.get(childId) === route) return;
        children.add(childId);
        opencodeRelay.alias(childId, sessionId);
        turnsBySession.set(childId, route);
        control?.touch?.();
      },
    });

    // 手を離した後は、このサーバーは OpenCode に何も返さない（承認の答え・中断は新しいサーバーのもの）
    const reply = (path, body) => (handedOff ? null : server.request('POST', path, { directory, body }).catch((err) => console.error('  opencode: reply failed:', String(err?.message ?? err).slice(0, 200))));
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
      if (event.type === 'pleiad.gone') { gone = p.error; settle(); return; }
      if (event.type === 'permission.asked') { void onPermission(p); return; }
      if (event.type === 'question.asked') { void onQuestion(p); return; }
      // 子の会話の出来事は、承認・質問のほかは親のターンに流さない（サブエージェントの中身は getSubagentMessages で読む）
      if ((p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID) !== sessionId) return;
      if (mapper.handle(event)) settle();
    }
    // 付け直しは、取り直した発言を流し終えるまで出来事を溜める（取り直しと出来事の間に、取りこぼしを作らない）
    let queue = adopt ? [] : null;
    const route = (event) => (queue ? queue.push(event) : onEvent(event));
    turnsBySession.set(sessionId, route);
    for (const child of children) { opencodeRelay.alias(child, sessionId); turnsBySession.set(child, route); }

    const onAbort = () => {
      if (handedOff) return;
      aborted = true;
      server.request('POST', `/session/${sessionId}/abort`, { directory }).catch(() => settle());
    };
    signal?.signal?.addEventListener?.('abort', onAbort, { once: true });

    if (control) {
      control.handle = { sessionId };
      control.steerConfirms = true;
      control.steer = async (item) => {
        if (signal?.signal?.aborted) return false;
        const said = String(item?.args?.prompt ?? '');
        steers.push({ id: item?.id ?? null, text: said, hash: promptHash(said) });
        control.touch?.();
        await server.request('POST', `/session/${sessionId}/prompt_async`, { directory, body: { ...(ref ? { model: ref } : {}), parts: [{ type: 'text', text: said }] } });
        return true;
      };
    }

    // 保持役の札と、引き継ぎで手を離す口（server の takeCard・handoverRun が使う）。発言を送る直前に付ける
    // （付ける前のターンは引き継げないので、短い準備のあいだは切り替えが待つ）
    const bindHeld = () => {
      if (!heldServer) return;
      control.backendCard = () => ({ held: true, directory, ref, mode: modeOf(card?.mode ?? mode), since, delivered, userMessageId, stopRounds,
        steers: steers.filter((x) => x.id).map((x) => ({ id: x.id, hash: x.hash })), children: [...children], runtimes, envFile: envFile?.name ?? null });
      control.holder = {
        label: (c) => heldServer.putCard(sessionId, c),
        // 旧サーバーの手を離す口: 札を置いて保持役へ detach し（全部のターンをまとめて 1 回）、このターンは終える（締めるのは付け直したサーバー）
        handOff: async (c) => { heldServer.putCard(sessionId, c); await heldServer.handOff(); handedOff = true; server.handedOff(); settle(); },
      };
      control.touch?.();
    };

    try {
      if (adopt) {
        bindHeld();
        const [list, status, permissions, questions] = await Promise.all([
          server.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory }),
          server.request('GET', '/session/status', { directory }).catch(() => ({})),
          server.request('GET', '/permission', { directory }).catch(() => []),
          server.request('GET', '/question', { directory }).catch(() => []),
        ]);
        // このターンの発言（送った時刻より後）を組み立て直す。途中の本文は、次の部品の更新まで差分を読まない（溜めた差分と重なる）
        replaying = true;
        try {
          for (const m of Array.isArray(list) ? list : []) {
            // 送った時刻が分からない札なら組み立て直さない（前の発言まで流すと重なる）
            if (!(since > 0) || !(Number(m?.info?.time?.created) >= since)) continue;
            mapper.handle({ type: 'message.updated', properties: { info: m.info } });
            for (const part of m.parts ?? []) mapper.handle({ type: 'message.part.updated', properties: { part } });
          }
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
        if (state !== 'busy' && state !== 'retry') settle();
        control?.onReady?.();
        if (signal?.signal?.aborted) onAbort();
        await done;
      } else {
        // 入力欄の `!` の結果は、返答を起こさない行（noReply）で先に積む（Claude の shouldQuery: false と同じ）
        for (const line of shellAppends) {
          await server.request('POST', `/session/${sessionId}/message`, { directory, body: { noReply: true, ...(ref ? { model: ref } : {}), parts: [{ type: 'text', text: String(line) }] } });
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
        since = Date.now();
        bindHeld();
        await server.request('POST', `/session/${sessionId}/prompt_async`, {
          directory,
          body: {
            ...(ref ? { model: ref } : {}),
            agent: modeOf(mode) === 'plan' ? 'plan' : 'build',
            ...(effort ? { variant: String(effort) } : {}),
            ...(system ? { system } : {}),
            parts: [{ type: 'text', text }],
          },
        }).catch((err) => { throw undelivered(err); });
        control?.onReady?.();
        if (signal?.signal?.aborted) onAbort();
        await done;
      }
      // 終わりの前の Hooks（Stop）。続けさせる理由なら、それを次の発言として渡して、もう一度終わりを待つ（3 回まで。付け直しをまたいで数える）
      for (; hooks?.has('Stop') && stopRounds < 3 && !aborted && !gone && !handedOff && !mapper.error; ) {
        const reason = await hooks.stop(stopRounds > 0, { signal: signal?.signal });
        if (!reason || handedOff) break;
        stopRounds++;
        control?.touch?.();
        arm();
        await server.request('POST', `/session/${sessionId}/prompt_async`, { directory, body: { ...(ref ? { model: ref } : {}), agent: modeOf(card?.mode ?? mode) === 'plan' ? 'plan' : 'build', parts: [{ type: 'text', text: reason }] } });
        await done;
      }
    } catch (err) {
      if (handedOff) return { sessionId, handedOff: true };
      emit({ type: 'turnResult', outcome: 'error', error: String(err?.message ?? err) });
      throw err;
    } finally {
      signal?.signal?.removeEventListener?.('abort', onAbort);
      if (turnsBySession.get(sessionId) === route) turnsBySession.delete(sessionId);
      for (const child of children) if (turnsBySession.get(child) === route) turnsBySession.delete(child);
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
      // 手を離したターンは、札も環境変数のファイルも新しいサーバーのもの
      if (!handedOff) { heldServer?.endTurn(sessionId); void envFile?.dispose(); }
    }
    if (handedOff) return { sessionId, handedOff: true };
    for (const s of steers) if (s.id) emit({ type: 'userMessage.dropped', messageId: s.id });

    const error = gone ? { message: String(gone.message ?? gone) } : mapper.error;
    if (aborted || error?.aborted) emit({ type: 'turnResult', outcome: 'aborted' });
    else if (error) emit({ type: 'turnResult', outcome: 'error', error: error.message, ...(error.auth ? { kind: 'auth', pristine: !mapper.wroteText } : {}) });
    else emit({ type: 'turnResult', outcome: 'ok', costUsd: mapper.usage.costUsd });
    return { sessionId };
  },

  /**
   * 付け直し（無停止の更新。opencode-held.mjs）: 保持役の子の共有のサーバーで走っているターンを引き取る。
   * card は runTurn が札に置いた分（control.backendCard）、source は opencode-held.mjs の付け直す元。発言は送らない
   */
  async adoptTurn(args) {
    if (!args.card?.held || !args.source?.held) throw new Error('opencode: the turn was not on the holder');
    return backend.runTurn(args, { card: args.card, source: args.source });
  },

  /** 引き継ぎで、ターンの無い共有のサーバーも新しいサーバーへ渡す（札は待ち受けだけ。新しいサーバーが起こし直さずに使う） */
  async releaseIdle() {
    const held = server.held;
    if (!held || held.cards.size > 0) return;
    await held.handOff();
    server.handedOff();
  },

  async compact({ sessionId, emit, cwd, trigger = 'manual' }) {
    const directory = (await directoryOf(sessionId)) ?? cwd;
    const msgs = await server.request('GET', `/session/${sessionId}/message`, { directory });
    const last = [...(msgs ?? [])].reverse().find((m) => m.info?.role === 'assistant' && m.info?.providerID);
    const ref = last ? { providerID: last.info.providerID, modelID: last.info.modelID } : await defaultModelRef(directory);
    if (!ref) throw new Error(t('opencode.errors.noModel'));
    emit({ type: 'compaction', phase: 'start', trigger });
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    let error = null;
    const onEvent = (event) => {
      if (event.type === 'pleiad.gone') { error = event.properties.error; settle(); }
      if (event.type === 'session.error') error = errorOf(event.properties.error);
      if (event.type === 'session.idle') settle();
    };
    turnsBySession.set(sessionId, onEvent);
    try {
      await server.request('POST', `/session/${sessionId}/summarize`, { directory, body: { ...ref, auto: false }, timeoutMs: 15 * 60_000 });
      await Promise.race([done, new Promise((r) => setTimeout(r, 10 * 60_000).unref?.())]);
    } finally {
      if (turnsBySession.get(sessionId) === onEvent) turnsBySession.delete(sessionId);
    }
    if (error) {
      emit({ type: 'compaction', phase: 'failed', trigger, reason: String(error.message ?? error) });
      return;
    }
    const after = await server.request('GET', `/session/${sessionId}/message`, { directory }).catch(() => []);
    const summary = [...(after ?? [])].reverse().find((m) => m.info?.summary);
    const text = (summary?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
    emit({ type: 'compaction', phase: 'complete', trigger, ...(text ? { summary: text } : {}), ...(summary?.info?.id ? { nativeId: summary.info.id } : {}) });
  },

  // ---- セッション管理 -----------------------------------------------------

  async listSessions({ limit = 100 } = {}) {
    // サーバーが動いていなければ、起こさずに会話の DB から読む（Pleiad で作った会話は Pleiad の控えからも一覧に出る）
    const rows = server.running ? await server.request('GET', '/experimental/session', { query: { roots: true, limit } }) : (sessionsFromDb({ limit }) ?? []);
    const list = Array.isArray(rows) ? rows : rows?.data ?? [];
    for (const s of list) if (s?.id && s.directory) directories.set(s.id, s.directory);
    return list.filter((s) => !s.parentID).map(sessionRow).filter(Boolean);
  },

  async getSession(sessionId) {
    if (!sessionId || !/^ses_/.test(sessionId)) return null;
    if (!server.running) {
      const [row] = sessionsFromDb({ id: sessionId }) ?? [];
      if (row?.directory) directories.set(row.id, row.directory);
      return sessionRow(row ?? null);
    }
    const s = await server.request('GET', `/session/${encodeURIComponent(sessionId)}`, { directory: directories.get(sessionId) ?? null }).catch(() => null);
    if (s?.directory) directories.set(s.id, s.directory);
    return sessionRow(s);
  },

  async getMessages(sessionId, options = {}) {
    if (!sessionId) return [];
    // サーバーが動いていなければ、起こさずに会話の DB から読む（全文検索の索引作りが全部の会話を読むので、起動のたびに起きていた）
    if (!server.running) {
      const stored = messagesFromDb(sessionId);
      if (stored) return messagesToNormalized(stored, options);
    }
    const directory = await directoryOf(sessionId);
    const list = await server.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory });
    return messagesToNormalized(list, options);
  },

  async setTitle(sessionId, title) {
    const directory = await directoryOf(sessionId);
    await server.request('PATCH', `/session/${encodeURIComponent(sessionId)}`, { directory, body: { title: String(title ?? '') } });
  },

  async fork(sessionId, { upToMessageId, title } = {}) {
    const directory = await directoryOf(sessionId);
    const list = await server.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory });
    const ids = (list ?? []).map((m) => m.info?.id);
    let body = {};
    if (upToMessageId) {
      const at = ids.indexOf(upToMessageId);
      if (at < 0) throw new Error(t('opencode.errors.forkMissing'));
      // OpenCode の fork は渡した発言の手前までを写す。その発言までを含めるので、次の発言の id を渡す（最後なら全部）
      if (at + 1 < ids.length) body = { messageID: ids[at + 1] };
    }
    const created = await server.request('POST', `/session/${encodeURIComponent(sessionId)}/fork`, { directory, body });
    if (created?.directory) directories.set(created.id, created.directory);
    if (title) await server.request('PATCH', `/session/${created.id}`, { directory, body: { title: String(title) } }).catch(() => {});
    return { sessionId: created.id };
  },

  async listSubagents(sessionId) {
    const directory = await directoryOf(sessionId);
    const kids = await server.request('GET', `/session/${encodeURIComponent(sessionId)}/children`, { directory }).catch(() => []);
    return (kids ?? []).map((k) => k.id).filter(Boolean);
  },

  async getSubagentMessages(sessionId, agentId, { limit } = {}) {
    const directory = await directoryOf(sessionId);
    const list = await server.request('GET', `/session/${encodeURIComponent(agentId)}/message`, { directory }).catch(() => []);
    const messages = messagesToNormalized(list);
    return Number.isFinite(limit) ? messages.slice(-limit) : messages;
  },

  async getSubagentOrigin(sessionId, agentId) {
    const directory = await directoryOf(sessionId);
    const list = await server.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory }).catch(() => []);
    for (const m of list ?? []) for (const p of m.parts ?? []) if (p.type === 'tool' && p.tool === 'task' && p.state?.metadata?.sessionId === agentId) return String(p.callID ?? p.id);
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
      const argv = cliCommand('opencode');
      if (!argv) throw new Error(t('opencode.errors.notInstalled'));
      const before = new Set(((await server.request('GET', '/provider').catch(() => null))?.connected) ?? []);
      const command = [...argv, 'auth', 'login'].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      emit?.({ type: 'auth', phase: 'url', url: command, message: t('opencode.auth.runCommand') });
      const until = Date.now() + LOGIN_TIMEOUT_MS;
      let seen = authStamp();
      while (Date.now() < until) {
        await new Promise((r) => { const timer = setTimeout(r, LOGIN_POLL_MS); timer.unref?.(); });
        // 資格情報は OpenCode が auth.json に書く。走っているサーバーは読み直さないので、ファイルが変わったときだけ起こし直して確かめる
        // （サーバーは 1 本で約 760 MB。見張りのたびには起こさない）
        const stamp = authStamp();
        if (stamp === seen) continue;
        seen = stamp;
        providersCache = null;
        await server.stop();
        const now = ((await server.request('GET', '/provider').catch(() => null))?.connected) ?? [];
        if (now.some((id) => !before.has(id))) { emit?.({ type: 'auth', phase: 'done', message: t('opencode.auth.loggedIn') }); return; }
      }
      const message = t('opencode.auth.loginTimeout');
      emit?.({ type: 'auth', phase: 'error', message });
      throw new Error(message);
    },
    async logout() {
      throw new Error(t('opencode.auth.logoutInCli'));
    },
  },
};

/** 試験用: 共有のサーバーを止める（tests/unit/server-opencode.mjs） */
export const stopOpencodeServer = () => server.stop();
/** 中継の口に結び付けるサーバー名（試験が見る） */
export const OPENCODE_RELAY_SERVERS = Object.keys(RELAY_SERVERS);
