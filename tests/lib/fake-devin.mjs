import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const argv = process.argv.slice(2), command = argv.find(value => ['models', 'auth', 'acp', 'version', '--version'].includes(value));
const catalogue = { families: [
  { family_uid: 'swe-2', family_label: 'SWE-2', slug: 'swe-2', variants: ['high', 'medium', 'max'].map(level => ({ model_uid: `swe-2-${level}`, label: `SWE-2 ${level}`, cost_tier: 'Free', max_context_tokens: 262000 })) },
  { family_uid: 'fixture-paid', family_label: 'Fixture paid', slug: 'fixture-paid', variants: [{ model_uid: 'paid-exact', label: 'Fixture paid', cost_tier: 'High cost', cost_summary: '$1 per unit' }] },
] };
if (command === '--version' || command === 'version') { console.log('3000.11.92'); process.exit(0); }
if (command === 'models') { console.log(process.env.FAKE_DEVIN_CATALOGUE ? fs.readFileSync(process.env.FAKE_DEVIN_CATALOGUE, 'utf8') : JSON.stringify(catalogue)); process.exit(0); }
if (command === 'auth') { console.log('{"authenticated":true}'); process.exit(0); }
if (command !== 'acp') process.exit(2);

const stateDir = process.env.FAKE_DEVIN_STATE_DIR || process.env.DEVIN_SESSIONS_DIR || '';
if (stateDir) fs.mkdirSync(stateDir, { recursive: true });
const sessions = new Map(), running = new Map(), pending = new Map();
let seq = 0;
const file = id => path.join(stateDir, `${id}.json`);
const persist = session => { sessions.set(session.sessionId, session); if (stateDir) fs.writeFileSync(file(session.sessionId), JSON.stringify(session)); };
const load = id => {
  if (sessions.has(id)) return sessions.get(id);
  if (!/^devin-fixture-[\w-]+$/.test(id ?? '')) throw new Error('Unknown session');
  const session = stateDir ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : null;
  if (!session) throw new Error('Unknown session');
  sessions.set(id, session); return session;
};
const configs = session => [
  { id: 'mode', category: 'mode', type: 'select', currentValue: session.mode, options: ['ask', 'accept-edits', 'smart', 'plan', 'bypass'].map(value => ({ value, name: value })) },
  { id: 'model', category: 'model', type: 'select', currentValue: session.model, options: [{ group: 'Models', options: [{ value: 'swe-2-high', name: 'SWE-2' }, { value: 'paid-exact', name: 'Fixture paid' }] }] },
  ...(session.model === 'paid-exact' ? [] : [{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: session.thought_level, options: ['medium', 'high', 'max'].map(value => ({ value, name: value })) }]),
  { id: 'speed', category: 'model_config', type: 'select', currentValue: session.speed, options: ['standard', 'fast'].map(value => ({ value, name: value })) },
];
const write = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const update = (sessionId, value) => write({ method: 'session/update', params: { sessionId, update: value } });
const ask = (method, params) => new Promise((resolve, reject) => { const id = `fixture-request-${++seq}`; pending.set(id, { resolve, reject, sessionId: params.sessionId }); write({ id, method, params }); });
function replay(session) {
  for (const message of session.messages) {
    if (message.role === 'user') update(session.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.text } });
    else {
      if (message.thinking) update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: message.thinking } });
      for (const tool of message.toolCalls ?? []) {
        update(session.sessionId, { sessionUpdate: 'tool_call', toolCallId: tool.id, title: tool.name, rawInput: tool.input, ...(tool.content ? { content: tool.content } : {}), status: 'running' });
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
  for (const steer of session?.steerQueue ?? []) write({ id: steer.id, result: { stopReason: 'cancelled' } });
  if (session) session.steerQueue = [];
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
      case 'fixture/no-reply': return;
      case 'initialize': result = { protocolVersion: 1, agentInfo: { name: 'fake-devin', version: '3000.11.92' }, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: false } } }; break;
      case 'session/new': {
        const session = { sessionId: `devin-fixture-${crypto.randomUUID()}`, cwd: p.cwd, messages: [], mode: 'accept-edits', model: 'swe-2-high', thought_level: 'high', speed: 'fast', used: 120000, window: 262000,
          // 起動で届いたもの（mcpServers・Pleiad からの環境変数）。配達物の試験が読む
          mcpServers: p.mcpServers ?? [], seenEnv: Object.keys(process.env).filter(k => /^(AGENT_BROWSER_|PLEIAD_CONTROL_)/.test(k)) };
        persist(session); update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session) });
        result = { sessionId: session.sessionId, configOptions: configs(session) }; break;
      }
      case 'session/load': {
        const session = load(p.sessionId);
        if (p.cwd && session.cwd !== p.cwd) throw new Error('cwd mismatch');
        replay(session); update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session) });
        update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used ?? 120000, size: session.window ?? 262000 });
        result = { sessionId: session.sessionId, configOptions: configs(session) }; break;
      }
      case 'session/list': {
        if (stateDir) for (const name of fs.readdirSync(stateDir).filter(name => /^devin-fixture-.*\.json$/.test(name))) { const s = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')); sessions.set(s.sessionId, s); }
        result = { sessions: [...sessions.values()].filter(s => !p.cwd || s.cwd === p.cwd).map(s => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title ?? null })) }; break;
      }
      case 'session/set_config_option': {
        const session = load(p.sessionId), option = configs(session).find(o => o.id === p.configId);
        const flatten = values => values.flatMap(v => v.options ? flatten(v.options) : [v.value]);
        if (!option || !flatten(option.options).includes(p.value)) throw new Error('Unsupported config value');
        session[p.configId] = p.value; persist(session);
        const options = configs(session);
        if (process.env.FAKE_DEVIN_BAD_ACK === p.configId) options.find(o => o.id === p.configId).currentValue = 'wrong';
        const drift = process.env.FAKE_DEVIN_SETUP_DRIFT;
        if (p.configId === 'speed' && drift) {
          const frames = [];
          const configFrame = values => ({ method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: values } } });
          const modeFrame = value => ({ method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: value } } });
          if (drift === 'before-mode') {
            session.mode = 'bypass'; frames.push(modeFrame(session.mode));
            frames.push({ id: request.id, result: { configOptions: configs(session) } });
          } else {
            if (drift === 'before-recovered') frames.push(modeFrame('bypass'));
            frames.push({ id: request.id, result: { configOptions: options } });
            if (drift === 'after-mode') { session.mode = 'bypass'; frames.push(modeFrame(session.mode)); }
            if (drift === 'after-model') { session.model = 'paid-exact'; frames.push(configFrame(configs(session))); }
            if (drift === 'after-config-mode') { session.mode = 'bypass'; frames.push(configFrame(configs(session))); }
            if (drift === 'after-empty') frames.push(configFrame([]));
            if (drift === 'after-duplicate') frames.push(configFrame([...options, options[0]]));
            if (drift === 'after-recovered') { frames.push(modeFrame('bypass')); frames.push(configFrame(options)); }
          }
          persist(session);
          // One write forces ACK + notifications through one transport batch.
          process.stdout.write(frames.map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n');
          return;
        }
        update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: options });
        result = { configOptions: options }; break;
      }
      case 'session/prompt': {
        const session = load(p.sessionId), text = (p.prompt ?? []).map(v => v.text ?? '').join('');
        // 走っている回への prompt は同じ回に折り込む（実機の振る舞い。応答は回の終わりにまとめて返る）
        if (running.has(session.sessionId)) {
          // [fast-steer]: 呼び出しが直ぐに成功で決着する（受理の判定の窓より速い成功。合図が受理の応答より先に出る順の試験用）
          if (text.includes('[fast-steer]')) { session.messages.push({ role: 'user', text }); persist(session); write({ id: request.id, result: { stopReason: 'end_turn' } }); return; }
          (session.steerQueue ??= []).push({ id: request.id, text }); return;
        }
        if (text === '/compact') {
          // ACP のスラッシュコマンドは prompt の本文として届く。発言は増やさず、占有だけ減らして usage_update を流す
          session.used = Math.max(20000, Math.round((session.used ?? 120000) * 0.15)); persist(session);
          update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used, size: session.window });
          result = { stopReason: 'end_turn' }; break;
        }
        const token = { cancelled: false, stubborn: text.includes('[stubborn]') }; running.set(session.sessionId, token);
        session.messages.push({ role: 'user', text }); persist(session);
        update(session.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
        if (text.includes('[kill]')) process.exit(17);
        if (text.includes('[slow]') || token.stubborn) await new Promise(resolve => { const timer = setTimeout(resolve, token.stubborn ? 60000 : Number(process.env.FAKE_DEVIN_SLOW_MS || 5000)); token.wake = () => { clearTimeout(timer); resolve(); }; });
        if (token.cancelled) { running.delete(session.sessionId); for (const steer of session.steerQueue ?? []) write({ id: steer.id, result: { stopReason: 'cancelled' } }); session.steerQueue = []; result = { stopReason: 'cancelled' }; break; }
        if (text.includes('[frame-malformed]')) { process.stdout.write('{not-json}\n'); break; }
        const drift = ['model', 'thought_level', 'speed'].find(kind => text.includes(`[${kind}-drift]`));
        if (drift) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session).map(o => o.id === drift ? { ...o, currentValue: 'unexpected' } : o) });
        if (text.includes('[config-valid]')) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session) });
        if (text.includes('[config-empty]')) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: [] });
        if (text.includes('[config-invalid]')) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: null });
        for (const kind of ['mode', 'model', 'thought_level', 'speed']) {
          if (text.includes(`[${kind}-missing]`)) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session).filter(o => o.id !== kind) });
          if (text.includes(`[${kind}-duplicate]`)) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: [...configs(session), configs(session).find(o => o.id === kind)] });
          if (text.includes(`[${kind}-renamed]`)) update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session).map(o => o.id === kind ? { ...o, id: `${kind}-new` } : o) });
        }
        if (text.includes('[mode-drift]')) update(session.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'bypass' });
        let permissionResult = null;
        const tools = [];
        const permissionKind = ['permission', 'permission-id-only', 'permission-partial', 'permission-null', 'permission-unknown'].find(kind => text.includes(`[${kind}]`));
        if (text.includes('[large-edit]')) {
          const unchanged = 'const line = "日本語🙂";\n'.repeat(24000);
          const tool = { id: crypto.randomUUID(), name: 'Edit file', input: { file_path: 'large.mjs', oldText: unchanged + 'before', newText: unchanged + 'after' },
            content: [{ type: 'diff', path: 'large.mjs', oldText: unchanged + 'before', newText: unchanged + 'after' }], result: 'edited' };
          update(session.sessionId, { sessionUpdate: 'tool_call', toolCallId: tool.id, title: tool.name, kind: 'edit', rawInput: tool.input, content: tool.content, status: 'running' });
          update(session.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: tool.id, status: 'completed' });
          tools.push(tool);
        }
        if (permissionKind || text.includes('[tool]')) {
          const tool = { id: crypto.randomUUID(), name: 'Fixture permission', input: { command: 'echo fixture' }, result: 'fixture tool result' };
          if (permissionKind !== 'permission-unknown') update(session.sessionId, { sessionUpdate: 'tool_call', toolCallId: tool.id, title: tool.name, kind: 'execute', rawInput: tool.input, status: 'running' });
          if (permissionKind) {
            const requestTool = permissionKind === 'permission' ? { toolCallId: tool.id, title: tool.name, rawInput: tool.input }
              : permissionKind === 'permission-partial' ? { toolCallId: tool.id, title: 'Updated permission' }
              : permissionKind === 'permission-null' ? { toolCallId: tool.id, title: null, rawInput: null }
              : { toolCallId: tool.id };
            permissionResult = await ask('session/request_permission', { sessionId: session.sessionId, toolCall: requestTool, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' }] });
          }
          update(session.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: tool.id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: tool.result } }] }); tools.push(tool);
        }
        update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } });
        let reply = `fixture: ${text}`;
        if (text.includes('[env]')) reply = JSON.stringify({ cwd: process.cwd(), configHome: process.env.DEVIN_CONFIG_HOME ?? null, sessions: process.env.DEVIN_SESSIONS_DIR,
          mcpServers: (session.mcpServers ?? []).map(s => s.name), seenEnv: session.seenEnv ?? [] });
        if (text.includes('[multi-utf8]')) {
          const frame = `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '日本語🙂' } } } })}\n`;
          const bytes = Buffer.from(frame), split = bytes.indexOf(Buffer.from('🙂')) + 2;
          process.stdout.write(bytes.subarray(0, split)); await new Promise(r => setTimeout(r, 5)); process.stdout.write(bytes.subarray(split));
          reply = `日本語🙂${reply}`;
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice('日本語🙂'.length) } });
        } else {
          const middle = Math.ceil(reply.length / 2);
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, middle) } });
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(middle) } });
        }
        session.messages.push({ role: 'assistant', text: reply, thinking: 'fixture thought', toolCalls: tools });
        session.used = Math.min(session.window, (session.used ?? 120000) + 30000); persist(session); running.delete(session.sessionId);
        update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used, size: session.window });
        result = { stopReason: token.cancelled ? 'cancelled' : 'end_turn', permissionResult };
        write({ id: request.id, result });
        // 折り込まれた途中送信も、同じ回の続きとして返し、並んだ順に応答を書く
        for (const steer of session.steerQueue ?? []) {
          // [drop-steer]: 受理したが読んだか分からないまま cancelled で決着する（既読不明の試験用）
          if (steer.text.includes('[drop-steer]')) { write({ id: steer.id, result: { stopReason: 'cancelled' } }); continue; }
          session.messages.push({ role: 'user', text: steer.text });
          update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } });
          const steerReply = `fixture: ${steer.text}`, steerMiddle = Math.ceil(steerReply.length / 2);
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: steerReply.slice(0, steerMiddle) } });
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: steerReply.slice(steerMiddle) } });
          session.messages.push({ role: 'assistant', text: steerReply, thinking: 'fixture thought' });
          write({ id: steer.id, result: { stopReason: 'end_turn' } });
        }
        session.steerQueue = []; persist(session);
        // 圧縮で履歴を書き換える（最初の 1 往復を落とす）。次の session/load の再生は、位置がずれて返る
        if (text.includes('[compact-rewrite]')) { session.messages.splice(0, 2); persist(session); }
        return;
      }
      default: throw new Error(`Unsupported method: ${request.method}`);
    }
    write({ id: request.id, result });
  } catch (error) { write({ id: request.id, error: { code: -32000, message: error.message } }); }
});
