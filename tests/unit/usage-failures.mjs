import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lang, setLanguage, t as tr, fmt } from '../../web/i18n.mjs';
import { currentLocale, setLocale, t as serverT } from '../../core/i18n.mjs';
import { N } from '../lib/dom-stub.mjs';
// 名前空間で読む（直す前の版で 1 つの名前が無くても、ほかの場面の判定を出す）
import * as usage from '../../core/usage.mjs';
import * as claudeUsage from '../../core/backends/claude-usage.mjs';
import * as webUsage from '../../web/usage.mjs';
import * as headerUsage from '../../web/header-usage.mjs';

export const name = 'usage-failures';
export const title = '使用量が読めないとき: 再ログインの案内・前回の値を残す・失敗のログは 1 行・読む間隔を延ばす';

export default async function(t) {
  // These assertions require Japanese, regardless of the host or preceding suite.
  const previousLanguage = lang;
  const previousLocale = currentLocale();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-usage-failures-'));
  try {
    setLocale('ja');
    await setLanguage('ja');
    await japaneseCases(t, tmp);
  } finally {
    setLocale(previousLocale);
    await setLanguage(previousLanguage);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function check(t, label, fn) {
  try { await fn(); t.ok(label, true); }
  catch (e) { t.ok(label, false, String(e?.message ?? e).split('\n')[0]); }
}

const MIN = 60_000;
const future = () => new Date(Date.now() + 3600_000).toISOString();
const week = used => ({ label: '週次（7日間）', usedPercent: used, remainingPercent: 100 - used, resetsAt: future(), minutes: 10080 });
// トークンが無いときの CLI の応答（制限の情報もプランも無い）
const NO_LIMITS = { rate_limits_available: false, subscription_type: null, rate_limits: null };

/** 偽のログイン情報のファイル。値は試験用の作り物（本物の ~/.claude・~/.agent-host には触らない） */
async function credentials(dir, body) {
  await fs.mkdir(dir, { recursive: true });
  if (body !== undefined) await fs.writeFile(path.join(dir, '.credentials.json'), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}

async function japaneseCases(t, tmp) {
  const empty = { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: [] } };
  const filled = { claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 1, scopes: [] } };
  const home = path.join(tmp, 'home');
  const loginDir = await credentials(path.join(home, '.claude'), empty);
  const registered = {
    emptyToken: await credentials(path.join(tmp, 'acct-aaaaaaaaaaaa'), empty),
    noItem: await credentials(path.join(tmp, 'acct-bbbbbbbbbbbb'), {}),
    noFile: await credentials(path.join(tmp, 'acct-cccccccccccc')),
    ok: await credentials(path.join(tmp, 'acct-dddddddddddd'), filled),
    broken: await credentials(path.join(tmp, 'acct-eeeeeeeeeeee'), '{'),
  };
  const missing = opts => claudeUsage.credentialsMissing({ env: {}, home, platform: 'win32', ...opts });

  await check(t, 'ログイン情報のファイル: トークンが空・項目が無い・ファイルが無いときだけ「無い」（値は読まない）', async () => {
    assert.equal(await missing({ configDir: registered.emptyToken }), true, 'トークンが空');
    assert.equal(await missing({ configDir: registered.noItem }), true, 'claudeAiOauth が無い');
    assert.equal(await missing({ configDir: registered.noFile }), true, '登録したアカウントの設定フォルダにファイルが無い');
    assert.equal(await missing({ configDir: registered.ok }), false, 'トークンがある');
    assert.equal(await missing({ configDir: registered.broken }), false, '壊れたファイルは手がかりにしない');
    assert.equal(await missing({}), true, 'ログイン中のアカウント（~/.claude）のトークンが空');
    assert.equal(await missing({ env: { CLAUDE_CONFIG_DIR: registered.ok } }), false, 'CLAUDE_CONFIG_DIR の先を読む');
    assert.equal(await missing({ home: path.join(tmp, 'nobody') }), false, 'ログイン中のアカウントのファイルが無いのは API の接続でもあるので手がかりにしない');
    assert.equal(await missing({ env: { ANTHROPIC_API_KEY: 'x' } }), false, 'API キーで動くときは手がかりにしない');
    assert.equal(await missing({ configDir: registered.noItem, platform: 'darwin' }), false, 'macOS はキーチェーンに置く');
    assert.ok(loginDir);
  });

  const relogin = serverT('claude.usage.relogin'), reauthNeeded = serverT('claude.usage.reauthNeeded');
  // read は CLI の代わり: どのアカウントにも制限の無い応答を返し、その設定フォルダの偽のファイルを見る
  const read = ({ configDir } = {}) => claudeUsage.claudeUsageQuota(NO_LIMITS, { configDir, missing: ({ configDir: dir }) => missing({ configDir: dir }) });
  const accounts = [
    { id: 'acct-aaaaaaaaaaaa', name: '仕事', configDir: registered.emptyToken, usageLogin: true },
    { id: 'acct-bbbbbbbbbbbb', name: '個人', configDir: registered.noItem, usageLogin: true },
    { id: 'acct-dddddddddddd', name: '予備', configDir: registered.ok, usageLogin: true },
  ];
  let quota;
  await check(t, 'トークンが空・項目が無い: 汎用の「取得できません」ではなく「再ログインが必要です」（理由 no-login）', async () => {
    quota = await claudeUsage.readClaudeAccountsUsage({ accounts, loginLabel: 'ログイン中のアカウント', read });
    const [login, work, personal, spare] = quota.accounts;
    assert.equal(login.reason, 'no-login'); assert.equal(login.message, relogin);
    assert.match(login.message, /再ログインが必要です/); assert.match(login.message, /claude auth login/);
    assert.ok(!login.reauth, 'ログイン中のアカウントはターミナルで入り直す（ボタンは出さない）');
    for (const row of [work, personal]) {
      assert.equal(row.reason, 'no-login'); assert.equal(row.message, reauthNeeded); assert.equal(row.reauth, true, '「認可をやり直す」の元');
    }
    assert.match(work.message, /再ログインが必要です/);
    assert.equal(spare.reason, undefined, 'トークンがあれば今までどおり');
    assert.equal(spare.message, serverT('usage.claudeUnavailable'));
    assert.ok(!JSON.stringify(quota).includes('fake-'), 'トークンの値を出さない');
  });

  await check(t, '設定の「使用量」に再ログインの文と「認可をやり直す」のボタンが出る。ヘッダーの札は認可待ち', async () => {
    assert.ok(quota?.accounts, '前の場面の結果');
    const els = new Map();
    const $ = id => els.get(id) ?? (els.set(id, new N('div')), els.get(id));
    const logins = [];
    webUsage.setupUsage({ $, cmd: async () => ({ label: 'Claude', quota, local: { error: 'なし' } }),
      getBackends: () => [{ id: 'claude', label: 'Claude' }], page: () => {}, isOpen: () => true, onUsageLogin: id => logins.push(id) });
    $('usageTab').onclick();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    const root = $('usageCards');
    assert.ok(root.shown.includes(relogin), root.shown);
    assert.ok(root.shown.includes(reauthNeeded));
    const buttons = root.querySelectorAll('button').filter(b => b.textContent === tr('usage.redoAuth'));
    assert.equal(buttons.length, 2, '登録した 2 つのアカウントにだけボタン');
    buttons[0].onclick();
    assert.deepEqual(logins, ['acct-aaaaaaaaaaaa']);
    assert.equal(headerUsage.needsAuth(quota.accounts[0]), true);
    assert.equal(headerUsage.chipState(headerUsage.quotaOf(quota, '')).kind, 'auth');
  });

  await check(t, '読めなかったら前回の値を空の結果で上書きせず残し、「◯分前の値」を添える（前回が無ければ理由の文だけ）', async () => {
    // 画面の「◯分前」は実際の時計で数えるので、前回の値は今の 5 分前に読んだことにする
    let now = Date.now() - 5 * MIN;
    const store = usage.createQuotaStore({ now: () => now });
    const first = await store.refresh('codex', async () => ({ plan: 'plus', windows: [week(40)] }));
    const readAt = first.checkedAt;
    now += 5 * MIN;
    const failed = await store.refresh('codex', async () => { throw Object.assign(new Error('HTTP 429 Too Many Requests'), {}); });
    assert.deepEqual(failed.windows.map(w => w.usedPercent), [40], '前回の枠のまま');
    assert.equal(failed.plan, 'plus');
    assert.equal(failed.reason, 'rate-limited');
    assert.equal(failed.staleSince, readAt, 'いつの値か');
    assert.equal(failed.checkedAt, readAt, '読んだ時刻は前回のまま（委譲の振り分けが新しい値と取り違えない）');
    const note = tr('usage.staleValue', { when: fmt.relative(failed.staleSince) });
    assert.match(note, /5分前/);
    // 設定の「使用量」に出る
    const els = new Map();
    const $ = id => els.get(id) ?? (els.set(id, new N('div')), els.get(id));
    webUsage.setupUsage({ $, cmd: async () => ({ label: 'Codex', quota: failed, local: { error: 'なし' } }),
      getBackends: () => [{ id: 'codex', label: 'Codex' }], page: () => {}, isOpen: () => true });
    $('usageTab').onclick();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok($('usageCards').shown.includes(note), $('usageCards').shown);
    // ply_usage にも理由と何分前か
    const compact = usage.compactQuota(failed, now);
    assert.equal(compact.reason, 'rate-limited'); assert.equal(compact.staleMinutes, 5);
    assert.equal(compact.staleSince, new Date(readAt).toISOString());
    // 前回が無い: 理由の文だけ（枠も古い値の印も無い）
    const fresh = usage.createQuotaStore({ now: () => now });
    const none = await fresh.refresh('codex', async () => { throw new Error('boom'); });
    assert.deepEqual(none.windows, []); assert.equal(none.staleSince, undefined); assert.equal(none.reason, 'error');
    assert.ok(none.message);
  });

  await check(t, 'アカウントの行ごと: 読めなかった行だけ前回の値を残し、ほかの行は新しい値。ply_usage の行に reason と staleSince', async () => {
    let now = Date.now() - 20 * MIN;
    const store = usage.createQuotaStore({ now: () => now });
    const rows = (login, work) => ({ windows: [], message: null, accounts: [{ label: 'ログイン中のアカウント', ...login }, { label: '仕事', accountId: 'acct-aaaaaaaaaaaa', ...work }] });
    await store.refresh('claude', async () => rows({ windows: [week(10)] }, { windows: [week(30)] }));
    const readAt = now;
    now += 2 * MIN;
    const next = await store.refresh('claude', async () => rows({ windows: [week(12)] }, { windows: [], reason: 'timeout', reauth: true, message: '時間切れ' }));
    assert.equal(next.accounts[0].windows[0].usedPercent, 12);
    assert.equal(next.accounts[1].windows[0].usedPercent, 30, '読めなかった行は前回の枠');
    assert.equal(next.accounts[1].staleSince, readAt);
    assert.equal(next.accounts[1].reauth, true); assert.equal(next.accounts[1].message, '時間切れ');
    const compact = usage.compactQuota(next, now);
    assert.equal(compact.accounts[1].reason, 'timeout'); assert.equal(compact.accounts[1].staleMinutes, 2);
    assert.equal(compact.accounts[0].reason, undefined); assert.equal(compact.accounts[0].staleSince, undefined);
    // ply_usage: 取得そのものの例外も理由を付ける
    const agents = await usage.agentUsage({ list: () => [], get: () => ({ id: 'codex', label: 'Codex', usage: true }), backend: 'codex', locale: 'ja',
      read: async () => { throw Object.assign(new Error('x'), { reason: 'timeout' }); } });
    assert.equal(agents.backends[0].reason, 'timeout');
  });

  await check(t, '失敗は server.log に 1 行（アカウント・理由・時刻）。同じ理由が続く間は増えず、読めたら 1 行', async () => {
    let now = Date.parse('2026-10-21T00:00:00Z');
    const lines = [];
    const store = usage.createQuotaStore({ now: () => now, log: line => lines.push(line) });
    let reply = { windows: [], reason: 'no-login', message: relogin };
    const fetcher = async () => ({ windows: [], message: null, accounts: [{ label: 'ログイン中のアカウント', windows: [week(5)] }, { label: '仕事', accountId: 'acct-aaaaaaaaaaaa', ...reply }] });
    for (let i = 0; i < 4; i++) { await store.refresh('claude', fetcher, { force: true }); now += 20 * MIN; }
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /claude account=acct-aaaaaaaaaaaa read failed reason=no-login at=2026-10-21T00:00:00\.000Z/);
    assert.ok(!lines[0].includes('fake-') && !lines[0].includes('仕事'), '秘密も表示名（メールのことがある）も書かない');
    reply = { windows: [], reason: 'rate-limited', message: '429' };
    await store.refresh('claude', fetcher, { force: true });
    assert.equal(lines.length, 2, '理由が変わったら 1 行'); assert.match(lines[1], /reason=rate-limited/);
    reply = { windows: [week(7)] };
    await store.refresh('claude', fetcher, { force: true });
    await store.refresh('claude', fetcher, { force: true });
    assert.equal(lines.length, 3); assert.match(lines[2], /acct-aaaaaaaaaaaa read again after reason=rate-limited/);
    // 取得そのものの例外（アカウントの無いエージェント）
    await store.refresh('codex', async () => { throw new Error('socket hang up'); }, { force: true });
    await store.refresh('codex', async () => { throw new Error('socket hang up'); }, { force: true });
    assert.equal(lines.filter(l => l.startsWith('codex ')).length, 1);
    assert.match(lines.at(-1), /^codex read failed reason=error at=/);
  });

  await check(t, '読めない間は読む間隔を 60 秒の倍々に延ばし（上限 15 分）、読めたら戻す', async () => {
    let now = 1_000_000, calls = 0, fail = true;
    const store = usage.createQuotaStore({ now: () => now });
    const fetcher = async () => { calls++; return fail ? { windows: [], reason: 'rate-limited', message: '429' } : { windows: [week(3)] }; };
    // 次に読みに行くまでの間隔を、1 秒刻みで確かめる（ttl 内は読まない）
    const nextRead = async () => {
      const before = calls;
      for (let waited = 0; waited <= 20 * MIN; waited += 1000) {
        now += 1000; await store.refresh('codex', fetcher);
        if (calls > before) return waited + 1000;
      }
      return null;
    };
    await store.refresh('codex', fetcher); assert.equal(calls, 1);
    const gaps = [];
    for (let i = 0; i < 5; i++) gaps.push(await nextRead());
    assert.deepEqual(gaps.map(g => g / MIN), [2, 4, 8, 15, 15], '倍々に延ばして 15 分で止める');
    fail = false;
    await store.refresh('codex', fetcher, { force: true });
    assert.equal(await nextRead(), MIN, '読めたら 60 秒の間隔に戻す');
  });

  await check(t, 'アカウントの行ごとに延ばす: 延ばしている行は読まず（skip）、ほかの行は読む。人の読み直しは全部をすぐ読む', async () => {
    let now = 5_000_000;
    const store = usage.createQuotaStore({ now: () => now });
    const asked = [];
    const fetcher = async ({ skip = [] } = {}) => {
      asked.push(skip);
      return { windows: [], message: null, accounts: [
        skip.includes('login') ? { label: 'ログイン中のアカウント', windows: [], skipped: true } : { label: 'ログイン中のアカウント', windows: [week(asked.length)] },
        skip.includes('acct-aaaaaaaaaaaa') ? { label: '仕事', accountId: 'acct-aaaaaaaaaaaa', windows: [], skipped: true }
          : { label: '仕事', accountId: 'acct-aaaaaaaaaaaa', windows: [], reason: 'no-login', reauth: true, message: reauthNeeded },
      ] };
    };
    await store.refresh('claude', fetcher);
    now += MIN + 1000;
    const second = await store.refresh('claude', fetcher);
    assert.deepEqual(asked[1], ['acct-aaaaaaaaaaaa'], '延ばしている行を skip で渡す');
    assert.equal(second.accounts[0].windows[0].usedPercent, 2, 'ほかの行は読む');
    assert.equal(second.accounts[1].reason, 'no-login', '読まなかった行は前回の行（理由の文）のまま');
    assert.equal(second.accounts[1].message, reauthNeeded);
    // 人の読み直し: ttl 内でも、延ばしている行も読む
    await store.refresh('claude', fetcher, { force: true });
    assert.equal(asked.length, 3); assert.deepEqual(asked[2], []);
    // readClaudeAccountsUsage は skip の行を読まない
    const reads = [];
    const out = await claudeUsage.readClaudeAccountsUsage({ accounts: [{ id: 'acct-aaaaaaaaaaaa', name: '仕事', configDir: registered.emptyToken, usageLogin: true }],
      loginLabel: 'ログイン中のアカウント', skip: ['acct-aaaaaaaaaaaa'], read: async ({ configDir } = {}) => { reads.push(configDir ?? 'login'); return { windows: [week(1)] }; } });
    assert.deepEqual(reads, ['login']); assert.equal(out.accounts[1].skipped, true);
  });

  await check(t, '設定の「使用量」の読み直しボタンは間隔を待たずに読み直す（delegation.usageRefresh）。タブを開くのは今までどおり', async () => {
    const sent = [];
    const els = new Map();
    const $ = id => els.get(id) ?? (els.set(id, new N('div')), els.get(id));
    const cmd = async (command, args) => { sent.push([command, args]); return { label: 'Codex', quota: { windows: [week(1)] }, local: { error: 'なし' } }; };
    webUsage.setupUsage({ $, cmd, getBackends: () => [{ id: 'codex', label: 'Codex' }], page: () => {}, isOpen: () => true });
    const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
    $('usageTab').onclick(); await tick();
    $('refreshUsage').onclick(); await tick();
    assert.deepEqual(sent, [['providerUsage', { backend: 'codex' }], ['invoke', { op: 'delegation.usageRefresh', args: { backend: 'codex' } }]]);
  });
}
