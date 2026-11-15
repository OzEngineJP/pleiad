/**
 * Shared matrix builder and runtime resolution for external instructions and skills (ADR 0337).
 * Guarantees Settings UI, Right Panel, and runtime per-agent execution derive from the exact same rules.
 */
import os from 'node:os';
import { SOURCES, containsPath, pathKey } from './context-settings.mjs';
import {
  DOC_AGENT_IDS,
  DOC_AGENT_TRAITS,
  canRelayDocToAgent,
  devinFormatsForEntry,
  docCellLock,
  entryOrigins,
  isEntryNativeTo,
  mayReadNatively,
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
  setDocRowRule,
  toggleDocAgentRule,
} from './context-agents.mjs';

/**
 * 設定の表（名前 × エージェント）を作るための探索の計画。どのエージェントの分も並べるため、形式は全部・除外は無しで探し、
 * 探す場所（roots）と Skills の設定だけ今の保存（effectivePlan。core/context-settings.mjs の get の plan）から取る。
 * core/server.mjs の docScanContext と試験（tests/unit/context-doc-main-equivalence.mjs）が同じ関数を使う
 */
export function docScanPlan(effectivePlan, kind) {
  return {
    user: { kinds: { [kind]: { sources: [...SOURCES], excludePaths: [] } }, roots: effectivePlan.user.roots },
    directory: { kinds: { [kind]: { sources: [...SOURCES], excludePaths: [] } }, roots: effectivePlan.directory.roots },
    ...(kind === 'skill' ? { skill: effectivePlan.skill } : {}),
  };
}

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
  const cells = evaluateDocCells(kind, entryOrSummary, rule, { legacyOwner: legacyRule?.owner ?? 'native' });
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
  const rule = docAgentsFromLegacy(kind, combined, legacyRule, { home, cwd, included });
  const cells = evaluateDocCells(kind, combined, rule, { legacyOwner: legacyRule?.owner ?? 'native' });
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
  // 場所の上書きを作った後に、この場所が上の段から引き継ぐ表（この場所の自分の段は除く）
  const placeKey = place ? pathKey(place) : null;
  const above = place
    ? resolveEffectiveDocSource(legacyConfig, docAgentsConfig, place, kind).agentsChain.filter((level) => level.place !== placeKey)
    : null;
  const out = {};
  if (!place || !matrix.touched) {
    out[WORKSPACE_SUMMARY_KEY] = { ...matrix.summaryRow.rule };
  }
  for (const row of matrix.rows) {
    if (!place && row.scope !== 'user') continue;
    // ユーザーの物は、上の段に同じ規則があれば写さずに引き継ぐ。上の段に規則が無い名前は、上書きを作ると「自分の物だけ読む」になるので、
    // 触る前の動き（旧「Pleiad がそろえる」の広げ方など）と違えば写す
    if (place && row.scope === 'user' && sameRule(row.rule, resolveRuleForItem(above, row.key, row.scope))) continue;
    out[row.key] = { ...row.rule };
  }
  return out;
}

/** applyDocTouch が押せない物を押されたときの誤り。code は locales の context.settings.<code> */
export class DocTouchError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

/**
 * 表のスイッチ 1 回分（設定のマス = setDocAgent、行のスイッチ = setDocRow）を cfg（context-agents.json の中身）に書く。
 * 初めて触れる場所（か旧い保存の方が深い場所）は、触る前の動きを写した基準を先に書いてから変える。
 * agent があれば keys[0] の 1 マス、無ければ keys の行ごと。core/server.mjs と試験（tests/unit/context-doc-main-equivalence.mjs）が同じ関数を使う
 */
export function applyDocTouch(cfg, { kind, entries = [], legacyConfig, matrixCwd = null, home = os.homedir(), place = null, placeKey = null, agent = null, keys, on }) {
  const matrix = buildDocMatrix({ kind, entries, legacyConfig, docAgentsConfig: cfg, cwd: matrixCwd, home });
  if (agent && !matrix.agents.includes(agent)) throw new DocTouchError('unknownAgent', { agent });
  const targets = keys.map((k) => {
    const row = k === WORKSPACE_SUMMARY_KEY ? matrix.summaryRow : matrix.byKey.get(k);
    if (!row) throw new DocTouchError('unknownDocItem', { key: k });
    return { k, row };
  });
  let pressable;
  if (agent) {
    pressable = targets.slice(0, 1);
    const { k, row } = pressable[0];
    const cell = row.cells[agent];
    if (!cell || cell.locked) throw new DocTouchError('docNotPressable', { name: row.name ?? k, agent });
  } else {
    pressable = targets.filter((tRow) => !tRow.row.rowLocked);
    if (!pressable.length) throw new DocTouchError('docRowLocked', { name: targets[0].row.name ?? targets[0].row.key });
  }
  // 場所の行を「使う」に戻すときは、全エージェントをオンにせず、この場所の上書きが無いときの動き（全体の表・旧い保存）に戻す。
  // main の右パネルで除外を外したときと同じ（外す前の担当の渡し方に戻る）。戻した先が全部オフのときだけ、全エージェントをオンにする
  let restore = null;
  if (!agent && placeKey && on) {
    const without = structuredClone(cfg);
    if (without.places[placeKey]) delete without.places[placeKey][kind];
    restore = buildDocMatrix({ kind, entries, legacyConfig, docAgentsConfig: without, cwd: matrixCwd, home });
  }
  const holder = placeKey ? (cfg.places[placeKey] ??= {}) : cfg.defaults;
  if (!holder[kind] || (!matrix.touched && matrix.agentsDepth < matrix.legacyDepth)) {
    holder[kind] = { agents: snapshotBaselineAgents({ kind, entries, legacyConfig, docAgentsConfig: cfg, place, home }) };
  }
  for (const { k, row } of pressable) {
    const entryOrSummary = k === WORKSPACE_SUMMARY_KEY ? WORKSPACE_SUMMARY_KEY : { ...row.chosen, origins: row.origins };
    const inherited = restore ? (k === WORKSPACE_SUMMARY_KEY ? restore.summaryRow : restore.byKey.get(k)) : null;
    if (inherited?.rowSwitchOn && !inherited.rowLocked) {
      holder[kind].agents[k] = { off: [...(inherited.rule.off ?? [])], spread: [...(inherited.rule.spread ?? [])] };
      continue;
    }
    const curRule = holder[kind].agents[k] ?? row.rule;
    holder[kind].agents[k] = agent
      ? toggleDocAgentRule(kind, entryOrSummary, curRule, agent, Boolean(on), { legacyOwner: matrix.legacyOwner })
      : setDocRowRule(kind, entryOrSummary, curRule, Boolean(on), { legacyOwner: matrix.legacyOwner });
  }
  return cfg;
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
  const lockCtx = { legacyOwner: matrix.legacyOwner };
  const active = [];
  const desiredSuppress = [];
  const desiredDeliver = [];
  const nativeKept = [];
  // 既定では読まないが、ほかの物を外すと読み始める物（Claude の AGENTS.md は、横の CLAUDE.md を外すと読む）。何かを外すときだけ一緒に外す
  const latentOff = [];

  for (const row of matrix.rows) {
    const cell = row.cells[agent];
    const nativeCopies = row.copies.filter((c) => isEntryNativeTo(agent, kind, c));
    if (!cell?.on) {
      // Turned off (only stoppable copies get added; locked cells always remain cell.on === true unless relay-locked off).
      if (nativeCopies.length && !cell?.locked) {
        desiredSuppress.push(...nativeCopies);
      }
      if (!cell?.locked) latentOff.push(...row.copies.filter((c) => !nativeCopies.includes(c) && mayReadNatively(agent, kind, c)));
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
        if (!docCellLock(agent, kind, c, lockCtx)) desiredSuppress.push(c);
      }
    } else {
      // Chosen file is NOT natively read by this agent. Suppress any shadowing native copy and deliver chosen.
      let allShadowStopped = true;
      // Pleiad が渡すときは、ほかの物を外したときに自分でも読み始める写しも外す（二重に入らないように）
      for (const c of row.copies.filter((x) => mayReadNatively(agent, kind, x))) {
        if (docCellLock(agent, kind, c, lockCtx)) {
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

  if (desiredSuppress.length > 0) desiredSuppress.push(...latentOff);

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
        if (docCellLock(agent, kind, entry, lockCtx)?.lockedOn) {
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
    && !docCellLock(agent, kind, WORKSPACE_SUMMARY_KEY, lockCtx),
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

/**
 * Devin の read_config_from は、形式ごとに指示と Skills をまとめて止める（core/backends/devin-config.mjs）。
 * 片方の種類で形式を止めると、もう片方の種類でその形式から自分で読んでいた物も読まなくなるので、残す物（nativeKeep）のうち
 * 止める形式に入る物を Pleiad から渡し直す（deliver）。docs は { instruction, skill } で、解いていない種類は null のまま返す
 */
export function coupleDevinFormats(docs) {
  const disabled = new Set([...(docs?.instruction?.devinDisableFormats ?? []), ...(docs?.skill?.devinDisableFormats ?? [])]);
  if (!disabled.size) return docs;
  const out = { ...docs };
  for (const kind of ['instruction', 'skill']) {
    const res = docs[kind];
    if (!res) continue;
    const keep = [];
    const moved = [];
    for (const entry of res.nativeKeep) (devinFormatsForEntry(kind, entry).some((f) => disabled.has(f)) ? moved : keep).push(entry);
    if (!moved.length) continue;
    out[kind] = { ...res, nativeKeep: keep, deliver: [...res.deliver, ...moved], untouchedNative: false, hasWork: true };
  }
  return out;
}

/** Utility: resolve entries scoped cleanly for `cwd` check (matches containsPath for place deletion/queries). */
export function isPlaceRelevantToCwd(placeKey, cwd) {
  return Boolean(placeKey && cwd && containsPath(placeKey, cwd));
}
