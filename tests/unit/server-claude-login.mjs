// Claude のアカウントの認可を server の配線で通す（claudeLoginStart / claudeLoginCode / claudeLoginCancel と claudeLogin イベント）。
// Claude Code の代わりに偽の CLI（tests/lib/fake-claude-login.mjs）を AGENT_HOST_CLAUDE_BIN で渡す。本物のログインもネットワークも使わない。
// ADR 0353: アカウントは名前と claude.ai のログインで作り、済んだときだけ載せる。前の版の会話用のトークンは起動時に消す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-claude-login';
export const title = 'Claude のアカウントの認可: 名前とログインで登録・取り消しで何も残さない・ログインし直し・削除で設定フォルダも消す・前の版のトークンを消す';

const FAKE_CLI = path.join(ROOT, 'tests', 'lib', 'fake-claude-login.mjs');
const ORG_WORK = '11111111-4444-4000-8000-00000000000d';
const LEGACY_ID = 'acct-legacy0000000';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-login-server-'));
  const log = path.join(scratch, 'fake-cli.log');
  // 前の版の置き場: 会話用のトークン（暗号化した秘密）・持ち主の照合の記録・setup-token の使い捨てフォルダ
  await fs.writeFile(path.join(scratch, 'claude-account-secrets.json'), JSON.stringify({ version: 1, entries: { [`claude-account:${LEGACY_ID}`]: 'opaque' } }));
  await fs.writeFile(path.join(scratch, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [
    { id: LEGACY_ID, name: '前の版', createdAt: '2026-01-01T00:00:00.000Z', tokenOrg: ORG_WORK, tokenCheckedAt: '2026-01-01T00:00:00.000Z' }] }));
  await fs.mkdir(path.join(scratch, 'claude-login-tmp', 'scratch-1'), { recursive: true });
  const server = await startServer({ dataDir: scratch, env: {
    AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CLAUDE_BIN: `"${process.execPath}" "${FAKE_CLI}"`, FAKE_CLAUDE_LOG: log,
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-parent-shell-should-not-leak',
    CLAUDE_CONFIG_DIR: path.join(scratch, 'cli-config'),
    FAKE_CLAUDE_ORG: ORG_WORK, FAKE_CLAUDE_EMAIL: 'work@example.com',
  } });
  const c = await open({ port: server.port, token: server.token });
  const logins = from => c.since(from).filter(e => e.type === 'claudeLogin');
  const phase = (loginId, p, from) => c.waitFor(e => e.type === 'claudeLogin' && e.loginId === loginId && e.phase === p, { ms: 30_000, from });
  const exists = p => fs.access(p).then(() => true, () => false);
  try {
    // ---- 前の版の会話用のトークンを消す
    const legacyRowNow = async () => JSON.parse(await fs.readFile(path.join(scratch, 'claude-accounts.json'), 'utf8')).accounts.find(a => a.id === LEGACY_ID);
    // 起動の後で消す（トークンのファイル → 使い捨てフォルダ → 一覧の順）。一覧まで済むのを待つ
    for (let i = 0; i < 200 && 'tokenOrg' in ((await legacyRowNow()) ?? {}); i++) await sleep(50);
    t.ok('起動したら、前の版の会話用のトークンのファイルを消す', !(await exists(path.join(scratch, 'claude-account-secrets.json'))));
    t.ok('setup-token の使い捨てフォルダも消す', !(await exists(path.join(scratch, 'claude-login-tmp'))));
    const legacyRow = await legacyRowNow();
    t.ok('一覧から持ち主の照合の記録を消し、アカウントは残す', legacyRow?.name === '前の版' && !('tokenOrg' in legacyRow) && !('tokenCheckedAt' in legacyRow));
    const legacy = (await c.cmd('claudeAccounts')).accounts.find(a => a.id === LEGACY_ID);
    t.ok('ログインの無い前の版のアカウントは「ログインがまだ」で、トークンの項目は無い', legacy?.usageLogin === false && !('hasToken' in legacy) && !('tokenCheck' in legacy), JSON.stringify(legacy));

    let refused = null;
    await c.cmd('claudeLoginStart', { name: '  ' }).catch(e => { refused = e; });
    t.ok('表示名が無ければ始めない', refused?.message.includes('表示名'));
    refused = null;
    await c.cmd('claudeLoginStart', { accountId: 'acct-nope' }).catch(e => { refused = e; });
    t.ok('登録していないアカウントの認可は始めない', refused?.message.includes('登録されていません'));
    refused = null;
    await c.cmd('claudeLoginStart', { kind: 'setup-token', name: '仕事用' }).catch(e => { refused = e; });
    t.ok('setup-token の認可は始めない（ADR 0353）', Boolean(refused));

    // ---- 新しいアカウント（名前 → claude.ai のログイン）
    const m0 = c.mark();
    const { loginId: a } = await c.cmd('claudeLoginStart', { name: '仕事用' });
    const url = await phase(a, 'url', m0);
    t.ok('認可 URL を知らせる', url.url.startsWith('https://claude.com/cai/oauth/authorize?') && url.sessionId === null);
    t.ok('済むまでは新しいアカウントの id を画面に渡さない', url.accountId === null);
    await phase(a, 'code', m0);
    t.ok('済むまでは一覧に載せない', (await c.cmd('claudeAccounts')).accounts.every(x => x.name !== '仕事用'));
    const m1 = c.mark();
    await c.cmd('claudeLoginCode', { loginId: a, code: 'bad' });
    const retry = await c.waitFor(e => e.type === 'claudeLogin' && e.loginId === a && e.phase === 'code' && e.message, { ms: 30_000, from: m1 });
    t.ok('受け付けられなかったコードを知らせる', retry.message.includes('Invalid code'));
    await c.cmd('claudeLoginCode', { loginId: a, code: 'good#1' });
    const done = await phase(a, 'done', m1);
    t.ok('済んだら作ったアカウントの id を添えて完了を知らせる', /^acct-/.test(done.accountId ?? ''));
    const list = (await c.cmd('claudeAccounts')).accounts;
    const work = list.find(x => x.id === done.accountId);
    t.ok('済んだら名前とログイン済みで載る', work?.name === '仕事用' && work.usageLogin === true);
    t.ok('アカウント一覧が変わったことを知らせる', c.since(m0).some(e => e.type === 'claudeAccountsChanged'));
    const usageDir = path.join(scratch, 'claude-usage', work.id);
    t.ok('資格情報はアカウントの設定フォルダに残る', await exists(path.join(usageDir, '.credentials.json')));
    refused = null;
    await c.cmd('claudeLoginStart', { name: ' 仕事用 ' }).catch(e => { refused = e; });
    t.ok('同じ名前の新しいアカウントは始めない（ログインし直しは accountId で始める）', refused?.message.includes('同じ名前'));

    // ---- 新しいアカウントの取り消し: 何も残さない
    const usageDirsBefore = (await fs.readdir(path.join(scratch, 'claude-usage'))).sort();
    const m2 = c.mark();
    const { loginId: b } = await c.cmd('claudeLoginStart', { name: '途中でやめる' });
    await phase(b, 'code', m2);
    await c.cmd('claudeLoginCancel', { loginId: b });
    await phase(b, 'cancelled', m2);
    t.ok('取り消した新しいアカウントは一覧に載せない', (await c.cmd('claudeAccounts')).accounts.every(x => x.name !== '途中でやめる'));
    let leftover = null;
    for (let i = 0; i < 100; i++) {
      leftover = (await fs.readdir(path.join(scratch, 'claude-usage'))).sort();
      if (leftover.join() === usageDirsBefore.join()) break;
      await sleep(50);
    }
    t.ok('取り消した新しいアカウントの設定フォルダを片付ける', leftover.join() === usageDirsBefore.join(), leftover.join());

    // ---- 登録済みのアカウントのログインし直し
    const m3 = c.mark();
    const { loginId: d } = await c.cmd('claudeLoginStart', { accountId: work.id });
    const dUrl = await phase(d, 'url', m3);
    t.ok('登録済みのアカウントは id を添えて知らせる', dUrl.accountId === work.id);
    await phase(d, 'code', m3);
    await c.cmd('claudeLoginCode', { loginId: d, code: 'good#2' });
    await phase(d, 'done', m3);
    t.ok('ログインし直してもログイン済みのまま', (await c.cmd('claudeAccounts')).accounts.find(x => x.id === work.id)?.usageLogin === true);

    // 偽の CLI は版の確かめ（--version）などでも呼ばれる。ここで見るのはログインだけ
    // macOS は取り消した新しいアカウントを片付けるとき auth logout も回す（キーチェーンの項目を CLI に消させる。ADR 0351）
    const seen = (await fs.readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(s => s.args[0] === 'auth');
    const loginRuns = seen.filter(s => s.args[1] === 'login');
    t.ok('CLI に会話用のトークンを渡さない', loginRuns.length >= 3 && seen.every(s => !s.hasOauthToken));
    t.ok('どれも auth login を、アカウントの設定フォルダで回す', seen.every(s => ['auth login --claudeai', 'auth logout'].includes(s.args.join(' ')))
      && loginRuns.every(s => s.args.join(' ') === 'auth login --claudeai' && path.resolve(s.configDir).startsWith(path.resolve(scratch, 'claude-usage')))
      && path.resolve(loginRuns.at(-1).configDir) === path.resolve(usageDir), JSON.stringify(seen.map(s => ({ args: s.args, configDir: s.configDir }))));

    // ---- 取り消し（登録済み）
    const m4 = c.mark();
    const { loginId: e } = await c.cmd('claudeLoginStart', { accountId: work.id });
    await phase(e, 'code', m4);
    await c.cmd('claudeLoginCancel', { loginId: e });
    await phase(e, 'cancelled', m4);
    refused = null;
    await c.cmd('claudeLoginCode', { loginId: e, code: 'x' }).catch(err => { refused = err; });
    t.ok('取り消した認可にはコードを送れない', refused?.message.includes('終了しています'));
    t.ok('取り消しても認可済みの印と設定フォルダは残る', (await c.cmd('claudeAccounts')).accounts.find(x => x.id === work.id).usageLogin === true && await exists(usageDir));

    // ---- 削除
    await c.cmd('deleteClaudeAccount', { id: work.id });
    t.ok('削除すると使用量の設定フォルダも消える', !(await exists(usageDir)));
    t.ok('サーバーのログにトークンを出さない', !server.tail(200).includes('sk-ant-'));
    t.ok('記録したファイルの一覧にトークンを書かない', !(await fs.readFile(path.join(scratch, 'claude-accounts.json'), 'utf8')).includes('sk-ant-'));
    t.note(`イベント ${logins(0).length} 件`);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
