// SDK は使うときに読む（配布物は SDK を持たない。取っていなければ、取得を促す文で失敗する。core/claude-sdk.mjs）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadClaudeSdk } from '../claude-sdk.mjs';
import { claudeExecutable } from '../cli-installation.mjs';
import { claudeQuota, LOGIN_ACCOUNT, quotaFailure } from '../usage.mjs';
// 人が自分で env に置いた長期トークン（ログイン中のアカウントの会話はこれで動く）。登録したアカウントの使用量では外す
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
import { claudeLoginPresent, macKeychainAuthFailure } from '../claude-own-dir.mjs';
import { isClaudeAuthError } from './claude-normalize.mjs';
import { t } from '../i18n.mjs';

/**
 * 使用量を読むプロセスの env。
 *   configDir あり … 登録したアカウントの使用量。そのアカウント専用の設定フォルダ（`claude auth login` 済み）を
 *                    CLAUDE_CONFIG_DIR にし、env の長期トークン（CLAUDE_CODE_OAUTH_TOKEN）は外す（会話と同じログインで読む。ADR 0353）。
 *   無し          … ログイン中のアカウント（今までどおり）
 */
export function usageEnv(base = process.env, { configDir } = {}) {
  const env = { ...base, CLAUDECODE: undefined };
  if (!configDir) return env;
  for (const key of Object.keys(env)) if ([TOKEN_ENV, 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// A control-only query: no prompt is yielded and no inference request is made.
// Keep stdin open until get_usage completes, then close the owned process.
// 同じ設定フォルダの更新の直列化は CLI の .oauth_refresh.lock に任せる（ADR 0350。Pleiad 側の順番の口は持たない）
export const readClaudeUsage = (options = {}) => readClaudeUsageNow(options);

async function readClaudeUsageNow({ configDir } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { query } = await loadClaudeSdk();
  const q = query({ prompt: (async function* () { await gate; })(), options: {
    pathToClaudeCodeExecutable: claudeExecutable(), persistSession: false,
    settingSources: ['user'], tools: [], mcpServers: {}, settings: { disableAllHooks: true },
    env: usageEnv(process.env, { configDir }),
  } });
  let timer, result;
  try {
    result = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(t('claude.usage.timeout')), { reason: 'timeout' })), 20_000); }),
    ]);
  } finally { clearTimeout(timer); release(); q.close(); }
  return claudeUsageQuota(result, { configDir });
}

const filled = value => typeof value === 'string' && value.length > 0;
/**
 * ログイン情報のファイル（<設定フォルダ>/.credentials.json）にトークンが無いか。
 * トークンの値は比べも返しもせず、項目（claudeAiOauth）があるか・アクセス用のトークンが空でないかだけを見る。
 *   configDir あり … 登録したアカウントの使用量の設定フォルダ。無し … ログイン中のアカウント（CLAUDE_CONFIG_DIR、無ければ ~/.claude）
 * API キー（やログイン中のアカウントの会話用のトークン）が env にあれば、CLI はそちらで動くのでファイルは手がかりにならない（false）。
 * macOS の CLI はキーチェーンに置く。登録したアカウント（configDir あり）は、claudeLoginPresent で項目の有無だけを見る（中身は読まない。ADR 0351）。
 *   ログイン中のアカウントは今までどおり手がかりにしない。
 * ログイン中のアカウントは API の接続でもファイルが無いので、ファイルが無いことは手がかりにしない（登録したアカウントは Pleiad がログインさせた設定フォルダ）
 */
export async function credentialsMissing({ configDir, env = process.env, home = os.homedir(), platform = process.platform, readFile = fs.readFile,
  present = claudeLoginPresent } = {}) {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...(configDir ? [] : [TOKEN_ENV])];
  if (keys.some(key => filled(env[key]))) return false;
  if (platform === 'darwin') return Boolean(configDir) && await present(configDir, { platform }) === 'missing';
  const dir = configDir || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  let text;
  try { text = await readFile(path.join(dir, '.credentials.json'), 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' && Boolean(configDir); }
  let oauth;
  try { oauth = JSON.parse(text)?.claudeAiOauth; } catch { return false; }
  if (!oauth || typeof oauth !== 'object') return true;
  return !filled(oauth.accessToken);
}

/**
 * CLI の使用量の応答を枠にする。トークンが無いと CLI は使用量の口を呼ばず、制限の情報もプランも無い応答を返す
 * （rate_limits_available: false・subscription_type: null）。そのときログイン情報のファイルにトークンが無ければ、
 * 汎用の「取得できません」ではなく再ログインを促す（reason: 'no-login'）。ログイン中のアカウントはターミナルの `claude auth login`、
 * 登録したアカウントは「認可をやり直す」（readClaudeAccountsUsage が reauth を付ける）
 */
export async function claudeUsageQuota(result, { configDir, missing = credentialsMissing } = {}) {
  const quota = claudeQuota(result);
  if (quota.windows.length || quota.plan) return quota;
  if (!(await Promise.resolve().then(() => missing({ configDir })).catch(() => false))) return quota;
  return { ...quota, reason: 'no-login', message: configDir ? t('claude.usage.reauthNeeded') : t('claude.usage.relogin') };
}

const errorText = error => String(error?.message ?? error).replace(/sk-ant-[A-Za-z0-9_-]+/g, t('claude.redacted.token'));

// 更新用トークンの取り合い。ログインは切れていない（再試行で通る）。
// claude.exe（@anthropic-ai/claude-agent-sdk-win32-x64、SDK 0.3.288）:
//   "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient"
//   "OAuth access token could not be refreshed: another Claude Code process is holding the refresh lock"
//   "OAuthRefreshLockTimeoutError" / "OAuthRefreshLockContendedError"
const USAGE_REFRESH_CONTENTION = /another Claude Code process is (?:refreshing|holding the refresh lock)|OAuthRefreshLock(?:Timeout|Contended)Error/i;

// 認証が無い・更新できない、と CLI / SDK が返す文言だけ。429 や時間切れは含めない。
//   - isClaudeAuthError（ADR 0212）: sdk.mjs は失敗を "Claude Code returned an error result: …" で包む。
//     sdk.d.ts の SDKAssistantMessageError に authentication_failed。
//     観測した文は "Failed to authenticate. API Error: 401 OAuth access token has expired."
//   - claude.exe の文言: authentication_error（401 の error.type）、
//     "Token refresh failed with invalid_grant" / oauth_refresh_invalid_grant、
//     "OAuth token revoked" / "OAuth access token has been revoked" / "OAuth token has been revoked"、
//     "OAuth session expired and could not be refreshed"、"OAuth refresh token is no longer valid"、
//     "OAuth access token is invalid"、"Not logged in. Run claude auth login"、
//     "Please run /login"（"Your session has expired. Please run /login to sign in again." など）
const USAGE_AUTH_TEXT = /authentication_error|oauth_refresh_invalid_grant|\binvalid_grant\b|token has been revoked|oauth token revoked|oauth session expired and could not be refreshed|refresh token is no longer valid|oauth access token is invalid|not logged in\. run claude auth login|please run \/login/i;

/**
 * 使用量の読み取りの例外が、認証が無い・更新できないときか。
 * 429・時間切れ・更新の取り合いは false（ログイン切れの印を付けない）。
 * status が 401、error.type が authentication_error / authentication_failed、code が invalid_grant、reason が no-login も真。
 */
export function claudeUsageAuthFailure(error) {
  if (error?.reason === 'no-login') return true;
  if (error?.reason === 'rate-limited' || error?.reason === 'timeout') return false;
  const text = String(error?.message ?? error ?? '');
  if (USAGE_REFRESH_CONTENTION.test(text)) return false;
  const status = error?.status ?? error?.statusCode ?? error?.api_error_status;
  if (status != null && Number(status) === 429) return false;
  if (status != null && Number(status) === 401) return true;
  const kind = error?.error?.type ?? (typeof error?.error === 'string' ? error.error : null);
  if (kind === 'authentication_error' || kind === 'authentication_failed' || kind === 'invalid_grant' || error?.code === 'invalid_grant') return true;
  if (/\b429\b|rate[ _-]?limit/i.test(text) || /\btime[ds]?[ _-]?out\b/i.test(text)) return false;
  // isClaudeAuthError の "failed to authenticate" は 401 の文（"Failed to authenticate. API Error: 401 …"）用。
  // claude.exe にある別系統（broker・registry）は claude.ai のログイン切れではない
  if (/failed to authenticate through the broker|failed to authenticate with registry/i.test(text)) return false;
  return isClaudeAuthError(text) || USAGE_AUTH_TEXT.test(text);
}

/** CLI の認証失敗で、ログイン切れの表示を付ける行か */
export function shouldMarkUsageExpired(row) {
  return row?.cliAuthFailed === true;
}

/** 使用量の認可を促す文。言語が実行中に変わるので呼ぶたびに引く */
export const needsUsageLogin = () => t('claude.usage.needsLogin');
/** 互換（tests/unit/claude-login.mjs が比べる）。読み込み時の言語で固まるので、本体は needsUsageLogin() を使う */
export const NEEDS_USAGE_LOGIN = needsUsageLogin();

/**
 * 登録したアカウントがあるときの使用量。どのアカウントの値かが分かるよう、アカウントごとに見出しを付けて並べる
 * （web/usage.mjs の quota.accounts）。登録が無ければ今までどおりログイン中のアカウントの値だけを返す。
 *
 * accounts: [{ id, name, configDir, usageLogin }]（core/claude-accounts.mjs の usageTargets）。
 * 使用量の認可が済んでいないアカウントは読みに行かず、認可を促す（needsUsageLogin）。
 * 1 件が取れなくても他は出す。読めなかった行には理由（reason）を付ける。エラーメッセージからはトークンを伏せる。
 * skip は読む間隔を延ばしている行（ログイン中は 'login'、ほかはアカウントの id。core/usage.mjs の createQuotaStore）。
 * 読まずに { skipped: true } の行を返し、ストアが前回の行を残す
 */
export async function readClaudeAccountsUsage({ accounts = [], loginLabel = t('claude.usage.loginAccount'), read = readClaudeUsage, skip = [],
  keychainFailure = macKeychainAuthFailure } = {}) {
  if (!accounts.length) {
    try { return await read({}); }
    catch (e) { return { windows: [], reason: quotaFailure(e), message: t('claude.usage.failed', { message: errorText(e) }) }; }
  }
  const skipped = new Set(skip);
  const login = async () => {
    if (skipped.has(LOGIN_ACCOUNT)) return { label: loginLabel, windows: [], skipped: true };
    try { return { label: loginLabel, ...(await read({})) }; }
    catch (e) { return { label: loginLabel, windows: [], reason: quotaFailure(e), message: t('claude.usage.failed', { message: errorText(e) }) }; }
  };
  const one = async a => {
    const base = { label: a.name, accountId: a.id ?? null };
    if (a.error) return { ...base, windows: [], message: a.error };
    if (!a.usageLogin || !a.configDir) return { ...base, windows: [], needsUsageLogin: true, message: needsUsageLogin() };
    if (skipped.has(a.id)) return { ...base, windows: [], skipped: true };
    try {
      const quota = await read({ configDir: a.configDir });
      return { ...base, ...quota, ...(quota?.reason === 'no-login' ? { reauth: true } : {}) };
    } catch (e) {
      // ログイン切れの印は、CLI が認証失敗を返したときに付ける。429・時間切れ・起動失敗は「取得できませんでした」
      const reason = quotaFailure(e);
      const auth = reason !== 'rate-limited' && reason !== 'timeout' && claudeUsageAuthFailure(e);
      // macOS で項目が有るのに断られたのは、鍵束を開けなかった（ロック中など。ADR 0351 の M7）か、サーバー側でログインが取り消された（M6。未確認）か。
      // 見分けられないので、ログイン切れの印（cliAuthFailed）は付けず、ロックの解除を先に、続くときの「ログインし直す」も出す（reauth）
      if (auth && await Promise.resolve().then(() => keychainFailure(a.configDir)).catch(() => null) === 'keychain') {
        return { ...base, windows: [], reason, keychain: true, reauth: true, message: t('claude.usage.keychain') };
      }
      return { ...base, windows: [], reason, ...(auth ? { reauth: true, cliAuthFailed: true } : {}),
        message: auth ? t('claude.usage.failedReauth', { message: errorText(e) }) : t('claude.usage.failed', { message: errorText(e) }) };
    }
  };
  const rows = await Promise.all([login(), ...accounts.map(one)]);
  return { windows: [], accounts: rows, message: null };
}
