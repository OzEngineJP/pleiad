# 0360 委譲の子の worktree は、委譲先を切り替えても片付けず、回の終わりに 1 度だけ片付ける

- 状態: 承認（2026-11-26）。§3 の外から起きたターンの扱い（送信待ちに失敗で残す）は同日の追補
- 関係: [ADR 0089](0089-worktree-on-demand.md)（worktree の作成と片付け）・[ADR 0136](0136-worktree-opt-in.md)（委譲は `isolate: true` のときだけ）・[ADR 0302](0302-delegation-prework-reroute.md)（仕事前のエラーの任せ直し）・[ADR 0355](0355-delegated-child-wake-notifies.md)（外から起きた子の回）

## 状況

`isolate: true` の子が上限（`limited`）やログイン切れで別の委譲先へ切り替わると（`run.limitSwitch`。同じ子の会話で続ける）、切り替えの直前のターンの終わりに `finishChild` が `worktreeHost.taskDone` を呼び、変更の無い worktree を消していた。子の会話の cwd は元の場所へ戻り（`worktreeBack`）、次の委譲先のターンの前に `renewTaskWorktree` が別の id の worktree を作り直した。その結果、

- タスクの記録の `worktree` は新しい worktree、`cwd` は消えた古い worktree を指したままになり、`ply_task_status` は途中で `gone`（片付け済み）を返した。
- 子へ渡す続きの依頼文の作業場所の段落と、実際の cwd が食い違った。
- 子が書き始めていた変更（未コミット）は、消える前に退避されないまま古い worktree と一緒に失われうる。
- 作り直しに失敗すると、ターンは元の場所（依頼元と同じ作業ツリー）でそのまま走った。

## 決定

1. **片付けはタスクの回の終わりに 1 度だけ**。子の 1 ターンの終わり（`finishChild`）では片付けず、状態（`taskState`）だけを結果に載せる。`agentTasks` が回を閉じるときに `settleWorkspace`（`worktreeHost.taskDone`）を 1 度呼ぶ。回の終わり方ごとに:
   - 完了（`run.result` の `completed`）・失敗（`failed`。候補が尽きた上限・ログイン切れ・任せ直しの上限を含む）・取り消し（`run.cancelled`）・例外（`run.error`）: 片付ける。結果の `workspace` は片付けた後の状態。
   - 上限・ログイン切れの切り替え（`run.limitSwitch`）・仕事前のエラーの任せ直し（`run.reroute`）: 片付けない。同じ worktree で次の委譲先が続ける。
   - 次の指示が積まれていて回が続く（`queued`）・会話が忙しくて送信待ちへ戻った（`requeue`）・外から起きたターンが始まらなかった: 片付けない。
   - 片付けた後に `ply_task_send` や外から起きたターン（ADR 0355）で回がまた始まったら、その回の終わりにもう 1 度片付ける（回ごとに 1 度）。
   - サーバーが落ちて回が閉じられないまま終わったもの（`halted`）は、起動後の片付け（`sweep`。ACTIVE でないタスクの worktree）に任せる。
2. **任せ直した前の子の会話も手放す**。`run.reroute` で新しい子の会話へ移ったとき、前の子の会話の cwd も同じ worktree の中にある。回の終わりの片付けには、今の子の会話と、この回で任せ直した前の子の会話をすべて渡し（`taskDone(task, { sessions })`）、どれも元の場所へ戻してから消す。渡さないと前の子の会話が「使用中」に数えられ、変更の無い worktree が残る。
3. **作り直せないときは走らせない**。片付け済みの子が再開するとき（`ply_task_send`・外から起きたターン）に `renewTaskWorktree` が worktree を作り直せなければ（元の場所が無い・git が失敗した）、ターンを始めずに失敗で返す。元の場所では走らせない。文言は依頼元の言語の `agent:delegation.worktreeRenewFailed`。
   - 外から起きたターン（人が子の会話へ直接送った・Chrome を戻した続き・再開・別の会話からの送信・送信予定。ADR 0355）も同じに扱う（2026-11-26 の追補。プロダクトオーナーの決定）。`execute` が `external.refuse` で断り、`agentTasks.external` はそのターンをタスクと結ばない素のままでも走らせない（前は「始まらなかった」として子の会話の今の cwd、つまり片付けで戻った元の場所で走らせていた）。送信待ちの `start` は理由付きの失敗で返り、発言は送信待ちに「送れなかった」（`failed`）で残る。子の会話では、その発言の吹き出しに理由と［再送する］［取り消す］が出る（既存の送れなかった行。文言は人の言語の `server:queue.worktreeRenewFailed`。作り直せなかった理由は `worktree.fail.*`・元の場所が無いときは `cwd.missing`）。直してから再送すると、もう一度作り直してから走る。
   - タスクの行は起こす前のまま（状態・通知・出来事を変えない）。依頼元へは知らせない（ADR 0355 §1 の「ターンが始まらなかった」と同じ。子は何もしておらず、依頼元が読む新しい結果が無い）。
4. **`worktree` と `cwd` は一緒に書く**。タスクの記録の `worktree` を書き換える所（作り直し・切り替え・結果）は、`cwd` もその worktree のパスにする。

## 理由

- 上限やログイン切れの切り替えは、依頼の途中で委譲先を替えるだけで、仕事は同じ子の会話で続く。その途中で作業場所を消して作り直すと、記録・依頼文・実際の場所の 3 つが食い違い、途中の変更も守れない。片付けを「回の終わり」の 1 か所に寄せると、終わり方の数だけ片付けを書かずに済み、漏れ（残る）と二重（2 度消す）の両方を避けられる。
- 元の場所で走らせると、`isolate` を指示した意味（依頼元や並ぶ子の作業ツリーを踏まない）が失われる。失敗で返せば、依頼元が状態を確かめてやり直せる。
- 切り替えのたびに片付けて作り直す案（記録と依頼文の側を新しい worktree に合わせる）は、途中の未コミットの変更を退避してから移す処理が要り、作り直しの失敗の度に止まる場所も増えるので採らない。

## 影響

- `core/agent-tasks.mjs`: `settleWorkspace` を足し、回の終わり（`run.result` の `queued` 以外・`run.error`・`run.cancelled`）で 1 度呼ぶ。`run.reroute` で前の子の会話を控える。`row.worktree` を書く所で `row.cwd` も書く。
- `core/server.mjs`: `finishChild` は片付けずに `taskState` だけを返す。`renewTaskWorktree` は `{ needed, ok, worktree, reason, error }` を返し、`execute` は作り直せなければ `error` で返す。外から起きたターンなら、その前に `external.refuse` で人が読む理由を渡す。
- `core/agent-tasks.mjs`（追補）: `external` は断られた（`refused`）回の後でターンを素のまま流さず、理由の付いたエラーで返す。送信待ち（`core/message-queue.mjs`）は今までどおり、受け付ける前のエラーを `failed` にする。
- `core/worktree-host.mjs`: `taskDone` は手放す子の会話の一覧（`sessions`）を受ける（既定はタスクの今の会話）。
- 試験: `tests/unit/server-delegation-reroute.mjs` に、`isolate` の子が上限で切り替わっても同じ worktree・ブランチ・cwd で続き、完了時に変更が無ければ消え・あれば未取り込みで残ること、任せ直した子の後も同じ worktree で前の子の会話ごと片付くこと、作り直せないときに元の場所で走らず失敗することを足した。追補で、片付け済みの子へ人が直接送ったとき、作り直せなければ元の場所で走らず、発言が送信待ちに理由付きの「送れなかった」で残り、タスクの行が変わらないこと、直してから再送すると作り直してから走って完了することを足した。
