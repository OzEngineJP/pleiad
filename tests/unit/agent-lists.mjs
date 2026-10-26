// エージェントの一覧への入れ忘れを捕まえる lint（tests/lint-agent-lists.mjs）と、
// README・AGENTS.md がエージェントの記述（core/backends/agents.mjs）とずれていないことの試験。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lintRepo, scanCollections, ROOT } from '../lint-agent-lists.mjs';
import { AGENTS, DEFAULT_AGENT_IDS } from '../../core/backends/agents.mjs';

export const name = 'agent-lists';
export const title = 'エージェントの一覧への入れ忘れ（core/backends/ の外の一覧・README・AGENTS.md）';

const backendLabel = (id) => {
  const src = readFileSync(path.join(ROOT, 'core', 'backends', AGENTS[id].module), 'utf8');
  return src.match(new RegExp(`\\bid:\\s*['"]${id}['"][\\s\\S]{0,400}?label:\\s*['"]([^'"]+)['"]`))?.[1] ?? null;
};

export default async function (t) {
  const { problems } = lintRepo();
  t.ok('core/backends/ の外のエージェントの id をキー・要素にする一覧は、全エージェントを持つか理由を宣言してある',
    problems.length === 0, problems.map((p) => p.message).join('\n'));

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const id of DEFAULT_AGENT_IDS) {
    const names = [backendLabel(id), AGENTS[id].shortLabel].filter(Boolean);
    t.ok(`README に ${id} の名前（${names.join(' / ')}）がある`,
      names.some((n) => readme.includes(n)), 'エージェントを足したら README の名簿にも足す');
  }

  const agents = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  for (const id of DEFAULT_AGENT_IDS) {
    const env = AGENTS[id].cli?.binEnv;
    if (!env) continue;
    t.ok(`AGENTS.md に ${id} の実行ファイルの環境変数（${env}）の行がある`,
      agents.includes(env), 'エージェントを足したら AGENTS.md の環境変数の表にも足す');
  }

  // lint の自己診断: 拾える形・許可・見逃しを確かめる
  const fails = [];
  const src = [
    `import { HOOK_AGENTS } from '../core/hooks-config.mjs';`,
    `const A = ['claude', 'codex'];`,                                  // 部分一覧 → 拾う
    `const B = [['claude', 'x'], ['codex', 'y'], ['antigravity', 'z'], ['opencode', 'w'], ['devin', 'v'], ['grok', 'u']];`,  // 全部 → 通る
    `const C = { claude: 1, codex: 2 };`,                              // キーの一覧 → 拾う
    `function f() { const claude = 1; const out = []; }`,              // ブロック・1 個だけ → 拾わない
    `const D = [...HOOK_AGENTS, ['opencode', 'x'], ['grok', 'y']];`,   // 参照の解決 → 拾う（HOOK_AGENTS は import 先）
    `const E = x === 'claude' && y === 'codex';`,                      // 比較 → 拾わない
  ].join('\n');
  const { collections, decls, imports } = scanCollections(src);
  const got = collections.filter((c) => c.set.size >= 2).map((c) => [...c.set].sort().join(',')).sort();
  const want = ['claude,codex', 'claude,codex', 'antigravity,claude,codex,devin,grok,opencode', 'grok,opencode'].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`拾った一覧が違う: ${JSON.stringify(got)}`);
  }
  if (!decls.has('A') || ![...decls.get('A').all].includes('claude')) fails.push('decl A が無い');
  if (!imports.has('HOOK_AGENTS')) fails.push('import の記録が無い');
  for (const f of fails) t.ok(`lint の自己診断: ${f}`, false);
  if (!fails.length) t.ok('lint の自己診断', true);
}
