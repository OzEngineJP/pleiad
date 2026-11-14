// 設定 › プラグイン › 外部 MCP の一覧（名前 × エージェント）の元データ。ADR 0327。
// 画面は行ごとに「全体のスイッチ」と、エージェントごとのアイコンを出す。この関数が、各アイコンが
//   on / off（今そのエージェントで使われるか）と、押せるか（toggle / locked / blocked / none）を決める。
// 担当の 2 択のまま（agents が無い）の設定は、mcpAgentsFromLegacy で今の接続と同じ形に読み替えて見せる（書き換えない）。
import { PLY_CONTEXT_CONFLICTS } from './backends/agent-marks.mjs';
import { nativeMcpOffMode } from './backends/mcp-off-home.mjs';
import { mcpAgentsFromLegacy } from './context-settings.mjs';
import { agentOf } from './backends/agents.mjs';

/** 画面に並べるエージェントの順（アイコンの列）。ここに無いエージェントは末尾 */
// backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
export const AGENT_ORDER = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
const orderOf = id => { const i = AGENT_ORDER.indexOf(id); return i < 0 ? AGENT_ORDER.length : i; };

/** そのエージェントが、Pleiad の中継（ply_context）を受け取れない担当の組み合わせか（指示・Skills を Pleiad が担当しているとき） */
export function relayBlocked(agent, owners) {
  return (PLY_CONTEXT_CONFLICTS[agent] ?? []).some(k => owners?.[k] === 'ply');
}
/**
 * そのエージェント自身の MCP を、起動のときに名前ごとに止める手があるか（能力の印 nativeMcpOff が true か 'user'。
 * 'user' は写しの置き場を使うので、シンボリックリンクを作れない PC では無い。core/backends/mcp-off-home.mjs の nativeMcpOffMode）
 */
export const canStopNative = agent => nativeMcpOffMode(agent) !== null;

/**
 * そのエージェント自身の設定にある名前 name を、起動のときに止められないなら、その理由（止められるなら null）。
 *   scopes  その名前の定義がある範囲（'user' | 'directory'）
 *   'own'        止める手が無い（能力の印 nativeMcpOff が無い・リンクを作れない PC の 'user'）か、名前の形が止める手に合わない
 *   'workspace'  ユーザーの設定の定義しか止められない（nativeMcpOff: 'user'）のに、作業場所の設定にも定義がある
 * Codex は点や引用符を含む名前を -c のパーサーが扱えず止められない（core/backends/context-options.mjs と同じ規則）
 */
export function nativeStopBlock(agent, name, scopes = ['user']) {
  const mode = nativeMcpOffMode(agent);
  if (mode === null) return 'own';
  // backend-allow: Codex の -c の名前の規則（core/backends/context-options.mjs の codexContextRpc と同じ）
  if (agent === 'codex' && !/^[A-Za-z0-9_-]+$/.test(name)) return 'own';
  if (mode === 'user' && scopes.some(s => s !== 'user')) return 'workspace';
  return null;
}

/** そのエージェント自身の設定にある名前 name を、起動のときに止められるか（nativeStopBlock の理由が無いか） */
export const canStopName = (agent, name, scopes) => nativeStopBlock(agent, name, scopes) === null;

const CONNECTOR_PREFIX = 'claude.ai ';
/** 中継を受け取れない担当の組み合わせ（relayBlocked）の鍵 */
const blocked = () => ({ state: 'off', mode: 'blocked', reason: 'relay' });

/**
 * 担当の 2 択から写す入力（mcpAgentsFromLegacy の info）を作る。画面と context.setMcpAgent で同じものを使い、保存の前後で見え方が変わらないようにする。
 * 探す対象（spreadFrom）は、2 択の「探す形式」（user / directory の sources）に入っていたエージェント
 */
export function mcpLegacyInfo({ kind, registered = [], native = {}, plugins = [], connectors = [] }) {
  const ids = Object.keys(native);
  const sources = new Set([...(kind.user?.sources ?? []), ...(kind.directory?.sources ?? [])]);
  const spreadFrom = !sources.size ? ids : ids.filter(a => (agentOf(a)?.contextSources ?? []).some(s => sources.has(s)));
  // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
  const extras = ids.includes('claude') ? { claude: [...plugins.map(p => p.key), ...(connectors ?? []).map(c => `${CONNECTOR_PREFIX}${c}`)] } : {};
  return {
    registered: registered.map(r => r.name),
    native: Object.fromEntries(ids.map(a => [a, native[a].map(s => s.name)])),
    disabled: Object.fromEntries(ids.map(a => [a, native[a].filter(s => s.disabled).map(s => s.name)])),
    spreadFrom, extras,
  };
}

/**
 * 戻り: { agents: [id], rows: [...], locked: bool（鍵のアイコンが 1 つでもあるか）, connectors: 'reading'|'ready'|'none' }
 * 入力:
 *   kind        外部 MCP の設定の値（owner・disabled・agents）
 *   owners      効いている担当（指示・Skills の担当は、中継を受け取れるかに効く）
 *   registered  Pleiad の登録 [{ name, transport }]
 *   native      { <agent>: [{ name, transport, disabled }] }（各エージェントの設定にあるもの）
 *   plugins     [{ plugin, server, key, transport }]（Claude のプラグインの MCP。key は止めるときの名前）
 *   connectors  null（未読。reading が true なら読み取り中）| [名前]（読めた一覧。[] は読めて 0 件）
 *   needsAuth   ログインが必要なコネクターの名前（行に needsAuth: true を付ける）
 *   installed   { <agent>: bool }（そのエージェントを使えるか。使えないエージェントのアイコンは出さない）
 *   workspace   null（全体の設定）| { <agent>: [名前] }（場所ごとの設定で、その場所の作業場所の設定に定義がある名前）
 */
export function buildMcpMatrix({ kind, owners, registered = [], native = {}, plugins = [], connectors = null, reading = false, needsAuth = [], installed = {}, workspace = null }) {
  const agents = Object.keys(native).filter(id => installed[id] !== false).sort((a, b) => orderOf(a) - orderOf(b));
  const info = { registered: registered.map(r => r.name), native: Object.fromEntries(Object.keys(native).map(a => [a, native[a].map(s => s.name)])) };
  const rules = kind.agents ?? mcpAgentsFromLegacy(kind, mcpLegacyInfo({ kind, registered, native, plugins, connectors }));
  const disabledIn = (a, name) => native[a]?.some(s => s.name === name && s.disabled) === true;
  // その名前の定義がある範囲。一覧を出した場所（cwd）の作業場所の定義では鍵にしない（全体の設定は、どの作業場所の会話にも効くため。
  // 作業場所の定義が勝つ会話では、実行時に会話の cwd で判定して止めない。core/context-runtime.mjs）。
  // 場所ごとの設定（place）を出すときだけ、その場所の作業場所の定義がある名前を鍵にする（workspace: { <agent>: [名前] }）
  const scopesIn = (a, name) => (workspace?.[a] ?? []).includes(name) ? ['user', 'directory'] : ['user'];
  const off = (key, a) => (rules.off?.[key] ?? []).includes(a);
  const spread = (key, a) => (rules.spread?.[key] ?? []).includes(a);
  const names = [...new Set([...info.registered, ...Object.values(info.native).flat()])];
  const rows = [];
  for (const name of names) {
    const reg = registered.find(r => r.name === name) ?? null;
    // 自身の設定で無効の定義は「そのエージェントが持っていない」扱い（画面も実行時も同じ規則。ロゴも出さない）
    const origins = agents.filter(a => info.native[a].includes(name) && !disabledIn(a, name));
    const cells = {};
    for (const a of agents) {
      const own = origins.includes(a);
      if (own) {
        // 自分の設定にある名前。止められるのは、起動のときに名前で止める手があるエージェントだけ。
        // 止められない鍵には理由（reason: 'own' | 'workspace'）を付ける（nativeStopBlock）
        const block = nativeStopBlock(a, name, scopesIn(a, name));
        cells[a] = block ? { state: 'on', mode: 'locked', reason: block } : { state: off(name, a) ? 'off' : 'on', mode: 'toggle' };
      } else if (!reg && !origins.length) {
        // どのエージェントの設定でも無効の名前: 広げる元が無い
        cells[a] = { state: 'off', mode: 'none' };
      } else if (reg) {
        cells[a] = relayBlocked(a, owners) ? blocked() : { state: off(name, a) ? 'off' : 'on', mode: 'toggle' };
      } else {
        // 他のエージェントの設定にだけある名前: 広げれば使える
        cells[a] = relayBlocked(a, owners) ? blocked() : { state: spread(name, a) ? 'on' : 'off', mode: 'toggle' };
      }
    }
    rows.push({ key: name, name, kind: 'config', group: reg ? 'ply' : 'agent', transport: (reg ?? Object.values(native).flat().find(s => s.name === name))?.transport ?? null,
      registered: Boolean(reg), origins, plugin: null, cells, on: agents.some(a => cells[a].state === 'on') });
  }
  // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
  if (installed.claude !== false && agents.includes('claude')) {
    for (const p of plugins) {
      // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
      const cells = Object.fromEntries(agents.map(a => [a, a === 'claude'
        // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
        ? { state: off(p.key, 'claude') ? 'off' : 'on', mode: 'toggle' } : { state: 'off', mode: 'none' }]));
      // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
      rows.push({ key: p.key, name: p.server, kind: 'plugin', group: 'agent', transport: p.transport ?? null, registered: false, origins: ['claude'], plugin: p.plugin, cells, on: !off(p.key, 'claude') });
    }
    for (const c of connectors ?? []) {
      const key = `${CONNECTOR_PREFIX}${c}`;
      // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
      const cells = Object.fromEntries(agents.map(a => [a, a === 'claude'
        // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
        ? { state: off(key, 'claude') ? 'off' : 'on', mode: 'toggle' } : { state: 'off', mode: 'none' }]));
      // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
      rows.push({ key, name: c, kind: 'connector', group: 'agent', transport: 'http', needsAuth: needsAuth.includes(c), registered: false, origins: ['claude'], plugin: null, cells, on: !off(key, 'claude') });
    }
  }
  // backend-allow: 画面の列の順と、Claude 固有の読み取り（プラグイン・コネクター）。ADR 0327
  const claudeHere = installed.claude !== false && agents.includes('claude');
  return {
    agents, rows,
    locked: rows.some(r => agents.some(a => r.cells[a].mode === 'locked' || r.cells[a].mode === 'blocked')),
    // null（未読）で読み取り中なら reading、読み取りが終わって読めなかったなら none（読めた 0 件と区別するのは保存側）
    connectors: !claudeHere ? 'none' : connectors === null ? (reading ? 'reading' : 'none') : connectors.length ? 'ready' : 'none',
  };
}
