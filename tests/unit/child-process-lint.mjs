// 子を起こす API の lint（ADR 0270 の規則 ①。tests/lint-child-process.mjs のラチェット）と、その自己診断。
// 長く生きる子は保持役でしか起こさない。直に child_process・utilityProcess.fork を読んでよいのは口だけ。
import { lintRepo, selftest, MOUTH } from '../lint-child-process.mjs';

export const name = 'child-process-lint';
export const title = '子を起こす API を読んでよいのは口（core/process.mjs・desktop/process.cjs）だけ（移行中は基準。増えたら落ちる）';

export default async function (t) {
  const result = lintRepo();
  t.ok(`口（${MOUTH.join('・')}）の外で子を起こす API を直に読むファイルが、基準（${result.baselineCount} ファイル）を超えない（移行中 ${result.migrating.length} ファイル。段 4 の終わりに空にする）`,
    result.problems.length === 0, result.problems.map((problem) => problem.message).join('\n'));
  t.ok('口は基準（移行中）に載っていない', !Object.keys(result.baseline).some((file) => MOUTH.includes(file)), Object.keys(result.baseline).filter((file) => MOUTH.includes(file)).join(' / '));
  const fails = selftest();
  t.ok('lint の自己診断', fails.length === 0, fails.join(' / '));
}
