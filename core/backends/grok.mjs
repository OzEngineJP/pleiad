import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { t, agentT } from '../i18n.mjs';
import { createLoginWatch, loginTimeoutError } from '../auth/login-watch.mjs';
import { BROWSER_SERVER } from '../browser-bridge.mjs';
import { CONTROL_SERVER } from '../ops/surfaces/mcp.mjs';
import { SHELL_SERVER } from '../shell-bridge.mjs';
import { COMPUTER_SERVER, computerPrompt } from './computer-delivery.mjs';
import * as store from '../store.mjs';
import { conversation } from '../conversations.mjs';
import { undelivered } from './undelivered.mjs';
import { createGrokMapper } from './grok-normalize.mjs';
import { createAcpSteer, PROTOCOL_REJECT_CODES } from './acp-steer.mjs';
import { createHeldAcp, heldAcpPlan } from './acp-held.mjs';
import { writeTurnPlugin } from './grok-hooks.mjs';
import { grokQuota } from './grok-usage.mjs';
import { CAPABILITY_STATES, AGENT_TRAITS } from './agent-marks.mjs';

/** 札（backendCard）に入れる発言の本文の上限（バイト）。超えたら人に書いた分だけにして、写しは人に書いた分で組み立てる */
const CARD_TEXT_MAX = 16 * 1024;

// i18n-dynamic: grok.errors.modelUnavailable
// i18n-dynamic: grok.errors.effortUnavailable
// i18n-dynamic: grok.errors.modeUnavailable
// i18n-dynamic: grok.errors.loginRequired
const fail = (key, values = {}) => Object.assign(new Error(t(`grok.errors.${key}`, values)), {});

const abortError = () => Object.assign(new Error('Grok turn cancelled'), { aborted: true });
const isAuthError = error => /auth|credential|login|unauthorized/i.test(String(error?.message ?? '')) || error?.code === -32002;
const LOGIN_TIMEOUT_MS = Number(process.env.AGENT_HOST_GROK_LOGIN_MS ?? 10 * 60_000);
const LOGIN_POLL_MS = Number(process.env.AGENT_HOST_GROK_POLL_MS ?? 3_000);
/** Grok の置き場（config.toml・auth.json）。試験は AGENT_HOST_GROK_HOME で差し替える */
const grokHome = () => process.env.AGENT_HOST_GROK_HOME || path.join(os.homedir(), '.grok');

// Pleiad のモード → Grok の permission mode（`grok --permission-mode` の値と同じ）
const GROK_MODES = { ask: 'default', 'accept-edits': 'acceptEdits', auto: 'auto', bypass: 'bypassPermissions', plan: 'plan' };

const modes = () => ({
  ask: { label: t('modes.ask'), note: t('grok.modes.askNote'), scope: 'workspace', autonomy: 'ask', enforced: false },
  'accept-edits': { label: t('modes.acceptEdits'), note: t('grok.modes.editNote'), scope: 'full', autonomy: 'judge', enforced: false },
  auto: { label: t('grok.modes.auto'), note: t('grok.modes.autoNote'), scope: 'full', autonomy: 'judge', enforced: false },
  bypass: { label: 'Bypass', note: t('grok.modes.bypassNote'), scope: 'full', autonomy: 'never', enforced: false },
  plan: { label: t('modes.plan'), note: t('grok.modes.planNote'), scope: 'readonly', autonomy: 'ask', enforced: false },
});

/** initialize の `_meta.modelState` → Pleiad のモデルの一覧の形 */
function grokModels(init) {
  const state = init?._meta?.modelState;
  const available = Array.isArray(state?.availableModels) ? state.availableModels : [];
  const entries = available.filter(m => typeof m?.modelId === 'string' && m.modelId);
  if (!entries.length) throw fail('modelUnavailable', { model: '' });
  const current = entries.find(m => m.modelId === state.currentModelId) ?? entries[0];
  const effortsOf = m => (m?._meta?.reasoningEfforts ?? []).map(e => e?.value ?? e?.id).filter(v => typeof v === 'string' && v);
  const defaultEffortOf = m => (m?._meta?.reasoningEfforts?.find(e => e?.default)?.value ?? m?._meta?.reasoningEffort ?? null);
  const out = { '': {
    label: t('models.default'),
    note: current?.name ?? current?.modelId ?? '',
    resolvesTo: current?.modelId,
    efforts: effortsOf(current), defaultEffort: defaultEffortOf(current),
  } };
  for (const m of entries) {
    out[m.modelId] = {
      label: typeof m.name === 'string' && m.name ? m.name : m.modelId,
      note: typeof m.description === 'string' ? m.description : '',
      efforts: effortsOf(m), defaultEffort: defaultEffortOf(m),
    };
  }
  return out;
}

function spawnArgs(model, effort) {
  const args = [];
  if (model) args.push('--model', model);
  if (effort) args.push('--reasoning-effort', effort);
  return args;
}

export function createGrokBackend({ Acp = null, command = () => cliCommand('grok'), dataDir = store.dataDir, cancelGraceMs = 2000 } = {}) {
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
    if (!value) throw Object.assign(new Error(t('grok.errors.notInstalled')), { code: 'NOT_INSTALLED' });
    return value;
  }
  async function openClient(cwd, args = [], handlers = {}, extraEnv = null, { held = null, adopt = null } = {}) {
    const Client = Acp ?? (await import('./grok-acp.mjs')).GrokAcp;
    const client = new Client({ command: argv(), args, cwd: path.resolve(cwd), env: extraEnv ? { ...process.env, ...extraEnv } : process.env, ...handlers, held, adopt, onRequest: handlers.onRequest ?? (async method => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      throw Object.assign(new Error('Unsupported ACP client request'), { code: -32601 });
    }) });
    try { await client.start(); return client; } catch (error) { await client.close().catch(() => {}); throw error; }
  }
  async function cwdFor(id) {
    if (rows.has(id)) return rows.get(id).cwd;
    for (const [hostId, meta] of Object.entries(await store.getAll())) {
      if (meta.backend !== 'grok') continue;
      if (hostId === id && meta.cwd) return meta.cwd;
      const record = await conversation(hostId);
      if (record?.backend === 'grok' && (record.nativeId === id || record.segments?.some(s => s.backend === 'grok' && s.nativeId === id))) return meta.cwd ?? record.info?.cwd ?? null;
    }
    return null;
  }
  /** modelState の実際のモデル・エフォートが、渡した指定と一致しているか */
  function verifySelection(init, model, effort) {
    const state = init?._meta?.modelState;
    if (model && state?.currentModelId !== model) throw fail('modelUnavailable', { model });
    if (effort) {
      const current = (state?.availableModels ?? []).find(m => m.modelId === state?.currentModelId);
      const actual = current?._meta?.reasoningEffort;
      if (actual && actual !== effort) throw fail('effortUnavailable', { effort });
    }
  }
  // resume は起動引数より保存済みの設定を優先する。送信前に今回の指定へ戻し、ACKも照合する。
  async function applySelection(client, sessionId, state, model, effort) {
    let modelChanged = false;
    for (const [id, wanted, failure] of [['model', model, 'modelUnavailable'], ['reasoning_effort', effort, 'effortUnavailable']]) {
      if (!wanted) continue;
      const option = state?.configOptions?.find(o => o.id === id);
      const actual = option?.currentValue ?? (id === 'model' ? state?.models?.currentModelId : null);
      if ((typeof actual !== 'string' || actual === wanted) && !(id === 'reasoning_effort' && modelChanged)) continue;
      const result = await client.call('session/set_config_option', { sessionId, configId: id, value: wanted });
      if (result?.configOptions?.find(o => o.id === id)?.currentValue !== wanted) throw fail(failure, { model, effort });
      state = result;
      if (id === 'model') modelChanged = true;
    }
  }
  /** 標準の ACP のモード（state.modes）。古い configOptions の形も受ける */
  async function applyMode(client, sessionId, state, mode) {
    const wanted = GROK_MODES[mode];
    if (!wanted) throw fail('modeUnavailable');
    if (state?.modes) {
      const available = (state.modes.availableModes ?? []).map(m => m?.id ?? m);
      if (!available.includes(wanted)) throw fail('modeUnavailable');
      const result = await client.call('session/set_mode', { sessionId, modeId: wanted });
      const actual = result?.currentModeId ?? result?.modes?.currentModeId;
      if (typeof actual === 'string' && actual !== wanted) throw fail('modeUnavailable');
      return;
    }
    const options = state?.configOptions ?? [];
    const modeOption = options.filter(o => o?.id === 'mode' || o?.category === 'mode');
    if (modeOption.length !== 1) {
      // Grok は modes も mode の configOption も返さないが、session/set_mode は直接受ける（空の ACK）
      await client.call('session/set_mode', { sessionId, modeId: wanted });
      return;
    }
    const choices = values => (values ?? []).flatMap(v => Array.isArray(v?.options) ? choices(v.options) : [v?.value]);
    if (!choices(modeOption[0].options).includes(wanted)) throw fail('modeUnavailable');
    const result = await client.call('session/set_config_option', { sessionId, configId: modeOption[0].id, value: wanted });
    const actual = result?.configOptions?.find(o => o.id === modeOption[0].id)?.currentValue;
    if (typeof actual === 'string' && actual !== wanted) throw fail('modeUnavailable');
  }
  // モデルの一覧の置き場（grok agent の initialize で読む modelState）。起動に秒かかるので、直近の値と
  // 取りかけを分け合う（codex.mjs の modelCache/modelFetch と同じ形）。一覧は場所の設定で変わりうるので
  // 置き場（cwd）ごとに覚える。成功した取得だけを覚え、失敗は次の要求で取り直す
  const modelsTtlMs = () => { const v = Number(process.env.AGENT_HOST_GROK_MODELS_TTL_MS); return Number.isFinite(v) ? v : 300_000; };
  const modelsCache = new Map(), modelsFetch = new Map();
  async function fetchModels(cwd) {
    const client = await serial(metadataQueue, () => openClient(cwd).catch(error => { throw isAuthError(error) ? fail('loginRequired') : error; }));
    try { return grokModels(client.init); }
    finally { await client.close(); }
  }
  // ログインの案内が同時に走らないよう掴む旗と、待っている見張りをやめる口（authCancel）
  let pendingAuth = null;
  const loginWatch = createLoginWatch('Grok');
  return {
    id: 'grok', label: 'Grok Build', get description() { return t('grok.description'); },
    // 能力の印と性質は core/backends/agent-marks.mjs（公開文書も同じデータから作る）
    capabilities: CAPABILITY_STATES.grok,
    traits: AGENT_TRAITS.grok,
    modes,
    async usage({ cwd = process.cwd() } = {}) {
      return serial(metadataQueue, async () => {
        let client;
        try {
          client = await openClient(cwd);
          return grokQuota(await client.call('_x.ai/billing', {}));
        } catch (error) {
          return { windows: [], checkedAt: null, message: isAuthError(error) ? t('grok.usageNoCredentials') : t('grok.usageFetchFailed') };
        } finally { await client?.close(); }
      });
    },
    async models(cwd = process.cwd(), { refresh = false } = {}) {
      const key = path.resolve(cwd);
      const hit = modelsCache.get(key);
      if (!refresh && hit && Date.now() - hit.at < modelsTtlMs()) return hit.value;
      if (!modelsFetch.has(key)) {
        modelsFetch.set(key, fetchModels(key)
          .then(value => { modelsCache.set(key, { value, at: Date.now() }); return value; })
          .finally(() => modelsFetch.delete(key)));
      }
      return modelsFetch.get(key);
    },
    // 起動時に一覧を取り置く（初めての振り分けで CLI の起動を待たない）
    async warmModels(cwd = process.cwd()) { await models(cwd); },
    async listSessions({ cwd } = {}) {
      // Common conversations add their persisted rows without starting a CLI. An
      // explicit directory may also discover native sessions via session/list.
      if (cwd && command()) {
        const client = await openClient(cwd).catch(() => null);
        if (client) try {
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
        const mapper = createGrokMapper(id);
        let client;
        try {
          client = await openClient(cwd, [], { onUpdate: p => { if (p.sessionId === id) mapper.accept(p.update); } });
          await client.call('session/load', { sessionId: id, cwd, mcpServers: [] });
          remember(id, mapper); return mapper.messages();
        } catch { return []; } // The common conversation keeps its persisted transcript.
        finally { if (client) await client.close(); }
      });
    },
    // adopt は付け直し（{ source, card }。adoptTurn だけが渡す）。無ければ普通のターン（保持役に載せるかは acp-held.mjs の heldAcpPlan が決める）
    async runTurn(args, adopt = null) {
      return serial(args.sessionId ?? Symbol('new'), async () => {
        const { emit, onPromptDelivered, control } = args;
        const hostSignal = args.signal?.signal ?? args.signal;
        const local = new AbortController();
        let client, closePromise, sessionId = args.sessionId ?? null, mapper, prompting = false, sent = false, fatal = null, closing = false, watchdog, steered = null, plugin = null;
        // 保持役（無停止の更新 段 2b）: 子を載せたターンだけ。handedOff は旧サーバーが手を離した（続きは新しいサーバー）
        let held = null, handedOff = false, handingOff = false, settleHandOff = () => {}, promptId = null, replaying = false, sentText = '', shownText = '';
        const handedOffPromise = new Promise(resolve => { settleHandOff = resolve; });
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
        // 付け直しの再生（印から ack まで）は画面へ流さない（server の makeEmit が状態だけ作る）
        const mapEmit = event => emit(event, replaying ? { replay: true } : undefined);
        /**
         * 札のバックエンドの欄（保持役に載せたターンだけ。server の takeCard が control.backendCard から読み、付け直す側の adoptTurn の card になる）。
         * 付け直しに要る、再生では作れないもの: 走っている session/prompt の id（応答を拾い直す）と、送った本文・人が書いた分（写しのエコー合わせ。
         * 大きいときは入れない＝人に書いた分で組み立て直す）
         */
        const backendCard = () => ({ held: true, grok: { promptId, sessionId,
          sent: Buffer.byteLength(sentText) <= CARD_TEXT_MAX ? sentText : null,
          shown: Buffer.byteLength(shownText) <= CARD_TEXT_MAX ? shownText : null,
          // 走っている途中送信の id（回の終わりの後に答えるので、付け直した側が決着を待ってから閉じる）
          prompts: client?.pendingPromptIds?.() ?? [] } });
        // 札を保持役の子に置く口（server の touchCard が札の中身の変わるたびに呼ぶ）と、旧サーバーの手を離す口（core/handover.mjs）
        const bindHolder = () => {
          if (!control || !held) return;
          control.holder = {
            label: card => held.label(card),
            handOff: async card => {
              handingOff = true;
              await held.handOff(card);
              handedOff = true;
              client?.markHandedOff?.();
              settleHandOff();
            },
          };
          control.backendCard = backendCard;
          control.touch?.();
        };
        let error = null, outcome = 'ok';
        try {
          if (args.account != null || args.oauthToken || args.endpoint) throw new Error(t('accounts.badBackend'));
          if (args.contextRuntime) throw new Error(t('context.runtime.refused', { backend: 'Grok Build' }));
          check();
          // CLI の起動・履歴の再生・モードの適用は送る前に済ませるが、数秒黙る。
          // その間も画面が止まって見えないよう、準備中から稼働表示に出す
          // 付け直しは、記録の再生が稼働表示を作り直す（準備中から出し直さない）
          if (!adopt) emit({ type: 'activity', state: 'preparing' });
          const cwd = path.resolve(args.cwd ?? (sessionId && await cwdFor(sessionId)) ?? process.cwd());
          const model = typeof args.model === 'string' && args.model ? args.model : '';
          const effort = typeof args.effort === 'string' && args.effort ? args.effort : '';
          // Pleiad がそろえる Hooks を渡すターンは、Claude・Cursor・Codex 互換の読み込み元を環境変数で止める（二重実行の防止）
          const extraEnv = { ...(args.browserEnv ?? {}), ...(args.controlRuntime?.env ?? {}),
            ...(args.secretsRuntime?.env ?? {}), ...(args.hooksRuntime?.compatHookEnv ?? {}) };
          const handlers = {
            onGone: e => { if (!closing) { fatal = e; local.abort(); forceReject(e); } },
            onUpdate: (params, opts) => {
              if (sessionId && params.sessionId !== sessionId) return;
              if (fatal) return;
              replaying = Boolean(opts?.replay);
              try { mapper?.accept(params.update); } finally { replaying = false; }
            },
            // _x.ai/interject の受理確認通知: 通知の届いた位置へ user 行を置き、履歴の uuid を nativeId に使う
            onInterjection: params => {
              if (!params || (sessionId && params.sessionId !== sessionId)) return;
              if (!steered?.hasInterjection(params.interjectionId)) return;
              const nativeId = mapper?.injectUser?.(params.text ?? '', params.interjectionId);
              steered?.confirmed(params.interjectionId, nativeId);
            },
            onRequest: async (method, params) => {
              if (method !== 'session/request_permission') throw Object.assign(new Error('Unsupported ACP client request'), { code: -32601 });
              if (!prompting || params.sessionId !== sessionId || local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
              const allow = params.options?.find(o => o.kind === 'allow_once'), deny = params.options?.find(o => o.kind === 'reject_once');
              const always = params.options?.find(o => o.kind === 'allow_always');
              mapper.accept({ ...params.toolCall, sessionUpdate: 'tool_call_update' });
              const tool = mapper.getToolCall(params.toolCall?.toolCallId);
              const title = tool?.title ?? tool?.name;
              if (typeof title !== 'string' || !title.trim()) return { outcome: typeof deny?.optionId === 'string' ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
              emit({ type: 'activity', state: 'waiting', sessionId });
              const answer = await Promise.resolve(args.askPermission?.({ toolName: title, input: tool.rawInput ?? {}, sessionId,
                toolUseID: params.toolCall?.toolCallId ?? null, signal: local.signal, canAlways: typeof always?.optionId === 'string', kind: 'tool', locale: args.locale }) ?? { allow: false }).catch(() => ({ allow: false }));
              if (local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
              const selected = answer?.allow ? (answer.always && typeof always?.optionId === 'string' ? always : allow) : deny;
              return { outcome: typeof selected?.optionId === 'string' ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
            },
          };
          // 途中送信: 走っているターンへ session/prompt を重ねる（Grok は内蔵の待ち行列に積み、今の回の直後に続けて回す）。
          // interject が無い版は応答が次の回の終わりまで返らないので、折り込んだ時点で渡ったことにする
          const makeSteer = () => createAcpSteer({ client, sessionId, emit, ready: () => prompting && !closing && !fatal && !local.signal.aborted,
            onSent: text => mapper?.queueUser(text),
            confirmOnAccept: true, onCall: () => control?.touch?.(),
            // 走っているターンを止めずに次のモデル呼び出しへ差し込む Grok 固有の口（1.0.62 実測。
            // 応答は受理した時点で返る。{result:{status:'queued'}} はターン内の差し込み待ちへの受理）
            interject: async (text, item, interjectionId) => {
              try {
                const result = await client.call('_x.ai/interject', { sessionId, text, interjectionId }, { timeoutMs: 15000 });
                if (result?.result?.status !== 'queued') throw new Error('Unrecognized Grok interjection acknowledgement');
                return true;
              } catch (error) {
                if (error?.code === -32601) return 'unsupported';     // この経路が無い古い版 → session/prompt へ
                if (PROTOCOL_REJECT_CODES.has(error?.code)) return false;
                throw error;   // 結果不明（読まれたか分からない）— 呼ぶ側は送り直さない
              }
            } });
          let prompt = null, response = null, initialNativeId = null, windowTokens = null;
          if (adopt) {
            // 付け直し: 子は initialize 済みで、session も設定も済んでいる。走っている session/prompt の応答を拾い直し、
            // 印から ack までの記録を再生して状態を作る（initialize・session/resume・設定の適用・発言は送らない）
            const card = adopt.card?.grok;
            if (!adopt.card?.held || !card || typeof adopt.source?.write !== 'function') throw new Error('grok: the turn was not on the holder');
            if (typeof card.promptId !== 'string' && typeof card.promptId !== 'number') throw new Error('grok: the card has no prompt id');
            promptId = card.promptId;
            sentText = typeof card.sent === 'string' ? card.sent : String(args.prompt ?? '');
            shownText = typeof card.shown === 'string' ? card.shown : String(args.prompt ?? '');
            held = createHeldAcp({ source: adopt.source });
            client = await openClient(cwd, [], handlers, extraEnv, { held, adopt: { promptId } });
            check();
            mapper = createGrokMapper(sessionId, mapEmit, { windowTokens: null });
            mapper.beginTurn(sentText, shownText);
            remember(sessionId, mapper); active.set(sessionId, client);
            // attach の答え（答えていない依頼）。再生の依頼のうち、これに入っているものだけを聞き直す
            await client.open(1);
            // 走っている途中送信の応答の枠を開ける（本文の応答の後に続けて届く返答を、閉じる前に読む）
            client.adoptTrailing((Array.isArray(card.prompts) ? card.prompts : []).filter(id => id !== promptId));
            steered = makeSteer();
            if (control) { control.handle = { sessionId }; control.steer = item => steered.steer(item); control.steerConfirms = true; }
            bindHolder();
            sent = true;
            prompting = true;
            // 再生と続き（印から）。応答は replay の途中か、その後に届く
            client.begin();
            response = client.running;
          } else {
            check();
            // 保持役に載せるか（実行場所の置き場があるときだけ。acp-held.mjs）。載せると、CLI はサーバーの入れ替えをまたいで走り続ける
            const plan = await heldAcpPlan({ dataDir, argv: argv(), bot: Boolean(args.botInstructions), envName: 'AGENT_HOST_GROK_HOLDER' });
            held = plan ? createHeldAcp({ client: plan.client }) : null;
            client = await openClient(cwd, spawnArgs(model, effort), handlers, extraEnv, { held });
            check();
            verifySelection(client.init, model, effort);
            windowTokens = Number((client.init?._meta?.modelState?.availableModels ?? []).find(m => m.modelId === client.init?._meta?.modelState?.currentModelId)?._meta?.totalContextTokens) || null;
            // MCP は新規・再開の両方に、そのターンの接続情報だけを渡す。
            const acpMcp = (name, runtime) => runtime?.url ? [{ name, type: 'http', url: runtime.url,
              headers: Object.entries(runtime.headers ?? {}).map(([header, value]) => ({ name: header, value })) }] : [];
            const mcpServers = [...acpMcp(BROWSER_SERVER, args.browserRuntime), ...acpMcp(CONTROL_SERVER, args.controlRuntime),
              ...acpMcp(COMPUTER_SERVER, args.computerRuntime), ...acpMcp(SHELL_SERVER, args.shellRuntime), ...acpMcp('ply_agents', args.agentRuntime)];
            // Pleiad がそろえる Hooks は、このターンだけのプラグイン（hooks/hooks.json）として _meta.pluginDirs で渡す。
            // 渡した置き場は trusted になり、保存されない（session/load でも毎回渡す）。ターンの終わりに消す（grok-hooks.mjs）
            if (args.hooksRuntime?.pluginHooks) plugin = await writeTurnPlugin(path.join(dataDir, 'grok-hooks'), args.hooksRuntime.pluginHooks);
            const meta = plugin ? { _meta: { pluginDirs: [plugin.dir] } } : {};
            let state;
            if (sessionId) {
              try {
                state = await client.call('session/resume', { sessionId, cwd, mcpServers, ...meta });
                // Reuse a mapper that already owns the transcript. After a server restart,
                // resume has no replay to seed positional UUIDs, so namespace this turn's
                // new rows until the next explicit history load can align them by content.
                mapper = cache.get(sessionId) ?? createGrokMapper(sessionId, mapEmit, { windowTokens, messageNamespace: randomUUID() });
                mapper.setEmit(mapEmit);
              } catch (error) {
                // Older Grok CLI releases expose session/load but not session/resume.
                if (![-32601, -32602].includes(error?.code)) throw error;
                mapper = createGrokMapper(sessionId, mapEmit, { windowTokens });
                state = await client.call('session/load', { sessionId, cwd, mcpServers, ...meta });
              }
            } else {
              state = await client.call('session/new', { cwd, mcpServers, ...meta });
              sessionId = state?.sessionId;
              if (typeof sessionId !== 'string' || !sessionId) throw new Error(t('grok.errors.notConnected'));
              mapper = createGrokMapper(sessionId, mapEmit, { windowTokens });
            }
            remember(sessionId, mapper); active.set(sessionId, client);
            check();
            await applySelection(client, sessionId, state, model, effort);
            await applyMode(client, sessionId, state, args.mode || 'ask');
            check();
            const browserInstructions = args.browserEnv && modes()[args.mode || 'ask']?.scope === 'readonly'
              ? agentT(args.locale, 'browser.readonlyInstructions') : args.browserInstructions;
            prompt = [...(args.shellAppends ?? []), ...(args.notes ?? []), args.botInstructions, args.addedInstructions, args.agentRuntime?.instructions,
              args.visualizeInstructions, browserInstructions, computerPrompt(args.computerRuntime, { locale: args.locale }),
              args.controlRuntime?.instructions, args.shellRuntime?.instructions, args.secretsRuntime?.instructions, String(args.prompt ?? '')].filter(Boolean).join('\n\n');
            sentText = prompt;
            shownText = [...(args.shellAppends ?? []), ...(args.notes ?? []), String(args.prompt ?? '')].filter(Boolean).join('\n\n');
            // ACP には指示の欄が無いので、指示は本文の前に足して送る。記録の発言には人が書いた分だけを残す（#97）
            initialNativeId = mapper.beginTurn(prompt, shownText);
            rows.set(sessionId, { sessionId, cwd, title: rows.get(sessionId)?.title ?? String(args.prompt ?? '').slice(0, 80), createdAt: rows.get(sessionId)?.createdAt ?? new Date().toISOString(), lastModified: Date.now() });
            emit({ type: 'session', sessionId, model: model || client.init?._meta?.modelState?.currentModelId || undefined, ...(args.sessionId ? {} : { first: true }) });
            steered = makeSteer();
            if (control) { control.handle = { sessionId }; control.steer = item => steered.steer(item); control.steerConfirms = true; }
            check();
            prompting = true;
            // 札を先に置き、印を打ってから書く（落ちたとき、新しいサーバーがこのターンを拾えるように）
            bindHolder();
            await new Promise(resolve => setImmediate(resolve));
            held?.markTurn();
            // prompt を渡してから最初の session/update が来るまでも黙っている（Codex・Antigravity と同じく、送る直前に出す）
            emit({ type: 'activity', state: 'thinking' });
            promptId = typeof client.newId === 'function' ? client.newId() : null;
            response = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 0, ...(promptId ? { id: promptId } : {}) });
            sent = true; onPromptDelivered?.(initialNativeId);
            control?.onReady?.();
          }
          const result = await Promise.race([response, stopped, handedOffPromise]);
          // 旧サーバーが手を離した。このターンはここで終わる（締めるのは付け直したサーバー）
          if (handedOff) { emit({ type: 'turnResult', outcome: 'aborted' }); return { sessionId, handedOff: true }; }
          if (fatal) throw fatal;
          if (local.signal.aborted || result?.stopReason === 'cancelled') outcome = 'aborted';
          else if (['max_tokens', 'max_turn_requests'].includes(result?.stopReason)) outcome = 'limited';
          else if (result?.stopReason !== 'end_turn') throw new Error(t('grok.errors.promptFailed'));
        } catch (e) {
          error = fatal ?? (isAuthError(e) ? fail('loginRequired') : e);
          outcome = !fatal && (hostSignal?.aborted || error.aborted) ? 'aborted' : 'error';
        } finally {
          clearTimeout(watchdog); hostSignal?.removeEventListener('abort', onAbort);
          // 途中送信で待ち行列に並んだ分がまだ回っていれば、その決着まで待つ（Grok は今の回の直後に続けて回す）。
          // 中断・失敗・打ち切り・手を離したときは待たず、残りは close で拒否されて userMessage.dropped になる。
          // closing を先に立て、drain の間に届いた新しい途中送信は受理しない（次のターンで送る）。
          // drain 中に並んだ分の回が承認を求められるよう、prompting は drain が済むまで下ろさない
          closing = true;
          if (outcome === 'ok' && !handedOff) await steered?.drain({ alive: () => !local.signal.aborted && !fatal });
          // 付け直したターンは、走っている途中送信の決着（回の終わりの後に届く返答）を待ってから閉じる
          if (adopt && !handedOff) await client?.settleTrailing?.(1500);
          prompting = false; local.abort();
          // ターンが終わった子は、付け直す対象から外してから止める（手を離した子には触れない）
          if (!handedOff && !handingOff) held?.endTurn();
          if (client) {
            try { await closeClient(); }
            catch (closeError) {
              if (!handedOff) {
                error = error ? new AggregateError([error, closeError], `${error.message}; ${closeError.message}`) : closeError;
                outcome = 'error';
              }
            }
          }
          // 手を離したターンのプラグインの置き場は消さない（子が読み直すことがある。アプリの終了で片付く）
          if (!handedOff) plugin?.cleanup();
          if (sessionId) active.delete(sessionId);
          if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; control.holder = null; control.backendCard = null; }
          mapper?.finish();
          emit({ type: 'turnResult', outcome, ...(sessionId ? { sessionId } : {}), ...(outcome === 'error' ? { error: String(error?.message ?? t('grok.errors.promptFailed')) } : {}) });
        }
        if (outcome === 'error') throw sent ? error : undelivered(error);
        return { sessionId, ...(handedOff ? { handedOff: true } : {}) };
      });
    },
    /**
     * 付け直し（無停止の更新 段 2b。acp-held.mjs）: 保持役が持つ走っている ACP の続きを受ける。card は runTurn が札に置いた分
     * （control.backendCard の { held, grok }）、source は保持役の子（core/adopt.mjs の holderSource）。印から ack までは記録を読み直して
     * 状態を作り（emit の replay）、続きは普通に流して行ごとに ack する。initialize も session の作成も設定の適用も送らない
     */
    async adoptTurn(args) {
      if (!args.card?.held || !args.card.grok || typeof args.source?.write !== 'function') throw new Error('grok: the turn was not on the holder');
      return this.runTurn(args, { source: args.source, card: args.card });
    },
    async setModelLive(handle, model) {
      const client = active.get(handle?.sessionId);
      if (!client || !model) return false;
      try {
        const result = await client.call('session/set_config_option', { sessionId: handle.sessionId, configId: 'model', value: model });
        const options = result?.configOptions?.filter(o => o.id === 'model' || o.category === 'model') ?? [];
        return options.length === 1 && options[0].currentValue === model;
      } catch { return false; }
    },
    async setModeLive(handle, mode) {
      const client = active.get(handle?.sessionId);
      if (!client || !GROK_MODES[mode]) return false;
      try { await applyMode(client, handle.sessionId, null, mode); return true; } catch { return false; }
    },
    async releaseConversation(id) {
      let client = active.get(id);
      if (!client) {
        const cwd = await cwdFor(id);
        if (cwd && command()) {
          try { client = await openClient(cwd); } catch {}
        }
      }
      if (client) {
        try { await client.call('session/close', { sessionId: id }); } catch {}
        await client.close().catch(() => {});
      }
      active.delete(id);
      cache.delete(id);
    },

    // ---- 認証 ---------------------------------------------------------------
    //
    // ログインは `grok login`（ブラウザー・デバイスコードは端末で）。資格情報は ~/.grok/auth.json。
    // Pleiad はコマンドを案内して済むのを見届ける（Antigravity・Devin と同じ流れ）。アカウント名は
    // auth.json から読めないので、状態と CLI の場所だけを出す。

    auth: {
      /** ~/.grok/auth.json に登録があればログイン済み。無ければ `grok models` が通るか見る（XAI_API_KEY など） */
      async status() {
        if (await signedIn()) return { loggedIn: true, account: t('grok.auth.account'), detail: null };
        return { loggedIn: false, account: null, detail: t('grok.auth.notLoggedIn') };
      },
      /** ログインは端末でしか受け付けない。コマンドを出し、ログインが済むまで見張る */
      async login({ emit }) {
        if (pendingAuth) throw new Error(t('grok.auth.loginRunning'));
        pendingAuth = {};
        const watch = loginWatch.begin();
        try {
          if (await signedIn()) {
            emit?.({ type: 'auth', phase: 'done', message: t('grok.auth.alreadyLoggedIn') });
            return;
          }
          const command = [...argv(), 'login'].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
          emit?.({ type: 'auth', phase: 'url', url: command, message: t('grok.auth.runCommand') });
          const until = Date.now() + LOGIN_TIMEOUT_MS;
          while (Date.now() < until) {
            await watch.pause(LOGIN_POLL_MS);
            const done = await signedIn();
            watch.check();
            if (done) {
              emit?.({ type: 'auth', phase: 'done', message: t('grok.auth.loggedIn') });
              return;
            }
          }
          const message = t('grok.auth.loginTimeout');
          emit?.({ type: 'auth', phase: 'error', code: 'TIMEOUT', message });
          throw loginTimeoutError(message);
        } finally {
          pendingAuth = null;
          watch.end();
        }
      },
      /** 待っているログインをやめる（見張りを止める）。login は CANCELLED で返る */
      async cancel() { return loginWatch.cancel(); },
      /** `grok logout`。対話は要らないので Pleiad から実行する */
      async logout() {
        const { code, err, out } = await runAuth(['logout']);
        if (code !== 0) throw new Error((err || out || t('grok.errors.promptFailed')).trim().slice(0, 300));
      },
    },
    /** 使っている grok の実行ファイルと版（設定の行の名前の下。Claude の cliInfo と同じ形） */
    async cliInfo() {
      const argv = command();
      if (!argv) return null;
      const { code, out } = await runAuth(['--version']).catch(() => ({ code: -1, out: '' }));
      const version = code === 0 ? (/(\d[\d.]*)/.exec(out)?.[1] ?? null) : null;
      return { path: argv[0] === process.execPath && argv[1] ? argv[1] : argv[0], ...(version ? { version } : {}) };
    },
  };

  /** 認証まわりの小さな起動（status・logout・--version）。ターンの ACP とは別経路 */
  function runAuth(args, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnCli(argv(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '', settled = false;
      const finish = (error, code = null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ code, out, err }); };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(new Error(t('grok.errors.timeout', { method: args.join(' '), ms: timeoutMs }))); }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', c => { out += c; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', c => { err += c; });
      child.once('error', finish);
      child.once('close', code => finish(null, code));
    });
  }
  /** auth.json の登録、XAI_API_KEY、`grok models` のどれかが通ればログイン済み */
  async function signedIn() {
    if (process.env.XAI_API_KEY) return true;
    try {
      if (Object.keys(JSON.parse(fs.readFileSync(path.join(grokHome(), 'auth.json'), 'utf8'))).length) return true;
    } catch {}
    if (!command()) return false;
    const { code } = await runAuth(['models'], { timeoutMs: 10000 }).catch(() => ({ code: -1 }));
    return code === 0;
  }
}

export const backend = createGrokBackend();
