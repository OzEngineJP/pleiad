# 0270 サーバーはいつ落ちてもよい（起動を復元にして、引き継ぎ専用の経路を畳む）

- 状態: 段 4b まで実装済み（2026-10-27）。更新はロック → 旧サーバーの通常停止 → 新サーバーの通常起動。保持役の子とデータベースの状態は新サーバーが復元する。
- 置き換えた: [ADR 0151](0151-zero-downtime-update.md) の決定 5（サーバーの入れ替えは引き継ぎで行う）・決定 9（段階 1 の先送り）・決定 11 のうち「引き継ぎを始める前に合うかを判定する」部分。決定 6（記録の再生で組み立て直す）は起動の復元の一部として残る。決定 1〜4（3 層・版ごとの実行場所・保持役の規約）・決定 10（データの形式番号が変わる版は中断して更新）・決定 12（終了は今のまま）は残る
- 管理: [issue #143](https://github.com/tekalu1/pleiad/issues/143) は残件の管理に使う。この ADR は作り直しの形と段ごとの実装を記録する
- 関連: [docs/zero-downtime-update/design.md](../zero-downtime-update/design.md)・[plan.md](../zero-downtime-update/plan.md)・[ADR 0115](0115-records-in-sqlite.md)（データ置き場は 1 プロセス）・[ADR 0168](0168-permission-wait-outlives-turn.md)（ターンの外の待ち）・[ADR 0227](0227-ply-shell-and-command-notices.md)（ply_shell）

## 状況

この節の挙動は段 4 の実装前（2026-10-26）の記録である。現在の復元と停止は「段 4a の実装」を参照。

無停止の更新（ADR 0151）は、サーバーを入れ替えるときに、機能ごとに「手放す側（旧サーバーの `handOff`・`stash`）」と「引き取る側（新サーバーの `adoptTurn`・`adopt`）」を書く作りになっている。保持役（`core/holder/`）はすでに汎用で、子の起動・通番つきの出力の記録・`ack`・`marks`・答えていない依頼の渡し直し（`jsonrpc`・`claude-control`）を持つ。その上に、`core/backends/*-held.mjs`（約 1,300 行）・`core/shell-runs.mjs` の `handOff`/`adopt`・Chrome の `setCarry`/`handOff`・`agent-tasks` の `adoptRun`・預かり物（`stash`）が別々に乗っている。

書いていない機能は、切り替えを先送りさせる（`desktop/switch.cjs` の `waitIdle`・`switchBlockers`）、確認なしに止める、知らせずに消す。issue #143 の表のとおり、Devin・Grok のターン、ply_shell のジョブ、外部の stdio MCP、bot の会話・圧縮のターン、`outlivesTurn` の待ち、音声がそうなる。機能を足すたびに同じ穴を作りうる。

`holdable` は「`control.holder.handOff` を持つターン」だけを渡せる。`handoverSettled` は送信待ち・分岐・通知の配送・予定・Chrome の後片付けなど「短い処理」を数え、8 秒待つ。`handover.mjs` は札を取れないターンが 1 つでもあれば切り替えを断る。この 3 つが、機能ごとの書き忘れを「先送り」「確認」「中断」に変えている。

## 決定

### 1. 唯一の規則

**サーバーはいつ落ちてもよい。** 更新は「旧サーバーが止まり、新サーバーが普通に起動して拾う」だけにする。引き継ぎ専用の経路（`--handover`・預かり物・`holdable`・先送り・止まるものの確認）を消す。宣言・一覧・登録を人が保つ仕組みは足さない。作り方の形で守らせる。

### 2. ① 長く生きる子プロセスは保持役でしか起こせない

- プロセスの口を 2 つにする。`run()` は完了を待つ短命の子（`git`・`gh`・`--version`・`taskkill` など）。プロセスを掴んだまま返さない。`start()` は保持役に起こさせ、`source`（記録・`write`・`ack`）を返す。
- `node:child_process` を読んでよいのはこの口（`core/process.mjs` と、Electron main の `desktop/process.cjs`）だけにする。ほかのモジュールが読んでいたら `npm test` が落とす（`tests/lint-child-process.mjs`。基準は 2026-10-26 の 25 ファイル（移行中）から減らすときだけ更新する）。
- これで「切り替えで止まる子」が定義から消える。`desktop/switch.cjs` の blocker と stopper の区別、止まるものの確認のダイアログの大半は要らなくなる。
- 実装（段 2a。2026-10-26）: `core/process.mjs` が `run()`・`start()`・`detach()`・`spawnChild()` を持つ。`start()` は保持役の子を起こし、`core/adopt.mjs` の `holderSource`（記録・`write`・`ack`）を返す。`detach()` は保持役自身の起動（`core/holder/client.mjs`）。`spawnChild()` は保持役本体と、段 4b で固定した例外だけが使う生の `spawn` 口。コピー後も単独で動く `core/hook-adapter.mjs` には限定した Node API の fallback がある。Electron main の `utilityProcess.fork` は `desktop/process.cjs` の `forkUtility()` に集めた。段 4b で lint を固定例外方式にした。
- 例外は、保持役に載せられない子（`.cmd` の包みを解けない・保持役を起こせない環境）だけ。そのときは「サーバーの子として走り、切り替えで止まる」ことを会話に知らせる（黙って止めない）。

### 3. ② 続きに要る状態は DB か保持役の記録にしか置かない

サーバーのメモリは写しにする。今メモリだけにあるもので、続きに要るもの:

| 今の置き場 | 移す先 | 段 |
|---|---|---|
| `runtime.waiting`（承認・質問のカード） | DB の行（id・会話・ツール・聞いていること・出した時刻）。答えを待つ約束は保持役の控え（`jsonrpc`・`claude-control`）から作り直す。ターンの外の待ち（`outlivesTurn`。Chrome の接続・ログイン）は DB の行だけを持ち、起動で出し直すか取り下げを会話へ届ける | 3 |
| ply_shell のジョブの出力（`OUTPUT_KEEP` 256 KB・終わった 20 件）と、終わりの知らせ | 保持役の子の記録（`!` の行と同じ形。`core/shell-held.mjs` の包みを ply_shell にも使う）。ジョブの一覧は子の札から作る | 2・3 |
| 委譲の子の実行の控え（`taskExecutions`・`waitingSince`・`streamed`） | 台帳はすでに `agent_tasks` の行。実行の控えも行にし、起動で `running` の行を拾う | 3 |
| 送信待ちの「渡しかけ」・`liveNotices`・`liveInstructions` | すでに `outbox` と会話の記録にある。メモリの控えは起動で作り直す（今も `outbox.recover` がやっている） | 3 |
| 圧縮の予約の版（`compactionScheduler` のメモリ） | 会話の記録の行（`compactionRevision` は札にある） | 3 |

- 預かり物（`stash`。トークン・ポート）は消す。main が新しいサーバーを同じトークン・ポートで起こす（`desktop/server-restart.cjs` がすでにそうしている）。
- 「短い処理を 8 秒待つ」仕組み（`handoverSettled`）は消す。サーバーが落ちてよいなら、途中の HTTP の呼び出し・hooks のコールバックは 1 回失敗してよい（モデルが読み直す）。失ってはいけないものだけを ② の置き場に残す。

### 4. ③ 起動の処理が復元の処理

- 機能が持つのは「起動したら DB と保持役の子の一覧から自分の分を拾う」1 つだけにする。今の `restoreAdoptedTurns` を、`AGENT_HOST_ADOPT_HOLDER`・`--handover`・`AGENT_HOST_HANDOVER` の条件なしでいつも通す。`restoreTurn`・`adoptTurn`・`driveTurn` の道はそのまま使う（締めの道が 1 本であることは変えない）。
- 「自分の分」は、子の札（`label`。不透明な JSON）と印（`marks`）で見分ける。保持役の規約は変えない（`label` は誰のものか知らない）。拾う側の一覧（`readHolderSources`・`registerChildExpander`）は汎用の 1 か所に置き、機能ごとの登録を増やさない。子 1 つが複数のターンを運ぶバックエンド（Codex の共有 app-server）の展開は、子の札の種類ごとの 1 関数として残す。
- `holdable` の例外（bot の会話・圧縮のターン）をなくす。bot も圧縮も、起動で拾えるようにする（拾えない理由が残るなら、その機能を保持役に載せないのではなく、拾える形に直す）。
- サーバーの終わりに子を止める後片付け（`shellRuns.stopAll`・`shellBridge.stopAll`・`backend.releaseIdle`）をやめる。**アプリの終了**（利用者が終了を選んだ・アンインストール）だけが子を止める。更新で本体（Electron）を入れ替えても、保持役と子は止めない。サーバーの終わりは「手を離す」だけにする。

### 5. 更新の手順

1. main は新しい版の実行場所を組み、旧サーバーに終わってよいと伝える（今の `shutdown` の道）。旧サーバーは何も渡さずに終わる。
2. 旧サーバーが終わったら（データ置き場のロックとポートが空いたら）、main は新しい版のサーバーを、同じトークン・ポートで普通に起こす（`desktop/server-restart.cjs` と同じ形）。
3. 新サーバーは起動で、DB と保持役の子から自分の分を拾う。拾えなかったものは、会話に「更新で続けられなかった」と理由を出す（黙って消さない）。
4. 画面は同じトークン・ポートでつなぎ直し、版が変わっていれば 1 回だけ読み直す（今のまま）。

- データの形式番号が変わる版だけ、今までどおり「中断して更新」にする（ADR 0151 決定 10 のまま）。形式の移行は、ターンを走らせたまま・利用者が選ばない時に行わない。
- 旧サーバーが落ちた（更新でない）ときも同じ道を通る。main の `server-restart.cjs` が同じ版を同じトークン・ポートで起こし、新サーバーが拾う。**更新と落ちたときの復元が同じ試験で守られる。**

### 6. 開発時の経路（off）

`AGENT_HOST_HANDOVER=off`（`npm run desktop`・`electron .`。サーバーが `utilityProcess`）も同じ作りにする。サーバーが main の子でも、保持役は `$INSTDIR` の外で別に走らせ、起動で拾う。`utilityProcess` の経路だけ別の引き継ぎを持つ形はやめる。経路を 1 つにする。

### 7. 例外は「本体の入れ替えで必ず切れるもの」だけ

音声の通話・computer use・ビューア（内蔵ブラウザーのタブ）は、main（Electron）の入れ替えで必ず切れる。これらは保持役に載せず、「切れたら繋ぎ直し、理由を出す」1 通りにそろえる。サーバーの入れ替えでは切れない（main が同じなら繋がったまま）。今の「理由を出さずに切れる」（音声）を直す。

### 8. 試験

既存の土台（`tests/lib/server.mjs`・`tests/lib/ws-client.mjs`・`tests/lib/backend-matrix.mjs`）に「途中でサーバーを止めて起こし直す」動かし方を 1 つ足す（`tests/lib/restart.mjs`）。`startServer` と `open` がこの仕掛けを通り、試験は 1 つのサーバー・1 つの接続を使っているつもりのまま、途中で普通に止めて普通に起こした先へ繋ぎ直す。イベントは続きに積む。既存の試験をそのまま流す。新しい機能は普通の試験を持っていれば自動で網にかかる（登録・宣言は要らない）。

## 2a の実装（2026-10-26。段 2 の前半）

段 2 を 2a（口・検査・`!` の行・ply_shell）と 2b（Devin・Grok の ACP・外部の stdio MCP・残りの移行）に分けた。2a で決めたこと:

### 計測（危うい点「出力が保持役を通る遅れ」）

Windows・Node v24.22.1。5 回の中央値。`!` の行は fake のサーバーに `runShell` を投げ、`shell.start` から `shell.done` まで。出力は 64 KB ずつ、drain を待って書く。

| 経路 | 100 KB | 10 MB |
|---|---|---|
| 保持役なし（`AGENT_HOST_SHELL_HOLDER=off`。サーバーの子） | 83.2 ms | 97.5 ms |
| 保持役あり（保持役の子の包み） | 159.7 ms | 173.7 ms |

- `!` の行の出力は `runHostShell` が stdout・stderr それぞれ 256 KB で切る。10 MB のうち保持役を通るのは 256 KB だけで、差は 10 MB に比例しない。差は約 76 ms の一定（保持役の子の包み（Node）の起動）。包みの中の `runHostShell` の時間は 97 → 104 ms（+7 ms）
- 保持役の記録をそのまま 10 MB 流す場合（包みを通さない）: 直に spawn して読む 66 ms、保持役を通す 96 ms（+30 ms、約 1.45 倍、約 109 MB/s）。1 MB ずつのまとめ（`PUMP_BATCH_BYTES`）と 4 MB の高水位（`highWaterBytes`）はこの量で足りる。**2a ではまとめ方を直さない**
- 結論: 10 MB の出力で「大きく遅い」とは言えない。一定の 76 ms は、短い `!` の行（100 ms 程度）では目立つが、包み 1 プロセスの起動の分で、出力の量に比例しない。包みを常駐させる・保持役が直にシェルを起こす、は 2b 以降に測って要れば行う

### 口

`core/process.mjs`:
- `run(command, args, { cwd, env, input, timeoutMs, signal, onOutput, maxOutputChars, killTree, exitCloseGraceMs, killedCloseGraceMs, ... })` … 完了を待つ。ハンドルを返さない。戻り値は `{ exitCode, signal, stdout, stderr, durationMs, timedOut, stopped, truncated, leftover?, startError? }`。`core/host-shell.mjs` の `runHostShell` はこの口の包みになった（`OUTPUT_LIMIT`・`leftover` の猶予は同じ）
- `start({ id, command, args, cwd, env, policy, label, marks, keepMs, dataDir, root, key, appVersion, log, idleMs })` … 保持役に起こさせ、`{ id, client, source }` を返す。`source` は `core/adopt.mjs` の `holderSource`（記録・`write`・`ack`）。保持役を使えないときは `null`、つなげない・起こせないときは投げる（呼び出し側が今の流れに落とす）
- `detach(command, args, { cwd, env })` … サーバーの子でない形で起こし、`{ pid }` を返す。`core/holder/client.mjs` の `launchHolder` が使う
- `spawnChild(...)` … 生の `spawn`。保持役本体と lint の固定例外一覧にあるファイルだけが使う。未登録 import は lint で失敗する。`hook-adapter.mjs` はアプリ内ではこの口を使い、コピー先では Pleiad のソースが無い場合に限り Node の API に fallback する
- `desktop/process.cjs` の `forkUtility()` … Electron main の `utilityProcess.fork`。`desktop/main.cjs` はこれだけを使う

### 開発版と配布版の経路

- `AGENT_HOST_RUNTIME_ROOT` があればそれ。無ければ、Node で走るサーバーはデータ置き場ごとの一時置き場（`os.tmpdir()/pleiad-holder/<データ置き場のハッシュ>`）で保持役を使う。同じデータ置き場のサーバーを起こし直すと同じ保持役につながる。
- 開発版の Electron も配布版と同じ保持役を使う。`utilityProcess` はサーバーの親として残るが、長く生きる孫は保持役が起こし、通常起動で復元する。親の輸送方式は開発時の Electron API と配布版の runtime 起動条件が異なるため共通化せず、保持役・子の寿命・復元経路を共通にする。
- テストは `AGENT_HOST_HOLDER_IDLE_MS=5000` を渡し、親も子も居なくなった保持役が 5 秒で終わる（後片付けで残さない）

### 検査

- `tests/lint-child-process.mjs` が `core/`・`desktop/`・`bin/` の `node:child_process`（import・require・動的 import）と `utilityProcess.fork(` を検査する。生の import は `core/process.mjs`・`desktop/process.cjs` と、コピー後に単独実行が必要な `core/hook-adapter.mjs` だけに限る。`spawnChild` の import は保持役本体と固定例外一覧のファイルだけに限り、未登録のファイルは selftest でも失敗を確認する。
- 例外一覧は移行中の基準ではなく、ファイルごとの理由を lint に固定した決定事項である。baseline ファイルと `--update-baseline` の仕組みは段 4b で削除した。
- 2a 当時は `core/host-shell.mjs`（`run()`）・`core/holder/client.mjs`（`detach()`）・`core/holder/holder.mjs`（`spawnChild()`）・`desktop/main.cjs`（`forkUtility()`）を移し、baseline は 28 から 25 ファイルになった。これは当時の経過記録であり、現行 lint の基準ではない。
- `tests/unit/child-process-lint.mjs` が `npm test` から回す。`tests/unit/desktop-boot.mjs` の vm の require に `./process.cjs` を足した

### ply_shell のジョブ

- `core/ply-shell-held.mjs`。子は `!` の行と同じ `core/shell-held-child.mjs`（`runHostShell` の包み）。印は `ply_shell` を通番 1、札は `{ kind: 'ply_shell', v: 1, sessionId, jobId, jobKind, command, cwd, shell, startedAt, stoppedBy? }`
- ジョブの出力は保持役の記録（`o`・`e`・`done` の行）にあり、`output` と `list` はそれを読む。`done` の行は `endedAt` を持つ。終わったジョブの記録は `JOBS_KEPT`（20 件）から溢れるまで残す（`release` はそのとき）
- 新しいサーバーは起動で `shellJobHolder.adoptable()` を読み、`shellBridge.adopt` が `sessionId` ごとの一覧に戻す。**手放す/引き取るの対は書かない**（規則 ③。`schedule` と `sessionCommands` を作った後に読む。`onJobStart` が `running` の配りと見張りを使うため）
- `ack` 済みの `done` は前のサーバーが終わりを処理済みとして `onJobEnd` を出し直さない。ack より後なら、このサーバーが `onJobEnd` を出す（終わりの知らせが 1 回）。終わりを処理したら `finished()` で `done` まで ack し、購読をやめる（記録は `output`・`list` のために残す）
- `stop`・`stopSession` は札を置き直してから `stop` を書く。`stopAll({ keepHeld: true })` はサーバーの終わり（SIGTERM・落ちたとき）で保持役の子を止めずに手を離す。アプリの終了（`exitAfterStoppingHeld`）は `closeAll()` で止める
- `running` の `background` と `shells` に `held` を付け、引き継ぎのときの `switchBlockers` は保持役の ply_shell のジョブを待たない

### `!` の行

- `core/shell-held.mjs` は `core/process.mjs` の `start()` を使う。`shellHolderEnabled()` は「`AGENT_HOST_SHELL_HOLDER=off` でなければ載せる」になった（実行場所の置き場の有無では決めない）
- `shell.start` は、保持役の子を起こし終えてから出す（`core/shell-runs.mjs` の `markStarted`）。前は `runShell` の返事より前に出していたので、`PLEIAD_TEST_RESTART=shell` の試験が「保持役の子がまだ無い」時点で止め、ジョブが消えていた。今は `shell.start` の時点で保持役の子が居る
- サーバーの終わりは `stopAll({ keepHeld: true })` で手を離す。アプリの終了は `shellRuns.stopAll()`（今のまま止める）

### 試験

- `node tests/run.mjs restart-mode --jobs 1` … held: のターンと ply_shell の start のジョブが、普通に止めて普通に起こした後も続く。`list` と `output` で読める
- `PLEIAD_TEST_RESTART=shell node tests/run.mjs server-shell --jobs 1` … `!` の行が保持役の子として残り、`shell.done` が 1 回
- `server-shell`・`shell-runs`・`adopt-shell`・`shell-held`・`shell-bridge`・`shell-delivery`・`host-shell-leftover`・`holder-*`・`desktop-boot`・`desktop-server-boot`・`desktop-job`・`runner-contract`・`child-process-lint`・`i18n-lint` が緑（2026-10-26）
- 全体の `node tests/run.mjs`（12 worker・401 秒）で、今回の変更と関係する失敗は `desktop-boot`・`desktop-exit-dialog`（vm の require に `./process.cjs` が無い）・`secret-warmup`（`forkUtility` の位置）・`server-boot-env`（`forkUtility` の env）・`shell-bridge`（900 ms で output を待ちすぎ）で、直して個別に緑。残る失敗は、`whoami.exe` が Git の GNU whoami に解決される環境（`codex-accounts`・`opencode-accounts`・`server-agent-accounts`・`account-backend-i18n`・`server-agent-account-adopt`。`PATH` の先頭を `C:\Windows\System32` にすると緑）と、12 worker の負荷（`server-session-delete`・`server-limit-resume`・`plus-hosts`・`server-git`・`server-git-panel-load`。`--jobs 1` で緑）、`runner-contract` の「worktree が増えていない」の検査（他の作業の worktree が `D:/dev/pleiad.pleiad/` にある。登録の検査は 589/589 で緑）
- `shell-held` の「実行場所の置き場が無ければ載せない」は「既定は載せる」に直した。`restart-mode` の ply_shell の判定は「消える」から「残る」に反転した。`restart-mode` の ply_shell のターンは同じ会話（`sessionId`）で始める（前は別の会話で始め、別の会話の `list` を見ていた）

### 2b 以降に回したもの

- Electron の `utilityProcess`（off 経路）で保持役を使う（段 4。実行場所の外の保持役を main が渡す）
- `shell-runs` の `handOff`/`adopt` と `shell-held` の `handOff`/`abandon` を畳む（段 4。引き継ぎの経路がまだ使う）
- ply_shell のジョブの `keepMs`（アプリの終了で止める道）・`stopAll` の後片付けの一本化（段 4）
- `restoreAdoptedTurns` を条件なしで通す（段 4）。今は `!` の行と ply_shell だけ条件なし
- 出力の包みの起動の 76 ms を減らす（常駐の包み・保持役が直にシェルを起こす。測って要れば。2b 以降）
- 承認・質問のカード・委譲の実行の控え・`outlivesTurn`・圧縮の予約の DB 化（段 3）
- 残った 3 ファイルの `child_process`（`core/cli-installation.mjs`・`core/claude-login.mjs`・`core/hook-adapter.mjs`。理由は「2c の実装」の「残りの `child_process` の移行」）

## 2b の実装（2026-10-26。段 2 の後半）

段 2 の残りを実装した。対象は Devin・Grok の ACP、Codex のターン専用の app-server、npm の `.cmd` の包みで保持役に載らなかった経路。

### Devin・Grok の ACP（`core/backends/acp-held.mjs`）

- 載せるか（`heldAcpPlan`）: `AGENT_HOST_DEVIN_HOLDER`・`AGENT_HOST_GROK_HOLDER`。`on` は載せる・`off` は載せない。**無ければ、実行場所の置き場（`AGENT_HOST_RUNTIME_ROOT`）があるときだけ載せる**（2a の `!` の行・ply_shell と同じ既定）。bot の会話は載せない（`restoreTurn` が付け直さない）。`.cmd` は包みの中身に解いてから載せる（解けなければ今の流れ）
- 子は policy `jsonrpc`（1 ターン 1 プロセス。id は `acp-…`）。`createHeldAcp` が ChildProcess の最小の写し（stdin・stdout・stderr・kill・exit）を返し、`DevinAcp`・`GrokAcp` は `spawnCli` の代わりにこれを使う
- 印（`turn`）は `session/prompt` を書く直前に打つ。札はサーバーのターンの札（`core/turn-card.mjs`）をそのまま置く。札を先に置いて 1 tick 待ち、印を打ってから書く（落ちた瞬間に印だけあって札が無い、を減らす）
- 札のバックエンドの欄（`backendCard`）は `{ held: true, devin|grok: { promptId, sessionId, sent, shown, prompts } }`。`promptId` は走っている `session/prompt` の id（付け直した側が応答を拾い直す）、`prompts` は走っている途中送信の id（本文の応答の後に届く返答を、閉じる前に待つ）、`sent`・`shown` は写しのエコー合わせ（16 KB を超えるときは入れない＝人が書いた分で組み立てる）
- 付け直しは既存の道（規則 ③）。`readHolderSources` が札と印を持つ子を拾い、`restoreTurn` → バックエンドの `adoptTurn` → `runTurn(args, { source, card })`。**initialize も session の作成も設定の適用も送らない**。印から ack までを再生（emit の replay。画面へは流さない）し、続きを流して行ごとに ack する
- 承認・質問: 保持役の `jsonrpc` の控え（`pendingRequests`）が、**答えていない依頼だけ**を attach で渡し直す。再生の履歴に残っている答え済みの依頼は出し直さない。記録の続きと控えで同じ依頼が 2 回来ても、聞くのは 1 回（`asked`）。承認の id はツールの id から決まるので、旧サーバーと同じ id で出直す（`core/approval-id.mjs`）
- 途中送信（steer）: 渡った合図（`confirmOnAccept`）を出す前に、依頼の id を札へ反映する（`acp-steer.mjs` の `onCall` → `touchCard`）。止める前に子へ書けた途中送信は、子の待ち行列に残り、新しいサーバーが返答まで読む。書けなかった分は送信待ちに戻る（今のまま）
- 手放し（引き継ぎ）: `control.holder.handOff` が札を置いて保持役へ detach し、`markHandedOff` で以後の読み書きを止め、`runTurn` は `handedOff` で終わる（締めるのは新しいサーバー）。ターンが終わった子は、札と印を外してから止める（`endTurn` → `close`）
- サーバーの終わりは子を止めない。2c の `codex-held.mjs` と `codex-rpc.mjs` にあった `process.once('exit')` の kill を外した（アプリの終了だけが `exitAfterStoppingHeld` で止める。落ちた後は `keepMs` の保険）

### Codex のターン専用の app-server

- Pleiad がコンテキストを持つ会話（`contextRuntime`）の app-server は 1 ターン 1 本。`context-options.mjs` の `codexContextRpc` に acquire を渡し、`acquireHeldTurnAppServer` が保持役の子として起こす（id は `codex-turn-…`、policy `jsonrpc`、`keepMs` は共有と同じ 10 分）
- 札は共有の app-server と同じ種類（`k: 'codex-app-server'`）に `dedicated: true` と起こしたときの `-c`（`config`）を足したもの。ターンの札は `putCard` で入れる（`bindHeld` が `rpc.heldChannel` を使う。共有は `heldAppServer()`）
- 起動で拾った子は `expandCodexHeld` が `dedicated` を見て、その子だけを話す `CodexRpc` を作り（`codexRpcForHeld`）、initialize を送らずに `adoptThread` で印からの記録と続きを渡す。ターンの終わりに `rpc.stop()` で子を止める（1 ターン 1 本なので、idle で残さない）
- 圧縮のターンは載せない（付け直さないので、残すと止める人が居なくなる。今の流れ＝サーバーの子）
- サーバーの終わりに止める一覧（`stopHeldAppServer`）にターン専用の子も入れた（アプリの終了で残さない）

### `.cmd` の包み（`core/cli-installation.mjs`）

- `unwrapCommandShim` が npm の包みの本文から中のスクリプトを解く（`%dp0%\…\.js`／`node.exe` 以外の `.exe`）。`directCommand` は `.cmd`/`.bat` を「node とスクリプト」の形に直し、解けなければ null
- `spawnCli`・`cliCommand` と、保持役の各口（agy・Claude・Codex・OpenCode・ACP）がこれを使う。**`.cmd` を保持役で起こせない理由は「cmd.exe 経由でしか起こせない」だけ**で、包みの中身は直に起こせるので、載せない理由にはならない。解けない包み（本文からスクリプトを見つけられない・`node_modules` の外を指す）だけ今の流れ（shell: true）に落ちる

### 試験・基準

- `node tests/run.mjs restart-acp --jobs 1` … Devin のツールの実行中・承認待ち、Grok のターンの途中・途中送信を、普通に止めて起こし直しても続く（7 判定）
- `node tests/run.mjs restart-codex-turn --jobs 1` … ターン専用の app-server のターン（ゲートしたツールの実行中）が続く（2 判定）
- `claude-held` の `--version`（`execFile`）を `run()` へ移した。`child_process` の基準は 25 → 24 ファイル（`--update-baseline`）
- 触った範囲の既存の試験（`server-devin`・`devin-acp`・`grok-backend`・`server-grok`・`codex-held`・`server-codex`・`adopt-codex`・`adopt-held`・`adopt-agy`・`restart-mode`・`backend-contract`・`child-process-lint`・`onboarding`）が緑

## 2c の実装（2026-10-26。段 2 の残り）

段 2 の残り（外部の stdio MCP・残りの `child_process` の移行）を実装した。

### 外部の stdio MCP（`core/context-mcp-held.mjs`）

- 載せるか（`heldMcpPlan`）: `AGENT_HOST_MCP_HOLDER`。`on` は載せる・`off` は載せない。**無ければ、実行場所の置き場（`AGENT_HOST_RUNTIME_ROOT`）があるときだけ載せる**（2b の Devin・Grok・Codex のターン専用と同じ既定。`npm start`・テストのサーバーは今の流れ）
- 子は `core/process.mjs` の `start()`（policy `jsonrpc`、`keepMs` 10 分。id は `mcp-<鍵の頭>-<乱数>`）。中の状態（ハンドシェイク・呼び出しの回数など）は子のプロセスに残る
- 札（label）は `{ k: 'mcp', v: 1, key, serverId, name, cwd, init }`。`init` は **initialize の結果**（`protocolVersion`・`capabilities`・`serverInfo`・`instructions`。札の上限に収まらないときは `instructions` を落とす）。印（`marks`）は使わない（記録を initialize の行から残すと、その後の行が全部残るため）
- **2 回目の initialize を MCP に受けさせない**（ADR の【未確認】への答え）。付け直した子に `Client.connect()` が出す initialize は送らず、札の `init` をその依頼への返事として返す（`HeldMcpTransport.send`）。`notifications/initialized` も送り直さない。**確かめた**: `restart-mcp` の試験で、MCP が受けた initialize は起こし直した後も 1 回だけ（試験用の MCP が回数を `runs` のファイルに残す）。MCP の規約が 2 回目を受けるかは確かめていない（送らない形にしたので要らない）
- 付け直し（規則 ③）: 起動で `readHeldMcpChildren` が保持役の子のうち札の種類が `mcp` のものを読み、`contextBridge.adoptHeld` が鍵ごとに控える。**手放す/引き取るの対は書かない**。次の `open` の `acquire` が同じ鍵なら、その子に `holderSource` で付く（`attach` は `acked + 1` から。`initialize` は送らない）。`connections` の `keyFor` から env を外した（サーバーの起動ごとに変わる値が入るため。定義の env と `${env:…}` の参照は `item.definition` に載る）
- 依頼の id は、前のサーバーが飛ばしたままの依頼とぶつからないよう、この口だけの文字列（`h<乱数>:<通番>`）に付け替える。この口が知らない id の返事（前のサーバーの依頼への返事）は捨てる
- サーバーの終わりでは止めない: `process.on('exit')` は `contextBridge.dispose({ keepHeld: true })`（手を離すだけ）。止めるのは**アプリの終了**（`exitAfterStoppingHeld` の `dispose()`）と、**会話の後片付け**（warm の idle 10 分・`closeUnder`（worktree を消す前））
- 使われないまま残った子は、起動で拾ってから 10 分（warm の idle と同じ）使われなければ止める。その場所の設定から外れた鍵の子は `prune` のときに止める（`closeStaleHeld`）
- 台帳（`core/mcp-ledger.mjs`）には保持役の子を載せない（持ち主は保持役で、木ごとの停止も保持役がやる）。サーバーの子に落ちたときだけ今までどおり載せる。`sweep`・`sweepCwd` は `run()` を使うため async になった
- 遅延起動（ADR 0238）: 一覧の写しがあっても、保持役の子が居れば standby にせず、その子に付く（既に起きているため）

### 残りの `child_process` の移行

24 → 3 ファイル（`--update-baseline`）。移したのは、短命を `run()`・切り離すものを `detach()` へ:

- `core/` の 12: `agent-browser`・`mcp-ledger`・`git-info`・`git-prs`・`context-bridge`（stdio は保持役・`taskkill` は `run()`）・`main-away`・`os-open`（`detach()`）・`backends/antigravity-background`・`backends/antigravity-pids`・`backends/codex-accounts`・`backends/opencode-accounts`（同期の `prepareAccount` から呼ばれる `whoami`・`icacls` は、口に足した `runSync()`）・`backends/opencode-server`（`taskkill`）
- `desktop/` の 9: `server-boot`（`spawnDetached`）・`shell-env`（`spawnRaw`）・`switch`・`update-auth`（`run()`）・`chrome-os/mac`・`chrome-os/win32`（`spawnDetached`）・`chrome-os/win32-uia`・`computer/apps`（`run()`）・`computer/mac-helper`（`spawnRaw`）
- 口（`desktop/process.cjs`）に足した: `run()`（main は CJS なので、`core/process.mjs` の `run()` の main が使う範囲を写した。asar の中の ESM を動的 import すると配布物で読めないため）・`spawnDetached()`・`spawnRaw()`。`core/process.mjs` に足した: `runSync()`・`run()` の `shell`・`detach()` の `windowsVerbatimArguments`・`run()` の `startCode`
- **残した 3 つと理由**:
  - `core/cli-installation.mjs`: `spawnCli` は保持役の各口（agy・Codex・OpenCode・ACP）が使う生の spawn の落とし先で、呼び出し側は ChildProcess（stdin・stdout・kill）を期待する。保持役に載せるには口ごとの写し（2b の `acp-held.mjs` の形）が要る。段 4
  - `core/claude-login.mjs`: 端末（node-pty）とパイプの対話で、ログインはサーバーの OAuth の流れに結び付く（サーバーの入れ替えでは続けられず、やり直す）。段 4
  - `core/hook-adapter.mjs`: このファイルは**他のエージェントの置き場へ単体で写して走る**（Node の組み込みだけで動く。Pleiad が無くても動く）。`core/process.mjs` を読めないので生の spawn のまま（写す側の `core/hooks-unify.mjs` の性質）

### 試験・基準

- `node tests/run.mjs restart-mcp --jobs 1` … 呼び出しの回数を数える MCP（`tests/lib/stateful-mcp.mjs`）を `.mcp.json` から起こし、普通に止めて起こし直す。同じ子に付いて `count:2`（中の状態が残る）・同じ pid・initialize は 1 回（3 判定）
- 触った範囲の既存の試験（`context-*`・`mcp-*`・`worktree-mcp`・`mcp-orphans`・`restart-*`・`server-hooks-unify`・`desktop-*`・`chrome-os`・`accounts`・`git`・`file-actions`・`main-away`・`agent-browser`）が緑
- 全体の `node tests/run.mjs`（12 worker・481 秒）で、今回の変更と関係する失敗は無し（`adopt-claude` の R15 は 2c の期待に直した）。12 worker の負荷で落ちた `server-git-panel-load`・`server-delegation-routing-settings`・`adopt-opencode` は `--jobs 1` で緑（2b の時点で負荷で落ちた suite と同じ）
- 基準は 24 → 3 ファイル（`node tests/lint-child-process.mjs --update-baseline`）

## 段 3 の実装（2026-10-26。状態の置き場）

段 3 の範囲（規則 ②）を実装した。承認・質問のカードは DB の行にし、委譲の実行の控え・圧縮の予約・その他のメモリだけの台帳を洗い出して、続きに要るものの扱いを決めた。

### 承認・質問のカード（`core/server.mjs` の `runtime.waiting`）

- **DB の行**: `waiting_cards`（後から足す表。`core/db.mjs` の `waitingCardTable`。形式番号は上げない）。
  `id`（カードの id）・`session_id`（カードの会話）・`origin`（カードを出した会話。中継の複製は置かない）・`tool_name`・`asked_at`・`data`（`{ payload, target, detached, outlivesTurn }` の JSON）。
  行は「答えていないカード」の数だけで、決着すると消える。`core/store.mjs` の `loadWaitingCards`・`putWaitingCard`・`removeWaitingCards` が読み書きする（同期。1 行ずつ）
- **置く**: `askPermission` がカードを `runtime.waiting` に載せた後に、元のカード（`cards[0]`）の 1 行を置く（`core/waiting-cards.mjs` の `put`）。中継の複製は元のカードから作り直せるので置かない。リモートのホストに任せたタスクの写し（`w.remote`）は、ホストの `sync` で作り直すので置かない
- **消す**: `settle` が `runtime.waiting` から消した後に、同じ id の行を消す（決着の前に落ちても、行が残るのは「答えていない」側だけ）
- **中身の上限**: 行には入力（Write の本文など）をそのまま置かない。`input` が 4 KB を超えたら `{ truncated: true }`、全体が 16 KB を超えたら `settingChange.rows` と `questions` を落とし、それでも超えたら種別と見出しだけにする（`compactWaitingPayload`）。stops に出す対象（`target`）は切り詰める前の payload から作って別に持つ
- **起動で拾う**: `waitingCards.load()` の後に `withdrawRestoredCards(adopting)`。付け直すターンの会話（`adopting` の `sessionId`）の行は、記録の再生が終わるまで残す。ほかの会話の行は、その場で取り下げる。付け直したターンは、最初の生の出来事・ターンの終わり・失敗のどれかで `finalizeAdoptedCards(sessionId)` を呼び、その会話の拾わなかった行を取り下げる（`adoptTurn` の `emit` の包みと `finally`）
- **拾えたかの印**: 付け直したターンが同じ id で `askPermission` を呼ぶと、`core/waiting-cards.mjs` の `put` が「拾った」と印を付け、元の `askedAt` を残す。カードの id はツールの id から決まるので（`core/approval-id.mjs`）、旧サーバーと同じ id で出直す。答えは保持役の子の控え（`jsonrpc`・`claude-control`）へ届く（段 2b の道。Devin・Grok・Codex は `restart-acp`・`restart-codex-turn`、fake は `restart-cards` の 1）
- **取り下げの届け方**: 拾わなかった行は、黙って消さずに `store.addStops` へ残し、画面へ `permissionSettled { allow: false, reason: 'restart' }`、スマホの通知と通知の一覧のあなた待ちも決着させる。
  - ターンの中のカード（保持役に載らないターン・付け直せなかったターン）は `approvals` に `ap:<id>`（ツール名と対象）
  - ターンの外の待ち（`outlivesTurn`。Chrome の接続・ログイン）は `waits` に `wait:<id>`。待っている呼び出し（`hand_to_user` など）はサーバーの終わりで切れており、出し直しても答えを返す先が無いので、出し直さずに取り下げを届ける
  - 設定の変更の承認と秘密情報の入力のカード（`detached`）は、台帳（`core/setting-approvals.mjs`）が起動で「再起動で取り下げた」結果を会話へ届けるので、`stops` は足さない
- **設定の変更の承認を出し直さない理由**: 承認は「この引数・この前の値」への受領証つきの約束で、許可の後に `proceed()` が前の値を読み直して実行する。起動をまたぐと `proceed` の closures（引数・操作の主体・依存）が無く、引数には秘密（MCP の env・接続先のキー）が入りうるので、DB に残して再実行する形にはしない。取り下げを会話へ届ける今の形を残す（「取り下げずに出し直せるならそうする」の判断。安全に再実行できないため出し直さない）
- **起動の復元**: 起動ごとに保持役の子一覧と DB のターン札を照合し、`label.waits` の承認・質問を同じ ID で出し直す（`core/adopt.mjs` の `readHeldWaitIds`）。取り下げていない待ちを消さない
- **試験**: `restart-cards`（保持役のターンの承認が同じ id で出直して続く・載らないターンのカードは `approvals`・`outlivesTurn` は `waits`・`detached` は台帳の取り下げ）。既存の `server-permission-settled`・`server-permission-update`・`server-setting-approval`・`server-setting-approval-delegated`・`restart-acp` も緑

### 委譲の実行の控え（`core/agent-tasks.mjs` と `core/server.mjs` の `taskExecutions`）

- `taskExecutions`（`outcome`・`error`・`limit`・`rejections`・`waitingSince`・`streamed`・`streamEnded`）は、付け直したターンでは札の `delegation.waitingSince` と記録の再生（`turnResult`・`tool.result` の `rejection`・`text.delta` / `text.end`）から作り直す（`newExecution`・`makeEmit`・`restoreTurn`）。結果の確定は `adoptChild` → `agentTasks.adoptRun` が 1 回だけ行う（段 2b-7 の道）
- 付け直さないタスクは、今までどおり起動で `interrupted` にし、依頼元の会話の `stops` に `restart` として残す（`agentTasks.restored`）
- **試験**: `restart-delegation`（保持役の子のターンがサーバーの入れ替えをまたいで最後まで走り、完了通知と結果の確定が 1 回だけ）・`agent-tasks-adopt`（manager の単体）

### 圧縮の予約

- 見えている予約は `compaction-schedule.json` に保存し、起動で戻す（ADR 0069。`core/server.mjs` の `saveCompactionSchedule`・`restoreCompactionSchedule`）。猶予（8 分）を過ぎたもの・会話の無いもの・バックエンドが変わったものは捨てる
- `compactionScheduler` の版（`revision`）とタイマーはメモリだけ。版は「古いタイマーの発火を捨てる」ためで、起動をまたぐ続きには要らない。`queuedCompactions`（走っているターンの後ろに並んだ手動の圧縮）は失うが、そのターンは起動で中断になり、人・エージェントがもう一度頼める
- **試験**: `server-compaction`（予約がファイルに残り、同じデータ置き場で立て直すと戻る・猶予を過ぎたものは戻らない）

### メモリだけの台帳（洗い出し）

続きに要るものと、写しでよいものを分けた。表の「写し」は、起動で作り直す・落ちてもやり直せるもので、DB へは移さない。

| 今の置き場 | 何を持つか | 扱い |
|---|---|---|
| `runtime.waiting` | 承認・質問のカード | DB の `waiting_cards`（上の節） |
| `runtime.turns` | 走っているターン | 保持役の札と記録（段 2） |
| `runtime.background` | ターンの外の裏の作業（Codex の端末など） | バックエンド・保持役の子から聞き直す。ターンの子は中断で止まる（写し） |
| `taskExecutions` | 委譲の子の実行の控え | 札の `delegation` と再生（上の節） |
| `liveNotices`・`liveInstructions` | 走っているターンへ途中送信で渡した通知・追加指示の控え | 札の `steers` と `outbox`・`agent_tasks` の行から作り直す（写し） |
| `limitStates` | 使用量の上限で止まった会話の待ち | 会話の `interrupted`（reason: limit）と `recoverLimitWaits`（写し） |
| `limitedSlots` | 上限で止まったばかりの枠（振り分けの回避） | メモリだけの回避の印。次の上限で付け直す（写し） |
| `settingCards`・`secretRequests` | 設定の変更・秘密情報の入力のカードの決着の口 | 台帳（`setting-approvals.json`）と DB のカード行。カードは出し直さない（上の節） |
| `agentTasks` の `live`・`notices`・`persisted`・`steers`・`instructionSends`・`deferredInstructions`・`settlingInstructions`・`waited` | 委譲の実行・通知・追加指示の配送の途中 | 台帳の行（`status`・`notification`・`instructions`）から作り直す。`sending` は起動で `delivered`（二重に送らない）。`waited`（`ply_task_wait` の待ち）は呼び出しが 1 回失敗し、エージェントがやり直す（写し） |
| `agentTasks` の `commandNotices`・`backgroundNotices`・`silenceNotices`・`silenceWaiting` | 通知の重複を防ぐ印 | メモリだけ。起動後に 1 回多く知らせることがある（記録は失わない。写し） |
| `compactionScheduler` の `revision`・タイマー・`queuedCompactions` | 圧縮の予約の版と待ち | 予約は `compaction-schedule.json`。版・待ちはメモリ（上の節） |
| `shellRuns`・`shellBridge`・`shellHolder`・`plyShellHolder` | `!` の行・ply_shell のジョブ | 保持役の記録（段 2a） |
| `contextBridge`・`context-connections` の entries | 外部 MCP の接続と中の状態 | 保持役の子（段 2c）と `mcp_tool_cache`。鍵は定義と参照先の env の値（下の節） |
| `chromeHandoffs` の `open`・`unclaimed` | Chrome の接続・ログインの待ち | DB のカード行（`outlivesTurn`）。起動で取り下げを `waits` に残す（上の節） |
| `chromeLoginGroups`・`chromeProfiles` | ログイン待ちの束ねの鍵・プロフィールの選択 | 鍵の材料は接続の子の carry（`chromeRelay.carryExtra`）に預ける。開いている束ね（待ち）は `outlivesTurn` のカードとして取り下げる（上の節） |
| `chromeControl` の一時停止の印 | 人が Chrome を操作中の状態 | メモリ。Chrome の接続の子が持つ端点・窓の印から作り直す。人が操作中の印は段 4 で「切れたら理由を出す」にそろえる（下の残り） |
| `remoteDelegation` の写し | ホストに任せたタスク・中継する承認 | ホストの `sync` で作り直す。`w.remote` のカードは DB に置かない |
| `voiceHost` の通話・`computerLock`・ビューア | 通話・computer use・内蔵ブラウザーのタブ | main（Electron）の入れ替えで必ず切れる。段 4 で「切れたら繋ぎ直し、理由を出す」にそろえる（今は音声だけ理由が無い） |
| `runtime.buffer`・`runningSent`・`nativeLists`・`placeCheckCache`・`chromeWindowSent`・`relayHops`・`remotePushed`・`lastWarm`・`authExpired`・`authAccounts` など | 画面への配り・一覧・接続の写し | 起動で作り直す（写し） |

### 待つ上限を超えて打ち切った短い処理（8 秒・5 秒）

段 4 で引き継ぎ自体を畳むので、ここでは今の打ち切りが「記録が残る」か「冪等で困らない」かを確かめた（コードの変更は無し）。

- **短い処理（`DRAIN_MS` = 8 秒）**: 終わらなければ引き継ぎを**断る**（`busy`。旧サーバーはそのまま走り、何も渡していない）。打ち切って進むことはない。`handover-core` の「短い処理が終わらなければ、上限まで待って断る」と `handover-server` が確かめる
- **処理中の呼び出し（`INFLIGHT_MS` = 5 秒）**: 上限を過ぎても進むが、待ち切れなかった数を `result.droppedCalls` に載せ、`handover: N call(s) were still running...` とログに残す（`handover-core` の「処理中の呼び出しは上限まで待ち、過ぎても進む」・`handover-server` の `droppedCalls`）。打ち切られるのは HTTP の MCP・in-process の host MCP・hooks のコールバックで、保持役の子から見れば 1 回失敗するだけ。モデルが読んでやり直す（冪等でなくてよい。状態を変える処理は、失敗したことがモデルに返る）
- 段 4a で `handoverSettled`・`--handover`・`stash` と一緒にこの 2 つの上限も削除した。飛んでいる短い呼び出しはサーバー終了時に失敗し、呼び出し元が次の試行で判断する

### 外部 MCP の接続の鍵（段 2c の退行の直し）

段 2c で `core/context-connections.mjs` の `keyFor` から env を丸ごと外したため、`${env:…}` の参照先（秘密・変数）だけを変えても MCP を起こし直さなかった。鍵を「定義 + 定義が参照している env の値」に直した（`referencedEnvNames`・`envKeyOf`）。

- 参照は `${env:…}`（`command`・`args`・`url`・`baseUrl`・`cwd`・`env`・`headers`）・`env_vars`・`env_http_headers`・`bearer_token_env_var` から拾う
- 起動ごとに変わる起動用の変数（`core/boot-env.mjs` の `isBootEnvName`）は鍵から外す。サーバーは起動の時に `process.env` から外しているので、MCP へも渡らない
- 参照していない env の値（`PATH` など）は鍵に入れない（関係のない変更で MCP を起こし直さない）
- **試験**: `context-key`（参照先を変えると別の鍵・起動ごとに変わる値と参照していない値では同じ鍵・HTTP のヘッダーも同じ）

### 記録の再生の冪等（危うい点への答え）

段 3 の移行で、新しい鍵は要らなかった。

- カードは「記録の出来事」として再生しない。付け直したターンは、保持役の子の控え（`jsonrpc` の `pendingRequests`・Claude の `pending_permission_requests`）から**答えていない依頼だけ**を出し直し、バックエンド側の `asked` / `settled` の集合が二重を防ぐ（段 2b）。カードの id はツールの id から決まる
- 取り下げは起動で 1 回だけ（`cardsFinalized` と行の削除）。再生の中では走らない
- 設定の変更の承認の台帳は再生しない（`delivering` / `queued` の状態を持ち、送り直しを自分で決める）
- 委譲の実行の控えは、`text.end`（uuid）・`tool.start` / `tool.result`（ツールの id）の既存の 3 種類の鍵で足りる。`turnResult` は最後の 1 行で、結果の確定は `adoptRun` が 1 回だけ行う。承認の出入り・通知は再生に載せない（DB の行・台帳・stops から作り直す）
- 残る危うい点（再生に載る出来事を増やしたときに鍵が要る）は、段 4 で引き継ぎを畳むときに、再生の対象を「ターンの中の表示・使用量・ツール」に限ることで閉じる

### 試験・基準

- 新しい suite: `restart-cards`（9 判定）・`restart-delegation`（4 判定）・`context-key`（7 判定）
- 触った範囲の既存の suite: `restart-mode`・`restart-acp`・`restart-codex-turn`・`restart-mcp`・`server-permission-settled`・`server-permission-update`・`server-setting-approval`・`server-setting-approval-delegated`・`agent-tasks`・`agent-tasks-adopt`・`chrome-handoff`・`chrome-handoff-flow`・`context-warm`・`context-lazy`・`server-context`・`worktree-mcp`・`mcp-orphans`・`adopt-held`・`adopt-claude`・`adopt-codex`・`adopt-agy`・`data-writes`・`store-write-scale`・`server-store-failures`・`i18n-lint`・`ops-coverage`・`child-process-lint`（2026-10-26。`--jobs 1`）
- 全体の `node tests/run.mjs` の結果は下の「段 3 の全体の試験」に書く

### 段 3 の全体の試験（2026-10-26）

`node tests/run.mjs`（12 worker・693.7 秒・suite の合計 6975.6 秒）は終了コード 1。新しい 3 本（`restart-cards` 9/9・`restart-delegation` 4/4・`context-key` 7/7）と、上の触った範囲の suite は全部緑。落ちたのは次の 8 本で、今回の変更の外（負荷・時計・前からある揺れ）だった。

| suite | 落ち方 | 単独（`--jobs 1`） |
|---|---|---|
| `restart-codex-turn` | 「終わったターンの専用 app-server は保持役に残っていない」— 停止が間に合わず `codex-turn-…` が残った | 12.2 秒で 2/2 緑 |
| `server-devin` | suite の上限（3 分）を過ぎた（12 worker の負荷） | 90/90 緑 |
| `server-session-delete` | 前提の「記録がある」— `refs` が空（git の撮影が負荷で間に合わない） | 23/23 緑 |
| `worktrees` | suite の上限（3 分）を過ぎた | 44/44 緑 |
| `server-git-panel-load` | 「間隔の中でもう一度開いても、片付けは走らない」— `kept=null`（`git worktree` の作成が 8 秒を超え、間隔の条件に入らなかった。10 秒の間隔を試す試験。git のコードは触っていない） | 単独でも同じ（他の作業の負荷）。今回の変更の外 |
| `agy-relay-retry` | 「返事は口が開いた後に届く」— 408 ms（期待は 600 ms 以上。空きポートの取り合いで、開く前につながった。中継のコードは触っていない） | 3 回中 1 回緑。前からある揺れ |
| `adopt-opencode` | 2 回目以降の `mcp:` の中継が空、または最初のターンが `error`。`MaxListenersExceededWarning` は試験の `attachMain` のもの | **元の場所（`D:/dev/pleiad`、同じ HEAD `2cd883a1`）でも同じように落ちた**。今回の変更の外 |
| `runner-contract` | suite の上限（3 分 55 秒）と、PowerShell のプロセス表が読めなかった（12 worker の負荷） | ランナーの整合の検査は今回の変更の外（ADR の段 2a でも同じ扱い） |

`server-git-panel-load`・`agy-relay-retry` は単独でも揺れるが、触ったファイル（`core/server.mjs`・`core/store.mjs`・`core/db.mjs`・`core/waiting-cards.mjs`・`core/interrupt-stops.mjs`・`core/adopt.mjs`・`core/context-connections.mjs`）に git・worktree・agy の中継の変更は無い。`adopt-opencode` は元の場所でも落ちることを確かめた。残りは `--jobs 1` で緑。

### 段 3 完了時に段 4 へ回したもの（2026-10-26 時点）

- `restoreAdoptedTurns` を条件なしで通す（段 4a で完了。段 3 では、付け直さない起動で保持役の子がまだ待っているカードの行を残すだけだった）
- 設定の変更の承認のカードの出し直し（安全に再実行できる形にするなら。段 4 以降の別の判断）
- `chromeControl` の一時停止の印・音声・computer use・ビューアの「切れたら理由を出す」（4b）

## 段 4a の実装（2026-10-27。サーバー側）

### 起動と停止

- `restoreAdoptedTurns` は通常起動で常に呼ぶ。保持役を起こさず、データ置き場のロックを取った後に保持役の子一覧とデータベースのターン札を照合する。該当するターンは `restoreTurn` で登録し、待ち受け後に `adoptTurn` / `driveTurn` で記録を再生する。該当しないターンは `restart` の中断として記録する。`AGENT_HOST_ADOPT_*` と `--handover` は復元の条件ではない。
- SIGTERM・SIGINT・更新では保持役の子を止めず、通話と bot の記録、Chrome の予約済み carry、データベースを書き切ってからロックを放す。アプリの終了だけは `stopHeldChildren` を通して保持役の子を止める。会話削除など、その会話の後片付けは従来どおり対象の子を止める。`keepMs` は親が消えた子を回収する保持役側の上限として残し、通常のサーバー終了では起動し直す時間があるため、終了理由の印には使わない。
- desktop の自動更新は旧サーバーへ通常の `shutdown` を送り、終了通知を待ってから installer を起こす。installer が起動しなければ保持役から同じ版を通常起動し、既存の窓を読み直す。
- Chrome はリレーの状態変化で保存済みの carry だけを flush する。サーバー終了時に全状態のスナップショットを作る専用の carry 経路は持たない。接続の子と通常の carry 更新は残る。
- `shell-runs.restore` と `shellBridge.restore` は起動時の復元を表す名前にし、`shell-held.stop` はアプリ終了時に札を外して子へ停止を送る。サーバー終了だけでこれらを呼ぶことはない。

### bot と圧縮

- bot の通常ターンは、起動復元でチャンネルの既存投稿と sidecar、待ち受け中の inbox、ターン札に保存した投稿 ID・使用量・呼び出し元から進捗役を作り直す。保持役の記録を replay して本文・使用量・承認状態を再構成し、replay 中はチャンネル通知を再送しない。配達済みフラグの修復は同じ inbox 行への冪等な更新にする。`bot-dispatch` の通常再起動場面が、承認待ちの投稿と再起動中に届いた出来事を確かめる。
- pulse bot は通常のターン投稿を持たないため、既存の短い会話として復元役だけを登録する。保持役に残る圧縮ターンは通常の復元で続け、保持役に無い圧縮ターンは `compacting` 印から新しいサーバーで再試行する。圧縮は冪等なので再試行の方を選び、復元できた会話は再試行対象から外す。開始失敗時は `compacting` 印を消して次回起動でも再試行できるようにする。

### 試験の対応と 4b へ回すもの

- backend 固有の付け直しを確かめていた `adopt-agy`・`adopt-claude`・`adopt-codex`・`adopt-opencode`・`adopt-shell`・`adopt-held`・`adopt-finished` は残し、A の通常停止（SIGTERM）と B の通常起動に書き換えた。記録の再生・重複防止・同じ承認 ID の再表示・Codex の複数ターン・終了済みの子・A 不在中の shell 出力を引き続き検査する。`adopt-held` の委譲の途中送信に含まれていた「札を取る前半／detach する後半」の境目の検査は削除し、委譲の子・結果確定・完了通知は `restart-delegation` に任せる。
- 引き継ぎ専用試験の対応は次のとおり。

| 削除した試験 | 削除した理由／現在の検査先 |
|---|---|
| `handover-core` | `stash`・手放しフラグ・引き継ぎ待ちタイマーの単体契約はなくなった。起動は特別な準備段階を持たず、通常起動の復元だけになる。 |
| `handover-notice` | `handoverSettled` の上限待ちはなくなった。未完了の短い呼び出しは失敗してよく、失ってはいけない状態は DB または保持役の記録から復元する。状態の復元は `restart-cards`・`restart-delegation` と backend ごとの `adopt-*` が検査する。 |
| `handover-server` | `--handover` 固有の起動・ポート待ち・ロック受け渡しはなくなった。通常起動時のロック待ちは `restart-mode` と desktop の通常再起動試験で検査する。 |
| `tests/lib/adopt-server.mjs` と `tests/lib/slow-exit-preload.mjs` | 旧サーバーにだけ「手を離す」操作を注入する入口と、終了後もしばらく生かす仕掛けは不要になった。保持役の子を残す A の通常 SIGTERM と B の通常起動は、7 つの `adopt-*` suite が直接使う `startServer` で検査する。遅延した終了通知や通常ロック待ちは `desktop-server-restart`・`restart-mode` が検査する。 |
| `desktop-switch` の handover 専用ブロック（held ターンを blocker から外す判定、`handoverMode` と SDK 先取り、断り直し、S1 が手放した後の復旧） | 旧サーバーが処理中に次のサーバーへ状態を渡す分岐がなくなった。desktop 切り替え試験は 4b の表で通常停止・通常起動の振る舞いに置き換えた。 |
| `desktop-handover` | main の handover 規約・blocker／stopper UX を前提にした suite は不要になった。サーバー側の通常再起動復元は `adopt-*` と `restart-*`、desktop 更新は置き換え後の `desktop-switch` が検査する。 |
| `main-away-server` と orphan guard の更新向け 30 分猶予 | 更新中も旧サーバーを残す `main-leaving` 例外をなくした。自動更新は `shutdown` の終了を待ち、失敗時は同じ版を通常起動で戻す。保持役の子の復元は `adopt-*`、main 切断中の通常猶予は `desktop-server-boot` が検査する。 |
| `adopt-held` の `handOffTurnOnly`／`handOffDetach`・準備中の handOff 可否・待ち上限 | サーバーがターンを札に移す中間状態と handoverSettled の上限はなくなった。通常停止の後に保持役の記録を再生する部分は同 suite の承認・ツール・終端行試験、委譲は `restart-delegation` が検査する。 |
| `adopt-server` の `pauseHeld`／`muteHeld` 試験用操作 | 読み・書きの途中を人為的に止める口は不要になった。`adopt-held` と `adopt-finished` が、A の通常停止後に偽 CLI を完了させ、B が記録を拾う形で検査する。B で答える承認と、B で送る中断はそれぞれの起動復元試験が確認する。 |
| `adopt-held` の handoff 段階ごとの委譲境界 | 中間の handoff 段階がなくなった。通常停止後の保持役の子・結果確定・完了通知は `restart-delegation` が確認し、`adopt-held` は付け直し中の再生と重複防止を確認する。 |
| `claude-held` の「handoff 時に hook 呼び出しを drain する」場面 | サーバー終了時に hook を drain する特別な契約はなくなった。未完了の呼び出しは終了で失敗してよく、保持役の記録からの復元と承認の出し直しは `adopt-claude` が通常再起動で確認する。 |
| `codex-held` の「handoff 可否・handoff 後に子を止めない」場面 | handoff callback はなくなった。普通のサーバー終了時に保持役の Codex app-server を止めず、次の起動で複数ターンを展開することを `adopt-codex` と `restart-codex-turn` が確認する。 |
| `codex-accounts`・`opencode-accounts` の handoff callback を使ったアカウント保持試験 | handoff callback はなくなった。保持役由来のアカウント展開・通常 dispose の停止動作は同 suite、起動後の Codex ターン再接続は `server-agent-account-restart` と `adopt-codex` が確認する。 |

- `desktop-handover`・`handover-*`・`main-away-server` の旧更新経路試験は削除し、backend 別の `adopt-*` は通常再起動試験として runner に戻した。`compat-check` は保持役の接続互換だけを確認し、handover の判定をしない。
- `adopt-server.mjs` と `slow-exit-preload.mjs` は handoff の応答・遅延終了を作る試験専用の仕掛けだったため削除した。通常の `startServer()`、SIGTERM と保持役の fake CLI で A/B を作り、試験の前提を本番の起動と停止に揃えた。
- `shell-held` は削除した。札を保存中に handOff を待つ場面、ack の後に子を abandon する場面は handoff の二相処理がなくなったため不要。既定で保持役へ載ること、停止中も出力が続くこと、終了直後の記録、再起動後の出力と `shell.done` の一回性は `adopt-shell` が通常の A 停止・B 起動で検査する。アプリ終了で保持役の子を止める動作は `adopt-shell` と `desktop-server-boot` が検査する。
- `handover-core`・`handover-notice`・`handover-server` は削除した。drain の可否・短い処理の待ち上限・処理中呼び出しの打ち切り件数は handoff がなくなったため振る舞い自体がない。通常停止中の未完了 RPC は接続断として呼び出し元へ返り、復元が必要な agent のターンだけ保持役の記録から再開する。
- `desktop-handover` と `main-away-server` は削除した。前者の handoff 専用 blocker・拒否通知・stopper UX は不要になった。後者の「main が離れたら handoff」はなくなり `orphan-guard` が停止時の子を止めて通常終了する。サーバー A の通常停止と B の通常起動は `desktop-server-restart`、main の起動と終了配線は `desktop-server-boot` が検査する。
- `chrome-relay` の旧 5c（handOff 前に保留 Fetch を drain する場面）は削除した。通常終了では保留中の Fetch は失敗してよく、再試行可能な通信は接続元が再実行する。接続の子を通常起動で付け直すことは `chrome-link-adopt`、保存済み carry と窓の復元は `chrome-persist` が検査する。
- 4b で完了: `desktop/switch.cjs` の blocker・stopper・待機画面を削除し、通常停止と通常起動に統一。開発時の `utilityProcess` も同じ保持役と起動復元を使う。音声・computer use・ビューアには更新で切れた理由を知らせる。残りの `child_process` 3 ファイルは起動口へ移し、baseline を空にした。

### 段 4b の実装（2026-10-27。desktop 側と残件）

- 更新は `update-lock` を取ってから旧サーバーへ通常の `shutdown` を送り、終了を待ち、新版を通常起動する。処理中の作業を数えず、保持役の子は止めない。新版の起動に失敗したら旧版を同じ口で起こし直す。stop timeout と旧版への再接続は、停止要求が完了しなかった場合にデータベースのロックを奪わないため残す。
- `desktop/switch.cjs` に残すのは、版・データ形式・IPC 互換の検査、更新ロック、通常停止・起動、旧版への復旧、窓の再読み込みである。互換性検査に失敗した場合の「あとで／今すぐ更新」は、不適合なサーバーを起動してデータを壊さないため残す。作業の有無や stopper を理由に尋ねるダイアログはない。
- 開発版のサーバー親は既存の `utilityProcess` のままにした。開発ツリーには配布用の版別 Node 実行場所と安定した main-link の起動条件がなく、開発版の Electron 実行環境と画面・OS bridge も必要になるため、親プロセスの輸送方式は切り替えない。保持役の置き場は `AGENT_HOST_RUNTIME_ROOT` が無ければデータ置き場から決まり、`ELECTRON_RUN_AS_NODE=1` を付けた Electron から保持役を起こす。したがって `utilityProcess` でも子の寿命・DB と保持役の記録・通常起動での復元は配布版と同じである。
- Electron 本体の更新で切れる通話・computer use・内蔵ビューアには、次の起動で「更新のため切れた」と知らせる。ビューアは保存済みタブを通常起動で開き直し、computer use は再接続を促す。音声通話と computer use の接続自体は OS 側の main が終了するため再利用しない。
- `core/cli-installation.mjs`・`core/claude-login.mjs`・`core/hook-adapter.mjs` の限定した起動は `spawnChild` に集めた。hook adapter の単体コピーは `core/process.mjs` が無いため、コピーされた場合の fallback だけ `node:child_process` を読む。保持役本体を含む固定一覧 4 ファイルと各理由を `tests/lint-child-process.mjs` に置き、一覧外の `spawnChild` import を selftest で失敗させる。これは移行基準ではなく決定済みの例外である。`spawnProcess` と `tests/child-process-baseline.json` は削除した。外部 MCP も保持役が使えない場合にサーバーの子へ落とさず、接続を失敗させる。
- 古い handover コメント・画面文言・更新 blocker 用設定を削除または通常起動・復元の説明へ直した。`core/agent-tasks.mjs` の削除済み `core/handover.mjs` 参照も修正した。

#### desktop-switch 試験の置き換え

| 旧場面 | 対応 | 新しい検査 |
|---|---|---|
| `waitIdle` が処理中ターン・コマンドの終了を待つ | 振る舞いを削除 | 処理が走っていても lock → 通常停止 → 起動が進む |
| `switchBlockers` が保持役のターンを blocker から外す | handover 専用の振る舞いを削除 | 停止後も保持役の子が残り、新サーバーが通常起動する |
| stopper 一覧・「あとで／止めて切り替え」 | 振る舞いと画面を削除 | blocker・stopper の情報を読まないこと、確認なしで通常停止すること |
| handover mode・Claude SDK 先取り・断り直し・S1 の手放し後復旧 | 振る舞いを削除 | 通常停止後に新版を起動し、起動失敗時は旧版を起こし直す |
| 旧版の異常終了と起動失敗 | 維持・書き換え | stop timeout で旧サーバーへ再接続。新版起動失敗なら旧版を通常起動 |
| スキーマ・IPC・runtime の非互換 | 維持 | 安全に切り替えられない版の「あとで／今すぐ更新」確認 |
| `desktop-switch-screen`・`web-switch-notice` | 削除 | 新規 suite `desktop-switch` の通常停止・起動試験。UI に待機表示を持たない |
| `desktop-handover` suite | 前段で削除済み | `adopt-*`・`restart-*` と `desktop-switch` の試験 |

- `desktop/switch.cjs` は 529 行から 347 行へ 182 行削減した。画面の「切り替え待ち」状態・一覧・中断ボタンと、対応する locale・CSS・preload API を削除した。
- `main-away-desktop` は通常起動でも `browser-restore-request` の応答後にタブを報告する試験にした。close 後に状態変更の購読が残らないことも検査する。

### 段 4b の検証

- `desktop-switch`: 11/11。`main-away-desktop`: 32/32。
- `restart-acp restart-cards restart-codex-turn restart-delegation restart-mcp restart-mode --jobs 1`: 29/29。
- `PLEIAD_TEST_RESTART=work node tests/run.mjs server-fake --jobs 1`: 118/118。`PLEIAD_TEST_RESTART=turnEnd node tests/run.mjs server-shell server-fake --jobs 1`: 154/154。
- `node tests/run.mjs restart --jobs 1`: 55/55。指定された `PLEIAD_TEST_RESTART=work ... server-fake --jobs 1`: 118/118、`PLEIAD_TEST_RESTART=turnEnd ... server-shell server-fake --jobs 1`: 154/154。`node tests/run.mjs desktop --jobs 1`: 791/791、19 suite（`desktop-shell-env` は対象 OS ではないため skip）。
- `node tests/lint-child-process.mjs` と `node tests/run.mjs child-process-lint --jobs 1`: 通過。固定例外は 4 ファイル、登録外 import は 0。`node tests/run.mjs worktree-mcp hooks-unify server-hooks-unify composer-wait data-writes i18n-lint --jobs 1`: 211/211。
- 12 worker の全体実行は 8/21,462 判定が失敗し、終了コード 1 だった。失敗した 6 suite は `server-limit-resume`・`server-git-panel-load`・`worktrees`・`server-devin`・`server-ops-send`・`agy-relay-retry`。全体出力では `worktrees` が 3 分 4 秒で 3 分の上限を、`server-devin` が 3 分 2 秒で 3 分の上限を超え、`server-ops-send` の待ちが 30 秒で timeout した。残る 3 suite は解除時刻・キャッシュ期限・遅延時間の時間依存判定で失敗した。
- 全体で失敗した 6 suite を `--jobs 1` で再実行し、360/360 判定が通過した。直列では期限内に終わり、時間依存判定も成立したため、12 worker の負荷と並列実行時の時間競合による失敗と判断した。先の全体実行で落ちた 21 suite もまとめて `--jobs 1` で再実行し、857/857 判定が通過した。直列で残る失敗は無い。
- 直列化で修正した実際の不具合は、`spawnChild` の呼び出し引数、更新 blocker を前提とした test/locale/data-write 許可、旧 MCP 台帳を期待した assertion、終了後に保持役の子が残る 4 suite の cleanup だった。cleanup は各 suite の隔離データ置き場の保持役だけを止める。
- 12 worker で `runner-contract` の内部 3 秒 stall fixture は負荷時に 10〜12 秒まで遅れたが、suite 自体は直列再実行で通過した。`runner-contract`／restart 系の「本体の git worktree が増えていない」判定は同時に別作業が worktree を作ると落ちうる（環境要因）。
- 試験後にこの worktree の保持役・Chrome 子をコマンド行で特定し、残ったプロセスを停止した。ユーザーの Pleiad とそのデータ置き場は対象にしていない。

### 検証

- `node tests/run.mjs restart --jobs 1`: 55/55 判定、8 suite 通過。
- `PLEIAD_TEST_RESTART=work node tests/run.mjs server-fake --jobs 1`: 118/118 判定。
- `PLEIAD_TEST_RESTART=turnEnd node tests/run.mjs server-shell server-fake --jobs 1`: 154/154 判定。
- `node tests/run.mjs desktop --jobs 1`: 913/913 判定、20 suite 通過（`desktop-shell-env` は macOS・Linux 専用のため skip）。
- 個別 suite: `adopt-agy` 9/9、`chrome-persist` 53/53、`server-devin` 90/90。全体試験では `bot-dispatch` の通常再起動ケースも通過した。
- 全体 `node tests/run.mjs`（12 worker）: 21,609 判定中 4 件が worker 負荷または並列実行の時間競合で失敗。`server-devin`（90/90）は `--jobs 1` で再実行済み。残る `server-git-panel-load`・`worktrees`・`agy-relay-retry` はまとめて `--jobs 1` で再実行し、61/61 判定が通過した。全体試験で失敗した 4 suite の直列再試行合計は 151/151。
- 全体実行後に残ったこの worktree の保持役・Chrome 子・runner fixture は、作成時刻とコマンド行を確認して停止した。
- runner-contract／restart 系の「本体の git worktree が増えていない」判定は共有環境の別作業に影響される。今回の全体試験で該当する失敗はなかった。

## 畳むもの

| 今 | 段 | 残る |
|---|---|---|
| `core/handover.mjs`（180 行）・`core/handover-check.mjs`（52 行）・起動の `--handover`・`HANDOVER_VERSION`/`HANDOVER_RANGE`・`running` の `handover` | 4 | 版ごとの実行場所・main の `switch.cjs` の「組み立て→止める→起こす」 |
| `desktop/switch.cjs` の作業待ち・`switchBlockers`・handover 分岐・stoppers の確認（529 行中 182 行を削除） | 4b | 版・データ形式・IPC 互換の判定、更新ロック、通常停止と起動、旧版への復旧、窓の読み直し。非互換の版をいつ切り替えるかの確認は残す |
| サーバーの `holdable`・`handoverSettled`・`createHandover` の deps・`handOffTurn`・保持役の `stash`・`AGENT_HOST_ADOPT_*` | 4a | `restoreAdoptedTurns`・`restoreTurn`・`adoptTurn`・`driveTurn`・`heldTurnCard`・`touchCard`。通常起動で DB と保持役の子一覧を照合する |
| バックエンドのターンを手放す `handOff` と引き継ぎ専用の `adoptable` 判定 | 4a | 保持役の子を各 CLI に見せる部分（Claude の偽 `SpawnedProcess`・Codex の共有 app-server の読み書き・OpenCode の HTTP・agy の stdio）、`adoptTurn` による復元、記録の正規化と再生。Codex の子の展開も残る。shell の起動時一覧を読む `adoptable()` は復元 API として残る |
| `shell-runs.handOff`/`adopt`・`shell-held` の `handOff`/`abandon` | 4a | 起動時の `restore`・実行中の `drive`/`finished`。アプリ終了時の `stop` は残し、通常のサーバー終了では呼ばない |
| Chrome の終了時だけ行う carry のスナップショット設定 | 4a | 状態変化ごとの `setCarry` と接続の子（`core/chrome/link.mjs`）が WebSocket を持ち続ける経路。サーバー終了時は予約済み更新を flush し、起動は保存済み端点と窓の印を読む |
| `agent-tasks.adoptRun` の「引き継ぎ専用」の分岐 | 3・4 | 台帳の行から `running` を拾い、結果の確定を続ける道 |
| `desktop/switch.cjs` の `askUser`（stopper の「あとで／止めて切り替え」） | 4b | 非互換の版で「あとで／今すぐ更新」を確認する。互換性検査が失敗したまま起動するとデータを壊す恐れがあるため |

## 畳めないもの・まだ分からないこと

- 【確認】Claude の in-process の MCP・`canUseTool`・hooks は、保持役の控えの渡し直し（`mcp_message`・`elicitation`）だけでは戻らない。新しいサーバーが SDK の `query` を作り直し、2 回目の `initialize` で `canUseTool` と hooks を渡し直し、CLI が `pending_permission_requests` で承認待ちを回し直す（`core/backends/claude.mjs` の `adoptTurn`・`claude-held.mjs`）。この道は残る。消えるのは `handOff`（旧サーバーが札を置いて `detach` する所）だけで、付け直しの道は「起動の復元」として残る。
- 【確認】Codex の共有 app-server は子 1 つが複数のターンを運ぶので、`readHolderSources` の「子 → ターン」の展開（`registerChildExpander`）が要る。OpenCode は記録ではなく HTTP に聞き直す（`opencode.mjs` の `adoptTurn`）。どちらも機能ごとの「手放す/引き取る」ではなく、「子の札の種類ごとの読み方」として残る。
- 【推測】記録の再生で戻るのは、ターンの中の状態（表示・使用量・承認・ツール）だけ。ターンの外（`runtime.waiting` の待ち・`outlivesTurn`・ply_shell の出力・圧縮の予約）は戻らない。② で移す。移し忘れは「起動で拾えない」として試験に出る（段 3 の合格条件）。
- 【確認】再生の冪等は、今は `text.end`・`tool.start`・`tool.result` の uuid/ツール id だけ（`core/adopt.mjs` の `eventKey`）。ほかの出来事（承認の出入り・通知・委譲の完了）は、ack の位置が「アプリのループで処理し終えた最後の行」なので、落ちた行が再処理されると二重になりうる。段 3 で、状態を変える出来事すべてに冪等の鍵を付ける。
- 【確認・4a】データ置き場のロックは通常起動でも、旧サーバーが放すまで `acquireDataLockWait` で待つ（`core/data-lock.mjs`）。待ちを既定にしたので、サーバー A の通常停止直後に B を起こせる。
- 【決定・4a】`keepMs` は保持役が親を失ったままになった場合の孤児回収上限として残し、通常サーバーの SIGTERM・クラッシュ・更新時には子を止める理由に使わない。再起動が上限を超えて回復できなかった場合だけ、保持役が指定時間後に子を回収する。アプリ終了は待ち時間を使わず `stopHeldChildren` で直ちに止め、会話削除などは対象会話の子を直ちに止める。
- 【確認・2c】外部の stdio MCP は、`jsonrpc` の policy でそのまま保持役に載る（2c で実装）。「サーバーごとの状態」（ハンドシェイク・ケーパビリティ）は、**2 回目の `initialize` を送らずに**引き継げる: initialize の結果を札（`label.init`）に残し、付け直した側の `Client.connect()` の initialize にはその結果を返す（`notifications/initialized` も送り直さない）。`restart-mcp` の試験で、起こし直した後も MCP が受けた initialize は 1 回だけ（2026-10-26）。MCP の規約が 2 回目の `initialize` を受けるかは確かめていない（送らない形にしたので要らない）。

## 段

1. **試験の仕掛け**（この ADR と同時に試作）。「途中で止めて起こし直す」を既存の土台に被せる。今の穴を赤で出す。Claude のターン（`held:` の fake）は通る。ply_shell の `start` のジョブは、当時は落ちた（赤。段 2a で「残る」に反転した）。
2. **プロセスの口**。`run()`/`start()` を足し、長く生きる子を `start()` へ移す。Devin・Grok（ACP）・外部の stdio MCP を保持役に載せる。`child_process` の検査を入れる。
   - 2a（実装済み 2026-10-26）: `core/process.mjs`・`desktop/process.cjs`・`child_process` の検査・`!` の行と ply_shell のジョブを `start()` へ・出力の計測（下の「2a の実装」）
   - 2b（実装済み 2026-10-26）: Devin・Grok（ACP）・Codex のターン専用の app-server・`.cmd` の包み（「2b の実装」）
   - 2c（実装済み 2026-10-26）: 外部の stdio MCP を保持役へ・残りの `child_process` の移行（24 → 3。「2c の実装」）
3. **状態の置き場**。承認・質問のカード、ply_shell の出力、委譲の実行の控え、`outlivesTurn`、圧縮の予約を DB か保持役の記録へ移す。`handoverSettled` の「短い処理を待つ」を消す。
4. **引き継ぎ専用の経路を畳む**。
   - 4a（実装済み 2026-10-27）: 通常起動で復元し、SIGTERM・クラッシュ・更新で保持役の子を止めずに終了する。backend 別の再起動試験は通常停止・起動にする。「段 4a の実装」を参照。
   - 4b（実装済み 2026-10-27）: desktop の通常停止・起動、開発時の保持役復元、更新切断の通知、残る `child_process` の整理。詳細は「段 4b の実装」を参照。

段 1 はこの ADR と同じブランチで試作し、段 2 以降は別のブランチで行う。段ごとに、その段の変更と同じコミットで `AGENTS.md` の環境変数の表・`docs/desktop-releases.md`・`docs/zero-downtime-update/` を今の形に直す。

## 危うい点

- **保持役の責任が増えないか。** 増やさない。規約は v1 のまま（`spawn`・`attach`・`write`・`ack`・`mark`・`label`・`replay`・`release`・`shutdown`）。新しいサーバーが子の一覧を読むのは `welcome.children` で足りる。`stash` と `detach` は使わなくなるが、規約 v1 からは外さない（古い保持役・古いサーバーとの互換のため。外すなら規約の版を上げる段 4 の判断にする）。危ういのは `keepMs` の意味（上記）と、`spawn` の id が前のサーバーと重なったとき（`exists`）の扱い。起動で拾う前に同じ id で起こし直す機能は、`exists` を受けたら `attach` に切り替える。
- **記録の再生で全部戻るか。** ターンの中は戻る（Claude・Codex・agy・OpenCode・`!` で実績がある）。戻らないのはターンの外で、② で移す。危ういのは、再生の冪等が今は 3 種類の出来事だけなこと（上記）。段 3 で鍵を足すまで、再処理で二重になりうる出来事（承認の出入り・通知）は再生では流さず、DB の行から作り直す。
- **出力が保持役を通る遅れ。** Claude・Codex・agy・OpenCode・`!` はすでに通っている（今より悪くならない）。ply_shell と外部 MCP を載せると、今まで直だった出力が 1 ホップ増える。保持役は 1 MB ずつまとめて流し、親が読まなければ 4 MB で止める（`PUMP_BATCH_BYTES`・`highWaterBytes`）。**段 2a で測った**（「2a の実装」の計測）: `!` の行の 10 MB 出力で、保持役ありはなしより約 76 ms 遅いが、これは包み 1 プロセスの起動の一定分で、10 MB に比例しない（`runHostShell` が 256 KB で切るため、保持役を通るのは 256 KB だけ）。保持役の記録をそのまま 10 MB 流すと +30 ms（約 1.45 倍、約 109 MB/s）で、まとめ方は足りる。2a ではまとめ方を直さない。包みを常駐させる・保持役が直にシェルを起こす、は 2b 以降に測って要れば行う。
- **仕掛けの適用範囲（段 1 の試作で分かったこと）。** 既存の試験は「1 つのサーバー・1 つの接続・メモリの状態」を前提に書かれている。仕掛けは `startServer`/`open` を通すので、接続とイベントは続けられる。試作では、既存の `server-shell`（36 判定）を 1 行も変えずに `PLEIAD_TEST_RESTART=turnEnd` で流して全部通った。同じ試験を `shell`（`!` の出力の途中）で流すと、`!` の行が保持役に載っていない設定（`AGENT_HOST_RUNTIME_ROOT` が無い）なのでジョブが消え、`shell.done` を待って落ちた。`server-fake` を `work`（ツールの実行中）で流すと、保持役に載らない fake のターンが `restart` の中断になり、`turnEnd` を待って落ちた。**どれも「今の穴」が出ただけで、仕掛けの不具合ではない。** 段 2a で `!` の行が既定で保持役に載るようになり（`shell.start` は保持役の子を起こした後に出す）、`server-shell` を `PLEIAD_TEST_RESTART=shell` で流しても緑になった。
  被せられない・足りないもの: (1) サーバーの `child`・`port`・`tail()` を直に見る試験（起こし直すと値が変わる。ハンドル越しに読み直す形へ直す手間が要る）、(2) `startServer` を 2 回呼んで 2 台を並べる試験（`adopt-*`・`handover-*`。それぞれのサーバーには付くが、自動の起こし直しは最後の 1 台だけが対象）、(3) メモリの状態を直に読む単体試験（サーバーを立てない）、(4) 起こし直しの最中に投げた `cmd`（仕掛けは、短い `cmd` が終わるのを 2 秒まで待ち、その間に投げられた分は新しいサーバーへ回す。それでも長い `cmd` は落ちる）、(5) 境目の直後に試験が開く 2 本目の接続（仕掛けは起こし直しの終わりを待ってからつなぐ）。
- **二重起動。** 旧サーバーが生きている間に新サーバーが起動すると、両方が同じ保持役の子を拾う。データ置き場のロックが 1 つしか取れないので、新サーバーはロック待ちで止まる。main は旧サーバーの終了を待ってから起こす。保持役は「後から来た親が勝つ」で古い親を切るが、これは最後の砦にする。
- **起動の復元が機能ごとの登録に戻らないか。** 子の札の `k` は機能が自分で置くが、拾う側は汎用の 1 か所（`readHolderSources`）にする。`registerChildExpander`（子 1 つが複数のターンを運ぶ Codex の共有 app-server の展開）は今の 1 つだけ残し、機能を足すたびに登録を増やさない。増やしたくなったら、それは ② の置き場が足りない印として扱う。

## 理由

- 機能ごとの「手放す/引き取る」を書かせると、書き忘れが「先送り・確認・中断・消失」になる。規則を 3 つにして、長く生きる子を保持役の外で起こせなくすれば、書き忘れの余地が構造的に減る。
- 保持役はすでに汎用で、規約を変えずに「起動で子の一覧から拾う」ができる（`welcome.children`・`label`・`marks`・`replay`・`attach`）。新しい仕組みを足すのではなく、今ある付け直しの道をいつも通すだけにする。
- 更新と「落ちたとき」の復元が同じ道になると、試験も 1 つで両方を守れる。今は更新の試験（`adopt-*`・`handover-*`）と落ちたときの試験（`desktop-server-restart`）が別で、機能ごとの穴は更新の試験にしか出ない。
- 戻し道は「今の引き継ぎ」ではなく「データ形式が変わる版だけ中断して更新」に一本化する。引き継ぎを戻し道として残すと、機能ごとの経路が残り続ける。

## 影響

- `core/` のモジュール構成が変わる（`core/process.mjs` を足し、`child_process` の読みをそこへ集める）。`npm test` に `child-process` の検査が増える。
- 段 2a の影響: `core/process.mjs`・`desktop/process.cjs`・`core/ply-shell-held.mjs` を足した。`core/host-shell.mjs`・`core/holder/client.mjs`・`core/holder/holder.mjs` は口へ移した。`AGENTS.md` に `AGENT_HOST_PLY_SHELL_HOLDER`・`AGENT_HOST_HOLDER_IDLE_MS` を足し、`AGENT_HOST_SHELL_HOLDER` の説明を「既定は載せる」に直した（ほかの `AGENT_HOST_*_HOLDER` は段 2b・3）。`tests/lint-child-process.mjs`・`tests/child-process-baseline.json`（25 ファイル）を足した。ply_shell のジョブの出力と終わりの記録は保持役に残り、終わったジョブ 20 件までは `output`・`list` で読める。
- 段 2b の影響: `core/backends/acp-held.mjs` を足した。`core/backends/devin.mjs`・`devin-acp.mjs`・`grok.mjs`・`grok-acp.mjs` は `runTurn(args, adopt)` と `adoptTurn` を持ち、能力の `handover` を true にした。`codex-held.mjs` に `acquireHeldTurnAppServer`・`codexRpcForHeld` と `dedicated` の札を足し、`codex-rpc.mjs`・`codex-held.mjs` の `process.once('exit')` から保持役の子を止める分を外した。`cli-installation.mjs` に `unwrapCommandShim`・`directCommand` を足した。`AGENTS.md` に `AGENT_HOST_DEVIN_HOLDER`・`AGENT_HOST_GROK_HOLDER`・`AGENT_HOST_CODEX_TURN_HOLDER` を足した。`child_process` の基準は 24 ファイルになった。
- 段 4b で `desktop/switch.cjs` を 529 行から 347 行へ短くした。作業待ちと stopper の確認を削除し、データ形式・IPC・runtime の非互換を安全に延期する確認だけを残した。画面の待ち表示と blocker 設定を削除した。
- 段 4b で `AGENTS.md` を更新した。引き継ぎ固有の設定はなくし、`AGENT_HOST_HANDOVER` は Electron とサーバーの接続方式を選ぶ旧名として残した。`AGENT_HOST_*_HOLDER` の opt-out は fallback を検査する試験・互換用途に残し、通常の配布版と開発版は保持役を使う。
- 段 4b で `docs/zero-downtime-update/` の design.md・plan.md に、段 4 の通常起動による復元を追記した。ADR 0151 は過去の設計記録として保持する。
- 保持役の子を止めるのはアプリ終了と会話の後片付けに限る。段 4b の試験後にこの worktree の保持役・Chrome 子が残らないことを確認し、漏れていた保持役子の終了待ちを試験の後片付けへ追加した。
- 段 4b で音声・computer use・ビューアに、Electron 本体の更新で切れた理由を知らせる表示を加えた。ビューアは保存済みタブを通常起動で開き直す。

## issue #143 の残件実装（2026-10-27）

### 6. 外の AI に渡す MCP・CLI の起動口

- **現状**: NSIS 版の `mcpSetup` は `$INSTDIR\Ply.exe` と `$INSTDIR\resources\app\bin\pleiad.mjs` を設定に出していた。外の AI が MCP を起動中だと `Ply.exe` が使用中になり、NSIS が差し替えられない。
- **決定**: 配布版の実行場所の置き場（`AGENT_HOST_RUNTIME_ROOT`）の `cli/` に固定の `pleiad-node.exe` と `pleiad-cli.mjs` を置く。MCP 設定は `command` に固定 Node、`args` に `[固定 .mjs, "mcp"]` を指定し、`cmd.exe` と `.cmd` を経由しない。固定スクリプトは `cli-current.txt` の版を選び、その版の `runtime-node.txt` にある Node で `bin/pleiad.mjs` を `spawn` する。子の標準入出力を引き継ぎ、終了コードを返す。起動口自身も版の使用中ロックを持つ。
- **版の切替**: runtime の install は固定 Node とスクリプトを用意・更新するが、active pointer は変えない。Node またはスクリプトは中身が異なる時だけ一時ファイルから置換し、Windows が使用中ファイルを置き換えられない場合はその更新を次の install に延期する。サーバーが起動して ready を返した時点で、その版を `cli-current.txt` に原子的に記録する。互換性確認で新しい版を延期している間、外部 AI がその版を先に起動することはない。
- **更新時の扱い**: 外の AI が古い版を実行中でも、固定 Node・スクリプト・版ごとの Node とアプリ木はすべて `$INSTDIR` の外にある。起動口は選んだ版の `AGENT_HOST_RUNTIME_ROOT`・`AGENT_HOST_RUNTIME_KEY` を子へ渡す。起動口と `bin/pleiad.mjs` が版使用中ロックを持つため、実行中のファイルは runtime cleanup の対象から外れる。NSIS はこれらを入れ替えない。次の起動口呼び出しは active pointer の版を使う。
- **古い設定**: Pleiad は外部 AI の設定ファイルを自動編集しない。既存の `$INSTDIR` を指す設定は次回の「外の AI から Pleiad を使う」画面で新しい設定をコピーし、外部 AI 側へ貼り直すよう案内する。実際の利用者設定ファイルは変更しない。
- **Store 版**: 従来どおり App Execution Alias を使い、現在のパッケージ内のスクリプトを実行時に解決する。
- **試験**: `cli-launcher` は生成設定の command/args を `spawn(shell:false)` にそのまま渡し、空白を含む一時 runtime の偽版が起動すること、引数と終了コード、pointer 切替後に次の起動が別版を選ぶことを確かめる。`desktop-runtime` は install が pointer を変更しないこと、固定ファイルが runtime の外側にあることを確かめる。

### 試験の仕掛けと Chrome 接続子の後片付け

- restart 仕掛けは suite 終了時に controller のタイマーと全 `waitFor` watcher を解除する。破棄時に未完了の待機を reject せず解決し、未待機の timeout reject が次の suite の worker を落とさないようにする。`PLEIAD_TEST_RESTART` の指定は、外した直後に新しい controller で入れ直す（入れ直さないと、全体の掃引が worker の最初の suite にしか効かない）。
- `chrome-link-adopt` は保持役を止める前に接続子を列挙し、生存中の子を木ごと終了してから保持役を閉じる。全体試験後は suite を特定するため worker データ置き場とコマンド行を照合し、この worktree を含む Node プロセスが残らないことを確認する。
- `server-agent-account-restart` は保持役へ終了要求を送ってから、プロセス終了を確認するまでクライアント接続を保つ。要求を送った直後にパイプを閉じると保持役が残るため、終了確認後に接続を閉じ、保持役の子の終了を待つ。
- テスト用 `AGENT_HOST_HOLDER_IDLE_MS=5000` はサーバーが `bootEnv` に退避する。`core/process.start` を通らず `holderLink` から保持役を起こす fake の held ターンは、この値を渡しておらず、保持役が本番既定の 10 分待つため `server-fake` の終了後に残っていた。`holderLink` が起動時の idle 値を引き継ぐようにし、本物の保持役を使う試験で親・子が無いと idle 後に終了することを確かめる。テスト runner はテストサーバーごとの置き場を記録し、suite の終了時に保持役の idle 終了を待つ。通常の停止・再起動では保持役を維持し、suite 後にまだ残るテスト専用の保持役だけを最後に回収する。回収した保持役は、その suite の失敗として出す（idle で終わらない保持役は本番でも残るので、黙って止めると次の漏れが見えない。`holderLink` の直しを外すと `server-fake` がこの判定で落ちることを確かめた）。置き場が消えていてつなげない保持役は、試験が起こした pid を直に止める。
- サーバーを直接起動する `main-link`・`server-chrome`・`server-chrome-screencast`・`server-chrome-delegation`・`chrome-profiles`・`chrome-relay`・`chrome-os-link`・`server-delegate-account` は、`server.stop()` の後にテスト専用データ置き場の保持役と子を明示的に停止し、その置き場を消す。通常のサーバー停止は保持役の寿命を終わらせないため、テスト側で専用の後片付けを行う。全体試験後の `core/holder/main.mjs` と `core/chrome/link-child.mjs` を、Chrome の接続を有効にするサーバー suite 群に絞って見直した結果、これらの後片付け漏れを修正した。

### 1. 途中送信（steer）の再起動

- **確認した不具合**: 途中送信の outbox を `sending` にしてから保持役の子へ入力を送る間にサーバーが止まると、再起動後の復元札に ID が無い場合も outbox が `unknown` になり、送信が再開されず失われることがあった。
- **決定**: 保持役に載ったターンでは、途中送信が子への入力として受け付けられた直後に、途中送信 ID を含む札を同期的に書く。Claude のように子へ渡す固有 ID も必要なバックエンドは、その ID とハッシュも札へ書く。札を入力より先に書く方式では、札への記録後、子への入力前にサーバーが止まると、再起動後に「送信済み」と誤認して入力が失われる。入力後に書く方式では、子が入力を受け取った後、札への記録前にサーバーが止まると再起動後に再送して二重に届く可能性がある。この狭い区間を原子的にできないため、途中送信を失わないことを優先して入力後の記録を選ぶ。採用済み保持ターンで札に ID があれば送信済みとして再送しない。ID が無ければ outbox を `queued` に戻して再送する。保持役に載っていないターンは従来どおり送信する。採用済みターンが無い `sending` は結果が曖昧なため `unknown` のままにする。
- **範囲と確認**: Devin・Grok の ACP は要求を書いた後、Codex はターン専用 app-server が要求を受け付けた後、OpenCode は `prompt_async` が受け付けられた後に記録する。送信直後に通常停止・起動し、発言・配送通知・履歴・outbox が一度ずつであることを試験する。Claude は `adopt-claude` で、途中送信 ID と子側 UUID・ハッシュが札に残り、付け直し側が一度だけ渡った通知を出すことを確かめる。通常停止・起動の試験は `tests/lib/restart.mjs` の仕掛けを使う。
