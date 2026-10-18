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

## OpenCode

OpenCode（`opencode`）の接続先をそのまま使う。OpenCode Zen の無料のモデルはログイン無しで使え、ChatGPT Pro/Plus・GitHub Copilot・API キーの接続先は端末の
`opencode auth login` でつなぐ（「ログイン」を押すとそのコマンドが出る。終わると表示が切り替わる）。外すのも端末の `opencode auth logout`。

Pleiad は OpenCode のサーバー（`opencode serve`）を 1 本だけ起こし、全部の会話で使う（1 本で約 760 MB）。利用者の `opencode.json`（MCP・権限・指示）はそのまま効き、
Pleiad は自分のプラグインとツール（委譲・操作の一覧・コンピューターの操作・ブラウザー）だけを足す。会話は OpenCode の側に残るので、OpenCode の TUI からも見える。

承認モードは「都度確認」「編集は自動」「全部自動」「YOLO」「計画のみ」。「全部自動」は作業ディレクトリの外へのアクセスを断る。

Hooks を Pleiad がそろえる場所では、Claude Code の形の登録をそのまま OpenCode の会話にも渡せる（渡し先に OpenCode を選ぶ）。OpenCode 自身のプラグインは止めない。

Pleiad を更新しても、走っている OpenCode のターンは止まらない（承認待ちのままでも、新しい版で同じ承認が出る）。

互換の接続先（OpenRouter・LiteLLM・ローカルの Ollama など）は、Pleiad の「接続先」ではなく OpenCode の接続先としてつなぐ（`opencode auth login`、または `opencode.json` の `provider`）。つないだ接続先のモデルは、入力欄のモデルの一覧にそのまま出る。

## コンピューターの操作

デスクトップ版（Windows）では、各エージェントに Pleiad の MCP `ply_computer` を渡し、画面を撮ってマウスとキーボードでアプリを操作させられる（[`computer-use.md`](computer-use.md)）。エージェントごとの違い:

- Claude Code: 違いは無い。ツールごとの承認は出さず、アプリの承認だけを聞く。
- Codex: Pleiad から起動した会話では、Codex に同梱の computer use を切る（利用者の `~/.codex/config.toml` は書き換えない。Pleiad の外の Codex には影響しない）。
- OpenCode: Claude Code と同じくアプリの承認を聞く。画像は MCP の image のまま渡す（モデルが画像を読めるかは、選んだモデルによる）。
- Antigravity: アプリの承認を聞かない（承認モードが確認なししか無いため。禁止のアプリは拒む）。画像はファイルを開いて見るので、1 回の撮影に 2 手かかる。別の会話が操作中のときは、3 分ごとに呼び直しながら待つ。

## 互換の接続先

Claude Code と Codex は、公式の接続先のほかに互換の接続先（OpenRouter・LiteLLM・ローカルの Ollama など）を登録して会話ごとに選べる。詳しくは [`design.md`](design.md) の「互換の接続先」。

## 使うときの注意

相対パスで指示すると、モデルが絶対パスを推測して見当違いの場所に書くことがある（会話自体は指定した作業ディレクトリで動いていて、Glob など作業ディレクトリ起点のツールは正しく効く）。確実にしたいときは絶対パスで指示する。
