import { cleanupTestData } from '../lib/test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'antigravity-accounts';
export const title = 'Antigravity rejects explicit accounts without authentication and preserves existing usage';

const fake = fileURLToPath(new URL('../lib/fake-agy.mjs', import.meta.url));
const unsupported = error => error.code === 'AGY_ACCOUNTS_UNSUPPORTED' && !error.message.includes('secret-sentinel');

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
    const account = { id: 'acct-a', name: 'A', dir: path.join(dir, 'account-a'),
      get credential() { throw new Error('secret-sentinel must never be read'); } };
    const emissions = [];
    assert.equal(legacyCapabilities(backend.capabilities).accounts, false);
    for (const selected of [account, {}, '', false]) {
      await assert.rejects(backend.runTurn({ account: selected, emit: event => emissions.push(event) }), unsupported);
    }
    t.ok('Explicit accounts fail clearly instead of falling back to the current login', true);

    let holderWrites = 0;
    await assert.rejects(backend.adoptTurn({ account, card: { held: true, agy: {} },
      source: { write() { holderWrites++; } }, emit: event => emissions.push(event) }), unsupported);
    assert.equal(holderWrites, 0);
    assert.deepEqual(emissions, []);
    assert.deepEqual(await fs.readdir(dir), []);
    t.ok('Rejection reads no credential, starts no CLI or login flow, writes no account files and never contacts the holder', true);

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
    assert.deepEqual((await fs.readdir(dir)).sort(), ['antigravity', 'args.json']);
    t.ok('Existing live usage retains its shape, executes only version and read-only usage commands, then warms the missing catalog once', true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run({ ok: (label, value) => { assert.ok(value, label); console.log(`ok - ${label}`); } }); }
  finally { await cleanupTestData(); }
}
