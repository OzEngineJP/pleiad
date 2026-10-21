// Pleiad Plus の api を呼ぶ手。ヘッダー・誤りの形・401 の取り直しをここに集める。
// 誤りは {"error":{"code","message"}} を PlusError（status・code・message・retryAfter・resetAt・body）にして投げる。
// 本文が読めないとき・ネットの誤りは PlusError({ code: 'network' })。
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 券の道に対応したクライアントの印（X-Pleiad-Admission: 2）を付けるか。
 * 同期の口（/v1/sync/*）は同期の券をまだ使わないので付けない。syncPublicKey を載せる登録も、印つきでは api が受けないので付けない
 */
export const admissionMark = (path, body) => !String(path).startsWith('/v1/sync/')
  && !(body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'syncPublicKey'));

export class PlusError extends Error {
  constructor({ status, code, message, retryAfter, resetAt, body } = {}) {
    super(message ?? code ?? 'plus error');
    this.name = 'PlusError';
    this.status = status ?? null;
    this.code = code ?? 'unknown';
    this.retryAfter = retryAfter ?? null;
    this.resetAt = resetAt ?? null;
    // 誤りの本文の全体（409 conflict の current など、error のほかの欄を読む口のため）
    this.body = body ?? null;
  }
}

/** 誤りの本文から PlusError を作る。code が無ければ HTTP の状態から決める */
function errorFrom(status, body, headers) {
  const err = body && typeof body === 'object' ? body.error : null;
  const retryAfter = /^[\d.]+$/.test(headers?.get?.('retry-after') ?? '') ? Number(headers.get('retry-after')) : null;
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    return new PlusError({ status, code: err.code, message: typeof err.message === 'string' ? err.message : err.code, retryAfter, resetAt: typeof err.resetAt === 'string' ? err.resetAt : null, body });
  }
  return new PlusError({ status, code: status === 401 ? 'unauthenticated' : 'http', message: `HTTP ${status}`, retryAfter });
}

/**
 * @param {object} o
 * @param {object} o.config createPlusConfig の結果（apiBase を使う）
 * @param {(opts?: { force?: boolean }) => Promise<string>} o.getIdToken ID トークンを取る（force は 401 の取り直し）
 * @param {string} o.appVersion X-Pleiad-Client: desktop/<版>
 * @param {Function} [o.fetchFn]
 * @param {Function} [o.onAuthFailure] 取り直しても 401 だったとき（セッションを「もう一度ログインしてください」へ）
 * @param {Function} [o.onAccountDisabled] 403 account_disabled のとき（覚えているアカウントを disabled に）
 */
export function createPlusClient({ config, getIdToken, appVersion = '0.0.0', fetchFn = fetch, onAuthFailure = () => {}, onAccountDisabled = () => {} }) {
  async function send(method, path, { body, auth, signal, token } = {}) {
    const headers = { 'x-pleiad-client': `desktop/${appVersion}` };
    if (admissionMark(path, body)) headers['x-pleiad-admission'] = '2';
    if (auth) headers.authorization = `Bearer ${token ?? await getIdToken()}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchFn(`${config.apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      if (e?.name === 'AbortError' && signal?.aborted) throw e;
      throw new PlusError({ code: 'network', message: String(e?.message ?? e).slice(0, 200) });
    }
    let json = null;
    try { json = await res.json(); } catch { /* 本文の無い応答 */ }
    if (res.ok) return json;
    throw errorFrom(res.status, json, res.headers);
  }

  /**
   * api を呼ぶ。auth のときは ID トークンを付け、401 unauthenticated は 1 回だけ取り直してやり直す。
   * 2 回目も 401 なら onAuthFailure を呼んでから投げる。403 account_disabled は onAccountDisabled を呼ぶ。
   */
  async function request(method, path, { body, auth = true, signal } = {}) {
    try {
      return await send(method, path, { body, auth, signal });
    } catch (e) {
      if (!(e instanceof PlusError) || !auth) throw followup(e);
      if (e.status === 401 && e.code === 'unauthenticated') {
        // トークンを取り直して 1 回だけやり直す
        let token;
        try { token = await getIdToken({ force: true }); }
        catch (re) { throw followup(re); }
        try { return await send(method, path, { body, auth, signal, token }); }
        catch (re) {
          if (re instanceof PlusError && re.status === 401) { try { onAuthFailure(); } catch {} }
          throw followup(re);
        }
      }
      throw followup(e);
    }
  }

  function followup(e) {
    if (e instanceof PlusError && e.status === 403 && e.code === 'account_disabled') { try { onAccountDisabled(); } catch {} }
    return e;
  }

  return { request, PlusError };
}
