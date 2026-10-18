import { StringDecoder } from 'node:string_decoder';
import { spawnCli, cliCommand } from '../cli-installation.mjs';
import { killTree } from './antigravity-background.mjs';

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const CLIENT_INFO = { name: 'pleiad', version: '0.0.0' };

function rpcError(message, code = -32000, data) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
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

export class DevinAcp {
  constructor({ command = cliCommand('devin'), cwd, env, onUpdate = () => {}, onRequest = async () => { throw rpcError('Unsupported client request', -32601); }, onGone = () => {}, timeoutMs = 30_000 } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.onUpdate = onUpdate;
    this.onRequest = onRequest;
    this.onGone = onGone;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.starting = null;
    this.closing = false;
    this.gone = false;
    this.closed = null;
    this.reaping = null;
    this.nextId = 0;
    this.pending = new Map();
    this.incoming = new Set();
    this.seenIncoming = new Set();
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.stderrBytes = 0;
    this.stderrTail = '';
  }

  get pid() { return this.proc?.pid ?? null; }
  get alive() { return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null && !this.gone); }

  start() {
    if (this.starting) return this.starting;
    if (this.closing || this.gone) return Promise.reject(rpcError('Devin ACP is closed'));
    this.starting = this.#start();
    return this.starting;
  }

  async #start() {
    let child;
    try {
      child = spawnCli(this.command, ['acp'], {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.proc = child;
      child.stdout.on('data', (chunk) => this.#stdout(chunk));
      child.stderr.on('data', (chunk) => this.#stderr(chunk));
      child.on('error', (error) => this.#fail(rpcError(`Devin ACP process error: ${error.message}`)));
      child.on('exit', (code, signal) => this.#fail(rpcError(`Devin ACP exited (${signal ?? code ?? 'unknown'})`)));
      await new Promise((resolve, reject) => {
        if (child.pid) return resolve();
        const timer = setTimeout(() => reject(rpcError('Devin ACP spawn timed out')), this.timeoutMs);
        child.once('spawn', () => { clearTimeout(timer); resolve(); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      if (this.closing) throw rpcError('Devin ACP closed during startup', -32800);
      return await this.call('initialize', {
        protocolVersion: 1,
        clientInfo: CLIENT_INFO,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { timeoutMs: this.timeoutMs });
    } catch (error) {
      this.#fail(error instanceof Error ? error : rpcError('Devin ACP failed to start'));
      throw error;
    }
  }

  call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.proc || this.gone || this.closing) return Promise.reject(rpcError('Devin ACP is not running'));
    const id = `pleiad-${++this.nextId}`;
    if (this.pending.has(id)) return Promise.reject(rpcError('Duplicate JSON-RPC id'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(rpcError(`Devin ACP request timed out: ${method}`, -32001));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) {
    if (!this.proc || this.gone || this.closing) throw rpcError('Devin ACP is not running');
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame) {
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw rpcError('Devin ACP frame exceeds limit', -32600);
    if (!this.proc?.stdin?.writable) throw rpcError('Devin ACP stdin is closed');
    this.proc.stdin.write(`${text}\n`, (error) => { if (error) this.#fail(rpcError('Devin ACP write failed')); });
  }

  #stdout(chunk) {
    if (this.gone || this.closing) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES && !this.buffer.includes('\n')) return this.#fail(rpcError('Devin ACP frame exceeds limit', -32600));
    let at;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return this.#fail(rpcError('Devin ACP frame exceeds limit', -32600));
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { return this.#fail(rpcError('Invalid Devin ACP JSON frame', -32700)); }
      if (!frame || frame.jsonrpc !== '2.0' || typeof frame !== 'object') return this.#fail(rpcError('Invalid Devin ACP JSON-RPC frame', -32600));
      this.#frame(frame);
      if (this.gone) return;
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) this.#fail(rpcError('Devin ACP frame exceeds limit', -32600));
  }

  #stderr(chunk) {
    const bytes = Buffer.from(chunk);
    this.stderrBytes += bytes.length;
    const tail = Buffer.concat([Buffer.from(this.stderrTail, 'utf8'), bytes]).subarray(-MAX_STDERR_BYTES);
    this.stderrTail = tail.toString('utf8');
  }

  #frame(frame) {
    if (Object.hasOwn(frame, 'method')) {
      if (typeof frame.method !== 'string' || !frame.method) return this.#fail(rpcError('Invalid Devin ACP method', -32600));
      if (Object.hasOwn(frame, 'id')) {
        if (!(typeof frame.id === 'string' || (typeof frame.id === 'number' && Number.isFinite(frame.id)))) return this.#fail(rpcError('Invalid Devin ACP request id', -32600));
        return this.#serverRequest(frame);
      }
      if (frame.method === 'session/update') {
        try {
          const result = this.onUpdate(frame.params);
          if (result && typeof result.then === 'function') result.catch(() => this.#fail(rpcError('Devin ACP update handler failed')));
        } catch { this.#fail(rpcError('Devin ACP update handler failed')); }
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
      pending.reject(rpcError(e.message, e.code, e.data));
    } else pending.resolve(frame.result);
  }

  #serverRequest(frame) {
    const idKey = `${typeof frame.id}:${String(frame.id)}`;
    if (this.seenIncoming.has(idKey) || this.seenIncoming.size >= 10_000) return this.#fail(rpcError('Duplicate or excessive Devin ACP request id', -32600));
    this.seenIncoming.add(idKey);
    this.incoming.add(idKey);
    Promise.resolve().then(() => this.onRequest(frame.method, frame.params)).then(
      (result) => { if (!this.closing && !this.gone) this.#write({ jsonrpc: '2.0', id: frame.id, result: result ?? null }); },
      (error) => { if (!this.closing && !this.gone) this.#write({ jsonrpc: '2.0', id: frame.id, error: { code: Number.isInteger(error?.code) ? error.code : -32601, message: String(error?.message ?? 'Request denied') } }); },
    ).catch(() => this.#fail(rpcError('Devin ACP request response failed'))).finally(() => this.incoming.delete(idKey));
  }

  #fail(error) {
    if (this.gone || this.closing) return;
    this.gone = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    try { this.proc?.stdin?.destroy(); } catch {}
    this.reaping = this.#terminateTree();
    try { this.onGone(error); } catch {}
  }

  async #terminateTree() {
    const child = this.proc;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { await killTree(child.pid); } catch {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }

  async close() {
    if (this.closed) return this.closed;
    this.closing = true;
    const error = rpcError('Devin ACP closed', -32800);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.closed = (async () => {
      const child = this.proc;
      if (!child) { this.gone = true; return; }
      if (this.reaping) {
        await this.reaping;
        if (child.pid) await waitForExit(child, 2000);
        this.gone = true;
        return;
      }
      try { child.stdin?.end(); } catch {}
      if (child.pid == null) await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); child.off('spawn', done); child.off('error', done); resolve(); };
        const timer = setTimeout(done, 1000);
        child.once('spawn', done);
        child.once('error', done);
      });
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        await waitForExit(child, 500);
        if (child.exitCode === null && child.signalCode === null) {
          this.reaping = this.#terminateTree();
          await this.reaping;
          await waitForExit(child, 2000);
        }
      }
      this.gone = true;
    })();
    return this.closed;
  }
}
