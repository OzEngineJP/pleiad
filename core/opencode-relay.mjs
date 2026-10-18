// OpenCode v2 の Pleiad MCP・Hooks・指示を、account と会話 ID で振り分ける。
// tools/call は OpenCode が付ける _meta["ai.opencode/sessionID"] を使う。
// 子の会話は native API で親を確かめ、環境を設定してから親の口へ通す。
// 更新時は同じ account token を保ち、ターンの結び直しまで呼び出しを待たせる。
import crypto from 'node:crypto';
import {t} from './i18n.mjs';

export const OPENCODE_RELAY_PATH = '/mcp/opencode';
/** OpenCode の MCP のサーバー名 -> runArgs の口の名前 */
// ply_context は Pleiad 担当のコンテキストのターン（専用のサーバー）だけ。口はターンごとのトークン
export const RELAY_SERVERS = Object.freeze({ ply_agents: 'agentRuntime', ply_control: 'controlRuntime', ply_computer: 'computerRuntime', ply_browser: 'browserRuntime', ply_context: 'contextRuntime', ply_shell: 'shellRuntime' });
/** 旧版の偽装用引数が残っていても、信頼せず転送前に捨てる。 */
export const SESSION_ARG = '_pleiadSession';
const BODY_MAX = 4 * 1024 * 1024;
/** 付け直すターンの会話の結び付けを待つ上限 */
const EXPECT_MS = 60_000;

export function createOpencodeRelay({ secret: initialSecret = crypto.randomBytes(24).toString('hex'), fetchImpl = (...a) => fetch(...a), expectMs = EXPECT_MS } = {}) {
  let secret = initialSecret;
  const expected = new Map();   // 付け直すターンの会話の id -> { promise, resolve, timer }
  const sessions = new Map();   // OpenCode の会話の id -> { runtimes: { server: { url, headers } }, env: {}, hooks: { beforeTool, afterTool } | null }
  const aliases = new Map();    // 子の会話（task のサブエージェント）の id -> 親の会話の id
  const latest = new Map();     // server -> { url, headers }（ツールの一覧を聞く先）
  let origin = null;
  let originWaiters = [];
  const scoped = (id, account = 'login') => `${account}:${id}`;
  const accountToken = (account = 'login') => crypto.createHmac('sha256',secret).update(account).digest('hex');

  const rootOf = (id) => {
    let key = id;
    for (let i = 0; i < 8 && !sessions.has(key) && aliases.has(key); i++) key = aliases.get(key);
    return key;
  };
  const lookup = (id, account = 'login') => sessions.get(rootOf(scoped(id, account))) ?? null;
  const prepare = async (entry,id,account) => {
    if(sessions.get(scoped(id,account))===entry || !entry.prepareChild)return entry;
    // 同じ子を並行して呼んでも、この bind の環境の設定は一度だけ行う。
    if(!entry.prepared.has(id)) {
      const pending=Promise.resolve().then(()=>entry.prepareChild(id));
      entry.prepared.set(id,pending);
      pending.catch(()=>entry.prepared.delete(id));
    }
    await entry.prepared.get(id);
    return entry;
  };
  /** 付け直す途中の会話なら、結び付け直すまで待ってから引く */
  const settled = async (id, account = 'login') => {
    if(!id)return null;
    const found = lookup(id, account);
    if (found) return prepare(found,id,account);
    // A child may execute before its tool result reaches the live UI. Verify the
    // server's parent relation and initialize its environment before forwarding.
    for (const entry of sessions.values()) if (entry.account === account && entry.resolveChild) {
      const parent = await entry.resolveChild(id).catch(() => null);
      if (parent && lookup(parent, account) === entry) {
        aliases.set(scoped(id, account), scoped(parent, account));
        return prepare(entry,id,account);
      }
    }
    const wait = expected.get(rootOf(scoped(id, account)));
    if (!wait) return null;
    await wait.promise;
    const ready=lookup(id, account);
    return ready ? prepare(ready,id,account) : null;
  };
  const release = (id) => {
    const wait = expected.get(id);
    if (!wait) return;
    expected.delete(id);
    clearTimeout(wait.timer);
    wait.resolve();
  };

  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  async function forward(target, message) {
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const text = await res.text();
    // 口は JSON で返す（streamable HTTP の SSE で返す口なら、最後の data 行を取る）
    if (/^\s*(event|data):/m.test(text) && !text.trim().startsWith('{')) {
      const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
      return data ? JSON.parse(data) : null;
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    get secret() { return secret; },
    token:accountToken,
    /** 前のサーバーの合言葉にする（引き継いだ OpenCode のサーバーは、その値で中継を呼ぶ） */
    adoptSecret(value) { if (typeof value === 'string' && value.length >= 32) secret = value; },
    /** 付け直すターンの会話（と子の会話）。結び付けるまで、その会話の呼び出しを待たせる。children は { 子の id: 親の id } */
    expect(sessionIds, children = {}, account = 'login') {
      for (const id of sessionIds ?? []) {
        const key=scoped(id,account);
        if (!id || expected.has(key) || sessions.has(key)) continue;
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const timer = setTimeout(() => release(key), expectMs);
        timer.unref?.();
        expected.set(key, { promise, resolve, timer });
      }
      for (const [child, parent] of Object.entries(children ?? {})) if (child && parent && child !== parent) aliases.set(scoped(child,account), scoped(parent,account));
    },
    /** 付け直さなかった会話の待ちを外す */
    unexpect: (sessionId, account = 'login') => release(scoped(sessionId,account)),
    /** Pleiad のサーバーの待ち受け（http://127.0.0.1:port）。server が listen の後に入れる */
    setOrigin(value) { origin = value; for (const fn of originWaiters) fn(value); originWaiters = []; },
    origin: () => origin,
    whenOrigin: () => (origin ? Promise.resolve(origin) : new Promise((resolve) => originWaiters.push(resolve))),
    /** OpenCode に渡すサーバーの url（origin が決まっていること） */
    serverUrl: (server, account = 'login') => `${origin}${OPENCODE_RELAY_PATH}/${server}?account=${encodeURIComponent(account)}`,
    envUrl: () => `${origin}${OPENCODE_RELAY_PATH}/env`,
    hookUrl: () => `${origin}${OPENCODE_RELAY_PATH}/hook`,
    /**
     * 会話にそのターンの口と環境変数を結び付ける（ターンの始めに）。runtimes は { agentRuntime, controlRuntime, ... }（url・headers を持つもの）
     * 返りは、口のあるサーバー名の一覧
     */
    bind(sessionId, { runtimes = {}, env = {}, hooks = null, account = 'login', system = '', resolveChild = null, prepareChild = null, context = null } = {}) {
      const bound = {};
      for (const [server, key] of Object.entries(RELAY_SERVERS)) {
        const r = runtimes[key];
        if (r?.url) { bound[server] = { url: r.url, headers: { ...(r.headers ?? {}) } }; latest.set(scoped(server,account), bound[server]); }
      }
      sessions.set(scoped(sessionId,account), { runtimes: bound, env: { ...env }, hooks, account, system, resolveChild, prepareChild, context, prepared:new Map() });
      release(scoped(sessionId,account));
      return Object.keys(bound);
    },
    /** 子の会話（サブエージェント）を親の会話に結び付ける。子のツールの呼び出しは親の口へ */
    alias(childId, parentId, account = 'login') { if (childId && parentId && childId !== parentId && lookup(parentId,account)) aliases.set(scoped(childId,account), scoped(parentId,account)); },
    setSystem(sessionId, text, account = 'login') { const entry=lookup(sessionId,account);if(entry)entry.system=String(text ?? ''); },
    /** 会話の結び付きを外す（会話を消したとき）。走っていない会話も、続きのターンまで残しておいてよい */
    unbind(sessionId, account = 'login') {const key=scoped(sessionId,account); sessions.delete(key); release(key); for (const [k, v] of aliases) if (k === key || v === key) aliases.delete(k); },
    has: (sessionId, account = 'login') => Boolean(lookup(sessionId,account)),

    async handle(req, res, url) {
      const account = url.searchParams.get('account') ?? 'login';
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const a = Buffer.from(token), b = Buffer.from(accountToken(account));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reply(res, 401, { error: 'Unauthorized' });
      const rest = url.pathname.slice(OPENCODE_RELAY_PATH.length + 1);
      if(rest==='blocked')return reply(res,400,{error:{message:t('opencode.errors.compactionOwner')}});
      if (rest === 'env') {
        if (req.method !== 'GET') return reply(res, 405);
        const entry=await settled(url.searchParams.get('session') ?? '',account);
        if(!entry)return reply(res,403,{error:'Unknown conversation'});
        return reply(res, 200, url.searchParams.get('kind')==='context' ? {system:entry.system,requiredServers:Object.keys(entry.runtimes),...(await entry.context?.(url.searchParams.get('session'),{fresh:url.searchParams.get('fresh')==='1'}) ?? {})} : entry.env);
      }
      if (rest === 'hook') {
        if (req.method !== 'POST') return reply(res, 405);
        let body;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > BODY_MAX) return reply(res, 413); chunks.push(chunk); }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { return reply(res, 400, {}); }
        // 会話に Hooks が結び付いていなければ何もしない（ほとんどのツールの呼び出しはここで返る）
        const entry=await settled(String(body?.session ?? ''),account);
        if(!entry)return reply(res,403,{error:'Unknown conversation'});
        const hooks = entry.hooks;
        if (!hooks) return reply(res, 200, {});
        try {
          const out = body.phase === 'after' ? await hooks.afterTool({sessionID:body.session,tool:body.tool,args:body.args,output:body.output}) : await hooks.beforeTool({sessionID:body.session,tool:body.tool,args:body.args});
          return reply(res, 200, out ?? {});
        } catch (err) {
          return reply(res, 200, { error: String(err?.message ?? err).slice(0, 300) });
        }
      }
      const server = rest;
      if (!Object.hasOwn(RELAY_SERVERS, server)) return reply(res, 404, { error: 'unknown server' });
      if (req.method === 'GET') return reply(res, 405);
      if (req.method === 'DELETE') return reply(res, 200, {});
      if (req.method !== 'POST') return reply(res, 405);
      let message;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > BODY_MAX) return reply(res, 413); chunks.push(chunk); }
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const id = message?.id;
      const ok = (result) => reply(res, 200, { jsonrpc: '2.0', id, result });
      if (id === undefined || id === null) { res.writeHead(202); return res.end(); }
      try {
        if (message.method === 'initialize') {
          return ok({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: server, version: '1' } });
        }
        if (message.method === 'ping') return ok({});
        if (message.method === 'tools/list') {
          const target = latest.get(scoped(server,account));
          if (!target) return ok({ tools: [] });
          const answer = await forward(target, { jsonrpc: '2.0', id, method: 'tools/list', params: message.params ?? {} });
          return reply(res, 200, { jsonrpc: '2.0', id, ...(answer?.error ? { error: answer.error } : { result: answer?.result ?? { tools: [] } }) });
        }
        if (message.method === 'tools/call') {
          const args = { ...(message.params?.arguments ?? {}) };
          const sessionId = String(message.params?._meta?.['ai.opencode/sessionID'] ?? '');
          delete args[SESSION_ARG];
          const target = sessionId ? (await settled(sessionId,account))?.runtimes?.[server] : null;
          if (!target) return ok({ isError: true, content: [{ type: 'text', text: `${server} is not available in this conversation` }] });
          const answer = await forward(target, { jsonrpc: '2.0', id, method: 'tools/call', params: { ...message.params, arguments: args } });
          return reply(res, 200, { jsonrpc: '2.0', id, ...(answer?.error ? { error: answer.error } : { result: answer?.result ?? {} }) });
        }
        return reply(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      } catch (err) {
        return reply(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err).slice(0, 300) } });
      }
    },
  };
}

/** Pleiad のサーバーに 1 つ（core/server.mjs が口を張り、core/backends/opencode.mjs が会話を結び付ける） */
export const opencodeRelay = createOpencodeRelay();
