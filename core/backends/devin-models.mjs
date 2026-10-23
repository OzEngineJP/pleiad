// The catalogue's variant ID is the user selection. ACP may represent a family with a
// different ID; only the measured SWE-2 mapping is translated here. Other IDs must
// match an advertised ACP choice exactly before a prompt can be sent.
// SWE-2 (Devin CLI 3000.11.92, 2026-10-23): ACP advertises only `swe-2-high` as the model,
// with thought_level medium/high/max and speed standard/fast. The CLI's model config cache
// gives swe-2-<level>-lightning the same "Reasoning Effort" as swe-2-<level> plus
// "Fast Mode" on, so a Lightning variant is swe-2-high + that thought level + speed fast.
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

const SWE_2 = /^swe-2-(medium|high|max)(-lightning)?$/;

/** The ACP model choice a catalogue ID needs (the SWE-2 variants share one). */
export const devinAcpModel = modelId => SWE_2.test(modelId) ? 'swe-2-high' : modelId;

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
  const [, sweThought, lightning] = SWE_2.exec(row.id) ?? [];
  const swe = (row.family.family_uid === 'swe-2' || row.family.slug === 'swe-2') && sweThought;
  if (sweThought && !swe) throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue');
  return {
    id: row.id, acpModel: swe ? 'swe-2-high' : row.id,
    ...(swe ? { thoughtLevel: sweThought } : {}), speed: swe && lightning ? 'fast' : 'standard',
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

// ACP select choices may contain arbitrarily nested groups (the groups have no value).
function choices(options) {
  if (!Array.isArray(options)) return [];
  return options.flatMap(option => Array.isArray(option?.options) ? choices(option.options) : (typeof option?.value === 'string' ? [option.value] : []));
}

/** Apply and acknowledge all requested settings, including after session/load. */
export async function applyDevinModel(call, sessionId, configOptions, selection) {
  if (!selection?.id || !selection.acpModel || !['standard', 'fast'].includes(selection.speed)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'model' });
  let latest = configOptions;
  const verified = new Map();
  for (const [kind, value] of [['model', selection.acpModel], ...(selection.thoughtLevel ? [['thought_level', selection.thoughtLevel]] : []), ['speed', selection.speed]]) {
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
    // An exact model ID alone cannot confirm an independent thought setting whose
    // relation to this catalogue variant is unknown.
    if (kind === 'model' && !selection.thoughtLevel && latest.some(o => o?.id === 'thought_level' || o?.category === 'thought_level')) {
      throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'thought_level' });
    }
  }
  return latest;
}
