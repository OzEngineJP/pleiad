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
  // 自分の物（~/.codex/AGENTS.md は Codex の鍵つきでオン）: 初めから鍵つきのオンだけで、戻す先（外す前の記録）も無いので、押せない。
  // 押しても変わらない、を作らず、ほかのエージェントへ配ることもしない（ADR 0337 §決定 4 の 2026-11-17 改訂）
  const codexRow = defMatrix(emptyDocAgentsConfig()).byKey.get(docItemKey(userCodex));
  let lockedErr = null;
  try { defPress(emptyDocAgentsConfig(), docItemKey(userCodex), false); } catch (e) { lockedErr = e; }
  t.ok('初めから鍵つきでオンだけの行: 行のスイッチは「一部」の形で押せない（戻す先が無い。setDocRow は docRowLocked で断る）',
    codexRow.rowSwitchOn === true && codexRow.rowFixed === true && codexRow.rowChangeableOn === false && codexRow.rowRestore === null
    && codexRow.rowLocked === true && codexRow.anyOn === true
    && lockedErr instanceof DocTouchError && lockedErr.code === 'docRowLocked',
    JSON.stringify({ on: codexRow.rowSwitchOn, locked: codexRow.rowLocked, restore: codexRow.rowRestore, err: lockedErr?.code }));

  // Claude の物は Grok・Devin が自分で読む（鍵つきでオン）。行のスイッチは押せて、鍵の無いオンだけをまとめてオフにし、鍵つきのオンは残る。
  // もう一度押すと、外す前のマスに戻る（鍵つきのマスは触らない）
  const claudeKey = docItemKey(userClaude);
  const lockCfg = emptyDocAgentsConfig();
  const claudeBefore = defMatrix(lockCfg).byKey.get(claudeKey);
  const lockedOnOf = (row) => Object.keys(row.cells).filter((a) => row.cells[a].locked && row.cells[a].on).sort().join(',');
  const unlockedOnOf = (row) => Object.keys(row.cells).filter((a) => !row.cells[a].locked && row.cells[a].on).sort().join(',');
  t.ok('Claude のユーザーの物: Grok・Devin の鍵つきでオンが残っても、行のスイッチは押せる（鍵の無いオンがあるので、押す向きはオフ）',
    claudeBefore.rowLocked === false && claudeBefore.rowFixed === true && claudeBefore.rowChangeableOn === true
    && claudeBefore.rowNextOn === false && lockedOnOf(claudeBefore) === 'devin,grok' && unlockedOnOf(claudeBefore) === 'claude',
    JSON.stringify({ locked: claudeBefore.rowLocked, fixed: claudeBefore.rowFixed, next: claudeBefore.rowNextOn, lockedOn: lockedOnOf(claudeBefore), on: unlockedOnOf(claudeBefore) }));
  defPress(lockCfg, claudeKey, false);
  const claudeOff = defMatrix(lockCfg).byKey.get(claudeKey);
  t.ok('Claude のユーザーの物の行をオフ: 鍵の無いマスだけ全部オフ・Grok と Devin の鍵つきのオンは残り、「一部」＋鍵の形になる（外す前の記録つき）',
    unlockedOnOf(claudeOff) === '' && lockedOnOf(claudeOff) === 'devin,grok' && claudeOff.rowSwitchOn === true && claudeOff.rowMixed === true
    && claudeOff.rowChangeableOn === false && claudeOff.rowFixed === true && claudeOff.rowRestore === 'was' && claudeOff.rowNextOn === true && claudeOff.rowLocked === false
    && lockCfg.defaults.instruction.agents[claudeKey].was !== undefined,
    JSON.stringify({ on: unlockedOnOf(claudeOff), locked: lockedOnOf(claudeOff), restore: claudeOff.rowRestore }));
  const claudeOffAgain = structuredClone(lockCfg);
  defPress(claudeOffAgain, claudeKey, false);
  t.ok('鍵の無いオンが無い行をオフにしても変わらない（外す前の記録も作り直さない）',
    JSON.stringify(claudeOffAgain.defaults.instruction.agents[claudeKey]) === JSON.stringify(lockCfg.defaults.instruction.agents[claudeKey]));
  defPress(lockCfg, claudeKey, true);
  const claudeBack = defMatrix(lockCfg).byKey.get(claudeKey);
  t.ok('もう一度押すと、外す前のマスに戻る（鍵つきのマスは触らず、記録は消える）',
    unlockedOnOf(claudeBack) === 'claude' && lockedOnOf(claudeBack) === 'devin,grok' && claudeBack.rowRestore === null && claudeBack.rowChangeableOn === true
    && lockCfg.defaults.instruction.agents[claudeKey].was === undefined,
    JSON.stringify({ on: unlockedOnOf(claudeBack), locked: lockedOnOf(claudeBack) }));
  // 外した後にマスを 1 つ押すと、外す前の記録は消える（古い記録で、あとから足したエージェントまで戻さない）
  defPress(lockCfg, claudeKey, false);
  defPress(lockCfg, claudeKey, true, 'codex');
  const claudeCell = defMatrix(lockCfg).byKey.get(claudeKey);
  t.ok('外した後にマスを押すと、外す前の記録は消え、押したマスだけがオンになる（行のスイッチで古い選択へ戻さない）',
    lockCfg.defaults.instruction.agents[claudeKey].was === undefined && unlockedOnOf(claudeCell) === 'codex' && claudeCell.rowRestore === null,
    JSON.stringify({ on: unlockedOnOf(claudeCell), restore: claudeCell.rowRestore }));
  // マスで押せるマスの最後のオンを外したときだけは、その前の規則を戻し先として覚える（鍵つきのオンが残る行でも、行のスイッチで戻せる）
  const iconCfg = emptyDocAgentsConfig();
  defPress(iconCfg, claudeKey, false, 'claude');
  const iconOff = defMatrix(iconCfg).byKey.get(claudeKey);
  t.ok('マスで最後のオンを外す: 鍵つきが残る行は「一部」＋鍵のまま、行のスイッチで戻せる（戻し先は外す前の規則）',
    unlockedOnOf(iconOff) === '' && lockedOnOf(iconOff) === 'devin,grok' && iconOff.rowMixed === true && iconOff.rowRestore === 'was' && iconOff.rowLocked === false
    && iconCfg.defaults.instruction.agents[claudeKey].was !== undefined,
    JSON.stringify({ on: unlockedOnOf(iconOff), restore: iconOff.rowRestore }));
  defPress(iconCfg, claudeKey, true);
  t.ok('その行のスイッチを押すと、外す前のマス（Claude）に戻り、記録は消える',
    unlockedOnOf(defMatrix(iconCfg).byKey.get(claudeKey)) === 'claude' && iconCfg.defaults.instruction.agents[claudeKey].was === undefined);
  // 最後でないオンを外したときは記録しない（鍵の無いオンが残るので、行のスイッチは「オフにする」向き）
  const iconCfg2 = emptyDocAgentsConfig(), openKey = docItemKey(userOpen);
  defPress(iconCfg2, openKey, true, 'codex');
  defPress(iconCfg2, openKey, false, 'codex');
  t.ok('最後でないオンをマスで外しても、記録は作らない', iconCfg2.defaults.instruction.agents[openKey].was === undefined);
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

  // ---- まとまり（Skills）の行スイッチ: 子の全マスで数え、押すと変えられるオンだけがまとめてオフ。戻すと子ごとに外す前へ戻り、もともとオフの子はオンにしない
  const skC = mkSkill('gamma', path.join(home, '.claude', 'skills', 'gamma', 'SKILL.md'), 'claude', 'user');
  const grpEntries = [skA, skB, skC];
  const grpKeys = [docItemKey(skA), docItemKey(skB), docItemKey(skC)];
  const grpCfg = emptyDocAgentsConfig();
  const grpPress = (on) => applyDocTouch(grpCfg, { kind: 'skill', entries: grpEntries, legacyConfig: nativeRaw, matrixCwd: null, home, place: null, placeKey: null, agent: null, keys: grpKeys, on });
  const grpView = () => buildDocMatrix({ kind: 'skill', entries: grpEntries, legacyConfig: nativeRaw, docAgentsConfig: grpCfg, cwd: null, home });
  const grpUnlockedOn = (row) => Object.keys(row.cells).filter((a) => !row.cells[a].locked && row.cells[a].on).sort().join(',');
  const grpLockedOn = (row) => Object.keys(row.cells).filter((a) => row.cells[a].locked && row.cells[a].on).sort().join(',');
  // skC は初めから、鍵の無いマスを全部オフにしてあった子（記録なし）。skB は Codex にも広げてある子
  applyDocTouch(grpCfg, { kind: 'skill', entries: grpEntries, legacyConfig: nativeRaw, matrixCwd: null, home, place: null, placeKey: null, agent: 'codex', keys: [docItemKey(skB)], on: true });
  grpCfg.defaults.skill.agents[docItemKey(skC)] = { off: ['claude', 'codex', 'antigravity', 'opencode', 'devin'], spread: [] };
  const grp0 = grpView();
  const grpBefore = Object.fromEntries(grpKeys.map((k) => [k, grpUnlockedOn(grp0.byKey.get(k))]));
  grpPress(false);
  const grp1 = grpView();
  t.ok('まとまりをオフ: どの子も鍵の無いマスは全部オフ（鍵つきのオンは残る）・オンだった子は外す前の記録つき・もともとオフの子には記録を作らない',
    grpKeys.every((k) => grpUnlockedOn(grp1.byKey.get(k)) === '')
    && grpKeys.every((k) => grpLockedOn(grp1.byKey.get(k)) === grpLockedOn(grp0.byKey.get(k)))
    && grp1.byKey.get(docItemKey(skA)).rowRestore === 'was' && grp1.byKey.get(docItemKey(skB)).rowRestore === 'was'
    && grpCfg.defaults.skill.agents[docItemKey(skC)].was === undefined,
    JSON.stringify(grpBefore));
  grpPress(true);
  const grp2 = grpView();
  t.ok('まとまりを戻す: 外す前にオンだった子は子ごとに外す前のマスへ戻り（skB は Codex も）、もともとオフの子はオフのまま',
    grpUnlockedOn(grp2.byKey.get(docItemKey(skA))) === grpBefore[docItemKey(skA)]
    && grpUnlockedOn(grp2.byKey.get(docItemKey(skB))) === grpBefore[docItemKey(skB)]
    && grpUnlockedOn(grp2.byKey.get(docItemKey(skC))) === '' && grpBefore[docItemKey(skC)] === '',
    JSON.stringify({ before: grpBefore, after: Object.fromEntries(grpKeys.map((k) => [k, grpUnlockedOn(grp2.byKey.get(k))])) }));
  // 実行時: オフの間 Claude には出ず、戻すと出る（表と実際の配り方が同じ）
  const claudeActive = () => resolveDocForAgent({ kind: 'skill', agent: 'claude', entries: grpEntries, legacyConfig: nativeRaw, docAgentsConfig: grpCfg, cwd: null, home })
    .active.map((a) => a.row.key);
  grpPress(false);
  const claudeActiveOff = claudeActive();
  grpPress(true);
  const claudeActiveOn = claudeActive();
  t.ok('まとまりをオフにすると Claude への配りからも外れ（鍵の無いエージェントだけ）、戻すと配りに戻る',
    !claudeActiveOff.includes(docItemKey(skA)) && !claudeActiveOff.includes(docItemKey(skB))
    && claudeActiveOn.includes(docItemKey(skA)) && claudeActiveOn.includes(docItemKey(skB)) && !claudeActiveOn.includes(docItemKey(skC)),
    JSON.stringify({ off: claudeActiveOff, on: claudeActiveOn }));
  // 鍵つきのオン（Grok・Devin が自分で読む）が残り、鍵の無いマスが全部オフで、外す前の記録も無い子だけのまとまりは、押せない（ほかのエージェントへ配らない）
  const grpAllOff = emptyDocAgentsConfig();
  grpAllOff.defaults.skill = { agents: Object.fromEntries([skA, skB].map((s) => [docItemKey(s), { off: ['claude', 'codex', 'antigravity', 'opencode', 'devin'], spread: [] }])) };
  const grpAllOffBefore = JSON.stringify(grpAllOff);
  let grpAllOffErr = null;
  try {
    applyDocTouch(grpAllOff, { kind: 'skill', entries: [skA, skB], legacyConfig: nativeRaw, matrixCwd: null, home, place: null, placeKey: null, agent: null, keys: [docItemKey(skA), docItemKey(skB)], on: true });
  } catch (e) { grpAllOffErr = e; }
  const grpAllOffM = buildDocMatrix({ kind: 'skill', entries: [skA, skB], legacyConfig: nativeRaw, docAgentsConfig: grpAllOff, cwd: null, home });
  t.ok('初めから鍵つきのオンだけで外す前の記録がどの子にも無いまとまりは押せない（docRowLocked で断り、設定は変えない）',
    grpAllOffErr instanceof DocTouchError && grpAllOffErr.code === 'docRowLocked' && JSON.stringify(grpAllOff) === grpAllOffBefore
    && [skA, skB].every((s) => grpAllOffM.byKey.get(docItemKey(s)).rowLocked === true && grpAllOffM.byKey.get(docItemKey(s)).rowRestore === null),
    JSON.stringify({ err: grpAllOffErr?.code }));

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
  t.ok('まとめの行は Devin・Grok が鍵つきでオンのまま、Claude などの鍵の無いオンがあるので、行のスイッチは押せる（押す向きはオフ）',
    sumBack.summaryRow.rowSwitchOn === true && sumBack.summaryRow.rowFixed === true && sumBack.summaryRow.rowChangeableOn === true
    && sumBack.summaryRow.rowLocked === false && sumBack.summaryRow.rowNextOn === false);
  // まとめの行の行スイッチ: 鍵の無いオンだけオフになり、作業場所の行にも届く。戻すと外す前に戻る（鍵は触らない）
  const sumRowCfg = structuredClone(sumCfg);
  const sumPress = (on) => applyDocTouch(sumRowCfg, {
    kind: 'instruction', entries: sumEntries, legacyConfig: nativeRaw, matrixCwd: repo, home,
    place: repo, placeKey: pathKey(repo), agent: null, keys: [WORKSPACE_SUMMARY_KEY], on,
  });
  const sumView = () => buildDocMatrix({ kind: 'instruction', entries: sumEntries, legacyConfig: nativeRaw, docAgentsConfig: sumRowCfg, cwd: repo, home });
  const sumOnOf = (row) => Object.keys(row.cells).filter((a) => row.cells[a].on).sort().join(',');
  const sumLockedOnOf = (row) => Object.keys(row.cells).filter((a) => row.cells[a].locked && row.cells[a].on).sort().join(',');
  const sumBefore = sumView();
  const sumBeforeOn = { summary: sumOnOf(sumBefore.summaryRow), claude: sumOnOf(sumBefore.byKey.get(docItemKey(wsClaude))), agents: sumOnOf(sumBefore.byKey.get(docItemKey(wsAgents))) };
  sumPress(false);
  const sumOff = sumView();
  t.ok('まとめの行のスイッチをオフ: 鍵の無いマスだけ全部オフ（作業場所の行にも届く）・鍵つきのオンは残る',
    sumOff.summaryRow.rowSwitchOn === true && sumOff.summaryRow.rowRestore === 'was'
    && sumOnOf(sumOff.summaryRow) === sumLockedOnOf(sumOff.summaryRow)
    && sumOnOf(sumOff.byKey.get(docItemKey(wsClaude))) === sumLockedOnOf(sumOff.byKey.get(docItemKey(wsClaude)))
    && sumOnOf(sumOff.byKey.get(docItemKey(wsAgents))) === sumLockedOnOf(sumOff.byKey.get(docItemKey(wsAgents))),
    JSON.stringify({ summary: sumOnOf(sumOff.summaryRow), restore: sumOff.summaryRow.rowRestore }));
  sumPress(true);
  const sumOn = sumView();
  t.ok('まとめの行のスイッチをもう一度押すと、外す前のマスに戻る（作業場所の行も。もともとオフだった名前をオンにしない）',
    sumOnOf(sumOn.summaryRow) === sumBeforeOn.summary
    && sumOnOf(sumOn.byKey.get(docItemKey(wsClaude))) === sumBeforeOn.claude
    && sumOnOf(sumOn.byKey.get(docItemKey(wsAgents))) === sumBeforeOn.agents,
    JSON.stringify({ before: sumBeforeOn, after: { summary: sumOnOf(sumOn.summaryRow) } }));

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
