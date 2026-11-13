# 0324 デスクトップ版の renderer 落ちからの自動復帰とローカル記録・ダンプ管理

- 状態: 承認（2026-11-13）

## 状況

デスクトップ版の本体の窓（`desktop/main.cjs`）を長時間開いた状態で renderer プロセスが終了すると、ホストのサーバーが生きていても窓が白いまま戻らなかった。本体の窓とリモートの窓（`desktop/remote-windows.cjs`）のどちらにも `render-process-gone`・`did-fail-load`・`unresponsive` と子プロセス終了（`child-process-gone`）の受け口が無く、`crashReporter` も動かしていなかったため、自動復帰も事後の原因追跡もできなかった。

## 決定

- **共有の受け口（`desktop/renderer-recovery.cjs`）**: 本体の窓（`main`）とリモートの窓（`remote:<hostId>`）の両方に共通の `attachWindowHealth` を付け、既存の 2 つの小窓（`desktop/chrome-pill.cjs`・`desktop/computer-overlay.cjs`）の扱いは変えない。本体の窓は `closeSafely()` の入口（キャンセル時は `finally` で解除）と `powerMonitor` の `shutdown`（`preventDefault()` は呼ばない）で `exitInProgress` を立て、リモートの窓は `close` イベントで `closing` を立てて、終了確認や閉じる途中のクラッシュで不要な読み直しやダイアログを出さない。
- **自動読み直しと最新の URL**: 窓が破棄済み・終了処理中・`reason === 'clean-exit'` のときは読み直さない（`clean-exit` はログのみ残す）。それ以外の `render-process-gone` では、落ちた時点の古い URL を再利用せず、本体の窓は最新の `serverReady`（無停止の更新で替わりうるポート・トークンを含み、初回起動限定の `reason=update-restart` は付け直さない）で `reloadWindow` し、リモートの窓は最新の `device.proxy(hostId).url` を引き直して `window-trust` のオリジンも更新する。
- **連続クラッシュの打ち切りと安全な再起動**: `60_000` ミリ秒以内に `3` 回目の非 `clean-exit` 落ちに達したら自動読み直しを止め、重複ダイアログを抑止したうえで、辞書 `web/locales/{ja,en}/desktop.json`（`renderer.*`）を使った「読み直す / Pleiad を再起動する」の 2 択を出す（`defaultId: 0`・`cancelId: 0` により Esc や閉じる操作は再起動せず「読み直す」となる）。窓が非表示・最小化中に閾値へ達した場合は背景でフォーカスを奪わないようダイアログを保留し、`show` / `restore` で可視状態に戻った時点で出す（保留中の破棄・終了では解除する）。「Pleiad を再起動する」では `stableLauncher()` を `execPath` に渡し、`--hidden`・`--remote-hosts`・`pleiad://…` を外した引数で `app.relaunch` する。`linked`（名前付きパイプ接続）経路では進行中の会話・委譲・会話用 Chrome 窓を守るためサーバーを止めず `worker.leave('restart')` と `keepAgentWindows`（`closeAgentWindows()` で見張り停止のみ）で離脱待ち（上限 `2_000` ms）ののち main のみ再起動し、`utilityProcess` 経路（`!linked`）では旧サーバー終了を待って（`shutdown` 送信後上限 `30_000` ms）再起動する。
- **同期の循環ログ（`desktop/desktop-log.cjs`）**: `userData/logs/desktop.log` へ ISO 時刻つきで同期追記し、`1 MB`（`MAX_BYTES`）を超える前に `.old` へ 1 世代だけ回す（ロック等で `renameSync` が失敗した場合は `writeFileSync` で切り詰めて肥大を防ぎ、実行中に `logs/` が無くなった `ENOENT` 時は作り直して 1 回再試行する）。`render-process-gone`・メインフレームの `did-fail-load`・`unresponsive`/`responsive`・`app` の `child-process-gone` を記録し、URL の userinfo や認証・API 系の秘密パラメーター（エラーコード等の `code=-102` や `?open=` は保持）および `Authorization` / GitHub PAT を `[redacted]` に伏せる。
- **ローカル限定のクラッシュダンプと上限管理**: 単一起動ロック取得後・`whenReady` 前に `crashReporter.start({ uploadToServer: false, productName: app.getName(), compress: true })` を呼んで手元（`Crashpad`）にだけ残し、外へ送らない。`app.setPath('crashDumps', ...)` を手動で上書きすると Electron 44 の Windows 環境で Crashpad のパイプ登録（`TransactNamedPipe` 0x6D）が壊れてダンプが書かれないため、`crashDumps` のパスは `desktop/dev-identity.cjs` のアプリ名分離（開発版 `Pleiad Dev` / 配布版 `agent-host`）に委ねる。起動時と `render-process-gone` の `5000` ミリ秒後（連続クラッシュ時は単一タイマーで統合）に `pruneCrashDumps` で最大 `10` 件・合計 `50 MB` を超える古い `.dmp` と添付（`stem` 空文字を除外し `attachments/` 本体は消さない）を消す。

## 理由

- 窓ごとの重複実装を避け、無停止更新・リモート再接続で変わりうる最新のポート・トークンを使って白い画面から確実に復帰するため。
- 起動直後に落ち続ける環境で無限リロードに陥らないよう 60 秒 3 回で止め、背景・最小化中や終了操作中・誤キャンセルで会話や作業を壊さないようにするため。
- 配布版（`linked`）ではサーバーや保持役 Chrome 窓を残したまま main だけ再起動し、`utilityProcess` 経路では旧サーバーと競合させないため。
- 長時間運用の実機で再発した際に `desktop.log` とローカルの `.dmp` の両方から OOM・GPU・読み込み失敗などを後から切り分けられ、かつ機密情報の露出やディスク圧迫を防ぐため。

## 影響

- 対象ファイル: `desktop/renderer-recovery.cjs`・`desktop/desktop-log.cjs`・`desktop/main.cjs`・`desktop/remote-windows.cjs`・`web/locales/{ja,en}/desktop.json`・`tests/data-writes-allowlist.mjs`・`tests/unit/desktop-boot.mjs`・`tests/unit/desktop-exit-dialog.mjs`・`tests/unit/desktop-renderer-recovery.mjs`・`tests/desktop/renderer-crash-smoke.cjs`・`docs/design.md`・`docs/dev-verification.md`。
- 本対応は復帰・記録・ダンプ保持までに限り、`backgroundColor` の変更、設定 UI・トレイ表示の追加、renderer のメモリ使用量そのものの調査・削減は対象外とする。
