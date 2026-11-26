// バックエンドの契約（core/backends/contract.mjs）の静的な検査: 全エージェントの能力の印の状態・性質・印とメソッドの食い違い・
// エージェントの記述（core/backends/agents.mjs）のキー・性質ごとの契約の試験と説明の置き場・身代わり・runArgs の絞り込み（gateRunArgs）・配達物の証拠の照らし方。
// 印ごとの検査の規則（required・impossible の cause と理由・todo の Issue・subagentTools の申告）は、contract.mjs の検査そのものを下で確かめる。
// 動かして確かめる共通の契約と配達物の確かめは tests/unit/backend-common.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CAPABILITIES, CAPABILITY_KEYS, CAPABILITY_DOCS, IMPOSSIBLE_CAUSES, NO_CAPABILITIES, NO_TRAITS, BACKEND_EVENTS, TRAIT_KEYS, RUN_ARG_FEATURES,
  checkBackendShape, checkBackendEvent, capabilityProblem, capabilityValue, covered, gateRunArgs, impossible, legacyCapabilities, todo, traitProblem,
} from '../../core/backends/contract.mjs';
import { AGENTS, DESCRIPTOR_KEYS, DEFAULT_AGENT_IDS, definePerAgentMap, idleCompactionKey } from '../../core/backends/agents.mjs';
import {
  DELIVERY_ARG_KEYS, DELIVERY_HINTS, DELIVERY_PROBES, EXTRA_PROBES, PROBE_MARKS, RIGS, deliveryArgs, deliveryRequired, loadNatives, probeVerdict,
} from '../lib/backend-common.mjs';
import { ROOT } from '../lib/server.mjs';

// 現役のエージェント（試験用の fake を除く）
const ACTIVE = DEFAULT_AGENT_IDS;

// 性質（能力ではない。ADR 0274）ごとの契約の試験（tests/run.mjs の suite 名）。性質を足すときはここにも足す
const TRAIT_CONTRACTS = {
  effortInModelId: ['effort', 'devin-models', 'server-devin'],
  instructionsAtStart: ['bot-dispatch'],
  failureDiagnostics: ['server-antigravity', 'server-devin'],
  promptDelivery: ['message-queue', 'server-antigravity'],
  secretsViaEnvFile: ['secrets-store'],
  liveSecrets: ['server-secrets', 'secrets-store', 'server-opencode'],
};

export const name = 'backend-contract';
export const title = 'バックエンドの契約: 能力の印を 4 つの状態で全部書く・性質を true/false で書く・印とメソッドが合う・記述のキー・runArgs の絞り込み・配達物の証拠の照らし方';

export default async function (t) {
  const natives = await loadNatives();
  for (const [id, native] of Object.entries(natives)) {
    // 必須の印（required）・impossible の原因と理由・サブエージェントの申告も、この検査が見る
    const problems = checkBackendShape(native);
    t.ok(`${id}: 能力の印を 4 つの状態で全部書き、印とメソッドが合う`, problems.length === 0, problems.join(' / '));
    t.ok(`${id}: id が記述のキーと同じ`, native.id === id, String(native.id));
  }
  t.ok('何も持たない能力（対応を終えたバックエンド）も全部のキーを持ち、値が許される形（required の印にも書ける）',
    CAPABILITY_KEYS.every((k) => Object.hasOwn(NO_CAPABILITIES, k) && capabilityProblem(k, NO_CAPABILITIES[k]) === null)
    && Object.keys(NO_CAPABILITIES).length === CAPABILITY_KEYS.length);
  t.ok('性質を持たないバックエンドの値は、全部 false',
    TRAIT_KEYS.every((k) => NO_TRAITS[k] === false) && Object.keys(NO_TRAITS).length === TRAIT_KEYS.length);
  // 現役のエージェントは「全部 impossible の雛形」から始められない（対応を終えたバックエンドだけが NO_CAPABILITIES を使える）
  for (const [id, a] of Object.entries(AGENTS)) {
    const file = a.module.replace(/^\.\//, '');
    const source = readFileSync(path.join(ROOT, 'core', 'backends', file), 'utf8');
    t.ok(`${id}: 現役のエージェントは NO_CAPABILITIES を使わない（全キーを状態で書く）`, !/\bNO_CAPABILITIES\b/.test(source),
      `core/backends/${file} に NO_CAPABILITIES がある。全部のキーを 4 つの状態で書く`);
  }

  for (const [id, a] of Object.entries(AGENTS)) {
    const missing = DESCRIPTOR_KEYS.filter((k) => !Object.hasOwn(a, k));
    const extra = Object.keys(a).filter((k) => !DESCRIPTOR_KEYS.includes(k));
    t.ok(`${id}: 記述のキーを全部書く（使わないものは null）`, missing.length === 0 && extra.length === 0, JSON.stringify({ missing, extra }));
    t.ok(`${id}: 身代わり（tests/lib/backend-common.mjs の RIGS）がある`, typeof RIGS[id] === 'function');
    t.ok(`${id}: hooksVia は hooksAs のエージェントだけが書き、'callback'・'plugin'・'config'`, a.hooksAs ? ['callback', 'plugin', 'config'].includes(a.hooksVia) : a.hooksVia === null, String(a.hooksVia));
    t.ok(`${id}: contextAt は 'turn' か 'conversation'`, ['turn', 'conversation'].includes(a.contextAt), String(a.contextAt));
    if (a.cli) t.ok(`${id}: CLI の記述に exe・binEnv・installUrl がある`, typeof a.cli.exe === 'string' && /^AGENT_HOST_[A-Z_]+_BIN$/.test(a.cli.binEnv) && /^https:\/\//.test(a.cli.installUrl));
    const key = idleCompactionKey(id);
    t.ok(`${id}: 自動の圧縮の行は、compact を持つときだけ（行の無い compact は黙って自動の圧縮が動かない）`,
      Boolean(key) === Boolean(capabilityValue(natives[id]?.capabilities?.compact)), JSON.stringify({ key, compact: natives[id]?.capabilities?.compact }));
    // シェルのツールの名前（core/shell-tools.mjs の正本）は、画面の見た目の手がかり（toolHints の shape: 'shell'）と同じ
    const hinted = Object.entries(natives[id]?.toolHints ?? {}).filter(([, h]) => h?.shape === 'shell').map(([n]) => n).sort();
    t.ok(`${id}: 記述の shellTools が、toolHints の shape: 'shell' と同じ名前`, Array.isArray(a.shellTools) && JSON.stringify([...a.shellTools].sort()) === JSON.stringify(hinted),
      JSON.stringify({ shellTools: a.shellTools, hinted }));
  }
  t.ok('既定で有効にするのは fake を除く全部', DEFAULT_AGENT_IDS.join() === Object.keys(AGENTS).filter((id) => id !== 'fake').join());
  t.ok('身代わりの一覧に、記述に無いエージェントが無い', Object.keys(RIGS).every((id) => Object.hasOwn(AGENTS, id)));
  t.ok('CLI の実行ファイルを差し替える環境変数はエージェントごとに独立する',
    new Set(Object.values(AGENTS).filter((a) => a.cli).map((a) => a.cli.binEnv)).size === Object.values(AGENTS).filter((a) => a.cli).length);

  // エージェントごとの表（definePerAgentMap）: 足りない・知らないエージェントのキーは黙って通さない
  const perAgentError = (map, opts) => { try { definePerAgentMap('check', map, opts); return null; } catch (e) { return String(e.message); } };
  const fullMap = () => Object.fromEntries(DEFAULT_AGENT_IDS.map((id) => [id, 1]));
  t.ok('エージェントごとの表: 全エージェントを書けば通り、書き換えられない', perAgentError(fullMap()) === null && Object.isFrozen(definePerAgentMap('check', fullMap())));
  t.ok('エージェントごとの表: 足りないエージェント・知らないエージェントのキーは落とす',
    (perAgentError(Object.fromEntries(DEFAULT_AGENT_IDS.slice(1).map((id) => [id, 1]))) ?? '').includes(`足りない: ${DEFAULT_AGENT_IDS[0]}`)
    && (perAgentError({ ...fullMap(), 'no-such-agent': 1 }) ?? '').includes('知らない: no-such-agent'));
  t.ok('エージェントごとの表: extra で試験用の別名を足せる（足していなければ落とす）',
    perAgentError({ ...fullMap(), fake: 1 }, { extra: ['fake'] }) === null && perAgentError({ ...fullMap(), fake: 1 }) !== null);

  // 印ごとの説明（印を足して、書き忘れたら落とす）と、性質ごとの契約の試験の実在
  const suites = new Set([...readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8').matchAll(/'\.\/unit\/([\w.-]+)\.mjs'/g)].map((m) => m[1]));
  const suiteNames = new Set([...suites].map((file) => {
    const text = readFileSync(path.join(ROOT, 'tests', 'unit', `${file}.mjs`), 'utf8');
    return /export const name = ['"]([^'"]+)['"]/.exec(text)?.[1] ?? file;
  }));
  const text = (v) => ['ja', 'en'].every((lng) => typeof v?.[lng] === 'string' && v[lng].length > 0);
  for (const key of CAPABILITY_KEYS) {
    // 印の説明の正本（公開文書 site/docs/scripts/generate.mjs が使う利用者向けの文）。印を足して説明を書き忘れたら落とす
    const doc = CAPABILITY_DOCS[key];
    t.ok(`印 ${key}: 利用者向けの説明（ja・en の label・summary・unavailable）がある（core/backends/capability-marks.mjs の CAPABILITY_DOCS）`,
      Boolean(doc) && text(doc.label) && text(doc.summary) && text(doc.unavailable) && Object.values(doc.values ?? {}).every(text));
    // Pleiad が補える印（covered: true）は、どう補うかの文を持つ。補えない印は持たない
    t.ok(`印 ${key}: Pleiad が補える印だけが、補い方の説明（covered）を ja・en で持つ`,
      CAPABILITIES[key].covered === true ? text(doc?.covered) : !Object.hasOwn(doc ?? {}, 'covered'));
  }
  t.ok('説明に、一覧に無い印が無い', Object.keys(CAPABILITY_DOCS).every((k) => CAPABILITY_KEYS.includes(k)));
  // 性質は能力の表に出さない（一覧にも混ぜない）
  for (const key of TRAIT_KEYS) {
    const named = TRAIT_CONTRACTS[key] ?? [];
    const unknown = named.filter((n) => !suiteNames.has(n));
    t.ok(`性質 ${key}: 契約の試験がある（tests/unit/backend-contract.mjs の TRAIT_CONTRACTS に suite 名を書く）`, named.length > 0 && unknown.length === 0, JSON.stringify({ named, unknown }));
  }
  t.ok('性質の契約の試験に、一覧に無い性質が無い', Object.keys(TRAIT_CONTRACTS).every((k) => TRAIT_KEYS.includes(k)) && TRAIT_KEYS.every((k) => !CAPABILITY_KEYS.includes(k)));
  t.ok('印の説明（公開文書の表）に性質を出さない', TRAIT_KEYS.every((k) => !Object.hasOwn(CAPABILITY_DOCS, k)));
  // 配達物（runArgs の渡し物）: 現役のエージェントは全員、1 ターン流して届いた証拠を返す probe を持つ（tests/unit/backend-common.mjs が回す）。
  // 新しいエージェントを足したときに漏れないよう、記述（AGENTS）から機械的に決める
  for (const id of ACTIVE) {
    t.ok(`${id}: 配達物の probe がある（tests/lib/backend-common.mjs の DELIVERY_PROBES に、1 ターン流して証拠を返す probe を書く）`,
      typeof DELIVERY_PROBES[id] === 'function');
  }
  t.ok('配達物の probe の一覧に、記述に無い・現役でないエージェントが無い', Object.keys(DELIVERY_PROBES).every((id) => ACTIVE.includes(id)));
  // 配達物のキーは RUN_ARG_FEATURES から作る（手で写さない）。deliveryArgs が全部のキーを実際に渡す（一覧だけ足して渡し忘れない）
  const allCaps = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true]));
  const built = deliveryArgs(allCaps, {});
  const unbuilt = DELIVERY_ARG_KEYS.filter((key) => !Object.hasOwn(built, key));
  t.ok('配達物の試験: deliveryArgs が RUN_ARG_FEATURES のキーを全部渡す（新しいキーは tests/lib/backend-common.mjs の deliveryArgs にも足す）',
    DELIVERY_ARG_KEYS.length > 0 && unbuilt.length === 0, JSON.stringify(unbuilt));

  // 証拠の取りこぼしを落とす: runArgs の配達物の印は全部 probe: true（capability-marks.mjs）で、確かめる証拠の集合と一致し、説明がある
  const featureMarks = [...new Set(Object.values(RUN_ARG_FEATURES))].sort();
  t.ok('配達物の印（RUN_ARG_FEATURES の印）は、全部 probe: true で、それ以外の印に probe: true が無い（証拠が要る印の取りこぼしが無い）',
    featureMarks.length > 0 && JSON.stringify([...PROBE_MARKS].sort()) === JSON.stringify(featureMarks)
    && featureMarks.every((key) => CAPABILITIES[key]?.probe === true), JSON.stringify({ probe: PROBE_MARKS, features: featureMarks }));
  const extraKeys = Object.values(EXTRA_PROBES).flat();
  t.ok('エージェントごとの追加の証拠: 現役のエージェントのもので、PROBE_MARKS と重ならない',
    Object.keys(EXTRA_PROBES).every((id) => ACTIVE.includes(id)) && extraKeys.every((key) => !PROBE_MARKS.includes(key)));
  t.ok('証拠ごとに、届くはずの場所の説明（DELIVERY_HINTS）がある',
    [...PROBE_MARKS, ...new Set(extraKeys)].every((key) => typeof DELIVERY_HINTS[key] === 'string' && DELIVERY_HINTS[key].length > 0));
  t.ok('追加の証拠のうち印のものは、そのエージェントの宣言にある（知らない印を書いていない）',
    Object.entries(EXTRA_PROBES).every(([id, keys]) => keys.every((key) => !Object.hasOwn(CAPABILITIES, key) || Object.hasOwn(natives[id]?.capabilities ?? {}, key))));

  // 証拠の照らし方（probeVerdict）そのもの: 要る証拠が無い・偽・宣言が対応でない印の証拠が真・知らない証拠を、それぞれ見つける
  const supportedCaps = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true]));
  const goodEvidence = Object.fromEntries(PROBE_MARKS.map((key) => [key, true]));
  const verdict = (over = {}, caps = supportedCaps, extras = []) => probeVerdict({ id: 'verdict-check', caps, extras, result: { evidence: { ...goodEvidence, ...over } } });
  const clean = verdict();
  t.ok('証拠の照らし方: 全部対応で全部届いていれば問題が無い（要る証拠は PROBE_MARKS の全部）',
    JSON.stringify([...clean.required].sort()) === JSON.stringify([...PROBE_MARKS].sort())
    && !clean.missing.length && !clean.notDelivered.length && !clean.unknown.length && !clean.stale.length);
  const dropped = { ...goodEvidence };
  delete dropped.browser;
  t.ok('証拠の照らし方: 要る証拠が無いものと偽のものを落とす',
    probeVerdict({ id: 'verdict-check', caps: supportedCaps, result: { evidence: dropped } }).missing.join() === 'browser'
    && verdict({ secrets: false }).notDelivered.join() === 'secrets');
  t.ok('証拠の照らし方: 知らない証拠を落とし、追加の証拠は extras にあれば通す',
    verdict({ mystery: true }).unknown.join() === 'mystery'
    && verdict({ conversationIsolation: true }, supportedCaps, ['conversationIsolation']).unknown.length === 0
    && verdict({ conversationIsolation: true }, supportedCaps, ['conversationIsolation']).required.includes('conversationIsolation')
    && verdict({}, supportedCaps, ['conversationIsolation']).missing.join() === 'conversationIsolation');
  const unsupported = [impossible('x', 'design'), todo('#180'), false];
  t.ok('証拠の照らし方: 宣言が対応でない印は証拠を要求せず、証拠が真なら宣言が古いと落とす（偽なら通す）',
    unsupported.every((value) => {
      const caps = { ...supportedCaps, hooks: value };
      const off = verdict({ hooks: false }, caps);
      const stale = verdict({ hooks: true }, caps);
      return !off.required.includes('hooks') && !off.notDelivered.length && !off.stale.length && stale.stale.join() === 'hooks';
    }));
  t.ok('証拠の照らし方: 追加の証拠が印のとき、対応のときだけ要求する（印でないものは常に要求する）',
    verdict({ shell: false }, { ...supportedCaps, shell: todo('#1') }, ['shell']).required.includes('shell') === false
    && verdict({}, supportedCaps, ['shell']).required.includes('shell')
    && deliveryRequired(true) && deliveryRequired('host') && deliveryRequired(covered)
    && !deliveryRequired(false) && !deliveryRequired(todo('#1')) && !deliveryRequired(impossible('x', 'design')));

  // runArgs の絞り込み（gateRunArgs）: 対応でない印（false・impossible・todo・covered）の配達物は消え、対応の印と配管のキーは残る。知らないキーは strict で例外
  const featureKeys = Object.keys(RUN_ARG_FEATURES);
  const gateWith = (over, base = supportedCaps) => gateRunArgs({ ...built }, { ...base, ...over }, { strict: false, log() {} });
  for (const [id, native] of Object.entries(natives)) {
    const caps = native.capabilities ?? {};
    const gated = gateRunArgs({ ...built, prompt: 'p' }, caps, { strict: false, log() {} });
    const wrong = featureKeys.filter((key) => Object.hasOwn(gated, key) !== Boolean(capabilityValue(caps[RUN_ARG_FEATURES[key]])));
    t.ok(`${id}: runArgs の絞り込みは、宣言が対応の印の配達物だけを残す（false・impossible・todo は消す）`, wrong.length === 0 && gated.prompt === 'p', JSON.stringify(wrong));
  }
  t.ok('runArgs の絞り込み: 全部の印が対応なら全部残り、false・impossible・todo・covered の印は、その印の配達物だけが消える',
    featureKeys.every((key) => Object.hasOwn(gateWith({}), key))
    && [false, impossible('x', 'design'), todo('#1'), covered].every((value) => Object.keys(RUN_ARG_FEATURES).every((key) => {
      const gated = gateWith({ [RUN_ARG_FEATURES[key]]: value });
      return !Object.hasOwn(gated, key) && featureKeys.filter((other) => RUN_ARG_FEATURES[other] !== RUN_ARG_FEATURES[key]).every((other) => Object.hasOwn(gated, other));
    })));
  t.ok('runArgs の絞り込み: 配管のキー（prompt など）は印に関わらず残る',
    gateWith(Object.fromEntries(featureKeys.map((key) => [RUN_ARG_FEATURES[key], false]))).prompt === 'delivery check');
  const strictThrows = (() => { try { gateRunArgs({ prompt: 'p', notRegistered: 1 }, supportedCaps, { strict: true, log() {} }); return false; } catch (e) { return /notRegistered/.test(String(e.message)); } })();
  const logged = [];
  const lenient = gateRunArgs({ prompt: 'p', notRegistered: 1 }, supportedCaps, { strict: false, log: (line) => logged.push(line) });
  t.ok('runArgs の絞り込み: 登録の無いキーは strict なら例外、そうでなければログだけ出して消さない',
    strictThrows && logged.length === 1 && /notRegistered/.test(logged[0]) && lenient.notRegistered === 1);

  // 状態と値の検査そのもの
  const base = { id: 'state-check', label: 'S', capabilities: { ...NO_CAPABILITIES }, traits: { ...NO_TRAITS }, modes: () => ({}), models: async () => ({}),
    listSessions: async () => [], getSession: async () => null, getMessages: async () => [], runTurn: async () => ({}) };
  const withCaps = (over, members = {}) => ({ ...base, ...members, capabilities: { ...base.capabilities, ...over } });
  const stateProblems = (over, members) => checkBackendShape(withCaps(over, members)).join('\n');
  t.ok('状態の検査: 理由の無い impossible・Issue の無い todo・補えない covered・false を落とす',
    /impossible needs a reason/.test(stateProblems({ title: impossible('', 'design') }))
    && /todo needs an issue number/.test(stateProblems({ title: todo('98') }))
    && /todo needs an issue number/.test(stateProblems({ title: todo('#x') }))
    && /compact cannot be covered/.test(stateProblems({ compact: covered }))
    && /title value false is not allowed/.test(stateProblems({ title: false }))
    && /approvals cannot be a state/.test(stateProblems({ approvals: impossible('x', 'design') })));
  // impossible は原因（cause）を持ち、手段があるのに確かめていない・Issue 待ちを理由に書けない（その場合は todo）
  const causes = IMPOSSIBLE_CAUSES.filter((cause) => cause !== 'retired');
  t.ok('不可能の検査: 原因（upstream / design / retired）の無い・知らない原因の impossible を落とし、正しい原因は通す',
    IMPOSSIBLE_CAUSES.length > 0
    && /needs a cause/.test(stateProblems({ title: impossible('x') }))
    && /needs a cause/.test(stateProblems({ title: impossible('x', 'no-such-cause') }))
    && causes.every((cause) => capabilityProblem('title', impossible('x', cause)) === null));
  t.ok('不可能の検査: 「確かめていない」・Issue の番号を理由に書いた impossible を落とす（手段があるなら todo）',
    /must not say/.test(stateProblems({ title: impossible('口を確かめていない', 'upstream') }))
    && /must not say/.test(stateProblems({ title: impossible('まだ確かめていない', 'design') }))
    && /must not say/.test(stateProblems({ title: impossible('#180 で扱う', 'upstream') }))
    && capabilityProblem('title', todo('#180')) === null);
  // required の印は、現役のエージェントなら対応の値だけ（impossible・todo は RETIRED のほかは落とす）
  const requiredKeys = CAPABILITY_KEYS.filter((key) => CAPABILITIES[key].required);
  t.ok('必須の印の検査: required の印を impossible・todo・covered にしたら落とす（対応を終えたバックエンドの印は通る）',
    requiredKeys.length > 0 && requiredKeys.every((key) => /required for every active agent/.test(stateProblems({ [key]: todo('#1') }))
      && /required for every active agent/.test(stateProblems({ [key]: impossible('x', 'upstream') }))
      && !new RegExp(`${key} is required`).test(stateProblems({ [key]: true }))
      && capabilityProblem(key, NO_CAPABILITIES[key]) === null));
  // サブエージェントを持つなら、委譲のツール名（subagentTools）か、申告できない理由（subagentToolsAbsent）のどちらかを書く
  const subagentMembers = { listSubagents: async () => [], getSubagentMessages: async () => [] };
  t.ok('サブエージェントの申告の検査: 対応なのにツール名も理由も無い・空のものを落とし、どちらかがあれば通す',
    /neither subagentTools .* nor subagentToolsAbsent/.test(stateProblems({ subagents: true }, subagentMembers))
    && /neither subagentTools/.test(stateProblems({ subagents: true }, { ...subagentMembers, subagentTools: [] }))
    && /neither subagentTools/.test(stateProblems({ subagents: true }, { ...subagentMembers, subagentToolsAbsent: ' ' }))
    && checkBackendShape(withCaps({ subagents: true }, { ...subagentMembers, subagentTools: ['Task'] })).length === 0
    && checkBackendShape(withCaps({ subagents: true }, { ...subagentMembers, subagentToolsAbsent: '子を別の経路で読む' })).length === 0
    && !/subagentTools/.test(stateProblems({ subagents: impossible('x', 'design') })));
  t.ok('印に要るメソッド: compact=true で compact() が無いと落ちる（Claude は prompt）',
    /compact=true needs compact/.test(stateProblems({ compact: true }))
    && checkBackendShape(withCaps({ compact: 'prompt' })).length === 0);
  t.ok('印に要るメソッド: forkMessage=true には fork が要る', /forkMessage=true needs fork/.test(stateProblems({ forkMessage: true })));
  t.ok('性質の検査: true / false だけを通し、状態を持てない',
    traitProblem('promptDelivery', true) === null && traitProblem('promptDelivery', false) === null
    && /true or false/.test(traitProblem('promptDelivery', impossible('x', 'design')))
    && /not in .*TRAITS/.test(traitProblem('no-such-trait', true)));
  const missingTrait = { ...base, traits: { ...NO_TRAITS } };
  delete missingTrait.traits.promptDelivery;
  t.ok('性質の案内: どのファイルに true / false を書くかを出す',
    /trait promptDelivery has no value \(write true or false for state-check in core\/backends\/agent-marks\.mjs\)/.test(checkBackendShape(missingTrait).join('\n')));
  const stateTrait = { ...base, traits: { ...NO_TRAITS, promptDelivery: impossible('x', 'design') } };
  t.ok('性質に状態（impossible など）を書けない', /trait promptDelivery value .* is not allowed \(true or false\)/.test(checkBackendShape(stateTrait).join('\n')));
  t.ok('状態から今までの値を引く: 対応はそのまま、covered・impossible・todo は false',
    capabilityValue(true) === true && capabilityValue('host') === 'host' && capabilityValue('prompt') === 'prompt'
    && capabilityValue(covered) === false && capabilityValue(impossible('x', 'design')) === false && capabilityValue(todo('#1')) === false
    && JSON.stringify(legacyCapabilities({ title: covered, shell: 'host', compact: 'prompt', hooks: todo('#98') }))
      === JSON.stringify({ title: false, shell: 'host', compact: 'prompt', hooks: false }));

  const broken = { ...base, capabilities: { ...NO_CAPABILITIES, fork: true, extra: 1 }, setModelLive: async () => true };
  delete broken.capabilities.tag;
  const problems = checkBackendShape(broken).join('\n');
  t.ok('形の検査: 書いていない印・一覧に無い印・印に要るメソッドの欠け・メソッドがあるのに対応でない印を落とす',
    /tag has no state/.test(problems) && /extra is not in core\/backends\/capability-marks\.mjs CAPABILITIES/.test(problems)
    && /fork=true needs fork/.test(problems) && /setModelLive\(\) exists but liveModel is not true/.test(problems), problems);

  const missing = withCaps({});
  delete missing.capabilities.hooks;
  const missingProblems = checkBackendShape(missing).join('\n');
  t.ok('印を足したときの案内: どのファイルに何を書くかを出す',
    /hooks has no state \(write true, or impossible\('reason'\), todo\('#Issue'\) for state-check in core\/backends\/agent-marks\.mjs\)/.test(missingProblems), missingProblems);

  // イベントの検査そのもの
  t.ok('イベントの検査: 契約どおりのものは通す', ['session', 'text.delta', 'turnResult'].every((type) => Object.hasOwn(BACKEND_EVENTS, type))
    && checkBackendEvent({ type: 'session', sessionId: 's' }) === null && checkBackendEvent({ type: 'turnResult', outcome: 'limited' }) === null
    && checkBackendEvent({ type: 'tool.start', id: 'a', name: 'Bash', input: {} }) === null);
  t.ok('イベントの検査: 知らない種類・欠けたフィールド・許されない値・ターンの外で出せないものを落とす',
    /event type/.test(checkBackendEvent({ type: 'permission' })) && /text/.test(checkBackendEvent({ type: 'text.delta' }))
    && /outcome/.test(checkBackendEvent({ type: 'turnResult', outcome: 'done' })) && /outside a turn/.test(checkBackendEvent({ type: 'text.delta', text: 'x' }, { outsideTurn: true }))
    && /without type/.test(checkBackendEvent(null)));
}
