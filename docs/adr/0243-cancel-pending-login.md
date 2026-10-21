# 0243 待っているログインを、どの入口でも［やめる］で取りやめられるようにする

- 状態: 承認（2026-10-21）
- 関連: [0212](0212-claude-auth-expired.md)（ログインの期限切れと、会話の失敗の行の取り消し `authCancel`）、docs/design-system.md「ログインを待っている間」、docs/i18n-glossary.md（やめる）、docs/remote.md §7.3（リモートの窓はログインを始めない）

## 状況

- 設定 › エージェント設定のカードと初回の案内で［ログイン］を押すと、終わるまで「ログインを待っている」のままで、やめる手段が無かった。ブラウザーを閉じても、端末のコマンドを打たなくても、最長 10 分（Codex は 11 分）待たされ、その間は同じエージェントのログインをやり直せなかった（「ログインを待っています」で断られる）。
- やめる口（`authCancel`）は ADR 0212 で Claude の `claude auth login` にだけ作り、会話の失敗の行の［キャンセル］からしか使っていなかった。
- 端末のコマンドで入るエージェント（OpenCode・Antigravity・Devin・Grok）は、ログイン済みになるまでファイルや `auth status` を一定の間隔で見張るだけで、見張りを止める口が無かった。Codex は app-server の `account/login/start` の完了の通知を待つだけだった。
- 待っている間の URL は会話に一行で足され、設定の面には開く・写す入口が無かった。時間切れ・失敗も会話の一行で、どのカードの話か分かりにくかった。
- ほかの窓（リモートの窓も）は、別の窓が始めたログインが終わった・やめた・時間切れになったことを知れず、「ログインを待っている」のまま残ることがあった。
- Claude のアカウント（Pro・Max）の認可の URL は、いまの CLI では `claude.com` から始まる。CLI 2.1.303 の同梱コードで `CLAUDE_AI_AUTHORIZE_URL = https://claude.com/cai/oauth/authorize`（Console は `https://platform.claude.com/oauth/authorize`）を確かめた（資格情報には触れず、実行ファイルの中の文字列を読んだ）。Pleiad は `claude.ai`・`console.anthropic.com`・`platform.claude.com` だけを拾っていたので、`claude.com` の URL は画面に出なかった。

## 決定

モックで形を合意したうえで、次のとおりにする（形は design-system.md「ログインを待っている間」）。

- **語**: 待っているログインを取りやめる操作は、どの入口でも「やめる」（英語は Cancel）。会話の失敗の行の［キャンセル］も［やめる］にする。
- **全エージェントで `auth.cancel()`**: `authCancel` は `backend.auth.cancel()` を呼び、待っている `authLogin` は `code: 'CANCELLED'` の失敗で返る。
  - 端末のコマンドで入るエージェントは、見張り（`core/auth/login-watch.mjs` の `createLoginWatch`）を通して待つ。`cancel()` は次の確かめを待たずに見張りを起こして止める。待っていなければ `{ cancelled: false }`。
  - Codex は待ちを止めたうえで、app-server に `account/login/cancel`（そのログインの `loginId`）を送り、戻り先（localhost:1455）の待ち受けを閉じる。
  - Claude は今までどおり `claude auth login` の子を止める。
- **時間切れは `code: 'TIMEOUT'`**: 見張りの時間切れ・Codex の時間切れ・Claude の時間切れは、失敗とその `error` のイベントに `code: 'TIMEOUT'` を載せる。画面は「時間切れになりました（10 分）。」をカードの中に出す。それ以外の失敗は「ログインできませんでした: 理由」。
- **ほかの窓へのイベント**: サーバーは、やめたら `{ type: 'auth', phase: 'cancelled' }` を、エージェントが失敗のイベントを出さずに失敗したら `phase: 'error'`（`code` 付き）を全部の窓へ出す（同じ失敗を 2 度は出さない）。どの窓も、`url` で待っている様子と［やめる］を、`cancelled`・`error`・`done` で待ちを畳む。
- **画面**: 設定のカードと初回の案内の行は、待っている間に回る印と［やめる］、URL が届けば［ログインの画面を開く］［リンクをコピー］（コマンドならコマンドと［コピー］）を出す。やめたら一文は出さずに未ログインへ戻し、焦点を［ログイン］へ戻す。設定・初回の案内から始めたログインは、会話に URL の一行を足さない（会話の失敗の行から始めたものは今までどおり残す）。開いている設定・案内は、URL が届いても開き直さない（押した［やめる］から焦点を外さない）。
- **リモートの窓**: ［やめる］は押せる（`authCancel` は `authLogin` と同じアカウントの組の、人だけの命令）。URL・コマンドはホストの窓にだけ出す（ログインの戻り先はホストの PC）。
- **カードの「アカウントと接続先」**: 面の地・「接続」の見出し・面の［閉じる］をやめ、開け閉めはカードの右上のボタンだけにする（待っている間の入口と一文をカードの中に置くため、面の段を減らした）。
- **Claude の URL**: 拾うホストに `claude.com` を足す。

## 理由

- 10 分待つしかないと、間違えて押した・別のアカウントで入り直したい・ブラウザーを閉じた、のどれでもやり直せない。やめる口はすでに `authCancel` があり、全エージェントに広げるのが最小の変更だった。
- 見張りを 1 か所（`createLoginWatch`）にまとめたのは、4 つのエージェントが同じ「一定の間隔で確かめる」形で、やめる・時間切れの扱いを揃えるため。次の確かめまで待たずに止まらないと、押してから最大で間隔の分だけ「やめた」が遅れる。
- やめたことを一文で知らせないのは、利用者が自分で押した結果で、カードが「未ログイン」と［ログイン］に戻ることがそのまま答えになるため。やめたものを失敗として出すと、何かが壊れたように見える。
- 時間切れを `code` で見分けるのは、文面（エージェントごと・言語ごとに違う）に頼らずに同じ一文を出すため。
- ほかの窓へのイベントが無いと、別の窓で始めたログインが終わっても待ちの表示が残り、［やめる］を押しても何も起きない状態になる。

## 影響

- バックエンドの `auth` に `cancel()` が増える（Claude・Codex・OpenCode・Antigravity・Devin・Grok・fake）。`core/auth/login-watch.mjs` を足す。
- auth のイベントに `phase: 'cancelled'` が増え、`error` に `code` が載る。
- fake に、ログインを時間切れ・失敗にする `AGENT_HOST_FAKE_LOGIN_FAIL=timeout|<文>` を足す（`AGENT_HOST_FAKE_LOGIN_MS` で待たせて［やめる］を確かめる）。
- 文字列: `settings.agents` に `cancelLogin`・`cancelLoginLabel`・`openLoginPage`・`copyLink`・`linkCopied`・`copyCommand`・`commandCopied`・`loginTimedOut` を足し、`loginFailed` の形を変え、`loginFailedRetry`・`connections` を外す。
- 扱わないもの: MCP の OAuth、Pleiad Plus の URL を開き直す入口、スマホの Plus の［やめる］。
