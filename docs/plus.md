# Pleiad Plus

デスクトップの Pleiad を Pleiad Plus のアカウントで使うための土台（`core/plus/`）。

- ログインは外のブラウザー + ループバック + PKCE。アカウントは Pleiad Plus のアカウント
- 保管するのは更新トークンだけ。ID トークンはメモリに置く
- ログインの基盤の値（`projectId`・`apiKey`）はアプリに焼き込まない。起動時に `GET https://api.pleiad.dev/v1/auth/config` から受け取る

## 環境変数

| 名前 | 既定 | 意味 |
| --- | --- | --- |
| `AGENT_HOST_PLUS_API` | `https://api.pleiad.dev` | Pleiad Plus の api の基点。`https:` のほか、試験のために `http://127.0.0.1:<port>` と `http://localhost:<port>` だけを受ける。ほかの `http:` は起動時に警告を出して既定に戻す |
| `AGENT_HOST_PLUS_JWKS_URL` | `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` | ID トークンの公開鍵（JWKS） |
| `AGENT_HOST_PLUS` | なし | `0` なら Plus を全部隠す（`state: off` と同じ。自分でビルドする人のため） |

## `/v1/auth/config`（`core/plus/config.mjs`）

`GET <api>/v1/auth/config`（認証なし）。クライアントが使う欄は `state`・`token`（`projectId`・`apiKey`）・`urls`（`login`・`account`・`profile`・`relay`・`refresh`）・`minClient` だけ。ほかの欄は読まない。

- 覚えるのは 5 分。過ぎたら次に要るときに読み直す。同時の呼び出しは 1 本にまとめる
- 読めた値は `<data>/plus-config.json` にも書く（秘密は入っていない）。起動直後と、api に届かないときはこの写しを使う
- 写しも無く api にも届かないときは `state` を `null`（分からない）にする
- `state` は `on` / `maintenance` / `off`。`off` と `AGENT_HOST_PLUS=0` のときは状態の `available` を false にする（画面は入口ごと出さない）
- 今の版が `minClient.desktop` より古いときは `needsUpdate: true` にし、Plus の機能を使わない

## ログインの流れ（`core/plus/session.mjs`）

1. `code_verifier`・`state` を 32 バイトの乱数の base64url で作る。`code_challenge` = `base64url(SHA-256(verifier))`
2. `127.0.0.1` のランダムなポートに `/callback` の受け口を立てる（立てられなければ `localhost`）。10 分で閉じる
3. 外のブラウザーで `<urls.login>?client=desktop&redirect_uri=<enc>&state=<state>&code_challenge=<c>&code_challenge_method=S256&lang=<ja|en>` を開く
4. `/callback?code=…&state=…` を受けたら `state` を定数時間で照合し、ページに「ログインしました」を返して受け口を閉じる
5. `POST <api>/v1/auth/token`（認証なし）に `{"code","codeVerifier","redirectUri"}` を送る
6. `error`・`state` の不一致・期限切れ・交換の失敗は `login.phase: 'failed'` にする
7. ログインの途中にもう一度 `login()` が呼ばれたら、前の試みを捨てて新しく始める
8. `cancelLogin()` は受け口を閉じて `idle` に戻す

`state` が `maintenance` のとき・`needsUpdate` のときは `login()` を始めない（`PlusError({ code: 'maintenance' })` / `{ code: 'update' }`）。

## 保管と更新

- `<data>/plus-secrets.json`（ほかの秘密と同じ `secretCipher`）の鍵 `plus:session` に `{ refreshToken, uid, email, tokenProjectId, apiKey, savedAt }`
- `getIdToken({ force })` は期限の 5 分前を過ぎていたら取り直す（single-flight）
- 取り直しは `POST <urls.refresh>?key=<apiKey>`（form: `grant_type=refresh_token&refresh_token=<…>`）。`refresh_token` が替われば保管し直す
- `400` で `TOKEN_EXPIRED`・`USER_DISABLED`・`USER_NOT_FOUND`・`INVALID_REFRESH_TOKEN` なら保管を消して未ログインにする
- ネットの誤りは 1 分おきに 5 回まで取り直す。その間 `reachable: false`。5 回で諦めたら次に要るときにまた始める
- 保管した `tokenProjectId` が config の `token.projectId` と違うときは保管を消して `error: { code: 'relogin' }` にする
- ログアウトは ID トークンを捨てて保管を消すだけ（api には送らない）
- 保管が読めない（`SECRET_LOCKED`・`SECRET_FILE_BROKEN`）ときは消さずに `error: { code: 'locked' }`

## api を呼ぶ手（`core/plus/client.mjs`）

`createPlusClient({ config, getIdToken, appVersion, fetchFn })` → `request(method, path, { body, auth = true, signal })`。

- ヘッダーは `X-Pleiad-Client: desktop/<版>`。`auth` のときは `Authorization: Bearer <ID トークン>`
- 本文は JSON。10 秒で打ち切る
- 誤りは `{"error":{"code","message"}}` を `PlusError`（`status`・`code`・`message`・`retryAfter`・`resetAt`）にして投げる。本文が読めない・ネットの誤りは `code: 'network'`
- `401 unauthenticated` は ID トークンを 1 回だけ取り直してやり直す。2 回目も 401 ならセッションを `relogin` にする
- `403 account_disabled` は覚えているアカウントの `status` を `disabled` にする

## 状態と知らせ

`status()` が返す形（秘密は入れない）:

```js
{
  available: true,          // false = state off か AGENT_HOST_PLUS=0
  state: 'on',              // 'on' | 'maintenance' | 'off' | null（分からない）
  needsUpdate: false,
  signedIn: true,
  login: { phase: 'idle' }, // 'idle' | 'waiting' | 'finishing' | 'failed'
  account: { uid, email, provider, status, plan, limits, usage, sync } | null,
  reachable: true,          // false = サーバーに届かない（account は最後に知った値）
  error: null,              // { code: 'relogin' | 'locked' } | null
  urls: { account, profile },
  host: null,               // この PC の登録の結果（この段階では常に null）
  checkedAt: '...'
}
```

変わるたびに `onChange(fn)` で `fn({ type, status })`（`type` は `config`・`signedIn`・`signedOut`・`account`・`login`）。サーバーは変わるたびに全接続へ `{ type: 'plusStatus', status }` を送る。`setHost(host)` は後の段階が呼ぶ。

`GET <api>/v1/account` は起動したとき・ログインした直後・画面が `{ refresh: true }` で状態を求めたとき（30 秒に 1 回まで）・ログイン中は 15 分ごとに読む。読めなかったときは前の値を残して `reachable: false`。

## WS のコマンド

| コマンド | 入力 → 出力 | 誰が |
| --- | --- | --- |
| `plusStatus` | `{ refresh? }` → 上の状態 | 操作 `plus.status`（risk `read`）を通す。agent には `account.email` と `account.uid` を伏せる |
| `plusLogin` | `{}` → `{ started: true }` | 人だけ |
| `plusLoginCancel` | `{}` → 状態 | 人だけ |
| `plusLogout` | `{}` → 状態 | 人だけ |

## 設定 › Pleiad Plus（`web/plus-settings.mjs`）

設定のメニューに「Pleiad Plus」を足す。`status.available === false` のときは項目ごと出さない（ページにも行けない）。ページを開いたとき `plusStatus { refresh: true }` を送り、開いている間は `plusStatus` イベントで描き直す。画面は表示とコマンドを送ることだけをする。状態から DOM を作る `renderPlus` は純粋な関数（`tests/lib/dom-stub.mjs` で試験できる）。

- 上から順に当てはめる: `needsUpdate`（更新の 1 行だけ）→ `state: maintenance`（メンテナンスの行。ログイン中ならアカウントの行だけ）→ ログインの途中（`waiting`・`finishing`。「やめる」で `plusLoginCancel`）→ ログインの失敗（「もう一度」で `plusLogin`）→ `error.code: locked`（保管が読めない文言）→ `signedIn: false`（「ログイン」。`error.code: relogin` なら「もう一度ログインしてください」）→ `account.status`（disabled / free / plus）
- `reachable === false` のときは、当てはまった中身の上に「サーバーへの接続に失敗しました」の 1 行を足す（⚠ は付けない）
- アカウントの行は丸（メールの頭の 1 文字・大文字）・メール・入り方（`provider === 'google.com'` のときだけ「Google でログイン」）。プランの行は `account.plan.name`（無ければ「Pleiad Plus」）か「無料」
- 今月の利用（`plus` かつ `usage`・`limits` があるとき）: 「今月の利用: {used} / {limit} クレジット（{date} に戻ります）」。数は `Intl.NumberFormat`、日付は `Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric' })`。`used >= limit` ならその下に「上限に達しました」
- 同期の置き場は `<div id="plusSyncSection">`（見出しは隠してある。中身は同期の画面の issue が入れる）
- この PC の行は `host.state` が `taken`（「つなぎ直す」→ 確かめの窓 → `plusHostRebind`）・`limit` のときだけ。ほかは出さない。`plusHostRebind` は後の段階が作る。知らないコマンドが返ったら何も出さない
- 「Pleiad Plus にする」は `urls.account` に `/plus` を足した URL を、「アカウントを管理」は `urls.account` を外のブラウザーで開く。「ログアウト」は `plusLogout`

## ID トークンの検証（`core/plus/verify.mjs`）

`createIdTokenVerifier({ jwksUrl, projectId, now, fetchFn })` → `verify(token)` → `{ uid, email }`。合わなければ `PlusError({ code: 'bad_token' })`。

1. ヘッダー: `alg` が `RS256`、`kid` が JWKS にある
2. ペイロード: `iss` = `https://securetoken.google.com/<projectId>`、`aud` = `<projectId>`、`exp` > いま − 60 秒、`iat` ≤ いま + 60 秒、`sub` が空でない
3. `projectId` は `/v1/auth/config` の `token.projectId`（呼ぶたびに今の値を使う）
4. JWKS は `Cache-Control` の `max-age` の間だけ覚える。知らない `kid` が来たら 1 分に 1 回まで読み直す
5. 署名は `crypto.createPublicKey({ key: jwk, format: 'jwk' })` と `crypto.verify('RSA-SHA256', …)` で確かめる

## ログに出さない

`core/plus/*` は ID トークン・更新トークン・`code`・`codeVerifier`・`state` の値を、ログにも誤りの文にも書かない。`core/redact.mjs` の規則が、名前付きの値（`idToken`・`refreshToken`・`id_token`・`refresh_token`・`codeVerifier`・`code_verifier`）・ヘッダー `X-Pleiad-Account`・JWT の形・URL のクエリの `code=`・`state=`・`refresh_token=` を伏せる（誤りの code は伏せない）。

## 試験: 偽の Plus（`tests/lib/fake-plus.mjs`）

`startFakePlus(opts)` → `{ url, jwksUrl, state, issueIdToken(uid, extra?), route(method, pattern, handler), close() }`。試験は `AGENT_HOST_PLUS_API` にこの URL を渡す。本物の api には送らない。

- `GET /v1/auth/config`（`state`・`token`・`minClient` は `state` から変えられる）・`/login`（`state.nextLogin` に従い 302）・`/v1/auth/token`（verifier・redirectUri・期限・1 回きりを照合）・`/v1/token`（更新）・`GET`/`PATCH /v1/account`（`state.accounts[uid]`、無い uid は `free`）
- `state.down = true` の間は全部の口が接続を切る（届かない場合の試験に使う）
- 呼ばれた口と `X-Pleiad-Client` を `state.calls` に残す
- `route()` で、あとの機能（この PC の登録・キー無しの機能・同期）が口を足せる

## iOS

この段階の iOS のアプリは Pleiad Plus に対応しない。`pleiad://auth` を受けても「まだ使えません」と記録するだけで、画面にもホストの窓にも触れない。ログインを足すときの流れ:

1. Android と同じログインのページを `ASWebAuthenticationSession`（`callbackURLScheme` は `pleiad`）で開き、`client=ios`・`redirect_uri=pleiad://auth` を渡す。
2. 戻りの `pleiad://auth?code=…&state=…` を `SceneDelegate` の受け口（`offerLink`）で受け、`state` を照合してから `POST https://api.pleiad.dev/v1/auth/token` に `{code, codeVerifier, redirectUri: "pleiad://auth"}` を送ってトークンに替える。
3. ログインに使う設定（`token.projectId`・`token.apiKey`・`urls`・`minClient`）はアプリに焼き込まず、起動時に `GET https://api.pleiad.dev/v1/auth/config` から受け取る。Firebase の SDK と `GoogleService-Info.plist` は足さない。
4. 保管は更新トークンだけを Keychain（`KeychainVault`）に `{refreshToken, uid, email, tokenProjectId, apiKey, savedAt}` の形で置き、ID トークンはメモリにだけ置く。更新の決まり（期限の 5 分前に取り直す・同時に呼ばれても 1 本にまとめる・`400` の `TOKEN_EXPIRED`・`USER_DISABLED`・`USER_NOT_FOUND`・`INVALID_REFRESH_TOKEN` なら保管を消す）は Android と同じ。
5. `minClient` に `ios` の欄が増えたらそれに従う。

審査の注意（ログインを入れると Sign in with Apple とアカウントの削除の道が要る）は [ios.md](ios.md) の冒頭の段落を参照。
