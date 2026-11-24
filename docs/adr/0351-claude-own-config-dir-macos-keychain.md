# 0351 macOS でも専用フォルダ方式を使えるようにする（キーチェーンの読み書きは CLI に任せ、Pleiad は項目の有無だけを見る）

- 状態: 承認（2026-11-24、利用者が委任）。実装済み。macOS の止めは下の「Mac の確かめ」に合格するまで外さない。
  2026-11-24 の実機の途中結果（M1〜M4 合格・M7・M8 不合格）を受けて決定を直した（下の「実機の途中結果と直し」）
- 関係: [ADR 0345](0345-claude-account-own-config-dir.md)（専用フォルダ方式）・[ADR 0350](0350-claude-own-config-dir-default-remove-b1.md)（段 2。macOS を止め、対応はこの ADR に回した）・[ADR 0340](0340-claude-connectors-per-account.md)（b1。macOS の読み取り経路の準備）

## 状況

段 1 の `ownDirLogin` は `<専用フォルダ>/.credentials.json` があるかでログインを判定する。macOS にはこのファイルが無いため、常に「ログインし直す」と案内してしまう。ADR 0350 では、macOS を「この OS ではまだ使えない」として止めた。

2026-11-24 に Mac の実機で確かめた（CLI 2.1.322 / SDK 0.3.288、Darwin 27、画面のあるログイン。b1 の確かめのときに得たもの）:
- CLI は資格情報をキーチェーンの汎用パスワードに置き、`.credentials.json` を作らない。
- 項目名は、`CLAUDE_CONFIG_DIR` を渡すと `Claude Code-credentials-<その文字列を NFC 正規化した SHA-256 の先頭 8 桁>`、渡さないと `Claude Code-credentials` になる。パスの文字列で決まるため、symlink の別名や末尾の `/` があると別の項目になる。account は OS のログイン名（ADR 0340 の準備経路は当初 `claude-code-user` としていたが、ADR 0340 段 4 の記録でログイン名に直した）。
- `security find-generic-password -s <名前> -a <ログイン名>` を `-w` なしで呼ぶと、中身を読まず、確認のダイアログも出さずに項目の有無が分かる。`-w` で中身を読むとアクセスの確認が出る（「許可」で通る）。画面のロック中は確認を出せないので待ち続ける。
- 終了コード: 項目なし 44・ロック 36・拒否 128・認証失敗 51・鍵束なし 50・既定の鍵束なし 37。
- 専用フォルダで `claude auth login` を実行してブラウザーで認可すると、ハッシュ付きの項目ができる。アクセス用トークンが期限切れでも、同じフォルダの CLI を 1 回呼ぶと項目ごと更新され、ログインし直す必要はなかった。
- Pleiad でアカウントを消しても、項目は残った（フォルダは消える）。
- headless（ssh・GUI なし）は確かめていない。

専用フォルダ方式では、子 CLI と使用量の SDK が同じ `CLAUDE_CONFIG_DIR` でキーチェーンを自分で読み書きし、Pleiad はトークンを受け渡さない。設定 › アカウントの「ログイン」（`usage-login`。`accounts.usageDir(id)` で `claude auth login` を実行する）は macOS でもすでにこの形で動いている。そのため、ログインで作られる項目は、会話の子 CLI が読む項目と同じになる。

Pleiad がトークンの中身を読む必要があるかを洗った。本人照合の識別ハッシュ（`usageAccountDigest`）と `ownerStatus` は、専用フォルダの `.claude.json` の `oauthAccount` から取る。期限は CLI が管理する。トークンの受け渡しと期限の判定は段 2b で消える。中身を読む必要のある所は無い。

## 決定

- Pleiad は macOS でキーチェーンの中身（`-w`）を読まない。見るのは項目の有無だけで、Pleiad の操作でダイアログを出さない。
- ログインの有無の判定を 1 つの関数にまとめる（例: `claudeLoginPresent(dir)`）。Windows・Linux は今と同じく `.credentials.json` の有無で判定する。macOS は `/usr/bin/security find-generic-password -s <項目名> -a <os.userInfo().username>` を `-w` なしで呼び、5 秒で打ち切る。`ownDirLogin` と使用量の `credentialsMissing` の両方がこの関数を使う（使用量の行でも、macOS で「ログインし直す」を出せる）。
- 項目名は、ログイン・子 CLI・使用量の SDK に渡すのと同じ `CLAUDE_CONFIG_DIR` の文字列（`accounts.usageDir(id)`）から作る。realpath や末尾の調整はしない（今の Mac にある使用量のログインの項目をそのまま使うため）。渡す文字列を作る所は今の 1 か所のままにし、4 つの経路（ログイン・会話・使用量・有無の判定）が同じ文字列を使うことを試験で守る。
- 結果の扱い:
  - 0: ログインあり。
  - 44: 今と同じ `ownDirLogin`。「ログイン」を押すと今の `usage-login` が動く。
  - 36・51・128・打ち切り: 新しい種類 `keychain`。「Mac のキーチェーンを開けません。画面でロックを解除してから送り直してください」と出し、ログインし直しは出さない（ログインは消えていないため）。
    ただし実機では、`-w` なしの判定は鍵束のロック中でも 0 を返した（M7）。ロックをこの判定で見分けられるという前提は崩れたので、ロックは次の「断られたとき」の扱いで見分ける。
  - 50・37・`security` が無い: `platform`（この Mac ではまだ使えない）。CLI が macOS で `.credentials.json` に保存した場合の扱いは決めない。
- 断られたとき（macOS。M7 を受けて 2026-11-24 に足した）: 専用フォルダのログインを使った会話の CLI か使用量の SDK が認証の失敗で終わったら、項目の有無を見直す。
  - 項目が有る（0）か、有無を確かめられない（ロック・打ち切りなど）: 鍵束を開けなかったとみて `keychain` にする。ログイン切れの印（`ply-usage-expired.json`）は付けず、「ログインし直す」も出さない。会話の文面は上と同じ「Mac のキーチェーンを開けません。画面でロックを解除してから送り直してください」。
  - 項目が無い（44）・`platform`: 今までどおりログイン切れの印を付け、「ログイン」を出す。
  - Windows・Linux は変えない。
- ssh で起動したサーバー（macOS。M8 を受けて 2026-11-24 に足した）: `SSH_CONNECTION`・`SSH_TTY`・`SSH_CLIENT` のどれかに値があれば、専用フォルダ方式を `platform` で止める（試験用の外し方 `AGENT_HOST_MACOS_OWN_DIR=1` があっても止める）。画面の無いセッションの CLI は鍵束を開けず、ログインしていないと答えるため。`security show-keychain-info` でロックを見る案は、それ自体がダイアログを出すので使わない。
- 期限切れのとき Pleiad は何もしない（CLI が更新する。実機で確かめた）。CLI が認証の失敗を返したときは、Windows と同じくログイン切れの印を付け、「ログイン」を出す（macOS は上の「断られたとき」の分け方に従う）。
- ログイン切れの印は、そのアカウントのログインで会話が通ったときにも外す（どの OS も。M7 で、解除の後に送れても印が残り続けたため）。今までは使用量の読み取りが通ったときだけ外していた。
- アカウントを消すとき（macOS だけ）は、専用フォルダを消す前に同じ `CLAUDE_CONFIG_DIR` で `claude auth logout` を呼び、CLI に自分の項目を消させる（Pleiad が `security delete-generic-password` を呼ぶとダイアログが出るおそれがあるため）。その後に有無を見て、項目が残っていればログに書き、削除は止めない。すでに消したアカウントの項目は、パスが分からないので掃除しない。
- ADR 0340 の準備経路 `readMacAccessCredentials`（b1 用。`-w` で中身を読む）は、この実装で消す。b1 は macOS で一度も動いていない。
- macOS の止め（ADR 0350）は、専用フォルダ方式の検査の入口（`ownDirChecks`）で `platform` として止める。止めを外すのは、環境変数 `AGENT_HOST_MACOS_OWN_DIR=1` があるときだけにする。これは下の確かめに使う試験用のサーバーにだけ付ける。既定（変数なし・`1` 以外の値）は止めたままで、利用者の Mac ではこの判定に入らない。合格したら、この変数をやめて darwin を既定で通す。
- 段との並び:
  - 実装は b1 に触れないので、いつ入れてもよい。ただし ADR 0350 の macOS の止めを外すのは、下の確かめに合格してからにする。
  - 段 2a の既定の切り替えに Mac を含めるのは、2a のリリースまでに合格した場合だけ。間に合わなければ Mac は止めたまま 2a を出し、合格したリリースで止めを外す。2a・2b は Mac の確かめを待たない。
  - Mac には b1 が無い。そのため、準備に失敗しても b1 には戻さず、コネクターをオフのまま理由を出す。入口のスイッチでも b1 は選べない。
  - Mac には段 1.5 の数日の運用を課さない。戻り先の b1 が無く、失敗しても今と同じ「コネクターが使えない」状態になるだけなので。

## Mac の確かめ（止めを外す条件）

隔離したデータ置き場（`AGENT_HOST_DATA`）・別ポートのサーバー・使い捨ての private アカウントで行い、CLI / SDK は `VERIFIED_VERSIONS` の組を使う。実アカウントのログインは使わない。すべての項で、ダイアログが出たかどうかを記録する。AI は手順のスクリプトと記録を用意し、Mac の前の人は太字の操作だけを行う。

| # | 確かめること | Mac の前の人の操作 | 合格の条件 |
|---|---|---|---|
| M1 | 設定 › アカウントの「ログイン」 | **ブラウザーで認可** | Pleiad が計算した項目名で有無の判定が 0 を返し、CLI が作った項目名（`security dump-keychain` の属性。`-d` なし）と一致する。ダイアログは出ない |
| M2 | 本人照合 | なし | 専用フォルダの `.claude.json` に `oauthAccount` があり、識別ハッシュが取れる |
| M3 | 専用フォルダ方式の会話で、コネクターの読み取りの道具を 1 回呼ぶ。同時に使用量も読む | ダイアログが出たら**「許可」**を押して記録する | 子 CLI と SDK がダイアログを出さずに動く |
| M4 | CLI の版を替えて M3 をやり直す | 同上 | ダイアログが出ない |
| M5 | アクセス用トークンの期限を過ぎてから、会話と使用量を同時に始める（5 回） | **期限まで待つ（数時間。放置でよい）** | 両方通り、ログインし直しが要らない |
| M6 | ADR 0350 の T1（サーバー側の失効）を Mac で行う | T1 の手順の操作 | 保持中の会話が再起動なしで続く（キーチェーンから読み直す） |
| M7 | `security lock-keychain` で鍵束をロックしてから送る | **パスワードでロックを解除** | `keychain` の文面が出て「ログインし直す」は出ない。解除の後は送れる |
| M8 | ssh で入ってサーバーを立て、画面をロックした状態で送る | **ssh の用意と画面のロック** | 待ち続けず、理由（`keychain` か `platform`）が出るか、会話が動く |
| M9 | アカウントを消す | なし | `claude auth logout` で項目が消え（44）、ダイアログが出ない。共有の `projects/` などは残る |

試験用のサーバーは `AGENT_HOST_MACOS_OWN_DIR=1` を付けて立てる（付けないと M1 から `platform` で止まる）。

止めたままにする範囲（2026-11-24 に決めた）: M4 でダイアログが出たら（CLI の更新のたびに確認が出るので）止めを外さず、別の ADR で扱う。M8 で待ち続けたら、headless の Mac は `platform` で止める（判定の方法は別に決める）。試していない macOS の版や、CLI が `.credentials.json` に保存する形は、動くとは書かない（版では止めない）。

## 実機の途中結果と直し（2026-11-24）

| # | 結果 | 直し |
|---|---|---|
| M1〜M4 | 合格。CLI 2.1.322 と 2.1.331 のどちらでも、ダイアログは一度も出なかった | なし |
| M7 | 不合格。鍵束をロックしても `-w` なしの判定は 15 ms で 0（有る）を返し、送れてしまう。CLI は約 16 秒後に終了コード 1 で終わり、Pleiad は期限切れと判定して `ply-usage-expired.json` を書いた。解除の後は送れたが、`usageExpired: true` が残った | 断られたときに項目の有無を見直し、有れば `keychain`（印を付けない）。会話が通ったら印を外す |
| M8 | 不合格。ssh のセッションでは CLI が「User interaction is not allowed」で鍵束を開けず、`loggedIn: false` を返して 4 秒で失敗。Pleiad は期限切れと判定した | ssh で起動したら `platform` で止める。ssh でないときの同じ失敗は M7 の直しで `keychain` になる |

- 印が外れなかった原因: 会話が通っても、外していたのは CLI のログイン（`authExpired`）の印だけで、アカウントの `ply-usage-expired.json` は外していなかった。外すのは使用量の読み取りが通ったときだけで、失敗の続いた行は読む間隔を延ばしている（最長 15 分）ので、その間は印が残った。Windows・Linux も同じで、会話が通ったら外すようにした。
- 試験の補助の `recordAll`（`tests/lib/claude-launch-record.mjs`）は、Mac で動かすと b1 の入口が `platform` で止まり、起動の記録と比べられなかった。記録は起動の組み立て（ファイルの資格情報から env へ）を見るもので鍵束は関わらないので、入口に渡す OS を linux とみなす（期待値も linux の記録）。
- 残るおそれ: Mac でサーバー側の失効（M6）があると、項目は残っているので `keychain` の文面が出て、「ログインし直す」が出ない。M6 の結果を見て、失効の文面（401 の本文など）で期限切れと分けるかを決める。
- 残りの確かめ: M5・M6・M9 と、直した後の M7・M8 のやり直し。

## 理由

- 中身を読まなければダイアログが出ず、Pleiad がトークンを持つこともない（ADR 0345 の目的と同じ）。ログインの導線も止める理由も、項目の有無と終了コードだけで決められる。
- 項目名を今の文字列のまま揃えるのは、今の Mac の使用量のログインをそのまま使い、ログインし直しを求めないため。realpath を通すと、既存の項目と名前が変わる。
- 削除で CLI に消させるのは、項目を作った CLI なら確認なしで消せる見込みがあり、Pleiad が別の書き手にならずに済むため（M9 で確かめる）。
- 捨てた案:
  - Pleiad が `-w` で中身を読んで期限を見る案: ダイアログが出るうえ、b1 と同じ独自の判定が戻る。
  - CLI に `.credentials.json` へ保存させる案: 非公開の動きに頼り、平文で置くことになる。
  - Mac で先に b1 を通す案: 段 2b で消すもののため。
  - 孤立した項目を掃除する案: パスが分からず、無くても利用の流れは止まらない。
  - headless 専用の判定を作る案: 終了コードで足りる。

## 影響

- `core/claude-own-dir.mjs`: 有無を判定する `claudeLoginPresent`（項目名は `claudeKeychainService`）と、削除の前の `logoutClaudeOwnDir` を置く。
- `core/claude-connectors-auth.mjs`: `ownDirLogin` が `claudeLoginPresent` を使い、種類 `keychain`（ログインし直しは出さない）を足し、`readMacAccessCredentials` を消す。`ownDirChecks` に darwin の止めと試験用の外し方を入れる。合格したら止めを外す。
- `core/backends/claude-usage.mjs`: `credentialsMissing` の darwin の分岐を `claudeLoginPresent` に替える（44 のときだけ「ログインし直す」）。
- `core/claude-accounts.mjs`・`core/server.mjs`: `remove` でフォルダを消す前に `logoutClaudeOwnDir` を呼ぶ（macOS 以外と、フォルダの無いアカウントでは何もしない）。
- 実機の途中結果の直し（2026-11-24）:
  - `core/claude-own-dir.mjs`: 断られたときの見分け `macKeychainAuthFailure` と、ssh の見分け `sshSession` を置く。
  - `core/claude-connectors-auth.mjs`: `ownDirChecks` で macOS の ssh を `platform` で止める。専用フォルダの入口が会話へ `authFailure()` を渡す。
  - `core/backends/claude.mjs`: 専用フォルダの会話が認証の失敗で終わったら `authFailure()` を聞き、`keychain` なら `connectorsError` を添える（server は `connectorsError` があれば印を付けない）。
  - `core/backends/claude-usage.mjs`: 使用量の行も同じ見分けで `keychain` の行にする（`cliAuthFailed`・`reauth` を付けない）。
  - `core/server.mjs`: 印を付ける所（`markConnectorsLoginExpired`）でも同じ見分けをし、コネクターがオンのアカウントで会話が通ったら印を外す。
  - `tests/lib/claude-launch-record.mjs`: 入口に渡す OS（`recordPlatform`）。
- `web/connectors-fail.mjs`・`web/locales/*`: `keychain` の文面を足す（直し方は「送り直す」）。`web/mcp-matrix.mjs`・`web/session-context.mjs` は種類ごとの文面を locales から引き、「ログインし直す」を出す種類に `keychain` を含めないので、変えない。
- 試験（`tests/unit/claude-own-dir.mjs`）: 偽物の `security` で、終了コードごとの種類・ダイアログの出る呼び方（`-w`・`-g`）や書き換えをしないこと・4 つの経路と削除の logout の文字列が同じこと・darwin の止めと試験用の外し方を確かめる。CI に macOS は無いので、どの OS でも偽物で回る。
  実機の途中結果の直しは、偽の `security` と偽の CLI の失敗（401 の result・例外）で、断られたときの見分け・ssh の止め・使用量の行・`recordPlatform` を確かめる。会話が通ったら印を外すことは `tests/unit/server-claude-connectors-list.mjs` のサーバー通しで確かめる。
- Mac の確かめには、この実装のブランチを Mac で動かす必要がある（リモートへの push が要る）。
