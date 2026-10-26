# 0270 サーバーはいつ落ちてもよい（起動を復元にして、引き継ぎ専用の経路を畳む）

- 状態: 提案（2026-10-26）
- 置き換えた: [ADR 0151](0151-zero-downtime-update.md) の決定 5（サーバーの入れ替えは引き継ぎで行う）・決定 9（段階 1 の先送り）・決定 11 のうち「引き継ぎを始める前に合うかを判定する」部分。決定 6（記録の再生で組み立て直す）は起動の復元の一部として残る。決定 1〜4（3 層・版ごとの実行場所・保持役の規約）・決定 10（データの形式番号が変わる版は中断して更新）・決定 12（終了は今のまま）は残る
- 管理: [issue #143](https://github.com/tekalu1/pleiad/issues/143)。いまの挙動の表と残件はそちら。この ADR は作り直しの形だけを決める
- 関連: [docs/zero-downtime-update/design.md](../zero-downtime-update/design.md)・[plan.md](../zero-downtime-update/plan.md)・[ADR 0115](0115-records-in-sqlite.md)（データ置き場は 1 プロセス）・[ADR 0168](0168-permission-wait-outlives-turn.md)（ターンの外の待ち）・[ADR 0227](0227-ply-shell-and-command-notices.md)（ply_shell）

## 状況

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
- 実装（段 2a。2026-10-26）: `core/process.mjs` が `run()`・`start()`・`detach()`・`spawnChild()` を持つ。`start()` は保持役の子を起こし、`core/adopt.mjs` の `holderSource`（記録・`write`・`ack`）を返す。`detach()` は保持役自身の起動（`core/holder/client.mjs`）、`spawnChild()` は保持役の本体（`core/holder/holder.mjs`）だけが使う生の口。Electron main の `utilityProcess.fork` は `desktop/process.cjs` の `forkUtility()` に集めた。`child_process` の検査は `tests/lint-child-process.mjs`（基準は今の 25 ファイル。増えたら落ちる）。
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
- `spawnChild(...)` … 保持役の本体（`core/holder/holder.mjs`）が子を起こすための生の口（ハンドルを返す）。ほかからは使わない
- `desktop/process.cjs` の `forkUtility()` … Electron main の `utilityProcess.fork`。`desktop/main.cjs` はこれだけを使う

### 保持役の無い経路（off・`AGENT_HOST_RUNTIME_ROOT` が無いとき）

- `AGENT_HOST_RUNTIME_ROOT` があればそれ。無ければ、Node で走っているサーバー（`npm start`・テスト）はデータ置き場ごとの一時の置き場（`os.tmpdir()/pleiad-holder/<データ置き場のハッシュ>`）で保持役を起こす。同じデータ置き場のサーバーを起こし直すと同じ保持役につながる
- Electron の `utilityProcess`（`AGENT_HOST_HANDOVER=off` の開発・パッケージ版）で置き場が無いときは、まだ保持役を使わない（`start()` は `null`。今のサーバーの子）。実行場所の外の保持役を main が渡すのは段 4。**off を同じ作りにするのは段 4 に回す**（理由: off のサーバーは `$INSTDIR` の中で走り、保持役を `$INSTDIR` の外で起こす口がまだ無い。`npm run desktop` の `utilityProcess` は `process.execPath` が Electron で、`ELECTRON_RUN_AS_NODE` を外して起こす今の `launchHolder` では Node として起動できない）
- テストは `AGENT_HOST_HOLDER_IDLE_MS=5000` を渡し、親も子も居なくなった保持役が 5 秒で終わる（後片付けで残さない）

### 検査

- `tests/lint-child-process.mjs` が `core/`・`desktop/`・`bin/` の `node:child_process`（import・require・動的 import）と `utilityProcess.fork(` を数える。口（`core/process.mjs`・`desktop/process.cjs`）は除く
- 基準は `tests/child-process-baseline.json` の 25 ファイル（「移行中」）。基準に無いファイル・基準より多い件数は落ちる。減った分は通す（`--update-baseline` で下げる）。**段 4 の終わりに空にする**
- 2a で移した: `core/host-shell.mjs`（`run()`）・`core/holder/client.mjs`（`detach()`）・`core/holder/holder.mjs`（`spawnChild()`）・`desktop/main.cjs`（`forkUtility()`）。ADR が書いた 28 ファイルから 3 減って 25
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

- 外部の stdio MCP を保持役に載せる（段 2 の残り。Devin・Grok の ACP は 2b で実装済み）
- 残り 24 ファイルの `child_process` の移行（段 2b・4。基準は減らすときだけ更新）
- Electron の `utilityProcess`（off 経路）で保持役を使う（段 4。実行場所の外の保持役を main が渡す）
- `shell-runs` の `handOff`/`adopt` と `shell-held` の `handOff`/`abandon` を畳む（段 4。引き継ぎの経路がまだ使う）
- ply_shell のジョブの `keepMs`（アプリの終了で止める道）・`stopAll` の後片付けの一本化（段 4）
- `restoreAdoptedTurns` を条件なしで通す（段 4）。今は `!` の行と ply_shell だけ条件なし
- 出力の包みの起動の 76 ms を減らす（常駐の包み・保持役が直にシェルを起こす。測って要れば。2b 以降）
- 承認・質問のカード・委譲の実行の控え・`outlivesTurn`・圧縮の予約の DB 化（段 3）

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

## 畳むもの

| 今 | 段 | 残る |
|---|---|---|
| `core/handover.mjs`（180 行）・`core/handover-check.mjs`（52 行）・起動の `--handover`・`HANDOVER_VERSION`/`HANDOVER_RANGE`・`running` の `handover` | 4 | 版ごとの実行場所・main の `switch.cjs` の「組み立て→止める→起こす」 |
| `desktop/switch.cjs` の `waitIdle`・`switchBlockers`・`handoverMode`・`stoppers` の確認・`declines`（693 行のうち約 3 分の 1） | 4 | 版の判定（`needsSwitch`）・データ形式の判定・実行場所の組み立て・窓の読み直し・合わない版のダイアログ |
| サーバーの `holdable`・`handoverSettled`・`createHandover` の deps・`handOffTurn`・`stash`・`release`（終わる順序）・`AGENT_HOST_ADOPT_HOLDER`/`AGENT_HOST_ADOPT_FROM`/`AGENT_HOST_ADOPT_PORT_WAIT_MS` | 4 | `restoreAdoptedTurns`・`restoreTurn`・`adoptTurn`・`driveTurn`・`takeCard`（札を DB と保持役へ置く口に変わる）・`touchCard` |
| バックエンドの `handOff`（`createHeldCli.handOff`・`handOffHeld`・`handOffAgy`・`handOffCodex`・`handOffOpencode`）と `adoptable` | 4 | 保持役の子をその CLI に見せる部分（Claude の偽 `SpawnedProcess`・Codex の共有 app-server の読み書き・OpenCode の HTTP・agy の stdio）と、記録の正規化・再生。子 1 つが複数のターンを運ぶ Codex の展開（`registerChildExpander`。子の札の種類ごとの 1 関数） |
| `shell-runs.handOff`/`adopt`・`shell-held` の `handOff`/`abandon`・`shellBridge.stopAll`（サーバーの終わり） | 4 | `drive`/`finished`・札・`runHostShell` の包み |
| Chrome の `setCarry`/`handOff`・接続の子の「最後の carry」 | 4 | 接続の子（`core/chrome/link.mjs`）が ws を持ち続けること。サーバーは起動で端点と窓の印を子から読む |
| `agent-tasks.adoptRun` の「引き継ぎ専用」の分岐 | 3・4 | 台帳の行から `running` を拾い、結果の確定を続ける道 |
| `desktop/switch.cjs` の `askUser`（止まるものの「あとで／止めて切り替え」） | 4 | データ形式が変わる版の「あとで／中断して更新」（ADR 0036 の形） |

## 畳めないもの・まだ分からないこと

- 【確認】Claude の in-process の MCP・`canUseTool`・hooks は、保持役の控えの渡し直し（`mcp_message`・`elicitation`）だけでは戻らない。新しいサーバーが SDK の `query` を作り直し、2 回目の `initialize` で `canUseTool` と hooks を渡し直し、CLI が `pending_permission_requests` で承認待ちを回し直す（`core/backends/claude.mjs` の `adoptTurn`・`claude-held.mjs`）。この道は残る。消えるのは `handOff`（旧サーバーが札を置いて `detach` する所）だけで、付け直しの道は「起動の復元」として残る。
- 【確認】Codex の共有 app-server は子 1 つが複数のターンを運ぶので、`readHolderSources` の「子 → ターン」の展開（`registerChildExpander`）が要る。OpenCode は記録ではなく HTTP に聞き直す（`opencode.mjs` の `adoptTurn`）。どちらも機能ごとの「手放す/引き取る」ではなく、「子の札の種類ごとの読み方」として残る。
- 【推測】記録の再生で戻るのは、ターンの中の状態（表示・使用量・承認・ツール）だけ。ターンの外（`runtime.waiting` の待ち・`outlivesTurn`・ply_shell の出力・圧縮の予約）は戻らない。② で移す。移し忘れは「起動で拾えない」として試験に出る（段 3 の合格条件）。
- 【確認】再生の冪等は、今は `text.end`・`tool.start`・`tool.result` の uuid/ツール id だけ（`core/adopt.mjs` の `eventKey`）。ほかの出来事（承認の出入り・通知・委譲の完了）は、ack の位置が「アプリのループで処理し終えた最後の行」なので、落ちた行が再処理されると二重になりうる。段 3 で、状態を変える出来事すべてに冪等の鍵を付ける。
- 【確認】データ置き場のロックは、今は `--handover` の起動だけが `acquireDataLockWait` で待つ（`core/data-lock.mjs`）。普通に起こす新サーバーも、旧サーバーが放すまで数十 ms 待つ必要がある（待たないと `DATA_LOCKED` で終わる）。起動の待ちを既定にする。
- 【推測】保持役の `keepMs`（親が居ない間に終わらない子を止める保険。Codex・OpenCode は 10 分）は「サーバーが落ちても子を止めない」と衝突する。更新・落ちたときの復元は数秒で終わるので 10 分で足りるが、アプリを終了したときに子を止めるのは `keepMs` ではなく「アプリの終了」の道に任せる。段 2 で `keepMs` を外すか、アプリの終了だけが渡す印にするかを決める。
- 【推測】外部の stdio MCP は、MCP の子を保持役に載せると、その stdio の JSON-RPC を新しいサーバーが読む形になる。`jsonrpc` の policy でそのまま載る見込み（Devin・Grok の ACP も同じ）。ただし、MCP の子が持つ「サーバーごとの状態」（ハンドシェイク・ケーパビリティ）は新しいサーバーが `initialize` を送り直すことになる。MCP の規約が 2 回目の `initialize` を受けるかは【未確認】。

## 段

1. **試験の仕掛け**（この ADR と同時に試作）。「途中で止めて起こし直す」を既存の土台に被せる。今の穴を赤で出す。Claude のターン（`held:` の fake）は通る。ply_shell の `start` のジョブは、当時は落ちた（赤。段 2a で「残る」に反転した）。
2. **プロセスの口**。`run()`/`start()` を足し、長く生きる子を `start()` へ移す。Devin・Grok（ACP）・外部の stdio MCP を保持役に載せる。`child_process` の検査を入れる。
   - 2a（実装済み 2026-10-26）: `core/process.mjs`・`desktop/process.cjs`・`child_process` の検査・`!` の行と ply_shell のジョブを `start()` へ・出力の計測（下の「2a の実装」）
   - 2b（実装済み 2026-10-26）: Devin・Grok（ACP）・Codex のターン専用の app-server・`.cmd` の包み（「2b の実装」）。外部の stdio MCP と残り 24 ファイルの移行は段 2 の残り（下の「2b 以降に回したもの」）
3. **状態の置き場**。承認・質問のカード、ply_shell の出力、委譲の実行の控え、`outlivesTurn`、圧縮の予約を DB か保持役の記録へ移す。`handoverSettled` の「短い処理を待つ」を消す。
4. **引き継ぎ専用の経路を畳む**。`--handover`・`stash`・`holdable`・`switch.cjs` の `waitIdle`/`blockers`/`stoppers` を消し、更新と落ちたときの復元を「止める→普通に起こす」にそろえる。off 経路も同じにする。

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
- `desktop/switch.cjs` が大きく短くなる。更新の UX（待ちの表示・止まるものの確認）は「データ形式が変わる版」だけに残る。`docs/design-system.md` の切り替えの待ちの表示は、その 1 通りに絞る。
- `AGENTS.md` の環境変数の表から `AGENT_HOST_ADOPT_*`・`AGENT_HOST_HANDOVER`（off 経路の切り替えとしての意味は残るか、段 4 で決める）を外し、`AGENT_HOST_*_HOLDER` の説明を「いつも載せる」に直す。
- `docs/zero-downtime-update/` の design.md・plan.md は、段ごとに「今の形」へ書き換える（ADR 0151 の本文は書き換えない）。
- 保持役の子を止めるのは「アプリの終了」だけになる。利用者が Pleiad を終了したときに、Codex の app-server・OpenCode のサーバー・`!` の行・ply_shell のジョブが残らないことを、終了の試験で守る。
- 音声・computer use・ビューアは、main の入れ替えで切れることを理由つきで会話に出す（今は音声だけ理由が無い）。
