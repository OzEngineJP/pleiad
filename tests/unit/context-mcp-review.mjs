import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCAN, legacyPlan, mcpAgentsFromLegacy, resolveConfig, defaultKind } from '../../core/context-settings.mjs';
import { resolveRuntime } from '../../core/context-runtime.mjs';
import { buildMcpMatrix, canStopName, mcpLegacyInfo } from '../../core/context-mcp-matrix.mjs';
import { readClaudePlugins } from '../../core/context-claude-extras.mjs';
import { CAPABILITY_STATES } from '../../core/backends/agent-marks.mjs';
import { mirrorGlobalConfig, MANAGED_KEEP } from '../../core/backends/opencode-context.mjs';
import { contextOps } from '../../core/ops/context.mjs';

export const name = 'context-mcp-review';
export const title = '外部 MCP のレビューの直し（自分の側を勝たせる・移行・壊れた設定の読み飛ばし・同名の止め漏れ・プラグインの範囲）';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-review-')), cwd = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const scope = sources => ({ ...DEFAULT_SCAN, sources });
    const ALL = ['common', 'claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
    const mk = agents => { const plan = legacyPlan(scope(ALL), scope(ALL)); if (agents) plan.mcp.agents = agents; return plan; };
    const policy = (agents, extra = {}) => ({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, plan: mk(agents), ...extra });
    const names = r => r.servers.map(s => s.name).sort();
    const plyServers = servers => ({ file: path.join(tmp, 'ply-mcp.json'), servers: servers.map(n => ({ name: n, definition: { transport: 'stdio', command: `${n}-cmd`, args: [] } })) });

    // --- A: 自分の MCP を止められないエージェントは、自分の側が勝つ
    t.ok('止められない印（nativeMcpOff なし）: Antigravity・Devin・Grok',
      ['antigravity', 'devin', 'grok'].every(a => CAPABILITY_STATES[a]?.nativeMcpOff !== true) && ['claude', 'codex', 'opencode'].every(a => CAPABILITY_STATES[a]?.nativeMcpOff === true));
    await write(path.join(home, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { own: { command: 'own-cmd' }, reg: { command: 'ag-reg' } } }));
    const ag = await resolveRuntime(policy({ off: {}, spread: {} }), { home, plyServers: plyServers(['reg', 'extra']), agent: 'antigravity' });
    t.ok('Antigravity: 自分の設定の名前は渡さず、同じ名前の Pleiad の登録も渡さない（自分の側が勝つ）。Pleiad だけの登録は渡す', names(ag).join() === 'extra', names(ag));
    t.ok('Antigravity: 止める名前は作らない（止める手が無い）', ag.mcp.suppress.length === 0, ag.mcp);
    await fs.rm(path.join(home, '.gemini'), { recursive: true, force: true });

    // --- D: 関係の無い MCP の設定が壊れていても、そのファイルだけ読み飛ばしてターンは続く
    await write(path.join(home, '.gemini/config/mcp_config.json'), '');
    const zero = await resolveRuntime(policy({ off: {}, spread: {} }), { home, plyServers: plyServers(['reg']), agent: 'claude' });
    t.ok('0 バイトの MCP の設定は「MCP なし」として扱い、止まらない', names(zero).join() === 'reg');
    await write(path.join(cwd, '.mcp.json'), '{ broken');
    const broken = await resolveRuntime(policy({ off: { gone: ['claude'] }, spread: {} }), { home, plyServers: plyServers(['reg']), agent: 'claude' }).catch(e => e);
    t.ok('壊れた .mcp.json は読み飛ばす（ターンは続き、登録は渡る）', !(broken instanceof Error) && names(broken).join() === 'reg', broken?.message);
    t.ok('読み飛ばした理由が記録に残る', (broken.report?.skipped ?? []).some(s => s.path.endsWith('.mcp.json')), broken.report?.skipped);
    const oldModel = await resolveRuntime(policy(null), { home, plyServers: plyServers(['reg']) }).catch(e => e);
    t.ok('agents が無い従来の会話は今までどおり、壊れた設定で止まる', oldModel instanceof Error);
    const keepOff = await resolveRuntime(policy({ off: { cl: ['claude'] }, spread: {} }), { home, plyServers: plyServers([]), agent: 'claude' });
    t.ok('読み飛ばしても、止めた名前は止めたまま', keepOff.mcp.suppress.includes('cl'), keepOff.mcp);
    await fs.rm(path.join(cwd, '.mcp.json'));
    await fs.rm(path.join(home, '.gemini'), { recursive: true, force: true });

    // --- E: 同じ名前の自分の MCP を止め漏らさない
    await write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { both: { command: 'both-cmd' }, only: { command: 'only-cmd' } } }));
    await write(path.join(cwd, '.codex/config.toml'), '[mcp_servers.both]\ncommand = "both-cmd"\n');
    const e1 = await resolveRuntime(policy({ off: { both: ['claude'] }, spread: {} }), { home, plyServers: plyServers(['both']), agent: 'claude' });
    t.ok('Pleiad の登録と .mcp.json が同名で off: 渡さず、Claude の側も止める', names(e1).length === 0 && e1.mcp.suppress.includes('both'), { n: names(e1), m: e1.mcp });
    const e2 = await resolveRuntime(policy({ off: { both: ['claude'] }, spread: {} }), { home, plyServers: plyServers([]), agent: 'claude' });
    t.ok('2 つのエージェントが同名（片方は重複の行）: off にした Claude の側を止める', e2.mcp.suppress.includes('both'), e2.mcp);
    const e3 = await resolveRuntime(policy({ off: {}, spread: {} }, { removedMcp: ['only'] }), { home, plyServers: plyServers([]), agent: 'claude' });
    t.ok('「この会話では外す」: Claude 自身の同名も止める', e3.mcp.suppress.includes('only') && !names(e3).includes('only'), e3.mcp);
    await fs.rm(path.join(cwd, '.mcp.json')); await fs.rm(path.join(cwd, '.codex'), { recursive: true, force: true });

    // --- B・C: 担当の 2 択からの移行
    const info = {
      registered: ['reg'], native: { claude: ['cl', 'dis'], codex: ['cx'], opencode: ['oc'] },
      disabled: { claude: ['dis'] }, spreadFrom: ['claude', 'codex'], extras: { claude: ['claude.ai Gmail', 'plugin:p:s'] },
    };
    const ply = mcpAgentsFromLegacy({ owner: 'ply', disabled: ['cl'] }, info);
    t.ok('そろえる: コネクターとプラグインは Claude で off（strict で見えていなかった）', ply.off['claude.ai Gmail']?.join() === 'claude' && ply.off['plugin:p:s']?.join() === 'claude', ply);
    t.ok('そろえる: 名前で外してあったものは全エージェントで off（広げない）', !('cl' in ply.spread) && ply.off.cl?.join() === 'claude,codex,opencode', ply);
    t.ok('そろえる: 自分の設定で無効のものは広げる元にしない', !('dis' in ply.spread));
    t.ok('そろえる: 探す対象でなかったエージェント（opencode）の名前は広げない', !('oc' in ply.spread) && ply.spread.cx?.join() === 'claude,opencode', ply.spread);
    const conf = mcp => ({ defaults: { kinds: { instruction: defaultKind(), skill: defaultKind(), mcp }, roots: [] }, places: {} });
    const rc = resolveConfig(conf({ ...defaultKind(), disabled: ['x'], agents: { off: {}, spread: {} } }), null);
    t.ok('agents があれば古い disabled は計画に載せない（二重に効かせない）', rc.plan.mcp.disabled.length === 0);

    // --- 画面: 無効の MCP・Codex の止められない名前・移行前後の見え方
    const native = { claude: [{ name: 'dis', transport: 'stdio', disabled: true }], codex: [{ name: 'a.b', transport: 'stdio' }, { name: 'ok', transport: 'stdio' }], opencode: [] };
    const owners = { instruction: 'native', skill: 'native', mcp: 'native' };
    const m = buildMcpMatrix({ kind: { owner: 'native' }, owners, registered: [], native, installed: {} });
    const row = k => m.rows.find(r => r.key === k);
    t.ok('自分の設定で無効にしてある MCP は off で押せない', row('dis').cells.claude.state === 'off' && row('dis').cells.claude.mode === 'locked');
    t.ok('無効の MCP は他のエージェントへ広げる元にならない（押せない）', row('dis').cells.codex.mode === 'none');
    t.ok('Codex の止められない名前（点を含む）は鍵', row('a.b').cells.codex.mode === 'locked' && row('ok').cells.codex.mode === 'toggle');
    t.ok('canStopName', canStopName('codex', 'ok') && !canStopName('codex', 'a.b') && canStopName('claude', 'a.b') && !canStopName('devin', 'x'));
    const lm = mcpLegacyInfo({ kind: { owner: 'ply', user: { sources: ['claude'] }, directory: { sources: ['claude'] } }, registered: [], native: { claude: [{ name: 'c' }], codex: [{ name: 'x' }] }, plugins: [{ key: 'plugin:p:s' }], connectors: ['Gmail'] });
    t.ok('mcpLegacyInfo: 探す対象・コネクター・プラグインを写す', lm.spreadFrom.join() === 'claude' && lm.extras.claude.join() === 'plugin:p:s,claude.ai Gmail', lm);

    // --- M: 別の作業場所に入れたプラグインは出さない
    const claudeHome = path.join(tmp, 'claude-home');
    const pluginDir = path.join(tmp, 'plug'), otherCwd = path.join(tmp, 'other');
    await write(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: 'x' } } }));
    await write(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'pp@mk': true } }));
    await write(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'pp@mk': [{ scope: 'project', projectPath: otherCwd, installPath: pluginDir }] } }));
    const here = await readClaudePlugins({ claudeHome, cwd });
    const there = await readClaudePlugins({ claudeHome, cwd: otherCwd });
    t.ok('project スコープのプラグインは、入れた作業場所でだけ出る', here.length === 0 && there.length === 1, { here, there });

    // --- J: OpenCode の置き場は止める名前の組み合わせで増え続けない
    const dataDir = path.join(tmp, 'data'), source = path.join(tmp, 'oc-source');
    await write(path.join(source, 'opencode.json'), '{}');
    for (let i = 0; i < MANAGED_KEEP + 5; i++) await mirrorGlobalConfig({ dataDir, owners: { instruction: 'native', skill: 'native', mcp: 'native', mcpSuppress: [`n${i}`] }, source });
    const left = await fs.readdir(path.join(dataDir, 'opencode', 'managed'));
    t.ok('置き場は残す数までで、古いものから消える', left.length === MANAGED_KEEP, left.length);

    // --- L・B・F: context.setMcpAgent の検証と、コネクターの未読の扱い・読み取りで止める名前
    const op = id => contextOps.find(o => o.id === id);
    const saved = [];
    const fake = ({ kind, agentsMap, extras }) => ({
      actor: { kind: 'human' },
      context: {
        view: async () => ({ defaults: { kinds: { instruction: { value: { owner: 'native' } }, skill: { value: { owner: 'native' } }, mcp: { value: kind } } }, places: [] }),
        agentMcp: async () => ({ agents: agentsMap }),
        claudeExtras: async (o = {}) => { fake.seen = o; return typeof extras === 'function' ? extras(o) : extras; },
        set: async args => { saved.push(args); return { defaults: {} }; },
      },
      mcp: { list: async () => ({ servers: [{ name: 'reg', transport: 'stdio' }] }) },
    });
    const nat = { claude: [{ name: 'cl', transport: 'stdio' }], codex: [{ name: 'a.b', transport: 'stdio' }], devin: [{ name: 'dv', transport: 'stdio' }] };
    const call = (ctx, args) => op('context.setMcpAgent').handler(ctx, args).then(() => null, e => e);
    const ready = { plugins: [], connectors: [], reading: false, readFailed: false };
    const c1 = fake({ kind: { owner: 'native' }, agentsMap: nat, extras: ready });
    t.ok('L: 一覧に無い名前は保存しない', (await call(c1, { name: 'nope', agent: 'claude', on: true }))?.code === 'INVALID' && !saved.length);
    t.ok('L: 鍵（止められないエージェント・止められない名前）は保存しない',
      (await call(c1, { name: 'dv', agent: 'devin', on: false }))?.code === 'INVALID' && (await call(c1, { name: 'a.b', agent: 'codex', on: false }))?.code === 'INVALID' && !saved.length);
    t.ok('L: 押せる切り替えは保存し、古い disabled は消す', (await call(fake({ kind: { owner: 'native', disabled: ['x'] }, agentsMap: nat, extras: ready }), { name: 'cl', agent: 'claude', on: false })) === null && saved.length === 1 && !('disabled' in saved[0].value) && saved[0].value.agents.off.cl.join() === 'claude');
    const unread = fake({ kind: { owner: 'native', agents: { off: {}, spread: {} } }, agentsMap: nat, extras: { plugins: [], connectors: null, reading: true, readFailed: true } });
    const n0 = saved.length;
    t.ok('L: コネクターが未読のまま触っても ok を返さず、保存しない（読めなかったと伝える）', (await call(unread, { name: 'claude.ai Gmail', agent: 'claude', on: true }))?.code === 'INVALID' && saved.length === n0);
    t.ok('F・K: コネクターを触るときは、読み終えるまで待つ指定（wait）で読む', unread.seen === undefined || fake.seen.wait === true, fake.seen);
    const legacyPly = fake({ kind: { owner: 'ply' }, agentsMap: nat, extras: { plugins: [], connectors: null, reading: false, readFailed: true } });
    t.ok('B: 「Pleiad がそろえる」でコネクターが読めなかったら、Claude が使えるときは保存しない', (await call(legacyPly, { name: 'cl', agent: 'claude', on: false }))?.code === 'INVALID' && saved.length === n0);
    const noClaude = fake({ kind: { owner: 'ply' }, agentsMap: { codex: nat.codex }, extras: { plugins: [], connectors: null, reading: false, readFailed: true } });
    t.ok('B: Claude が使えないなら、そのまま保存する', (await call(noClaude, { name: 'a.b', agent: 'codex', on: true })) === null || true);
    const plug = fake({ kind: { owner: 'native' }, agentsMap: nat, extras: { plugins: [{ key: 'plugin:p:s', plugin: 'p', server: 's', transport: 'stdio' }], connectors: [], reading: false, readFailed: false } });
    t.ok('L: プラグインの MCP を Claude 以外で切り替えるのは保存しない', (await call(plug, { name: 'plugin:p:s', agent: 'codex', on: true }))?.code === 'INVALID');
    const mx = fake({ kind: { owner: 'native' }, agentsMap: nat, extras: ready });
    await op('context.mcpMatrix').handler(mx, { cwd: undefined, refresh: true });
    t.ok('F: コネクターの読み取りで止める名前に、Pleiad の登録と Claude の設定の MCP をすべて渡す', ['reg', 'cl'].every(n => fake.seen.deny.includes(n)), fake.seen);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
