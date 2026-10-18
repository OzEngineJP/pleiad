// OpenCode の共有のサーバーから来る Pleiad のツールの呼び出しを、会話ごとの口へ振り分ける中継（docs/multi-backend.md §2.10）。
//
// OpenCode の MCP の設定は作業場所（instance）全体のもので、呼び出しに会話の id は載らない（実機で確認）。そこで:
//   1. Pleiad のプラグイン（core/backends/opencode-plugin.mjs）が、`ply_*` のツールの引数に `_pleiadSession`（OpenCode の会話の id）を足す
//   2. OpenCode は `/mcp/opencode/<サーバー>` へ MCP の JSON-RPC を送る（合言葉は Pleiad の起動ごと）
//   3. ここで会話の id から、そのターンの口（runArgs の agentRuntime など。url と headers）を引き、tools/call をそのまま転送する
// ツールの一覧（tools/list）は、最後に結び付けた会話の口に聞く（ツールの定義は会話に依らない。説明の言語だけが違う）。
// 会話のシェルの環境変数（ブラウザー・操作の一覧・秘密情報）は、プラグインの shell.env が `/mcp/opencode/env?session=` で取る。
// Pleiad がそろえる Hooks のツールの前後は、プラグインの tool.execute.before / after が `/mcp/opencode/hook` を呼ぶ（core/backends/opencode-hooks.mjs）
// 無停止の更新で OpenCode のサーバーを引き継いだときは、合言葉を前のサーバーの値にし（OpenCode に渡したまま変えられない）、
// 付け直すターンの会話は結び付け直すまで呼び出しを待たせる（expect。待ち受けた直後から呼ばれうる）
import crypto from 'node:crypto';

export const OPENCODE_RELAY_PATH = '/mcp/opencode';
/** OpenCode の MCP のサーバー名 -> runArgs の口の名前 */
// ply_context は Pleiad 担当のコンテキストのターン（専用のサーバー）だけ。口はターンごとのトークン
export const RELAY_SERVERS = Object.freeze({ ply_agents: 'agentRuntime', ply_control: 'controlRuntime', ply_computer: 'computerRuntime', ply_browser: 'browserRuntime', ply_context: 'contextRuntime', ply_shell: 'shellRuntime' });
/** 会話の id を運ぶ引数の名前（プラグインが足し、ここで外す） */
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

  const rootOf = (id) => {
    let key = id;
    for (let i = 0; i < 8 && !sessions.has(key) && aliases.has(key); i++) key = aliases.get(key);
    return key;
  };
  const lookup = (id) => sessions.get(rootOf(id)) ?? null;
  /** 付け直す途中の会話なら、結び付け直すまで待ってから引く */
  const settled = async (id) => {
    const found = lookup(id);
    if (found) return found;
    const wait = expected.get(rootOf(id));
    if (!wait) return null;
    await wait.promise;
    return lookup(id);
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
    /** 前のサーバーの合言葉にする（引き継いだ OpenCode のサーバーは、その値で中継を呼ぶ） */
    adoptSecret(value) { if (typeof value === 'string' && value.length >= 32) secret = value; },
    /** 付け直すターンの会話（と子の会話）。結び付けるまで、その会話の呼び出しを待たせる。children は { 子の id: 親の id } */
    expect(sessionIds, children = {}) {
      for (const id of sessionIds ?? []) {
        if (!id || expected.has(id) || sessions.has(id)) continue;
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const timer = setTimeout(() => release(id), expectMs);
        timer.unref?.();
        expected.set(id, { promise, resolve, timer });
      }
      for (const [child, parent] of Object.entries(children ?? {})) if (child && parent && child !== parent) aliases.set(child, parent);
    },
    /** 付け直さなかった会話の待ちを外す */
    unexpect: (sessionId) => release(sessionId),
    /** Pleiad のサーバーの待ち受け（http://127.0.0.1:port）。server が listen の後に入れる */
    setOrigin(value) { origin = value; for (const fn of originWaiters) fn(value); originWaiters = []; },
    origin: () => origin,
    whenOrigin: () => (origin ? Promise.resolve(origin) : new Promise((resolve) => originWaiters.push(resolve))),
    /** OpenCode に渡すサーバーの url（origin が決まっていること） */
    serverUrl: (server) => `${origin}${OPENCODE_RELAY_PATH}/${server}`,
    envUrl: () => `${origin}${OPENCODE_RELAY_PATH}/env`,
    hookUrl: () => `${origin}${OPENCODE_RELAY_PATH}/hook`,
    /**
     * 会話にそのターンの口と環境変数を結び付ける（ターンの始めに）。runtimes は { agentRuntime, controlRuntime, ... }（url・headers を持つもの）
     * 返りは、口のあるサーバー名の一覧
     */
    bind(sessionId, { runtimes = {}, env = {}, hooks = null } = {}) {
      const bound = {};
      for (const [server, key] of Object.entries(RELAY_SERVERS)) {
        const r = runtimes[key];
        if (r?.url) { bound[server] = { url: r.url, headers: { ...(r.headers ?? {}) } }; latest.set(server, bound[server]); }
      }
      sessions.set(sessionId, { runtimes: bound, env: { ...env }, hooks });
      release(sessionId);
      return Object.keys(bound);
    },
    /** 子の会話（サブエージェント）を親の会話に結び付ける。子のツールの呼び出しは親の口へ */
    alias(childId, parentId) { if (childId && parentId && childId !== parentId) aliases.set(childId, parentId); },
    /** 会話の結び付きを外す（会話を消したとき）。走っていない会話も、続きのターンまで残しておいてよい */
    unbind(sessionId) { sessions.delete(sessionId); release(sessionId); for (const [k, v] of aliases) if (k === sessionId || v === sessionId) aliases.delete(k); },
    has: (sessionId) => Boolean(lookup(sessionId)),

    async handle(req, res, url) {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const a = Buffer.from(token), b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reply(res, 401, { error: 'Unauthorized' });
      const rest = url.pathname.slice(OPENCODE_RELAY_PATH.length + 1);
      if (rest === 'env') {
        if (req.method !== 'GET') return reply(res, 405);
        return reply(res, 200, (await settled(url.searchParams.get('session') ?? ''))?.env ?? {});
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
        const hooks = (await settled(String(body?.session ?? '')))?.hooks;
        if (!hooks) return reply(res, 200, {});
        try {
          const out = body.phase === 'after' ? await hooks.afterTool({ tool: body.tool, args: body.args, output: body.output }) : await hooks.beforeTool({ tool: body.tool, args: body.args });
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
          const target = latest.get(server);
          if (!target) return ok({ tools: [] });
          const answer = await forward(target, { jsonrpc: '2.0', id, method: 'tools/list', params: message.params ?? {} });
          return reply(res, 200, { jsonrpc: '2.0', id, ...(answer?.error ? { error: answer.error } : { result: answer?.result ?? { tools: [] } }) });
        }
        if (message.method === 'tools/call') {
          const args = { ...(message.params?.arguments ?? {}) };
          const sessionId = String(args[SESSION_ARG] ?? '');
          delete args[SESSION_ARG];
          const target = (await settled(sessionId))?.runtimes?.[server];
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
