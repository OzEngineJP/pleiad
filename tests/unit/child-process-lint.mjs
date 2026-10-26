// 子を起こす API の lint（ADR 0270 の規則 ①。tests/lint-child-process.mjs のラチェット）と、その自己診断。
// 長く生きる子は保持役でしか起こさない。直読みは口と lint 内の固定例外に限る。
import { lintRepo, selftest, MOUTH, SPAWN_CHILD_EXCEPTIONS } from '../lint-child-process.mjs';

export const name = 'child-process-lint';
export const title = '生の子起動 API は口と固定例外だけが使える';

export default async function (t) {
  const result = lintRepo();
  t.ok(`生の child_process API は口（${MOUTH.join('・')}）と hook-adapter 以外で読まない`,
    result.problems.length === 0, result.problems.map((problem) => problem.message).join('\n'));
  t.ok(`spawnChild の固定例外は ${Object.keys(SPAWN_CHILD_EXCEPTIONS).length} ファイル`,
    Object.keys(result.spawnChildImports).every((file) => Object.hasOwn(SPAWN_CHILD_EXCEPTIONS, file)), Object.keys(result.spawnChildImports).join(' / '));
  const fails = selftest();
  t.ok('lint の自己診断', fails.length === 0, fails.join(' / '));
}
