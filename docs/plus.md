# Pleiad Plus

開発者が運営する公式の中継とアカウント（[ADR 0183](adr/0183-accounts-and-hosted-relay.md)）。自分の中継
（[docs/remote.md](remote.md)）はこのまま残り、Pleiad Plus は選べる道として足す。アプリにログインの方法を
選ぶ画面は置かない。方法を選ぶのはログインのページ（`https://account.pleiad.dev/login`）で、アプリは外の
ブラウザーへ開くだけ。

クライアントが使う api の口（`GET /v1/auth/config`・`POST /v1/auth/token`・`GET /v1/account`）と、
誤りの形 `{"error":{"code","message"}}` は公開の仕様。Firebase などのログインの基盤の値はアプリに
焼き込まず、`/v1/auth/config` から実行時に読む。

## Android

対象: `mobile/`（Capacitor の殻）。ログインの計算と更新の決まりは Android に依らない Kotlin（`remote-core` の
`dev.pleiad.app.plus`）に置き、単体試験は `./gradlew :remote-core:test` で回す。

### 設定は起動時に受け取る

- 起動時と、前面にいる間は 5 分ごとに `GET <api>/v1/auth/config` を読む。使う欄だけを読む:
  `state`・`token.projectId`・`token.apiKey`・`urls`（`login`・`account`・`profile`・`relay`・`refresh`）・
  `minClient.android`。それ以外の欄は読まない
- api のベースの URL は `BuildConfig.PLUS_API`（既定 `https://api.pleiad.dev`）。gradle のプロパティ
  `pleiadPlusApi` で debug のビルドだけ替えられる（release では替えられない）
- 読めないときは前に読んだ値（SharedPreferences `plus` の `config`。平文。秘密は無い）を使う。
  一度も読めていなければ、一覧の上の Plus の入口に「サーバーに接続できません」を出し、ログインのボタンは
  押せない
- `state` が `off` のときは Plus の入口を全部隠して今の見た目に戻る。`minClient.android` より古い版は
  「Pleiad を更新してください」を出す

### ログイン（Custom Tabs + PKCE）

1. 「Pleiad Plus にログイン」で、`verifier` = 32 バイトの乱数の base64url、`state` = 32 バイトの乱数、
   `challenge` = `base64url(SHA-256(verifier))`（RFC 7636）を作る
2. `verifier`・`state`・作った時刻を `KeystoreCipher`（別名 `pleiad-account-session`）で暗号化して
   SharedPreferences `plus` の `pending` に置く（Custom Tabs の間にプロセスが消えても戻れるように）。
   10 分で捨てる
3. `androidx.browser` の Custom Tabs で開く:
   `<urls.login>?client=android&redirect_uri=<enc(https://account.pleiad.dev/app/callback)>&state=…&code_challenge=…&code_challenge_method=S256&lang=<ja|en>`
4. 戻りは 2 つの道がある。どちらも `MainActivity` が `onCreate`・`onNewIntent` で 1 回だけ受ける:
   - **App Links**: `https://account.pleiad.dev/app/callback` の intent-filter（`autoVerify`）。
     検証のファイル（`assetlinks.json`）はサーバー側（account.pleiad.dev の `/.well-known/`）が出す
   - **予備**: App Links が確かめられないビルド（自分で署名したものなど）では、ページが
     「アプリに戻る」（`pleiad://auth?code=…&state=…`）を出す。`pleiad://auth` の intent-filter で受ける
5. `error` のクエリー・`state` が `pending` と合わない（定数時間で比べる）・`pending` が無いか 10 分を超えた
   → 「ログインできませんでした」と「もう一度」
6. コードをトークンに替える: `POST <api>/v1/auth/token`、本文 `{"code","codeVerifier","redirectUri"}`。
   `redirectUri` は戻り道に関わらずページに渡した `https://account.pleiad.dev/app/callback`。
   `400 invalid_grant` → 「ログインできませんでした」。ネットの誤り → 「サーバーへの接続に失敗しました」
7. ログイン中にもう一度押されたら、前の `pending` を捨てて新しく始める

### 保管と更新

- 保管するのは更新トークンだけ。`KeystoreCipher` で暗号化して SharedPreferences `plus` の `session` に
  `{refreshToken, uid, email, tokenProjectId, apiKey, savedAt}`。ID トークンはメモリだけ（保管に入らない）
- 更新: `POST <urls.refresh>?key=<apiKey>`（form、`grant_type=refresh_token&refresh_token=<…>`）。
  応答の `id_token`・`refresh_token`（替わったら保管し直す）・`expires_in` を使う
- ID トークンは期限の 5 分前に取り直す。同時に何本呼ばれても更新は 1 本にまとめる（single-flight）
- 更新が `400` で `error.message` が `TOKEN_EXPIRED`・`USER_DISABLED`・`USER_NOT_FOUND`・
  `INVALID_REFRESH_TOKEN` のどれか → 保管を消して「ログインしていません」にする
- ネットの誤り・5xx → 1 分おきに 5 回まで張り直す。その間は「サーバーへの接続に失敗しました」。
  5 回だめなら次に画面が表示されるまで待つ
- 起動時に、保管した `tokenProjectId` が `/v1/auth/config` の `token.projectId` と違えば保管を消し、
  「もう一度ログインしてください」を 1 度だけ出す
- ログアウト: 保管と `pending` を消し、メモリの ID トークンを捨てる。サーバーには何も送らない
- ログに出さない: ID トークン・更新トークン・`code`・`verifier`・`state`。誤りのログは HTTP の状態と
  `error.message` の種類だけ

### アカウントの状態と画面

- ログインしていて ID トークンがあるとき、`GET <api>/v1/account`（`Authorization: Bearer <ID トークン>`、
  `X-Pleiad-Client: android/<versionName>`）を、起動時・前面に戻ったとき（前に読んでから 60 秒たっていれば）・
  ログインの直後に読む。使う欄: `email`・`provider`・`status`・`limits.devicesPerHost`
- `401 unauthenticated` → ID トークンを 1 回だけ取り直して読み直す。まただめなら「ログインしていません」
- 画面のプラグインは `PleiadPlus`（`PleiadPlusPlugin.kt`）: `state()`・`login()`・`logout()`・
  `openAccount()`・`idToken()` とイベント `state`。`idToken()` は画面の JS には渡さず、Kotlin の中から使う
- ホストの一覧の上（「ホストを追加」の下）に Plus の入口を出す:

| 状態 | 一覧の上 | 右上 |
| --- | --- | --- |
| ログインしていない | 「Pleiad Plus にログイン」 | なし |
| ログイン中 | 「ログインしています…」 | なし |
| `plus` | （ホストの一覧） | 丸（メールの頭文字） |
| `free`・`disabled` | 「このアカウントでは公式の中継を使えません」と「アカウントを管理」 | 丸 |
| `maintenance` | 「Pleiad Plus はメンテナンス中です」 | ログイン中なら丸 |
| `update` | 「Pleiad を更新してください」 | ログイン中なら丸 |
| `off` | 何も足さない | なし |
| 設定を一度も読めていない | 「サーバーに接続できません」（ログインのボタンは押せない） | なし |
| 失敗 | 「ログインできませんでした」と「もう一度」／「サーバーへの接続に失敗しました」／「もう一度ログインしてください」 | 前の状態のまま |

- 右上の丸を押すとアカウントのシート（下から出る）: 丸とメールアドレス、`provider` が `google.com` なら
  「Google でログイン」、`apple.com` なら「Apple でログイン」、ほかは出さない。「アカウントを管理」は
  `urls.profile` を Custom Tabs で開く。「ログアウト」は確かめずにログアウトしてシートを閉じる
- ログインの方法のボタン（Google・Apple など）はアプリに置かない。購入・プラン・支払いへの道も置かない
