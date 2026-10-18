// Catalogue identity, explicit paid selection and ACP acknowledgement are tested without a CLI or credentials.
import assert from 'node:assert/strict';
import { buildDevinModels, resolveDevinModel, applyDevinModel } from '../../core/backends/devin-models.mjs';

export const name = 'devin-models';
export const title = 'Devin のライブ無料既定・明示した有料モデル・系列と思考と速度の設定 ACK';

const catalogue = () => ({ data: { families: [
  { family_uid: 'swe-2', family_label: 'SWE-2', slug: 'swe-2', variants: ['high', 'medium', 'max'].map(level => ({
    model_uid: `swe-2-${level}`, label: `SWE-2 ${level}`, cost_tier: 'Free', max_context_tokens: 262000,
  })) },
  { family_uid: 'paid-family', family_label: 'Paid Family', slug: 'paid-family', variants: [{ model_uid: 'paid-exact', label: 'Current paid label', cost_tier: 'High cost', cost_summary: '$5 per unit' }] },
] } });
const options = () => [
  { id: 'model', category: 'model', currentValue: 'swe-2-high', options: [{ group: 'Models', options: [{ group: 'Nested', options: [{ value: 'swe-2-high', name: 'SWE-2' }, { value: 'paid-exact', name: 'Paid' }] }] }] },
  { id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [{ group: 'Thought', options: ['medium', 'high', 'max'].map(value => ({ value })) }] },
  { id: 'speed', category: 'model_config', currentValue: 'fast', options: [{ value: 'standard' }, { value: 'fast' }] },
];
function rpc(initial = options(), alter = () => {}) {
  let current = structuredClone(initial);
  const calls = [];
  return { calls, call: async (method, params) => {
    assert.equal(method, 'session/set_config_option');
    calls.push(params);
    current.find(o => o.id === params.configId).currentValue = params.value;
    alter(current, params, calls.length);
    return { configOptions: structuredClone(current) };
  } };
}

export default async function (t) {
  const raw = catalogue(), models = buildDevinModels(raw);
  t.ok('全 variant と有料モデルを表示し、SWE-2 High のライブ無料既定を選ぶ', models[''].resolvesTo === 'swe-2-high' && models['paid-exact'].label === 'Current paid label'
    && models['paid-exact'].note.includes('$5 per unit') && ['swe-2-medium', 'swe-2-max', 'paid-exact'].every(id => Object.hasOwn(models, id)));
  const changed = catalogue(); changed.data.families[0].variants[0].cost_tier = 'Paid';
  t.ok('High が有料なら他のライブ Free を既定にする', resolveDevinModel(changed).id === 'swe-2-medium');
  const noFree = catalogue(); noFree.data.families[0].variants.forEach(v => { v.cost_tier = 'Paid'; });
  assert.throws(() => resolveDevinModel(noFree), { code: 'DEVIN_MODEL_EXPLICIT_REQUIRED' });
  t.ok('無料が無ければ有料へ黙って落とさず明示選択を要求する', !buildDevinModels(noFree)[''].resolvesTo && resolveDevinModel(noFree, 'paid-exact').free === false);
  for (const [label, patch] of [
    ['lowercase tier', { cost_tier: 'free' }], ['flag without tier', { cost_tier: undefined, free: true }],
    ['false free flag', { free: false }], ['nested false flag', { pricing: { isFree: false } }],
    ['nonzero price', { pricing: { input: 0.01 } }], ['unknown price', { cost: 'unknown' }],
    ['expired', { free_until: '2000-01-01T00:00:00Z' }], ['invalid expiry', { freeUntil: 'invalid' }],
  ]) {
    const bad = catalogue(); Object.assign(bad.data.families[0].variants[0], patch);
    t.ok(`矛盾や期限切れをライブ無料既定にしない（${label}）`, resolveDevinModel(bad).id === 'swe-2-medium');
    if (!Object.hasOwn(patch, 'cost_tier')) assert.throws(() => resolveDevinModel(bad, 'swe-2-high'), { code: 'DEVIN_MODEL_UNAVAILABLE' });
  }
  const zero = catalogue(); Object.assign(zero.data.families[0].variants[0], { pricing: { input: 0, output: '0.00' }, free_until: '2999-01-01T00:00:00Z' });
  t.ok('Free tier だけで十分で、0料金の補足とも一致する', resolveDevinModel(raw).free && resolveDevinModel(zero).id === 'swe-2-high');
  const routed = { data: { families: [{ family_uid: 'adaptive', slug: 'adaptive', variants: [{ model_uid: 'adaptive', cost_tier: 'Free' }] }] } };
  assert.throws(() => resolveDevinModel(routed), { code: 'DEVIN_MODEL_EXPLICIT_REQUIRED' });
  t.ok('ルーティングモデルも表示し明示選択できるが無料既定にしない', Object.hasOwn(buildDevinModels(routed), 'adaptive') && resolveDevinModel(routed, 'adaptive').id === 'adaptive');
  assert.throws(() => resolveDevinModel(raw, 'swe-2'), { code: 'DEVIN_MODEL_UNAVAILABLE' });
  assert.throws(() => resolveDevinModel(raw, 'removed-model'), { code: 'DEVIN_MODEL_UNAVAILABLE' });
  const duplicate = catalogue(); duplicate.data.families[1].variants.push({ model_uid: 'swe-2-high' });
  assert.throws(() => buildDevinModels(duplicate), { code: 'DEVIN_CATALOGUE_INVALID' });
  t.ok('別名・消えたID・重複IDを推測で解決しない', true);

  for (const level of ['medium', 'high', 'max']) {
    const selected = resolveDevinModel(raw, `swe-2-${level}`), fake = rpc();
    const latest = await applyDevinModel(fake.call, 'resumed-session', options(), selected);
    assert.deepEqual(fake.calls.map(c => [c.configId, c.value]), [['model', 'swe-2-high'], ['thought_level', level], ['speed', 'standard']]);
    t.ok(`系列代表・思考・標準速度を別々に ACK し variant ID を保持する（${level}）`, selected.id === `swe-2-${level}` && selected.acpModel === 'swe-2-high'
      && latest.find(o => o.id === 'thought_level').currentValue === level && selected.maxContextTokens === 262000 && fake.calls.every(c => c.sessionId === 'resumed-session'));
  }
  const resume = options(); resume.find(o => o.id === 'thought_level').currentValue = 'max';
  const resumed = rpc(resume); await applyDevinModel(resumed.call, 'resume', resume, resolveDevinModel(raw, 'swe-2-medium'));
  t.ok('再開後も以前の思考・速度を引き継がず選択を ACK し直す', resumed.calls.length === 3 && resumed.calls[1].value === 'medium' && resumed.calls[2].value === 'standard');
  const paidOptions = options().filter(o => o.id !== 'thought_level');
  const paid = rpc(paidOptions); await applyDevinModel(paid.call, 'paid', paidOptions, resolveDevinModel(noFree, 'paid-exact'));
  t.ok('明示選択の有料モデルは ACP の完全一致選択肢なら使える', paid.calls[0].value === 'paid-exact' && paid.calls.at(-1).value === 'standard');
  const unknownThought = rpc();
  await assert.rejects(applyDevinModel(unknownThought.call, 'paid', options(), resolveDevinModel(noFree, 'paid-exact')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('完全一致IDでも独立した思考設定との対応が不明なら拒否する', unknownThought.calls.length === 1);
  const foreign = catalogue(); foreign.data.families[1].variants[0].model_uid = 'unknown-variant';
  const unknown = rpc(); await assert.rejects(applyDevinModel(unknown.call, 'unknown', options(), resolveDevinModel(foreign, 'unknown-variant')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('他系列の代表との対応が不明なら推測送信も fallback もしない', unknown.calls.length === 0);

  for (const [kind, step] of [['model', 1], ['thought_level', 2], ['speed', 3]]) {
    const fake = rpc(options(), (state, params, n) => { if (n === step) state.find(o => o.id === params.configId).currentValue = 'unacknowledged'; });
    await assert.rejects(applyDevinModel(fake.call, 's', options(), resolveDevinModel(raw, 'swe-2-medium')), { code: 'DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED' });
    t.ok(`${kind} の ACK が違えばその場で停止する`, fake.calls.length === step);
  }
  for (const [label, changedKind, step] of [['thought changes model', 'model', 2], ['speed changes thought', 'thought_level', 3]]) {
    const fake = rpc(options(), (state, _params, n) => { if (n === step) state.find(o => o.id === changedKind).currentValue = 'changed'; });
    await assert.rejects(applyDevinModel(fake.call, 's', options(), resolveDevinModel(raw, 'swe-2-medium')), { code: 'DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED' });
    t.ok(`後続 ACK が確認済み設定を変えたら停止する（${label}）`, fake.calls.length === step);
  }
  await assert.rejects(applyDevinModel(async () => ({}), 's', options(), resolveDevinModel(raw)), { code: 'DEVIN_MODEL_CONFIG_NOT_ACKNOWLEDGED' });
  const noThought = options().filter(o => o.id !== 'thought_level'), noSpeed = options().filter(o => o.id !== 'speed');
  for (const initial of [noThought, noSpeed]) {
    const fake = rpc(initial);
    await assert.rejects(applyDevinModel(fake.call, 's', initial, resolveDevinModel(raw)), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  }
  const unavailableLevel = options(); unavailableLevel[1].options = [{ value: 'high' }];
  await assert.rejects(applyDevinModel(rpc(unavailableLevel).call, 's', unavailableLevel, resolveDevinModel(raw, 'swe-2-medium')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('ACK全体・思考・速度・指定した思考の候補が無ければ停止する', true);
  const error = new Error('RPC refused');
  await assert.rejects(applyDevinModel(async () => { throw error; }, 's', options(), resolveDevinModel(raw)), e => e === error);
  t.ok('RPC の拒否を成功や別モデルに置き換えない', true);
}
