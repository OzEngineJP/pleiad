# エージェント × 機能の対応表

<!-- 自動で作る表。手で直さない。`node tests/lib/backend-matrix.mjs --write` で書き直す（tests/lib/backend-matrix.mjs） -->

各エージェントのバックエンド（`core/backends/<id>.mjs`）が書いた能力の印（`core/backends/contract.mjs`）の一覧。
— は「対応しない」とバックエンドが明示したもの（書き忘れではない。書き忘れは `npm test` の backend-contract が落とす）。
印の意味と、エージェントを足す手順は [multi-backend.md](multi-backend.md)「エージェントを足す」。

| 機能 | Claude Code | OpenAI Codex | Antigravity | OpenCode | Devin CLI |
|---|---|---|---|---|---|
| タイトルをエージェントの側に持つ（無ければ Pleiad の控え）（`title`） | ✓ | ✓ | — | ✓ | — |
| 状態タグをエージェントの側に持つ（無ければ Pleiad の控え）（`tag`） | ✓ | — | — | — | — |
| エージェントの側で分岐する（無ければ Pleiad が写して分ける）（`fork`） | ✓ | ✓ | — | ✓ | — |
| 発言の途中で分岐できる（`forkMessage`） | ✓ | — | — | ✓ | — |
| 同じ会話の巻き戻し（resumeAt: 次のターンで切る / thread: すぐ切る / —: Pleiad が写す）（`rewind`） | resumeAt | thread | — | — | — |
| サブエージェントの一覧と中身（`subagents`） | ✓ | ✓ | — | ✓ | — |
| 走っている最中にモデルを替える（`liveModel`） | ✓ | — | — | — | — |
| 走っている最中に承認モードを替える（`liveMode`） | ✓ | — | — | — | — |
| AI から set_status / set_title / fork を呼ぶ（`hostTools`） | ✓ | — | — | — | — |
| 対話の承認（none: 承認モードが確認なしだけ）（`approvals`） | interactive | interactive | none | interactive | interactive |
| 承認に「常に許可」を返す（`alwaysAllow`） | ✓ | ✓ | — | ✓ | — |
| MCP のツールの承認（host: エージェントが聞かないので Pleiad が聞く）（`mcpApproval`） | agent | host | agent | agent | agent |
| Pleiad の画面からログインする（`login`） | ✓ | ✓ | ✓ | ✓ | — |
| 会話ごとにアカウントを選ぶ（token: Pleiad がトークンを持つ / agent: エージェントがアカウントごとの置き場でログインする）（`accounts`） | token | agent | — | agent | — |
| 互換の接続先を会話ごとに選ぶ（`compatEndpoints`） | ✓ | ✓ | — | — | — |
| 手動・自動の圧縮（`compact`） | ✓ | ✓ | — | ✓ | — |
| 委譲の子の自動圧縮の閾値を受け取る（`autoCompactWindow`） | ✓ | — | — | — | — |
| 次の発言の候補（native: ターンの中で届く / —: Pleiad がターンの後に作る）（`promptSuggestions`） | native | — | — | — | — |
| 委譲の橋（ply_agents）と Pleiad の指示を受け取る（`plyAgents`） | ✓ | ✓ | — | ✓ | — |
| Pleiad のコンテキスト（ply_context）の受け取り方（turn / conversation）（`plyContext`） | turn | turn | conversation | turn | — |
| コンピューターの操作（ply_computer）。画像の渡し方（`computerUse`） | inline | inline | path（150 秒ごと） | inline | — |
| 入力欄の `!`（host: Pleiad が走らせる / native: エージェントが走らせる）（`shell`） | host | native | — | host | — |
| Pleiad のシェルのツール（ply_shell）を受け取る（`plyShell`） | ✓ | ✓ | — | ✓ | — |
| エージェントのシェルのツールを会話ごとに切れる（ply_shell だけにする）（`nativeShellOff`） | ✓ | — | — | ✓ | — |
| 強さをモデルの id で選ぶ（`effortInModelId`） | — | — | ✓ | — | ✓ |
| 指示は会話の始めにしか効かない（人格を直したら次のターンで渡し直す）（`instructionsAtStart`） | — | — | ✓ | — | — |
| 失敗の理由を会話の控えに残す（`failureDiagnostics`） | — | — | ✓ | — | ✓ |
| 更新で走っているターンを止めない（無停止の更新。新しいサーバーが付け直す）（`handover`） | ✓ | ✓ | ✓ | ✓ | — |
| エージェントのブラウザー（Chrome の窓。AGENT_BROWSER_* の環境変数と ply_browser）を受け取る（`browser`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 操作の一覧（ply_control）と会話に束縛した CLI（PLEIAD_CONTROL_*）を受け取る（`plyControl`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 秘密情報と変数（環境変数と一覧の文）を受け取る（`secrets`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 可視化の指示を受け取る（`visualize`） | ✓ | ✓ | — | ✓ | ✓ |
| Pleiad がそろえる Hooks（hooksRuntime）を受け取る（`hooks`） | ✓ | ✓ | ✓ | ✓ | — |
