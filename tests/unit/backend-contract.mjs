// バックエンドの契約（core/backends/contract.mjs）の静的な検査: 全エージェントの能力の印の明示・印とメソッドの食い違い・
// エージェントの記述（core/backends/agents.mjs）のキー・印ごとの契約の試験と説明の置き場・身代わり・対応表の文書が最新か。
// 動かして確かめる共通の契約は tests/unit/backend-conformance.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, CAPABILITY_KEYS, NO_CAPABILITIES, BACKEND_EVENTS, checkBackendShape, checkBackendEvent } from '../../core/backends/contract.mjs';
import { AGENTS, DESCRIPTOR_KEYS, DEFAULT_AGENT_IDS, idleCompactionKey } from '../../core/backends/agents.mjs';
import { CAPABILITY_CONTRACTS, RIGS } from '../lib/backend-contracts.mjs';
import { ABOUT, MATRIX_FILE, loadNatives, renderMatrix } from '../lib/backend-matrix.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'backend-contract';
export const title = 'バックエンドの契約: 能力の印を全部明示する・印とメソッドが合う・記述のキー・印ごとの契約の試験・対応表が最新';

export default async function (t) {
  const natives = await loadNatives();
  for (const [id, native] of Object.entries(natives)) {
    const problems = checkBackendShape(native);
    t.ok(`${id}: 能力の印を全部明示し、印とメソッドが合う`, problems.length === 0, problems.join(' / '));
    t.ok(`${id}: id が記述のキーと同じ`, native.id === id, String(native.id));
  }
  t.ok('何も持たない能力（対応を終えたバックエンド）も全部のキーを持ち、値が許される形', CAPABILITY_KEYS.every((k) => Object.hasOwn(NO_CAPABILITIES, k) && CAPABILITIES[k].valid(NO_CAPABILITIES[k]))
    && Object.keys(NO_CAPABILITIES).length === CAPABILITY_KEYS.length);

  for (const [id, a] of Object.entries(AGENTS)) {
    const missing = DESCRIPTOR_KEYS.filter((k) => !Object.hasOwn(a, k));
    const extra = Object.keys(a).filter((k) => !DESCRIPTOR_KEYS.includes(k));
    t.ok(`${id}: 記述のキーを全部書く（使わないものは null）`, missing.length === 0 && extra.length === 0, JSON.stringify({ missing, extra }));
    t.ok(`${id}: 身代わり（tests/lib/backend-contracts.mjs の RIGS）がある`, typeof RIGS[id] === 'function');
    if (a.cli) t.ok(`${id}: CLI の記述に exe・binEnv・installUrl がある`, typeof a.cli.exe === 'string' && /^AGENT_HOST_[A-Z_]+_BIN$/.test(a.cli.binEnv) && /^https:\/\//.test(a.cli.installUrl));
    const key = idleCompactionKey(id);
    t.ok(`${id}: 自動の圧縮の行は、compact を持つときだけ（行の無い compact は黙って自動の圧縮が動かない）`,
      Boolean(key) === Boolean(natives[id]?.capabilities?.compact), JSON.stringify({ key, compact: natives[id]?.capabilities?.compact }));
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
    const named = CAPABILITY_CONTRACTS[key] ?? [];
    const unknown = named.filter((n) => n !== 'conformance' && !suiteNames.has(n));
    t.ok(`印 ${key}: 契約の試験があり、名前の suite が登録されている`, named.length > 0 && unknown.length === 0, JSON.stringify({ named, unknown }));
    t.ok(`印 ${key}: 対応表の説明がある`, typeof ABOUT[key] === 'string' && ABOUT[key].length > 0);
  }
  t.ok('契約の試験・説明に、一覧に無い印が無い', Object.keys(CAPABILITY_CONTRACTS).every((k) => CAPABILITY_KEYS.includes(k)) && Object.keys(ABOUT).every((k) => CAPABILITY_KEYS.includes(k)));

  // 対応表の文書が今の印と一致する
  const doc = readFileSync(MATRIX_FILE, 'utf8').replace(/\r\n/g, '\n');
  t.ok('docs/backend-matrix.md が今の能力の印と一致する（node tests/lib/backend-matrix.mjs --write）', doc === renderMatrix(natives));

  // イベントの検査そのもの
  t.ok('イベントの検査: 契約どおりのものは通す', ['session', 'text.delta', 'turnResult'].every((type) => Object.hasOwn(BACKEND_EVENTS, type))
    && checkBackendEvent({ type: 'session', sessionId: 's' }) === null && checkBackendEvent({ type: 'turnResult', outcome: 'limited' }) === null
    && checkBackendEvent({ type: 'tool.start', id: 'a', name: 'Bash', input: {} }) === null);
  t.ok('イベントの検査: 知らない種類・欠けたフィールド・許されない値・ターンの外で出せないものを落とす',
    /event type/.test(checkBackendEvent({ type: 'permission' })) && /text/.test(checkBackendEvent({ type: 'text.delta' }))
    && /outcome/.test(checkBackendEvent({ type: 'turnResult', outcome: 'done' })) && /outside a turn/.test(checkBackendEvent({ type: 'text.delta', text: 'x' }, { outsideTurn: true }))
    && /without type/.test(checkBackendEvent(null)));
  const broken = { id: 'broken', label: 'B', capabilities: { ...NO_CAPABILITIES, fork: true, extra: 1 }, modes: () => ({}), models: async () => ({}), listSessions: async () => [], getSession: async () => null, getMessages: async () => [], runTurn: async () => ({}), setModelLive: async () => true };
  delete broken.capabilities.tag;
  const problems = checkBackendShape(broken).join('\n');
  t.ok('形の検査: 書いていない印・一覧に無い印・印に要るメソッドの欠け・メソッドがあるのに false の印を落とす',
    /tag has no value/.test(problems) && /extra is not in/.test(problems) && /fork=true needs fork/.test(problems) && /setModelLive but liveModel is false/.test(problems));
}
