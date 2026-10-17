// OpenCode の共有のサーバー（`opencode serve`）。Pleiad のサーバーにつき 1 本を起こし、全部の会話・作業場所で使う
// （1 本で約 760 MB。会話ごとには起こさない。docs/multi-backend.md §2.10）。
//
// - 起動は初めて要ったとき。ポートは 0（OS が選ぶ）で、stdout の `opencode server listening on http://…` から読む
// - basic 認証（OPENCODE_SERVER_PASSWORD。ユーザー名は opencode）。合言葉は起動ごとに作り、外へ出さない
// - 出来事は `/global/event`（SSE）の 1 本で、全部の作業場所の分を受ける（{ directory, payload: { type, properties } }）
// - 落ちたら、次に要ったときに起こし直す。走っていたターンには onGone で知らせる
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { spawnCli } from '../cli-installation.mjs';
import { killTree } from './antigravity-background.mjs';

const LISTENING = /opencode server listening on (http:\/\/[^\s]+)/i;
const START_TIMEOUT_MS = Number(process.env.AGENT_HOST_OPENCODE_START_MS) || 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * @param command () => argv | null。opencode の実行ファイル（cliCommand('opencode')）
 * @param env () => Promise<object>。起こすときに足す環境変数（OPENCODE_CONFIG_CONTENT など）
 */
export function createOpencodeServer({ command, env = async () => ({}) }) {
  let proc = null;          // 起こした子
  let base = null;          // http://127.0.0.1:port
  let auth = null;          // Authorization の値
  let starting = null;      // 起動中の Promise
  let stream = null;        // SSE の AbortController
  let exitHooked = false;
  const listeners = new Set();   // (event: { directory, type, properties }) => void
  const goneListeners = new Set();

  async function start() {
    const argv = command();
    if (!argv) throw Object.assign(new Error('opencode is not installed'), { code: 'NOT_INSTALLED' });
    const password = crypto.randomBytes(24).toString('hex');
    const child = spawnCli(argv, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      env: { ...process.env, ...(await env()), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = [];
    const keep = (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) { tail.push(line); if (tail.length > 40) tail.shift(); } };
    child.stderr.on('data', keep);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve did not start in ${START_TIMEOUT_MS}ms: ${tail.join(' / ').slice(0, 400)}`)), START_TIMEOUT_MS);
      timer.unref?.();
      const look = (chunk) => {
        keep(chunk);
        const m = LISTENING.exec(String(chunk));
        if (m) { clearTimeout(timer); child.stdout.off('data', look); resolve(m[1].replace(/\/$/, '')); }
      };
      child.stdout.on('data', look);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`opencode serve exited (${code}): ${tail.join(' / ').slice(0, 400)}`)); });
    });
    child.stdout.on('data', keep);
    proc = child;
    // Pleiad が終わったら道連れにする。OpenCode の子（MCP のサーバー・ツールのシェル）も残さないよう木ごと止める。
    // SIGINT / SIGTERM のハンドラは足さない（server の既定の終了挙動を変えない。antigravity.mjs と同じ）
    if (!exitHooked) { exitHooked = true; process.once('exit', () => stopSync()); }
    base = url;
    auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    child.once('exit', () => {
      if (proc !== child) return;
      proc = null; base = null; auth = null;
      stream?.abort(); stream = null;
      for (const fn of goneListeners) { try { fn(new Error(`opencode serve exited: ${tail.slice(-3).join(' / ').slice(0, 300)}`)); } catch {} }
    });
    openStream();
  }

  async function ensure() {
    if (proc && base) return { base, auth };
    starting ??= start().finally(() => { starting = null; });
    await starting;
    return { base, auth };
  }

  function openStream() {
    const ac = new AbortController();
    stream = ac;
    const run = async () => {
      while (!ac.signal.aborted && base) {
        try {
          const res = await fetch(`${base}/global/event`, { headers: { authorization: auth, accept: 'text/event-stream' }, signal: ac.signal });
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let at;
            while ((at = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, at).replace(/\r$/, '');
              buffer = buffer.slice(at + 1);
              if (!line.startsWith('data:')) continue;
              let raw;
              try { raw = JSON.parse(line.slice(5)); } catch { continue; }
              const payload = raw?.payload ?? raw;
              const event = { directory: raw?.directory ?? null, type: payload?.type, properties: payload?.properties ?? {} };
              if (!event.type) continue;
              for (const fn of listeners) { try { fn(event); } catch (err) { console.error('  opencode: event listener failed:', String(err?.message ?? err)); } }
            }
          }
        } catch (err) {
          if (ac.signal.aborted) return;
          console.error('  opencode: event stream dropped:', String(err?.message ?? err).slice(0, 200));
        }
        if (!ac.signal.aborted) await new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); });
      }
    };
    void run();
  }

  /** HTTP の呼び出し。directory は作業場所（OpenCode の instance を選ぶ）。返りは JSON（空なら null） */
  async function request(method, path, { directory = null, body, query = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const { base: b, auth: a } = await ensure();
    const qs = new URLSearchParams({ ...(directory ? { directory } : {}), ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) });
    const res = await fetch(`${b}${path}${qs.size ? `?${qs}` : ''}`, {
      method,
      headers: { authorization: a, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`opencode ${method} ${path} ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  function stopSync() {
    const child = proc;
    proc = null;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {}
  }

  return {
    ensure,
    request,
    /** 出来事を受ける。返り値で外す */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** サーバーが落ちたときに呼ばれる。返り値で外す */
    onGone(fn) { goneListeners.add(fn); return () => goneListeners.delete(fn); },
    get running() { return Boolean(proc && base); },
    get pid() { return proc?.pid ?? null; },
    async stop() {
      const child = proc;
      stream?.abort(); stream = null;
      proc = null; base = null; auth = null;
      if (child?.pid) await killTree(child.pid).catch(() => { try { child.kill('SIGKILL'); } catch {} });
    },
  };
}
