# マルチバックエンド設計（v3）

途中のバックエンド切り替えは [backend-handoff.md](backend-handoff.md) を参照。
切り替え済み会話では会話IDとネイティブIDを分離し、本文の正本をアプリに移す（本書 §2.1 の例外）。

作成 2026-09-11。`design.md` §3「やらない: マルチプロバイダ」を**改訂する**（[ADR 0004](adr/0004-multiple-agent-backends.md)）。
Claude Agent SDK に加えて **OpenAI Codex**（公式 `codex` CLI の app-server）をバックエンドとして駆動できるようにする。
2026-09 に **Antigravity CLI**（`agy`）を足した（§2.8）。
同時期に入れた Gemini CLI（ACP）は、個人向けログインの終了により廃止した。

## 外部エージェントと操作ツールの版

利用者が CLI を管理する。下表は確認した範囲であり、上限は設けない（[ADR 0037](adr/0037-manage-external-agent-versions.md)）。

内蔵ブラウザー操作用の agent-browser は **0.38.1** を同梱する。エージェントの CLI と異なり、Pleiad がこの版を固定して配る（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。

| バックエンド | つなぎ方 | 検証した版 | 最低の版 | 頼っている非公開のもの |
|---|---|---|---|---|
| Codex | `codex app-server` | CLI 0.160.0 | なし | rollout の `session_meta.cli_version`、`response_item` の `turn_id` とツール出力。拒否の読み取り（[ADR 0035](adr/0035-read-codex-rollout-for-rejections.md)）、`thread/shellCommand` の `userShell` の item の `command` の包み方と止めたときの `exitCode: -1`・`command aborted by user`、`!` のターンの間の `turn/start` の扱い（[ADR 0054](adr/0054-shell-from-composer.md)） |
| Claude Code | Agent SDK の `query()` と利用者の `claude` CLI | SDK 0.3.258、CLI 2.1.283 | なし | `projects/*.jsonl` の attachment と `cost-state`（使用量の累計）、`subagents/*.jsonl` の親子鎖、`*.meta.json` の `toolUseId`、`system:compact_boundary` の `compactMetadata`・`isCompactSummary`・`parentUuid`、コマンド・`!` の行のタグと中断の文字列（[ADR 0053](adr/0053-system-messages-display.md)）、`shouldQuery: false` の行をつないだ 1 つの user 行（[ADR 0054](adr/0054-shell-from-composer.md)） |
| Antigravity | `agy --print= --input-format stream-json --output-format stream-json` | CLI 1.2.12（Hooks の実機検証。[ADR 0049](adr/0049-hooks-pleiad-managed.md)） | 1.1.11（古い版では `/usage` がモデルへの依頼になる） | ファイルなし。stream-json のイベント形 |
| 内蔵ブラウザー操作 | `agent-browser` と会話別 CDP 中継 | 0.38.1（同梱） | 同梱版を使用 | なし |

非公開形式の不一致は `AGENT_HOST_DATA/backend-shape-errors.log` に、バックエンド・種類・検知した版・検証した版・時刻だけを記録する。同じ組合せはログに残る間は一度だけ記録する。Claude の transcript は行の `version`、Codex の rollout は先頭の `session_meta.cli_version` を使う。Antigravity の stream-json には版がないため `unknown` と記録する。

---

## 1. 何が問題か

SDK は 2 つの役割を兼ねていた（棚卸しの結論）。

1. **実行エンジン** — `query()` を回してストリームを吐く。差し替えは `runTurn` 1 本で済む。
2. **セッション管理データベース** — 一覧・タイトル・状態タグ・履歴・fork・サブエージェントを
   `~/.claude` の JSONL に外注していた。codex には等価物が無い。

さらに `core/session.mjs` が **生の SDK メッセージを web へ素通し**しており、
`web/client.mjs` が Anthropic の API ストリーム型（`content_block_start` / `text_delta` …）を直接パースしていた。
これが唯一かつ致命的な境界の穴で、ここを塞げば web の 2800 行はほぼ無傷で残る。

## 2. 決めたこと

### 2.1 正本の所在（design.md §5 の再改訂）

理由は [ADR 0005](adr/0005-source-of-truth-for-sessions.md)。

| | 旧（v1） | 新（v3） |
|---|---|---|
| セッションの存在・一覧 | `~/.claude`（SDK `listSessions`） | **各バックエンドのネイティブ一覧 ∪ sidecar**。sidecar（形式 2 では `pleiad.db`。形式 1 の `sessions.json`。[ADR 0115](adr/0115-records-in-sqlite.md)）が全バックエンド横断のインデックス |
| タイトル / 状態 | `~/.claude`（customTitle / tag） | **バックエンドがネイティブに持てるならそれが正本**（Claude: customTitle/tag、Codex: thread name）。持てないものは sidecar が正本。書くときは両方に書く |
| cwd / createdAt | SDK | ネイティブ優先、無ければ sidecar |
| 変更履歴・parent・statusChangedAt・mode・model・present | sidecar | 変わらず sidecar |

「ネイティブに持てるなら持たせる」を残す理由: Claude で公式 CLI / VS Code とタイトル・状態が共有される利点（design.md §5）は捨てない。
Codex も `thread/name/set` で公式クライアントとタイトルを共有できる。

**セッション id はバックエンドのネイティブ id をそのまま使い、行に `backend` を付ける。**
複合キーにしない（web の `s.id` 依存を壊さない）。衝突は実質起きない
（Claude: UUID、Codex: UUIDv7、Antigravity: UUID）。
サーバは `sessionId → backend` を sidecar で引き、無ければ各バックエンドの `getSession` を順に当てる。

ネイティブ一覧は読むのに時間がかかる（Codex の `thread/list` は 1 秒前後、2026-09-26 実測）ので、サーバーはバックエンドと件数ごとに使い回す（`core/server.mjs` の `nativeSessions`）。
一覧の行に効く出来事（本文の流れ・`running`・承認など数の多いもの以外）が出たら捨て、Pleiad の外（公式 CLI）で動いた分のために 10 秒で読み直す。
一覧・系譜（`lineage`）・状態の候補（`listStatuses`）が同じものを使う。sidecar はメモリにあるので毎回読む。

### 2.2 core → web は正規化イベントだけを流す（プロトコル v2）

`sdk` イベントを廃止し、以下に置き換える（[ADR 0006](adr/0006-normalized-events-protocol.md)）。`PROTOCOL_VERSION` は **2**。

バックエンドが出してよいイベントの種類と、必ず付けるフィールドの正本は `core/backends/contract.mjs` の `BACKEND_EVENTS`
（ターンの外の `host.event` で出せるものは `OUTSIDE_TURN_EVENTS`）。試験のサーバー（`tests/lib/server.mjs`）は `PLEIAD_BACKEND_CONTRACT=strict` で
受け口（runTurn・compact・adoptTurn の `emit` と `host.event`）ごとに照らし、外れたイベントがあれば `stop()` で落とす。下の表は意味の説明
（[ADR 0220](adr/0220-backend-contract-and-agent-descriptors.md)）。

| type | ペイロード（`sessionId` は emitGlobal が必ず補う） | 置き換える旧経路 |
|---|---|---|
| `text.delta` | `{ text }` | `stream_event/text_delta` |
| `text.end` | `{ uuid? }` 確定した発言の id。走っている最中でも分岐の起点にできる（v3） | `assistant`（streamEl リセット） |
| `thinking.start` | `{ }` | `content_block_start(thinking)` |
| `thinking.delta` | `{ text?, estimatedTokens? }` | `thinking_delta` |
| `tool.start` | `{ id, name, input, at, startedAt?, shell? }` `shell: true` は、名前でシェルのツールと見分けられない呼び出し（ACP の自由な題。Devin の `kind: "execute"`）がシェルのコマンドであること。名前で見分けるものは、エージェントの記述（`core/backends/agents.mjs`）の `shellTools` に書く（`core/shell-tools.mjs`）。`at` はサーバーが受けた時刻（epoch ms）。バックエンドは出さず、server の `makeEmit` が 1 か所で付ける（すでに数の `at` があれば上書きしない）。実行中のスナップショット（`stream.events`）にも同じ値が残るので、開き直し・再接続の再生でも、画面は走っているツールの経過と見出しの経過を本当の開始から数える（端末の時計とのずれは `ready` の `now` で補う）。`startedAt` はバックエンドが申告した開始（Codex の `startedAtMs`。推定で埋めない） | `assistant` の `tool_use` |
| `tool.result` | `{ id, text, isError, truncated, rejection?, images?, computer? }` `rejection` は実行前に拒否されたコマンドの構造（Codex だけ。§2.5「Codex の実行前の拒否」）。server が委譲の結果に集める。`images` は結果の画像（Codex の画像生成と、`ply_computer` のスクリーンショット）。`computer` は `ply_computer` の印の行の中身（[computer-use.md](computer-use.md)「tool.start / tool.result」。3 つのバックエンドが印から作り、名前も `mcp__ply_computer__<ツール>` にそろえる） | `user` の `tool_result` |
| `activity` | `{ state: "thinking"\|"writing"\|"compacting"\|"waiting"\|"running"\|"preparing"\|"retrying"\|"idle", label?, retry? }`（preparing は送信の準備。CLI の起動・履歴の再生・設定の適用など、送る前に数秒かかるもの。retrying は上限・一時的な失敗のあと再試行を待っている。`retry: { attempt, next, message, reason, limit }`、next は次の再試行の epoch ms。人の応答待ちの waiting とは別。ADR 0229） | `system/status`, `session_state_changed` |
| `turnResult` | `{ outcome: "ok"\|"error"\|"aborted"\|"limited", turns?, costUsd?, error?, resetsAt? }`（costUsd はこのターンの分。aborted には server が中断の理由 `reason` を足す。バックエンドは出さない。limited は使用量の上限で止まった。resetsAt は解ける時刻の epoch ms で、分からなければ出さない。ADR 0229） | `result` |
| `permission` | `{ id, kind: "tool"\|"question", toolName, input, title?, canAlways, questions? }` | 既存 + AskUserQuestion の特別扱い |
| `auth` | `{ backend, phase: "url"\|"done"\|"error", url?, message? }` | 新規（ログイン誘導） |
| `session` | `{ sessionId, first?, model? }` | 既存 + モデル通知 |
| `background` | `{ tasks: [{ id, kind: "agent"\|"shell"\|"terminal"\|"other", label, waitable? }] }` 裏で生きているタスクの**全量**。受けたら丸ごと置き換える。`ambient` のタスクは含めない。`waitable: true` = 終わりの通知が必ず来るので待てる（下の kind の表） | Claude `system/background_tasks_changed`（保険に `task_started` / `task_updated` / `task_notification`）。Antigravity は ACTIVE のまま残った `run_command`（§2.8「裏へ回ったコマンド」） |
| `phase` | `{ state: "active"\|"waiting" }` `waiting` = main は返答を終えて止まっていて、かつ裏のタスクが 1 本以上生きている。それ以外は `active` | 新規（main の区切りと上の一覧から導く） |
| `userMessage.delivered` | `{ messageId }` 途中送信が**エージェントに渡った**（走っているターンの会話に入った）。`messageId` は outbox の item の id | 新規（2026-09。Claude の replay、Codex の `item/started`） |
| `userMessage.dropped` | `{ messageId }` 受理した途中送信を、エージェントが読まないままターンが死んだ。server は送信待ちの保留へ戻す | 新規（2026-09。ターンの終わりより後に届くことがある。受け口は server と web に残る。ACP の 2 つ（Devin・Grok）が、呼び出しが拒否・中断で決着した分に出す） |

`present` / `status` / `title` / `fork` / `mode` / `model` / `running` / `turnEnd` はそのまま。

バックエンドが出しても web へは流さないものに `hookRun`（Claude の hooks の開始・応答。server が会話の `hookRuns` に集める。docs/context-runtime.md「Hooks」）がある。

**`background` / `phase`（2026-09）**: どちらも変わったときだけ出る。ターンの中の裏（Claude: main がターンを保持したまま待つ）の印で、
`phase` を出さないバックエンド（Codex・Antigravity）はずっと `active` のまま扱う。server はターンごとに `phase` と `background` を持ち、`running` のターン行
（`{ kind: "turn", …, phase, background }`）に載せ、変わった時点で `running` を配り直す（4 秒ごとの定期便を待たない）。
web はこれを見て、一覧の行・畳んだ見出し・稼働表示の弧を衛星（design-system.md §6）に替える。
`waiting` の間もターンは終わっていない。同じ会話への送信は途中送信（`control.steer`）で届く。
次のターンの設定の予約（`nextSettings`。実行中に作業ディレクトリ・モデルなどのチップを変えると立つ）があっても、`waiting` の間は同じに途中送信する。
送信は今のターンの設定のまま処理され、予約は消さずに次のターンから効く（[ADR 0077](adr/0077-steer-before-reservation-while-waiting.md)）。
`core/message-queue.mjs` の `kick` は、予約があって main が動いている間（`active`）だけ、すぐ終わるのでターンの終わりを待つ（送信待ちの理由は `{ reason: 'turn', detail: 'reserved' }`）。

途中送信の口は `control.steer`（`core/backends/acp-steer.mjs` は ACP の 2 バックエンドの共通部品）。
ACP の `session/prompt` を走っているターンへ重ねると、**Devin は同じ回に折り込み**（実測 3000.11.92）、
**Grok は内蔵の待ち行列に積んで今の回の直後に続けて回す**（実測 1.0.62）。どちらも応答は回の決着まで返らないので、
「受理」は書き込みが直ぐに断られなかったこと、「渡らなかった」は呼び出しが拒否・中断で決着したこと。
Grok のように次の回として回る分は、runTurn が drain で決着まで待つ（待たずに畳むと接続の終了で全部 dropped になる）。
Antigravity は途中送信を持たない（送ると `reason: 'turn'` で送信待ちになる）。
`phase` が `waiting` に変わった時点で `core/server.mjs` が `kick` し直し、待っていた送信をすぐ流す。
終わらない裏のコマンド（headed のブラウザー・`npm run dev`）が残るターンで、予約があると裏を止めるまで送られなかった（2026-10-02 に実例）のはこれで直した。
届かない送信を切り分けるときは、`~/.agent-host/pleiad.db` の会話の `outbox`（受理の `at`。`session_fields` の行。`tests/lib/data-store.mjs` の `readSessions` で組み直して読める）と、Claude の transcript の
`queue-operation` の `enqueue`（CLI が受け取った時刻）を突き合わせる。enqueue が無ければ Pleiad の送信待ちで止まっている。
**ターンが終わった後も裏が残る**バックエンド（Codex）は、これではなく §2.7 の会話単位の background を使う。

**`kind` の語彙（2026-09）**: web が衛星に数えるかどうかがここで決まる（`behindOfTasks`）。

| kind | 何 | 衛星に数えるか |
|---|---|---|
| `agent` | サブエージェント（Claude `local_agent`） | 数える |
| `terminal` | ターンをまたいで生きる端末（Codex `unified_exec`） | **数えない**（ターンの終わった後の設備。会話末尾の「バックグラウンド N」から開く） |
| `shell` | 裏のシェル（Claude `local_bash`・Antigravity の裏へ回った `run_command`） | `waitable: true` のときだけ数える（Antigravity は付けない） |
| `other` | 上のどれでもない（ワークフロー・MCP タスクなど） | 数える |

`shell` の扱いは**終わりの合図があるかどうか**で分かれる（2026-09 に直した）。

- **Claude の `local_bash` は数える**。終わると必ず `system/task_notification`（と `background_tasks_changed`）が来て、
  CLI がそれで main を自動で再開させる。以前は数えずに入力を閉じていたが、**入力を閉じると CLI は数秒でそのコマンドを
  kill する**（`tasks/<id>.output` に `[killed]` だけが残り、「完了の通知が来たら報告します」が果たされない）。
  いまは `canCloseInput` が shell も待つので入力は開いたまま、完了通知で main が再開して報告できる。
  タスクには `waitable: true` を付けて出す。終わらないコマンド（`npm run dev`）の逃げ道はタイムアウトではなく
  作業ダイアログの**停止ボタン**（`stopBackground` → SDK の `Query.stopTask`）。委譲の子でも server は止めず、
  `phase: waiting` の間、依頼元へ裏作業通知を送る（agent-delegation.md「子に残った裏の作業」、ADR 0170）
- 見出し（`behindOfTasks` の `label`）は、全部 `agent` なら「サブエージェントを待っている」、
  全部 `shell` なら「バックグラウンドのコマンドを待っている」、混在なら「裏の作業を待っている」

**`running` の形（2026-09）**: `{ turns, permissions, subagents, background, tasks, scheduled, count }`。
`tasks` は委譲のタスクのうち終わっていないものと完了通知が届いていないものの短い行だけ（agent-delegation.md「保存・画面・再起動」）。
ターンの始まり・終わりなど変わった時点では必ず配り、4 秒ごとの定期便は前に配ったものと中身が同じなら送らない（2026-10-03）。
`background` は `[{ kind: "background", sessionId, backend, tasks, since }]`
（ターンの外で裏に残っている作業、§2.7）。`count` に `background` は入れない（下の理由）。
`subagents` の行は `{ id, kind: "subagent", sessionId, messages, description, saying, lastAt, status, startedAt, endedAt }`（2026-09-22 に後ろの 3 つを足した）。
`status` は `"running" | "completed" | "failed" | "stopped" | null`。`getSubagentState` を持たないバックエンド・分からない子は `null`。
`startedAt` / `endedAt` は ISO 文字列か `null`。終わった子もターンが終わるまでは一覧に残る（履歴化はしていない）。
`count` のサブエージェント分は **`status` が `"running"` か `null` の行だけ**を数える。終わった子を数えると更新のゲート
（web の `count > 0`）が閉じたままになる。`null` を数えるのは、状態を出さないバックエンドでゲートを緩めないため。
`turnEnd` は `{ completedAt, outcome, interrupted, requeued?, delegated? }`。`requeued: true` は完了ではない（§2.7 の requeue。`completedAt` は `null`）。
`interrupted` は中断で終わったターンなら `{ at, reason }`（`at` は `completedAt` と同じ）、それ以外は `null`（design.md「中断と再開」）。
`running` の `count` が 0 になるのを、更新とデスクトップの終了の「中断して…」が待つ（ADR 0036）。無停止の更新（ADR 0151。パッケージ版の既定）の切り替えも、新しい版のサーバーへ替える前に `count` が 0 になるのを待つ（`desktop/switch.cjs`。`!` の行・Codex の裏の端末・外部の stdio MCP・送信予定は `count` に入らず、待たない。`!` の行と Codex の裏の端末は「切り替えで止まるもの」として別に持ち、残っていれば「あとで／止めて切り替え」を聞く）。更新で main が入れ替わる間もサーバーとターンは止まらない（段階 1。ターンは作業が終わるまで古い版のサーバーで走る）。

Claude の判定は `core/backends/claude-background.mjs`（SDK 非依存、`tests/unit/claude-background.mjs`）。
実測（`output/bg-tasks/claude-report.md` §3、2026-09、SDK 0.3.258 / Claude Code 2.1.268）に沿う:
main の開始は 2 回目以降の `system/init` とトップレベルの `message_start`、停止は `message_delta.stop_reason` が
`tool_use` / `pause_turn` / null 以外のときと `result`。`result` だけに頼らないのは、裏が残っている間の
`result` が保留されうるため。

**Claude CLI の事実（2026-09、SDK 0.3.258 / Claude Code 2.1.268 で実測）**:

- Pleiad は 1 ターン = 1 回の `query()`。文字列のプロンプトや 1 件で終わる generator では、SDK は最初の `result` の直後に CLI の stdin を閉じる
- 入力が閉じた CLI は裏の subagent を `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`（既定 600000）までしか待たない。超えると stderr に
  `Background tasks still running after 600s; terminating…` を出し、subagent を殺して終わる（実際の会話で 600 秒ちょうどで殺された）。
  `0` は上限なし。上限は**入力が閉じているときだけ**効く（入力を開けたままなら 15 秒の上限でも 43 秒の subagent は殺されなかった）
- 待っている間、CLI は完了した subagent 1 本ごとに main を自動で再開する（`system/init` → 返答 → `result`）。2 つ目以降の `result` は保留されうる
- 入力を閉じると、裏の Bash は main の最後のターンから約 5 秒後に止められる。
  出力ファイル（`%TEMP%/claude/<project>/<session>/tasks/<id>.output`）には `[killed]` だけが残る
- 裏の Bash（`local_bash`）も終われば `system/task_notification` を出し、CLI はそれで main を自動で再開させる。
  subagent と同じ扱いでよい（2026-09 に確認）
- SDK の `env` は環境を**置き換える**（足し算ではない）。`process.env` を必ず広げる
- そこで Pleiad は入力を async generator で開けたままにし、main が止まっている・裏のタスクが 1 本も無い・流し込んだメッセージが残っていない、
  の 3 つが揃ったとき（と中断のとき）だけ閉じる。上限も `0` にして外し、CLI の stderr はサーバのコンソールへ出す
- **閉じた入力は開き直せない。まだ続くターンで閉じると host の口だけが黙って死ぬ**（2026-09 実測）。
  SDK MCP サーバ（`mcp__host__*`）の結果も `canUseTool` の返事も、ホストから CLI へは stdin で戻る。
  閉じた後の書き込みは SDK が黙って捨てる（`ProcessTransport: Dropping write to ended stdin stream`）ので、
  CLI 側は答えを待てず `The tool call was interrupted before a result was received` /
  `Tool permission request failed: AbortError: Stream closed` になる。CLI 内蔵のツールは stdin を使わないので動き続け、
  **fork / set_status / set_title と承認だけが落ちる**。SDK は最初の `result` まで閉じるのを遅らせる（`waitForFirstResult`）ため、
  事故は「`result` を 1 回見た後＝CLI が main を自動で再開しうる場面」に限られる
- そのため Pleiad は (1) host ツール・承認が走っている間は閉じない、(2) 裏の作業を一度でも見たターンでは、
  3 つが揃ってからさらに `RESUME_GRACE_MS`（5 秒）待ってから閉じる。main の自動再開は実測 0〜80ms だが、
  混んだセッション（agent teams・長い履歴）では 2.5 秒かかるのを観測した。ambient のタスクは一覧には出さないが
  「再開がありうる」印としては数える（ただし終わらないものがあるので、閉じる判定そのものは止めない）
- 開いた入力への途中送信（既定の priority = `next`）: main が作業中なら**次のツール結果の区切り**で同じターンに折り込まれ、
  そのターンの中で答える。承認を待っている間に流した分も、承認が返った区切りで同じターンに入る。
  main が止まっていれば（裏の subagent が走っていても）止まっていること自体が区切りになり、約 1.6 秒で折り込まれてすぐ答える
  （`priority: "later"` と同じ速さ。実測 2026-09、CLI 2.1.273）。どの場面でも遅れないので、Pleiad は場面で出し分けず常に `next` で流す
- 折り込まれた瞬間はストリームに合図が無い。`--replay-user-messages`（`extraArgs`）を付けると、折り込みと同時に
  `{ type:'user', isReplay:true, message:{ role:'user', content:'<文字列>' } }` が流れる。流れるのは最初のプロンプトと
  自分が流し込んだ分だけで、CLI 内部の通知（task-notification など）は replay されない。Pleiad は流し込むフレームに毎回新しい
  `uuid` を付け、replay の `uuid` で突き合わせて `userMessage.delivered` を出す（画面の「まだ渡っていない」はこれで消える）。
  区切りが来ないまま内部ターンが終わると、CLI は溜まった分を**まとめて**次の内部ターンとして取り出し、本文を `
` でつないだ
  replay を最後のメンバーの `uuid` で 1 本出す（メンバーごとの replay は `uuid` 付きのフレームにだけ出る。実測 2026-09-23、CLI 2.1.280）。
  答えは同じ Pleiad ターンの中で流れる。本文だけで照合していたころはこれを取りこぼし、答えが返っても「渡します」が残った。
  保険として本文の一致・つないだ本文の分解でも拾い、それでも残った分は `result` の後の `system/init`（次の内部ターン）で渡ったことにする
- 折り込まれた発言は transcript に `attachment`（`{ type:'queued_command', prompt, commandMode:'prompt' }`）として残り、
  古い CLI・SDK の `getSessionMessages` は返さない（`includeSystemMessages` でも返さない）。新しいもの（2026-10、SDK 0.3.288）は user エントリとして返し、
  その uuid が attachment の `uuid` か `source_uuid`（流し込んだ user メッセージの uuid）に当たる。`timestamp` は流し込んだ時刻で直前の行より古く、
  時刻では並べ直せない。Pleiad は `parentUuid` の鎖を遡って `getSessionMessages` に出ている最初の祖先を探し、その直後へ差し戻す
  （`claude-normalize.mjs` の `mergeQueuedCommands`。返っている分は足さない）。区切りが来ないままターンが終わった分は待ち行列から外れ、
  普通の user 行として残って次のターンで答えられる（両方に残る形は観測していない＝二重にならない）
- 入力を閉じた後も、CLI は stdin で受け取り済みのメッセージを処理してから終わる。閉じる判定で「取りかかった」と早めに数えても取りこぼさない
- 中断は `Query.interrupt({ cancelQueued: true })`（Esc と同じ。d.ts の型に引数は無いが SDK 0.3.258 の実装は受ける）。stdin を閉じるだけでは
  CLI は今の仕事と待ち行列を片付けてから終わり、Windows の SDK は abort から 2 秒 + 5 秒後に claude.exe を kill するまで動き続けていた
  （2026-09-23 調査）。そのため SDK には server の AbortController を渡さず、自前のものを渡す（渡すと中断の瞬間に stdin が閉じ、
  interrupt を書けない）。interrupt の応答か `result` が 2.5 秒のうちに来なければ、入力を閉じて SDK の abort に落とす。受領の後は入力を閉じ、
  3 秒のうちに終わらなければ同じく落とす。結果はどちらでも `turnResult aborted`。応答の `cancelled` にある `uuid`（折り込まれる前に取り消された
  途中送信）は `userMessage.dropped` にする。プロセスツリーごとの強制終了はしない（pid は `spawnClaudeCodeProcess` で自前に起動したときしか取れない）
- `result` は 1 回の query で何度も出る。`total_cost_usd` と `modelUsage` は累計で単調に増える（上書きで二重計上にならない）。
  CLI 2.1.280 以降は resume で transcript の最後の `cost-state` を読み戻すので、累計は query ではなく会話の始まりから数える。
  そのため query を作る前に最後の `cost-state` を開始時点として読み、`usage` はそこからの差分にする（`claude-cost-state.mjs`、[ADR 0052](adr/0052-claude-usage-delta.md)）
  turnResult は「ターンが終わった」の合図なので、Claude は成功の turnResult を query の終わりに 1 回だけ出す
  （途中で出すと server がターンを終わりかけと見なし、途中送信を止める）
- 裏の subagent の完了通知は、main を再開させるための user メッセージ（`<task-notification>…`、`origin.kind: task-notification`）として
  transcript に残る。`getSessionMessages` は `origin` を落とすので、履歴では中身で見分けて発言にしない

**`session` の `first`**: 「このターンで id が確定した」ときにだけ `true` を付ける。
新規セッションの 1 本目と、再開したつもりの id が変わったときだけ。
モデルが分かっただけの 2 本目や、再開ターンが形を揃えるために出す 1 本には**付けない**。
web の `isMine` は新規セッションの id を `first` の付いた session からしか採用しない
（付いていないものまで採ると、別タブが新規の id を待っている最中に
再開ターンの id を掴んで、自分が始めた会話が行き先を失う）。`model` の有無では判別できない
（新規でも init が最初に来れば id とモデルが同時に確定する）。

v3 で `statusIcon { status, icon }`（状態グループのアイコン。sidecar `statuses.json`）、`lineage`、`setStatusIcon`、runTurn の `status`、`text.end` の `uuid` を足した。`PROTOCOL_VERSION` は **3**。
その後、番号を据え置いたまま `loadSession` の `watch` と `watchSession` を足した。宣言した接続には、流れの出来事を開いている会話の分だけ送る（[ADR 0024](adr/0024-watch-open-session-stream.md)）。
さらに `loadSession` に `from`・`check`・`presentFrom`・`presentCheck` を足した。持っている履歴の先頭が合うときだけ続きを返し、合わなければ全量（[ADR 0062](adr/0062-incremental-session-load.md)）。

**`permission.kind === "question"` の `questions` の形**（web の questionCard が読む形。Claude の AskUserQuestion 入力をそのまま正規形にする）:

```jsonc
questions: [{ question, header?, multiSelect?, options: [{ label, description?, preview? }] }]
```

回答は `resolvePermission { id, allow: true, answers: { [question]: "a, b" }, annotations? }`。
バックエンドが自分の形（Codex なら `item/tool/requestUserInput` の response）へ戻す。

### 2.3 `AgentBackend` インターフェース

`core/backends/<id>.mjs` が 1 つずつ export する。`core/backends/index.mjs` がレジストリで、どの id があるかはエージェントの記述
（`core/backends/agents.mjs`。下の「エージェントを足す」）から作る。

能力の印（`capabilities`）の正本は `core/backends/contract.mjs` の `CAPABILITIES`。**バックエンドは全部のキーに値を書く**
（対応しないものは `false` などで明示する。書いていないことを「対応しない」の代わりにしない）。値の形と、値ごとに要るメソッド
（`fork: true` なら `fork()` など）もそこに書いてあり、`npm test` の backend-contract が確かめる。今の値の一覧は自動で作る
[backend-matrix.md](backend-matrix.md)。id で分けたくなったら、id を比べずに印を足す（下の「id で分けない」）。

```js
export const backend = {
  id: "claude",              // core/backends/agents.mjs のキーと同じ
  label: "Claude Code",
  capabilities: { ... },     // core/backends/contract.mjs の CAPABILITIES の全部のキー

  // ---- 語彙（UI はこれを <select> に流し込むだけ。値の意味は知らない）
  modes(): { [id]: { label, note } },          // 承認モード。id はバックエンドごとに違ってよい
  models(): Promise<{ [id]: { label, note } }>,// "" は「既定に従う」

  // ---- 実行
  runTurn({ prompt, sessionId, cwd, mode, model, emit, askPermission, signal, control })
    : Promise<{ sessionId }>,   // 新規なら確定した id を返す。途中で `session` イベントも出す
                                // 新規に最初から付ける状態（web の runTurn args.status）は server が session イベントで書く。バックエンドは知らない
                                // notes?: string[] … 中断の後に Pleiad が添える文（design.md「中断と再開」）。発言の本文は変えず、前に置く:
                                //   Claude は同じ user メッセージの別の text ブロック、Codex は turn/start の別の入力、agy は本文の前につなぐ
  abort?(handle),                // signal で足りるなら省略
  setModelLive?(handle, model): Promise<boolean>,
  setModeLive?(handle, mode): Promise<boolean>,

  // ---- セッション管理
  listSessions({ limit }): Promise<Array<{ sessionId, title, cwd, createdAt, lastModified, tag?, parent? }>>,
  getSession(id): Promise<{ sessionId, title, cwd, createdAt, lastModified, tag? } | null>,
  getMessages(id): Promise<NormalizedMessage[]>,   // history.mjs の messages と同じ形
  setTitle?(id, title): Promise<void>,
  setTag?(id, tag | null): Promise<void>,
  fork?(id, { upToMessageId?, title? }): Promise<{ sessionId }>,
  listSubagents?(id): Promise<string[]>,
  getSubagentMessages?(id, agentId, { limit }): Promise<NormalizedMessage[]>,
  getSubagentOrigin?(id, agentId): Promise<string | null>,  // 生んだ委譲ツールの tool_use id。実行中一覧の見出しを引く
  getSubagentState?(id, agentId): Promise<{            // 2026-09-22。実行中一覧の状態の印（design-system.md §2.2）
    status: "running" | "completed" | "failed" | "stopped",
    startedAt: string | null, endedAt: string | null,   // ISO 文字列
  } | null>,                                            // null は「分からない」。describeBackends の capabilities.subagentState
  suggestTitle?({ transcript }): Promise<string>,  // 小さいモデルで 1 発

  // ---- 認証
  auth?: {
    status(): Promise<{ loggedIn: bool, account?: string, detail?: string }>,
    login({ emit }): Promise<void>,   // emit({type:"auth", phase:"url", url}) で URL を出し、完了まで待つ
    logout(): Promise<void>,
    submitCode?(input): Promise<void>, // コールバックが取れないときの手貼り（今これを持つバックエンドは無い）
  },

  // ---- 表示ヒント（web/render.mjs の TOOL_LABEL を補う）
  toolHints?: { [toolName]: { label, shape: "shell"|"read"|"write"|"edit"|"search"|"delegate"|"web"|"generic" } },
};
```

`askPermission(req) → Promise<{ allow, always?, message?, answers?, annotations? }>` の形は現状のまま。
承認の保留・猶予・中断（design.md §8.5）は `server.mjs` に残し、**バックエンドは触らない**。

`getSubagentState` は 4 秒ごとの `runningWork()` から呼ばれる。**重い I/O をしない**こと。Claude は
そのターンで流れている SDK メッセージだけで答える（`claude-background.mjs` の `createTurnTracker` が
`task_started` / `task_updated` の `patch.status`・`patch.end_time` / `task_notification` の `status` を記録し、
task_id = agentId で引く。SDK の語彙は completed→completed、failed→failed、killed・stopped→stopped、
pending・running・paused→running）。前面で待った子で task 系の終わりが来ない場合に備え、委譲ツールの
`tool_use_result`（`sdk-tools.d.ts` の `AgentOutput`）の `status: "completed"` でも完了とみなす。
裏に回した子の結果は起動直後に `status: "async_launched"`（本文は "Async agent launched successfully."）が来るので完了にしない。
親 transcript は読まない（走っている間は mtime が毎回変わり、最悪 9MB を 4 秒ごとに読み直すことになる）。
`core/conversations.mjs` が Pleiad の会話 id をネイティブ id に訳して渡し、合成会話では `null` を返す。

`NormalizedMessage` は `history.mjs` が既に返している
`{ role, text, uuid, at, thinking?, toolCalls?: [{ id, name, input, result }] }`。
assistant の発言に `stopHookFollowUp: true` を付けてよい（2026-09-27）。Stop フックに止められて main が続けた分のうち、中身の仕事をしていない発言の印で、
委譲の結果を選ぶときに飛ばす（agent-delegation.md「子の結果」）。何を続きとみなし、何を中身の仕事とするかはバックエンドが決める。
今は Claude だけが付ける（`claude-normalize.mjs` の `stopHookFollowUps`。getSessionMessages に出ない `stop_hook_summary` の行を transcript から読む）。
付けないバックエンドでは、結果は今までどおり最後の返答になる。

人が書いていないのに user の行として残るもの（システム側のメッセージ）は、`kind` を付けた形に置き換えるか落とす（2026-09-28、[ADR 0053](adr/0053-system-messages-display.md)）。
置き換えるのは `core/system-messages.mjs` の `classifySystemMessages`（SDK を import しない純粋な関数。`kind` の付いた発言は触らないので、何度かけてもよい）:

| kind | 形 | 元の行 |
|---|---|---|
| `command` | `{ role:'user', text, command, output }` | スラッシュコマンドの行（`<command-name>`）と、続く出力（`<local-command-stdout>`／`-stderr`） |
| `shell` | `{ role:'user', text, command, stdout, stderr }` | `!` モードの入力（`<bash-input>`）と出力（`<bash-stdout>`／`<bash-stderr>`）。終了コードは無い |
| `compactSummary` | `{ role:'system', text:'', summary, boundary }` | 圧縮の要約。`history.mjs` が発言から外して `compactSummaries` で返し、server が区切りに入れる（`compaction-history.mjs` の `attachCompactSummaries`） |
| `interrupt` | `{ role:'system', text:'' }` | 中断（`[Request interrupted by user]`・`… for tool use]`） |
| `teammate` | `{ role:'system', text:'', from, body }` | agent teams の teammate の知らせ。待機（`idle_notification`）だけのものは落とす |
| `interruptionNote` | `{ role:'system', text:'', body }` | 中断で止めたものを Pleiad が伝えた文（行の先頭の `<pleiad-interruption>…</pleiad-interruption>`）。続く人の発言は別の行に分ける（分岐点の uuid は発言に残す）。どのバックエンドの行も `history.mjs` の `loadTranscript` で分ける（`splitInterruptionNotes`） |

コマンド・シェルの出力は入力の行へまとめ、`uuid` は出力の行のもの（分岐点）にする。Pleiad の `/compact` の行とその出力・裏の作業の完了通知・文脈だけの発言は落とし、発言の先頭の文脈（`<ide_opened_file>`・`<in-app-browser-context>`）は外す。
見分けは行の形を優先する。Claude は transcript の本文から印（`claude-normalize.mjs` の `transcriptSystemMarks`: 要約の uuid と区切りの uuid、コマンド・シェルの行の子の出力の uuid）を拾って渡す。getSessionMessages は `isCompactSummary`・`parentUuid` を落とすため。
印が無いとき（transcript を読めない・切り替え済みの会話の保存分。`conversations.mjs` が読むたびにかける）は文面（行の先頭のタグ・固定の中断の文字列・要約の定型の書き出し）で見分ける。Codex は `<in-app-browser-context>` を外すだけ。

Claude の `getCompactions` は、区切りを transcript の `system:compact_boundary` の行（`compactMetadata` の trigger・preTokens・postTokens）から読む。SDK 0.3.258 の `getSessionMessages({ includeSystemMessages: true })` は system 行を `message: null` で返すため。transcript を読めないときだけ SDK の行から読む。

#### シェルの行（入力欄の `!`、2026-09-28）

入力欄の `!` で人が走らせるコマンド（[ADR 0054](adr/0054-shell-from-composer.md)、形は design-system.md「入力欄のシェルの形」）。承認モードは掛けず、送信待ち（outbox）にも送り直しの控え（receipts）にも積まない。管理は `core/shell-runs.mjs`。

- 口: コマンド `runShell { sessionId, runId, command, cwd? }` → `{ runId, duplicate? }`（走り出したら返す。同じ `runId` は 2 度走らせない。`cwd` はまだ送っていない会話だけ使い、送信済みなら会話の作業ディレクトリ）、`stopShell { runId }` → `{ stopped }`、`skipShell { sessionId, runId, skip }` → `{ runId, skip }`（行ごとの「渡さない」。`'host'` の会話だけ。[ADR 0055](adr/0055-shell-skip-handoff.md)）
- 出来事（全部の接続へ。一覧は変わらない）: `shell.start { runId, command, cwd, at, backend, mode }`・`shell.output { runId, stream: 'stdout'|'stderr', text }`・`shell.done { runId, exitCode, durationMs, truncated, timedOut, stopped, timeoutMs?, error?, stdout? }`（`stdout` はエージェントが走らせた分の出力全体）・`shell.skip { runId, skip }`（「渡さない」を切り替えた）・`shell.handed { runIds, keptIds? }`（次の発言がエージェントに渡った。`keptIds` は渡さなかった行）
- `loadSession` は発言の末尾に、まだ渡していない行（`pending: true`。「渡さない」なら `skip: true`）と走っている行（`running: true`）を `{ role:'user', kind:'shell', command, stdout, stderr, exitCode, runId }` で足す。渡さなかった行（`kept: true`）は、走らせた時刻より後の最初の人の発言の前に差す（後に無ければ末尾）。履歴の `!` の行には、Pleiad が走らせたときの終了コードを付ける
- **渡さない**（`'host'` の会話だけ）: 走っている間は走っている分の印、終わった後は `shellPending` の行の `skip: true`。次の人の発言のターンでは `shellAppends` から外し、渡った合図で `shellPending` から sessions.json の `shellKept` へ移す（会話ごとに新しい 20 件まで、出力は stdout・stderr それぞれ先頭 32KB まで。越えたら `truncated`）。エージェントを切り替えて `shellPending` を捨てるときも、「渡さない」の行は `shellKept` へ移す。渡しかけている間（ターンの始めに `shellAppends` を決めてから渡った合図まで）と渡した後の切り替えは断る（`SHELL_HANDING`・`SHELL_HANDED`）。`'native'`（Codex）は結果がエージェントの会話に入っていて外せないので断る（`SHELL_UNAVAILABLE`）
- バックエンドの宣言は `capabilities.shell`:

| | 走らせる所 | 渡し方 | 履歴 |
|---|---|---|---|
| `'host'`（Claude・fake） | Pleiad がホストのシェル（`core/host-shell.mjs`。`AGENT_HOST_SHELL`、無ければ Windows は Git Bash → PowerShell、ほかは `$SHELL` → `/bin/sh`）。標準入力は閉じ、上限 10 分（`AGENT_HOST_SHELL_TIMEOUT_MS`）で木ごと止める。出力は stdout・stderr それぞれ 256KB まで | 結果を sessions.json の `shellPending` に貯め、次の人の発言のターンで `runTurn` の `shellAppends` に CLI の `!` と同じ 2 行（`<bash-input>`・`<bash-stdout>…<bash-stderr>`）を渡す。Claude は `shouldQuery: false` の user 行としてプロンプトの前に流す（返答を起こさずに transcript へ積み、プロンプトと合わせて渡る）。渡った合図（`onPromptDelivered`）で `shellPending` から外し、終了コードを `shellExits`（出力の鍵 → 終了コード、200 件まで）に控える | SDK は積んだ行を `\n` でつないだ 1 つの user 行として transcript に残す（CLI の `!` は 2 行。2026-09-28 に本物で確認）。`core/system-messages.mjs` がどちらも入力と出力の組ごとに `kind: 'shell'` の行にし（つないだ行の分岐点の uuid は最後の組だけ）、`shellExits` で終了コードを付ける |
| `'native'`（Codex） | `backend.shell({ sessionId, command, cwd, timeoutMs, signal, onOutput })`。app-server の `thread/shellCommand { threadId, command, timeoutMs }`（応答は `{}`、サンドボックスの外）。スレッドが読み込まれていなければ `thread/resume` し、終わったら `thread/unsubscribe`。Codex は 1 回ごとに turn/started・completed で包み、Windows では PowerShell で走らせる。止めるのは item の turnId への `turn/interrupt`（item は `exitCode: -1`・`"command aborted by user"` で閉じるので、終了コードにせず `stopped` にする）。**ターンの間は走らせない**: Codex は `!` のターンの間に来た `turn/start` の発言を同じターンに入れ、モデルを呼ばずに閉じる（2026-09-28 に本物で確認）。そのため、ターン（始める準備の間も）が走っていれば `runShell` を断り（`SHELL_BUSY`）、`!` が走っていれば次のターンは終わるまで待ってから始める（`shellRuns.settled`） | Codex の会話に残るので何もしない。次の人の発言のターンが渡ったら `shell.handed` だけ出す | `source: userShell` の `commandExecution` を `kind: 'shell'`（`stdout` は `aggregatedOutput`、`stderr` は null、`exitCode`）にし、エージェントのツールのカードにしない（ターンの通知でも拾わない）。`command` はシェルに包んで POSIX 式にクォートした形（`"…\powershell.exe" -Command '…'`）なので、人が打った形に戻す。最後の人の発言より後の行は `pending` |
| 無し（Antigravity） | 使えない（`runShell` は断る） | — | — |

- 完了通知で再開するターン・圧縮のターン・走っているターンへの途中送信では渡さない。エージェントを切り替えたら（予約した設定の適用も）走っている分を止め、替えた先も `'host'` なら `shellPending` を次のターンで渡し、そうでなければ捨てる（「渡さない」の行は `shellKept` に残す。`shellRuns.switched`）。予約で替わる先が `'host'` どうしでなければ `runShell` は断る。未送信の会話の削除・サーバーの終わりでも止める
- シェルが終わっても、裏で起こしたプロセスが出力のパイプを握ったまま残ることがある（PowerShell の `Start-Process -RedirectStandardOutput` で起こしたサーバーなど）。`close` を待ち続けないよう、シェルが終わったら 2 秒（`EXIT_CLOSE_GRACE_MS`）待って締め、終了コードと `leftover: true` を返す

#### Pleiad のシェルのツール（ply_shell、2026-10-18）

エージェントがホストでシェルのコマンドを走らせる Pleiad の MCP（`/mcp/shell`、`core/shell-bridge.mjs`。[ADR 0227](adr/0227-ply-shell-and-command-notices.md)）。会話ごとの Bearer で会話に束縛する（骨格は `core/mcp-bridge.mjs`、無停止の更新の付け直しは `restoreConnection` の `shell`）。

- ツール: `run`（終わるまで待つ。上限は既定 2 分・最大 10 分）・`start`（裏で始めてすぐジョブの id を返す）・`output`（`since` から続きを読む）・`stop`（子のプロセスごと止める）・`list`。走らせる口は `core/host-shell.mjs`。`shell` 引数で `default`・`bash`・`powershell`・`cmd`（Windows だけ）を選ぶ。コマンドには会話のシェルの環境変数（エージェントの Chrome・`PLEIAD_CONTROL_*`・秘密情報と変数）を渡す
- 承認: 読み取りだけのモード（scope が `none`・`readonly`）は断る。確認なし（autonomy が `never`）のほかは、走らせる前に会話へ承認のカードを出す。エージェント側では聞かない（Claude は `decidePermission` で通し、OpenCode は `ply_shell_*` を allow、Codex は `default_tools_approval_mode: approve`）
- ジョブの出力はメモリだけ（256 KB。古い方から捨て、捨てた分を数える）。会話ごとの同時の `start` は 8 まで。`start` のジョブは会話の裏の一覧（`running` の `background`、`kind: 'shell'`、`backend: 'ply_shell'`）に出て、`sessions.stopBackground` で止められる。人が止めた・自分で終わった `start` のジョブは、その会話へ知らせる（`shell.jobDone`）。サーバーの終わり・会話の削除・巻き戻しで止める（保持役には載せない）
- 受け取るかは能力の印 `plyShell`（Claude・Codex・OpenCode・fake）。Antigravity は MCP を Pleiad のカスタムエージェントでしか渡せず、Devin は ply_shell をまだ受けていないので、渡していない（ply_browser・ply_control は ACP の `session/new` の `mcpServers` で渡す）
- **エージェントのシェルを切る**: 設定 `shellTool`（`{ <エージェントの id>: 'native' | 'ply' }`。無ければエージェントの記述の `shellDefault`。OpenCode だけ `'ply'`）が `'ply'` で、能力の印 `nativeShellOff` を持つエージェントは、`runArgs.shellRuntime.nativeOff` でエージェントのシェルのツールを切る。Claude は `disallowedTools` に `Bash`・`PowerShell`、OpenCode は会話の権限で `bash` を全面拒否（一覧から外れる。規則の印 `+noshell`）。切った会話にだけ使い方の指示（`shell.instructions`。「指示の量」の内訳 `shell`）を足す
- シェルのツールの名前（長いコマンドの知らせ・声の待ちの案内が見分ける）は、エージェントの記述の `shellTools`（`core/shell-tools.mjs`。toolHints の `shape: 'shell'` と同じ名前）。名前で見分けられない呼び出し（ACP の自由な題）は `tool.start` の `shell: true`

### 2.4 sidecar の拡張

`~/.agent-host/pleiad.db` の会話の記録（Entry）に足す: `backend`, `title`, `status`, `cwd`, `createdAt`, `lastModified`。
`title` / `status` は capabilities に応じて「ミラー」か「正本」かが変わるが、**書き込みは常に両方**。
読み出し規則: どちらも「持てる方が正本、無ければもう片方へ落ちる」で揃える。
`capabilities.title ? (native.title ?? sidecar.title) : (sidecar.title ?? native.title)`、
`capabilities.tag ? native.tag : sidecar.status`。
`capabilities.title` / `capabilities.tag` は `describeBackends` が `setTitle` / `setTag` の実在と AND する
（書き口の無い宣言は「持てない」と同じ）。

sidecar 側の `setMode` / `setModel` は `exclusive()` を通す（既存の read-modify-write 交錯を直す）。

### 2.5 バックエンド別の対応表

| | Claude | Codex |
|---|---|---|
| プロセス | in-process SDK | `codex app-server`（stdio JSON-RPC 2.0、**1 プロセスを全セッションで共有**、threadId で多重化、落ちたら再起動） |
| 新規 | `query({prompt})` | `thread/start {cwd, model, approvalPolicy, sandbox}` → `turn/start` |
| 再開 | `resume` | `thread/resume {threadId}` → `turn/start` |
| 本文 | `text_delta` | `item/agentMessage/delta` |
| 思考 | `thinking_delta` | `item/reasoning/summaryTextDelta` |
| ツール | `tool_use` / `tool_result` | `item/started` / `item/completed`（`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch` …）+ `item/commandExecution/outputDelta` |
| 承認 | `canUseTool` | server request `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` → response で返す |
| 質問 | `AskUserQuestion` | `item/tool/requestUserInput` |
| 中断 | `Query.interrupt({ cancelQueued })`（応答が無ければ AbortController） | `turn/interrupt` |
| 完了 | `result` | `turn/completed` |
| 一覧 | `listSessions` | `thread/list`（name, cwd, createdAt, updatedAt, forkedFromId） |
| 履歴 | `getSessionMessages` | `thread/read {includeTurns:true}` |
| タイトル | `renameSession` | `thread/name/set` |
| 状態タグ | `tagSession` | 無し → sidecar |
| fork | `forkSession` | `thread/fork` |
| モード | `default/auto/acceptEdits/plan/bypass`（`bypass` は SDK の `bypassPermissions`。`allowDangerouslySkipPermissions: true` を同時に渡す） | `approvalPolicy` × `sandbox` の組を id 化: `ask`(untrusted/workspace-write) / `auto`(on-request/workspace-write) / `full`(never/workspace-write) / `yolo`(never/danger-full-access) / `readonly`(on-request/read-only)。各 turn/start にも承認と sandbox の設定を送る。`full`・`yolo` でも Codex 自身の安全判定で実行前に拒否されるコマンドがある（下の「Codex の実行前の拒否」） |
| モデル | fable/opus/sonnet/haiku（SDK のエイリアス。実 ID への解決は SDK） | `model/list` |
| host ツール | in-process MCP。可視化は共通参照 | 可視化は共通参照（§2.6） |
| 認証 | Claude Code のログイン | `account/read` / `account/login/start {type:"chatgpt"}` → `authUrl` → `account/login/completed` / `account/logout`。**`~/.codex/auth.json` は codex が書く** |

#### 承認モードの2軸

モード名はバックエンドごとに違って比べられないので、各 `modes()` は**軸の値**も一緒に返す。
強さの比較と委譲の規則は `core/modes.mjs` にまとめてあり、エージェントを足すときに触るのは
そのバックエンドの `MODES` だけで済む（`docs/agent-delegation.md` の「会話・権限・作業場所」）。

- **範囲 (`scope`)**: どこまで触れるか。`none` < `readonly` < `workspace` < `full`
- **自律 (`autonomy`)**: 人にどれだけ聞くか。`ask` < `judge` < `never`
- **強制 (`enforced`)**: その範囲を sandbox 等で機械的に強制できるか。できないなら「約束」にすぎない

| バックエンド | モード | 範囲 | 自律 | 強制 |
|---|---|---|---|---|
| Claude | `default` | workspace | ask | – |
| Claude | `auto` | workspace | judge | – |
| Claude | `acceptEdits` | workspace | judge | – |
| Claude | `plan` | none | ask | – |
| Claude | `bypass` | full | never | – |
| Codex | `ask` | workspace | ask | ✓ |
| Codex | `auto` | workspace | judge | ✓ |
| Codex | `full` | workspace | never | ✓ |
| Codex | `yolo` | full | never | – |
| Codex | `readonly` | readonly | judge | ✓ |
| Antigravity | `yolo` | full | never | – |

強制できるのは sandbox を持つ Codex だけ。Claude・Antigravity の範囲は宣言であり、
超えたことを機械的に止める手段が無い。委譲の規則はこの違いを見て「聞くかどうか」を変える。

Codex の app-server プロトコルは `codex app-server generate-json-schema --out <dir>` で得られる
（`temporary/codex-schema/`、追跡外）。`ClientRequest` / `ServerRequest` / `ServerNotification` の `method` を正とする。

**Codex の実装で分かった、この表からの実際のずれ**（codex-cli 0.153.2 で確認）:

- `AskForApproval` に **`on-failure` は無い**（`untrusted` / `on-request` / `never` / `granular` の4つ）。
  上の表の auto を `on-failure` としていたのは古い。聞く回数の順が保たれるよう
  `ask`=untrusted / `auto`=on-request / `full`=never / `readonly`=on-request+read-only に割り当てた。
- **`Thread` / `Turn` の時刻は「秒」**。スキーマは `int64` としか言わないので ms と読めてしまうが、
  そのまま使うと一覧が全部 1970 年になる（実機で確認）。`startedAtMs` のように名前に `Ms` が付くものだけミリ秒。
- 承認の応答は**種類ごとに形が違う**。`item/commandExecution` と `item/fileChange` は `decision`
  （`accept` / `acceptForSession` / `decline` / `cancel`）だが、
  **`item/permissions/requestApproval` は `decision` を持たず** `{ permissions, scope: "turn"|"session" }` を返す。
- `item/fileChange/requestApproval` の params は `itemId` しか運ばない。何を許すのかを承認カードに出すには、
  先行する `item/started` で見た item を覚えておく必要がある。
- `account/login/completed` 通知は **`threadId` を持たない**。スレッドへの振り分けでは拾えない。
- **サブエージェント（multi_agent。版はモデルごとに決まり、gpt-6-astra は v2）は子スレッドで動き、承認と質問は子の `threadId` で来る**
  （`item/*/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`）。`codex-rpc` は
  `thread/started`（`parentThreadId`、`source.subAgent.thread_spawn.parent_thread_id`）、`collabAgentToolCall`（spawnAgent の
  `receiverThreadIds`）、`subAgentActivity`（`agentThreadId`）から子 → 親を覚え、孫もたどって、attach 済みの親の会話へ回す。
  承認カードの `title` に「サブエージェント <agent_path から `/root/` を外したもの>」を添える。親が外れていれば（ターン終了後）
  今までどおりエラーを返す。子の通知（本文・ツール・turn）は親の本文やツールとして出さない。承認カードに載せるアイテムだけ覚える。
  子の通知が親と同じ接続に流れることは、スキーマからの推定で、実機ではまだ確かめていない。
- **サブエージェント一覧（実行中一覧・子の会話ダイアログ）に載せる**（2026-09、`capabilities.subagents: true`）。
  - `listSubagents(threadId)` = `thread/list { parentThreadId, limit: 100 }` の子と、実行時に覚えた子（`rpc.parents`、
    親の `subAgentActivity` / `collabAgentToolCall`）の**和**。前者は app-server の永続化の間合いに、後者は子の通知が
    この接続に流れるかに依存するので、どちらにも寄りかからない。**返ってきた行は `parentThreadId` で絞り直す**
    （このパラメータを知らない版は黙って無視して普通の一覧を返しうる）。行が `parentThreadId` を持たない・パラメータを撥ねられた
    版では以後 `thread/list` を使わず、実行時に覚えた子だけに落ちる。`sourceKinds` は不要（`parentThreadId` だけで子が返る）。
    既定の `thread/list`（左の一覧）には子は出ない。
  - `getSubagentMessages` = `thread/read { threadId: 子, includeTurns: true }` → `threadToMessages`。子であること
    （`parentThreadId` / `thread_spawn.parent_thread_id`、無ければ実行時に覚えた親）を確かめてから返す。`agentId` は形も確かめる。
    `limit` を超えたら先頭と末尾を残す（Claude と同じ）。子には `userMessage` が無い（依頼文は親から注入されて item にならない）。
  - `getSubagentOrigin` = 親の `subAgentActivity(kind=started, agentThreadId)` の `id`（= spawn の function call id `call_…`）、
    無ければ spawnAgent の `collabAgentToolCall` の `id`。どちらも `tool.start` の `event.id` と同じ item id。
  - `getSubagentState` = `subAgentActivity.kind`（started → running、completed → completed、interrupted → stopped。interacted は届けただけなので状態を変えない）と
    `collabAgentToolCall.agentsStates`（pendingInit/running → running、completed、errored → failed、shutdown/interrupted → stopped、
    notFound は分からない）。後から来たものが勝つ。終わった子が再び走るのは、子のターンが始まったとき（`turn/started` を子の
    thread で見たとき。`send_message` の `trigger_turn: true` など）と、collab の sendInput・followupTask が running を返したとき。
    `trigger_turn: false` の送信（interacted・sendMessage が completed を返す）では終わった子は completed のまま。
    時刻は実行時なら通知の `startedAtMs` / `completedAtMs`、履歴なら子の Thread の
    `createdAt` / `updatedAt`（無ければ親のターンの時刻）。
  - server は 4 秒ごとに全部を呼ぶ。一覧は 2 秒、親の items（origin / 状態を通知で見ていない子のため）は 10 秒覚える。
    親が native の接続で走っている間の状態は通知だけで答える。終わった子の本文は `updatedAt` が変わらなければ読み直さない。
    `useStateDbOnly` は付けない（走っている子が state DB に入る間合いが未確認。実機 0.153.2・rollout 875 本の環境で、
    付けなくても `thread/list { parentThreadId }` は 1〜2ms で返った）。
  - 委譲カード: `subAgentActivity` / `collabAgentToolCall` を `{ label: "委譲", shape: "delegate" }` で描く（`subagentTools` も同じ 2 つ）。
    `description` は `agent_path` から `/root/` を外したもの（started 以外は「（完了）」などを添える）。
    `collabAgentToolCall` は `prompt` / `model` も渡す（spawn の開始時は `receiverThreadIds` が空なので、見出しは prompt の 1 行目）。
- **thread/start の応答待ちの間は、見知らぬ `threadId` の frame を預かる。** 応答の id と一致したものだけを、届いた順に新しいセッションへ渡す（`adopt`）。
  残りは捨て、request にはエラーを返す。`threadId` を持たない通知は受け皿に渡さない。

#### Codex の実行前の拒否（2026-09、issue #24）

**`yolo`（never / danger-full-access）でも、Codex は組み込みの危険コマンドの判定で一部のコマンドをプロセスを作る前に拒否する**
（codex-cli 0.156.1 で確認。理由は `blocked by policy` など。削除に限らず `Stop-Process`・`Start-Process`・`New-Item` なども）。
拒否は承認に回らず、`item/started`・`item/completed` のアイテムを作らない。`error` 通知にもならず、ターンは `completed` で終わる。
`thread/read` にも残らない。モデルへのツールの出力（`` exec_command failed: CreateProcess { message: "Rejected(\"`…` rejected: blocked by policy\")" } ``）として、
Codex の rollout（`~/.codex/sessions/…/rollout-*.jsonl` の `response_item`）にだけ残る。

Pleiad はターンの後で rollout を読んで拾う（`core/backends/codex-rejections.mjs`、[ADR 0035](adr/0035-read-codex-rollout-for-rejections.md)）。

- `thread/start`・`thread/resume` の応答の `thread.path`（[UNSTABLE]）を覚える。ephemeral（タイトル生成）では読まない。
- `turn/start` の直前にファイルの長さを取り、`turn/completed` の後にその位置から末尾までだけを読む（まだ無ければ 0 から。最初のターンでファイルができる）。
  最後の改行より後（書きかけ）は捨てる。`internal_chat_message_metadata_passthrough.turn_id` がこのターンのものだけを見る。
- 呼び出しの行はあるのに出力の行がまだ無ければ（rollout の書き込みの遅れ）、50ms から伸ばして合計 0.75 秒まで読み直す。ターンの終わりの行（`task_complete` / `turn_aborted`）があれば待たない。
- 拾うのは出力の先頭（`exec_command` を直接呼んだ `function_call_output`）か `Script error:\n` の直後（code mode の `exec` の `custom_tool_call_output`、続きを待つ `wait` の `function_call_output`）にある文だけ。
  途中に引用されただけの同じ文（issue の本文を読んだ結果など）は拾わない。Rust の Debug 形式を 2 段戻し、`` `<描いたコマンド>` rejected: <理由> `` はポリシーの拒否、
  `Failed to create unified exec process: …` はプロセス作成の失敗（同じ形に包まれて来る）、それ以外は `other`。描いたコマンドは POSIX の語分けで `[shell, -Command, script]` に戻す。
- 見つけたら `turnResult` の前に、会話へ `tool.start`（`name: "commandExecution"`、`input: { command, cwd: null, rejected: true }`、`id` は call id）と
  `tool.result`（`isError: true`、本文は「Codex の安全判定で実行前に拒否された（理由）」と生の文、`rejection` に構造）を出す。
  **会話を開き直すと消える**（履歴は `thread/read` から作り、そこに拒否は無い）。残すには Pleiad 側に別の記録を持って履歴に差し込む必要があり、
  差し込む位置（どの発言の間か）が `thread/read` の items からは決まらないので、今はしない。委譲の結果（`rejections`）には残る（docs/agent-delegation.md「実行前に拒否されたコマンド」）。
- 読めない・形が違うときは診断ログに記録し、ターンの結果は変えない。rollout の行の形は公開の約束ではないので、Codex の版で変わりうる。
- `approvalRequested` は、同じターンで同じ call id（承認要求の `itemId`）の承認を求められたか。
- 上流が拒否を `commandExecution`（`declined`）のアイテムとして出すようになれば、この読み取りは要らなくなる。

**worktree と作業ディレクトリ（承認済み（2026-10-05）、[ADR 0136](adr/0136-worktree-opt-in.md)）。** 会話の cwd が worktree（`<リポジトリ>.pleiad/<id>`）になるのは、人が作業場所の面で「worktree で始める」を選んだときか、委譲で `isolate: true` を指示したときだけ。前者は `setTurnSettings` の cwd で次のターンに予約する。片付けで消す前に会話の cwd と予約を元の場所へ戻す（理由 `worktreeBack`）。worktree の中の会話の行は `worktree: { id, branch, origin }` を持ち、最近の場所の候補は元の場所にする。

**codex の実行ファイル**は `AGENT_HOST_CODEX_BIN`（既定 `codex`）。
**agy の実行ファイル**は `AGENT_HOST_AGY_BIN`（既定 `agy`）。
**agy の `--print-timeout`** は `AGENT_HOST_AGY_PRINT_TIMEOUT`（既定 `24h`。Go の duration 文字列。§2.8）。

### 2.7 ターンの外: 会話に残る裏の作業（2026-09）

Claude は裏の subagent を待つ間ターンを保持する（§2.2 の `phase: waiting`）。Codex は違い、
**バックグラウンド端末（issue #6）がターンの終わった後も残る。**
ターンの外に残る作業を扱うために、server はバックエンドに口を渡す。バックエンド非依存で、今は Codex が使う。

```js
backend.attachHost?.(host)   // server の起動時に 1 回。wrapBackend の後の各バックエンドに渡す
host = {
  background(sessionId, tasks),  // その会話でターンの外に残っている裏の作業の全量（tasks は §2.2 background と同じ形）。空で消える
  event(sessionId, event),       // ターンの外で起きた、会話に属する正規化イベント
}

backend.stopBackground?.(sessionId, taskId)   // その裏の作業を 1 本止める -> { stopped }。WS の stopBackground コマンドから
backend.getBackgroundTask?.(sessionId, taskId) // WS loadBackground から端末の詳細を読む。停止や再開はしない
```

`stopBackground` / `loadBackground` が探す先は 2 つある（server の `findBackgroundTask`）。
ターンの外に残っているもの（`runtime.background`。Codex）と、**走っているターンが抱えているもの**
（`turn.info.background`。Claude の `phase: waiting`）。画面はどちらも作業ダイアログの同じ行として並べる。

**Claude の停止**（`core/backends/claude.mjs`、2026-09）: バックグラウンドのコマンドはターンが保持しているので、
止める相手は走っている `query` そのもの。会話 id → `Query` の表（`liveQueries`）を持ち、`Query.stopTask(taskId)` を叩く。
CLI は `status: "stopped"` の `task_notification` を返し、tracker がそれで一覧から消す（**先回りして印を消さない**）。
SDK の `perTaskStopAffordance` は**宣言しない**。宣言すると中断（interrupt）がバックグラウンドのタスクを
殺さなくなり、「中断はターンごと」の約束が変わってしまう。`stopTask` はこの宣言なしで効く。
出力の取得（`getBackgroundTask`）は持たないので、詳細は「出力の取得に対応していません」と出る。

`sessionId` は**Pleiad の会話 id**（`runTurn` の `hostSessionId`）。バックエンドを乗り換えた会話では
ネイティブ id と別物なので、通知を引く鍵と報告先を分けて持つこと。

**`event`（2026-09）**: ターンを作らずに正規化イベントを 1 件だけ会話へ流す。`running` にも使用量にも出ない。
通せるのは `tool.result` だけ（server の `OUTSIDE_TURN_EVENTS`）。用途は 1 つで、Codex のバックグラウンド端末が
ターンの終わったずっと後に終わったとき、走ったままに見えているツールカードへ結果を差し込むこと。
何でも流せる口にはしない（本文や `turnResult` をターンの外から出すと、web の吹き出しと稼働表示の前提が崩れる）。

**会話単位の background**（`setBackground`）:
- server は `runtime.background` に会話ごとに持ち、`running.background` に載せる。変わったらすぐ `running` を配る。これがある間は 4 秒の定期便も回る
- `count` には入れない。デスクトップは `count > 0` の間は終了させない。ターンの外の作業（dev サーバの端末など）に終了を塞がせない
- 委譲の子の結果と、依頼元への完了通知は、終わりを待つもの（`behindOfTasks` と同じ基準。server の `awaitedBackground`）だけを待つ。端末は待たない（agent-delegation.md「子に残った裏の作業」）
- web: ターンが走っていない会話でも、待てるもの（§2.2 の `behindOfTasks`）が 1 本以上あれば衛星（一覧の行・畳んだ見出し・稼働表示）。
  ターンが走っていればターン行が優先（弧、または Claude の `waiting` なら衛星）。中断は出さない。
  Codex の端末は `kind: "terminal"` で待てるものに数えないので、端末だけなら衛星は出ない（会話末尾の「バックグラウンド N」から開く）

**requeue**（送れなかった）:
- server がターンを始められない（同じ会話が走っている・裏の作業が残っている・同時ターンの上限）とき、委譲の依頼と完了通知は `'requeue'` を返し、
  後で送り直す（[agent-delegation.md](agent-delegation.md)）
- バックエンドの `runTurn` が `{ requeue: true }`（相手が別のターンを走らせていて何も届かなかった）を返す口も残っている。今これを返すバックエンドは無い
- その場合 server は完了として扱わない: 使用量も `completedAt` も残さない、後続の送信待ちも保留しない。`turnEnd { requeued: true, completedAt: null }` を出す
- message-queue はその送信を `queued` に戻し、会話が空いたら改めて kick する
- web は出していた吹き出し（`userMessage` の `messageId`）を引っ込め、送信待ちの側に出す（届いてから改めて出る）

procway-code への対応は 2026-09 に終了した（旧会話は読むだけ。`core/backends/index.mjs` の `RETIRED`）。

**Codex での対応**（`core/backends/codex.mjs`、`core/backends/codex-background.mjs`、issue #6）:
- Codex の `unified_exec`（既定で有効）が起こした端末は、**ターンが終わっても動き続ける**（dev サーバ、`python -m http.server` など）。
  `turn/completed` は端末の終了を待たずに届き、端末の `item/completed` は**終わったターンの turnId のまま**、数分〜数十時間後に届く
- 見張りは**スレッドごと**で、`runTurn` の attach / detach とは独立に `rpc.onNotify`（全通知の聞き手）で受ける。
  以前は detach 以降の通知を捨てていたので、ターンが終わると同時に印が消え、ツールカードは「実行中」のまま残っていた
- 数え方: `item/started` で見た `commandExecution` のうち、`turn/completed` の時点で終わっておらず、`processId` を持つか
  `source` が `unifiedExec*`（`CommandExecutionSource` = `agent` / `userShell` / `unifiedExecStartup` / `unifiedExecInteraction`）のものを
  `kind: "terminal"` として持つ。`processId` は `item/started` で null のことがあるので `item/commandExecution/terminalInteraction` で補う
- 引くのは遅れて届いた `item/completed`。同時にその結果を `host.event` で会話へ流し、終わったターンのツールカードに差し込む
- `turn/completed` が来ない終わり方（`error` 通知・中断）でも `runTurn` の `finally` が裏へ回す
- **全部消す**のは app-server が落ちた・入れ替わったとき（`CodexRpc.onDown`。走っていた端末は道連れ）。
  contextRuntime のターンはターンの終わりに app-server ごと落とすので見張らない。`ephemeral`（タイトル生成）も数えない
- 見張るのは Pleiad が 1 度でもターンを回したスレッドだけ。子スレッド（サブエージェント）の通知も同じ接続に流れてくるが、
  会話を持たないので数えない（親のターンをまたぐ子は、親スレッド 18 本・親ターン 208 本の記録で 0 件。出てきたら同じ仕組みに `kind: "agent"` で足す）
- **`waiting` には数えない**。Codex は `phase` を出さず、端末が残るのはターンが終わった後。`running.background` には残すが、端末だけなら衛星もAIの経過時間も出さない。会話ヘッダーの「端末 · 件数」から開く。
  `ThreadStatus.activeFlags` は `waitingOnApproval` / `waitingOnUserInput` の 2 つだけで、「裏で走っている」を表す値が無い
- **照合**（`thread/backgroundTerminals/list`）: 取りこぼした終了を引くために、端末を数えている間だけ 60 秒ごとに問い合わせる
  （`AGENT_HOST_CODEX_RECONCILE_MS`）。**`generate-json-schema` の出力には現れない**（experimental）。
  実機に直接問い合わせ、端末を 1 本起こして確かめた形（codex-cli 0.154.0-alpha.6.2、2026-09-16）:

  | method | 引数 | 応答 |
  |---|---|---|
  | `thread/backgroundTerminals/list` | `{ threadId, cursor? }`（cursor は数字の文字列） | `{ data: [...], nextCursor: string\|null }` |
  | `thread/backgroundTerminals/terminate` | `{ threadId, processId }`（processId は数字の文字列） | `{ terminated: boolean }` |
  | `thread/backgroundTerminals/clean` | `{ threadId }` | `{}` |

  `data` の要素: `{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }`。
  `itemId` は `commandExecution` の id そのものなので、数えているものとそのまま突き合わせられる。

  一覧は**ページング**なので `nextCursor` を最後まで追う。**途中までのページで引いてはいけない**
  （次のページに居るだけの生きている端末を消すと、issue #6 の症状に戻る）。読み切れなければ何もしない。
  スレッドが**ロード済み**でないと `thread not found` になる（Pleiad は毎ターン resume するので通る）。
  古い版（0.147.0 で確認）はこの method を持たない。**「そんな method は無い」は `-32601` ではなく `-32600` +
  `unknown variant`** で返るので、そちらで見分ける。`-32600` でも `thread not found` は一時的な事情なので、
  そのスレッドを 1 回飛ばすだけにして、照合そのものは止めない
- **読む**（`loadBackground`）: 一覧の行を押すとコマンド・作業場所・起動時刻・出力を開く。Codex の出力は `item/commandExecution/outputDelta` をターン前後とも追跡し、末尾64K文字まで保持する。詳細を開いている間だけ取得する。終了後は最後に取得した内容であると明記する。
- **止める**（`stopBackground`）: 一覧・詳細の独立した停止ボタンから 1 本ずつ止める。行クリックでは停止しない。
  `background` の tasks の id は `commandExecution` の itemId だが、codex が求めるのは **processId** なので、
  見張りが覚えているものへ引き直す（`processIdOf`）。止めた後は**先回りして印を消さず**、codex に数え直させる
  （止めたつもりで生きている端末の印を落とす方が、消え遅れるより悪い）。
  web は作業ダイアログ（「裏で動いているもの」）に行として出し、`capabilities.stopBackground` のあるバックエンドにだけ
  「止める」を出す。中断（`abort`）はターンを止めるもので、これとは別物
- `thread/backgroundTerminals/clean` は使っていない（何をどこまで消すのかが実機で確かめられていない）
- **古い codex での振る舞い**: `backgroundTerminals` は 0.147.0 には無い（0.153 以降にある）。
  数えること自体は遅れて届く `item/completed` だけでできるので、**印は出る**。
  効かなくなるのは「取りこぼしの照合」と「止める」の 2 つだけ。止めようとしたときは生のプロトコルエラーを見せず、
  `codex update` で直せると伝える。Pleiad が使う codex は PATH の `codex`（`AGENT_HOST_CODEX_BIN` で上書きできる）で、
  ChatGPT デスクトップアプリが自前で持つ copy とは**別の install**（アプリを更新しても PATH の方は上がらない）

### 2.8 Antigravity CLI（`agy`、2026-09）

**Google のサブスク枠（AI Pro / Ultra）を正規の手段で使える唯一の道。** 経緯:

- 2026-06-18、Google は**個人向けの Gemini CLI を終了**し Antigravity へ移した。
  個人アカウントの `oauth-personal` は `This client is no longer supported for
  Gemini Code Assist for individuals … migrate to the Antigravity suite` で撥ねられる
  （利用者の実機で確認）。Code Assist Standard / Enterprise ならまだ通る
- Gemini API キーは**別建ての従量課金**で、サブスクの枠は流れない
- 公式の Antigravity SDK（Python）も **API キーか Vertex しか受けない**
  （[antigravity-sdk-python#20] が OAuth 対応の要望として open）
- そこで一度入れた gemini-cli（ACP）バックエンドは**廃止した**

**接続口**は `agy --print= --input-format stream-json --output-format stream-json`。
行区切り JSON（NDJSON）を stdin から受け、stdout へ流す。ACP は話さない
（[antigravity-cli#31] が要望のまま）。

実機（agy 1.2.4 / windows-x64）で確かめたこと:

- **`--print` は次のフラグを prompt として飲み込む。** `--print` と書くと `--input-format` が
  prompt 扱いになり、agy 自身がそう警告する。**`--print=`（空値）が正しい**
- 未ログインだと stderr に OAuth の URL を出し「Or, paste the authorization code here and press
  Enter:」と促す。**ただしその入力は端末からしか読まない。** パイプした stdin に認可コードを
  書いても完全に無視され、60 秒で `authentication failed or timed out` になる（実測）。
  公式も同じことを書いている: *Headless mode uses your cached credentials. Authenticate once
  with an interactive `agy` session first.*
  **だから Pleiad はログインを自分で回さない**（§下）
- 認証に失敗しても `result` は必ず出る（下の形は実機の観測）
- `agy models` は未ログインだと `Please sign in to view available models` で落ちる。
  資格情報は **OS の資格情報ストア**（macOS のキーチェーン: service `gemini` / account `antigravity`）に
  あってファイルとして読めないので、**ログイン判定は `agy models` に聞く**
- `agy models` の出力は `id<TAB>表示名`（例 `gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)`）。段違いは別の id で並ぶ（1.2.8 で確認）。
  既定のモデルは設定ファイルに出ない。agy は起動のたびにログへ `Propagating selected model override to backend: label="…"` を書くので、
  Pleiad は `agy --log-file <一時ファイル> models` で呼び、その label を既定として読む（公開の口ではないので、取れなければ「既定（agy の設定）」）
- 1.2.8 では `agy -p "/model"` などの slash コマンドは**通常のプロンプトとして LLM に送られる**（changelog 1.1.11 の「quota を使わずに答える」は当てはまらなかった。実測）。調べるのに使わない
- サブコマンドは `agent(s)` / `models` / `mcp` / `plugin` / `remote-control` / `update` /
  `changelog` / `install` / `help`。**会話を列挙するものが無い**
- **`--print-timeout`（既定 5m0s）がターンを打ち切る**（2026-09-16 に実測）。5 分を超えたターンは
  stderr に `[agy] print timeout after 5m0s with turn in progress; returning partial output` を出し、
  **`status:"SUCCESS"` / `response:""` / `usage` 全 0 の `result` を吐いて出力を止める**。
  SUCCESS をそのまま信じると「本文が空のまま正常に終わった」ターンになり、会話が途中で止まって見える。
  **しかも agy 本体は打ち切りの後も裏で走り続ける**（打ち切り後も `streamGenerateContent` を
  叩き続けるのをログで確認。3 時間動き続けた実例あり）。Pleiad が見ていない間もファイルは書き換えられ、
  Google の枠も減る。→ **Pleiad は `--print-timeout` を明示的に長く渡し**（既定 `24h`。
  `AGENT_HOST_AGY_PRINT_TIMEOUT` で上書き）、**それでも打ち切られたら失敗として畳み、その agy を落とす**。
  打ち切りは stderr の上の文言で見分ける（`duration_seconds: 0` / `usage` 全 0 も同じ印だが、
  短いターンと区別が付かない）。落とすのは、Pleiad が見ていない所で走り続けさせないため。
  会話は `--conversation <id>` で拾い直せるので失われない
- **MCP のツールは `tool_name: "call_mcp_tool"`、`tool_info.parameters = { ServerName, ToolName, Arguments }` で出る**（1.2.14 で実測）。
  `ServerName` はモデルが埋めず空のことが多いので、`ToolName` で見分ける。ツールの定義はサーバー名の階層なしで
  `~/.gemini/antigravity-cli/mcp/<ツール>.json` に書かれるので、一般的な名前は他のサーバーと衝突しうる（`ply_computer` は中継で `ply_computer_` を付けて見せる）。
  `output` は text ブロックをつないだもので、画像はファイルに退避して末尾に `[Resource offloaded to file:///…]` を足す（モデルは `view_file` で開く）。
  **1 回の MCP の呼び出しは 3 分で切れ**、agent.md の `mcpServers` に何を書いても伸びない（computer-use.md「エージェントごとの値」）
- **ツールの `step_update` は同じ `step_index` で `state: "ACTIVE"` → `"DONE"` の 2 回来る。**
  ACTIVE 側には `tool_info.output` が無い。両方を同じに扱うとツールが二重に並び、1 つ目は結果が空になる。
  → **ACTIVE を `tool.start`・DONE を `tool.result` に分ける**。
  他のバックエンドと同じく「実行中」も出る。`state` が未知・欠落のときは
  `tool_info.output` の有無で開始／完了を決める（取りこぼさないため）
- 調べるときのログは `~/.gemini/antigravity-cli/log/cli-<日時>.log`（`cli.log` が最新への symlink）。
  打ち切りは `poll.go:204] Print mode: print timeout` で引ける

| | Antigravity CLI |
|---|---|
| プロセス | `agy` のヘッドレス。**1 プロセス = 1 会話**（codex / claude の共有 1 プロセスとは違う） |
| 新規 | 引数なしで起動 → `init` の `conversation_id` |
| 再開 | `--conversation <id>` |
| 本文 | `step_update` の `step_type: "agent_response"` + `text_delta`（**真のデルタ**） |
| 思考 | **無し**（`thinking_tokens` は完了時の集計だけ） |
| ツール | `step_type: "tool"` + `tool_info{name,parameters,output}`。**`state` が ACTIVE / DONE の 2 回**（上の実測。開始と完了に分ける） |
| 承認 | **無し**（§下） |
| 中断 | **無し** → プロセスを落とす。会話は `--conversation` で拾い直せる |
| 完了 | `result` の `status`（SUCCESS / ERROR / CANCELED / INTERRUPTED / INVALID / WAITING / RUNNING） |
| 使用量 | `result.usage`（`input_tokens` / `output_tokens` / `cache_read_tokens` / `thinking_tokens`。`total_tokens` = 4 つの和なので、どれも他を含まない）。usage の出来事には Claude・Codex と同じ形にそろえて渡す: `inputTokens` = input + cache_read（入力はキャッシュ読みを含み、`cachedTokens` = cache_read はその内訳）、`outputTokens` = output + thinking。そろえる前（〜2026-10-04）の記録は `cachedTokens` が `inputTokens` を超えるので、読む側は `inputWithCache`（`core/usage.mjs`）で足して読み、キャッシュの割合が 100% に張り付かないようにする |
| 一覧・履歴 | **無し** → Pleiad が控える（§下） |
| タイトル・状態タグ・fork | 無し → sidecar / Pleiad の写し（分岐は [message-fork.md の「Antigravity の境界調査」](message-fork.md#antigravity-の境界調査)） |
| モード | **`--dangerously-skip-permissions` の 1 つだけ**（§下） |
| モデル・effort | `--model` だけを渡す。**起動時のみ**（liveModel / liveMode は false）。effort は段違いの id（`gemini-3.8-flash-low` / `-medium` / `-high`）を選ぶことと同じなので、段は同じ系統の id に解決して `--model` に載せ、`--effort` と同時には渡さない（agy 1.2.8 で確認。`core/backends/antigravity-models.mjs`） |
| 認証 | **端末でのサインインが要る**（Pleiad からは回せない。§下） |

イベントの形:

```jsonc
{"event":"init","conversation_id":"…","init":{"cwd","tools","permission_mode","model","agent"}}
{"event":"step_update","step_update":{"conversation_id","step_index","state":"ACTIVE|DONE","step_type","text_delta"}}
{"event":"result","result":{"conversation_id","status","response","error","duration_seconds","num_turns","usage"}}
```

**承認を持てない**: ターン中の対話承認は**公式に非対応**。許可が取れないツールは soft-deny され
（ターンは止まらず、stderr に通知が出るだけ）。そのため:

- `capabilities.alwaysAllow` は **false**。askPermission を一度も呼ばない
- **選べる承認モードは「全部自動」（`--dangerously-skip-permissions`）の 1 つだけ。**

`agy --help` には `--mode plan` と `--mode accept-edits` もあるが、**ヘッドレスでは選ばせない**。
`--dangerously-skip-permissions` を付けない限りツールは soft-deny されるうえ、
`--print` モードは settings.json の `permissions.allow` を見ない（[antigravity-cli#548]）ので
事前付与で埋めることもできない。並べると「モードを選んだのにエージェントが黙って何もできない」
だけになる。「都度確認」を出さないのも同じ理由（聞くと言って聞かないものを作らない）。

[antigravity-cli#548]: https://github.com/google-antigravity/antigravity-cli/issues/548

**ただし「ツールを呼ばない」の原因は承認とは限らない**: Pleiad 担当のコンテキストを渡す会話は
`--agent ply-context` で走る。agy のカスタムエージェントは frontmatter に `tools` を書かないと
書き込み系ツールを一切持たず、`--dangerously-skip-permissions` を付けても（`permission_mode` は
always-proceed のまま）読むだけになる。そこで定義に `tools` を明示する。
名前を書ける範囲と、`tools: "*"` を採らない理由は `core/backends/antigravity-context.mjs` の `TOOLS`。

**一覧と履歴を Pleiad が控える**（`core/backends/antigravity-store.mjs`）:
gemini では本体が書いた記録を**読んだ**が、agy には読めるものが無い
（会話を列挙するサブコマンドが無く、`conversation_summaries.db` は非公開スキーマの SQLite）。
そこで**ターンの最中に見た正規化メッセージをそのまま控える**。置き場は sidecar と同じ
`AGENT_HOST_DATA` の下の `antigravity/<conversation_id>.json`。
控えは**ターンの終わりを待たずに書き足す**（`runTurn`）: ユーザー発言は会話の id が分かってプロンプトを渡した時点で、
AI の発言はツールの完了ごと（本文は `AGENT_HOST_AGY_SAVE_MS`、既定 2 秒おき）にターンの間変わらない uuid で差し替え、
終わりで完了の時刻に打ち直す。失敗・中断・打ち切り・途中で落ちたターンも、そこまでのツールと本文が残る
（中断の印は sidecar の `interrupted`）。書き込みは会話ごとに 1 本ずつで、`runTurn` は積んだ分を書き終えてから返る。
再開した会話の途中と失敗の書き込みは、控えが無ければ作らない（forget した控えを作り直さない）。
控えなので agy 側で消えた会話が残りうる。`--conversation` が撥ねられた時点で落とす。

**ログインの導線**: Pleiad は OAuth を回さず、**端末で叩くコマンドを案内して、終わるのを見張る**。

- `auth.login` は `agy models` が通るようになるまで見張る（既定 3 秒間隔 / 10 分）。
  利用者は端末でログインするだけでよく、「再確認」を押さなくても画面が切り替わる
- 案内に出すコマンドは `cliCommand` が解決した**絶対パス**。インストーラが PATH を書いても、
  起動済みの端末や Pleiad には届いていないことがある
- **貼り付け欄を出さない。** `capabilities.submitCode`（`auth.submitCode` の実在）を web に渡し、
  受け取れるバックエンドにだけ入力欄を出す。受け取る口が無いのに出すと、
  貼っても何も起きない欄になる（実際にそうなっていた）
- ログアウトも口が無い。資格情報は OS の資格情報ストア（macOS のキーチェーン:
  service `gemini` / account `antigravity`）にあり、Pleiad からは消せない

**インストールの導線**（`core/cli-installation.mjs`）:

- `installation()` は **backend.id で引かれる**ので、`INSTALL_URLS` の鍵も `antigravity` にする。
  実行ファイル名が `agy` だからと鍵を `agy` にすると、`installation("antigravity")` が
  「URL を持たない = 常にインストール済み」になり、**インストール導線が一度も出ない**
- 実行ファイル名だけが違うので、既定のコマンド名は `{ antigravity: "agy" }` で引く
- Windows のインストーラ（`install.ps1`）は `%LOCALAPPDATA%gyin` へ置き、PATH はそのあと
  `agy install` が書く。**起動済みの Pleiad は PATH の変更を拾えない**ので、
  findExecutable はこの置き場を直接見る。見ないと「入れたのに未インストールのまま」になり、
  Pleiad の再起動が要る。Unix 版（`install.sh`）は `$HOME/.local/bin` なので元から見ている

**孤児の `agy` を残さない**（`core/backends/antigravity-pids.mjs`）:
1 プロセス = 1 会話なので、Pleiad が落ちると agy が裏に取り残される（前の起動のものが走り続けていた実例あり）。

- サーバ終了時に、生かしている AgySession を全部落とす（`process.once("exit")`）。
  **`SIGINT` / `SIGTERM` のハンドラは足さない**（server はワーカースレッドでも動くので、既定の終了挙動を変えない）
- それでは強制終了・クラッシュで取り残されるので、生かしている pid を
  `AGENT_HOST_DATA/antigravity/pids.json` に控え、**次の起動で生き残りを落とす**
- **pid は使い回される。** 落とす前にその pid の実行ファイル名を引き（win32 は `tasklist`、
  posix は `ps -p`）、起動に使う実行ファイルと同じ名前だと確かめる。
  確かめられなければ落とさない（無関係のプロセスを殺さないため）
- **他の Pleiad が使っているものは孤児ではない。** 控えは `AGENT_HOST_DATA` ごとに 1 つなので、
  Pleiad を 2 つ動かす（worktree ごとの開発サーバなど）と、後から起きた方が先の agy を落としかねない。
  控えには起こした Pleiad の pid（`owner`）も残し、**それが生きているうちは触らない**
- **保持役に載せた agy は、この掃除の対象に入らない**（無停止の更新 段階 3。`core/backends/antigravity-held.mjs`・[stage3-agy.md](zero-downtime-update/stage3-agy.md)）。
  `AGENT_HOST_AGY_HOLDER`（既定は実行場所の置き場があるとき on）で、会話ごとの agy が保持役の子になり、サーバーが入れ替わっても走り続けて、新しいサーバーが付け直す。
  保持役の子は pid を控えず、終了時（`process.once("exit")`）は手を離していない子だけを止める。ターンの間の子（idle）は引き継ぎのとき旧サーバーが止め、
  落ちた後は次の起動の最初の保持役の使用が止める

**裏へ回ったコマンド**（2026-10、`core/backends/antigravity-background.mjs`）:
agy 1.3.4 の `run_command` は、`WaitMsBeforeAsync`（20 秒）たっても終わらないコマンドを裏へ回し、モデルは終わるまで待ち続ける
（`npm run dev`・`node -e "setInterval(()=>{},1000)"` のような終わらないものは、ターンごと永久に止まる）。stream には ACTIVE が出たままで、
DONE はコマンドが本当に終わったときにしか来ない。裏へ回ったことを示す行は無い。そこで:

- `run_command` の ACTIVE から `AGENT_HOST_AGY_BACKGROUND_MS`（既定 30 秒）たっても DONE が来なければ、§2.2 の `background` を出す。
  形は `{ id, kind: "shell", label }`（`id` はツールの id = `<conversation_id>:<step_index>`、`label` はコマンドラインを 80 文字で切ったもの）。
  `waitable` は付けない（終わりの合図はコマンドの終わりだけで、待つ印にならない）。毎回全量を出し、DONE・ターンの終わり・中断で外す（空の一覧で流す）
- **`phase` は出さない（`active` のまま）。** 理由: agy は途中送信（`control.steer`）を持たないので、`waiting` にして outbox を流し直しても届かない。
  agy の main もコマンドの終わりを待ってツールを呼んだままで、Claude の「返答を終えて止まっている」とは違う。`waiting` にすると委譲の子では
  依頼元へ裏作業の通知（ADR 0170）が飛び、子が終わったかのように見える
- **止める口**（`stopBackground(sessionId, taskId)`。作業ダイアログの停止ボタン）は、そのコマンドを走らせているシェルの木だけを落とす:
  1. その会話の agy の pid を引く。直に起こしたものは `session.pid`。保持役に載せたもの（pid を持たない）は、保持役の直下の子から
     agent の置き場（`--add-dir`）か `--conversation <id>` が入っているものを 1 つだけ選ぶ（`pickHeldAgy`）
  2. **agy の直下の子**だけを見て、コマンドラインにそのコマンドが入っているものを選ぶ（`pickCommandProcess`。引用符・`\`・空白の違いは
     `commandKey` でならす。実機の 1.3.4 / Windows は `powershell -Command "<コマンド>"`）。agy 自身・中継（`agy-context-relay`）・孫・会話の外は選ばない。
     プロセスの一覧は win32 が `Get-CimInstance Win32_Process`（`ParentProcessId` で絞る）、posix が `ps -A -o pid=,ppid=,args=`
  3. 見つからない・2 つ以上当たる・agy の pid が分からないときは**何も落とさずにエラーを返す**
  4. 木ごと落とす（win32 は `taskkill /PID <pid> /T /F`、posix は子孫を引いて SIGKILL）。agy 自身は落とさない。
     taskkill /T は子を落としてから根を落とすので、子が終わると自分も終わるシェルは taskkill が根に届く前に終わりかけ、
     「実行中のタスクのインスタンスがありません」「実行しようとした操作はサポートされていません」で失敗が返る。根が 2 秒以内に消えれば落とせたとみなす
  5. agy の DONE（`AGENT_HOST_AGY_STOP_WAIT_MS`、既定 15 秒まで）を待ってから `{ stopped: true }` を返す。実機（1.3.4）では止めて 2 秒ほどで出力の空の DONE が来て、モデルはコマンドが終わったとして続け、ターンは `result`（SUCCESS）で終わった
- 中断・打ち切りは今までどおり agy を落とすだけで、コマンドのシェルを狙っては落とさない（agy と一緒に落ちるかは実機で確かめていない）

実行ファイルは `AGENT_HOST_AGY_BIN`（既定 `agy`）。
`--print-timeout` の値は `AGENT_HOST_AGY_PRINT_TIMEOUT`（既定 `24h`。**Go の duration 文字列**）。

**まだ確かめていないこと**: `step_update` は `agent_response` と `tool` と `user_input` しか
実機で見ていない。知らない `step_type` と `event` は黙って落とす作りにしてある。

[antigravity-cli#31]: https://github.com/google-antigravity/antigravity-cli/issues/31
[antigravity-sdk-python#20]: https://github.com/google-antigravity/antigravity-sdk-python/issues/20

### 2.6 host ツールの非対称（v3 の既知の穴）

公開 `present` MCP は廃止した。Claude・Codex 共通の Visualize 参照で表示・保存する。詳細は [可視化仕様](visualize.md)。
Codexの新規・再開スレッドは `config['mcp_servers.ply']`、Claudeは `mcpServers.ply` で接続する。
Codexの `set_status / set_title / fork` は未接続なので、
`capabilities.hostTools: false` は維持する。可視化へ移した理由は [ADR 0008](adr/0008-retire-present-mcp-for-visualize.md)。

### 2.9 エージェントを足す（2026-10-18）

エージェントごとの知識は `core/backends/` に置き、ほかの場所は能力の印とエージェントの記述から引く（[ADR 0220](adr/0220-backend-contract-and-agent-descriptors.md)）。
足すときに書くもの:

1. **エージェントの記述**（`core/backends/agents.mjs` の `AGENTS`）。`module`・`shortLabel`・`brand`（ロゴ。`web/brand/` に置く）・`cli`
   （`exe`・`binEnv`・`npmPackage`・`installUrl`・`searchDirs`）・`idleCompaction`（会話を離れた後の自動の圧縮の既定。Pleiad が圧縮しないなら null）・
   `shellTools`（シェルのコマンドを走らせるネイティブのツールの名前。toolHints の `shape: 'shell'` と同じ。名前で見分けられないなら `[]` にして `tool.start` に `shell: true`）・
   `shellDefault`（エージェントのシェルのツールの既定。`'native'` か `'ply'`。§2.3「Pleiad のシェルのツール」）・
   `contextSources`（エージェントが自分で読む指示・Skills・MCP の読み込み元。`core/context-settings.mjs` の `SOURCES`。新しい形式なら `core/context-scan.mjs` に読み方を足す）。
   `contextSources: null` は Pleiad が読み込み元を把握しておらず推計できないという意味で、エージェント自身の設定読み込みを抑止する値ではない。
   全部のキーを書く（使わないものは null）。レジストリ（`index.mjs`）・CLI の探し方（`core/cli-installation.mjs`）・自動の圧縮の設定の行
   （`core/compaction-settings.mjs`・`core/ops/settings.mjs`・設定の画面）・画面のロゴと短い名前（`web/agent-brands.mjs`）・委譲の行き先
   （`core/agent-bridge.mjs` の `backend`）は、ここから作るので触らない
2. **バックエンド**（`core/backends/<id>.mjs`）。§2.3 の形と、能力の印の全部のキー
3. **身代わり**（`tests/lib/fake-<id>.mjs`。LLM を呼ばずにプロトコルの形だけを真似る）と、`tests/lib/backend-contracts.mjs` の `RIGS` の 1 行。
   `npm test` の backend-conformance が、全エージェントで同じ共通の契約（1 ターン・履歴の形と uuid・続き・タイトル・分岐・イベントの形）を回す
4. **試験の隔離**。`tests/lib/test-env.mjs` と `tests/lib/server.mjs` で実 CLI の起動・利用者の資格情報の読み出しを防ぐ。
   そのエージェント固有の身代わり試験を `tests/run.mjs` に登録する。backend-registry は一覧の全件で CLI の差し替え・インストール案内・既定と指定順の登録を確かめる
5. 対応表を書き直す: `node tests/lib/backend-matrix.mjs --write`

**能力の印を足すとき**は、`contract.mjs` の `CAPABILITIES`（値の形・要るメソッド）・全バックエンドの値・`NO_CAPABILITIES`・
対応表の説明（`tests/lib/backend-matrix.mjs` の `ABOUT`）・その印の契約を確かめる試験（`tests/lib/backend-contracts.mjs` の `CAPABILITY_CONTRACTS`。
`'conformance'` か既存の suite の名前）を足す。どれかが欠けると backend-contract が落ちる。

**runArgs の配達物**（エージェントへ機能を渡すキー: `browserEnv`・`controlRuntime`・`secretsRuntime` など）は `contract.mjs` の
`RUN_ARG_FEATURES` に「キー → 能力の印」の行が要る。`server.mjs` は runArgs を組み立てるところと、バックエンドへ渡す前の `gateRunArgs` の
両方で印を見るので、印の無いバックエンドにはその配達物が届かない（消したキーはバックエンドの既定値に落ちる）。一覧に無いキーを runArgs に
足すと試験（`PLEIAD_BACKEND_CONTRACT=strict`）で `gateRunArgs` が例外にするので、新しい配達物は必ず `RUN_ARG_FEATURES`（機能）か
`RUN_ARG_PLUMBING`（プロンプト・承認など全バックエンドに渡る回線）のどちらかに登録する。配達物の機能を足したら、対応する印も足し、
受け取れないバックエンドは `false` と宣言する。`false` なのに配達される組み合わせは起きない。

#### id で分けない

`core/backends/` の外で `'claude'`・`'codex'`・`'antigravity'` を比べる・並べる・引くと、エージェントを足したときに黙って足りなくなる
（一覧に無い・分岐に当たらない）。`npm test` の backends-lint（`tests/lint-backends.mjs`）が、ファイルごとの件数を基準（`tests/backends-baseline.json`）と比べ、
増えたら落とす。減らしたら `node tests/lint-backends.mjs --update-baseline` で基準を下げる（上げる更新は拒む）。
そのエージェントだけの事情で、印にする意味が無いもの（Claude の transcript の救済など）は、行に `backend-allow: 理由` の印を付ける。
基準に残っている分（フック・MCP とコンテキストの設定の読み方・互換の接続先・委譲の振り分け・Claude のアカウント）は、[issue #91](https://github.com/OzEngineJP/pleiad/issues/91) で減らす。

### 2.10 OpenCode v2（2026-10-18）

対象は **v2.0.32 以降の v2**。HTTP/SSE と専用 plugin を使い、公開 backend の機能を維持する（[ADR 0232](adr/0232-opencode-v2-http-plugin-contract.md)）。公式 commit は `843a6c514e606b436a7fe713422ace0a93ad3d61`。

`serve --stdio --hostname 127.0.0.1 --port 0` の stdout JSON から URL を読み、起動ごとの Basic 認証でつなぐ。保持役が stdin を維持し、共有プロセスをアカウントごとに持つ。場所は `x-opencode-directory`、出来事は `/api/event`。内部の旧形式のパス名は `opencode-v2.mjs` が v2 API に変換するための私有の契約で、v1 サーバーには送らない。

| 機能 | v2 の契約と Pleiad の扱い |
|---|---|
| 会話の作成・継続・題 | `/api/session`。会話 ID とアカウントの組を維持する |
| 送信・途中送信 | `prompt { id, text, delivery: steer }`。受付と配送を区別し、発言 ID を照合する。応答消失は inbox と履歴で確認する |
| 本文・推論・ツール | native event envelope を内部イベントへ変換。text と reasoning は種類ごとの ordinal を使う |
| 承認・質問 | 会話別の permission・form と reply。選択肢は表示名から native の値に戻し、拒否・取り消しも返す |
| 承認モード | `permissions: [{ action, resource, effect }]`。Code Mode 自体も都度確認・編集・計画モードの承認にかける。移動・外部 worktree は YOLO に限る |
| 中断 | inbox の未配送入力を取り消し、`interrupt?resume=false` で止める |
| 履歴 | message を cursor でページ取得。起動していなければ SQLite を読み取り専用で開く。移行途中は旧テーブルを読む |
| 分岐・巻き戻し | `fork { before }` に次の発言 ID を渡して選んだ発言までを含める。ファイルの巻き戻しは Pleiad の snapshot を使う |
| 子の会話 | `subagent` の native session ID を取得。親を確かめ、子孫の承認・質問と環境を復元する |
| 圧縮 | `compact` の受付 ID と compaction の完了を照合。running・failed を要約の区切りにせず、費用も加算する |
| モデル・使用量 | `/api/model`・default と credential を利用。variant をモデル切替へ渡す。同じ発言の使用量を重複加算しない。再試行は待ちの時刻・回数を表示し、確定した上限は limited で終える |
| ログイン・複数 account | `auth login` を案内。v2 credential の active・作成時刻・ID の降順で選ぶ。HOME・設定・DB と relay token を分ける |
| 添付・`!` | 添付の保存は Pleiad が担う。`!` の出力は `synthetic { resume:false }` で、返答を起こさず積む |

**Pleiad の MCP・指示・Hooks。** `tools/call` の `_meta["ai.opencode/sessionID"]` と account token を使って会話の橋へ配送する。引数による会話 ID の指定は信頼しない。MCP の接続先は `PUT /api/experimental/mcp/:server` で登録し、接続と tool registry の準備を待つ。Pleiad のツールは `codemode:false` で直接使える。

plugin は `opencode/pleiad-plugin-v2/` の package として配置する。ツール前の Hooks は拒否・引数変更を反映し、連携できなければ実行を断る。ツール後と context・compaction・title・generate の補助 hook は、遅い失敗で完了済みの処理を壊さない。指示は会話ごとに system に注入する。会話の環境は native environment API に設定し、shell の起動 hook でも連携用の認証情報を取り除く。

**コンテキストの担当。** Pleiad 担当のターンは専用プロセスを使い、独立 HOME と設定の写しから担当の指示・Skills・MCP を外す。作業場所の設定を無効にし、OpenCode に任せる設定だけを絶対パスで渡し直す。v2 が自動で読む指示名は AGENTS.md。下位の read が追加した native 指示も、Pleiad 担当ならモデルの文脈から除く。分離できない OS のシステム設定がある場合は開始を断る。専用プロセスはターンの終わりに止まり、更新はその終了を待つ。

**移行と更新。** v1 の会話がある場合は、CLI 起動前に SQLite の一貫した `.pleiad-before-v2.db` バックアップを作り、公式変換の完了を待つ。継続する会話は発言・添付まで検証し、欠落があれば原本を残して開始を断る。外部 URL の v1 添付は公式変換で内容を保持できない場合がある。

最初の v1→v2 更新は旧サーバーの作業が終わってから切り替える。以降の共有プロセスは保持役のまま、札・履歴・保留中の承認と質問・active・inbox からターンを復元する。本文は snapshot と差分を重ねず、終了時の全文で補う。plugin は小さな接続先ファイルを毎回読み、新しい Pleiad は MCP の URL も更新する。ポートが変わっても OpenCode を止めない。処理中に切り替わった MCP 呼び出しは一度失敗する場合があり、以降は新しい接続先を使う。

## 3. 変えないこと

- 承認の保留・猶予・中断（design.md §8.5）。`server.mjs` の
  `graceExpired` / `giveUp` / `attach` / `detach` / `settleAll` / `askPermission` は触らない
  （行番号で書くとすぐずれる。関数名で探すこと）
- 「接続が来ても古い接続を閉じない」
- md レンダリング・CSP・提示の永続化
- `tests/unit/stream-routing.mjs` などの「規則の写経」は、写経元を動かしたら同時に直す

## 圧縮と文脈の量（2026-09-27）

| バックエンド | 圧縮の検出・手動実行 | 文脈の量 | 要約 |
|---|---|---|---|
| Claude Code | SDK の `status.compacting`・`compact_result`・`compact_boundary`、PreCompact / PostCompact。手動は `/compact` | `getContextUsage()` の `total_tokens` / `raw_max_tokens` | PostCompact |
| Codex | app-server 0.156.1 の `contextCompaction` item と `thread/compacted`、手動は `thread/compact/start` | `thread/tokenUsage/updated` の `last.totalTokens` / `modelContextWindow` | 現在の item 形からは取得できない |
| Antigravity | `checkpoint` の意味は未確認。圧縮と判別できないため正規化しない。手動操作は提供しない | 取得しない | 取得しない |
| Devin | Devin 自身の自動圧縮は ACP の会話に出ない。手動は `/compact` を prompt の本文として送る（ACP のスラッシュコマンドの形） | `usage_update` の `used` / `size` | 取得しない |
| Grok | 正規化しない（自動の圧縮は Grok 自身が `config.toml` の `[session] auto_compact_threshold_percent` で決める） | `usage_update` の `used` / `size`（2026-10-19 の実機では届かなかった）。`turn_completed` の `usage` は使わない: ターンのモデル呼び出しの合計（課金の量）で、呼び出しが 2 回のターンは文脈の占有のほぼ 2 倍になる（`totalTokens` 58,145、最後の呼び出しのプロンプト 29,195）。`_x.ai/session/usage` も同じ合計を返し、使用枠の残り・リセットの時刻は返さない | 取得しない |

core は圧縮の開始・完了・失敗を `compaction`、文脈量を `contextWindow` として送る。既存の `contextUsage` はプラグインの読み込み記録なので保持する。Claude の `compact_boundary` と Codex の `contextCompaction` item をネイティブ履歴から優先して読み、sidecar の `compactions` から要約・trigger・失敗理由を補う。ID のない記録も同じターン、または近い時刻で照合して重複を除く。ネイティブ境界が無い分は sidecar から区切りを戻し、ネイティブ履歴の発言と一緒に描く。自動圧縮の予約は送信受理・手動圧縮・未送信会話の削除・バックエンド切替・対象外への設定変更・キャンセルで取り消す。画面の会話切替では残す。見えている予約はファイルに保存し、Pleiad の再起動後に予定の時刻から 8 分以内のものを戻す（[ADR 0039](adr/0039-conversation-compaction.md)、[ADR 0069](adr/0069-idle-compaction-schedule-survives-restart.md)）。

## Codex の履歴の読み出し（2026-10-12）

Codex の会話の履歴（`getMessages`・`getCompactions`・`getSubagentMessages`・巻き戻し・子の一覧）は `core/backends/codex-history.mjs` の `readThread` で読む。返す形は `thread/read { includeTurns: true }` と同じ（`thread.turns[].items[]`）。

**問題.** `thread/read { includeTurns: true }` は会話を 1 行の応答で丸ごと返す。画像を作った会話は、1 枚につき 1.6 MB ほどの base64（`imageGeneration` の `result`）を抱える。14 枚で 22 MB を超え、保持役の 1 行の上限（16 MiB。`core/holder/protocol.mjs` の `DEFAULT_MAX_LINE_BYTES`）で捨てられた。`getMessages` には時間切れが無かったので、Pleiad は応答を待ち続けた。会話が開けず、`ply_task_send` の追加の指示が届かず、終わった子が「実行中」のまま残った（2026-10-11）。`thread/resume`・`thread/fork` も、既定では会話の中身ごと返すので同じだった。

**読み方.**

- まずメタデータだけの `thread/read` を読む。
- スレッドが paginated（`historyMode`。codex-cli 0.156 以降に作った会話）なら、ページに分けて読む。
  - `thread/turns/list { itemsView: "notLoaded", sortDirection: "asc", limit: 100 }` でターンの並びと時刻を読む。
  - `thread/items/list { sortDirection: "asc" }` でアイテムを読む。最初は 32 件ずつ。画像を含むページの次は 2 件にし、画像の無いページが続けば倍に戻す。
  - 1 行が上限を超えたら（下の `LINE_OVERFLOW`）、同じ位置を半分の大きさで読み直す。1 件でも超えるなら「大きすぎて読み込めない」（`codex.errors.historyTooLarge`）で失敗にする。
  - ターンの一覧の後に始まったターンのアイテムは、末尾のターンとして足す。
- legacy のスレッドと、ページ読みを知らない版（`unknown variant`。以後は試さない）は、今までどおり 1 回で読む。
- どちらの読み方でも、保存先（`savedPath`）のある画像の base64 は捨てる。画面は `/local-file` で保存先を開く。保存先の無い画像は、base64 が画面に出す元なので残す。
- 1 回の応答は 30 秒で打ち切り、「30 秒で読み込めなかった」（`codex.errors.historyTimeout`）で失敗にする。
- 会話を開くと `getMessages` の直後に `getCompactions` が同じ会話を読む。5 秒以内なら、直前に読んだものを使う（2 度読まない）。
- `thread/resume`・`thread/fork` には `excludeTurns: true` を付ける。知らない版に撥ねられたら、以後は付けない。

**保持役が行を捨てたとき.** 保持役は `overflow { id, reason: "line", bytes }` を送る（捨てた行の依頼の id は分からない）。`HeldAppServer` は自分の子の `reason: "line"` だけを `CodexRpc` に渡す。`CodexRpc` は、大きな答えになりうる待っている依頼をすぐ失敗にする（`LINE_OVERFLOW`）。対象は `thread/items/list`、`itemsView` が `notLoaded` でない `thread/turns/list`、中身つきの `thread/read`、`excludeTurns` の無い `thread/resume`・`thread/fork`。巻き添えで失敗したページ読みは、小さくして読み直すので害が無い。時間切れには `RPC_TIMEOUT` を付ける。

**読めないとき.** ターンの後の取り込みと委譲の結果の読み出しは、この 2 つの失敗（`historyGaveUp`）でターンや委譲を失敗にしない（docs/agent-delegation.md「履歴が一時的に読めないとき」）。

**使わなかった道.** codex の `thread_history_1.sqlite`（`thread_items`）を直に読む手もある。採らなかった理由:

- codex の内部の形である。
- legacy のスレッドが載らない。
- `CODEX_HOME` ごとに場所が変わる。

app-server のページ読みなら、codex の公開の口だけで済み、どの CODEX_HOME でも同じに動く。

**試験.**

- `tests/unit/codex-history.mjs`: 偽の app-server。読み方・上限超え・時間切れ・overflow を確かめる。
- `tests/unit/server-codex-large-history.mjs`: 本物の保持役と、fake の app-server の `images:14`（22 MB）。開く・追加の指示・完了・legacy の失敗を確かめる。

## Devin ACP の大きなツール情報

Devin の受信は 1 行 64 MiB までとし、改行までのバイト数を加算して管理する。超過した行はバッファーから解放し、次の改行まで読み飛ばす。接続は保ち、本文を含めず超過を検知した時点のバイト数をサーバーログに残す。送信側にはサイズ上限を設けない。

破棄した行の ID は特定できない。既存の要求の期限は維持し、期限なしで待っている要求にも超過を検知した時点から通常の要求と同じ期限（既定 30 秒）を付ける。その間に応答があれば受け付け、無ければその要求を時間切れにする。通知や承認要求を捨てた場合、その情報は復元できない。

ツールの入力・出力・content などは、各フィールドにキーを含む文字列 16,384 文字の予算を設け、値は 256 個、深さは 12 段までに制限してから、ツール状態・履歴・画面へ渡す。巨大な `oldText` / `newText` は共通の前後を除き、変更部分と前後それぞれ 160 文字、元の文字数、省略の印を残す。変更部分自体が大きいときは前後それぞれを 4,096 文字までにし、文字予算も適用する。省略の印は文字予算とは別に付ける。結果テキストは他のバックエンドと同じ `MAX_RESULT_CHARS`（2,000 文字）で切る。

この情報は表示用の抜粋であり、完全なパッチではない。Devin CLI が管理する DB や実行する編集内容は変更しない。履歴再生とライブ更新は同じ処理を通る（[ADR 0230](adr/0230-devin-large-tool-previews.md)）。
