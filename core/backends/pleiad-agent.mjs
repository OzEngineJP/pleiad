import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, get, setSessionData } from '../store.mjs';
import { t } from '../i18n.mjs';
import { editableField, hostTools, interactionQuestions } from './pleiad-agent-tools.mjs';
import { managedBackendIds } from './host-policy.mjs';
import { AGENT_TRAITS, CAPABILITY_STATES } from './agent-marks.mjs';

const ID = 'pleiad-agent';
const require = createRequire(import.meta.url);
const active = new Set();
const homeDir = path.join(dataDir, ID);
let resolveKey, plus;

function cliPath() {
  try {
    const override = process.env.AGENT_HOST_PLEIAD_AGENT_BIN;
    return override ? path.resolve(override) : require.resolve('pleiad-agent/cli');
  } catch { return null; }
}

function adapter(cli, module) {
  return import(pathToFileURL(path.join(path.dirname(cli), 'adapters', 'stdio', module + '.mjs')).href);
}

function modelSettings() {
  const prefix = 'AGENT_HOST_PLEIAD_AGENT_';
  const protocol = process.env[prefix + 'PROVIDER'] || 'openai';
  const model = process.env[prefix + 'MODEL'];
  if (!model || !['openai', 'anthropic'].includes(protocol)) return null;
  const official = protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  const url = new URL(process.env[prefix + 'BASE_URL'] || official);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid Pleiad Agent model endpoint');
  url.pathname = url.pathname.replace(/\/+$/, '') + (protocol === 'anthropic' ? '/messages' : '/chat/completions');
  return { model, protocol, url, official: new URL(official).origin, keyId: process.env[prefix + 'KEY_ID'],
    vision: process.env[prefix + 'VISION'] === '1', loopback };
}

function childEnvironment() {
  const inheritable = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritable.has(key.toUpperCase())));
  return { ...env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_RUN_AS_NODE: '1' };
}

async function saved(sessionId) {
  const cli = cliPath();
  if (!cli) return null;
  const { readHistory } = await adapter(cli, 'history');
  return readHistory({ homeDir, sessionId });
}

function textOf(content = []) {
  return content.filter(block => block.kind === 'text').map(block => block.text).join('');
}

function historyMessages(messages) {
  const rows = [];
  const calls = new Map();
  for (const message of messages) {
    const { role, content, id: uuid, createdAt } = message;
    if (role === 'tool') {
      for (const block of content) {
        const call = calls.get(block.toolCallId);
        if (call && block.kind === 'tool_result') {
          call.result = block.result?.data ?? block.result?.summary ?? block.result;
          call.isError = block.ok === false;
        }
      }
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const toolCalls = (content ?? []).filter(block => block.kind === 'tool_use').map(block => {
      const call = { id: block.toolCallId, name: block.name, input: block.args };
      calls.set(call.id, call);
      return call;
    });
    const text = textOf(content);
    if (text || toolCalls.length) rows.push({ role, uuid, text, ts: createdAt, ...(toolCalls.length ? { toolCalls } : {}) });
  }
  return rows;
}

function liveEvents(emit) {
  const textIds = new Set();
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let costKnown = true;
  return event => {
    switch (event.type) {
      case 'assistant.message.delta':
        textIds.add(event.messageId);
        emit({ type: 'text.delta', text: event.deltaText });
        break;
      case 'assistant.reasoning.delta':
        emit({ type: 'thinking.delta', text: event.deltaText });
        break;
      case 'assistant.message.completed': {
        const text = textOf(event.content);
        const streamed = textIds.delete(event.messageId);
        if (!streamed && text) emit({ type: 'text.delta', text });
        if (streamed || text) emit({ type: 'text.end', uuid: event.messageId });
        break;
      }
      case 'tool.call.scheduled':
        emit({ type: 'tool.start', id: event.toolCallId, name: event.name, input: event.args });
        break;
      case 'tool.call.completed': {
        const text = event.result?.data?.content ?? event.result?.summary ?? '';
        emit({ type: 'tool.result', id: event.toolCallId, text: typeof text === 'string' ? text : JSON.stringify(text), isError: !event.ok });
        break;
      }
      case 'usage.recorded':
        usage.inputTokens += event.inputTokens ?? 0;
        usage.outputTokens += event.outputTokens ?? 0;
        usage.cachedTokens += event.cacheReadTokens ?? 0;
        costKnown &&= Number.isFinite(event.costUsd);
        usage.costUsd = costKnown ? (usage.costUsd ?? 0) + event.costUsd : null;
        emit({ type: 'usage', ...usage });
        break;
    }
  };
}

// Keep authentication in the parent, including when a provider returns an error.
async function relayModel(frame, config, getKey, write, signal) {
  if (frame.body?.model !== config.model) throw new Error('Unexpected model');
  if (config.managed && frame.body.stream !== true) throw new Error('Plus requires streaming');
  const authorization = config.managed ? await getKey(signal) : { key: await getKey(signal) };
  const { key } = authorization;
  const headers = { 'content-type': 'application/json', ...authorization.headers };
  const body = { ...frame.body };
  // OpenRouter and the Plus proxy use the reasoning object.
  if (config.openRouter && body.reasoning_effort) {
    body.reasoning = { effort: body.reasoning_effort };
    delete body.reasoning_effort;
  }
  if (config.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  if (key) {
    const auth = config.auth ?? (config.protocol === 'anthropic' ? 'x-api-key' : 'bearer');
    if (auth === 'bearer') headers.authorization = 'Bearer ' + key;
    else if (auth === 'x-api-key' || auth === 'api-key') headers[auth] = key;
  }
  const response = await fetch(config.url, { method: 'POST', headers,
    body: JSON.stringify(body), signal, redirect: 'error' });
  // The body of an upstream error can include credentials. Send only the status.
  await write({ type: 'model.headers', id: frame.id, status: response.status,
    headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
  if (response.ok && response.body) {
    const decoder = new TextDecoder();
    let pending = '';
    async function chunk(value, final = false) {
      pending += value;
      const limit = final || !key ? pending.length : Math.max(0, pending.length - key.length + 1);
      let index = 0;
      let safe = '';
      while (index < limit) {
        if (key && pending.startsWith(key, index)) {
          safe += '[redacted]';
          index += key.length;
        } else safe += pending[index++];
      }
      // Preserve surrogate pairs when the retained suffix starts mid-character.
      if (!final && index > 0 && /[\uD800-\uDBFF]$/.test(safe)) {
        index--;
        safe = safe.slice(0, -1);
      }
      pending = pending.slice(index);
      if (safe) await write({ type: 'model.chunk', id: frame.id, data: Buffer.from(safe).toString('base64') });
    }
    for await (const buffer of response.body) await chunk(decoder.decode(buffer, { stream: true }));
    await chunk(decoder.decode(), true);
  } else await response.body?.cancel();
  await write({ type: 'model.end', id: frame.id });
}

function endpointSettings(endpoint, model) {
  const protocol = endpoint.kind === 'anthropic-messages' ? 'anthropic' : 'openai';
  model ||= endpoint.roles.main || endpoint.models[0];
  const url = new URL(endpoint.baseUrl + (protocol === 'anthropic' ? '/v1/messages' : '/chat/completions'));
  return { model, protocol, url, auth: endpoint.auth, openRouter: endpoint.preset === 'openrouter' || url.hostname === 'openrouter.ai',
    vision: endpoint.modelInfo?.[model]?.vision === true };
}

async function runTurn({ prompt, sessionId, hostSessionId, messageId, cwd, model, mode, effort, endpoint, emit, onPromptDelivered,
  signal: controller, control, askPermission, agentRuntime, contextRuntime, controlRuntime, shellRuntime,
  computerRuntime, browserRuntime, pendingDecision, addedInstructions }) {
  const signal = controller?.signal;
  const cli = cliPath();
  if (!cli) throw new Error('Configure the Pleiad Agent executable first');
  const conversation = hostSessionId ?? sessionId ?? messageId;
  if (active.has(conversation)) throw new Error('A Pleiad Agent turn is already active for this conversation');
  active.add(conversation);
  const id = pendingDecision?.turnId ?? messageId ?? randomUUID();
  const pendingSteers = new Map();
  const requests = new Map();
  const decisions = new Map();
  const modes = new Map();
  const handle = { setMode(next) {
    if (!turnSent || signal?.aborted || !supportsTools) return false;
    const request = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => settle(false), 3000);
      const settle = value => { clearTimeout(timer); modes.delete(request); resolve(value); };
      modes.set(request, settle);
      void send({ type: 'mode.set', id: request, turnId: id, mode: next });
    });
  } };
  let send, supportsTools = false;
  let child, closed, exit, timer, stopTimer, abort, protocolError;
  let outcome = 'error';
  let turnSent = false;
  let nativeId = sessionId;
  const normalize = liveEvents(emit);
  try {
    let config, getKey;
    const local = !managedBackendIds && !endpoint && modelSettings();
    if (local) {
      config = local;
      if (model && model !== config.model) throw new Error('The Pleiad Agent model configuration has changed');
      const key = config.keyId ? await resolveKey?.(config) : process.env.AGENT_HOST_PLEIAD_AGENT_API_KEY ||
        (config.url.origin === config.official ? process.env[config.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] : null);
      if (!key && (!config.loopback || config.keyId)) throw new Error('Configure the Pleiad Agent model key');
      getKey = () => key;
    } else if (!managedBackendIds && endpoint) {
      config = endpointSettings(endpoint, model);
      getKey = () => endpoint.key;
    } else {
      const catalog = await plus?.models(signal);
      model ||= Object.keys(catalog ?? {})[0];
      if (!model || !catalog || !Object.hasOwn(catalog, model)) throw new Error('Select an available Pleiad Plus model');
      config = { model, protocol: 'openai', url: plus.url, managed: true, openRouter: true, vision: catalog[model].vision === true };
      getKey = requestSignal => plus.authorization(model, requestSignal);
    }
    if (!config.model) throw new Error('Select a Pleiad Agent model');
    await mkdir(homeDir, { recursive: true });
    const { VERSION, readFrames, writeFrame } = await adapter(cli, 'frames');
    if (signal?.aborted) { outcome = 'aborted'; return; }
    child = spawn(process.execPath, [cli, 'stdio'], {
      cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => { child.kill(); });
    closed = new Promise(resolve => child.once('close', (code) => { exit = code; resolve(); }));
    const write = frame => writeFrame(child.stdin, frame);
    send = frame => write(frame).catch(() => { child.kill(); });
    const openId = randomUUID();
    const interruptId = randomUUID();
    abort = () => {
      if (turnSent) void send({ type: 'interrupt', id: interruptId, turnId: id });
      else child.kill();
      stopTimer ??= setTimeout(() => child.kill(), 3000);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => child.kill(), 15000);
    let greeted = false;
    for await (const frame of readFrames(child.stdout)) {
      if (!greeted) {
        if (frame.type !== 'hello' || frame.version !== VERSION) throw new Error('Unsupported Pleiad Agent protocol');
        greeted = true;
        supportsTools = frame.capabilities?.includes('host-tools');
        if (pendingDecision && !frame.capabilities?.includes('resume-decision')) throw new Error('Decision recovery is unavailable');
        const tools = supportsTools ? { mode: mode ?? 'default', ...hostTools({ ply_agents: agentRuntime, ply_context: contextRuntime,
          ply_control: controlRuntime, ply_shell: shellRuntime, ply_computer: computerRuntime,
          ply_browser: browserRuntime && { ...browserRuntime, instructions: 'Use ply_browser for browser handoff and downloads.' } }) } : {};
        if (supportsTools && addedInstructions) tools.instructions = [tools.instructions, addedInstructions].filter(Boolean).join('\n\n');
        await write({ type: 'open', id: openId, version: VERSION, ...(sessionId ? { sessionId, resume: true } : {}),
          protocol: config.protocol, model: config.model, vision: config.vision, reasoningEffort: effort, ...tools });
      } else if (frame.type === 'opened' && frame.id === openId && !turnSent) {
        clearTimeout(timer);
        nativeId = frame.sessionId;
        await emit({ type: 'session', sessionId: nativeId, first: !sessionId, model: config.model });
        if (signal?.aborted) break;
        await write(pendingDecision ? { type: 'turn.resume', id, requestId: pendingDecision.id } : { type: 'turn', id, prompt });
        turnSent = true;
        emit({ type: 'activity', state: 'thinking' });
      } else if (frame.type === 'accepted' && frame.id === id) {
        if (control) {
          control.handle = handle;
          control.steerConfirms = true;
          control.steer = item => {
            if (!item.id || !item.args?.prompt || item.args.attachments?.length || signal?.aborted) return false;
            if (!pendingSteers.has(item.id)) {
              pendingSteers.set(item.id, true);
              void send({ type: 'steer', id: item.id, turnId: id, prompt: item.args.prompt });
            }
            return true;
          };
        }
      } else if (frame.type === 'delivered' && frame.turnId === id) {
        if (frame.id === id) onPromptDelivered?.(frame.messageId);
        else if (pendingSteers.delete(frame.id)) emit({ type: 'userMessage.delivered', messageId: frame.id, nativeId: frame.messageId });
      } else if (frame.type === 'event' && frame.turnId === id) {
        normalize(frame.event);
      } else if ((frame.type === 'accepted' || frame.type === 'error') && modes.has(frame.id)) {
        modes.get(frame.id)(frame.type === 'accepted');
      } else if (frame.type === 'decision.cancel' && frame.turnId === id) {
        decisions.get(frame.id)?.abort();
      } else if ((frame.type === 'approval.request' || frame.type === 'interaction.request') && frame.turnId === id && !decisions.has(frame.id)) {
        const decision = new AbortController();
        decisions.set(frame.id, decision);
        const decisionSignal = signal ? AbortSignal.any([signal, decision.signal]) : decision.signal;
        void resolveDecision(frame, { sessionId: hostSessionId ?? nativeId, askPermission, signal: decisionSignal,
          restoring: pendingDecision?.id === frame.id })
          .catch(() => ({ allow: false }))
          .then(answer => {
            if (!decisionSignal.aborted) return send({ type: frame.type.replace('.request', '.resolve'), id: randomUUID(),
              requestId: frame.id, turnId: id, ...answer });
          }).finally(() => decisions.delete(frame.id));
      } else if (frame.type === 'model.request' && frame.turnId === id && !requests.has(frame.id)) {
        const request = new AbortController();
        requests.set(frame.id, request);
        void relayModel(frame, config, getKey, write, request.signal).catch(() => {
          if (!request.signal.aborted) return send({ type: 'model.error', id: frame.id });
        }).finally(() => requests.delete(frame.id));
      } else if (frame.type === 'model.cancel') {
        requests.get(frame.id)?.abort();
      } else if (frame.type === 'finished' && frame.turnId === id) {
        outcome = ({ ok: 'ok', duplicate: 'ok', aborted: 'aborted' })[frame.outcome] ?? 'error';
        if (outcome === 'error') protocolError = 'Pleiad Agent could not complete the turn';
        break;
      } else if (frame.type === 'error' && pendingSteers.delete(frame.id)) {
        emit({ type: 'userMessage.dropped', messageId: frame.id });
      } else if ((frame.type === 'error' && [id, openId].includes(frame.id)) || frame.type === 'fatal') {
        protocolError = 'Pleiad Agent rejected the request';
        break;
      }
    }
  } catch (error) {
    protocolError = error instanceof Error && !child ? error.message : 'Pleiad Agent connection failed';
  } finally {
    clearTimeout(timer);
    clearTimeout(stopTimer);
    signal?.removeEventListener('abort', abort);
    for (const request of requests.values()) request.abort();
    for (const decision of decisions.values()) decision.abort();
    for (const settle of modes.values()) settle(false);
    if (control) { control.steer = null; control.steerConfirms = false; if (control.handle === handle) control.handle = null; }
    if (child) {
      child.stdin.end();
      const reap = setTimeout(() => child.kill(), 3000);
      await closed;
      clearTimeout(reap);
    }
    for (const messageId of pendingSteers.keys()) emit({ type: 'userMessage.dropped', messageId, unknown: outcome === 'error' });
    active.delete(conversation);
    if (signal?.aborted) outcome = 'aborted';
    else if (exit !== 0) outcome = 'error';
    emit({ type: 'turnResult', outcome, ...(nativeId ? { sessionId: nativeId } : {}),
      ...(outcome === 'error' ? { error: protocolError ?? 'Pleiad Agent exited before completing the turn' } : {}) });
  }
}

async function resolveDecision(frame, { sessionId, askPermission, signal, restoring }) {
  if (!sessionId || signal.aborted || typeof askPermission !== 'function') return { allow: false };
  const question = frame.type === 'interaction.request';
  const questions = question ? interactionQuestions(frame, [['approved', t('ui:chat.approval.allow')], ['denied', t('ui:chat.approval.deny')]]) : null;
  if (question && !questions.length) return { allow: false };
  const field = editableField(frame.toolName);
  const canAlways = !question && (field !== null || frame.toolName === 'Edit');
  const granted = canAlways ? (await get(sessionId)).pleiadAgentAlwaysAllow ?? [] : [];
  if (!restoring && granted.includes(frame.toolName)) return { allow: !signal.aborted };
  const answer = await askPermission({ sessionId, signal, toolName: frame.toolName, title: frame.summary,
    toolUseID: frame.id, input: question ? { questions } : frame.input, canAlways,
    kind: question ? 'question' : 'tool', questions, editableField: field });
  if (signal.aborted || !answer?.allow) return { allow: false };
  if (answer.always && canAlways) await setSessionData(sessionId, 'pleiadAgentAlwaysAllow', [...new Set([...granted, frame.toolName])], { durable: true });
  if (question) {
    return { allow: true, answers: Object.fromEntries(questions.filter(q => Object.hasOwn(answer.answers ?? {}, q.question))
      .map(q => [q.id, answer.answers[q.question]])) };
  }
  return { allow: true, ...(field && typeof answer.editedInput === 'string' ? { [field]: answer.editedInput } : {}) };
}

export const backend = {
  id: 'pleiad-agent',
  label: 'Pleiad Agent',
  defaultConnectionLabel: 'Pleiad Plus',
  capabilities: CAPABILITY_STATES[ID],
  traits: AGENT_TRAITS[ID],
  modes: () => ({
    default: { label: t('modes.ask'), scope: 'workspace', autonomy: 'ask', enforced: false },
    auto: { label: 'auto', scope: 'workspace', autonomy: 'ask', enforced: false },
    acceptEdits: { label: t('modes.acceptEdits'), scope: 'workspace', autonomy: 'judge', enforced: false },
    plan: { label: t('modes.plan'), scope: 'readonly', autonomy: 'ask', enforced: true },
    readonly: { label: 'Read-only', scope: 'readonly', autonomy: 'never', enforced: true },
    bypass: { label: 'Bypass', scope: 'full', autonomy: 'never', enforced: false },
  }),
  async setModeLive(handle, mode) { return await handle?.setMode?.(mode) === true; },
  models: async () => {
    const config = !managedBackendIds && modelSettings();
    return config ? { [config.model]: { label: config.model, efforts: ['minimal', 'low', 'medium', 'high'] } }
      : await plus?.models().catch(() => ({})) ?? {};
  },
  async listSessions({ limit = 100 } = {}) {
    const cli = cliPath();
    if (!cli) return [];
    const { listHistory } = await adapter(cli, 'history');
    return listHistory({ homeDir, limit });
  },
  async getSession(sessionId) {
    const { meta } = (await saved(sessionId)) ?? {};
    return meta ? { ...meta, lastModified: meta.updatedAt } : null;
  },
  async getMessages(sessionId) {
    return historyMessages((await saved(sessionId))?.messages ?? []);
  },
  async getPendingDecision(sessionId) {
    const cli = cliPath();
    if (!cli) return null;
    const { readPendingDecision } = await adapter(cli, 'history');
    return readPendingDecision?.({ homeDir, sessionId }) ?? null;
  },
  attachHost(host) {
    resolveKey = host.pleiadAgentModelKey;
    plus = host.pleiadAgentPlus;
  },
  runTurn,
};
