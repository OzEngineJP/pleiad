// OpenCode の共有のサーバー（`opencode serve`）。Pleiad のサーバーにつき 1 本を起こし、全部の会話・作業場所で使う
// （1 本で約 760 MB。会話ごとには起こさない。docs/multi-backend.md §2.10）。
//
// - 起動は初めて要ったとき。ポートは 0（OS が選ぶ）で、stdout の `opencode server listening on http://…` から読む
// - basic 認証（OPENCODE_SERVER_PASSWORD。ユーザー名は opencode）。合言葉は起動ごとに作り、外へ出さない
// - 出来事は `/global/event`（SSE）の 1 本で、全部の作業場所の分を受ける（{ directory, payload: { type, properties } }）
// - 落ちたら、次に要ったときに起こし直す。走っていたターンには onGone で知らせる
// - 保持役に載せるとき（held。core/backends/opencode-held.mjs）は、保持役の子として起こし、Pleiad が入れ替わっても止めない。
//   新しい Pleiad は、前のサーバーが札に置いた待ち受けの URL と認証でつなぎ直す（起こさない）。Pleiad の待ち受け（origin）が前と違えば、
//   走っているターンが無くなってから起こし直す（OpenCode に渡した中継の口の URL が古いまま）
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
 * @param held { acquire({ argv }) => Promise<HeldOpencode | null> } | null。保持役に載せる口（opencode-held.mjs）
 * @param origin () => Promise<string>。OpenCode に渡す Pleiad の待ち受け（札に置く）。currentOrigin は今の値（待ち受ける前は null。見比べるだけで待たない）
 * @param busy () => boolean。走っているターンがあるか（待ち受けが変わったときに起こし直してよいか）
 */
export function createOpencodeServer({ command, env = async () => ({}), held = null, origin = async () => null, currentOrigin = () => null, busy = () => false }) {
  let proc = null;          // 起こした子（Pleiad の子のとき）
  let heldChild = null;     // 保持役の子のとき（HeldOpencode）
  let base = null;          // http://127.0.0.1:port
  let auth = null;          // Authorization の値
  let servedOrigin = null;  // OpenCode に渡した Pleiad の待ち受け
  let retired = false;      // 引き継ぎで手を離した（このサーバーは終わるところ。新しく起こさない）
  let starting = null;      // 起動中の Promise
  let stream = null;        // SSE の AbortController
  let exitHooked = false;
  const listeners = new Set();   // (event: { directory, type, properties }) => void
  const goneListeners = new Set();

  const lost = (reason) => {
    proc = null; heldChild = null; base = null; auth = null; servedOrigin = null;
    stream?.abort(); stream = null;
    for (const fn of goneListeners) { try { fn(new Error(`opencode serve exited: ${String(reason).slice(0, 300)}`)); } catch {} }
  };

  async function start() {
    const argv = command();
    if (!argv) throw Object.assign(new Error('opencode is not installed'), { code: 'NOT_INSTALLED' });
    const h = held ? await held.acquire({ argv }).catch((err) => { console.error('  opencode: the holder is not available:', String(err?.message ?? err).slice(0, 200)); return null; }) : null;
    if (h?.server?.base) return adopt(h);
    const password = crypto.randomBytes(24).toString('hex');
    const extra = await env();
    const childEnv = { ...process.env, ...extra, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
    const args = ['serve', '--port', '0', '--hostname', '127.0.0.1'];
    if (h) {
      const [file, ...prefix] = argv;
      const url = await h.spawn({ command: file, args: [...prefix, ...args], env: childEnv, cwd: process.cwd(), timeoutMs: START_TIMEOUT_MS });
      const at = await origin();
      h.setServer({ base: url, auth: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, origin: at, secret: extra.PLEIAD_OPENCODE_SECRET ?? null });
      return adopt(h);
    }
    const child = spawnCli(argv, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
    servedOrigin = await origin();
    child.once('exit', () => { if (proc === child) lost(tail.slice(-3).join(' / ')); });
    openStream();
  }

  /** 保持役の子につなぐ（起こしたばかりの子・前のサーバーから引き継いだ子）。札の待ち受けと認証で HTTP を話す */
  function adopt(h) {
    heldChild = h;
    base = h.server.base;
    auth = h.server.auth;
    servedOrigin = h.server.origin ?? null;
    h.onGone((exit) => { if (heldChild === h) lost(`${exit.code ?? exit.signal ?? exit.error ?? ''} ${h.tail()}`); });
    openStream();
  }

  async function ensure() {
    if (retired) throw new Error('opencode: the shared server was handed over to the next Pleiad server');
    // 前のサーバーから引き継いだ子が、今と違う Pleiad の待ち受けを持っている（OpenCode の中継の口が古い）。ターンが無くなったら起こし直す。
    // 止めてから起こすまでを 1 つの起動にまとめる（同時に来た呼び出しが、止めている最中の子につながない）
    const now = currentOrigin();
    const stale = Boolean(heldChild && base && now && !busy() && servedOrigin !== now);
    if (!stale && (proc || heldChild) && base) return { base, auth };
    starting ??= (async () => {
      if (stale) { console.error('  opencode: restarting the shared server (the Pleiad port changed)'); await stopNow(); }
      if (!((proc || heldChild) && base)) await start();
    })().finally(() => { starting = null; });
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
    // 保持役の子は opencode-held.mjs の終わりの保険が止める（手を離していれば止めない）
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {}
  }

  async function stopNow() {
    const child = proc;
    const h = heldChild;
    stream?.abort(); stream = null;
    proc = null; heldChild = null; base = null; auth = null; servedOrigin = null;
    if (h) await h.stop();
    else if (child?.pid) await killTree(child.pid).catch(() => { try { child.kill('SIGKILL'); } catch {} });
  }

  return {
    ensure,
    request,
    /** 出来事を受ける。返り値で外す */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** サーバーが落ちたときに呼ばれる。返り値で外す */
    onGone(fn) { goneListeners.add(fn); return () => goneListeners.delete(fn); },
    get running() { return Boolean((proc || heldChild) && base); },
    /** 保持役の子のとき（札を置く・手を離す）。Pleiad の子なら null */
    get held() { return heldChild && !heldChild.detached && !heldChild.closed ? heldChild : null; },
    /** 手を離した（引き継ぎ）。以後このサーバーは出来事を読まない（HTTP は新しいサーバーのもの） */
    handedOff() { retired = true; stream?.abort(); stream = null; heldChild = null; base = null; auth = null; servedOrigin = null; },
    stop: stopNow,
  };
}
