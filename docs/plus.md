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
  host: null,               // この PC の登録の結果（下の「この PC の登録」。{ state, hostId, error }）
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

## キー無しの機能（仮想のキー `plus`）

Pleiad Plus にログインしていれば、自分の OpenRouter のキーが無くても「委譲先の自動選択」と「音声通話」が動く。台帳（`core/api-keys.mjs`）に値を持たない仮想のキー `plus`（`{ id: 'plus', provider: 'plus', label: 'Pleiad Plus', virtual: true }`）がいて、`judge:jev` と `voice` にだけ選べる（ほかの使い道は `UNSUPPORTED_USE`）。削除・名前の変更・値の確認・probe の対象にはならない。

- ログインしたとき、委譲先の自動選択と音声通話の**両方**が「使わない」なら、両方に `plus` を自動で選ぶ（`onChange` に `{ uses: ['judge:jev', 'voice'], autoPlus: true }`）。どちらかでもキーを選んでいれば何もしない。ログアウトしても選択は消さない。
- 使う側は `apiKeys.useEndpoint(use)` が返す `{ kind, baseUrl, authorization }` で送る。`useKey` は `plus` に対して `null` を返し続ける（値が無いので）。`hasUse` は送り先があるときだけ true。
- `kind: 'openrouter'`（自分のキー）: `baseUrl` は OpenRouter（`AGENT_HOST_OPENROUTER_API`・`AGENT_HOST_VOICE_API`）、`authorization` は `Bearer <キー>`。
- `kind: 'plus'`: `baseUrl` は `<PLUS_API>/v1/proxy/openrouter`（判定）・`<PLUS_API>/v1/proxy/voice`（通話）。`authorization()` は送るたびに `session.getIdToken()` で ID トークンを取る（覚えない）。取れなければ `ApiKeyError('PLUS_SIGNED_OUT')` を投げる。`AGENT_HOST_OPENROUTER_API` は効かない。
- `plus` の送り先は、ログアウト・アカウントの `status` が `free` か `disabled`・`/v1/auth/config` の `state` が `off` か `maintenance` なら `null`（「キーが無い」と同じ扱い）。

中継の誤りは `{"error": {"code", "message", "resetAt?"}}` の `code` で扱いを決める（本文・トークンは誤りの文に出さない）:

| `code` | 判定（`delegation-judges.mjs`） | 通話（`core/voice/`） |
| --- | --- | --- |
| `credit_exhausted`（429。`resetAt` つき） | もう一方の判定も試さず難しさ `mid`。`resetAt` までは送らず `credit_exhausted` で `mid`（`resetAt` を過ぎるか、アカウントの読み直しが上限未満を示すまで）。覚えた値は `apiKeys.plusCredit()`／`delegationRouting` の `limit` に出る | 通話の前なら始めない（`{ t:'error', code:'credit_exhausted', resetAt, fatal }`）。途中なら通話を終える。やり直さない・予備のモデルへ送らない |
| `rate_limited`（429） | 試し直さず `mid` | 今の 429 と同じにやり直す |
| `not_plus`・`account_disabled`（403） | `mid`・セッションにアカウントを読み直させる | 通話を終える（`code` はそのまま） |
| `unauthenticated`（401） | ID トークンを 1 回だけ取り直して送り直す。取り直せなければ `mid` | 同じく 1 回だけ取り直して送り直す |
| `upstream_error`（502） | 今の 5xx と同じ（もう一方を試す） | 今の 5xx と同じ（1 回やり直す） |

判定は `plus` のときだけ待ち時間の上限を 8 秒にする（`PLUS_JUDGE_TIMEOUT_MS`。OpenRouter のままなら 3 秒）。通話が続いている間に ID トークンが替わっても切らない（キーの変わりを比べる印は `kind` と `uid`）。

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

## この PC の登録（`core/plus/hosts.mjs`）

リモートで使うために、この PC を鍵を持っている証明つきで api のホストの台帳（`GET /v1/hosts`）に載せる。

- いつ: 起動したとき・ログインした直後・アカウントが変わったとき・ホストの鍵（identity）を作った直後。`signedIn` で `account.status === 'plus'` のときだけ行う
- 手順: `GET /v1/hosts` で自分の `hostId`（`base32(SHA-256(公開鍵))` の先頭 26 字）を探す。あって公開鍵が同じなら違う欄だけ `PATCH`。無ければ `POST /v1/hosts/challenge { hostId, publicKey }` で `{ challengeId, nonce, serverPublicKey }` を受け、`proof = base64url(HMAC-SHA256(HKDF-SHA256(X25519(ホストの秘密鍵, serverPublicKey), "pleiad host proof v1"), nonce ‖ utf8(hostId) ‖ utf8("register")))` を作って `PUT /v1/hosts/{hostId}`（`{ challengeId, proof, publicKey, name, platform: win32|darwin|linux, appVersion }`。`name` は `cfg.hostName` を 1〜64 字に整えたもの。`syncPublicKey` はこの段階では送らない）
- その後: ホスト名が変わったら `PATCH { name }`、`via:'plus'` の端末の数が変わったら `PATCH { deviceCount }`（0〜64）
- 誤り（`status.host = { state, hostId, error }` で出す。`state`: `none`・`registering`・`registered`・`taken`・`limit`・`error`）:
  - `409 host_taken`（同じ hostId がほかのアカウントのもの）→ `taken`。自動ではやり直さない。人の「つなぎ直す」（`plusHostRebind`。人だけ）でホストの鍵を作り直し、端末を全部取り消し、新しい hostId で登録し直す
  - `429 host_limit` → `limit`（アカウントのホスト数の上限）
  - `422 bad_proof` → 新しい challenge で 1 回だけやり直す（だめなら `error`）
  - ネットの誤り・5xx → `error` で 1 分おきにやり直す

## Plus のつながり（`core/remote/plus-link.mjs`。docs/remote.md §6.4）

- 張るのは「ほかの端末からの操作を許可する」（`enabled`）・`signedIn`・`account.status === 'plus'`・`remote/settings.json` の `plus.connect`（既定 false。`setRemoteSettings { plusConnect }` で入れる。人だけ）・登録が `registered`、が全部そろったとき
- 行き先は `/v1/auth/config` の `urls.relay`。ヘッダーは `{ 'x-pleiad-host': hostId, 'x-pleiad-account': <ID トークン> }`（張るたびに取る）。中継の中身は Noise の暗号のまま（own と同じ）
- `remoteStatus.plus = { connect, link: { state, error, since, retryAt }, host: { state, error }, devices }`
- 中継が制御用の接続を閉じたとき: `4401 'account'` → 張り直さない（link の error `account`）。`4429 'account limit'` → `limit`。ほかの `4401` → ID トークンを取り直して 1 回だけ張り直す（また `4401` なら `auth`）。`1013` → 今の backoff で張り直す。ほか → 今と同じ。`account`・`accountStatus`・`plus.connect`・`enabled`・登録・ログインが変わったときに ready() から見直す
- `revoke` は両方の link（own・plus）へ送る

## 端末の受け入れ（同じアカウント。ADR 0240）

- 端末は `/v1/device` に `X-Pleiad-Host`・`X-Pleiad-Account`（ID トークン）だけでつなぐ（deviceId・ペアリング無し）。中継の差し込みが `admit: true` で通すと、ホストが accept を張り、Noise_IK の応答側になる
- 端末はメッセージ 1 に `{ proto, name, platform, app, plus: { idToken } }` を入れる。ホストは `plus.idToken` を自分で検証し、uid が今のアカウントと同じときだけ進める。断りは `{ type: 'denied', reason }`（`account`・`devices`・`unavailable`・`rate`）を暗号の中で送って閉じる
- 同じ公開鍵の `via:'plus'` の端末は置き換える（数に入れない）。`limits.devicesPerHost` を超える・一度も読めていない・この 1 時間の受け入れが 20 回を超える、は断る
- 端末の `{ type: 'admit' }` を受けたら `deviceId` と中継用トークンを発行し、`via:'plus'`・`plusUid` で登録、`{ type: 'approved', deviceId, token, hostName }` を返して 1000 で閉じる。`PATCH deviceCount` も追う
- 公式の中継はペアリングを受けない（`4401 'pairing disabled'`。ホスト側も受けない）
- 登録した端末がつなぐのは、`deviceId`・中継用トークン・`X-Pleiad-Account` を付けた通常の接続。ホストは `via:'plus'` かつ `plusUid` が今の uid のものだけを受ける

## 止める・ログアウト

- `plus.connect` を切る → plus の link だけ閉じる（端末の記録は残す）
- `account.status` が `plus` でなくなる（free・disabled）→ link は閉じるが記録は残す（戻ればまた張る）
- ログアウト・ほかのアカウントへの切り替え → `via:'plus'` の端末を全部取り消し、link を閉じる
- `enabled`（ほかの端末からの操作を許可する）を切る → 全部の link を閉じる（own も）

## 試験: 偽の Plus（`tests/lib/fake-plus.mjs`）

`startFakePlus(opts)` → `{ url, jwksUrl, state, issueIdToken(uid, extra?), route(method, pattern, handler), close() }`。試験は `AGENT_HOST_PLUS_API` にこの URL を渡す。本物の api には送らない。

- `GET /v1/auth/config`（`state`・`token`・`minClient` は `state` から変えられる）・`/login`（`state.nextLogin` に従い 302）・`/v1/auth/token`（verifier・redirectUri・期限・1 回きりを照合）・`/v1/token`（更新）・`GET`/`PATCH /v1/account`（`state.accounts[uid]`、無い uid は `free`）
- `state.down = true` の間は全部の口が接続を切る（届かない場合の試験に使う）
- 呼ばれた口と `X-Pleiad-Client` を `state.calls` に残す
- `route()` で、あとの機能（この PC の登録・キー無しの機能・同期）が口を足せる
- ホストの台帳: `GET /v1/hosts`・`POST /v1/hosts/challenge`・`PUT`/`PATCH`/`DELETE /v1/hosts/{hostId}`（証明は本物と同じく X25519+HKDF+HMAC で照合し `state.hosts` に残す。`state.failNextProof` で次の 1 回だけ 422 bad_proof）

中継側の「公式の中継」の身代わりは `tests/lib/plus-relay-authz.mjs`（中継に差し込む authz。`X-Pleiad-Account` の確かめ・ペアリングの断り・`admit: true`。`remote-plus.mjs` が一連の流れを確かめる）。

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
  `openAccount()` とイベント `state`。ID トークンは `PlusManager.currentIdToken()` からネイティブ側だけで使う
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

### Android のホスト一覧と接続

- ログイン中でアカウントが `plus` のとき、`GET <api>/v1/hosts` を読み、ホスト名・オンライン状態・最後に見えた時刻を一覧へ反映する。取得に失敗したら前回の一覧を残して「サーバーへの接続に失敗しました」を出す。`403 not_plus` または `account_disabled` なら Plus の行を隠し、「このアカウントでは公式の中継を使えません」を出す。
- 自前の中継と Plus のホストは見出しで分けず、`hostId` ごとに 1 行にまとめる。自前の記録と Plus の記録が両方ある行は、Plus が使えるとき Plus で開き、使えないときは自前で開く。最後に使った時刻が新しい行を先にし、まだ使っていない Plus のホストは API の順に後ろへ置く。
- 行名はホスト名を使い、この端末で付けた名前があればそちらを優先する。Plus の行では名前を変えられる。Plus の記録は端末側から削除できない。自前の記録もある行では、自前の記録だけを削除できる。
- ログイン後にホストが 1 台も無いときは、同じアカウントでログインした PC がここに並ぶ案内と「ホストを追加」を出す。ログアウト、利用資格の変更、Plus の停止中は Plus の行を表示しない。Plus の記録は端末内に残り、再び利用できるときに使う。
- Plus のホストを初めて開くと、公開鍵から `hostId` を確かめて Noise IK で接続する。相手の静的鍵はホスト一覧の公開鍵を使い、確認コードやホスト側での承認は使わない。受け入れが完了したら `deviceId` とトークンを暗号化して記録し、通常の接続を張る。失敗時は `account` を公式の中継が使えない、`devices` を上限、`rate` を 60 秒後に 1 回だけ再試行、`unavailable` をサーバー接続失敗として扱う。
- 通常の接続と通知の線は、記録した device token と、接続ごとに取得した ID トークンを送る。ID トークンを取得できないときは接続しない。

閉じたときの扱い:

| WebSocket の閉じ方 | 端末の状態と動作 |
| --- | --- |
| `4404` | オフライン。通常の間隔で再接続 |
| `4401` `revoked` / `device token` | 保存を捨て、受け入れを 1 回だけやり直す |
| `4401` `account` | 接続を止め、「このアカウントでは公式の中継を使えません」 |
| `4401` `token` | ID トークンを取り直して 1 回再接続。続けて失敗したら止める |
| `4401` `plus off` | オフラインとして通常の間隔で再接続 |
| `4401` `plus unavailable` | 一時停止し、設定を読み直す。利用可能になるまで自動接続しない |
| `4429` `account limit` | 接続を止め、「このアカウントの上限に達しています」 |
| `4429` `admit rate` / `1013` | オフラインとして再接続 |

## iOS

この段階の iOS のアプリは Pleiad Plus に対応しない。`pleiad://auth` を受けても「まだ使えません」と記録するだけで、画面にもホストの窓にも触れない。ログインを足すときの流れ:

1. Android と同じログインのページを `ASWebAuthenticationSession`（`callbackURLScheme` は `pleiad`）で開き、`client=ios`・`redirect_uri=pleiad://auth` を渡す。
2. 戻りの `pleiad://auth?code=…&state=…` を `SceneDelegate` の受け口（`offerLink`）で受け、`state` を照合してから `POST https://api.pleiad.dev/v1/auth/token` に `{code, codeVerifier, redirectUri: "pleiad://auth"}` を送ってトークンに替える。
3. ログインに使う設定（`token.projectId`・`token.apiKey`・`urls`・`minClient`）はアプリに焼き込まず、起動時に `GET https://api.pleiad.dev/v1/auth/config` から受け取る。Firebase の SDK と `GoogleService-Info.plist` は足さない。
4. 保管は更新トークンだけを Keychain（`KeychainVault`）に `{refreshToken, uid, email, tokenProjectId, apiKey, savedAt}` の形で置き、ID トークンはメモリにだけ置く。更新の決まり（期限の 5 分前に取り直す・同時に呼ばれても 1 本にまとめる・`400` の `TOKEN_EXPIRED`・`USER_DISABLED`・`USER_NOT_FOUND`・`INVALID_REFRESH_TOKEN` なら保管を消す）は Android と同じ。
5. `minClient` に `ios` の欄が増えたらそれに従う。

審査の注意（ログインを入れると Sign in with Apple とアカウントの削除の道が要る）は [ios.md](ios.md) の冒頭の段落を参照。
