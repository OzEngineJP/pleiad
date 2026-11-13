// 設定 › プラグイン › 外部 MCP の一覧（名前 × エージェント）の元データ。ADR 0324。
// 画面は行ごとに「全体のスイッチ」と、エージェントごとのアイコンを出す。この関数が、各アイコンが
//   on / off（今そのエージェントで使われるか）と、押せるか（toggle / locked / blocked / none）を決める。
// 担当の 2 択のまま（agents が無い）の設定は、mcpAgentsFromLegacy で今の接続と同じ形に読み替えて見せる（書き換えない）。
import { CAPABILITY_STATES, PLY_CONTEXT_CONFLICTS } from './backends/agent-marks.mjs';
import { mcpAgentsFromLegacy } from './context-settings.mjs';

/** 画面に並べるエージェントの順（アイコンの列）。ここに無いエージェントは末尾 */
export const AGENT_ORDER = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
const orderOf = id => { const i = AGENT_ORDER.indexOf(id); return i < 0 ? AGENT_ORDER.length : i; };

/** そのエージェントが、Pleiad の中継（ply_context）を受け取れない担当の組み合わせか（指示・Skills を Pleiad が担当しているとき） */
export function relayBlocked(agent, owners) {
  return (PLY_CONTEXT_CONFLICTS[agent] ?? []).some(k => owners?.[k] === 'ply');
}
/** そのエージェント自身の MCP を、起動のときに名前ごとに止められるか */
export const canStopNative = agent => CAPABILITY_STATES[agent]?.nativeMcpOff === true;

const CONNECTOR_PREFIX = 'claude.ai ';

/**
 * 戻り: { agents: [id], rows: [...], locked: bool（鍵のアイコンが 1 つでもあるか）, connectors: 'reading'|'ready'|'none' }
 * 入力:
 *   kind        外部 MCP の設定の値（owner・disabled・agents）
 *   owners      効いている担当（指示・Skills の担当は、中継を受け取れるかに効く）
 *   registered  Pleiad の登録 [{ name, transport }]
 *   native      { <agent>: [{ name, transport, disabled }] }（各エージェントの設定にあるもの）
 *   plugins     [{ plugin, server, key, transport }]（Claude のプラグインの MCP。key は止めるときの名前）
 *   connectors  null（読み取り中）| [名前]（読めた一覧）
 *   installed   { <agent>: bool }（そのエージェントを使えるか。使えないエージェントのアイコンは出さない）
 */
export function buildMcpMatrix({ kind, owners, registered = [], native = {}, plugins = [], connectors = null, installed = {} }) {
  const agents = Object.keys(native).filter(id => installed[id] !== false).sort((a, b) => orderOf(a) - orderOf(b));
  const info = { registered: registered.map(r => r.name), native: Object.fromEntries(Object.keys(native).map(a => [a, native[a].map(s => s.name)])) };
  const rules = kind.agents ?? mcpAgentsFromLegacy(kind, info);
  const off = (key, a) => (rules.off?.[key] ?? []).includes(a);
  const spread = (key, a) => (rules.spread?.[key] ?? []).includes(a);
  const names = [...new Set([...info.registered, ...Object.values(info.native).flat()])];
  const rows = [];
  for (const name of names) {
    const reg = registered.find(r => r.name === name) ?? null;
    const origins = agents.filter(a => info.native[a].includes(name));
    const cells = {};
    for (const a of agents) {
      const own = origins.includes(a);
      if (own) {
        // 自分の設定にある名前。止められるのは、起動のときに名前で止める手があるエージェントだけ
        const stop = canStopNative(a);
        cells[a] = { state: stop && off(name, a) ? 'off' : 'on', mode: stop ? 'toggle' : 'locked' };
      } else if (reg) {
        cells[a] = relayBlocked(a, owners) ? { state: 'off', mode: 'blocked' } : { state: off(name, a) ? 'off' : 'on', mode: 'toggle' };
      } else {
        // 他のエージェントの設定にだけある名前: 広げれば使える
        cells[a] = relayBlocked(a, owners) ? { state: 'off', mode: 'blocked' } : { state: spread(name, a) ? 'on' : 'off', mode: 'toggle' };
      }
    }
    rows.push({ key: name, name, kind: 'config', group: reg ? 'ply' : 'agent', transport: (reg ?? native[origins[0]]?.find(s => s.name === name))?.transport ?? null,
      registered: Boolean(reg), origins: reg ? origins : origins.slice(), plugin: null, cells, on: agents.some(a => cells[a].state === 'on') });
  }
  if (installed.claude !== false && agents.includes('claude')) {
    for (const p of plugins) {
      const cells = Object.fromEntries(agents.map(a => [a, a === 'claude'
        ? { state: off(p.key, 'claude') ? 'off' : 'on', mode: 'toggle' } : { state: 'off', mode: 'none' }]));
      rows.push({ key: p.key, name: p.server, kind: 'plugin', group: 'agent', transport: p.transport ?? null, registered: false, origins: ['claude'], plugin: p.plugin, cells, on: !off(p.key, 'claude') });
    }
    for (const c of connectors ?? []) {
      const key = `${CONNECTOR_PREFIX}${c}`;
      const cells = Object.fromEntries(agents.map(a => [a, a === 'claude'
        ? { state: off(key, 'claude') ? 'off' : 'on', mode: 'toggle' } : { state: 'off', mode: 'none' }]));
      rows.push({ key, name: c, kind: 'connector', group: 'agent', transport: 'http', registered: false, origins: ['claude'], plugin: null, cells, on: !off(key, 'claude') });
    }
  }
  const claudeHere = installed.claude !== false && agents.includes('claude');
  return {
    agents, rows,
    locked: rows.some(r => agents.some(a => r.cells[a].mode === 'locked' || r.cells[a].mode === 'blocked')),
    connectors: !claudeHere ? 'none' : connectors === null ? 'reading' : connectors.length ? 'ready' : 'none',
  };
}
