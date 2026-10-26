import crypto from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { contextTools, mcpTransportConfig, hash } from './context-runtime.mjs';
import { t, agentT } from './i18n.mjs';
import { createContextConnections, WARM_IDLE_MS } from './context-connections.mjs';
import { insideDir } from './worktrees.mjs';
import { bootEnv } from './boot-env.mjs';
import { run } from './process.mjs';
import { holderSource } from './adopt.mjs';
import { startHeldMcp, readHeldMcpChildren, initOfLabel, heldMcpPlan, HeldMcpTransport } from './context-mcp-held.mjs';

export const CONTEXT_MCP_PATH = '/mcp/context';
const MAX_TOOLS = 500;
const CONNECT_CONCURRENCY = 8;
// 開き直しを待つ上限（外部の MCP を起こし直すのに手間取っても、呼び出しを止めっぱなしにしない）
const REOPEN_WAIT_MS = 120_000;
// MCP_CONFIG は mcpTransportConfig（core/context-runtime.mjs）の設定の誤り。文言は言語で変わるので code で見る
const configError = e => e?.code === 'INVALID' || e?.code === 'SECRET_LOCKED' || e?.code === 'MCP_CONFIG';

/**
 * 外部 MCP の実効設定・認証状態を解決する。失敗も状態として返す。
 * 失敗時の status は needs-auth（ログインが要る・トークンが拒まれた）/ failed。
 * item の出所が Pleiad の登録（source: 'ply'）なら、秘密と OAuth のトークンは plyMcp / oauth から取る。
 */
async function resolveServer(item, { cwd, plyMcp, oauth } = {}) {
  const ply = item.origins?.[0]?.source === 'ply';
  const tracker = {};
  let config;
  try {
    if (ply) {
      if (!plyMcp) throw Object.assign(new Error(t('context.bridge.plyUnavailable')), { code: 'INVALID' });
      config = await plyMcp.connection(item.name, cwd);
      if (config.definition.auth === 'oauth') {
        if (!oauth) throw Object.assign(new Error(t('context.bridge.oauthUnavailable')), { code: 'INVALID' });
        // トークンが無ければここで「要ログイン」。ターンの中ではブラウザを開かない
        await oauth.accessToken(item.name, config.definition, config);
        config.fetch = oauth.authFetch(item.name, config.definition, config, tracker);
      }
    } else config = mcpTransportConfig(item, cwd);
  } catch (e) {
    if (e?.code === 'MCP_AUTH_REQUIRED') return { status: 'needs-auth', reason: e.message, ...(e.message === t('mcp.oauth.loginRequired') ? { reasonCode: 'MCP_AUTH_REQUIRED' } : {}) };
    if (!configError(e)) return { status: 'failed', reason: t('context.bridge.configUnreadable') };
    return { status: 'failed', reason: e.unsupported ? t('context.bridge.unsupportedHint', { message: e.message }) : e.message };
  }
  return { config, tracker, ply };
}

async function listServerTools(client, item, config) {
  const caps = client.getServerCapabilities(), tools = [];
  let cursor;
  do {
    const list = caps?.tools ? await client.listTools(cursor ? { cursor } : {}, { timeout: config.timeout }) : { tools: [] };
    for (const tool of list.tools) {
      if (item.definition.enabled_tools && !item.definition.enabled_tools.includes(tool.name)) continue;
      if (item.definition.disabled_tools?.includes(tool.name)) continue;
      tools.push(tool);
      if (tools.length > MAX_TOOLS) throw new Error('tool limit');
    }
    cursor = list.nextCursor;
  } while (cursor);
  return { caps, tools };
}

/**
 * POSIX ではプロセスグループを分けて起こす StdioClientTransport（detached: true。Windows は SDK のまま）。
 * 取り残した MCP の掃除（core/mcp-ledger.mjs）と close の木ごとの停止が `kill(-pid)` で届くようにする。
 * SDK の start は detached を渡せないので、同じ処理を写して detached だけを足す（SDK の版を上げたときは見直す）
 */
class DetachedStdioTransport extends StdioClientTransport {
  async start() {
    if (process.platform === 'win32') return super.start();
    if (this._process) {
      throw new Error('StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.');
    }
    return new Promise((resolve, reject) => {
      this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
        env: { ...getDefaultEnvironment(), ...this._serverParams.env },
        stdio: ['pipe', 'pipe', this._serverParams.stderr ?? 'inherit'],
        shell: false,
        windowsHide: process.platform === 'win32',
        cwd: this._serverParams.cwd,
        detached: true,
      });
      this._process.on('error', error => { reject(error); this.onerror?.(error); });
      this._process.on('spawn', () => { resolve(); });
      this._process.on('close', _code => { this._process = undefined; this.onclose?.(); });
      this._process.stdin?.on('error', error => { this.onerror?.(error); });
      this._process.stdout?.on('data', chunk => {
        try { this._readBuffer.append(chunk); this.processReadBuffer(); }
        catch (error) { this.onerror?.(error); }
      });
      this._process.stdout?.on('error', error => { this.onerror?.(error); });
      if (this._stderrStream && this._process.stderr) this._process.stderr.pipe(this._stderrStream);
    });
  }
}

/**
 * 1 つの外部 MCP につなぐ。stdio は保持役の子として起こす（ADR 0270 段 2c。core/context-mcp-held.mjs）。
 * held は付け直す子（{ id, source, adopted, init, label }）。保持役を使えないときは今の流れ（サーバーの子）に落ちる
 */
export async function connectServer(item, { cwd, plyMcp, oauth, resolved, cached, onClient = () => {}, key = null, name = null, ledger = null,
  dataDir = null, appVersion = '', held = null, log = () => {} } = {}) {
  resolved ??= await resolveServer(item, { cwd, plyMcp, oauth });
  if (resolved.status) return resolved;
  const { config, tracker, ply } = resolved;
  const client = new Client({ name: 'ply-context', version: '1.0.0' }, { capabilities: {} });
  try {
    const fetchImpl = config.fetch ?? fetch;
    // 保持役に載せる子（新しく起こすか、付け直す）。載せられなければ null（サーバーの子）
    let heldChild = held;
    if (!heldChild && config.type === 'stdio') {
      const started = await startHeldMcp({ command: config.command, args: config.args, cwd: config.cwd, env: config.env,
        key: key ?? item.id, serverId: item.id, name: item.name, dataDir, root: bootEnv('AGENT_HOST_RUNTIME_ROOT'), appVersion, log });
      if (started) heldChild = { id: started.id, source: started.source, adopted: false, init: null, label: started.label };
    }
    const transport = config.type === 'stdio' ? (heldChild ? new HeldMcpTransport({ ...heldChild, log })
      : new DetachedStdioTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: 'pipe' }))
      : config.type === 'sse' ? new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' }, ...(config.fetch ? { fetch: config.fetch } : {}), eventSourceInit: { fetch: (url, options) => fetchImpl(url, { ...options, headers: { ...options?.headers, ...config.headers }, redirect: 'error' }) } })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' }, ...(config.fetch ? { fetch: config.fetch } : {}) });
    transport.stderr?.resume(); // Do not publish third-party stderr (may contain credentials).
    if (config.type === 'stdio' && !heldChild) {
      // 起きた根の PID を台帳に記録する（spawn の確定＝ start の解決。connect に失敗しても残す。core/mcp-ledger.mjs）。
      // 保持役の子は台帳に載せない（持ち主は保持役で、木ごとの停止も保持役がやる）
      const rawStart = transport.start.bind(transport);
      transport.start = async () => {
        const out = await rawStart();
        if (transport.pid != null) transport.__ledgerSeq = ledger?.processes.record({ pid: transport.pid, command: [config.command, ...(config.args ?? []).slice(0, 1)].join(' '), cwd: config.cwd, key: key ?? name });
        return out;
      };
      const close = transport.close.bind(transport);
      transport.close = async () => {
        // SDK は直下のプロセスだけを止める。npx/uvx の子も、exit の同期処理で回収する。
        // POSIX は detached で分けたプロセスグループごと止める（DetachedStdioTransport）
        if (transport.pid) {
          if (process.platform === 'win32') await run('taskkill', ['/PID', String(transport.pid), '/T', '/F'], { windowsHide: true, timeoutMs: 2000 }).catch(() => {});
          else { try { process.kill(-transport.pid, 'SIGKILL'); } catch { /* グループは DetachedStdioTransport だけが作る */ } }
          ledger?.processes.close(transport.__ledgerSeq);
          transport.__ledgerSeq = null;
        }
        await close();
      };
    }
    onClient(client, transport);
    await client.connect(transport, { timeout: config.timeout });
    transport.stderr?.resume();
    const list = () => listServerTools(client, item, config);
    return { status: 'connected', client, ...(cached ?? await list()), list, cached: !!cached };
  } catch (e) {
    await client.close().catch(() => {});
    if (tracker.authRequired || e?.code === 'MCP_AUTH_REQUIRED') {
      const reason = tracker.authRequired ?? e.message;
      // 「ログインが必要」の定型文なら画面は理由を重ねて出さない（文言ではなく reasonCode で見分ける）
      return { status: 'needs-auth', reason, ...(reason === t('mcp.oauth.loginRequired') ? { reasonCode: 'MCP_AUTH_REQUIRED' } : {}) };
    }
    if (e?.code === 401 || /\b401\b/.test(String(e?.message ?? ''))) {
      return { status: 'needs-auth', reason: ply ? t('context.bridge.authRequiredPly') : t('context.bridge.authRequiredNative') };
    }
    return { status: 'failed', reason: e?.message === 'tool limit' ? t('context.bridge.tooManyTools', { max: MAX_TOOLS }) : t('context.bridge.connectFailed') };
  }
}

/**
 * 外部 MCP の口。dataDir を渡すと、stdio の MCP を保持役の子として起こし、サーバーを起こし直しても付け直す
 * （ADR 0270 段 2c。AGENT_HOST_MCP_HOLDER=off・実行場所の置き場が無いときは今の流れ＝サーバーの子）
 */
export function createContextBridge({ plyMcp, oauth, warmIdleMs, ledger = null, dataDir = null, appVersion = '', log = () => {} } = {}) {
  const bindings = new Map();
  const opening = new Set();
  const held = new Map();          // 鍵 -> { id, client, child, init, label }（起動で拾った、まだ使っていない保持役の子）
  const heldTimers = new Map();
  const connections = createContextConnections({
    connect: (item, opts) => connectServer(item, { ...opts, plyMcp, oauth, ledger, dataDir, appVersion, log }),
    idleMs: warmIdleMs, snapshots: ledger?.snapshots ?? null,
  });
  let disposed = false;

  const samePath = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const left = path.resolve(a), right = path.resolve(b);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  };
  /** 保持役の子を木ごと止めて、記録を捨てる（止まったのを待ってから release する） */
  function stopHeldChild({ client, id }, { timeoutMs = 3000 } = {}) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.off('exit', onExit);
        try { client.release(id); } catch { /* 生きている・記録が無い */ }
        resolve();
      };
      const onExit = frame => { if (frame?.id === id) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      client.on('exit', onExit);
      try { client.kill(id, { tree: true }); } catch { finish(); }
    });
  }
  function forgetHeld(key) {
    clearTimeout(heldTimers.get(key));
    heldTimers.delete(key);
    return held.delete(key);
  }
  /** 付け直す保持役の子（この鍵の分）。使ったら地図から外す（子の持ち主は接続になる） */
  function heldFor(key) {
    const entry = held.get(key);
    if (!entry) return null;
    forgetHeld(key);
    const source = holderSource(entry.client, entry.child, { redelivered: true });
    return { id: entry.id, source, adopted: true, init: entry.init, label: entry.label };
  }
  /** この場所の設定から外れた保持役の子を止める（prune と同じ扱い。使われないまま残さない） */
  function closeStaleHeld(keys, cwd) {
    for (const [key, entry] of [...held]) {
      if (keys.has(key) || !samePath(entry.label?.cwd, cwd)) continue;
      forgetHeld(key);
      log(`  external MCP: ${entry.label?.name || key} is no longer in the settings of this place; stopping it`);
      void stopHeldChild(entry);
    }
  }
  /**
   * 起動で、前のサーバーが保持役に残した MCP の子（札の種類が mcp）を拾う（規則 ③: 起動の処理が復元の処理）。
   * 子はまだ使わない（次の利用で acquire が heldFor で取る）。WARM_IDLE_MS 使われなければ止める
   */
  async function adoptHeld() {
    if (disposed || !dataDir || !heldMcpPlan()) return 0;
    const { client, children } = await readHeldMcpChildren({ dataDir, root: bootEnv('AGENT_HOST_RUNTIME_ROOT'), appVersion, log });
    let count = 0;
    for (const child of children) {
      const key = child.label?.key;
      const init = initOfLabel(child.label);
      if (!key || !init || child.alive === false || held.has(key)) { void stopHeldChild({ client, id: child.id }); continue; }
      held.set(key, { id: child.id, client, child, init, label: child.label });
      const timer = setTimeout(() => {
        if (!forgetHeld(key)) return;
        log(`  external MCP: ${child.label?.name || key} was not used after the restart; stopping it`);
        void stopHeldChild({ client, id: child.id });
      }, WARM_IDLE_MS);
      timer.unref?.();
      heldTimers.set(key, timer);
      count++;
    }
    return count;
  }

  // 並列の接続や一覧の更新が先に終わっても、登録・500 件の会計は常に設定の順。
  function register(binding) {
    binding.dirty = false;
    binding.tools = [...binding.helpers.tools];
    binding.calls.clear(); binding.entries.clear();
    for (const item of binding.runtime.servers) {
      const lease = binding.leases.get(item.id);
      if (!lease) continue;
      const { result, entry } = lease;
      const row = binding.runtime.report.entries.find(e => e.id === item.id);
      const lazy = result.status === 'standby';
      const overflow = (result.status === 'connected' || lazy) && binding.tools.length + result.tools.length > MAX_TOOLS;
      if ((result.status !== 'connected' && !lazy) || overflow) {
        row.status = overflow ? 'failed' : result.status;
        row.reason = overflow ? t('context.bridge.toolTotalExceeded', { max: MAX_TOOLS }) : result.reason;
        if (result.reasonCode) row.reasonCode = result.reasonCode; else delete row.reasonCode;
        row.tools = 0; delete row.capabilities;
        if (overflow) {
          const stopped = Promise.resolve(lease.release(true));
          binding.pending.add(stopped);
          void stopped.finally(() => binding.pending.delete(stopped));
          binding.leases.delete(item.id);
        }
        continue;
      }
      const { caps } = result;
      for (const tool of result.tools) {
        const name = `m_${hash([item.id, tool.name]).slice(0,24)}`;
        binding.tools.push({ ...tool, name, description: `[${item.name} / ${tool.name}] ${tool.description ?? ''}` });
        binding.calls.set(name, lazy ? { lazy: true, entry, item, name: tool.name, tool, lease } : { client: result.client, name: tool.name, item, entry, tool });
      }
      row.status = lazy ? 'standby' : 'connected'; row.tools = result.tools.length; delete row.reason; delete row.reasonCode;
      row.capabilities = Object.keys(caps ?? {});
      binding.entries.set(item.id, { client: result.client, item, caps, lazy, entry });
    }
    if (binding.entries.size) {
      binding.tools.push({ name: 'mcp_resources', description: agentT(binding.runtime.locale, 'context.tools.mcp_resources'), inputSchema: { type:'object',properties:{uri:{type:'string'}},additionalProperties:false } });
      binding.tools.push({ name: 'mcp_prompts', description: agentT(binding.runtime.locale, 'context.tools.mcp_prompts'), inputSchema: { type:'object',properties:{name:{type:'string'},arguments:{type:'object',additionalProperties:{type:'string'}}},additionalProperties:false } });
    }
  }
  // 付け直したターンの口を開き直している間の token → 開き終わりの待ち。保持役の CLI は新しいサーバーが待ち受けた直後から ply_context を呼べるので、
  // 外部の MCP を起こし直している間に届いた呼び出しは断らずに待たせる
  const reopening = new Map();
  /** token の口をこれから開き直す（open より前、待ち受けた時点で呼ぶ）。返す関数で待ちを解く（開き終えた・開かないと決めた。何度呼んでもよい） */
  function reserve(token) {
    let release;
    const wait = new Promise(resolve => { release = () => { if (reopening.get(token) === wait) reopening.delete(token); resolve(); }; });
    reopening.set(token, wait);
    return release;
  }
  /**
   * token を渡すと、その値で束ねる（会話のあいだ同じ値を使うバックエンド向け。antigravity は agy を会話ごとに
   * 1 本生かし、起動時に受け取った値をターンをまたいで使い続ける）。受け付けるのはこの open が開いている間だけ。
   * 省略時はターンごとに新しい値を作る。
   * restarted: true は、無停止の更新で付け直したターンの開き直し（同じ token。外部の MCP は起こし直すので状態が消えている。R15）。
   * 外部の MCP ごとに、起こし直した後の最初の呼び出しの結果へその旨を添える
   */
  async function open({ runtime, prompt, origin, isActive, changed = async () => {}, progress = () => {}, authorize = async () => true, signal, token: fixed, restarted = false, activity = () => {} }) {
    if (disposed) throw new Error(t('context.bridge.aborted'));
    if (fixed !== undefined && !/^[a-f0-9]{64}$/.test(fixed)) throw new Error(t('context.bridge.invalidToken'));
    const token = fixed ?? crypto.randomBytes(32).toString('hex'), helpers = contextTools(runtime, prompt);
    const binding = { origin, isActive, runtime, helpers, controller: new AbortController(), tools: [...helpers.tools], leases: new Map(), entries: new Map(), calls: new Map(), pending: new Set(), changed, authorize, activity, closed: false,
      restarted: new Set(restarted ? runtime.servers.map(item => item.id) : []) };
    let closing;
    const close = () => {
      if (closing) return closing;
      binding.closed = true;
      binding.controller.abort();
      signal?.removeEventListener('abort', aborted);
      // 同じ token で次のターンが先に束ね直していれば、そちらは消さない
      if (bindings.get(token) === binding) bindings.delete(token);
      closing = (async () => {
        await Promise.allSettled([
          ...[...binding.leases.values()].map(lease => lease.release(binding.discard)),
          ...binding.pending,
        ]);
      })();
      return closing;
    };
    const aborted = () => { binding.discard = true; void close(); };
    binding.close = close;
    binding.refresh = async () => {
      binding.dirty = true;
      if (binding.ready && !binding.closed) { register(binding); await changed(); }
    };
    // 共有の接続が起きた・失敗したとき、standby（起動中）の行を確定の状態へ進める（core/context-connections.mjs が全利用者に知らせる）
    binding.mcpStarted = (entry, result) => {
      const row = binding.runtime.report.entries.find(e => e.id === entry.id);
      if (!row || !['standby', 'starting'].includes(row.status)) return;
      if (result.status === 'connected') { row.status = 'connected'; row.tools = result.tools.length; row.capabilities = Object.keys(result.caps ?? {}); delete row.reason; delete row.reasonCode; }
      else { row.status = result.status === 'needs-auth' ? 'needs-auth' : 'failed'; row.reason = result.reason; if (result.reasonCode) row.reasonCode = result.reasonCode; }
      void binding.changed();
    };
    signal?.addEventListener('abort', aborted, { once: true });
    opening.add(binding);
    try {
      if (runtime.servers.length > 32) throw new Error(t('context.bridge.tooManyServers'));
      const results = new Array(runtime.servers.length), keys = new Set();
      let next = 0;
      const worker = async () => {
        while (next < runtime.servers.length) {
          const index = next++, item = runtime.servers[index];
          if (signal?.aborted || binding.closed) return;
          const resolved = await resolveServer(item, { cwd: runtime.policy.cwd, plyMcp, oauth });
          if (signal?.aborted || binding.closed) return;
          if (resolved.status) results[index] = { result: resolved, release: () => {} };
          else {
            const key = connections.keyFor(item, resolved.config);
            keys.add(key);
            // 一覧の写しがあれば起こさず standby。無いものだけ、従来どおりこの場で 1 回つないで一覧を覚える（progress はつなぐものだけ）
            const snapshot = connections.snapshotFor(key);
            if (!snapshot) progress({ current: index + 1, total: runtime.servers.length, name: item.name });
            const lease = await connections.acquire(item, resolved, binding, restarted, { lazy: Boolean(snapshot), heldFor });
            if (signal?.aborted || binding.closed) { await lease.release(true); return; }
            results[index] = lease;
            binding.leases.set(item.id, lease);
          }
        }
      };
      // 全 worker の回収を待つ。1 本の例外で残りの接続を置き去りにしない。
      const workers = await Promise.allSettled(Array.from({ length: Math.min(CONNECT_CONCURRENCY, runtime.servers.length) }, worker));
      const failed = workers.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (signal?.aborted || binding.closed) throw new Error(t('context.bridge.aborted'));
      connections.prune(keys, runtime.policy.cwd);
      closeStaleHeld(keys, runtime.policy.cwd);
      for (const [index, item] of runtime.servers.entries()) binding.leases.set(item.id, results[index]);
      register(binding);
      // 保持役の子に付け直した分は、状態が消えていない（initialize も送り直していない）。「起こし直した」の断りを付けない
      for (const [id, lease] of binding.leases) if (lease?.held) binding.restarted.delete(id);
      for (const item of runtime.servers) {
        const row = runtime.report.entries.find(e => e.id === item.id);
        if (row.status !== 'connected' && row.status !== 'standby') {
          await binding.leases.get(item.id)?.release(true);
          binding.leases.delete(item.id);
          await changed();
        }
      }
      if (signal?.aborted || binding.closed || disposed) throw new Error(t('context.bridge.aborted'));
      // 失敗行の changed/close を待つ間に届いた一覧も、公開する前に取り込む。
      if (binding.dirty) register(binding);
      binding.ready = true;
      bindings.set(token, binding);
      runtime.report.status = 'ready'; await changed();
      if (signal?.aborted || binding.closed || disposed) throw new Error(t('context.bridge.aborted'));
      // locale は会話の言語。agy（antigravity）はエージェント定義の文と中継のエラーをこの言語で作る。
      // shape: 担当と渡すツールの名前。会話のあいだプロセスを生かすバックエンド（antigravity）は、これが変わったら起こし直す
      // （設定の変更で担当や外部 MCP が変わっても、起動時に受け取ったツール一覧のままになるため）
      const shape = hash([runtime.owners, binding.tools.map(tool => tool.name)]);
      // held: 保持役の子に付け直した外部 MCP の id（起こし直していない。状態が残っている）
      const heldIds = [...binding.leases].filter(([, lease]) => lease?.held).map(([id]) => id);
      // sections: prompt の内訳（Pleiad が足した文の量を数える。core/instruction-amount.mjs）
      return { owners: runtime.owners, prompt: helpers.prompt, sections: helpers.sections, locale: runtime.locale, url: `${origin}${CONTEXT_MCP_PATH}`, headers: { Authorization: `Bearer ${token}` }, shape, held: heldIds, close };
    } catch (e) { binding.discard = true; await close(); throw e; }
    finally { opening.delete(binding); }
  }
  async function metadata(b, kind, params = {}) {
    const resource = kind === 'resources';
    const selected = resource ? params.uri : params.name;
    // standby の MCP は、resources/prompts が求められたときに起きる（一覧の caps が resource/prompt を持つものだけここへ来る）
    const clientOf = async entry => entry.lazy && !entry.client ? (await connections.wake({ entry }, b)).result.client : entry.client;
    if (selected) {
      const match = /^ply-mcp:([a-f0-9]+):(.*)$/.exec(selected);
      const entry = match && b.entries.get(match[1]);
      if (!entry) throw new Error('Unknown MCP metadata');
      const client = await clientOf(entry);
      if (!client) throw new Error('MCP start failed');
      const key = decodeURIComponent(match[2]);
      return resource ? client.readResource({ uri:key }, { signal: b.controller.signal }) : client.getPrompt({name:key,arguments:params.arguments}, { signal: b.controller.signal });
    }
    const rows=[];
    for(const [id,entry] of b.entries) {
      if(!entry.caps?.[kind])continue;
      const client = await clientOf(entry);
      if (!client) continue;
      let cursor;
      do {
        const data=await (resource?client.listResources(cursor?{cursor}:{}, { signal: b.controller.signal }):client.listPrompts(cursor?{cursor}:{}, { signal: b.controller.signal }));
        for(const item of data[kind]??[]){const field=resource?'uri':'name';rows.push({...item,[field]:`ply-mcp:${id}:${encodeURIComponent(item[field])}`});if(rows.length>500)throw new Error('Metadata limit');}
        cursor=data.nextCursor;
      }while(cursor);
    }
    return {[kind]:rows};
  }
  async function callExternal(b, call, args) {
    // standby の MCP は最初の呼び出しで起きる。起きる間は行を「起動しています」にし、活動の帯にも出す（承認は呼び出し側が先に済ませる）
    if (call.lazy && !call.startFailed) {
      const row = b.runtime.report.entries.find(e => e.id === call.item.id);
      if (row && row.status === 'standby') { row.status = 'starting'; await b.changed(); }
      b.activity?.('mcpStart', call.item.name);
      let woken;
      try { woken = await connections.wake(call.lease, b); }
      catch (e) { woken = { result: { status: 'failed', reason: e?.message } }; }
      b.activity?.('thinking');
      call.entry = woken.entry;
      if (woken.result.status !== 'connected') {
        call.startFailed = true;
        if (row && row.status === 'starting') { row.status = woken.result.status === 'needs-auth' ? 'needs-auth' : 'failed'; row.reason = woken.result.reason ?? t('context.bridge.connectFailed'); if (woken.result.reasonCode) row.reasonCode = woken.result.reasonCode; }
        await b.changed();
        throw woken.result.reason ? Object.assign(new Error(woken.result.reason), { code: 'MCP_START' }) : new Error('MCP start failed');
      }
      call.lazy = false; call.client = woken.result.client;
    }
    if (call.startFailed) throw Object.assign(new Error('MCP start failed'), { code: 'MCP_START' });
    const invoke = () => call.client.callTool({ name: call.name, arguments: args }, undefined,
      { timeout: Math.min(300000, (call.item.definition.tool_timeout_sec ?? 60) * 1000), signal: b.controller.signal });
    let result, failure;
    try { result = await invoke(); } catch (e) { failure = e; }
    if (!failure && !result?.isError) return result;
    if (b.closed || !b.isActive()) throw new Error('Turn ended');
    // 接続を再利用している間の一覧変更も拾う。仕様が同じ業務エラーを二重実行しない。
    const snapshot = await call.entry.refresh();
    const current = snapshot.tools.find(tool => tool.name === call.name);
    // 実行前のツール/引数検証で拒まれ、入力仕様が変わった場合だけ再試行する。
    const rejectedBeforeCall = [-32601, -32602].includes(failure?.code);
    if (rejectedBeforeCall && current && hash(current.inputSchema) !== hash(call.tool.inputSchema) && !b.closed && b.isActive()) return invoke();
    if (!current) throw new Error('Unknown tool');
    if (failure) throw failure;
    return result;
  }
  async function handle(req, res) {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bindings.has(token) && reopening.has(token)) {
      let timer;
      await Promise.race([reopening.get(token), new Promise(resolve => { timer = setTimeout(resolve, REOPEN_WAIT_MS); })]);
      clearTimeout(timer);
    }
    const b = bindings.get(token);
    if (!b || b.closed || !b.isActive()) return json(401, { error: 'Active context required' });
    if (req.headers.origin && req.headers.origin !== b.origin) return json(403, { error: 'Origin not allowed' });
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    let m;
    try {
      const chunks = []; let bytes = 0;
      req.setTimeout(15000, () => req.destroy());
      for await (const c of req) { bytes += c.length; if (bytes > 1024*1024) return json(413, {}); chunks.push(c); }
      m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return json(400, { error: 'Invalid JSON' }); }
    if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return json(400, {});
    if (!Object.hasOwn(m,'id')) { res.writeHead(202); return res.end(); }
    const reply = result => json(200, { jsonrpc: '2.0', id: m.id, result });
    const error = message => json(200, { jsonrpc: '2.0', id: m.id, error: { code: -32602, message } });
    if (!b.isActive() || b.closed) return error('Turn ended');
    if (m.method === 'initialize') return reply({ protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'Pleiad Context', version: '1.0.0' } });
    if (m.method === 'ping') return reply({});
    if (m.method === 'ply/bootstrap') return reply({ prompt: b.helpers.prompt });
    if (m.method === 'tools/list') return reply({ tools: b.tools });
    if (['resources/list','resources/read','prompts/list','prompts/get'].includes(m.method)) {
      try { return reply(await metadata(b,m.method.startsWith('resources')?'resources':'prompts',m.params)); }
      catch { return error('MCP metadata request failed'); }
    }
    if (m.method !== 'tools/call') return error('Method not supported');
    const call = b.calls.get(m.params?.name);
    if (!b.tools.some(t => t.name === m.params?.name)) return error('Unknown tool');
    const work = (async () => {
      try {
        if (call && !await b.authorize(call.item.name, call.name, m.params.arguments ?? {})) return { isError: true, content: [{type:'text',text:agentT(b.runtime.locale, 'context.errors.mcpDeclined')}] };
        if (b.closed || !b.isActive()) throw new Error('Turn ended');
        const isMetadata=['mcp_resources','mcp_prompts'].includes(m.params.name);
        const result = call ? await callExternal(b, call, m.params.arguments ?? {}) : isMetadata ? {content:[{type:'text',text:JSON.stringify(await metadata(b,m.params.name==='mcp_resources'?'resources':'prompts',m.params.arguments))}]} : await b.helpers.call(m.params.name, m.params.arguments);
        if (call) { const row = b.runtime.report.entries.find(e => e.id === call.item.id); row.calls = (row.calls ?? 0) + 1; }
        await b.changed();
        if (call && b.restarted.delete(call.item.id)) return { ...result, content: [{ type: 'text', text: agentT(b.runtime.locale, 'context.errors.mcpRestarted') }, ...(result?.content ?? [])] };
        return result;
      } catch { return { isError: true, content: [{ type: 'text', text: agentT(b.runtime.locale, 'context.errors.callFailed') }] }; }
    })();
    b.pending.add(work);
    try { return reply(await work); } finally { b.pending.delete(work); }
  }
  /**
   * dir の中（同じ場所を含む）を cwd に起こした stdio の MCP を畳む（worktree を消す前）。
   * http/sse はプロセスを起こさないので対象外。畳まれた分は次の利用で起き直る（遅延起動と同じ形）。
   * 保持役に残っていてまだ使っていない子（起動で拾った分）も、同じ場所なら止める
   */
  const closeUnder = async dir => {
    const unused = [...held].filter(([, entry]) => insideDir(entry.label?.cwd, dir));
    for (const [key] of unused) forgetHeld(key);
    const [folded] = await Promise.all([
      connections.closeWhere(entry => entry.resolved?.config?.type === 'stdio' && insideDir(entry.resolved.config.cwd, dir)),
      ...unused.map(([, entry]) => stopHeldChild(entry)),
    ]);
    return folded + unused.length;
  };
  /**
   * 口を閉じる。keepHeld: true はサーバーの終わり（更新・落ちたとき）で、保持役の子を止めずに手を離す
   * （止めるのはアプリの終了と、会話の後片付け＝ warm の idle・worktree を消す前だけ。ADR 0270）
   */
  function dispose({ keepHeld = false } = {}) {
    disposed = true;
    for (const key of [...held.keys()]) forgetHeld(key);
    const closed = [...new Set([...bindings.values(), ...opening])].map(b => { b.discard = true; return b.close(); });
    return Promise.allSettled([connections.dispose({ keepHeld }), ...closed]);
  }
  return { open, handle, reserve, closeUnder, dispose, adoptHeld };
}
