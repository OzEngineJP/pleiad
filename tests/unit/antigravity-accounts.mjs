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
    FAKE_AGY_ARGS_FILE: argsFile,
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const { backend } = await import('../../core/backends/antigravity.mjs');
    const account = { id: 'acct-a', name: 'A', dir: path.join(dir, 'account-a'),
      get credential() { throw new Error('secret-sentinel must never be read'); } };
    const emissions = [];
    assert.equal(backend.capabilities.accounts, false);
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
    assert.deepEqual(Object.keys(usage).sort(), ['message', 'windows']);
    assert.equal(usage.windows.length, 3);
    assert.equal(usage.windows[2].usedPercent, 100);
    assert.equal(typeof usage.message, 'string');
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
    assert.equal(args.length, 2);
    assert.deepEqual(args[0], ['--version']);
    assert.deepEqual(args[1], ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s']);
    assert.deepEqual(await fs.readdir(dir), ['args.json']);
    t.ok('Existing live usage retains its shape and only executes version and read-only usage commands', true);
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
