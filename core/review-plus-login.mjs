// 審査用ホスト（AGENT_HOST_REVIEW=1。ADR 0172・0339）の Plus ログイン。
// 審査員は Plus に「メールでログイン」し、一覧に出た審査用ホストへペアリングなしで入る。そのため審査用ホストは、
// 環境変数のメールアドレスとパスワード（AGENT_HOST_REVIEW_PLUS_EMAIL / AGENT_HOST_REVIEW_PLUS_PASSWORD）で、審査用アカウントとして Plus に入っておく。
//   - 入れていなければ入る。ログアウト・失効（Firebase が更新を拒んだ）のときも入り直す。失敗は間をあけて取り直す
//   - 再起動しても保管（plus-secrets.json）の refresh token で入ったまま。保管が別のメールのものなら入り直す
//   - 審査用アカウントの uid は uid() で返す（その端末だけを自動承認するため）。入っていなければ null
// 秘密（パスワード・トークン）は、ログにも出さない。
import { isReviewMode } from './review-mode.mjs';

export const REVIEW_PLUS_EMAIL = 'AGENT_HOST_REVIEW_PLUS_EMAIL';
export const REVIEW_PLUS_PASSWORD = 'AGENT_HOST_REVIEW_PLUS_PASSWORD';

/** 設定された審査用アカウント。審査モードでない・どちらかが欠けていれば null */
export function reviewPlusCredentials(env = process.env) {
  if (!isReviewMode(env)) return null;
  const email = String(env[REVIEW_PLUS_EMAIL] ?? '').trim();
  const password = String(env[REVIEW_PLUS_PASSWORD] ?? '');
  return email && password ? { email, password } : null;
}

/**
 * @param {object} o
 * @param {object} o.session createPlusSession の戻り値（snapshot・loginWithPassword・logout・onChange）
 * @param {object} [o.env]
 * @param {(line: string) => void} [o.log]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {{ minMs: number, maxMs: number }} [o.backoff]
 * @returns {{ uid: () => (string|null), ensure: () => Promise<void>, stop: () => void } | null} 対象でなければ null
 */
export function startReviewPlusLogin({ session, env = process.env, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms).unref?.()),
  backoff = { minMs: 5_000, maxMs: 5 * 60_000 } } = {}) {
  const cred = reviewPlusCredentials(env);
  if (!cred) return null;
  const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  const uid = () => {
    const s = session.snapshot();
    return s.signedIn && s.uid && same(s.email, cred.email) ? s.uid : null;
  };
  let stopped = false, running = null, delay = backoff.minMs;

  async function loop() {
    while (!stopped) {
      if (uid()) return;
      try {
        // 別のメールの保管が残っていたら消してから入る
        if (session.snapshot().signedIn) await session.logout();
        await session.loginWithPassword(cred);
        delay = backoff.minMs;
        log('review plus: signed in');
        return;
      } catch (e) {
        log(`review plus: sign-in failed (${String(e?.code ?? 'error')}: ${String(e?.message ?? e).slice(0, 80)}); retry in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        delay = Math.min(delay * 2, backoff.maxMs);
      }
    }
  }
  const ensure = () => { running ??= loop().finally(() => { running = null; }); return running; };
  // ログアウト・失効のあとも入り直す
  const off = session.onChange(({ type }) => { if (type === 'signedOut' && !stopped) void ensure(); });
  return { uid, ensure, stop() { stopped = true; off?.(); } };
}
