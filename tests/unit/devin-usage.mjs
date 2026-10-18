import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, summarize } from '../lib/harness.mjs';
import { devinCredentialsPath, readDevinCredentials, devinQuota, readDevinUsage } from '../../core/backends/devin-usage.mjs';
import { t as translate } from '../../core/i18n.mjs';

export const name = 'devin-usage';
export const title = 'Devin CLI の使用枠: credentials.toml・GetUserStatus の応答・日次と週次の枠への変換';

const toml = 'api_server_url = "https://api.example.test"\nwindsurf_api_key = "sk-test"\n';
const status = (over = {}) => ({ userStatus: { planStatus: {
  planInfo: { planName: 'Pro' },
  dailyQuotaRemainingPercent: 80, weeklyQuotaRemainingPercent: 50,
  dailyQuotaResetAtUnix: '2000000000', weeklyQuotaResetAtUnix: '2000500000',
  ...over,
} } });

export default async function testDevinUsage(t) {
  // credentials.toml の置き場（DEVIN_CONFIG_HOME が優先、無ければ OS の設定フォルダ）
  assert.equal(devinCredentialsPath({ DEVIN_CONFIG_HOME: path.join('x', 'cfg') }), path.join('x', 'cfg', 'devin', 'credentials.toml'));
  assert.equal(devinCredentialsPath({}, 'darwin', path.join('h', 'u')), path.join('h', 'u', 'Library', 'Application Support', 'devin', 'credentials.toml'));
  assert.equal(devinCredentialsPath({ APPDATA: path.join('r', 'app') }, 'win32', 'h'), path.join('r', 'app', 'devin', 'credentials.toml'));
  assert.equal(devinCredentialsPath({}, 'linux', path.join('h', 'u')), path.join('h', 'u', '.config', 'devin', 'credentials.toml'));
  assert.deepEqual(readDevinCredentials(toml), { apiKey: 'sk-test', apiServer: 'https://api.example.test' });
  assert.deepEqual(readDevinCredentials('other = "x"'), { apiKey: null, apiServer: null });
  t.ok('credentials.toml から api_server_url と windsurf_api_key を読む', true);

  // 応答 → 日次・週次の枠。残率から使用率を引き、リセットは unix 秒
  const quota = devinQuota(status());
  assert.equal(quota.plan, 'Pro');
  assert.equal(quota.windows.length, 2);
  assert.equal(quota.windows[0].label, translate('usage.window.daily'));
  assert.equal(quota.windows[0].usedPercent, 20);
  assert.equal(quota.windows[0].minutes, 1440);
  assert.equal(quota.windows[0].resetsAt, '2033-05-18T03:33:20.000Z');
  assert.equal(quota.windows[1].usedPercent, 50);
  assert.equal(quota.windows[1].minutes, 10080);
  // snake_case・hide フラグ・クォータ無しの契約
  const snake = devinQuota({ user_status: { plan_status: { plan_info: { plan_name: 'Team' }, hide_daily_quota: true,
    weekly_quota_remaining_percent: 30, weekly_quota_reset_at_unix: '2000500000' } } });
  assert.equal(snake.windows.length, 1);
  assert.equal(snake.plan, 'Team');
  assert.equal(devinQuota({}).windows.length, 0);
  assert.equal(devinQuota({ userStatus: {} }).message, translate('devin.usageUnknown'));
  t.ok('日次・週次の残率を使用率の枠に変え、hide フラグとクォータ無しの契約に従う', true);

  // 取得の失敗・資格情報なしは枠を出さず理由だけ
  const env = { DEVIN_CONFIG_HOME: path.join('x', 'cfg') };
  assert.equal((await readDevinUsage({ env, readFile: async () => { throw new Error('missing'); } })).message, translate('devin.usageNoCredentials'));
  assert.equal((await readDevinUsage({ env, readFile: async () => 'other = "x"' })).message, translate('devin.usageNoCredentials'));
  assert.equal((await readDevinUsage({ env, readFile: async () => toml, fetcher: async () => { throw new Error('HTTP 500'); } })).message, translate('usage.fetchFailed'));
  // 資格情報から Post し、返った枠をそのまま出す
  let called = null;
  const ok = await readDevinUsage({ env, readFile: async () => toml,
    fetcher: async (server, key, signal) => { called = { server, key, aborted: signal.aborted }; return status(); } });
  assert.deepEqual(called, { server: 'https://api.example.test', key: 'sk-test', aborted: false });
  assert.equal(ok.windows.length, 2);
  assert.equal(ok.plan, 'Pro');
  t.ok('資格情報なし・取得失敗は正直な文だけ、取れれば実値の枠とプラン名', true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = summarize([await runCase({ name, title, default: testDevinUsage })]);
