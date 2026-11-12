# 0319 会話の本文の描画を 3 層の部品（createLiveTurn → createHistoryPane → createConversationView）に分け、主を先に動かして、モーダルの子を同じ部品に載せる

- 状態: 承認（2026-11-12）。[0315](0315-two-watch-slots-modal-right-pane.md)〜[0318](0318-child-conversations-only-in-modal.md) に続く段 6。段 6-3（進行中のターン）は主の会話を動かさない移し替えとして実装済み
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
   | 2 | `createHistoryPane`（段 6-4） | 履歴の描画（ツールのまとまり・分け目・再読み込みの保ち方）。層 1 を中に持つ |
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

## 理由

- 同じ本文を 2 通りに持つと、主の修正がモーダルに届かず、モーダルは主と違う表示のままになる。部品を 1 つにすれば、直した所が両方に効く。
- 層を分けておけば、主を 1 段ずつ動かして、そのたびに主が変わっていないことを確かめられる。いきなりモーダルに載せ替えると、主とモーダルの両方が同時に壊れうる。
- 段 6-1 の表のとおり、モーダルの重さは「全部を読んで全部を描く」ことから来ている。主と同じ部品（末尾だけを描く）に載せれば、モーダルの値は主の値へ近づく。段 6 の目標はそこにある。
- 古い描き方のスイッチを 1 リリースに限るのは、載せ替えで壊れたときに戻せるようにしつつ、2 通りの描き方を長く残さないため。設定の画面に出すと、利用者が選べる状態になって 2 通りの保守が続く。

## 残る場合

- ネイティブの subagent とホストへ任せた子は、読み直しで描くので、層 2 の履歴の部品にはまだ載らない（行を描く関数だけが共通）。
- 段 6-3 の hooks の形は、段 6-4 で履歴の部品を足すときに増減しうる。この ADR は hooks の名前を固定しない（部品が `state.current` などを直に読まないことを固定する）。

## 影響

- 主の会話の動き・見た目・外から見える DOM（`id`・`class`・`data-key`・`data-uuid`・`data-h`）は変わらない。
- `client.mjs` から進行中のターンの描画（稼働表示・本文の流れ・thinking・ツールのまとまり・`resetLiveTurn` など）が `web/live-turn.mjs` へ動く。
- `client.mjs` のソースを切り出して試験していた単体試験は、`client.mjs` と `live-turn.mjs` を合わせて切り出す（`tests/lib/cut-source.mjs`）。期待は変えていない。
- 試験: `tests/unit/activity-strip.mjs`・`stream-frames.mjs`・`stream-prefix.mjs`・`session-stream.mjs`・`history-retain.mjs`・`tool-elapsed.mjs`、`tests/browser/main-thread-nav.mjs`・`work-dialog-live-stream.mjs`・`work-dialog-keep-open.mjs`、重さの測定は `tests/perf/child-modal-weight.mjs`。
