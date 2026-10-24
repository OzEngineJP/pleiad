// Catalogue identity, explicit paid selection and ACP acknowledgement are tested without a CLI or credentials.
import assert from 'node:assert/strict';
import { buildDevinModels, resolveDevinModel, applyDevinModel, devinAcpModel, devinModelChoices } from '../../core/backends/devin-models.mjs';

export const name = 'devin-models';
export const title = 'Devin のライブ無料既定・明示した有料モデル・系列代表と思考と速度の設定 ACK';

// 実機（3000.11.92）の形: model の選択肢は系列の代表だけで、thought_level・speed の
// 有無と選択肢は選んだ model で変わる。model を切り替えると thought_level は代表 uid の接尾辞の段に戻る
const AXES = {
  'swe-2-high': { thought: ['medium', 'high', 'max'], implicit: 'high', speed: ['standard', 'fast'] },
  'deepseek-v4-1-flash-1017-high': { thought: ['none', 'low', 'high', 'max'], implicit: 'high' },
  'glm-5-2': { thought: ['none', 'high', 'max'], implicit: 'high' },
  'glm-5-2-1m': { thought: ['none', 'high', 'max'], implicit: 'high' },
  'swe-1-7-medium': { thought: ['medium', 'max'], implicit: 'medium' },
  'swe-1-8-medium': { thought: ['medium', 'high', 'max'], implicit: 'medium' },
  'claude-opus-5-5-medium': { thought: ['low', 'medium', 'high', 'xhigh', 'max'], implicit: 'medium', speed: ['standard', 'fast'] },
  'gpt-6-astra-medium': { thought: ['low', 'medium', 'high', 'xhigh', 'max'], implicit: 'medium' },
  'kimi-k2-6': {},
  'paid-exact': {},
};
const catalogue = () => ({ families: [
  { family_uid: 'swe-2', family_label: 'SWE-2', slug: 'swe-2', variants: ['high', 'medium', 'max'].flatMap(level => [
    { model_uid: `swe-2-${level}`, label: `SWE-2 ${level}`, cost_tier: 'Free', max_context_tokens: 262000 },
    { model_uid: `swe-2-${level}-lightning`, label: `SWE-2 ${level} Lightning`, cost_tier: 'High cost', cost_summary: '$1 / 1M Input', max_context_tokens: 262144 },
  ]) },
  { family_uid: 'deepseek-v4-1-flash-1017', family_label: 'DeepSeek V4.1 Flash', slug: 'deepseek-v4.1-flash', variants: ['none', 'low', 'high', 'max'].map(level => ({ model_uid: `deepseek-v4-1-flash-1017-${level}`, label: `DeepSeek V4.1 Flash ${level}`, cost_tier: 'Low cost' })) },
  { family_uid: 'glm-5.2', family_label: 'GLM-5.2', slug: 'glm-5.2', variants: ['glm-5-2', 'glm-5-2-max', 'glm-5-2-none', 'glm-5-2-1m', 'glm-5-2-max-1m', 'glm-5-2-none-1m'].map(id => ({ model_uid: id, label: id, cost_tier: 'Low cost' })) },
  { family_uid: 'swe-1.7', family_label: 'SWE-1.7', slug: 'swe-1.7', variants: [{ model_uid: 'swe-1-7', label: 'SWE-1.7 Max', cost_tier: 'Low cost' }, { model_uid: 'swe-1-7-medium', label: 'SWE-1.7 Medium', cost_tier: 'Low cost' }] },
  { family_uid: 'swe-1.8', family_label: 'SWE-1.8', slug: 'swe-1.8', variants: [{ model_uid: 'swe-1-8', label: 'SWE-1.8', cost_tier: 'Low cost' }, { model_uid: 'swe-1-8-medium', label: 'SWE-1.8 Medium', cost_tier: 'Low cost' }] },
  { family_uid: 'claude-opus-5-5', family_label: 'Claude Opus 5.5', slug: 'claude-opus-5.5', variants: ['low', 'medium', 'high', 'xhigh', 'max'].flatMap(level => [{ model_uid: `claude-opus-5-5-${level}`, cost_tier: 'High cost' }, { model_uid: `claude-opus-5-5-${level}-fast`, cost_tier: 'High cost' }]) },
  { family_uid: 'gpt-6-astra', family_label: 'GPT-6 Astra', slug: 'gpt-6-astra', variants: ['low', 'medium', 'high', 'xhigh', 'max'].flatMap(level => [{ model_uid: `gpt-6-astra-${level}`, cost_tier: 'High cost' }, { model_uid: `gpt-6-astra-${level}-priority`, cost_tier: 'High cost' }]) },
  { family_uid: 'kimi-k2.6', family_label: 'Kimi K2.6', slug: 'kimi-k2.6', variants: [{ model_uid: 'kimi-k2-6', label: 'Kimi K2.6', cost_tier: 'Low cost' }] },
  { family_uid: 'paid-family', family_label: 'Paid Family', slug: 'paid-family', variants: [{ model_uid: 'paid-exact', label: 'Current paid label', cost_tier: 'High cost', cost_summary: '$5 per unit' }] },
] });
const axisOptions = model => {
  const axes = AXES[model] ?? {};
  return [
    ...(axes.thought ? [{ id: 'thought_level', category: 'thought_level', currentValue: axes.implicit, options: axes.thought.map(value => ({ value })) }] : []),
    ...(axes.speed ? [{ id: 'speed', category: 'model_config', currentValue: 'standard', options: axes.speed.map(value => ({ value })) }] : []),
  ];
};
const options = (model = 'swe-2-high') => [
  { id: 'model', category: 'model', currentValue: model, options: [{ group: 'Models', options: [{ group: 'Nested', options: Object.keys(AXES).map(value => ({ value })) }] }] },
  ...axisOptions(model),
];
function rpc(initial = options(), alter = () => {}) {
  let current = structuredClone(initial);
  const calls = [];
  return { calls, call: async (method, params) => {
    assert.equal(method, 'session/set_config_option');
    calls.push(params);
    if (params.configId === 'model') {
      // 実機と同じく、model を切り替えると軸の一覧が model のものに入れ替わり、段は代表の接尾辞に戻る
      current = [current.find(o => o.id === 'model'), ...axisOptions(params.value)];
      current[0].currentValue = params.value;
    } else current.find(o => o.id === params.configId).currentValue = params.value;
    alter(current, params, calls.length);
    return { configOptions: structuredClone(current) };
  } };
}
const sets = calls => calls.map(c => [c.configId, c.value]);

export default async function (t) {
  // Sanitized 3000.11.92 stdout from the captured kind=models record's data.
  const capturedStdout = JSON.parse('{"families":[{"family_uid":"swe-2","family_label":"SWE-2","slug":"swe-2","variants":[{"model_uid":"swe-2-high","label":"SWE-2 High","cost_tier":"Free","max_context_tokens":262000},{"model_uid":"swe-2-medium","label":"SWE-2 Medium","cost_tier":"Free","max_context_tokens":262000},{"model_uid":"swe-2-max","label":"SWE-2 Max","cost_tier":"Free","max_context_tokens":262000}]}]}');
  const capturedModels = buildDevinModels(capturedStdout);
  assert.equal(capturedModels[''].resolvesTo, 'swe-2-high');
  for (const level of ['high', 'medium', 'max']) {
    const selected = resolveDevinModel(capturedStdout, `swe-2-${level}`);
    assert.equal(selected.base, 'swe-2'); assert.equal(selected.level, level); assert.equal(selected.maxContextTokens, 262000);
  }
  assert.throws(() => buildDevinModels({ data: capturedStdout }), { code: 'DEVIN_CATALOGUE_INVALID' });
  assert.throws(() => resolveDevinModel({ ...capturedStdout, data: capturedStdout }), { code: 'DEVIN_CATALOGUE_INVALID' });
  t.ok('実 stdout の families を直接読み、ログの data wrapper や二重定義を受け入れない', true);
  const raw = catalogue(), models = buildDevinModels(raw);
  t.ok('全 variant と有料モデルを表示し、SWE-2 High のライブ無料既定を選ぶ', models[''].resolvesTo === 'swe-2-high' && models['paid-exact'].label === 'Current paid label'
    && models['paid-exact'].note.includes('$5 per unit') && ['swe-2-medium', 'swe-2-max', 'paid-exact', 'deepseek-v4-1-flash-1017-max', 'kimi-k2-6'].every(id => Object.hasOwn(models, id)));
  const changed = catalogue(); changed.families[0].variants[0].cost_tier = 'Paid';
  t.ok('High が有料なら他のライブ Free を既定にする', resolveDevinModel(changed).id === 'swe-2-medium');
  const noFree = catalogue(); noFree.families[0].variants.forEach(v => { v.cost_tier = 'Paid'; });
  assert.throws(() => resolveDevinModel(noFree), { code: 'DEVIN_MODEL_EXPLICIT_REQUIRED' });
  t.ok('無料が無ければ有料へ黙って落とさず明示選択を要求する', !buildDevinModels(noFree)[''].resolvesTo && resolveDevinModel(noFree, 'paid-exact').free === false);
  for (const [label, patch] of [
    ['lowercase tier', { cost_tier: 'free' }], ['flag without tier', { cost_tier: undefined, free: true }],
    ['false free flag', { free: false }], ['nested false flag', { pricing: { isFree: false } }],
    ['nonzero price', { pricing: { input: 0.01 } }], ['unknown price', { cost: 'unknown' }],
    ['expired', { free_until: '2000-01-01T00:00:00Z' }], ['invalid expiry', { freeUntil: 'invalid' }],
  ]) {
    const bad = catalogue(); Object.assign(bad.families[0].variants[0], patch);
    t.ok(`矛盾や期限切れをライブ無料既定にしない（${label}）`, resolveDevinModel(bad).id === 'swe-2-medium');
    if (!Object.hasOwn(patch, 'cost_tier')) assert.throws(() => resolveDevinModel(bad, 'swe-2-high'), { code: 'DEVIN_MODEL_UNAVAILABLE' });
  }
  const zero = catalogue(); Object.assign(zero.families[0].variants[0], { pricing: { input: 0, output: '0.00' }, free_until: '2999-01-01T00:00:00Z' });
  t.ok('Free tier だけで十分で、0料金の補足とも一致する', resolveDevinModel(raw).free && resolveDevinModel(zero).id === 'swe-2-high');
  const routed = { families: [{ family_uid: 'adaptive', slug: 'adaptive', variants: [{ model_uid: 'adaptive', cost_tier: 'Free' }] }] };
  assert.throws(() => resolveDevinModel(routed), { code: 'DEVIN_MODEL_EXPLICIT_REQUIRED' });
  t.ok('ルーティングモデルも表示し明示選択できるが無料既定にしない', Object.hasOwn(buildDevinModels(routed), 'adaptive') && resolveDevinModel(routed, 'adaptive').id === 'adaptive');
  assert.throws(() => resolveDevinModel(raw, 'swe-2'), { code: 'DEVIN_MODEL_UNAVAILABLE' });
  assert.throws(() => resolveDevinModel(raw, 'removed-model'), { code: 'DEVIN_MODEL_UNAVAILABLE' });
  const duplicate = catalogue(); duplicate.families.at(-1).variants.push({ model_uid: 'swe-2-high' });
  assert.throws(() => buildDevinModels(duplicate), { code: 'DEVIN_CATALOGUE_INVALID' });
  t.ok('別名・消えたID・重複IDを推測で解決しない', true);

  for (const level of ['medium', 'high', 'max']) {
    const selected = resolveDevinModel(raw, `swe-2-${level}`), fake = rpc();
    const applied = await applyDevinModel(fake.call, 'resumed-session', options(), selected);
    assert.deepEqual(sets(fake.calls), [['model', 'swe-2-high'], ['thought_level', level], ['speed', 'standard']]);
    t.ok(`系列代表・思考・標準速度を別々に ACK し variant ID を保持する（${level}）`, selected.id === `swe-2-${level}` && selected.base === 'swe-2'
      && applied.configOptions.find(o => o.id === 'thought_level').currentValue === level && selected.maxContextTokens === 262000 && fake.calls.every(c => c.sessionId === 'resumed-session'));
  }
  // 実物（3000.11.92）のカタログの Lightning の版。ACP の model には無く、swe-2-high + 思考 + speed fast で表す
  for (const level of ['medium', 'high', 'max']) {
    const selected = resolveDevinModel(raw, `swe-2-${level}-lightning`), fake = rpc();
    await applyDevinModel(fake.call, 's', options(), selected);
    assert.deepEqual(sets(fake.calls), [['model', 'swe-2-high'], ['thought_level', level], ['speed', 'fast']]);
    t.ok(`Lightning は系列代表・同じ思考・速さ fast で ACK し、有料のまま扱う（${level}）`, selected.id === `swe-2-${level}-lightning` && selected.free === false && devinAcpModel(selected.id, Object.keys(AXES)) === 'swe-2-high');
  }
  const standard = rpc(); await applyDevinModel(standard.call, 's', options(), resolveDevinModel(raw, 'swe-2-max'));
  t.ok('Lightning でない SWE-2 は標準の速さのまま', standard.calls.at(-1).value === 'standard');
  t.ok('ACP の model の選択肢を入れ子から読み、無ければ null', devinModelChoices(options()).join() === Object.keys(AXES).join()
    && devinModelChoices(options().filter(o => o.id !== 'model')) === null && devinModelChoices(undefined) === null && devinAcpModel('paid-exact', Object.keys(AXES)) === 'paid-exact');

  // 系列の代表だけが ACP の model に出る系列（実機 DeepSeek V4.1 Flash: speed 軸なし）
  const deepMax = rpc(); const deepApplied = await applyDevinModel(deepMax.call, 's', options(), resolveDevinModel(raw, 'deepseek-v4-1-flash-1017-max'));
  t.ok('DeepSeek Max は代表 high に読み替え思考だけ送り、speed 軸が無ければ速さを送らない',
    JSON.stringify(sets(deepMax.calls)) === JSON.stringify([['model', 'deepseek-v4-1-flash-1017-high'], ['thought_level', 'max']])
      && !deepApplied.configOptions.some(o => o.id === 'speed') && deepApplied.verified.get('thought_level').value === 'max', JSON.stringify(sets(deepMax.calls)));
  const deepRep = rpc(); await applyDevinModel(deepRep.call, 's', options('deepseek-v4-1-flash-1017-high'), resolveDevinModel(raw, 'deepseek-v4-1-flash-1017-high'));
  t.ok('代表そのものの版も同じ形で ACK する', JSON.stringify(sets(deepRep.calls)) === JSON.stringify([['model', 'deepseek-v4-1-flash-1017-high'], ['thought_level', 'high']]));

  // 接尾辞を持たない代表（GLM-5.2: uid に段が無いが model の選択だけで版が決まる）
  const glm = rpc(); const glmApplied = await applyDevinModel(glm.call, 's', options('glm-5-2'), resolveDevinModel(raw, 'glm-5-2'));
  t.ok('段の接尾辞が無い代表は model だけで版が決まり、CLI が導いた段を記録する',
    JSON.stringify(sets(glm.calls)) === JSON.stringify([['model', 'glm-5-2']]) && glmApplied.verified.get('thought_level').value === 'high', JSON.stringify(sets(glm.calls)));
  const glmMax = rpc(); await applyDevinModel(glmMax.call, 's', options(), resolveDevinModel(raw, 'glm-5-2-max'));
  t.ok('同じ基部の variant は代表 + 思考で表す', JSON.stringify(sets(glmMax.calls)) === JSON.stringify([['model', 'glm-5-2'], ['thought_level', 'max']]));
  const glm1m = rpc(); await applyDevinModel(glm1m.call, 's', options(), resolveDevinModel(raw, 'glm-5-2-max-1m'));
  t.ok('-1m は対応する代表がある基部なので読み替えられる', JSON.stringify(sets(glm1m.calls)) === JSON.stringify([['model', 'glm-5-2-1m'], ['thought_level', 'max']]));
  // 接尾辞を持たない非代表（swe-1-7 = 残った段が 1 つなので max と読み取れる）
  const swe17 = rpc(); await applyDevinModel(swe17.call, 's', options(), resolveDevinModel(raw, 'swe-1-7'));
  t.ok('段の接尾辞が無い非代表は、残り 1 つの段なら読み替えて ACK する', JSON.stringify(sets(swe17.calls)) === JSON.stringify([['model', 'swe-1-7-medium'], ['thought_level', 'max']]));
  // swe-1-8: 接尾辞の無い非代表で残りの段が 2 つあるので絞れない
  const ambiguous = rpc();
  await assert.rejects(applyDevinModel(ambiguous.call, 's', options(), resolveDevinModel(raw, 'swe-1-8')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('段が 1 つに絞れない接尾辞の無い版は推測で選ばない', JSON.stringify(sets(ambiguous.calls)) === JSON.stringify([['model', 'swe-1-8-medium']]));
  // 両方の軸が無い系（Kimi）
  const kimi = rpc(); const kimiApplied = await applyDevinModel(kimi.call, 's', options('kimi-k2-6'), resolveDevinModel(raw, 'kimi-k2-6'));
  t.ok('思考も速度も無い系は model の ACK だけで走る', JSON.stringify(sets(kimi.calls)) === JSON.stringify([['model', 'kimi-k2-6']]) && kimiApplied.verified.size === 1);
  // 対応軸の無い印（-priority）は送らず拒否する
  const priority = rpc();
  await assert.rejects(applyDevinModel(priority.call, 's', options(), resolveDevinModel(raw, 'gpt-6-astra-low-priority')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('-priority は ACP に対応軸が無いので黙って別の形にせず拒否する', priority.calls.length === 0 && devinAcpModel('gpt-6-astra-low-priority', Object.keys(AXES)) === null);
  const gpt = rpc(); await applyDevinModel(gpt.call, 's', options(), resolveDevinModel(raw, 'gpt-6-astra-high'));
  t.ok('priority でない GPT 系の variant は代表 + 思考で走る', JSON.stringify(sets(gpt.calls)) === JSON.stringify([['model', 'gpt-6-astra-medium'], ['thought_level', 'high']]));
  const claudeFast = rpc(); await applyDevinModel(claudeFast.call, 's', options(), resolveDevinModel(raw, 'claude-opus-5-5-high-fast'));
  t.ok('-fast の variant は代表 + 思考 + speed fast で走る', JSON.stringify(sets(claudeFast.calls)) === JSON.stringify([['model', 'claude-opus-5-5-medium'], ['thought_level', 'high'], ['speed', 'fast']]));
  const claudePlain = rpc(); await applyDevinModel(claudePlain.call, 's', options(), resolveDevinModel(raw, 'claude-opus-5-5-xhigh'));
  t.ok('fast でない variant は標準速度を ACK する', JSON.stringify(sets(claudePlain.calls)) === JSON.stringify([['model', 'claude-opus-5-5-medium'], ['thought_level', 'xhigh'], ['speed', 'standard']]));
  // speed 軸の無い系で -fast を選んだ場合は拒否する
  const fastNoAxis = catalogue();
  fastNoAxis.families.find(f => f.family_uid === 'deepseek-v4-1-flash-1017').variants.push({ model_uid: 'deepseek-v4-1-flash-1017-high-fast', cost_tier: 'Low cost' });
  const fastDenied = rpc();
  await assert.rejects(applyDevinModel(fastDenied.call, 's', options(), resolveDevinModel(fastNoAxis, 'deepseek-v4-1-flash-1017-high-fast')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('-fast を選んだのに speed 項目が無い系は拒否する', JSON.stringify(sets(fastDenied.calls)) === JSON.stringify([['model', 'deepseek-v4-1-flash-1017-high'], ['thought_level', 'high']]));
  // 指定の段がその系の選択肢に無ければ拒否（黙って別の段にしない）
  const missingLevel = catalogue();
  missingLevel.families.find(f => f.family_uid === 'deepseek-v4-1-flash-1017').variants.push({ model_uid: 'deepseek-v4-1-flash-1017-xhigh', cost_tier: 'Low cost' });
  await assert.rejects(applyDevinModel(rpc().call, 's', options(), resolveDevinModel(missingLevel, 'deepseek-v4-1-flash-1017-xhigh')), { code: 'DEVIN_MODEL_CONFIG_UNAVAILABLE' });
  t.ok('選んだ段がその系の選択肢に無ければ拒否する', true);

  const resume = options(); resume.find(o => o.id === 'thought_level').currentValue = 'max';
  const resumed = rpc(resume); await applyDevinModel(resumed.call, 'resume', resume, resolveDevinModel(raw, 'swe-2-medium'));
  t.ok('再開後も以前の思考・速度を引き継がず選択を ACK し直す', resumed.calls.length === 3 && resumed.calls[1].value === 'medium' && resumed.calls[2].value === 'standard');
  const paid = rpc(options('paid-exact')); const paidApplied = await applyDevinModel(paid.call, 'paid', options('paid-exact'), resolveDevinModel(noFree, 'paid-exact'));
  t.ok('明示選択の有料モデルは ACP の完全一致選択肢なら使える', sets(paid.calls).length === 1 && paid.calls[0].value === 'paid-exact' && paidApplied.verified.size === 1);
  const foreign = catalogue(); foreign.families.at(-1).variants[0].model_uid = 'unknown-variant';
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
  t.ok('ACK が空なら停止する', true);
  const error = new Error('RPC refused');
  await assert.rejects(applyDevinModel(async () => { throw error; }, 's', options(), resolveDevinModel(raw)), e => e === error);
  t.ok('RPC の拒否を成功や別モデルに置き換えない', true);
}
