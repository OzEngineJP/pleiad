// Devin のモデルと思考の強さは、Devin CLI の ACP が出す選択肢（configOptions）だけに従う（ADR 0356）。
// - モデルの一覧は `model` の選択肢（値・表示名）。Pleiad は名前を読み替えない・分解しない。
// - 思考の強さは `thought_level` の選択肢。選んだモデルで有無と選択肢が変わり、model を切り替えると
//   そのモデルの既定の段に戻る（3000.14.30821 で確認）。Pleiad の共通の「思考の強さ」の軸に載せる。
// - `speed`（category は model_config）はモデルで有無と値の組が変わり、共通の軸に合わないので触らない。
// 選択肢に無い名前・段は送らずに断る（kind: 'model' の失敗として扱わせる印 rejected を付ける）。
import { t } from '../i18n.mjs';

// i18n-dynamic: devin.errors.invalidCatalogue
// i18n-dynamic: devin.errors.modelUnavailable
// i18n-dynamic: devin.errors.effortUnavailable
// i18n-dynamic: devin.errors.selectionUnavailable
// i18n-dynamic: devin.errors.selectionNotAcknowledged
function fail(code, key, values = {}, extra = {}) {
  return Object.assign(new Error(t(`devin.errors.${key}`, values)), { code, ...extra });
}

/** One setting by id or category. Missing or duplicated is unreadable. */
function setting(options, kind) {
  if (!Array.isArray(options)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  const matches = options.filter(option => option?.id === kind || option?.category === kind);
  if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  return matches[0];
}

/** An axis the CLI omits for some models. Absent is null; duplicated is unreadable. */
function optionalSetting(options, kind) {
  if (!Array.isArray(options)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  const matches = options.filter(option => option?.id === kind || option?.category === kind);
  if (matches.length > 1 || (matches.length === 1 && (typeof matches[0].id !== 'string' || !matches[0].id))) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: kind });
  return matches[0] ?? null;
}

// ACP select choices may contain arbitrarily nested groups (the groups have no value).
function entries(options) {
  if (!Array.isArray(options)) return [];
  return options.flatMap(option => Array.isArray(option?.options) ? entries(option.options)
    : (typeof option?.value === 'string' && option.value ? [option] : []));
}
const choices = options => entries(options).map(option => option.value);

/** Model choices advertised in ACP configOptions, or null when they are not there. */
export function devinModelChoices(configOptions) {
  try { return choices(setting(configOptions, 'model').options); } catch { return null; }
}

/** The thought_level choices and the current value (the model's default right after a model switch). null = the model has none. */
export function devinThought(configOptions) {
  const thought = optionalSetting(configOptions, 'thought_level');
  if (!thought) return { efforts: [], defaultEffort: null };
  const values = [...new Set(choices(thought.options))];
  return { efforts: values, defaultEffort: values.includes(thought.currentValue) ? thought.currentValue : null };
}

/**
 * The model list read from a metadata session's configOptions: [{ id, label, images }] and the
 * current (default) model. Throws when the CLI advertised no readable `model` choice.
 */
export function readDevinList(configOptions) {
  let model;
  try { model = setting(configOptions, 'model'); } catch { throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue'); }
  const seen = new Set(), list = [];
  for (const option of entries(model.options)) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    list.push({ id: option.value, label: typeof option.name === 'string' && option.name.trim() ? option.name : option.value,
      images: option._meta?.['cognition.ai/supportsImages'] === true });
  }
  if (!list.length) throw fail('DEVIN_CATALOGUE_INVALID', 'invalidCatalogue');
  return { models: list, current: seen.has(model.currentValue) ? model.currentValue : null };
}

/**
 * Native backend models map. efforts は読み終えたモデルの思考の強さ（Map: id → { efforts, defaultEffort }）。
 * まだ読んでいないモデルは efforts を持たず（強さは選べない扱い）、読んでいる途中であることを理由に載せる。
 */
export function buildDevinModels(list, efforts = new Map(), { probing = false } = {}) {
  const known = id => efforts.get(id) ?? null;
  const shape = id => {
    const entry = known(id);
    if (entry) return { efforts: entry.efforts, defaultEffort: entry.defaultEffort };
    return probing ? { effortReason: t('devin.effortProbing') } : {};
  };
  const current = list.current ? list.models.find(m => m.id === list.current) : null;
  const result = { '': { label: t('models.default'), note: current?.label ?? '', ...(current ? { resolvesTo: current.id, ...shape(current.id) } : {}) } };
  for (const { id, label } of list.models) {
    Object.defineProperty(result, id, { enumerable: true, configurable: true, writable: true, value: { label, note: label === id ? '' : id, ...shape(id) } });
  }
  return result;
}

/**
 * 選んだモデルと思考の強さを ACP で設定し、応答の currentValue で確かめる（再開した会話でも）。
 *   model  … '' なら送らない（Devin の既定・会話のモデルのまま）。選択肢に無ければ送らずに断る
 *   effort … '' なら送らない（モデルの既定の段のまま）。そのモデルの選択肢に無ければ送らずに断る
 * onModel(model, configOptions) はモデルを切り替えた直後の応答（段はそのモデルの既定）を渡す口（一覧の強さを学ぶ）。
 * 返り値: { configOptions, verified: Map(kind → { id, value }), model, effort }
 */
export async function applyDevinSelection(call, sessionId, configOptions, { model = '', effort = '' } = {}, { onModel } = {}) {
  let latest = configOptions;
  const verified = new Map();
  const check = () => {
    for (const [kind, expected] of verified) {
      let actual;
      try { actual = setting(latest, kind); } catch { throw fail('DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED', 'selectionNotAcknowledged', { setting: kind }); }
      if (actual.id !== expected.id || actual.currentValue !== expected.value) throw fail('DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED', 'selectionNotAcknowledged', { setting: kind });
    }
  };
  const send = async (option, kind, value) => {
    const result = await call('session/set_config_option', { sessionId, configId: option.id, value });
    latest = result?.configOptions;
    verified.set(kind, { id: option.id, value });
    check();
  };
  const modelOption = setting(latest, 'model');
  if (model) {
    if (!choices(modelOption.options).includes(model)) throw fail('DEVIN_MODEL_UNAVAILABLE', 'modelUnavailable', { model }, { rejected: 'model' });
    await send(modelOption, 'model', model);
    onModel?.(model, latest);
  } else {
    if (typeof modelOption.currentValue !== 'string' || !modelOption.currentValue) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'model' });
    verified.set('model', { id: modelOption.id, value: modelOption.currentValue });
  }
  const current = verified.get('model').value;
  const thought = optionalSetting(latest, 'thought_level');
  if (effort) {
    if (!thought || !choices(thought.options).includes(effort)) throw fail('DEVIN_EFFORT_UNAVAILABLE', 'effortUnavailable', { effort, model: current }, { rejected: 'thought_level' });
    await send(thought, 'thought_level', effort);
  } else if (thought) {
    // 段を選ばないときは、CLI の今の段（モデルの既定）を確かめた値として覚える（実行中に変われば止める）
    if (!choices(thought.options).includes(thought.currentValue)) throw fail('DEVIN_MODEL_CONFIG_UNAVAILABLE', 'selectionUnavailable', { setting: 'thought_level' });
    verified.set('thought_level', { id: thought.id, value: thought.currentValue });
  }
  return { configOptions: latest, verified, model: current, effort: verified.get('thought_level')?.value ?? null };
}
