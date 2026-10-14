// 会話の PR の状態を gh で読む（git パネルの頭の PR の行。docs/git-panel-pr.md、ADR 0206）。
// gh pr view <URL> --json … の読み取りだけ（ネットワークは読むだけ。PR にも git にも書かない）。結果は URL ごとに 60 秒覚える。
// 画面へは正規化した形だけを返す: { number, url, repo, title?, state?: open|draft|merged|closed, checks?: pass|fail|pending, child? }。
// gh が無い・ログインしていないときは state・title・checks を付けず、reason（no-gh | no-auth）で理由を返す。
// 試験と画面の確認のために AGENT_HOST_GH で gh の代わりを指せる（.mjs / .js ならこの node で動かす）。
import { execFile } from 'node:child_process';
import { parsePrUrl } from './session-prs.mjs';

export const PR_TTL_MS = 60_000;
/** 1 回に状態を読む PR の数（新しい方から）と、並行して走らせる gh の数 */
export const PR_READ_MAX = 20;
const PR_PARALLEL = 4;
const GH_TIMEOUT_MS = 15_000;
const CACHE_MAX = 200;

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/** statusCheckRollup（CheckRun と StatusContext の混ざった配列）を pass / fail / pending のどれかにする。チェックが 1 つも無ければ null */
export function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pending = false;
  for (const c of rollup) {
    const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
    const status = String(c?.status || '').toUpperCase();
    if (FAILED.has(verdict)) return 'fail';
    if ((status && status !== 'COMPLETED') || PENDING.has(verdict) || (!verdict && !status)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

/** gh pr view --json title,state,isDraft,statusCheckRollup の出力から、画面に渡す部分だけを取り出す。読めなければ null */
export function normalizeView(json) {
  let v;
  try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const raw = String(v.state ?? '').toUpperCase();
  const state = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : raw === 'OPEN' ? (v.isDraft ? 'draft' : 'open') : null;
  if (!state) return null;
  const title = typeof v.title === 'string' ? v.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { title, state, checks: checksOf(v.statusCheckRollup) };
}

/** gh の失敗を、画面に出す理由に分ける。gh が無い → no-gh、ログインしていない → no-auth、それ以外（通信・権限・消えた PR など）→ null */
export function reasonOf(error) {
  if (error?.code === 'ENOENT') return 'no-gh';
  const text = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
  if (/gh auth login|not logged in|authentication|GH_TOKEN|GITHUB_TOKEN|HTTP 401|requires authentication|Bad credentials/i.test(text)) return 'no-auth';
  return null;
}

/** 既定の gh の呼び出し。stdout を返し、失敗は error（code・stderr 付き）で投げる */
export function runGh(args, { env = process.env } = {}) {
  const custom = env.AGENT_HOST_GH;
  const script = custom && /\.m?js$/i.test(custom);
  const file = script ? process.execPath : (custom || 'gh');
  return new Promise((resolve, reject) => {
    execFile(file, script ? [custom, ...args] : args, {
      timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8',
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '' },
    }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(String(stdout))));
  });
}

/** 一覧の PR の基本の形（番号・URL・repo。gh を呼ばない） */
export const basicPr = (p) => {
  const parsed = parsePrUrl(p.url);
  return { number: p.number, url: p.url, repo: parsed?.repo ?? null, ...(p.child ? { child: true } : {}) };
};

/**
 * PR の状態の読み手。run は gh の呼び出し（args → stdout の文字列）で、試験では差し替える。
 * read(list) は list（{ number, url, child? } の新しい順の配列）に、状態を足した配列と reason を返す。
 */
export function createPrReader({ run = runGh, now = Date.now, ttl = PR_TTL_MS } = {}) {
  const cache = new Map(); // url → { at, value: { view, reason } | Promise }
  const one = async (url) => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = (async () => {
      try {
        const view = normalizeView(await run(['pr', 'view', url, '--json', 'title,state,isDraft,statusCheckRollup']));
        return { view, reason: null };
      } catch (error) { return { view: null, reason: reasonOf(error) }; }
    })();
    cache.set(url, { at: now(), value });
    if (cache.size > CACHE_MAX) for (const k of cache.keys()) { if (cache.size <= CACHE_MAX / 2) break; cache.delete(k); }
    return value;
  };
  return {
    async read(list) {
      const picked = (list ?? []).slice(0, PR_READ_MAX);
      const out = picked.map(basicPr);
      let reason = null;
      let next = 0;
      const worker = async () => {
        while (next < picked.length) {
          const i = next++;
          const got = await one(picked[i].url);
          if (got.view) Object.assign(out[i], got.view.title ? { title: got.view.title } : {}, { state: got.view.state }, got.view.checks ? { checks: got.view.checks } : {});
          else if (got.reason && !reason) reason = got.reason;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PR_PARALLEL, picked.length) }, worker));
      // 1 件も状態が取れなかったときだけ理由を返す（一部の PR だけ取れないのは、消えた PR・権限などで gh の不備ではない）
      return { prs: out, reason: out.some((p) => p.state) ? null : reason };
    },
    /** 覚えている結果を捨てる（試験用） */
    clear: () => cache.clear(),
  };
}
