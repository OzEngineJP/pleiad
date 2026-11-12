# Pleiad のページ

`/_pleiad/s/<sessionId>/<page>` は会話に属する読み取りページを表示する。
`page` は `file`、`dir`、`git`、`plugins`、`new`、`attachment`。
本体とページ専用リスナーは同じ内容を配り、認証・Host の検査と旗の判定は呼び出す側が行う。
ページ本文にブラウザーの見出しや操作列は含めない。

## サーバーから渡す情報

`createPagesRoutes(deps)` は S0 の `ops`、`store`、`fileRoots`、`fileAccessFor`、
`resolveSessionFile`、`htmlKeys`、`ports` を利用する。
次の任意の関数で会話の情報を補える。

| 関数 | 戻り値 |
| --- | --- |
| `recentFiles(sessionId)` | `[{path, source, at?, actor?}]`。source は `read` / `edited` / `attached` / `opened` |
| `env(sessionId)` | `{lang:'ja'|'en', theme:'light'|'dark'|'auto'}` |
| `visualizations(sessionId)` | `[{title,url}]`。隔離 origin と一致する URL のみ表示 |
| `gitTimeline(sessionId)` | 既存 git パネルが使う会話の作業時点の情報 |

最近のファイルを渡さなければ、そのサーバーで開いたファイルを会話ごとに保持する。
作業フォルダーは会話の現在の `cwd` と `history` の `field:'cwd'` の変更履歴から取得する。
どちらも表示前にサーバーでファイルのアクセス制限を検査する。

## 読み取り API

API は同じ会話の `api/<name>` に GET / HEAD でアクセスする。
`preview`、`raw`、`tree`、`html-key`、`git`、`plugins`、`recent`、`env` を提供する。
`preview?path=...&content=raw` はメタデータと本文の種類だけを返す。
本文は `raw?path=...` で別取得し、JSON のエスケープや base64 による応答の増加を避ける。
テキスト 8 MiB、画像・PDF・原本 32 MiB、表 500 行・100 列、原文 5000 行の既存上限を維持する。
HTML は鍵を発行し、隔離 origin の `/f/<key>/<basename>` を iframe で表示する。

`git?kind=...` は `status`、`changes`、`diff`、`history`、`commit`、`worktrees`、
`worktree`、`prs` の既存の読み取り操作だけを呼び出す。
ページの操作には書き込み API はない。差分はリポジトリを基準に、削除済みのファイルは現存する親から検査する。
Git のパス指定式への展開を防ぐため、差分のパスの `:`、`*`、`?`、`[`、`]`、バックスラッシュは現在受け付けない。
共有の Git 読み取り処理がすべてのパスを literal として扱うようになれば、この制限を解除できる。

## ホストへの操作要求

Chrome のページでは `window.plyPage(JSON.stringify(request))`、
本体の iframe では同じ origin の親へ `{type:'pleiad:page-request',request}` を送る。
要求は `{type,sessionId,...detail}`。

| type | detail | ホストの処理 |
| --- | --- | --- |
| `file-menu` | `path,kind,x,y` | 共通のファイル操作メニュー |
| `use-file` | `path` | 添付をこの会話で使う |
| `use-text` | `text` | 作成欄へ文を渡す |
| `jump` | `event` | 会話の該当する発言を表示 |
| `worktree` | `action,requestId,...` | 作業場所への書き込みの確認と実行 |

作業場所の action は `keep`、`ask`、`unask`、`archive`、`restore`。
詳細は順に `{id,kept}`、`{row}`、`{ask}`、`{row}`、`{row,ref}`。
書き込みの要求は、届けただけでは完了にしない。
ホストは確認と処理を終えたとき、同じ `requestId` へ `{requestId,ok:true,result}`
または `{requestId,ok:false,error}` を返す。
Chrome では `CustomEvent('pleiad:page-result',{detail:reply})` をページへ送り、
iframe では `{type:'pleiad:page-result',...reply}` をそのフレームへ送る。
Promise を返すホスト関数も利用できる。要求は最大 50 件、応答待ちは 5 分で打ち切る。
`keep` の成功結果は `true` または処理結果のオブジェクトとする。キャンセルは失敗の応答を返す。
`ask` は `{title,messageId,sessionId}`、`unask` / `restore` は真偽値、
`archive` は既存部品と同じ `{action,ref?,why?}` を返す。

## ホストからの表示更新

Chrome は次の CustomEvent をページへ送る。
iframe は同じ origin の親から対応する message を送る。

| イベント | CustomEvent の detail | iframe の message |
| --- | --- | --- |
| `pleiad:env` | `{theme?,lang?}` | `{type:'pleiad:env',env}` |
| `pleiad:page-command` | `{type:'view',view:'source'|'preview'}` | `{type:'pleiad:page-command',command}` |
| `pleiad:page-command` | `{type:'changed'}` | 同上 |
| `pleiad:page-command` | `{type:'reread'}` | 同上（Pleiad のページだけ。触ったかどうかは親が決め、そのまま読み直す） |

テーマと言語はページを再取得せずに更新する。ファイル本文のスナップショットも再利用する。

## ページから親への状態の知らせ

ページは描き始め・描き終え・失敗を親へ `{type:'pleiad:page-state',state:'loading'|'ready'|'failed'}` で知らせる（同じ origin の親だけが受ける）。
親はこれで、アドレスバーの下の読み込み線とタブの印を出し入れする。
親は 150ms を超えて待ったときだけ線と印を出し、60 秒待っても `ready` が来なければ失敗として扱う（[ADR 0320](../../docs/adr/0320-browser-file-reread-and-loading-display.md)）。
`reread` は前の中身を残したまま読み直し、描き終えたところで差し替える。

## 隔離のページ（HTML・可視化）の読み直しと位置

隔離の origin のページは Pleiad のページアプリを持たず、サーバーが差す橋（`core/isolated-routes.mjs` の `withHead` → `web/visualize-document.mjs` の LINK_BRIDGE）と親が message でやり取りする。
読み直しでスクロール位置を保つため、次の 2 つが加わる（[ADR 0295](../../docs/adr/0295-pleiad-page-origins.md) の橋の規則のまま。宛先は origin を指定し、受け手は送り元の窓と出どころを確かめる）。

| 向き | message | 意味 |
| --- | --- | --- |
| 親 → ページ | `{type:'pleiad:page-command',command:{type:'scroll-restore',x,y}}` | 読み込み直した文書で位置へ戻す。親は読み直しの間に預かった位置だけを送る。橋は見えるまで待ち、見えてから 3 秒ほど高さを追い、利用者が触れたらやめる |
| ページ → 親 | `{type:'pleiad:page-scroll',x,y}` | `reload` の命令を受けたとき、読み直す直前の位置を命令の送り元の出どころへ返す。枠が見えない間は、見えていたときの最後の位置を返す。親は読み直しの間だけ受ける |

位置はページの window 変数や localStorage には置かない（ユーザーの HTML のスクリプトから見えないよう、親の枠の持ち物として預かる）。
