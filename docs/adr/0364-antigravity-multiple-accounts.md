# 0364 Antigravity の 2 つ目以降のアカウントを、トークンのファイル保存で分ける

- 状態: 承認（2026-11-26）。実装済み（Ph3 の P3-1〜P3-5）。実機の確認は**未実施（人が確認中）**。結果は末尾の「実機確認の結果」に追記する
- 関係: [0222](0222-agent-accounts-and-provider-quota.md)（アカウントの分離。「Antigravity は持てない」を置き換え）・[0224](0224-bot-account.md)（bot のアカウント。Antigravity だけ `''` を撤回）・[0359](0359-connections-unify.md)（接続先。§7 の「Antigravity の頭の行は変えない」を撤回）・[0363](0363-antigravity-on-acp.md)（Antigravity の口は ACP）・[0362](0362-consolidate-backend-leak-guards.md)（能力の印の宣言）・[0264](0264-delegation-account-scope.md)（委譲の候補はアカウントの単位）

## 状況

0222 は、Antigravity（`agy`）が認証を OS の共有キーリングに置き、アプリ・外部 CLI と共有するので、Pleiad の中のロックでは分けられないと判断し、`accounts: false` を保った。仕事用と個人用の Google アカウントを 1 台で使い分けたい、という要望は残っていた。

agy 1.5.17 の実測（ログインはしていない）で次が分かった。

- 環境変数 `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` を付けると、トークンを鍵束でなく `<appDataDir>/antigravity-oauth-token`（暗号化されない JSON）に置く。起動のログに `Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set` が出る。
- `agy acp --app-data-dir <相対パス>` で置き場を変えられる。相対は `~/.gemini` から数え、`..` を含んでもよい。絶対パスは内部サーバーが断る。一番上の `agy --app-data-dir` は受けない（`flags provided but not defined`）。
- 一番上の `agy models`・`agy --print /usage` は `USERPROFILE=HOME=<フォルダー>` で同じ置き場を指せる。
- 個人用と会社用（`oauth-personal`・`oauth-business`）は同じ保存枠を共有する。
- ログアウト中の `agy --print /usage` は OAuth の URL を出したまま約 60 秒止まる。

## 決定

### 1. 1 つ目は鍵束のまま、2 つ目以降だけファイルに置く

- 1 つ目（今ログインしているアカウント。既定）は今のまま（OS の鍵束・端末でのログイン）。何も付けない。
- 登録したアカウントだけ、env `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`・相対の `--app-data-dir`・`--log-file` を付けて起こす。置き場は `<データ>/accounts/antigravity/<id>/.gemini/antigravity-cli`。台帳（`agent-accounts.mjs`）の形は変えない。
- 能力の印は `accounts: 'agent'`。Claude 以外の登録アカウントと同じに扱う（会話ごとの選択・フォルダーの既定・bot のアカウント・`ply_delegate` の `account`・委譲の段の複数アカウント・`pickAccount` の使用量による選択・上限での切り替え）。Antigravity だけの例外の分岐は作らない。`ply_delegate` の説明も変えない。
- 秘密の保管庫に入れる値は印（`{kind:'agy-file-token', method, at}`）だけ。Pleiad はトークンの中身を読まない。

### 2. 版が変わったときの守り（印のガードと順番）

- 2 つ目以降で agy を起こすたびに、ログの印を確かめてから、会話・ログインを進める（`assertFileStorage`）。出なければ止めて `AGY_FILE_STORAGE_UNSUPPORTED`（「この版の agy では 2 つ目以降のアカウントを分けられません」）。**鍵束へ黙って戻さない**（1 つ目のログインを上書きさせない）。
- ログインでは、`session/new` を 1 度試して印を確かめた**後**にだけ `authenticate` を送る。印が無いまま `authenticate` を送ると、鍵束に別のアカウントのトークンが書かれうるため。会話では `prompt` の前に確かめ、アカウントに紐づく会話は `authenticate` を一切送らない。
- 印が出ないのは上限ではないので、上限の切り替えには乗せず、そのアカウントを「使えない」として扱う。
- ログイン後、トークンのファイルが「普通のファイル・リンクでない・nlink が 1」で在ることを確かめる（`accountStatus.hasCredential`）。無いアカウントでは agy を起こさない（使用量・models・会話は `AGY_NOT_LOGGED_IN`。起こすと 60 秒止まる）。
- 止め方は 3 つ: `AGY_FILE_STORAGE_UNSUPPORTED`（版）・`AGY_APP_DATA_UNREACHABLE`（置き場、§3）・`AGY_NOT_LOGGED_IN`（ログインが要る。画面は他のエージェントと同じ［ログインする］）。文面は ja・en の `antigravity.accounts.*`。

### 3. 置き場と権限

- Pleiad のデータの置き場が `%USERPROFILE%` と別のドライブで、`~/.gemini` からの相対パスが作れないときは**断る**（`AGY_APP_DATA_UNREACHABLE`）。絶対パスは agy が受けず、別の置き場へ黙って落とすこともしない。
- アカウントのフォルダーとその中は、本人の Windows ユーザーだけが読めるようにする（`icacls /inheritance:r /grant:r *SID:(OI)(CI)F`。0222 と同じ）。ログイン前とログイン後の両方で付ける。
- アカウントのフォルダーを消すときはリンクを辿らない削除（既存の `remove`）。使用中は断る。
- ログのファイルは起こすたびに新しい名前にし（前の回の印を拾わない）、古いものは 5 本だけ残す。

### 4. ログインの流れ

- `accountLogin({ account, signal, emit, method = 'oauth-personal' })`。`method` の通り道だけを作り、画面には**まだ選ぶ欄を出さない**（個人用と会社用の方式の選択は実機の確認待ち。下記）。
- ACP の `authenticate` がブラウザーを開く。URL が agy の標準エラーに出たときだけ画面へ https の URL を渡し、それまでは「ブラウザーで Google にログインしてください」のメッセージだけを出す（画面のログインの段は、URL もコマンドも無いメッセージだけの表示を持つ。どのエージェントにも効く）。
- 取消・タイムアウトで子のプロセスを止める。1 つ目の端末でのログイン（`agy models` の 10 分ポーリング）は 1 つ目にだけ残す。

### 5. 追加の前の注意（利用規約）

- Google の FAQ は、使用量の上限を避けるためにアカウントを自動で順に回す使い方を、個人向けプランの「サポート対象外」としている。**禁止とは書かれていない**。Pleiad は特別な制限を入れない（0222 の方針のまま、Claude・Codex と同じに扱う）。
- 代わりに、2 つ目以降を足すときだけ注意のモーダルを出す。エージェントの記述（`agents.mjs`）が `accountAddNotice`（文言の鍵）を持ち、`describeBackends` から画面へ通る。画面は id を直書きしない。
  - 題「2 つ目の Google アカウントを追加します」、ボタン「理解して追加する」「やめる」（Esc も同じ）。台帳に足すのは必ず 2 つ目以降なので毎回出る。
  - 文言は web の `agentAccounts.addNotice.antigravity.*`（ja・en）。

### 6. 候補として載せるだけのもの

- 偽の `SSH_CONNECTION` を渡して agy をファイル保存に倒す道（T3 Code が使う）は、環境変数の名前が公開の仕様でないため実装しない。env が効かなくなった版が出たときの代案として、ここに書くだけにする。

### 7. 変えるもの

- 0222（Antigravity の段）・0224（bot は `''` だけ）・0359 §7（頭の行は変えない）は、この ADR で置き換える。画面は、Antigravity も Claude・Codex と同じ［接続先］の面を持つ（`capabilities.accounts` で分岐し、id では分岐しない）。
- `docs/backends.md`、`site/docs` の Antigravity の接続の説明。

## 結果

- 良い点: 仕事用と個人用を 1 台で分けられる。他のエージェントと同じ道（台帳・選択・委譲・使用量）を使い、Antigravity だけの分岐を持たない。版が変わって印が出なくなっても、1 つ目のログインを壊さず止まる。
- 悪い点: 2 つ目以降のトークンはディスクに暗号化されずに置かれる（フォルダーの権限で守る。0222 の他のエージェントのファイルと同じ水準）。env・`--app-data-dir` は agy の非公開の挙動に頼るため、版が変わると止まる（ガードで検知して止め、更新を待つ）。

## 実機確認の結果

**未実施（人が確認中）。** 確かめる項目と、結果を書く欄:

| 項目 | 結果 |
|---|---|
| ACP の `authenticate` でブラウザーが開くか | （未） |
| 一番上のコマンド（`models`・`/usage`）を `USERPROFILE` で切り替えて同じトークンを読むか | （未） |
| 一番上のコマンドのログにも印が出るか | （未） |
| 1 時間後の更新がファイルに書かれ、鍵束が変わらないか | （未） |
| 会社のアカウントが `oauth-personal` で通るか（通らなければ方式の選択を画面に足す） | （未） |
