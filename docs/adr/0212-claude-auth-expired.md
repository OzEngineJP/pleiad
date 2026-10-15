# 0212 Claude のログインの期限切れを見分け、その場でログインし直す

- 状態: 承認（2026-10-15）

## 状況

Claude Code の CLI のログイン（OAuth）の期限が切れると、会話は CLI のエラー文そのまま（`✕ 失敗 Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.`）で失敗していた。何を直せばよいかが分からず、設定の画面も「ログイン済み」のままだった（#53）。

調べて分かったこと（2026-10-15）:

- `claude auth status --json` は、トークンの期限が切れても `loggedIn: true` を返す。状態の確認では期限切れを知れない。
- Agent SDK は 401 を、assistant のメッセージの `error: 'authentication_failed'`（`SDKAssistantMessageError`）と、`subtype: 'success'`・`is_error: true`・`api_error_status: 401` の result で知らせ、そのあと `Claude Code returned an error result: …` の例外を投げる。result の `subtype` は success のままなので、`subtype` だけを見ていると成功に見える。
- Pleiad の「Claude のアカウント」（`claude setup-token` のトークンを `CLAUDE_CODE_OAUTH_TOKEN` で渡す）を使う会話は、CLI にログインし直しても直らない。
- 利用者は、Claude のデスクトップアプリに入っている別の Claude Code と、Pleiad が使う `claude` を取り違えやすい。

## 決定

モックで形を合意したうえで、次のとおりにする（形は design-system.md「ログインの期限切れ」）。

- **見分け方**: `core/backends/claude-normalize.mjs` が、assistant の `error: 'authentication_failed'` と、result の `is_error`・`api_error_status: 401` から印（`authFailed`。画面へは流さない。上限の `limit` と同じ扱い）を作る。`core/backends/claude.mjs` は、印があるか、印が無くても例外の文面が 401 の形（`isClaudeAuthError`: `authentication_failed`・`access token has expired`・`Failed to authenticate`・`API Error: 401`）なら、失敗の `turnResult` に `kind: 'auth'` を付ける。例外にならずに終わっても（`is_error` の result だけ）、成功ではなく同じ失敗で出す。
- **pristine**: 同じ `turnResult` に、このターンでツールの実行（`tool.start`）も返答の本文（`text.delta`）も出ていなかったかを付ける。
- **server**: `kind: 'auth'` の失敗に `backend` と `auth` を添える。CLI のログインの会話は `{ mode: 'cli', email }`（最後に読めたログイン中のアカウント）、アカウントのトークンの会話は `{ mode: 'token', accountId, name }`。互換の接続先の会話には添えない（接続先のキーの問題）。
- **期限切れの印はサーバーのメモリだけ**: CLI のログインの会話が 401 で失敗したら、バックエンドごとに覚える。`authStatus` はログイン済みのときだけ `expired: true` を返す。ログインし直す・ログアウトする・次の CLI のログインのターンが通ると消す。保存はしない。
- **ログインし直したあとの送り直し**: 次の 3 つがそろえば、失敗した発言を自動で 1 度だけ送り直す。失敗の行の［ログインし直す］から始めた・pristine・ログインし直したアカウントが前と同じ（メールアドレス。どちらかが分からなければ送らない）。送り直しは「再送信」と同じ、同じ会話の中で発言の手前まで巻き戻して送る形（`sendMessage` の `rewind`。[ADR 0102](0102-rewind-in-place.md)）。そろわなければ［もう一度送る］を出す（途中で切れたターンや後ろに発言があるときは、いつもの「再送信」の帯で消えるものを確かめる）。
- **ログインの取り消し**: 失敗の行の［キャンセル］のため、待っている `claude auth login` を止める WS のコマンド `authCancel` を足す（人だけ。`authLogin` と同じアカウントの組）。
- **CLI の在り処**: 設定の Claude の行の名前の下に、Pleiad が使う `claude` の実行ファイルのパス（ホームは `~`）を出す。版は出さず、説明（title）にだけ入れる（`authStatus` の `cliPath`・`cliVersion`。版は実体ごとに 1 回だけ `--version` を聞く）。失敗の行にはパスを出さない。

## 理由

- 文面だけに頼ると CLI の文言の変更で外れる。SDK の型に載った値（`authentication_failed`・`api_error_status`）を正にし、文面は印が届かない経路（例外だけが来る）の控えにした。
- `claude auth status` が期限切れを返さない以上、Pleiad が見た 401 を覚えておくしかない。保存すると、CLI の外（ターミナル）でログインし直したあとも古い印が残る。メモリなら再起動で消え、次の 401 でまた付くので、誤りは長く残らない。
- 自動の送り直しは、二重の実行と別のアカウントでの実行を避けるため、何も起きていない（最初の API 呼び出しで断られた）ターンを、同じアカウントで、利用者がその場で頼んだときに限った。巻き戻して送るのは、失敗した発言と失敗の返答が履歴に二重に残らないため。
- 版は更新のたびに変わり、行の見た目を揺らす。取り違えを防ぐのはパスで足りる。

## 影響

- `turnResult` に `kind`・`pristine`・`auth`・`backend` が増える（`core/protocol.mjs`）。`authStatus` に `cliPath`・`cliVersion`・`expired` が増える（画面の口だけ。操作の一覧の `agents.authStatus` の AI 向けの返りは変えない）。
- `authCancel` を WS のコマンドに足す（`core/ops/policy.mjs` のアカウントの組・`tests/ops-baseline.json` の human-only）。
- fake バックエンドに台本 `fail-auth`（`fail-auth tool` でツールの後に失敗）・`cliInfo`・`auth.cancel` と、ログインを遅らせる `AGENT_HOST_FAKE_LOGIN_MS` を足す。
- 失敗の行はほかの失敗の行と同じく会話の流れの中だけで、開き直すと出ない。Claude の履歴には CLI が書いた合成の返答（401 の文）が残り、開き直すとそれが返答として見える（今までどおり）。
- Codex・Antigravity のログインの期限切れは扱わない。
