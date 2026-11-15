// 指示・Skills の名前 × エージェントの表（ADR 0337）が、旧い保存（context-scans.json）での動きを変えていないかを、
// main の実装で採った記録（tests/fixtures/context-doc-main-plans.json）と突き合わせるための共通部品。
//
// - makeFixture: ホーム・リポジトリ・追加の場所を持つ固定の木（Windows の Devin の置き場の形）を作る
// - COMBOS: 旧い保存の組み合わせ（旧「任せる」・旧「Pleiad がそろえる」・場所ごとの上書き・探す形式と除外・追加の場所・優先）
// - recordPlans: 渡したリポジトリの根（main の写しか、この作業ツリー）のコードで、組み合わせ × 作業場所 × 6 エージェントの
//   計画（各エージェントへ渡す起動の設定と、Pleiad が渡す指示・Skills）と、エージェントが自分で読むもの（native）を採る
// - sees: 起動の設定から「そのエージェントが実際に見る指示・Skills」を出す見立て。エージェントごとの止め方を、
//   新しいコードの判定（core/backends/context-capabilities.mjs）とは別に、ここで独立に書く
//
// 記録は main の写し（D:\dev\pleiad\temporary\main-snap など）で tests/lib/record-main-doc-plans.mjs を流して作る。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENT_IDS = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
export const DOC_KINDS = ['instruction', 'skill'];
// エージェントが自分で読む読み込み元（core/backends/agents.mjs の contextSources。main と同じ値）
export const NATIVE_SOURCES = {
  claude: ['claude'], codex: ['codex'], antigravity: ['common', 'antigravity'], opencode: ['common', 'opencode'],
  devin: ['common', 'claude', 'devin', 'opencode'], grok: ['common', 'grok', 'claude'],
};
const ALL_SOURCES = ['common', 'claude', 'codex', 'opencode', 'devin', 'antigravity', 'grok'];

const skillMd = name => `---\nname: ${name}\ndescription: ${name} の説明\n---\n${name} の本文\n`;

/** 固定の木。戻り: { root, home, repo, sub, custom, dataDir, snapshots, scanOptions } */
export async function makeFixture(root) {
  const home = path.join(root, 'home'), repo = path.join(root, 'repo'), sub = path.join(repo, 'sub'), custom = path.join(root, 'custom');
  const files = {
    // ユーザーの段（エージェントごとの設定の置き場）
    [path.join(home, '.claude', 'CLAUDE.md')]: '# home/.claude/CLAUDE.md\n',
    [path.join(home, '.codex', 'AGENTS.md')]: '# home/.codex/AGENTS.md\n',
    [path.join(home, '.config', 'opencode', 'AGENTS.md')]: '# home/.config/opencode/AGENTS.md\n',
    [path.join(home, '.gemini', 'GEMINI.md')]: '# home/.gemini/GEMINI.md\n',
    [path.join(home, '.grok', 'AGENTS.md')]: '# home/.grok/AGENTS.md\n',
    [path.join(home, '.devin', 'global_rules.md')]: '# home/.devin/global_rules.md\n',
    [path.join(home, 'AppData', 'Roaming', 'devin', 'AGENTS.md')]: '# home/AppData/Roaming/devin/AGENTS.md\n',
    // 作業場所の段
    [path.join(repo, 'AGENTS.md')]: '# repo/AGENTS.md\n',
    [path.join(repo, 'CLAUDE.md')]: '# repo/CLAUDE.md\n',
    [path.join(repo, '.claude', 'rules', 'style.md')]: '# repo/.claude/rules/style.md\n',
    [path.join(repo, '.grok', 'rules', 'g.md')]: '# repo/.grok/rules/g.md\n',
    [path.join(repo, '.gemini', 'GEMINI.md')]: '# repo/.gemini/GEMINI.md\n',
    [path.join(sub, 'AGENTS.md')]: '# repo/sub/AGENTS.md\n',
    [path.join(sub, 'CLAUDE.md')]: '# repo/sub/CLAUDE.md\n',
    // 追加の場所
    [path.join(custom, 'AGENTS.md')]: '# custom/AGENTS.md\n',
  };
  const skills = {
    [path.join(home, '.claude', 'skills', 'cl-user')]: 'cl-user',
    [path.join(home, '.claude', 'skills', 'shared')]: 'shared',
    [path.join(home, '.codex', 'skills', 'cx-user')]: 'cx-user',
    [path.join(home, '.agents', 'skills', 'ag-user')]: 'ag-user',
    [path.join(home, '.agents', 'skills', 'shared')]: 'shared',
    [path.join(home, '.config', 'opencode', 'skills', 'oc-user')]: 'oc-user',
    [path.join(home, '.gemini', 'antigravity', 'global_skills', 'gm-user')]: 'gm-user',
    [path.join(home, 'AppData', 'Roaming', 'cognition', 'skills', 'dv-user')]: 'dv-user',
    [path.join(home, '.codeium', 'windsurf', 'skills', 'ws-user')]: 'ws-user',
    [path.join(home, '.copilot', 'skills', 'cp-user')]: 'cp-user',
    [path.join(repo, '.claude', 'skills', 'cl-repo')]: 'cl-repo',
    [path.join(repo, '.agents', 'skills', 'ag-repo')]: 'ag-repo',
    [path.join(repo, '.opencode', 'skills', 'oc-repo')]: 'oc-repo',
    [path.join(repo, '.codex', 'skills', 'cx-repo')]: 'cx-repo',
    [path.join(custom, '.agents', 'skills', 'cu-skill')]: 'cu-skill',
  };
  for (const [file, body] of Object.entries(files)) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); }
  for (const [dir, name] of Object.entries(skills)) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd(name)); }
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const dataDir = path.join(root, 'data'), snapshots = path.join(root, 'snapshots');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(snapshots, { recursive: true });
  // 探索の置き場は全部渡す（既定は環境変数を読むので、試験の環境に左右される）
  const scanOptions = {
    home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), opencodeHome: path.join(home, '.config', 'opencode'),
    devinHome: path.join(home, 'AppData', 'Roaming', 'devin'), geminiHome: path.join(home, '.gemini'), grokHome: path.join(home, '.grok'),
  };
  return { root, home, repo, sub, custom, dataDir, snapshots, scanOptions };
}

const scope = (sources, excludePaths = []) => ({ sources, excludePaths });
const kindOf = (owner, { sources = ['common', 'claude', 'codex'], exclude = [], dirSources = sources, dirExclude = [], prefer } = {}) =>
  ({ owner, user: scope(sources, exclude), directory: scope(dirSources, dirExclude), ...(prefer ? { prefer } : {}) });
const native = () => kindOf('native');
const v3 = ({ instruction = native(), skill = native(), mcp = native(), roots = {}, places = {} } = {}) => ({
  version: 3,
  defaults: { roots: { instruction: [], skill: [], mcp: [], ...roots }, kinds: { instruction, skill, mcp } },
  places,
});

/** 旧い保存の組み合わせ。値は fx（makeFixture の戻り）から context-scans.json の中身を作る関数。null は保存が無い */
export const COMBOS = {
  default: () => null,
  instPly: () => v3({ instruction: kindOf('ply') }),
  skillPly: () => v3({ skill: kindOf('ply') }),
  bothPly: () => v3({ instruction: kindOf('ply'), skill: kindOf('ply') }),
  instPlyAllSources: () => v3({ instruction: kindOf('ply', { sources: ALL_SOURCES }) }),
  instPlyExclude: fx => v3({ instruction: kindOf('ply', { dirExclude: [path.join(fx.repo, 'CLAUDE.md')] }) }),
  skillPlyExclude: fx => v3({ skill: kindOf('ply', { dirExclude: [path.join(fx.repo, '.agents', 'skills', 'ag-repo')] }) }),
  skillPlyPrefer: fx => v3({ skill: kindOf('ply', { prefer: { shared: path.join(fx.home, '.agents', 'skills', 'shared', 'SKILL.md') } }) }),
  placePly: fx => v3({ places: { [fx.sub]: { path: fx.sub, kinds: { instruction: kindOf('ply'), skill: kindOf('ply') } } } }),
  placeNative: fx => v3({ instruction: kindOf('ply'), skill: kindOf('ply'), places: { [fx.sub]: { path: fx.sub, kinds: { instruction: native(), skill: native() } } } }),
  bothPlyRoots: fx => v3({ instruction: kindOf('ply'), skill: kindOf('ply'), roots: { instruction: [fx.custom], skill: [fx.custom] } }),
  nativeAllSources: () => v3({ instruction: kindOf('native', { sources: ALL_SOURCES }), skill: kindOf('native', { sources: ALL_SOURCES }) }),
  mcpPly: () => v3({ mcp: kindOf('ply') }),
};
export const CWDS = { repo: fx => fx.repo, sub: fx => fx.sub };

export async function writeCombo(fx, combo) {
  const file = path.join(fx.dataDir, 'context-scans.json');
  await fs.rm(file, { force: true });
  await fs.rm(path.join(fx.dataDir, 'context-agents.json'), { force: true });
  const value = COMBOS[combo](fx);
  if (value) await fs.writeFile(file, JSON.stringify(value, null, 2));
}

/** 固定の木の根を <R> に置き換え、区切りを / にそろえる（OS によらず同じ記録にする） */
export function tokenizer(fx) {
  const forms = [...new Set([fx.root, fx.root.replace(/\\/g, '/')])].sort((a, b) => b.length - a.length);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(forms.map(esc).join('|'), 'gi');
  const tok = value => {
    if (typeof value === 'string') {
      const replaced = value.replace(re, '<R>');
      return replaced.includes('<R>') ? replaced.replace(/\\/g, '/') : replaced;
    }
    if (Array.isArray(value)) return value.map(tok);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [tok(k), tok(v)]));
    return value;
  };
  return tok;
}
// 比べるときの鍵。Windows は大小を区別しないので小文字にする
export const keyOf = p => p.replace(/\\/g, '/').toLowerCase();

/** Codex の app-server の代わり。skills/list は Codex が自分で読む Skills を返す */
export function fakeCodexRpc(codexSkillPaths) {
  return {
    async request(method) {
      if (method === 'skills/list') return { data: [{ skills: codexSkillPaths.map(p => ({ path: p })) }] };
      if (method === 'config/read') return { config: { mcp_servers: {} } };
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function importFrom(root, rel) { return import(pathToFileURL(path.join(root, rel)).href); }

/**
 * root のコードを読み込む。main の写しには無い関数（nativeEquivalentTurn など）は null。
 * その場合は、main の core/server.mjs・core/backends/*.mjs に書いてある判定を、ここでそのまま写して使う（mainGlue）
 */
export async function loadTree(root) {
  const [runtime, settings, scan, session, options, devinCfg, marks, agentsMod, matrixMod, agentCtx, ocMod] = await Promise.all([
    importFrom(root, 'core/context-runtime.mjs'), importFrom(root, 'core/context-settings.mjs'), importFrom(root, 'core/context-scan.mjs'),
    importFrom(root, 'core/context-session.mjs'), importFrom(root, 'core/backends/context-options.mjs'), importFrom(root, 'core/backends/devin-config.mjs'),
    importFrom(root, 'core/backends/agent-marks.mjs'),
    importFrom(root, 'core/context-agents.mjs').catch(() => null), importFrom(root, 'core/context-doc-matrix.mjs').catch(() => null),
    importFrom(root, 'core/backends/antigravity-context.mjs'), importFrom(root, 'core/backends/opencode-context.mjs'),
  ]);
  return { runtime, settings, scan, session, options, devinCfg, marks, agentsMod, matrixMod, agentCtx, ocMod, stage2: Boolean(agentsMod && matrixMod) };
}

/** 6 エージェントの代わり（plyContextRefusal は木ごとの PLY_CONTEXT_CONFLICTS。core/backends/grok.mjs と同じ判定） */
function fakeBackend(tree, id) {
  const conflicts = tree.marks.PLY_CONTEXT_CONFLICTS?.[id];
  return { id, label: id, capabilities: { plyContext: 'turn' }, ...(conflicts ? { plyContextRefusal: owners => conflicts.some(k => owners?.[k] === 'ply') ? 'refused' : null } : {}) };
}

/** エージェントが自分で読む指示・Skills（エージェントの読み込み元で、除外なしに探す）。Claude は作業場所の AGENTS.md も読む（CLI 2.1.280 の実測） */
// main の contextSources と実物が違う所（実物で確かめた補正。2026-11-15）:
// - OpenCode は .claude/skills・~/.claude/skills も読む（opencode.exe の OPENCODE_DISABLE_CLAUDE_CODE_SKILLS。main も「Pleiad がそろえる」でこれを渡して止めている）
// - Devin は ~/.config/opencode/AGENTS.md を読まない（devin.exe の opencode の取り込みは mcp.rs だけ。main の agents.mjs の注釈も「MCP のインポート」）
// - Devin は作業場所の .windsurf/global_rules.md を読まない（devin 1.x の `devin rules list` に出ない）
export async function nativeOracle(tree, fx, cwd, agent) {
  const out = {};
  for (const kind of DOC_KINDS) {
    const sources = agent === 'claude' ? ['claude', 'common'] : agent === 'opencode' && kind === 'skill' ? [...NATIVE_SOURCES.opencode, 'claude'] : NATIVE_SOURCES[agent];
    const kinds = k => Object.fromEntries(['instruction', 'skill', 'mcp'].map(x => [x, x === k ? { sources, excludePaths: [] } : null]));
    const plan = { user: { roots: [], kinds: kinds(kind) }, directory: { roots: [], kinds: kinds(kind) }, mcp: { disabled: [], prefer: {} }, skill: { prefer: {} } };
    const scan = await tree.scan.scanContext({ cwd, plan }, fx.scanOptions);
    out[kind] = scan.entries.filter(e => e.kind === kind && ['candidate', 'conditional'].includes(e.status))
      // Claude は common の段のユーザーの指示を持たない（AGENTS.md は作業場所のものだけ読む）。Skills の .agents/skills も読まない
      .filter(e => agent !== 'claude' || e.origins.some(o => o.source === 'claude') || (kind === 'instruction' && e.scope !== 'user'))
      .filter(e => agent !== 'devin' || kind !== 'instruction'
        || (e.origins.some(o => o.source !== 'opencode') && !(e.scope !== 'user' && /\/\.windsurf\/global_rules\.md$/i.test(keyOf(e.realPath ?? e.path)))))
      .map(e => ({ name: e.name, path: e.path, realPath: e.realPath, scope: e.scope, sources: [...new Set(e.origins.map(o => o.source))] }));
  }
  return out;
}

/**
 * 1 ターン分の計画。glue: 'main'（main の server.mjs・各 backend の判定を写したもの）か 'tree'（root に入っている関数）
 * 戻り: { plyContext, fallback, owners, outputs, delivered }
 */
export async function planTurn(tree, fx, { cwd, agent, codexSkillPaths, glue }) {
  const contextSettings = tree.settings.createContextSettings(fx.dataDir, fx.home);
  let effective = await contextSettings.get(cwd);
  if (glue === 'tree' && tree.stage2) {
    const raw = await contextSettings.read();
    const docAgents = await tree.agentsMod.createContextAgents(fx.dataDir).read();
    effective = tree.runtime.attachDocPolicy(effective, raw, docAgents);
  }
  const { policy: followed } = tree.runtime.followSettings(null, effective);
  const policy = { ...followed, agent };
  const backend = fakeBackend(tree, agent);
  let plyContext = tree.runtime.managed(policy) && tree.runtime.acceptsPlyContext(backend, policy);
  let rc = plyContext ? await tree.runtime.resolveRuntime(policy, { ...fx.scanOptions, plyServers: null, snapshots: fx.snapshots, locale: 'en', agent }) : null;
  let fallback = false;
  const nativeTurn = glue === 'tree' && tree.runtime.nativeEquivalentTurn
    ? tree.runtime.nativeEquivalentTurn(policy, rc)
    : Boolean(rc?.mcp.named && policy.owners.instruction !== 'ply' && policy.owners.skill !== 'ply' && !rc.servers.length && !rc.mcp.suppress.length);
  if (nativeTurn) { plyContext = false; rc = null; fallback = true; }
  const outputs = {};
  if (agent === 'claude') outputs.claude = tree.options.claudeContextOptions(rc, {});
  if (agent === 'codex' && rc) outputs.codex = (await tree.options.codexContextRpc(rc, cwd, fakeCodexRpc(codexSkillPaths))).config;
  if (agent === 'antigravity') {
    // main: core/backends/antigravity.mjs の prepareAgent の owners と、作業場所の指示の注入の条件（1019 行）
    const owners = glue === 'tree' && tree.agentCtx.antigravityAgentOwners
      ? tree.agentCtx.antigravityAgentOwners(rc)
      : (rc?.mcp?.named ? { ...rc.owners, mcp: 'native' } : rc?.owners ?? { instruction: 'native', skill: 'native', mcp: 'native' });
    const skipInject = glue === 'tree' && tree.agentCtx.antigravitySkipsNativeInstructions
      ? tree.agentCtx.antigravitySkipsNativeInstructions(rc)
      : rc?.owners?.instruction === 'ply';
    outputs.antigravity = { customAgent: Boolean(rc), inheritCustomizations: owners.skill !== 'ply', skipInject };
  }
  if (agent === 'devin') {
    // main の devinTurnConfig は docs を受けない（渡しても無視される）
    outputs.devin = { turnConfig: tree.devinCfg.devinTurnConfig({ hooksRuntime: null, nativeShellOff: false, docs: rc?.docs ?? null }) };
  }
  if (agent === 'opencode') {
    // main: core/backends/opencode.mjs の managedServer（owners = contextRuntime.owners）・sessionPermission の noSkill・context
    const owners = glue === 'tree' && tree.ocMod.effectiveOpencodeOwners
      ? tree.ocMod.effectiveOpencodeOwners(rc)
      : rc?.owners ?? { instruction: 'native', skill: 'native', mcp: 'native' };
    outputs.opencode = rc ? { managedServer: true, instructionOwner: owners.instruction ?? 'native', skillOwner: owners.skill ?? 'native', noSkill: owners.skill === 'ply' } : { managedServer: false };
  }
  const delivered = {
    instructions: (rc?.instructions ?? []).map(i => i.realPath),
    conditional: (rc?.conditional ?? []).map(i => i.realPath),
    skills: (rc?.skills ?? []).map(s => ({ name: s.name, realPath: s.realPath })),
  };
  return { plyContext, fallback, owners: policy.owners, outputs, delivered };
}

/** 組み合わせ × 作業場所 × エージェントの計画と native を採る。戻りは根を <R> にした JSON にできる値 */
export async function recordPlans(root, fx, { combos = Object.keys(COMBOS), glue = 'main' } = {}) {
  const tree = await loadTree(root);
  const tok = tokenizer(fx);
  const native = {};
  for (const [cwdName, cwdOf] of Object.entries(CWDS)) {
    native[cwdName] = {};
    for (const agent of AGENT_IDS) native[cwdName][agent] = await nativeOracle(tree, fx, cwdOf(fx), agent);
  }
  const plans = {};
  for (const combo of combos) {
    await writeCombo(fx, combo);
    plans[combo] = {};
    for (const [cwdName, cwdOf] of Object.entries(CWDS)) {
      plans[combo][cwdName] = {};
      for (const agent of AGENT_IDS) {
        const codexSkillPaths = native[cwdName].codex.skill.map(s => s.path);
        plans[combo][cwdName][agent] = tok(await planTurn(tree, fx, { cwd: cwdOf(fx), agent, codexSkillPaths, glue }));
      }
    }
  }
  return { native: tok(native), plans };
}

// ---- 見立て: 起動の設定から、エージェントが実際に見る指示・Skills ----

const base = p => p.replace(/\\/g, '/').split('/').pop();
/** Claude の claudeMdExcludes の 1 つが、このファイルに当たるか（main の glob と、名前ごとのモデルの絶対パスの両方） */
function claudeExcludes(pattern, entry) {
  const paths = [entry.path, entry.realPath].map(keyOf);
  if (!pattern.includes('*')) return paths.includes(keyOf(pattern));
  const m = /^\*\*\/([^*/]+)$/.exec(pattern);
  if (m) return paths.some(p => base(p) === m[1].toLowerCase());
  const dir = /^\*\*\/(.+)\/\*\*$/.exec(pattern);
  if (dir) return paths.some(p => p.includes(`/${dir[1].toLowerCase()}/`));
  throw new Error(`unknown claudeMdExcludes pattern ${pattern}`);
}
/**
 * Devin の read_config_from の形式（ファイルの出どころ）。Devin 自身の置き場（.devin・.cognition・設定の置き場）は止められないので null
 * Devin の文書（docs/cli の Configuration）の形式名: agents_standard・claude・opencode・windsurf・cursor・copilot・zed
 */
export function devinFormatOf(entry) {
  const p = keyOf(entry.realPath ?? entry.path);
  if (/\/\.devin\/|\/appdata\/roaming\/devin\/|\/\.config\/devin\/|\/\.cognition\/|\/appdata\/roaming\/cognition\/|\/\.config\/cognition\//.test(p)) return null;
  if (/\/\.agents\/skills\//.test(p)) return null;
  if (/\/\.windsurfrules$/.test(p)) return 'agents_standard';
  if (/\/\.windsurf\/|\/\.codeium\/windsurf/.test(p)) return 'windsurf';
  if (/\/\.cursor\//.test(p)) return 'cursor';
  if (/\/\.github\/skills\/|\/\.copilot\/skills\//.test(p)) return 'copilot';
  if (/\/\.claude\/|\/claude(\.local)?\.md$/.test(p)) return 'claude';
  if (/\/\.opencode\/|\/\.config\/opencode\//.test(p)) return 'opencode';
  if (/\/agents(\.local)?\.md$|\/agent\.md$/.test(p)) return 'agents_standard';
  return null;
}

/**
 * エージェントが見る指示（実体のパスの鍵）・Skills（名前）。native: そのエージェントの nativeOracle、plan: planTurn の戻り。
 * 見る = （自分で読むもの − 起動の設定で止めたもの）＋ Pleiad が渡したもの
 */
export function sees(agent, native, plan) {
  const out = plan.outputs ?? {};
  const keepInst = (() => {
    const n = native.instruction;
    if (agent === 'claude') {
      const ex = out.claude?.settings?.claudeMdExcludes ?? [];
      return n.filter(e => !ex.some(p => claudeExcludes(p, e)));
    }
    // project_doc_max_bytes = 0 は作業場所の AGENTS.md を読まない。~/.codex/AGENTS.md は読む
    if (agent === 'codex') return out.codex?.project_doc_max_bytes === 0 ? n.filter(e => e.scope === 'user') : n;
    // カスタムエージェントは作業場所の指示を自分で読まず、Pleiad が注入する（skipInject で注入しない）。~/.gemini/GEMINI.md は読む
    if (agent === 'antigravity') return out.antigravity?.skipInject ? n.filter(e => e.scope === 'user') : n;
    if (agent === 'devin') {
      const off = out.devin?.turnConfig?.read_config_from ?? {};
      return n.filter(e => { const f = devinFormatOf(e); return !f || off[f] !== false; });
    }
    if (agent === 'opencode') return out.opencode?.managedServer && out.opencode.instructionOwner === 'ply' ? [] : n;
    return n;
  })();
  const keepSkill = (() => {
    const n = native.skill;
    if (agent === 'claude') {
      const list = out.claude?.skills;
      if (out.claude?.disallowedTools?.includes('Skill')) return [];
      return Array.isArray(list) ? n.filter(s => list.includes(s.name)) : n;
    }
    if (agent === 'codex') {
      const disabled = new Set((out.codex?.['skills.config'] ?? []).filter(s => s.enabled === false).map(s => keyOf(s.path)));
      return n.filter(s => !disabled.has(keyOf(s.path)));
    }
    if (agent === 'antigravity') return out.antigravity?.customAgent && !out.antigravity.inheritCustomizations ? [] : n;
    if (agent === 'devin') {
      const off = out.devin?.turnConfig?.read_config_from ?? {};
      return n.filter(s => { const f = devinFormatOf(s); return !f || off[f] !== false; });
    }
    if (agent === 'opencode') return out.opencode?.managedServer && out.opencode.noSkill ? [] : n;
    return n;
  })();
  const instructions = new Set([...keepInst.map(e => keyOf(e.realPath)), ...plan.delivered.instructions.map(keyOf), ...plan.delivered.conditional.map(keyOf)]);
  const skills = new Set([...keepSkill.map(s => s.name), ...plan.delivered.skills.map(s => s.name)]);
  return { instruction: [...instructions].sort(), skill: [...skills].sort() };
}
