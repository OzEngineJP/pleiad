# Pleiad Agent の提供前確認

Pleiad `1931fa165` と Pleiad Agent `d509ffc` の組み合わせで、試験提供の入口を確認した。PC では `AGENT_HOST_BACKENDS` で選択肢に加える。管理下のクラウドホストでは Pleiad Agent と Pleiad Plus の管理接続だけを使う。

表の「実経路」は、偽のモデルと実際の標準入出力アダプターを使い、記載した操作の結果まで確認した範囲を指す。「共通」は Pleiad 共通の画面またはホストの処理を指す。「一部」は未対応か、同じ経路を一続きで確認していない箇所を含む。試験名は `node tests/run.mjs <試験名>` で指定できる。

| 機能 | 利用画面・MCP・ホストの入口 | 試験と確認範囲 |
|---|---|---|
| エージェント登録と会話開始 | 新規会話、`agents.list`、`newSession` | 実経路。配布物とクラウドイメージの起動確認、`server-pleiad-agent`、`managed-host` |
| 承認・常に許可・承認モード | 入力欄のモード、承認カード、`resolvePermission`、`applyTurnSettingsNow` | 実経路。編集した書き込み、再起動でのカード復元、同じ会話のファイル操作への許可、ライブ変更を `server-pleiad-agent` で確認 |
| プランモード | 入力欄のモード、承認カード、標準入出力の `mode.set` | 実経路。変更で待機中の承認を閉じ、プランモード中にファイルを書かないことを `server-pleiad-agent` で確認。プラン承認後の実行は利用者がモード変更して送信する |
| 利用者への質問 | 質問カード、`resolvePermission` | 実経路。選択、元の要求への回答、再起動での復元、中断を `server-pleiad-agent` で確認。秘密専用の質問は対象外 |
| ToDo・成果物 | 会話の ToDo、`ply_control` の `todos.*` | 会話の ToDo の編集、版の衝突、成果物リンクの保存を `server-pleiad-agent` で確認 |
| 画像・添付・生成物 | 入力欄の添付、`attachFile`、会話の提示、モデル対応時の道具画像 | 実経路。添付パスが一度届き、再読み込みでも読める。画面撮影の画像と HTML を `server-pleiad-agent` で確認 |
| 再開・履歴・検索 | 会話一覧、`loadSession`、`sessions.read`、`sessions.search` | 履歴と同じ会話への続行は実経路。検索は共通。`server-pleiad-agent`、`ops-sessions`、`session-search` |
| 分岐・巻き戻し・エージェント切り替え | 会話メニュー、発言の編集、`sessions.fork`、`rewindSession`、エージェント選択 | 実経路。元と枝の履歴、発言からの巻き戻し、切り替え後の履歴を `server-pleiad-agent` で確認。巻き戻しは会話に適用する |
| 圧縮・コンテキスト残量 | 入力欄の `/compact`、`compactConversation`、文脈量の表示 | 実経路。手動圧縮の境界、文脈量、元の発言 ID を `server-pleiad-agent` で確認 |
| 途中の指示・送信待ち・時刻指定 | 入力欄、送信待ち、`sendMessage`、`messageAction`、標準入出力の `steer` | 添付の待機、途中の指示、同じ送信 ID の重複排除は実経路。予約・受付と配達の区別には共通処理を使う。`server-pleiad-agent`、`message-queue`、`message-steer` |
| 中断、失敗、再接続 | 停止、`abort`、`loadSession`、標準入出力の `interrupt` | 実経路。質問待ち・ブラウザー手渡しの停止、停止済み会話の再開を `server-pleiad-agent` で確認 |
| モデル・推論の強さ・動作中の切り替え | 入力欄、`models`、`setTurnSettings`、設定の予約 | 一部。モデル一覧と推論の強さの送信は実経路。モデルと強さは次のターンから変わる。`server-pleiad-agent`、`server-live-settings` |
| 使用量・費用・利用上限 | 会話の `usage`、設定の使用量、`providerUsage`、Plus 側の精算 | 一部。道具を挟んだ集計と報告された費用は `server-pleiad-agent` で確認。Plus 残高と上限の精算は Plus の責務 |
| 利用上限で止まった後の再開 | 会話の失敗表示、入力欄から再送 | 一部。Pleiad Agent 専用の上限解除時刻、解除後の再開経路は未提供。モデルの失敗時は利用者が再送する |
| 会話のアカウント・接続先の切り替え | 設定の接続先、入力欄、`setTurnSettings`、`compatEndpointCheck` | 実経路。OpenAI 互換・Anthropic・OpenRouter、デスクトップ Plus、クラウド Plus を `server-pleiad-agent` で確認。PC 配布物では利用者が選んだ接続先だけが受け取る |
| SDK 由来の作業状況・ネイティブのサブエージェント | 会話の道具の進捗、`ply_agents` の委譲 | 一部。ホスト委譲を `server-pleiad-agent` で確認。標準入出力にはネイティブの子エージェントや道具を使うバックグラウンド作業の入口がない |
| ネイティブのシェル・Pleiad のシェル・背景コマンド | 会話に束縛した `ply_shell` | 公開する道具と能力宣言を `backend-common`、承認して実行したコマンドの出力を `server-pleiad-agent` で確認。ネイティブシェルは最初から公開しない。入力欄の `!` はこのバックエンドの対応範囲外 |
| Skill | 設定の Skills、入力欄の候補、`ply_context.load_skill` | 一部。会話での候補と MCP の受け渡しを `server-pleiad-agent`、`backend-common` で確認 |
| 指示ファイル・会話の指示 | 設定の指示、`ply_context.instructions_for_path`、ターンの指示 | 実経路。Pleiad 管理とエージェント管理それぞれの指示が一度届くことを `server-pleiad-agent` で確認 |
| Pleiad が渡す MCP | `ply_agents`、`ply_context`、`ply_control`、`ply_shell`、`ply_browser`、`ply_computer` | 道具一覧への公開を `backend-common`、会話に束縛した承認、制御・操作・画像の実行を `server-pleiad-agent` で確認。制御 CLI 用の環境変数は子に渡さない |
| 外部 MCP・OAuth・プラグイン設定 | 設定の MCP、`mcp.list`、`ply_context` | 一部。Pleiad 管理の MCP を実行し、共通操作で秘密を伏せる。`server-pleiad-agent`、`ops-mcp-hooks`。ネイティブ MCP は読み込まず、名前別の停止は Pleiad 管理の MCP 設定で行う。実アカウントの OAuth は未実施 |
| フック | 設定の Hooks、送信と道具実行の前後、`hooks.session` | 一部。Pleiad 管理のフックで道具の入力が変わり、一度だけ実行される。`server-pleiad-agent`、`hooks-agents`。対応イベントは送信前と道具の前後 |
| スラッシュコマンド | 入力欄の `/`、Skill 候補、`/compact` | 実経路。Skill 候補と手動圧縮の入口を `server-pleiad-agent` で確認 |
| 可視化・HTML 表示 | 入力欄の可視化、会話の提示、添付から表示 | 実経路。正常な HTML と壊れた内容のエラーを `server-pleiad-agent` で確認 |
| ブラウザー・利用者に操作を渡す・ダウンロード | 会話別ブラウザー、`ply_browser`、手渡しカード、ダウンロード一覧 | 一部。偽の Chrome で手渡し・再開・停止を `server-pleiad-agent`、共通ブリッジとカードを `browser-bridge`、`browser-handoff-card` で確認。実サイトの秘密入力とダウンロードは今回未実施 |
| コンピューター操作と画像の取り込み | コンピューター操作の設定、`ply_computer`、会話の画像 | 一部。偽ドライバーで撮影から会話の画像・履歴まで確認。共通の許可とロックは `computer-bridge`、`computer-policy`。配布物の実機入力は今回未実施 |
| 作業場所、worktree、ファイル・git 表示 | 新規会話の作業場所、委譲の分離、ファイルと git のパネル | 実経路。空白・日本語を含む場所でのファイル読み取りと委譲した子の worktree 分離を `server-pleiad-agent`、共通操作を `ops-session-work` で確認 |
| 検索・題・状態・会話を開く／削除 | 会話一覧・検索・会話メニュー、`sessions.*`、`setStatus` | 題・状態・履歴は `server-pleiad-agent`。検索と削除は共通の `session-search`、`ops-sessions` |
| クリップボード・パスを開く・ホストの画面 | 添付表示、端末のクリップボードやファイルを開く操作 | 共通。Pleiad Agent の返した添付が提示に届くことを `server-pleiad-agent` で確認。OS のクリップボードとファイルを開く操作は配布物で今回未実施 |
| 委譲の子を作る | `ply_agents.ply_delegate`、依頼元の会話と作業一覧 | 実経路。別エージェントへの委譲と結果、管理下ホストから PC への経路を `server-pleiad-agent`、`managed-host` で確認 |
| 委譲の子として動く | 委譲の実行先選択、子の会話、承認カード | 実経路。別エージェントからの依頼、worktree 分離、承認を待つ子の完了を `server-pleiad-agent` で確認 |
| ルーティン・予約・通知 | ルーティンの設定、会話とスレッドへの通知 | 実経路。再起動時の補完実行と返信を一度だけ行うことを `server-pleiad-agent` で確認 |
| bot・チャンネル・記憶・承認 | チャンネルの呼びかけ、bot の会話、承認カード | 一部。呼びかけから Pleiad Agent の返信を `server-pleiad-agent` で確認。bot 固有の記憶と承認の組み合わせは今回未実施 |
| 次のメッセージの候補 | 入力欄の候補、独立したモデル呼び出し | 実経路。道具を渡さず、古い候補を捨てることを `server-pleiad-agent`、候補の共通処理を `prompt-suggestions` で確認 |
| 題の自動付け | 会話一覧、`suggestTitle`、独立したモデル呼び出し | 実経路。モデルを引き継ぎ、手動の題と履歴を保つことを `server-pleiad-agent` で確認 |
| 秘密情報・接続先・操作の設定 | 設定の「秘密情報と変数」と接続先、`secrets.*`、`ply_control` | 保存キーを選択先だけに使い、会話に返さないことを `server-pleiad-agent` と配布物で確認。共通の秘密操作は `server-secrets`。標準入出力の子に秘密を環境変数で直接渡さない |
| リモート・ホスト引き継ぎ・更新 | リモート接続、会話の再読み込み、アプリの更新 | 一部。共通のリモート接続を `remote-agent-e2e`、管理下と PC の間の委譲を `managed-host` で確認。更新を挟んで実行中のターンを移す機能は下記の制限に従う |
| 通話 | 通話ボタン、音声用 WebSocket、共通のターン送信 | 共通。偽の音声プロバイダーで聞き取りから読み上げを `server-voice`、発話と割り込みを `voice-turns` で確認。Pleiad Agent と配布物を使った通話の一続きの確認は今回未実施 |

## 配布物とイメージ

Windows x64 は `npm run desktop:dist -- --win --x64 --publish never` で作った未署名の展開済みアプリを使った。二つの空のデータフォルダーで実行し、画面の入力欄の起動、既定では選択肢に出ないこと、明示登録しても接続先を選ぶまではモデルへの要求がないことを確認した。二つの偽の接続先のうち保存して選んだ先だけに、正しい認証ヘッダーで一往復した。Windows のインストーラー実行、ARM64 実機、署名の確認は別に行う。

Windows とクラウドの接続確認に使ったビルドは、対応宣言と承認の永続化を修正する前のソースを使った。修正後のソースで、再起動後にも同じ会話に「常に許可」が効くことを `server-pleiad-agent` で確認した。

macOS は [評価版の配布ワークフロー](../.github/workflows/evaluation-release.yml) の `mac` と `mac-smoke` を確認した。`PLY_MAC_RELEASE=on` で Apple Silicon と Intel のジョブが動き、Developer ID 署名、公証、成果物のアーキテクチャ、キーチェーンと画面の起動を検査する。配布候補を Mac で検査するときは、[配布手順](desktop-releases.md) で署名と公証を確認し、新しいテストユーザーで起動する。Pleiad Agent を明示登録し、認証情報を空のまま一度起動した後に、ループバックの偽接続先を保存して選択する。会話を一往復し、未選択の接続先への要求がないことを確認する。既存の CI の画面確認では共通の偽バックエンドを使う。

クラウドでは Plus の `deploy/cloud-host/test-model.sh` で、Pleiad と Pleiad Agent のコミットラベルを照合した。ネットワークをループバックに閉じ、空の永続領域でホスト本体を起動した。持ち込み接続を拒み、偽の Plus からホスト用の短命の券を取り、道具の定義付きでストリーミングし、返答が履歴に残ることを確認した。

ランナー経由の起動は Plus の `deploy/cloud-host/test-wsl.sh` で確認した。ブラウザーの入場券に承認済みワークスペースの ID と種類を含めるよう Plus API を更新し、初回承認、使い捨ての券、再接続を通した。

## 今の制限

更新を挟んだ実行中のターンの引き継ぎは、一般提供の必須条件にしない。更新はターン終了を待ち、終了済みの履歴は同じ会話に残る。実行中に更新自体を強制した場合の継続は保証しない。未解決の承認・質問カードの再表示は別の復旧経路で行う。

道具を使うエージェント内部のバックグラウンド作業も、一般提供の必須条件にしない。作業を別会話で進めるには Pleiad の委譲・ルーティンを使い、作業と承認を確認できる。題や発言候補のための内部呼び出しは道具を持たない。一般提供時の案内でも、ネイティブの子エージェントやバックグラウンド実行を対応機能に含めない。
