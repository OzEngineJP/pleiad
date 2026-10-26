# 段 2b: Devin・Grok の ACP・Codex のターン専用の app-server・`.cmd` の包み

[ADR 0270](../adr/0270-server-may-die-anytime.md) の段 2 の後半（2026-10-26）。段 2 の前半（2a）は `core/process.mjs`・`child_process` の検査・`!` の行と ply_shell のジョブ。ここは、2a の後に残っていた「保持役に載っていない長く生きる子」を載せた記録。

## 載せたもの

| 子 | 今 | 載せる口 | 札 |
|---|---|---|---|
| Devin CLI（`devin acp`） | 1 ターン 1 プロセス。stdin・stdout の 1 行 1 JSON | `core/backends/acp-held.mjs` の `heldAcpPlan`・`createHeldAcp`（policy `jsonrpc`） | ターンの札（`core/turn-card.mjs`）＋ `backendCard` の `devin: { promptId, sessionId, sent, shown, prompts }` |
| Grok CLI（`grok agent stdio`） | 同上 | 同上（`AGENT_HOST_GROK_HOLDER`） | 同上の `grok` |
| Codex のターン専用の app-server（Pleiad がコンテキストを持つ会話。1 ターン 1 本） | サーバーの子。ターンの終わりに `rpc.stop()` で止める | `core/backends/codex-held.mjs` の `acquireHeldTurnAppServer`（policy `jsonrpc`。id は `codex-turn-…`） | 共有の app-server と同じ種類（`k: 'codex-app-server'`）に `dedicated: true` と `config`（起こしたときの `-c`） |

`!` の行・ply_shell・Claude・agy・OpenCode・Codex の共有の app-server は 2a・段階 3 で載せてある。

## 付け直し（規則 ③。新しい手放す/引き取るの対は書かない）

- 起動の `readHolderSources` が、札と印（`turn`）を持つ子を拾う。ACP は子 1 つが 1 ターンなので、札の種類（`k`）の展開は要らない（`restoreTurn` の汎用の道）。Codex のターン専用は、共有の app-server と同じ展開（`expandCodexHeld`）が `dedicated` を見て、その子だけを話す `CodexRpc` を作る（`codexRpcForHeld`）
- ACP の付け直しは `initialize` も `session/new`・`session/load` も設定の適用も送らない。印から ack までの記録を再生して写し（`devin-normalize.mjs`・`grok-normalize.mjs`）を作り、続きを流す。走っている `session/prompt` の id は札にあり、応答の枠を開けて拾い直す
- 途中送信は、本文の応答の後に届く返答を閉じる前に待つ（札の `prompts` と `settleTrailing`）。渡った合図の前に依頼の id を札へ反映する（`acp-steer.mjs` の `onCall`）
- 承認・質問は、保持役の `jsonrpc` の控え（答えていない依頼）だけを attach で渡し直す。再生の履歴の答え済みの依頼は出し直さない（2b-6 の「答え済みの `control_request` を流し直さない」と同じ判断）

## サーバーの終わり

- サーバーは子を止めない。`codex-held.mjs`・`codex-rpc.mjs` の `process.once('exit')` から、保持役の子を kill する分を外した（アプリの終了は `exitAfterStoppingHeld` が止める。落ちた後は `keepMs` の保険）
- ターンが終わった ACP の子は、札と印を外してから止める（`endTurn` → `close`）。Codex のターン専用はターンの終わりに `rpc.stop()` で止める

## `.cmd` の包み

- `core/cli-installation.mjs` の `unwrapCommandShim` が、npm の包みの本文（`"%_prog%" "%dp0%\node_modules\…\bin\x.js" %*`）から中のスクリプトを解く。`directCommand` は `.cmd`/`.bat` を「node とスクリプト」の形に直す
- `spawnCli`・`cliCommand` と、保持役の各口（agy・Claude・Codex・OpenCode・ACP）が使う。解けない包みだけ今の流れ（shell: true）に落ちる

## 試験

- `node tests/run.mjs restart-acp --jobs 1`: Devin のツールの実行中（ゲート）・承認待ち、Grok のターンの途中・途中送信を、普通に止めて起こし直す（`tests/lib/restart.mjs` の `manual`）
- `node tests/run.mjs restart-codex-turn --jobs 1`: ターン専用の app-server のターン（ゲートしたツールの実行中）を、同じく止めて起こし直す
- `PLEIAD_TEST_RESTART=work` で既存の `server-devin` などを流すには、その suite のサーバーに `AGENT_HOST_RUNTIME_ROOT` を渡す必要がある（既定では置き場が無いので載せない）。今は専用の suite で確かめている
