import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCAN, defaultKind, legacyPlan, normalizeAgents, resolveConfig } from '../../core/context-settings.mjs';
import { agentMcpRules, resolveRuntime } from '../../core/context-runtime.mjs';
import { claudeContextOptions } from '../../core/backends/context-options.mjs';

export const name = 'context-agent-mcp';
export const title = '外部 MCP を名前ごとに中継する・止める（名前 × エージェントのモデル。担当の 2 択との互換）';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agent-mcp-')), cwd = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { cl: { command: 'cl-cmd' }, both: { command: 'both-cmd' } } }));
    await write(path.join(cwd, '.codex/config.toml'), '[mcp_servers.cx]\ncommand = "cx-cmd"\n[mcp_servers.both]\ncommand = "both-cmd"\n');
    const plyServers = { file: path.join(tmp, 'ply-mcp.json'), servers: [{ name: 'reg', definition: { transport: 'stdio', command: 'reg-cmd', args: [] } }] };
    const scope = sources => ({ ...DEFAULT_SCAN, sources });
    const mk = agents => {
      const plan = legacyPlan(scope(['common', 'claude', 'codex']), scope(['common', 'claude', 'codex']));
      if (agents) plan.mcp.agents = agents;
      return plan;
    };
    const policy = (agents, owners = { instruction: 'native', skill: 'native', mcp: 'native' }, agent) => ({ version: 2, cwd, owners: { ...owners, mcp: 'ply' }, plan: mk(agents), ...(agent ? { agent } : {}) });
    const names = r => r.servers.map(s => s.name).sort();
    const row = (r, n) => r.report.entries.filter(e => e.kind === 'mcp' && e.name === n);

    // --- 設定の形
    t.ok('normalizeAgents: 空の名前を消し、エージェントを昇順・重複なしにする',
      JSON.stringify(normalizeAgents({ off: { a: ['codex', 'claude', 'codex'], b: [] }, spread: {} })) === JSON.stringify({ off: { a: ['claude', 'codex'] }, spread: {} }));
    const kindsOf = mcp => ({ instruction: defaultKind(), skill: defaultKind(), mcp });
    const conf = mcp => ({ defaults: { kinds: kindsOf(mcp), roots: [] }, places: {} });
    const noAgents = resolveConfig(conf(defaultKind()), null);
    t.ok('agents が無ければ従来どおり（担当は native のまま・plan に agents を足さない）', noAgents.owners.mcp === 'native' && !('agents' in noAgents.plan.mcp));
    const withAgents = resolveConfig(conf({ ...defaultKind(), agents: { off: { a: ['codex'] }, spread: {} } }), null);
    t.ok('agents があれば担当は ply（中継を常に開く）で、plan に agents が載る', withAgents.owners.mcp === 'ply' && withAgents.plan.mcp.agents.off.a[0] === 'codex');

    // --- 中継の規則（agent = claude）
    const agents = { off: { reg: ['codex'], cl: ['claude'] }, spread: { cx: ['claude'] } };
    const rules = agentMcpRules(mk(agents), 'claude');
    t.ok('agents が無い計画では規則を作らない', agentMcpRules(mk(null), 'claude') === null && agentMcpRules(mk(agents), null) === null);
    t.ok('規則を作れる', !!rules);

    const rt = await resolveRuntime(policy(agents), { home, plyServers, agent: 'claude' });
    // reg: Pleiad の登録（claude では off でない）→ 中継。cl: claude 自身の設定 → 渡さない（かつ off なので止める）。
    // cx: codex の設定で claude へ広げた → 中継。both: claude 自身も持つ → 渡さない
    t.ok('claude: 登録と広げた codex の定義だけを中継する', JSON.stringify(names(rt)) === JSON.stringify(['cx', 'reg']), names(rt));
    t.ok('claude: off にした自分の MCP だけを止める名前に出す', JSON.stringify(rt.mcp.suppress) === JSON.stringify(['cl']) && rt.mcp.named === true, rt.mcp);
    t.ok('claude: 行の記録に理由が残る（off は removed、自分で読むものは excluded）',
      row(rt, 'cl').some(e => e.status === 'removed') && row(rt, 'both').some(e => e.status === 'excluded'));

    const rtx = await resolveRuntime(policy(agents), { home, plyServers, agent: 'codex' });
    t.ok('codex: 登録は off、codex 自身の設定は渡さない、広げていない claude の定義も渡さない', names(rtx).length === 0, names(rtx));
    t.ok('codex: 止める名前は無い（off は reg だけで codex 自身の設定には無い）', rtx.mcp.suppress.length === 0, rtx.mcp);

    // 同じ名前を Pleiad も持つとき、エージェント自身の側は止める（二重につながない）
    const dupPlyServers = { file: plyServers.file, servers: [{ name: 'both', definition: { transport: 'stdio', command: 'reg-both', args: [] } }] };
    const rtd = await resolveRuntime(policy({ off: {}, spread: {} }), { home, plyServers: dupPlyServers, agent: 'codex' });
    t.ok('Pleiad と自分の設定に同じ名前: Pleiad が渡し、自分側は止める', names(rtd).join() === 'both' && rtd.mcp.suppress.join() === 'both', { n: names(rtd), m: rtd.mcp });

    // agents が無ければ、従来の結果（named: false・suppress 空）
    const rtl = await resolveRuntime({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, plan: mk(null) }, { home, plyServers });
    t.ok('agents が無い会話は従来どおり（named: false）', rtl.mcp.named === false && rtl.mcp.suppress.length === 0);

    // --- エージェントごとの止め方（Claude）
    const base = { owners: rt.owners, prompt: '', url: 'http://localhost/context', headers: {} };
    const named = claudeContextOptions({ ...base, mcp: rt.mcp });
    t.ok('Claude: 名前ごとのモデルは strictMcpConfig にせず deniedMcpServers で止める',
      !named.strictMcpConfig && JSON.stringify(named.settings.deniedMcpServers) === JSON.stringify([{ serverName: 'cl' }]), named.settings);
    const legacy = claudeContextOptions({ ...base, mcp: { named: false, suppress: [] } });
    t.ok('Claude: 従来の「Pleiad がそろえる」は strictMcpConfig のまま', legacy.strictMcpConfig === true && !legacy.settings?.deniedMcpServers);
    const noMcp = claudeContextOptions({ ...base, mcp: { named: true, suppress: [] } });
    t.ok('Claude: 止める名前が無ければ deniedMcpServers を付けない', !noMcp.settings?.deniedMcpServers);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
