// Pleiad Plus のセッション。ログイン（外のブラウザー + ループバック + PKCE）・保管・更新・ログアウト・状態。
//
// 保管するのは更新トークンだけ（<data>/plus-secrets.json の鍵 `plus:session`、ほかの秘密と同じ secretCipher）。
// ID トークンと期限はメモリにだけ置く。
// ログインの基盤の値（projectId・apiKey）はアプリに焼き込まず、/v1/auth/config（core/plus/config.mjs）から読む。
// ID トークン・更新トークン・code・codeVerifier・state の値はログにも誤りの文にも書かない。
import http from 'node:http';
import crypto from 'node:crypto';
import { t } from '../i18n.mjs';
import { oauthSuccessHtml, oauthErrorHtml } from '../auth/oauth-page.mjs';
import { PlusError, createPlusClient } from './client.mjs';

export { PlusError };

const STORE_KEY = 'plus:session';
const GRANT_ERRORS = ['TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_REFRESH_TOKEN'];
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
const closeServer = server => { try { server.closeAllConnections?.(); } catch {} try { server.close(); } catch {} };
const page = (res, status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };

/** GET /v1/account のうち使う欄だけ（ほかは読まない）。free のとき plan・limits・usage・sync は null */
function pickAccount(body) {
  if (!body || typeof body !== 'object' || typeof body.uid !== 'string') return null;
  const pick = (v, keys) => (v && typeof v === 'object' ? Object.fromEntries(keys.map(k => [k, v[k]])) : null);
  return {
    uid: body.uid,
    email: typeof body.email === 'string' ? body.email : null,
    provider: typeof body.provider === 'string' ? body.provider : null,
    status: ['plus', 'free', 'disabled'].includes(body.status) ? body.status : 'free',
    plan: pick(body.plan, ['id', 'name']),
    limits: pick(body.limits, ['hosts', 'devicesPerHost', 'creditsPerMonth', 'syncBytes']),
    usage: pick(body.usage, ['credits', 'periodStart', 'resetAt']),
    sync: pick(body.sync, ['enabled']),
  };
}

/**
 * @param {object} o
 * @param {object} o.config   createPlusConfig の結果
 * @param {object} o.secrets  createSecretStore の結果（<data>/plus-secrets.json）
 * @param {(url: string) => void} [o.openExternal] ログインのページを既定のブラウザーで開く
 * @param {() => string} [o.lang] 今の画面の言語（ja|en）
 * @param {Function} [o.fetchFn]
 * @param {Function} [o.now]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [o.timers] 試験の時計用
 * @param {number} [o.loginTtlMs] ループバックの受け口を閉じるまで（既定 10 分）
 * @param {number} [o.refreshRetryMs] 更新の取り直しの間隔（既定 1 分）
 * @param {number} [o.refreshRetries] 更新の取り直しの回数（既定 5）
 * @param {number} [o.accountIntervalMs] ログイン中の account の読み直し（既定 15 分）
 * @param {number} [o.accountThrottleMs] 画面の refresh の間隔（既定 30 秒）
 */
export function createPlusSession({ config, secrets, openExternal = () => {}, lang = () => 'en', fetchFn = fetch,
  now = Date.now, timers = { setTimeout, clearTimeout },
  loginTtlMs = 10 * 60_000, refreshRetryMs = 60_000, refreshRetries = 5, accountIntervalMs = 15 * 60_000, accountThrottleMs = 30_000,
  appVersion = '0.0.0' } = {}) {
  const wait = ms => new Promise(r => { const id = timers.setTimeout(r, ms); id?.unref?.(); });

  let stored = null;            // { refreshToken, uid, email, tokenProjectId, apiKey, savedAt }
  let idToken = null, idTokenExpiresAt = 0;
  let account = null;           // 最後に読めた account
  let reachable = true;
  let error = null;             // { code: 'relogin' | 'locked' } | null
  let host = null;              // B4 が埋める（この PC の登録の結果）
  let loginPhase = 'idle';      // 'idle' | 'waiting' | 'finishing' | 'failed'
  let flow = null;              // 進行中のログイン { server, state, verifier, redirectUri, timer }
  let refreshing = null;        // single-flight
  let cachedCfg = null;         // 最後に読めた /v1/auth/config
  let accountTimer = null, accountLastAt = 0, accountPolling = null;
  const listeners = new Set();

  const client = createPlusClient({
    config, appVersion, fetchFn,
    getIdToken,
    onAuthFailure: () => void clearSession({ code: 'relogin' }),
    onAccountDisabled: () => { if (account) { account = { ...account, status: 'disabled' }; emit('account'); } },
  });

  const signedIn = () => Boolean(stored?.refreshToken);

  function statusShape() {
    const d = config.derive(cachedCfg);
    return {
      available: d.available,
      state: d.state,
      needsUpdate: d.needsUpdate,
      signedIn: signedIn(),
      login: { phase: loginPhase },
      account,
      uid: stored?.uid ?? null,
      reachable,
      error,
      urls: { account: cachedCfg?.urls?.account ?? null, profile: cachedCfg?.urls?.profile ?? null },
      host,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  function emit(type) {
    const status = statusShape();
    for (const fn of [...listeners]) { try { fn({ type, status }); } catch {} }
  }

  /** 保管とメモリを消す（relogin・更新の拒否・ログアウト）。知らせは signedOut */
  async function clearSession(err) {
    stored = null; idToken = null; idTokenExpiresAt = 0; account = null;
    stopAccountPoll();
    if (err) error = err;
    await secrets.delete(STORE_KEY).catch(() => {});
    emit('signedOut');
  }

  /** 保管が読めない（SECRET_LOCKED・SECRET_FILE_BROKEN）。消さずに locked */
  function lockSession() {
    stored = null; idToken = null; idTokenExpiresAt = 0; account = null;
    error = { code: 'locked' };
  }

  async function saveStored(value) {
    stored = value;
    await secrets.set(STORE_KEY, value);
  }

  // ---- /v1/auth/config と tokenProjectId の照合 -----------------------------------------------------------

  async function loadConfig({ fresh = false } = {}) {
    const before = cachedCfg?.state;
    cachedCfg = await config.get({ fresh });
    // 保管した tokenProjectId が /v1/auth/config の projectId と違う → 保管を消して relogin
    if (stored && cachedCfg?.token?.projectId && stored.tokenProjectId !== cachedCfg.token.projectId) {
      await clearSession({ code: 'relogin' });
    }
    if (cachedCfg?.state !== before && listeners.size) emit('config');
    return cachedCfg;
  }

  // ---- ID トークンの取り直し -------------------------------------------------

  async function refreshOnce() {
    const cfg = cachedCfg ?? await loadConfig();
    const refreshUrl = cfg?.urls?.refresh;
    const apiKey = stored?.apiKey || cfg?.token?.apiKey;
    if (!refreshUrl || !apiKey || !stored?.refreshToken) throw new PlusError({ code: 'network', message: t('plus.unreachable') });
    let res;
    try {
      res = await fetchFn(`${refreshUrl}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new PlusError({ code: 'network', message: String(e?.message ?? e).slice(0, 200) });
    }
    const body = await res.json().catch(() => null);
    if (res.status === 400) {
      const message = String(body?.error?.message ?? '');
      if (GRANT_ERRORS.some(code => message.startsWith(code))) {
        await clearSession();
        throw new PlusError({ status: 400, code: 'unauthenticated', message: t('plus.signedOut') });
      }
      throw new PlusError({ status: 400, code: 'bad_request', message: 'refresh rejected' });
    }
    if (!res.ok) throw new PlusError({ status: res.status, code: 'network', message: `HTTP ${res.status}` });
    if (typeof body?.id_token !== 'string' || !body.id_token) throw new PlusError({ code: 'network', message: 'bad refresh response' });
    idToken = body.id_token;
    idTokenExpiresAt = now() + (Number(body.expires_in) || 3600) * 1000;
    // refresh_token が替わったら保管し直す
    if (typeof body.refresh_token === 'string' && body.refresh_token !== stored.refreshToken) {
      await saveStored({ ...stored, refreshToken: body.refresh_token, savedAt: new Date(now()).toISOString() });
    }
    if (!reachable) { reachable = true; emit('account'); }
    return idToken;
  }

  async function doRefresh() {
    let last = null;
    for (let attempt = 0; attempt < refreshRetries; attempt++) {
      try { return await refreshOnce(); }
      catch (e) {
        last = e;
        if (!(e instanceof PlusError) || e.code !== 'network') throw e;
        if (reachable) { reachable = false; emit('account'); }
        if (attempt + 1 < refreshRetries) await wait(refreshRetryMs);
      }
    }
    throw last;
  }

  /** 使ってよい ID トークン。期限の 5 分前を過ぎていたら取り直す（single-flight）。force は 401 の取り直し */
  async function getIdToken({ force = false } = {}) {
    if (!signedIn()) throw new PlusError({ status: 401, code: 'unauthenticated', message: t('plus.notSignedIn') });
    if (!force && idToken && now() < idTokenExpiresAt - 5 * 60_000) return idToken;
    refreshing ??= doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ---- account --------------------------------------------------------------------------------------------

  async function fetchAccount() {
    if (!signedIn()) return;
    accountPolling ??= (async () => {
      try {
        const next = pickAccount(await client.request('GET', '/v1/account'));
        if (next) {
          account = next;
          if (!reachable) reachable = true;
          emit('account');
        }
      } catch (e) {
        if (e instanceof PlusError && (e.code === 'unauthenticated' || !signedIn())) { /* セッション切れは別の経路で知らせる */ }
        if (reachable) { reachable = false; emit('account'); }
      } finally { accountPolling = null; accountLastAt = now(); }
    })();
    return accountPolling;
  }

  function startAccountPoll() {
    stopAccountPoll();
    accountTimer = timers.setTimeout(() => { accountTimer = null; void fetchAccount().then(() => { if (signedIn()) startAccountPoll(); }); }, accountIntervalMs);
    accountTimer?.unref?.();
  }
  function stopAccountPoll() { if (accountTimer !== null) { timers.clearTimeout(accountTimer); accountTimer = null; } }

  // ---- ログイン（ループバック + PKCE） -----------------------------------------------------------------------

  function failLogin(message) {
    if (!flow) return;
    const f = flow;
    flow = null;
    timers.clearTimeout(f.timer);
    closeServer(f.server);
    loginPhase = 'failed';
    emit('login');
  }

  async function finishLogin(f, code, res) {
    // 5. コードをトークンに替える
    let body = null;
    try {
      const r = await fetchFn(`${config.apiBase}/v1/auth/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier: f.verifier, redirectUri: f.redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });
      body = await r.json().catch(() => null);
      if (!r.ok) throw new PlusError({ status: r.status, code: body?.error?.code ?? 'http', message: 'token exchange failed' });
    } catch (e) {
      page(res, 400, oauthErrorHtml(t('plus.signInFailed')));
      failLogin(String(e?.message ?? e));
      return;
    }
    if (typeof body?.idToken !== 'string' || typeof body?.refreshToken !== 'string') {
      page(res, 400, oauthErrorHtml(t('plus.signInFailed')));
      failLogin('bad token response');
      return;
    }
    idToken = body.idToken;
    idTokenExpiresAt = Number(body.expiresAt) || now() + 3600_000;
    await saveStored({
      refreshToken: body.refreshToken, uid: body.uid ?? null, email: body.email ?? null,
      tokenProjectId: body.tokenProjectId ?? null, apiKey: body.apiKey ?? null, savedAt: new Date(now()).toISOString(),
    });
    page(res, 200, oauthSuccessHtml(t('plus.signedIn')));
    timers.clearTimeout(f.timer);
    closeServer(f.server);
    flow = null;
    loginPhase = 'idle';
    error = null;
    emit('login');
    emit('signedIn');
    startAccountPoll();
    void fetchAccount();
  }

  function handleCallback(f, req, res) {
    let url;
    try { url = new URL(req.url ?? '/', f.redirectUri); } catch { return page(res, 400, oauthErrorHtml(t('plus.signInFailed'))); }
    if (url.pathname !== '/callback') return page(res, 404, oauthErrorHtml('Not found.'));
    // state を定数時間で照合（長さが違えば不一致）
    const got = Buffer.from(String(url.searchParams.get('state') ?? ''));
    const want = Buffer.from(f.state);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      page(res, 400, oauthErrorHtml(t('plus.signInFailed')));
      return failLogin('state mismatch');
    }
    const errParam = url.searchParams.get('error');
    if (errParam) {
      page(res, 400, oauthErrorHtml(t('plus.signInFailed')));
      return failLogin(errParam);
    }
    const code = url.searchParams.get('code');
    if (!code) {
      page(res, 400, oauthErrorHtml(t('plus.signInFailed')));
      return failLogin('no code');
    }
    loginPhase = 'finishing';
    emit('login');
    void finishLogin(f, code, res);
  }

  /**
   * ログインを始める。`{ started: true }` を返し、完了・失敗は status() の login.phase と onChange で分かる。
   * 途中でもう一度呼ばれたら前の試みを捨てて（受け口も閉じて）新しく始める。
   * maintenance のときは PlusError({ code: 'maintenance' }）、needsUpdate のときは PlusError({ code: 'update' }）。
   */
  async function login() {
    const cfg = await loadConfig({ fresh: true });
    const d = config.derive(cfg);
    if (!d.available) throw new PlusError({ code: 'off', message: t('plus.unavailable') });
    if (cfg?.state === 'maintenance') throw new PlusError({ code: 'maintenance', message: t('plus.maintenance') });
    if (d.needsUpdate) throw new PlusError({ code: 'update', message: t('plus.needsUpdate') });
    if (typeof cfg?.urls?.login !== 'string' || !cfg.urls.login) throw new PlusError({ code: 'network', message: t('plus.unreachable') });

    // 前の試みを捨てる
    cancelLogin();

    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    let host = '127.0.0.1';
    let server = await listen(0, '127.0.0.1').catch(() => null);
    if (!server) { host = 'localhost'; server = await listen(0, 'localhost'); }
    const port = server.address().port;
    const f = { server, state, verifier, redirectUri: `http://${host}:${port}/callback`, timer: null };
    server.on('request', (req, res) => handleCallback(f, req, res));
    f.timer = timers.setTimeout(() => failLogin('timeout'), loginTtlMs);
    f.timer?.unref?.();
    flow = f;
    loginPhase = 'waiting';
    emit('login');
    const url = `${cfg.urls.login}?client=desktop&redirect_uri=${encodeURIComponent(f.redirectUri)}&state=${encodeURIComponent(state)}&code_challenge=${challenge}&code_challenge_method=S256&lang=${encodeURIComponent(lang())}`;
    try { openExternal(url); } catch {}
    return { started: true };
  }

  /** 進行中のログインをやめる。状態は idle に戻す */
  function cancelLogin() {
    if (!flow) { if (loginPhase !== 'idle') { loginPhase = 'idle'; emit('login'); } return statusShape(); }
    const f = flow;
    flow = null;
    timers.clearTimeout(f.timer);
    closeServer(f.server);
    loginPhase = 'idle';
    emit('login');
    return statusShape();
  }

  // ---- 外に出す口 -------------------------------------------------------------------------------------------

  return {
    client,
    /** 起動時に 1 回。保管を読み、config を読み、tokenProjectId を照合し、ログイン中なら account を読む */
    async init() {
      try { stored = (await secrets.get(STORE_KEY)) ?? null; }
      catch (e) {
        if (e?.code === 'SECRET_LOCKED' || e?.code === 'SECRET_FILE_BROKEN') lockSession();
        else throw e;
      }
      await loadConfig();
      emit('config');
      if (signedIn()) { startAccountPoll(); void fetchAccount(); }
      return statusShape();
    },
    login,
    cancelLogin,
    /** ログアウト。api には何も送らず、ID トークンを捨てて保管を消す */
    async logout() {
      cancelLogin();
      await clearSession();
      return statusShape();
    },
    getIdToken,
    /**
     * 今の状態。{ refresh: true } で account を読み直す（30 秒に 1 回まで）。
     * 秘密（トークン・apiKey・codeVerifier）は絶対に入れない。
     */
    async status({ refresh = false } = {}) {
      await loadConfig();
      if (refresh && signedIn() && now() - accountLastAt >= accountThrottleMs) void fetchAccount();
      return statusShape();
    },
    /** 変わるたびに知らせる。fn({ type: 'config'|'signedIn'|'signedOut'|'account'|'login', status }) */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** B4 が呼ぶ。status.host を差し替えて知らせる */
    setHost(next) { host = next ?? null; emit('account'); },
    /** 試験と B4 用: 状態の写し（読み取りだけ） */
    snapshot: statusShape,
  };
}
