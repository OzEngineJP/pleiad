import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMcpMatrix, relayBlocked } from '../../core/context-mcp-matrix.mjs';
import { createConnectorReader, connectorNames, readClaudePlugins } from '../../core/context-claude-extras.mjs';
import { DEFAULT_SCAN, legacyPlan, mcpAgentsFromLegacy } from '../../core/context-settings.mjs';
import { resolveRuntime } from '../../core/context-runtime.mjs';

export const name = 'context-mcp-matrix';
export const title = '外部 MCP の一覧（名前 × エージェント）・プラグインとコネクターの読み取り・更新前後で今の接続が変わらないこと';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-matrix-')), cwd = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  try {
    // --- 一覧の組み立て
    const native = {
      claude: [{ name: 'cl', transport: 'stdio' }, { name: 'both', transport: 'stdio' }],
      codex: [{ name: 'cx', transport: 'http' }, { name: 'both', transport: 'stdio' }],
      grok: [], devin: [{ name: 'dv', transport: 'stdio' }], antigravity: [], opencode: [],
    };
    const base = { kind: { owner: 'native' }, owners: { instruction: 'native', skill: 'native', mcp: 'native' }, registered: [{ name: 'reg', transport: 'http' }], native, installed: {} };
    const m = buildMcpMatrix(base);
    t.ok('列の順は Claude・Codex・Antigravity・OpenCode・Devin・Grok', m.agents.join() === 'claude,codex,antigravity,opencode,devin,grok', m.agents);
    const row = key => m.rows.find(r => r.key === key);
    t.ok('Pleiad の登録の行は「Pleiad に登録」の組で、「任せる」のままなら全部 off（今と同じ）',
      row('reg').group === 'ply' && m.agents.every(a => row('reg').cells[a].state === 'off'));
    t.ok('エージェントの設定にだけある名前は「エージェントの設定」の組で、持つエージェントは on', row('cl').group === 'agent' && row('cl').cells.claude.state === 'on' && row('cl').origins.join() === 'claude');
    t.ok('同じ名前を持つエージェントはすべて出どころに入る', row('both').origins.join() === 'claude,codex');
    t.ok('止められるエージェント（claude・codex・opencode）は toggle、Devin は鍵', row('cl').cells.claude.mode === 'toggle' && row('dv').cells.devin.mode === 'locked');
    t.ok('鍵があれば locked が真', m.locked === true);
    t.ok('他のエージェントの設定にだけある名前は、広げていなければ off で、押せる', row('cx').cells.claude.state === 'off' && row('cx').cells.claude.mode === 'toggle');

    // 「Pleiad がそろえる」: 今そろっている名前は全部 on
    const ply = buildMcpMatrix({ ...base, kind: { owner: 'ply' }, owners: { ...base.owners, mcp: 'ply' } });
    t.ok('「Pleiad がそろえる」の人: 広げられていた名前は他のエージェントでも on', ply.rows.find(r => r.key === 'cx').cells.claude.state === 'on' && ply.rows.find(r => r.key === 'reg').cells.codex.state === 'on');
    t.ok('今は外してあるもの（disabled）は広げない', buildMcpMatrix({ ...base, kind: { owner: 'ply', disabled: ['cx'] } }).rows.find(r => r.key === 'cx').cells.claude.state === 'off');

    // Grok: 指示・Skills を Pleiad が担当すると ply_context を受け取れない
    t.ok('Grok は指示を Pleiad が担当するとき中継を受け取れない', relayBlocked('grok', { instruction: 'ply' }) && !relayBlocked('grok', { instruction: 'native', skill: 'native' }) && !relayBlocked('codex', { instruction: 'ply' }));
    const blocked = buildMcpMatrix({ ...base, owners: { instruction: 'ply', skill: 'native', mcp: 'ply' } });
    t.ok('そのとき Grok の列は、広げる・登録の行で blocked（押せない）', blocked.rows.find(r => r.key === 'reg').cells.grok.mode === 'blocked' && blocked.rows.find(r => r.key === 'cx').cells.grok.mode === 'blocked');

    // プラグインとコネクター
    const rich = buildMcpMatrix({ ...base, plugins: [{ plugin: 'Notion', server: 'notion', key: 'plugin:Notion:notion', transport: 'http' }], connectors: ['Slack'] });
    const plug = rich.rows.find(r => r.kind === 'plugin'), conn = rich.rows.find(r => r.kind === 'connector');
    t.ok('プラグインの MCP は Claude だけ押せて、プラグイン名を持つ', plug.plugin === 'Notion' && plug.cells.claude.mode === 'toggle' && plug.cells.codex.mode === 'none');
    t.ok('コネクターは claude.ai <名前> の行で、Claude だけ押せる', conn.key === 'claude.ai Slack' && conn.cells.claude.mode === 'toggle' && conn.cells.grok.mode === 'none' && conn.group === 'agent');
    t.ok('読み取り中（null）は connectors が reading、空なら none、あれば ready', buildMcpMatrix({ ...base, connectors: null }).connectors === 'reading' && buildMcpMatrix({ ...base, connectors: [] }).connectors === 'none' && rich.connectors === 'ready');
    const noClaude = buildMcpMatrix({ ...base, native: { codex: native.codex }, installed: { claude: false }, connectors: ['Slack'], plugins: [{ plugin: 'P', server: 's', key: 'plugin:P:s' }] });
    t.ok('Claude が無ければ行も凡例も出さない', noClaude.rows.every(r => r.kind === 'config') && noClaude.connectors === 'none');

    // --- プラグインの読み取り
    const claudeHome = path.join(tmp, 'claude-home'), inst = path.join(claudeHome, 'plugins', 'cache', 'notion'), off = path.join(claudeHome, 'plugins', 'cache', 'off');
    await write(path.join(inst, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Notion' }));
    await write(path.join(inst, '.mcp.json'), JSON.stringify({ mcpServers: { notion: { type: 'http', url: 'https://x.invalid/mcp' } } }));
    await write(path.join(off, '.mcp.json'), JSON.stringify({ mcpServers: { gone: { command: 'x' } } }));
    await write(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'notion@mk': [{ installPath: inst }], 'off@mk': [{ installPath: off }] } }));
    await write(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'notion@mk': true, 'off@mk': false } }));
    const plugins = await readClaudePlugins({ claudeHome });
    t.ok('有効なプラグインの MCP だけを plugin:<名>:<サーバー> の名前で読む', plugins.length === 1 && plugins[0].key === 'plugin:Notion:notion' && plugins[0].transport === 'http', plugins);
    t.ok('プラグインが無い置き場は空', (await readClaudePlugins({ claudeHome: path.join(tmp, 'none') })).length === 0);

    // --- コネクターの読み取りと覚え
    t.ok('mcpServerStatus から claude.ai のものだけを名前にする', connectorNames([{ name: 'claude.ai Slack' }, { name: 'cl' }, { name: 'claude.ai Gmail' }]).join() === 'Gmail,Slack');
    const file = path.join(tmp, 'claude-connectors.json');
    let calls = 0, fail = false, seenDeny = null;
    const probe = async ({ deny }) => { calls++; seenDeny = deny; if (fail) throw new Error('boom'); return ['Slack', 'Gmail']; };
    const r1 = createConnectorReader({ file, probe });
    t.ok('最初は一覧が無い（null）', (await r1.get()).connectors === null);
    await r1.refresh({ deny: ['reg'] });
    t.ok('読めたら一覧を返し、止める名前を probe に渡す', (await r1.get()).connectors.join() === 'Gmail,Slack' && seenDeny.join() === 'reg');
    t.ok('覚えは小さい JSON で置き場に残る', JSON.parse(await fs.readFile(file, 'utf8')).connectors.length === 2);
    const r2 = createConnectorReader({ file, probe });
    t.ok('次に起動した側は、読み取りを待たず前の一覧をすぐ出せる', (await r2.get()).connectors.join() === 'Gmail,Slack');
    const r3 = createConnectorReader({ file, probe: async () => { throw new Error('boom'); } });
    const [, early] = await Promise.all([r3.refresh(), r3.get()]);
    t.ok('起動直後に読み取りと表示が重なっても、覚えの一覧が見える', early.connectors?.join() === 'Gmail,Slack', early);
    fail = true; await r2.refresh();
    t.ok('読み取りが失敗しても前の一覧を残す', (await r2.get()).connectors.join() === 'Gmail,Slack');
    fail = false;
    const both = [r2.refresh(), r2.refresh()]; await Promise.all(both);
    t.ok('読み取りは同時に 1 つだけ', calls === 3, calls);

    // --- 更新の前後で、今の接続が変わらない（担当の 2 択 → 名前ごと）
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { cl: { command: 'cl-cmd' }, both: { command: 'both-cmd' } } }));
    await write(path.join(cwd, '.codex/config.toml'), '[mcp_servers.cx]\ncommand = "cx-cmd"\n[mcp_servers.both]\ncommand = "both-cmd"\n');
    const plyServers = { file: path.join(tmp, 'ply-mcp.json'), servers: [{ name: 'reg', definition: { transport: 'stdio', command: 'reg-cmd', args: [] } }] };
    const scope = { ...DEFAULT_SCAN, sources: ['common', 'claude', 'codex'] };
    const info = { registered: ['reg'], native: { claude: ['cl', 'both'], codex: ['cx', 'both'] } };
    for (const owner of ['native', 'ply']) {
      const legacyPlan_ = legacyPlan(scope, scope), namedPlan = legacyPlan(scope, scope);
      namedPlan.mcp.agents = mcpAgentsFromLegacy({ owner }, info);
      for (const agent of ['claude', 'codex']) {
        const before = await resolveRuntime({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: owner }, plan: legacyPlan_, agent }, { home, plyServers, agent });
        const after = await resolveRuntime({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, plan: namedPlan, agent }, { home, plyServers, agent });
        // そのエージェントから見える名前 = Pleiad が渡すもの + 自分の設定のうち止めていないもの。「任せる」は前も後も自分の設定のまま
        const own = info.native[agent];
        const seen = r => [...new Set([...r.servers.map(s => s.name), ...(r.owners.mcp === 'ply' && !r.mcp.named ? [] : own.filter(n => !r.mcp.suppress.includes(n) && !r.servers.some(s => s.name === n)))])].sort().join();
        t.ok(`更新の前後で ${agent} に見える MCP が同じ（もとは「${owner === 'ply' ? 'Pleiad がそろえる' : '任せる'}」）`, seen(before) === seen(after), { before: seen(before), after: seen(after) });
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
