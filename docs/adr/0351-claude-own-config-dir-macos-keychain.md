# 0351 macOS でも専用フォルダ方式を使えるようにする（キーチェーンの読み書きは CLI に任せ、Pleiad は項目の有無だけを見る）

- 状態: 提案
- 関係: [ADR 0345](0345-claude-account-own-config-dir.md)（専用フォルダ方式）・[ADR 0350](0350-claude-own-config-dir-default-remove-b1.md)（段 2。macOS を止め、対応はこの ADR に回した）・[ADR 0340](0340-claude-connectors-per-account.md)（b1。macOS の読み取り経路の準備）

## 状況

段 1 の `ownDirLogin` は `<専用フォルダ>/.credentials.json` があるかでログインを判定する。macOS にはこのファイルが無いため、常に「ログインし直す」と案内してしまう。ADR 0350 では、macOS を「この OS ではまだ使えない」として止めた。

2026-11-24 に Mac の実機で確かめた（CLI 2.1.322 / SDK 0.3.288、Darwin 27、画面のあるログイン。b1 の確かめのときに得たもの）:
- CLI は資格情報をキーチェーンの汎用パスワードに置き、`.credentials.json` を作らない。
- 項目名は、`CLAUDE_CONFIG_DIR` を渡すと `Claude Code-credentials-<その文字列を NFC 正規化した SHA-256 の先頭 8 桁>`、渡さないと `Claude Code-credentials` になる。パスの文字列で決まるため、symlink の別名や末尾の `/` があると別の項目になる。account は OS のログイン名（ADR 0340 の準備経路にある `claude-code-user` は誤り）。
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
  - 50・37・`security` が無い: `platform`（この Mac ではまだ使えない）。CLI が macOS で `.credentials.json` に保存した場合の扱いは決めない。
- headless は別に判定しない。上の結果で `keychain` か `platform` になる。実機で確かめるまでは、headless で使えるとは書かない。
- 期限切れのとき Pleiad は何もしない（CLI が更新する。実機で確かめた）。CLI が認証の失敗を返したときは、Windows と同じくログイン切れの印を付け、「ログイン」を出す。
- アカウントを消すとき（macOS だけ）は、専用フォルダを消す前に同じ `CLAUDE_CONFIG_DIR` で `claude auth logout` を呼び、CLI に自分の項目を消させる（Pleiad が `security delete-generic-password` を呼ぶとダイアログが出るおそれがあるため）。その後に有無を見て、項目が残っていればログに書き、削除は止めない。すでに消したアカウントの項目は、パスが分からないので掃除しない。
- ADR 0340 の準備経路 `readMacAccessCredentials`（b1 用。`-w` で中身を読み、account の名前も誤っている）は、この実装で消す。b1 は macOS で一度も動いていない。
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

止めたままにする範囲: M4 でダイアログが出たら（CLI の更新のたびに確認が出るので）止めを外さず、別の ADR で扱う。M8 で待ち続けたら、headless の Mac は `platform` で止める（判定の方法は別に決める）。試していない macOS の版や、CLI が `.credentials.json` に保存する形は、動くとは書かない（版では止めない）。

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

- `core/claude-connectors-auth.mjs`: `ownDirLogin` が有無を判定する関数を使うようにし、種類 `keychain` を足し、`readMacAccessCredentials` を消す。止めを外すときに、ADR 0350 で入れる darwin の止めを外す。
- `core/backends/claude-usage.mjs`: `credentialsMissing` の darwin の分岐を、有無を判定する関数に替える。
- `core/claude-accounts.mjs`: macOS では、`remove` でフォルダを消す前に `claude auth logout` を呼ぶ。
- `web/connectors-fail.mjs`・`web/mcp-matrix.mjs`・`web/session-context.mjs`・`web/locales/*`: `keychain` の文面を足す（ログインし直しは出さない）。
- 試験: 偽物の `security` で、終了コードごとの種類・ダイアログの出る呼び方（`-w`）をしないこと・4 つの経路の文字列が同じことを確かめる。
- Mac の確かめには、この実装のブランチを Mac で動かす必要がある（リモートへの push が要る）。
