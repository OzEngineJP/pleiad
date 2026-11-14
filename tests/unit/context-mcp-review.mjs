import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCAN, legacyPlan, mcpAgentsFromLegacy, resolveConfig, defaultKind } from '../../core/context-settings.mjs';
import { resolveRuntime } from '../../core/context-runtime.mjs';
import { buildMcpMatrix, canStopName, canStopNative, mcpLegacyInfo, nativeStopBlock } from '../../core/context-mcp-matrix.mjs';
import { canLinkMcpOffHome, nativeMcpOffMode, setMcpOffLinker } from '../../core/backends/mcp-off-home.mjs';
import { readClaudePlugins } from '../../core/context-claude-extras.mjs';
import { CAPABILITY_STATES } from '../../core/backends/agent-marks.mjs';
import { mirrorGlobalConfig, MANAGED_KEEP, MANAGED_IDLE_MS } from '../../core/backends/opencode-context.mjs';
import { contextOps } from '../../core/ops/context.mjs';
import { createContextBridge } from '../../core/context-bridge.mjs';

export const name = 'context-mcp-review';
export const title = '外部 MCP のレビューの直し（自分の側を勝たせる・移行・壊れた設定の読み飛ばし・同名の止め漏れ・プラグインの範囲）';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-review-')), cwd = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  try {
    setMcpOffLinker(() => {}); // リンクを作れる PC として数える（この試験は写しの置き場を作らない。作れない PC は C の試験で差し替える）
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const scope = sources => ({ ...DEFAULT_SCAN, sources });
    const ALL = ['common', 'claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
    const mk = agents => { const plan = legacyPlan(scope(ALL), scope(ALL)); if (agents) plan.mcp.agents = agents; return plan; };
    const policy = (agents, extra = {}) => ({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, plan: mk(agents), ...extra });
    const names = r => r.servers.map(s => s.name).sort();
    const plyServers = servers => ({ file: path.join(tmp, 'ply-mcp.json'), servers: servers.map(n => ({ name: n, definition: { transport: 'stdio', command: `${n}-cmd`, args: [] } })) });

    // --- A: 自分の MCP を止められないエージェントは、自分の側が勝つ
    // ADR 0330: Devin はユーザーの設定の定義だけ止められる（'user'）。Antigravity・Grok は止めない（Grok は写しの置き場で認証の更新が本物に届かない）
    t.ok('止める手の印: Antigravity・Grok は無し、Devin はユーザーの設定だけ（user）、Claude・Codex・OpenCode は全部（true）',
      ['antigravity', 'grok'].every(a => ![true, 'user'].includes(CAPABILITY_STATES[a]?.nativeMcpOff)) && CAPABILITY_STATES.devin?.nativeMcpOff === 'user'
        && ['claude', 'codex', 'opencode'].every(a => CAPABILITY_STATES[a]?.nativeMcpOff === true));
    await write(path.join(home, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { own: { command: 'own-cmd' }, reg: { command: 'ag-reg' } } }));
    const ag = await resolveRuntime(policy({ off: {}, spread: {} }), { home, plyServers: plyServers(['reg', 'extra']), agent: 'antigravity' });
    t.ok('Antigravity: 自分の設定の名前は渡さず、同じ名前の Pleiad の登録も渡さない（自分の側が勝つ）。Pleiad だけの登録は渡す', names(ag).join() === 'extra', names(ag));
    t.ok('Antigravity: 止める名前は作らない（止める手が無い）', ag.mcp.suppress.length === 0, ag.mcp);
    await fs.rm(path.join(home, '.gemini'), { recursive: true, force: true });

    // --- ADR 0330 の再レビュー（B・C・E）: Devin（ユーザーの設定の定義だけ止められる）は、利用者が Devin 自身の名前を off にしたときだけ止める。
    // 期待値は merge-base（34b3075d）の結果（Devin は止める手が無く、自分の側が勝つ）を写したもの。何も止めていないときは前と同じ起動
    setMcpOffLinker(() => {}); // リンクを作れる PC（実際のリンクは作らない。写しの置き場は使わない試験）
    const dhome = path.join(tmp, 'dhome'), devinHome = path.join(dhome, 'devin'), repoB = path.join(tmp, 'repoB');
    await fs.mkdir(path.join(repoB, '.git'), { recursive: true });
    await write(path.join(devinHome, 'mcp_config.json'), JSON.stringify({ mcpServers: { both: { command: 'both-devin' }, donly: { command: 'd' }, wsdup: { command: 'u' } } }));
    await write(path.join(repoB, '.devin/mcp_config.json'), JSON.stringify({ mcpServers: { wsdup: { command: 'w' } } }));
    const dv = (agents, extra = {}, at = cwd) => resolveRuntime({ ...policy(agents, extra), cwd: at }, { home, devinHome, plyServers: plyServers(['both', 'reg']), agent: 'devin' });
    const cmds = r => r.servers.map(s => `${s.name}:${s.definition?.command ?? s.command}`).sort().join();
    const b0 = await dv({ off: {}, spread: {} });
    t.ok('B: 何も止めず名前が重なる（Pleiad の登録と Devin の設定に both）: 前と同じ（自分の側を使い Pleiad の側を渡さない・止める名前は空）',
      cmds(b0) === 'reg:reg-cmd' && b0.mcp.named && b0.mcp.suppress.length === 0, { s: cmds(b0), m: b0.mcp });
    const b1 = await dv({ off: { reg: ['devin'] }, spread: {} });
    t.ok('B: Pleiad にだけある名前を Devin で off: 前と同じ（渡さない・止める名前は空。写しで起動しない）', cmds(b1) === '' && b1.mcp.suppress.length === 0, { s: cmds(b1), m: b1.mcp });
    const b2 = await dv({ off: { both: ['devin'] }, spread: {} });
    t.ok('B: 重なる名前を Devin で off: 自分の側を止め、Pleiad の側も渡さない', cmds(b2) === 'reg:reg-cmd' && b2.mcp.suppress.join() === 'both', { s: cmds(b2), m: b2.mcp });
    const b3 = await dv({ off: { donly: ['devin'] }, spread: {} });
    t.ok('B: Devin の設定にだけある名前を off: その名前だけ止める（ほかは前と同じ）', cmds(b3) === 'reg:reg-cmd' && b3.mcp.suppress.join() === 'donly', { s: cmds(b3), m: b3.mcp });
    const b4 = await dv({ off: {}, spread: {} }, { removedMcp: ['donly', 'reg'] });
    const b4row = b4.report.entries.find(e => e.kind === 'mcp' && e.name === 'donly');
    t.ok('B: 「この会話では外す」だけでは Devin 自身の側を止めない（前と同じ起動。止めるのは Devin で off にして保存した名前だけ。N2）',
      b4.mcp.suppress.length === 0 && cmds(b4) === '' && b4row?.status === 'excluded', { s: cmds(b4), m: b4.mcp, row: b4row?.status });
    const b4b = await dv({ off: {}, spread: {} }, { removedMcp: ['reg'] });
    t.ok('B: Pleiad にだけある名前を「この会話では外す」: 止める名前は空（前と同じ起動）', b4b.mcp.suppress.length === 0 && cmds(b4b) === '', { s: cmds(b4b), m: b4b.mcp });
    const b5 = await dv({ off: { gone: ['devin'] }, spread: {} });
    t.ok('B: どこにも無い名前の off では止めない', b5.mcp.suppress.length === 0, b5.mcp);
    const cl = await resolveRuntime(policy({ off: {}, spread: {} }), { home, devinHome, plyServers: plyServers(['both', 'reg']), agent: 'claude' });
    t.ok('B: Claude などどれも止められるエージェントの規則は変えない（Devin の設定の名前は Claude のものではないので、両方渡す）', cmds(cl) === 'both:both-cmd,reg:reg-cmd' && cl.mcp.suppress.length === 0, { s: cmds(cl), m: cl.mcp });
    // E: 実行時は会話の cwd で判定する
    const eA = await dv({ off: { wsdup: ['devin'] }, spread: {} }, {}, cwd);
    const eB = await dv({ off: { wsdup: ['devin'] }, spread: {} }, {}, repoB);
    const rowB = eB.report.entries.find(e => e.kind === 'mcp' && e.name === 'wsdup' && e.status === 'excluded');
    t.ok('E: 作業場所の定義の無い会話（repoA）では、ユーザーの設定の名前を止める', eA.mcp.suppress.join() === 'wsdup', eA.mcp);
    t.ok('E: 同じ名前を作業場所で定義している会話（repoB）では止めない（作業場所の定義が勝つ）。右パネルの行は「自分の側を使う」と鍵の理由（nativeLock: workspace）',
      eB.mcp.suppress.length === 0 && rowB?.nativeLock === 'workspace', { m: eB.mcp, row: rowB });
    // C: リンクを作れない PC は、最初から鍵（止める手が無い）
    setMcpOffLinker(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    const c0 = await dv({ off: { donly: ['devin'], both: ['devin'] }, spread: {} });
    t.ok('C: リンクを作れない PC は、Devin の名前を off にしてあっても止めない（前と同じ起動。ターンは止めない）',
      !canLinkMcpOffHome() && nativeMcpOffMode('devin') === null && nativeMcpOffMode('claude') === true && c0.mcp.suppress.length === 0 && cmds(c0) === 'reg:reg-cmd', { m: c0.mcp, s: cmds(c0) });
    const c0row = c0.report.entries.find(e => e.kind === 'mcp' && e.name === 'donly');
    t.ok('C: 一覧では Devin の自分の名前の鍵の理由は nolinks（開発者モードが off）。止める手の無いエージェントは own のまま',
      nativeStopBlock('devin', 'x', ['user']) === 'nolinks' && nativeStopBlock('antigravity', 'x', ['user']) === 'own' && !canStopNative('devin') && canStopNative('codex'));
    t.ok('C: 右パネルの行は「自分の側を使う」と鍵の理由 nolinks（一覧と同じ）', c0row?.status === 'excluded' && c0row.nativeLock === 'nolinks', c0row);
    setMcpOffLinker(() => {});

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
    t.ok('自分の設定で無効にしてある MCP は「持っていない」扱い: 登録も他の設定も無ければ列は off・押せない・ロゴ無し', row('dis').cells.claude.state === 'off' && row('dis').cells.claude.mode === 'none' && row('dis').origins.length === 0);
    const m2 = buildMcpMatrix({ kind: { owner: 'native', agents: { off: {}, spread: {} } }, owners, registered: [{ name: 'dis' }], native, installed: {} });
    t.ok('無効の定義と Pleiad の登録: 登録の行で on（off で切り替える）', m2.rows.find(r => r.key === 'dis').cells.claude.state === 'on' && m2.rows.find(r => r.key === 'dis').cells.claude.mode === 'toggle' && m2.rows.find(r => r.key === 'dis').registered);
    const m3 = buildMcpMatrix({ kind: { owner: 'native', agents: { off: {}, spread: {} } }, owners, registered: [], native: { ...native, codex: [{ name: 'dis', transport: 'stdio' }] }, installed: {} });
    t.ok('無効の定義と他のエージェントの有効な定義: 広げる行（off・押せる）。ロゴは有効な側だけ', m3.rows.find(r => r.key === 'dis').cells.claude.state === 'off' && m3.rows.find(r => r.key === 'dis').cells.claude.mode === 'toggle' && m3.rows.find(r => r.key === 'dis').origins.join() === 'codex');
    t.ok('無効の MCP は他のエージェントへ広げる元にならない（押せない）', row('dis').cells.codex.mode === 'none');
    t.ok('Codex の止められない名前（点を含む）は鍵', row('a.b').cells.codex.mode === 'locked' && row('ok').cells.codex.mode === 'toggle');
    t.ok('canStopName', canStopName('codex', 'ok') && !canStopName('codex', 'a.b') && canStopName('claude', 'a.b') && !canStopName('antigravity', 'x')
      && canStopName('devin', 'x', ['user']) && !canStopName('devin', 'x', ['user', 'directory']) && !canStopName('devin', 'x', ['directory']) && !canStopName('grok', 'x', ['user']));
    t.ok('nativeStopBlock: 止められない理由（own / workspace）',
      nativeStopBlock('antigravity', 'x') === 'own' && nativeStopBlock('grok', 'x', ['user']) === 'own' && nativeStopBlock('codex', 'a.b') === 'own' && nativeStopBlock('devin', 'x', ['directory']) === 'workspace' && nativeStopBlock('devin', 'x', ['user']) === null);
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
    t.ok('使ったばかりの置き場は、残す数を超えても消さない（走っているものを巻き込まない）', left.length === MANAGED_KEEP + 5, left.length);
    const old = new Date(Date.now() - MANAGED_IDLE_MS - 60000);
    const dirs = (await fs.readdir(path.join(dataDir, 'opencode', 'managed'))).sort();
    for (const d of dirs.slice(0, 6)) await fs.utimes(path.join(dataDir, 'opencode', 'managed', d), old, old);
    await mirrorGlobalConfig({ dataDir, owners: { instruction: 'native', skill: 'native', mcp: 'native', mcpSuppress: ['latest'] }, source });
    const after = await fs.readdir(path.join(dataDir, 'opencode', 'managed'));
    t.ok('残す数を超え、1 日使っていない置き場だけ消える（古い 6 つが消え、最近のものは残る）', after.length === MANAGED_KEEP + 5 + 1 - 6 && dirs.slice(6).every(d => after.includes(d)), after.length);

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
    const nat = { claude: [{ name: 'cl', transport: 'stdio' }], codex: [{ name: 'a.b', transport: 'stdio' }], antigravity: [{ name: 'ag', transport: 'stdio' }],
      devin: [{ name: 'dv', transport: 'stdio', scope: 'directory', scopes: ['directory'] }, { name: 'du', transport: 'stdio', scope: 'user', scopes: ['user'] }] };
    const call = (ctx, args) => op('context.setMcpAgent').handler(ctx, args).then(() => null, e => e);
    const ready = { plugins: [], connectors: [], reading: false, readFailed: false };
    const c1 = fake({ kind: { owner: 'native' }, agentsMap: nat, extras: ready });
    t.ok('L: 一覧に無い名前は保存しない', (await call(c1, { name: 'nope', agent: 'claude', on: true }))?.code === 'INVALID' && !saved.length);
    t.ok('L: 鍵（止められないエージェント・止められない名前）は保存しない',
      (await call(c1, { name: 'ag', agent: 'antigravity', on: false }))?.code === 'INVALID'
        && (await call(c1, { name: 'a.b', agent: 'codex', on: false }))?.code === 'INVALID' && !saved.length);
    t.ok('L: 押せる切り替えは保存し、古い disabled は消す', (await call(fake({ kind: { owner: 'native', disabled: ['x'] }, agentsMap: nat, extras: ready }), { name: 'cl', agent: 'claude', on: false })) === null && saved.length === 1 && !('disabled' in saved[0].value) && saved[0].value.agents.off.cl.join() === 'claude');
    const unread = fake({ kind: { owner: 'native', agents: { off: {}, spread: {} } }, agentsMap: nat, extras: { plugins: [], connectors: null, reading: true, readFailed: true } });
    t.ok('L: Devin のユーザーの設定だけの名前は押せる（保存する）', (await call(c1, { name: 'du', agent: 'devin', on: false })) === null && saved.length === 2 && saved[1].value.agents.off.du.join() === 'devin');
    // E: 全体の設定の一覧は、一覧を出した場所（cwd）の作業場所の定義で鍵にしない。場所ごとの設定（place）は、その場所の作業場所の定義で鍵にする
    const placeDir = path.join(tmp, 'place');
    const atPlace = { devin: [{ name: 'du', transport: 'stdio', scope: 'user', scopes: ['user', 'directory'] }, { name: 'dv', transport: 'stdio', scope: 'directory', scopes: ['directory'] }] };
    const asked = [];
    const placed = { ...fake({ kind: { owner: 'native', agents: { off: {}, spread: {} } }, agentsMap: nat, extras: ready }) };
    const mcpKind = { value: { owner: 'native', agents: { off: {}, spread: {} } } }, nativeKind = { value: { owner: 'native' } };
    placed.context = { ...placed.context,
      view: async () => ({ defaults: { kinds: { instruction: nativeKind, skill: nativeKind, mcp: mcpKind } }, places: [{ path: placeDir, kinds: { instruction: nativeKind, skill: nativeKind, mcp: mcpKind } }] }),
      agentMcp: async (d) => { asked.push(d); return { agents: d === placeDir ? { ...nat, ...atPlace } : nat }; } };
    const cellOf = async (args, key, agent) => (await op('context.mcpMatrix').handler(placed, args)).rows.find(r => r.key === key)?.cells[agent];
    const gA = await cellOf({ cwd }, 'dv', 'devin'), gB = await cellOf({ cwd: path.join(tmp, 'repoB') }, 'dv', 'devin');
    t.ok('E: 全体の一覧では、cwd の作業場所にある名前（dv）も押せる（cwd を替えても同じ）', gA?.mode === 'toggle' && gB?.mode === 'toggle', { gA, gB });
    const pl = await cellOf({ cwd, place: placeDir }, 'du', 'devin');
    t.ok('E: 場所ごとの設定では、その場所の作業場所の定義がある名前を鍵にする（reason: workspace）', pl?.mode === 'locked' && pl.reason === 'workspace' && asked.includes(placeDir), { pl, asked });
    const n1 = saved.length;
    t.ok('E: 場所ごとの設定の鍵は保存しない。全体の設定では保存する',
      (await call(placed, { name: 'du', agent: 'devin', on: false, place: placeDir }))?.code === 'INVALID' && saved.length === n1
        && (await call(placed, { name: 'dv', agent: 'devin', on: false })) === null && saved.length === n1 + 1);
    // C: リンクを作れない PC は Devin の自分の名前を鍵にし、保存しない
    setMcpOffLinker(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    const cC = await cellOf({ cwd }, 'du', 'devin');
    const n2 = saved.length;
    t.ok('C: リンクを作れない PC は Devin の自分の名前を鍵（reason: nolinks）にし、保存しない。Claude の名前は押せるまま',
      cC?.mode === 'locked' && cC.reason === 'nolinks' && (await call(placed, { name: 'du', agent: 'devin', on: false }))?.code === 'INVALID' && saved.length === n2
        && (await cellOf({ cwd }, 'cl', 'claude'))?.mode === 'toggle', cC);
    setMcpOffLinker(() => {});
    t.ok('C: リンクを作れるようになったら、次に一覧を出すときから押せる（setMcpAgent も同じ判定）', (await cellOf({ cwd }, 'du', 'devin'))?.mode === 'toggle');
    const n0 = saved.length;
    t.ok('L: コネクターが未読のまま触っても ok を返さず、保存しない（読めなかったと伝える）', (await call(unread, { name: 'claude.ai Gmail', agent: 'claude', on: true }))?.code === 'INVALID' && saved.length === n0);
    t.ok('F・K: コネクターを触るときは、読み終えるまで待つ指定（wait）で読む', unread.seen === undefined || fake.seen.wait === true, fake.seen);
    // --- NEW-6: 止める名前が無いとき、shape（待機中のエージェントを起こし直すかの印）は今までの値のまま
    const bridge = createContextBridge();
    const shapeOf = async mcp => {
      const rt = await resolveRuntime(policy(null), { home, plyServers: { file: path.join(tmp, 'ply-mcp.json'), servers: [] } });
      const conn = await bridge.open({ runtime: { ...rt, mcp }, prompt: '', origin: 'http://127.0.0.1:1', isActive: () => true });
      const shape = conn.shape; await conn.close(); return shape;
    };
    const s0 = await shapeOf(undefined), s1 = await shapeOf({ named: true, suppress: [] }), s2 = await shapeOf({ named: false, suppress: [] }), s3 = await shapeOf({ named: true, suppress: ['x'] });
    t.ok('NEW-6 止める名前が無ければ shape は今までと同じ（更新の直後に待機中のエージェントを起こし直さない）', s0 === s1 && s1 === s2, { s0, s1, s2 });
    t.ok('NEW-6 止める名前があれば shape が変わる（起こし直す）', s3 !== s0);
    // N10: 写しのリンクを作れず止められなかった名前は、実行時の報告の行を「自分の側を使う」に戻し、鍵の理由 nolinks を付けて知らせる
    {
      const rt = await resolveRuntime(policy(null), { home, plyServers: { file: path.join(tmp, 'ply-mcp.json'), servers: [] } });
      rt.report.entries.push({ id: 'x1', kind: 'mcp', name: 'donly', status: 'removed', reason: 'off', tools: 0 }, { id: 'x2', kind: 'mcp', name: 'other', status: 'removed', reason: 'off', tools: 0 });
      let changes = 0;
      const conn = await bridge.open({ runtime: { ...rt, mcp: { named: true, suppress: ['donly'] } }, prompt: '', origin: 'http://127.0.0.1:1', isActive: () => true, changed: async () => { changes++; } });
      const before = changes;
      await conn.markUnstopped(['donly']);
      const [r1, r2] = ['donly', 'other'].map(n => rt.report.entries.find(e => e.name === n));
      t.ok('N10: 止められなかった名前の行だけ excluded・nativeLock: nolinks にし、保存する（ほかの行は変えない）',
        r1.status === 'excluded' && r1.nativeLock === 'nolinks' && !('tools' in r1) && r2.status === 'removed' && !r2.nativeLock && changes === before + 1, { r1, r2, changes, before });
      await conn.markUnstopped(['donly']);
      t.ok('N10: 2 度目は何も変えず、保存もしない', changes === before + 1);
      await conn.close();
    }
    await bridge.dispose();

    // --- NEW-1: 未読（null）と、読めて 0 件（[]）を最後まで区別する。context.setMcpAgent を実際の ctx の形で呼ぶ 5 つの場合
    const UNREAD = '読めなかった', pick = (e, id) => e?.message?.includes('コネクター') ? 'unread' : e ? e.code : 'saved';
    const run5 = async (agentsMap, extras, args = { name: 'cl', agent: 'claude', on: false }) => {
      const before = saved.length, waits = [];
      const c = fake({ kind: { owner: 'ply' }, agentsMap, extras: o => { waits.push(o.wait === true); return extras(o); } });
      const err = await call(c, args);
      return { err, saved: saved.length - before, waits, last: saved[saved.length - 1] };
    };
    const cold = await run5(nat, o => o.wait ? { plugins: [], connectors: ['Gmail'], reading: false, readFailed: false } : { plugins: [], connectors: null, reading: false, readFailed: false });
    t.ok('NEW-1 cold（1 度も読んでいない）: 読み取りを起こして待ち、読めたら保存する。コネクターは Claude で off', cold.err === null && cold.waits.includes(true) && cold.saved === 1 && cold.last.value.agents.off['claude.ai Gmail']?.join() === 'claude', cold);
    const failedRead = await run5(nat, () => ({ plugins: [], connectors: null, reading: false, readFailed: true }));
    t.ok('NEW-1 読み取り失敗: 待っても読めなければ保存せず、コネクターが読めなかった旨のエラー（unknownMcp ではない）', pick(failedRead.err) === 'unread' && failedRead.saved === 0 && failedRead.err.code === 'INVALID', failedRead);
    const inProgress = await run5(nat, o => o.wait ? { plugins: [], connectors: ['Slack'], reading: false, readFailed: false } : { plugins: [], connectors: null, reading: true, readFailed: false });
    t.ok('NEW-1 読み取り中: 読み終えるまで待ってから保存する', inProgress.err === null && inProgress.saved === 1 && inProgress.last.value.agents.off['claude.ai Slack']?.join() === 'claude', inProgress);
    const zeroItems = await run5(nat, () => ({ plugins: [], connectors: [], reading: false, readFailed: false }));
    t.ok('NEW-1 読めて 0 件: 待たずにそのまま保存する（未読とは別）', zeroItems.err === null && zeroItems.saved === 1 && !zeroItems.waits.includes(true) && !Object.keys(zeroItems.last.value.agents.off).some(k => k.startsWith('claude.ai ')), zeroItems);
    const noClaudeCase = await run5({ codex: [{ name: 'ok', transport: 'stdio' }] }, o => ({ plugins: [], connectors: null, reading: false, readFailed: true }), { name: 'ok', agent: 'codex', on: false });
    t.ok('NEW-1 Claude が使えない: コネクターを待たずに保存する', noClaudeCase.err === null && noClaudeCase.saved === 1 && !noClaudeCase.waits.includes(true), noClaudeCase);
    const rowUnread = await run5(nat, () => ({ plugins: [], connectors: null, reading: false, readFailed: true }), { name: 'claude.ai Gmail', agent: 'claude', on: true });
    t.ok('NEW-1 未読のままコネクターの行を触る: 「読めませんでした」で、一覧に無いとは言わない', pick(rowUnread.err) === 'unread' && rowUnread.saved === 0, rowUnread);
    const plug = fake({ kind: { owner: 'native' }, agentsMap: nat, extras: { plugins: [{ key: 'plugin:p:s', plugin: 'p', server: 's', transport: 'stdio' }], connectors: [], reading: false, readFailed: false } });
    t.ok('L: プラグインの MCP を Claude 以外で切り替えるのは保存しない', (await call(plug, { name: 'plugin:p:s', agent: 'codex', on: true }))?.code === 'INVALID');
    const mx = fake({ kind: { owner: 'native' }, agentsMap: nat, extras: ready });
    await op('context.mcpMatrix').handler(mx, { cwd: undefined, refresh: true });
    t.ok('F: コネクターの読み取りで止める名前に、Pleiad の登録と Claude の設定の MCP をすべて渡す', ['reg', 'cl'].every(n => fake.seen.deny.includes(n)), fake.seen);
  } finally {
    setMcpOffLinker(null);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
