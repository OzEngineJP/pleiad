// HTML のファイルを隔離の origin で読ませる鍵（ADR 0295 の 3 の 1）。ファイルのページの api/html-key（core/pages-routes.mjs）と
// pageOpen（core/browser-unify-ws.mjs）が出し、隔離の /f/<鍵>/…（core/isolated-routes.mjs）が引く。
// 鍵は { 会話・フォルダー・入口・一度だけの出どころ・発行時刻 } を AES-256-GCM で閉じた自己完結の文。
// 秘密は page-secrets.json（core/isolated-origins.mjs の loadPageSecrets）にだけあり、鍵の中身は外から読めない・作れない。
// サーバーの入れ替えをまたいでも引けるので、残ったタブの URL は新しい port に付け替えるだけで読める（24 時間の期限は文の中）。
// ファイルの検査の範囲（access）は鍵に持たず、引くたびにその会話の今の範囲で確かめ直す（許可を下げたらすぐ効く）。
// 「一度だけ読み込む」は、その一度の許可（https の出どころ）を載せた別の鍵で読み直す（ADR 0295 の 3 の 3）。
import crypto from 'node:crypto';
import path from 'node:path';
import { externalOrigin } from './preview-policy.mjs';

export const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 1000;
const MAX_ONCE = 50;
// 同じファイルにもう一度出すとき、残りがこれより短ければ新しい鍵にする（開いている途中で切れないように）
const REUSE_MIN_MS = 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_-]{40,8192}$/;
const VERSION = 1;

/**
 * @param {object} [deps]
 * @param [deps.secret] 鍵を閉じる秘密（Buffer 32 バイト。core/isolated-origins.mjs の loadPageSecrets の key）。
 *                      無ければこのプロセスの中だけで効く乱数を使う（サーバーの入れ替えをまたぐと鍵は引けない。試験用）
 * @param [deps.now]    時計（試験が差し替える）
 * @param [deps.log]    ログの 1 行（パスを書かない）
 * @param [deps.ttlMs]  鍵の寿命（既定は 24 時間）
 * @returns
 *   - issue({ sessionId, path, once?, access? }): 鍵（文字列）か null。path は ADR 0050 の検査を通した後の HTML のファイルの実体のパス。
 *     once は「一度だけ読み込む」で足す https の出どころ。access は今の呼び口との互換のためだけ（鍵には持たず、引くときに会話の範囲を引き直す）
 *   - resolve(key): { sessionId, root（鍵で読めるフォルダー）, entry（HTML のファイルの相対パス）, once, access: null } か null
 *   - close(): 使い回しの控えを捨てる（鍵そのものは秘密が同じ限り引ける）
 */
export function createHtmlKeys({ secret = null, now = Date.now, log = () => {}, ttlMs = KEY_TTL_MS, max = MAX_KEYS } = {}) {
  const key = Buffer.isBuffer(secret) && secret.length === 32 ? secret : crypto.randomBytes(32);
  const issued = new Map();   // ペイロードの要約 -> { key, until }（同じファイルには同じ鍵を返す。プロセスの中だけ）
  const seal = value => {
    const iv = crypto.randomBytes(12);
    const box = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([box.update(JSON.stringify(value), 'utf8'), box.final()]);
    return Buffer.concat([iv, box.getAuthTag(), body]).toString('base64url');
  };
  const open = value => {
    try {
      const packed = Buffer.from(value, 'base64url');
      if (packed.length < 12 + 16 + 10) return null;
      const box = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
      box.setAuthTag(packed.subarray(12, 28));
      const data = JSON.parse(Buffer.concat([box.update(packed.subarray(28)), box.final()]).toString('utf8'));
      return data && data.v === VERSION ? data : null;
    } catch { return null; }
  };
  const prune = () => {
    const at = now();
    for (const [digest, held] of issued) if (held.until <= at) issued.delete(digest);
  };
  return {
    issue({ sessionId = null, path: file, once = [], access = null } = {}) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.html?$/i.test(file)) return null;
      if (sessionId !== null && typeof sessionId !== 'string') return null;
      const payload = { v: VERSION, sid: sessionId, root: path.dirname(file), entry: path.basename(file), iat: now(),
        once: [...new Set((Array.isArray(once) ? once : []).slice(0, MAX_ONCE).map(externalOrigin).filter(Boolean))] };
      prune();
      const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
      const held = issued.get(digest);
      if (held && !payload.once.length && held.until - now() >= REUSE_MIN_MS) return held.key;
      while (issued.size >= max) issued.delete(issued.keys().next().value);
      const sealed = seal(payload);
      issued.set(digest, { key: sealed, until: payload.iat + ttlMs });
      log(`html-keys: issued (${issued.size} held${payload.once.length ? `, once ${payload.once.length}` : ''})`);
      return sealed;
    },
    resolve(value) {
      if (typeof value !== 'string' || !KEY.test(value)) return null;
      const data = open(value);
      if (!data || typeof data.iat !== 'number' || data.iat + ttlMs <= now() || data.iat > now() + 5 * 60 * 1000) return null;
      if (typeof data.root !== 'string' || !path.isAbsolute(data.root) || typeof data.entry !== 'string' || !/\.html?$/i.test(data.entry)) return null;
      if (data.sid !== null && typeof data.sid !== 'string') return null;
      const once = (Array.isArray(data.once) ? data.once : []).slice(0, MAX_ONCE).map(externalOrigin).filter(Boolean);
      return { sessionId: data.sid ?? null, root: data.root, entry: data.entry, once, access: null };
    },
    close() { issued.clear(); },
  };
}
