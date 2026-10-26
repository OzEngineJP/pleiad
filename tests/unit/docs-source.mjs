// 公開文書（site/docs）の生成に使う core/ のファイルの一覧が、依存を辿った閉包と一致するか。
// site/tools/build-site.mjs は一覧のファイルだけをリリースのタグから取るので、足りないと公開のページが欠ける（ADR 0271・0274）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DOCS_INDEX_FILE, DOCS_SOURCE_FILES, REPO_ROOT, closureOf } from '../../site/tools/docs-sources.mjs';
import { CAPABILITY_DOCS, CAPABILITY_KEYS, TRAIT_KEYS } from '../../core/backends/capability-marks.mjs';
import { AGENT_TRAITS, CAPABILITY_STATES } from '../../core/backends/agent-marks.mjs';
import { AGENTS, DEFAULT_AGENT_IDS } from '../../core/backends/agents.mjs';

export const name = 'docs-source';
export const title = '公開文書の生成に使う core/ の一覧: 依存を辿った閉包と一致する・相対 import だけで閉じる・印の状態と説明が読める';

export default async function (t) {
  const closure = closureOf(DOCS_SOURCE_FILES);
  t.ok('一覧のファイルは実在する', DOCS_SOURCE_FILES.every((rel) => existsSync(path.join(REPO_ROOT, rel))), DOCS_SOURCE_FILES.join(', '));
  t.ok('一覧は、依存を辿った閉包と一致する（足りない・余分なファイルが無い）',
    JSON.stringify(closure.files) === JSON.stringify([...DOCS_SOURCE_FILES].sort()), JSON.stringify({ listed: DOCS_SOURCE_FILES, closure: closure.files }));
  t.ok('生成に使うファイルは、相対 import と node: の組み込みだけで閉じる',
    closure.problems.length === 0, closure.problems.join(' / '));
  t.ok('古いタグの一覧だけの生成に使うファイルは、一覧に含まれる', DOCS_SOURCE_FILES.includes(DOCS_INDEX_FILE));

  // エージェントごとのページの材料（状態・性質・説明）が、この閉包から読める
  t.ok('能力の状態が、fake を除くエージェントの全部にある',
    DEFAULT_AGENT_IDS.every((id) => CAPABILITY_STATES[id] && CAPABILITY_KEYS.every((key) => Object.hasOwn(CAPABILITY_STATES[id], key))));
  t.ok('性質が、fake を含むエージェントの全部にある',
    Object.keys(AGENTS).every((id) => AGENT_TRAITS[id] && TRAIT_KEYS.every((key) => typeof AGENT_TRAITS[id][key] === 'boolean')));
  t.ok('印の説明が、能力の全部に ja・en である',
    CAPABILITY_KEYS.every((key) => {
      const doc = CAPABILITY_DOCS[key];
      return ['ja', 'en'].every((lng) => typeof doc?.label?.[lng] === 'string' && doc.label[lng].length > 0
        && typeof doc.summary?.[lng] === 'string' && doc.summary[lng].length > 0
        && typeof doc.unavailable?.[lng] === 'string' && doc.unavailable[lng].length > 0);
    }));
  t.ok('印の説明に、能力に無いキーが無い', Object.keys(CAPABILITY_DOCS).every((key) => CAPABILITY_KEYS.includes(key)));
}
