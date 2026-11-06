import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { antigravityQuota, supportsUsage, readAntigravityUsage } from '../../core/backends/antigravity-usage.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'antigravity-usage';
export const title = 'Antigravity の共有枠・読み取り専用取得・旧版保護';
export default async function(t) {
  for (const version of ['1.1.11', '1.2.5', 'v2.0.0']) assert.equal(supportsUsage(version), true);
  for (const version of ['1.1.10', '0.9.99', '', 'unknown', '1.2.5-preview']) assert.equal(supportsUsage(version), false);
  const payload = buckets => ({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets }] } } });
  const quota = antigravityQuota(payload([
    { window: 'weekly', remaining_fraction: .25, reset_time: '2030-01-01T00:00:00Z' },
    { window: '5h', remaining_fraction: 1 }, { remaining_fraction: 0 },
    {}, { remaining_fraction: -1 }, { remaining_fraction: 2 }, { remaining_fraction: '0.5', reset_time: 'bad' },
  ]));
  assert.equal(quota.windows[0].usedPercent, 75);
  assert.equal(quota.windows[0].minutes, 10080);
  assert.equal(quota.windows[0].resetsAt, '2030-01-01T00:00:00.000Z');
  assert.equal(quota.windows[1].remainingPercent, 100);
  assert.equal(quota.windows[2].remainingPercent, 0);
  for (const w of quota.windows.slice(3)) assert.equal(w.remainingPercent, null);
  assert.equal(quota.windows[6].resetsAt, null);
  assert.throws(() => antigravityQuota({ ...payload([]), num_turns: 1 }));
  assert.throws(() => antigravityQuota({ status: 'SUCCESS', response: 'made-up usage' }));
  assert.match(antigravityQuota(payload([])).message, /返されません/);
  t.ok('共有グループ・期間・欠損・上限到達を区別し、モデルの回答を使用枠として扱わない', true);

  // 1.5.2 の形: 'All Models' の 1 グループに、モデルと段ごとのバケット（window が無い）。リセットは 1970-01-01（時刻なし）
  const tiered = (name, id, fractions, reset = '1970-01-01T00:00:00Z') => Object.entries(fractions)
    .map(([tier, remaining_fraction]) => ({ id: `${id}-${tier.toLowerCase()}`, name: `${name} (${tier})`, remaining_fraction, reset_time: reset }));
  const perModel = antigravityQuota({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [{ name: 'All Models', buckets: [
    ...tiered('Gemini 3.8 Flash', 'gemini-3.8-flash', { High: 1, Medium: .4, Low: 1 }),
    ...tiered('Gemini 3.1 Pro', 'gemini-3.1-pro', { Low: 1, High: 1 }),
    ...tiered('Claude Opus 5.5', 'claude-opus-5-5', { Max: .9, High: .9 }, '2030-01-02T00:00:00Z'),
    { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)', remaining_fraction: .9, reset_time: '2030-01-01T00:00:00Z' },
    { id: 'gemini-9-medium', remaining_fraction: 'x' },
  ] }] } } });
  assert.deepEqual(perModel.windows.map(w => w.label), ['Gemini 3.8 Flash', 'Gemini 3.1 Pro', 'Claude Opus 5.5', 'gemini-9']);
  assert.deepEqual(perModel.windows.map(w => w.group), perModel.windows.map(w => w.label));
  assert.deepEqual(perModel.windows.map(w => w.remainingPercent), [40, 100, 90, null]);
  assert.deepEqual(perModel.windows.map(w => w.resetsAt), [null, null, '2030-01-01T00:00:00.000Z', null]);
  assert.ok(perModel.windows.every(w => w.minutes === null));
  assert.match(perModel.message, /3 つに分かれ/);
  assert.equal(antigravityQuota(payload([{ window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }])).windows[0].resetsAt, null);
  t.ok('モデルごとのバケットは段を外した系統ごとに 1 行（残りの最小・最早のリセット）。1970-01-01 のリセットは不明', true);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-usage-'));
  const fake = path.resolve('tests/lib/fake-agy.mjs');
  let server, client;
  try {
    const argsFile = path.join(dir, 'args.json');
    server = await startServer({ dataDir: path.join(dir, 'data'), env: {
      AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: `node "${fake}"`, FAKE_AGY_ARGS_FILE: argsFile,
    } });
    client = await open({ port: server.port, token: server.token });
    const result = await client.cmd('providerUsage', { backend: 'antigravity' });
    assert.equal(result.quota.windows.length, 3);
    assert.equal(result.quota.windows[2].usedPercent, 100);
    assert.ok(result.quota.checkedAt);
    assert.equal(result.local.fiveHour.turns, 0);
    await client.cmd('providerUsage', { backend: 'antigravity' });
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
    assert.equal(args.filter(a => a.includes('/usage')).length, 1);
    assert.ok(!args.some(a => a.includes('--dangerously-skip-permissions')));
    t.ok('WebSocketから使用枠を取得し、実行実績を増やさずキャッシュする', true);

    const script = path.join(dir, 'old.mjs');
    await fs.writeFile(script, "if (process.argv.includes('--version')) console.log('1.1.10'); else { console.log('unexpected prompt'); process.exit(1); }");
    assert.match((await readAntigravityUsage({ argv: [process.execPath, script] })).message, /agy update/);
    await fs.writeFile(script, "console.error('Bearer secret'); process.exit(1);");
    await assert.rejects(readAntigravityUsage({ argv: [process.execPath, script] }), e => !e.message.includes('secret'));
    await fs.writeFile(script, "setInterval(() => {}, 1000);");
    await assert.rejects(readAntigravityUsage({ argv: [process.execPath, script], timeoutMs: 100 }), /時間切れ/);
    t.ok('旧版ではプロンプトを送らず、失敗情報を秘匿し、タイムアウトで子を終了する', true);
  } finally { client?.close(); await server?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}
