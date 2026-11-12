# 0294 右の欄のタブをまとめ、ページと Chrome の映像を切り替える

- 状態: 提案（仮番号。main に入れる直前に振り直す）。決定 5 の 6 の最後の一文「同じ実体パスをもう一度開く操作だけでは読み直さない」は [ADR 0321](0321-browser-file-reread-and-loading-display.md)（承認 2026-11-12）が置き換える
- 関連: [ADR 0295](0295-pleiad-page-origins.md)（origin と認証）、[ADR 0296](0296-human-touch-takes-tab.md)（操作の受け渡しと入力）、[ADR 0297](0297-screencast-ack-paced-quality.md)（映像）、[ADR 0041](0041-inapp-browser-beside-conversation.md)・[ADR 0079](0079-html-opens-in-inapp-browser.md)・[ADR 0207](0207-html-route-and-remote-browser-panel.md)（置換）、[ADR 0148](0148-agent-browser-in-chrome.md)・[ADR 0154](0154-agent-window-hidden-off-screen.md)・[ADR 0010](0010-os-actions-only-on-host-screen.md)・[ADR 0050](0050-local-file-access.md)

## 状況

右の欄は「ファイル・git・プラグイン・ブラウザー」を会話の見出しのアイコンで 1 つずつ切り替えて出していた。ブラウザーも 2 つある。人が見る内蔵ブラウザー（Electron の `WebContentsView`、ADR 0041・0148 の第 7 段）と、エージェントが操作する PC の Chrome の専用の窓（ADR 0148）である。

- ファイルのプレビュー・git・プラグインは Pleiad の画面の中の別の作りで、エージェントからは読めない。HTML のファイルは内蔵ブラウザーの `file:` のタブ（ADR 0079・0207）で開き、可視化の「ブラウザーで開く」も内蔵ブラウザーに別のものとして開いていた。
- リモートの端末は、ホストの内蔵ブラウザーのタブを映像で見る（ADR 0207）。Chrome の窓とは別の作りで、出し方も文言も違う。
- 内蔵ブラウザーのタブはエージェントが操作できない。人が開いたページをエージェントに渡すには「Chrome で開く」が要った。
- `file:` のタブは、ページの中のリンクでフォルダーの外の `file:` へ移れる（ADR 0207 の残した問題）。

モック v6 で、会話ごとに Chrome のウィンドウを 1 つにまとめる形を承認した（2026-11-06）。

## 決定

### 1. 右の欄のページと会話の Chrome（v8、2026-11-07）

会話の右の欄は、利用者が開くファイル・フォルダー・git・プラグイン・HTML・可視化を端末内のページとして描く。PC・スマホ・Chrome が無い会話で同じタブを使い、開いただけでは会話の Chrome にタブを作らない。エージェントが開いた Web のタブは Chrome の映像で表示する。

アドレスバーの隣の「ページ ⌄」から「Chrome の映像」を選ぶと、そのページを会話の Chrome に開く。往復しても Chrome のタブを増やさず、「ページ」に戻ると保持していた iframe を表示する。端末内のタブと履歴は端末が持ち、映像のタブとは区別する。HTML はパス、可視化は元のパスまたは題を表示し、タブの印もファイル・可視化にする。

Chrome の映像は、会話ごとの範囲で使い、他の会話・bot・普段使う窓と混ぜない。裏の描画を保つため Chrome 側は 1 タブ 1 窓のままとし、ページ側は端末で開いた順を覚える。窓を画面外に置く扱いは ADR 0154 に従う。

### 2. タブの列とアドレスバーは Pleiad が描く

1. 映像（ADR 0297）に映るのはページの中身だけ。映像タブの題・favicon・読み込み中は CDP の情報、画面内のタブは端末が持つページの情報で描く。ページと Chrome の映像のタブを、画面で開いた順に並べる。PC は上にタブの列（favicon・題・×・末尾に＋）、その下に 戻る・進む・再読み込み・アドレスバー・⋮。スマホは上にアドレスバー（Web はホストだけ）・タブの数・⋮ で、タブの数を押すとサムネイルの一覧。映像タブは縮小画像、画面内のページは種類の印と題で一覧にする。タブの幅・縮み方・狭いときの省き方の順は、モック v6 の決定のとおりにする（docs/design-system.md に書く）。
2. 中継は会話の範囲のタブごとに、自分の CDP セッション（`Target.attachToTarget`、flatten）を持ち、次の情報を集める。エージェントの接続とは別のセッションで、エージェントのコマンドには混ぜない。
   - URL と題: `Target.targetInfoChanged`。
   - 読み込み中: `Page.frameStartedLoading` / `Page.frameStoppedLoading`（主フレーム）。
   - 戻る・進むが効くか: `Page.getNavigationHistory`（主フレームが移ったときに読む）。
   - favicon: 読み込みが終わったら、隔離した world（`Page.createIsolatedWorld`。ページのスクリプトは動かない）で `link[rel~="icon"]` の href（無ければ `/favicon.ico`）を読み、中継のプロセスの HTTP（Cookie を持たない）で取る。`Network.loadNetworkResource` は `includeCredentials:false` でも same-origin の資格で送り Cookie が付くので使わない（Chrome 156 で確かめた）。favicon はブラウザーのプロセスが読むので、Chrome が読み込み済みのものを CDP でページの資源として取ることもできない。ページは favicon の URL を好きに書けるので、行き先を絞る（`core/chrome/icon-fetch.mjs`）。名前を解決した後の IP が loopback・private・link-local・CGNAT・文書用・マルチキャスト・この PC のアドレス（IPv4 を埋めた IPv6 も中の IPv4 で）なら繋がず、検査した IP へそのまま繋ぐ（DNS の付け替えで抜けられない）。リダイレクトは 3 回まで 1 段ずつ同じ検査をかけ、`/_pleiad/` は取りに行かない。例外は、ページと同じ host（名前・port・scheme）で、その host が `localhost` か IP の直書きのとき（手元の開発サーバーの favicon）だけで、Pleiad の 3 つの port は例外にしない。64 KiB までの画像だけを data URL にし、origin ごとにメモリに覚える。取れなければ、ホストの頭文字を描いた札にする。Pleiad のページのタブは、取りに行かず種類のアイコン（文書・コード・フォルダー・枝分かれ・パズル。単色）を出す。
3. **URL の扱いを緩める。** 今は窓の題だけを画面に出し、URL は出していない（docs/inapp-browser.md「URL の扱い」）。これからは URL・favicon・読み込み中も画面に送る。ただし送る先はその会話を開いている画面だけで、WS の `chromeWindow` のように全画面へ配ることはしない。ログには今と同じく題・URL を書かない。
4. アドレスバーは URL とパスの両方を受ける。
   - パスとして読む入力: Windows は `C:\`・`\\`・`~\`・`.\`・`..\`、macOS・Linux は `/`・`~/`・`./`・`../`。`file://` の URL もパスに直す。相対パスの基準は会話の作業場所。パスとして読める入力は検索に送らない。候補にファイルとフォルダーを出す（`listTreeFolder` を使う）。
   - 開けないパスは、候補の 1 行目に理由を出して Enter を効かせない。ネットワークのパス・デバイスのパス・Pleiad のデータの置き場がこれにあたり、ADR 0050 と同じ検査をサーバーでかける。
   - URL でもパスでもない入力は検索にする。検索の URL は、会話のプロフィールの `Preferences` の `default_search_provider_data` から読み、読めなければ Google の検索の URL を使う。Chrome の既定の検索エンジンは CDP から読めないためである。
   - アドレスバーで URL を打って移ると、そのタブは人の操作に移る（ADR 0296）。
5. Pleiad のページのタブでは、アドレスバーに URL ではなく絶対パス（区切りの形）を出す。表示は PC で [ツリー][区切りのパス][プレビュー／原文] [ページ ⌄] の順。区切りの名前を押すとそのフォルダーへ移り、記号か空いた所を押すと文字で直せる。スマホではパスのどこを押しても文字で直す（2026-11-06 の追加の決定）。git は「<作業フォルダー名> › 変更」、プラグインは「プラグイン」、添付は「添付 › 名前」。新しいタブは「URL・パスを入力、または検索」。
6. 同じファイルのタブは 1 枚にまとめる。キーは、ADR 0050 の検査を通した後の実体のパスである。会話のファイルのリンク・添付・道具の結果のパスを押すと、そのタブへ移る（無ければ新しいタブで開く）。ファイルの変更が届くと、まだ触っていないページは自動で読み直す。クリック・スクロール・選択などで触った後は「更新を表示」を出し、押すまで今の表示を保つ。入力済みのページを更新・移動・閉じるときは確認する。同じ実体パスをもう一度開く操作だけでは読み直さない。

### 3. 外で開く操作

1. 「エクスプローラーで表示（macOS は Finder で表示）」「既定のブラウザーで開く」「既定のアプリで開く」「パスをコピー」「相対パスをコピー」「保存」「会話で使う」を 1 つの並びにする（開く → 写す → 持ち出す）。置き場は 4 つで、中身はどれも同じ。タブの ⋮（今のタブ）、タブの右クリック、フォルダーの一覧の行の ⋯ と右クリック、会話のファイルのリンクの ⋯。どの種類のタブに何を出すかは、モック v6 の表のとおりにする。
2. **メニューは Pleiad が描く。** Pleiad のページの中には置かない。ページの中で右クリック・⋯ を押すと、ページはその行の「メニューを開きたい」という頼みだけを Pleiad の画面へ送る（ADR 0295 の「ページから Pleiad への頼み」）。項目を選んだ後の実行は、今と同じ WS の操作で行う。
3. 「既定のアプリで開く」を新しく足す（ADR 0010 の「開くのは .html / .htm だけ」を一部置き換える）。開けるのは許した拡張子だけで、許す一覧をコードに 1 つだけ持ち、サーバー（`core/os-open.mjs`）と Electron の main（`desktop/file-bridge.cjs`）の両方がその一覧で検査する。一覧は次のとおり。
   - 文書: `.txt` `.md` `.pdf` `.rtf` `.docx` `.xlsx` `.pptx` `.odt` `.ods` `.odp` `.csv` `.tsv`
   - 文字のデータ: `.log` `.json` `.jsonl` `.yaml` `.yml` `.xml` `.toml` `.ini`（2026-11-06 の追加の決定。既定のアプリで開いても中身を見せるだけで、実行されない種類）
   - 画像: `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.svg` `.heic` `.tiff`
   - 音・動画: `.mp3` `.wav` `.flac` `.m4a` `.ogg` `.mp4` `.mov` `.webm` `.mkv`
   - ほかの拡張子（`.js` `.py` `.ps1` `.bat` `.cmd` `.vbs` `.hta` `.reg` `.url` `.lnk` `.exe` `.msi` `.jar` など）は出さず、サーバーも断る。マクロを含みうる `.docm` `.xlsm` も入れない。
   - フォルダーは「エクスプローラーで開く」と「既定のブラウザーで開く」にする。既定のブラウザーにはフォルダーのページを開く（入場券で入る。ADR 0295 の 2 の 2。2026-11-06 の追加の決定）。「既定のアプリで開く」は出さない。
4. 外で開く操作は、今と同じくホストの画面（中継を経ないループバックの WS）からだけ受ける。理由を書いた 1 つの口（ADR 0010 の `revealPath` / `openPath` に `openDefault` を足す）を通し、10 秒に 5 回までにする。AI の操作（CDP）からも、リモートからの入力からも起こせない。リモートの画面には出さず、代わりの説明文も出さない。

### 4. Chrome が無い会話とファイルツリー

Chrome の接続状態にかかわらず、利用者が開くページは同じタブ列・アドレスバー・ツリーで扱う。接続を求めず、接続後も自動で Chrome に移さない。Web のリンクは既定のブラウザーへ開く。

ファイルのツリーは、右の欄が 640px 以上ならページの左側、狭ければページに重ねて出す。並べるときの初期幅は 208px、160〜320px かつ欄の 40% 以内で、境界のドラッグか左右キー（16px 単位）で変える。開閉と幅は会話ごとに覚える。重ねるときは 280px（欄の右端に少なくとも 48px を残す）で、保存した幅は変えない。矢印は選択と枝の開閉だけを行い、クリック・Enter は現在のタブ、Ctrl／⌘＋クリック・中ボタン・Ctrl／⌘＋Enter は新しいタブで開く。同じ実体パスのタブがあれば選ぶ。「現在のファイルへ戻る」「すべて畳む」、行の ⋯・右クリック・Shift+F10 を備える。狭い画面では Escape で閉じてツリーのボタンへフォーカスを戻す。

画面内のページには操作の受け渡しを設けず、タブの黒い点・常設の「あなた」やエージェント名の札を出さない。Chrome の映像で人が操作したときだけ、短い「あなたが操作中」と「AI の操作を再開」を出す。明示的な停止の理由と人への依頼のカードは残す。

### 5. 内蔵ブラウザーをやめる

1. 同じ版で内蔵ブラウザーを丸ごと消す。消すものは次のとおり。
   - デスクトップ: `desktop/browser-panel.cjs`・`browser-screencast.cjs`・`browser-screencast-bridge.cjs`・`browser-viewer-bridge.cjs`。IPC の `ply:browser*` と preload の `plyDesktop.browser` もなくす。
   - サーバー: `core/browser-viewer.mjs`、`browser.openFile`、能力の `pcBrowser`。
   - 画面: `web/remote-browser.mjs`、`web/link-sheet.mjs`、`web/browser-address.mjs`。
   - 設定の `linkOpen` と、それに付く文言・試験。
2. Chrome の窓と共有している部分は残して削る。共有しているのは `core/browser-screencast.mjs` の hub、`web/browser-panel.mjs` のタブの列、`web/remote-browser.mjs` の座標の関数（`containRect`・`toPageCoords`・`toPageDelta`）である。座標の関数は先に別のモジュールへ移す。
3. 既定のブラウザーへ http の URL を渡す口は、今は内蔵ブラウザーの `openExternal` の動作だけが持っている。これを専用の IPC `ply:open-external` に置き換える（中の検査は今の `external()` のまま）。
4. **移行**
   - prefs の `linkOpen` は読み飛ばし、`defineSetting` から外す。保存されている値は次に設定を書いたときに落ちる。
   - 内蔵ブラウザーの保存領域 `persist:pleiad-browser`（ログインの Cookie など）は、新しい版の最初の起動で 1 回だけ消す（session を開かずに `Partitions/pleiad-browser` を消す。先に `session.clearStorageData()` で開くと Chromium が中のファイルを掴み、Windows では `EPERM` で消えなかった（2026-11-06 の確かめ）。消せなかったときだけ `clearStorageData()` で中身を消し、次の起動でフォルダーを消し直す。印は `userData/browser-partition-cleared`。`desktop/browser-partition-cleanup.cjs`）。持ち主の居ないログインの情報を残さないためである。リリースノートに「内蔵ブラウザーのログインは引き継がれません」と書く（2026-11-06 に確定）。
   - 更新の引き継ぎ（ADR 0167）にある内蔵ブラウザーのタブの写しは、新しい版では読まずに捨てる。写しはサーバーのメモリ（前の `core/browser-viewer.mjs`）にあり、新しい版のサーバーは受け口を持たないので、前の main の報告は読まれずに消える。
   - 地球のボタン（スレッドの頭）と Ctrl+Shift+B は、右の欄の開け閉めにする。
5. 会話の見出しのアイコンは、右の欄を開け閉めするアイコン 1 つにまとめる。git・プラグイン・作業フォルダーへは、＋の新しいタブから行く。

### 6. 文言

- すべて `web/locales/{ja,en}/` に置く。名前空間を 3 つ足す（2026-11-06 の追加の決定。並べて作る段どうしが ui.json の同じ所を書かないため）。
  - `tabs`（`tabs.json`）: `tabs:strip.*`（タブの列・一覧）、`tabs:address.*`（アドレスバー・候補・断る理由）。
  - `control`（`control.json`）: `control:*`（札・ポップ・帯。ADR 0296）。
  - `pages`（`pages.json`）: ADR 0295 の Pleiad のページの文言。
  - 映像の `browser.video.*`（遅れ・途切れ。ADR 0297）は ui.json に置く。
  - 案の段で `browser.tabs.*`・`browser.address.*`・`browser.control.*` と書いていた鍵は、それぞれ `tabs:strip.*`・`tabs:address.*`・`control:*` に読み替える。
- 承認された語: 「画面を開く」「映像が遅れています」「つなぎ直しています」「ファイルを選ぶ」「任せる」。操作中のカードの説明文は消し、「Claude のウィンドウ」「あなたのタブ」は使わない。エージェントの名前が入るところは `{{name}}` で受け、「Claude」を直書きしない。
- エクスプローラーの語は OS で替える。`files.menu.revealFile` などは、macOS 用の別の鍵（「Finder で表示」）を持つ。
- 消すのは、内蔵ブラウザーだけが使う鍵である（`browser.*` のビューアの鍵、`settings.browser.linkOpen.*`、`timeline.link` のシートの鍵、`ops.browser.openFile.*`）。残すのは `settings.browser.confirm.*`（可視化と HTML のファイルに効く）と `timeline.link.hostOnly` など。
- ui.json は文字列の置き換えで直す（JSON を読み直して書き戻さない）。

## 理由

- 利用者が開いたファイルや git は画面内で描き、端末で直接操作できる。AI と同じ画面を見る必要があるときは、表示を「Chrome の映像」に切り替えて、そのページを会話の Chrome に開く。
- ブラウザーが 2 つあると、作り・文言・リモートでの見え方が 2 通りになる。内蔵ブラウザーは AI が触れないので、残す理由が無い。
- タブの列とアドレスバーを映像に入れず Pleiad が描くと、狭い右の欄やスマホでも字がつぶれない。テーマ・言語・操作中の札を Pleiad の決まりで出せ、ページの中に偽の札を置かれても区別できる（ADR 0148 で、ページに帯を差し込む案を採らなかったのと同じ理由）。
- URL を画面に出すのは、アドレスバーを Chrome と同じ形にする決定（モック v6）による。送り先をその会話を開いている画面に絞れば、ほかの会話・bot の画面には漏れない。
- 「既定のアプリで開く」を許す一覧にするのは、ADR 0010 が恐れた「既定のアプリ経由で実行される」ものを、拒む一覧の漏れで通さないためである。
- Chrome が無い会話でも、ファイルのページは同じものを iframe で出せる。Chrome をつなぐかどうかで、ファイルの見え方の中身は変わらない。

## 影響

- docs: file-preview.md（Pleiad のページへ書き換え）、inapp-browser.md（ビューアの章を消し、Chrome のウィンドウの章へまとめる）、remote.md、design-system.md（タブの列・アドレスバー・省き方・ファイルの操作の表）、visualize.md。これらは実装の段で書き換える。
- ADR 0041・0079・0207 は置き換える。ADR 0042 は `file:` のタブの守りが無くなり、確認の設定は可視化と HTML のファイルの CSP（ADR 0295）に効く。ADR 0010 は「開く」の範囲を広げる。ADR 0148 の「右の欄は映すだけ」「引き継ぐ」は ADR 0296 で置き換える。
- 試験: 内蔵ブラウザーの試験（`tests/unit/inapp-browser.mjs`・`remote-browser-view.mjs`・`url-links.mjs`・`html-route.mjs`・`desktop-external-link.mjs`）は消すか書き直す。`linkOpen` を使う試験と `tests/ops-surface.snap.json` を直す。
