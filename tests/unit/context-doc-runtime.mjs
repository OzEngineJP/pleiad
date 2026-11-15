import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isEntryNativeTo, mayReadNatively } from '../../core/backends/context-capabilities.mjs';
import { agentDefinition } from '../../core/backends/antigravity-context.mjs';
import { claudeContextOptions, codexContextRpc } from '../../core/backends/context-options.mjs';
import { devinTurnConfig } from '../../core/backends/devin-config.mjs';
import { effectiveOpencodeOwners } from '../../core/backends/opencode-context.mjs';
import {
  WORKSPACE_SUMMARY_KEY,
  docItemKey,
  emptyDocAgentsConfig,
  normalizeDocAgentsConfig,
} from '../../core/context-agents.mjs';
import { resolveDocForAgent } from '../../core/context-doc-matrix.mjs';
import { createContextBridge } from '../../core/context-bridge.mjs';
import {
  attachDocPolicy,
  contextPolicy,
  contextTools,
  followSettings,
  plyContextRefusal,
  resolveRuntime,
} from '../../core/context-runtime.mjs';
import { DEFAULT_SCAN, DEFAULT_SOURCES, createContextSettings, pathKey } from '../../core/context-settings.mjs';
import { registry } from '../../core/ops/index.mjs';
import { ROOT, startServer } from '../lib/server.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'context-doc-runtime';
export const title = 'Stage 2 実行時: エージェント別バイパス・各バックエンド制御・MCP補填・ops権限とサーバー連携';

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-doc-runtime-')));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  const dataDir = path.join(tmp, 'data');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  let host, client, bridge, server, connection;

  try {
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await write(path.join(repo, 'CLAUDE.md'), 'REPO_CLAUDE_SECRET');
    await write(path.join(repo, 'AGENTS.md'), 'REPO_AGENTS_COMMON');
    await write(path.join(repo, '.claude', 'skills', 's-claude', 'SKILL.md'), '---\nname: s-claude\ndescription: Claude native skill\n---\nCLAUDE_SKILL_BODY');
    await write(path.join(repo, '.agents', 'skills', 's-common', 'SKILL.md'), '---\nname: s-common\ndescription: Common skill\n---\nCOMMON_SKILL_BODY');
    await write(path.join(repo, '.codex', 'skills', 's-codex', 'SKILL.md'), '---\nname: s-codex\ndescription: Codex native skill\n---\nCODEX_SKILL_BODY');
    await write(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { claudemcp: { command: process.execPath, args: ['-e', '0'] } } }));
    await write(path.join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cursormcp: { command: process.execPath, args: ['-e', '0'] } } }));
    await write(path.join(home, '.claude', 'CLAUDE.md'), 'USER_CLAUDE_INST');

    const settingsStore = createContextSettings(dataDir, home);
    const baseSettings = await settingsStore.get(repo);
    const rawCfg = await settingsStore.read();

    // ---- 1. 未操作時は Stage 2 プランを通しても全エージェントが untouchedNative
    const attachedUntouched = attachDocPolicy(baseSettings, rawCfg, emptyDocAgentsConfig());
    t.ok('未操作時は docSourceState が instruction/skill ともに touched=false',
      !attachedUntouched.docSourceState.instruction.touched && !attachedUntouched.docSourceState.skill.touched);

    // ---- 2. Claude の CLAUDE.md を 1 件だけオフにし、AGENTS.md を Claude に広げる
    const keyRepoClaude = docItemKey({ kind: 'instruction', path: path.join(repo, 'CLAUDE.md') });
    const keyRepoAgents = docItemKey({ kind: 'instruction', path: path.join(repo, 'AGENTS.md') });
    const keyUserClaude = docItemKey({ kind: 'instruction', path: path.join(home, '.claude', 'CLAUDE.md') });
    const mixedDocAgents = normalizeDocAgentsConfig({
      version: 1,
      defaults: {
        instruction: {
          agents: {
            [WORKSPACE_SUMMARY_KEY]: { off: [], spread: [] },
            [keyRepoClaude]: { off: ['claude'], spread: [] },
            [keyRepoAgents]: { off: [], spread: [] },
            [keyUserClaude]: { off: [], spread: [] },
          },
        },
        skill: {
          agents: {
            [WORKSPACE_SUMMARY_KEY]: { off: [], spread: [] },
            'skill:s-claude': { off: [], spread: ['codex'] },
            'skill:s-codex': { off: ['codex'], spread: [] },
          },
        },
      },
      places: {},
    });
    const attachedMixed = attachDocPolicy(baseSettings, rawCfg, mixedDocAgents);
    const mixedPolicy = contextPolicy(attachedMixed);

    // Grok は Stage 2 編集後、旧オーナーが ply 相当でも plyContextRefusal で拒まれない
    t.ok('Stage 2 で触った後は plyContextRefusal が Grok でも拒まない',
      plyContextRefusal({ id: 'grok', label: 'Grok', capabilities: {}, plyContextRefusal: (o) => (o.instruction === 'ply' ? 'refused' : null) }, { ...mixedPolicy, owners: { instruction: 'ply', skill: 'ply', mcp: 'native' } }) === null);

    // Claude runtime & options
    const clRuntime = await resolveRuntime(mixedPolicy, { home, agent: 'claude' });
    const clOpts = claudeContextOptions({ owners: mixedPolicy.owners, docs: clRuntime.docs, prompt: clRuntime.prompt });
    // Claude Code は作業場所の AGENTS.md を、同じフォルダーに CLAUDE.md・.claude/CLAUDE.md・CLAUDE.local.md が無いときだけ代わりに読む（2.1.322 で本物で確かめた）。
    // ここは横に CLAUDE.md があるので、Claude の AGENTS.md は既定でオフ。CLAUDE.md を外すと読み始めるので、一緒に外す
    t.ok('Claude: オフにした CLAUDE.md と、それを外すと代わりに読み始める同じ場所の AGENTS.md が claudeMdExcludes に入り、ほかは止めない',
      clOpts.settings?.claudeMdExcludes?.some((p) => p.endsWith('/repo/CLAUDE.md'))
      && clOpts.settings.claudeMdExcludes.some((p) => p.endsWith('/repo/AGENTS.md'))
      && clOpts.settings.claudeMdExcludes.every((p) => /\/repo\/(?:claude|agents)\.md$/i.test(p))
      && !clOpts.settings.claudeMdExcludes.includes('**/CLAUDE.md'),
      JSON.stringify({ excludes: clOpts.settings?.claudeMdExcludes }));
    const clAgentsRow = clRuntime.docs?.instruction?.matrix?.rows?.find((r) => r.name === 'AGENTS.md');
    t.ok('Claude: ネイティブの s-claude は untouchedNative なため Skill を止めず、横に CLAUDE.md がある AGENTS.md は表でオフ・注入もしない',
      clOpts.skills === undefined && !clRuntime.prompt.includes('REPO_AGENTS_COMMON')
      && clAgentsRow?.cells?.claude?.on === false && clAgentsRow?.cells?.claude?.native === false
      && clAgentsRow?.cells?.codex?.on === true
      && clRuntime.report.entries.some((e) => e.name === 'CLAUDE.md' && e.scope === 'user' && e.status === 'native' && e.tokens > 0),
      JSON.stringify({ cells: clAgentsRow?.cells }));

    // 置き方ごとの「Claude が自分で読むか」（本物の 4 つの置き方と同じ）
    const layout = async (name, files) => {
      const dir = path.join(tmp, 'layouts', name);
      for (const f of files) await write(path.join(dir, f), 'x');
      await write(path.join(dir, 'AGENTS.md'), 'x');
      return { kind: 'instruction', name: 'AGENTS.md', path: path.join(dir, 'AGENTS.md'), scope: 'directory', origins: [{ path: path.join(dir, 'AGENTS.md'), source: 'common', scope: 'directory' }] };
    };
    const lyAlone = await layout('alone', []);
    const lyBeside = await layout('beside', ['CLAUDE.md']);
    const lyDot = await layout('dot', [path.join('.claude', 'CLAUDE.md')]);
    const lyLocal = await layout('local', ['CLAUDE.local.md']);
    t.ok('Claude: AGENTS.md だけの場所では自分で読み、CLAUDE.md・.claude/CLAUDE.md・CLAUDE.local.md が横にあると読まない（どれも外せば読み始める物として数える）',
      isEntryNativeTo('claude', 'instruction', lyAlone)
      && !isEntryNativeTo('claude', 'instruction', lyBeside)
      && !isEntryNativeTo('claude', 'instruction', lyDot)
      && !isEntryNativeTo('claude', 'instruction', lyLocal)
      && [lyAlone, lyBeside, lyDot, lyLocal].every((e) => mayReadNatively('claude', 'instruction', e))
      && [lyBeside, lyDot, lyLocal].every((e) => isEntryNativeTo('codex', 'instruction', e) && isEntryNativeTo('opencode', 'instruction', e)));

    // AGENTS.md を Claude に広げると、Pleiad が渡し、Claude の自分での読み込みは外す（CLAUDE.md は止めない）
    const clSpreadPolicy = contextPolicy(attachDocPolicy(baseSettings, rawCfg, normalizeDocAgentsConfig({
      version: 1,
      defaults: { instruction: { agents: { [keyRepoAgents]: { off: [], spread: ['claude'] } } } },
      places: {},
    })));
    const clSpreadRuntime = await resolveRuntime(clSpreadPolicy, { home, agent: 'claude' });
    const clSpreadOpts = claudeContextOptions({ owners: clSpreadPolicy.owners, docs: clSpreadRuntime.docs, prompt: clSpreadRuntime.prompt });
    t.ok('Claude: 横に CLAUDE.md がある AGENTS.md を広げると、Pleiad が本文を渡し、AGENTS.md だけを claudeMdExcludes に入れる',
      clSpreadRuntime.prompt.includes('REPO_AGENTS_COMMON')
      && clSpreadOpts.settings?.claudeMdExcludes?.some((p) => p.endsWith('/repo/AGENTS.md'))
      && clSpreadOpts.settings.claudeMdExcludes.every((p) => /\/repo\/agents\.md$/i.test(p)),
      JSON.stringify({ excludes: clSpreadOpts.settings?.claudeMdExcludes }));

    // ほかのエージェントのセルだけを触った場所では、Claude の起動は今までと同じ（AGENTS.md も外さない）
    const devinOnlyPolicy = contextPolicy(attachDocPolicy(baseSettings, rawCfg, normalizeDocAgentsConfig({
      version: 1,
      defaults: { instruction: { agents: { [keyRepoAgents]: { off: ['devin'], spread: [] } } } },
      places: {},
    })));
    const devinOnlyRuntime = await resolveRuntime(devinOnlyPolicy, { home, agent: 'claude' });
    const devinOnlyOpts = claudeContextOptions({ owners: devinOnlyPolicy.owners, docs: devinOnlyRuntime.docs, prompt: devinOnlyRuntime.prompt });
    t.ok('Claude: Devin のセルだけを触った場所では claudeMdExcludes を渡さず、注入もしない',
      !devinOnlyOpts.settings?.claudeMdExcludes && !devinOnlyRuntime.prompt.includes('REPO_AGENTS_COMMON') && !devinOnlyRuntime.prompt.includes('REPO_CLAUDE_SECRET'),
      JSON.stringify({ settings: devinOnlyOpts.settings }));

    // Skill を 2 つのうち 1 つだけオフにした場合（Claude で s-claude オフ・新スキル s-kept 残し）
    await write(path.join(repo, '.claude', 'skills', 's-kept', 'SKILL.md'), '---\nname: s-kept\ndescription: Kept\n---\nKEPT');
    const clSelectiveAgents = normalizeDocAgentsConfig({
      version: 1,
      defaults: { skill: { agents: { 'skill:s-claude': { off: ['claude'], spread: [] } } } },
      places: {},
    });
    const clSelPolicy = contextPolicy(attachDocPolicy(baseSettings, rawCfg, clSelectiveAgents));
    const clSelRuntime = await resolveRuntime(clSelPolicy, { home, agent: 'claude' });
    const clSelOpts = claudeContextOptions({ owners: clSelPolicy.owners, docs: clSelRuntime.docs, prompt: clSelRuntime.prompt });
    t.ok('Claude: 複数スキルのうち 1 つ残しなら skills: [残す名前] になる',
      Array.isArray(clSelOpts.skills) && clSelOpts.skills.join(',') === 's-kept' && !clSelOpts.disallowedTools);

    // Codex RPC: 指示 1 件オフ -> project_doc_max_bytes=0 + 残りの渡し直し、スキル部分オフ -> skills.config
    const cxRuntime = await resolveRuntime(mixedPolicy, { home, agent: 'codex' });
    const fakeRpc = {
      requests: [],
      async request(method) {
        this.requests.push(method);
        if (method === 'skills/list') {
          return {
            data: [{
              skills: [
                { path: path.join(repo, '.codex', 'skills', 's-codex', 'SKILL.md') },
                { path: path.join(repo, '.agents', 'skills', 's-common', 'SKILL.md') },
              ],
            }],
          };
        }
        return { config: { mcp_servers: {} } };
      },
    };
    const cxRpc = await codexContextRpc({ owners: mixedPolicy.owners, docs: cxRuntime.docs, mcp: { named: true, suppress: [] } }, repo, fakeRpc);
    t.ok('Codex: 選択的スキル停止は該当パスの skills.config disabled だけで features.plugins は残す（残すネイティブスキルあり）',
      Array.isArray(cxRpc.config['skills.config'])
      && cxRpc.config['skills.config'].length === 1
      && cxRpc.config['skills.config'][0].path.endsWith('SKILL.md')
      && cxRpc.config['features.plugins'] === undefined
      && !cxRpc.config.project_doc_max_bytes);
    t.ok('Codex: Claude 由来 s-claude が遅れて deliver に乗り、contextTools から load_skill できる',
      (await contextTools(cxRuntime).call('load_skill', { id: cxRuntime.skills.find((s) => s.name === 's-claude').id })).content[0].text.includes('CLAUDE_SKILL_BODY'));

    // OpenCode: untouched のままなら native、1 件でも外せば ply として managedServer 対象
    t.ok('OpenCode: effectiveOpencodeOwners は docs の抑制有無で切り替わる',
      effectiveOpencodeOwners({ owners: { instruction: 'native', skill: 'native', mcp: 'native' }, docs: { instruction: { untouchedNative: true, suppress: [] }, skill: { untouchedNative: false, suppress: [{ path: 'x' }] } } }).instruction === 'native'
      && effectiveOpencodeOwners({ owners: { instruction: 'native', skill: 'native', mcp: 'native' }, docs: { instruction: { untouchedNative: true, suppress: [] }, skill: { untouchedNative: false, suppress: [{ path: 'x' }] } } }).skill === 'ply');

    // Antigravity: custom agent inheritCustomizations は Skill が抑制あるときだけ false
    const agDefKeep = agentDefinition({ owners: { instruction: 'native', skill: 'native', mcp: 'native' }, prompt: '', cwd: repo, home, locale: 'ja' });
    const agDefSuppressSkill = agentDefinition({ owners: { instruction: 'native', skill: 'ply', mcp: 'native' }, prompt: '', cwd: repo, home, locale: 'ja' });
    t.ok('Antigravity: Skill 抑制無しのとき inheritCustomizations: true、抑制ありで false',
      agDefKeep.includes('inheritCustomizations: true') && agDefSuppressSkill.includes('inheritCustomizations: false'));

    // Devin: 取り込みは表で止めない（ADR 0337 §決定 8）。Claude 形式の指示を off と書いても鍵付きでオンのまま、--config も MCP も main と同じ
    const dvOffAgents = normalizeDocAgentsConfig({
      version: 1,
      defaults: { instruction: { agents: { [keyRepoClaude]: { off: ['devin'], spread: [] } } } },
      places: {},
    });
    const dvPolicy = contextPolicy(attachDocPolicy(baseSettings, rawCfg, dvOffAgents));
    const dvRuntime = await resolveRuntime(dvPolicy, { home, agent: 'devin' });
    const dvCfg = devinTurnConfig({ hooksRuntime: null });
    t.ok('Devin: 取り込む物を off と書いても止めず（suppress 空）、--config を作らず、Claude 形式の MCP を Pleiad から渡さない',
      dvCfg === null
      && (dvRuntime.docs?.instruction?.suppress.length ?? 0) === 0
      && !dvRuntime.servers.some((s) => s.name === 'claudemcp')
      && dvRuntime.docs?.skill == null,
      JSON.stringify({ suppress: dvRuntime.docs?.instruction?.suppress.map((e) => e.path), servers: dvRuntime.servers.map((s) => s.name) }));
    const dvMatrix = resolveDocForAgent({ kind: 'instruction', agent: 'devin', entries: [], legacyConfig: rawCfg, docAgentsConfig: dvOffAgents, cwd: repo, home }).matrix;
    t.ok('Devin: まとめの行（CLAUDE.md・AGENTS.md）の Devin のマスは鍵付きでオン（止めると Hooks・MCP も止まる）',
      dvMatrix.summaryRow.cells.devin.locked && dvMatrix.summaryRow.cells.devin.on && dvMatrix.summaryRow.cells.devin.reason === 'bundled');

    // Grok: resolveDocForAgent は常に untouchedNative=true / suppress=[] / deliver=[]
    const grokDoc = resolveDocForAgent({ kind: 'instruction', agent: 'grok', entries: [], legacyConfig: rawCfg, docAgentsConfig: mixedDocAgents, cwd: repo, home });
    t.ok('Grok: resolveDocForAgent は常に untouchedNative=true・suppress/deliver 空',
      grokDoc.untouchedNative === true && grokDoc.suppress.length === 0 && grokDoc.deliver.length === 0);

    // followSettings は docSourceState 変化を検出し keepNative では無視する
    const afterFollow = followSettings(mixedPolicy, attachedUntouched);
    t.ok('followSettings は Stage 2 状態の変化を changed に検出し、keepNative では無効のまま',
      afterFollow.changed.includes('instruction') && followSettings(null, attachedMixed, { keepNative: true }).policy.keepNative === true);

    // contextBridge.open は docs を返す
    bridge = createContextBridge();
    server = http.createServer(bridge.handle);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    connection = await bridge.open({ runtime: clRuntime, prompt: clRuntime.prompt, origin: `http://127.0.0.1:${server.address().port}`, isActive: () => true });
    t.ok('contextBridge.open() は runtime.docs を引き渡す', Boolean(connection.docs?.instruction && connection.docs?.skill));
    await connection.close();
    await bridge.dispose(); server.close(); connection = null; bridge = null; server = null;

    // ---- 3. ops riskOf & 実サーバー統合検査 (WS: docMatrix / setDocAgent / setDocRow / setPlyInstructions / 場所削除連動)
    const opWrite = await registry.invoke(
      { by: 'agent', via: 'mcp', sessionId: 's1', mode: { scope: 'workspace', autonomy: 'ask' } },
      'context.setDocAgent',
      { kind: 'instruction', key: 'file:/x', agent: 'claude', on: false },
      { context: { setDocAgent: async () => ({ ok: true }) }, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), reason: 'off' },
    );
    const opGuarded = await registry.invoke(
      { by: 'agent', via: 'mcp', sessionId: 's1', mode: { scope: 'workspace', autonomy: 'ask' } },
      'context.setDocAgent',
      { kind: 'instruction', key: 'file:/x', agent: 'claude', on: true },
      { context: { setDocAgent: async () => ({ ok: true }) }, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), approve: async () => ({ pending: true, requestId: 'req-1' }), reason: 'on' },
    );
    t.ok('ops riskOf: setDocAgent(on=false) は write で即実行、on=true は guarded で承認待ち',
      opWrite.ok === true && opGuarded.pending === true,
      JSON.stringify({ opWrite, opGuarded }));

    const osHome = path.join(tmp, 'os-home');
    await fs.mkdir(path.join(osHome, '.claude'), { recursive: true });
    await fs.writeFile(path.join(osHome, '.claude', 'CLAUDE.md'), 'NEVER_SCAN_OS_HOME\n');
    host = await startServer({ dataDir, env: {
      AGENT_HOST_BACKENDS: 'fake,devin',
      AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`,
      HOME: osHome,
      USERPROFILE: osHome,
      PLEIAD_SCAN_HOME: home,
    } });
    client = await open(host);

    const initM = await client.cmd('docMatrix', { kind: 'instruction', place: 'default' });
    t.ok('WS docMatrix(default): untouched で summaryRow(__workspace__) とユーザー行を返す',
      initM.touched === false && initM.summaryRow.key === WORKSPACE_SUMMARY_KEY
      && initM.rows.some((r) => r.scope === 'user' && r.name === 'CLAUDE.md'));

    // ユーザーの CLAUDE.md を Codex へ広げる
    const userRow = initM.rows.find((r) => r.scope === 'user' && r.name === 'CLAUDE.md');
    await client.cmd('setDocAgent', { kind: 'instruction', key: userRow.key, agent: 'codex', on: true, place: 'default' });
    const afterToggle = await client.cmd('docMatrix', { kind: 'instruction', place: 'default' });
    t.ok('WS setDocAgent 後は touched=true になり、Codex が spread ON で永続化される',
      afterToggle.touched === true && afterToggle.rows.find((r) => r.key === userRow.key).cells.codex.on === true);

    // agent handler 側（ページネーション・maskTree・maxChars）も ops 経由で検査
    const opDocM = await registry.invoke(
      { by: 'agent', via: 'mcp', sessionId: 's1' },
      'context.docMatrix',
      { kind: 'instruction', place: repo, limit: 1, maxChars: 120 },
      { context: { docMatrix: (a) => client.cmd('docMatrix', a) } },
    );
    t.ok('AI 向け context.docMatrix handler は limit=1 でページ分割し total・next を返す',
      opDocM.ok && opDocM.result.rows.length === 1 && opDocM.result.total >= 2 && Boolean(opDocM.result.next));

    // setDocRow で場所のまとめ切り替え + setContextSettings({ remove: true }) で同期削除
    const wsM = await client.cmd('docMatrix', { kind: 'instruction', cwd: repo, place: repo });
    await client.cmd('setDocRow', { kind: 'instruction', key: docItemKey(wsM.rows.find((r) => r.name === 'AGENTS.md')), on: false, place: repo, cwd: repo });
    const afterPlaceEdit = await client.cmd('docMatrix', { kind: 'instruction', cwd: repo, place: repo });
    t.ok('WS setDocRow(place) でその場所だけの設定ができ、AGENTS.md のアンロックセルが全て off になる',
      afterPlaceEdit.rows.find((r) => r.name === 'AGENTS.md').cells.claude.on === false
      && afterPlaceEdit.rows.find((r) => r.name === 'AGENTS.md').cells.codex.on === false
      && afterPlaceEdit.rows.find((r) => r.name === 'AGENTS.md').cells.grok.on === true);

    // prepareTurn の resolveRuntime も HOME/USERPROFILE ではなく PLEIAD_SCAN_HOME(SCAN_OPTIONS) で解決する
    // Devin は自分で取り込む物を止めないので、Devin が読まないユーザーの Codex の指示を Devin へ広げて、Pleiad が渡す物を作る
    await write(path.join(home, '.codex', 'AGENTS.md'), 'USER_CODEX_INST');
    const keyUserCodex = docItemKey({ kind: 'instruction', path: path.join(home, '.codex', 'AGENTS.md') });
    await client.cmd('setDocAgent', { kind: 'instruction', key: keyUserCodex, agent: 'devin', on: true, place: repo, cwd: repo });
    const sScanHome = await client.cmd('newSession', { cwd: repo, backend: 'devin' });
    await client.runTurn({ ...sScanHome, prompt: 'echo:scan-home', model: 'swe-2-high' }, { ms: 60_000 });
    const scanHomeRec = await client.cmd('sessionContext', sScanHome);
    const recPaths = (scanHomeRec?.report?.entries ?? []).map((e) => String(e.path ?? '').toLowerCase());
    t.ok('WS ターン実行時も os.homedir() ではなく PLEIAD_SCAN_HOME から指示を読む',
      recPaths.some((p) => p.startsWith(home.toLowerCase())) && !recPaths.some((p) => p.includes('os-home')),
      JSON.stringify(recPaths));

    // 未操作と変更ありでゼロ変更バイパスを確認（fake セッションの contextSession で native vs ply）
    const sNative = await client.cmd('newSession', { cwd: repo, backend: 'fake' });
    // fake backend でも、スキル未編集（all native）時は Stage 2 touched(instruction)=true なので instruction だけ active
    // 代わりに codex をオフにした場所と未変更スキルを確認するなら、場所を削除して元に戻すと native に戻る
    await client.cmd('setContextSettings', { place: repo, remove: true });
    const agentsDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'context-agents.json'), 'utf8'));
    t.ok('setContextSettings(remove: true) で context-agents.json の該当 place も同期削除される',
      !Object.hasOwn(agentsDisk.places ?? {}, pathKey(repo)));

    // 既定も含めて消して完全 untouched 状態のセッションを実行
    await fs.rm(path.join(dataDir, 'context-agents.json'), { force: true });
    await client.runTurn({ ...sNative, prompt: 'echo:zero-change' }, { ms: 60_000 });
    const nativeRecord = await client.cmd('sessionContext', sNative);
    t.ok('完全未操作の会話は status=native でゼロ変更バイパスを通る',
      nativeRecord.report?.status === 'native', JSON.stringify(nativeRecord.report));

    // WS setPlyInstructions toggleAgent で Grok をオンにできる
    const ply0 = await client.cmd('plyInstructions', {});
    const targetItem = ply0.items.find((i) => i.tag !== 'linked');
    const grokWasOn = targetItem.agents.includes('grok');
    const ply1 = await client.cmd('setPlyInstructions', { action: 'toggleAgent', id: targetItem.id, agent: 'grok', on: !grokWasOn });
    t.ok('WS setPlyInstructions(toggleAgent) で Grok を切り替えられる',
      ply1.items.find((i) => i.id === targetItem.id).agents.includes('grok') === !grokWasOn);
  } finally {
    if (connection) await connection.close().catch(() => {});
    if (bridge) await bridge.dispose().catch(() => {});
    if (server) server.close();
    client?.close();
    if (host) await host.stop().catch(() => {});
    await cleanupTestHolder(dataDir).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
