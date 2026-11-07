// 隔離の origin のアプリごとの専用の出どころ（<印>.localhost:<port>。ADR 0295 の 3）。
//   - ブラウザーは <名前>.localhost をいつもループバックへ解決する（公開の DNS では作れず、付け替えもできない）。
//     印ごとに別の origin になるので、アプリ同士は localStorage・IndexedDB・Cookie を分けられる
//   - 印はアプリごとに決まり、サーバーの入れ替えをまたいでも同じ（そのアプリの保存が残る）。
//     可視化は束のハッシュから（束の中身が同じなら同じ印）、HTML のファイルはフォルダーの HMAC から（パスを出さない）
//   - Host の見出しが localhost:<port> か <印>.localhost:<port> のときだけ隔離のリスナーは答える（page-listener.mjs の hostCheck）
// 中身の読み出しは今までどおり URL の鍵（/viz/<ハッシュ>/・/f/<鍵>/）が守る。印は出どころを分けるためのもので、検査は変えない
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';

export const PAGE_SECRETS_FILE = 'page-secrets.json';
export const LOCALHOST_MARK = /^[a-z0-9][a-z0-9-]{0,61}\.localhost$/;

/**
 * 印を作る元の秘密（page-secrets.json。32 バイトを 1 つ）。無ければ作る。
 * HTML のファイルの印の HMAC の元で、鍵の暗号化（core/html-keys.mjs）にも使う
 */
export async function loadPageSecrets(dataDir, { log = () => {} } = {}) {
  const file = path.join(dataDir, PAGE_SECRETS_FILE);
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const key = Buffer.from(String(saved?.key ?? ''), 'base64');
    if (key.length === 32) return { key };
  } catch { /* 無い・壊れているものは作り直す */ }
  const key = crypto.randomBytes(32);
  await writeAtomic(file, `${JSON.stringify({ key: key.toString('base64') })}\n`, { mode: 0o600 })
    .catch(error => log(`page-secrets: could not write the secrets file: ${String(error?.message ?? error)}`));
  return { key };
}

/** 可視化の印。束のハッシュの先頭から（中身が同じなら同じ印。ハッシュは URL の中の秘密なので隠すものではない） */
export function vizMark(hash) {
  return `v${String(hash ?? '').toLowerCase().slice(0, 24)}`;
}

/** 印の元にするフォルダーの形。Windows の大小文字と区切りの違いを揃える */
export function normalizeRoot(root) {
  const value = path.resolve(String(root ?? '')).replaceAll('\\', '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** HTML のファイルの印。鍵のフォルダー（＝アプリ）ごとに決まり、フォルダーのパスは出さない（HMAC） */
export function fileMark(secret, root) {
  const mac = crypto.createHmac('sha256', Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret ?? '')));
  return `f${mac.update(`file-root:${normalizeRoot(root)}`).digest('hex').slice(0, 16)}`;
}

/** Host の見出しが localhost:<port> か <印>.localhost:<port> か（大小文字は見ない。ページの port は localhost だけ）。port は 10 進の数字だけ（0x・空白・+・.0・e0 は通さない） */
export function isolatedHostOk(header, port) {
  if (typeof header !== 'string') return false;
  const match = /^(.+):(\d{1,5})$/.exec(header.toLowerCase());
  return !!match && match[2] === String(port) && (match[1] === 'localhost' || LOCALHOST_MARK.test(match[1]));
}

/** アプリの出どころと URL */
export const appOrigin = (mark, port) => `http://${mark}.localhost:${port}`;

/**
 * port が替わったあとの開いているタブ・枠の URL の付け替え（再起動・取り違え・衝突のあと）。
 * @param {object} options
 * @param {{ pages?: number|number[], isolated?: number|number[] }} options.from 前の port（起動ごとに違いうるので列でも受ける）
 * @param {{ pages?: number, isolated?: number }} options.to   今の port
 * @param options.secret   page-secrets の key（HTML のファイルの印の元）
 * @param options.htmlKeys HTML のファイルの鍵（/f/<鍵>/ のフォルダーを引く。期限切れの鍵は null → 付け替えない）
 * @returns 付け替えた URL（http://…）。Pleiad の port でない・付け替えられないものは null
 */
export function movedPageUrl(value, { from, to, secret, htmlKeys } = {}) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || url.username || url.password) return null;
  const port = Number(url.port || 80);
  const local = url.hostname === 'localhost' || LOCALHOST_MARK.test(url.hostname.toLowerCase());
  if (!local) return null;
  const wasPages = [from?.pages].flat().includes(port), wasIsolated = [from?.isolated].flat().includes(port);
  if (wasPages && Number.isInteger(to?.pages) && url.hostname === 'localhost') {
    url.port = String(to.pages);
    return url.href;
  }
  if (!(wasIsolated && Number.isInteger(to?.isolated))) return null;
  const parts = url.pathname.split('/');
  if (parts[1] === 'viz' && parts[2]) {
    url.hostname = `${vizMark(parts[2])}.localhost`;
    url.port = String(to.isolated);
    return url.href;
  }
  if (parts[1] === 'f' && parts[2]) {
    const held = htmlKeys?.resolve?.(parts[2]);
    if (!held) return null;   // 期限切れ・作り直す元が分からない鍵は付け替えられない
    url.hostname = `${fileMark(secret, held.root)}.localhost`;
    url.port = String(to.isolated);
    return url.href;
  }
  return null;
}
