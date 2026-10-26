// バックエンドの契約（docs/multi-backend.md §2.3、ADR 0273・0274）。SDK にもネットワークにも依存しない。
//
// 能力の印と性質の定義・状態・利用者向けの説明は core/backends/capability-marks.mjs（公開文書の生成も読む軽いファイル）。
// エージェントごとの状態は core/backends/agent-marks.mjs。ここは契約の検査（形・値・要るメソッド）とイベントの検査を持つ。
//
// 1. 能力の印（CAPABILITIES）: バックエンドは**全部のキーに状態を書く**。状態は 4 つ:
//    対応（true・'host'・'native'・'turn' などの値）/ covered（Pleiad の共通処理が補う）/
//    impossible('理由')（技術的に無理・該当しない）/ todo('#Issue')（手段はあるが未実装）。
//    false は書かない。書いていないことを「対応しない」の代わりにしない（tests/unit/backend-contract.mjs が落とす）。
//    現役のエージェントは NO_CAPABILITIES を使えない（対応を終えたバックエンドだけ）。
//    印を足すときは、capability-marks.mjs に 1 行足し、全バックエンドに状態を書き、一覧の説明（tests/lib/backend-matrix.mjs の ABOUT）と
//    印の契約の試験（tests/lib/backend-contracts.mjs）を足す。未実装（todo）は tests/backend-todos.json の基準より増やせない。
//    server・画面へは、レジストリ（core/backends/index.mjs）が状態を今までの値へ引いて渡す（legacyCapabilities）。
// 2. 性質（TRAITS）: 機能ではなくエージェントの特徴。true / false だけで書き、状態は持たない（ADR 0274）。
//    server・bot・委譲の振り分けが backend.traits から読み、画面へは出さない。
// 3. バックエンドが出すイベント（BACKEND_EVENTS）: runTurn の emit・compact の emit・attachHost の host.event に渡してよい種類と、
//    必ず付けるフィールド。試験のサーバーは PLEIAD_BACKEND_CONTRACT=strict で受け口ごとに確かめ、外れたら [backend-contract] の行を出す
//    （tests/lib/server.mjs が拾い、stop() で落とす）。
import { CAPABILITIES, CAPABILITY_KEYS, TRAITS, TRAIT_KEYS, capabilityValue, isCapabilityState } from './capability-marks.mjs';

export {
  CAPABILITIES, CAPABILITY_KEYS, CAPABILITY_DOCS, TRAITS, TRAIT_KEYS, NO_TRAITS,
  covered, impossible, todo, isCapabilityState, capabilityValue, legacyCapabilities,
} from './capability-marks.mjs';

/** 対応の値の検査。v が許される形なら true */
const oneOf = (...values) => (v) => values.includes(v);
const bool = oneOf(true, false);

/** 印の値の説明（落ちたときの文に出す） */
function expectedOf(spec) {
  const states = spec.covered ? "covered, impossible('reason'), todo('#Issue')" : "impossible('reason'), todo('#Issue')";
  return spec.absent === undefined ? spec.hint : `${spec.hint}, or ${states}`;
}

/**
 * 印の値の違反（無ければ null）。状態の理由・Issue の形もここで見る。
 * checkBackendShape が id とファイルを添えて出す。
 */
export function capabilityProblem(key, value) {
  const spec = CAPABILITIES[key];
  if (!spec) return `capability ${key} is not in core/backends/capability-marks.mjs CAPABILITIES`;
  if (isCapabilityState(value)) {
    if (spec.absent === undefined) return `capability ${key} cannot be a state (${spec.hint})`;
    if (!['covered', 'impossible', 'todo'].includes(value.state)) return `capability ${key} has unknown state ${JSON.stringify(value.state)} (use covered, impossible('reason'), or todo('#Issue'))`;
    if (value.state === 'covered' && !spec.covered) return `capability ${key} cannot be covered (Pleiad has no common fallback; use impossible('reason') or todo('#Issue'))`;
    if (value.state === 'impossible' && !(typeof value.reason === 'string' && value.reason.trim())) return `capability ${key} impossible needs a reason (impossible('reason'))`;
    if (value.state === 'todo' && !/^#\d+$/.test(String(value.issue ?? ''))) return `capability ${key} todo needs an issue number (todo('#98'))`;
    return null;
  }
  return spec.valid(value) ? null : `capability ${key} value ${JSON.stringify(value)} is not allowed (${expectedOf(spec)})`;
}

/**
 * 性質の値の違反（無ければ null）。状態は持てない（true / false だけ）。
 * checkBackendShape が id とファイルを添えて出す。
 */
export function traitProblem(key, value) {
  if (!TRAITS[key]) return `trait ${key} is not in core/backends/capability-marks.mjs TRAITS`;
  return typeof value === 'boolean' ? null : `trait ${key} value ${JSON.stringify(value)} is not allowed (true or false)`;
}

/** 何も持たない能力（対応を終えたバックエンドだけが使う。core/backends/index.mjs の retiredBackend） */
const RETIRED = Object.freeze({ state: 'impossible', reason: '対応を終えた' }); // i18n-ignore: 対応を終えたバックエンドの理由（開発者向け。利用者向けの文は #149）
export const NO_CAPABILITIES = Object.freeze(Object.fromEntries(CAPABILITY_KEYS.map((key) => [key,
  key === 'approvals' ? 'none' : key === 'mcpApproval' ? 'agent' : RETIRED])));

/** バックエンドの必須のメンバー（retiredBackend が持つ最小の形） */
export const REQUIRED_MEMBERS = ['id', 'label', 'capabilities', 'modes', 'models', 'listSessions', 'getSession', 'getMessages', 'runTurn'];

/**
 * バックエンドの形の検査。違反の文の配列を返す（空なら守っている）。
 * native はラップ前（core/backends/<id>.mjs の backend）を渡す。ラップ後は fork などを足すので、requires の検査が甘くなる
 */
export function checkBackendShape(native) {
  const problems = [];
  const id = native?.id ?? '(no id)';
  const file = `core/backends/${id}.mjs`;
  const marksFile = 'core/backends/agent-marks.mjs';
  for (const key of REQUIRED_MEMBERS) if (native?.[key] === undefined) problems.push(`${id}: required member ${key} is missing (${file})`);
  const caps = native?.capabilities ?? {};
  for (const key of CAPABILITY_KEYS) {
    if (!Object.hasOwn(caps, key)) {
      problems.push(`${id}: capability ${key} has no state (write ${expectedOf(CAPABILITIES[key])} for ${id} in ${marksFile})`);
      continue;
    }
    const value = caps[key];
    const problem = capabilityProblem(key, value);
    if (problem) { problems.push(`${id}: ${problem} (write it for ${id} in ${marksFile})`); continue; }
    const spec = CAPABILITIES[key];
    if (isCapabilityState(value)) {
      for (const member of spec.coveredRequires ?? []) {
        if (value.state === 'covered' && native[member] === undefined) problems.push(`${id}: ${key}=covered needs ${member} (Pleiad has no fallback; ${file})`);
      }
      continue;
    }
    for (const member of spec.requires?.(value) ?? []) {
      if (native[member] === undefined) problems.push(`${id}: ${key}=${JSON.stringify(value)} needs ${member} (${file})`);
    }
  }
  for (const key of Object.keys(caps)) if (!Object.hasOwn(CAPABILITIES, key)) problems.push(`${id}: capability ${key} is not in core/backends/capability-marks.mjs CAPABILITIES (add it to the list or remove it from ${marksFile} (${id}))`);
  // 性質は能力ではない。true / false だけを全部書く（状態は持てない。false は未対応ではない）
  const traits = native?.traits ?? {};
  for (const key of TRAIT_KEYS) {
    if (!Object.hasOwn(traits, key)) {
      problems.push(`${id}: trait ${key} has no value (write true or false for ${id} in ${marksFile})`);
      continue;
    }
    const problem = traitProblem(key, traits[key]);
    if (problem) problems.push(`${id}: ${problem} (write it for ${id} in ${marksFile})`);
  }
  for (const key of Object.keys(traits)) if (!Object.hasOwn(TRAITS, key)) problems.push(`${id}: trait ${key} is not in core/backends/capability-marks.mjs TRAITS (add it to the list or remove it from ${marksFile} (${id}))`);
  // 印とメソッドの逆向き: メソッドがあるのに印が対応（true）でないと、画面がその機能を出さない（書いたのに使われない）
  for (const [member, key] of [['setModelLive', 'liveModel'], ['setModeLive', 'liveMode'], ['setTitle', 'title'], ['setTag', 'tag'], ['fork', 'fork'], ['compact', 'compact']]) {
    if (typeof native?.[member] === 'function' && caps[key] !== true) {
      problems.push(`${id}: ${member}() exists but ${key} is not true (${file}; set ${key} to true for ${id} in ${marksFile} or remove the method)`);
    }
  }
  if (typeof native?.shell === 'function' && caps.shell !== 'native') problems.push(`${id}: shell() exists but shell is not 'native' (${file}; set shell to 'native' for ${id} in ${marksFile} or remove the method)`);
  return problems;
}

// ---- バックエンドが出すイベント ----------------------------------------------------------

const str = (v) => typeof v === 'string';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const optional = (check) => (v) => v === undefined || v === null || check(v);

/**
 * バックエンドが emit してよいイベントと、フィールドの検査（必須は check をそのまま、無くてよいものは optional で包む）。
 * ここに無い種類はバックエンドから出さない。画面へ出すイベントの一覧（core/protocol.mjs の EVENTS）とは別で、server が作るもの
 * （permission・turnEnd など）は入れない。意味は docs/multi-backend.md §2.2
 */
export const BACKEND_EVENTS = {
  session: { sessionId: str, first: optional(bool), model: optional(str) },
  'text.delta': { text: str },
  'text.end': { uuid: optional(str) },
  'thinking.start': {},
  'thinking.delta': { text: optional(str), estimatedTokens: optional(num) },
  'tool.start': { id: str, name: str },
  'tool.result': { id: str, isError: optional(bool), truncated: optional(bool) },
  // retrying はエージェントが API の失敗（上限・混雑）で再試行を待っている。retry: { attempt, next（epoch ms）, message, reason, limit }（ADR 0229）
  activity: { state: oneOf('thinking', 'writing', 'compacting', 'waiting', 'running', 'idle', 'preparing', 'retrying'),
    retry: optional((v) => typeof v === 'object' && optional(num)(v.next) && optional(num)(v.attempt)) },
  // resetsAt は limited の解ける時刻（epoch ms の数。文字列は server が読めず捨てる）
  turnResult: { outcome: oneOf('ok', 'error', 'aborted', 'limited'), resetsAt: optional(num) },
  usage: {},
  contextWindow: { usedTokens: num, windowTokens: num },
  contextBase: { tokens: num },
  compaction: { phase: oneOf('start', 'complete', 'failed', 'summary') },
  background: { tasks: Array.isArray },
  phase: { state: oneOf('active', 'waiting') },
  // nativeId: 渡った発言のネイティブ履歴の id（分かるバックエンドだけ。保存の照合に使う）
  'userMessage.delivered': { messageId: str, nativeId: optional(str) },
  'userMessage.dropped': { messageId: str },
  promptSuggestion: { text: str },
  hookRun: { phase: oneOf('started', 'response') },
  // 裏のコマンドの様子（server が委譲のタスクの見張りに使い、画面へは流さない）。id はツールの呼び出しの id で、無いこともある。
  // state はバックエンドの語彙（stopped / completed / unknown / background / running など）のまま
  'task.activity': {},
  'task.command': { id: optional(str), state: optional(str) },
  // 成果物の提示（server の makeEmit が記録する）
  present: { kind: optional(str) },
  // ターンの中のログイン（auth.login の emit と同じ形）
  auth: { phase: oneOf('url', 'done', 'error') },
};

/** ターンの外（attachHost の host.event）で出してよい種類（server.mjs の受け口と揃える） */
export const OUTSIDE_TURN_EVENTS = new Set(['tool.result', 'task.command', 'task.activity']);

/** 1 つのイベントの検査。違反の文（無ければ null） */
export function checkBackendEvent(event, { outsideTurn = false } = {}) {
  const type = event?.type;
  if (!str(type)) return `event without type: ${safe(event)}`;
  const spec = BACKEND_EVENTS[type];
  if (!spec) return `backends do not emit this event type: ${type}`;
  if (outsideTurn && !OUTSIDE_TURN_EVENTS.has(type)) return `event type not allowed outside a turn: ${type}`;
  for (const [field, check] of Object.entries(spec)) {
    if (!check(event[field])) return `${type}.${field} breaks the contract: ${safe(event[field])}`;
  }
  return null;
}

function safe(v) {
  try { return JSON.stringify(v)?.slice(0, 160) ?? String(v); } catch { return String(v); }
}

// ---- runArgs の配達物 ----------------------------------------------------------
//
// runArgs のキーは 2 種類に分かれる。
//   RUN_ARG_FEATURES … 機能の配達物。バックエンドが受け取れるかは能力の印が決め、印の無いバックエンドには server が渡さない。
//   RUN_ARG_PLUMBING … どのバックエンドにも渡る、会話を動かすためのもの（発言・cwd・承認・中断の合図など）。
// runArgs に配達物を足すときは、能力の印を足して RUN_ARG_FEATURES に書く。印の無い配達物は、受け取らないバックエンドが
// 黙って捨てても気づけないので、ここで強制する（checkRunArgs。tests/unit/backend-contract.mjs が各バックエンドの参照も確かめる）。

export const RUN_ARG_FEATURES = Object.freeze({
  browserEnv: 'browser', browserInstructions: 'browser', browserRuntime: 'browser',
  computerRuntime: 'computerUse', controlRuntime: 'plyControl', secretsRuntime: 'secrets',
  shellRuntime: 'plyShell', agentRuntime: 'plyAgents', contextRuntime: 'plyContext',
  addedInstructions: 'plyInstructions',
  visualizeInstructions: 'visualize', hooksRuntime: 'hooks',
});

/** runArgs に載ってよい、配達物でないキー。新しいキーを足すときは配達物なら RUN_ARG_FEATURES へ、どのバックエンドにも必要ならここへ */
export const RUN_ARG_PLUMBING = Object.freeze(new Set([
  // scanOptions: コンテキスト探索の置き場（home など）。探索するバックエンド（agy のネイティブ指示の注入）だけが使う。
  // 試験で home を差し替えるための配管で、能力の配達物ではない
  'scanOptions',
  'prompt', 'sessionId', 'messageId', 'cwd', 'mode', 'model', 'effort', 'emit', 'onPromptDelivered', 'askPermission', 'hostInvoke',
  'signal', 'control', 'locale', 'delegatedChild', 'notes', 'shellAppends', 'botInstructions', 'botFolders',
  'compact', 'oauthToken', 'account', 'endpoint', 'autoCompactWindow', 'promptSuggestions',
  'hostSessionId', 'hostBackend', 'ephemeral', 'rewind', 'card', 'source', 'trigger',
  'authorize', 'backend', 'isActive', 'origin', 'progress',
]));

/**
 * runArgs の配達物を能力の印で絞り、一覧に無いキーを拒否する（server.mjs が runArgs を確定する前に通す）。
 * 印の無い配達物は消す（状態は capabilityValue で今までの値に引く。渡されなかったときの既定値はバックエンド側が持つ）。
 * 一覧に無いキーは、試験（strict）では例外、通常はログだけ残す。
 */
export function gateRunArgs(runArgs, capabilities, { strict = strictContract(), log = console.error } = {}) {
  for (const key of Object.keys(runArgs)) {
    if (RUN_ARG_PLUMBING.has(key)) continue;
    const flag = RUN_ARG_FEATURES[key];
    if (flag === undefined) {
      // i18n-ignore: 開発者向けの契約エラー（ログ・試験の失敗にだけ出る。利用者には見えない）
      const message = `runArgs.${key} は RUN_ARG_FEATURES・RUN_ARG_PLUMBING のどちらにも無い（core/backends/contract.mjs に登録する）`;
      if (strict) throw new Error(message);
      log(`[backend-contract] ${message}`);
      continue;
    }
    if (!capabilityValue(capabilities?.[flag])) delete runArgs[key];
  }
  return runArgs;
}

/** 試験のサーバーで、受け口ごとに確かめるか（PLEIAD_BACKEND_CONTRACT=strict。tests/lib/server.mjs が付ける） */
export const strictContract = () => process.env.PLEIAD_BACKEND_CONTRACT === 'strict';

/**
 * emit を包み、契約に外れたイベントを [backend-contract] の行で知らせる（strict のときだけ。イベントは止めずに流す）。
 * 同じ違反は包んだ emit ごとに 1 回だけ出す
 */
export function contractEmit(emit, backendId, { outsideTurn = false } = {}) {
  if (!strictContract() || typeof emit !== 'function') return emit;
  const seen = new Set();
  return (event, ...rest) => {
    const problem = checkBackendEvent(event, { outsideTurn });
    if (problem && !seen.has(problem)) {
      seen.add(problem);
      console.error(`[backend-contract] ${backendId}: ${problem}`);
    }
    return emit(event, ...rest);
  };
}
