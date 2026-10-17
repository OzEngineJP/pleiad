# 0218 Chrome のリモート デバッグの確認に Pleiad が答える

- 状態: 承認（2026-10-17）。利用者がモック（AsIs / ToBe）を見て、次を決めた:
  - 確認を自動で押すモードは「確認なし・制限なし」の 3 つだけにする（Claude の YOLO・Codex の YOLO・Antigravity）。
  - 設定に「Chrome の確認に自動で答える」を置く（既定はオン）。
  - スマホ（リモートの端末）からの許可を認める。
  - 「常に許可」は出さない。
  - トグルも Pleiad が入れる。ただし確認なしのモードでも、カードで人が押したときだけにする。
- 関連:
  - [ADR 0148](0148-agent-browser-in-chrome.md)（エージェントのブラウザーを PC の Chrome に移す）
  - [ADR 0153](0153-chrome-connection-waits-indefinitely-behind-os-layer.md)（待ちは無期限、OS の層の口）
  - [ADR 0154](0154-agent-window-hidden-off-screen.md)（窓を隠す）
  - [ADR 0167](0167-chrome-connection-held-across-updates.md)（接続の子）
  - [ADR 0168](0168-permission-wait-outlives-turn.md)（操作待ちのカード）
  - [ADR 0219](0219-agent-browser-in-chrome-macos.md)（同じ口の macOS の層）

## 状況

エージェントのブラウザーは、利用者の Chrome に CDP でつなぐ。

### 人の手が要る段

つなぐまでに、人の手が 2 回要る。

1. **トグル:** 初めてのときは、`chrome://inspect/#remote-debugging` を開いて「Allow remote debugging for this browser instance」をオンにする。
2. **確認:** 接続のたびに Chrome が「リモート デバッグを許可しますか？」と聞く。確認は覚えられず、Chrome を起動するたびに出る。

### 困っていたこと

- 確認は PC の Chrome の窓に出る。スマホから答えられず、ほかの窓の後ろに出ることもある。
- 会話のカードは承認の見出しなのに、肯定のボタンが無い。人は PC の Chrome まで行って押すしかなかった。
- docs/inapp-browser.md は「Pleiad はこの確認に自動で答えない」と書いていたが、理由の記録は無い。

### 実機で確かめたこと（Windows 11、Chrome 155、別の User Data）

- **chrome:// のページは外から開けない。** `chrome.exe` に `chrome://inspect/#remote-debugging` を渡すと、Chrome は新しいタブにする。
- **アドレス欄からは開ける。** UI Automation でアドレス欄（Edit）に `SetValue` し、その窓へ Enter を `PostMessage` すると開く。Chrome は、窓が前面のときしかこの Enter を受けない。
- **ページの中身は普段は見えない。** Chrome はページの中身を UI Automation に出していない。描画の窓へ `AccessibleObjectFromWindow` し、`IServiceProvider::QueryService` で IAccessible2 を問い合わせると出る。画面読み上げソフトと同じ扱い。
  - 出た後は、CheckBox「Allow remote debugging for this browser instance」を `TogglePattern` で入れられる。`DevToolsActivePort` も書かれる。
  - 画面の外・ほかの窓に覆われた窓では、中身が出ない。
- **確認のボタンは押せる。** 確認の窓の Button「許可する」（英語の UI は Allow）を `InvokePattern` で押すと、WebSocket が開いて `Browser.getVersion` が返る。前面は要らない。
- **通しでも動く。** Pleiad の層・接続をそのまま使うと、トグルを入れるまで約 1.9 秒、確認を押してつながるまで約 0.6 秒だった。

## 決定

### 1. 状態に consent を足し、Chrome の確認は Pleiad の中の許可の後にだけ出す

Pleiad が確認を押せるときがある（OS の層の `features.allow`、設定 `chromeAutoAllow` がオン）。そのときは、ポートが生きていても consent で止まり、Chrome にはまだ何も出さない（upgrade を投げない）。

consent を抜けるのは、次の 3 つのどれか:
- カードの「許可」（`browser.chromeConsent`）
- 設定の「つなぐ」（`browser.chromeConnect`）
- 確認なし・制限なしのモードの会話からの `demand({ consent: true })`

抜けたら upgrade を投げ、出た確認を `os.allowPermission(ref)` で押す。押す確認の窓は、findPermissionDialog が upgrade の前の写しとの差で見つけ、DevToolsActivePort のポートの待ち受けのプロセスに絞ったもの（ADR 0153）。

Pleiad が押せないとき、consent には入らず、今までどおり人が押す（前に出す）。押せないのは次のどれか:
- 設定がオフ
- OS の層が押せない
- 押せなかった（`allow-failed`）
- 押しても 5 秒開かなかった

`assist` は、Pleiad が代わりに押している段を状態に載せる。値は `enabling` / `enable-failed` / `allowing` / `allow-failed`。

### 2. トグルは「オンにしてつなぐ」を押したときだけ入れる

トグルは「ほかのプログラムがこの Chrome を操作してよいか」を決める元のスイッチで、確認なしのモードでも自動では入れない。

- 会話のカードと設定に「オンにしてつなぐ」（`browser.chromeEnable`）を出す。押すと `os.enableRemoteDebugging` がトグルを入れる。
- この 1 回で、その接続の許可も兼ねる。2 回は聞かない。
- 入れられなければ `enable-failed` にし、手で入れる手順（アドレスと「コピー」）を出す。

### 3. Windows の層は UI Automation を PowerShell から呼ぶ

`desktop/chrome-os/win32-uia.ps1` を、`powershell.exe -EncodedCommand` で 1 回ごとに起こす。頼みは環境変数 `PLEIAD_UIA` で渡し、答えは JSON の 1 行で返る。起動には 0.5〜2 秒かかるが、押すのは Chrome の起動ごとに 1 回なので足りる。koffi から COM の UI Automation を組むより小さい。

**allow（確認を押す）:**
- 層が確認として出した窓の中で、名前が「Allow」「許可する」のボタンがちょうど 1 つのときだけ押す。
- ほかの言語の Chrome・0 個・2 個以上なら押さず、人の案内に戻る。

**navigate → toggle（トグルを入れる）:**
1. 題に nonce を持つ新しい窓を開いて隠す（ADR 0154 の conceal）。
2. 透明・マウスの素通しのまま、画面の中の最前面（topmost）に置く。
3. その窓のアドレス欄からページを開く。開く間（1 秒未満）だけその窓に前面を持たせ、開いたらすぐ元の前面へ返す。
4. IA2 を問い合わせてから、トグルを入れる。
5. 窓を閉じる。同じ Chrome にほかの窓が無い（この窓で Chrome を起動した）ときは、閉じると Chrome ごと終わるので、見える形へ戻して残す。

利用者の窓・タブ・アドレス欄には触らない。マウス・キーボードの入力は送らない（Enter はその窓への `PostMessage`）。

### 4. 確認なしのモードは、カードを出さずに 1 行だけ残す

確認なし・制限なしの判定は、範囲が full で自律が never のモード。`web/composer-controls.mjs` の `isDanger` と同じ。

このモードの会話は、カードの台帳（`core/chrome/handoff.mjs`）が `demand` に `consent: true` を渡す。決着の行には「確認なしのため自動」と書く。ただし人が手を動かした接続には書かない。人が手を動かしたとは、次のどれか:
- トグルを入れた
- 人が押す案内に戻った
- 断った

Codex の「全部自動」（範囲は作業フォルダー）は含めない。Chrome への接続は、ログイン中のすべてのサイトに及ぶため。

### 5. 設定と、スマホからの許可

- **設定:** 「Chrome の確認に自動で答える」（`chromeAutoAllow`、既定はオン）を置く。オフからオンにする向きは関所を緩めるので、エージェントからの変更は承認が要る（riskOf で guarded）。
- **スマホ:** `browser.chromeConsent`・`browser.chromeEnable` は人のボタンなので、画面とリモートの端末から呼べる（MCP・CLI には出さない）。つなぐ・切る・前に出す（`chromeConnect` など）は、今までどおりホストの画面だけ。
- **通知の題:** 「{エージェント} が Chrome への接続の許可を待っています」にする。

## 理由

- **人の意思は Pleiad で取る。** カードの「許可」・設定の「つなぐ」・確認なしのモードの選択のどれかを人がしている。Chrome の確認は、その意思を Chrome にもう一度伝えるだけになる。consent を挟み、確認を出す前に聞くので、出た確認を押すのは、人が許した接続のものだけになる。
- **トグルは元のスイッチなので、毎回人に押させる。** 気づかないうちに入る形を作らない。押すのは初めの 1 回だけで、手間は小さい。
- **取り違えを防ぐ。** 押すボタンは、確認の窓・持ち主のプロセス・ボタンの名前と数で絞る。Chrome の権限の確認（通知・カメラなど）や、別のツールの接続の確認を押さない。
- **押せなくても今の手動に戻るだけにする。** 押せる道を足しても、利用者が気づかないまま止まる形を作らない。

## 影響

- **増えたファイル:** `desktop/chrome-os/win32-uia.cjs`・`win32-uia.ps1`。
- **増えた口:** `core/chrome/os.mjs` に `allowPermission`・`enableRemoteDebugging` と `features.allow`・`features.enable`。Windows の Win32 の表に `setTopmost`。
- **接続の状態:**
  - `consent` が増える。状態に `assist`・`enable` が載る。
  - `demand` が `consent` を受ける。`consent()`・`enable()` が増える。
- **操作と設定:** ops に `browser.chromeConsent`・`browser.chromeEnable`、設定に `chromeAutoAllow`。
- **画面:**
  - 会話のカードは、接続の案内が承認の形（見出しは「承認を待っている」）になる。
  - 設定の Chrome の行に「オンにしてつなぐ」と切り替えが増える。
- **トグルを入れる間:**
  - 1 秒未満、透明な窓が前面を持つ。その間に打ったキーは、その窓に入る。
  - Chrome が起動しているときは、新しい窓が画面の中に開いてから隠すまでの一瞬、見えることがある。
- **Chrome を閉じているとき:** 「オンにしてつなぐ」で Pleiad が Chrome を起動する。
  - 起動していない Chrome は、起動のときに渡した URL を開かないことがあるので、5 秒たっても窓が開かなければ、起動した Chrome にもう一度頼む。2 つ開いたら使わない方を閉じる。
  - Chrome が自分の画面（初回のログインなど）を先に出すと、窓が開かずに `enable-failed`（手順の案内）になる。その画面を Pleiad は操作しない。
  - 初回の画面を飛ばして作った試験用のプロフィールでは、この画面が出て開かなかった。普段使っているプロフィールで、閉じた状態から通るかは未確認。
- **IA2 の問い合わせ:** Chrome のアクセシビリティを、画面読み上げソフトと同じ扱いで有効にする。
- **まだやっていないこと:** 依頼元の端末に出る、別のホストの操作待ちのカード（ADR 0204）の「許可」。
