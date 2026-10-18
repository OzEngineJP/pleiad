import path from 'node:path';
import { cliCommand } from '../cli-installation.mjs';
import { t } from '../i18n.mjs';
import * as store from '../store.mjs';
import { conversation } from '../conversations.mjs';
import { NO_CAPABILITIES } from './contract.mjs';
import { undelivered } from './undelivered.mjs';
import { createGrokMapper } from './grok-normalize.mjs';

// i18n-dynamic: grok.errors.modelUnavailable
// i18n-dynamic: grok.errors.effortUnavailable
// i18n-dynamic: grok.errors.modeUnavailable
// i18n-dynamic: grok.errors.loginRequired
const fail = (key, values = {}) => Object.assign(new Error(t(`grok.errors.${key}`, values)), {});

const abortError = () => Object.assign(new Error('Grok turn cancelled'), { aborted: true });
const isAuthError = error => /auth|credential|login|unauthorized/i.test(String(error?.message ?? '')) || error?.code === -32002;

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
  async function openClient(cwd, args = [], handlers = {}) {
    const Client = Acp ?? (await import('./grok-acp.mjs')).GrokAcp;
    const client = new Client({ command: argv(), args, cwd: path.resolve(cwd), ...handlers, onRequest: handlers.onRequest ?? (async method => {
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
    if (modeOption.length !== 1) throw fail('modeUnavailable');
    const choices = values => (values ?? []).flatMap(v => Array.isArray(v?.options) ? choices(v.options) : [v?.value]);
    if (!choices(modeOption[0].options).includes(wanted)) throw fail('modeUnavailable');
    const result = await client.call('session/set_config_option', { sessionId, configId: modeOption[0].id, value: wanted });
    const actual = result?.configOptions?.find(o => o.id === modeOption[0].id)?.currentValue;
    if (typeof actual === 'string' && actual !== wanted) throw fail('modeUnavailable');
  }
  return {
    id: 'grok', label: 'Grok Build', get description() { return t('grok.description'); },
    capabilities: { ...NO_CAPABILITIES, approvals: 'interactive', mcpApproval: 'agent', shell: 'host', failureDiagnostics: true },
    modes,
    async models(cwd = process.cwd()) {
      const client = await serial(metadataQueue, () => openClient(cwd).catch(error => { throw isAuthError(error) ? fail('loginRequired') : error; }));
      try { return grokModels(client.init); }
      finally { await client.close(); }
    },
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
    async runTurn(args) {
      return serial(args.sessionId ?? Symbol('new'), async () => {
        const { emit, onPromptDelivered, control } = args;
        const hostSignal = args.signal?.signal ?? args.signal;
        const local = new AbortController();
        let client, closePromise, sessionId = args.sessionId ?? null, mapper, prompting = false, sent = false, fatal = null, closing = false, watchdog;
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
        let error = null, outcome = 'ok';
        try {
          if (args.account != null || args.oauthToken || args.endpoint) throw new Error(t('accounts.badBackend'));
          if (args.contextRuntime) throw new Error(t('context.runtime.refused', { backend: 'Grok Build' }));
          check();
          const cwd = path.resolve(args.cwd ?? (sessionId && await cwdFor(sessionId)) ?? process.cwd());
          const model = typeof args.model === 'string' && args.model ? args.model : '';
          const effort = typeof args.effort === 'string' && args.effort ? args.effort : '';
          client = await openClient(cwd, spawnArgs(model, effort), {
            onGone: e => { if (!closing) { fatal = e; local.abort(); forceReject(e); } },
            onUpdate: params => {
              if (sessionId && params.sessionId !== sessionId) return;
              if (fatal) return;
              mapper?.accept(params.update);
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
          });
          check();
          verifySelection(client.init, model, effort);
          let state;
          if (sessionId) {
            mapper = createGrokMapper(sessionId, emit);
            state = await client.call('session/load', { sessionId, cwd, mcpServers: [] });
          } else {
            state = await client.call('session/new', { cwd, mcpServers: [] });
            sessionId = state?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId) throw new Error(t('grok.errors.notConnected'));
            mapper = createGrokMapper(sessionId, emit);
          }
          remember(sessionId, mapper); active.set(sessionId, client);
          check();
          await applyMode(client, sessionId, state, args.mode || 'ask');
          check();
          const prompt = [...(args.shellAppends ?? []), ...(args.notes ?? []), args.botInstructions, args.addedInstructions, String(args.prompt ?? '')].filter(Boolean).join('\n\n');
          mapper.beginTurn(prompt);
          rows.set(sessionId, { sessionId, cwd, title: rows.get(sessionId)?.title ?? String(args.prompt ?? '').slice(0, 80), createdAt: rows.get(sessionId)?.createdAt ?? new Date().toISOString(), lastModified: Date.now() });
          emit({ type: 'session', sessionId, model: model || client.init?._meta?.modelState?.currentModelId || undefined, ...(args.sessionId ? {} : { first: true }) });
          if (control) control.handle = { sessionId };
          check();
          prompting = true;
          const response = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 0 });
          sent = true; onPromptDelivered?.();
          const result = await Promise.race([response, stopped]);
          if (fatal) throw fatal;
          if (local.signal.aborted || result?.stopReason === 'cancelled') outcome = 'aborted';
          else if (['max_tokens', 'max_turn_requests'].includes(result?.stopReason)) outcome = 'limited';
          else if (result?.stopReason !== 'end_turn') throw new Error(t('grok.errors.promptFailed'));
        } catch (e) {
          error = fatal ?? (isAuthError(e) ? fail('loginRequired') : e);
          outcome = !fatal && (hostSignal?.aborted || error.aborted) ? 'aborted' : 'error';
        } finally {
          clearTimeout(watchdog); hostSignal?.removeEventListener('abort', onAbort);
          prompting = false; closing = true; local.abort();
          if (client) {
            try { await closeClient(); }
            catch (closeError) {
              error = error ? new AggregateError([error, closeError], `${error.message}; ${closeError.message}`) : closeError;
              outcome = 'error';
            }
          }
          if (sessionId) active.delete(sessionId);
          if (control) control.handle = null;
          mapper?.finish();
          emit({ type: 'turnResult', outcome, ...(sessionId ? { sessionId } : {}), ...(outcome === 'error' ? { error: String(error?.message ?? t('grok.errors.promptFailed')) } : {}) });
        }
        if (outcome === 'error') throw sent ? error : undelivered(error);
        return { sessionId };
      });
    },
    async releaseConversation(id) { const client = active.get(id); if (client) await client.close(); cache.delete(id); },
  };
}

export const backend = createGrokBackend();
