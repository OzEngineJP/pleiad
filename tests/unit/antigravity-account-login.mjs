import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'antigravity-account-login';
export const title = 'Antigravity second accounts log in with file token storage, guarded by the log marker, without touching the keychain';

const fake = fileURLToPath(new URL('../lib/fake-agy.mjs', import.meta.url));

export default async function run(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-login-'));
  const home = path.join(data, 'home');
  await fs.mkdir(home);
  const keys = ['AGENT_HOST_AGY_BIN', 'AGENT_HOST_DATA', 'USERPROFILE', 'HOME', 'FAKE_AGY_AUTH_FILE', 'FAKE_AGY_ACP_LOG', 'FAKE_AGY_NO_FILE_MARKER', 'FAKE_AGY_PID_FILE', 'FAKE_AGY_AUTH_HOLD_MS', 'FAKE_AGY_AUTH_REFUSE'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const made = ['acct-0123456789ab', 'acct-aaaaaaaaaaaa', 'acct-bbbbbbbbbbbb', 'acct-cccccccccccc', 'acct-dddddddddddd'];
  const keychain = path.join(data, 'keychain-marker');
  try {
    Object.assign(process.env, {
      AGENT_HOST_AGY_BIN: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`,
      AGENT_HOST_DATA: data, USERPROFILE: home, HOME: home, FAKE_AGY_AUTH_FILE: keychain,
      FAKE_AGY_ACP_LOG: path.join(data, 'acp.jsonl'), FAKE_AGY_PID_FILE: path.join(data, 'pids.json'),
    });
    delete process.env.FAKE_AGY_NO_FILE_MARKER;
    const acp = await import(`../../core/backends/antigravity-acp.mjs?re=login-${Date.now()}`);
    const accounts = await import(`../../core/backends/antigravity-accounts.mjs?re=login-${Date.now()}`);
    // 置き場の根は store が最初に読まれたときの dataDir（全体の実行では別の suite が先に読む）に従う
    const root = (await import('../../core/store.mjs')).dataDir;
    const id = 'acct-0123456789ab';
    const account = { id, name: '仕事用', dir: path.join(root, 'accounts', 'antigravity', id) };
    const sent = async () => (await fs.readFile(process.env.FAKE_AGY_ACP_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l).method).filter(Boolean);

    // ---- 起動の型: 1 つ目は何も足さない。2 つ目以降は env・相対パス・ログ
    assert.deepEqual(acp.agyLaunchProfile(), { key: 'default', args: [], env: {} });
    const profile = acp.agyLaunchProfile({ account });
    assert.equal(profile.key, id);
    assert.equal(profile.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, '1');
    assert.equal(profile.args[0], '--app-data-dir');
    assert.ok(!path.isAbsolute(profile.args[1]), 'app data dir is relative');
    assert.equal(path.resolve(home, '.gemini', profile.args[1]), path.join(account.dir, '.gemini', 'antigravity-cli'));
    assert.equal(profile.args[2], '--log-file');
    assert.equal(profile.topEnv.USERPROFILE, account.dir);
    assert.notEqual(acp.agyLaunchProfile({ account }).logFile, profile.logFile, 'a new log name per launch');
    t.ok('The first account adds nothing; later accounts get the file-storage env, a relative app-data-dir and a fresh log', true);

    // ---- 別のドライブ（相対パスが作れない）は断る
    if (process.platform === 'win32') {
      const other = path.parse(home).root.toUpperCase().startsWith('Z:') ? 'Y:\\' : 'Z:\\';
      process.env.USERPROFILE = `${other}Users\\someone`;
      assert.throws(() => acp.agyLaunchProfile({ account }), e => e.code === 'AGY_APP_DATA_UNREACHABLE');
      process.env.USERPROFILE = home;
      t.ok('A data folder on another drive is refused', true);
    }

    // ---- ログイン: 印を確かめてから authenticate、token はファイル。鍵束には触れない
    const events = [];
    const result = await accounts.loginAgyAccount({ account, dataDir: root, emit: e => events.push(e), method: 'oauth-business' });
    assert.equal(result.credential.kind, 'agy-file-token');
    assert.equal(result.credential.method, 'oauth-business');
    assert.equal(result.label, '仕事用');
    assert.ok(!JSON.stringify(result).includes('"fake"'), 'the token is never put in the stored credential');
    assert.equal(await accounts.hasAgyToken(account, root), true);
    assert.equal(await fs.stat(keychain).catch(() => null), null, 'the keychain stand-in is untouched');
    assert.ok(events.some(e => e.phase === 'url' && !e.url), 'message-only step');
    assert.equal(events.at(-1).phase, 'done');
    const methods = await sent();
    assert.deepEqual(methods.slice(0, 3), ['initialize', 'session/new', 'authenticate']);
    const logs = await fs.readdir(path.join(account.dir, 'logs'));
    assert.equal(logs.length, 1);
    t.ok('Login checks the marker before authenticate, stores a token file and leaves the keychain alone', true);

    // ---- 同じアカウントをもう一度: すでに通る（authenticate を送らない）
    await fs.rm(process.env.FAKE_AGY_ACP_LOG);
    await accounts.loginAgyAccount({ account, dataDir: root });
    assert.ok(!(await sent()).includes('authenticate'));
    t.ok('An account that already has a token does not authenticate again', true);

    // ---- token のファイルがリンク・ハードリンクなら「在る」とみなさない
    const token = profile.tokenFile.replace(account.dir, account.dir);
    const tokenPath = path.join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    assert.ok(token);
    await fs.link(tokenPath, path.join(data, 'second-link'));
    assert.equal(await accounts.hasAgyToken(account, root), false);
    await fs.rm(path.join(data, 'second-link'));
    assert.equal(await accounts.hasAgyToken(account, root), true);
    await assert.rejects(accounts.hasAgyToken({ ...account, id: 'acct-ffffffffffff' }, root));
    t.ok('A token with another hard link is not a credential; a foreign directory is rejected', true);

    // ---- ログイン済みの 2 つ目のアカウントの会話: ファイル保存の env・相対の置き場で起こし、印を確かめてから prompt を送る。1 つ目は何も足さない
    const { backend } = await import(`../../core/backends/antigravity.mjs?re=turn-${Date.now()}`);
    const work = path.join(data, 'work');
    await fs.mkdir(work);
    const turnEvents = [];
    await fs.rm(process.env.FAKE_AGY_ACP_LOG, { force: true });
    const bound = await backend.forAccount(account);
    assert.deepEqual(await bound.accountStatus(), { hasCredential: true, label: '仕事用' });
    const turn = await bound.runTurn({ prompt: 'hello', cwd: work, mode: 'default', emit: e => turnEvents.push(e), sessionId: 'agy-acct-turn-1' });
    assert.ok(turnEvents.length > 0, 'the turn produced events');
    const turnMethods = await sent();
    assert.ok(turnMethods.indexOf('session/prompt') > turnMethods.indexOf('session/new'), 'prompt follows session/new');
    assert.equal(await fs.stat(keychain).catch(() => null), null, 'the keychain stand-in is still untouched after a turn');
    await bound.accountDispose();
    // ---- 使用量とモデル一覧もアカウントごと: トークン（ファイル）の残りで 1 つ目と別の値になり、一覧の写しはアカウントの名前のファイル
    await fs.writeFile(path.join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ fake: true, remaining: 0.25 }));
    const usage = await bound.usage();
    assert.equal(usage.attempted, true);
    assert.ok(usage.windows.some(w => w.usedPercent === 75), JSON.stringify(usage.windows));
    const list = await bound.models(work, { refresh: true });
    assert.ok(Object.keys(list).length > 1, 'the account model list was fetched');
    const cacheDir = (await import('../../core/backends/antigravity-store.mjs')).dir();
    assert.ok((await fs.readdir(cacheDir)).includes('models-' + id + '.json'), 'a per-account models cache');
    assert.ok(!(await fs.readdir(cacheDir)).includes('models.json'), 'the first account cache is not written');
    assert.equal(await bound.validModel(Object.keys(list).find(k => k)), true);
    // 印が出ない版の使用量は採らない（鍵束＝1 つ目の値かもしれない）
    process.env.FAKE_AGY_NO_FILE_MARKER = '1';
    await assert.rejects(bound.usage(), e => e.code === 'AGY_FILE_STORAGE_UNSUPPORTED');
    delete process.env.FAKE_AGY_NO_FILE_MARKER;
    // トークンが無いアカウントは起こさず「ログインが要る」
    const ghost = { id: 'acct-cccccccccccc', name: 'G', dir: path.join(root, 'accounts', 'antigravity', 'acct-cccccccccccc') };
    await fs.mkdir(ghost.dir, { recursive: true });
    assert.equal((await backend.usage({ account: ghost })).reason, 'no-login');
    t.ok('Usage and the model list are read per account with the file-storage env and the marker check', true);

    // 印が出ない版: 会話も prompt を送らずに止まる（鍵束へ黙って戻さない）
    process.env.FAKE_AGY_NO_FILE_MARKER = '1';
    await fs.rm(process.env.FAKE_AGY_ACP_LOG, { force: true });
    await assert.rejects(bound.runTurn({ prompt: 'hello', cwd: work, mode: 'default', emit: () => {}, sessionId: 'agy-acct-turn-2' }), e => e.code === 'AGY_FILE_STORAGE_UNSUPPORTED');
    assert.ok(!(await sent()).includes('session/prompt'), 'no prompt was sent without the marker');
    delete process.env.FAKE_AGY_NO_FILE_MARKER;
    await bound.accountDispose();
    t.ok('A logged-in second account runs a turn under the file-storage launch and the keychain stays untouched', true);

    // ---- 版が違って印が出ない: authenticate を送らず、止める
    const second = { id: 'acct-aaaaaaaaaaaa', name: 'B', dir: path.join(root, 'accounts', 'antigravity', 'acct-aaaaaaaaaaaa') };
    process.env.FAKE_AGY_NO_FILE_MARKER = '1';
    await fs.rm(process.env.FAKE_AGY_ACP_LOG, { force: true });
    await assert.rejects(accounts.loginAgyAccount({ account: second, dataDir: root, markerMs: 300 }), e => e.code === 'AGY_FILE_STORAGE_UNSUPPORTED');
    assert.ok(!(await sent()).includes('authenticate'));
    assert.equal(await fs.stat(keychain).catch(() => null), null);
    delete process.env.FAKE_AGY_NO_FILE_MARKER;
    t.ok('Without the marker the login stops with AGY_FILE_STORAGE_UNSUPPORTED and never sends authenticate', true);

    // ---- agy がログインを断る（実機 1.5.17 の oauth-business・Enterprise の契約なし）: 理由がログインの段の文に出て、トークンは残らない
    const refused = { id: 'acct-dddddddddddd', name: 'D', dir: path.join(root, 'accounts', 'antigravity', 'acct-dddddddddddd') };
    process.env.FAKE_AGY_AUTH_REFUSE = "Couldn't sign in: no Gemini Enterprise license found for this account; configure gcp.project and gcp.location in settings.json\n\tsee https://example.invalid/docs?token=abc";
    await assert.rejects(accounts.loginAgyAccount({ account: refused, dataDir: root, method: 'oauth-business' }), e => {
      assert.equal(e.code, 'AGY_LOGIN_REFUSED');
      assert.match(e.message, /no Gemini Enterprise license found/);
      assert.ok(!/[\n\t]/.test(e.message) && !e.message.includes('token=abc'), 'one line, no URL query');
      return true;
    });
    assert.equal(await accounts.hasAgyToken(refused, root), false);
    delete process.env.FAKE_AGY_AUTH_REFUSE;
    const { authRefusalReason } = acp;
    assert.equal(authRefusalReason('x'.repeat(10) + ' ' + 'y'.repeat(400)).length <= 300, true);
    t.ok('When agy refuses the sign-in, its reason reaches the login step as one short line and no token is kept', true);

    // ---- 取消: ブラウザー待ちの途中で止める。URL は agy が stderr に出したときだけ流す
    const third = { id: 'acct-bbbbbbbbbbbb', name: 'C', dir: path.join(root, 'accounts', 'antigravity', 'acct-bbbbbbbbbbbb') };
    process.env.FAKE_AGY_AUTH_HOLD_MS = '60000';
    await fs.rm(process.env.FAKE_AGY_ACP_LOG, { force: true });
    const controller = new AbortController(), seen = [];
    const pending = accounts.loginAgyAccount({ account: third, dataDir: root, signal: controller.signal, emit: e => seen.push(e) });
    const rejected = assert.rejects(pending, e => e.code === 'CANCELLED');
    for (let i = 0; i < 100 && !seen.some(e => e.url); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(seen.find(e => e.url)?.url ?? '', /^https:\/\/accounts\.example\.invalid\//);
    controller.abort();
    await rejected;
    delete process.env.FAKE_AGY_AUTH_HOLD_MS;
    t.ok('Cancelling while waiting for the browser rejects with CANCELLED; the URL comes only from agy output', true);

    // ---- 取消: プロセスが止まる
    const pids = JSON.parse(await fs.readFile(process.env.FAKE_AGY_PID_FILE, 'utf8'));
    assert.ok(pids.length >= 1);
    for (const pid of pids) {
      let alive = true;
      for (let i = 0; i < 200 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); } catch { alive = false; } }
      assert.equal(alive, false, `agy ${pid} stopped`);
    }
    t.ok('The agy processes of finished and refused logins are stopped', true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(data, { recursive: true, force: true });
    const root = (await import('../../core/store.mjs')).dataDir;
    for (const id of made) await fs.rm(path.join(root, 'accounts', 'antigravity', id), { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run({ ok: (label, value) => { assert.ok(value, label); console.log(`ok - ${label}`); } }); }
  finally { await cleanupTestData(); }
}
