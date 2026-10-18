import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

// grok の身代わり。`grok agent [オプション] stdio`（ACP over stdio）だけを真似る（LLM は呼ばない）。
const argv = process.argv.slice(2);
const version = argv.find(v => ['version', '--version'].includes(v));
if (version) { console.log('grok 1.0.62 (fixture)'); process.exit(0); }
if (argv[0] === 'models') {
  console.log('Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5');
  process.exit(0);
}
if (argv[0] !== 'agent' || !argv.includes('stdio')) process.exit(2);

const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const spawnModel = flag('--model') ?? 'grok-4.6';
const spawnEffort = flag('--reasoning-effort') ?? 'high';

const EFFORTS = [
  { id: 'xhigh', value: 'xhigh', label: 'Extra High Effort', default: false },
  { id: 'high', value: 'high', label: 'High Effort', default: true },
  { id: 'medium', value: 'medium', label: 'Medium Effort', default: false },
  { id: 'low', value: 'low', label: 'Low Effort', default: false },
];
const MODELS = [
  { modelId: 'grok-4.6', name: 'Grok 4.6', description: "SpaceXAI's latest frontier model" },
  { modelId: 'grok-4.5', name: 'Grok 4.5', description: 'fixture model' },
];
const modelState = (current) => ({
  currentModelId: current,
  availableModels: MODELS.map(m => ({ ...m, _meta: { totalContextTokens: 500000, supportsReasoningEffort: true, reasoningEffort: m.modelId === current ? spawnEffort : 'high', reasoningEfforts: EFFORTS } })),
});
const MODE_IDS = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'];
const modesFor = current => ({ currentModeId: current, availableModes: MODE_IDS.map(id => ({ id, name: id, description: `fixture mode ${id}` })) });
const configOptions = session => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: MODELS.map(m => ({ value: m.modelId, name: m.name })) },
  { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: session.effort, options: EFFORTS.map(e => ({ value: e.value, name: e.label })) },
];
// Grok のターンの終わりは `_x.ai/session_notification` で届く（内側は同じ sessionUpdate の形）
const notify = (sessionId, value) => write({ method: '_x.ai/session_notification', params: { sessionId, update: value } });

const stateDir = process.env.FAKE_GROK_STATE_DIR || (process.env.GROK_HOME ? path.join(process.env.GROK_HOME, 'sessions') : '');
if (stateDir) fs.mkdirSync(stateDir, { recursive: true });
const sessions = new Map(), running = new Map(), pending = new Map();
let seq = 0;
const file = id => path.join(stateDir, `${id}.json`);
const persist = session => { sessions.set(session.sessionId, session); if (stateDir) fs.writeFileSync(file(session.sessionId), JSON.stringify(session)); };
const load = id => {
  if (sessions.has(id)) return sessions.get(id);
  if (!/^grok-fixture-[\w-]+$/.test(id ?? '')) throw new Error('Unknown session');
  const session = stateDir ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : null;
  if (!session) throw new Error('Unknown session');
  sessions.set(id, session); return session;
};
const write = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const update = (sessionId, value) => write({ method: 'session/update', params: { sessionId, update: value } });
const ask = (method, params) => new Promise((resolve, reject) => { const id = `fixture-request-${++seq}`; pending.set(id, { resolve, reject, sessionId: params.sessionId }); write({ id, method, params }); });
function replay(session) {
  for (const message of session.messages) {
    if (message.role === 'user') update(session.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.text } });
    else {
      if (message.thinking) update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: message.thinking } });
      for (const tool of message.toolCalls ?? []) {
        update(session.sessionId, { sessionUpdate: 'tool_call', toolCallId: tool.id, title: tool.name, rawInput: tool.input, status: 'running' });
        update(session.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: tool.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: tool.result } }] });
      }
      update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.text } });
    }
  }
}
function cancel(id) {
  const token = running.get(id);
  if (token && !token.stubborn) { token.cancelled = true; token.wake?.(); }
  const session = sessions.get(id);
  for (const queued of session?.queue ?? []) write({ id: queued.id, result: { stopReason: 'cancelled' } });
  if (session) session.queue = [];
  for (const [key, waiter] of pending) if (waiter.sessionId === id) { pending.delete(key); waiter.resolve({ outcome: { outcome: 'cancelled' } }); }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (!request.method) {
    const waiter = pending.get(request.id); if (!waiter) return;
    pending.delete(request.id); request.error ? waiter.reject(new Error(request.error.message)) : waiter.resolve(request.result); return;
  }
  if (request.method === 'session/cancel') { cancel(request.params?.sessionId); if (request.id !== undefined) write({ id: request.id, result: {} }); return; }
  if (request.id === undefined) return;
  try {
    let result;
    const p = request.params ?? {};
    switch (request.method) {
      case 'initialize': result = {
        protocolVersion: 1,
        agentInfo: { name: 'fake-grok', version: '1.0.62' },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
        authMethods: [{ id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' }],
        _meta: { modelState: modelState(spawnModel) },
      }; break;
      case 'session/new': {
        if (process.env.FAKE_GROK_AUTH === '0') throw Object.assign(new Error('Authentication required'), { code: -32002 });
        const session = { sessionId: `grok-fixture-${crypto.randomUUID()}`, cwd: p.cwd, messages: [], mode: 'default', model: spawnModel, effort: spawnEffort };
        persist(session);
        // 実機は modes を返さず、models と configOptions（model・reasoning_effort）を返す
        result = { sessionId: session.sessionId, models: { currentModelId: session.model, availableModels: MODELS }, configOptions: configOptions(session) }; break;
      }
      case 'session/load': {
        const session = load(p.sessionId);
        if (p.cwd && session.cwd !== p.cwd) throw new Error('cwd mismatch');
        replay(session);
        result = { sessionId: session.sessionId, models: { currentModelId: session.model, availableModels: MODELS }, configOptions: configOptions(session) }; break;
      }
      case 'session/list': {
        if (stateDir) for (const name of fs.readdirSync(stateDir).filter(name => /^grok-fixture-.*\.json$/.test(name))) { const s = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')); sessions.set(s.sessionId, s); }
        result = { sessions: [...sessions.values()].filter(s => !p.cwd || s.cwd === p.cwd).map(s => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title ?? null })) }; break;
      }
      case 'session/set_mode': {
        const session = load(p.sessionId);
        if (!MODE_IDS.includes(p.modeId)) throw new Error('Unsupported mode');
        session.mode = p.modeId; persist(session);
        notify(session.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId });
        result = {}; break;
      }
      case 'session/prompt': {
        const session = load(p.sessionId), text = (p.prompt ?? []).map(v => v.text ?? '').join('');
        // 走っている回への prompt は内蔵の待ち行列に積む（実機の振る舞い。今の回が終わってから続けて回す）
        if (running.has(session.sessionId)) { (session.queue ??= []).push({ id: request.id, text }); return; }
        const token = { cancelled: false, stubborn: text.includes('[stubborn]') }; running.set(session.sessionId, token);
        session.messages.push({ role: 'user', text }); persist(session);
        update(session.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
        if (text.includes('[kill]')) process.exit(17);
        if (text.includes('[slow]') || token.stubborn) await new Promise(resolve => { const timer = setTimeout(resolve, token.stubborn ? 60000 : Number(process.env.FAKE_GROK_SLOW_MS || 5000)); token.wake = () => { clearTimeout(timer); resolve(); }; });
        if (token.cancelled) { running.delete(session.sessionId); result = { stopReason: 'cancelled' }; break; }
        if (text.includes('[frame-malformed]')) { process.stdout.write('{not-json}\n'); break; }
        const tools = [];
        if (text.includes('[permission]') || text.includes('[tool]')) {
          const tool = { id: crypto.randomUUID(), name: 'Fixture permission', input: { command: 'echo fixture' }, result: 'fixture tool result' };
          update(session.sessionId, { sessionUpdate: 'tool_call', toolCallId: tool.id, title: tool.name, kind: 'execute', rawInput: tool.input, status: 'running' });
          if (text.includes('[permission]')) {
            await ask('session/request_permission', { sessionId: session.sessionId, toolCall: { toolCallId: tool.id, title: tool.name, rawInput: tool.input }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' }] });
          }
          update(session.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: tool.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: tool.result } }] });
          tools.push(tool);
        }
        update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } });
        const reply = `fixture: ${text}`;
        const middle = Math.ceil(reply.length / 2);
        update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, middle) } });
        update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(middle) } });
        session.messages.push({ role: 'assistant', text: reply, thinking: 'fixture thought', toolCalls: tools }); persist(session); running.delete(session.sessionId);
        notify(session.sessionId, { sessionUpdate: 'turn_completed', stop_reason: token.cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
        result = { stopReason: token.cancelled ? 'cancelled' : 'end_turn' };
        write({ id: request.id, result });
        // 待ち行列に積まれた途中送信を、並んだ順に続けて回す
        while (session.queue?.length) {
          const queued = session.queue.shift();
          const qtoken = { cancelled: false }; running.set(session.sessionId, qtoken);
          session.messages.push({ role: 'user', text: queued.text }); persist(session);
          update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } });
          const qreply = `fixture: ${queued.text}`, qmiddle = Math.ceil(qreply.length / 2);
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: qreply.slice(0, qmiddle) } });
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: qreply.slice(qmiddle) } });
          session.messages.push({ role: 'assistant', text: qreply, thinking: 'fixture thought' }); persist(session); running.delete(session.sessionId);
          notify(session.sessionId, { sessionUpdate: 'turn_completed', stop_reason: qtoken.cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
          write({ id: queued.id, result: { stopReason: qtoken.cancelled ? 'cancelled' : 'end_turn' } });
        }
        // 圧縮で履歴を書き換える（最初の 1 往復を落とす）。次の session/load の再生は、位置がずれて返る
        if (text.includes('[compact-rewrite]')) { session.messages.splice(0, 2); persist(session); }
        return;
      }
      default: throw new Error(`Unsupported method: ${request.method}`);
    }
    write({ id: request.id, result });
  } catch (error) { write({ id: request.id, error: { code: Number.isInteger(error?.code) ? error.code : -32000, message: error.message } }); }
});
