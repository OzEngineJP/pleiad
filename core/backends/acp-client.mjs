// ACP（Agent Client Protocol。stdio の 1 行 1 JSON の JSON-RPC 2.0）の CLI と話す共通の口。
// Devin（core/backends/devin-acp.mjs）・Grok（core/backends/grok-acp.mjs）はこの薄いサブクラスで、違うのは
//   起動の引数（args）・session/update 以外の通知の振り分け（routeNotification）・エラーに載せる印（decorateError）・
//   プロバイダ固有のエラー種別（vendorKinds。core/backends/acp-error.mjs）・超過した行の知らせ方（onDrop / onOverflow）だけ。
// 保持役（core/holder/）に載せるときは held（core/backends/acp-held.mjs の createHeldAcp）を渡す。付け直しは adopt（{ promptId }）。
import { acpRequestFailure } from './acp-error.mjs';
import { createLineReader } from '../link-codec.mjs';
import { spawnCli } from '../cli-installation.mjs';
import { killTree } from '../process-tree.mjs';

const MAX_STDERR_BYTES = 16 * 1024;
const CLIENT_INFO = { name: 'pleiad', version: '0.0.0' };
const SAFE_ERROR = Symbol('safe ACP error');
const CALLBACK_CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32800]);
const PROCESS_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'E2BIG', 'ENOMEM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOTDIR', 'EINVAL']);

/** 外へ出してよいエラー（文面は固定・code は JSON-RPC の番号か spawn の種別）。wire の message・data は載せない */
function rpcError(message, code = -32000) {
  const error = new Error(message);
  error.code = code;
  error[SAFE_ERROR] = true;
  return error;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

const isRpcId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

export class AcpClient {
  #init = null;

  /**
   * label: エラーの文面の頭（`${label} ACP …`）。args: command の後ろに付ける引数（Devin は ['acp']、Grok は ['agent', …, 'stdio']）
   * held: 保持役の子に載せた CLI の口（無ければ spawnCli で直に起こす）。adopt: 付け直し（{ promptId }。initialize も session の作成も送らない）
   * onDrop: 上限を超えた行を捨てたとき（改行が届いた時点）。onOverflow: 上限を超えたと分かった時点（改行を待たない）。
   *   どちらも、id の分からない応答を待ち続けないよう、期限の無い依頼に期限を付けてから呼ぶ。両方とも省くと onDrop で期限だけ付ける
   * routeNotification(method, params, opts, run): session/update 以外の通知。run(fn, what = 'notification') で呼ぶと、
   *   投げた・断った約束を `${label} ACP ${what} handler failed` の失敗にする
   * decorateError(reject, { error, method, params }): 断られた依頼のエラー（reject）に、構造化した安全な印だけを載せる（error は wire の error）
   */
  constructor({ label = 'ACP', args = [], command, cwd, env, timeoutMs = 30_000, held = null, adopt = null,
    onUpdate = () => {}, onResponse = () => {}, onRequest = async () => { throw rpcError('Unsupported client request', -32601); },
    onGone = () => {}, onDrop = null, onOverflow = null, routeNotification = null, decorateError = null, vendorKinds = null,
    maxFrameBytes = 64 * 2 ** 20 } = {}) {
    this.label = label;
    this.cliArgs = args;
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.onUpdate = onUpdate;
    this.onResponse = onResponse;
    this.onRequest = onRequest;
    this.onGone = onGone;
    this.routeNotification = routeNotification;
    this.decorateError = decorateError;
    this.vendorKinds = vendorKinds;
    this.timeoutMs = timeoutMs;
    this.held = held;
    this.adopt = adopt;
    this.adopted = Boolean(adopt);
    // 付け直し: 記録の再生で出てくる依頼のうち、まだ答えていないもの（保持役の控え）だけを聞き直す。聞いた依頼の id
    this.pendingRequests = new Set();
    this.asked = new Set();
    this.trailing = [];   // 付け直したターンで、走っている途中送信の応答を待つ約束
    this.proc = null;
    this.starting = null;
    this.closing = false;
    this.gone = false;
    this.closed = null;
    this.reaping = null;
    this.connectionAbort = new AbortController();
    this.nextId = 0;
    this.pending = new Map();
    this.incoming = new Set();
    this.seenIncoming = new Set();
    // The id is unavailable. Keep reading ACKs, but bound even prompt calls
    // that normally have no deadline if the discarded line was their reply.
    const bounded = callback => info => {
      for (const [id, pending] of this.pending) if (!pending.timer) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          pending.reject(rpcError(`${this.label} ACP request timed out after a dropped frame`, -32001));
        }, this.timeoutMs > 0 ? this.timeoutMs : 30_000);
      }
      try { callback(info); } catch {}
    };
    if (!onDrop && !onOverflow) onDrop = () => {};
    this.reader = createLineReader({
      maxBytes: maxFrameBytes,
      onLine: line => this.#line(line),
      ...(onDrop ? { onDrop: bounded(onDrop) } : {}),
      ...(onOverflow ? { onOverflow: bounded(onOverflow) } : {}),
    });
    this.stderrBytes = 0;
    this.stderrTail = '';
  }

  /** initialize の答え（付け直した子は null。initialize を送らない） */
  get init() { return this.#init; }
  get pid() { return this.proc?.pid ?? null; }
  get alive() { return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null && !this.gone); }

  #processError(error) { return rpcError(`${this.label} ACP process failed`, PROCESS_CODES.has(error?.code) ? error.code : -32000); }

  start() {
    if (this.closing || this.gone) return Promise.reject(rpcError(`${this.label} ACP is closed`));
    if (this.starting) return this.starting;
    this.starting = this.held ? this.#startHeld() : this.#start();
    return this.starting;
  }

  #wire(child) {
    this.proc = child;
    child.stdin.on('error', () => this.#fail(rpcError(`${this.label} ACP input pipe failed`)));
    child.stdout.on('error', () => this.#fail(rpcError(`${this.label} ACP output pipe failed`)));
    child.stderr.on('error', () => this.#fail(rpcError(`${this.label} ACP error pipe failed`)));
    child.stdout.on('data', (chunk) => this.#stdout(chunk));
    child.stderr.on('data', (chunk) => this.#stderr(chunk));
    child.on('error', error => this.#fail(this.#processError(error)));
  }

  #initialize() {
    if (this.closing) throw rpcError(`${this.label} ACP closed during startup`, -32800);
    return this.call('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT_INFO,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, { timeoutMs: this.timeoutMs });
  }

  /**
   * 保持役の子として起動する。付け直し（adopt）は子が走っているので initialize を送らず、走っている session/prompt の応答だけを待つ。
   * 読み（記録の再生と続き）は、付け直しでは写しを組み立てた後に begin() で始める（core/backends/acp-held.mjs）
   */
  async #startHeld() {
    try {
      const child = this.held.start({ argv: [...this.command, ...this.cliArgs], cwd: this.cwd, env: this.env ?? process.env });
      this.#wire(child);
      child.on('exit', (_code, _signal, status) => this.#fail(rpcError(`${this.label} ACP exited`), { terminateTree: status?.lost !== true }));
      if (this.adopted) {
        // 2 回目の initialize は送らない（子は initialize 済み）。走っている prompt の応答の枠だけを開ける
        this.#awaitResponse(this.adopt?.promptId, 'session/prompt');
        return null;
      }
      this.held.begin({ onLine: (line, opts) => this.#line(line, opts) });
      this.#init = await this.#initialize();
      return this.#init;
    } catch (error) {
      const safe = error?.[SAFE_ERROR] ? error : this.#processError(error);
      this.#fail(safe);
      throw safe;
    }
  }

  /** 付け直し: 読みを始める（写しを組み立てた後に呼ぶ） */
  begin() {
    if (!this.held) return;
    this.held.begin({ onLine: (line, opts) => this.#line(line, opts) });
  }

  /** 付け直した子の attach の答え（pendingRequests。答えていない依頼）。起こした子は null */
  async open(from = 1) {
    const state = this.held ? await this.held.open(from) : null;
    if (Array.isArray(state?.pendingRequests)) this.pendingRequests = new Set(state.pendingRequests.map(p => p.requestId));
    return state;
  }

  /** 走っている session/prompt の id（走っているターンと途中送信）。札に置き、付け直した側が応答を拾い直す */
  pendingPromptIds() {
    return [...this.pending].filter(([, p]) => p.method === 'session/prompt').map(([id]) => id);
  }

  /**
   * 付け直し: 走っている途中送信の応答の枠を開ける（本文は要らない。決着を待つためだけ）。
   * 途中送信は回の終わりの後に答えるので、本文の応答だけを待って閉じると、続けて届く途中送信の返答を読めない
   */
  adoptTrailing(ids = []) {
    for (const id of ids) {
      if (this.pending.has(id)) continue;
      const promise = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, timer: null, method: 'session/prompt', params: null }); });
      promise.catch(() => {});
      this.trailing.push(promise);
    }
  }

  /** 付け直したターン: 途中送信の決着を待つ（上限つき）。閉じる前に呼ぶ */
  async settleTrailing(ms = 2000) {
    if (!this.trailing.length) return;
    let timer;
    try { await Promise.race([Promise.allSettled(this.trailing), new Promise(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); })]); }
    finally { clearTimeout(timer); this.trailing = []; }
  }

  /** 走っている依頼の応答の枠を開ける（付け直し）。id は前のサーバーが付けたもの（pleiad-<n>）。応答は this.running で待つ */
  #awaitResponse(id, method) {
    if (typeof id !== 'string' && typeof id !== 'number') throw rpcError(`${this.label} ACP adoption has no running request`);
    if (this.pending.has(id)) throw rpcError('Duplicate JSON-RPC id');
    this.running = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer: null, method, params: null });
    });
    this.running.catch(() => {});
    const n = /^pleiad-(\d+)$/.exec(String(id))?.[1];
    if (n) this.nextId = Math.max(this.nextId, Number(n));
  }

  async #start() {
    let child;
    try {
      child = spawnCli(this.command, this.cliArgs, {
        cwd: this.cwd,
        env: this.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.#wire(child);
      child.on('exit', () => this.#fail(rpcError(`${this.label} ACP exited`)));
      await new Promise((resolve, reject) => {
        if (child.pid) return resolve();
        const timer = setTimeout(() => reject(rpcError(`${this.label} ACP spawn timed out`)), this.timeoutMs);
        child.once('spawn', () => { clearTimeout(timer); resolve(); });
        child.once('error', error => { clearTimeout(timer); reject(this.#processError(error)); });
      });
      this.#init = await this.#initialize();
      return this.#init;
    } catch (error) {
      const safe = error?.[SAFE_ERROR] ? error : this.#processError(error);
      this.#fail(safe);
      throw safe;
    }
  }

  call(method, params, { timeoutMs = this.timeoutMs, id = null } = {}) {
    if (!this.proc || this.gone || this.closing) return Promise.reject(rpcError(`${this.label} ACP is not running`));
    const requestId = id ?? `pleiad-${++this.nextId}`;
    if (this.pending.has(requestId)) return Promise.reject(rpcError('Duplicate JSON-RPC id'));
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(rpcError(`${this.label} ACP request timed out`, -32001));
      }, timeoutMs) : null;
      this.pending.set(requestId, { resolve, reject, timer, method, params });
      try { this.#write({ jsonrpc: '2.0', id: requestId, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  /** 次に送る依頼の id（server/prompt の id を、書く前に札へ置くため）。使うと番号が進む */
  newId() { return `pleiad-${++this.nextId}`; }

  notify(method, params) {
    if (!this.proc || this.gone || this.closing) throw rpcError(`${this.label} ACP is not running`);
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame) {
    const text = JSON.stringify(frame);
    if (!this.proc?.stdin?.writable) throw rpcError(`${this.label} ACP stdin is closed`);
    this.proc.stdin.write(`${text}\n`, (error) => { if (error) this.#fail(rpcError(`${this.label} ACP write failed`)); });
  }

  #stdout(chunk) {
    if (this.gone || this.closing) return;
    this.reader.push(chunk);
  }

  #line(line, opts = null) {
    if (this.gone || this.closing) return;
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return this.#fail(rpcError(`Invalid ${this.label} ACP JSON frame`, -32700)); }
    if (!frame || frame.jsonrpc !== '2.0' || typeof frame !== 'object') return this.#fail(rpcError(`Invalid ${this.label} ACP JSON-RPC frame`, -32600));
    this.#frame(frame, opts);
  }

  #stderr(chunk) {
    const bytes = Buffer.from(chunk);
    this.stderrBytes += bytes.length;
    const tail = Buffer.concat([Buffer.from(this.stderrTail, 'utf8'), bytes]).subarray(-MAX_STDERR_BYTES);
    this.stderrTail = tail.toString('utf8');
  }

  /** 通知の処理を呼ぶ。投げた・断った約束は失敗にする（文面は `${label} ACP ${what} handler failed`） */
  #handle(fn, what) {
    const failed = () => this.#fail(rpcError(`${this.label} ACP ${what} handler failed`));
    try {
      const result = fn();
      if (result && typeof result.then === 'function') result.catch(failed);
    } catch { failed(); }
  }

  #frame(frame, opts = null) {
    if (Object.hasOwn(frame, 'method')) {
      if (typeof frame.method !== 'string' || !frame.method) return this.#fail(rpcError(`Invalid ${this.label} ACP method`, -32600));
      if (Object.hasOwn(frame, 'id')) {
        if (!isRpcId(frame.id)) return this.#fail(rpcError(`Invalid ${this.label} ACP request id`, -32600));
        return this.#serverRequest(frame, opts);
      }
      if (frame.method === 'session/update') this.#handle(() => this.onUpdate(frame.params, opts), 'update');
      else if (this.routeNotification) this.#handle(() => this.routeNotification(frame.method, frame.params, opts, (fn, what = 'notification') => this.#handle(fn, what)), 'notification');
      return;
    }
    if (!Object.hasOwn(frame, 'id')) return this.#fail(rpcError(`Invalid ${this.label} ACP response`, -32600));
    if (!isRpcId(frame.id)) return this.#fail(rpcError(`Invalid ${this.label} ACP response id`, -32600));
    const pending = this.pending.get(frame.id);
    if (!pending) return; // Late response after timeout is harmless.
    const hasError = Object.hasOwn(frame, 'error'), hasResult = Object.hasOwn(frame, 'result');
    if (hasError === hasResult || (hasError && (!frame.error || typeof frame.error !== 'object' || !Number.isInteger(frame.error.code) || typeof frame.error.message !== 'string'))) {
      return this.#fail(rpcError(`Malformed ${this.label} ACP response`, -32600));
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (hasError) {
      const e = frame.error;
      const failure = acpRequestFailure(e, this.label, `${this.label} ACP request failed`, { vendorKinds: this.vendorKinds });
      const reject = rpcError(failure.message, failure.code);
      // 構造化した安全な印だけを載せる（wire の message/data/trace id はここから外へ出さない）
      if (this.decorateError) { try { this.decorateError(reject, { error: e, method: pending.method, params: pending.params }); } catch {} }
      pending.reject(reject);
    } else {
      // Observe ACKs in wire order, before resolving a call can queue its await.
      try { this.onResponse({ method: pending.method, params: pending.params, result: frame.result }); }
      catch {
        const error = rpcError(`${this.label} ACP response handler failed`);
        pending.reject(error); this.#fail(error); return;
      }
      pending.resolve(frame.result);
    }
  }

  #serverRequest(frame, opts = null) {
    const idKey = `${typeof frame.id}:${String(frame.id)}`;
    // 記録の再生（印から ack まで）の依頼は履歴。まだ答えていないもの（保持役の控え。付け直しで渡し直される）だけを聞き直す
    if (opts?.replay && !opts?.redelivered && !this.pendingRequests.has(JSON.stringify(frame.id))) { this.seenIncoming.add(idKey); return; }
    // 記録の続きと控えの渡し直しで同じ依頼が 2 回来る。聞くのは 1 回だけ
    if (this.asked.has(idKey)) return;
    if (this.seenIncoming.has(idKey) || this.seenIncoming.size >= 10_000) return this.#fail(rpcError(`Duplicate or excessive ${this.label} ACP request id`, -32600));
    this.asked.add(idKey);
    this.seenIncoming.add(idKey);
    this.incoming.add(idKey);
    const signal = this.connectionAbort.signal;
    let onAbort;
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const handling = Promise.resolve().then(() => {
      if (this.closing || this.gone || signal.aborted) return null;
      return this.onRequest(frame.method, frame.params, { signal });
    });
    Promise.race([handling, cancelled]).then(
      (result) => { if (!this.closing && !this.gone) this.#write({ jsonrpc: '2.0', id: frame.id, result: result ?? null }); },
      (error) => { if (!this.closing && !this.gone) this.#write({ jsonrpc: '2.0', id: frame.id, error: { code: CALLBACK_CODES.has(error?.code) ? error.code : -32603, message: `${this.label} ACP client request failed` } }); },
    ).catch(() => this.#fail(rpcError(`${this.label} ACP request response failed`))).finally(() => { signal.removeEventListener('abort', onAbort); this.incoming.delete(idKey); });
  }

  #fail(error, { terminateTree = true } = {}) {
    if (this.gone || this.closing) return;
    this.gone = true;
    this.reader.reset();
    this.connectionAbort.abort();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.reaping = (terminateTree ? this.#terminateTree() : Promise.resolve()).finally(() => { try { this.proc?.stdin?.destroy(); } catch {} });
    try { this.onGone(error); } catch {}
  }

  async #terminateTree() {
    if (this.held) { this.held.kill(); return; }
    const child = this.proc;
    if (!child?.pid) return;
    // Each POSIX child owns a detached process group. The group can survive the
    // root process, so reap it even when the CLI has already exited.
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch {}
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { await killTree(child.pid); } catch {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }

  async close() {
    if (this.closed) return this.closed;
    this.closing = true;
    this.reader.reset();
    this.connectionAbort.abort();
    const error = rpcError(`${this.label} ACP closed`, -32800);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.closed = (async () => {
      if (this.held) { await this.held.close(); this.gone = true; return; }
      const child = this.proc;
      if (!child) { this.gone = true; return; }
      if (this.reaping) {
        await this.reaping;
        if (child.pid) await waitForExit(child, 2000);
        if (child.pid && child.exitCode === null && child.signalCode === null) throw rpcError(`${this.label} ACP did not stop`);
        this.gone = true;
        return;
      }
      if (child.pid == null) await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); child.off('spawn', done); child.off('error', done); resolve(); };
        const timer = setTimeout(done, 1000);
        child.once('spawn', done);
        child.once('error', done);
      });
      // Stop the tree while its root is still alive: ending stdin first can let
      // the root exit before Windows taskkill can discover its descendants.
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        this.reaping = this.#terminateTree();
        await this.reaping;
        await waitForExit(child, 2000);
        if (child.exitCode === null && child.signalCode === null) throw rpcError(`${this.label} ACP did not stop`);
      }
      this.gone = true;
    })();
    return this.closed;
  }
}

export { rpcError, SAFE_ERROR, PROCESS_CODES, CALLBACK_CODES, waitForExit };
