// HTML のファイルを隔離の origin で読ませる鍵（ADR 0295 の 3 の 1）。ファイルのページの api/html-key（core/pages-routes.mjs）が出し、
// 隔離の /f/<鍵>/…（core/isolated-routes.mjs）が引く。サーバーが 1 つだけ作り、両方へ同じものを渡す（core/server.mjs）。
// 鍵は 128 ビットの乱数で、HTML のファイルのフォルダーに結ぶ（鍵で読めるのはそのフォルダーの下だけ）。
// サーバーの中のメモリだけに持ち、24 時間かサーバーの終わり（close）で消える。
// 「一度だけ読み込む」は、その一度の許可（https の出どころ）を載せた別の鍵で読み直す（ADR 0295 の 3 の 3）。
import crypto from 'node:crypto';
import path from 'node:path';
import { externalOrigin } from './preview-policy.mjs';

export const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 1000;
// 同じファイルにもう一度出すとき、残りがこれより短ければ新しい鍵にする（開いている途中で切れないように）
const REUSE_MIN_MS = 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_-]{22}$/;

/**
 * @param {object} [deps]
 * @param [deps.now] 時計（試験が差し替える）
 * @param [deps.log] ログの 1 行（パスを書かない）
 * @param [deps.ttlMs] 鍵の寿命（既定は 24 時間）
 * @returns
 *   - issue({ sessionId, path, once?, access? }): 鍵（文字列）か null。path は ADR 0050 の検査を通した後の HTML のファイルの実体のパス。
 *     once は「一度だけ読み込む」で足す https の出どころ。access はファイルの検査の範囲（core/server.mjs の fileAccessFor の値。無ければ隔離の側で決める）
 *   - resolve(key): { sessionId, root（鍵で読めるフォルダー）, entry（HTML のファイルの相対パス）, once, access } か null
 *   - close(): 全部捨てる
 */
export function createHtmlKeys({ now = Date.now, log = () => {}, ttlMs = KEY_TTL_MS, max = MAX_KEYS } = {}) {
  const keys = new Map();   // key -> { sessionId, root, entry, once, access, until }
  const prune = () => {
    const at = now();
    for (const [key, entry] of keys) if (entry.until <= at) keys.delete(key);
  };
  return {
    issue({ sessionId = null, path: file, once = [], access = null } = {}) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.html?$/i.test(file)) return null;
      if (sessionId !== null && typeof sessionId !== 'string') return null;
      const root = path.dirname(file), entry = path.basename(file);
      const origins = [...new Set((Array.isArray(once) ? once : []).slice(0, 500).map(externalOrigin).filter(Boolean))];
      prune();
      if (!origins.length) {
        for (const [key, held] of keys) {
          if (held.sessionId === sessionId && held.root === root && held.entry === entry && !held.once.length && held.access === access && held.until - now() >= REUSE_MIN_MS) return key;
        }
      }
      while (keys.size >= max) keys.delete(keys.keys().next().value);
      const key = crypto.randomBytes(16).toString('base64url');
      keys.set(key, { sessionId, root, entry, once: origins, access, until: now() + ttlMs });
      log(`html-keys: issued (${keys.size} held${origins.length ? `, once ${origins.length}` : ''})`);
      return key;
    },
    resolve(key) {
      if (typeof key !== 'string' || !KEY.test(key)) return null;
      const held = keys.get(key);
      if (!held) return null;
      if (held.until <= now()) { keys.delete(key); return null; }
      return { sessionId: held.sessionId, root: held.root, entry: held.entry, once: [...held.once], access: held.access };
    },
    close() { keys.clear(); },
  };
}
