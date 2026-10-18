# 0221 OpenCode は共有の `opencode serve` 1 本とし、Pleiad のツールはプラグインと中継の口で会話ごとに振り分ける

- 状態: 提案
- 関連: [0220](0220-backend-contract-and-agent-descriptors.md)（バックエンドの契約）、[0004](0004-multiple-agent-backends.md)（複数のバックエンド）、[0037](0037-manage-external-agent-versions.md)（外部のエージェントの版）

## 状況

- OpenCode に、Claude Code 向けと同じ機能を出したい（[issue #91](https://github.com/OzEngineJP/pleiad/issues/91)）。
- OpenCode のヘッドレスの口は `opencode serve`（HTTP + SSE）。実機（opencode 1.19.3）では 1 本で約 760 MB を使う。
- Pleiad は会話ごとに違う口（委譲の橋・操作の一覧・コンピューターの操作・ブラウザーの MCP のトークン）と、会話ごとのシェルの環境変数を渡す。
  OpenCode の MCP の設定は作業場所（instance）全体のもので、**MCP の呼び出しに会話の id は載らない**（実機で確認）。
- OpenCode のプラグインの `tool.execute.before` と `shell.env` は会話の id を受け取り、前者は引数をその場で書き足すと MCP の呼び出しに届く（実機で確認）。

## 決定

- **`opencode serve` は Pleiad のサーバーにつき 1 本を共有する**（会話ごとに起こさない）。作業場所は呼び出しごとの `?directory=` で選び、出来事は `/global/event` の 1 本で受ける。
- **Pleiad のツールは、Pleiad のプラグインと中継の口で会話ごとに振り分ける。** プラグイン（`OPENCODE_CONFIG_CONTENT` の `plugin` で読ませる。本文はデータ置き場に書き出す）が
  `ply_*` のツールの引数に OpenCode の会話の id を足し、Pleiad の `/mcp/opencode/<サーバー>` が、その会話のそのターンの口へ転送する。
  会話のシェルの環境変数は、プラグインの `shell.env` が `/mcp/opencode/env` から取る。合言葉は Pleiad の起動ごと。結び付いていない会話の呼び出しは断る。
- 利用者の `opencode.json` は書き換えない。Pleiad が起こした OpenCode は `autoupdate: false` にする。
- 「既定」のモデルでも、Pleiad が決めたモデル（OpenCode の設定の `model`、無ければ OpenCode Zen の既定）を明示して送る。
- 巻き戻しに `revert` は使わない（ファイルの変更まで戻すため）。Pleiad の写しで戻す。
- **互換の接続先（Pleiad の compat endpoints）は OpenCode には作らない。** OpenCode は接続先（provider）を自分で持ち（`opencode auth login`・`opencode.json` の `provider`。OpenRouter・LiteLLM・Ollama などの OpenAI 互換も入る）、Pleiad のモデルの一覧にもつないだ接続先のモデルが出る。共有のサーバー 1 本に会話ごとの接続先を足すと、接続先を変えるたびにサーバーを起こし直すことになる（走っているターンが止まる）。
- **Pleiad がそろえる Hooks は、Claude Code の形を真似て渡す**（エージェントの記述の `hooksAs`）。OpenCode のフックは JS のプラグインでコマンドの形が無いため。ツールの前後は Pleiad のプラグインが中継の口 `/mcp/opencode/hook` を呼び、発言の前・会話の始め・終わりの前はバックエンドが走らせる。
- **Pleiad 担当のコンテキスト（ply_context）のターンは、そのターンだけ専用の `opencode serve` を起こす。** 指示はプロセス全体の設定（`OPENCODE_DISABLE_PROJECT_CONFIG`・設定の置き場）でしか止められず、
  Skills の一覧も会話の権限の規則では消えないため。全体の設定の置き場は担当の種類を外して写し、作業場所の設定は渡し直す。作業場所の `.opencode` のエージェント・コマンド・プラグインは、そのターンでは読まれない（受け入れる）。
- **無停止の更新（[ADR 0151](0151-zero-downtime-update.md)）では、共有の `opencode serve` を保持役の子に載せ、プロセスだけを持たせる。** 新しいサーバーは、子の札に置いた待ち受けの URL・basic 認証・中継の合言葉でつなぎ直し、
  走っていたターンは OpenCode に聞き直して組み立て直す（会話の発言・答えていない承認と質問・会話の状態）。Codex のように stdout の記録を再生しない（HTTP と SSE には記録が無く、OpenCode が会話の状態を持っているため）。
  会話のシェルの環境変数（秘密情報）は札に入れず、データ置き場のファイルに置く。

## 理由

- 会話ごとに起こすと、会話の数 × 約 760 MB になる。
- 会話ごとの口を MCP の設定だけで渡す手段が無い。プラグインは OpenCode の公式の拡張の口で、利用者の設定を書き換えずに足せる。
- 「既定」を省くと、OpenCode は自分の覚えている最後のモデルを使い、画面の表示と食い違う（使えなくなったモデルで失敗した実例がある）。

## 影響

- 設計は `docs/multi-backend.md` §2.10、利用者向けは `docs/backends.md`「OpenCode」。
- OpenCode の版が上がってプラグインの口や出来事の形が変わったら、身代わり（`tests/lib/fake-opencode.mjs`）と実機の記録（`tests/lib/opencode-events.json`）を取り直す。
- フック・互換の接続先（作らない）・無停止の更新・Pleiad 担当のコンテキストは、issue #91 で決めて足した（上の決定）。Pleiad 担当のコンテキストの試験は `tests/unit/server-opencode-context.mjs`。
- 無停止の更新の設計は `docs/multi-backend.md` §2.10「無停止の更新」、試験は `tests/unit/adopt-opencode.mjs`（身代わりの OpenCode を保持役に載せ、本物の引き継ぎの道・ターンの無い引き継ぎ・強制終了を通す）。
