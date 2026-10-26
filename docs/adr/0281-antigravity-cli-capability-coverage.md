# 0281 Antigravity CLI の不足能力を実装・判定する

- 状態: 承認（2026-10-27）
- 関連: [0054](0054-shell-input.md)（入力欄の `!`）、[0273](0273-capability-states.md)（能力の印）、[0274](0274-capability-traits-and-public-marks.md)（能力と性質）、[0278](0278-capability-delivery-tests.md)（配達物の試験）、[#148](https://github.com/OzEngineJP/pleiad/issues/148)、[#151](https://github.com/OzEngineJP/pleiad/issues/151)

## 状況

Antigravity の可視化・入力欄の `!`・子の会話・互換接続・自動圧縮のしきい値には `todo` が付いていた。CLI の拡張に該当する仕組みがあるか分からず、コードと資料だけでは判定できていなかった。

## 決定

- 可視化の指示は、カスタムエージェントの定義に固定せず、各ターンの発言の前に渡す。Antigravity はエージェント定義を起動時に読むため、会話の途中で追加された指示も新規・再開の両方で届く。指示文は Pleiad の履歴にユーザー発言として保存しない。
- 入力欄の `!` は `shell: 'host'` とする。Pleiad が実行した結果を次のターンの本文に含める。
- Antigravity CLI 1.4.7 の `stream-json` は子の `conversation_id` と `log_uri` を含む `subagent_info` を出す。`agy agent` / `agy agents` は利用可能なエージェント定義の一覧であり、子の会話の本文を得る操作ではない。`log_uri` の実体・形式と完了後の読み方を確かめられていないため、`subagents` は `todo('#151')` のままにする。
- 同じ版の `customModelsConfig` は Gemini API key の設定に限られ、Google アカウントの認証では無視される。セッションごとの互換接続先を選べないため `compatEndpoints` は不可能とする。
- 同じ版の公式 CLI 引数・設定には、自動圧縮の開始しきい値を指定する手段がないため `autoCompactWindow` は不可能とする。自動圧縮自体は CLI の機能として残す。
- 実機 CLI の確認では、Gemini の枠を消費しない Claude または GPT のモデルを `--model` で指定する。

## 根拠

手元の `agy --version` は `1.4.7`。`agy --help` のヘッドレス入出力・セッション再開・モデル指定を確認した。公式の [headless mode](https://antigravity.google/docs/cli/headless/) は `subagent_info` に子の ID と `log_uri` が載ると説明するが、ログ本文の形式・取得方法は示していない。公式の [CLI reference](https://antigravity.google/docs/cli/reference/) は `--print` / `--conversation` / `--model` を記載する。公式の [CLI settings](https://antigravity.google/docs/settings?tab=cli) は `customModelsConfig` が Google アカウント利用時に無視されることを明記し、自動圧縮の閾値設定を載せていない。

## 影響

- 可視化と `!` の配達は `tests/lib/backend-delivery.mjs` で偽 CLI に渡ることを検査する。既存の `server-shell`・`server-visualize` 契約も維持する。
- CLI の拡張やヘッドレス API が後の版で追加された場合は、実機・公式資料を再確認して該当する不可能の印を更新する。
