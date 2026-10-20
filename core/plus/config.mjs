// Pleiad Plus の設定（`GET <api>/v1/auth/config`。認証なし）。
// ログインの基盤の値（projectId・apiKey）や各 URL はアプリに焼き込まず、実行時にここから読む。
// 読めた値は <dataDir>/plus-config.json に写しを置き、起動直後や api に届かないときはその写しを使う。
// 読み取りは 5 分だけ覚え、同時の呼び出しは 1 本にまとめる（single-flight）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';

export const DEFAULT_API = 'https://api.pleiad.dev';
export const DEFAULT_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
export const CONFIG_TTL_MS = 5 * 60_000;
const COPY_FILE = 'plus-config.json';
const FETCH_TIMEOUT_MS = 10_000;

/** api の基点の URL を整える。https のほか、試験用にループバックの http だけを受ける。ほかは警告して既定に戻す */
export function normalizeApiBase(raw, { log = () => {} } = {}) {
  const fallback = () => {
    // i18n-ignore: 起動ログの警告は画面に出ない。環境変数名を確実に残すため文を固定する
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') log(`plus: AGENT_HOST_PLUS_API ${JSON.stringify(String(raw).slice(0, 120))} は使えない（https かループバックの http だけ）。既定に戻す`);
    return DEFAULT_API;
  };
  try {
    const url = new URL(String(raw ?? '').trim() || DEFAULT_API);
    if (url.protocol === 'https:') return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin;
    return fallback();
  } catch { return fallback(); }
}

/** 版の比較 x.y.z（同じ形でないもの同士は等しくない扱い。比べられなければ null） */
export function compareVersions(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(String(a ?? '').trim());
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(String(b ?? '').trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 応答のうちクライアントが使う欄だけを拾う（ほかの欄は読まない） */
export function parseAuthConfig(body) {
  if (!body || typeof body !== 'object') return null;
  const state = ['on', 'maintenance', 'off'].includes(body.state) ? body.state : 'off';
  const urls = body.urls && typeof body.urls === 'object' ? body.urls : {};
  return {
    state,
    token: {
      projectId: typeof body.token?.projectId === 'string' ? body.token.projectId : '',
      apiKey: typeof body.token?.apiKey === 'string' ? body.token.apiKey : '',
    },
    urls: Object.fromEntries(['login', 'account', 'profile', 'relay', 'refresh'].map(k => [k, typeof urls[k] === 'string' ? urls[k] : null])),
    minClient: body.minClient && typeof body.minClient === 'object' ? { ...body.minClient } : {},
  };
}

/**
 * @param {object} o
 * @param {object} [o.env] 環境変数（AGENT_HOST_PLUS_API・AGENT_HOST_PLUS_JWKS_URL・AGENT_HOST_PLUS=0 で全部隠す）
 * @param {string} o.dataDir 写し（plus-config.json）の置き場
 * @param {string} o.appVersion このアプリの版（minClient との比較用）
 * @param {string} [o.platform] minClient の自分の欄（既定 desktop）
 * @param {Function} [o.fetchFn]
 * @param {Function} [o.now]
 * @param {Function} [o.log] 警告の行
 */
export function createPlusConfig({ env = process.env, dataDir, appVersion = '0.0.0', platform = 'desktop', fetchFn = fetch, now = Date.now, log = () => {} } = {}) {
  const apiBase = normalizeApiBase(env?.AGENT_HOST_PLUS_API, { log });
  const jwksUrl = env?.AGENT_HOST_PLUS_JWKS_URL || DEFAULT_JWKS_URL;
  const enabled = String(env?.AGENT_HOST_PLUS ?? '') !== '0';
  const copyFile = dataDir ? path.join(dataDir, COPY_FILE) : null;
  let memory = null;          // { config, at }
  let reading = null;         // single-flight

  async function readCopy() {
    if (!copyFile) return null;
    try { return parseAuthConfig(JSON.parse(await fs.readFile(copyFile, 'utf8'))); } catch { return null; }
  }
  async function writeCopy(config) {
    if (!copyFile) return;
    await writeAtomic(copyFile, JSON.stringify(config, null, 2) + '\n').catch(() => {});
  }

  async function fetchConfig() {
    const res = await fetchFn(`${apiBase}/v1/auth/config`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const config = parseAuthConfig(await res.json().catch(() => null));
    if (!config) throw new Error('bad config');
    memory = { config, at: now() };
    await writeCopy(config);
    return config;
  }

  /** 今の設定。5 分以内の覚えがあればそれ、無ければ読み直す。読めなければ写し（記憶→ファイル）、それも無ければ null */
  async function get({ fresh = false } = {}) {
    if (!fresh && memory && now() - memory.at < CONFIG_TTL_MS) return memory.config;
    reading ??= fetchConfig().catch(async () => memory?.config ?? await readCopy()).finally(() => { reading = null; });
    return reading;
  }

  return {
    apiBase,
    jwksUrl,
    enabled,
    get,
    /** 最後に知った値（メモリ→ファイルの順。読みには行かない） */
    async known() { return memory?.config ?? await readCopy(); },
    /** 状態の表示に使う導出値 */
    derive(config) {
      return {
        state: config?.state ?? null,
        // off か AGENT_HOST_PLUS=0 なら入口ごと出さない
        available: enabled && config?.state !== 'off',
        needsUpdate: compareVersions(appVersion, config?.minClient?.[platform]) === -1,
      };
    },
  };
}
