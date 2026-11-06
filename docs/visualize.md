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

以前の本文入りの可視化の記録は、表示するときに HTML だけの束へ移す。起動時には参照されない実体を掃除する。可視化の保存と配信の詳細は [ADR 0292](adr/0292-pleiad-page-origins.md) にある。

## 表示と操作

会話の可視化のカードは、保存した束を隔離の iframe で表示する。「広げる」は同じ束を会話の Chrome のタブで開く。Web・ファイル・git・プラグインと同じタブの列に並び、元のファイルを読み直すことはない。Chrome が無い会話でも、会話内の iframe で表示できる。

可視化の保存は HTML を渡す。束全体を ZIP などにはまとめない。元の在り処が分かるときはパスのコピー・元のファイルを開く・会話で使う操作も出す。元のファイルを開く操作は現在のファイルを読み、保存した写しと区別する。元の在り処が無い記録では、その操作を出さない。表示とカードの規則は [デザインシステム](design-system.md#可視化のカード承認済み2026-11-06) を参照。

## 外部の読み込みと隔離

可視化は Pleiad 本体・ファイルのページと異なる出どころから配り、認証 Cookie を使わない。iframe と応答の CSP は `sandbox allow-scripts allow-downloads allow-forms` にし、`allow-same-origin`・`allow-modals`・`allow-popups`・`allow-top-navigation` を付けない。単独で開いても不透明な出どころで実行し、親画面や Pleiad の保存領域へ届かせない。HTML のファイルは `allow-scripts` だけにする。

外部の読み込みの確認は既定 OFF で、HTTPS の資源を許す。ON のときは、許可した HTTPS の出どころ以外を止める。「読み込む」はその表示だけの一時の許可にする。HTML は新しい鍵、可視化は 10 分だけ有効なメモリー上の `once` の鍵を使い、恒久的な設定へ保存しない。HTTP だけの資源には「読み込む」を出さない。

隔離の応答は `Referrer-Policy: no-referrer`・`X-Content-Type-Options: nosniff` を付ける。共有の方針は `core/preview-policy.mjs` にまとめる。外部リンクなど親へ渡す通知は、送信元・会話・型と大きさを確かめ、任意のコマンドを実行する橋は公開しない。
