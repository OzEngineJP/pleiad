import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'antigravity-accounts';
export const title = 'Antigravity second accounts: hooks, guards without a token, and existing usage preserved';

const fake = fileURLToPath(new URL('../lib/fake-agy.mjs', import.meta.url));

export default async function run(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-accounts-'));
  const argsFile = path.join(dir, 'args.json');
  const env = {
    AGENT_HOST_AGY_BIN: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`,
    AGENT_HOST_DATA: dir,   // 一覧の写し（antigravity/models.json）をこの試験の置き場に向ける
    FAKE_AGY_ARGS_FILE: argsFile,
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    // モジュールのキャッシュを別にして、他の試験が残した見通し（authGuess）・一覧 cache の影響を受けない
    const { backend } = await import(`../../core/backends/antigravity.mjs?re=accounts-${Date.now()}`);
    const { legacyCapabilities } = await import('../../core/backends/contract.mjs');
    const root = (await import('../../core/store.mjs')).dataDir;
    const id = 'acct-0123456789ab';
    const account = { id, name: 'A', dir: path.join(root, 'accounts', 'antigravity', id),
      get credential() { throw new Error('secret-sentinel must never be read'); } };
    const emissions = [];
    assert.ok(legacyCapabilities(backend.capabilities).accounts);
    assert.equal(backend.capabilities.accounts, 'agent');
    for (const hook of ['forAccount', 'accountStatus', 'accountLogin', 'accountRemove', 'accountDispose']) assert.equal(typeof backend[hook], 'function', hook);
    // 指定があるのに id が無いものは、1 つ目のログインへ黙って落とさず断る
    for (const selected of [{}, '', false]) {
      if (selected === '' || selected === false) continue;   // 空文字・false は「指定なし」と同じ扱い（呼び出し側の account は null か台帳の 1 件）
      await assert.rejects(backend.runTurn({ account: selected, emit: event => emissions.push(event) }), error => error.code === 'AGY_ACCOUNT_INVALID');
    }
    await assert.rejects(backend.forAccount({}), error => error.code === 'AGY_ACCOUNT_INVALID');
    t.ok('An account without an id is refused instead of falling back to the first login', true);

    // 置き場が無い・トークンが無いアカウントは、agy を起こさずに「ログインが要る」で断る
    await assert.rejects(backend.runTurn({ account, emit: event => emissions.push(event) }), error => !error.message.includes('secret-sentinel'));
    await fs.mkdir(account.dir, { recursive: true });
    await assert.rejects(backend.runTurn({ account, emit: event => emissions.push(event) }), error => error.code === 'AGY_NOT_LOGGED_IN' && !error.message.includes('secret-sentinel'));
    assert.deepEqual(emissions.filter(event => event.type === 'auth'), [], 'no terminal-command login card for a second account');
    assert.ok(!(await fs.readFile(argsFile, 'utf8').catch(() => '')).includes('acp'), 'agy acp was never started (only the version check ran)');
    const bound = await backend.forAccount(account);
    assert.deepEqual(await bound.accountStatus(), { hasCredential: false });
    assert.deepEqual(await bound.auth.status(), { loggedIn: false, account: null });
    await assert.rejects(bound.runTurn({ emit: event => emissions.push(event) }), error => error.code === 'AGY_NOT_LOGGED_IN');
    t.ok('A second account with no token fails with AGY_NOT_LOGGED_IN, reads no credential and starts no agy', true);

    // 消す: 生きた agy が無ければそのまま通り、ログイン中の間は断る
    await bound.accountRemove();
    await assert.rejects(backend.accountRemove({}), /dedicated/);
    t.ok('Removing an account with nothing running succeeds', true);

    await fs.rm(argsFile, { force: true });   // ここから先は 1 つ目の使用量の呼び出しだけを数える
    const usage = await backend.usage();
    assert.deepEqual(Object.keys(usage).sort(), ['attempted', 'message', 'windows']);
    assert.equal(usage.windows.length, 3);
    assert.equal(usage.windows[2].usedPercent, 100);
    assert.equal(typeof usage.message, 'string');
    // 使用量が読めた＝ログイン済みが確かめられたので、一覧（写しも無い）が無ければ裏で 1 回取りに行く（この呼び出しは待たない）
    let args;
    for (let i = 0; i < 100 && (args = JSON.parse(await fs.readFile(argsFile, 'utf8'))).length < 3; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(args.length, 3);
    assert.deepEqual(args[0], ['--version']);
    assert.deepEqual(args[1], ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s']);
    assert.equal(args[2][0], '--log-file');
    assert.equal(args[2].at(-1), 'models');
    // 一覧の写し（取れた時刻付き）は使い捨ての置き場に入る（利用者の本物の置き場ではない）
    for (let i = 0; i < 100 && !(await fs.readdir(dir)).includes('antigravity'); i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual((await fs.readdir(dir)).filter(n => n !== 'accounts').sort(), ['antigravity', 'args.json']);
    t.ok('Existing live usage retains its shape, executes only version and read-only usage commands, then warms the missing catalog once', true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join((await import('../../core/store.mjs')).dataDir, 'accounts', 'antigravity', 'acct-0123456789ab'), { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run({ ok: (label, value) => { assert.ok(value, label); console.log(`ok - ${label}`); } }); }
  finally { await cleanupTestData(); }
}
