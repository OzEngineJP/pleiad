import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../../core/process.mjs';

export const name = 'process-exit';
export const title = 'プロセスの終了処理: 待ち受けの共有・解除・登録順・自然終了';

export default async function (t) {
  const child = fileURLToPath(new URL('../lib/process-exit-child.mjs', import.meta.url));
  const result = await run(process.execPath, [child], { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 7, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, { code: 7, seen: Array.from({ length: 20 }, (_, i) => [i, 7]).filter(([i]) => i !== 5) });
  t.ok('20 個の終了処理を 1 本で待ち、解除した処理を除いて自然終了時に登録順に呼ぶ', true);
}
