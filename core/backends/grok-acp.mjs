import { createLineReader } from '../link-codec.mjs';
import { spawnCli, cliCommand } from '../cli-installation.mjs';
import { killTree } from './antigravity-background.mjs';

export const MAX_GROK_FRAME_BYTES = 64 * 1024 * 1024;
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
const processError = error => rpcError('Grok ACP process failed', PROCESS_CODES.has(error?.code) ? error.code : -32000);

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

export class GrokAcp {
  // args: `grok agent` と `stdio` の間に入れるオプション（--model・--reasoning-effort）
  constructor({ command = cliCommand('grok'), args = [], cwd, env, onUpdate = () => {}, onResponse = () => {}, onRequest = async () => { throw rpcError('Unsupported client request', -32601); }, onGone = () => {}, onDrop = ({ bytes }) => console.error(`  grok: dropped an oversize ACP line (${bytes} bytes)`), timeoutMs = 30_000 } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onUpdate = onUpdate;
    this.onResponse = onResponse;
    this.onRequest = onRequest;
    this.onGone = onGone;
    this.timeoutMs = timeoutMs;
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
      maxBytes: MAX_GROK_FRAME_BYTES,
      onLine: line => this.#line(line),
      onDrop: info => {
        // The id is unavailable. Keep reading ACKs, but bound even prompt calls
        // that normally have no deadline if the discarded line was their reply.
        for (const [id, pending] of this.pending) if (!pending.timer) {
          pending.timer = setTimeout(() => {
            if (!this.pending.delete(id)) return;
            pending.reject(rpcError('Grok ACP request timed out after a dropped frame', -32001));
          }, this.timeoutMs > 0 ? this.timeoutMs : 30_000);
        }
        try { onDrop(info); } catch {}
      },
    });
    this.stderrBytes = 0;
    this.stderrTail = '';
    this.init = null;
  }

  get pid() { return this.proc?.pid ?? null; }
  get alive() { return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null && !this.gone); }

  start() {
    if (this.closing || this.gone) return Promise.reject(rpcError('Grok ACP is closed'));
    if (this.starting) return this.starting;
    this.starting = this.#start();
    return this.starting;
  }

  async #start() {
    let child;
    try {
      child = spawnCli(this.command, ['agent', ...this.args, 'stdio'], {
        cwd: this.cwd,
        env: this.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.proc = child;
      child.stdin.on('error', () => this.#fail(rpcError('Grok ACP input pipe failed')));
      child.stdout.on('error', () => this.#fail(rpcError('Grok ACP output pipe failed')));
      child.stderr.on('error', () => this.#fail(rpcError('Grok ACP error pipe failed')));
      child.stdout.on('data', (chunk) => this.#stdout(chunk));
      child.stderr.on('data', (chunk) => this.#stderr(chunk));
      child.on('error', error => this.#fail(processError(error)));
      child.on('exit', () => this.#fail(rpcError('Grok ACP exited')));
      await new Promise((resolve, reject) => {
        if (child.pid) return resolve();
        const timer = setTimeout(() => reject(rpcError('Grok ACP spawn timed out')), this.timeoutMs);
        child.once('spawn', () => { clearTimeout(timer); resolve(); });
        child.once('error', error => { clearTimeout(timer); reject(processError(error)); });
      });
      if (this.closing) throw rpcError('Grok ACP closed during startup', -32800);
      this.init = await this.call('initialize', {
        protocolVersion: 1,
        clientInfo: CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { timeoutMs: this.timeoutMs });
      return this.init;
    } catch (error) {
      const safe = error?.[SAFE_ERROR] ? error : processError(error);
      this.#fail(safe);
      throw safe;
    }
  }

  call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.proc || this.gone || this.closing) return Promise.reject(rpcError('Grok ACP is not running'));
    const id = `pleiad-${++this.nextId}`;
    if (this.pending.has(id)) return Promise.reject(rpcError('Duplicate JSON-RPC id'));
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(rpcError('Grok ACP request timed out', -32001));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method, params });
      try { this.#write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) {
    if (!this.proc || this.gone || this.closing) throw rpcError('Grok ACP is not running');
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame) {
    const text = JSON.stringify(frame);
    if (!this.proc?.stdin?.writable) throw rpcError('Grok ACP stdin is closed');
    this.proc.stdin.write(`${text}\n`, (error) => { if (error) this.#fail(rpcError('Grok ACP write failed')); });
  }

  #stdout(chunk) {
    if (this.gone || this.closing) return;
    this.reader.push(chunk);
  }

  #line(line) {
    if (this.gone || this.closing) return;
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return this.#fail(rpcError('Invalid Grok ACP JSON frame', -32700)); }
    if (!frame || frame.jsonrpc !== '2.0' || typeof frame !== 'object') return this.#fail(rpcError('Invalid Grok ACP JSON-RPC frame', -32600));
    this.#frame(frame);
  }

  #stderr(chunk) {
    const bytes = Buffer.from(chunk);
    this.stderrBytes += bytes.length;
    const tail = Buffer.concat([Buffer.from(this.stderrTail, 'utf8'), bytes]).subarray(-MAX_STDERR_BYTES);
    this.stderrTail = tail.toString('utf8');
  }

  #frame(frame) {
    if (Object.hasOwn(frame, 'method')) {
      if (typeof frame.method !== 'string' || !frame.method) return this.#fail(rpcError('Invalid Grok ACP method', -32600));
      if (Object.hasOwn(frame, 'id')) {
        if (!(typeof frame.id === 'string' || (typeof frame.id === 'number' && Number.isFinite(frame.id)))) return this.#fail(rpcError('Invalid Grok ACP request id', -32600));
        return this.#serverRequest(frame);
      }
      if (frame.method === 'session/update') {
        try {
          const result = this.onUpdate(frame.params);
          if (result && typeof result.then === 'function') result.catch(() => this.#fail(rpcError('Grok ACP update handler failed')));
        } catch { this.#fail(rpcError('Grok ACP update handler failed')); }
      }
      return;
    }
    if (!Object.hasOwn(frame, 'id')) return this.#fail(rpcError('Invalid Grok ACP response', -32600));
    if (!(typeof frame.id === 'string' || (typeof frame.id === 'number' && Number.isFinite(frame.id)))) return this.#fail(rpcError('Invalid Grok ACP response id', -32600));
    const pending = this.pending.get(frame.id);
    if (!pending) return; // Late response after timeout is harmless.
    const hasError = Object.hasOwn(frame, 'error'), hasResult = Object.hasOwn(frame, 'result');
    if (hasError === hasResult || (hasError && (!frame.error || typeof frame.error !== 'object' || !Number.isInteger(frame.error.code) || typeof frame.error.message !== 'string'))) {
      return this.#fail(rpcError('Malformed Grok ACP response', -32600));
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (hasError) {
      const e = frame.error;
      pending.reject(rpcError('Grok ACP request failed', Number.isSafeInteger(e.code) ? e.code : -32000));
    } else {
      // Observe ACKs in wire order, before resolving a call can queue its await.
      try { this.onResponse({ method: pending.method, params: pending.params, result: frame.result }); }
      catch {
        const error = rpcError('Grok ACP response handler failed');
        pending.reject(error); this.#fail(error); return;
      }
      pending.resolve(frame.result);
    }
  }

  #serverRequest(frame) {
    const idKey = `${typeof frame.id}:${String(frame.id)}`;
    if (this.seenIncoming.has(idKey) || this.seenIncoming.size >= 10_000) return this.#fail(rpcError('Duplicate or excessive Grok ACP request id', -32600));
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
      (error) => { if (!this.closing && !this.gone) this.#write({ jsonrpc: '2.0', id: frame.id, error: { code: CALLBACK_CODES.has(error?.code) ? error.code : -32603, message: 'Grok ACP client request failed' } }); },
    ).catch(() => this.#fail(rpcError('Grok ACP request response failed'))).finally(() => { signal.removeEventListener('abort', onAbort); this.incoming.delete(idKey); });
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
    const error = rpcError('Grok ACP closed', -32800);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.closed = (async () => {
      const child = this.proc;
      if (!child) { this.gone = true; return; }
      if (this.reaping) {
        await this.reaping;
        if (child.pid) await waitForExit(child, 2000);
        if (child.pid && child.exitCode === null && child.signalCode === null) throw rpcError('Grok ACP did not stop');
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
        if (child.exitCode === null && child.signalCode === null) throw rpcError('Grok ACP did not stop');
      }
      this.gone = true;
    })();
    return this.closed;
  }
}
