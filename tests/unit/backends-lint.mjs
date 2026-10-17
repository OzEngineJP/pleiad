// エージェントの id の直書きの lint（tests/lint-backends.mjs。ラチェット）と、その自己診断。
import { lintRepo, selftest } from '../lint-backends.mjs';

export const name = 'backends-lint';
export const title = 'エージェントの id の直書きを増やさない（core/backends/ の外。ラチェット）';

export default async function (t) {
  const result = lintRepo();
  t.ok('core/backends/ の外のエージェントの id の直書きが基準（tests/backends-baseline.json）を超えず、減った分は基準を下げてある',
    result.problems.length === 0, result.problems.map((p) => p.message).join('\n'));
  const fails = selftest();
  t.ok('lint の自己診断', fails.length === 0, fails.join(' / '));
}
