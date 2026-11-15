import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { compensatedMcpFormats } from '../../core/backends/context-capabilities.mjs';
import { agentDefinition } from '../../core/backends/antigravity-context.mjs';
import { claudeContextOptions, codexContextRpc } from '../../core/backends/context-options.mjs';
import { devinTurnConfig } from '../../core/backends/devin-config.mjs';
import { effectiveOpencodeOwners } from '../../core/backends/opencode.mjs';
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
            [keyRepoAgents]: { off: [], spread: ['claude'] },
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
    t.ok('Claude: オフにした CLAUDE.md だけが claudeMdExcludes に入り、他は止めない',
      clOpts.settings?.claudeMdExcludes?.length >= 1
      && clOpts.settings.claudeMdExcludes.some((p) => p.endsWith('/repo/CLAUDE.md'))
      && clOpts.settings.claudeMdExcludes.every((p) => /\/repo\/claude\.md$/i.test(p))
      && !clOpts.settings.claudeMdExcludes.includes('**/CLAUDE.md'),
      JSON.stringify({ docInst: clRuntime.docs?.instruction, excludes: clOpts.settings?.claudeMdExcludes, keyRepoClaude }));
    t.ok('Claude: ネイティブの s-claude は untouchedNative なため Skill を止めず、AGENTS.md を注入する',
      clOpts.skills === undefined && clRuntime.prompt.includes('REPO_AGENTS_COMMON')
      && clRuntime.report.entries.some((e) => e.name === 'CLAUDE.md' && e.scope === 'user' && e.status === 'native' && e.tokens > 0));

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

    // Devin: Claude 由来を止めると read_config_from.claude=false + .mcp.json 補填
    const dvOffAgents = normalizeDocAgentsConfig({
      version: 1,
      defaults: { instruction: { agents: { [keyRepoClaude]: { off: ['devin'], spread: [] } } } },
      places: {},
    });
    const dvPolicy = contextPolicy(attachDocPolicy(baseSettings, rawCfg, dvOffAgents));
    const dvRuntime = await resolveRuntime(dvPolicy, { home, agent: 'devin' });
    const dvCfg = devinTurnConfig({ docs: dvRuntime.docs });
    t.ok('Devin: Claude 指示停止で read_config_from.claude=false になり、.mcp.json を補填対象に入れる',
      dvCfg?.read_config_from?.claude === false
      && compensatedMcpFormats('devin', dvRuntime.docs).includes('claude')
      && dvRuntime.servers.some((s) => s.name === 'claudemcp')
      && !dvRuntime.servers.some((s) => s.name === 'cursormcp'));

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
      && afterPlaceEdit.rows.find((r) => r.name === 'AGENTS.md').cells.grok.on === true);

    // prepareTurn の resolveRuntime も HOME/USERPROFILE ではなく PLEIAD_SCAN_HOME(SCAN_OPTIONS) で解決する
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
