# 0246 隠した Chrome の窓が前面を取ったときのプロフィールの窓と、使われなくなった窓の片付け

- 状態: 承認（2026-10-22）。実機で起きた 2 つの不具合（プロフィールを選んでも窓が開かない・終わった会話の隠した窓が溜まる）への修正
- 関連: [0148](0148-agent-browser-in-chrome.md)（Chrome の専用窓）、[0154](0154-agent-window-hidden-off-screen.md)（窓を隠す置き方と前面の見張り）、[0167](0167-chrome-connection-held-across-updates.md)（更新を越える窓の持ち越し）、[0219](0219-agent-browser-in-chrome-macos.md)（macOS の層）

## 状況

2026-10-22、利用者が普段使う Chrome（プロフィールは Default =「ユーザー 1」・Profile 1・Profile 2）で、「ユーザー 1」を選んでも窓が開かなくなった。調べると、Default の窓は Pleiad が隠した窓（画面の外・透明度 0・`WS_EX_LAYERED | TOOLWINDOW | TRANSPARENT`）が 21 枚あるだけで、見える窓は 0 枚だった。Profile 1 にも隠した窓が 2 枚あった。窓のプロフィールは、窓ごとの AppUserModelID（Default は `Chrome`、ほかは `Chrome.UserData.Profile1` の形）で見分けた。

原因は 3 つ。

1. そのプロフィールの窓が既にあると、Chrome はプロフィールの選択（プロフィールの選択画面・アバターのメニュー）で新しい窓を作らず、そのプロフィールで最後に使った窓を前に出す。それが Pleiad の隠した窓だった。
2. 前面の見張り（`desktop/chrome-os/win32.cjs` の `guardBody`）は、隠した窓が前面を取るとすぐ直前の前面へ返す。そのため利用者には何も起きないように見える。
3. 会話の窓が閉じられるのは、エージェントの `close_browser_window` と会話の削除（`core/chrome/close-window.mjs` → `relay.closeConversationWindows`）のときだけ。終わった会話の窓は隠れたまま溜まっていく。

## 決定

### 1. 人がプロフィールを開こうとしたら、そのプロフィールの見える窓を開く

- 窓のプロフィールは、**窓ごとの AppUserModelID** で見分ける。Windows の層に `windowAumid(hwnd)` を足し、`SHGetPropertyStoreForWindow` と `IPropertyStore::GetValue`（`PKEY_AppUserModel_ID`）で読む。読むだけで、窓には触らない。AUMID は不透明な鍵として比べ、`Chrome` を Default、`Chrome.UserData.*` をほかのプロフィールとして扱う（フォルダー名への変換はしない。空白の落とし方などが Chrome の版で変わりうるため）。
- 見える窓を開くときの `--profile-directory` は、**core の記録**（`core/chrome/windows.mjs` の `record.profile`）を確かな値として使う。`conceal`・`adoptAgent` に `profile` を渡し、層が窓の AUMID と対応づけて覚える。`launchWindow` で開いた窓は、題の nonce で見つけたときに同じ対応を覚える。AUMID からフォルダー名が引けない（core の記録が無い popup など）ときは開かない。
- **条件**: 隠した窓が前面を取り、そのプロフィールに見えている Chrome の窓（隠していない・透明でない・cloaked でない・最小化でない）が無いとき、`chrome.exe --profile-directory=<dir> --new-window`（`--user-data-dir` は直前の起動に合わせる）で見える窓を開く。隠した窓は隠したままにし、エージェントの作業は止めない。開いた窓は層の記録に載せない（エージェントの窓ではない）。
- **エージェントの操作との見分け**: 次のいずれかなら開かない（今までどおり直前の前面へ返すだけ）。
  - 窓が `ghost`（リモート デバッグのトグルを入れている最中）・`closeAt`（閉じる依頼中）・引き継ぎで見せている（`concealed` でない）。
  - 層がその窓を隠した・引き継いだ・開いた直後（2 秒以内）。開きかけの窓と `window.open` の popup を拾う。
  - 直前に前面だったのが、同じ Chrome の隠した窓（エージェントが窓を切り替えた）。
  - **直前に前面だったのが、隠していない Chrome の窓でない**。人がプロフィールを開こうとするときは、プロフィールの選択画面か Chrome の見える窓が直前に前面にある。ほかのアプリから隠した窓へ移った場合（エージェントの操作か、見分けられない場合）は開かない。
- 同じプロフィールで続けて前面を取っても窓を重ねないよう、AUMID ごとに 30 秒の間隔を置く。
- AUMID が読めない・プロフィールのフォルダー名が分からないときは、**開かずに今までどおり前面を返す**（分からないまま窓を増やさない）。ログにプロフィール名は出さない。
- **macOS** は `features.conceal = false` で、窓を隠さず見える通常の窓として使う（ADR 0219）。「隠した窓が前面を取る」ことが起きないため、この修正は要らない。`conceal` が効く別の OS を足すときは、同じ判定をその層に置く。

### 2. 終わった会話の窓を溜めない

- **長く使われていない会話の隠した窓を閉じる**。会話ごとに「最後に Chrome の窓を使った時刻」を中継（`core/chrome/relay.mjs`）が持ち、エージェントのコマンド・タブの採用・今のタブの変更・`openForConversation`・`endpoint`・引き継ぎ（`pause` / `unpause`）で更新する。`close-window.mjs` の `sweepIdle()` が、最後に使ってから既定 24 時間（`CHROME_WINDOW_IDLE_MS`）を過ぎた会話の窓を、`close_browser_window` と同じ道（`Page.captureScreenshot` → `chromeClosed` の行、`by: 'idle'`）で閉じる。サーバー（`core/server.mjs`）が 1 時間ごとに呼ぶ。
- 閉じない条件: ターンが走っている・人が引き継いでいる（`paused`）・人への依頼（`hand_to_user`）の答え待ち・中継の外で動いていると分かる会話（`isLive`）・更新の途中（OS の層が `pending`、または中継が引き継ぎで出ていく途中）。窓が無い会話は何もしない。
- **アーカイブ**: コードを確かめたところ、会話（セッション）のアーカイブに当たる操作は無い（`sessions.delete` は削除で、既に `close-window.mjs` を通る。`channels.archive` はチャンネルのアーカイブで、会話の窓とは関係しない）。そのため新しい入口は足さない。将来、会話を消さずに片付ける操作を足すときは、`chromeWindowCloser.close(sessionId, { by: 'human' })` と同じ道を使う。
- **更新（ADR 0167）との関係**: 最後に使った時刻は `snapshot()` の会話ごとの `lastUsedAt` に載り、`restore()` で戻す。古い預かり物に無ければ復元した時刻から数え直す。OS の層が `pending` の間は掃除をしない（窓の印の引き継ぎと競合しない）。掃除で閉じる窓は、通常の閉じる経路（CDP の `Target.closeTarget` → 層の `closeAgent`）だけを通り、`snapshot` / `restore` / `readopt` の状態を書き換えない。

## 理由

- **AUMID を使う**: Chrome は全プロフィールを 1 つのプロセスで動かすので、プロセスやコマンドラインでは窓のプロフィールを区別できない。窓ごとの AUMID は Chrome 自身がプロフィールごとに付けている値で、読むだけなら利用者の窓に触らない。実機で Default = `Chrome`、`Profile 1` = `Chrome.UserData.Profile1` を確かめた。
- **フォルダー名は core の記録から**: AUMID からフォルダー名を機械的に作ると、空白の扱いなどが Chrome の版で変わりうる。Pleiad が窓を開いたときの `--profile-directory` は確かなので、それを `conceal` / `adoptAgent` で層に渡す。
- **直前の前面を条件にする**: 「隠した窓が前面を取った」だけでは、`window.open` の popup・開きかけの窓・エージェントのタブ切り替えと区別できない。人がプロフィールを選ぶときは、選択画面か Chrome の見える窓が直前に前面にある。この条件と、隠した直後の猶予を組み合わせると、報告された場面だけを拾い、エージェントの操作では窓を増やさない。見分けられないときは開かない（安全側）。
- **隠した窓を閉じない**: 利用者が見たいのは「そのプロフィールの窓」で、エージェントの作業中の窓ではない。隠した窓を閉じるとエージェントのタブとログインが失われる。
- **24 時間・1 時間ごと**: 会話の続きに使う窓を急に閉じない。終わった会話の窓が丸 1 日残るのは許容し、その後の掃除で溜まらないようにする。定数 1 つなので、必要なら設定にできる。
- **アーカイブの入口を作らない**: 会話のアーカイブという操作が無いのに、それらしい入口を新設すると、削除との違いが曖昧になる。削除は既に窓を閉じ、静止画を残す。

## 影響

- 変えるファイル: `desktop/computer/win32.cjs`（`windowAumid`）、`desktop/chrome-os/win32.cjs`（AUMID・プロフィールの記録・人が開こうとしたときの見える窓・掃除の条件）、`core/chrome/os.mjs`（`conceal` / `adoptAgent` の `profile`）、`core/chrome/windows.mjs`（プロフィールを層へ渡す）、`core/chrome/relay.mjs`（最後に使った時刻・`lastUsed`・carry）、`core/chrome/close-window.mjs`（`sweepIdle`・`by: 'idle'`）、`core/server.mjs`（1 時間ごとの掃除）、`core/history.mjs`（`idle` の記録）、`web/chrome-control.mjs` と locale（閉じた行の文言）。
- 変えないもの: ADR 0154 の「隠した窓が前面を取ったら直前の前面へ返す」は残る。今回の修正は、その前に「人がプロフィールを開こうとした」と分かったときだけ見える窓を足す。
- 試験: `tests/unit/chrome-os.mjs`（AUMID・プロフィールの見える窓を開く条件・エージェントの操作との見分け・重複の抑制・分からないとき）、`tests/unit/chrome-windows.mjs`（プロフィールを `conceal` / `adoptAgent` へ渡す）、`tests/unit/chrome-relay.mjs`（`lastUsedAt` の carry）、`tests/unit/chrome-close-window.mjs`（24 時間の掃除・実行中／引き継ぎ／依頼待ちの除外・`idle` の行）。本物の利用者の Chrome は使わない。
- 実機で確かめること: Windows の AUMID の読み取り（読み取りだけ。窓は操作しない）、プロフィールの選択で見える窓が 1 枚開くこと、エージェントの `window.open` で余計な窓が開かないこと、24 時間の掃除が実際の時計で動くこと（短い間隔に変えて確かめる）。
