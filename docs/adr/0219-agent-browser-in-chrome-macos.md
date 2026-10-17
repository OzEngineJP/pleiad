# 0219 エージェントのブラウザー（Chrome）を macOS でも動かす

- 状態: 提案
- 関連: [0148](0148-agent-browser-in-chrome.md)（Chrome の専用窓）、[0153](0153-chrome-connection-waits-indefinitely-behind-os-layer.md)（OS の層の契約）、[0154](0154-agent-window-hidden-off-screen.md)（窓を隠す置き方）、[0173](0173-computer-use-macos.md)（macOS の Swift ヘルパー）

## 状況

- エージェントのブラウザー（利用者の PC の Chrome に CDP でつなぎ、会話ごとの専用の窓でエージェントが操作する機能）は、これまで Windows（`desktop/chrome-os/win32.cjs`）だけで動き、macOS では `unsupported`（`reason: 'platform'`）になっていた。
- macOS でも同じ体験（`DevToolsActivePort` の検出、必要に応じた `chrome://inspect/#remote-debugging` のトグル有効化、接続時の「リモート デバッグを許可しますか？」の確認ダイアログの検出・前面化・自動応答、会話ごとの専用窓の起動・中継・`agent-browser` の操作）を提供したい。
- すでに computer use のために Swift のヘルパー `pleiad-computer-helper`（[ADR 0173](0173-computer-use-macos.md)）があり、`Pleiad.app/Contents/Helpers/pleiad-computer-helper` として同梱・署名され、Accessibility（TCC）の許可の確認・案内も備えている。
- 一方で、macOS の WindowServer は Windows の `SetWindowPos` + `WS_EX_LAYERED` + `WS_EX_TOOLWINDOW` のように他プロセスの窓を透明化・画面外へ完全に移動させる API を持たないため、[ADR 0154](0154-agent-window-hidden-off-screen.md) の「窓を隠す（`conceal`）」が macOS でどこまで効くかは実機（`macos-15` ランナー）で確かめる必要があった。

## 決定

### 1. User Data の既定の場所（`core/chrome/locate.mjs`）

- `platform === 'darwin'` の既定の User Data を `~/Library/Application Support/Google/Chrome`（Edge は `~/Library/Application Support/Microsoft Edge`）とする。
- `DevToolsActivePort` と `Local State`（`profile.last_used`・`profile.info_cache`）の構造は Windows と同じ。`AGENT_HOST_CHROME_USER_DATA` による差し替えも共通で効く。

### 2. OS の層の新しい口（`core/chrome/os.mjs`）

Windows 側の自動許可・自動有効化と名前・形をそろえて、`core/chrome/os.mjs` の契約に次の 2 つの口と `features`（`allow`・`enable`）を足す。

- `allowPermission(ref)` → `Promise<boolean>`（上限 `ALLOW_TIMEOUT_MS = 20_000`）: `findPermissionDialog` が見つけた確認の窓の参照 `ref` についてだけ、「許可する／Allow」ボタンを押す。層が確認として出した `ref` 以外には何もしない。
- `enableRemoteDebugging({ browser, profileDir, userDataDir? })` → `Promise<{ ok: boolean, reason?: string }>`（上限 `ENABLE_TIMEOUT_MS = 45_000`）: すでに `DevToolsActivePort` があり TCP でつながるなら何もせず `{ ok: true }` を返す。無ければ一意なマーカー付きの `data:` URL で新しい専用窓を開き、アドレス欄から `chrome://inspect/#remote-debugging` へ移動して「Allow remote debugging for this browser instance」のトグルをオンにし、その一時窓だけを閉じて元の前面アプリへ戻す。利用者がすでに開いている窓やタブには触らない。

### 3. Swift ヘルパー（`pleiad-computer-helper`）への `chrome*` op の追加

別のヘルパーを増やさず、`desktop/computer/mac/` の `pleiad-computer-helper`（`Chrome.swift`・`Server.swift`）に Chrome 操作用の op を足す。これによりアプリの署名・同梱・TCC（Accessibility）の許可が 1 つで済む。

| op | 役割 |
|---|---|
| `chromeWindows` | 指定ポートの `lsof` または実行ファイル名から Chrome の PID を特定し、`AXManualAccessibility` と `AXEnhancedUserInterface` を `true` にして `AXWindow` 一覧（ID `ax-<pid>-<index>`・題・座標・大きさ・最小化）を返す |
| `chromeFindDialog` | Chrome のシート（`AXSheet`・`AXDialog`・`AXApplicationAlertDialog`）と小窓を走査し、その要素の部分木（`AXWebArea` を除く）にリモートデバッグの確認の文言があり、かつ許可ボタンがちょうど 1 つあるシート・窓そのものの参照を返す（シートが窓に付くときは親の `AXWindow` ではなくシート要素を返す） |
| `chromeAllowDialog` | `chromeFindDialog` が出した `id` の要素 1 つの部分木（`AXWebArea` を除く）だけを調べ、確認の文言を含み、かつ許可ボタン（`許可する`・`Allow`）がちょうど 1 つのときだけ `kAXPressAction`（または `kAXConfirmAction`）で押す（`method: "ax-press" | "ax-confirm"`）。0 個や 2 個以上なら押さずに `{ ok: false, reason: "no-button" | "ambiguous" }` を返し、アプリ全体や他の `AXWindow` は見ない |
| `chromeEnableStep` | マーカーの題で一時窓を特定し、アドレス欄（`AXTextField`）へ `chrome://inspect/#remote-debugging` を入れて移動させ、`AXWebArea` 内のチェックボックス `AXDOMIdentifier == "remote-debugging-enabled"` が有効（`kAXEnabledAttribute == true`）になるのを待ってからオンにし、検証後に一時窓を閉じる |
| `chromeRaise` | `NSRunningApplication.activate` と `kAXMainAttribute`・`kAXFocusedAttribute`・`kAXRaiseAction` で窓を前面に出す |
| `chromeClose` | `kAXCloseButtonAttribute` に `kAXPressAction` を送って窓を閉じる |
| `chromeMoveWindow` | `kAXPositionAttribute`・`kAXSizeAttribute`・`kAXMinimizedAttribute` を設定する |
| `chromeDisplays` | `CGGetActiveDisplayList` と `CGDisplayBounds` からディスプレイ配置を返す |

### 4. `chrome://inspect/#remote-debugging` と確認シートの AX 操作の仕組み

Chrome 152（macOS arm64）での実測に基づき、次の手順を採る。

1. **Web 領域の AX 露出**: Chrome は既定では Web ページの中身を macOS の Accessibility 木に出さない。アプリの `AXUIElement` に `AXManualAccessibility = true` と `AXEnhancedUserInterface = true` を設定すると、`AXWebArea` の下に DOM の要素が現れる。
2. **アドレス欄からの移動**: `chrome://inspect/#remote-debugging` はコマンドライン引数で直接開くと新しいタブになるため、まず `data:text/html,<title>PLY-ENABLE-<nonce></title>` を `--new-window` で開き、その窓のアドレス欄（`AXTextField`）に URL を設定して `Return` を送る。Chrome は窓がアクティブでないとアドレス欄の `Return` で移動しないため、移動の間だけ一時窓をアクティブにし、必要なら `⌘L` → 文字列入力 → `Return` にフォールバックし、完了後に `prevFrontPid` のアプリを前面へ戻す。
3. **チェックボックスの特定と待機**: `chrome://inspect` には 4 つのチェックボックス（`discover-usb-devices-enable`・`discover-tcp-devices-enable`・`port-forwarding-enable`・`remote-debugging-enabled`）があり、最初の 2 つは初期状態でチェック済み、`remote-debugging-enabled` はページの初期化（`inspect.js`）が終わるまで `disabled`（`kAXEnabledAttribute == false`）になっている。そのため `AXDOMIdentifier == "remote-debugging-enabled"`（またはラベル文言 `Allow remote debugging for this browser instance`）で厳密に特定し、`enabled == true` になるまで待ってから `kAXPressAction`（効かなければ親 `<label>` の `kAXPressAction`、さらにフォーカス＋Space）でオンにし、`kAXValueAttribute` が `1` になったことを確かめる。
4. **確認シートの単一要素への限定**: 利用者の Chrome にはサイトの通知・カメラ・位置情報などの「許可する／Allow」の確認も出うる。取り違えて別の許可を押さないよう、`chromeAllowDialog` は `chromeFindDialog` が返したシート・窓 1 つの部分木（`AXWebArea` を除く）だけを見て、確認の文言と「ちょうど 1 つの許可ボタン」が揃っているときだけ押す（Windows 側の `desktop/chrome-os/win32-uia.ps1` の `allow` と同じ規則）。

### 5. 窓を隠す（`conceal`）の扱い

`macos-15` ランナー（画面 `1024×768`、Chrome 152）で次の 3 通りを実測した。

1. **`AXPosition` で画面外（`x = 2024, y = 0`）へ移動**: macOS の WindowServer が窓の左端を `x = 984`（画面右端 `1024` の内側 40 px）にクランプし、画面外へ完全に追い出せない（`fullyOffscreen: false`）。
2. **CDP `Browser.setWindowBounds` で画面外（`left = 2024, top = 0`）へ移動**: 同じく `left = 984` にクランプされる（`fullyOffscreen: false`）。
3. **最小化（`AXMinimized = true`）**: 設定直後に `minimizedState: false` に戻るか、最小化できても [ADR 0154](0154-agent-window-hidden-off-screen.md) のとおり裏で描画・viewport 操作が止まる恐れがある。

また、macOS には他プロセスの窓の透明度（alpha）やマウス素通し（click-through）、Dock / Command+Tab からの除外を外から設定する公開 API が無い。そのため `desktop/chrome-os/mac.cjs` では `features.conceal = false`・`features.watch = false` とし、`core/chrome/windows.mjs` の既存の分岐に従って**見える通常の窓のまま使う**。`launchWindow` で窓を開いた直後に `restoreForeground` で直前の前面アプリへフォーカスを戻し、エージェントの `Page.bringToFront`・`Target.activateTarget` は中継で握りつぶす。

## 実証結果（GitHub Actions `macos-15`）

`.github/workflows/chrome-mac-verify.yml`（`scripts/verify-chrome-mac.mjs`）により、`macos-15`（macOS 15.7.9 arm64、Google Chrome 152.0.7977.83）で一時 `--user-data-dir` を使って次の一連の流れが通ることを実証した。

- **Accessibility の許可**: ランナー上で `AXIsProcessTrusted()` が `true`、`CGPreflightScreenCaptureAccess()` も `true`。
  - **注（実証の範囲）**: CI のワークフローでは、実行前に `/Library/Application Support/com.apple.TCC/TCC.db` へ `kTCCServiceAccessibility` の許可を書き込んでから試している。利用者の Mac では、初めて使うときに Pleiad に Accessibility の許可を手で出す必要がある（ヘルパーの `request` op とシステム設定の Accessibility ペインへの案内。[ADR 0173](0173-computer-use-macos.md) §6）。
- **`enableRemoteDebugging`**: 既存の窓（`ax-4068-1`）を残したまま一時窓を開き、`chrome://inspect/#remote-debugging` の `remote-debugging-enabled` をオンにして一時窓を閉じ、`DevToolsActivePort`（port `9222`）が生成され、残る窓が `ax-4068-1` のみであることを確認（所要約 5.5 秒）。
- **接続と `allowPermission`**: `createChromeConnection` が `permission` 状態に入り、`findPermissionDialog` が確認シートを検出し、`allowPermission` が確認シート内の Allow ボタンを `method: "ax-press"` で押して `connected`（`Browser.getVersion` → `Chrome/152.0.7977.83`）に遷移することを確認。
- **中継と `agent-browser`**: `createChromeRelay` と `createWindowManager` を通して同梱の `agent-browser`（darwin arm64）でローカル試験ページを `open` → `snapshot -i` → `screenshot` し、見出し・ボタンの取得と PNG 保存がすべて成功することを確認。
- **実証できなかったこと・未確認の範囲**:
  - 窓を画面外や透明にして利用者から完全に隠すこと（`conceal`）。macOS の WindowServer が画面外への移動を `x = 984` にクランプするため、`features.conceal: false` として見える窓で動かす。
  - `enableRemoteDebugging` で一時窓のアドレス欄に `Return` を送る約 1〜2 秒の間、Chrome の一時窓が一度アクティブになること（完了後に元の前面アプリへ戻す）。
  - **日本語 UI の Chrome**: CI は英語の Chrome だけで確かめた。日本語の Chrome の確認シートの「許可する」と、`chrome://inspect/#remote-debugging` のトグルの文言は、実機ではまだ確かめていない（トグル自体は言語に依らない `AXDOMIdentifier == "remote-debugging-enabled"` を主条件にしている）。

## 理由

- 既存の `pleiad-computer-helper` に op を載せることで、ビルド・ユニバーサルバイナリ化・Developer ID 署名・TCC の許可案内を二重に持たずに済む。
- `core/chrome/os.mjs` の口（`allowPermission`・`enableRemoteDebugging`）を Windows 側と完全に一致させることで、`core/chrome/connection.mjs` 側の自動許可・自動有効化の流れを OS ごとの分岐なしに共通化できる。
- macOS で効かない `conceal` を無理に最小化で代用せず `features.conceal: false` を正直に返すことで、描画停止や操作失敗を避け、`core/chrome/windows.mjs` の既存の非 conceal 経路をそのまま使える。

## 影響

- `core/chrome/locate.mjs` が `darwin` に対応する。
- `core/chrome/os.mjs` に `allowPermission`・`enableRemoteDebugging` と `features.allow`・`features.enable` が加わる。
- `desktop/chrome-os/mac.cjs` が新設され、`desktop/chrome-os/index.cjs` と `desktop/main.cjs` が `darwin` で `mac.cjs` を選ぶ。`attachChromeOs` は非同期（Promise）の戻り値も解決して `chrome-os-result` に返す。
- `desktop/computer/mac/` の `pleiad-computer-helper` に `chrome*` op が加わる。
- Windows 上の単体試験（`tests/unit/chrome-os.mjs`・`tests/unit/chrome-connection.mjs`）で、偽のヘルパーを用いて `mac.cjs`・`locate.mjs`・`index.cjs` の契約を検証する。
