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
    t.ok('上限の誤りは code DOC_AGENTS_LIMIT で、英語の生の文ではなく次にすることを言う（レビュー M7）',
      placesErr?.code === 'DOC_AGENTS_LIMIT' && keysErr?.code === 'DOC_AGENTS_LIMIT'
      && /全体の設定に戻す|Reset to the global settings/.test(placesErr.message) && !/limit exceeded/.test(placesErr.message + keysErr.message),
      JSON.stringify([placesErr?.message, keysErr?.message]));

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
    // 保存された除外は絶対パス（normalizeKind が保存のときに解決する）
    const plyExcludedPath = { owner: 'ply', user: { sources: ['common', 'claude', 'codex'], excludePaths: [path.join(home, '.claude', 'CLAUDE.md')] }, directory: { sources: ['common', 'claude'], excludePaths: [path.join(repo, 'blocked.md')] } };

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
    // 鍵のマスでも、旧い「Pleiad がそろえる」で外していた物は off に覚える（触った後も Pleiad が渡さない。表のマスは鍵でオンのまま）。Grok には渡せないので書かない
    t.ok('旧「探す形式」で外していた出どころは全エージェントが off（Codex 自身の全体の指示は鍵でオンのまま、off にも覚える）',
      excludedBySource.off.includes('claude') && excludedBySource.off.includes('codex') && !excludedBySource.off.includes('grok')
      && evaluateDocCells('instruction', { kind: 'instruction', path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user', origins: [{ path: path.join(home, '.codex', 'AGENTS.md'), source: 'codex', scope: 'user' }] }, excludedBySource, { legacyOwner: 'ply' }).codex.on === true
      && docCellLock('codex', 'instruction', { kind: 'instruction', path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user', origins: [{ path: path.join(home, '.codex', 'AGENTS.md'), source: 'codex', scope: 'user' }] })?.lockedOn === true);

    t.ok('旧 excludePaths に当たるパスは legacyEntryIncluded が false',
      !legacyEntryIncluded('instruction', instA, plyExcludedPath, { home, cwd: repo }));
    // 除外はその物とその下を外す（フォルダーを外すと中の物も外れる）。除外がジャンクションなら、その実体の下の物も外す（main の探し方と同じ）
    const realDir = path.join(tmp, 'real-rules');
    const linkDir = path.join(tmp, 'link-rules');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'guide.md'), '# guide');
    await fs.symlink(realDir, linkDir, 'junction');
    const inReal = { kind: 'instruction', name: 'guide.md', path: path.join(realDir, 'guide.md'), realPath: path.join(realDir, 'guide.md'), scope: 'directory', origins: [{ path: path.join(realDir, 'guide.md'), source: 'claude', scope: 'directory' }] };
    const dirRule = (p) => ({ owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [p] } });
    t.ok('旧 excludePaths: フォルダーの除外は中の物を外し、ジャンクションの除外は実体の下の物も外す。外の物は外さない',
      !legacyEntryIncluded('instruction', inReal, dirRule(realDir), { home, cwd: repo })
      && !legacyEntryIncluded('instruction', inReal, dirRule(linkDir), { home, cwd: repo })
      && legacyEntryIncluded('instruction', inReal, dirRule(path.join(tmp, 'real')), { home, cwd: repo }));

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

    // すでにどれかの押せるマスがオンの行は、行のスイッチをオンにしても変えない（まとまりのスイッチを「一部」からオンにしたとき）
    const rowOnSpread = setDocRowRule('instruction', instA, toggledCodexOn, true);
    t.ok('setDocRowRule(true) はオンの行の広げ（Codex）を消さない',
      rowOnSpread.spread.join(',') === 'codex' && rowOnSpread.off.length === 0);
    const teamDir = path.join(home, 'team-rules');
    const teamFile = path.join(teamDir, '.claude', 'rules', 'r.md');
    const instCustom = { kind: 'instruction', name: 'r.md', path: teamFile, scope: 'user', root: teamDir,
      origins: [{ path: teamFile, source: 'claude', scope: 'user', root: teamDir }] };
    const customClaude = toggleDocAgentRule('instruction', instCustom, { off: [], spread: [] }, 'claude', true);
    const rowOnCustom = setDocRowRule('instruction', instCustom, customClaude, true);
    const customCells = evaluateDocCells('instruction', instCustom, rowOnCustom);
    t.ok('探す場所に足したフォルダーの行が Claude だけオンなら、setDocRowRule(true) で他のエージェントへ広げない',
      customCells.claude.on === true && ['codex', 'antigravity', 'opencode', 'devin', 'grok'].every(a => !customCells[a].on));
    const rowOffCustom = setDocRowRule('instruction', instCustom, rowOnCustom, false);
    const rowBackCustom = evaluateDocCells('instruction', instCustom, setDocRowRule('instruction', instCustom, rowOffCustom, true));
    t.ok('オフにしてからオンにすると、前の状態（Claude だけ）に戻る',
      rowBackCustom.claude.on === true && ['codex', 'antigravity', 'opencode', 'devin', 'grok'].every(a => !rowBackCustom[a].on));

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

    // ---- 書くときの掃除と上限（レビュー M7・S5）
    const pruneDir = path.join(tmp, 'prune-data');
    const pruneStore = createContextAgents(pruneDir);
    const goneFile = path.join(tmp, 'gone', 'CLAUDE.md');
    await pruneStore.mutate((cfg) => {
      for (let i = 0; i < MAX_PLACES + 5; i++) cfg.places[pathKey(path.join(tmp, 'gone', `p-${i}`))] = { instruction: { agents: {} } };
      cfg.places[pathKey(repo)] = { instruction: { agents: { [`file:${goneFile.replace(/\\/g, '/')}`]: { off: ['claude'], spread: [] } } } };
      return cfg;
    });
    const pruned = await pruneStore.read();
    t.ok('書くとき、フォルダーがもう無い場所の設定を外す（上限に届く前に。あるフォルダーの設定と、無いファイルの覚えは上限までは残す）',
      Object.keys(pruned.places).length === 1 && Boolean(pruned.places[pathKey(repo)]?.instruction?.agents[`file:${goneFile.replace(/\\/g, '/')}`]),
      JSON.stringify(Object.keys(pruned.places).length));

    // 上限を超えるときだけ、もう無いファイルの覚え（名前を変えた・消したファイル）を外す
    await pruneStore.mutate((cfg) => {
      for (let i = 0; i < MAX_AGENT_KEYS + 5; i++) cfg.defaults.instruction = { agents: { ...(cfg.defaults.instruction?.agents ?? {}), [`file:${path.join(tmp, 'gone', `f-${i}.md`).replace(/\\/g, '/')}`]: { off: ['claude'], spread: [] } } };
      return cfg;
    });
    const prunedKeys = await pruneStore.read();
    t.ok('上限を超えるときは、もう無いファイルの設定を外して保存できる', countAgentKeys(prunedKeys) === 0, String(countAgentKeys(prunedKeys)));

    // 外せない物（あるフォルダーの場所・Skills の名前）で超えると、日本語の上限の誤りで断り、ファイルは変えない
    const realPlaces = path.join(tmp, 'real-places');
    for (let i = 0; i <= MAX_PLACES; i++) await fs.mkdir(path.join(realPlaces, `p-${i}`), { recursive: true });
    const beforeLimit = await fs.readFile(pruneStore.file, 'utf8');
    let placeLimitErr = null;
    try {
      await pruneStore.mutate((cfg) => {
        for (let i = 0; i <= MAX_PLACES; i++) cfg.places[pathKey(path.join(realPlaces, `p-${i}`))] = { skill: { agents: {} } };
        return cfg;
      });
    } catch (e) { placeLimitErr = e; }
    let keyLimitErr = null;
    try {
      await pruneStore.mutate((cfg) => {
        cfg.defaults.skill = { agents: {} };
        for (let i = 0; i <= MAX_AGENT_KEYS; i++) cfg.defaults.skill.agents[`skill:s-${i}`] = { off: ['claude'], spread: [] };
        return cfg;
      });
    } catch (e) { keyLimitErr = e; }
    t.ok('外せない物で上限を超えると DOC_AGENTS_LIMIT で断り、ファイルは書かない',
      placeLimitErr?.code === 'DOC_AGENTS_LIMIT' && keyLimitErr?.code === 'DOC_AGENTS_LIMIT'
      && /上限（100 か所）|limit of 100 places/.test(placeLimitErr.message) && /2000/.test(keyLimitErr.message)
      && (await fs.readFile(pruneStore.file, 'utf8')) === beforeLimit,
      JSON.stringify([placeLimitErr?.message, keyLimitErr?.message]));

    // ---- 読めないファイル（レビュー M6）: 会話を断る誤りにし、上書きせず、退避して直せる
    for (const [label, body] of [['壊れた JSON', '{"version": 1, '], ['知らない版', '{"version": 2, "defaults": {}, "places": {}}'], ['知らない項目', '{"version": 1, "defaults": {}, "places": {}, "future": true}']]) {
      const brokenDir = path.join(tmp, `broken-${label.length}-${body.length}`);
      await fs.mkdir(brokenDir, { recursive: true });
      const brokenStore = createContextAgents(brokenDir, { now: () => new Date('2026-11-15T10:20:30.456Z') });
      await fs.writeFile(brokenStore.file, body);
      let readErr = null;
      try { await brokenStore.read(); } catch (e) { readErr = e; }
      let writeErr = null;
      try { await brokenStore.mutate((cfg) => cfg); } catch (e) { writeErr = e; }
      t.ok(`${label}: read は code DOC_AGENTS_UNREADABLE とファイル名・直し方を言う誤りで断り、mutate は上書きしない`,
        readErr?.code === 'DOC_AGENTS_UNREADABLE' && /context-agents\.json/.test(readErr.message) && /context\.repairDocAgents/.test(readErr.message)
        && writeErr?.code === 'DOC_AGENTS_UNREADABLE' && (await fs.readFile(brokenStore.file, 'utf8')) === body,
        JSON.stringify({ read: readErr?.message, write: writeErr?.message }));
      // 同じ名前の退避が先にあれば -1 を付ける（上書きしない）
      await fs.writeFile(path.join(brokenDir, 'context-agents.broken-2026-11-15T10-20-30-456Z.json'), 'OLD');
      const repaired = await brokenStore.repair();
      const files = (await fs.readdir(brokenDir)).sort();
      t.ok(`${label}: repair は context-agents.broken-<時刻>.json へ移し（消さない・先の退避を上書きしない）、read は空に戻る。読めるなら何もしない`,
        repaired?.backup === 'context-agents.broken-2026-11-15T10-20-30-456Z-1.json'
        && (await fs.readFile(path.join(brokenDir, repaired.backup), 'utf8')) === body
        && (await fs.readFile(path.join(brokenDir, 'context-agents.broken-2026-11-15T10-20-30-456Z.json'), 'utf8')) === 'OLD'
        && !files.includes(DOC_AGENTS_FILE)
        && JSON.stringify(await brokenStore.read()) === JSON.stringify(emptyDocAgentsConfig())
        && (await brokenStore.repair()) === null,
        JSON.stringify({ repaired, files }));
    }
    // 退避は MAX_BROKEN_BACKUPS（5）まで。超えたら古い物から消し、今退避した物は残す
    const manyDir = path.join(tmp, 'broken-many');
    await fs.mkdir(manyDir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const f = path.join(manyDir, `context-agents.broken-old-${i}.json`);
      await fs.writeFile(f, `OLD${i}`);
      await fs.utimes(f, new Date(Date.UTC(2026, 0, 1 + i)), new Date(Date.UTC(2026, 0, 1 + i)));
    }
    const manyStore = createContextAgents(manyDir, { now: () => new Date('2026-11-15T00:00:00.000Z') });
    await fs.writeFile(manyStore.file, '{');
    const manyRes = await manyStore.repair();
    const left = (await fs.readdir(manyDir)).filter((f) => f.startsWith('context-agents.broken-')).sort();
    t.ok('退避は 5 つまで残し、古い物から消す（今退避した物は残る）',
      left.length === 5 && left.includes(manyRes.backup) && left.includes('context-agents.broken-old-6.json') && !left.includes('context-agents.broken-old-2.json'),
      JSON.stringify(left));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
