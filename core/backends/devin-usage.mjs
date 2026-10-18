// Devin CLI の使用枠。CLI 自身が読んでいるアカウントの使用状況の口（GetUserStatus）を、
// 同じ資格情報（credentials.toml の windsurf_api_key）で読む。
// 応答は planStatus.dailyQuotaRemainingPercent / weeklyQuotaRemainingPercent / *_ResetAtUnix と
// planInfo.planName。クォータ制でない契約・未ログイン・失敗は枠を作らず理由の文だけ返す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { usageWindow, number } from '../usage.mjs';
import { t } from '../i18n.mjs';

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

/** credentials.toml の場所。DEVIN_CONFIG_HOME/<app>/credentials.toml、無ければ OS の設定フォルダ */
export function devinCredentialsPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.DEVIN_CONFIG_HOME) return path.join(env.DEVIN_CONFIG_HOME, 'devin', 'credentials.toml');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'devin', 'credentials.toml');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'devin', 'credentials.toml');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'devin', 'credentials.toml');
}

/** toml の `key = "value"` だけ読む（資格情報ファイルの範囲なのでフルパーサーは要らない） */
export function readDevinCredentials(text) {
  const get = name => new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm').exec(String(text ?? ''))?.[1] ?? null;
  return { apiKey: get('windsurf_api_key'), apiServer: get('api_server_url') };
}

/** userStatus.planStatus → 使用枠。読めなければ枠を出さず message だけ */
export function devinQuota(data) {
  const status = data?.userStatus ?? data?.user_status;
  const plan = status?.planStatus ?? status?.plan_status;
  const info = plan?.planInfo ?? plan?.plan_info;
  if (!plan || !info) return { plan: null, windows: [], message: t('devin.usageUnknown') };
  const hide = name => plan[name] === true || info[name] === true;
  const window = (remaining, resetAt, minutes, label) => {
    const rest = number(remaining);
    if (rest == null || rest > 100) return null;
    const reset = number(typeof resetAt === 'string' ? Number(resetAt) : resetAt);
    return usageWindow(label, 100 - rest, reset == null ? null : reset * 1000, minutes);
  };
  const windows = [
    !hide('hide_daily_quota') && !hide('hideDailyQuota')
      ? window(plan.daily_quota_remaining_percent ?? plan.dailyQuotaRemainingPercent,
          plan.daily_quota_reset_at_unix ?? plan.dailyQuotaResetAtUnix, DAY_MINUTES, t('usage.window.daily')) : null,
    !hide('hide_weekly_quota') && !hide('hideWeeklyQuota')
      ? window(plan.weekly_quota_remaining_percent ?? plan.weeklyQuotaRemainingPercent,
          plan.weekly_quota_reset_at_unix ?? plan.weeklyQuotaResetAtUnix, WEEK_MINUTES, t('usage.window.weekly')) : null,
  ].filter(Boolean);
  return { plan: typeof info.planName === 'string' ? info.planName : (typeof info.plan_name === 'string' ? info.plan_name : null),
    windows, message: windows.length ? null : t('devin.usageUnknown') };
}

async function postUserStatus(apiServer, apiKey, signal) {
  const res = await fetch(`${String(apiServer).replace(/\/+$/, '')}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata: { api_key: apiKey, ide_name: 'devin-cli', ide_version: '1.0.0', extension_name: 'devin', extension_version: '1.0.0' } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function readDevinUsage({ env = process.env, fetcher = postUserStatus, readFile = fs.readFile, timeoutMs = 15_000 } = {}) {
  let cred;
  try { cred = readDevinCredentials(await readFile(devinCredentialsPath(env), 'utf8')); }
  catch { return { windows: [], checkedAt: null, message: t('devin.usageNoCredentials') }; }
  if (!cred.apiKey || !cred.apiServer) return { windows: [], checkedAt: null, message: t('devin.usageNoCredentials') };
  let data;
  try { data = await fetcher(cred.apiServer, cred.apiKey, AbortSignal.timeout(timeoutMs)); }
  catch { return { windows: [], checkedAt: null, message: t('usage.fetchFailed') }; }
  return devinQuota(data);
}
