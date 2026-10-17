// `opencode serve` の身代わり。HTTP の口と `/global/event`（SSE）を、実機（opencode 1.19.3 / windows-x64、2026-10-18）で確かめた形だけ真似る。
// LLM を呼ばない。core/backends/opencode.mjs の写し替え（出来事 -> 正規化イベント、承認・質問の受け渡し、中断、分岐、圧縮、
// サブエージェント、Pleiad の MCP の中継とシェルの環境変数）を試験で通すためのもの。推測で足した口は無い。
//
// 使い方: AGENT_HOST_OPENCODE_BIN="node tests/lib/fake-opencode.mjs" で opencode-server.mjs から `serve --port 0 --hostname 127.0.0.1` で起こされる。
// 台本は発言の先頭で選ぶ:
//   "tool"          bash のツールを 1 回動かしてから答える
//   "ask"           bash の承認（permission.asked）を待ち、許可なら動かす。拒否なら error のツール
//   "question"      質問（question.asked）を待ち、答えを本文にする
//   "mcp:<json>"    { server, tool, arguments } の Pleiad の MCP のツールを、POST /mcp で足された口へ呼ぶ（プラグインと同じく _pleiadSession を足す）
//   "env"           プラグインの shell.env と同じく、PLEIAD_OPENCODE_ENV_URL から会話の環境変数を取り、JSON を本文にする
//   "task"          子の会話（task のサブエージェント）を作って答えさせる
//   "slow"          中断（/abort）されるまで終わらない
//   "hold"          途中送信（走っている最中の prompt_async）が届くまで（最長 20 秒）待ってから答える
//   "fail"          失敗（session.error）で終わる
//   それ以外        "echo: <発言>" と答える（system を受けたら "[system]" を前に付ける）
// 走っている最中に届いた prompt_async は、同じ実行の中で次の区切りに読み（途中送信）、本文の最後に "受け取った: <本文>" を足す。
import http from 'node:http';
import crypto from 'node:crypto';

const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const CONFIG = (() => { try { return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'); } catch { return {}; } })();
const PROVIDERS = {
  providers: [{ id: 'fake', name: 'Fake', models: { echo: { name: 'Echo', limit: { context: 100_000, output: 8_000 }, variants: { low: {}, high: {} } }, tiny: { name: 'Tiny', limit: { context: 8_000, output: 1_000 }, variants: {} } } }],
  default: { fake: 'echo' },
};

let seq = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(16)}${(++seq).toString(36).padStart(4, '0')}${crypto.randomBytes(4).toString('hex')}`;
const sessions = new Map();       // id -> { id, directory, title, parentID, time, permission, messages: [{ info, parts }], run }
const mcp = new Map();            // directory -> { name: { status, config } }
const waits = new Map();          // permission / question の id -> resolve
const clients = new Set();

function broadcast(directory, type, properties) {
  const line = `data: ${JSON.stringify({ directory, payload: { id: id('evt'), type, properties } })}\n\n`;
  for (const res of clients) res.write(line);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const row = (s) => ({ id: s.id, slug: 'fake', projectID: 'fake-project', directory: s.directory, title: s.title, ...(s.parentID ? { parentID: s.parentID } : {}), version: 'fake', time: s.time, permission: s.permission });

function session(directory, { title = null, parentID = null, permission = [] } = {}) {
  const s = { id: id('ses'), directory, title: title ?? 'New session', parentID, time: { created: now(), updated: now() }, permission: [...permission], messages: [], run: null };
  sessions.set(s.id, s);
  broadcast(directory, 'session.created', { sessionID: s.id, info: row(s) });
  return s;
}

function addUser(s, text, { system = null } = {}) {
  const info = { id: id('msg'), sessionID: s.id, role: 'user', time: { created: now() }, ...(system ? { system } : {}) };
  const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'text', text };
  s.messages.push({ info, parts: [part] });
  broadcast(s.directory, 'message.updated', { sessionID: s.id, info });
  broadcast(s.directory, 'message.part.updated', { sessionID: s.id, part, time: now() });
  return info;
}

function assistant(s, parentID) {
  const info = { id: id('msg'), sessionID: s.id, role: 'assistant', parentID, time: { created: now() }, modelID: 'echo', providerID: 'fake', mode: 'build', agent: 'build', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  const m = { info, parts: [] };
  s.messages.push(m);
  broadcast(s.directory, 'message.updated', { sessionID: s.id, info });
  const put = (part) => { const at = m.parts.findIndex((p) => p.id === part.id); if (at >= 0) m.parts[at] = part; else m.parts.push(part); broadcast(s.directory, 'message.part.updated', { sessionID: s.id, part, time: now() }); };
  return {
    info,
    async text(body) {
      const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'text', text: '', time: { start: now() } };
      put(part);
      for (const chunk of String(body).match(/[\s\S]{1,6}/g) ?? []) {
        part.text += chunk;
        broadcast(s.directory, 'message.part.delta', { sessionID: s.id, messageID: info.id, partID: part.id, field: 'text', delta: chunk });
        await wait(1);
      }
      put({ ...part, time: { start: part.time.start, end: now() } });
    },
    reasoning(body) {
      const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'reasoning', text: '', time: { start: now() } };
      put(part);
      broadcast(s.directory, 'message.part.delta', { sessionID: s.id, messageID: info.id, partID: part.id, field: 'text', delta: body });
      put({ ...part, text: body, time: { start: part.time.start, end: now() } });
    },
    tool(tool, input) {
      const part = { id: id('prt'), messageID: info.id, sessionID: s.id, type: 'tool', tool, callID: id('call'), state: { status: 'pending', input: {}, raw: '' } };
      put(part);
      const start = now();
      put({ ...part, state: { status: 'running', input, time: { start } } });
      return {
        callID: part.callID,
        metadata: (metadata) => put({ ...part, state: { status: 'running', input, metadata, time: { start } } }),
        done: (output, metadata = {}) => put({ ...part, state: { status: 'completed', input, output, title: tool, metadata, time: { start, end: now() } } }),
        fail: (error) => put({ ...part, state: { status: 'error', input, error, time: { start, end: now() } } }),
      };
    },
    finish() {
      const tokens = { total: 1200, input: 1000, output: 150, reasoning: 50, cache: { read: 400, write: 0 } };
      put({ id: id('prt'), messageID: info.id, sessionID: s.id, type: 'step-finish', reason: 'stop', cost: 0.001, tokens });
      Object.assign(info, { tokens, cost: 0.001, time: { ...info.time, completed: now() } });
      broadcast(s.directory, 'message.updated', { sessionID: s.id, info });
    },
  };
}

function ask(s, type, properties) {
  const requestID = id(type === 'permission.asked' ? 'per' : 'que');
  return new Promise((resolve) => {
    waits.set(requestID, resolve);
    broadcast(s.directory, type, { id: requestID, sessionID: s.id, ...properties });
  });
}

async function mcpCall(s, server, tool, args) {
  const entry = mcp.get(s.directory)?.[server];
  if (!entry) return `no mcp server ${server}`;
  const res = await fetch(entry.config.url, { method: 'POST', headers: { ...entry.config.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { ...args, _pleiadSession: s.id } } }) });
  const body = await res.json();
  return (body.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || JSON.stringify(body.error ?? body.result ?? null);
}

// Pleiad のプラグインの tool.execute.before / after と同じく、Pleiad の口（PLEIAD_OPENCODE_HOOK_URL）にツールの前後を聞く
async function pluginHook(s, phase, tool, args, output = '') {
  if (!process.env.PLEIAD_OPENCODE_HOOK_URL) return {};
  const res = await fetch(process.env.PLEIAD_OPENCODE_HOOK_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.PLEIAD_OPENCODE_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: s.id, phase, tool, args, output }) }).catch(() => null);
  return res?.ok ? res.json() : {};
}

async function run(s, user, text, { system = null } = {}) {
  const ctl = { aborted: false, steers: [], abort: null };
  ctl.aborted$ = new Promise((resolve) => { ctl.abort = resolve; });
  s.run = ctl;
  broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'busy' } });
  const a = assistant(s, user.id);
  try {
    if (text.startsWith('slow')) {
      const t = a.tool('bash', { command: 'sleep 600' });
      await ctl.aborted$;
      t.fail('Tool execution aborted');
      broadcast(s.directory, 'session.error', { sessionID: s.id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
      return;
    }
    if (text.startsWith('fail')) {
      broadcast(s.directory, 'session.error', { sessionID: s.id, error: { name: 'UnknownError', data: { message: 'fake failure' } } });
      return;
    }
    let reply = `echo: ${text}`;
    a.reasoning('thinking about it');
    if (text.startsWith('tool')) {
      const args = { command: text.includes('forbidden') ? 'echo forbidden' : 'echo hello' };
      const verdict = await pluginHook(s, 'before', 'bash', args);
      if (verdict.args) Object.assign(args, verdict.args);
      const t = a.tool('bash', args);
      await wait(5);
      if (verdict.block) { t.fail(verdict.block); reply = `blocked: ${verdict.block}`; }
      else {
        let out = `${args.command === 'echo hello' ? 'hello' : args.command}\n`;
        const after = await pluginHook(s, 'after', 'bash', args, out);
        if (after.append) out += `\n${after.append}`;
        t.done(out, { exit: 0, truncated: false });
        reply = after.append ? `ran the tool (${after.append})` : 'ran the tool';
      }
    } else if (text.startsWith('ask')) {
      const t = a.tool('bash', { command: 'echo asked' });
      const answer = await Promise.race([ask(s, 'permission.asked', { permission: 'bash', patterns: ['echo asked'], metadata: { command: 'echo asked' }, always: ['echo *'], tool: { messageID: a.info.id, callID: t.callID } }), ctl.aborted$.then(() => ({ reply: 'reject' }))]);
      if (answer.reply === 'reject') { t.fail(`The user rejected permission to use this specific tool call${answer.message ? ` with the following feedback: ${answer.message}` : ''}`); reply = `rejected${answer.message ? `: ${answer.message}` : ''}`; }
      else { t.done('asked\n', { exit: 0 }); reply = `allowed (${answer.reply})`; }
    } else if (text.startsWith('question')) {
      const answer = await ask(s, 'question.asked', { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }] });
      reply = answer.rejected ? 'question rejected' : `answers: ${JSON.stringify(answer.answers)}`;
    } else if (text.startsWith('mcp:')) {
      const { server, tool, arguments: args = {} } = JSON.parse(text.slice(4));
      const t = a.tool(`${server}_${tool}`, args);
      const out = await mcpCall(s, server, tool, args);
      t.done(out);
      reply = out;
    } else if (text.startsWith('env')) {
      const t = a.tool('bash', { command: 'env' });
      const res = await fetch(`${process.env.PLEIAD_OPENCODE_ENV_URL}?session=${encodeURIComponent(s.id)}`, { headers: { authorization: `Bearer ${process.env.PLEIAD_OPENCODE_SECRET}` } });
      const env = res.ok ? await res.json() : { status: res.status };
      t.done(JSON.stringify(env));
      reply = `env: ${JSON.stringify(env)}`;
    } else if (text.startsWith('hold')) {
      for (let i = 0; i < 400 && !ctl.steers.length; i++) await wait(50);
    } else if (text.startsWith('task')) {
      const child = session(s.directory, { title: 'fake subagent (@general subagent)', parentID: s.id });
      const t = a.tool('task', { description: 'fake subagent', prompt: 'say hi', subagent_type: 'general' });
      t.metadata({ sessionId: child.id, parentSessionId: s.id });
      const cu = addUser(child, 'say hi');
      const ca = assistant(child, cu.id);
      await ca.text('hi from the child');
      ca.finish();
      broadcast(child.directory, 'session.idle', { sessionID: child.id });
      t.done('hi from the child', { sessionId: child.id, parentSessionId: s.id });
      reply = 'the child said hi';
    }
    // 途中送信: 走っている最中に届いた発言は、ここ（区切り）で読む
    await wait(30);
    for (const steer of ctl.steers.splice(0)) { addUser(s, steer); reply += `\n受け取った: ${steer}`; }
    await a.text(system ? `[system] ${reply}` : reply);
    a.finish();
  } finally {
    s.run = null;
    s.time.updated = now();
    broadcast(s.directory, 'session.status', { sessionID: s.id, status: { type: 'idle' } });
    broadcast(s.directory, 'session.idle', { sessionID: s.id });
  }
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
  if (req.headers.authorization !== AUTH) return send(401, { error: 'unauthorized' });
  const dir = url.searchParams.get('directory');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/global/health') return send(200, { healthy: true, version: 'fake' });
    if (url.pathname === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/config') return send(200, { ...(process.env.FAKE_OPENCODE_MODEL ? { model: process.env.FAKE_OPENCODE_MODEL } : {}), plugin: CONFIG.plugin ?? [] });
    if (url.pathname === '/config/providers') return send(200, PROVIDERS);
    if (url.pathname === '/provider') return send(200, { all: [{ id: 'fake', name: 'Fake' }], connected: ['fake'], default: { fake: 'echo' } });
    if (url.pathname === '/mcp' && req.method === 'GET') return send(200, Object.fromEntries(Object.entries(mcp.get(dir) ?? {}).map(([k, v]) => [k, { status: v.status }])));
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const b = await body(req);
      const entry = { status: 'connected', config: b.config };
      // 実機と同じく、足した時点で tools/list を聞く
      await fetch(b.config.url, { method: 'POST', headers: { ...b.config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }) }).then((r) => r.json()).then((r) => { entry.tools = r.result?.tools?.map((x) => x.name) ?? []; }).catch(() => { entry.status = 'failed'; });
      mcp.set(dir, { ...(mcp.get(dir) ?? {}), [b.name]: entry });
      return send(200, Object.fromEntries(Object.entries(mcp.get(dir)).map(([k, v]) => [k, { status: v.status }])));
    }
    if (url.pathname === '/experimental/session') return send(200, [...sessions.values()].filter((s) => !s.parentID).reverse().map(row));
    if (url.pathname === '/session' && req.method === 'POST') {
      const b = await body(req);
      return send(200, row(session(dir, { title: b.title ?? null, permission: b.permission ?? [] })));
    }
    if (parts[0] === 'permission' && parts[2] === 'reply') { const b = await body(req); waits.get(parts[1])?.(b); waits.delete(parts[1]); return send(200, true); }
    if (parts[0] === 'question' && parts[2] === 'reply') { const b = await body(req); waits.get(parts[1])?.({ answers: b.answers }); waits.delete(parts[1]); return send(200, true); }
    if (parts[0] === 'question' && parts[2] === 'reject') { waits.get(parts[1])?.({ rejected: true }); waits.delete(parts[1]); return send(200, true); }
    if (parts[0] === 'session' && parts[1]) {
      const s = sessions.get(parts[1]);
      if (!s) return send(404, { error: 'not found' });
      const action = parts[2];
      if (!action && req.method === 'GET') return send(200, row(s));
      if (!action && req.method === 'PATCH') {
        const b = await body(req);
        if (typeof b.title === 'string') s.title = b.title;
        if (Array.isArray(b.permission)) s.permission.push(...b.permission);
        broadcast(s.directory, 'session.updated', { sessionID: s.id, info: row(s) });
        return send(200, row(s));
      }
      if (action === 'message' && req.method === 'GET') return send(200, s.messages);
      if (action === 'message' && req.method === 'POST') {
        const b = await body(req);
        const info = addUser(s, (b.parts ?? []).map((p) => p.text ?? '').join(''));
        return send(200, { info, parts: s.messages.at(-1).parts });
      }
      if (action === 'prompt_async') {
        const b = await body(req);
        const text = (b.parts ?? []).map((p) => p.text ?? '').join('');
        send(204);
        if (s.run) { s.run.steers.push(text); return; }
        const user = addUser(s, text, { system: b.system ?? null });
        void run(s, user, text, { system: b.system ?? null });
        return;
      }
      if (action === 'abort') { s.run?.abort(); return send(200, true); }
      if (action === 'children') return send(200, [...sessions.values()].filter((x) => x.parentID === s.id).map(row));
      if (action === 'fork') {
        const b = await body(req);
        const at = b.messageID ? s.messages.findIndex((m) => m.info.id === b.messageID) : s.messages.length;
        const f = session(s.directory, { title: `${s.title} (fork)`, permission: s.permission });
        const remap = new Map();
        for (const m of s.messages.slice(0, at < 0 ? s.messages.length : at)) {
          const nid = id('msg'); remap.set(m.info.id, nid);
          f.messages.push({ info: { ...m.info, id: nid, sessionID: f.id, ...(m.info.parentID ? { parentID: remap.get(m.info.parentID) ?? m.info.parentID } : {}) }, parts: m.parts.map((p) => ({ ...p, id: id('prt'), messageID: nid, sessionID: f.id })) });
        }
        return send(200, row(f));
      }
      if (action === 'summarize') {
        await body(req);
        send(200, true);
        const user = { id: id('msg'), sessionID: s.id, role: 'user', time: { created: now() } };
        s.messages.push({ info: user, parts: [{ id: id('prt'), messageID: user.id, sessionID: s.id, type: 'compaction', auto: false }] });
        broadcast(s.directory, 'message.updated', { sessionID: s.id, info: user });
        const a = assistant(s, user.id);
        a.info.summary = true;
        await a.text('## Summary\n- the fake conversation so far');
        a.finish();
        broadcast(s.directory, 'session.compacted', { sessionID: s.id });
        broadcast(s.directory, 'session.idle', { sessionID: s.id });
        return;
      }
    }
    return send(404, { error: `fake opencode: no route ${req.method} ${url.pathname}` });
  } catch (err) {
    return send(500, { error: String(err?.message ?? err) });
  }
});

const port = Number(process.argv[process.argv.indexOf('--port') + 1] ?? 0) || 0;
// 起こされた印（試験が「一覧を作るだけでは起こさない」を確かめる）
if (process.env.FAKE_OPENCODE_STARTED_FILE) { try { (await import('node:fs')).appendFileSync(process.env.FAKE_OPENCODE_STARTED_FILE, `${process.pid}
`); } catch {} }
server.listen(port, '127.0.0.1', () => {
  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`);
});
