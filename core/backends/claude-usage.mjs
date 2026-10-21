// SDK は使うときに読む（配布物は SDK を持たない。取っていなければ、取得を促す文で失敗する。core/claude-sdk.mjs）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadClaudeSdk } from '../claude-sdk.mjs';
import { claudeExecutable } from '../cli-installation.mjs';
import { claudeQuota, LOGIN_ACCOUNT, quotaFailure } from '../usage.mjs';
import { claudeEnv, TOKEN_ENV } from '../claude-accounts.mjs';
import { t } from '../i18n.mjs';

/**
 * 使用量を読むプロセスの env。
 *   configDir あり … 登録したアカウントの使用量。そのアカウント専用の設定フォルダ（`claude auth login` 済み）を
 *                    CLAUDE_CONFIG_DIR にし、会話用のトークン（CLAUDE_CODE_OAUTH_TOKEN）は外す。
 *                    setup-token のトークンは scope が user:inference だけで使用量を読めない（2026-09-23 確認）ため。
 *   無し          … ログイン中のアカウント（今までどおり）
 */
export function usageEnv(base = process.env, { token, configDir } = {}) {
  if (!configDir) return claudeEnv(base, { token, extra: { CLAUDECODE: undefined } });
  const env = claudeEnv(base, { extra: { CLAUDECODE: undefined } });
  for (const key of Object.keys(env)) if ([TOKEN_ENV, 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// A control-only query: no prompt is yielded and no inference request is made.
// Keep stdin open until get_usage completes, then close the owned process.
export async function readClaudeUsage({ token, configDir } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { query } = await loadClaudeSdk();
  const q = query({ prompt: (async function* () { await gate; })(), options: {
    pathToClaudeCodeExecutable: claudeExecutable(), persistSession: false,
    settingSources: ['user'], tools: [], mcpServers: {}, settings: { disableAllHooks: true },
    env: usageEnv(process.env, { token, configDir }),
  } });
  let timer, result;
  try {
    result = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(t('claude.usage.timeout')), { reason: 'timeout' })), 20_000); }),
    ]);
  } finally { clearTimeout(timer); release(); q.close(); }
  return claudeUsageQuota(result, { token, configDir });
}

const filled = value => typeof value === 'string' && value.length > 0;
/**
 * ログイン情報のファイル（<設定フォルダ>/.credentials.json）にトークンが無いか。
 * トークンの値は比べも返しもせず、項目（claudeAiOauth）があるか・アクセス用のトークンが空でないかだけを見る。
 *   configDir あり … 登録したアカウントの使用量の設定フォルダ。無し … ログイン中のアカウント（CLAUDE_CONFIG_DIR、無ければ ~/.claude）
 * API キー（やログイン中のアカウントの会話用のトークン）が env にあれば、CLI はそちらで動くのでファイルは手がかりにならない（false）。
 * macOS の CLI はキーチェーンに置くので、ファイルが無い・項目が無いことは手がかりにしない。
 * ログイン中のアカウントは API の接続でもファイルが無いので、ファイルが無いことは手がかりにしない（登録したアカウントは Pleiad がログインさせた設定フォルダ）
 */
export async function credentialsMissing({ configDir, env = process.env, home = os.homedir(), platform = process.platform, readFile = fs.readFile } = {}) {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...(configDir ? [] : [TOKEN_ENV])];
  if (keys.some(key => filled(env[key]))) return false;
  const dir = configDir || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  let text;
  try { text = await readFile(path.join(dir, '.credentials.json'), 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' && Boolean(configDir) && platform !== 'darwin'; }
  let oauth;
  try { oauth = JSON.parse(text)?.claudeAiOauth; } catch { return false; }
  if (!oauth || typeof oauth !== 'object') return platform !== 'darwin';
  return !filled(oauth.accessToken);
}

/**
 * CLI の使用量の応答を枠にする。トークンが無いと CLI は使用量の口を呼ばず、制限の情報もプランも無い応答を返す
 * （rate_limits_available: false・subscription_type: null）。そのときログイン情報のファイルにトークンが無ければ、
 * 汎用の「取得できません」ではなく再ログインを促す（reason: 'no-login'）。ログイン中のアカウントはターミナルの `claude auth login`、
 * 登録したアカウントは「認可をやり直す」（readClaudeAccountsUsage が reauth を付ける）
 */
export async function claudeUsageQuota(result, { token, configDir, missing = credentialsMissing } = {}) {
  const quota = claudeQuota(result);
  if (quota.windows.length || quota.plan || token) return quota;
  if (!(await Promise.resolve().then(() => missing({ configDir })).catch(() => false))) return quota;
  return { ...quota, reason: 'no-login', message: configDir ? t('claude.usage.reauthNeeded') : t('claude.usage.relogin') };
}

const errorText = error => String(error?.message ?? error).replace(/sk-ant-[A-Za-z0-9_-]+/g, t('claude.redacted.token'));

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
export async function readClaudeAccountsUsage({ accounts = [], loginLabel = t('claude.usage.loginAccount'), read = readClaudeUsage, skip = [] } = {}) {
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
      return { ...base, windows: [], reauth: true, reason: quotaFailure(e), message: t('claude.usage.failedReauth', { message: errorText(e) }) };
    }
  };
  const rows = await Promise.all([login(), ...accounts.map(one)]);
  return { windows: [], accounts: rows, message: null };
}
