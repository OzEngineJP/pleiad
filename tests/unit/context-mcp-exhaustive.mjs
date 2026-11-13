import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCAN, legacyPlan, mcpAgentsFromLegacy } from '../../core/context-settings.mjs';
import { resolveRuntime } from '../../core/context-runtime.mjs';
import { scanContext } from '../../core/context-scan.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';
import { AGENT_ORDER, buildMcpMatrix, canStopName, mcpLegacyInfo } from '../../core/context-mcp-matrix.mjs';

export const name = 'context-mcp-exhaustive';
export const title = '外部 MCP の総当たり: 一覧の表示（on / off / 鍵 / 押せない）が、実行時に実際に使えるかと一致する';

// エージェント × 名前の種類 × 状態（初期・オフ・広げる・この会話では外す）を総当たりで突き合わせる。ADR 0325

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-all-')), cwd = path.join(tmp, 'repo'), home = path.join(tmp, 'home');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    // 名前の種類: reg（Pleiad の登録だけ）／cl（Claude の設定だけ）／cx（Codex の設定だけ）／dot（Codex の止められない名前）／
    //   both（Claude の設定と登録）／dis（Claude の設定で無効）／disreg（Claude の設定で無効と登録）／oc（OpenCode の設定だけ）／gk（Grok の設定だけ）
    await write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      cl: { command: 'cl' }, both: { command: 'both' }, dis: { command: 'dis', disabled: true }, disreg: { command: 'disreg', disabled: true } } }));
    await write(path.join(cwd, '.codex/config.toml'), '[mcp_servers.cx]\ncommand = "cx"\n[mcp_servers."a.b"]\ncommand = "dot"\n');
    await write(path.join(cwd, 'opencode.json'), JSON.stringify({ mcp: { oc: { type: 'local', command: ['oc'] } } }));
    await write(path.join(cwd, '.grok/config.toml'), '[mcp_servers.gk]\ncommand = "gk"\n');
    const def = c => ({ transport: 'stdio', command: c, args: [] });
    const plyServers = { file: path.join(tmp, 'ply-mcp.json'), servers: [
      { name: 'reg', definition: def('reg') }, { name: 'both', definition: def('both-ply') }, { name: 'disreg', definition: def('disreg-ply') }] };
    const all = ['common', 'claude', 'codex', 'opencode', 'devin', 'grok', 'antigravity'];
    const scope = { ...DEFAULT_SCAN, sources: all };
    const legacy = owner => { const plan = legacyPlan(scope, scope); return { plan, owner }; };
    const policyOf = (plan, removedMcp = []) => ({ version: 2, cwd, owners: { instruction: 'native', skill: 'native', mcp: 'ply' }, plan, removedMcp });
    const ids = AGENT_ORDER.filter(id => AGENTS[id]);

    // 各エージェントの設定にある名前（core/context-session.mjs の agentMcp と同じ規則）
    const scan = await scanContext({ cwd, plan: { user: { roots: [], kinds: { instruction: null, skill: null, mcp: { sources: all.filter(s => s !== 'common'), excludePaths: [] } } },
      directory: { roots: [], kinds: { instruction: null, skill: null, mcp: { sources: all.filter(s => s !== 'common'), excludePaths: [] } } }, mcp: { disabled: [], prefer: {} }, skill: { prefer: {} } } }, { home });
    const native = Object.fromEntries(ids.map(id => [id, []]));
    for (const e of scan.entries) {
      if (e.kind !== 'mcp') continue;
      for (const source of new Set(e.origins.map(o => o.source))) for (const id of ids) {
        if (!(AGENTS[id].contextSources ?? []).filter(s => s !== 'common').includes(source) || native[id].some(s => s.name === e.name)) continue;
        native[id].push({ name: e.name, transport: e.transport, disabled: e.status === 'disabled' });
      }
    }
    const registered = plyServers.servers.map(s => ({ name: s.name, transport: 'stdio' }));
    const names = [...new Set([...registered.map(r => r.name), ...Object.values(native).flat().map(s => s.name)])].sort();
    t.ok('前提: 名前の種類がそろっている（登録・各エージェントの設定・無効・止められない名前）',
      ['reg', 'cl', 'cx', 'a.b', 'both', 'dis', 'disreg', 'oc', 'gk'].every(n => names.includes(n)), JSON.stringify({ names, native: Object.fromEntries(ids.map(i => [i, native[i].map(s => s.name)])) }));

    const ownEnabled = (id, n) => native[id].some(s => s.name === n && !s.disabled);
    // 止める名前に入っていても、止められない名前（Codex の点つき）は実際には止まらない（core/backends/context-options.mjs）
    const usableAt = (rt, id, n) => rt.servers.some(s => s.name === n) || (ownEnabled(id, n) && !((rt.mcp.suppress ?? []).includes(n) && canStopName(id, n)));
    const runtimeOf = async (plan, id, removed) => resolveRuntime(policyOf(plan, removed), { home, plyServers, agent: id });

    // --- 名前ごとのモデル: 画面の表示 = 実行時に使えるか
    const states = {
      '初期': () => ({ off: {}, spread: {} }),
      '全部オフ': () => ({ off: Object.fromEntries(names.map(n => [n, ids])), spread: {} }),
      '全部広げる': () => ({ off: {}, spread: Object.fromEntries(names.map(n => [n, ids])) }),
      '1 つおきにオフ・広げる': () => ({ off: Object.fromEntries(names.filter((_, i) => i % 2).map(n => [n, ids.filter((_, j) => j % 2)])), spread: Object.fromEntries(names.filter((_, i) => !(i % 2)).map(n => [n, ids.filter((_, j) => !(j % 2))])) }),
    };
    const bad = [];
    for (const [label, make] of Object.entries(states)) {
      const agents = make();
      const kind = { owner: 'native', disabled: [], agents };
      const plan = legacyPlan(scope, scope); plan.mcp.agents = agents;
      const matrix = buildMcpMatrix({ kind, owners: { instruction: 'native', skill: 'native' }, registered, native, installed: {} });
      for (const id of ids) {
        const rt = await runtimeOf(plan, id, []);
        for (const n of names) {
          const cell = matrix.rows.find(r => r.key === n)?.cells[id];
          const shown = cell.state === 'on';
          const real = usableAt(rt, id, n);
          if (shown !== real) bad.push({ label, id, n, cell, real, servers: rt.servers.map(s => s.name), suppress: rt.mcp.suppress });
          // 鍵のセルは止められないエージェントの自分の定義だけ。押せるセルは止められる
          if (cell.mode === 'locked' && !(ownEnabled(id, n) && !canStopName(id, n))) bad.push({ label, id, n, cell, why: 'locked' });
          if (cell.mode === 'none' && real) bad.push({ label, id, n, cell, why: 'none-but-usable' });
        }
      }
    }
    t.ok(`一覧の表示と実際に使えるかが一致（${Object.keys(states).length} 状態 × ${ids.length} エージェント × ${names.length} 名前）`, bad.length === 0, JSON.stringify(bad.slice(0, 6)));

    // --- この会話では外す: 中継するものは使えず、止められる自分の定義も止まる（止められないエージェントの自分の定義は残る）
    const removedBad = [];
    const plan0 = legacyPlan(scope, scope); plan0.mcp.agents = { off: {}, spread: Object.fromEntries(names.map(n => [n, ids])) };
    for (const id of ids) {
      const rt = await runtimeOf(plan0, id, names);
      for (const n of names) {
        const expected = ownEnabled(id, n) && !canStopName(id, n);
        if (usableAt(rt, id, n) !== expected) removedBad.push({ id, n, servers: rt.servers.map(s => s.name), suppress: rt.mcp.suppress });
      }
    }
    t.ok('この会話では外した名前は、止められないエージェントの自分の定義だけが残る', removedBad.length === 0, JSON.stringify(removedBad.slice(0, 6)));

    // --- 旧 2 択の変換直後: 変換の前後で接続が同じ（旧「Pleiad がそろえる」「任せる」）
    const legacyBad = [];
    for (const owner of ['ply', 'native']) {
      const kindLegacy = { owner, disabled: [] };
      const info = mcpLegacyInfo({ kind: kindLegacy, registered, native });
      const converted = mcpAgentsFromLegacy(kindLegacy, info);
      const planNew = legacyPlan(scope, scope); planNew.mcp.agents = converted;
      const matrixOld = buildMcpMatrix({ kind: kindLegacy, owners: { instruction: 'native', skill: 'native' }, registered, native, installed: {} });
      const rtOld = await resolveRuntime({ ...policyOf(legacyPlan(scope, scope)), owners: { instruction: 'native', skill: 'native', mcp: owner } }, { home, plyServers });
      for (const id of ids) {
        const rtNew = await runtimeOf(planNew, id, []);
        for (const n of names) {
          // 変換前: 「そろえる」は Pleiad が全部を中継し（有効な定義だけ）、止められないエージェントは自分のも使う。「任せる」は自分の定義だけ（登録は渡さない）
          const before = owner === 'ply'
            ? rtOld.servers.some(s => s.name === n) || (ownEnabled(id, n) && !canStopName(id, n))
            : ownEnabled(id, n);
          const after = usableAt(rtNew, id, n);
          const screen = matrixOld.rows.find(r => r.key === n)?.cells[id]?.state === 'on';
          if (before !== after || screen !== after) legacyBad.push({ owner, id, n, before, after, screen });
        }
      }
    }
    t.ok('旧 2 択を変換した直後は、変換の前と接続が同じ（画面も同じ）', legacyBad.length === 0, JSON.stringify(legacyBad.slice(0, 8)));

    // --- プラグイン・コネクターの行: Claude の列のオフは、実行時の止める名前に入る
    const plugKey = 'plugin:p:srv', connKey = 'claude.ai Slack';
    const planPc = legacyPlan(scope, scope); planPc.mcp.agents = { off: { [plugKey]: ['claude'], [connKey]: ['claude'] }, spread: {} };
    const rtPc = await runtimeOf(planPc, 'claude', []);
    const planOn = legacyPlan(scope, scope); planOn.mcp.agents = { off: {}, spread: {} };
    const rtOn = await runtimeOf(planOn, 'claude', []);
    const mPc = buildMcpMatrix({ kind: { owner: 'native', disabled: [], agents: planPc.mcp.agents }, owners: {}, registered, native, plugins: [{ plugin: 'p', server: 'srv', key: plugKey, transport: 'stdio' }], connectors: ['Slack'], installed: {} });
    t.ok('プラグイン・コネクターを Claude でオフ: 画面はオフ、実行時は止める名前に入る。オンなら入らない',
      mPc.rows.find(r => r.key === plugKey).cells.claude.state === 'off' && mPc.rows.find(r => r.key === connKey).cells.claude.state === 'off'
      && rtPc.mcp.suppress.includes(plugKey) && rtPc.mcp.suppress.includes(connKey) && !rtOn.mcp.suppress.includes(plugKey) && !rtOn.mcp.suppress.includes(connKey), { s: rtPc.mcp.suppress });
    t.ok('プラグイン・コネクターの行は Claude 以外の列が押せない（none）', ids.filter(i => i !== 'claude').every(i => mPc.rows.find(r => r.key === plugKey).cells[i].mode === 'none' && mPc.rows.find(r => r.key === connKey).cells[i].mode === 'none'));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
