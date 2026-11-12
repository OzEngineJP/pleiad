// wait_until の問いを決定モデル（perplexity/pplx-decider-v1.2、OpenRouter の decisions）に 1 回聞く（ADR 0165）。
// 送るのは撮った画面（JPEG）と問いだけ。キーは設定 › API キーの割り当て computer:decider（ADR 0155）。
// 失敗は決まった code（timeout / network / http_<status> / bad_response）だけで返し、キー・応答の本文は文にもログにも出さない。
// 応答の読み方は 1 か所（parseDecision）。形は委譲先の自動選択（core/delegation-judges.mjs の askJudge）と同じ answers.<名前>.noul。

export const DECIDER_MODEL = 'perplexity/pplx-decider-v1.2';
/** 1 回の往復の上限（検証の中央値は 898ms） */
export const DECIDER_TIMEOUT_MS = 6000;
/** 送る画面の上限（検証は 1440×900。それより小さいと正答率が 2〜7 ポイント落ちた） */
export const DECIDER_SHOT = Object.freeze({ maxEdge: 1440, maxPixels: 1_300_000, quality: 75 });
/** 問いの上限（文字） */
export const UNTIL_MAX = 500;
const MAX_BODY = 64 * 1024;

// 送り先。AGENT_HOST_OPENROUTER_API はテストの偽物用（本物へは送らない）。自動選択と同じ変数
const apiBase = env => String(env.AGENT_HOST_OPENROUTER_API || 'https://openrouter.ai/api').replace(/\/+$/, '');

/** 送る本文。問いは「完了したか」の向き（はい = 完了） */
export function decisionBody(jpegBase64, until) {
  return {
    model: DECIDER_MODEL,
    state: [{ type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }],
    questions: { done: { type: 'noul', instructions: until, criteria: { true: 'Yes', false: 'No' } } },
  };
}

/** 応答から はい の確率（0〜1）。形が違えば null */
export function parseDecision(data) {
  const answer = data?.answers?.done, p = answer?.noul;
  if (answer?.type !== 'noul' || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return Math.round(p * 1000) / 1000;
}

/** Pleiad Plus の中継へ送るときの待ち時間の上限（1 段多い経路。core/delegation-judges.mjs の PLUS_JUDGE_TIMEOUT_MS と同じ） */
export const PLUS_DECIDER_TIMEOUT_MS = 8000;

/** 誤りの本文から中継の code と resetAt を取る（本文そのものは返さない・出さない） */
async function plusError(res) {
  const text = await res.text().catch(() => '');
  try {
    const err = JSON.parse(text)?.error;
    return { code: typeof err?.code === 'string' ? err.code : null, resetAt: typeof err?.resetAt === 'string' ? err.resetAt : null };
  } catch { return { code: null, resetAt: null }; }
}

const isTimeout = e => e?.name === 'TimeoutError' || e?.name === 'AbortError';

/**
 * 1 回聞く。戻りは { ok: true, p } か { ok: false, code, resetAt? }。投げない。
 * 送り先は endpoint（{ kind: 'plus'|'openrouter', baseUrl, authorization, ... }。core/api-keys.mjs の useRoute）か key（OpenRouter のキーの値）。
 * plus のときは中継の code（credit_exhausted・rate_limited・not_plus・account_disabled・unauthenticated・upstream_error・unavailable …）を code に載せ、
 * ID トークンの失効（401 unauthenticated）は 1 度だけ取り直して送り直す（core/delegation-judges.mjs の post と同じ）。
 * 上限（credit_exhausted）は endpoint.noteCredit で覚え、not_plus・account_disabled は endpoint.refreshAccount でアカウントを読み直す
 * @param {object} o
 * @param {string} [o.key]
 * @param {object} [o.endpoint]
 * @param {Uint8Array} o.jpeg
 * @param {string} o.until
 */
export async function askDecider({ key, endpoint, jpeg, until, fetch: fetchImpl = globalThis.fetch, env = process.env, timeoutMs, signal }) {
  const plus = endpoint?.kind === 'plus';
  const limit = timeoutMs ?? (plus ? PLUS_DECIDER_TIMEOUT_MS : DECIDER_TIMEOUT_MS);
  const body = JSON.stringify(decisionBody(Buffer.from(jpeg).toString('base64'), until));
  const url = `${endpoint?.baseUrl ?? apiBase(env)}/alpha/decisions`;
  const send = authorization => fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(limit), ...(signal ? [signal] : [])]),
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Title': 'Pleiad' }, body });
  let authorization;
  try { authorization = endpoint ? await endpoint.authorization() : `Bearer ${key}`; }
  catch { return { ok: false, code: endpoint ? 'unauthenticated' : 'no_key' }; }   // Pleiad Plus の ID トークンを取れない = ログインが切れた（キーが無いのではない）
  let res;
  try { res = await send(authorization); }
  catch (e) { return { ok: false, code: isTimeout(e) ? 'timeout' : 'network' }; }
  if (plus && res.status === 401) {
    const err = await plusError(res);
    if (err.code !== 'unauthenticated') return { ok: false, code: err.code ?? 'unauthenticated', ...(err.resetAt ? { resetAt: err.resetAt } : {}) };
    try { authorization = await endpoint.authorization({ force: true }); } catch { return { ok: false, code: 'unauthenticated' }; }
    try { res = await send(authorization); }
    catch (e) { return { ok: false, code: isTimeout(e) ? 'timeout' : 'network' }; }
  }
  if (!res.ok) {
    if (!plus) { await res.body?.cancel?.().catch(() => {}); return { ok: false, code: `http_${res.status}` }; }
    const err = await plusError(res);
    if (err.code === 'credit_exhausted') endpoint.noteCredit?.(err.resetAt ?? null);
    else if (err.code === 'not_plus' || err.code === 'account_disabled') endpoint.refreshAccount?.();
    return { ok: false, code: err.code ?? `http_${res.status}`, ...(err.resetAt ? { resetAt: err.resetAt } : {}) };
  }
  let text;
  try { text = await res.text(); } catch (e) { return { ok: false, code: isTimeout(e) ? 'timeout' : 'bad_response' }; }
  if (text.length > MAX_BODY) return { ok: false, code: 'bad_response' };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, code: 'bad_response' }; }
  const p = parseDecision(data);
  return p === null ? { ok: false, code: 'bad_response' } : { ok: true, p };
}
