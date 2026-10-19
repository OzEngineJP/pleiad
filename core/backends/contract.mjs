// バックエンドの契約の正本（docs/multi-backend.md §2.3）。SDK にもネットワークにも依存しない。
//
// 1. 能力の印（CAPABILITIES）: バックエンドは**全部のキーに値を書く**。対応しないものは false などで明示し、
//    書いていないことを「対応しない」の代わりにしない（tests/unit/backend-contract.mjs が落とす）。
//    印を足すときは、ここに 1 行足し、全バックエンドに値を書き、対応表の説明（tests/lib/backend-matrix.mjs の ABOUT）と
//    印の契約の試験（tests/lib/backend-contracts.mjs）を足す。どれかが欠けると npm test の backend-contract が落とす。
// 2. バックエンドが出すイベント（BACKEND_EVENTS）: runTurn の emit・compact の emit・attachHost の host.event に渡してよい種類と、
//    必ず付けるフィールド。試験のサーバーは PLEIAD_BACKEND_CONTRACT=strict で受け口ごとに確かめ、外れたら [backend-contract] の行を出す
//    （tests/lib/server.mjs が拾い、stop() で落とす）。

/** 値の形の検査。v が許される形なら true */
const oneOf = (...values) => (v) => values.includes(v);
const bool = oneOf(true, false);

/**
 * 能力の印。valid は許される値、requires は「この値ならこのメソッドが要る」（無ければ契約違反）。
 * 意味は対応表（docs/backend-matrix.md。説明は tests/lib/backend-matrix.mjs の ABOUT）
 */
export const CAPABILITIES = {
  // ネイティブにタイトル・状態タグを持つ（無ければ Pleiad の控えが正本）
  title: { valid: bool, requires: (v) => (v ? ['setTitle'] : []) },
  tag: { valid: bool, requires: (v) => (v ? ['setTag'] : []) },
  // ネイティブに分岐できる（無ければ Pleiad が写して分ける）。forkMessage は発言の途中まで（upToMessageId）
  fork: { valid: bool, requires: (v) => (v ? ['fork'] : []) },
  forkMessage: { valid: bool },
  // 同じ会話で巻き戻す形（resumeAt: 次のターンで切る / thread: rewind() で今切る / false: Pleiad が写す。core/conversations.mjs の rewind）
  rewind: { valid: oneOf(false, 'resumeAt', 'thread'), requires: (v) => (v === 'thread' ? ['rewind'] : []) },
  subagents: { valid: bool, requires: (v) => (v ? ['listSubagents', 'getSubagentMessages'] : []) },
  // 走っている最中にモデル・承認モードを替えられる
  liveModel: { valid: bool, requires: (v) => (v ? ['setModelLive'] : []) },
  liveMode: { valid: bool, requires: (v) => (v ? ['setModeLive'] : []) },
  // set_status / set_title / fork を AI 側から呼べる（§2.6）
  hostTools: { valid: bool },
  // 対話の承認（askPermission）を使う。none は承認モードが確認なししか無い（agy）。コンピューターの操作のアプリの承認も聞かない
  approvals: { valid: oneOf('interactive', 'none') },
  alwaysAllow: { valid: bool },
  // MCP のツールの承認。host は、エージェント自身が聞かないので、確認なしの承認モード（autonomy: full）のほかは Pleiad が聞く（Codex）
  mcpApproval: { valid: oneOf('agent', 'host') },
  login: { valid: bool, requires: (v) => (v ? ['auth'] : []) },
  // 会話ごとにアカウントを選べる（ADR 0222）。token: Pleiad がトークンを持ち、server は oauthToken を渡す（Claude の setup-token）。
  // agent: アカウントごとの置き場でエージェント自身がログインし、server は account（core/agent-accounts.mjs の resolve）を渡す
  accounts: { valid: oneOf(false, 'token', 'agent'), requires: (v) => (v === 'agent' ? ['accountLogin', 'accountStatus', 'forAccount'] : []) },
  compatEndpoints: { valid: bool },
  compact: { valid: bool },
  // 委譲の子の自動圧縮の閾値を受け取る（runArgs.autoCompactWindow）
  autoCompactWindow: { valid: bool },
  // 次の発言の候補をターンの中で受け取る（native）。false は suggestNext がある場合だけターンの後に作る
  promptSuggestions: { valid: oneOf(false, 'native') },
  // Pleiad の指示（core/ply-instructions.mjs。追加の文）を受け取る。委譲の橋（plyAgents）とは別の印:
  // 文を受け取れるだけのバックエンドと、委譲ツールまで繋がるバックエンドを分ける（issue #107）
  plyInstructions: { valid: bool },
  // ply_agents（委譲の橋）を受け取る。agentRuntime（url・headers・instructions）が渡る。
  // instructions の後ろには Pleiad の指示（plyInstructions の分）も足される
  plyAgents: { valid: bool },
  // Pleiad のコンテキスト（ply_context）の受け取り方（turn: ターンごと / conversation: 会話ごとの同じトークン / false: 受け取らない）
  plyContext: { valid: oneOf(false, 'turn', 'conversation') },
  // ply_computer を受け取る（画像の渡し方と待ちの区切り。docs/computer-use.md）
  computerUse: { valid: (v) => v === false || (Boolean(v) && typeof v === 'object' && ['inline', 'path'].includes(v.images) && (v.waitSliceMs === null || Number.isFinite(v.waitSliceMs))) },
  // 入力欄の `!`（host: Pleiad が走らせて次のターンで渡す / native: エージェントが走らせる / false: 使えない。ADR 0054）
  shell: { valid: oneOf(false, 'host', 'native'), requires: (v) => (v === 'native' ? ['shell'] : []) },
  // Pleiad のシェルのツール（ply_shell。runArgs.shellRuntime）を受け取る（ADR 0227 §1）
  plyShell: { valid: bool },
  // エージェントのシェルのツールを会話ごとに切れる（runArgs.shellRuntime.nativeOff。ADR 0227 §3）。切るのは ply_shell を受け取るときだけ
  nativeShellOff: { valid: bool },
  // 強さがモデルの id に入る（エフォートを別に渡さない。core/effort.mjs）
  effortInModelId: { valid: bool },
  // 指示（bot の人格など）は会話の始めにしか効かない。直した人格は次のターンの文脈で渡し直す（core/bots/dispatch.mjs）
  instructionsAtStart: { valid: bool },
  // 失敗の理由を会話の控え（failureReason）に残し、失敗のログを書く（server.mjs の recordBackendFailure）
  failureDiagnostics: { valid: bool },
  // プロンプトが相手に渡った合図を、返答の出来事とは別に出せる（runArgs.onPromptDelivered → server の initialDelivered）。
  // false なら「合図が無い = 渡っていない」とは言えない（agy は入力を受け取っても黙って捨てうる）ので、
  // 無出力で終わった発言を未達（failed・自動再送の対象）にせず結果不明（unknown）にする（server.mjs の closeTurn）
  promptDelivery: { valid: bool },
  // 更新で走っているターンを止めない（無停止の更新。CLI・共有のサーバーを保持役に載せ、新しいサーバーが adoptTurn で付け直す。docs/zero-downtime-update/）
  handover: { valid: bool, requires: (v) => (v ? ['adoptTurn'] : []) },
  // エージェントのブラウザー（会話の Chrome の窓。AGENT_BROWSER_* の環境変数と ply_browser と指示）を受け取る（docs/inapp-browser.md）
  browser: { valid: bool },
  // ply_control（操作の一覧の MCP）と、会話に束縛した CLI の環境変数（PLEIAD_CONTROL_*）を受け取る（ADR 0081）
  plyControl: { valid: bool },
  // 秘密情報と変数（runArgs.secretsRuntime。会話のシェルの環境変数と一覧の文）を受け取る（ADR 0217）
  secrets: { valid: bool },
  // 可視化の指示（runArgs.visualizeInstructions）を受け取る
  visualize: { valid: bool },
  // Pleiad がそろえる Hooks（runArgs.hooksRuntime）を受け取る（ADR 0049）
  hooks: { valid: bool },
};

export const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITIES));

/** 何も持たない能力（対応を終えたバックエンド。core/backends/index.mjs の retiredBackend） */
export const NO_CAPABILITIES = Object.freeze({
  title: false, tag: false, fork: false, forkMessage: false, rewind: false, subagents: false, liveModel: false, liveMode: false,
  hostTools: false, approvals: 'none', alwaysAllow: false, mcpApproval: 'agent', login: false, accounts: false, compatEndpoints: false,
  compact: false, autoCompactWindow: false, promptSuggestions: false, plyInstructions: false, plyAgents: false, plyContext: false, computerUse: false,
  shell: false, plyShell: false, nativeShellOff: false, effortInModelId: false, instructionsAtStart: false, failureDiagnostics: false, promptDelivery: false, handover: false,
  browser: false, plyControl: false, secrets: false, visualize: false, hooks: false,
});

/** バックエンドの必須のメンバー（retiredBackend が持つ最小の形） */
export const REQUIRED_MEMBERS = ['id', 'label', 'capabilities', 'modes', 'models', 'listSessions', 'getSession', 'getMessages', 'runTurn'];

/**
 * バックエンドの形の検査。違反の文の配列を返す（空なら守っている）。
 * native はラップ前（core/backends/<id>.mjs の backend）を渡す。ラップ後は fork などを足すので、requires の検査が甘くなる
 */
export function checkBackendShape(native) {
  const problems = [];
  const id = native?.id ?? '(no id)';
  for (const key of REQUIRED_MEMBERS) if (native?.[key] === undefined) problems.push(`${id}: required member ${key} is missing`);
  const caps = native?.capabilities ?? {};
  for (const key of CAPABILITY_KEYS) {
    if (!Object.hasOwn(caps, key)) { problems.push(`${id}: capability ${key} has no value (write false etc. when unsupported)`); continue; }
    const value = caps[key];
    const spec = CAPABILITIES[key];
    if (!spec.valid(value)) { problems.push(`${id}: capability ${key} has an invalid value ${JSON.stringify(value)}`); continue; }
    for (const member of spec.requires?.(value) ?? []) {
      if (native[member] === undefined) problems.push(`${id}: ${key}=${JSON.stringify(value)} needs ${member}`);
    }
  }
  for (const key of Object.keys(caps)) if (!Object.hasOwn(CAPABILITIES, key)) problems.push(`${id}: capability ${key} is not in core/backends/contract.mjs`);
  // 印とメソッドの逆向き: メソッドがあるのに印が false だと、画面がその機能を出さない（書いたのに使われない）
  if (typeof native?.setModelLive === 'function' && caps.liveModel === false) problems.push(`${id}: has setModelLive but liveModel is false`);
  if (typeof native?.setModeLive === 'function' && caps.liveMode === false) problems.push(`${id}: has setModeLive but liveMode is false`);
  if (typeof native?.shell === 'function' && caps.shell !== 'native') problems.push(`${id}: has shell() but shell is not native`);
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
 * 印の無い配達物は消す（渡されなかったときの既定値はバックエンド側が持つ）。一覧に無いキーは、試験（strict）では例外、通常はログだけ残す。
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
    if (!capabilities?.[flag]) delete runArgs[key];
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
