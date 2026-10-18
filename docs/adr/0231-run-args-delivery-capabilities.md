# 0231. runArgs の配達物を能力の印で絞る

状態: 提案（2026-10-19）

## 状況

`server.mjs` はターンごとに `runArgs` を組み立て、`backend.runTurn` へ渡す。その中には機能の配達物（`browserEnv`・`browserRuntime`・`browserInstructions`・`computerRuntime`・`controlRuntime`・`secretsRuntime`・`visualizeInstructions`・`hooksRuntime` など）が混ざるが、能力の印を持つもの（`plyShell` など）は印で絞られていたのに対し、ブラウザー・ply_control・秘密情報・可視化・Hooks には印が無く、全バックエンドへそのまま渡っていた。JS の destructuring は余分なキーを黙って捨てるので、Devin（2026-10-18 の新規統合）がこれらを読んでいなくてもエラーも警告も出ず、「ブラウザーが届かない」が実際に開いてみるまで分からなかった。

## 決定

- ブラウザー・ply_control・秘密情報・可視化・Hooks に能力の印（`browser`・`plyControl`・`secrets`・`visualize`・`hooks`）を足す。全バックエンドが値を宣言し、対応表（`docs/backend-matrix.md`）に出る。
- `contract.mjs` に `RUN_ARG_FEATURES`（配達物のキー → 能力の印）と `RUN_ARG_PLUMBING`（プロンプト・承認・回線など全バックエンドに渡るキー）を定義し、`gateRunArgs` が runArgs を仕分けする: 印の無い配達物は消し、どちらの一覧にも無いキーは通常は警告、試験（`PLEIAD_BACKEND_CONTRACT=strict`）では例外にする。
- `server.mjs` は配達物を組み立てる時点でも印を見る（ブラウザーの中継の設定ファイルの作成や secrets の読み出し自体をスキップするため）。

## 理由

- 黙って捨てられることを不可能にする。新しい機能を足した側は `RUN_ARG_FEATURES` に 1 行足すだけで、全バックエンドに「印で受け取るか `false` と宣言するか」の明示を強制できる。
- 「まだ配線していない」が「対応しない」と区別できず受動的だった問題を、印の宣言で可視化する（matrix の「—」は明示した非対応になる）。
- strict 試験で未登録のキーが例外になるので、runArgs に項目を足す側にも登録を強制できる。

## 影響

- Devin にブラウザー（`AGENT_BROWSER_*`・ply_browser・指示）・ply_control（MCP と `PLEIAD_CONTROL_*`）・秘密情報と変数・可視化の指示が届くようになる（`browser`・`plyControl`・`secrets`・`visualize` = true）。`hooks`・`plyShell`・`computerUse` などは引き続き `false` で、届かない。
- Antigravity は可視化の指示を発言に入れていなかったので `visualize: false` と宣言し、配達を止めた（消費していなかったので挙動は変わらない）。
- 新しいバックエンドを足すとき、全部の印に値を書くことが backend-contract で強制されるのは従来どおり。配達物を増やす変更は `RUN_ARG_FEATURES` への登録が必要になる。
