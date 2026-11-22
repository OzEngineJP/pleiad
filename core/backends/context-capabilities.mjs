/**
 * Per-agent capabilities and native readership rules for external instructions and skills (ADR 0337).
 * All agent-specific literals live under core/backends/ so core/ and web/ stay agent-agnostic.
 */
import fsSync from 'node:fs';
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
// Devin の取り込み（devin 1.x の `devin skills list` / `rules list` と `read_config_from` で実測）:
// 作業場所の .windsurf/rules・.windsurf/skills は windsurf、.github/skills は copilot で止まる。.github/copilot-instructions.md は読まない。
// ユーザーの ~/.codeium/windsurf*/skills・~/.copilot/skills は main の探し方が Devin の物として並べる所（実物は本物の HOME に書けず未確認なので鍵）
const isWindsurfDirPath = (p) => /(?:^|\/)(?:\.windsurf|\.codeium\/windsurf(?:-next|-insiders)?)\//i.test(p);
const isCopilotPath = (p) => /(?:^|\/)(?:\.github|\.copilot)\/skills\//i.test(p);
const isOpenCodeDirPath = (p) => /(?:^|\/)\.opencode\//i.test(p);
const isIsolatedAgentConfigDir = (p) => /(?:^|\/)\.(?:codex|config\/opencode|grok)\//i.test(p);
// 作業場所の .windsurf/global_rules.md は main の探し方では Devin の物だが、devin 1.x は読まない（rules list に出ない）
const isWindsurfWorkspaceGlobalRules = (p) => /(?:^|\/)\.windsurf\/global_rules\.md$/i.test(p);

/**
 * True if path belongs to Devin's unstoppable own dirs: <設定の置き場>/devin（%APPDATA%・~/.config・DEVIN_CONFIG_HOME）、
 * その隣の cognition、~/.devin、作業場所の .devin・.cognition（`devin skills paths` が並べ、read_config_from の対象外）
 */
export function isDevinOwnPath(p) {
  const s = normalizeSlashPath(p);
  return /(?:^|\/)(?:\.devin|\.cognition)(?:\/|$)/i.test(s) || /\/(?:appdata\/roaming|\.config)\/(?:devin|cognition)(?:\/|$)/i.test(s);
}

/**
 * Map a scanned origin to Devin's `read_config_from` key if Devin natively imports and can suppress it.
 * Returns null if Devin owns it unconditionally or does not natively import it.
 */
export function devinImportFormat(kind, pathStr, originSource, scope = null) {
  const p = normalizeSlashPath(pathStr);
  if (!p || isDevinOwnPath(p)) return null;
  // ユーザーの Devin の置き場（DEVIN_CONFIG_HOME などで場所が変わっても）は Devin 自身の物。~/.codeium・~/.copilot の Skills だけ取り込みの形式で数える
  if (originSource === 'devin' && scope === 'user' && !isWindsurfDirPath(p) && !isCopilotPath(p)) return null;
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

const isWorkspaceAgentsMd = (origin) => origin.source === 'common' && origin.scope !== 'user' && /(?:^|\/)AGENTS\.md$/i.test(origin.path);

/** 同じフォルダーに Claude Code の指示（CLAUDE.md・.claude/CLAUDE.md・CLAUDE.local.md）があるか */
function claudeMdBeside(file) {
  const dir = path.dirname(file);
  return ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'].some((f) => fsSync.existsSync(path.join(dir, f)));
}

const NATIVE_READERS = {
  claude(kind, origin) {
    // Claude Code は作業場所の AGENTS.md を、同じフォルダーに CLAUDE.md・.claude/CLAUDE.md・CLAUDE.local.md が無いときだけ代わりに読む
    // （2.1.322 で 4 つの置き方を本物で確かめた。2026-11-15）。CLAUDE.md を claudeMdExcludes で外すと読み始めるので、止めるときは mayReadNatively で外す
    if (kind === 'instruction') {
      return origin.source === 'claude' || (isWorkspaceAgentsMd(origin) && !claudeMdBeside(origin.path));
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
    if (kind === 'instruction' && origin.scope !== 'user' && isWindsurfWorkspaceGlobalRules(origin.path)) return false;
    if (isDevinOwnPath(origin.path) || isDevinOwnPath(origin.realPath)) return true;
    // main の探し方が Devin の物として並べる所（DEVIN_CONFIG_HOME の置き場・cognition・~/.codeium・~/.copilot の Skills）
    if (origin.source === 'devin') return true;
    if (kind === 'skill' && (isAgentsSkillsPath(origin.path) || isAgentsSkillsPath(origin.realPath))) return true;
    return devinImportFormat(kind, origin.path, origin.source, origin.scope) !== null;
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

/**
 * Whether `agent` may load `entryOrSummary` by itself in some session, even if it does not by default.
 * Claude Code reads a workspace AGENTS.md once the CLAUDE.md beside it is excluded, so a stopped or relayed AGENTS.md is always excluded on Claude.
 */
export function mayReadNatively(agent, kind, entryOrSummary) {
  if (isEntryNativeTo(agent, kind, entryOrSummary)) return true;
  return agent === 'claude' && kind === 'instruction' && entryOrigins(entryOrSummary).some((o) => !o.custom && isWorkspaceAgentsMd(o));
}

/** Return the list of agents that natively read `entryOrSummary`. */
export function nativeReaders(kind, entryOrSummary) {
  return DOC_AGENT_IDS.filter((agent) => isEntryNativeTo(agent, kind, entryOrSummary));
}

/** Whether Pleiad can deliver external file instructions/skills to `agent`. */
export function canRelayDocToAgent(agent) {
  return DOC_AGENT_TRAITS[agent]?.relay ?? true;
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
  // Devin の取り込みを止めると read_config_from が形式ごとに Hooks・MCP まで止める（2026-11-15 の本物の確かめ）。
  // 指示と Skills の表では Devin の取り込みを止めないと決めた（ADR 0337 §決定 8）。Devin が自分で読む物は、まとめの行も含めて鍵付きでオン
  // Devin 自身の置き場（.devin・.cognition・設定の置き場）とユーザーの Devin の物は own、ほかの形式から取り込む物は bundled（止めると Hooks・MCP も止まる）
  // ctx.devinImportsStopped: その場所の Devin のターンで、Pleiad が Hook を渡すため取り込み（read_config_from）が全部止まる
  // （Hooks の旧「そろえる」から移った compat.devin: 'off'。core/hooks-agents.mjs の devinImportsStopped）。取り込む物は読まれないので鍵つきでオフ
  devin(kind, entryOrSummary, ctx) {
    // 旧「そろえる」の場所（legacyOwner: 'ply'）は、鍵のマスも Pleiad が渡す（resolveLegacyPlyDoc）ので、取り込みが止まっても届く
    const stopped = ctx?.devinImportsStopped && ctx?.legacyOwner !== 'ply';
    const imported = stopped ? { lockedOn: false, reason: 'devinHooks' } : { lockedOn: true, reason: 'bundled' };
    if (entryOrSummary === '__workspace__') return imported;
    const origins = entryOrigins(entryOrSummary).filter((o) => !o.custom && NATIVE_READERS.devin(kind, o));
    if (!origins.length) return null;
    const own = origins.filter((o) => isDevinOwnPath(o.path) || isDevinOwnPath(o.realPath) || (o.source === 'devin' && o.scope === 'user'));
    return own.length ? { lockedOn: true, reason: scopeLockReason(own) } : imported;
  },
  grok(kind, entryOrSummary) {
    if (entryOrSummary === '__workspace__') {
      return { lockedOn: true, reason: 'workspace' };
    }
    const matching = entryOrigins(entryOrSummary).filter((o) => !o.custom && NATIVE_READERS.grok(kind, o));
    if (matching.length) return { lockedOn: true, reason: scopeLockReason(matching) };
    return null;
  },
};

/**
 * Lock descriptor for an external instruction/skill cell `(agent, kind, entryOrSummary)`.
 * Returns null if user-toggleable, or `{ lockedOn: boolean, reason: 'own' | 'workspace' | 'relay' | 'bundled' | 'devinHooks' }`.
 * `ctx.legacyOwner` is the legacy owner ('native' | 'ply') of `kind` at the place (some locks depend on it).
 * `ctx.devinImportsStopped` is true when Devin's imports stop at the place because Pleiad supplies hooks to Devin.
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
  devin: { perFileInstructionExclude: false, perNameSkillList: false, relay: true, legacyPlyKeepsNative: true },
  grok: { perFileInstructionExclude: false, perNameSkillList: false, relay: true },
});

/**
 * 名前×エージェントの結果（core/context-doc-matrix.mjs の resolveDocForAgent）で、エージェントが自分で読む物を止めるか。
 * 旧い「Pleiad がそろえる」の場所を触った後（legacyPly）は、main と同じくまとめて止める
 */
export const docStopsNative = (doc) => Boolean(doc && !doc.untouchedNative && (doc.legacyPly || doc.suppress.length > 0));

/** Determine whether `ply_context` should expose `load_skill` / `instructions_for_path` for `agent`. */
export function docToolRequirements(agent, docs, conditionalCount = 0, instructionsCount = 0) {
  const traits = DOC_AGENT_TRAITS[agent] ?? {};
  const needLoadSkill = Boolean(docs?.skill && (docs.skill.legacyPly || docs.skill.deliver.length > 0));
  const needInstructionsForPath = Boolean(
    docs?.instruction
    && (docs.instruction.legacyPly
      || conditionalCount > 0
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
