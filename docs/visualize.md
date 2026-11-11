# 会話内の可視化

Pleiad の可視化は、Claude・Codex 共通の Visualize 参照で表示する。公開 MCP ツール `present` と `/mcp/ply`、その有効化設定は廃止した（[ADR 0008](adr/0008-retire-present-mcp-for-visualize.md)）。外部 MCP の設定は変更しない。旧 `plyPresentEnabled` の値は使用しない。

## 作り方

ホストの任意の場所に UTF-8 の HTML を作り、回答の独立した行に絶対パスの参照を置く。UNC・デバイスパスと Pleiad のデータ置き場（添付の uploads を除く）は利用できない（[ADR 0050](adr/0050-local-file-access.md)）。

```text
visualize{"path":"D:/workspace/output/comparison.html","title":"比較"}
```

Codex の専用形式も同じ経路で受け取る。

```text
visualize{"path":"D:/workspace/output/comparison.html","title":"比較","mode":"wide"}
```

上のコードブロックは説明用。実際の回答ではコードフェンス・インラインコード・リストに入れず出力する。コード例とユーザー発言からファイルを読み込むことはない。Claude の実接続では専用 Unicode 記号が落ちる場合があるため ASCII 形式を使えるようにした。

共通スキルは `skills/visualize/SKILL.md`（英語の会話）と `skills/visualize/SKILL.ja.md`（日本語の会話。参照の形式は同じ。docs/design.md「多言語対応」）。ターン開始時に、会話の言語のものを Claude の system prompt append と Codex の developerInstructions に注入する。ネイティブのスキル・指示は既存のコンテキスト設定に従い、可視化の表示契約を追加する。ユーザーのスキルディレクトリを書き換えたり、OpenAI プラグインのコードをコピーしたりしない。

## 保存する束

可視化は、回答を確定した時点の HTML と同じフォルダーの資源を束として保存する。元のファイルを変更・削除しても、過去の表示は変わらない。更新を見せるときは新しい参照を回答する。1 ターンは 32 参照まで、HTML は UTF-8 の 1 MiB までで、非 HTML・不正 UTF-8 は理由を残して断る。

束は HTML のフォルダーを再帰して集め、隠しファイル・`node_modules` と、ファイルの検査で読めないものを除く。上限は 200 ファイル・合計 32 MiB・各 8 MiB。超える場合は HTML だけを残し、「資源は含めていません」と知らせる。相対資源を後から元のフォルダーへ取りに行くことはない。

束の実体は内容の SHA-256 を名前にした `viz-blobs/` のファイルに保存する。会話の可視化の記録は、相対パスと実体のハッシュを持つ manifest（束の目録）を参照する。目録のハッシュを URL にした `/viz/<束のハッシュ>/<相対パス>` で隔離のリスナーから配る。ファイルの検査は取り込むときに行い、保存した実体は書き換えない。

以前の本文入りの可視化の記録は、表示するときに HTML だけの束へ移す。起動時には参照されない実体を掃除する。可視化の保存と配信の詳細は [ADR 0295](adr/0295-pleiad-page-origins.md) にある。

## 表示と操作

会話の可視化のカードは、保存した束を隔離の iframe で表示する。出どころは束ごとの専用の origin `v<束の印>.localhost`（`core/isolated-origins.mjs`。束のハッシュの先頭 24 字）なので、相対パスの資源・fetch・WASM・localStorage はその origin の中で本物が効く。カードの操作は「広げる」（↔。その場で会話の列を越えて横へ広げる）と「ページで開く」（窓の印）と「⋮」に分かれる。「ページで開く」は**元の HTML の現在版**を右の欄のページタブで開く（カードのインラインの表示は保存した当時の束のまま）。元のファイルが消えていれば保存した版へ進み、切り替えた旨を知らせる。元パスの記録が無いものはそのまま保存版を開く。保存した版のタブは「保存した版」の札と題を出し、元のパスを現在のファイルのように見せない。ファイル・フォルダー・git・プラグイン・HTML と同じタブの列に並ぶ。Chrome が無い会話でも、会話内の iframe で表示できる。LAN のブラウザーの画面（`AGENT_HOST_BIND`）では隔離のリスナーに届かないので、srcdoc の iframe で描く。sandbox に `allow-same-origin` を付けないので Pleiad の画面の document には触れないが、束の同じフォルダーの資源・相対パスの fetch・WASM は読めない。本体は既定では LAN に待ち受けず、この画面は環境変数で開いた人にだけあるので、隔離の origin から配る形は採らなかった（ADR 0295 の「現在の制約」）。

可視化の保存は HTML を渡す。束全体を ZIP などにはまとめない。カードにはホストの PC の画面で「既定のブラウザーで開く」の専用ボタンを置く。「⋮」（カード・新しいタブの行）にはパスのコピー・Explorer・「会話に保存した版を開く」・「HTML を保存」を、保存した版のタブの「⋮」には「元のファイルを開く」（現在のファイルを読み、保存した写しと区別する）・「HTML を保存」・「題をコピー」を出す。「HTML を保存」は、中身を手元に持つカードではその中身から、手元に無い経路（新しいタブの行・保存版のタブ）では会話の記録にある束の入口を認証つきで読む `api/viz` から取る。元の在り処が無い記録では、パスを使う操作と OS の操作を出さない。リモートの画面ではホストの OS を開く操作は出さない。表示とカードの規則は [デザインシステム](design-system.md#可視化のカード承認済み2026-11-06) と [ADR 0305](adr/0305-browser-surface-frame-newtab-viz-focus.md) を参照。

## 外部の読み込みと隔離

可視化は Pleiad 本体・ファイルのページと異なる出どころ（束ごとの `<印>.localhost`）から配り、認証 Cookie を使わない。iframe と応答の CSP は `sandbox allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups allow-pointer-lock`（`APP_SANDBOX`）にし、`allow-top-navigation` を付けない。アプリごとの専用の出どころで動くので `allow-same-origin` を付け、ほかのアプリや Pleiad の保存領域へは届かせない。HTML のファイルも同じ sandbox（フォルダーの印の出どころ）。srcdoc の写しは従来どおり不透明な出どころの `allow-scripts` だけにする。

外部の読み込みの確認は既定 OFF で、HTTPS の資源を許す。ON のときは、許可した HTTPS の出どころ以外を止める。「読み込む」はその表示だけの一時の許可にする。HTML は新しい鍵、可視化は 10 分だけ有効なメモリー上の `once` の鍵を使い、恒久的な設定へ保存しない。HTTP だけの資源には「読み込む」を出さない。

隔離の応答は `Referrer-Policy: no-referrer`・`X-Content-Type-Options: nosniff` を付ける。共有の方針は `core/preview-policy.mjs` にまとめる。外部リンクなど親へ渡す通知は、送信元・会話・型と大きさを確かめ、任意のコマンドを実行する橋は公開しない。
