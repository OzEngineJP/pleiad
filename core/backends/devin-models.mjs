// The catalogue's variant ID is the user selection. ACP exposes one representative
// `model` choice per variant family plus separate `thought_level` and `speed` axes
// whose availability and choices change with the selected model (Devin CLI
// 3000.11.92, 2026-10-24). A variant uid decomposes into a family base plus an
// optional thought-level suffix and speed suffixes (-fast / -lightning = speed
// fast; -priority has no ACP axis). The representative is the same-base family
// variant advertised as a `model` choice; sibling variants become representative
// + thought_level + speed. Setting model also resets thought_level to the
// representative's own suffix. Anything ACP cannot express is refused rather
// than run as a different model.
import { t } from '../i18n.mjs';

// i18n-dynamic: devin.errors.invalidCatalogue
// i18n-dynamic: devin.errors.modelUnavailable
// i18n-dynamic: devin.errors.explicitModelRequired
// i18n-dynamic: devin.errors.selectionUnavailable
// i18n-dynamic: devin.errors.selectionNotAcknowledged
function fail(code, key, values = {}) {
  return Object.assign(new Error(t(`devin.errors.${key}`, values)), { code });
}

function catalogueRows(raw) {
  if (raw?.data && Object.hasOwn(raw.data, 'families')) throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue');
  const families = raw?.families;
  if (!Array.isArray(families)) throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue');
  const seen = new Set(), rows = [];
  for (const family of families) {
    if (!Array.isArray(family?.variants)) throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue');
    for (const variant of family.variants) {
      const id = variant?.model_uid;
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue');
      seen.add(id);
      rows.push({ family, variant, id });
    }
  }
  return rows;
}

const FREE_FLAGS = new Set(['free', 'isFree', 'is_free']);
const EXPIRY = new Set(['freeUntil', 'free_until']);

/** Free is an exact live tier, with no conflicting free flag, price or expiry. */
function freeProof({ variant: row }) {
  if (row.cost_tier !== 'Free') return false;
  function clean(object, pricing = false) {
    return Object.entries(object).every(([key, value]) => {
      if (FREE_FLAGS.has(key)) return value == null || value === true;
      if (EXPIRY.has(key)) return value == null || (typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now());
      if (key === 'cost_tier') return value === 'Free';
      const charge = pricing || /pric|cost|credit|multiplier/i.test(key);
      if (value && typeof value === 'object') return clean(value, charge);
      if (!charge || value == null) return true;
      if (typeof value === 'string' && value.trim() === 'Free') return true;
      return ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) === 0;
    });
  }
  return clean(row);
}

function liveFree(row) {
  return freeProof(row) && !/^(adaptive|fusion)(?:$|[-_])/i.test(row.id)
    && !/^(adaptive|fusion)(?:$|[-_])/i.test(row.family.slug ?? row.family.family_uid ?? '');
}

const LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const FAST = new Set(['fast', 'lightning']);
const NO_AXIS = new Set(['priority']);

/**
 * Split a variant uid into the family base, an optional thought level and speed.
 * Fusion uids carry the driver's level/speed before `-sidekick-`; the sidekick
 * stays part of the base. Unmappable shapes (a second level, -priority) are
 * marked so the caller can refuse them instead of guessing.
 */
function parseDevinUid(uid) {
  const at = String(uid).indexOf('-sidekick-');
  const rest = [];
  const parsed = { level: null, speed: 'standard', unmappable: false };
  for (const token of (at < 0 ? String(uid) : String(uid).slice(0, at)).split('-')) {
    if (LEVELS.has(token)) { if (parsed.level) parsed.unmappable = true; else parsed.level = token; }
    else if (FAST.has(token)) parsed.speed = 'fast';
    else if (NO_AXIS.has(token)) parsed.unmappable = true;
    else rest.push(token);
  }
  return { ...parsed, base: rest.join('-') + (at < 0 ? '' : String(uid).slice(at)) };
}

/** The ACP model choice a catalogue ID needs, or null when it cannot be expressed. */
export function devinAcpModel(modelId, acpChoices) {
  if (typeof modelId !== 'string' || !Array.isArray(acpChoices)) return null;
  const target = parseDevinUid(modelId);
  if (target.unmappable) return null;
  const reps = acpChoices.filter(choice => parseDevinUid(choice).base === target.base);
  return reps.length === 1 ? reps[0] : null;
}

/** Model choices advertised in ACP configOptions, or null when they are not there. */
export function devinModelChoices(configOptions) {
  const model = Array.isArray(configOptions) ? configOptions.filter(o => o?.id === 'model' || o?.category === 'model') : [];
  return model.length === 1 && Array.isArray(model[0].options) ? choices(model[0].options) : null;
}

const defaultRow = rows => rows.find(row => row.id === 'swe-2-high' && liveFree(row)) ?? rows.find(liveFree) ?? null;

/** Native backend models map. Labels and prices come only from this catalogue. */
export function buildDevinModels(rawCatalogue) {
  const rows = catalogueRows(rawCatalogue), preferred = defaultRow(rows);
  const result = { '': { label: t('models.default'), note: preferred?.variant.label ?? (preferred ? preferred.id : t('devin.errors.explicitModelRequired')),
    ...(preferred ? { resolvesTo: preferred.id } : {}), efforts: [], defaultEffort: null } };
  for (const { id, family, variant } of rows) {
    Object.defineProperty(result, id, { enumerable: true, configurable: true, writable: true, value: {
      label: typeof variant.label === 'string' && variant.label ? variant.label : id,
      note: [family.family_label, variant.cost_tier, variant.cost_summary].filter(v => typeof v === 'string' && v).join(' · '),
      efforts: [], defaultEffort: null,
    } });
  }
  return result;
}

/** Resolve a new or resumed turn using the current catalogue, never a paid default. */
export function resolveDevinModel(rawCatalogue, modelId = '') {
  const rows = catalogueRows(rawCatalogue);
  if (typeof modelId !== 'string') throw fail('DEVIN_MODEL_UNAVAILABLE', 'modelUnavailable', { model: String(modelId) });
  const row = modelId ? rows.find(row => row.id === modelId) : defaultRow(rows);
  if (!row) throw modelId ? fail('DEVIN_MODEL_UNAVAILABLE', 'modelUnavailable', { model: modelId }) : fail('DEVIN_MODEL_EXPLICIT_REQUIRED', 'explicitModelRequired');
  if (row.variant.cost_tier === 'Free' && !freeProof(row)) throw fail('DEVIN_MODEL_UNAVAILABLE', 'modelUnavailable', { model: row.id });
  const parsed = parseDevinUid(row.id);
  return {
    id: row.id, base: parsed.base, level: parsed.level, speed: parsed.speed, unmappable: parsed.unmappable,
    family: rows.filter(r => r.family === row.family).map(r => ({ id: r.id, ...parseDevinUid(r.id) })),
    free: liveFree(row), label: row.variant.label ?? row.id,
    maxContextTokens: Number.isFinite(row.variant.max_context_tokens) && row.variant.max_context_tokens > 0 ? row.variant.max_context_tokens : null,
  };
}

function setting(options, kind) {
  if (!Array.isArray(options)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  const matches = options.filter(option => option?.id === kind || option?.category === kind);
  if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  return matches[0];
}

/** An axis the CLI may omit for some models. Absent is null; duplicated is unreadable. */
function optionalSetting(options, kind) {
  if (!Array.isArray(options)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  const matches = options.filter(option => option?.id === kind || option?.category === kind);
  if (matches.length > 1 || (matches.length === 1 && (typeof matches[0].id !== 'string' || !matches[0].id))) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  return matches[0] ?? null;
}

// ACP select choices may contain arbitrarily nested groups (the groups have no value).
function choices(options) {
  if (!Array.isArray(options)) return [];
  return options.flatMap(option => Array.isArray(option?.options) ? choices(option.options) : (typeof option?.value === 'string' ? [option.value] : []));
}

/**
 * The level a suffix-less non-representative variant needs: the single
 * thought_level choice no same-base family variant claims, or null when the
 * remaining choices do not pin down exactly one (nothing is guessed).
 */
function impliedLevel(selection, levelChoices) {
  const claimed = new Set(selection.family.filter(v => v.base === selection.base && v.level).map(v => v.level));
  const left = levelChoices.filter(choice => !claimed.has(choice));
  return left.length === 1 ? left[0] : null;
}

/** Apply and acknowledge all requested settings, including after session/load. */
export async function applyDevinModel(call, sessionId, configOptions, selection) {
  if (!selection?.id || !selection.base || !Array.isArray(selection.family) || selection.unmappable) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'model' });
  let latest = configOptions;
  const verified = new Map();
  const send = async (kind, value) => {
    const option = setting(latest, kind);
    if (choices(option.options).filter(choice => choice === value).length !== 1) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
    const result = await call('session/set_config_option', { sessionId, configId: option.id, value });
    latest = result?.configOptions;
    verified.set(kind, { id: option.id, value });
    for (const [checkKind, expected] of verified) {
      let actual;
      try { actual = setting(latest, checkKind); } catch { throw fail('DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED', 'selectionNotAcknowledged', { setting: checkKind }); }
      if (actual.id !== expected.id || actual.currentValue !== expected.value) throw fail('DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED', 'selectionNotAcknowledged', { setting: checkKind });
    }
  };
  // The representative is the same-base family variant ACP advertises as a model.
  const modelChoices = choices(setting(latest, 'model').options);
  const reps = modelChoices.includes(selection.id) ? [selection.id]
    : selection.family.filter(variant => variant.base === selection.base && !variant.unmappable && modelChoices.includes(variant.id)).map(variant => variant.id);
  if (reps.length !== 1) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'model' });
  const rep = reps[0];
  await send('model', rep);

  // thought_level exists only for some models; the choices also depend on the model.
  const thought = optionalSetting(latest, 'thought_level');
  if (thought) {
    if (selection.id === rep && selection.level === null) {
      // A representative without a level suffix needs no thought setting: the
      // model choice alone is the variant, so the CLI-derived level is recorded.
      if (!choices(thought.options).includes(thought.currentValue)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'thought_level' });
      verified.set('thought_level', { id: thought.id, value: thought.currentValue });
    } else {
      const level = selection.level ?? impliedLevel(selection, choices(thought.options));
      if (level === null) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'thought_level' });
      await send('thought_level', level);
    }
  } else if (selection.id !== rep) {
    // A non-representative variant cannot be told apart from its representative
    // when the model exposes no thought axis.
    throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'thought_level' });
  }

  const speedOption = optionalSetting(latest, 'speed');
  if (speedOption) await send('speed', selection.speed);
  else if (selection.speed !== 'standard') throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'speed' });
  return { configOptions: latest, verified };
}
