// バックエンドの契約（core/backends/contract.mjs）の静的な検査: 全エージェントの能力の印の状態・印とメソッドの食い違い・
// エージェントの記述（core/backends/agents.mjs）のキー・印ごとの契約の試験と説明の置き場・身代わり・未実装のラチェット。
// 動かして確かめる共通の契約は tests/unit/backend-conformance.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY_KEYS, NO_CAPABILITIES, BACKEND_EVENTS, RUN_ARG_FEATURES,
  checkBackendShape, checkBackendEvent, capabilityProblem, capabilityValue, covered, impossible, legacyCapabilities, todo,
} from '../../core/backends/contract.mjs';
import { AGENTS, DESCRIPTOR_KEYS, DEFAULT_AGENT_IDS, idleCompactionKey } from '../../core/backends/agents.mjs';
import { CAPABILITY_CONTRACTS, RIGS } from '../lib/backend-contracts.mjs';
import { DELIVERY_ARG_KEYS, DELIVERY_CAPABILITIES, DELIVERY_PROBES, deliveryArgs, deliveryContractProblem, deliveryRequired } from '../lib/backend-delivery.mjs';
import { ABOUT, loadNatives, renderMatrix } from '../lib/backend-matrix.mjs';
import { checkTodos, collectTodos, readTodosBaseline, updateTodosBaseline } from '../lib/backend-todos.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'backend-contract';
export const title = 'バックエンドの契約: 能力の印を 4 つの状態で全部書く・印とメソッドが合う・記述のキー・印ごとの契約の試験・未実装のラチェット';

export default async function (t) {
  const natives = await loadNatives();
  for (const [id, native] of Object.entries(natives)) {
    const problems = checkBackendShape(native);
    t.ok(`${id}: 能力の印を 4 つの状態で全部書き、印とメソッドが合う`, problems.length === 0, problems.join(' / '));
    t.ok(`${id}: id が記述のキーと同じ`, native.id === id, String(native.id));
  }
  // 共通の配達機能を状態に戻しても形の検査だけでは通るため、製品としての最低限を別に守る。
  for (const id of DEFAULT_AGENT_IDS) for (const key of ['plyInstructions', 'plyAgents', 'browser', 'plyControl', 'secrets']) {
    t.ok(`${id}: 共通機能 ${key} を受け取れる`, Boolean(capabilityValue(natives[id].capabilities[key])), JSON.stringify(natives[id].capabilities[key]));
  }
  t.ok('何も持たない能力（対応を終えたバックエンド）も全部のキーを持ち、値が許される形',
    CAPABILITY_KEYS.every((k) => Object.hasOwn(NO_CAPABILITIES, k) && capabilityProblem(k, NO_CAPABILITIES[k]) === null)
    && Object.keys(NO_CAPABILITIES).length === CAPABILITY_KEYS.length);
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
    t.ok(`${id}: 身代わり（tests/lib/backend-contracts.mjs の RIGS）がある`, typeof RIGS[id] === 'function');
    t.ok(`${id}: hooksVia は hooksAs のエージェントだけが書き、'callback' か 'plugin'`, a.hooksAs ? ['callback', 'plugin'].includes(a.hooksVia) : a.hooksVia === null, String(a.hooksVia));
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

  // 印ごとの契約の試験と説明（印を足して、試験・説明を書き忘れたら落とす）
  const suites = new Set([...readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8').matchAll(/'\.\/unit\/([\w.-]+)\.mjs'/g)].map((m) => m[1]));
  const suiteNames = new Set([...suites].map((file) => {
    const text = readFileSync(path.join(ROOT, 'tests', 'unit', `${file}.mjs`), 'utf8');
    return /export const name = ['"]([^'"]+)['"]/.exec(text)?.[1] ?? file;
  }));
  for (const key of CAPABILITY_KEYS) {
    const named = CAPABILITY_CONTRACTS[key]?.suites ?? [];
    const unknown = named.filter((n) => n !== 'conformance' && !suiteNames.has(n));
    t.ok(`印 ${key}: 契約の試験がある（tests/lib/backend-contracts.mjs の CAPABILITY_CONTRACTS に suite 名を書く）`, named.length > 0 && unknown.length === 0, JSON.stringify({ named, unknown }));
    t.ok(`印 ${key}: 一覧の説明がある（tests/lib/backend-matrix.mjs の ABOUT に書く）`, typeof ABOUT[key] === 'string' && ABOUT[key].length > 0);
  }
  // 配達物（runArgs の渡し物）を持つ印は、対応・補うのエージェントごとに「そのエージェントで届く」試験が要る。
  // 新しいエージェント・新しい配達物を足したときに漏れないよう、印の値（対応か）と身代わり（DELIVERY_PROBES）から機械的に決める
  for (const key of DELIVERY_CAPABILITIES) {
    const agents = CAPABILITY_CONTRACTS[key]?.agents ?? {};
    for (const id of DEFAULT_AGENT_IDS) {
      if (!deliveryRequired(natives[id]?.capabilities?.[key])) continue;
      const problem = deliveryContractProblem({ key, id, suite: agents[id], suites: suiteNames, probes: DELIVERY_PROBES,
        file: AGENTS[id].module.replace(/^\.\//, '') });
      t.ok(`印 ${key}: ${id} は対応なので、${id} で届くことを確かめる試験がある`, problem === null, problem ?? undefined);
    }
  }
  const missingDelivery = deliveryContractProblem({ key: 'browser', id: 'nobody', suite: undefined, suites: suiteNames, probes: DELIVERY_PROBES });
  t.ok('配達物の試験が無いときの案内: どのファイルに何を書くかを出す',
    /tests\/lib\/backend-delivery\.mjs/.test(missingDelivery) && /CAPABILITY_CONTRACTS\.browser\.agents\.nobody/.test(missingDelivery)
    && /backend-delivery/.test(missingDelivery), missingDelivery);
  // 新しい配達物のキーを RUN_ARG_FEATURES に足したら、届け方の試験でも渡す（渡していないキーは、黙って捨てられても気づけない）
  const untestedArgs = Object.keys(RUN_ARG_FEATURES).filter((key) => !DELIVERY_ARG_KEYS.includes(key));
  t.ok('配達物の試験: RUN_ARG_FEATURES のキーをすべて渡している（新しいキーは tests/lib/backend-delivery.mjs の DELIVERY_ARG_KEYS と deliveryArgs にも足す）',
    untestedArgs.length === 0, JSON.stringify(untestedArgs));
  const allCaps = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true]));
  const built = deliveryArgs(allCaps, {});
  const unbuilt = DELIVERY_ARG_KEYS.filter((key) => !Object.hasOwn(built, key));
  t.ok('配達物の試験: deliveryArgs が DELIVERY_ARG_KEYS を実際に渡す（一覧だけ足して渡し忘れない）', unbuilt.length === 0, JSON.stringify(unbuilt));
  for (const [key, contract] of Object.entries(CAPABILITY_CONTRACTS)) {
    for (const [id, suite] of Object.entries(contract.agents ?? {})) {
      t.ok(`印 ${key}: エージェント ${id} の試験 ${suite} が実在する`, Object.hasOwn(AGENTS, id) && suiteNames.has(suite),
        `tests/lib/backend-contracts.mjs の CAPABILITY_CONTRACTS.${key}.agents.${id} を、実在するエージェントと suite（tests/run.mjs の名前）にする`);
    }
  }
  t.ok('契約の試験・説明に、一覧に無い印が無い', Object.keys(CAPABILITY_CONTRACTS).every((k) => CAPABILITY_KEYS.includes(k)) && Object.keys(ABOUT).every((k) => CAPABILITY_KEYS.includes(k)));
  const matrix = renderMatrix(natives);
  t.ok('一覧（端末に出す）: 対応・補う・不可能・未実装を出し、不可能の理由と未実装の Issue を添える',
    /\| ✓ \|/.test(matrix) && /補/.test(matrix) && /無理/.test(matrix) && /未実装 #98/.test(matrix)
    && /hooks \| #98/.test(matrix) && /accounts \| OS の共有キーリング/.test(matrix));

  // 状態と値の検査そのもの
  const base = { id: 'state-check', label: 'S', capabilities: { ...NO_CAPABILITIES }, modes: () => ({}), models: async () => ({}),
    listSessions: async () => [], getSession: async () => null, getMessages: async () => [], runTurn: async () => ({}) };
  const withCaps = (over) => ({ ...base, capabilities: { ...base.capabilities, ...over } });
  const stateProblems = (over) => checkBackendShape(withCaps(over)).join('\n');
  t.ok('状態の検査: 理由の無い impossible・Issue の無い todo・補えない covered・false を落とす',
    /impossible needs a reason/.test(stateProblems({ title: impossible('') }))
    && /todo needs an issue number/.test(stateProblems({ title: todo('98') }))
    && /todo needs an issue number/.test(stateProblems({ title: todo('#x') }))
    && /compact cannot be covered/.test(stateProblems({ compact: covered }))
    && /title value false is not allowed/.test(stateProblems({ title: false }))
    && /approvals cannot be a state/.test(stateProblems({ approvals: impossible('x') })));
  t.ok('印に要るメソッド: compact=true で compact() が無いと落ちる（Claude は prompt）',
    /compact=true needs compact/.test(stateProblems({ compact: true }))
    && checkBackendShape(withCaps({ compact: 'prompt' })).length === 0);
  t.ok('印に要るメソッド: forkMessage=true には fork が要る', /forkMessage=true needs fork/.test(stateProblems({ forkMessage: true })));
  t.ok('状態から今までの値を引く: 対応はそのまま、covered・impossible・todo は false',
    capabilityValue(true) === true && capabilityValue('host') === 'host' && capabilityValue('prompt') === 'prompt'
    && capabilityValue(covered) === false && capabilityValue(impossible('x')) === false && capabilityValue(todo('#1')) === false
    && JSON.stringify(legacyCapabilities({ title: covered, shell: 'host', compact: 'prompt', hooks: todo('#98') }))
      === JSON.stringify({ title: false, shell: 'host', compact: 'prompt', hooks: false }));

  const broken = { ...base, capabilities: { ...NO_CAPABILITIES, fork: true, extra: 1 }, setModelLive: async () => true };
  delete broken.capabilities.tag;
  const problems = checkBackendShape(broken).join('\n');
  t.ok('形の検査: 書いていない印・一覧に無い印・印に要るメソッドの欠け・メソッドがあるのに対応でない印を落とす',
    /tag has no state/.test(problems) && /extra is not in core\/backends\/contract\.mjs CAPABILITIES/.test(problems)
    && /fork=true needs fork/.test(problems) && /setModelLive\(\) exists but liveModel is not true/.test(problems), problems);

  const missing = withCaps({});
  delete missing.capabilities.hooks;
  const missingProblems = checkBackendShape(missing).join('\n');
  t.ok('印を足したときの案内: どのファイルに何を書くかを出す',
    /hooks has no state \(write true, or impossible\('reason'\), todo\('#Issue'\) in core\/backends\/state-check\.mjs\)/.test(missingProblems), missingProblems);

  // 未実装（todo）は減る方向にしか動かせない
  const baseline = { todos: { a: { x: '#1' } } };
  t.ok('未実装の基準: 同じなら通る', checkTodos({ a: { x: '#1' } }, baseline).length === 0);
  t.ok('未実装の基準: 増えたら落ちる', checkTodos({ a: { x: '#1', y: '#2' } }, baseline).some((p) => p.rule === 'increased'));
  t.ok('未実装の基準: 減ったら基準を下げさせる', checkTodos({}, baseline).some((p) => p.rule === 'decreased'));
  t.ok('未実装の基準: Issue が変わったら基準を更新させる', checkTodos({ a: { x: '#2' } }, baseline).some((p) => p.rule === 'changed'));
  const todoDir = mkdtempSync(path.join(os.tmpdir(), 'pleiad-todos-'));
  const todoFile = path.join(todoDir, 'todos.json');
  try {
    writeFileSync(todoFile, JSON.stringify({ todos: { a: { x: '#1' } } }));
    t.ok('未実装の基準の更新: 増える更新は拒む',
      updateTodosBaseline({ a: { x: '#1', y: '#2' } }, { file: todoFile }).ok === false
      && JSON.parse(readFileSync(todoFile, 'utf8')).todos.a.y === undefined);
    t.ok('未実装の基準の更新: 減る更新は通す',
      updateTodosBaseline({ a: { x: '#1' } }, { file: todoFile }).ok === true
      && JSON.parse(readFileSync(todoFile, 'utf8')).todos.a.x === '#1');
  } finally {
    rmSync(todoDir, { recursive: true, force: true });
  }
  const todoProblems = checkTodos(collectTodos(natives), readTodosBaseline());
  t.ok('未実装（todo）は基準（tests/backend-todos.json）より増えない', todoProblems.length === 0, todoProblems.map((p) => p.message).join(' / '));

  // イベントの検査そのもの
  t.ok('イベントの検査: 契約どおりのものは通す', ['session', 'text.delta', 'turnResult'].every((type) => Object.hasOwn(BACKEND_EVENTS, type))
    && checkBackendEvent({ type: 'session', sessionId: 's' }) === null && checkBackendEvent({ type: 'turnResult', outcome: 'limited' }) === null
    && checkBackendEvent({ type: 'tool.start', id: 'a', name: 'Bash', input: {} }) === null);
  t.ok('イベントの検査: 知らない種類・欠けたフィールド・許されない値・ターンの外で出せないものを落とす',
    /event type/.test(checkBackendEvent({ type: 'permission' })) && /text/.test(checkBackendEvent({ type: 'text.delta' }))
    && /outcome/.test(checkBackendEvent({ type: 'turnResult', outcome: 'done' })) && /outside a turn/.test(checkBackendEvent({ type: 'text.delta', text: 'x' }, { outsideTurn: true }))
    && /without type/.test(checkBackendEvent(null)));
}
