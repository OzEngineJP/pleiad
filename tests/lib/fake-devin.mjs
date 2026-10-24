import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2), command = argv.find(value => ['models', 'auth', 'acp', 'version', '--version'].includes(value));
// 実機（3000.11.92）の形: model の選択肢は系列の代表だけで、thought_level・speed の
// 有無と選択肢は選んだ model で変わる。model を切り替えると thought_level は代表 uid の接尾辞の段に戻る
const MODELS = {
  'swe-2-high': { thought: ['medium', 'high', 'max'], implicit: 'high', speed: ['standard', 'fast'] },
  'deepseek-v4-1-flash-1017-high': { thought: ['none', 'low', 'high', 'max'], implicit: 'high' },
  'glm-5-2': { thought: ['none', 'high', 'max'], implicit: 'high' },
  'glm-5-2-1m': { thought: ['none', 'high', 'max'], implicit: 'high' },
  'swe-1-7-medium': { thought: ['medium', 'max'], implicit: 'medium' },
  'claude-opus-5-5-medium': { thought: ['low', 'medium', 'high', 'xhigh', 'max'], implicit: 'medium', speed: ['standard', 'fast'] },
  'gpt-6-astra-medium': { thought: ['low', 'medium', 'high', 'xhigh', 'max'], implicit: 'medium' },
  'kimi-k2-6': {},
  'paid-exact': {},
};
const catalogue = { families: [
  { family_uid: 'swe-2', family_label: 'SWE-2', slug: 'swe-2', variants: ['high', 'medium', 'max'].flatMap(level => [
    { model_uid: `swe-2-${level}`, label: `SWE-2 ${level}`, cost_tier: 'Free', max_context_tokens: 262000 },
    { model_uid: `swe-2-${level}-lightning`, label: `SWE-2 ${level} Lightning`, cost_tier: 'High cost', cost_summary: '$1 / 1M Input', max_context_tokens: 262144 },
  ]) },
  { family_uid: 'deepseek-v4-1-flash-1017', family_label: 'DeepSeek V4.1 Flash', slug: 'deepseek-v4.1-flash', variants: ['none', 'low', 'high', 'max'].map(level => ({ model_uid: `deepseek-v4-1-flash-1017-${level}`, label: `DeepSeek V4.1 Flash ${level}`, cost_tier: 'Low cost' })) },
  { family_uid: 'glm-5.2', family_label: 'GLM-5.2', slug: 'glm-5.2', variants: ['glm-5-2', 'glm-5-2-max', 'glm-5-2-none', 'glm-5-2-1m', 'glm-5-2-max-1m', 'glm-5-2-none-1m'].map(id => ({ model_uid: id, label: id, cost_tier: 'Low cost' })) },
  { family_uid: 'swe-1.7', family_label: 'SWE-1.7', slug: 'swe-1.7', variants: [{ model_uid: 'swe-1-7', label: 'SWE-1.7 Max', cost_tier: 'Low cost' }, { model_uid: 'swe-1-7-medium', label: 'SWE-1.7 Medium', cost_tier: 'Low cost' }] },
  { family_uid: 'claude-opus-5-5', family_label: 'Claude Opus 5.5', slug: 'claude-opus-5.5', variants: ['low', 'medium', 'high', 'xhigh', 'max'].flatMap(level => [{ model_uid: `claude-opus-5-5-${level}`, cost_tier: 'High cost' }, { model_uid: `claude-opus-5-5-${level}-fast`, cost_tier: 'High cost' }]) },
  { family_uid: 'gpt-6-astra', family_label: 'GPT-6 Astra', slug: 'gpt-6-astra', variants: ['low', 'medium', 'high', 'xhigh', 'max'].flatMap(level => [{ model_uid: `gpt-6-astra-${level}`, cost_tier: 'High cost' }, { model_uid: `gpt-6-astra-${level}-priority`, cost_tier: 'High cost' }]) },
  { family_uid: 'kimi-k2.6', family_label: 'Kimi K2.6', slug: 'kimi-k2.6', variants: [{ model_uid: 'kimi-k2-6', label: 'Kimi K2.6', cost_tier: 'Low cost' }] },
  { family_uid: 'fixture-paid', family_label: 'Fixture paid', slug: 'fixture-paid', variants: [{ model_uid: 'paid-exact', label: 'Fixture paid', cost_tier: 'High cost', cost_summary: '$1 per unit' }] },
] };
if (command === '--version' || command === 'version') { console.log('3000.11.92'); process.exit(0); }
if (command === 'models') { console.log(process.env.FAKE_DEVIN_CATALOGUE ? fs.readFileSync(process.env.FAKE_DEVIN_CATALOGUE, 'utf8') : JSON.stringify(catalogue)); process.exit(0); }
if (command === 'auth') {
  // ログイン状態はファイルに持つ（FAKE_DEVIN_AUTH_FILE。内容は in / out。無ければ in）。`auth login`・`auth logout` で替わる
  const authFile = process.env.FAKE_DEVIN_AUTH_FILE || '';
  const read = () => { try { return fs.readFileSync(authFile, 'utf8').trim() === 'in'; } catch { return true; } };
  const write = value => { if (authFile) { fs.mkdirSync(path.dirname(authFile), { recursive: true }); fs.writeFileSync(authFile, value); } };
  const sub = argv[argv.indexOf('auth') + 1];
  if (sub === 'login') write('in');
  else if (sub === 'logout') write('out');
  console.log(JSON.stringify({ authenticated: read(), name: 'fixture-devin' }));
  process.exit(0);
}
if (command !== 'acp') process.exit(2);

const stateDir = process.env.FAKE_DEVIN_STATE_DIR || process.env.DEVIN_SESSIONS_DIR || '';
if (stateDir) fs.mkdirSync(stateDir, { recursive: true });
const sessions = new Map(), running = new Map(), pending = new Map();
let seq = 0;
const file = id => path.join(stateDir, `${id}.json`);
// 書きかけのファイルを読ませない。止められても、別のプロセスが読んでも、前か後の完全な版だけが見える
const persist = session => {
  sessions.set(session.sessionId, session);
  if (!stateDir) return;
  const target = file(session.sessionId), temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(session)); fs.renameSync(temp, target);
};
const load = id => {
  if (sessions.has(id)) return sessions.get(id);
  if (!/^devin-fixture-[\w-]+$/.test(id ?? '')) throw new Error('Unknown session');
  const session = stateDir ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : null;
  if (!session) throw new Error('Unknown session');
  sessions.set(id, session); return session;
};
const configs = session => {
  const axes = MODELS[session.model] ?? {};
  return [
    { id: 'mode', category: 'mode', type: 'select', currentValue: session.mode, options: ['ask', 'accept-edits', 'smart', 'plan', 'bypass'].map(value => ({ value, name: value })) },
    { id: 'model', category: 'model', type: 'select', currentValue: session.model, options: [{ group: 'Models', options: Object.keys(MODELS).map(value => ({ value, name: value })) }] },
    ...(axes.thought ? [{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: session.thought_level, options: axes.thought.map(value => ({ value, name: value })) }] : []),
    ...(axes.speed ? [{ id: 'speed', category: 'model_config', type: 'select', currentValue: session.speed, options: axes.speed.map(value => ({ value, name: value })) }] : []),
  ];
};
const write = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const update = (sessionId, value) => write({ method: 'session/update', params: { sessionId, update: value } });
function usageUpdate(session, usage = { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 800 }) {
  session.lastUsage = usage;
  const meta = Object.fromEntries(Object.entries(usage).map(([key, value]) => [`cognition.ai/${key}`, value]));
  update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used, size: session.window, _meta: meta });
  update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used, size: session.window,
    _meta: { ...meta, 'cognition.ai/subagent_context': {} } });
}
const compactionNotice = (session, params) => write({ method: '_cognition.ai/compaction', params: { sessionId: session.sessionId, ...params } });
// 圧縮が適用されると実機は message_nodes に継続用の system ノード（metadata.summarized_from 付き）を足す。
// 区切りの読み取り（core/backends/devin-compaction.mjs）の試験のため、同じ形で SQLite に書く
function writeBoundary(session, summary) {
  if (!stateDir) return;
  try {
    const dir = path.join(stateDir, 'cli');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'sessions.db'));
    db.exec(`create table if not exists sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT, model TEXT, agent_mode TEXT, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER);
             create table if not exists message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)`);
    const now = Math.floor(Date.now() / 1000);
    if (!db.prepare('select 1 from message_nodes where session_id = ? limit 1').get(session.sessionId)) {
      let pid = null;
      for (const [i, m] of session.messages.entries()) {
        db.prepare('insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) values (?,?,?,?,?)')
          .run(session.sessionId, i, pid, JSON.stringify({ role: m.role, content: m.text }), now);
        pid = i;
      }
    }
    const prev = db.prepare('select max(node_id) as n from message_nodes where session_id = ?').get(session.sessionId).n;
    const nid = (prev ?? -1) + 1;
    const content = `You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:\nFull conversation history saved at fixture-history.md.\nSummary:\n<summary>${summary}</summary>`;
    db.prepare('insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values (?,?,?,?,?,?)')
      .run(session.sessionId, nid, prev ?? null, JSON.stringify({ role: 'system', content }), now, JSON.stringify({ summarized_from: prev ?? 0 }));
    db.prepare('insert into sessions (id, working_directory, created_at, last_activity_at, main_chain_id) values (?,?,?,?,?) on conflict(id) do update set main_chain_id = excluded.main_chain_id, last_activity_at = excluded.last_activity_at')
      .run(session.sessionId, session.cwd ?? '', now, now, nid);
    db.close();
  } catch { /* fixture */ }
}
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
        // ターンごとに届く接続先（ply_context の口はターンごとのトークン）。再開でもその回の分を覚える
        session.mcpServers = p.mcpServers ?? []; persist(session);
        replay(session); update(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: configs(session) });
        if (session.lastUsage) usageUpdate(session, session.lastUsage);
        else update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used ?? 120000, size: session.window ?? 262000 });
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
        session[p.configId] = p.value;
        // 実機は model の切替で thought_level をその uid の接尾辞の段に戻し、軸の有無・選択肢も model に合わせる
        if (p.configId === 'model') { session.thought_level = MODELS[p.value]?.implicit ?? null; session.speed = 'standard'; }
        persist(session);
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
          // ACP のスラッシュコマンドは prompt の本文として届く。実機は応答のあとで圧縮を走らせ、
          // _cognition.ai/compaction 通知・使用量の減少・継続ノードの追加で効いたことが分かる。
          // [disable-compact] の会話は何も起きない（「圧縮するものが無い」側の台本）
          if (session.noCompact) {
            update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Nothing to compact.' }, _meta: { 'cognition.ai/displayMessage': true } });
            result = { stopReason: 'end_turn' }; break;
          }
          compactionNotice(session, { status: 'started' });
          session.used = Math.max(20000, Math.round((session.used ?? 120000) * 0.15));
          writeBoundary(session, 'fixture summary');
          compactionNotice(session, { status: 'completed', summary: 'Full conversation history saved at fixture-history.md.\nSummary:\n<summary>fixture summary</summary>' });
          persist(session);
          update(session.sessionId, { sessionUpdate: 'usage_update', used: session.used, size: session.window });
          result = { stopReason: 'end_turn' }; break;
        }
        const token = { cancelled: false, stubborn: text.includes('[stubborn]') }; running.set(session.sessionId, token);
        // [disable-compact]: この会話の /compact を「圧縮するものが無い」側にする。[auto-compact]: ターンの途中で内部の自動圧縮の合図を出す
        if (text.includes('[disable-compact]')) { session.noCompact = true; }
        session.messages.push({ role: 'user', text }); persist(session);
        update(session.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
        if (text.includes('[kill]')) process.exit(17);
        const gate = process.env.FAKE_DEVIN_GATE_DIR && /\[gate:([\w-]+)\]/.exec(text)?.[1];
        if (text.includes('[slow]') && gate && !token.stubborn) {
          // 試験が受理・決着を観測するまで保持する。負荷で固定秒数を越えても先に終わらない。
          const file = path.join(process.env.FAKE_DEVIN_GATE_DIR, gate);
          await new Promise(resolve => {
            const timer = setInterval(() => { if (fs.existsSync(file)) finish(); }, 20);
            const finish = () => { clearInterval(timer); resolve(); };
            token.wake = finish;
            fs.writeFileSync(`${file}.ready`, '');
          });
        } else if (text.includes('[slow]') || token.stubborn) await new Promise(resolve => { const timer = setTimeout(resolve, token.stubborn ? 60000 : Number(process.env.FAKE_DEVIN_SLOW_MS || 5000)); token.wake = () => { clearTimeout(timer); resolve(); }; });
        if (token.cancelled) { running.delete(session.sessionId); for (const steer of session.steerQueue ?? []) write({ id: steer.id, result: { stopReason: 'cancelled' } }); session.steerQueue = []; result = { stopReason: 'cancelled' }; break; }
        if (text.includes('[frame-malformed]')) { process.stdout.write('{not-json}\n'); break; }
        if (text.includes('[max-tokens]') || text.includes('[max-turn-requests]')) {
          running.delete(session.sessionId);
          result = { stopReason: text.includes('[max-tokens]') ? 'max_tokens' : 'max_turn_requests' };
          break;
        }
        // [rate-limit]: 実機（Cognition）の一時的な上限応答。走っている回に積まれた分も同じエラーで決着する。
        // [rate-limit-minutes]: 同じ応答の分の形（実機は「N seconds」「N minute(s)」「N hours N minutes」に時:分の時刻を併記する。ここでは切り捨てて、相対の見込みで待つ）
        if (text.includes('[rate-limit]') || text.includes('[rate-limit-minutes]')) {
          const span = text.includes('[rate-limit-minutes]') ? 3 * 60_000 : 5000;
          const at = new Date(Math.floor((Date.now() + span) / 60_000) * 60_000).toISOString().slice(11, 16);
          const error = { code: -32010, message: `Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in ${span >= 60_000 ? `${span / 60_000} minutes` : `${span / 1000} seconds`} (at ${at} UTC). (trace ID: fixture)`, data: { 'cognition.ai/errorKind': 'unavailable', 'cognition.ai/retryable': true } };
          running.delete(session.sessionId);
          for (const steer of session.steerQueue ?? []) write({ id: steer.id, error });
          session.steerQueue = [];
          result = undefined;
          write({ id: request.id, error });
          return;
        }
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
        // ply_context（Pleiad のコンテキストの口）を MCP 越しに実際に叩く。[context-tools] は一覧、末尾の行の context:{...} は tools/call
        const contextServer = (session.mcpServers ?? []).find(s => s?.name === 'ply_context' && s.url);
        const contextCall = async (method, params) => {
          const headers = { 'content-type': 'application/json' };
          for (const h of contextServer.headers ?? []) headers[h.name] = h.value;
          const response = await fetch(contextServer.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          return (await response.json()).result;
        };
        if (contextServer && text.includes('[context-tools]')) reply = JSON.stringify((await contextCall('tools/list'))?.tools ?? []);
        const contextMatch = /(?:^|\n)context:(\{[^\n]*\})\s*$/.exec(text);
        if (contextServer && contextMatch) reply = JSON.stringify((await contextCall('tools/call', JSON.parse(contextMatch[1])))?.content?.[0]?.text ?? null);
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
        // 圧縮で履歴を書き換える（最初の 1 往復を落とす）。次の session/load の再生は、位置がずれて返る
        if (text.includes('[compact-rewrite]')) session.messages.splice(0, 2);
        // Devin 内部の自動圧縮の合図（_cognition.ai/compaction 通知 + transcript の継続ノード）
        if (text.includes('[auto-compact]')) {
          compactionNotice(session, { status: 'started' });
          writeBoundary(session, 'fixture auto summary');
          compactionNotice(session, { status: 'completed', summary: 'Full conversation history saved at fixture-history.md.\nSummary:\n<summary>fixture auto summary</summary>' });
        }
        const steers = session.steerQueue ?? []; session.steerQueue = [];
        // 保存は応答を書く前に終える。親は応答を受けるとプロセスを止めるので、後に回すと書きかけで残る
        session.used = Math.min(session.window, (session.used ?? 120000) + 30000);
        if (text.includes('[usage-multi]')) {
          usageUpdate(session, { inputTokens: 400, outputTokens: 10, cachedReadTokens: 100 });
          update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'next model request' } });
        }
        usageUpdate(session); persist(session); running.delete(session.sessionId);
        result = { stopReason: token.cancelled ? 'cancelled' : 'end_turn', permissionResult, usage: session.lastUsage };
        write({ id: request.id, result });
        // 折り込まれた途中送信も、同じ回の続きとして返し、並んだ順に応答を書く
        for (const steer of steers) {
          // [drop-steer]: 受理したが読んだか分からないまま cancelled で決着する（既読不明の試験用）
          if (steer.text.includes('[drop-steer]')) { write({ id: steer.id, result: { stopReason: 'cancelled' } }); continue; }
          session.messages.push({ role: 'user', text: steer.text });
          update(session.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } });
          const steerReply = `fixture: ${steer.text}`, steerMiddle = Math.ceil(steerReply.length / 2);
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: steerReply.slice(0, steerMiddle) } });
          update(session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: steerReply.slice(steerMiddle) } });
          session.messages.push({ role: 'assistant', text: steerReply, thinking: 'fixture thought' });
          usageUpdate(session, { inputTokens: 2000, outputTokens: 200, cachedReadTokens: 1600 }); persist(session);
          write({ id: steer.id, result: { stopReason: 'end_turn', usage: session.lastUsage } });
        }
        return;
      }
      default: throw new Error(`Unsupported method: ${request.method}`);
    }
    write({ id: request.id, result });
  } catch (error) { write({ id: request.id, error: { code: -32000, message: error.message } }); }
});
