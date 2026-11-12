# 0319 会話の本文の描画を 3 層の部品（createLiveTurn → createHistoryPane → createConversationView）に分け、主を先に動かして、モーダルの子を同じ部品に載せる

- 状態: 承認（2026-11-12）。[0315](0315-two-watch-slots-modal-right-pane.md)〜[0318](0318-child-conversations-only-in-modal.md) に続く段 6。段 6-3（進行中のターン）・段 6-4（履歴の面）・段 6-5（本文の面）は主の会話を動かさない移し替えとして実装済み。段 6-6（モーダルの子を子の役の実例へ載せ替え）は実装済み
- 承認の内容: プロダクトオーナーが「子の会話のモーダルを主と同じ部品で作り直す」の残り（本文の描画の共通化）を「すぐやる。共通化すべき」として承認した
- 前提: [0318](0318-child-conversations-only-in-modal.md)（子の会話はモーダルだけで開く）・[0317](0317-modal-child-composer-stop-name-tags.md)（モーダルの名札・入力欄・中断）

## 状況

- 主の会話の本文は `web/client.mjs` の関数群が描き、モーダル（`#workDialog`）の本文は別の描き方（`openDetail` / `refreshDetail` / `readonlyThread`）で描いている。同じ「会話の本文」を 2 通りに持っているので、主で直した表示（ツールのまとまり・稼働表示・孫の委譲カードなど）がモーダルに届かない。
- 段 6-1 で、300 発言・ツール 50 件・20 ラウンドの同じ会話を、主とモーダルで測った（4 倍スロットル・3 回の中央値）。モーダルは全部を読んで全部を描くので、主（末尾の約 50 発言だけ描く）より大きく重い。

| 項目 | 主 | モーダル |
| --- | --- | --- |
| 最後の発言が見えるまで | 232 ms | 499 ms |
| 行が落ち着くまで | 469 ms | 499 ms |
| `.mw`（ツールのまとまり） | 70 | 301 |
| DOM の数 | 2132 | 9323 |
| `loadSession` の回数 / バイト | 1 / 12258 B | 2 / 142082 B |
| フレーム間隔 p50 / p95 / p99 / max | 16.7 / 16.8 / 50 / 100 ms | 16.7 / 33.4 / 450 / 483.3 ms |
| longtask の数 | 1 | 30 |
| LayoutCount | 1040 | 107 |
| LayoutDuration | 1.372 s | 1.069 s |
| TaskDuration | 9.449 s | 13.101 s |
| ScriptDuration | 1.415 s | 0.214 s |
| 流している間の `loadSession` の回数 / バイト | 1 / 21359 B | 23 / 1943840 B |
| 受けたバイトの合計 | 138381 B | 2059354 B |
| 流し終わりの行数 / DOM | 90 / 3832 | 322 / 10963 |

（段 6-1 の測定。`tests/perf/child-modal-weight.mjs --runs=3`。スロットル 4 倍・発言 300・ツール 50・20 ラウンド。）

## 決定

1. **本文の描画を 3 層の部品に分ける**。下の層は上の層を知らない。

   | 層 | 部品 | 持つもの |
   | --- | --- | --- |
   | 1 | `createLiveTurn({ thread, ...hooks })`（`web/live-turn.mjs`） | 進行中のターン（追記中の発言・ツールのまとまり・本文の流れ・thinking・稼働表示）の描画と状態 |
   | 2 | `createHistoryPane({ thread, log, ...hooks })`（`web/history-pane.mjs`。段 6-4） | 履歴の面（窓・最初の塗り・後からの足し・古いページの読み足し・静かな読み直しで残す行・実寸の確定）の描画と状態。段 6-4 では層 1 の実例を主が持ち、部品は `resetLiveTurn()` を hook で受ける |
   | 3 | `createConversationView`（段 6-5） | 目次・検索・スクロール・入力欄との結び付きなど、筋 1 本の見せ方。層 2 を中に持つ |

   部品は主の会話の値（`state.current` など）を直に読まない。必要なものは hooks で受ける。
2. **主を先に動かし、あとでモーダルの委譲の子を同じ部品に載せる**。段 6-3〜6-5 は主の動きと見た目を変えない移し替えだけ。モーダルは段 6-6 で載せ替える。
3. **古い描き方へ戻すスイッチは段 6-6 の版にだけ置く**。1 リリースだけ持ち、段 6-7 で外す。設定の画面には出さない。
4. **孫の委譲カードは、モーダルでも主と同じにつなぐ**（カードから孫のモーダルへ開く）。
5. **モーダルの履歴のツールのまとめ方は主と同じにする**（同じ部品が描く）。
6. **段 6 の後も残る違い**: 名札（[0317](0317-modal-child-composer-stop-name-tags.md)）・AI の名前をモデル名で出すこと・分岐／編集／再送が無いこと・git のバッジが無いこと。ネイティブの subagent とホストへ任せた子は、これまでどおり読み直しで描き、行を描く関数だけを共通にする。
7. **段 6-3 の hooks**（`createLiveTurn` が受けるもの）: `thread`・`log`／`isRunning()`・`stopping()`／`behind()`・`backgroundCounts()`／`turnStart()`／`aiMsg(opts)`／`placeRow(node, key)`／`atBottom()`・`followBottom(ms)`／`relayout()`／`onActivity()`／`stopComputer(bundle)`／`replaying()`・`painting()`／`nextSeq()`。
   - 状態（`turnEl`・`bundle`・`pendingUuid`・`endedWithText`・`turnClosed`・`streamEl`・`thinkEl`・`toolCards`）は部品の中が持つ。`client.mjs` の `state` の同名の項目は、部品の実例の getter / setter へつなぐ。
   - 今の関数名（`ensureTurnEl`・`appendText`・`resetLiveTurn` など）は、`client.mjs` に実例への薄い委任として残す。
   - モーダルの `#workDialog` は、この段ではまだ使わない。
8. **段 6-4 の hooks**（`createHistoryPane` が受けるもの）: `thread`・`log`／`atBottom()`・`placeRow(node, key)`・`spine()`・`relayoutBranches()`・`placeJunctions(opts)`・`paintDelegateStates()`・`paintCompactions()`・`syncEdit()`・`paintable(p)`・`updateBranches(id, messages, opts)`・`finalizing(on)`／`resetLiveTurn()`／`cmd(command, args, opts)`・`select(id, opts)`／`systemHistoryNode(m)`・`stripActions(node)`・`userMsg(text, opts)`・`aiMsg(opts)`・`thinkFromText(text)`・`noteEndpointFailure(card, result, sessionId)`・`linkDelegateCard(card, input, result, ctx)`・`activeBackendId()`・`subagentToolsOf(id)`・`isBoundaryTool(name, tools)`／`currentSession()`・`isBusy()`・`isLoadingSession()`・`backendVocab(backend)`・`toolCardMap()`。
   - 状態（`messages`・`base`・`presents`・`presentBase`・`earlierCalls`、窓の手前を描く仕事の `backfill`・`paintBefore`・`olderBusy`・`olderFail`・`olderEl`、描画中の印の `paintingHistory`）は部品の中が持つ。`client.mjs` の `state` の同名の 5 項目は、部品の実例の getter / setter へつなぐ（列挙できる項目のまま。`state` を丸ごと写す・並べる所は無い）。
   - 部品は `state` を直に読まない（`web/history-pane.mjs` の中の `state.` は 0）。historyRow の `sessionId` の既定値も `currentSession()` から引く。
   - 今の関数名（`paintHistory`・`retainThread`・`clearThread`・`historyRow`・`loadOlder` など）は、`client.mjs` に実例への薄い委任として残す。`loadHistory`・`syncHistory` は、主の `state`（今の会話・読み込み中の印・送信待ち）を読む画面全体の仕事なので、段 6-5 でも `client.mjs` に残す（面は `syncHistory` を hooks で受ける）。
9. **段 6-5 の `createConversationView({ sessionId, log, thread, frame, role, hooks })`**（`web/conversation-view.mjs`）: 層 1・層 2 の実例（`liveTurn`・`historyPane`）・出来事の取り置き（`createSessionLoads()`。実例ごとに 1 つ）・筋への行の置き方（`wrap`・`place`・`append`・末尾へ送る）・送った発言の行と配達の合図（`ensureMessageRow`・`markDelivery`・`syncOutboxRows`）を束ねる。主は `role: 'main'`・`frame: #logFrame` で 1 つだけ作る。
   - **`paintSession` の分け方**: 実例の仕事（履歴を描く・読み込み中に取り置いた出来事を流し直す・描き終えた後の位置決め）は `view.prepare`・`adopt`・`paint`・`finish`。画面全体の仕事（今の会話・上部のバー・入力欄の下書き・選択・読み込みの順序）は `client.mjs` の `paintSession` に残る。入力欄の下書きを戻す仕事は、最初の描画の前に呼ぶ `beforeFirstPaint` で渡す。
   - **`onEvent` の分け方**: 出来事を本文へ描く仕事は `view.apply(ev, replay)`。対象は `userMessage`・`taskInstruction`・`userMessage.delivered`/`dropped`・`text.delta`/`end`・`thinking.start`/`delta`・`tool.start`/`result`・`activity`・`taskNotice`・`channelEvent`・`interruptionNote`・`turnResult`・`present`・`turnEnd` の本文の部分。どの会話の出来事かの振り分けと、画面全体・主だけの仕事（上部のバー・既読・git・入力欄・送信待ちの一覧・声の配送）は `client.mjs` に残り、本文の描き方と混ざる出来事は、順序を保つ任意の hooks（`onStopping`・`onTurnOk`・`onReplyArrived`・`onTurnSettled`・`turnFailedRow`・`paintOutbox`・`markFailedMessage`）を `apply` の中から呼んで分ける。`permission`（承認カード）は、画面全体の `state.pendingPerms`・`thread`・`renderPermission` に結び付くので `client.mjs` に残す（段 6-6 で、置き先を実例ごとに選べるようにする。承認の一覧そのものは画面全体のまま）。`paintInterruptLine` も `client.mjs` の関数で、hooks で受ける。
   - **hooks**: 層 1・層 2 の hooks（段 6-3・6-4 と同じ）／出来事を描く `userMsg`・`userRaw`・`paintUser`・`paintUserTools`・`markSentBy`・`markSentLate`・`hhmm`・`taskNoticeNode`・`paintInterruptLine`・`turnFailedRow`・`syncHistory`／主だけの仕事（子は渡さない）`paintOutbox`・`markFailedMessage`・`voiceDelivery`・`provisionalByMessage`・`onStopping`・`onTurnOk`・`onReplyArrived`・`onTurnSettled`／会話を開く `setUuid`・`isEditing`・`outbox`・`onEvent`・`batchPaint`／主の会話の値 `currentSession`・`isBusy`・`isLoadingSession`・`backendVocab`。子の実例は `sessionId` で自分の会話を示し、`currentSession` に頼らない。
   - **子の会話の役（`role: 'child'`）の設定**: 事実は作業のダイアログの今の描き方（`readonlyThread`・`refreshDetail`・`historyRow` の `readonly`）から取った。分岐の筋・編集・再送・git の印は出さない／履歴の行は `readonly` で描く／発言のメニューは `CHILD_MENU`／`git`・`worktree` の提示は出さない／発言者の語は 最初=依頼・人が子へ直接送った発言=あなた・それ以外=追加の指示（古い分を省いた筋の最初は追加の指示）／追加の指示の行（差し込み待ち・待機・届かず終わった・届いた の 4 状態）／走っている子は末尾に稼働表示（弧だけ。ホストに届かない間・承認を待つ間は言い方が替わる）。この段では画面に使わず、設定と行の形を単体試験で確かめるだけ（作業のダイアログは読み直しの経路のまま。載せ替えは段 6-6）。
   - **独立の条件**: `web/conversation-view.mjs`・`web/live-turn.mjs`・`web/history-pane.mjs` は、主の `state`・画面全体の DOM（`getElementById` など）・保存先を直に読まない（単体試験が原稿を走査して守る）。別の会話の実例を作って履歴を描き出来事を流しても主の `#thread`・今の会話・題・スクロール・入力欄は変わらず、逆も成り立つことを、実ブラウザーの試験で確かめる。画面全体のもの（`state.current`・`state.pendingPerms`・入力欄・上部のバー）は `state` に残る。
   - 今の関数名（`messageRow`・`markDelivery`・`ensureMessageRow`・`syncOutboxRows`・`followBottom` など）は、`client.mjs` に `mainView` への薄い委任として残す。

## 段 6-6 の実装（モーダルの委譲の子を `role: 'child'` の実例に載せる）

委譲の子（`'task'`）をモーダル（`#workDialog`・`#workBody`）で開くと、本文は `createConversationView({ role: 'child' })` の実例（`.thread.bg-thread`）を `#workBody` の中に 1 つ持つ。主は変えない。

- **開く順**: 見張り（watch）→ 窓つきの `loadSession` → 取り置いた出来事の再生。開くたびに、前の実例を `disposeModalChild` で片づけてから作る。見張りの付け直し（再接続）も同じ順（先に watch、あとで窓を読み直す）。
- **出来事の振り分け**: `onEvent` が、モーダルが開いている子の会話の出来事（`MODAL_CHILD_EVENTS`: text・thinking・tool・activity・taskNotice・channelEvent・interruptionNote・turnResult・present・turnEnd・`userMessage`／`.delivered`／`.dropped`）を `modalView.apply` へ渡す。主が同じ会話を持っているときは主が勝ち、モーダルは描かない。追加の指示の出来事（`taskInstruction`、`task-send-` の messageId の `userMessage*`）は、一覧を読み直して行の状態を替える（`refreshModalInstructions`）。
- **承認カード**: `view.apply` は `permission` を扱わない。`state.pendingPerms` は画面全体のまま、置き先だけを実例で選ぶ（モーダルの子は `modalChildPermission` が `#workBody` の筋へ置く）。`permissionSettled` では `dropModalChildPermission` がカードを外す（従来の読み直しでは、決着した承認が履歴に無くカードも消えた。主は畳んで残すが、モーダルは従来どおり消す）。
- **片づけ**: 閉じる・別の項目へ移る・別の子を開くとき、`disposeModalChild` が目次（`createConversationToc`）・筋のナビ（`createThreadNav`）・ResizeObserver・タイマー・watch・取り置き（`loads.cancel`）を放す。ナビと目次は二重に付けない。
- **`revealMessage`**: 主の発言は `data-uuid`、モーダルの子の行は検索から開いたとき送る目印の `data-hit-uuid` で引く。子の行は `data-uuid` を持たない（`setUuid` の hooks が何もしない）ので、`thread`（`#thread`）を引くグローバルな `data-uuid` の探索（分岐・編集・再送・検索の飛び先・`forkAtReplyEnd`）に子の行は当たらない。全箇所を走査して確かめた。
- **スイッチ**: 設定 `childThreadRenderer: 'live' | 'reread'`（既定 `'live'`。設定の画面には出さない。`ply_control` と URL の `?childThread=reread` で替えられる）。`'reread'` は従来の `refreshDetail` をそのまま通る。古い経路は段 6-7 で外す。委譲の子以外（ネイティブのサブエージェント・ホスト委譲の子）は、スイッチに関わらず従来の読み直しの経路のまま。
- **子だけの差**（固定）: 発言者の語（依頼／あなた／追加の指示）・AI の名前＝モデル名・追加の指示の 4 状態・`CHILD_MENU`・分岐／分岐の接続点・git／worktree の印なし・メッセージの移動はモーダルの `createThreadNav`・孫の委譲カードの `linkDelegateCard`。
- **新しい役の設定 `yieldToReader`**: `followBottom` の追従を、読んでいる人が上へ動かしたらやめる（子の面だけ true。主は false で変わらない）。子の本文が 250ms おきに流れても、読んでいる位置を保つため。
- **見た目の差**（意図した変更。撮影は `%TEMP%\ply-s6-6\shots\`）: ① ツールのまとめ方が主と同じになる（本文で区切る。従来は本文をまたいで 1 つにまとめた。keep-open の台本で 6 本 → 3 本） ② 左の縦の筋の線が無くなり、点だけ（主と同じ） ③ 各ツールの行に時刻が出る（主と同じ） ④ 稼働の行にラベルと経過時間が付く（主と同じ）。
- **重さ**（`tests/perf/child-modal-weight.mjs`、300 発言＋ツール 50、CPU 4 倍・3 回ずつ交互。段 6-6 の前 → 後）: モーダルを開く 745〜1032 ms → 276〜353 ms／DOM 9,323 → 2,133 要素／loadSession 2 回・142 KB → 1 回・16.7 KB／流れている間の loadSession 10〜15 回 → 0 回／longtask 合計 8.6〜10 s → 0.4〜3.7 s。主は変わらない（開く 408〜562 ms・2,132 要素・1 回・12 KB）。
- **試験**: `tests/unit/conversation-view-child.mjs`（子の役の hooks・指示・dispose）、`tests/browser/child-modal-main-independence.mjs`（子が流れる間は主が、親が流れる間はモーダルが変わらない。`CHILD_THREAD=reread` でも流せる）。`work-dialog-keep-open`・`work-dialog-search-menu` は `CHILD_THREAD=reread` で従来の経路、既定で新しい経路を確かめる（新しい経路は流れている間の読み直しが 0 回・ツールのまとめ方が主と同じ、を期待値にした）。

## 理由

- 同じ本文を 2 通りに持つと、主の修正がモーダルに届かず、モーダルは主と違う表示のままになる。部品を 1 つにすれば、直した所が両方に効く。
- 層を分けておけば、主を 1 段ずつ動かして、そのたびに主が変わっていないことを確かめられる。いきなりモーダルに載せ替えると、主とモーダルの両方が同時に壊れうる。
- 段 6-1 の表のとおり、モーダルの重さは「全部を読んで全部を描く」ことから来ている。主と同じ部品（末尾だけを描く）に載せれば、モーダルの値は主の値へ近づく。段 6 の目標はそこにある。
- 古い描き方のスイッチを 1 リリースに限るのは、載せ替えで壊れたときに戻せるようにしつつ、2 通りの描き方を長く残さないため。設定の画面に出すと、利用者が選べる状態になって 2 通りの保守が続く。

## 残る場合

- ネイティブの subagent とホストへ任せた子は、読み直しで描くので、層 2 の履歴の部品にはまだ載らない（行を描く関数だけが共通）。
- 段 6-5 では、承認カード（`permission`）の置き先・`loadHistory`・`syncHistory`・`paintInterruptLine` が画面全体の側に残る。段 6-6 で、作業のダイアログを載せるときに実例ごとの置き先へ替える。
- hooks の形は、段 6-6 以降で部品を足すときに増減しうる。この ADR は hooks の名前を固定しない（部品が `state.current` などを直に読まないことを固定する）。

## 影響

- 主の会話の動き・見た目・外から見える DOM（`id`・`class`・`data-key`・`data-uuid`・`data-h`）は変わらない。
- `client.mjs` から進行中のターンの描画（稼働表示・本文の流れ・thinking・ツールのまとまり・`resetLiveTurn` など）が `web/live-turn.mjs` へ動く。
- `client.mjs` のソースを切り出して試験していた単体試験は、`client.mjs`・`conversation-view.mjs`・`live-turn.mjs`・`history-pane.mjs` を合わせて切り出す（`tests/lib/cut-source.mjs`。`openBridge()` が主の面を試験の中に組み立てる）。期待は変えていない。
- 段 6-5 で `client.mjs` から、履歴を開く仕事の実例の部分・出来事を本文へ描く仕事・送った発言の行と配達の合図・筋への行の置き方が `web/conversation-view.mjs` へ動く。主の動き・見た目・外から見える DOM は変えない。
- 段 6-5 の試験: `tests/unit/conversation-view-child.mjs`（子の役の設定・3 つの部品が主の値を直に読まない走査）・`tests/browser/conversation-view-independence.mjs`（別の会話の実例と主が互いに影響しない）。
- 試験: `tests/unit/activity-strip.mjs`・`stream-frames.mjs`・`stream-prefix.mjs`・`session-stream.mjs`・`history-retain.mjs`・`tool-elapsed.mjs`、`tests/browser/main-thread-nav.mjs`・`work-dialog-live-stream.mjs`・`work-dialog-keep-open.mjs`、重さの測定は `tests/perf/child-modal-weight.mjs`。
