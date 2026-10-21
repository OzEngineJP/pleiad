# 0242 止まった委譲の子に残ったコマンドは片付け、子が切り離した作業は追わない

- 状態: 承認（2026-10-21）
- 関連: [0170](0170-delegation-background-notify-not-stop.md)（返答後の裏の作業は止めず、依頼元に知らせる）、[0138](0138-quiet-wait-notices.md)（待っているだけのコマンドは知らせない）、[0180](0180-agent-browser-daemon-lifetime.md)（agent-browser のデーモンの寿命）、docs/agent-delegation.md「無音と長いコマンドの通知」「子に残った裏の作業」

## 状況

- devin の子が要求回数の上限で `failed` になった。最後に走らせた grep が `activeCommands` に `running` のまま残り、5 分後に依頼元へ「長時間実行中」の通知が届いた。
  - 台帳（`core/task-commands.mjs` の `observeCommand`）がコマンドを外すのは、同じ呼び出しの `tool.result` か、終わりを示す `task.command` が来たときだけだった。バックエンドが呼び出しの途中で止まると、どちらも来ない。
  - タスクが `completed`・`failed`・`cancelled` になっても、`activeCommands` に触れる道が無かった。
  - 長いコマンドの通知を判定する見回り（`kick()`）は、走っていない手元の行も調べていた（ホストの写しの行だけが `running` を条件にしていた）。
- Codex の端末・`Start-Process` で起動したエミュレーター・Electron が、子のターンが終わった後に「長時間実行中」として知らせられた。Codex の端末は、子の完了後も知らせる設計だった。
- Claude の子が返答した後、裏で走らせた `agent-browser open …` が「裏の作業がまだ走っています」として残り、依頼元が止めるまで残った。Pleiad が見ているのは CLI が裏の作業として挙げる一覧で、CLI がこの bash をまだ走っていると挙げ続けていた。
  - 未確認の仮説: `agent-browser open` が起動したデーモンが、bash の出力のハンドルを受け継いで握り続けている。そのため CLI は bash の終わりを見られない。PowerShell の `Start-Process -RedirectStandardOutput` で起きるのと同じ形で、子への指示（`agent:guide.commandLifetime`）はその形を避けるよう書いている。
- どのバックエンドも、コマンドの出来事に OS のプロセス ID を載せない。
  - Codex の `processId` は Codex 自身の端末のハンドルである。
  - Claude が渡すのは裏のタスクの ID（`task_id`）である。
  - Devin・OpenCode・Antigravity は何も渡さない。

## 決定

1. **子の回が終わったら（`run.result`・`run.error`・取り消しで止まった回）、前景のコマンドを記録から外す。** `running` と承認待ちのものは、回と一緒に終わっている。
   - 裏へ回ったもの（`background`）は残す。Codex は、ターンが終わる前に走ったままの端末を `background` にする（`endTurn`）。
   - 生存が分からないもの（`unknown`。再起動・app-server の入れ替わり）も残す。
2. **長いコマンドの通知は、子が `running` の間だけ送る。** 止まった子（`completed`・`failed`・`cancelled`・`interrupted`）に残ったコマンドは知らせない。送る途中で子が止まった通知も送らない。
3. **止まった子に残った裏のコマンドは、バックエンドがまだ裏の作業として挙げている間だけ残す。** 挙げなくなったら外す。
   - 調べるのは見回り（500 ms ごと）で、問い合わせ先は `createAgentTasks` の `commandAlive`。
   - server の `commandAlive` は `findBackgroundTask` で答える。見るのは次の 3 つ。
     - Codex の `runtime.background`
     - Claude のターンが抱える `turn.info.background`
     - `ply_shell` の裏のジョブ
   - OS のプロセス ID で生死を確かめることはしない。渡すバックエンドが無いからだ。渡すバックエンドが出てきたら、`commandAlive` の引数の `processId` で確かめる。
   - 残っている間は、`ply_task_status`・`ply_task_list` の `activeCommands` に出る。`ply_task_cancel` で止められる（`cancelBackground`）。
4. **子が意図して切り離した作業は、Pleiad は追わない。** 例: `Start-Process`、`nohup`、末尾の `&`、デーモンを立てる CLI（agent-browser）、エミュレーター、Electron、dev サーバー。
   - Pleiad が記録するのは、起動したコマンドだけである。そのコマンドが終われば記録から消える（前景なら遅くとも回の終わりに、裏へ回したものならバックエンドが終わりを伝えたときか、挙げなくなったとき）。
   - 切り離したプロセスの後始末は、子の仕事である。子への指示では、PID を控えて自分で止めるよう求めている（`agent:guide.commandLifetime`）。
   - 例外: エージェントのブラウザーのデーモンは、子が止まったら Pleiad が止める（[0180](0180-agent-browser-daemon-lifetime.md)）。
5. **CLI が裏の作業として挙げ続けている間（Claude の `phase: waiting`）は、[0170](0170-delegation-background-notify-not-stop.md) のとおりにする。** 時間で止めず、依頼元へ知らせ、タスクは `running` のまま。
   - Pleiad には、挙げられている作業が本当に動いているかを確かめる手段が無い（OS のプロセス ID が無い）。そのため、仮説の形（デーモンが出力を握る）でも、依頼元が `ply_task_cancel` で止めるまで残る。
6. 再起動の後に `unknown` にしたコマンドは、今までどおり残して知らせない。

## 理由

- 止まった子のコマンドを「長時間実行中」と知らせても、依頼元にできることは無い。子は動いていないので、何かを待っても結果は来ない。誤った通知は依頼元のターンを起こし、費用がかかり、判断も誤らせる。
- 終わりの合図に頼ると、合図を出さずに止まったバックエンド（上限・異常終了）の分が残り続ける。回の終わりは、前景のコマンドが終わったことを確かに示す。
- 切り離したプロセスを OS の上で追うと、子が残したつもりのサーバーを、Pleiad が知らないうちに止めることになる（[0170](0170-delegation-background-notify-not-stop.md) と同じ問題）。追う手がかり（PID）も無い。起動したコマンドの記録だけを正しく保つ方が、壊れにくい。
- Codex の端末を子の完了後に知らせるのをやめても、端末は記録と画面の一覧に残り、止めることもできる。止まった子について依頼元のターンを起こさない方を選ぶ。

## 影響

- `core/agent-tasks.mjs`: 回の終わりの `endTurnCommands`、止まった行の `settleCommands`、`commandAlive` の口を足し、`notifyCommand` の条件に `running` を加えた。`core/server.mjs` は `commandAlive` を渡す。
- Codex の端末の扱いが変わる。子の完了後は長いコマンドの通知を送らない。端末が生きている間は `activeCommands` に残り、終われば（`item/completed`、または一覧から消えたとき）外れる。
- 回の終わりに外したコマンドが後から本当に終わっても、終わりの合図は記録のどれにも当たらず、何も起きない。
- 試験: `tests/unit/agent-tasks-command-settle.mjs`。次を確かめる。
  - 上限で `failed`・例外・取り消しで止まった後、`activeCommands` が空になり、通知が出ない。
  - 返答の後の裏の作業は、バックエンドが挙げている間は残り、挙げなくなると外れる。
  - 子が止まった後に届いた終わりの合図でも外れる。
  - `tests/unit/task-command-notice.mjs` の Codex の場面は、完了後に知らせないことを確かめる形に改めた。
