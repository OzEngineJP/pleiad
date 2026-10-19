import path from 'node:path';
import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { t, agentT } from '../i18n.mjs';
import { BROWSER_SERVER } from '../browser-bridge.mjs';
import { CONTROL_SERVER } from '../ops/surfaces/mcp.mjs';
import * as store from '../store.mjs';
import { conversation } from '../conversations.mjs';
import { NO_CAPABILITIES } from './contract.mjs';
import { undelivered } from './undelivered.mjs';
import { prepareDevinLaunch } from './devin-config.mjs';
import { buildDevinModels, resolveDevinModel, applyDevinModel } from './devin-models.mjs';
import { createDevinMapper } from './devin-normalize.mjs';
import { COMPUTER_SERVER, computerPrompt } from './computer-delivery.mjs';
import { createAcpSteer } from './acp-steer.mjs';
import { devinCompactionsFromDb, devinCompactionFromNotification, devinSessionsDb } from './devin-compaction.mjs';

const choices = values => (values ?? []).flatMap(v => Array.isArray(v?.options) ? choices(v.options) : [v?.value]);
const abortError = () => Object.assign(new Error('Devin turn cancelled'), { aborted: true });
const LOGIN_TIMEOUT_MS = Number(process.env.AGENT_HOST_DEVIN_LOGIN_MS ?? 10 * 60_000);
const LOGIN_POLL_MS = Number(process.env.AGENT_HOST_DEVIN_POLL_MS ?? 3_000);
// 数値でない環境変数は NaN になり、NaN との比較は常に false で待ちが止まらなくなる。数値でなければ既定に戻す
const envMs = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) ? v : fallback; };
// /compact の応答は圧縮の前に返る。圧縮が効いたかの合図（通知・使用量の減少・継続ノードの追加）を待つ上限と、
// 何も合図が来なければ「圧縮するものが無い」と判断するまでの待ち（CLI 3000.11.92 は通知を 1 秒ほどで送る）
const COMPACT_VERIFY_MS = envMs('AGENT_HOST_DEVIN_COMPACT_WAIT_MS', 120_000);
const COMPACT_QUIET_MS = envMs('AGENT_HOST_DEVIN_COMPACT_QUIET_MS', 15_000);
const configSetting = (options, kind) => options.filter(o => o?.id === kind || o?.category === kind);
function matchesVerified(options, verified) {
  if (!Array.isArray(options) || options.some(o => typeof o?.id !== 'string') || new Set(options.map(o => o.id)).size !== options.length) return false;
  return [...verified].every(([kind, expected]) => {
    const actual = configSetting(options, kind);
    return actual.length === 1 && actual[0].id === expected.id && actual[0].currentValue === expected.value;
  });
}

async function captureCatalogue(launch, signal) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(launch.command, ['models', 'list', '--format', 'json'], { cwd: launch.cwd, env: launch.env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else {
        try { resolve(JSON.parse(output)); } catch { reject(new Error(t('devin.errors.invalidCatalogue'))); }
      }
    };
    const timer = setTimeout(() => finish(new Error(t('devin.errors.timeout', { method: 'models', ms: 20000 }))), 20000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (settled) return; bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) finish(new Error(t('devin.errors.invalidCatalogue'))); else output += chunk; });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error(t('devin.errors.startFailed'))));
    child.once('close', code => finish(code === 0 ? null : new Error(t('devin.errors.invalidCatalogue'))));
  });
}

export function createDevinBackend({ Acp = null, catalogue = captureCatalogue, command = () => cliCommand('devin'), dataDir = store.dataDir, cancelGraceMs = 2000 } = {}) {
  const cache = new Map(), rows = new Map(), active = new Map(), queues = new Map();
  const metadataQueue = Symbol('metadata');
  function remember(id, mapper) {
    cache.delete(id); cache.set(id, mapper);
    while (cache.size > 16) cache.delete(cache.keys().next().value);
  }
  function serial(key, fn) {
    const job = (queues.get(key) ?? Promise.resolve()).then(fn);
    const tail = job.catch(() => {}); queues.set(key, tail);
    tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
    return job;
  }
  function argv() {
    const value = command();
    if (!value) throw Object.assign(new Error(t('devin.errors.notInstalled')), { code: 'NOT_INSTALLED' });
    return value;
  }
  async function rawModels(cwd, signal) {
    return serial(metadataQueue, async () => {
      const launch = await prepareDevinLaunch({ command: argv(), cwd, dataDir, metadata: true });
      return catalogue(launch, signal);
    });
  }
  async function openClient(cwd, handlers = {}, extraEnv = null) {
    const launch = await prepareDevinLaunch({ command: argv(), cwd, dataDir, env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
    const Client = Acp ?? (await import('./devin-acp.mjs')).DevinAcp;
    const client = new Client({ ...launch, ...handlers, onRequest: handlers.onRequest ?? (async method => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      throw Object.assign(new Error('Unsupported ACP client request'), { code: -32601 });
    }) });
    try { await client.start(); return client; } catch (error) { await client.close().catch(() => {}); throw error; }
  }
  async function cwdFor(id) {
    if (rows.has(id)) return rows.get(id).cwd;
    for (const [hostId, meta] of Object.entries(await store.getAll())) {
      if (meta.backend !== 'devin') continue;
      if (hostId === id && meta.cwd) return meta.cwd;
      const record = await conversation(hostId);
      if (record?.backend === 'devin' && (record.nativeId === id || record.segments?.some(s => s.backend === 'devin' && s.nativeId === id))) return meta.cwd ?? record.info?.cwd ?? null;
    }
    return null;
  }
  const modes = () => ({
    ask: { label: t('devin.modes.ask'), note: t('devin.modes.askNote'), scope: 'readonly', autonomy: 'ask', enforced: false },
    'accept-edits': { label: t('modes.acceptEdits'), note: t('devin.modes.editNote'), scope: 'full', autonomy: 'judge', enforced: false },
    smart: { label: t('devin.modes.smart'), note: t('devin.modes.smartNote'), scope: 'full', autonomy: 'judge', enforced: false },
    plan: { label: t('modes.plan'), note: t('devin.modes.planNote'), scope: 'readonly', autonomy: 'ask', enforced: false },
    bypass: { label: 'Bypass', note: t('devin.modes.bypassNote'), scope: 'full', autonomy: 'never', enforced: false },
  });
  // ログインの案内が同時に走らないよう掴む旗
  let pendingAuth = null;
  return {
    id: 'devin', label: 'Devin CLI', get description() { return t('devin.description'); },
    capabilities: { ...NO_CAPABILITIES, compact: true, approvals: 'interactive', mcpApproval: 'agent', effortInModelId: true, failureDiagnostics: true, login: true, promptDelivery: true,
      // ACP の session/new の mcpServers（type: 'http'）に ply_browser・ply_control・ply_computer・ply_context を、CLI の env と指示にブラウザー・秘密情報・可視化を渡す
      browser: true, plyControl: true, secrets: true, visualize: true,
      // ACP には指示の欄が無い。Pleiad 担当の指示・Skills の一覧は発言の前に注入文として足し、本文の読み出し
      // （load_skill・instructions_for_path）と外部 MCP は ply_context の MCP（type: 'http'）越しに渡す。口はターンごと
      plyContext: 'turn',
      computerUse: { images: 'inline', waitSliceMs: null } },
    modes,
    async usage() { return (await import('./devin-usage.mjs')).readDevinUsage(); },
    async models(cwd = process.cwd()) { return buildDevinModels(await rawModels(cwd)); },
    async listSessions({ cwd } = {}) {
      // Common conversations add their persisted rows without starting a CLI. An
      // explicit directory may also discover native sessions in Pleiad's session root.
      if (cwd && command()) {
        const client = await openClient(cwd);
        try {
          const result = await client.call('session/list', { cwd: path.resolve(cwd) });
          for (const s of result?.sessions ?? []) if (typeof s.sessionId === 'string') rows.set(s.sessionId, { sessionId: s.sessionId, cwd: s.cwd ?? path.resolve(cwd), title: s.title ?? null, createdAt: null, lastModified: s.updatedAt ? Date.parse(s.updatedAt) : null });
        } finally { await client.close(); }
      }
      return [...rows.values()].filter(s => !cwd || s.cwd === path.resolve(cwd)).map(s => ({ ...s }));
    },
    async getSession(id) {
      if (rows.has(id)) return { ...rows.get(id) };
      const cwd = await cwdFor(id);
      return cwd ? { sessionId: id, cwd, title: null, createdAt: null, lastModified: null } : null;
    },
    async getMessages(id) {
      if (cache.has(id)) return cache.get(id).messages();
      const cwd = await cwdFor(id);
      if (!cwd || !command()) return [];
      return serial(id, async () => {
        if (cache.has(id)) return cache.get(id).messages();
        const mapper = createDevinMapper(id);
        let client;
        try {
          client = await openClient(cwd, { onUpdate: p => { if (p.sessionId === id) mapper.accept(p.update); } });
          await client.call('session/load', { sessionId: id, cwd, mcpServers: [] });
          remember(id, mapper); return mapper.messages();
        } catch { return []; } // The common conversation keeps its persisted transcript.
        finally { if (client) await client.close(); }
      });
    },
    async runTurn(args) {
      return serial(args.sessionId ?? Symbol('new'), async () => {
        const { emit, onPromptDelivered, control } = args;
        const hostSignal = args.signal?.signal ?? args.signal;
        const local = new AbortController();
        let client, closePromise, sessionId = args.sessionId ?? null, mapper, verified = null, selectedMode = null, prompting = false, sent = false, fatal = null, closing = false, watchdog, steered = null;
        let latestSession = null, latestSnapshot = null, latestMode = null;
        const closeClient = () => closePromise ??= Promise.resolve().then(() => client.close());
        let forceReject;
        const stopped = new Promise((_, reject) => { forceReject = reject; }); stopped.catch(() => {});
        const stop = error => {
          if (error && !fatal) fatal = error;
          local.abort();
          try { if (client && sessionId) client.notify('session/cancel', { sessionId }); } catch {}
          if (prompting && !watchdog) watchdog = setTimeout(() => { forceReject(fatal ?? abortError()); void closeClient().catch(() => {}); }, cancelGraceMs);
          else if (!prompting && client) void closeClient().catch(() => {});
        };
        const onAbort = () => stop();
        hostSignal?.addEventListener('abort', onAbort, { once: true });
        if (hostSignal?.aborted) local.abort();
        const check = () => { if (fatal) throw fatal; if (local.signal.aborted) throw abortError(); };
        const observe = (id, config, modeOnly = false) => {
          if (typeof id !== 'string' || (sessionId && id !== sessionId)) return;
          if (latestSession !== id) { latestSession = id; latestSnapshot = null; latestMode = null; }
          if (modeOnly) latestMode = config;
          else {
            latestSnapshot = structuredClone(config);
            const mode = Array.isArray(config) ? configSetting(config, 'mode') : [];
            latestMode = mode.length === 1 ? mode[0].currentValue : null;
          }
          if (verified && (!matchesVerified(latestSnapshot, verified) || latestMode !== selectedMode)) stop(new Error(t('devin.errors.configChanged')));
        };
        let error = null, outcome = 'ok';
        try {
          if (args.account != null || args.oauthToken || args.endpoint) throw new Error(t('accounts.badBackend'));
          check();
          // モデル一覧・CLI の起動・履歴の再生・設定の適用は送る前に済ませるが、数秒黙る。
          // その間も画面が止まって見えないよう、準備中から稼働表示に出す
          emit({ type: 'activity', state: 'preparing' });
          const cwd = path.resolve(args.cwd ?? (sessionId && await cwdFor(sessionId)) ?? process.cwd());
          const selection = resolveDevinModel(await rawModels(cwd, local.signal), args.model ?? '');
          check();
          // ブラウザー（AGENT_BROWSER_*）・ply_control の CLI・秘密情報と変数は、起動する CLI の env で渡す（会話のシェルへ届く）
          const extraEnv = { ...(args.browserEnv ?? {}), ...(args.controlRuntime?.env ?? {}), ...(args.secretsRuntime?.env ?? {}) };
          client = await openClient(cwd, {
            onGone: e => { if (!closing) { fatal = e; local.abort(); forceReject(e); } },
            onResponse: ({ method, params, result }) => {
              if (!['session/new', 'session/load', 'session/set_config_option'].includes(method)) return;
              const id = params?.sessionId ?? result?.sessionId;
              if (method === 'session/new' && typeof id === 'string') sessionId = id;
              observe(id, result?.configOptions);
            },
            onUpdate: params => {
              if (sessionId && params.sessionId !== sessionId) return;
              const update = params.update;
              if (update?.sessionUpdate === 'config_option_update') observe(params.sessionId, update.configOptions);
              if (update?.sessionUpdate === 'current_mode_update') observe(params.sessionId, update.currentModeId, true);
              if (fatal) return;
              mapper?.accept(update);
            },
            // Devin 内部の自動圧縮の合図。transcript にも残る（getCompactions が区切りとして読む）が、
            // 走っているターンではここで区切りを出す（読み直すまで見えないため）
            onNotification: (method, params) => {
              if (method !== '_cognition.ai/compaction' || fatal) return;
              if (sessionId && params?.sessionId && params.sessionId !== sessionId) return;
              const event = devinCompactionFromNotification(params);
              if (!event) return;
              if (event.status === 'started') { emit({ type: 'compaction', phase: 'start', trigger: 'auto' }); emit({ type: 'activity', state: 'compacting' }); }
              // 完了・失敗のあとは稼働表示を compacting のまま残さない。ターンは続くので thinking に戻す（次の出来事で更に変わる）
              else if (event.status === 'completed') { emit({ type: 'compaction', phase: 'complete', trigger: 'auto', ...(event.summary ? { summary: event.summary } : {}) }); emit({ type: 'activity', state: 'thinking' }); }
              else if (event.status === 'failed') { emit({ type: 'compaction', phase: 'failed', trigger: 'auto', reason: event.reason ?? t('compaction.noCompletion') }); emit({ type: 'activity', state: 'thinking' }); }
            },
            onRequest: async (method, params) => {
              if (method !== 'session/request_permission') throw Object.assign(new Error('Unsupported ACP client request'), { code: -32601 });
              if (!prompting || params.sessionId !== sessionId || local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
              const allow = params.options?.find(o => o.kind === 'allow_once'), deny = params.options?.find(o => o.kind === 'reject_once');
              mapper.accept({ ...params.toolCall, sessionUpdate: 'tool_call_update' });
              const tool = mapper.getToolCall(params.toolCall?.toolCallId);
              const title = tool?.title ?? tool?.name;
              if (typeof title !== 'string' || !title.trim()) return { outcome: typeof deny?.optionId === 'string' ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
              emit({ type: 'activity', state: 'waiting', sessionId });
              const answer = await Promise.resolve(args.askPermission?.({ toolName: title, input: tool.rawInput ?? {}, sessionId,
                toolUseID: params.toolCall?.toolCallId ?? null, signal: local.signal, canAlways: false, kind: 'tool', locale: args.locale }) ?? { allow: false }).catch(() => ({ allow: false }));
              if (local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
              const selected = answer?.allow ? allow : deny;
              return { outcome: typeof selected?.optionId === 'string' ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
            },
          }, extraEnv);
          check();
          // Pleiad の MCP（ply_browser・ply_control・ply_context）は ACP の mcpServers で渡す（type: 'http' が要る。外すと session/new が Invalid params で断る）
          const acpMcp = (name, runtime) => (runtime?.url ? [{ name, type: 'http', url: runtime.url, headers: Object.entries(runtime.headers ?? {}).map(([header, value]) => ({ name: header, value })) }] : []);
          const mcpServers = [...acpMcp('ply_context', args.contextRuntime), ...acpMcp(BROWSER_SERVER, args.browserRuntime), ...acpMcp(CONTROL_SERVER, args.controlRuntime), ...acpMcp(COMPUTER_SERVER, args.computerRuntime)];
          let state;
          if (sessionId) {
            mapper = createDevinMapper(sessionId, emit);
            state = await client.call('session/load', { sessionId, cwd, mcpServers });
          } else {
            state = await client.call('session/new', { cwd, mcpServers });
            sessionId = state?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId) throw new Error(t('devin.errors.notConnected'));
            mapper = createDevinMapper(sessionId, emit);
          }
          remember(sessionId, mapper); active.set(sessionId, client);
          check();
          const mode = args.mode || 'ask';
          if (!Object.hasOwn(modes(), mode)) throw new Error(t('devin.errors.modeUnavailable'));
          const modeOptions = state?.configOptions?.filter(o => o.id === 'mode' || o.category === 'mode') ?? [];
          if (modeOptions.length !== 1 || !choices(modeOptions[0].options).includes(mode)) throw new Error(t('devin.errors.modeUnavailable'));
          state = await client.call('session/set_config_option', { sessionId, configId: modeOptions[0].id, value: mode });
          if (state?.configOptions?.find(o => o.id === modeOptions[0].id)?.currentValue !== mode) throw new Error(t('devin.errors.modeUnavailable'));
          const config = await applyDevinModel(client.call.bind(client), sessionId, state.configOptions, selection);
          if (config.find(o => o.id === modeOptions[0].id)?.currentValue !== mode) throw new Error(t('devin.errors.modeUnavailable'));
          verified = new Map([['mode', { id: modeOptions[0].id, value: mode }]]);
          for (const [kind, value] of [['model', selection.acpModel], ...(selection.thoughtLevel ? [['thought_level', selection.thoughtLevel]] : []), ['speed', selection.speed]]) {
            const option = configSetting(config, kind);
            if (option.length !== 1) throw new Error(t('devin.errors.configChanged'));
            verified.set(kind, { id: option[0].id, value });
          }
          if (!matchesVerified(config, verified)) throw new Error(t('devin.errors.configChanged'));
          selectedMode = mode;
          if (latestSession !== sessionId || !matchesVerified(latestSnapshot, verified) || latestMode !== mode) throw new Error(t('devin.errors.configChanged'));
          check();
          // 読み取り専用のモードでは、ブラウザーの指示を「操作しない」に読み替える（agent-browser は読むだけでもデーモンの書き込みが要る。Codex と同じ）
          let browserInstructions = args.browserInstructions;
          if (args.browserEnv && modes()[mode]?.scope === 'readonly') browserInstructions = agentT(args.locale, 'browser.readonlyInstructions');
          const prompt = [...(args.shellAppends ?? []), ...(args.notes ?? []), args.botInstructions, args.addedInstructions, args.contextRuntime?.prompt, args.visualizeInstructions, browserInstructions, computerPrompt(args.computerRuntime, { locale: args.locale, agent: 'devin' }), args.controlRuntime?.instructions, args.secretsRuntime?.instructions, String(args.prompt ?? '')].filter(Boolean).join('\n\n');
          // ACP には指示の欄が無いので、指示は本文の前に足して送る。記録の発言には人が書いた分だけを残す（#97）
          mapper.beginTurn(prompt, [...(args.shellAppends ?? []), ...(args.notes ?? []), String(args.prompt ?? '')].filter(Boolean).join('\n\n'));
          rows.set(sessionId, { sessionId, cwd, title: rows.get(sessionId)?.title ?? String(args.prompt ?? '').slice(0, 80), createdAt: rows.get(sessionId)?.createdAt ?? new Date().toISOString(), lastModified: Date.now() });
          emit({ type: 'session', sessionId, model: selection.id, ...(args.sessionId ? {} : { first: true }) });
          // 途中送信: 走っているターンへ session/prompt を重ねる。Devin は同じ回に折り込む（実測 3000.11.92）
          steered = createAcpSteer({ client, sessionId, emit, ready: () => prompting && !closing && !fatal && !local.signal.aborted });
          if (control) { control.handle = { sessionId }; control.steer = item => steered.steer(item); control.steerConfirms = true; }
          check();
          prompting = true;
          // prompt を渡してから最初の session/update が来るまでも黙っている（Codex・Antigravity と同じく、送る直前に出す）
          emit({ type: 'activity', state: 'thinking' });
          const response = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 0 });
          sent = true; onPromptDelivered?.();
          control?.onReady?.();
          const result = await Promise.race([response, stopped]);
          if (fatal) throw fatal;
          if (local.signal.aborted || result?.stopReason === 'cancelled') outcome = 'aborted';
          else if (['max_tokens', 'max_turn_requests'].includes(result?.stopReason)) outcome = 'limited';
          else if (result?.stopReason !== 'end_turn') throw new Error(t('devin.errors.promptFailed'));
        } catch (e) {
          error = fatal ?? e;
          outcome = !fatal && (hostSignal?.aborted || error.aborted) ? 'aborted' : 'error';
        } finally {
          clearTimeout(watchdog); hostSignal?.removeEventListener('abort', onAbort);
          // 途中送信で並んだ分がまだ回っていれば、その決着まで待つ（区切りが来ず次の回に回った分）。
          // 中断・失敗・打ち切りでは待たず、残りは close で拒否されて userMessage.dropped になる。
          // closing を先に立て、drain の間に届いた新しい途中送信は受理しない（次のターンで送る）。
          // drain 中に並んだ分の回が承認を求められるよう、prompting は drain が済むまで下ろさない
          closing = true;
          if (outcome === 'ok') await steered?.drain({ alive: () => !local.signal.aborted && !fatal });
          prompting = false; verified = null; local.abort();
          if (client) {
            try { await closeClient(); }
            catch (closeError) {
              error = error ? new AggregateError([error, closeError], `${error.message}; ${closeError.message}`) : closeError;
              outcome = 'error';
            }
          }
          if (sessionId) active.delete(sessionId);
          if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
          mapper?.finish();
          emit({ type: 'turnResult', outcome, ...(sessionId ? { sessionId } : {}), ...(outcome === 'error' ? { error: String(error?.message ?? t('devin.errors.promptFailed')) } : {}) });
        }
        if (outcome === 'error') throw sent ? error : undelivered(error);
        return { sessionId };
      });
    },
    /**
     * 会話の圧縮（/compact）。ACP のスラッシュコマンドは、host が prompt の本文として送る。
     * 手動の区切りはここで出す。Devin 内部の自動圧縮は `_cognition.ai/compaction` 通知で拾い、
     * 走っているターンでは runTurn の onNotification が区切りを出す（transcript の継続ノードは getCompactions が読む）。
     * 第 1 引数の sessionId はネイティブの id（core/conversations.mjs が host の id から訳す）。
     * 前後の文脈量は、Devin が流す usage_update（文脈の占有）から取る。来なければ量は付けない
     *
     * /compact の応答（end_turn）は圧縮が走る**前**に返る（実測 CLI 3000.11.92。圧縮は裏で進み、
     * `_cognition.ai/compaction` 通知と usage_update の減少があとから来る）。返っただけでは完了とせず、
     * 実効を検証する: 通知の completed・使用量の減少・transcript（sessions.db）への継続ノードの追加の
     * どれかを待つ。何も来なければ「圧縮するものがありませんでした」、始まって終わらなければ失敗にする
     */
    async compact({ sessionId, emit, cwd, trigger = 'manual', signal, hostSessionId, hostBackend }) {
      const dir = path.resolve(cwd ?? (await cwdFor(sessionId)) ?? process.cwd());
      const dbFile = devinSessionsDb(dataDir);
      const hostSignal = signal?.signal ?? signal;
      const local = new AbortController();
      let client, fatal = null, usage = null;
      const events = [];   // _cognition.ai/compaction の通知
      let nothingShown = false;
      const onAbort = () => { local.abort(); try { client?.notify('session/cancel', { sessionId }); } catch {} };
      hostSignal?.addEventListener('abort', onAbort, { once: true });
      // リスナーを登録したあとの await は try の中へ（ここで投げるとリスナーが外れない）
      try {
        // 区切りの位置（issue #105）: 直前の発言の uuid を afterMessageId にする（codex.mjs の区切りと同じ形。
        // Devin の発言は時刻を持たないので、画面は uuid アンカーでしか置けない）。
        // ホスト記録の会話は記録の行の uuid、ネイティブだけの会話は再生の行の uuid（どちらも画面の data-uuid と同じ値）
        const last = (hostBackend && hostSessionId
          ? await hostBackend.getMessages(hostSessionId).catch(() => [])
          : cache.get(sessionId)?.messages() ?? []
        ).filter(m => m?.uuid).at(-1);
        const boundary = last?.uuid ? { afterMessageId: last.uuid } : {};
        const known = new Set(devinCompactionsFromDb({ dataDir, sessionId, dbFile }).map(e => e.nativeId));
        const newBoundary = () => devinCompactionsFromDb({ dataDir, sessionId, dbFile }).find(e => !known.has(e.nativeId)) ?? null;
        client = await openClient(dir, {
          onGone: error => { fatal = error; local.abort(); },
          onUpdate: params => {
            if (params.sessionId !== sessionId) return;
            const u = params.update;
            if (u?.sessionUpdate === 'usage_update') {
              const used = Number(u.used), size = Number(u.size);
              if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
              usage = { usedTokens: used, windowTokens: size };
              emit({ type: 'contextWindow', usedTokens: used, windowTokens: size });
            } else if (u?.sessionUpdate === 'agent_message_chunk' && u._meta?.['cognition.ai/displayMessage']
              && /nothing to compact/i.test(String(u.content?.text ?? ''))) nothingShown = true;
          },
          onNotification: (method, params) => {
            if (method !== '_cognition.ai/compaction' || (params?.sessionId && params.sessionId !== sessionId)) return;
            const event = devinCompactionFromNotification(params);
            if (event) events.push(event);
          },
        });
        await client.call('session/load', { sessionId, cwd: dir, mcpServers: [] });
        if (fatal) throw fatal;
        const before = usage?.usedTokens;
        emit({ type: 'compaction', phase: 'start', trigger, ...boundary });
        emit({ type: 'activity', state: 'compacting' });
        const result = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact' }] }, { timeoutMs: 0 });
        if (fatal) throw fatal;
        if (result?.stopReason !== 'end_turn') {
          emit({ type: 'compaction', phase: 'failed', trigger, ...boundary,
            reason: result?.stopReason === 'cancelled' || local.signal.aborted ? t('turn.aborted') : t('devin.errors.promptFailed') });
          return { sessionId };
        }
        // 実効の検証。圧縮は裏で進むので、合図を上限つきで待つ
        const quiet = Date.now() + COMPACT_QUIET_MS, deadline = Date.now() + COMPACT_VERIFY_MS;
        const started = () => events.some(e => e.status === 'started');
        for (let node = null, nextDb = 0;;) {
          const done = events.find(e => e.status === 'completed');
          const declined = events.find(e => e.status === 'failed');
          const after = usage?.usedTokens;
          const dropped = Number.isFinite(before) && Number.isFinite(after) && after < before;
          if (!node && (done || !events.length) && Date.now() >= nextDb) {
            nextDb = Date.now() + 1000;
            node = newBoundary();
          }
          if (done || dropped || node) {
            emit({ type: 'compaction', phase: 'complete', trigger, ...boundary,
              // DB の継続ノードの id を載せると、読み直し（getCompactions）の区切りと照合できる
              ...(node ? { nativeId: node.nativeId } : {}),
              ...(dropped ? { beforeTokens: before, afterTokens: after } : {}),
              ...(done?.summary ?? node?.summary ? { summary: done?.summary ?? node.summary } : {}) });
            return { sessionId };
          }
          if (declined) { emit({ type: 'compaction', phase: 'failed', trigger, ...boundary, reason: declined.reason ?? t('compaction.noCompletion') }); return { sessionId }; }
          if (fatal) throw fatal;
          if (local.signal.aborted) { emit({ type: 'compaction', phase: 'failed', trigger, ...boundary, reason: t('turn.aborted') }); return { sessionId }; }
          // 始まりの合図も無く静かなら「圧縮するものが無かった」。displayMessage の "Nothing to compact." は早めの確定
          if (!started() && (Date.now() > quiet || (nothingShown && !events.length))) {
            emit({ type: 'compaction', phase: 'failed', trigger, ...boundary, reason: t('compaction.nothingToCompact') });
            return { sessionId };
          }
          if (Date.now() > deadline) { emit({ type: 'compaction', phase: 'failed', trigger, ...boundary, reason: t('compaction.noCompletion') }); return { sessionId }; }
          await new Promise(r => { const timer = setTimeout(r, 250); timer.unref?.(); });
        }
      } finally {
        hostSignal?.removeEventListener('abort', onAbort);
        if (client) await client.close().catch(() => {});
      }
    },
    // 自動圧縮を含む区切りを、会話の DB（sessions.db の継続ノード）から読む（core/compaction-history.mjs の形）
    async getCompactions(sessionId) {
      return devinCompactionsFromDb({ dataDir, sessionId });
    },
    async releaseConversation(id) { const client = active.get(id); if (client) await client.close(); cache.delete(id); },

    // ---- 認証 ---------------------------------------------------------------
    //
    // `devin auth` に status / login / logout がある。ログインはブラウザーで行うので端末が要る:
    // Pleiad はコマンドを案内し、`devin auth status` が通るのを見届ける（Antigravity と同じ流れ）。
    // 資格情報は credentials.toml（windsurf_api_key）。使用量は同じ資格情報で読む（devin-usage.mjs）。

    auth: {
      /** `devin auth status` を読む。人向けの文（Logged in … / User: Name:）と、fixture の JSON の両方を受ける */
      async status() {
        const { code, out, err } = await runAuth(['auth', 'status']).catch(e => ({ code: -1, out: '', err: String(e?.message ?? e) }));
        const text = `${out}\n${err}`.trim();
        try {
          const parsed = JSON.parse(out.trim());
          if (typeof parsed.authenticated === 'boolean') return { loggedIn: parsed.authenticated, account: parsed.authenticated ? (parsed.name ?? parsed.user ?? null) : null, detail: text.slice(0, 200) || null };
        } catch {}
        if (/logged in/i.test(text)) {
          const account = /^\s*Name:\s*(.+)$/m.exec(text)?.[1]?.trim() || null;
          return { loggedIn: true, account, detail: /via\s+(.+?)[).]/i.exec(text)?.[1]?.trim() || null };
        }
        return { loggedIn: false, account: null, detail: text.slice(0, 200) || null };
      },
      /** ログインは端末でしか受け付けない（OAuth はブラウザー）。コマンドを出し、status が通るまで見張る */
      async login({ emit }) {
        if (pendingAuth) throw new Error(t('devin.auth.loginRunning'));
        pendingAuth = {};
        try {
          if (await signedIn()) {
            emit?.({ type: 'auth', phase: 'done', message: t('devin.auth.alreadyLoggedIn') });
            return;
          }
          const command = [...argv(), 'auth', 'login'].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
          emit?.({ type: 'auth', phase: 'url', url: command, message: t('devin.auth.runCommand') });
          const until = Date.now() + LOGIN_TIMEOUT_MS;
          while (Date.now() < until) {
            await new Promise(r => { const timer = setTimeout(r, LOGIN_POLL_MS); timer.unref?.(); });
            if (await signedIn()) {
              emit?.({ type: 'auth', phase: 'done', message: t('devin.auth.loggedIn') });
              return;
            }
          }
          const message = t('devin.auth.loginTimeout');
          emit?.({ type: 'auth', phase: 'error', message });
          throw new Error(message);
        } finally {
          pendingAuth = null;
        }
      },
      /** `devin auth logout`。対話は要らないので Pleiad から実行する */
      async logout() {
        const { code, err, out } = await runAuth(['auth', 'logout']);
        if (code !== 0) throw new Error((err || out || t('devin.errors.promptFailed')).trim().slice(0, 300));
      },
    },
    /** 使っている devin の実行ファイルと版（設定の行の名前の下。Claude の cliInfo と同じ形） */
    async cliInfo() {
      const argv = command();
      if (!argv) return null;
      const { code, out } = await runAuth(['--version']).catch(() => ({ code: -1, out: '' }));
      const version = code === 0 ? (/(\d[\d.]*)/.exec(out)?.[1] ?? null) : null;
      return { path: argv[0] === process.execPath && argv[1] ? argv[1] : argv[0], ...(version ? { version } : {}) };
    },
  };

  /** 認証まわりの小さな起動（status・logout・--version）。ターン・モデル一覧の ACP・catalogue とは別経路 */
  function runAuth(args, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnCli(argv(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '', settled = false;
      const finish = (error, code = null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ code, out, err }); };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(new Error(t('devin.errors.timeout', { method: args.join(' '), ms: timeoutMs }))); }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', c => { out += c; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', c => { err += c; });
      child.once('error', finish);
      child.once('close', code => finish(null, code));
    });
  }
  async function signedIn() {
    return (await authStatusForLogin().catch(() => ({ loggedIn: false }))).loggedIn === true;
  }
  // login の見張りは status() と同じ判定を使う（循環を避けるため分離）
  async function authStatusForLogin() {
    const { out, err } = await runAuth(['auth', 'status']);
    const text = `${out}\n${err}`.trim();
    try {
      const parsed = JSON.parse(out.trim());
      if (typeof parsed.authenticated === 'boolean') return { loggedIn: parsed.authenticated };
    } catch {}
    return { loggedIn: /logged in/i.test(text) };
  }
}

export const backend = createDevinBackend();
