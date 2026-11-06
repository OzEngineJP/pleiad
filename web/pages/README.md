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
| `pleiad:page-command` | `{type:'tree',open?:boolean}` | 同上 |

テーマと言語はページを再取得せずに更新する。ファイル本文のスナップショットも再利用する。
