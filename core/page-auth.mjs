// Pleiad のページ（/_pleiad/…）の 2 つの入口の認証（ADR 0295 の 2）。純粋な関数だけ。
//   - ファイルのページの port（localhost:<pages port>）: ページの Cookie（pleiad_pages）。値は HMAC(本体のトークン, "pleiad-pages") で、本体のトークンそのものは Chrome に入れない
//   - 本体の port の /_pleiad/（画面の iframe）: 本体の Cookie（agent_host_token）だけ。?token= は受けない（iframe の URL にトークンを載せない）
// どちらの入口も、core/pages-routes.mjs へ渡す前にここで通す（A2・A4 は入口を触らない）。
// どちらの入口も Sec-Fetch-Site が same-origin か none（アドレスバー・CDP の移動）のときだけ通す。Chrome は localhost の port 違いを
// same-site と数え、SameSite=Strict の Cookie も送る。隔離の origin や手元のほかのサーバー（localhost:5173 など）からの要求を、ここで断る。
import crypto from 'node:crypto';

export const PAGES_PATH = '/_pleiad/';
export const PAGES_COOKIE = 'pleiad_pages';
export const MAIN_COOKIE = 'agent_host_token';
const PAGES_LABEL = 'pleiad-pages';

/** ページの Cookie の値。本体のトークンが同じなら同じ値（再起動をまたいでも、トークンを変えるまで変わらない） */
export function pagesSecret(token) {
  return crypto.createHmac('sha256', String(token)).update(PAGES_LABEL).digest('hex');
}

/**
 * Chrome に置くページの Cookie（A2 が Storage.setCookies で置く。url か domain は置く側が足す）。
 * Path を /_pleiad/ に絞り、JS から読めず、ほかのサイトからは送られない
 */
export function pagesCookie(token) {
  return { name: PAGES_COOKIE, value: pagesSecret(token), path: PAGES_PATH, httpOnly: true, sameSite: 'Strict' };
}

/** Cookie の見出しから、名前の合う値を全部（Path の違う同じ名前が並ぶことがある）。壊れた % は捨てる */
export function readCookies(header, name) {
  const values = [];
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try { values.push(decodeURIComponent(part.slice(at + 1).trim())); } catch {}
  }
  return values;
}

/** 長さと中身を、時間で漏らさずに比べる */
export function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ファイルのページの port の入口: ページの Cookie のどれかが合えば通す */
export function pagesCookieOk(cookieHeader, token) {
  if (!token) return false;
  const expected = pagesSecret(token);
  return readCookies(cookieHeader, PAGES_COOKIE).some(value => sameSecret(value, expected));
}

/** 本体の port の /_pleiad/ の入口: 本体の Cookie のどれかが本体のトークンと合えば通す */
export function mainCookieOk(cookieHeader, token, name = MAIN_COOKIE) {
  if (!token) return false;
  return readCookies(cookieHeader, name).some(value => sameSecret(value, String(token)));
}

/**
 * 要求の出どころ（Sec-Fetch-Site）が Pleiad のページ自身かアドレスバーか。same-site・cross-site は断る。
 * 見出しが無いもの（ブラウザーでない取得。Chrome は localhost へはいつも付ける）は通す
 */
export function fetchSiteOk(site) {
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * 入口ごとの検査。via は 'pages'（ファイルのページの port）か 'main'（本体の port）。ほかは通さない
 * @param {{ via: 'pages'|'main', cookie?: string, token: string, site?: string }} request site は Sec-Fetch-Site の値
 */
export function pageRequestOk({ via, cookie, token, site }) {
  if (!fetchSiteOk(site)) return false;
  if (via === 'pages') return pagesCookieOk(cookie, token);
  if (via === 'main') return mainCookieOk(cookie, token);
  return false;
}
