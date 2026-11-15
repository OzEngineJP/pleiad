/**
 * Persistent per-item × per-agent matrix rules for external instructions and skills (ADR 0337).
 * Stored in <dataDir>/context-agents.json (version 1) so beta.31 context-scans.json strict validation
 * never breaks on downgrade. Legacy settings govern any (place, kind) until that depth is first touched.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { writeAtomic } from './atomic-file.mjs';
import {
  DEFAULT_SOURCES,
  containsPath,
  pathKey,
} from './context-settings.mjs';
import {
  DOC_AGENT_IDS,
  DOC_AGENT_TRAITS,
  canRelayDocToAgent,
  docCellLock,
  entryOrigins,
  isEntryNativeTo,
  normalizeSlashPath,
} from './backends/context-capabilities.mjs';

export const DOC_KINDS = ['instruction', 'skill'];
export const DOC_AGENTS_FILE = 'context-agents.json';
export const DOC_AGENTS_VERSION = 1;
export const WORKSPACE_SUMMARY_KEY = '__workspace__';
export const MAX_PLACES = 100;
export const MAX_AGENT_KEYS = 2000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const AGENT_IDX = new Map(DOC_AGENT_IDS.map((id, i) => [id, i]));
const sortAgents = (ids) => [...new Set(ids)].filter((id) => AGENT_IDX.has(id)).sort((a, b) => AGENT_IDX.get(a) - AGENT_IDX.get(b));

const agentEntrySchema = z.object({
  off: z.array(z.string()).optional(),
  spread: z.array(z.string()).optional(),
}).strict();

const kindOverrideSchema = z.object({
  agents: z.record(z.string(), agentEntrySchema),
}).strict();

const placeOverrideSchema = z.object({
  instruction: kindOverrideSchema.optional(),
  skill: kindOverrideSchema.optional(),
}).strict();

const fileSchema = z.object({
  version: z.literal(DOC_AGENTS_VERSION),
  defaults: placeOverrideSchema.default({}),
  places: z.record(z.string(), placeOverrideSchema).default({}),
}).strict();

/** Stable per-item identity key shared by storage, UI matrix rows, and runtime resolution. */
export function docItemKey(entry) {
  if (!entry || entry === WORKSPACE_SUMMARY_KEY) return WORKSPACE_SUMMARY_KEY;
  if (entry.kind === 'skill') return `skill:${entry.name}`;
  return `file:${normalizeSlashPath(pathKey(entry.realPath ?? entry.path))}`;
}

function normalizeAgentValue(value) {
  return {
    off: sortAgents(Array.isArray(value?.off) ? value.off : []),
    spread: sortAgents(Array.isArray(value?.spread) ? value.spread : []),
  };
}

function normalizeKindOverride(raw) {
  if (!isObj(raw) || !isObj(raw.agents)) return undefined;
  const agents = {};
  for (const [k, v] of Object.entries(raw.agents)) {
    if (!k) continue;
    agents[k] = normalizeAgentValue(v);
  }
  return { agents };
}

function normalizePlaceOverride(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  for (const kind of DOC_KINDS) {
    const k = normalizeKindOverride(raw[kind]);
    if (k) out[kind] = k;
  }
  return out;
}

export const emptyDocAgentsConfig = () => ({ version: DOC_AGENTS_VERSION, defaults: {}, places: {} });

/** Count stored item keys across defaults and all places to enforce bounded storage. */
export function countAgentKeys(config) {
  let total = 0;
  for (const kind of DOC_KINDS) {
    total += Object.keys(config.defaults?.[kind]?.agents ?? {}).length;
  }
  for (const place of Object.values(config.places ?? {})) {
    for (const kind of DOC_KINDS) {
      total += Object.keys(place?.[kind]?.agents ?? {}).length;
    }
  }
  return total;
}

/** Validate and normalize parsed JSON from context-agents.json. Throws if malformed or over limits. */
export function normalizeDocAgentsConfig(raw) {
  if (raw == null) return emptyDocAgentsConfig();
  const parsed = fileSchema.parse(raw);
  const defaults = normalizePlaceOverride(parsed.defaults);
  const places = {};
  for (const [k, v] of Object.entries(parsed.places ?? {})) {
    const normKey = pathKey(k);
    const val = normalizePlaceOverride(v);
    if (Object.keys(val).length) places[normKey] = val;
  }
  const normalized = { version: DOC_AGENTS_VERSION, defaults, places };
  if (Object.keys(normalized.places).length > MAX_PLACES) {
    throw new Error(`context-agents places limit exceeded (${MAX_PLACES})`);
  }
  if (countAgentKeys(normalized) > MAX_AGENT_KEYS) {
    throw new Error(`context-agents total key limit exceeded (${MAX_AGENT_KEYS})`);
  }
  return normalized;
}

const placeDepth = (k) => (k ? 1 + pathKey(k).length : 0);

function ancestorKeys(placesObj, cwdKey) {
  if (!cwdKey || !isObj(placesObj)) return [];
  return Object.keys(placesObj)
    .filter((p) => containsPath(p, cwdKey))
    .sort((a, b) => placeDepth(a) - placeDepth(b));
}

/**
 * Resolve whether Stage 2 rules or legacy context-scans rules govern `(cwd, kind)`.
 * Legacy stays active until a matching (or deeper) place/default exists in context-agents.json.
 */
export function resolveEffectiveDocSource(legacyConfig, docAgentsConfig, cwd, kind) {
  const cwdKey = cwd ? pathKey(cwd) : null;
  const defaultRule = legacyConfig?.defaults?.kinds?.[kind] ?? legacyConfig?.defaults?.[kind] ?? null;
  const legacyChain = [{ depth: 0, place: null, rule: defaultRule }];
  for (const p of ancestorKeys(legacyConfig?.places, cwdKey)) {
    const rule = legacyConfig.places[p]?.kinds?.[kind];
    if (rule) legacyChain.push({ depth: placeDepth(p), place: p, rule });
  }

  const agentsChain = [];
  if (docAgentsConfig?.defaults?.[kind]) {
    agentsChain.push({ depth: 0, place: null, agents: docAgentsConfig.defaults[kind].agents });
  }
  for (const p of ancestorKeys(docAgentsConfig?.places, cwdKey)) {
    const ov = docAgentsConfig.places[p]?.[kind];
    if (ov) agentsChain.push({ depth: placeDepth(p), place: p, agents: ov.agents });
  }

  const deepestLegacy = legacyChain.at(-1);
  const deepestAgents = agentsChain.at(-1) ?? null;
  const touched = Boolean(deepestAgents && deepestAgents.depth >= deepestLegacy.depth);
  return {
    touched,
    legacyRule: deepestLegacy.rule,
    legacyPlace: deepestLegacy.place,
    legacyDepth: deepestLegacy.depth,
    agentsChain,
    agentsPlace: deepestAgents?.place ?? null,
    agentsDepth: deepestAgents?.depth ?? -1,
  };
}

/** Whether any level in `agentsChain` stores an explicit per-item rule for `key`. */
export const hasExplicitRule = (agentsChain, key) => agentsChain.some((level) => Object.hasOwn(level.agents ?? {}, key));

/** Resolve the effective `{ off, spread }` rule for `key` from `agentsChain`. */
export function resolveRuleForItem(agentsChain, key, scope) {
  for (let i = agentsChain.length - 1; i >= 0; i--) {
    const hit = agentsChain[i].agents?.[key];
    if (hit) return hit;
  }
  if ((scope === 'directory' || scope === 'workspace' || scope === 'local') && key !== WORKSPACE_SUMMARY_KEY) {
    for (let i = agentsChain.length - 1; i >= 0; i--) {
      const wsRule = agentsChain[i].agents?.[WORKSPACE_SUMMARY_KEY];
      if (wsRule) return wsRule;
    }
  }
  return { off: [], spread: [] };
}

const exclusionReal = new Map();
/** 旧い除外のパスと、その実体（シンボリックリンク・ジャンクションの先）。実体は覚えておく（表を作るたびに同期で引かない） */
function legacyExclusions(list) {
  const out = [];
  for (const p of list ?? []) {
    out.push(p);
    if (!exclusionReal.has(p)) {
      let real = null;
      try { real = fsSync.realpathSync.native(p); } catch {}
      exclusionReal.set(p, real);
    }
    const real = exclusionReal.get(p);
    if (real && real !== p) out.push(real);
  }
  return out;
}

/**
 * Determine whether `entryOrSummary` was active under legacy `legacyRule`.
 * When `legacyRule.owner === 'native'`, Pleiad did zero filtering at runtime so all existing entries are native-active.
 */
export function legacyEntryIncluded(kind, entryOrSummary, legacyRule, { home = os.homedir(), cwd = null } = {}) {
  if (!legacyRule || legacyRule.owner !== 'ply') return true;
  if (entryOrSummary === WORKSPACE_SUMMARY_KEY) {
    return (legacyRule.directory?.sources?.length ?? 0) > 0;
  }
  const origins = entryOrigins(entryOrSummary);
  for (const o of origins) {
    const scopeRule = o.scope === 'user' ? legacyRule.user : legacyRule.directory;
    const allowed = scopeRule?.sources ?? DEFAULT_SOURCES;
    const sourceOk = o.source === 'custom' || allowed.includes(o.source);
    if (!sourceOk) continue;
    // 旧い除外は絶対パス（保存のときに解決済み）で、その物かその下を外す。main の探し方（context-scan.mjs の exclusions）と同じく、除外のパスとその実体の両方で比べる
    const excluded = legacyExclusions(scopeRule?.excludePaths).some((x) => [o.path, entryOrSummary.path, entryOrSummary.realPath].some((f) => f && containsPath(x, f)));
    if (!excluded) return true;
  }
  return false;
}

/** Convert legacy `(owner, sources, excludePaths)` state for an item/summary into Stage 2 `{ off, spread }`. */
export function docAgentsFromLegacy(kind, entryOrSummary, legacyRule, opts = {}) {
  const included = typeof opts.included === 'boolean' ? opts.included : legacyEntryIncluded(kind, entryOrSummary, legacyRule, opts);
  const off = [];
  const spread = [];
  const isPly = legacyRule?.owner === 'ply';
  const ctx = { legacyOwner: legacyRule?.owner ?? 'native' };
  for (const agent of DOC_AGENT_IDS) {
    if (docCellLock(agent, kind, entryOrSummary, ctx)) continue;
    if (!included) {
      // 旧い「Pleiad がそろえる」でも、自分で読む物を止めていなかったエージェント（Devin）は、外していた物もそのまま読んでいた
      if (isPly && DOC_AGENT_TRAITS[agent]?.legacyPlyKeepsNative && isEntryNativeTo(agent, kind, entryOrSummary)) continue;
      off.push(agent);
      continue;
    }
    if (isPly && !isEntryNativeTo(agent, kind, entryOrSummary) && canRelayDocToAgent(agent)) {
      spread.push(agent);
    }
  }
  return { off: sortAgents(off), spread: sortAgents(spread) };
}

/**
 * Evaluate exact display & runtime cell states for all 6 agents from a stored `{ off, spread }` rule.
 * Locks always take precedence so immutable CLI behaviors remain honest.
 */
export function evaluateDocCells(kind, entryOrSummary, storedRule, ctx = null) {
  const rule = storedRule ?? { off: [], spread: [] };
  const offSet = new Set(rule.off ?? []);
  const spreadSet = new Set(rule.spread ?? []);
  const cells = {};
  for (const agent of DOC_AGENT_IDS) {
    const isNat = isEntryNativeTo(agent, kind, entryOrSummary);
    const lock = docCellLock(agent, kind, entryOrSummary, ctx);
    if (lock) {
      const on = Boolean(lock.lockedOn);
      cells[agent] = {
        on,
        mode: on ? (isNat ? 'native' : 'spread') : 'off',
        locked: true,
        reason: lock.reason,
        native: isNat,
      };
      continue;
    }
    if (offSet.has(agent)) {
      cells[agent] = { on: false, mode: 'off', locked: false, native: isNat };
    } else if (isNat) {
      cells[agent] = { on: true, mode: 'native', locked: false, native: true };
    } else if (spreadSet.has(agent) && canRelayDocToAgent(agent)) {
      cells[agent] = { on: true, mode: 'spread', locked: false, native: false };
    } else {
      cells[agent] = { on: false, mode: 'off', locked: false, native: isNat };
    }
  }
  return cells;
}

/** Toggle a single agent cell on `(kind, entryOrSummary)`. Locked cells remain unchanged. */
export function toggleDocAgentRule(kind, entryOrSummary, currentRule, agent, on, ctx = null) {
  if (!AGENT_IDX.has(agent) || docCellLock(agent, kind, entryOrSummary, ctx)) {
    return normalizeAgentValue(currentRule);
  }
  const off = new Set(currentRule?.off ?? []);
  const spread = new Set(currentRule?.spread ?? []);
  const isNat = isEntryNativeTo(agent, kind, entryOrSummary);
  if (on) {
    off.delete(agent);
    if (!isNat && canRelayDocToAgent(agent)) spread.add(agent);
  } else {
    spread.delete(agent);
    off.add(agent);
  }
  return { off: sortAgents(off), spread: sortAgents(spread) };
}

/** Turn all unlocked deliverable cells of a row ON or OFF together (whole-row / right-panel switch). */
export function setDocRowRule(kind, entryOrSummary, currentRule, on, ctx = null) {
  let next = normalizeAgentValue(currentRule);
  for (const agent of DOC_AGENT_IDS) {
    if (docCellLock(agent, kind, entryOrSummary, ctx)) continue;
    next = toggleDocAgentRule(kind, entryOrSummary, next, agent, on, ctx);
  }
  return next;
}

/** Create an atomic serialized reader/writer store for `<dataDir>/context-agents.json`. */
export function createContextAgents(dataDir) {
  const file = path.join(dataDir, DOC_AGENTS_FILE);
  let queue = Promise.resolve();

  const read = async () => {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return emptyDocAgentsConfig();
      throw err;
    }
    return normalizeDocAgentsConfig(JSON.parse(text));
  };

  const mutate = (fn) => {
    const run = queue.then(async () => {
      const current = await read();
      const nextRaw = await fn(structuredClone(current));
      const next = normalizeDocAgentsConfig(nextRaw);
      await fs.mkdir(dataDir, { recursive: true });
      await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
    queue = run.catch(() => {});
    return run;
  };

  const removePlace = (place, kind = null) => mutate((cfg) => {
    const key = pathKey(place);
    if (!cfg.places[key]) return cfg;
    if (kind && DOC_KINDS.includes(kind)) {
      delete cfg.places[key][kind];
      if (!Object.keys(cfg.places[key]).length) delete cfg.places[key];
    } else {
      delete cfg.places[key];
    }
    return cfg;
  });

  const prunePlaces = (keepKeys) => mutate((cfg) => {
    const keep = new Set([...keepKeys].map((k) => pathKey(k)));
    for (const k of Object.keys(cfg.places)) {
      if (!keep.has(k)) delete cfg.places[k];
    }
    return cfg;
  });

  return { file, read, mutate, removePlace, prunePlaces };
}
