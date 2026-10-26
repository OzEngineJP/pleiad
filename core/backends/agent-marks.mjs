// エージェントごとの能力の印と性質（データだけ）。SDK にもネットワークにも依存しない。
//
// バックエンド（core/backends/<id>.mjs）は、ここから自分の分を読む（写しを持たない）。
// 公開文書（site/docs/scripts/generate.mjs）は、このファイル・capability-marks.mjs・agents.mjs を
// リリースのタグから取って、エージェントごとのページを作る（site/tools/build-site.mjs の DOCS_SOURCE_FILES）。
//
// 試験用の fake は、環境変数で印を切り替える（台本のため）ので、ここには置かず core/backends/fake.mjs が持つ。
// 性質だけは AGENT_TRAITS.fake に置く（値は環境で変わらない）。
import { covered, impossible, todo } from './capability-marks.mjs';
import { AGY_WAIT_SLICE_MS } from './computer-timing.mjs';

/** 各エージェントの能力の印（CAPABILITY_KEYS の全部。値の意味は capability-marks.mjs） */
export const CAPABILITY_STATES = {
  claude: {
    // server の compactConversation が /compact を発言として送る（compact() は持たない）
    compact: 'prompt',
    // 委譲の子だけ自動圧縮の閾値を下げる窓（runArgs.autoCompactWindow → CLAUDE_CODE_AUTO_COMPACT_WINDOW）を受ける
    autoCompactWindow: true,
    // 次の発言の候補はターンの中で届く（runArgs.promptSuggestions。ターンの後に作らない。core/prompt-suggestions.mjs）
    promptSuggestions: 'native',
    title: true,       // renameSession / customTitle。公式 CLI・VS Code と共有される
    tag: true,         // tagSession / tag。同上
    fork: true,
    forkMessage: true,
    // 同じ会話で巻き戻せる（resume + resumeSessionAt + resumeDropsTurn。conversations.mjs の rewind）
    rewind: 'resumeAt',
    subagents: true,
    liveModel: true,
    liveMode: true,
    hostTools: true,
    plyAgents: true,   // ply_agents を mcpServers に、その instructions を append に渡す
    plyInstructions: true, // Pleiad の指示は ply_agents の instructions の後ろに足されて同じ欄に届く
    // ply_computer（runArgs.computerRuntime）を mcpServers に、指示を append に渡す。MCP の image はそのままモデルに見える（docs/computer-use.md）
    computerUse: { images: 'inline', waitSliceMs: null },
    alwaysAllow: true,
    login: true,
    // 会話ごとのアカウント（claude setup-token のトークン）を選べる。server は oauthToken を渡す（core/claude-accounts.mjs）
    accounts: 'token',
    // 互換の接続先（Anthropic 互換）を会話ごとに選べる。server は endpoint を渡す（core/compat-endpoints.mjs）
    compatEndpoints: true,
    // 入力欄の `!`: Pleiad がホストで走らせ、結果を次のターンの始めに shouldQuery: false の行で渡す（runTurn の shellAppends。ADR 0054）
    shell: 'host',
    // ply_shell を受け取り、Bash・PowerShell を disallowedTools で切れる（ADR 0227）
    plyShell: true,
    nativeShellOff: true,
    approvals: 'interactive',   // canUseTool
    mcpApproval: 'agent',       // MCP のツールも canUseTool を通る
    plyContext: 'turn',         // ply_context はターンごとのトークンで mcpServers に渡す
    steer: true,   // 入力の流れ（streamInput）へ発言を足す
    handover: true,          // CLI を保持役に載せ、新しいサーバーが付け直す（claude-held.mjs）
    // runArgs の配達物: ブラウザーは会話の env と mcpServers に、ply_control は mcpServers と env・指示に、
    // 秘密情報は envFile と指示に、可視化の指示は append に、Pleiad の Hooks は hooksRuntime に渡す
    browser: true, plyControl: true, secrets: true, visualize: true, hooks: true,
  },
  codex: {
    compact: true,
    title: true,        // thread/name/set。公式クライアントとタイトルを共有できる
    tag: covered,       // 状態タグは持てない -> sidecar が正本
    fork: true,
    // 同じ会話で巻き戻せる（thread/revert。legacy は thread/fork { beforeTurnId }。下の rewind）
    rewind: 'thread',
    subagents: true,    // 子スレッド。thread/list { parentThreadId } と thread/read で読む
    liveModel: impossible('app-server に走っているターンの切り替えの口が無い'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    liveMode: impossible('app-server に走っているターンの切り替えの口が無い'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    hostTools: covered,   // ply_control の sessions.setTitle / setStatus / fork で同じことができる
    plyAgents: true,    // ply_agents を mcp_servers に、その instructions を developerInstructions に渡す
    plyInstructions: true, // Pleiad の指示は ply_agents の instructions の後ろに足されて同じ欄に届く
    // ply_computer（runArgs.computerRuntime）を mcp_servers に、指示を developerInstructions に渡す。同梱の computer use は切る（ADR 0074）。
    // MCP の image は gpt-5.x では自動で、gpt-6 系のコードモードでは image() で渡したときモデルに見える（指示文で頼む）
    computerUse: { images: 'inline', waitSliceMs: null },
    alwaysAllow: true,  // acceptForSession
    login: true,
    // 互換の接続先（OpenAI Responses 互換）を会話ごとに選べる（core/compat-endpoints.mjs）
    compatEndpoints: true,
    // 入力欄の `!`: app-server の thread/shellCommand で走らせる（下の shell。ADR 0054）
    shell: 'native',
    // ply_shell を受け取る。Codex のシェルは切らない（features.shell_tool が会話ごとに効くか確かめていない・切るとサンドボックスも外れる。ADR 0227）
    plyShell: true,
    nativeShellOff: impossible('Codex のシェルは切らない（features.shell_tool が会話ごとに効くか確かめていない・切るとサンドボックスも外れる。ADR 0227）'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    forkMessage: covered,       // thread/fork は発言の途中では切れない（Pleiad が写す）
    approvals: 'interactive',
    // MCP のツールの呼び出しは Codex が承認を聞かない。確認なしの承認モードのほかは Pleiad が聞く（server.mjs の mcpApprovalByHost）
    mcpApproval: 'host',
    accounts: 'agent',
    autoCompactWindow: todo('#151'),   // 委譲の子に渡す口があるか未検証
    promptSuggestions: covered,   // ターンの後に suggestNext で作る
    plyContext: 'turn',
    steer: true,   // turn/steer で走っているターンへ足す
    handover: true,          // 共有の app-server を保持役に載せ、新しいサーバーが付け直す（codex-held.mjs）
    // runArgs の配達物: ブラウザーは shell_environment_policy と mcp_servers・指示に、ply_control も mcp_servers と env・指示に、
    // 秘密情報は shell_environment_policy と指示に、可視化・Pleiad の Hooks の指示は developerInstructions に渡す
    browser: true, plyControl: true, secrets: true, visualize: true, hooks: true,
  },
  antigravity: {
    title: covered,       // タイトルの口が無い -> sidecar が正本
    tag: covered,         // 状態タグも無い -> sidecar が正本
    fork: covered,        // 分岐の口が無い -> Pleiad の写しで分ける
    subagents: todo('#151'),   // ACP の標準には子の一覧が無い。CLI の拡張を確かめる
    liveModel: impossible('起動時の --model だけで、走らせたままは変えられない'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    liveMode: impossible('起動時の --mode だけで、走らせたままは変えられない'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    hostTools: covered,   // ply_control の sessions.setTitle / setStatus / fork で同じことができる
    // Pleiad 担当のコンテキスト（ply_context）は、Pleiad の置き場に作ったカスタムエージェント経由で渡す（antigravity-context.mjs）。
    // agy は会話のあいだ 1 本のプロセスを生かすので、ply_context のトークンもターンごとではなく会話ごと（'conversation'）
    plyContext: "conversation",
    alwaysAllow: impossible('対話の承認そのものが無い（approvals: none）'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    login: true,
    // ply_computer は 2 本目の中継（agy-context-relay.mjs --computer）で渡す。MCP の画像は agy がファイルに退避し、モデルは view_file で読む
    // ので、保存先のパスも書く（images: 'path'）。1 回の呼び出しは 3 分で切れ、設定では伸びないので、ロックの待ちは 150 秒ごとに分けて返す
    computerUse: { images: 'path', waitSliceMs: AGY_WAIT_SLICE_MS },
    forkMessage: covered,
    rewind: covered,              // 巻き戻しの口も無い -> Pleiad の写しで戻す
    approvals: 'none',          // 承認モードは確認なしだけ。コンピューターの操作のアプリの承認も聞かない（2026-10-01 に決めた）
    mcpApproval: 'agent',
    accounts: impossible('OS の共有キーリングをアプリ・外部 CLI と共有していて、Pleiad の中で分離できない（ADR 0222）'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    compatEndpoints: todo('#151'),   // CLI に接続先の設定があるか未検証
    compact: impossible('agy が自分で圧縮する。手動の圧縮の口が無い'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    autoCompactWindow: todo('#151'),
    promptSuggestions: covered,   // ターンの後に suggestNext で作る
    // 委譲の橋（ply_agents）は、Pleiad のコンテキストと同じくカスタムエージェントの mcpServers に束ねた中継で渡す。
    // 説明（instructions）と Pleiad の指示は発言の本文の前に毎ターン足す（エージェント定義は最初の会話にしか効かないため。
    // 継続した会話でもそのターンの設定が届き、記録と実際が一致する）。カスタムエージェントが読まない作業場所の
    // 指示ファイル（AGENTS.md・GEMINI.md）は、担当がエージェント任せの会話では Pleiad が読んで agent.md の本文へ足す
    // （antigravity-context.mjs の prepareAgent。足さないとカスタムエージェント化で指示が抜け落ちる）
    plyAgents: true,
    plyInstructions: true,
    shell: todo('#148'),
    // ply_shell はまだ渡さない（MCP は Pleiad のカスタムエージェントでしか渡せず、run_command を外すと作業場所の AGENTS.md を読まなくなる。ADR 0227）
    plyShell: impossible('Pleiad の MCP はカスタムエージェント経由でしか渡せず、必ずカスタムエージェントにすると作業場所の AGENTS.md を読まなくなる（ADR 0227）'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    nativeShellOff: impossible('run_command を外すと作業場所の AGENTS.md を読まなくなる'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    steer: impossible('agy の stream-json は走っているターンへ入力を足せない'),   // 追加指示は次のターンで渡す // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    handover: true,          // agy を保持役に載せ、新しいサーバーが付け直す（antigravity-held.mjs）
    // runArgs の配達物: ブラウザーは会話の env と 1 本の中継（--browser）に、ply_control は中継と env・指示に、
    // 秘密情報は env と指示に、Pleiad の Hooks はカスタムエージェントに渡す。可視化の指示は渡さない（発言に入れていない）
    browser: true, plyControl: true, secrets: true, visualize: todo('#148'), hooks: true,
  },
  opencode: {
    title: true,            // PATCH /session/{id} { title }。OpenCode の TUI と共有する
    tag: covered,           // 状態タグは無い -> Pleiad の控えが正本
    fork: true,             // POST /session/{id}/fork { messageID }（その発言の手前まで写す。発言の id は振り直される）
    forkMessage: true,      // 発言の次の id を渡せば、その発言までを含めて写せる
    rewind: covered,        // revert はファイルの変更まで戻すので使わない -> Pleiad の写しで戻す
    subagents: true,        // task のツールが作る子の会話（/session/{id}/children）
    liveModel: todo('#151'),   // v2 の API に走っているターンのモデル切替があるか未検証
    liveMode: todo('#151'),    // 同上
    hostTools: covered,        // ply_control の sessions.setTitle / setStatus / fork で同じことができる
    approvals: 'interactive',
    alwaysAllow: true,      // reply: always（OpenCode が出す always のパターンで、この会話の間）
    mcpApproval: 'agent',   // MCP のツールも権限の規則（*）を通り、OpenCode が聞く
    login: true,            // 端末で opencode auth login を案内して待つ
    accounts: 'agent',
    compatEndpoints: impossible('OpenCode 自身の接続先としてつなぐので、Pleiad の互換の接続先は使わない（ADR 0221）'), // i18n-ignore: 能力の印の理由（開発者向け。利用者向けの文は #149）
    compact: true,          // POST /session/{id}/summarize
    autoCompactWindow: todo('#151'),
    promptSuggestions: todo('#151'),
    plyAgents: true,        // ply_agents を中継の口で渡し、指示を system に入れる
    plyInstructions: true,  // Pleiad の指示は ply_agents の instructions の後ろに足されて同じ欄に届く
    plyContext: 'turn',     // そのターンだけ専用のサーバーを起こし、ply_context はターンごとの口を中継で渡す（opencode-context.mjs）
    computerUse: { images: 'inline', waitSliceMs: null },
    shell: 'host',          // 入力欄の `!` は Pleiad が走らせ、次のターンの始めに返答を起こさない行（noReply）で渡す
    // ply_shell を受け取り、会話の権限で bash を拒否して切れる（ADR 0227。既定は切る: エージェントの記述の shellDefault）
    plyShell: true,
    nativeShellOff: true,
    steer: true,   // inbox へ足す
    handover: true,         // 共有のサーバーを保持役に載せ、新しいサーバーがつなぎ直して付け直す（opencode-held.mjs）
    // runArgs の配達物: ブラウザーは shell.env の env と中継の ply_browser に、ply_control は中継と env・指示に、
    // 秘密情報は env と指示に、可視化・Pleiad の Hooks の指示は system と hooksRuntime に渡す
    browser: true, plyControl: true, secrets: true, visualize: true, hooks: true,
  },
  devin: {
    // ACP の標準にはタイトル・状態タグ・分岐・巻き戻し・子の一覧の口が無い。Pleiad の控えと写しで補う
    title: covered,
    tag: covered,
    fork: covered,
    forkMessage: covered,
    rewind: covered,
    subagents: todo('#108'),          // 子の一覧は CLI の拡張を確かめる
    liveModel: todo('#108'),          // 実行中のモデル変更
    liveMode: todo('#108'),           // 実行中の承認モード変更
    hostTools: covered,               // ply_control の sessions.setTitle / setStatus / fork で同じことができる
    approvals: 'interactive',
    alwaysAllow: true,
    mcpApproval: 'agent',
    login: true,
    accounts: todo('#108'),           // アカウントごとの認証の分離
    compatEndpoints: todo('#108'),    // CLI の接続先の設定と Pleiad の選択 UI を接続する
    compact: true,                    // /compact を prompt として送る（下の compact）
    autoCompactWindow: todo('#108'),
    promptSuggestions: covered,   // ACP に提案の口が無いため、ターン後の使い捨て読み取り専用会話で補う
    plyInstructions: true,
    plyAgents: true,
    // ACP には指示の欄が無い。Pleiad 担当の指示・Skills の一覧は発言の前に注入文として足し、本文の読み出し
    // （load_skill・instructions_for_path）と外部 MCP は ply_context の MCP（type: 'http'）越しに渡す。口はターンごと
    plyContext: 'turn',
    computerUse: { images: 'inline', waitSliceMs: null },
    shell: 'host',
    plyShell: true,
    nativeShellOff: todo('#108'),
    steer: true,
    handover: true,      // ACP の CLI を保持役に載せ、新しいサーバーが付け直す（acp-held.mjs）
    // ACP の session/new の mcpServers（type: 'http'）にブラウザー・操作一覧・コンピューター・コンテキスト・シェル・委譲を、
    // CLI の env と指示にブラウザー・秘密情報・可視化を渡す。Pleiad の指示は発言の前に足す（ACP に指示の欄が無い）
    browser: true, plyControl: true, secrets: true, visualize: true,
    hooks: todo('#98'),
  },
  grok: {
    // Grok の ACP 拡張でネイティブ題名と全履歴の分岐を使う。状態タグ・巻き戻しは Pleiad の控えで補う
    title: true,
    tag: covered,
    fork: true,
    forkMessage: covered,
    rewind: covered,
    subagents: todo('#108'),
    liveModel: true,     // session/set_config_option
    liveMode: true,      // session/set_mode
    hostTools: covered,  // ply_control の sessions.setTitle / setStatus / fork で同じことができる
    approvals: 'interactive',
    alwaysAllow: true,
    mcpApproval: 'agent',
    login: true,
    accounts: 'agent',
    compatEndpoints: todo('#108'),
    compact: true,                    // compact() から /compact を送り、自動圧縮通知を履歴イベントへ写す
    autoCompactWindow: true,          // GROK_CONFIG.session.auto_compact_threshold_percent に換算
    promptSuggestions: covered,       // ACP に提案 API がなく、ターン後の使い捨て読み取り専用会話で補う
    plyInstructions: true,
    plyAgents: true,
    plyContext: todo('#108'),         // HTTP MCP で渡せるが、Pleiad 担当分の分離が未了
    computerUse: { images: 'path', waitSliceMs: null },
    shell: 'host',
    plyShell: true,
    nativeShellOff: todo('#108'),
    steer: true,
    handover: true,      // ACP の CLI を保持役に載せ、新しいサーバーが付け直す（acp-held.mjs）
    // ブラウザー・操作一覧・コンピューター・シェル・委譲を HTTP MCP で、接続情報と秘密の変数を起動環境で渡す。
    // Pleiad がそろえる Hooks は hooksRuntime（セッション限定のプラグイン。_meta.pluginDirs で渡す）を受け取る
    browser: true, plyControl: true, secrets: true, visualize: true,
    hooks: true,
  },
};

/**
 * 各エージェントの性質（TRAIT_KEYS の全部。true / false だけ）。
 * 能力ではないので、false は「未対応」ではなく、そのエージェントの特徴（そろえる対象ではない）。
 */
export const AGENT_TRAITS = {
  claude: { effortInModelId: false, instructionsAtStart: false, failureDiagnostics: false, promptDelivery: true },
  codex: { effortInModelId: false, instructionsAtStart: false, failureDiagnostics: false, promptDelivery: true },
  // 強さはモデル名に入り、人格は会話の始めに固定され、失敗の理由は Pleiad が控えに残す。渡った合図は出せない
  antigravity: { effortInModelId: true, instructionsAtStart: true, failureDiagnostics: true, promptDelivery: false },
  opencode: { effortInModelId: false, instructionsAtStart: false, failureDiagnostics: false, promptDelivery: true },
  devin: { effortInModelId: true, instructionsAtStart: false, failureDiagnostics: true, promptDelivery: true },
  grok: { effortInModelId: false, instructionsAtStart: false, failureDiagnostics: true, promptDelivery: true },
  fake: { effortInModelId: false, instructionsAtStart: false, failureDiagnostics: false, promptDelivery: true },
};
