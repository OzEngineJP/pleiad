# 内部 AI 呼び出しの分離（会話も接続先の履歴も作らない）

## 状態

承認（2026-11-09）。

## 状況

記憶の整理（learner）・bot の会話の要約（episode）・心拍の安い判断（pulse）は、これまで側車に `bot.kind` の印を付けた隠れた会話で走らせていた。次の発言の候補（suggest）とタイトル生成（title）も、接続先によっては使い捨ての会話・履歴に残る呼び出し（`agy --print` など）を使っていた。このため、内部処理が利用者の会話の一覧・検索・通知・最近の場所に混ざり、直接 get/read でも開けた（Issue #180）。

## 決定

- 内部の AI 呼び出しは 1 本の共通経路 `host.internalCall`（`core/internal-call.mjs` → `backend.internalTurn`）に集める。使う場所は `learner`・`episode`・`pulse`・`suggest`・`title` の 5 種。どれも Pleiad の会話を作らず、接続先の会話履歴にも残さない
- 能力の印 `capabilities.internalCall` で分離の可否を宣言する。Claude・Codex・fake は `ephemeral`（接続先に会話を残さない実行）。Antigravity・Devin・Grok・OpenCode は `impossible(理由)` — 接続先に会話を残さないことを確かめられないため
- 分離できないエージェントでは当該機能を実行しない（通常会話へのフォールバックはしない）: learner・episode は halted（記憶の設定の状態の行に理由）、pulse は理由付きの静かな行で paused、候補は設定 › 入力の説明にエージェント名と理由、題名は `UNSUPPORTED`
- 呼び出しの記録は journal（既存 `memory_state`、kind `internal.calls`。1 呼出し 1 行・終了分は直近 100 件）と使用量（既存 `usage_records` の `internalTask` 欄。kind・botId・model・account・endpoint）に残す。測れない値は 0 でなく null（不明）。失敗・中断・打ち切りでも記録する
- 以前 learner・pulse が作った隠れた会話は、確かな印（`meta.bot.kind` が `learner`・`pulse` で `channelId`・`threadId` が null）のあるものだけを一覧・検索・最近の場所・通常の `sessions.get`/`sessions.read` から外す。題・文頭の prefix では判定しない。データは消さない。診断用に `includeInternal` で読める
- 既存の `runTurn({ internal: true })`（会話に差し込む内部の発言）と、Claude のターンの中の候補（`promptSuggestions: 'native'`）は別物で変えない

## 理由

- 内部処理は「会話として見える物を作らない」が正であり、印付きの会話をあとから隠す形では一覧・検索・通知・ネイティブ id 経由の参照などの抜け道が残る
- 分離の可否は接続先ごとに違うので、確かめられない場所で動かすより、理由を見せて止める方が利用者のデータの扱いとして正直
- 不明な使用量を 0 扱いすると予算の線を越えて自発が続くので、不明は不明として保守的に止める
- 旧データは消せない（消すとネイティブの会話が表に出る・人の履歴を失う）ので、確かな印があるものだけ見えなくする

## 影響

- 新しい DB は足さない。journal は `memory_state`、使用量は `usage_records` に既存の形で入る
- 分離できないエージェントを使う利用者では、記憶の自動整理・bot の会話の要約・心拍・次の発言の候補・タイトル生成が理由表示付きで動かない。ふつうの会話・bot の仕事・ルーティン・委譲・承認・bot の通常会話はそのまま
- Antigravity で動いていた次の発言の候補は止まる（設定 › 入力に理由が出る）
