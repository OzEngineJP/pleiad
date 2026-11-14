# 0330 Grok・Devin 自身の MCP を名前で止める（設定の置き場の写し）

- 状態: 提案（2026-11-15）
- 関係: [ADR 0327](0327-external-mcp-by-name-and-agent.md)（外部 MCP を名前 × エージェントの一覧にする）の「Devin・Grok は鍵」を変える。Antigravity は変えない。

## 状況

ADR 0327 の一覧で、Grok・Devin 自身の設定にある MCP は鍵だった（能力の印 `nativeMcpOff: impossible`）。どちらの CLI にも、会話ごとに MCP を名前で止める引数が無い。
- Grok: 起動の引数・ACP の `session/new` に止める口が無い。一方、GROK_HOME の `config.toml` の最上位の `disabled_mcp_servers`（名前の配列）は、利用者の `config.toml`・Claude の設定からの取り込み・作業場所の `.grok/config.toml`・`.mcp.json` のどの定義にも効く（実機で確認、Grok 1.0.62、2026-11-15）。
  - `managed_config.toml`・`requirements.toml` の `[[denied_mcp_servers]]` も起動のときは効くが、使わない。ログインした会話では、Grok が起動の直後に管理の設定をサーバーと同期し、写しに書いたファイルを消す（同じ実機で確認）。会話の途中で設定を読み直すと止めが外れうる。
  - 作業場所の定義（`.grok/config.toml`・`.mcp.json`）は、Grok が信頼したフォルダー（`~/.grok/trusted_folders.toml`）でしか起動しない。これは止める名前の有無に関係しない、今までの動き。
- Devin: 起動の `--config` は `config.json` の置き換えで、MCP は `mcp_config.json` から読む。`DEVIN_CONFIG_HOME/devin/mcp_config.json` の `disabled: true` は、ユーザーの設定の定義と、Claude の `~/.claude.json` からの取り込み（同じ名前なら mcp_config.json が勝つ）を止める。作業場所の `.devin/mcp_config.json`・`.mcp.json` の定義は止まらない（作業場所の定義が勝つ。実機で確認、Devin 3000.11.92、2026-11-15）。
- 止め方は「起動のときに Pleiad が止める」だけ（ADR 0327）。利用者の設定ファイルは書き換えない。

## 決定

- **止める名前があるターンだけ、設定の置き場の写しで起動する**（`core/backends/mcp-off-home.mjs`）。Grok は GROK_HOME、Devin は DEVIN_CONFIG_HOME を写しに替える。止める名前が無いターンは今までと同じ起動（環境変数も引数も変えない）。
  - 写しは本物の置き場のディレクトリをジャンクション（Windows）／シンボリックリンク、ファイルをシンボリックリンクでつなぐ。認証情報・会話の記録・ログの書き込みはリンクを通って本物に届き、写しに分かれない。
  - 止める名前を書いたファイルだけを Pleiad が写しに書く。Grok は `config.toml`（本物の中身の先頭に `disabled_mcp_servers`。本物にもあれば名前を合わせる。書いた結果を読み直し、「本物の中身＋止める名前」にならなければ止めずにエラー）、Devin は `mcp_config.json`（止める名前に `disabled: true`、本物に無い名前は `{ disabled: true }` を足す）。
  - SQLite の DB（`*.db` と `-wal`・`-shm`）はリンクしない（本物と写しから同時に開くと壊れうる）。Grok の `managed_config.lock` も写さない。写しにだけある普通の `managed_config.toml`（Grok の同期が写しに作ったもの）は、本物に無ければ次のターンの前に消す。
  - Grok の `sessions` は本物に作ってからリンクする（止める名前の有無・再開・分岐で記録が分かれない）。
  - Devin の `config.json` に `mcpServers` が残っている（Devin が `mcp_config.json` へ移す前の形）ときは、写しの `config.json` から外し、写しの `mcp_config.json` に移す（リンクのままだと、Devin の移し替えが本物の `config.json` を書き換える）。
  - 写しは「本物の置き場 × 止める名前の組」ごとに 1 つで、同じ組の会話は共有する。使うたびに印（mtime）を付け、12 個を超えて 1 日以上使っていないものだけを古い順に消す（OpenCode の写しと同じ規則）。
- **能力の印 `nativeMcpOff` に `'user'` を足す**。`true` はユーザーの設定・作業場所の設定のどちらの定義も止められる、`'user'` はユーザーの設定の定義だけ止められる。Grok は `true`、Devin は `'user'`。Antigravity は `impossible` のまま。
- **一覧の鍵に理由を付ける**（`reason`）。`'own'` は止める手が無い（印が無い・Codex の点つきの名前）、`'workspace'` は `'user'` のエージェントで作業場所の設定にも定義がある名前、`'relay'` は中継を受け取れない担当の組み合わせ（`mode: 'blocked'`）。`'admin'`（管理者の設定）は今は使わない。
  - Devin の名前の範囲は、走査の行の `scope` から決める（`core/context-session.mjs` の `agentMcp` が有効な定義の範囲を `scopes` に集める）。
  - 実行時も同じ規則: `'user'` のエージェントで作業場所の定義を含む名前は、止める名前に入れず（入れても使われ続ける）、同じ名前を Pleiad から中継しない（自身側が勝つ。ADR 0327 の鍵と同じ）。
- **反映は次のターンから**。どちらもターンごとに CLI を起こすので、次のターンの起動で写しを使う／使わなくなる。保持役（無停止の更新）に載るターンも、起動の環境変数に写しの場所を渡す。

## 影響

- 写しを作れない（Windows でシンボリックリンクを作る権限が無い。開発者モードか管理者が要る）ときは、ターンを始めずに `MCP_OFF_LINK_FAILED` のエラーにする。本物の `config.toml` が TOML として読めない・`disabled_mcp_servers` を 1 行の配列以外の形で書いてある、または Devin の `mcp_config.json` が読めないときは `MCP_OFF_UNSUPPORTED`。どちらも止めずにつなぐことはしない。
- ターンの外の起動（Grok の会話の一覧・読み出し・分岐のための起動、Devin のモデル一覧）は写しを使わない。MCP はターンでしかつながらない前提。
- 写しの中にエージェントが作る DB（Grok の `worktrees.db` など）は、写しごとに別になる。
- Grok が会話の途中で写しの `config.toml` に書いたもの（設定の変更）は、本物に届かず、次のターンで本物の中身から作り直す。写しにまだ無いファイル（`trusted_folders.toml` など）を Grok が作ると、写しにだけ残る。
- 画面（`web/`）は、鍵のセルの `reason` を出すと理由がわかる（今はどの鍵も同じ表示）。
