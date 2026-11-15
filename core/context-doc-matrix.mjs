/**
 * Shared matrix builder and runtime resolution for external instructions and skills (ADR 0337).
 * Guarantees Settings UI, Right Panel, and runtime per-agent execution derive from the exact same rules.
 */
import os from 'node:os';
import path from 'node:path';
import { containsPath, pathKey } from './context-settings.mjs';
import {
  DOC_AGENT_IDS,
  DOC_AGENT_TRAITS,
  canRelayDocToAgent,
  devinFormatsForEntry,
  docCellLock,
  entryOrigins,
  isEntryNativeTo,
} from './backends/context-capabilities.mjs';
import {
  WORKSPACE_SUMMARY_KEY,
  docAgentsFromLegacy,
  docItemKey,
  evaluateDocCells,
  hasExplicitRule,
  legacyEntryIncluded,
  resolveEffectiveDocSource,
  resolveRuleForItem,
} from './context-agents.mjs';

function sameFile(a, b) {
  if (!a || !b) return false;
  return pathKey(a.realPath ?? a.path) === pathKey(b.realPath ?? b.path);
}

/** Merge duplicate scanned entries into logical rows keyed by `docItemKey`. */
export function groupDocEntries(kind, entries = [], preferMap = {}) {
  const byKey = new Map();
  for (const entry of entries) {
    if (!entry || entry.kind !== kind) continue;
    const key = docItemKey(entry);
    let group = byKey.get(key);
    if (!group) {
      group = { key, copies: [], origins: [] };
      byKey.set(key, group);
    }
    group.copies.push(entry);
    for (const o of entryOrigins(entry)) {
      if (!group.origins.some((x) => x.source === o.source && x.path === o.path && x.scope === o.scope)) {
        group.origins.push(o);
      }
    }
  }

  const items = [];
  for (const group of byKey.values()) {
    const preferredPath = kind === 'skill' ? preferMap?.[group.copies[0].name] : null;
    const chosen = (preferredPath
      ? group.copies.find((c) => pathKey(c.path) === pathKey(preferredPath) || pathKey(c.realPath ?? c.path) === pathKey(preferredPath))
      : null) ?? group.copies.find((c) => c.status === 'candidate') ?? group.copies[0];
    items.push({
      key: group.key,
      kind,
      id: chosen.id,
      name: chosen.name,
      path: chosen.path,
      realPath: chosen.realPath ?? chosen.path,
      scope: chosen.scope,
      appliesTo: chosen.appliesTo ?? null,
      conditional: chosen.conditional ?? null,
      chosen,
      copies: group.copies,
      origins: group.origins,
      duplicates: group.copies.length > 1 ? group.copies.slice() : [],
    });
  }
  return items;
}

function summarizeRowMeta(cells) {
  const unlocked = DOC_AGENT_IDS.filter((a) => !cells[a].locked);
  const unlockedOn = unlocked.filter((a) => cells[a].on);
  const anyLockedOn = DOC_AGENT_IDS.some((a) => cells[a].locked && cells[a].on);
  const rowLocked = unlocked.length === 0;
  const rowMixed = unlockedOn.length > 0 && unlockedOn.length < unlocked.length;
  const rowSwitchOn = unlocked.length > 0 ? unlockedOn.length > 0 : anyLockedOn;
  return { rowLocked, rowMixed, rowSwitchOn, anyOn: unlockedOn.length > 0 || anyLockedOn };
}

function mergeWorkspaceFallback(legacyBase, wsRule) {
  const off = new Set(legacyBase.off ?? []);
  for (const a of wsRule?.off ?? []) off.add(a);
  const spread = new Set((legacyBase.spread ?? []).filter((a) => !off.has(a)));
  for (const a of wsRule?.spread ?? []) {
    if (!off.has(a)) spread.add(a);
  }
  return {
    off: DOC_AGENT_IDS.filter((a) => off.has(a)),
    spread: DOC_AGENT_IDS.filter((a) => spread.has(a)),
  };
}

function buildSingleRow({ kind, entryOrSummary, key, scope, sourceState, home, cwd }) {
  const { touched, legacyRule, agentsChain } = sourceState;
  let rule;
  if (!touched) {
    rule = docAgentsFromLegacy(kind, entryOrSummary, legacyRule, { home, cwd });
  } else if ((scope === 'directory' || scope === 'workspace' || scope === 'local') && key !== WORKSPACE_SUMMARY_KEY && !hasExplicitRule(agentsChain, key) && legacyRule) {
    const legacyBase = docAgentsFromLegacy(kind, entryOrSummary, legacyRule, { home, cwd });
    const wsRule = resolveRuleForItem(agentsChain, key, scope);
    rule = mergeWorkspaceFallback(legacyBase, wsRule);
  } else {
    rule = resolveRuleForItem(agentsChain, key, scope);
  }
  const cells = evaluateDocCells(kind, entryOrSummary, rule);
  return { rule, cells, ...summarizeRowMeta(cells) };
}

/**
 * Build full UI + runtime matrix for `(kind, entries, legacyConfig, docAgentsConfig, cwd)`.
 * Notice `summaryRow` evaluates `'__workspace__'` so global Settings and inherited workspace items agree.
 */
export function buildDocMatrix({ kind, entries = [], legacyConfig, docAgentsConfig, cwd = null, home = os.homedir(), preferMap = null }) {
  const sourceState = resolveEffectiveDocSource(legacyConfig, docAgentsConfig, cwd, kind);
  const items = groupDocEntries(kind, entries, preferMap ?? sourceState.legacyRule?.prefer ?? legacyConfig?.prefer ?? {});

  const summaryEval = buildSingleRow({
    kind,
    entryOrSummary: WORKSPACE_SUMMARY_KEY,
    key: WORKSPACE_SUMMARY_KEY,
    scope: 'workspace',
    sourceState,
    home,
    cwd,
  });
  const summaryRow = {
    key: WORKSPACE_SUMMARY_KEY,
    kind,
    scope: 'workspace',
    ...summaryEval,
  };

  const rows = [];
  const byKey = new Map();
  for (const item of items) {
    // Check legacy inclusion across all copies for grouped skills when legacy rule is active.
    const itemForLegacy = item.copies.length > 1
      ? { ...item.chosen, origins: item.origins }
      : item.chosen;
    const evalInput = itemForLegacy;
    const evaluated = !sourceState.touched && item.copies.length > 1
      ? buildGroupedLegacyRow(kind, item, sourceState.legacyRule, home, cwd)
      : buildSingleRow({
          kind,
          entryOrSummary: evalInput,
          key: item.key,
          scope: item.scope,
          sourceState,
          home,
          cwd,
        });

    const row = {
      ...item,
      ...evaluated,
    };
    rows.push(row);
    byKey.set(row.key, row);
  }

  return {
    kind,
    touched: sourceState.touched,
    agentsPlace: sourceState.agentsPlace,
    legacyPlace: sourceState.legacyPlace,
    legacyDepth: sourceState.legacyDepth,
    agentsDepth: sourceState.agentsDepth,
    legacyRule: sourceState.legacyRule,
    legacyOwner: sourceState.legacyRule?.owner ?? 'native',
    agents: [...DOC_AGENT_IDS],
    summaryRow,
    rows,
    byKey,
  };
}

function buildGroupedLegacyRow(kind, item, legacyRule, home, cwd) {
  const combined = { ...item.chosen, origins: item.origins };
  const included = item.copies.some((c) => legacyEntryIncluded(kind, c, legacyRule, { home, cwd }));
  let rule;
  if (!included) {
    const off = DOC_AGENT_IDS.filter((a) => !docCellLock(a, kind, combined));
    rule = { off, spread: [] };
  } else {
    rule = docAgentsFromLegacy(kind, combined, legacyRule, { home, cwd });
  }
  const cells = evaluateDocCells(kind, combined, rule);
  return { rule, cells, ...summarizeRowMeta(cells) };
}

function sameRule(a, b) {
  if (!a || !b) return false;
  const sort = (xs) => [...(xs ?? [])].sort().join(',');
  return sort(a.off) === sort(b.off) && sort(a.spread) === sort(b.spread);
}

/**
 * Snapshot writable `{ [key]: { off, spread } }` baseline for `(placeOrDefault, kind)` on first edit.
 * Preserves pre-edit effective behavior for all items at that place before applying the requested toggle.
 */
export function snapshotBaselineAgents({ kind, entries = [], legacyConfig, docAgentsConfig, place = null, home = os.homedir() }) {
  const cwd = place ?? null;
  const matrix = buildDocMatrix({ kind, entries, legacyConfig, docAgentsConfig, cwd, home });
  // When Stage 2 already governs this place via defaults or an ancestor override, start with an empty per-place override map so untouched keys keep inheriting dynamically.
  if (place && matrix.touched) return {};
  const parentDir = place && path.dirname(place) !== place ? path.dirname(place) : null;
  const parentMatrix = place
    ? buildDocMatrix({ kind, entries, legacyConfig, docAgentsConfig, cwd: parentDir, home })
    : null;
  const out = {};
  if (!place || !matrix.touched) {
    out[WORKSPACE_SUMMARY_KEY] = { ...matrix.summaryRow.rule };
  }
  for (const row of matrix.rows) {
    if (!place && row.scope !== 'user') continue;
    if (place && row.scope === 'user') {
      const parentRule = parentMatrix?.byKey.get(row.key)?.rule;
      if (!parentRule || sameRule(row.rule, parentRule)) continue;
    }
    out[row.key] = { ...row.rule };
  }
  return out;
}

/**
 * Resolve per-agent runtime actions for `(kind, agent)`:
 * - `untouchedNative`: true when nothing differs from the agent's native loading (keep exact legacy launch)
 * - `active`: logical items active for `agent` (carrying `chosen`, `cells[agent]`)
 * - `nativeKeep`: entries kept natively by `agent` without suppression
 * - `suppress`: native copies/paths that must be stopped on `agent`
 * - `deliver`: entries that Pleiad must deliver via system injection / ply_context
 * - `devinDisableFormats`: Devin `read_config_from` keys that must be set to false
 */
export function resolveDocForAgent({ kind, agent, entries = [], legacyConfig, docAgentsConfig, cwd = null, home = os.homedir(), forceCoarseDeliver = false }) {
  const matrix = buildDocMatrix({ kind, entries, legacyConfig, docAgentsConfig, cwd, home });

  // Strict zero-change guarantee before Stage 2 touches this place/kind and legacy owner is native.
  if (!matrix.touched && matrix.legacyOwner === 'native') {
    const active = [];
    for (const row of matrix.rows) {
      if (row.cells[agent]?.on) {
        active.push({ row, entry: row.chosen, mode: row.cells[agent].mode });
      }
    }
    return {
      matrix,
      agent,
      untouchedNative: true,
      hasWork: false,
      spreadSummary: false,
      active,
      nativeKeep: active.map((a) => a.entry),
      suppress: [],
      deliver: [],
      devinDisableFormats: [],
    };
  }

  const traits = DOC_AGENT_TRAITS[agent] ?? {};
  const active = [];
  const desiredSuppress = [];
  const desiredDeliver = [];
  const nativeKept = [];

  for (const row of matrix.rows) {
    const cell = row.cells[agent];
    const nativeCopies = row.copies.filter((c) => isEntryNativeTo(agent, kind, c));
    if (!cell?.on) {
      // Turned off (only stoppable copies get added; locked cells always remain cell.on === true unless relay-locked off).
      if (nativeCopies.length && !cell?.locked) {
        desiredSuppress.push(...nativeCopies);
      }
      continue;
    }

    active.push({ row, entry: row.chosen, mode: cell.mode });

    const chosenIsNative = isEntryNativeTo(agent, kind, row.chosen);
    const conflictingCopies = nativeCopies.filter((c) => !sameFile(c, row.chosen));

    if (chosenIsNative && conflictingCopies.length === 0) {
      nativeKept.push({ row, entry: row.chosen });
    } else if (chosenIsNative && conflictingCopies.length > 0) {
      // Prefer matches a native copy, but other conflicting native copies must be suppressed if stoppable.
      nativeKept.push({ row, entry: row.chosen });
      for (const c of conflictingCopies) {
        if (!docCellLock(agent, kind, c)) desiredSuppress.push(c);
      }
    } else {
      // Chosen file is NOT natively read by this agent. Suppress any shadowing native copy and deliver chosen.
      let allShadowStopped = true;
      for (const c of nativeCopies) {
        if (docCellLock(agent, kind, c)) {
          allShadowStopped = false;
        } else {
          desiredSuppress.push(c);
        }
      }
      if (canRelayDocToAgent(agent) && (nativeCopies.length === 0 || allShadowStopped)) {
        desiredDeliver.push(row.chosen);
      }
    }
  }

  // Handle coarse/group suppression fallout cleanly:
  // If agent stops all-at-once (no perFileInstructionExclude / perNameSkillList), suppressing ANY item
  // forces kept native items into `deliver`. For Devin, disabling a read_config_from format forces
  // kept items in that format into `deliver`.
  let nativeKeep = nativeKept.map((x) => x.entry);
  const deliver = [...desiredDeliver];
  const devinDisableFormats = new Set();

  if (traits.readConfigFrom) {
    for (const s of desiredSuppress) {
      for (const fmt of devinFormatsForEntry(kind, s)) devinDisableFormats.add(fmt);
    }
    if (devinDisableFormats.size > 0) {
      nativeKeep = [];
      for (const { entry } of nativeKept) {
        const fmts = devinFormatsForEntry(kind, entry);
        if (fmts.some((f) => devinDisableFormats.has(f))) {
          deliver.push(entry);
        } else {
          nativeKeep.push(entry);
        }
      }
    }
  } else {
    const canFilterIndividually = kind === 'instruction'
      ? traits.perFileInstructionExclude
      : (traits.perNameSkillList || traits.perPathSkillDisable);
    if (!canFilterIndividually && (desiredSuppress.length > 0 || forceCoarseDeliver)) {
      // Coarse stop suppresses ALL stoppable native items; keep unstoppable native items (`locked: 'own'/'workspace'`),
      // and re-deliver every stoppable nativeKeep item via Pleiad.
      nativeKeep = [];
      for (const { row, entry } of nativeKept) {
        if (docCellLock(agent, kind, entry)?.lockedOn) {
          nativeKeep.push(entry);
        } else {
          deliver.push(entry);
        }
      }
    }
  }

  // If `perNameSkillList` (Claude `skills: [keptNames]`): if any kept skill came from a non-native source or `deliver`
  // overlaps native suppression (Wait: Claude can pass BOTH `skills: ['native-skill']` AND `ply_context.load_skill` for spread skills!
  // EXCEPT if a native skill conflicts by name with a non-native chosen `prefer` skill — wait: omitting that name from `skills: [...]`
  // stops ONLY that shadowed native skill while keeping other native skills native!).
  const spreadSummary = Boolean(
    kind === 'instruction'
    && canRelayDocToAgent(agent)
    && matrix.summaryRow.rule?.spread?.includes(agent)
    && !matrix.summaryRow.rule?.off?.includes(agent)
    && !docCellLock(agent, kind, WORKSPACE_SUMMARY_KEY),
  );
  const untouchedNative = desiredSuppress.length === 0 && deliver.length === 0 && devinDisableFormats.size === 0 && !spreadSummary;
  return {
    matrix,
    agent,
    untouchedNative,
    hasWork: !untouchedNative && (desiredSuppress.length > 0 || deliver.length > 0 || spreadSummary),
    spreadSummary,
    active,
    nativeKeep,
    suppress: desiredSuppress,
    deliver,
    devinDisableFormats: [...devinDisableFormats],
  };
}

/** Utility: resolve entries scoped cleanly for `cwd` check (matches containsPath for place deletion/queries). */
export function isPlaceRelevantToCwd(placeKey, cwd) {
  return Boolean(placeKey && cwd && containsPath(placeKey, cwd));
}
