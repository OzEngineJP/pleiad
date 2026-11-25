// Devin のモデル・思考の強さは ACP の選択肢だけに従う（ADR 0356）。CLI も資格情報も使わずに確かめる。
import assert from 'node:assert/strict';
import { buildDevinModels, readDevinList, applyDevinSelection, devinModelChoices, devinThought } from '../../core/backends/devin-models.mjs';

export const name = 'devin-models';
export const title = 'Devin のモデル一覧は ACP の model の選択肢そのまま・思考の強さは thought_level・選択肢に無い名前は送らずに断る';

// 実機（3000.14.30821）の形: thought_level の有無と選択肢は選んだ model で変わり、model を切り替えるとそのモデルの既定の段に戻る。
// speed（model_config）もモデルで変わるが、Pleiad は触らない
const AXES = {
  'swe-2-high': { thought: ['medium', 'high', 'max'], implicit: 'high', speed: ['standard', 'fast'] },
  'glm-5-2': { thought: ['none', 'high', 'max'], implicit: 'high' },
  'claude-opus-5-5-medium': { thought: ['low', 'medium', 'high', 'xhigh', 'max'], implicit: 'medium', speed: ['standard', 'fast'] },
  'kimi-k2-6': {},
};
const axisOptions = model => {
  const axes = AXES[model] ?? {};
  return [
    ...(axes.thought ? [{ id: 'thought_level', category: 'thought_level', currentValue: axes.implicit, options: axes.thought.map(value => ({ value, name: value })) }] : []),
    ...(axes.speed ? [{ id: 'speed', category: 'model_config', currentValue: 'fast', options: axes.speed.map(value => ({ value })) }] : []),
  ];
};
const options = (model = 'swe-2-high') => [
  { id: 'mode', category: 'mode', currentValue: 'accept-edits', options: [{ value: 'accept-edits' }] },
  { id: 'model', category: 'model', currentValue: model, options: [{ group: 'Models', options: [{ group: 'Nested', options: Object.keys(AXES).map(value => ({ value, name: value === 'swe-2-high' ? 'SWE-2 High' : value, ...(value === 'claude-opus-5-5-medium' ? { _meta: { 'cognition.ai/supportsImages': true } } : {}) })) }] }] },
  ...axisOptions(model),
];
function rpc(initial = options(), alter = () => {}) {
  let current = structuredClone(initial);
  const calls = [];
  return { calls, call: async (method, params) => {
    assert.equal(method, 'session/set_config_option');
    calls.push(params);
    if (params.configId === 'model') current = [current[0], { ...current[1], currentValue: params.value }, ...axisOptions(params.value)];
    else current.find(o => o.id === params.configId).currentValue = params.value;
    alter(current, params, calls.length);
    return { configOptions: structuredClone(current) };
  } };
}
const sets = calls => calls.map(c => [c.configId, c.value]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async function (t) {
  // ---- 一覧: model の選択肢をそのまま（入れ子の group を開き、重複は 1 つ）
  const list = readDevinList(options());
  t.ok('一覧は ACP の model の選択肢の値と表示名をそのまま並べ、今の値を既定にする',
    same(list.models.map(m => m.id), Object.keys(AXES)) && list.models[0].label === 'SWE-2 High' && list.current === 'swe-2-high'
      && list.models.find(m => m.id === 'claude-opus-5-5-medium').images === true, JSON.stringify(list));
  const doubled = options(); doubled[1].options.push({ value: 'kimi-k2-6' }, { value: '' }, { name: 'no value' });
  t.ok('同じ値の重ねと値の無い選択肢は 1 つにまとめる・捨てる', same(readDevinList(doubled).models.map(m => m.id), Object.keys(AXES)));
  for (const [label, bad] of [['model が無い', options().filter(o => o.id !== 'model')], ['model が 2 つ', [...options(), options()[1]]], ['選択肢が空', options().map(o => o.id === 'model' ? { ...o, options: [] } : o)], ['配列でない', null]]) {
    assert.throws(() => readDevinList(bad), { code: 'DEVIN_CATALOGUE_INVALID' });
    t.ok(`読めない一覧は推測で埋めずに断る（${label}）`, true);
  }
  t.ok('devinModelChoices は入れ子から読み、無ければ null', same(devinModelChoices(options()), Object.keys(AXES)) && devinModelChoices(undefined) === null);
  t.ok('devinThought はそのモデルの段と既定（今の値）を返し、軸が無ければ空', same(devinThought(options()), { efforts: ['medium', 'high', 'max'], defaultEffort: 'high' })
    && same(devinThought(options('kimi-k2-6')), { efforts: [], defaultEffort: null }));

  // ---- 共通の models の形
  const efforts = new Map([['swe-2-high', devinThought(options())], ['kimi-k2-6', devinThought(options('kimi-k2-6'))]]);
  const models = buildDevinModels(list, efforts, { probing: true });
  t.ok('既定（空の名前）は今のモデルを指し、強さはそのモデルのもの', models[''].resolvesTo === 'swe-2-high' && models[''].note === 'SWE-2 High' && same(models[''].efforts, ['medium', 'high', 'max']) && models[''].defaultEffort === 'high');
  t.ok('名前を読み替えない（ACP の値がそのままキー。表示名が違えば値を補足に出す）', same(Object.keys(models).slice(1), Object.keys(AXES)) && models['swe-2-high'].note === 'swe-2-high' && models['glm-5-2'].note === '');
  t.ok('読んだモデルは強さを持ち、読んでいない間は理由だけを載せる', same(models['kimi-k2-6'].efforts, []) && !models['glm-5-2'].efforts && typeof models['glm-5-2'].effortReason === 'string' && models['glm-5-2'].effortReason.length > 0);
  t.ok('読み終えた後（probing でない）は理由も載せない', !('effortReason' in buildDevinModels(list, efforts)['glm-5-2']));
  t.ok('キーが __proto__ でも普通の項目として持つ', Object.hasOwn(buildDevinModels({ models: [{ id: '__proto__', label: 'x' }], current: null }), '__proto__'));

  // ---- 選択: モデル → 段の順に送り、応答の currentValue で確かめる
  const plain = rpc();
  const kept = await applyDevinSelection(plain.call, 's', options(), {});
  t.ok('モデルも段も選ばなければ何も送らず、今のモデルと段を確かめた値として覚える', plain.calls.length === 0 && kept.model === 'swe-2-high' && kept.effort === 'high'
    && kept.verified.get('model').value === 'swe-2-high' && kept.verified.get('thought_level').value === 'high');
  const learned = [];
  const glm = rpc();
  const glmApplied = await applyDevinSelection(glm.call, 'resumed', options(), { model: 'glm-5-2', effort: 'max' }, { onModel: (id, configOptions) => learned.push([id, devinThought(configOptions)]) });
  t.ok('モデルを送ってから、そのモデルの段を送る（speed は送らない）', same(sets(glm.calls), [['model', 'glm-5-2'], ['thought_level', 'max']]) && glm.calls.every(c => c.sessionId === 'resumed') && glmApplied.effort === 'max');
  t.ok('モデルを切り替えた直後の応答（段はそのモデルの既定）を onModel に渡す', same(learned, [['glm-5-2', { efforts: ['none', 'high', 'max'], defaultEffort: 'high' }]]));
  const noEffort = rpc(); const noEffortApplied = await applyDevinSelection(noEffort.call, 's', options(), { model: 'claude-opus-5-5-medium' });
  t.ok('段を選ばなければモデルだけ送り、そのモデルの既定の段を覚える', same(sets(noEffort.calls), [['model', 'claude-opus-5-5-medium']]) && noEffortApplied.effort === 'medium');
  const kimi = rpc(); const kimiApplied = await applyDevinSelection(kimi.call, 's', options(), { model: 'kimi-k2-6' });
  t.ok('段の軸が無いモデルは model の確認だけで走る', kimi.calls.length === 1 && kimiApplied.verified.size === 1 && kimiApplied.effort === null);
  const sameModel = rpc(); await applyDevinSelection(sameModel.call, 's', options(), { effort: 'medium' });
  t.ok('モデルを選ばず段だけ選べば、今のモデルの段だけ送る', same(sets(sameModel.calls), [['thought_level', 'medium']]));

  // ---- 選択肢に無いものは送らずに断る（kind: 'model' の印）
  for (const [label, selection, code, rejected] of [
    ['古いカタログの名前', { model: 'swe-2-1-high' }, 'DEVIN_MODEL_UNAVAILABLE', 'model'],
    ['分解した名前', { model: 'swe-2' }, 'DEVIN_MODEL_UNAVAILABLE', 'model'],
    ['そのモデルに無い段', { model: 'glm-5-2', effort: 'medium' }, 'DEVIN_EFFORT_UNAVAILABLE', 'thought_level'],
    ['段の軸が無いモデルの段', { model: 'kimi-k2-6', effort: 'high' }, 'DEVIN_EFFORT_UNAVAILABLE', 'thought_level'],
  ]) {
    const fake = rpc();
    await assert.rejects(applyDevinSelection(fake.call, 's', options(), selection), error => error.code === code && error.rejected === rejected);
    t.ok(`選択肢に無いもの（${label}）は送らずに断り、読み替えない`, same(sets(fake.calls), selection.effort ? [['model', selection.model]] : []), JSON.stringify(sets(fake.calls)));
  }
  const refused = Object.assign(new Error('Invalid value'), { code: -32602, configRejected: { option: 'model' } });
  await assert.rejects(applyDevinSelection(async () => { throw refused; }, 's', options(), { model: 'glm-5-2' }), error => error === refused);
  t.ok('CLI の断りは置き換えずにそのまま返す（印は devin-acp.mjs が付ける）', true);

  // ---- 応答の確かめ
  for (const [kind, step] of [['model', 1], ['thought_level', 2]]) {
    const fake = rpc(options(), (state, params, n) => { if (n === step) state.find(o => o.id === params.configId).currentValue = 'unacknowledged'; });
    await assert.rejects(applyDevinSelection(fake.call, 's', options(), { model: 'glm-5-2', effort: 'max' }), { code: 'DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED' });
    t.ok(`${kind} の応答が違えばその場で止める`, fake.calls.length === step);
  }
  const drift = rpc(options(), (state, _params, n) => { if (n === 2) state.find(o => o.id === 'model').currentValue = 'changed'; });
  await assert.rejects(applyDevinSelection(drift.call, 's', options(), { model: 'glm-5-2', effort: 'max' }), { code: 'DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED' });
  t.ok('後の応答が確かめたモデルを変えたら止める', drift.calls.length === 2);
  await assert.rejects(applyDevinSelection(async () => ({}), 's', options(), { model: 'glm-5-2' }), { code: 'DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED' });
  t.ok('応答が空なら止める', true);
  const broken = options(); broken.find(o => o.id === 'thought_level').currentValue = 'unknown';
  await assert.rejects(applyDevinSelection(rpc(broken).call, 's', broken, {}), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('今の段が選択肢に無ければ、確かめられないので止める', true);
}
