# 0324 デスクトップ版の renderer 落ちからの自動復帰とローカル記録・ダンプ管理

- 状態: 提案（2026-11-13）

## 状況

デスクトップ版の本体の窓（`desktop/main.cjs`）を長時間開いた状態で renderer プロセスが終了すると、ホストのサーバーが生きていても窓が白いまま戻らなかった。本体の窓とリモートの窓（`desktop/remote-windows.cjs`）のどちらにも `render-process-gone`・`did-fail-load`・`unresponsive` と子プロセス終了（`child-process-gone`）の受け口が無く、`crashReporter` も動かしていなかったため、自動復帰も事後の原因追跡もできなかった。

## 決定

- **共有の受け口（`desktop/renderer-recovery.cjs`）**: 本体の窓（`main`）とリモートの窓（`remote:<hostId>`）の両方に共通の `attachWindowHealth` を付け、既存の 2 つの小窓（`desktop/chrome-pill.cjs`・`desktop/computer-overlay.cjs`）の扱いは変えない。
- **自動読み直しと最新の URL**: 窓が破棄済み・アプリ終了処理中・`reason === 'clean-exit'` のときは読み直さない（`clean-exit` はログのみ残す）。それ以外の `render-process-gone` では、落ちた時点の古い URL を再利用せず、本体の窓は最新の `serverReady`（無停止の更新で替わりうるポート・トークンを含み、初回起動限定の `reason=update-restart` は付け直さない）で `reloadWindow` し、リモートの窓は最新の `device.proxy(hostId).url` を引き直して `window-trust` のオリジンも更新する。
- **連続クラッシュの打ち切り**: `60_000` ミリ秒以内に `3` 回目の非 `clean-exit` 落ちに達したら自動読み直しを止め、重複ダイアログを抑止したうえで、辞書 `web/locales/{ja,en}/desktop.json`（`renderer.*`）を使った「読み直す / Pleiad を再起動する」の 2 択を出す。「読み直す」で回数窓を戻して読み直し、「Pleiad を再起動する」では `--hidden` を外して `app.relaunch` と `app.quit()` を行う。
- **同期の循環ログ（`desktop/desktop-log.cjs`）**: `userData/logs/desktop.log` へ ISO 時刻つきで同期追記し、`1 MB`（`MAX_BYTES`）を超える前に `.old` へ 1 世代だけ回す（`desktop/update-log.cjs`・`core/server-log.mjs` と同じ方針）。`render-process-gone`・メインフレームの `did-fail-load`（URL・本文中の `token=` 等は `[redacted]` に伏せ、挙動は変えない）・`unresponsive`/`responsive`・`app` の `child-process-gone` を記録する。
- **ローカル限定のクラッシュダンプと上限管理**: 単一起動ロック取得後・`whenReady` 前に `crashReporter.start({ uploadToServer: false, productName: app.getName(), compress: true })` を呼んで手元（`Crashpad`）にだけ残し、外へ送らない。`app.setPath('crashDumps', ...)` を手動で上書きすると Electron 44 の Windows 環境で Crashpad のパイプ登録（`TransactNamedPipe` 0x6D）が壊れてダンプが書かれないため、`crashDumps` のパスは `desktop/dev-identity.cjs` のアプリ名分離（開発版 `Pleiad Dev` / 配布版 `agent-host`）に委ねる。Electron に保持上限の設定口が無いため、起動時と `render-process-gone` の `5000` ミリ秒後に `pruneCrashDumps` で最大 `10` 件・合計 `50 MB` を超える古い `.dmp` と `attachments` を消す。

## 理由

- 窓ごとの重複実装を避け、無停止更新・リモート再接続で変わりうる最新のポート・トークンを使って白い画面から確実に復帰するため。
- 起動直後に落ち続ける環境で無限リロードに陥らないよう 60 秒 3 回で止め、保存済み会話が残ることを伝えた上で利用者が再試行・再起動を選べるようにするため。
- 長時間運用の実機で再発した際に `desktop.log` とローカルの `.dmp` の両方から OOM・GPU・読み込み失敗などを後から切り分けられ、かつディスクを圧迫し続けないようにするため。

## 影響

- 対象ファイル: `desktop/renderer-recovery.cjs`・`desktop/desktop-log.cjs`・`desktop/main.cjs`・`desktop/remote-windows.cjs`・`web/locales/{ja,en}/desktop.json`・`tests/data-writes-allowlist.mjs`・`tests/unit/desktop-renderer-recovery.mjs`・`tests/desktop/renderer-crash-smoke.cjs`・`docs/design.md`・`docs/dev-verification.md`。
- 本対応は復帰・記録・ダンプ保持までに限り、`backgroundColor` の変更、設定 UI・トレイ表示の追加、renderer のメモリ使用量そのものの調査・削減は対象外とする。
