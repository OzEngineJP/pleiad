/**
 * Per-agent capabilities and native readership rules for external instructions and skills (ADR 0337).
 * All agent-specific literals live under core/backends/ so core/ and web/ stay agent-agnostic.
 */
import path from 'node:path';
import { DEFAULT_AGENT_IDS } from './agents.mjs';

export const DOC_AGENT_IDS = Object.freeze([...DEFAULT_AGENT_IDS]);

/** Normalize any OS path to lowercase forward-slash form for matching CLI config locations. */
export function normalizeSlashPath(p) {
  if (!p) return '';
  const resolved = process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Extract normalized origins list for an entry (or empty list for summary rows). */
export function entryOrigins(entry) {
  if (!entry || typeof entry === 'string') return [];
  if (Array.isArray(entry.origins) && entry.origins.length) {
    return entry.origins.map((o) => ({
      source: o.source ?? entry.source ?? 'common',
      scope: o.scope ?? entry.scope ?? 'workspace',
      path: normalizeSlashPath(o.path ?? entry.path ?? entry.realPath ?? ''),
      realPath: normalizeSlashPath(o.realPath ?? o.path ?? entry.realPath ?? entry.path ?? ''),
      custom: Boolean(o.root ?? entry.root),
    }));
  }
  const p = normalizeSlashPath(entry.path ?? entry.realPath ?? '');
  const rp = normalizeSlashPath(entry.realPath ?? entry.path ?? '');
  return [{ source: entry.source ?? 'common', scope: entry.scope ?? 'workspace', path: p, realPath: rp, custom: Boolean(entry.root) }];
}

const isAgentsSkillsPath = (p) => /(?:^|\/)\.agents\/skills(?:\/|$)/i.test(p);
const isClaudePath = (p) => /(?:^|\/)(?:\.claude(?:\/|$)|CLAUDE(?:\.local)?\.md$)/i.test(p);
const isCursorPath = (p) => /(?:^|\/)\.cursor\//i.test(p);
const isWindsurfDirPath = (p) => /(?:^|\/)\.windsurf\//i.test(p);
const isCopilotPath = (p) => /(?:^|\/)\.github\/(?:copilot-instructions\.md|instructions\/|skills\/)/i.test(p);
const isOpenCodeDirPath = (p) => /(?:^|\/)\.opencode\//i.test(p);
const isIsolatedAgentConfigDir = (p) => /(?:^|\/)\.(?:codex|config\/opencode|grok)\//i.test(p);

/** True if path belongs to Devin's unstoppable own dirs (%APPDATA%/devin, .devin, .cognition). */
export function isDevinOwnPath(p) {
  const s = normalizeSlashPath(p);
  return /(?:^|\/)(?:\.devin|\.cognition)(?:\/|$)/i.test(s) || /\/appdata\/roaming\/devin(?:\/|$)/i.test(s);
}

/**
 * Map a scanned origin to Devin's `read_config_from` key if Devin natively imports and can suppress it.
 * Returns null if Devin owns it unconditionally or does not natively import it.
 */
export function devinImportFormat(kind, pathStr, originSource) {
  const p = normalizeSlashPath(pathStr);
  if (!p || isDevinOwnPath(p)) return null;
  if (kind === 'skill' && isAgentsSkillsPath(p)) return null;
  if (originSource === 'claude' || isClaudePath(p)) return 'claude';
  if (isCursorPath(p)) return 'cursor';
  if (isWindsurfDirPath(p)) return 'windsurf';
  if (isCopilotPath(p)) return 'copilot';
  if (isOpenCodeDirPath(p) || (kind === 'skill' && originSource === 'opencode')) return 'opencode';
  if (
    kind === 'instruction'
    && !isIsolatedAgentConfigDir(p)
    && (/(?:^|\/)(?:AGENTS(?:\.local)?|AGENT)\.md$/i.test(p) || /(?:^|\/)\.windsurfrules$/i.test(p))
  ) {
    return 'agents_standard';
  }
  return null;
}

const NATIVE_READERS = {
  claude(kind, origin) {
    // Claude Code も作業場所の AGENTS.md を読む（main の CLAUDE_MD_EXCLUDES が **/AGENTS.md を止めているのと同じ。本物で確かめた）
    if (kind === 'instruction') {
      return origin.source === 'claude'
        || (origin.source === 'common' && origin.scope !== 'user' && /(?:^|\/)AGENTS\.md$/i.test(origin.path));
    }
    return origin.source === 'claude';
  },
  codex(kind, origin) {
    if (kind === 'instruction') {
      return origin.source === 'codex'
        || (origin.source === 'common' && /(?:^|\/)AGENTS(?:\.override)?\.md$/i.test(origin.path));
    }
    return origin.source === 'codex'
      || (origin.source === 'common' && isAgentsSkillsPath(origin.path));
  },
  antigravity(kind, origin) {
    if (kind === 'instruction') {
      return origin.source === 'antigravity' || (origin.source === 'common' && origin.scope !== 'user');
    }
    return origin.source === 'antigravity'
      || (origin.source === 'common' && isAgentsSkillsPath(origin.path));
  },
  opencode(kind, origin) {
    if (kind === 'instruction') {
      return origin.source === 'opencode'
        || (origin.source === 'common' && origin.scope !== 'user' && /(?:^|\/)AGENTS\.md$/i.test(origin.path));
    }
    return origin.source === 'opencode'
      || origin.source === 'claude'
      || (origin.source === 'common' && isAgentsSkillsPath(origin.path));
  },
  devin(kind, origin) {
    if (isDevinOwnPath(origin.path) || isDevinOwnPath(origin.realPath)) return true;
    if (kind === 'skill' && (isAgentsSkillsPath(origin.path) || isAgentsSkillsPath(origin.realPath))) return true;
    return devinImportFormat(kind, origin.path, origin.source) !== null;
  },
  grok(_kind, origin) {
    return origin.source === 'grok' || origin.source === 'common' || origin.source === 'claude';
  },
};

/**
 * Whether `agent` natively loads `entryOrSummary` without Pleiad injection.
 * Passing `'__workspace__'` returns true for every agent since workspace summaries aggregate CLAUDE.md/AGENTS.md and .claude/skills/.agents/skills.
 */
export function isEntryNativeTo(agent, kind, entryOrSummary) {
  if (entryOrSummary === '__workspace__') return true;
  const check = NATIVE_READERS[agent];
  if (!check) return false;
  // 「探す場所」に足したフォルダー（entry.root）はどのエージェントも自分では読まない（main の nativeInstructionEntries も roots: [] で探す）
  return entryOrigins(entryOrSummary).some((o) => !o.custom && check(kind, o));
}

/** Return the list of agents that natively read `entryOrSummary`. */
export function nativeReaders(kind, entryOrSummary) {
  return DOC_AGENT_IDS.filter((agent) => isEntryNativeTo(agent, kind, entryOrSummary));
}

/** Whether Pleiad can deliver external file instructions/skills to `agent`. */
export function canRelayDocToAgent(agent) {
  return agent !== 'grok';
}

function scopeLockReason(origins) {
  return origins.some((o) => o.scope === 'user') ? 'own' : 'workspace';
}

const LOCK_CHECKS = {
  claude: () => null,
  // Codex の全体の指示（~/.codex/AGENTS.md・AGENTS.override.md）は project_doc_max_bytes では止まらず、main も止めていない
  codex(kind, entryOrSummary) {
    if (entryOrSummary === '__workspace__' || kind !== 'instruction') return null;
    const own = entryOrigins(entryOrSummary).some((o) => !o.custom && o.source === 'codex' && o.scope === 'user');
    return own ? { lockedOn: true, reason: 'own' } : null;
  },
  opencode: () => null,
  antigravity(kind, entryOrSummary, ctx) {
    // Antigravity は自分で読む Skills を 1 つでも止めると inheritCustomizations: false になり、Hooks・プラグイン・サブエージェントも一緒に消える。
    // main でもそうなる旧い「Pleiad がそろえる」の場所でだけ押せるようにし、それ以外では止められない鍵にする
    if (kind === 'skill') {
      if (ctx?.legacyOwner === 'ply') return null;
      return entryOrSummary === '__workspace__' || isEntryNativeTo('antigravity', kind, entryOrSummary) ? { lockedOn: true, reason: 'bundled' } : null;
    }
    if (entryOrSummary === '__workspace__') return null;
    const lockedOrigins = entryOrigins(entryOrSummary).filter((o) => !o.custom && o.source === 'antigravity' && o.scope === 'user');
    return lockedOrigins.length ? { lockedOn: true, reason: 'own' } : null;
  },
  devin(kind, entryOrSummary) {
    if (entryOrSummary === '__workspace__') {
      return kind === 'skill' ? { lockedOn: true, reason: 'workspace' } : null;
    }
    const origins = entryOrigins(entryOrSummary);
    const matching = origins.filter((o) => !o.custom && (
      isDevinOwnPath(o.path) || isDevinOwnPath(o.realPath)
      || (kind === 'skill' && (isAgentsSkillsPath(o.path) || isAgentsSkillsPath(o.realPath)))
    ));
    return matching.length ? { lockedOn: true, reason: scopeLockReason(matching) } : null;
  },
  grok(kind, entryOrSummary) {
    if (entryOrSummary === '__workspace__') {
      return { lockedOn: true, reason: 'workspace' };
    }
    const matching = entryOrigins(entryOrSummary).filter((o) => !o.custom && NATIVE_READERS.grok(kind, o));
    if (matching.length) return { lockedOn: true, reason: scopeLockReason(matching) };
    return { lockedOn: false, reason: 'relay' };
  },
};

/**
 * Lock descriptor for an external instruction/skill cell `(agent, kind, entryOrSummary)`.
 * Returns null if user-toggleable, or `{ lockedOn: boolean, reason: 'own' | 'workspace' | 'relay' | 'bundled' }`.
 * `ctx.legacyOwner` is the legacy owner ('native' | 'ply') of `kind` at the place (some locks depend on it).
 */
export function docCellLock(agent, kind, entryOrSummary, ctx = null) {
  return LOCK_CHECKS[agent]?.(kind, entryOrSummary, ctx) ?? null;
}

/** Whether Claude uses native `claudeMdExcludes` per-file suppression (always true) or per-name skills list. */
export const DOC_AGENT_TRAITS = Object.freeze({
  claude: { perFileInstructionExclude: true, perNameSkillList: true, customInstructionPath: true, relay: true },
  codex: { perFileInstructionExclude: false, perNameSkillList: false, perPathSkillDisable: true, customInstructionPath: true, relay: true },
  antigravity: { perFileInstructionExclude: false, perNameSkillList: false, customAgentRequired: true, relay: true },
  opencode: { perFileInstructionExclude: false, perNameSkillList: false, managedServeOnDiff: true, relay: true },
  devin: { perFileInstructionExclude: false, perNameSkillList: false, readConfigFrom: true, mcpCompensationFormats: ['claude', 'cursor'], relay: true, legacyPlyKeepsNative: true },
  grok: { perFileInstructionExclude: false, perNameSkillList: false, relay: false },
});

/** Map `(kind, origins)` to all Devin `read_config_from` keys affected by an entry. */
export function devinFormatsForEntry(kind, entry) {
  const out = new Set();
  for (const o of entryOrigins(entry)) {
    const fmt = devinImportFormat(kind, o.path, o.source);
    if (fmt) out.add(fmt);
  }
  return [...out];
}

/** Collect all disabled `read_config_from` keys for Devin across instruction + skill docs. */
export function devinEffectiveDisabledFormats(docs) {
  const set = new Set();
  for (const kind of ['instruction', 'skill']) {
    for (const fmt of docs?.[kind]?.devinDisableFormats ?? []) set.add(fmt);
  }
  return [...set];
}

/** Formats whose native MCP configs are suppressed when disabled via `read_config_from` and need Pleiad relay. */
export function compensatedMcpFormats(agent, docs) {
  const formats = DOC_AGENT_TRAITS[agent]?.mcpCompensationFormats;
  if (!formats?.length) return [];
  const disabled = new Set(devinEffectiveDisabledFormats(docs));
  return formats.filter((f) => disabled.has(f));
}

/** True when an MCP entry stems from one of the compensated native import formats (e.g. 'claude', 'cursor'). */
export function mcpEntryMatchesFormat(entry, formats = []) {
  if (!formats.length || !entry) return false;
  const set = new Set(formats);
  return entryOrigins(entry).some((o) => (
    (set.has('claude') && (o.source === 'claude' || isClaudePath(o.path) || /\.mcp\.json$/i.test(o.path) || /\.claude\.json$/i.test(o.path)))
    || (set.has('cursor') && isCursorPath(o.path))
  ));
}

/** Determine whether `ply_context` should expose `load_skill` / `instructions_for_path` for `agent`. */
export function docToolRequirements(agent, docs, conditionalCount = 0, instructionsCount = 0) {
  const traits = DOC_AGENT_TRAITS[agent] ?? {};
  const needLoadSkill = Boolean(docs?.skill && docs.skill.deliver.length > 0);
  const needInstructionsForPath = Boolean(
    docs?.instruction
    && (conditionalCount > 0
      || instructionsCount > 0
      || (!traits.perFileInstructionExclude && docs.instruction.suppress.length > 0)
      || docs.instruction.spreadSummary),
  );
  return { needLoadSkill, needInstructionsForPath };
}

/** True when Stage 2 docs for `agent` diverge from native behavior and need runtime wiring. */
export function docHasWorkForAgent(docs) {
  return Boolean(
    (docs?.instruction && !docs.instruction.untouchedNative)
    || (docs?.skill && !docs.skill.untouchedNative),
  );
}
