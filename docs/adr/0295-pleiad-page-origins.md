# 0295 Pleiad のページを、本体の画面と別の 2 つの origin（ファイルのページ・隔離）から配る

- 状態: 提案（仮番号。main に入れる直前に振り直す）
- 関連: [ADR 0294](0294-one-chrome-window-per-conversation.md)、[ADR 0009](0009-sandboxed-html-with-scripts.md)・[ADR 0042](0042-preview-loads-external-by-default.md)（一部置換）、[ADR 0050](0050-local-file-access.md)、[ADR 0010](0010-os-actions-only-on-host-screen.md)、[ADR 0115](0115-records-in-sqlite.md)、[ADR 0148](0148-agent-browser-in-chrome.md)、[ADR 0151](0151-zero-downtime-update.md)、[ADR 0167](0167-chrome-connection-held-across-updates.md)

## 状況

ADR 0294 で、ファイル・フォルダー・git・プラグイン・新しいタブを、Chrome のタブに出す Pleiad のページにした。HTML のファイルと可視化も、同じ Chrome のタブで開く。

- 本体の画面（`127.0.0.1:<port>`。既定 7420）は、トークン 1 つですべての操作に届く（`core/server.mjs` の `tokenOk`、Cookie の `agent_host_token`）。Chrome は AI が操作するブラウザーで、利用者のプロフィールの Cookie を使う。本体の画面のトークンが Chrome に入ると、AI が Pleiad を丸ごと操作できてしまう（自分への許可を自分で承認する、など）。今の中継（`core/chrome/relay.mjs` の `safeUrl`）は http のループバックを止めないので、利用者が Chrome で本体の画面を開いたことがあれば、今でもこの道が開いている。
- Cookie は port を区別しない。`127.0.0.1:A` の Cookie は `127.0.0.1:B` にも送られる。SameSite も port を区別しない（`localhost:A` と `localhost:B` は同じ site）。
- 可視化は srcdoc の iframe（opaque origin）で、相対パスの画像・fetch・WASM・localStorage が動かない（試作 `pleiad-proto-viz`）。記録は `presents/<会話>.jsonl` に中身ごと（8 MiB まで）書いている。
- HTML のファイルは、内蔵ブラウザーの `file:` のタブで開いていた。ページの中のリンクで、フォルダーの外の `file:` に移れた（ADR 0207）。
- リモートの端末は、端末の中のプロキシ（`core/remote/device-proxy.mjs`、iOS・Android は同じ作りのネイティブ）の `127.0.0.1:<p>` から本体の画面を読む。中継（`relay/server.mjs`）は Noise の暗号文を素通しするだけで、中身を読めない。ホストの側の入口は `core/remote/forward.mjs` である。

## 決定

### 1. origin を 3 つに分ける

| 名前 | origin | 中身 | 資格 |
|---|---|---|---|
| 本体 | `http://127.0.0.1:<port>`（今のまま） | 会話の画面 | 本体のトークン（今のまま） |
| ファイルのページ | `http://localhost:<pages port>` | ファイル・フォルダー・git・プラグイン・新しいタブ・HTML の枠 | ページの Cookie（下の 2） |
| 隔離 | `http://localhost:<isolated port>` | 可視化・HTML のファイルの中身 | 無し（URL の鍵だけ。下の 3） |

- ファイルのページと隔離は、本体とは別のリスナーにし、`127.0.0.1` と `::1` に bind する（Chrome は `localhost` を `::1` から試すことがある）。`AGENT_HOST_BIND` で本体を LAN に開いていても、この 2 つはループバックだけで待つ。
- 名前を `localhost` にするのは、本体（`127.0.0.1`）と Cookie の置き場を分けるためである。`127.0.0.1` の別 port にすると、本体の Cookie が届く。
- どちらのリスナーも、`Host` が `localhost:<その port>` のときだけ答える（DNS rebinding を防ぐ）。受けるのは GET と HEAD だけ。
- port はデータの置き場の `page-ports.json`（`{ pages, isolated }`）に覚え、次の起動でも同じ port を試す。取れなければ新しい port にし、開いている Pleiad のページのタブを中継が新しい URL へ移す。無停止の更新（ADR 0151）では、新しいサーバーが同じ port を引き継ぐ。試験用に `AGENT_HOST_PAGES_PORT`・`AGENT_HOST_ISOLATED_PORT`（`0` で空いた port）を足す。環境変数で決めた port は覚えない。
- 2 つのリスナーと本体の `/_pleiad/` は常に立てる（実装の間は旗 `AGENT_HOST_BROWSER_UNIFY=on` のときだけ立て、ADR 0294 の段階 C1 で旗を外した）。立った port は能力の `browserUnify`（`{ pages, isolated }`）で画面へ知らせる。

### 2. ファイルのページ

1. **URL の形**: `http://localhost:<pages port>/_pleiad/s/<会話 id>/<ページ>?path=…`。ページは `file`・`dir`・`git`・`plugins`・`new`・`attachment`。データは同じ前置きの `api/…`（`api/preview`・`api/raw`・`api/tree`・`api/git`・`api/plugins`・`api/recent`・`api/html-key`）から取る。
   - パスの検査と上限は、今のプレビューの関数（`resolveSessionFile`・`readPreview`・`listTreeFolder`・`readLocalFile`）をそのまま使う。上限はテキスト 8 MiB、画像・PDF 32 MiB、原文 5,000 行、表 500 行・100 列。
   - 会話 id は、その会話の読み取りの範囲（`fileAccessFor(sessionId)`。レビューの会話の `confine` を含む）を選ぶためにある。
   - 前置きの `/_pleiad/` は、Cookie の Path を絞るためにある。
2. **Chrome のタブでの資格**: 中継が CDP（`Storage.setCookies`。中継自身の接続で）で、Cookie `pleiad_pages` を入れる。属性は `localhost`、`Path=/_pleiad/`、`HttpOnly`、`SameSite=Strict`。
   - 値は本体のトークンから導いた別の値（HMAC(本体のトークン, "pleiad-pages")）。本体のトークンそのものは Chrome に入れない。本体のトークンが同じ間は値も変わらないので、更新をまたいでも入れ直さずに済む。
   - 入れる時点は、接続のたびと、Pleiad のページを開く前。URL に資格を載せないのは、Chrome の履歴と同期に残るためである。
   - `Storage.setCookies` で入れた Cookie が、会話のプロフィールのタブの `localhost` の要求に付くことは、中継の作りに取りかかる段（A2）の最初に実機で確かめ直す（2026-11-06 の追加の決定）。付かなければ、この 2 の 2 を見直す。
     - 確かめた（2026-11-06。使い捨てのプロフィールの Chrome で、既定の context のタブにも、既定でない context のタブにも付いた）。
   - この Cookie で届くのは、ファイルのページの GET だけである。本体の操作・WS・外で開く操作には届かない。
   - Cookie だけでは、要求の出どころを区別できない。`SameSite=Strict` でも、`localhost` の別の port のページ（利用者の dev サーバー・sandbox の無い応答）からの要求には付く。`localhost` の port 違いは同じ site だからである（2026-11-06 に実機の Chrome で確かめた）。
   - そこで、ファイルのページの入口と本体の `/_pleiad/` の入口は、`Sec-Fetch-Site` が `same-origin`（ページ自身）か `none`（アドレスバー・中継の移動）のときだけ通し、`same-site`・`cross-site` は 401 にする（2026-11-06 の追加の決定。`core/page-auth.mjs` の `fetchSiteOk`）。
     - 見出しの無い要求（ブラウザーでない取得）は Cookie の検査だけで通す。Chrome は `localhost` への要求にいつも付ける。
   - 既定のブラウザーでフォルダーのページを開くとき（ADR 0294 の 3 の 1）は、既定のブラウザーがこの Cookie を持たない。ホストの画面の `openPath` だけが 1 回だけ使える入場券を作り、`/_pleiad/enter?ticket=<券>` を OS に開かせる（2026-11-06 の追加の決定。`core/page-tickets.mjs`）。
     - ファイルのページの port は、券が生きていて（作ってから 60 秒・1 回だけ）、`Sec-Fetch-Site` が `none` か無い GET のときだけ、同じ属性の `pleiad_pages` を置き、券を作ったときに決めた行き先へ 303 で移す。行き先は URL から受けない。
     - 券は 32 バイトの乱数で、メモリだけに置き、20 枚までにする。ログに券と行き先を書かない。届くのは、Chrome のタブと同じファイルのページの GET だけである。
3. **画面の iframe での資格**（Chrome が無い会話・スマホの手元の描画・LAN のブラウザー）: 同じページを本体の origin の同じパス（`http://127.0.0.1:<port>/_pleiad/s/…`）でも配り、本体の Cookie で認証する（2026-11-06 の追加の決定）。ページのコードは同じで、相対の URL で API を呼ぶ。
   - 本体の入口が受けるのは本体の Cookie だけで、URL の `?token=` は受けない。GET と HEAD のほかは 405 にする。
   - 本体の origin で動くのは Pleiad のページのコードだけである。利用者の HTML と可視化は、iframe でも隔離した origin（下の 3）から読む。
4. **中で動くのは Pleiad のコードだけ。** 利用者のファイルの中身は文字として描く。Markdown は今と同じく `renderMarkdown` で消毒して描く。HTML・SVG のスクリプトは、この origin では動かさない（HTML は下の 3 の隔離の iframe、SVG は `<img>` で描く）。
   - 応答の CSP は `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src http://localhost:<isolated port>; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`。
   - `frame-ancestors` は、ファイルのページの port では `'none'`、本体の port では `'self'` にする。
   - `Referrer-Policy: no-referrer` と `X-Content-Type-Options: nosniff` を付ける。
5. **見た目**: Pleiad のテーマ（明るい・暗い）と言語に従う。ページは `api/env` から言語とテーマを読み、変わったときは中継が Pleiad のページのタブへ知らせる（隔離した world で `CustomEvent` を出す）。i18n は `web/i18n.mjs` を使い、`pages.json` を足す。
6. **ページから Pleiad への頼み**（行の ⋯・右クリック・書き込みを伴う操作）
   - Chrome のタブでは、中継がそのタブにだけ `Runtime.addBinding`（名前 `plyPage`）を足す。iframe では親へ `postMessage` で送り、親が送り元を確かめる。
   - 頼みは「この行のメニューを開きたい」「このファイルを会話で使いたい」「この差分をコミットしたい」のような**頼み**で、受けた Pleiad の画面がメニューや確認を描き、人が押してから今の WS の操作で実行する。
   - ページから届いた頼みは、そのタブを人が操作中（ADR 0296）のときだけ受ける。人が操作中のタブでは、AI の `Runtime.evaluate` などの操作は中継が断る。このため AI はページを通して頼みを偽れない。
   - 頼みに載ったパスは、サーバーで検査し直す。

### 3. 隔離した origin（可視化・HTML のファイル）

1. **資格を持たない。** 隔離の port は Cookie を資格に使わず、URL の中の推し量れない鍵だけで読ませる。
   - sandbox が効いている間（下の 2。opaque origin）は、隔離の枠からファイルのページへの要求に Cookie は付かない（`Sec-Fetch-Site: cross-site`）。タブに直に開いた枠でも、ファイルのページの中の iframe でも同じだった（2026-11-06、実機の Chrome）。
   - ただし、隔離の port の応答で sandbox の無いもの（作りの誤りなど）からの要求には、`pleiad_pages` が付く（`same-site`。2 の Cookie の項を参照）。隔離の枠がファイルのページを読めないことは、sandbox だけに頼らず、2 の `Sec-Fetch-Site` の検査でも守る。
   - 可視化: `/viz/<束のハッシュ>/<相対パス>`。束のハッシュは、束の中身の一覧（相対パス → 各ファイルの sha256）の sha256 である。
   - HTML のファイル: `/f/<鍵>/<相対パス>`。鍵は 128 ビットの乱数で、ファイルのページの `api/html-key` が、その HTML のファイルのフォルダーに結んで出す。鍵で読めるのは、そのフォルダーの下だけ（ADR 0207 の残した問題を塞ぐ）。読むたびに ADR 0050 の検査をかけ、上限は 2 の 1 と同じにする。鍵はサーバーの中のメモリだけに持ち、24 時間かサーバーの終わりで消える。
   - HTML のファイルのタブの URL は、ファイルのページ（`…/file?path=`）である。鍵の URL は枠の中の iframe にしか出ないので、Chrome の履歴の上の行には残らない。
2. **応答のヘッダー**: 可視化は `Content-Security-Policy: sandbox allow-scripts allow-downloads allow-forms; <プレビューの CSP>; frame-ancestors http://127.0.0.1:* http://localhost:*`。HTML のファイルは `sandbox allow-scripts` だけにする（2026-11-06 の追加の決定）。
   - どちらも `allow-same-origin`・`allow-modals`・`allow-popups`・`allow-top-navigation` は付けない。
   - 付けるヘッダー: `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: cross-origin`、今と同じ Permissions-Policy。
   - iframe の側にも同じ sandbox を書く。「広げる」で Chrome のタブに直に開いたときも、ヘッダーの `sandbox` で opaque origin になる。
3. **プレビューの CSP と確認**: 今の `previewPolicy` / `previewCsp`（`web/browser-confirm-policy.mjs`）を、サーバーからも使える純粋なモジュールにする。設定の「外部の読み込みの前に確認」と、「常に」許可した出どころ（`externalSitePermissions`）から、応答ごとに CSP を作る。
   - 「一度だけ読み込む」は、その一度の許可を載せた別の鍵（HTML）か、問い合わせの印（可視化。`?once=<短い乱数>`。サーバーのメモリで 10 分）で読み直す。
   - 止めた出どころは `securitypolicyviolation` を親へ伝える小さな橋で数える（今の `VIOLATION_BRIDGE`）。この橋は、サーバーが応答の頭に差し込む。
4. **可視化の束の保存**
   - 束: `visualize{"path":…}` が指す HTML（今と同じく UTF-8・1 MiB まで）と、同じフォルダーの下のファイルである。ドットで始まるもの・`node_modules` は除き、ADR 0050 の検査をかける。束全体で 200 ファイル・32 MiB、1 ファイル 8 MiB までとし（2026-11-06 の追加の決定）、超えたら HTML だけの束にして、カードに「資源は含めていません」と出す。
   - 中身は内容のハッシュで `viz-blobs/<sha256>` に 1 ファイルずつ書く（書いたら変えない）。束の一覧は、可視化の記録の行に持つ。データの置き場の書き込みの許可の一覧（`tests/data-writes-allowlist.mjs`）に `viz-blobs/` を足す。
   - 記録から消えた束のファイルは、起動時の片付けで消す。
   - 前の版の記録（中身を行に持つもの）は、読むときに HTML だけの束として扱い、そのとき blob を書く。`visualization-snapshots/` の写しは作らなくなり、残っている分は今の片付け（1 日）で消える。

### 4. 中継が通す Pleiad の origin の範囲

`core/chrome/relay.mjs` の移動の検査（`safeUrl` を使う 3 か所：`Page.navigate`・`Target.createTarget`・`openForConversation`）を次のようにする。

1. 通す: ファイルのページ `http://localhost:<pages port>/_pleiad/s/<その会話の id>/…` と、隔離の `http://localhost:<isolated port>/…`。
2. 断る:
   - ファイルのページの、ほかの会話の id のパス。
   - 本体の port（ホスト名が `127.0.0.1`・`localhost`・`[::1]`・`0.0.0.0` のどれでも）。
   - 2 つの port を `localhost` 以外の名前で指すもの。
   - `file:`（今のまま。アドレスバーでパスに直す）。
3. ページの中の JS（`location = …`）の移動は、上の検査では止まらない。そこで中継は会話のタブに `Fetch.enable` をかけ、本体の port と、ほかの会話のファイルのページへの要求を、中継の内側で失敗させる（今の `confirmAgentSites` の Fetch のセッションに足す）。
4. Cookie を読むコマンドの応答（`Network.getCookies`）から `pleiad_*` を除く。`urls` で隔離・ファイルのページを指す `Network.getCookies`・`Network.setCookie(s)`・`Network.deleteCookies` は断る。
5. ユーザーの dev サーバーなど、ほかの localhost の port は今と同じく通す。

### 5. リモートとスマホ

1. **ファイルのページ**: PC・スマホとも利用者のページは端末の中で直接描く。本体の origin の `/_pleiad/s/…` を、今の端末のプロキシ → Noise → `forward.mjs` の道で読む（上の 2 の 3）。新しいリスナーは要らない。
2. **「中継の側でも認証と大きさの上限」の置き場**: 中継のサーバー（`relay/server.mjs`）は暗号文しか見えないので、ここでは検査できない。かける場所は道の両端で、両方にかける（2026-11-06 の追加の決定）。
   - ホストの側（`core/remote/forward.mjs`）: `/_pleiad/` を許す道に足す。ペアリング済みの端末の流れだけを本体へ渡す（今と同じ）。応答の本体を数え、テキストの API は 8 MiB、`api/raw` は 32 MiB を超えたら流れを切る（本体の検査に任せきりにしない）。
   - 端末の側（`device-proxy.mjs`・`DeviceProxy.kt`・`DeviceProxy.swift`）: `/_pleiad/` を GET・HEAD だけ通す。受けた本体を同じ上限で数えて切る。
3. **隔離の origin**: 端末のプロキシに 2 つ目のリスナー `localhost:<p2>` を足し、`/viz/…` と `/f/…` だけを、ホストの隔離の port へ送る。
   - 流れの頭に行き先の印を付け、`forward.mjs` はそれを見て、本体ではなく隔離の port へつなぐ。本体の Cookie は付けない。
   - `Host` は `localhost:<p2>` だけを受ける。
   - iOS は `HostViewController.swift` の `decidePolicyFor` で、`http://localhost:<p2>` の子フレームを許す。`LinkPolicy` は、隔離の URL を「ホストだけのリンク」として断らないようにする。
   - Android は `network_security_config` の平文の許可に `localhost` を足し、`HostActivity.kt` の `shouldOverrideUrlLoading` で同じ子フレームを許す。
   - デスクトップのリモートの窓（`core/remote/device-proxy.mjs`）も同じ作りにする。
4. エージェントが開いた Web のページは映像で表示する。利用者が開く HTML・可視化は端末内で描き、明示的に「Chrome の映像」を選んだときだけ映像にする（ADR 0297）。中継を通る映像の量には、今は上限を置かず、測ってから決める（2026-11-06 の追加の決定）。

## 理由

- 本体のトークンを Chrome に入れないことが、AI に Pleiad を操作させないための線である。ファイルのページの Cookie は読み取りの GET にしか届かず、AI はもともと自分の道具でファイルを読める（ADR 0050 の考え方）。
- `localhost` の Cookie はほかの port にも送られる。そこで Path を `/_pleiad/` に絞り、値を本体のトークンと別にし、届く範囲を読み取りだけにした。ユーザーの dev サーバーに送られても、本体の操作には届かない。
- HTML と可視化を資格の無い origin で動かすと、中のスクリプトがファイルの API を呼んでも資格が付かない。ファイルのページの origin で描くと、HTML の中のスクリプトが同じ origin の API で別のファイルを読めてしまう。
- 鍵を HTML のファイルのフォルダーに結ぶと、相対の資源（画像・CSS・スクリプト）は読め、フォルダーの外は読めない。
- 画面の iframe を本体の origin から出すのは、別の origin の iframe だと Cookie が third-party の扱いで送られず、URL か postMessage で資格を渡す道を新しく作ることになるためである。スマホでは、リスナーを 1 つ増やさずに済む。中で動くのは今のプレビューと同じ Pleiad のコードで、危険の大きさは今と変わらない。
- 中継のサーバーは暗号文を素通しする作りで、中身を読ませると端から端までの暗号の前提が崩れる。そこで上限は道の両端でかける。

## 影響

- `core/server.mjs` にリスナーを 2 つ足す（ルーティングは新しいモジュール `core/pages-server.mjs`・`core/isolated-server.mjs` に分ける）。`/visualization-snapshot` と `writeSnapshotFile` は、移行の後に消す。
- `web/visualize-frame.mjs`・`web/visualize-document.mjs`・`web/preview-confirm.mjs` は、srcdoc をやめて隔離の URL を iframe の src にする。高さの通知（120〜900px）とリンクの橋は、サーバーが差し込む橋に移す。
- ADR 0009 の決定のうち、「CSP を HTML の内容より前に置く（meta）」「srcdoc の iframe」「可視化は allow-scripts だけ」を一部置き換える。HTML のファイルは allow-scripts だけのまま。ADR 0042 の確認の設定は、ヘッダーの CSP に効かせる形で続く。
- 文書: visualize.md・file-preview.md・remote.md・docs/design.md（リスナーの一覧）・AGENTS.md の環境変数の表。

## 追記（2026-11-06）: 端末の入口の検査・スマホの端末内の描画・ファイルのページの頭のパス

1. **端末のプロキシの入口**: 端末のプロキシ（`core/remote/device-proxy.mjs`・`DeviceProxy.kt`・`DeviceProxy.swift`）も、ファイルのページの要求は `Sec-Fetch-Site` が `same-origin`・`none`・無しのときだけ通し、ほかは 403 にする。通した値はホストへの転送の頭に載せ、`forward.mjs` はページの道でだけ本体へ渡す（知らない値は `cross-site` として渡し、ホストの入口で断られる）。隔離の入口は対象外（sandbox の枠からの要求は設計上 `cross-site`）。
2. **端末内の描画（v8 で置換）**: PC・スマホとも利用者が開くページを iframe で描く。通常のファイル・フォルダー・git・プラグインは本体の `/_pleiad/s/<sid>/<page>`、HTML・可視化は下記 `pageOpen` の URL を使う。
   - タブ・題・履歴は端末が持つ。Chrome に同じタブを作るのは「Chrome の映像」を選んだときだけ。ページへ戻すと保持した iframe を表示する。
   - ページの要求は `web/page-frame.mjs` の `pageRequestOf` で種類と会話を検査し、親で送信元の window と origin を照合する。通常ページだけがファイル操作を要求できる。
   - ツリーは画面側で描く。右の欄が 640px 以上なら横、狭ければ重ねる。画面内のページを表示中は映像の配信を止め、映像を選んだら再開する。
3. **ファイルのページの頭のパス**: 会話の作業場所の中のファイルは作業場所からの相対パス、外のファイルは絶対パスを出す。題（ツールチップ）には常に絶対パスを出す。
   - 2026-11-07 に ADR 0294 の 2 の 5（アドレスバーは絶対パス）で置き換えた。スマホも絶対パスを出す。

## 現在の制約（2026-11-06）

1. **LAN のブラウザーの画面の可視化**: `AGENT_HOST_BIND` で本体を LAN に開き、別の PC のブラウザーで `http://<LAN のアドレス>:<port>/` を開いた画面では、可視化を隔離の origin で描かず、srcdoc の iframe で描く（`web/client.mjs` の `loopbackScreen`。`web/visualize-frame.mjs` の `isolatedVisualizationUrl` が null を返す）。
   - 理由: 隔離のリスナーはループバックだけで待ち、`Host` が `localhost:<port>` のときだけ答える（上の 1）。LAN の画面の `localhost` はその PC 自身を指すので、届かない。
   - 安全: srcdoc の iframe の sandbox は `allow-scripts` だけで、`allow-same-origin` を付けない（`web/visualize-frame.mjs`）。可視化は不透明な origin で動き、Pleiad の画面の document・Cookie・保存領域に触れないので、安全は保たれる。
   - 起きること: 束の同じフォルダーの資源（相対パスの画像・CSS・スクリプト）・相対パスの fetch・WASM・localStorage は読めない（隔離の前と同じ）。会話の中の HTML の本文と、外部の読み込みの確認（ADR 0042）は今までどおり動く。「ブラウザーで開く」は会話の中の拡大になる（会話の Chrome のタブには開かない）。
   - 直さない理由: 隔離の origin から配る形を 2 つ調べ、採らなかった。(1) 本体の port に可視化の専用の道を作り、sandbox を二重にかける。(2) 隔離のリスナーを LAN にも開き、別の `Host` を受ける。どちらもファイルの中身を配る口を LAN に増やし、この ADR の 1 の線（本体だけを LAN に開く）を変える。本体は既定では LAN に待ち受けず（`AGENT_HOST_BIND` の既定は `127.0.0.1`）、この画面は環境変数で開いた人にだけある。スマホ・リモートの窓は端末のプロキシの `localhost` で隔離の origin を使えるので、今の形にとどめる。
   - スマホのアプリとデスクトップのリモートの窓は対象外（端末のプロキシの `localhost:<p2>` で隔離の origin を使う。上の 5 の 3）。

## v8 の画面と配信の約束（2026-11-07）

HTML・可視化のタブは、画面を作る W1 と隔離配信を作る W2 の境界を次のように分ける。この節が旧来の HTML の外枠 URL・opaque origin・スマホだけの端末内描画に優先する。鍵・CSP・リモートの配信変更は W2 の実装で合わせる。

- `pageOpen({sessionId, kind:'file'|'viz', path?, vizHash?, entry?})` は `{url,title,path?,kind,origin}` を返す。W1 は HTML・可視化の URL を組み立てず、ページでも Chrome でも返却 URL を使う。
- `page:moved {sessionId,from,to}` は現在の URL と履歴を差し替える。入力済みの画面は「更新を表示」を押して確認するまで残す。
- `page:changed {sessionId,path}` は、未操作なら読み直し、操作後なら「更新を表示」を出す。
- W1 の実装は `web/page-tabs.mjs` と `web/browser-unify.mjs`。試験だけ `tests/lib/page-open-w1.mjs` を依存として渡す。本番は `pageOpen` コマンドを呼び、代わりの URL へ逃がさない。W2 がコマンドを追加すれば、試験用の注入を使わず接続できる。
- 隔離された HTML の操作検出には `web/pages/activity.mjs` の `installPageActivity` を W2 のページへ載せる（モジュールを配るか、同関数を橋へ組み込む）。親の load 時の `pleiad:page-activity-init` に対し、クリック・選択・スクロール・入力の最初の変化を `pleiad:page-activity {input:boolean}` で親へ返す。親 window を照合し、応答先は受信した正確な origin に限定する。W1 も iframe の window と返却 URL の origin を照合する。この橋はアプリ操作の命令を受けない。

W2 の取り込み前には、本番の HTML・可視化の新しいタブを開くコマンドと隔離側の操作通知は未接続である。W1 の実ブラウザー試験は別 origin のページへ同じ橋を載せ、入力の保持と更新の確認を検証する。
