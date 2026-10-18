import path from 'node:path';
import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { t } from '../i18n.mjs';
import * as store from '../store.mjs';
import { conversation } from '../conversations.mjs';
import { NO_CAPABILITIES } from './contract.mjs';
import { undelivered } from './undelivered.mjs';
import { prepareDevinLaunch } from './devin-config.mjs';
import { buildDevinModels, resolveDevinModel, applyDevinModel } from './devin-models.mjs';
import { createDevinMapper } from './devin-normalize.mjs';

const choices = values => (values ?? []).flatMap(v => Array.isArray(v?.options) ? choices(v.options) : [v?.value]);
const abortError = () => Object.assign(new Error('Devin turn cancelled'), { aborted: true });
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
  async function openClient(cwd, handlers = {}) {
    const launch = await prepareDevinLaunch({ command: argv(), cwd, dataDir });
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
  return {
    id: 'devin', label: 'Devin CLI', get description() { return t('devin.description'); },
    capabilities: { ...NO_CAPABILITIES, approvals: 'interactive', mcpApproval: 'agent', effortInModelId: true, failureDiagnostics: true },
    modes,
    async usage() { return { windows: [], checkedAt: null, message: t('devin.usageUnknown') }; },
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
        let client, closePromise, sessionId = args.sessionId ?? null, mapper, verified = null, selectedMode = null, prompting = false, sent = false, fatal = null, closing = false, watchdog;
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
          if (args.contextRuntime) throw new Error(t('context.runtime.refused', { backend: 'Devin CLI' }));
          check();
          const cwd = path.resolve(args.cwd ?? (sessionId && await cwdFor(sessionId)) ?? process.cwd());
          const selection = resolveDevinModel(await rawModels(cwd, local.signal), args.model ?? '');
          check();
          client = await openClient(cwd, {
            onGone: e => { if (!closing) { fatal = e; local.abort(); forceReject(e); } },
            onUpdate: params => {
              if (params.sessionId !== sessionId) return;
              const update = params.update;
              if (verified) {
                const invalid = update?.sessionUpdate === 'config_option_update' && !matchesVerified(update.configOptions, verified);
                const modeChanged = update?.sessionUpdate === 'current_mode_update' && update.currentModeId !== selectedMode;
                if (invalid || modeChanged) { stop(new Error(t('devin.errors.configChanged'))); return; }
              }
              mapper?.accept(update);
            },
            onRequest: async (method, params) => {
              if (method !== 'session/request_permission') throw Object.assign(new Error('Unsupported ACP client request'), { code: -32601 });
              if (!prompting || params.sessionId !== sessionId || local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
              const allow = params.options?.find(o => o.kind === 'allow_once'), deny = params.options?.find(o => o.kind === 'reject_once');
              emit({ type: 'activity', state: 'waiting', sessionId });
              const answer = await Promise.resolve(args.askPermission?.({ toolName: String(params.toolCall?.title ?? params.toolCall?.kind ?? 'tool'), input: params.toolCall?.rawInput ?? {}, sessionId,
                toolUseID: params.toolCall?.toolCallId ?? null, signal: local.signal, canAlways: false, kind: 'tool', locale: args.locale }) ?? { allow: false }).catch(() => ({ allow: false }));
              if (local.signal.aborted) return { outcome: { outcome: 'cancelled' } };
              const selected = answer?.allow ? allow : deny;
              return { outcome: typeof selected?.optionId === 'string' ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
            },
          });
          check();
          let state;
          if (sessionId) {
            mapper = createDevinMapper(sessionId, emit);
            state = await client.call('session/load', { sessionId, cwd, mcpServers: [] });
          } else {
            state = await client.call('session/new', { cwd, mcpServers: [] });
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
          check();
          const prompt = [...(args.shellAppends ?? []), ...(args.notes ?? []), args.botInstructions, args.addedInstructions, String(args.prompt ?? '')].filter(Boolean).join('\n\n');
          mapper.beginTurn(prompt);
          rows.set(sessionId, { sessionId, cwd, title: rows.get(sessionId)?.title ?? String(args.prompt ?? '').slice(0, 80), createdAt: rows.get(sessionId)?.createdAt ?? new Date().toISOString(), lastModified: Date.now() });
          emit({ type: 'session', sessionId, model: selection.id, ...(args.sessionId ? {} : { first: true }) });
          if (control) control.handle = { sessionId };
          prompting = true;
          const response = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 0 });
          sent = true; onPromptDelivered?.();
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
          prompting = false; verified = null; closing = true; local.abort();
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
          emit({ type: 'turnResult', outcome, ...(sessionId ? { sessionId } : {}), ...(outcome === 'error' ? { error: String(error?.message ?? t('devin.errors.promptFailed')) } : {}) });
        }
        if (outcome === 'error') throw sent ? error : undelivered(error);
        return { sessionId };
      });
    },
    async releaseConversation(id) { const client = active.get(id); if (client) await client.close(); cache.delete(id); },
  };
}

export const backend = createDevinBackend();
