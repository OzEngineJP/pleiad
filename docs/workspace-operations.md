# 会話から使うワークスペース操作

ホストの操作一覧とエージェント用 MCP の `list_ops`、`call_op` から、会話が属するワークスペースを操作できます。エージェントは現在の会話を使い、画面からの呼び出しでは `sessionId` を渡します。ブラウザーから作成した組織の会話では、会話の作成時に割り当てられた組織を使います。組織の印がない会話では、個人用ワークスペースを使います。

| 操作 | 入力 | 結果 |
| --- | --- | --- |
| `workspace.search` | `query`（タイトルの部分一致、省略可）、`limit`（最大100） | 読み取り権限があるページの `pageId`、`title`、`kind`、`databaseId` と、続きがあるかを示す `more` |
| `workspace.readPage` | `pageId` | `pageId`、`title`、`markdown`、`blocks`（各要素は `id` と `type`）、`version` |
| `workspace.writePage` | `pageId`、`baseVersion`、`requestId`、`change`、置き換え時の `blockId` | `pageId`、`blockId`、保存後の `version` |
| `workspace.queryDatabase` | `databaseId`、任意の `viewId`、`filters`、`sorts`、`limit`、`offset` | 項目の定義 `properties`、行 `rows`、続きの `nextOffset` |
| `workspace.createTask` | `databaseId`、`title`、任意の `values`、`requestId` | 作ったタスクの `id` と `version` |

ページを編集する前に `readPage` で版を取得します。`change` は `{kind: "appendParagraph", text}` または `{kind: "replaceText", text}` です。文章は1行のプレーンテキストです。置き換えは段落、見出し、チェック項目、コードブロックを対象にできます。`WORKSPACE_CONFLICT` が返ったら、ページを読み直し、変更を確認して新しい要求を作ります。

データベースの絞り込みは `{propertyId, op, value}` の配列です。`empty` と `not_empty` では値を省きます。`eq`、`ne`、範囲比較、`contains` の可否と値の型は項目に従います。タイトルには `title` を使います。タスクの `values` は項目 ID をキーに持つオブジェクトです。状態の既定値はテンプレートから補われます。

書き込みには会話の承認モードが適用されます。承認が必要な場合は `PENDING_APPROVAL` を返し、結果を会話に通知します。保存後のページの版と本文は `workspace.readPage` で確認できます。`requestId` は呼び出し側で生成する UUID です。応答を受け取れなかったときは、同じ会話から同じ内容と要求 ID で再試行すると、保存済みの場合は同じ結果を返します。ログインが必要な場合は `WORKSPACE_SIGN_IN_REQUIRED`、個人用ワークスペースがない場合は `NO_PERSONAL_WORKSPACE` を返します。
