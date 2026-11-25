# 開発規則

このリポジトリの変更作業の標準手順。ユーザーの個別の指示を優先する。

## 足す前に

- 機能・コード・試験・文書・ADR・この文書のどれでも、足す前に「減らす・既存へ寄せる・共通化する」案を先に考える。機能の採否は `docs/design.md`「2.1 セッションを離れずに済むこと」（3 つに寄与しないものは入れない）。
- 遅さ・不安定さは、先に測ってボトルネックを特定してから直す（`docs/dev-verification.md`「重さと動きを測る」）。
- lint・試験で止められる決まりはここに書かず、機械で止める。止まったら失敗の文言に従う。

## 作業の流れ（ADR 0003）

- 始める前に `git status --short --branch` と `git worktree list` を見る。既存の未コミット変更・他のブランチと worktree には触れない（stash・破棄・上書きしない）。
- 最新の `main` から作業ごとにブランチと worktree を作る: `git worktree add -b fix/<作業名> <メインの作業ディレクトリ>/temporary/worktrees/<作業名> main`。実装・試験・コミットは worktree の中で行い、依頼に要る変更だけを、対象を明示してステージする。
- `node_modules` は、依存が `main` と同じなら PowerShell の `cmd /c mklink /J <worktree>\node_modules <メイン>\node_modules` で足りる。**`git worktree remove` の前に `cmd /c rmdir <worktree>\node_modules` で外す**（外さずに remove するとメイン側の中身まで消える）。electron-builder でパッケージを作るときだけ `npm ci`。
- 検証が通ったらコミットする。worktree のブランチを `main` に取り込むのは push する直前にし、取り込んだまま push せずに置かない（別の会話が `main` から版を上げると、確認前の変更が一緒に公開される）。直前に `main` が進んでいれば worktree に取り込んで検証し直す。意図の分からない競合はユーザーに聞く。push はユーザーに頼まれたときだけ。
- 終わったら worktree を `git worktree remove`、ブランチを `git branch -d` で消す（強制しない）。報告は、変更・検証結果・コミット・main への反映・サーバーの状態と、残った手順とその理由。

## 構成

core/（サーバー。backends/ はエージェント 1 種類 1 ファイル、ops/ は画面・MCP・CLI へ出す操作の正本）・web/（画面。ビルド無し）・desktop/（Electron）・mobile/・relay/・bin/（CLI）・tests/・scripts/・docs/（`design.md`・`design-system.md`・`adr/`）。Node.js 22.16 以上。

環境変数: `AGENT_HOST_PORT`（既定 7420。使用中なら空きへ移る）・`AGENT_HOST_DATA`（既定 `~/.agent-host`）・`AGENT_HOST_BACKENDS`・各 CLI の実行ファイル（`AGENT_HOST_CLAUDE_BIN`・`AGENT_HOST_CODEX_BIN`・`AGENT_HOST_AGY_BIN`・`AGENT_HOST_OPENCODE_BIN`・`AGENT_HOST_DEVIN_BIN`・`AGENT_HOST_GROK_BIN`）。ほかの `AGENT_HOST_*` は使う所のコードと ADR にある（`git grep <名前>`）。

## 試験

- コード変更後は worktree の中で `npm test`（LLM を呼ばない）。1 本は `node tests/run.mjs <名前>`、ほかの引数は `tests/run.mjs` の冒頭。全件は 10 分を超えることがあるので、ログに書いて最後まで待ち、打ち切った結果を通過としない。
- `npm run test:e2e` は本物の LLM を呼ぶので、実サービスとの接続を確かめる変更でだけ流す。文書だけの変更は内容と `git diff --check` の確認でよい。
- 試験・画面の確かめでつまずいたら、先に `docs/dev-verification.md`。

## 画面の確かめ

- `agent-browser`（会話に専用の Chrome があればそれ）、無ければ `playwright-cli`。LLM を呼ばずに見るなら fake を別ポート・一時のデータ置き場で立てる（`docs/dev-verification.md`「fake で画面を出す」）。
- 自分が立てたサーバーは、起動ログの実際のポートか PID で止める。指定したポート番号で引いて止めない（別の作業のサーバーを止める）。
- 実データで測るときは `node scripts/copy-data-dir.mjs <temporary/ の下>` で写し（手でコピーしない）、測り終えたら消す。

## 設計の決まり

- 設計は `docs/design.md`、画面は `docs/design-system.md`、訳語は `docs/i18n-glossary.md`。
- サーバーはいつ落ちてもよい作りにする: 続きに要る状態は DB か保持役の記録に置き、通常の起動で復元する（ADR 0270）。
- データ置き場の保存は ADR 0115。DB の形を変えるときは形式番号を上げ、`core/schema-migration.mjs` の形で移行を足す（`docs/desktop-releases.md`「適用とデータ保護」）。
- リリースは `docs/desktop-releases.md`。

## 使い捨てのもの（ADR 0002）

- モック・メモ・スクリーンショット・一回きりのスクリプトは、メインの作業ディレクトリの `temporary/` に絶対パスで書く（worktree の中のものは worktree と一緒に消える）。コミットしない。
- コミットするのはコード・試験・今の動きを書いた文書と ADR だけ。承認された形は、モックへのリンクでなく形と日付を文書の本文に書く。

## ADR（ADR 0001）

- 書くのは ADR 0001「ADR が要るとき」に当たり、理由を残さないと同じ議論をやり直すものだけ。実装の修正・既存の決まりの範囲の手直し・調査の経過には書かない。
- `承認` にするのはユーザーの承認を受けたときだけ。living doc は今の形だけを書き、理由は ADR を指す。
- 長く並行するブランチの ADR は、`main` を取り込む前に、`main` の最大の次から番号を振り直し、`docs/adr/` に無いリンクを grep で確かめる。番号は `main` に取り込む直前に `origin/main` の最新を見て決め直す（重なったら付け直す）。

## サーバーの起動と確認

- マージ後はメインの作業ディレクトリで `npm start`（依存が変わったら先に `npm ci`）。実際の URL は起動ログで見て、トークン付きの URL で画面が取れることを確かめる（401 だけでは確かめたことにならない）。トークンをコミット・ログに残さない。文書だけの変更なら、今のサーバーの応答の確認でよい。
- **再起動すると走っているターンが終わる。** 止める前に画面か WS の `running` で 0 件を確かめ、走っていれば待つ。確かめられない・中断が要るときはユーザーに聞く。止めるのは確かめた対象だけ（Node を一括で止めない）。
- Windows で裏に立てるなら `Start-Process -WindowStyle Hidden`。`-RedirectStandardOutput`・`-RedirectStandardError` は付けない（シェルのツールが戻らなくなる）。ログは `Start-Process cmd -WindowStyle Hidden -ArgumentList '/c','node core/server.mjs > <ログ> 2>&1'`。
