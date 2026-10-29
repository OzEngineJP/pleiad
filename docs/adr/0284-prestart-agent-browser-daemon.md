# 0284 Windows では agent-browser のデーモンを Pleiad が先に起こす（標準入出力を受け継がせない）

- 状態: 提案（2026-10-29）
- 関連: [0180](0180-agent-browser-daemon-lifetime.md)（agent-browser のデーモンと置き場の寿命）、[0170](0170-delegation-background-notify-not-stop.md)（返答後の裏の作業は止めず、依頼元に知らせる）、[0242](0242-settle-commands-of-stopped-children.md)（止まった子に残ったコマンド）、Issue #156、docs/inapp-browser.md「中継とエージェントへの渡し方」、docs/agent-delegation.md「子に残った裏の作業」

## 状況

- Windows で、委譲の子が最初の `agent-browser` をパイプに通して呼ぶ（`agent-browser get url | tail`・`$(agent-browser …)`）と、シェルのコマンドが返らない。子は `backgroundWaiting` のまま止まる。
- 原因は agent-browser（0.38.1）の CLI のデーモンの起こし方。Windows では CreateProcess を `bInheritHandles=TRUE` で呼ぶので、CLI の標準出力・標準エラー（受け継げるハンドル）がデーモンへ漏れる。デーモンは 24 時間（`AGENT_BROWSER_IDLE_TIMEOUT_MS`）生きるので、パイプの書き口が閉じず、読む側（`tail`・コマンド置換）が終わらない。
- 2 回目以降の呼び出しは、起きているデーモンにつなぐだけなので返る。漏れるのはデーモンを起こした 1 回だけ。
- 手元で再現した（一時のセッションと同梱の実物）。先に起こさないと、パイプは 20 秒たっても閉じず、デーモンを止めて初めて閉じた。

## 決定

1. **Windows では、Pleiad がターンの初めに会話のデーモンを先に起こす**（`core/agent-browser.mjs` の `prestartBrowserDaemon`）。`browserEnvironment` が設定を書いた後に呼ぶ。起こし方は `detach`（標準入出力は `ignore`、親から切り離す）で、子のシェルのハンドルを持たない。CLI は起きているデーモンにつなぐだけになる。
2. CLI が「そのまま使える」と見なす条件（`cli/src/connection.rs` の `ensure_daemon`）を全部満たして起こす。
   - `<セッション名>.port` に TCP でつながる。デーモンが自分で書く。
   - `<セッション名>.version` が CLI の版と同じ。デーモンが自分で書く。版は、子のシェルが呼ぶのと同じ PATH の上の `agent-browser.exe` の `--version` で読む（`locateAgentBrowser`）。
   - `<セッション名>.config` が CLI の設定の指紋と同じ。指紋は CLI が書く。無いと CLI は 1 秒待ってから起こし直すので、Pleiad が同じ値を書く（`daemonConfigFingerprint`。Rust の `DefaultHasher`＝鍵 0 の SipHash-1-3 で `(debug, action_policy, confirm_actions, idle_timeout, default_timeout, no_auto_dialog)` を混ぜる）。
3. デーモンの環境は、CLI の `apply_daemon_env` が渡すもののうち Pleiad の設定で決まるもの（`AGENT_BROWSER_DAEMON=1`・`AGENT_BROWSER_CDP`・`AGENT_BROWSER_HIDE_SCROLLBARS=1`・`AGENT_BROWSER_PLUGINS=[]`）と、子のシェルへ渡す agent-browser の環境。作業場所はターンの `cwd` にする（デーモンは相対パスの保存先を自分の作業場所で解く）。
   - 起こした後、デーモンが `.port` を書き、そのポートに TCP でつながるまで待ってからターンを始める（上限 2 秒。実機では 45ms ほど）。待たずに返すと、その間にエージェントが呼んだ CLI は `.port` が無いのでデーモンを自分で起こし、漏れが戻る。上限の内につながらなければ待つのをやめ、ログに `slow` を残してターンを始める。
   - 起こすのに失敗したら、書いた `.config` を消す。`.config` だけが残ると、デーモンが起きた会話に見えるのに先に起こした印が無く、ターンの終わりにも掃除でも置き場が消えない。
4. 次のときは先に起こさない。起こさなければ今までどおり、エージェントの最初の呼び出しが起こす。
   - Windows 以外（漏れない）。
   - 中継が無いターン（デスクトップ版の外。サーバーの単体試験もここ）。
   - PATH に `agent-browser.exe` が無い、または版が読めない。
   - サーバーの環境に指紋を変える変数（`AGENT_BROWSER_DEBUG` など）がある。
   - 古いデーモンを止められない。
   - 起こすのに失敗した。ログに残し、ターンは止めない。
   - サーバーの環境に `AGENT_HOST_AGENT_BROWSER_PRESTART=off` がある。試験のサーバー（`tests/lib/server.mjs`）が使う。偽の中継の試験で PATH の上の実物を起こすと、デーモンが試験の一時の作業場所を掴み、消せなくなるため。
5. 使えるデーモンがもう居れば何もしない（`running`）。版や指紋が合わないデーモンは、ADR 0180 と同じ止め方（`.pid` の実行ファイルを確かめて落とす）で止めてから起こし直す。
6. 起こしたら `<セッション名>.ply-prestart` に pid を書く。ターンの終わり（`settleBrowserEnvironment`）と掃除（`sweepBrowserEnvironments`）は、印の pid が今の `.pid` と同じで、`.target` が無いデーモンを「先に起こしたまま使われなかった」と見なし、止めて置き場を消す。使った会話（`.target` がある）と、CLI が起こし直した会話は、ADR 0180 のとおり残す。
7. **薄いランチャーは採らない。** Git Bash・PowerShell・cmd のどれから呼んでも `agent-browser` で解ける実行ファイルが要るが、`.cmd` は URL や JS の引数のクォートを壊す。ネイティブの exe を作って同梱するのは、版上げのたびに作り直す手間に見合わない。
8. 子への指示（`agent:browser.instructions`）に「agent-browser の出力はパイプに通さず、ファイルへ書き出してから読む」を足す。指紋を変えるフラグ（`--debug`・`--idle-timeout` など）を子が付けると、CLI がデーモンを起こし直し、漏れが戻るため。
9. 漏れが起きたときに依頼元が気づけるよう、裏待ちの通知と `backgroundWaiting` に、裏の出力が最後に伸びてからの時間を足す（docs/agent-delegation.md「子に残った裏の作業」）。止めるかは今までどおり依頼元が決める（ADR 0170）。
   - Issue の任意の案（裏待ちに agent-browser が含まれ、デーモンが生きていれば「デーモンが出力を握っている可能性」と添える）は採らない。理由は 3 つ。
     - 1 の後は、既定の呼び方では握られない。
     - 出力が伸びていないことは 9 の時間で読める。
     - 通知はターンの外で同期的に組み立てるので、デーモンの生死を確かめる（プロセスを引く）処理を足すと重くなる。

## 理由

- 先に起こすと、子のシェルの書き方（パイプ・コマンド置換・PowerShell のパイプライン）に関わらず、最初の呼び出しも 2 回目以降と同じ「つなぐだけ」になる。指示だけでは、子が守らなかった 1 回でターンが止まる。
- agent-browser の CLI を直すのが本筋だが、同梱の版を待つ間も止まる。上流が直ったら、先に起こすのをやめられる（デーモンが居ないときは CLI が起こす形に戻るだけ）。
- 指紋の計算が上流で変わると、CLI は Pleiad が起こしたデーモンを起こし直し、今の漏れる形に戻るだけで、壊れはしない。同梱の実物で確かめる試験（`tests/unit/agent-browser-prestart.mjs` の実物の節）が、版上げのときにそれを拾う。

## 影響

- ブラウザーの中継があるターン（デスクトップ版の Windows）は、ターンごとにデーモンを確かめる。最初のターンで起こし、使わなければターンの終わりに止める。ブラウザーを使わない会話でも、ターンごとに起こして止める手間（プロセスを 1 つ起こし、終わりに `tasklist` で確かめて落とす）が掛かる。
- 子が指紋を変えるフラグを付けた呼び出しは、CLI が起こし直すので、パイプに通すと今までどおり返らない。8 の指示と 9 の時間で補う。
- デーモンが 2 秒の内につながらない（`slow`）ターンで、つながる前にエージェントが呼ぶと、CLI がデーモンを自分で起こしうる（今の漏れる形に戻るだけ）。ターンの始まりは、デーモンを起こすときだけ最大 2 秒遅れる。
- Chrome の許可を待ったまま裏に回った `agent-browser` が、`.target` を書く前にターンが終わると、先に起こしたデーモンとして止められる。そのコマンドは失敗で返る（次の呼び出しで起こし直す）。
- サーバーが閉じると子を道連れにする Job の中にあると、先に起こしたデーモンもサーバーと一緒に落ちる。子のシェルから起こしたデーモンも同じだったので、今と変わらない。
- 書く場所は今と同じ OS の一時領域の `ply-ab-<ハッシュ>` で、`<セッション名>.config` と `<セッション名>.ply-prestart` が増える（`tests/data-writes-allowlist.mjs`）。
