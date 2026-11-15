import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DOC_AGENTS_FILE,
  DOC_AGENTS_VERSION,
  MAX_AGENT_KEYS,
  MAX_PLACES,
  WORKSPACE_SUMMARY_KEY,
  countAgentKeys,
  createContextAgents,
  docAgentsFromLegacy,
  docItemKey,
  emptyDocAgentsConfig,
  evaluateDocCells,
  legacyEntryIncluded,
  normalizeDocAgentsConfig,
  resolveEffectiveDocSource,
  resolveRuleForItem,
  setDocRowRule,
  toggleDocAgentRule,
} from '../../core/context-agents.mjs';
import { docCellLock } from '../../core/backends/context-capabilities.mjs';
import { DEFAULT_SOURCES, VERSION as SCANS_VERSION, createContextSettings, defaultKind, pathKey } from '../../core/context-settings.mjs';

export const name = 'context-agents';
export const title = 'Stage 2 保存 (context-agents.json): スキーマ・キー・旧形式対応・深さ継承・ベータ31互換';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-agents-'));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'work', 'repo');
  const sub = path.join(repo, 'packages', 'app');

  try {
    // ---- スキーマ検証と正規化
    const empty = emptyDocAgentsConfig();
    t.ok('空の設定は version: 1 / defaults / places を持つ',
      empty.version === DOC_AGENTS_VERSION && typeof empty.defaults === 'object' && typeof empty.places === 'object');

    let badVersionErr = null;
    try { normalizeDocAgentsConfig({ version: 2, defaults: {}, places: {} }); } catch (e) { badVersionErr = e; }
    t.ok('未知の version は拒む', Boolean(badVersionErr));

    let unknownFieldErr = null;
    try { normalizeDocAgentsConfig({ version: 1, defaults: {}, places: {}, extra: 1 }); } catch (e) { unknownFieldErr = e; }
    t.ok('strict スキーマは余分なキーを拒む', Boolean(unknownFieldErr));

    // 上限検査: MAX_PLACES・MAX_AGENT_KEYS
    const tooManyPlaces = { version: 1, defaults: {}, places: {} };
    for (let i = 0; i <= MAX_PLACES; i++) tooManyPlaces.places[path.join(tmp, `p-${i}`)] = { instruction: { agents: {} } };
    let placesErr = null;
    try { normalizeDocAgentsConfig(tooManyPlaces); } catch (e) { placesErr = e; }
    t.ok(`places 上限 (${MAX_PLACES}) 超過を拒む`, Boolean(placesErr));

    const tooManyKeys = { version: 1, defaults: { instruction: { agents: {} } }, places: {} };
    for (let i = 0; i <= MAX_AGENT_KEYS; i++) tooManyKeys.defaults.instruction.agents[`file:/x/${i}`] = { off: ['claude'] };
    t.ok('countAgentKeys はキー総数を正しく数える', countAgentKeys(tooManyKeys) === MAX_AGENT_KEYS + 1);
    let keysErr = null;
    try { normalizeDocAgentsConfig(tooManyKeys); } catch (e) { keysErr = e; }
    t.ok(`総キー数上限 (${MAX_AGENT_KEYS}) 超過を拒む`, Boolean(keysErr));

    // ---- アイテム識別キー
    const instA = { kind: 'instruction', name: 'CLAUDE.md', path: path.join(home, '.claude', 'CLAUDE.md'), scope: 'user', origins: [{ path: path.join(home, '.claude', 'CLAUDE.md'), source: 'claude', scope: 'user' }] };
    const instB = { kind: 'instruction', name: 'CLAUDE.md', path: path.join(repo, 'link.md'), realPath: path.join(repo, 'real.md'), scope: 'directory', origins: [{ path: path.join(repo, 'link.md'), source: 'claude', scope: 'directory' }] };
    const skillA = { kind: 'skill', name: 'deploy', path: path.join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), scope: 'directory', origins: [{ path: path.join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), source: 'claude', scope: 'directory' }] };
    t.ok('Summary キーは __workspace__', docItemKey(WORKSPACE_SUMMARY_KEY) === WORKSPACE_SUMMARY_KEY);
    t.ok('Skill キーは skill:<name>', docItemKey(skillA) === 'skill:deploy');
    t.ok('指示キーは realPath 優先の file:<normalizedPath>',
      docItemKey(instA).startsWith('file:') && docItemKey(instB).endsWith('real.md') && !docItemKey(instB).includes('\\'));

    // ---- 旧形式からの写し（docAgentsFromLegacy / legacyEntryIncluded）
    const nativeRule = { owner: 'native', user: { sources: [...DEFAULT_SOURCES], excludePaths: [] }, directory: { sources: [...DEFAULT_SOURCES], excludePaths: [] } };
    const plyRule = { owner: 'ply', user: { sources: ['common', 'claude'], excludePaths: [] }, directory: { sources: ['common', 'claude', 'codex'], excludePaths: [] } };
    const plyExcludedPath = { owner: 'ply', user: { sources: ['common', 'claude', 'codex'], excludePaths: ['.claude/CLAUDE.md'] }, directory: { sources: ['common', 'claude'], excludePaths: ['blocked.md'] } };

    const fromNative = docAgentsFromLegacy('instruction', instA, nativeRule, { home, cwd: repo });
    t.ok('旧「エージェントに任せる」は off=[]・spread=[]（Grok 等ロックセル以外）',
      fromNative.off.length === 0 && fromNative.spread.length === 0);

    const fromPly = docAgentsFromLegacy('instruction', instA, plyRule, { home, cwd: repo });
    t.ok('旧「Pleiad がそろえる」はネイティブ(Claude/Devin取り込み)を除いた中継可能エージェントだけ spread に載る（Grok は載らない）',
      fromPly.off.length === 0 && ['codex', 'antigravity', 'opencode'].every((a) => fromPly.spread.includes(a))
      && !fromPly.spread.includes('devin') && !fromPly.spread.includes('grok'));

    const excludedBySource = docAgentsFromLegacy('instruction', {
      kind: 'instruction', name: 'AGENTS.md', path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user',
      origins: [{ path: path.join(home, '.codex', 'AGENTS.md'), source: 'codex', scope: 'user' }],
    }, plyRule, { home, cwd: repo });
    // ~/.codex/AGENTS.md は Codex が必ず読む（main の project_doc_max_bytes でも止まらない）ので Codex のセルは鍵（オンのまま）
    t.ok('旧「探す形式」で外していた出どころはロックなし全エージェントが off（Codex 自身の全体の指示は鍵でオンのまま）',
      excludedBySource.off.includes('claude') && !excludedBySource.off.includes('codex') && !excludedBySource.off.includes('grok')
      && docCellLock('codex', 'instruction', { kind: 'instruction', path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user', origins: [{ path: path.join(home, '.codex', 'AGENTS.md'), source: 'codex', scope: 'user' }] })?.lockedOn === true);

    t.ok('旧 excludePaths に当たるパスは legacyEntryIncluded が false',
      !legacyEntryIncluded('instruction', instA, plyExcludedPath, { home, cwd: repo }));

    t.ok('__workspace__ まとめ行は旧 directory.sources が空なら除外扱い',
      !legacyEntryIncluded('instruction', WORKSPACE_SUMMARY_KEY, { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: [], excludePaths: [] } }, { home, cwd: repo }));

    // ---- 深さ優先の継承解決（context-scans vs context-agents）
    const rawScans = {
      version: SCANS_VERSION,
      defaults: { kinds: { instruction: nativeRule, skill: defaultKind(), mcp: defaultKind() }, roots: { instruction: [], skill: [], mcp: [] } },
      places: {
        [pathKey(repo)]: { kinds: { instruction: plyRule } },
      },
    };
    const agentsOnlyDefault = normalizeDocAgentsConfig({
      version: 1,
      defaults: { instruction: { agents: { [WORKSPACE_SUMMARY_KEY]: { off: ['codex'], spread: [] } } } },
      places: {},
    });
    const srcAtSub = resolveEffectiveDocSource(rawScans, agentsOnlyDefault, sub, 'instruction');
    t.ok('子の階層に旧設定(repo)が深く残っていれば、全体の context-agents では上書きせず旧設定が勝つ（touched: false）',
      !srcAtSub.touched && srcAtSub.legacyPlace === pathKey(repo) && srcAtSub.legacyRule.owner === 'ply');

    const agentsAtRepo = normalizeDocAgentsConfig({
      version: 1,
      defaults: { instruction: { agents: { [WORKSPACE_SUMMARY_KEY]: { off: ['codex'], spread: [] } } } },
      places: { [pathKey(repo)]: { instruction: { agents: { [docItemKey(skillA)]: { off: ['claude'], spread: [] } } } } },
    });
    const srcEqual = resolveEffectiveDocSource(rawScans, agentsAtRepo, sub, 'instruction');
    t.ok('同じ深さ以上の context-agents があれば Stage 2 が有効になる（touched: true）',
      srcEqual.touched && srcEqual.agentsPlace === pathKey(repo));

    // scope: 'directory' は __workspace__ にフォールバックする
    const fallbackRule = resolveRuleForItem(srcEqual.agentsChain, 'file:/nonexistent/CLAUDE.md', 'directory');
    t.ok('scope=directory の未登録キーは __workspace__ ルールを受け継ぐ',
      fallbackRule.off.join(',') === 'codex');
    const userNoFallback = resolveRuleForItem(srcEqual.agentsChain, 'file:/nonexistent/user.md', 'user');
    t.ok('scope=user の未登録キーは __workspace__ を受け継がない',
      userNoFallback.off.length === 0 && userNoFallback.spread.length === 0);

    // ---- toggleDocAgentRule / setDocRowRule / evaluateDocCells とロック保護
    const cellsInst = evaluateDocCells('instruction', instA, { off: ['claude'], spread: ['codex'] });
    t.ok('evaluateDocCells: off は off、spread は spread、Grok は claude 元なので workspace/own ロック on',
      cellsInst.claude.on === false && cellsInst.codex.on === true && cellsInst.codex.mode === 'spread'
      && cellsInst.grok.locked === true && cellsInst.grok.reason === 'own' && cellsInst.grok.on === true);

    const toggledGrok = toggleDocAgentRule('instruction', instA, { off: [], spread: [] }, 'grok', false);
    t.ok('ロックセルへの toggleDocAgentRule は無効でルールを変えない',
      toggledGrok.off.length === 0 && toggledGrok.spread.length === 0);

    const toggledCodexOn = toggleDocAgentRule('instruction', instA, { off: [], spread: [] }, 'codex', true);
    t.ok('非ネイティブ指示を Codex で ON にすると spread に追加される',
      toggledCodexOn.spread.join(',') === 'codex' && toggledCodexOn.off.length === 0);

    const rowOff = setDocRowRule('instruction', instA, toggledCodexOn, false);
    t.ok('setDocRowRule(false) は非ロックエージェント全てを off にし、spread を空にする',
      rowOff.spread.length === 0 && rowOff.off.includes('claude') && rowOff.off.includes('codex') && !rowOff.off.includes('grok'));

    // ---- 永続化・place 削除・旧 context-scans.json (.strict()) 非汚染保証
    const dataDir = path.join(tmp, 'data');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    const settings = createContextSettings(dataDir, home);
    const storeAgents = createContextAgents(dataDir);
    await settings.set({ place: null, kind: 'instruction', value: defaultKind() });
    await settings.set({ place: repo, kind: 'instruction', value: defaultKind() });
    await storeAgents.mutate((cfg) => {
      cfg.defaults.instruction = { agents: { [WORKSPACE_SUMMARY_KEY]: { off: ['claude'], spread: [] } } };
      cfg.places[pathKey(repo)] = {
        instruction: { agents: { [WORKSPACE_SUMMARY_KEY]: { off: ['codex'], spread: [] } } },
        skill: { agents: { [WORKSPACE_SUMMARY_KEY]: { off: ['claude'], spread: [] } } },
      };
      cfg.places[pathKey(sub)] = { instruction: { agents: { 'file:/x': { off: ['claude'], spread: [] } } } };
      return cfg;
    });
    const rawDiskScans = JSON.parse(await fs.readFile(path.join(dataDir, 'context-scans.json'), 'utf8'));
    t.ok('beta.31 互換: context-agents 書き込み後も context-scans.json には余分な欄を足さない',
      rawDiskScans.version === SCANS_VERSION && !Object.hasOwn(rawDiskScans.defaults.kinds.instruction, 'agents'));

    // 別ファイルであることを確認しつつ read() で設定がそのまま読めること
    const onDiskAgents = await fs.readFile(path.join(dataDir, DOC_AGENTS_FILE), 'utf8');
    t.ok('context-agents.json が保存され、contextSettings.read() も通る',
      JSON.parse(onDiskAgents).version === 1 && (await settings.read()).version === SCANS_VERSION);

    await storeAgents.removePlace(repo, 'instruction');
    const afterKindRemove = await storeAgents.read();
    t.ok('removePlace(place, kind) は指定 kind だけ外し別 kind は残す',
      !afterKindRemove.places[pathKey(repo)]?.instruction && Boolean(afterKindRemove.places[pathKey(repo)]?.skill));

    await storeAgents.prunePlaces([repo]);
    const afterPrune = await storeAgents.read();
    t.ok('prunePlaces は keepKeys 以外の place を除く',
      Boolean(afterPrune.places[pathKey(repo)]) && !afterPrune.places[pathKey(sub)]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
