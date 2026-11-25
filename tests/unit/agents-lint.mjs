// エージェントの種類の漏れの lint（tests/lint-agents.mjs）: 規則 1 id-literal（直書きを増やさない。ラチェット）・
// 規則 2 agent-list（一覧の入れ忘れ）と、README・AGENTS.md がエージェントの記述（core/backends/agents.mjs）とずれていないこと。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lintIds, lintLists, selftest, ROOT } from '../lint-agents.mjs';
import { AGENTS, DEFAULT_AGENT_IDS } from '../../core/backends/agents.mjs';

export const name = 'agents-lint';
export const title = 'エージェントの種類の漏れ（core/backends/ の外の id の直書き・一覧の入れ忘れ・README・AGENTS.md）';

const backendLabel = (id) => {
  const src = readFileSync(path.join(ROOT, 'core', 'backends', AGENTS[id].module), 'utf8');
  return src.match(new RegExp(`\\bid:\\s*['"]${id}['"][\\s\\S]{0,400}?label:\\s*['"]([^'"]+)['"]`))?.[1] ?? null;
};

export default async function (t) {
  const ids = lintIds();
  t.ok('id-literal: core/backends/ の外のエージェントの id の直書きと backend-allow の印が基準（tests/backends-baseline.json）を超えず、減った分は基準を下げてあり、死んだ印が無い',
    ids.problems.length === 0, ids.problems.map((p) => p.message).join('\n'));

  const lists = lintLists();
  t.ok('agent-list: core/backends/ の外のエージェントの id をキー・要素にする一覧は、全エージェントを持つか理由を宣言してある',
    lists.problems.length === 0, lists.problems.map((p) => p.message).join('\n'));

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const id of DEFAULT_AGENT_IDS) {
    const names = [backendLabel(id), AGENTS[id].shortLabel].filter(Boolean);
    t.ok(`README に ${id} の名前（${names.join(' / ')}）がある`,
      names.some((n) => readme.includes(n)), 'エージェントを足したら README の名簿にも足す');
  }

  const agentsMd = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  for (const id of DEFAULT_AGENT_IDS) {
    const env = AGENTS[id].cli?.binEnv;
    if (!env) continue;
    t.ok(`AGENTS.md に ${id} の実行ファイルの環境変数（${env}）の行がある`,
      agentsMd.includes(env), 'エージェントを足したら AGENTS.md の環境変数の表にも足す');
  }

  const fails = selftest();
  t.ok('lint の自己診断', fails.length === 0, fails.join(' / '));
}
