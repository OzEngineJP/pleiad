# 0362 Antigravity の口を stream-json から ACP（`agy acp`）に替える

- 状態: 承認（2026-11-26）。実装済み（Ph2 の C1〜C5）
- 関係: [0281](0281-antigravity-cli-capability-coverage.md)（口の部分を置換）・[0308](0308-antigravity-catalog-fetch-places.md)（ログインの証拠と呼び出しの読み替え）・[0270](0270-server-may-die-anytime.md)（無停止の更新。保持役）・[0223](0223-devin-acp-backend.md)（Devin の ACP。共通の口 `AcpClient` の元）・[0356](0356-devin-models-from-acp-options.md)・[0362](0362-consolidate-backend-leak-guards.md)（実装漏れ対策。印の宣言）・[0222](0222-agent-accounts-and-provider-quota.md)（アカウントの分離。Ph3 の前提）

## 状況

Antigravity（`agy`）の口は `agy --print= --input-format stream-json --output-format stream-json` だった。この口は、Pleiad が他のエージェントでは持っている機能の多くを持てなかった。

- 走っているターンへ入力を足せない（`steer` が不可能）。追加の指示は次のターンまで渡らない。
- 承認の往復が無い（`approvals: 'none'`）。ツールの確認は「全部通す」（yolo）だけで、`alwaysAllow` も無い。
- モデル・モード・段（`--model` ほか）は起動の引数でしか決まらず、走らせたままは変えられない（`liveModel`・`liveMode`・`liveEffort` が不可能）。モデルを替えるたびに `--conversation` つきで別のプロセスを起こし直していた。
- 手動の圧縮の口が無い（`compact` が不可能）。
- イベントに版が無く、形が変わったことを検知できない（`backend-shape-errors.log` は `unknown` と記録するだけだった）。
- 保持役（[0270](0270-server-may-die-anytime.md)）に載せるため、stream-json の `init`・`result` 行を自前で読む `antigravity-held.mjs` と、起こし直しの `antigravity-cli.mjs` が要った。Devin・Grok が使う ACP の口とは別の実装で、直す箇所が 2 倍になっていた。

agy は 1.5.0 で `agy acp`（Agent Client Protocol。JSON-RPC 2.0 を stdio で、1 行 1 JSON）を安定版にした。Pleiad が頼る口（`session/resume`・`session/set_config_option`・`session/request_permission`・`session/new` の `_meta.antigravity.systemPrompt`・応答の `_meta.antigravity.deniedActions`）を使える版として、下限を 1.5.15 にした。実測は 1.5.17（Windows x64）。

## 決定

### 1. 口は ACP だけにする

- 起動は `agy acp --add-dir <cwd> …`（`agyAcpArgs`）。共通の `AcpClient`（`core/backends/acp-client.mjs`）に agy 固有の差（`core/backends/antigravity-acp.mjs`）を載せる。stream-json の口は残さない（`antigravity-cli.mjs`・`antigravity-held.mjs` を廃止）。
- **1.5.15 未満は古い口に落とさず、更新を促す**（`antigravity.errors.acpTooOld`。「`agy update` で更新してください」）。送信・圧縮・ログイン状態の確認のどれでも同じ文を返す。古い口を残すと、新旧の差を試験し続ける費用が要り、`steer` などの印も版ごとに揺れる。
- 起動の版は `agy --version` で確かめる（`agyVersion`・`supportsAcp`・`tooOldAcp`）。

### 2. 1 会話 1 プロセスにする

- agy の子は保持役の `lifetime: 'conversation'`（`core/backends/acp-held.mjs`）に載せる。子の id は `acp-agy-…`。新しいサーバーは付け直して、ターンの途中の続きと締めを 1 回だけ残す（[0270](0270-server-may-die-anytime.md) の形。`core/adopt.mjs`）。
- 次の発言まで `IDLE_MS`（30 分。`AGENT_HOST_AGY_IDLE_MS`）だけ生かし、過ぎたら止める（`sweepIdleAcp`）。止めた会話は次の発言で起こし直す。起こし直しは `session/resume` → `session/load` の順に試し（どちらにも `cwd`・`mcpServers`・`_meta` を渡す）、会話が無い（`notFound`。-32002）ときだけ `session/new` に落ちる。
- 中断は `session/cancel`（通知）。`CANCEL_GRACE_MS`（5 秒）待っても終わらなければ agy を止める。会話は agy 側に残るので、次の発言は同じ会話の続きになる。
- サーバーが終わるときは、保持役に載っていない直下の agy だけ止める（`process.once('exit')`）。

### 3. 起動と会話の契約

| 段 | 呼び出し | 要点 |
|---|---|---|
| 1 | `initialize` | `protocolVersion: 1`。`clientCapabilities` は `fs` も `terminal` も持たない（ファイルとシェルは agy 自身が実行する） |
| 2 | `session/new { cwd, mcpServers, _meta }` | 新しい会話。`sessionId` は agy が決める UUID。Pleiad の会話 id にもそのまま使う |
| 2' | `session/resume` → `session/load` | 続き。`notFound` なら `session/new` |
| 3 | `session/set_config_option { configId: 'mode' / 'model' / 'thought_level', value }` | 返ってきた `configOptions` の `currentValue` が `value` と違えば断られたと見なして失敗にする（`configRejected`） |
| 4 | `session/prompt`（`timeoutMs: 0`） | 応答は `stopReason`（`end_turn`・`cancelled` ほか）。本文・ツール・使用量は `session/update` の通知（`agent_message_chunk`・`tool_call`・`tool_call_update`・`usage_update`・`available_commands_update`） |
| 5 | `session/cancel` | 通知。上の 2 を参照 |

- ターンの最中に別の `session/prompt` が来たら steer（走っているターンへ足す）にする（`core/backends/acp-steer.mjs`）。
- 思考（thought chunk）は流さない。`thinking_tokens` は `usage_update` の `_meta.antigravity.usage` の集計にだけ出る。

### 4. 承認

- ツールの確認は `session/request_permission`（`allow_once`・`reject_once`・`allow_always`）を Pleiad の承認カードへ繋ぐ。「常に許可」（`alwaysAllow`）が使える。
- モードは `default`（都度確認）・`accept-edits`・`auto`・`plan` を `set_config_option` で替える。**`yolo` は起動の旗 `--dangerously-skip-permissions`** で、起動の時にしか決まらない。yolo とそれ以外の行き来だけは agy の起こし直し（`setModeLive` が false）。**新しい会話の既定は今までどおり `yolo`**。
- 組織の管理者が確認を求める設定のとき、旗を付けても確認の要るツールは拒否される。応答の `_meta.antigravity.deniedActions` を `adminNotice` として会話に知らせる（黙らせない）。
- 委譲の子の承認: 全エージェントが `approvals: 'interactive'` になったので、agy の子が「親より強い」承認のカードを出す経路（agy だけ `none` だった）は無くなった。

### 5. モデルと段

- モデルは `session/set_config_option`（`model`）で設定する。`--model` の引数は無い。走らせたままでも替わる（`liveModel`・`liveEffort`）。
- **段は、同じ系統の段違いの id に解決して `model` に載せる**（`agyTarget`・`applyTarget`）。`thought_level` を設定するのは、モデルの id が分からず段だけ決まっているときの最後の手（段が `low`・`medium`・`high` のとき）に限る。`thought_level` の振る舞いは実機で確かめていない。
- **`effortInModelId` は残す。** agy のモデル一覧は段をモデル id に含める（`gemini-3.8-flash-low`・`…-high`）形で、Pleiad の段の選択（`AGY_LEVELS`・`agyTarget`）はその id へ解決する。一覧は従来どおり `agy models` と `agy --print /usage --output-format json` から取る（`requireModelCatalog`・TTL・single-flight は [0308](0308-antigravity-catalog-fetch-places.md) のまま）。

### 6. MCP と指示

- Pleiad の MCP（ply_context・ply_agents・ply_computer・ply_browser・ply_control）は、`session/new`（と `session/resume`・`session/load`）の `mcpServers` に **1 本に束ねた stdio の中継** `ply_<先頭の種類>`（`relayMcpServers`。agy は先頭の 1 本しか起こさないので束ねる）を渡す。接続先とトークンは `env` の `[{ name, value }]`（ファイルには書かない）。
- Pleiad の指示は、**制限した会話**（Skills または MCP の担当を Pleiad にして、agy 自身の分を止める会話。`agyRestricted`）だけ、従来どおりカスタムエージェント（`--agent ply-context`。`agent.md` を Pleiad の置き場に書き、`inheritCustomizations: false` で止める）で渡す。**それ以外の会話は既定のエージェントのまま**で、指示を `session/new` の `_meta.antigravity.systemPrompt.append` に足す。stream-json の口ではカスタムエージェントでしか指示と MCP を渡せず、`tools` を書いても既定より持てるツールが少なく、作業場所の `AGENTS.md` も読まなかった。今は、制限しない会話は既定のツールと `AGENTS.md` の読み込みをそのまま持つ。
- `agent.md` を書くのは「コンテキストが有効で、制限した会話」のときだけ（`prepareAgent`）。制限した会話で `AGENTS.md` を読まない分は、従来どおり Pleiad が発言の前に足す（issue #107）。
- 可視化の指示は、従来どおり各ターンの発言の前に付ける（[0281](0281-antigravity-cli-capability-coverage.md)）。
- 渡すものの鍵（コンテキスト・ブラウザー・Hooks・各中継・bot の人格・秘密情報・起動の旗・プロファイル）が前のターンと変わったら、起動時にしか渡せないので agy を起こし直す（`keysOf`）。

### 7. 履歴は Pleiad の写しが正本のまま

- 会話の履歴・タイトル・使用量・使用の記録は、`AGENT_HOST_DATA/antigravity/<id>.json`（`antigravity-store.mjs`）の Pleiad の写しを正本にする。agy 側の会話データ（`~/.gemini/antigravity-cli`）は、再開の鍵（`sessionId`）にだけ使い、履歴としては読まない。保持役からの付け直しが再生する行は `replay` の印を付けて流し、写しに二重に積まない。
- 以前の版が置いた `pids.json`（孤児の掃除の控え）が残っていても、一覧は拾わない（形の検査は残す）。

### 8. 孤児の掃除（pid の控え）をやめる

- `antigravity-pids.mjs`（生きている agy の pid を控え、次の起動で名前を確かめて落とす）は、使う所が無くなったので廃止した（試験・書き込みの許可表・suite の重みも）。
- 理由は実測。**`agy acp` は stdin を閉じると自分で終わる**（1.5.17 で、`initialize` に答えたあと stdin を閉じて 21 ms 後に終了コード 0）。サーバーが強制終了・クラッシュしても、OS が子の stdin を閉じるので、子は残らない。保持役に載った子は保持役が持つ。

### 9. 能力の印の変更（`core/backends/agent-marks.mjs`・`agents.mjs`）

| 印 | 変更前 | 変更後 | 根拠 |
|---|---|---|---|
| `steer` | 不可能 | `true` | 走っているターンへ `session/prompt` を足す（`acp-steer.mjs`） |
| `liveModel` | 不可能 | `true` | `set_config_option`（`model`） |
| `liveMode` | 不可能 | `true` | `set_config_option`（`mode`）。`yolo` の行き来だけは起こし直し |
| `liveEffort` | 不可能 | `true` | `set_config_option`（段違いの id を `model` で選ぶ。id が分からないときだけ `thought_level`） |
| `alwaysAllow` | 不可能 | `true` | `session/request_permission` の `allow_always` |
| `approvals` | `none` | `interactive` | `session/request_permission` を承認カードへ |
| `compact` | 不可能 | `true` | `/compact` を `session/prompt` で送る |
| `idleCompaction` | なし | `{ enabled: false, delayMinutes: 25 }` | `/compact` を送れるので、離れた後の自動の圧縮の口ができた。既定は切る |
| `promptDelivery`（性質） | `false` | `true` | 発言が渡ったかを区別して返せる。`session/prompt` を書く前の失敗（起動・会話の準備・版）と、何も実行せずに thought signature で断られた失敗だけ `undelivered`。書いた後の失敗は、渡ったかもしれないものとして結果不明のまま返す |
| `handover` | `true`（`antigravity-held.mjs`） | `true`（`acp-held.mjs`） | 実装の置き場だけ替わる |

変えない印: `subagents`・`accounts`・`compatEndpoints`・`autoCompactWindow`・`plyShell`・`nativeShellOff`・`nativeMcpOff`（理由は従来のまま。口が替わっても確かめていない・変わっていない。残る課題を参照）。

### 10. プロファイルの口を 1 つにする（Ph3 の足場）

- agy の起動の種類は `agyLaunchProfile({ account })` の 1 か所だけで決める（今は `{ key: 'default', args: [], env: {} }`）。会話ごとの agy は `Map<プロファイルの key, …>` で持ち、起動の引数・環境は `profile.args`・`profile.env` を通す。複数アカウント（Ph3）はこの口にアカウントごとの `HOME` などを足すだけで入る。

## 理由

- 同じ共通の口（`AcpClient`・`acp-held`・`acp-steer`）を Devin・Grok・Antigravity が使うので、保持役・付け直し・中断・steer の直しが 1 か所で済む。agy だけの口（`antigravity-held`・`antigravity-cli`）を持ち続けるより、後の費用が小さい。
- 承認・モデル・モード・段・圧縮・steer は、stream-json では不可能と判定したものが、ACP の標準の呼び出しで持てる。能力の印を「不可能」で据え置く理由が消えた。
- 古い版へ落とす互換の口は残さない。残すと、印が版ごとに揺れ、新旧の差を試験し続ける。下限を 1.5.15 にして更新を促す。
- `yolo` を既定のまま旗に残すのは、今までの利用（確認しない）を黙って変えないため。承認の往復を既定にするのは別の判断（残る課題）。
- 履歴を Pleiad の写しに置くのは、agy の会話データの形に頼らず、再生の重複と、アカウントを替えたときの履歴の消えを避けるため。
- `effortInModelId` を残すのは、モデル一覧（`agy models`）が段つきの id を返す事実が変わっていないため。

## 影響

- **廃止・削除**: `core/backends/antigravity-cli.mjs`・`antigravity-held.mjs`・`antigravity-pids.mjs`、`tests/unit/antigravity-held.mjs`・`antigravity-pids.mjs`、`tests/lib/fake-agy.mjs` の stream-json の口。
- **追加**: `core/backends/antigravity-acp.mjs`（agy 固有の差。起動の引数・版・エラーの印・プロファイルの口）、`tests/lib/fake-agy.mjs` の ACP モード（`runAcp`）、`tests/unit/fake-agy-acp.mjs`、`scripts/zero-downtime/agy/acp-probe.mjs`。
- **更新**: `scripts/zero-downtime/agy/{held-server,held-swap,relay-retry}.mjs` と `scripts/zero-downtime/codex/{60-agy-basic,61-agy-swap,62-agy-mcp}.mjs` は ACP の呼び出しで測る。無停止の更新の文書（`docs/zero-downtime-update/stage3-agy.md`）と `docs/multi-backend.md` §2.8 は ACP の記述に直す。公開文書の接続の手順（`_connect.md`）に最低の版（1.5.15）を足す。
- **利用者への影響**: 1.5.15 未満の agy は更新が要る（案内が出る）。既定のモード（確認しない）・モデル一覧・履歴は変わらない。承認のモードを選べば、確認のカードが出る。
- **承認モードの語彙が 1 つから 5 つになったことで、`yolo` が唯一であることを前提にしていた所が動く**（どれも語彙から決まる作りなので、コードは直さず、文書・文言・試験の期待を直した）:
  - コンピューターの操作のアプリの承認は、Antigravity も会話のモードに従う（`yolo` のときだけ聞かない。`capabilities.approvals` が `'none'` から `'interactive'` になったため。[computer-use.md](../computer-use.md)）。設定の画面の 1 行（`settings.computer.antigravity`）もそう直した。
  - bot を新しく作るとき、Antigravity の既定のモードは `yolo` ではなく、語彙の先頭の `default`（都度確認）になる（`core/bots/sessions.mjs` の `defaultMode` は「作業場所に限って毎回聞くもの。無ければ先頭」）。bot のページの「承認モードは全部自動だけ」の 1 行は出なくなる（`onlyMode` は 1 つだけのバックエンド向けのまま）。
  - 隠れた会話（心拍の安いモデル・夜の記憶の整理。`narrowestMode`）は、`plan`（readonly）ができたので Antigravity でも作れる。
  - 手で走らせる `tests/browser/bot-page.cjs`（`npm test` には入らない）の Antigravity の節は、5 つの語彙の期待に直した。**この台本は実際には走らせていない**（身代わりの agy を有効にした分離サーバーを立てて `playwright-cli` で流す必要がある）。
- **実測の記録**（agy 1.5.17、Windows x64）:
  - `initialize` の応答は `protocolVersion: 1`・`agentCapabilities`（`loadSession`・`promptCapabilities`・`sessionCapabilities`・`auth.logout`・`_meta.antigravity`）・認証の方式 4 つ。
  - `session/new` の応答は UUID の `sessionId`・`models`・`modes`（4 つ）・`configOptions`（`model`・`thought_level`・`mode`）。直後に `available_commands_update` と `usage_update` の通知が来る。
  - `session/prompt` の `stopReason` は `end_turn`・`cancelled`。
  - stdin を閉じると 21 ms で終了コード 0（上の 8）。
  - モードの id と認証方式の id は数（4 つずつ）しか確かめていない。Pleiad は、`set_config_option` が返す `currentValue` で当たったかを確かめ、名前に頼らない。
  - 身代わり（`tests/lib/fake-agy.mjs`）は、この実測の形を台本で動かす。無停止の更新の 6 本の実機の確かめ（`scripts/zero-downtime/…`）は、身代わりで段取りまで確かめた。**実物の agy・実際のモデルでの再測定は、ログインの済んだ環境で別に流す**。
- **残る課題**:
  - 新しい会話の既定のモードを `yolo` から `default`（都度確認）にするか（bot は上のとおり、すでに `default` になる）。
  - `effortInModelId` をやめ、段を `thought_level` だけで選ぶか（`thought_level` の振る舞いを実機で確かめ、モデル一覧の形が段を分けて返すようになったら）。
  - `session/list` で agy 側の会話の一覧を取り込むか。
  - `subagents`（子の会話本文）が ACP の通知から取れるかの再判定。
  - `plyShell`・`nativeShellOff` の再判定。MCP は `mcpServers` で渡せるようになったので、「MCP はカスタムエージェント経由でしか渡せない」という理由（[0227](0227-ply-shell-and-command-notices.md)）は古い。ply_shell の中継を束ねに足せるかを確かめる。
  - 複数アカウント（Ph3。`agyLaunchProfile` に口はある。OS の共有キーリングの分離は [0222](0222-agent-accounts-and-provider-quota.md) の制約のまま）。
