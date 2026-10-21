# エージェントごとの設定と挙動

Pleiad は各エージェントの CLI とログイン（またはサブスクリプション）を使う。利用者がそれぞれ用意し、Pleiad は資格情報を代わりに発行しない。

## Claude Code

認証は Claude Code のログインをそのまま使う。`ANTHROPIC_API_KEY` が設定されているとそちら（従量課金）が優先されるので、サブスクリプションで動かすなら未設定にしておく。

Claude のサブスクリプションを複数使い分けるなら、設定の「エージェント設定」→ Claude Code の「アカウント」に `claude setup-token` で発行したトークンを登録すると、会話ごとに入力欄（モデルの隣）でアカウントを選べる。選ばない会話はログイン中のアカウントで動く。
トークンはブラウザーでログイン中の claude.ai のアカウントで発行されるので、発行前にそのアカウントへ切り替えておく（使用量の表示の認可と別のアカウントのトークンなら、一覧に警告が出る）。

ログイン（OAuth）の期限が切れても `claude auth status` はログイン済みを返す。会話のターンが 401 で失敗すると、Pleiad はその失敗の行に「ログインの有効期限が切れています」と［ログインし直す］を出し、設定の Claude の行の下にも ⚠ の 1 行を出す（見分けは SDK の `authentication_failed`・`api_error_status: 401` と、例外の文面。覚えるのはサーバーのメモリだけ。[ADR 0212](adr/0212-claude-auth-expired.md)）。設定の行の名前の下に、Pleiad が使う `claude` の実行ファイルのパスを出す（Claude のデスクトップアプリに入っている別の Claude Code と取り違えないため。版はパスの説明に出す）。

Claude では会話のメタ情報の正本が `~/.claude`（SDK ネイティブの tag / customTitle / fork）なので、Pleiad で付けた状態やタイトルは公式の CLI・VS Code 拡張からも見える。

## Codex

ログインはサイドバー下の「バックエンド認証」から行う（`~/.codex/auth.json` は codex が書く）。

設定の Codex の「アカウント」から追加してログインすると、会話ごとに使うアカウントを選べる。選ばない会話は現在の CLI ログインを使う。登録したアカウントは認証と app-server を分け、CLI の設定・会話の記録・書き手のロックを共有する。Windows ではファイルのシンボリックリンクを作れる環境が必要。使用量の枠もアカウントごとに出る。

承認モードは「都度確認」「auto」「全部自動」「YOLO」「読むだけ」。

- 「全部自動」は作業ディレクトリ内の制限を残して確認を省く。
- 「YOLO」は確認なしで Codex のサンドボックス制限を解除し、全ファイル・ネットワークへのアクセスを許可する。
- 変更は次のターンから反映され、実行途中のターンや既存の承認待ちは変更しない。
- OS や管理者が別途設定した権限制限は YOLO でも解除されない。

## Antigravity

Google のサブスクリプション枠（AI Pro / Ultra）を使える唯一のバックエンド。

未インストールなら「バックエンド認証」に「インストール」が出る。インストーラーは Windows なら `%LOCALAPPDATA%\agy\bin`、Unix なら `~/.local/bin` へ置く。どちらも Pleiad が直接見るので、入れたあとは「再確認」だけでよく、Pleiad の再起動は要らない。

**ログインは端末で行う。** `agy` は認可コードを端末からしか読まないため、Pleiad からは回せない（公式も「Authenticate once with an interactive `agy` session first」としている）。「ログイン」を押すと端末で実行するコマンドが出るので、それを実行して Google にログインする。済むと Pleiad が気づいて表示が切り替わる。資格情報は OS の資格情報ストアに入るため、ログアウトも `agy` 側で行う。

`agy` のヘッドレスには対話の承認が無いので、選べる承認モードは「全部自動」だけ。`--dangerously-skip-permissions` を付けない限りツールは黙って拒否されるため、「計画だけ」「編集は自動」「都度確認」は出さない。思考は流れず、ツールは終わってから出る。本文は逐次流れるので、会話の見え方は他と変わらない。`agy` に一覧も履歴も無いため、会話の控えは Pleiad が `AGENT_HOST_DATA` の下に書く。

Antigravity 1.4.2 の複数アカウント切替は未対応。CLI とアプリが OS の認証を共有するため、Pleiad だけで認証を安全に分離できない。別のアカウントを同時に使う場合は、別の OS ユーザーや仮想マシンで環境を分ける（[認証の公式説明](https://www.antigravity.google/docs/install?tab=cli)、[ADR 0222](adr/0222-agent-accounts-and-provider-quota.md)）。

## OpenCode

OpenCode v2.0.32 以降の v2（`opencode`）の接続先をそのまま使う。OpenCode Zen の無料のモデルはログイン無しで使え、ChatGPT Pro/Plus・GitHub Copilot・API キーの接続先は端末の
`opencode auth login` でつなぐ（「ログイン」を押すとそのコマンドが出る。終わると表示が切り替わる）。外すのも端末の `opencode auth logout`。

複数のログインを使う場合は、設定の OpenCode の「アカウント」から追加する。Pleiad が表示する専用のコマンドを、Pleiad が動いている PC の端末で実行してログインする。会話ごとにアカウントを選べ、切替時には保存した会話を引き継いで新しい実行区間を始める。既存の OpenCode のログインは書き換えない。

使用枠は OpenCode Go・ChatGPT・GitHub Copilot の接続から読み取る。Go は既存の OpenCode OAuth access または API キーを Bearer として `GET https://opencode.ai/zen/go/v1/usage` に付け、5時間・週次・月次を取得する。`usage.{rolling,weekly,monthly}.percent` は百分率、`resetsAt` は絶対日時。月次を固定30日として扱わない。OpenRouter のキー別枠は照会・表示しない。

枠はアカウント → 接続先 → 期間で一度だけ表示する。現在の接続先を先頭にし、ChatGPT・GitHub Copilot など残りを「ほかの接続先」に畳む。委譲ではモデルの接頭辞に合う枠だけを使う（Go の provider は `opencode-go`）。既定モデルも実際の接続先へ解決する。他の接続先の枠で代用しない。

認証なし・OAuth 期限切れは `opencode auth login` の手順、契約なしを示す 403 EntitlementError は Go へのリンクを表示する。一般の 401/403・通信失敗・不正応答は取得失敗として再試行できる。同じ認証・接続先で取得した前回値は取得時刻つきで残すが、認証変更後は引き継がない。リセット済みの値は更新まで「—」。追加のブラウザーログインは不要（[ADR 0245](adr/0245-opencode-go-usage.md)）。

Pleiad は OpenCode のサーバー（`opencode serve`）を、現在の CLI ログインでは 1 本共有する。登録したアカウントは認証・設定・データの置き場とサーバーを分ける。利用者の `opencode.json`（MCP・権限・指示）はそのまま効き、
Pleiad は自分のプラグインとツール（委譲・操作の一覧・コンピューターの操作・ブラウザー）だけを足す。会話は OpenCode の側に残るので、OpenCode の TUI からも見える。

承認モードは「都度確認」「編集は自動」「全部自動」「YOLO」「計画のみ」。「全部自動」は作業ディレクトリの外へのアクセスを断る。

Hooks を Pleiad がそろえる場所では、Claude Code の形の登録をそのまま OpenCode の会話にも渡せる（渡し先に OpenCode を選ぶ）。OpenCode 自身のプラグインは止めない。

Pleiad を更新しても、共有サーバーで走っている OpenCode のターンは止まらない（承認待ちのままでも、新しい版で同じ承認が出る）。初回の v1 対応版からの更新は、古いターンを終えてから切り替える。Pleiad がコンテキストを担当する専用サーバーのターンも、終了してから切り替える。

旧会話は元の DB を退避し、OpenCode の公式変換が終わった後に同じ会話 ID で再開する。変換で外部ファイルの添付などが欠けた会話は、欠落を通知して再開を止める。元の記録と退避した DB は残る。

設定 › プラグインで指示・Skills・外部 MCP を「Pleiad がそろえる」にした場所では、Pleiad がそろえたものだけを OpenCode に渡し、OpenCode 自身の AGENTS.md・Skills・MCP は読ませない。
そのため、そのターンだけ専用の OpenCode を起こす（起動の数秒が足される）。作業場所の `.opencode` の中のエージェント・コマンド・プラグインは、その会話では読まれない。

システム管理者の設定に担当外のコンテキストがあり、隔離できない環境では開始時に理由を表示する。macOS の管理プロファイルがある場合も同様。Windows の専用サーバーは OpenCode のシステム設定用の置き場も隔離する。

v2.0.32 では、Bedrock の SigV4 で署名した圧縮要求に、Pleiad 担当として除外すべき古い指示が再び入る場合がある。この場合は送信を止めて理由を表示する。署名した本文を書き換えたり、担当外の指示を送信したりしない。新しい会話を始めるか、指示の担当を OpenCode に変えると再開できる。

互換の接続先（OpenRouter・LiteLLM・ローカルの Ollama など）は、Pleiad の「接続先」ではなく OpenCode の接続先としてつなぐ（`opencode auth login`、または v2 の `opencode.json` の `providers`）。つないだ接続先のモデルは、入力欄のモデルの一覧にそのまま出る。

## Devin CLI

ローカルの Devin CLI（`devin`）へ ACP で接続する。クラウドの Devin セッションを操作する接続ではない。
[公式のインストール手順](https://docs.devin.ai/cli)に従い、Pleiad が動く PC に CLI を入れる。

- Windows: 公式の x64 / ARM64 インストーラー、または PowerShell の `irm https://static.devin.ai/cli/setup.ps1 | iex`。
- macOS / Linux: `curl -fsSL https://cli.devin.ai/install.sh | bash`。macOS は Homebrew の `brew install --cask devin-cli` も使える。

Windows のインストール先 `%LOCALAPPDATA%\devin\cli\bin` と、macOS / Linux の `~/.local/bin`・Homebrew の置き場も探す。
別の場所の CLI は `AGENT_HOST_DEVIN_BIN` で指定できる。

ログインは同じ PC の端末で `devin auth login` を実行する（[公式コマンド一覧](https://docs.devin.ai/cli/reference/commands)）。
Pleiad の画面からのログイン、複数アカウントの切替は未対応。

Devin CLI のモデルは、モデル系列の代表と、思考の強さ・速度が別の選択肢になっている。モデル名の末尾だけを強さとして切り出さず、CLI が返す選択肢を使う
（[モデルの公式説明](https://docs.devin.ai/cli/models)、[ACP 接続の公式説明](https://docs.devin.ai/cli/acp/zed)）。
モデルの一覧には有料の候補も出す。既定は現在のカタログで無料と確認できる SWE-2 High を優先し、無ければ別の無料候補を使う。
無料の既定が無い場合や有料モデルを使う場合は、モデルを明示的に選ぶ。選んだモデル・思考・標準速度を ACP が確認しない場合は開始しない。
カタログに載っていても ACP が対応する選択肢を返さないモデルは使えない。
無料表示はアカウント・時期によって変わる。2026-10-18 の接続確認では `swe-2-high`・`swe-2-medium`・`swe-2-max` が Free と返った。
利用上限や請求額を保証する表示ではなく、残り使用枠を取得できないときは「不明」とする。

Pleiad が読むネイティブ設定の一覧が不明なときは、指示量や MCP の一覧を推定しない。
これは Devin 自身がネイティブ設定を読まないという保証ではない。Pleiad 管理のコンテキストを受け取れない場合は担当の切替を無効にし、
保存済みの担当が Pleiad でも、この会話では適用されない理由を表示する。
Pleiad 管理のコンテキストは MCP と注入文として配達するが、担当分のネイティブ読込を止める処理は未実装で、二重読込を防ぐ所有者分離が残る（[対応状況](https://github.com/OzEngineJP/pleiad/issues/108)）。
通常の会話では利用者のネイティブ設定とログインを保ち、会話データの置き場だけを Pleiad 専用に分ける。
Windows では CLI 本体が予期せず先に終了した場合、既存の `taskkill` による終了処理だけでは残った子プロセスをすべて回収できる保証はない。

## Grok Build

ローカルの Grok Build CLI に ACP で接続する。ログインは Pleiad が案内する `grok login` を端末で実行する。
会話のブラウザー、操作の一覧、秘密情報と変数、可視化の指示、Pleiad のシェルツール、委譲、Hooks を受け取る。
ブラウザーは Pleiad が割り当てた会話の Chrome を使い、別のプロファイルへ切り替えない。

実行中のモデル・承認モードの変更は、そのセッションへ設定要求を送る。モデルの応答が指定と一致しない場合や CLI が拒否した場合は、次のターンからの変更として扱う。再開時に保存済みのモデル・effortが今回の指定と異なれば、送信前に再適用し、応答が一致しなければ送信を止める。
Devin と Grok は、CLI が承認候補に `allow_always` を返したときだけ「常に許可」を選べる。

Grok のコンピューター操作の画像はファイル経由で渡す。CLI 1.0.62 では、MCPの画像と保存先を渡し、画像ファイルを開いて内容を読む経路を確認した。
Pleiad 管理のコンテキスト、複数アカウント、無停止更新、候補の生成などの残件は [対応状況の管理](https://github.com/OzEngineJP/pleiad/issues/108)で追跡する。
Pleiad に管理を任せない指示・Skills・MCPは、引き続き Grok 自身の設定が適用される。

Devin でも Pleiad のシェルツールと入力欄の `!` が使える。両者ともネイティブシェルを無効化する機能とは別である。

## コンピューターの操作

デスクトップ版（Windows）では、各エージェントに Pleiad の MCP `ply_computer` を渡し、画面を撮ってマウスとキーボードでアプリを操作させられる（[`computer-use.md`](computer-use.md)）。エージェントごとの違い:

- Claude Code: 違いは無い。ツールごとの承認は出さず、アプリの承認だけを聞く。
- Codex: Pleiad から起動した会話では、Codex に同梱の computer use を切る（利用者の `~/.codex/config.toml` は書き換えない。Pleiad の外の Codex には影響しない）。
- Grok Build: 画像の保存先を受け取り、ファイルを開いて確認する。読み取り専用モードではブラウザー操作用の指示を配らない。
- Devin CLI: MCPの画像を直接渡す。ツール結果の撮影情報は会話の画像表示にも使う。
- OpenCode: Claude Code と同じくアプリの承認を聞く。画像は MCP の image のまま渡す（モデルが画像を読めるかは、選んだモデルによる）。
- Antigravity: アプリの承認を聞かない（承認モードが確認なししか無いため。禁止のアプリは拒む）。画像はファイルを開いて見るので、1 回の撮影に 2 手かかる。別の会話が操作中のときは、3 分ごとに呼び直しながら待つ。

## 互換の接続先

Claude Code と Codex は、公式の接続先のほかに互換の接続先（OpenRouter・LiteLLM・ローカルの Ollama など）を登録して会話ごとに選べる。詳しくは [`design.md`](design.md) の「互換の接続先」。

## 使うときの注意

相対パスで指示すると、モデルが絶対パスを推測して見当違いの場所に書くことがある（会話自体は指定した作業ディレクトリで動いていて、Glob など作業ディレクトリ起点のツールは正しく効く）。確実にしたいときは絶対パスで指示する。
