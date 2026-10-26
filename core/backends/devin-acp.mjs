import { acpRequestFailure, acpTurnLimit } from './acp-error.mjs';
import { createLineReader } from '../link-codec.mjs';
import { spawnCli, cliCommand } from '../cli-installation.mjs';
import { killTree } from './antigravity-background.mjs';

export const MAX_DEVIN_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const CLIENT_INFO = { name: 'pleiad', version: '0.0.0' };
const SAFE_ERROR = Symbol('safe ACP error');
const CALLBACK_CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32800]);
const PROCESS_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'E2BIG', 'ENOMEM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOTDIR', 'EINVAL']);

function rpcError(message, code = -32000) {
  const error = new Error(message);
  error.code = code;
  error[SAFE_ERROR] = true;
  return error;
}
const processError = error => rpcError('Devin ACP process failed', PROCESS_CODES.has(error?.code) ? error.code : -32000);

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

export class DevinAcp {
  // held: 保持役の子に載せた CLI の口（core/backends/acp-held.mjs の createHeldAcp）。無ければ今の形（spawnCli）
  // adopt: 付け直し（{ promptId }。走っている session/prompt の応答を拾い直す）。initialize も session の作成も送らない
  constructor({ command = cliCommand('devin'), cwd, env, onUpdate = () => {}, onNotification = () => {}, onResponse = () => {}, onRequest = async () => { throw rpcError('Unsupported client request', -32601); }, onGone = () => {}, onDrop = ({ bytes }) => console.error(`  devin: dropped an oversize ACP line (${bytes} bytes)`), timeoutMs = 30_000, held = null, adopt = null } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.onUpdate = onUpdate;
    this.onNotification = onNotification;
    this.onResponse = onResponse;
    this.onRequest = onRequest;
    this.onGone = onGone;
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
    this.reader = createLineReader({
      maxBytes: MAX_DEVIN_FRAME_BYTES,
      onLine: line => this.#line(line),
      onOverflow: info => {
        // The id is unavailable. Keep reading ACKs, but bound even prompt calls
        // that normally have no deadline if the discarded line was their reply.
        for (const [id, pending] of this.pending) if (!pending.timer) {
          pending.timer = setTimeout(() => {
            if (!this.pending.delete(id)) return;
            pending.reject(rpcError('Devin ACP request timed out after a dropped frame', -32001));
          }, this.timeoutMs > 0 ? this.timeoutMs : 30_000);
        }
        try { onDrop(info); } catch {}
      },
    });
    this.stderrBytes = 0;
    this.stderrTail = '';
  }

  get pid() { return this.proc?.pid ?? null; }
  get alive() { return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null && !this.gone); }

  start() {
    if (this.closing || this.gone) return Promise.reject(rpcError('Devin ACP is closed'));
    if (this.starting) return this.starting;
    this.starting = this.held ? this.#startHeld() : this.#start();
    return this.starting;
  }

  /**
   * 保持役の子として起動する。付け直し（adopt）は子が走っているので initialize を送らず、走っている session/prompt の応答だけを待つ。
   * 読み（記録の再生と続き）は、付け直しでは写しを組み立てた後に begin() で始める（core/backends/acp-held.mjs）
   */
  async #startHeld() {
    try {
      const child = this.held.start({ argv: [...this.command, 'acp'], cwd: this.cwd, env: this.env ?? process.env });
      this.proc = child;
      child.stdin.on('error', () => this.#fail(rpcError('Devin ACP input pipe failed')));
      child.stdout.on('error', () => this.#fail(rpcError('Devin ACP output pipe failed')));
      child.stderr.on('error', () => this.#fail(rpcError('Devin ACP error pipe failed')));
      child.stdout.on('data', (chunk) => this.#stdout(chunk));
      child.stderr.on('data', (chunk) => this.#stderr(chunk));
      child.on('error', error => this.#fail(processError(error)));
      child.on('exit', () => this.#fail(rpcError('Devin ACP exited')));
      if (this.adopted) {
        // 2 回目の initialize は送らない（子は initialize 済み）。走っている prompt の応答の枠だけを開ける
        this.#awaitResponse(this.adopt?.promptId, 'session/prompt');
        return null;
      }
      this.held.begin({ onLine: (line, opts) => this.#line(line, opts) });
      if (this.closing) throw rpcError('Devin ACP closed during startup', -32800);
      return await this.call('initialize', {
        protocolVersion: 1,
        clientInfo: CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { timeoutMs: this.timeoutMs });
    } catch (error) {
      const safe = error?.[SAFE_ERROR] ? error : processError(error);
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
    if (typeof id !== 'string' && typeof id !== 'number') throw rpcError('Devin ACP adoption has no running request');
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
      child = spawnCli(this.command, ['acp'], {
        cwd: this.cwd,
        env: this.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.proc = child;
      child.stdin.on('error', () => this.#fail(rpcError('Devin ACP input pipe failed')));
      child.stdout.on('error', () => this.#fail(rpcError('Devin ACP output pipe failed')));
      child.stderr.on('error', () => this.#fail(rpcError('Devin ACP error pipe failed')));
      child.stdout.on('data', (chunk) => this.#stdout(chunk));
      child.stderr.on('data', (chunk) => this.#stderr(chunk));
      child.on('error', error => this.#fail(processError(error)));
      child.on('exit', () => this.#fail(rpcError('Devin ACP exited')));
      await new Promise((resolve, reject) => {
        if (child.pid) return resolve();
        const timer = setTimeout(() => reject(rpcError('Devin ACP spawn timed out')), this.timeoutMs);
        child.once('spawn', () => { clearTimeout(timer); resolve(); });
        child.once('error', error => { clearTimeout(timer); reject(processError(error)); });
      });
      if (this.closing) throw rpcError('Devin ACP closed during startup', -32800);
      return await this.call('initialize', {
        protocolVersion: 1,
        clientInfo: CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { timeoutMs: this.timeoutMs });
    } catch (error) {
      const safe = error?.[SAFE_ERROR] ? error : processError(error);
      this.#fail(safe);
      throw safe;
    }
  }

  call(method, params, { timeoutMs = this.timeoutMs, id = null } = {}) {
    if (!this.proc || this.gone || this.closing) return Promise.reject(rpcError('Devin ACP is not running'));
    const requestId = id ?? `pleiad-${++this.nextId}`;
    if (this.pending.has(requestId)) return Promise.reject(rpcError('Duplicate JSON-RPC id'));
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(rpcError('Devin ACP request timed out', -32001));
      }, timeoutMs) : null;
      this.pending.set(requestId, { resolve, reject, timer, method, params });
      try { this.#write({ jsonrpc: '2.0', id: requestId, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  /** 次に送る依頼の id（server/prompt の id を、書く前に札へ置くため）。使うと番号が進む */
  newId() { return `pleiad-${++this.nextId}`; }

  notify(method, params) {
    if (!this.proc || this.gone || this.closing) throw rpcError('Devin ACP is not running');
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame) {
    const text = JSON.stringify(frame);
    if (!this.proc?.stdin?.writable) throw rpcError('Devin ACP stdin is closed');
    this.proc.stdin.write(`${text}\n`, (error) => { if (error) this.#fail(rpcError('Devin ACP write failed')); });
  }

  #stdout(chunk) {
    if (this.gone || this.closing) return;
    this.reader.push(chunk);
  }

  #line(line, opts = null) {
    if (this.gone || this.closing) return;
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return this.#fail(rpcError('Invalid Devin ACP JSON frame', -32700)); }
    if (!frame || frame.jsonrpc !== '2.0' || typeof frame !== 'object') return this.#fail(rpcError('Invalid Devin ACP JSON-RPC frame', -32600));
    this.#frame(frame, opts);
  }

  #stderr(chunk) {
    const bytes = Buffer.from(chunk);
    this.stderrBytes += bytes.length;
    const tail = Buffer.concat([Buffer.from(this.stderrTail, 'utf8'), bytes]).subarray(-MAX_STDERR_BYTES);
    this.stderrTail = tail.toString('utf8');
  }

  #frame(frame, opts = null) {
    if (Object.hasOwn(frame, 'method')) {
      if (typeof frame.method !== 'string' || !frame.method) return this.#fail(rpcError('Invalid Devin ACP method', -32600));
      if (Object.hasOwn(frame, 'id')) {
        if (!(typeof frame.id === 'string' || (typeof frame.id === 'number' && Number.isFinite(frame.id)))) return this.#fail(rpcError('Invalid Devin ACP request id', -32600));
        return this.#serverRequest(frame, opts);
      }
      if (frame.method === 'session/update') {
        try {
          const result = this.onUpdate(frame.params, opts);
          if (result && typeof result.then === 'function') result.catch(() => this.#fail(rpcError('Devin ACP update handler failed')));
        } catch { this.#fail(rpcError('Devin ACP update handler failed')); }
      } else {
        // session/update 以外の通知（_cognition.ai/compaction などの ext_notification）。要求（id 付き）は上で処理する
        try {
          const result = this.onNotification(frame.method, frame.params, opts);
          if (result && typeof result.then === 'function') result.catch(() => this.#fail(rpcError('Devin ACP notification handler failed')));
        } catch { this.#fail(rpcError('Devin ACP notification handler failed')); }
      }
      return;
    }
    if (!Object.hasOwn(frame, 'id')) return this.#fail(rpcError('Invalid Devin ACP response', -32600));
    if (!(typeof frame.id === 'string' || (typeof frame.id === 'number' && Number.isFinite(frame.id)))) return this.#fail(rpcError('Invalid Devin ACP response id', -32600));
    const pending = this.pending.get(frame.id);
    if (!pending) return; // Late response after timeout is harmless.
    const hasError = Object.hasOwn(frame, 'error'), hasResult = Object.hasOwn(frame, 'result');
    if (hasError === hasResult || (hasError && (!frame.error || typeof frame.error !== 'object' || !Number.isInteger(frame.error.code) || typeof frame.error.message !== 'string'))) {
      return this.#fail(rpcError('Malformed Devin ACP response', -32600));
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (hasError) {
      const e = frame.error;
      const failure = acpRequestFailure(e, 'Devin', 'Devin ACP request failed');
      const reject = rpcError(failure.message, failure.code);
      // 構造化した安全な印だけを載せる（wire の message/data/trace id はここから外へ出さない）
      const limit = acpTurnLimit(e);
      if (limit) reject.acpLimit = limit;
      pending.reject(reject);
    } else {
      // Observe ACKs in wire order, before resolving a call can queue its await.
      try { this.onResponse({ method: pending.method, params: pending.params, result: frame.result }); }
      catch {
        const error = rpcError('Devin ACP response handler failed');
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
    if (this.seenIncoming.has(idKey) || this.seenIncoming.size >= 10_000) return this.#fail(rpcError('Duplicate or excessive Devin ACP request id', -32600));
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
      (error) => { if (!this.closing && !this.gone) this.#write({ jsonrpc: '2.0', id: frame.id, error: { code: CALLBACK_CODES.has(error?.code) ? error.code : -32603, message: 'Devin ACP client request failed' } }); },
    ).catch(() => this.#fail(rpcError('Devin ACP request response failed'))).finally(() => { signal.removeEventListener('abort', onAbort); this.incoming.delete(idKey); });
  }

  #fail(error) {
    if (this.gone || this.closing) return;
    this.gone = true;
    this.reader.reset();
    this.connectionAbort.abort();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.reaping = this.#terminateTree().finally(() => { try { this.proc?.stdin?.destroy(); } catch {} });
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
    const error = rpcError('Devin ACP closed', -32800);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.closed = (async () => {
      if (this.held) { await this.held.close(); this.gone = true; return; }
      const child = this.proc;
      if (!child) { this.gone = true; return; }
      if (this.reaping) {
        await this.reaping;
        if (child.pid) await waitForExit(child, 2000);
        if (child.pid && child.exitCode === null && child.signalCode === null) throw rpcError('Devin ACP did not stop');
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
        if (child.exitCode === null && child.signalCode === null) throw rpcError('Devin ACP did not stop');
      }
      this.gone = true;
    })();
    return this.closed;
  }
}
