# 0229 OpenCode の上限と再試行の待ちを、走り続けに見せない

- 状態: 提案
- 関連: [0222](0222-agent-accounts-and-provider-quota.md)（エージェントの使用枠）、[0040](0040-delegation-routing-headroom.md)（委譲の振り分けの余裕）、[0048](0048-delegation-silence-notice.md)（無音の通知）、[0170](0170-delegation-background-notify-not-stop.md)（裏の作業の通知）

## 状況

- 2026-10-18、OpenCode の会話と、OpenCode に任せた子のタスクが、使用量の上限に当たった後も「動いている」のまま止まって見えた。委譲の子は `running` のままで、依頼元の `ply_task_wait` は 30 秒ごとに空振りし、振り分けは同じ委譲先を選び続けた。
- OpenCode 1.19.3 を、手元の偽のプロバイダー（課金なし）に向けて確かめた。
  - API の失敗（429・5xx・overloaded・接続の失敗）は、OpenCode が自分で最大 5 回再試行する。間隔は `retry-after-ms` / `retry-after` があればそれ、無ければ 2.4・4.8・9.7・18.3・39.3 秒。
  - 再試行の間、`session.status` は `{ type: 'retry', attempt, message, action?, next }`（next は次の再試行の epoch ms）で、各回の後に `busy` に戻る。Pleiad はこれを読んでおらず、ターンは「動いている」のままだった。
  - 上限の種類は `action` の reason で分かる。Free の上限は `free_tier_limit`（「Free usage exceeded, subscribe to Go」）、Go の週の上限は `account_rate_limit`（「Weekly usage limit reached…」と解除時刻）。
  - 単なる 429（「Rate limit exceeded」）は、5 回の後に `APIError` 429 で終わり idle になる。
  - 再試行の待ちの間に abort すると、すぐ idle になる。
  - 2026-10-18 の件では `retry-after` が 7 分を超えていた。
  - 2.0.32 も同じ形の status（加えて RetryPart）を持つ。再試行の方針は確かめていない。

## 決定

- **再試行の待ちを、独立した稼働の状態 `retrying` にする。** バックエンドは `activity { state: 'retrying', retry: { attempt, next, message, reason, limit } }` を出し、待ちが明ければ `running` を出す。画面は「上限で待機中・HH:MM に再試行（N 回目）」（上限でなければ「失敗のため待機中・…」）と出し、人の応答待ち（`waiting`）とは別の言い方にする。■ で止められる。会話の引き継ぎ（adopt）・会話の圧縮でも同じ。
- **待っても通らない上限は、ターンを `turnResult limited` で終える。** OpenCode の `free_tier_limit`・残高不足・解除時刻付きの `account_rate_limit` は、OpenCode の再試行を待たずに abort し、`resetsAt`（epoch ms）を付けて limited を返す。曖昧な 429 は `retrying` のまま OpenCode の再試行に任せる。
- **委譲の子が再試行を待っている間は、タスクを `status: waiting` に数える。** 上限による待ち・次の時刻が分からない待ち・次の再試行まで 60 秒以上の待ちに限る（数秒で戻る短い待ちのたびに依頼元を起こさない）。`ply_task_wait` はすぐ戻り、返り値に `retryWaiting` を付ける。待ちの回ごとに 1 回、依頼元へ理由と次の時刻を知らせ、待つか止めて任せ直すかを選べる文面にする。待ちが明ければ `running` に戻る。`waiting` に数えるのは依頼元へ見せる `ply_task_*` の返り値で、画面のタスク一覧は `running` のまま `retryWaiting` を添え、子の会話の稼働の表示（`retrying`）で待ちを見せる。
- **上限で止まった子は `failed` のまま `limit: { resetsAt, window }` を付ける。** 完了通知に解除の見込みと任せ直せることを添える。この子への `ply_task_send` は指示を積むが、解除時刻までは走らせない（送信待ちの `limitHolds` と同じ判断）。
- **振り分けは、上限に当たっている委譲先を外す。** 理由は `retry_waiting`（再試行を待っているターンがある）と `recently_limited`（最近 limited で止まった。解除時刻まで。時刻が分からなければ同じ委譲先のターンが次に通るまで）。`routing.skipped` に理由と `until` を載せる。記録はメモリだけで、起動し直すと消える。過去の解除時刻は記録しない。固定の委譲（`backend` を書いた）には効かせない。

## 理由

- 「動いている」と「上限で待っている」は、人と依頼元のエージェントが取る行動が違う（待つか、別の委譲先に任せ直すか）。同じ表示では判断の材料が無い。
- OpenCode の再試行は数秒から数分に伸び、上限の種類によっては何度待っても通らない。通らないものを待ち続けると、子は依頼元から見えないまま止まる。待つ価値のあるものだけを OpenCode に任せる。
- 時間の閾値で子を自動で止めない（止めるかは依頼元と人が決める）。Pleiad は知らせるだけにする。
- 振り分けが同じ上限に当たった委譲先を選び直すと、任せ直しても同じ所で止まる。

## 影響

- `core/backends/opencode-normalize.mjs`（`retryOf`・`errorOf.resetsAt`・`retrying` / `running` の出し分け）、`core/backends/opencode.mjs`（上限での abort・adopt と圧縮の再試行）、`core/backends/contract.mjs`（`retrying`・`resetsAt`）。
- `core/server.mjs`（`turn.retry`・`slotBlocked`・完了通知の上限の一行・`deliverRetry`・`held`）、`core/agent-tasks.mjs`（`waiting` の数え方・`retryWaiting`・`limit`・`limitHeld`）、`core/delegation-routing.mjs`（`blocked`）、`web/client.mjs`（稼働表示）、`web/delegation-routing-view.mjs`。
- やらないこと: 子が OpenCode の task ツールで起こしたサブエージェントの会話の再試行は見ない（親の会話の status だけを読む）。`limitedSlots` は保存しない。
- 文書: `docs/multi-backend.md`・`core/protocol.mjs` の表、`docs/agent-delegation.md`「上限と再試行の待ち」と振り分けの理由。
