import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_SUMMARY_KEY,
  docItemKey,
  emptyDocAgentsConfig,
  normalizeDocAgentsConfig,
} from '../../core/context-agents.mjs';
import {
  buildDocMatrix,
  snapshotBaselineAgents,
} from '../../core/context-doc-matrix.mjs';
import {
  DEFAULT_SOURCES,
  VERSION as SCANS_VERSION,
  defaultKind,
  pathKey,
} from '../../core/context-settings.mjs';
import {
  AGENTS as PLY_AGENTS,
  changePlyInstructions,
  normalizePlyInstructions,
  screenState,
} from '../../core/ply-instructions.mjs';

export const name = 'context-doc-matrix';
export const title = 'Stage 2 一覧構築・初回スナップショット・同名Skill優先・Pleiadの指示Grok解放';

export default async function (t) {
  const home = path.join(os.tmpdir(), 'ply-doc-matrix-home');
  const repo = path.join(os.tmpdir(), 'ply-doc-matrix-repo');
  const mkInst = (p, source, scope) => ({
    id: `id:${path.basename(path.dirname(p))}/${path.basename(p)}`,
    kind: 'instruction', name: path.basename(p), path: p, realPath: p,
    scope, appliesTo: scope === 'user' ? null : repo,
    tokens: 12, bytes: 48, content: '# Inst', status: 'candidate',
    origins: [{ path: p, source, scope }],
  });
  const mkSkill = (skillName, p, source, scope, status = 'candidate') => ({
    id: `skill:${source}:${scope}:${skillName}`,
    kind: 'skill', name: skillName, path: p, realPath: p,
    scope, appliesTo: scope === 'user' ? null : repo,
    description: `${skillName} desc`, tokens: 8, bytes: 32, content: '---\nname: ' + skillName + '\n---\nbody',
    status,
    origins: [{ path: p, source, scope }],
  });

  const userClaude = mkInst(path.join(home, '.claude', 'CLAUDE.md'), 'claude', 'user');
  const userCodex = mkInst(path.join(home, '.codex', 'AGENTS.md'), 'codex', 'user');
  const userGemini = mkInst(path.join(home, '.gemini', 'GEMINI.md'), 'antigravity', 'user');
  const userDevin = mkInst(path.join(home, 'AppData', 'Roaming', 'devin', 'AGENTS.md'), 'devin', 'user');
  const wsClaude = mkInst(path.join(repo, '.claude', 'rules', 'guide.md'), 'claude', 'directory');
  const wsAgents = mkInst(path.join(repo, 'AGENTS.md'), 'common', 'directory');

  const nativeRaw = {
    version: SCANS_VERSION,
    defaults: { kinds: { instruction: defaultKind(), skill: defaultKind(), mcp: defaultKind() }, roots: { instruction: [], skill: [], mcp: [] } },
    places: {},
  };
  const plyRule = { owner: 'ply', user: { sources: ['common', 'claude', 'codex'], excludePaths: [] }, directory: { sources: ['common', 'claude'], excludePaths: [] } };
  const plyDefaultsRaw = {
    version: SCANS_VERSION,
    defaults: { kinds: { instruction: plyRule, skill: plyRule, mcp: defaultKind() }, roots: { instruction: [], skill: [], mcp: [] } },
    places: {},
  };

  // ---- buildDocMatrix ロック判定・summaryRow
  const mNative = buildDocMatrix({
    kind: 'instruction',
    entries: [userClaude, userCodex, userGemini, userDevin, wsClaude, wsAgents],
    legacyConfig: nativeRaw,
    docAgentsConfig: emptyDocAgentsConfig(),
    cwd: repo,
    home,
  });
  t.ok('未操作時は touched が false、agents は 6 エージェント',
    !mNative.touched && mNative.agents.join(',') === 'claude,codex,antigravity,opencode,devin,grok');
  t.ok('summaryRow(__workspace__): 指示は Grok だけ workspace ロック on、Skill は Devin と Grok が workspace ロック on',
    mNative.summaryRow.cells.grok.locked && mNative.summaryRow.cells.grok.reason === 'workspace' && !mNative.summaryRow.cells.codex.locked);

  const clRow = mNative.byKey.get(docItemKey(userClaude));
  const cxRow = mNative.byKey.get(docItemKey(userCodex));
  const agyRow = mNative.byKey.get(docItemKey(userGemini));
  const dvRow = mNative.byKey.get(docItemKey(userDevin));
  t.ok('Claude ユーザー指示: Claude=native ON, Grok=own ロック ON, 他は toggle OFF',
    clRow.cells.claude.on && !clRow.cells.claude.locked && clRow.cells.grok.locked && clRow.cells.grok.reason === 'own'
    && !clRow.cells.codex.on && !clRow.cells.codex.locked);
  t.ok('Codex ユーザー指示: Codex=native ON, Grok=relay ロック OFF',
    cxRow.cells.codex.on && cxRow.cells.grok.locked && cxRow.cells.grok.reason === 'relay' && !cxRow.cells.grok.on);
  t.ok('Antigravity ~/.gemini/GEMINI.md: Antigravity=own ロック ON',
    agyRow.cells.antigravity.locked && agyRow.cells.antigravity.reason === 'own' && agyRow.cells.antigravity.on);
  t.ok('Devin ユーザー自身のパス: Devin=own ロック ON、.agents/skills はロック',
    dvRow.cells.devin.locked && dvRow.cells.devin.reason === 'own' && dvRow.cells.devin.on);

  // ---- 同名 Skill の prefer 優先と重なり
  const dupClaude = mkSkill('build', path.join(repo, '.claude', 'skills', 'build', 'SKILL.md'), 'claude', 'directory', 'shadowed');
  const dupAgents = mkSkill('build', path.join(repo, '.agents', 'skills', 'build', 'SKILL.md'), 'common', 'directory', 'candidate');
  const preferConfig = {
    version: SCANS_VERSION,
    defaults: { kinds: { instruction: defaultKind(), skill: { owner: 'ply', user: { sources: [...DEFAULT_SOURCES], excludePaths: [] }, directory: { sources: [...DEFAULT_SOURCES], excludePaths: [] }, prefer: { build: dupClaude.path } }, mcp: defaultKind() }, roots: { instruction: [], skill: [], mcp: [] } },
    places: {},
  };
  const mSkill = buildDocMatrix({
    kind: 'skill',
    entries: [dupClaude, dupAgents],
    legacyConfig: preferConfig,
    docAgentsConfig: emptyDocAgentsConfig(),
    cwd: repo,
    home,
  });
  const buildRow = mSkill.byKey.get('skill:build');
  t.ok('同名 Skill は 1 行にまとまり、prefer 指定側を chosen とし duplicates に全コピーを持つ',
    mSkill.rows.length === 1 && buildRow.chosen.path === dupClaude.path && buildRow.duplicates.length === 2
    && buildRow.cells.devin.locked && buildRow.cells.devin.reason === 'workspace');
  t.ok('Skill の summaryRow(__workspace__) は Devin と Grok が workspace ロック',
    mSkill.summaryRow.cells.devin.locked && mSkill.summaryRow.cells.devin.reason === 'workspace'
    && mSkill.summaryRow.cells.grok.locked && mSkill.summaryRow.cells.grok.reason === 'workspace');

  // ---- snapshotBaselineAgents の 3 パターンと defaults->workspace フォールバック
  const baseDefaults = snapshotBaselineAgents({
    kind: 'instruction',
    entries: [userClaude, userCodex, wsClaude, wsAgents],
    legacyConfig: plyDefaultsRaw,
    docAgentsConfig: emptyDocAgentsConfig(),
    place: null,
    home,
  });
  t.ok('defaults 初回スナップショットは __workspace__ と user 行だけ写し、directory 行を含まない',
    Object.hasOwn(baseDefaults, WORKSPACE_SUMMARY_KEY)
    && Object.hasOwn(baseDefaults, docItemKey(userClaude))
    && !Object.hasOwn(baseDefaults, docItemKey(wsClaude)));

  // defaults を 1 件だけ触った後でも、未変更の directory 行が旧 ply spread と除外を受け継ぐこと
  const cfgDefaultsTouched = normalizeDocAgentsConfig({
    version: 1,
    defaults: { instruction: { agents: { ...baseDefaults, [docItemKey(userClaude)]: { off: ['claude'], spread: [] } } } },
    places: {},
  });
  const wsAfterDefaultsTouch = buildDocMatrix({
    kind: 'instruction',
    entries: [userClaude, wsClaude, wsAgents],
    legacyConfig: plyDefaultsRaw,
    docAgentsConfig: cfgDefaultsTouched,
    cwd: repo,
    home,
  });
  t.ok('defaults を 1 件触っても未編集の directory 行は旧 ply の広げと __workspace__ を保つ',
    wsAfterDefaultsTouch.byKey.get(docItemKey(wsClaude)).cells.codex.on === true
    && wsAfterDefaultsTouch.byKey.get(docItemKey(wsClaude)).cells.codex.mode === 'spread');

  // defaults が既に touched の場所では snapshotBaselineAgents(place: repo) は空から始める（動的継承を壊さない）
  const baseRepoAfterDefaults = snapshotBaselineAgents({
    kind: 'instruction',
    entries: [userClaude, wsClaude, wsAgents],
    legacyConfig: plyDefaultsRaw,
    docAgentsConfig: cfgDefaultsTouched,
    place: repo,
    home,
  });
  t.ok('defaults で既に Stage 2 化済みの場所の初回 place スナップショットは空（動的継承維持）',
    Object.keys(baseRepoAfterDefaults).length === 0);

  // defaults 未操作で place を初めて触ると directory 行の現在状態を写す
  const baseRepoFresh = snapshotBaselineAgents({
    kind: 'instruction',
    entries: [userClaude, wsClaude, wsAgents],
    legacyConfig: plyDefaultsRaw,
    docAgentsConfig: emptyDocAgentsConfig(),
    place: repo,
    home,
  });
  t.ok('defaults 未操作の place 初回スナップショットはその場所の directory 行のルールを写す',
    Object.hasOwn(baseRepoFresh, docItemKey(wsClaude)) && baseRepoFresh[docItemKey(wsClaude)].spread.includes('codex'));

  // ---- Pleiad の指示（Grok 解放・委譲と連動だけ別扱い・toggleAgent）
  const initList = normalizePlyInstructions(null, null, 'ja');
  const st = screenState(initList, 'ja', { routing: true });
  t.ok('Pleiad の指示 screenState は全 6 エージェントを含む',
    st.agents.map((a) => a.id).join(',') === PLY_AGENTS.join(','));
  const addedList = changePlyInstructions(initList, {
    action: 'save',
    name: 'テスト指針',
    body: '常に簡潔に答える',
    target: 'all',
    agents: ['claude'],
  }, 'ja');
  const custom = addedList.find((i) => i.name === 'テスト指針');
  const grokOn = changePlyInstructions(addedList, {
    action: 'toggleAgent',
    id: custom.id,
    agent: 'grok',
    on: true,
  }, 'ja');
  t.ok('Pleiad の指示は Grok を直接オンにできる',
    grokOn.find((i) => i.id === custom.id).agents.includes('grok'));

  const onlyClaudeOff = changePlyInstructions(addedList, {
    action: 'toggleAgent',
    id: custom.id,
    agent: 'claude',
    on: false,
  }, 'ja');
  t.ok('最後の 1 つをオフにすると行全体が on: false になる',
    onlyClaudeOff.find((i) => i.id === custom.id).on === false);

  const reactivateGrok = changePlyInstructions(onlyClaudeOff, {
    action: 'toggleAgent',
    id: custom.id,
    agent: 'grok',
    on: true,
  }, 'ja');
  t.ok('行全体が off のとき Grok を押すと on: true になり agents が [grok] に切り替わる',
    reactivateGrok.find((i) => i.id === custom.id).on === true
    && reactivateGrok.find((i) => i.id === custom.id).agents.join(',') === 'grok');
}
