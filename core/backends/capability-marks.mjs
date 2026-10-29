// 能力の印と性質の正本（docs/multi-backend.md §2.3、ADR 0273・0274）。SDK にもネットワークにも依存しない。
//
// 1. 能力の印（CAPABILITIES）: バックエンドは**全部のキーに状態を書く**。状態は 4 つ:
//    対応（true・'host'・'native'・'turn' などの値）/ covered（Pleiad の共通処理が補う）/
//    impossible('理由')（技術的に無理・該当しない）/ todo('#Issue')（手段はあるが未実装）。
//    false は書かない。書いていないことを「対応しない」の代わりにしない（tests/unit/backend-contract.mjs が落とす）。
//    現役のエージェントは NO_CAPABILITIES を使えない（対応を終えたバックエンドだけ）。
//    印を足すときは、ここに 1 行足し、全バックエンドに状態を書き、一覧の説明（tests/lib/backend-matrix.mjs の ABOUT）と
//    印の契約の試験（tests/lib/backend-contracts.mjs）を足す。未実装（todo）は tests/backend-todos.json の基準より増やせない。
//    server・画面へは、レジストリ（core/backends/index.mjs）が状態を今までの値へ引いて渡す（legacyCapabilities）。
// 2. 性質（TRAITS）: 機能ではなく、そのエージェントの特徴。全エージェントにそろえる対象ではない。
//    true / false だけで書き、covered・impossible・todo は持たない（「持っていない」は未対応ではなく、そのエージェントの性質）。
//    server・bot・委譲の振り分けが読み、画面へは出さない（describeBackends に載せない）。
// 3. 印の説明（CAPABILITY_DOCS）: 公開文書（site/docs/scripts/generate.mjs）が使う利用者向けの文（ja・en）。
//    アプリの辞書（web/locales）とは別に持つ。印を足したらここにも書く（無いと backend-contract が落とす）。
//
// エージェントごとの状態は core/backends/agent-marks.mjs。ここは「印の意味」だけを持つ。

/** 対応の値の検査。v が許される形なら true */
const oneOf = (...values) => (v) => values.includes(v);
const yes = (v) => v === true;

// ---- 状態（対応しない理由） --------------------------------------------------------------
//
// 値は 1 行で読める形にする: `hooks: todo('#98')`・`accounts: impossible('…')`・`fork: covered`。
// impossible の reason は今は作る人向けの短い日本語。利用者向けの文は CAPABILITY_DOCS の unavailable に持つ。

/** Pleiad の共通処理が補う（タイトル・タグ・分岐・巻き戻しなど） */
export const covered = Object.freeze({ state: 'covered' });

/** 技術的に無理・該当しない。reason は必須 */
export const impossible = (reason) => Object.freeze({ state: 'impossible', reason });

/** 手段はあるが未実装。issue は '#98' の形（必須） */
export const todo = (issue) => Object.freeze({ state: 'todo', issue });

/** 状態の値か（形だけ見る。state の中身は capabilityProblem が確かめる） */
export function isCapabilityState(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, 'state');
}

/** 状態を、今まで server・画面へ渡していた値に引く（covered・impossible・todo は false） */
export function capabilityValue(v) {
  return isCapabilityState(v) ? false : v;
}

/** バックエンドの capabilities を、今まで server・画面へ渡していた値の表に引く */
export function legacyCapabilities(capabilities) {
  return Object.fromEntries(Object.entries(capabilities ?? {}).map(([key, value]) => [key, capabilityValue(value)]));
}

/**
 * 能力の印。valid は対応のときの値、requires は「この値ならこのメソッドが要る」。
 * absent は状態のときに server・画面へ渡す今までの値（false など）。無ければ状態を持てない（approvals・mcpApproval）。
 * covered は Pleiad の共通処理が補える印だけ true。coveredRequires は covered のときに要るメソッド。
 * hint は落ちたときの文に出す値の形。意味は一覧（node tests/lib/backend-matrix.mjs。説明は ABOUT）
 */
export const CAPABILITIES = {
  // ネイティブにタイトル・状態タグを持つ（無ければ Pleiad の控えが正本）
  title: { valid: yes, absent: false, covered: true, hint: 'true', requires: (v) => (v === true ? ['setTitle'] : []) },
  tag: { valid: yes, absent: false, covered: true, hint: 'true', requires: (v) => (v === true ? ['setTag'] : []) },
  // ネイティブに分岐できる（無ければ Pleiad が写して分ける）。forkMessage は発言の途中まで（upToMessageId）
  fork: { valid: yes, absent: false, covered: true, hint: 'true', requires: (v) => (v === true ? ['fork'] : []) },
  forkMessage: { valid: yes, absent: false, covered: true, hint: 'true', requires: (v) => (v === true ? ['fork'] : []) },
  // 同じ会話で巻き戻す形（resumeAt: 次のターンで切る / thread: rewind() で今切る / 補: Pleiad が写す。core/conversations.mjs の rewind）
  rewind: { valid: oneOf('resumeAt', 'thread'), absent: false, covered: true, hint: "'resumeAt' or 'thread'", requires: (v) => (v === 'thread' ? ['rewind'] : []) },
  subagents: { valid: yes, absent: false, hint: 'true', requires: (v) => (v === true ? ['listSubagents', 'getSubagentMessages'] : []) },
  // 走っている最中にモデル・承認モードを替えられる
  liveModel: { valid: yes, absent: false, hint: 'true', requires: (v) => (v === true ? ['setModelLive'] : []) },
  liveMode: { valid: yes, absent: false, hint: 'true', requires: (v) => (v === true ? ['setModeLive'] : []) },
  // set_status / set_title / fork を AI 側から呼べる（§2.6）。covered は ply_control の sessions.* で同じことができる
  hostTools: { valid: yes, absent: false, covered: true, hint: 'true' },
  // 対話の承認（askPermission）を使う。none は承認モードが確認なししか無い（agy）。コンピューターの操作のアプリの承認も聞かない
  approvals: { valid: oneOf('interactive', 'none'), hint: "'interactive' or 'none'" },
  alwaysAllow: { valid: yes, absent: false, hint: 'true' },
  // MCP のツールの承認。host は、エージェント自身が聞かないので、確認なしの承認モード（autonomy: full）のほかは Pleiad が聞く（Codex）
  mcpApproval: { valid: oneOf('agent', 'host'), hint: "'agent' or 'host'" },
  login: { valid: yes, absent: false, hint: 'true', requires: (v) => (v === true ? ['auth'] : []) },
  // 会話ごとにアカウントを選べる（ADR 0222）。token: Pleiad がトークンを持ち、server は oauthToken を渡す（Claude の setup-token）。
  // agent: アカウントごとの置き場でエージェント自身がログインし、server は account（core/agent-accounts.mjs の resolve）を渡す
  accounts: { valid: oneOf('token', 'agent'), absent: false, hint: "'token' or 'agent'", requires: (v) => (v === 'agent' ? ['accountLogin', 'accountStatus', 'forAccount'] : []) },
  compatEndpoints: { valid: yes, absent: false, hint: 'true' },
  // true は compact() で圧縮する。prompt は /compact を発言として送る（Claude。server の compactConversation）
  compact: { valid: oneOf(true, 'prompt'), absent: false, hint: "true (with compact()) or 'prompt' (send /compact)", requires: (v) => (v === true ? ['compact'] : []) },
  // 委譲の子の自動圧縮の閾値を受け取る（runArgs.autoCompactWindow）
  autoCompactWindow: { valid: yes, absent: false, hint: 'true' },
  // 次の発言の候補をターンの中で受け取る（native）。covered はターンの後に suggestNext で作る
  promptSuggestions: { valid: oneOf('native'), absent: false, covered: true, coveredRequires: ['suggestNext'], hint: "'native'" },
  // Pleiad の指示（core/ply-instructions.mjs。追加の文）を受け取る。委譲の橋（plyAgents）とは別の印:
  // 文を受け取れるだけのバックエンドと、委譲ツールまで繋がるバックエンドを分ける（issue #107）
  plyInstructions: { valid: yes, absent: false, hint: 'true' },
  // ply_agents（委譲の橋）を受け取る。agentRuntime（url・headers・instructions）が渡る。
  // instructions の後ろには Pleiad の指示（plyInstructions の分）も足される
  plyAgents: { valid: yes, absent: false, hint: 'true' },
  // Pleiad のコンテキスト（ply_context）の受け取り方（turn: ターンごと / conversation: 会話ごとの同じトークン）
  plyContext: { valid: oneOf('turn', 'conversation'), absent: false, hint: "'turn' or 'conversation'" },
  // ply_computer を受け取る（画像の渡し方と待ちの区切り。docs/computer-use.md）
  computerUse: { valid: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && ['inline', 'path'].includes(v.images) && (v.waitSliceMs === null || Number.isFinite(v.waitSliceMs)), absent: false, hint: "{ images: 'inline' | 'path', waitSliceMs: number | null }" },
  // 入力欄の `!`（host: Pleiad が走らせて次のターンで渡す / native: エージェントが走らせる。ADR 0054）
  shell: { valid: oneOf('host', 'native'), absent: false, hint: "'host' or 'native'", requires: (v) => (v === 'native' ? ['shell'] : []) },
  // Pleiad のシェルのツール（ply_shell。runArgs.shellRuntime）を受け取る（ADR 0227 §1）
  plyShell: { valid: yes, absent: false, hint: 'true' },
  // エージェントのシェルのツールを会話ごとに切れる（runArgs.shellRuntime.nativeOff。ADR 0227 §3）。切るのは ply_shell を受け取るときだけ
  nativeShellOff: { valid: yes, absent: false, hint: 'true' },
  // 走っているターンへ途中で入力を渡せる（runArgs.control.steer。委譲の追加指示・完了通知）。
  // 無いなら追加指示は待機のまま、次のターンの入力として渡す（server.mjs の childTarget。画面は「次のターンで届く」と出す）
  steer: { valid: yes, absent: false, hint: 'true' },
  // 更新で走っているターンを止めない（無停止の更新。CLI・共有のサーバーを保持役に載せ、新しいサーバーが adoptTurn で付け直す。docs/zero-downtime-update/）
  handover: { valid: yes, absent: false, hint: 'true', requires: (v) => (v === true ? ['adoptTurn'] : []) },
  // エージェントのブラウザー（会話の Chrome の窓。AGENT_BROWSER_* の環境変数と ply_browser と指示）を受け取る（docs/inapp-browser.md）
  browser: { valid: yes, absent: false, hint: 'true' },
  // ply_control（操作の一覧の MCP）と、会話に束縛した CLI の環境変数（PLEIAD_CONTROL_*）を受け取る（ADR 0081）
  plyControl: { valid: yes, absent: false, hint: 'true' },
  // 秘密情報と変数（runArgs.secretsRuntime。会話のシェルの環境変数と一覧の文）を受け取る（ADR 0217）
  secrets: { valid: yes, absent: false, hint: 'true' },
  // 可視化の指示（runArgs.visualizeInstructions）を受け取る
  visualize: { valid: yes, absent: false, hint: 'true' },
  // Pleiad がそろえる Hooks（runArgs.hooksRuntime）を受け取る（ADR 0049）
  hooks: { valid: yes, absent: false, hint: 'true' },
};

export const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITIES));

/**
 * 性質（エージェントの特徴）。能力ではないので、全エージェントにそろえる対象ではない。
 * true / false だけで書き、covered・impossible・todo は持たない（「持っていない」は未対応ではなく、そのエージェントの性質）。
 * hint は落ちたときの文に出す値の形。
 */
export const TRAITS = {
  // 強さがモデルの id に入る（エフォートを別に渡さない。core/effort.mjs）
  effortInModelId: { hint: 'true' },
  // 指示（bot の人格など）は会話の始めにしか効かない。直した人格は次のターンの文脈で渡し直す（core/bots/dispatch.mjs）
  instructionsAtStart: { hint: 'true' },
  // 失敗の理由を会話の控え（failureReason）に残し、失敗のログを書く（server.mjs の recordBackendFailure）
  failureDiagnostics: { hint: 'true' },
  // プロンプトが相手に渡った合図を、返答の出来事とは別に出せる（runArgs.onPromptDelivered → server の initialDelivered）。
  // 無いなら「合図が無い = 渡っていない」とは言えない（agy は入力を受け取っても黙って捨てうる）ので、
  // 無出力で終わった発言を未達（failed・自動再送の対象）にせず結果不明（unknown）にする（server.mjs の closeTurn）
  promptDelivery: { hint: 'true' },
  // 秘密情報と変数は、値ファイルを読むスクリプト（CLAUDE_ENV_FILE。core/claude-env-file.mjs）経由で Bash 系のシェルにだけ届く。
  // エージェント自身の PowerShell ツールには渡らないので、AI への一覧の文を替える（core/secrets-prompt.mjs・ADR 0284）
  secretsViaEnvFile: { hint: 'true' },
};

export const TRAIT_KEYS = Object.freeze(Object.keys(TRAITS));

/** 性質を持たないバックエンドの値（対応を終えたバックエンド・資格情報の無い会話） */
export const NO_TRAITS = Object.freeze(Object.fromEntries(TRAIT_KEYS.map((key) => [key, false])));

/**
 * 印の説明（公開文書 site/docs が使う利用者向けの文。ja・en）。
 * label は短い名前、summary はできることの説明、unavailable はできないときの理由、values は値ごとの補足。
 * 開発者向けの説明は tests/lib/backend-matrix.mjs の ABOUT（一覧の 1 列目）。
 */
export const CAPABILITY_DOCS = {
  title: { label: { ja: 'タイトル', en: 'Title' }, summary: { ja: '会話に名前を付けて、一覧や見出しに表示します。', en: 'Name a conversation and show it in the list and header.' }, unavailable: { ja: 'このエージェントではタイトルを保存できません。', en: 'This agent cannot store conversation titles.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  tag: { label: { ja: '状態タグ', en: 'Status tag' }, summary: { ja: '会話に「実行中」「確認待ち」などの状態を付けます。', en: 'Show a status such as running or waiting for review.' }, unavailable: { ja: 'このエージェントでは状態タグを保存できません。', en: 'This agent cannot store status tags.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  fork: { label: { ja: '分岐', en: 'Fork' }, summary: { ja: '会話を途中から分けて、別の枝として続けます。', en: 'Split a conversation and continue on a new branch.' }, unavailable: { ja: 'このエージェントでは会話を分岐できません。', en: 'This agent cannot fork conversations.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  forkMessage: { label: { ja: '発言の途中からの分岐', en: 'Fork at a message' }, summary: { ja: '途中の発言までを含む枝を作ります。', en: 'Create a branch that includes messages up to the middle.' }, unavailable: { ja: 'このエージェントでは発言の途中で分岐できません。', en: 'This agent cannot fork in the middle of a conversation.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  rewind: { label: { ja: '巻き戻し', en: 'Rewind' }, summary: { ja: '同じ会話を前の地点まで戻して続けます。', en: 'Go back to an earlier point in the same conversation.' }, unavailable: { ja: 'このエージェントでは会話を巻き戻せません。', en: 'This agent cannot rewind a conversation.' }, values: { resumeAt: { ja: '次のターンで戻ります。', en: 'Rewinds on the next turn.' }, thread: { ja: 'その場で戻ります。', en: 'Rewinds immediately.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  subagents: { label: { ja: 'サブエージェント', en: 'Subagents' }, summary: { ja: 'エージェントが分けた子の作業を一覧して、中身を読めます。', en: 'List and read the child tasks an agent splits off.' }, unavailable: { ja: 'このエージェントの接続方法では、子の作業の一覧を取得できません。', en: "This agent's protocol does not expose child tasks." } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  liveModel: { label: { ja: '実行中のモデル切り替え', en: 'Switch models while running' }, summary: { ja: 'ターンを止めずにモデルを切り替えます。', en: 'Switch models without stopping the turn.' }, unavailable: { ja: '走っているターンの途中ではモデルを切り替えられません。次のターンから切り替わります。', en: 'The model cannot be changed during a running turn. It changes from the next turn.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  liveMode: { label: { ja: '実行中の承認モード切り替え', en: 'Switch approval modes while running' }, summary: { ja: 'ターンを止めずに承認モードを切り替えます。', en: 'Switch approval modes without stopping the turn.' }, unavailable: { ja: '走っているターンの途中では承認モードを切り替えられません。次のターンから切り替わります。', en: 'The approval mode cannot be changed during a running turn. It changes from the next turn.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  hostTools: { label: { ja: 'AI からの題名・状態・分岐', en: 'Title, status, and fork from the AI' }, summary: { ja: 'AI が会話の題名・状態を変えたり、分岐したりできます。', en: 'The AI can rename a conversation, change its status, and fork it.' }, unavailable: { ja: 'このエージェントでは AI から題名・状態・分岐を変えられません。', en: 'The AI cannot change titles, status, or forks with this agent.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  approvals: { label: { ja: '対話の承認', en: 'Interactive approvals' }, summary: { ja: 'ツールの実行前に承認を求めます。', en: 'Ask before running tools.' }, unavailable: { ja: 'このエージェントでは承認を求められません。', en: 'This agent cannot ask for approval.' }, values: { interactive: { ja: '実行前に承認を求めます。', en: 'Asks before running tools.' }, none: { ja: '承認は求めず、確認なしで実行します。', en: 'Runs without asking for approval.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  alwaysAllow: { label: { ja: '「常に許可」', en: 'Always allow' }, summary: { ja: '承認に「常に許可」を返せます。', en: 'Answer an approval with always allow.' }, unavailable: { ja: 'このエージェントでは「常に許可」を返せません。', en: 'This agent cannot always allow.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  mcpApproval: { label: { ja: 'MCP ツールの承認', en: 'MCP tool approvals' }, summary: { ja: 'MCP のツールの実行前に承認を求めます。', en: 'Ask before running MCP tools.' }, unavailable: { ja: 'このエージェントでは MCP のツールの承認を扱えません。', en: 'This agent cannot handle MCP tool approvals.' }, values: { agent: { ja: 'エージェントが承認を求めます。', en: 'The agent asks.' }, host: { ja: 'Pleiad が承認を求めます。', en: 'Pleiad asks.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  login: { label: { ja: 'Pleiad からのログイン', en: 'Sign in from Pleiad' }, summary: { ja: 'Pleiad の画面からエージェントにログインできます。', en: 'Sign in to the agent from Pleiad.' }, unavailable: { ja: 'このエージェントは Pleiad の画面からログインできません。端末でログインしてください。', en: 'This agent cannot be signed in from Pleiad. Sign in from a terminal.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  accounts: { label: { ja: '会話ごとのアカウント', en: 'Accounts per conversation' }, summary: { ja: '会話ごとに使うアカウントを選べます。', en: 'Choose an account for each conversation.' }, unavailable: { ja: 'このエージェントではアカウントを分けられません。', en: 'This agent cannot separate accounts.' }, values: { token: { ja: 'Pleiad がアカウントのトークンを渡します。', en: 'Pleiad passes the account token.' }, agent: { ja: 'エージェントがアカウントごとにログインします。', en: 'The agent signs in for each account.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  compatEndpoints: { label: { ja: '互換の接続先', en: 'Compatible endpoints' }, summary: { ja: '会話ごとに互換の接続先を選べます。', en: 'Choose a compatible endpoint for each conversation.' }, unavailable: { ja: 'このエージェントでは互換の接続先を選べません。', en: 'This agent cannot choose a compatible endpoint.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  compact: { label: { ja: '圧縮', en: 'Compaction' }, summary: { ja: '会話の文脈を要約して縮めます。', en: 'Summarize and shrink the conversation context.' }, unavailable: { ja: 'このエージェントでは Pleiad から圧縮を始められません。', en: 'Pleiad cannot start compaction for this agent.' }, values: { true: { ja: 'Pleiad の操作から圧縮できます。', en: 'Compact from Pleiad.' }, prompt: { ja: '/compact を発言として送って圧縮します。', en: 'Send /compact as a message to compact.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  autoCompactWindow: { label: { ja: '委譲の子の自動圧縮の閾値', en: 'Auto-compaction threshold for delegated children' }, summary: { ja: '委譲した子の会話だけ、自動圧縮の閾値を下げられます。', en: 'Lower the auto-compaction threshold for delegated child conversations.' }, unavailable: { ja: '委譲した子の自動圧縮の閾値は変えられません。', en: 'The threshold for delegated children cannot be changed.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  promptSuggestions: { label: { ja: '次の発言の候補', en: 'Prompt suggestions' }, summary: { ja: '次の発言の候補を出します。', en: 'Suggest what to say next.' }, unavailable: { ja: 'このエージェントでは次の発言の候補を出せません。', en: 'This agent cannot suggest prompts.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  plyInstructions: { label: { ja: 'Pleiad の指示', en: 'Pleiad instructions' }, summary: { ja: 'Pleiad の指示（追加の文・既定の項目）をエージェントに渡します。', en: "Pass Pleiad's instructions (added text and defaults) to the agent." }, unavailable: { ja: 'このエージェントには Pleiad の指示を渡せません。', en: "Pleiad's instructions cannot be passed to this agent." } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  plyAgents: { label: { ja: '委譲（ply_agents）', en: 'Delegation (ply_agents)' }, summary: { ja: 'エージェントから Pleiad の子へ作業を委譲できます。', en: 'Let the agent delegate work to Pleiad child agents.' }, unavailable: { ja: 'このエージェントからは委譲できません。', en: 'This agent cannot delegate work.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  plyContext: { label: { ja: 'Pleiad のコンテキスト（ply_context）', en: 'Pleiad context (ply_context)' }, summary: { ja: '指示・Skills・MCP を Pleiad のコンテキストから読めます。', en: "Read instructions, skills, and MCP from Pleiad's context." }, unavailable: { ja: 'このエージェントは Pleiad のコンテキストを受け取れません。', en: "This agent cannot receive Pleiad's context." }, values: { turn: { ja: 'ターンごとに渡します。', en: 'Passed for each turn.' }, conversation: { ja: '会話ごとの同じトークンで渡します。', en: 'Passed with one token for the whole conversation.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  computerUse: { label: { ja: 'コンピューターの操作（ply_computer）', en: 'Computer use (ply_computer)' }, summary: { ja: '画面の操作とスクリーンショットをエージェントに渡します。', en: 'Let the agent control the screen and take screenshots.' }, unavailable: { ja: 'このエージェントではコンピューターの操作を使えません。', en: 'This agent cannot use computer control.' }, values: { inline: { ja: 'スクリーンショットは画像として直接渡します。', en: 'Screenshots are passed as images.' }, path: { ja: 'スクリーンショットはファイルとして渡します。', en: 'Screenshots are passed as files.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  shell: { label: { ja: '入力欄の !（シェル）', en: 'Shell from the composer' }, summary: { ja: '入力欄の ! でシェルのコマンドを走らせ、結果を会話に渡します。', en: 'Run a shell command from the composer and add the result to the conversation.' }, unavailable: { ja: 'このエージェントでは入力欄の ! を使えません。', en: 'The composer shell is not available with this agent.' }, values: { host: { ja: 'Pleiad が実行し、結果を次のターンに渡します。', en: 'Pleiad runs it and passes the result on the next turn.' }, native: { ja: 'エージェント自身が実行します。', en: 'The agent runs it.' } } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  plyShell: { label: { ja: 'Pleiad のシェル（ply_shell）', en: 'Pleiad shell (ply_shell)' }, summary: { ja: 'エージェントから Pleiad のシェルのツールを使えます。', en: "Let the agent use Pleiad's shell tool." }, unavailable: { ja: 'このエージェントには Pleiad のシェルを渡せません。', en: "Pleiad's shell cannot be passed to this agent." } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  nativeShellOff: { label: { ja: 'エージェントのシェルを切る', en: "Turn off the agent's shell" }, summary: { ja: '会話ごとにエージェント自身のシェルのツールを切れます。', en: "Turn off the agent's own shell tools for a conversation." }, unavailable: { ja: 'このエージェントのシェルは切れません。', en: "This agent's shell cannot be turned off." } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  steer: { label: { ja: '実行中の追加指示', en: 'Instructions during a turn' }, summary: { ja: '走っているターンへ追加の指示を渡せます。', en: 'Send more instructions into a running turn.' }, unavailable: { ja: '走っているターンへ追加の指示は渡せません。次のターンで渡します。', en: 'Additional instructions are delivered on the next turn.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  handover: { label: { ja: '更新中の継続', en: 'Continue through updates' }, summary: { ja: 'Pleiad の更新中も、走っているターンを止めません。', en: 'Keep running turns alive while Pleiad updates.' }, unavailable: { ja: '更新のときは走っているターンを止めます。', en: 'Running turns stop when Pleiad updates.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  browser: { label: { ja: 'エージェントのブラウザー', en: 'Agent browser' }, summary: { ja: '会話専用の Chrome をエージェントから操作できます。', en: 'Let the agent drive a Chrome window dedicated to the conversation.' }, unavailable: { ja: 'このエージェントではブラウザーを使えません。', en: 'The browser is not available with this agent.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  plyControl: { label: { ja: '操作の一覧（ply_control）', en: 'Control surface (ply_control)' }, summary: { ja: 'エージェントから Pleiad の操作の一覧と CLI を使えます。', en: "Let the agent use Pleiad's control surface and CLI." }, unavailable: { ja: 'このエージェントには操作の一覧を渡せません。', en: 'The control surface cannot be passed to this agent.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  secrets: { label: { ja: '秘密情報と変数', en: 'Secrets and variables' }, summary: { ja: '会話に預けた秘密情報と変数を環境変数として渡します。', en: 'Pass secrets and variables as environment variables.' }, unavailable: { ja: 'このエージェントには秘密情報を渡せません。', en: 'Secrets cannot be passed to this agent.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  visualize: { label: { ja: '可視化', en: 'Visualizations' }, summary: { ja: 'HTML の可視化を作って会話に表示するよう指示します。', en: 'Ask the agent to build HTML visualizations in the conversation.' }, unavailable: { ja: 'このエージェントには可視化の指示を渡せません。', en: 'Visualization instructions cannot be passed to this agent.' } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
  hooks: { label: { ja: 'Hooks', en: 'Hooks' }, summary: { ja: 'Pleiad がそろえた Hooks を、エージェントのツールの前後で走らせます。', en: "Run Pleiad-managed hooks around the agent's tools." }, unavailable: { ja: 'このエージェントは Pleiad の Hooks を受け取れません。', en: "This agent cannot receive Pleiad's hooks." } }, // i18n-ignore: 公開文書（site/docs）の生成に使う利用者向けの文。アプリの辞書の外
};
