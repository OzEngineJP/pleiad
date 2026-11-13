# 0325 遅い命令・イベントループ・送信待ちの診断記録と、送信の待ち表示・会話切り替え通知

- 状態: 提案

## 状況

実機で「送信を押しても送られない」症状が報告された際、`web/client.mjs` の `submit()` が `settingsWrite`・`modeWrite`・`startWorktree` や `chatSender.send`（`sendMessage`）の応答を待つあいだは、ボタンが薄い無効状態になるだけで注記もエラーも出ず、そのあいだに利用者が別の会話へ切り替えると待ち終了後に無言で送信を見送って下書きを残す挙動になっていた。また、どの命令が・サーバーとイベントループと往復のどこで詰まったのかを後から確かめる仕組みがサーバーになかった。

## 決定

- **診断ログ `slow-commands.log`（`core/slow-log.mjs`）**: データ置き場に追記専用・上限 `128 KiB`（超過時は新しい半分を残す）の JSON Lines ファイル `slow-commands.log` を置き、次の 4 つの物差しを記録する。
  - **画面の往復（`client-pending` / `client-rtt`、`web/slow-client.mjs`）**: `cmd()` が `clientMs`（既定 `2000 ms`）を超えても返らない時点で `client-pending`、決着（完了・失敗・切断）時に `client-rtt` を記録する。`invoke` は `invoke:<op>` として記録し、`app.reportSlow` 自体は除外する。送信・接続を止めないよう画面側に一時保持し（上限 `200` 件）、`ready` 後や空き時間に `invoke('app.reportSlow')`（UI 専用、`surfaces: { ui: true, mcp: false, cli: false }`）へ非同期・火消しで送る。
  - **サーバーの命令時間（`server-cmd`、`core/server.mjs`）**: WS 命令を受け取ってから `reply`（または非応答終了）までが `serverMs`（既定 `1000 ms`）以上なら命令名・時間・`sessionId`・結果・`errorCode`・同時実行数を記録する。
  - **イベントループの詰まり（`event-loop`）**: Node の `monitorEventLoopDelay` により、窓（既定 `1000 ms`）内の最大遅れが `loopMs`（既定 `500 ms`）以上なら最大・平均・p99・処理中 WS 命令数を記録する。
  - **送信待ちの内訳と切り替え見送り（`submit-wait` / `submit-switched`）**: `submit()` の待ちが `submitMs`（既定 `2000 ms`）以上になった場合は `newSessionMs`・`settingsMs`・`modeMs`・`worktreeMs`・`postSettingsMs`・`sendMs`・`compactMs` の内訳つきで `submit-wait` を残し、送信前待ちのあいだに別の会話へ移って送らなかった場合は経過時間に関わらず `submit-switched` を残す。
  - **内容を残さない**: `sanitizeSlowEntry` で許可列（時刻・`kind`・`source`・命令名・`ms`・`sessionId`・結果・`errorCode`・数・`wait` 内訳の時刻と真偽値）だけを拾い、トークン文字列検査によりメッセージ本文・タイトル・ファイルパス・設定値・生エラー文言を一切残さない。しきい値は環境変数 `AGENT_HOST_SLOW_*` で上書きでき、`ready.slow` で画面へ伝える。
- **送信の待ち表示（`web/composer-wait.mjs`・`web/client.mjs`・`web/style.css`）**: 既存の「新しい会話ができるまで」の `composerWait.queue`（150 ms 遅れで `.send.wait` と `#composerNote`、入力欄は `readonly`）を拡張し、設定・モード・worktree 待ちには「設定の反映を待っています。終わりしだい送ります · 取り消す」、`sendMessage`／`compactConversation` の受理待ちには「送信を受け付けています」（送信済みのため取消ボタンなし）を同じ枠で継ぎ目なく切り替える（二重表示や 150 ms タイマーの再始動をしない）。`.send.wait:disabled` は `opacity: 1` とし、二重送信を防ぎながら待機中の弧を見せる。送信前待ちの「取り消す」を押すとその試行だけを無効化して即座にボタン活性・編集可能へ戻し、入力を残す。
- **別の会話へ移ったときの通知（`web/file-actions.mjs`・`web/client.mjs`）**: `composerWait.cancel('switch')` により会話切り替えと利用者操作の「取り消す」を区別する。送信前の待ち（新規作成中と既存会話の両方）の終了時に別の会話を開いていた場合は送らず、`notify()` に未送信と下書き残留の文言（会話名あり／なし）および対象会話を `openConversation` で開く操作ボタンを添えて知らせる。自分で「取り消す」を押した場合は出さない。

## 理由

- クライアント往復・サーバー処理・イベントループの 3 点を同じ時刻軸で並べることで、実機再現時に「ハンドラーの処理遅れ」「イベントループ閉塞」「WS 往復／切断」のいずれかを即座に切り分けられる。
- `cmd()` 自体に一律の時間切れを入れると重い通常命令や一時停止の挙動を変えるため、観測と待ち UI・切り替え通知を先に入れ、根本の遅い命令を実データで特定する。
- 新規会話の `queued` と同一部品・`150 ms` 閾値を共有することで、短い通常送信では見た目を揺らさず、新しい会話の直後に `sendDraftSettings` で待ったときも二重注記にならない。

## 影響

- 対象ファイル: `core/slow-log.mjs`・`core/ops/app.mjs`・`core/server.mjs`・`web/slow-client.mjs`・`web/composer-wait.mjs`・`web/file-actions.mjs`・`web/client.mjs`・`web/style.css`・`web/locales/{ja,en}/ui.json`・`web/locales/{ja,en}/agent.json`・`tests/data-writes-allowlist.mjs`・各単体テスト・実ブラウザーテスト・`docs/design.md`・`docs/design-system.md`。
- `cmd()` への時間切れ追加、サーバー処理の最適化、`web/md-editor.mjs` の `setValue` による添付札消失の修正は本 ADR の対象外とする。
