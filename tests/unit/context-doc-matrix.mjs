import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_SUMMARY_KEY,
  docItemKey,
  emptyDocAgentsConfig,
  normalizeDocAgentsConfig,
} from '../../core/context-agents.mjs';
import {
  DocTouchError,
  applyDocTouch,
  buildDocMatrix,
  resolveDocForAgent,
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
  // Devin・Grok が自分で読まない物（鍵つきでオンのマスが無く、行のスイッチを押せる）
  const userOpen = mkInst(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'opencode', 'user');
  const wsGemini = mkInst(path.join(repo, 'GEMINI.md'), 'antigravity', 'directory');

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
  t.ok('summaryRow(__workspace__): 指示は Grok が workspace・Devin が bundled のロック on（Devin の取り込みは止めない）',
    mNative.summaryRow.cells.grok.locked && mNative.summaryRow.cells.grok.reason === 'workspace' && !mNative.summaryRow.cells.codex.locked
    && mNative.summaryRow.cells.devin.locked && mNative.summaryRow.cells.devin.reason === 'bundled' && mNative.summaryRow.cells.devin.on);

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

  // ---- 段 2 のレビュー S2: Pleiad が Devin へ Hook を渡す場所では Devin の取り込みが止まる。取り込む物は鍵つきのオフ、自分の物は鍵つきのオン
  const mStopped = buildDocMatrix({
    kind: 'instruction',
    entries: [userClaude, userCodex, userGemini, userDevin, wsClaude, wsAgents],
    legacyConfig: nativeRaw,
    docAgentsConfig: emptyDocAgentsConfig(),
    cwd: repo,
    home,
    devinImportsStopped: true,
  });
  const stClaude = mStopped.byKey.get(docItemKey(userClaude));
  t.ok('取り込みが止まる場所: Claude の指示の Devin は devinHooks の鍵つきでオフ、ほかのエージェントは変わらない',
    stClaude.cells.devin.locked && !stClaude.cells.devin.on && stClaude.cells.devin.reason === 'devinHooks'
    && stClaude.cells.claude.on && !stClaude.cells.claude.locked && stClaude.cells.grok.reason === 'own');
  t.ok('取り込みが止まる場所: 作業場所のまとめの Devin も devinHooks の鍵つきでオフ',
    mStopped.summaryRow.cells.devin.locked && !mStopped.summaryRow.cells.devin.on && mStopped.summaryRow.cells.devin.reason === 'devinHooks');
  t.ok('取り込みが止まる場所でも、Devin 自身の置き場の指示は own の鍵つきでオン（read_config_from に関わらず読む）',
    mStopped.byKey.get(docItemKey(userDevin)).cells.devin.on && mStopped.byKey.get(docItemKey(userDevin)).cells.devin.reason === 'own');
  const resStopped = resolveDocForAgent({
    kind: 'instruction', agent: 'devin',
    entries: [userClaude, userCodex, userDevin, wsClaude, wsAgents],
    legacyConfig: nativeRaw, docAgentsConfig: emptyDocAgentsConfig(), cwd: repo, home, devinImportsStopped: true,
  });
  t.ok('取り込みが止まる場所の Devin のターン: 鍵つきのオフの物は読んだことにも渡したことにもしない（自分の物だけ使う）',
    !resStopped.active.some((a) => a.entry.path === userClaude.path)
    && !resStopped.deliver.some((e) => e.path === userClaude.path)
    && resStopped.active.some((a) => a.entry.path === userDevin.path));
  const mStoppedPly = buildDocMatrix({
    kind: 'instruction',
    entries: [userClaude, userCodex, userDevin, wsClaude, wsAgents],
    legacyConfig: plyDefaultsRaw,
    docAgentsConfig: emptyDocAgentsConfig(),
    cwd: repo,
    home,
    devinImportsStopped: true,
  });
  t.ok('旧「そろえる」の指示の場所（legacyOwner: ply）は、取り込みが止まっても Pleiad が渡すので Devin のマスは bundled のまま',
    mStoppedPly.legacyOwner === 'ply' && mStoppedPly.byKey.get(docItemKey(userClaude)).cells.devin.reason === 'bundled'
    && mStoppedPly.byKey.get(docItemKey(userClaude)).cells.devin.on);

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
    && buildRow.cells.devin.locked && buildRow.cells.devin.reason === 'bundled');
  t.ok('Skill の summaryRow(__workspace__) は Devin が bundled・Grok が workspace のロック',
    mSkill.summaryRow.cells.devin.locked && mSkill.summaryRow.cells.devin.reason === 'bundled'
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

  // 旧「Pleiad がそろえる」のユーザーの物は、場所を初めて触るときに写す（写さないと、その場所だけ旧い広げが消える）。
  // 旧「任せる」のユーザーの物は上の段と同じなので写さない（全体の表を後で変えたら、その場所にも効く）
  const baseRepoNative = snapshotBaselineAgents({
    kind: 'instruction', entries: [userClaude, wsClaude, wsAgents], legacyConfig: nativeRaw,
    docAgentsConfig: emptyDocAgentsConfig(), place: repo, home,
  });
  t.ok('場所の初回スナップショット: 旧 ply のユーザー行は広げを写し、旧「任せる」のユーザー行は写さない',
    baseRepoFresh[docItemKey(userClaude)]?.spread.includes('codex') === true
    && !Object.hasOwn(baseRepoNative, docItemKey(userClaude)),
    JSON.stringify({ ply: baseRepoFresh[docItemKey(userClaude)], native: baseRepoNative[docItemKey(userClaude)] ?? null }));

  // 右の欄で行を止めて戻すと、この場所の上書きが無いときの動き（全体の表で Codex にだけ広げた）に戻り、全エージェントをオンにはしない。
  // （.claude/rules の物は Devin・Grok が自分で読む鍵つきでオンなので行は押せない。押せる GEMINI.md で確かめる）
  const placeEntries = [userClaude, wsGemini, wsAgents];
  const touchCfg = normalizeDocAgentsConfig({
    version: 1,
    defaults: { instruction: { agents: { [docItemKey(wsGemini)]: { off: [], spread: ['codex'] } } } },
    places: {},
  });
  const pressRow = (on) => applyDocTouch(touchCfg, {
    kind: 'instruction', entries: placeEntries, legacyConfig: nativeRaw, matrixCwd: repo, home,
    place: repo, placeKey: pathKey(repo), agent: null, keys: [docItemKey(wsGemini)], on,
  });
  const ruleOf = () => buildDocMatrix({ kind: 'instruction', entries: placeEntries, legacyConfig: nativeRaw, docAgentsConfig: touchCfg, cwd: repo, home }).byKey.get(docItemKey(wsGemini));
  const beforeRow = ruleOf();
  pressRow(false);
  const offRow = ruleOf();
  pressRow(true);
  const backRow = ruleOf();
  const onAgents = (row) => Object.keys(row.cells).filter((a) => row.cells[a].on).sort().join(',');
  t.ok('右の欄の行を止めて戻すと、押す前のマスに戻る（全エージェントをオンにしない）',
    !offRow.rowSwitchOn && onAgents(backRow) === onAgents(beforeRow) && onAgents(backRow) === 'antigravity,codex',
    `${onAgents(beforeRow)} → ${onAgents(offRow)} → ${onAgents(backRow)}`);

  // ---- 行のスイッチの規則（ADR 0337 §決定 4・レビュー M4）
  const defEntries = [userClaude, userCodex, userOpen, wsClaude, wsAgents];
  const defMatrix = (cfg) => buildDocMatrix({ kind: 'instruction', entries: defEntries, legacyConfig: nativeRaw, docAgentsConfig: cfg, cwd: null, home });
  const defPress = (cfg, key, on, agent = null) => applyDocTouch(cfg, {
    kind: 'instruction', entries: defEntries, legacyConfig: nativeRaw, matrixCwd: null, home,
    place: null, placeKey: null, agent, keys: [key], on,
  });
  const onSet = (row) => Object.keys(row.cells).filter((a) => row.cells[a].on).sort().join(',');
  // 自分の物（~/.codex/AGENTS.md は Codex の鍵つきでオン）: 行のスイッチはオンに見え、押せない（押しても変わらない、を作らない）
  const codexRow = defMatrix(emptyDocAgentsConfig()).byKey.get(docItemKey(userCodex));
  let lockedErr = null;
  try { defPress(emptyDocAgentsConfig(), docItemKey(userCodex), false); } catch (e) { lockedErr = e; }
  t.ok('鍵つきでオンのマスがある行: 行のスイッチはオン・押せない（setDocRow は docRowLocked で断る）',
    codexRow.rowSwitchOn === true && codexRow.rowLocked === true && codexRow.anyOn === true
    && lockedErr instanceof DocTouchError && lockedErr.code === 'docRowLocked',
    JSON.stringify({ on: codexRow.rowSwitchOn, locked: codexRow.rowLocked, err: lockedErr?.code }));

  // Claude の物は Grok・Devin が自分で読む（鍵つきでオン）ので押せない
  t.ok('Claude のユーザーの物: Grok・Devin の鍵つきでオンが残るので行のスイッチは押せない',
    defMatrix(emptyDocAgentsConfig()).byKey.get(docItemKey(userClaude)).rowLocked === true);
  // OpenCode の物を Codex にも広げてから、行をオフ → オン で、オフにする前（OpenCode・Codex）に戻る
  const rowCfg = emptyDocAgentsConfig();
  const ucKey = docItemKey(userOpen);
  defPress(rowCfg, ucKey, true, 'codex');
  const spreadOn = onSet(defMatrix(rowCfg).byKey.get(ucKey));
  defPress(rowCfg, ucKey, false);
  const offState = defMatrix(rowCfg).byKey.get(ucKey);
  const wasSaved = rowCfg.defaults.instruction.agents[ucKey]?.was;
  defPress(rowCfg, ucKey, true);
  const backState = onSet(defMatrix(rowCfg).byKey.get(ucKey));
  t.ok('行のスイッチ: オフ→オンで、オフにする前の状態に戻る（was に覚え、戻したら消える）',
    spreadOn === 'codex,opencode' && offState.rowSwitchOn === false && onSet(offState) === ''
    && wasSaved?.spread?.includes('codex') && backState === 'codex,opencode'
    && rowCfg.defaults.instruction.agents[ucKey].was === undefined,
    JSON.stringify({ spreadOn, off: onSet(offState), wasSaved, backState }));
  // 保存の形でも was が残る（読み直しても戻せる）
  defPress(rowCfg, ucKey, false);
  const reread = normalizeDocAgentsConfig(JSON.parse(JSON.stringify(rowCfg)));
  defPress(reread, ucKey, true);
  t.ok('was は保存を読み直しても残り、オンで戻せる',
    onSet(defMatrix(reread).byKey.get(ucKey)) === 'codex,opencode');

  // 前の状態が無ければ、出どころのエージェント（自分で読む OpenCode）だけオン。ほかへは広げない
  const freshCfg = normalizeDocAgentsConfig({ version: 1, defaults: { instruction: { agents: { [WORKSPACE_SUMMARY_KEY]: { off: [], spread: [] }, [ucKey]: { off: ['claude', 'codex', 'antigravity', 'opencode', 'devin'], spread: [] } } } }, places: {} });
  defPress(freshCfg, ucKey, true);
  t.ok('前の状態が無い行をオン: 出どころのエージェントだけオン（確認なしに全員へ広げない）',
    onSet(defMatrix(freshCfg).byKey.get(ucKey)) === 'opencode',
    onSet(defMatrix(freshCfg).byKey.get(ucKey)));
  // マスを押すと覚えた前の状態は消える（マスで決めた形が新しい基準）
  defPress(rowCfg, ucKey, false);
  defPress(rowCfg, ucKey, true, 'codex');
  t.ok('マスを押すと was は消える', rowCfg.defaults.instruction.agents[ucKey].was === undefined
    && onSet(defMatrix(rowCfg).byKey.get(ucKey)) === 'codex');

  // 「探す場所」に足したフォルダーの物は自分で読むエージェントが無いので、オンは渡せる全エージェント（Grok は渡せない）
  const rootDoc = { ...mkInst(path.join(home, 'notes', 'extra.md'), 'common', 'user'), root: path.join(home, 'notes') };
  rootDoc.origins = [{ path: rootDoc.path, source: 'common', scope: 'user', custom: true }];
  const rootEntries = [userClaude, rootDoc];
  const rootKey = docItemKey(rootDoc);
  const rootCfg = normalizeDocAgentsConfig({ version: 1, defaults: { instruction: { agents: { [WORKSPACE_SUMMARY_KEY]: { off: [], spread: [] }, [rootKey]: { off: ['claude', 'codex', 'antigravity', 'opencode', 'devin'], spread: [] } } } }, places: {} });
  applyDocTouch(rootCfg, { kind: 'instruction', entries: rootEntries, legacyConfig: nativeRaw, matrixCwd: null, home, place: null, placeKey: null, agent: null, keys: [rootKey], on: true });
  const rootRow = buildDocMatrix({ kind: 'instruction', entries: rootEntries, legacyConfig: nativeRaw, docAgentsConfig: rootCfg, cwd: null, home }).byKey.get(rootKey);
  t.ok('自分で読むエージェントが無い物（探す場所の物）のオンは、渡せる全エージェント',
    onSet(rootRow) === 'antigravity,claude,codex,devin,opencode', onSet(rootRow));

  // まとまりのチップ・確認の後の広げは、複数の名前を 1 回で書く（レビュー S3）
  const bundleCfg = emptyDocAgentsConfig();
  const skA = mkSkill('alpha', path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'claude', 'user');
  const skB = mkSkill('beta', path.join(home, '.claude', 'skills', 'beta', 'SKILL.md'), 'claude', 'user');
  const skEntries = [skA, skB];
  applyDocTouch(bundleCfg, { kind: 'skill', entries: skEntries, legacyConfig: nativeRaw, matrixCwd: null, home, place: null, placeKey: null, agent: 'codex', keys: [docItemKey(skA), docItemKey(skB)], on: true });
  const skM = buildDocMatrix({ kind: 'skill', entries: skEntries, legacyConfig: nativeRaw, docAgentsConfig: bundleCfg, cwd: null, home });
  t.ok('setDocAgent の keys: 複数の名前の同じエージェントのマスを 1 回で書く',
    skM.byKey.get(docItemKey(skA)).cells.codex.on && skM.byKey.get(docItemKey(skB)).cells.codex.on);

  // ---- 場所のまとめの行（CLAUDE.md・AGENTS.md）が、場所のファイルの行と実行時に届く（レビュー M3）
  const sumCfg = emptyDocAgentsConfig();
  const sumEntries = [userClaude, wsClaude, wsAgents];
  applyDocTouch(sumCfg, {
    kind: 'instruction', entries: sumEntries, legacyConfig: nativeRaw, matrixCwd: repo, home,
    place: repo, placeKey: pathKey(repo), agent: 'claude', keys: [WORKSPACE_SUMMARY_KEY], on: false,
  });
  const sumM = buildDocMatrix({ kind: 'instruction', entries: sumEntries, legacyConfig: nativeRaw, docAgentsConfig: sumCfg, cwd: repo, home });
  const sumClaude = resolveDocForAgent({ kind: 'instruction', agent: 'claude', entries: sumEntries, legacyConfig: nativeRaw, docAgentsConfig: sumCfg, cwd: repo, home });
  const suppressed = new Set(sumClaude.suppress.map((c) => pathKey(c.path)));
  t.ok('場所のまとめの行で Claude を外すと、その場所の作業場所の行の Claude も外れ、実行時に止まる（ユーザーの物は変わらない）',
    !sumM.summaryRow.cells.claude.on
    && !sumM.byKey.get(docItemKey(wsClaude)).cells.claude.on && !sumM.byKey.get(docItemKey(wsAgents)).cells.claude.on
    && sumM.byKey.get(docItemKey(userClaude)).cells.claude.on
    && suppressed.has(pathKey(wsClaude.path)) && suppressed.has(pathKey(wsAgents.path)),
    JSON.stringify({ suppress: [...suppressed], rows: sumM.rows.map((r) => [r.name, r.cells.claude.on]) }));
  applyDocTouch(sumCfg, {
    kind: 'instruction', entries: sumEntries, legacyConfig: nativeRaw, matrixCwd: repo, home,
    place: repo, placeKey: pathKey(repo), agent: 'claude', keys: [WORKSPACE_SUMMARY_KEY], on: true,
  });
  const sumBack = buildDocMatrix({ kind: 'instruction', entries: sumEntries, legacyConfig: nativeRaw, docAgentsConfig: sumCfg, cwd: repo, home });
  t.ok('場所のまとめの行で Claude を戻すと、作業場所の行の Claude も戻る',
    sumBack.summaryRow.cells.claude.on && sumBack.byKey.get(docItemKey(wsClaude)).cells.claude.on && sumBack.byKey.get(docItemKey(wsAgents)).cells.claude.on);
  t.ok('まとめの行は Devin・Grok が鍵つきでオンなので、行のスイッチはオンで押せない',
    sumBack.summaryRow.rowSwitchOn === true && sumBack.summaryRow.rowLocked === true);

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
