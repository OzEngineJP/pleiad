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

## 理由

- 会話ごとに起こすと、会話の数 × 約 760 MB になる。
- 会話ごとの口を MCP の設定だけで渡す手段が無い。プラグインは OpenCode の公式の拡張の口で、利用者の設定を書き換えずに足せる。
- 「既定」を省くと、OpenCode は自分の覚えている最後のモデルを使い、画面の表示と食い違う（使えなくなったモデルで失敗した実例がある）。

## 影響

- 設計は `docs/multi-backend.md` §2.10、利用者向けは `docs/backends.md`「OpenCode」。
- OpenCode の版が上がってプラグインの口や出来事の形が変わったら、身代わり（`tests/lib/fake-opencode.mjs`）と実機の記録（`tests/lib/opencode-events.json`）を取り直す。
- Pleiad 担当のコンテキスト（`ply_context`）・フック・互換の接続先・無停止の更新は、issue #91 の段階 2・3 で足す。
