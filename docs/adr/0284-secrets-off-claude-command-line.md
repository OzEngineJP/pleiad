# Claude の子プロセスのコマンドラインから秘密と MCP のトークンを外す

## 状態

承認（2026-10-29）

## 状況

秘密情報と変数（[ADR 0217](0217-secrets-and-variables-for-agents.md)）と、Pleiad が会話ごとに発行する MCP の Bearer トークンは、Claude の 2 経路で子プロセスのコマンドラインに載っていた（2026-10-29 に実機で確かめた）。プロセスのコマンドラインは、データ置き場の 0600 のファイルより多くの場所（同じ利用者のほかのプロセス・監視の道具）から見えるので、値やトークンを置いてはいけない。

- **C1**: Claude Code は `CLAUDE_ENV_FILE` の中身を Bash ツールの各コマンドに貼り、`bash.exe -c` の引数にする。今の env file は `export NAME='値'` の行を持つので、値が argv に載る。
- **C2**: SDK の `mcpServers` に HTTP の MCP（`ply_agents`・`ply_context`・`ply_computer`・`ply_browser`・`ply_control`・`ply_shell`。`headers.Authorization` にトークン）を入れると、SDK が JSON に直列化して `--mcp-config` の引数に置く。トークンが `claude.exe` の argv に載る。保持役経由の起動（`claude-held.mjs`）は SDK の args をそのまま使うので、同じ値が載る。

ほかのバックエンドと Pleiad 自身の起動は、env・stdin・0600 のファイルで渡していて、argv に値を組まない（同じ日にコードで確かめた）。利用者の書き方しだいでしか載らない経路は、下の「範囲外」に書く。

**この決まりは今後の経路にも当てはめる**: 秘密の値・会話ごとのトークンを、子プロセスの起動の引数（argv。JSON に包んだものも）に入れない。env・標準入力・0600 のファイルのパスで渡す。

## 決定

どちらも「ファイルに値を置き、argv にはパスだけを出す」形に変える。ファイルはどちらも `run/` に 0600 で書き、ターンの終わりに消し、消し損ねは起動時に片付ける（`run/claude-compat-<uuid>.json` と同じ扱い）。保持役の札にはファイルの名前だけを入れる（トークン・値は入れない）。名前の形を確かめてから `run/` の下に限って引くので、札が `run/` の外を指すことはない。

### C1: `CLAUDE_ENV_FILE` は「読み込む行」だけにする

- 値は `run/claude-env-<uuid>.vals`（0600）に `export NAME='値'` の行で書く。
- `CLAUDE_ENV_FILE` の `run/claude-env-<uuid>.sh` には、値ファイルを読み込む `[ -f '…' ] && . '…'` の行だけを置く。中身は argv に載るが、パスと固定の行だけで値は載らない。利用者が元から `CLAUDE_ENV_FILE` を付けていれば、そのファイルを先に読む行を頭に置く（Pleiad の値が後で勝つ。今までどおり）。
- **Claude の PowerShell ツールには秘密が届かなくなる。** Claude Code は env file を「素の代入の行だけ」として読み、代入でない行が 1 行でもあると全部捨てる（利用者が自分の `CLAUDE_ENV_FILE` を付けている会話では、今までも届いていなかった）。Bash・ply_shell には届くので、AI への一覧の文は「Bash ツールか ply_shell にだけ届き、PowerShell ツールには渡されていない」に替える（`agent:secrets.prompt.envFile`。出し分けは性質の印 `secretsViaEnvFile`。`core/backends/capability-marks.mjs` の TRAITS と `agent-marks.mjs` に足した）。
- 実装は `core/claude-env-file.mjs`。スクリプトと値ファイルは対で作り・消し（`dispose`）、付け直したターンは札のスクリプト名から両方を引き直す（`adoptClaudeEnvFile`）。起動時の掃除（`sweepClaudeEnvFiles`）は、消し損ねたスクリプト・対の値ファイル・対のスクリプトの無い値ファイルを消し、札が指す組は残す。

### C2: HTTP の MCP は `--mcp-config` のファイルに載せる

- `plyServers` のうち sdk 型（`host`。SDK がインプロセスで持つ）だけを `options.mcpServers` に残す。
- HTTP の MCP は `{ mcpServers: { … } }` を `run/claude-mcp-<uuid>.json`（0600）に書き、`extraArgs` の `mcp-config` にファイルのパスだけを渡す（CLI の `--mcp-config` は JSON 文字列とファイルのパスの両方を受け、複数指定はマージする。`setMcpServers()` より、query の組み立てと付け直しの両方で同じ形にできるこちらを採る）。
- 実装は `core/claude-mcp-file.mjs`。札は `backendCard.mcpFile` に名前だけを持ち、付け直しは `adoptClaudeMcpFile` で引き直す（CLI は起動のときだけ読むので、走っている CLI の設定を読み直す必要はない。ターンの終わりに消す）。起動時の掃除は `sweepClaudeMcpFiles`。

### 範囲外（M1〜M3）

利用者の書き方でしか値が載らない経路（Codex の hooks の確かめの `-c hooks=`、ネイティブ stdio MCP の `${env:X}` の argv 展開、hook-adapter のコマンドの base64url）は、Pleiad が値を argv に組む経路ではないので今回は対象外とする。直すなら、hooks の定義は 0600 の config か標準入力で、展開した値は env で、hook のコマンドは 0600 のファイルのパスで渡す。

## 理由

- コマンドラインは、値を書くファイルやログより「外に出る先」が広い（EDR・プロセスの一覧）。ファイルに置いてパスだけを出せば、argv に載るのは値ではなく場所になる。
- `.vals` に分けると、読み込み側（`.sh`）は値を持たないまま Bash のシェルに値を届けられる。値を CLI の env に入れる案（`PLEIAD_SECRET_*` の付け替え・名前の振り分け）は、hooks・stdio MCP・CLI の子へ値が広がり、ADR 0217 の「hooks と MCP には渡さない」に反するので採らない。
- PowerShell ツールへ届かなくなるのは、Claude Code の env file の読み方では避けられない（上流の制約）。Bash・ply_shell に届くことを一覧の文に書き、そちらで使うよう明示する方が、条件しだいで黙って届かない今の形より分かりやすい。
- 保持役・起動の掃除・札は既存の flag 設定ファイルと同じ仕組みに乗せ、新しい管理の形を増やさない。

## 影響

- 新しいファイル `run/claude-env-<uuid>.vals`・`run/claude-mcp-<uuid>.json`（`tests/data-writes-allowlist.mjs`）。`run/claude-env-<uuid>.sh` の中身は値を持たなくなった。
- 性質の印 `secretsViaEnvFile` を TRAITS・AGENT_TRAITS（全バックエンド。Claude だけ true）に足した。`backend.traits` から `secretsRuntimeFor` へ渡し、一覧の文を出し分ける。
- 辞書: `agent:secrets.prompt.envFile`（ja・en）。
- 読む側: `core/claude-env-file.mjs`（書き方）、`core/claude-mcp-file.mjs`（新規）、`core/backends/claude.mjs`（mcpServers の分割・札・片付け）、`core/server.mjs`（起動の掃除・文の出し分け）、`core/secrets-prompt.mjs`・`web/locales/*/agent.json`。
- ADR 0217 の「環境変数の渡し方」の Claude の項は、この ADR の形に置き換わる（向こうにも注記を足した）。
