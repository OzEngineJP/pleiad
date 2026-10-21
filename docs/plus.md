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
| `AGENT_HOST_PLUS` | なし | `0` なら Plus を全部隠す（`state: off` と同じ。自分でビルドする人のため）。`1` なら `visibility: optin` の間でも端末の印が無くても入口を出す（開発と試験のため） |

## `/v1/auth/config`（`core/plus/config.mjs`）

`GET <api>/v1/auth/config`（認証なし）。クライアントが使う欄は `state`・`visibility`・`token`（`projectId`・`apiKey`）・`urls`（`login`・`account`・`profile`・`relay`・`refresh`）・`minClient` だけ。ほかの欄は読まない。

- 覚えるのは 5 分。過ぎたら次に要るときに読み直す。同時の呼び出しは 1 本にまとめる
- 読めた値は `<data>/plus-config.json` にも書く（秘密は入っていない）。起動直後と、api に届かないときはこの写しを使う
- 写しも無く api にも届かないときは `state` を `null`（分からない）にする
- `state` は `on` / `maintenance` / `off`。`off` と `AGENT_HOST_PLUS=0` のときは状態の `available` を false にする（画面は入口ごと出さない）
- `visibility` は `public` / `optin`。`optin` の間は、その端末に「入口を出す」印（下の「入口を出すリンク」）が無い限り `available` を false にする。欄が無い・知らない値は `optin` として扱う
- 今の版が `minClient.desktop` より古いときは `needsUpdate: true` にし、Plus の機能を使わない

## 入口を出すリンク（`pleiad://plus/enable`・`pleiad://plus/disable`）

`visibility: optin` の間、Plus の入口は端末ごとに隠れている。その端末で `pleiad://plus/enable` を開くと
「入口を出す」印が立ち、設定のメニューの Pleiad Plus・委譲・通話・リモートの Plus のまとまり・初回の案内の行が
出るようになる。`pleiad://plus/disable` で印を外す。`visibility: public` の間は印に関係なく出る。
ログインの状態・セッションは印とは別に残る。印を外してもログアウトしない。

- 印の置き場（どちらもその端末だけ。同期・バックアップの対象外）:
  - デスクトップ・サーバー: `prefs.plus.entrance`（`core/ops/settings.mjs` の `plus` 設定は `sync: false`）
  - Android: SharedPreferences `plus` の `entrance`（`PlusStore`）
- デスクトップは `pleiad` プロトコルを OS に登録する（electron-builder.yml の `protocols`、MSIX は
  build/appx-manifest.xml の Extensions、実行時は `app.setAsDefaultProtocolClient` をパッケージ版だけ）。
  main が argv（Windows・Linux の単一インスタンス・初回起動）と `open-url`（macOS）からリンクを拾い、
  `{ type: 'plus-entrance', action }` でサーバーへ渡す（desktop/plus-link.cjs）。ほかの `pleiad://…` は無視する
- リンクを受け取ったら主の窓を前に出す（起動前に届いた分は起動後に流す）
- ほかのプラットフォーム（iOS）は対象外

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
  accountReadAt: 1760000000000 | null, // GET /v1/account を最後に読めた時刻（ms。読めなかった・403 のときは進まない）
  uid: '...' | null,        // 保管したログインの uid（account を読む前から分かる。中継・同期が使う）
  email: '...' | null,      // 保管したログインのメール（account を読む前の画面のアカウントの行に使う）
  reachable: true,          // false = サーバーに届かない（account は最後に知った値）
  error: null,              // { code: 'relogin' | 'locked' } | null
  urls: { account, profile },
  host: null,               // この PC の登録の結果（下の「この PC の登録」。{ state, hostId, error }）
  checkedAt: '...'
}
```

変わるたびに `onChange(fn)` で `fn({ type, status })`（`type` は `config`・`signedIn`・`signedOut`・`account`・`login`）。サーバーは変わるたびに全接続へ `{ type: 'plusStatus', status }` を送る。`setHost(host)` は後の段階が呼ぶ。

`GET <api>/v1/account` は起動したとき・ログインした直後・画面が `{ refresh: true }` で状態を求めたとき（30 秒に 1 回まで）・ログイン中は 15 分ごとに読む。読めなかったときは前の値を残して `reachable: false`。ログインでトークンを交換できたら `reachable: true` に戻す（前に届かなかった印が残ると、account を読むまでの間もプランが「読み込めませんでした」になるため）。

## WS のコマンド

| コマンド | 入力 → 出力 | 誰が |
| --- | --- | --- |
| `plusStatus` | `{ refresh? }` → 上の状態 | 操作 `plus.status`（risk `read`）を通す。agent（`pleiad plus status`・ply_control・`pleiad mcp`）には `uid`・`account.uid`・`account.email` を伏せる。Plus の行を混ぜて返す `voice.status` の `plus`・`delegation.routing` の `keys.*.plus` も、agent には `email` を伏せる（`core/ops/plus.mjs` の `plusIdentityShown`） |
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

## 画面の行（`web/plus-key-row.mjs`）

設定 › 委譲の「委譲先の自動選択に使うキー」と設定 › 通話の「使うキー」は、どちらも見出し＋ラジオの行（`role=radiogroup`・`role=radio`）。Pleiad Plus が上、OpenRouter が下。サーバーは画面に `via`（`'plus'`・`'key'`・`null`）・`hasKey`・`keyRef`・`plus` を返す（`plus` は `state`・`signedIn`・`status`・`email`・`reachable`・`limitReached`・`resetAt`・`profileUrl`。キーの値・ID トークン・更新トークンは返さない）。

- ログイン中: メールと状態。上限（`limitReached`）なら「今月の上限に達しました（{date} に戻ります）」を行の下に足す。選んでもよい
- `signedIn: false`: 「ログインしていません · ログイン」（［ログイン］で `plusLogin`）。選べない
- `account.status` が `free`・`disabled`: 「Pleiad Plus を使っていません」。選べない
- ログイン中で `status` がまだ無い（アカウントを読んでいる）: 場所取り（`.rm-skel`、読み上げは「読み込んでいます」）。`reachable === false` なら「読み込めませんでした」。どちらも「使っていません」とは言わない。選べない（2026-10-21 承認）
- `state` が `off`・`maintenance`、`available === false`、`AGENT_HOST_PLUS=0`: 行ごと出さない
- 選んだ印（`uses` の `plus`）は残し続ける。ログアウト・`free`・`disabled` になっても OpenRouter へすげ替えない（効き目は「キーが無い」と同じ — `endpointFor` が `null` を返す）
- 通話の設定では、選んでいて `limitReached` のとき、行の下に「今月の Pleiad Plus の上限に達したため、通話を始められません。」と「アカウントを管理」（`profileUrl` を外へ開く）を出す。通話の画面でも、始める前・途中の `credit_exhausted` は同じ文言の通知で終わる（やり直さない・ほかへ送らない）。`not_plus`・`account_disabled` は「このアカウントでは公式の中継を使えません」

## 設定 › Pleiad Plus（`web/plus-settings.mjs`）

設定のメニューに「Pleiad Plus」を足す。`status.available === false` のときは項目ごと出さない（ページにも行けない）。項目の出し入れと開いているページのために、接続が ready になったあと（つなぎ直しを含む）に `plusStatus` を取る（起動の直後は WS がまだ開いていない）。ページを開いたとき `plusStatus { refresh: true }` を送り、開いている間は `plusStatus` イベントで描き直す。画面は表示とコマンドを送ることだけをする。状態から DOM を作る `renderPlus` は純粋な関数（`tests/lib/dom-stub.mjs` で試験できる）。

- 上から順に当てはめる: `needsUpdate`（更新の 1 行だけ）→ `state: maintenance`（メンテナンスの行。ログイン中ならアカウントの行だけ）→ ログインの途中（`waiting`・`finishing`。「やめる」で `plusLoginCancel`）→ ログインの失敗（「もう一度」で `plusLogin`）→ `error.code: locked`（保管が読めない文言）→ `signedIn: false`（「ログイン」。`error.code: relogin` なら「もう一度ログインしてください」）→ `account.status`（disabled / free / plus）
- `reachable === false` のときは、当てはまった中身の上に「サーバーへの接続に失敗しました」の 1 行を足す（⚠ は付けない）
- アカウントの行は丸（メールの頭の 1 文字・大文字）・メール・入り方（`provider === 'google.com'` のときだけ「Google でログイン」）。プランの行（`planValue`。2026-10-21 承認）は、`plus` ならサーバーの `account.plan.name` をそのまま（無ければ「Pleiad Plus」。招待の人はサーバーが「Pleiad Plus（招待）」を返す）、`free` と読めたときだけ「無料」。アカウントをまだ読めていない間は場所取り（`.rm-skel`）、`reachable === false` で読めていなければ強い字の「読み込めませんでした」と「再試行」（`plusStatus { refresh: true }`。送っている間は場所取りに戻し、終わったら「再試行」へフォーカスを戻す）。読み込み中・失敗のときに「無料」は出さない。アカウントの行は、読めるまでログインのときに覚えたメール（`status.email`）を出す
- 今月の利用（`plus` かつ `usage`・`limits` があるとき）: 「今月の利用: {used} / {limit} クレジット（{date} に戻ります）」。数は `Intl.NumberFormat`、日付は `Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric' })`。`used >= limit` ならその下に「上限に達しました」
- 同期のまとまりは `<div id="plusSyncSection">`（`web/plus-sync.mjs` の `renderSync`。`account.status === 'plus'` のときだけ）。スイッチは `account.sync.enabled`（切り替えは `plus.syncSetEnabled` 操作。失敗したら戻して「変えられませんでした」）。状態の行は `plusSyncStatus` イベントで描き直し、`disabled`・`sync.enabled === false` のときは出さない。`stopped` は「同期は止まっています」と、自動で再開することの一言（「同期できませんでした」は出さない。ボタンも出さない）。ボタンは `plus.syncNow`・`plus.syncReset`（確かめの窓あり）・`plus.syncOpenConflicts`（この PC の画面だけ）の各操作を送る（仕組みは下の「同期」）
- 鍵を待つ（`waiting_key`）間は、状態の `wait` で中身を分ける（下の「同期の始め直しと登録の外れ」）:
  - 鍵を持つ PC が台帳に居る（`wait.holder`）→ その PC の名前と最後の同期・「その PC で Pleiad を開くと鍵を渡します」。ボタンは控えめな「鍵を持つ PC が使えないとき」
  - 居ない → 「ほかの PC が同期したデータがあります（約 {size}・{count} 件）」・最後の更新（書いた PC の名前つき）・登録から外れた PC の名前。ボタンは「鍵を持つ PC が使えない」。`itemCount` が無い（前の api）ときは「データがあるかもしれません」
  - 手元の鍵が古い（`wait.stale`。ほかの PC が始め直した）→ 「同期は {name} で {time} に始め直されました」
  - ボタンはどれも確かめの窓を開く。窓は消えるもの（サーバーの同期のデータの件数と大きさ）・消えないもの（手元のファイルと設定）・ほかの PC への影響と、チェック 1 つ（「サーバーの同期のデータを消して、この PC から始め直す」）。入れるまで「消して始め直す」を押せない。押すと見せた `keyId` と `itemCount` を `plus.syncReset { confirm }` に付ける。`confirmNeeded` が返る・確かめている間に `plusSyncStatus` の件数が変わったら、窓を開いたままチェックを外し、「確かめている間に、サーバーのデータが変わりました」と新しい件数を出す
- 同期で届いて取り込むのを待っている skill・指示ファイルがあれば（状態の `inbox` が 1 以上）、同期のまとまりの終わりに「◆ 届いた変更 N 件」の行（`web/plus-inbox.mjs`）。押すと「届いた変更」の面に替わる（下の「同期で届いた skill と指示ファイル」）
- `unregistered`（この PC の登録が外れた）は止めている旨と「登録し直すと、自動で再開します」だけ（ボタンは出さない）。`sharedTo`（7 日の間に鍵を渡した新しい PC）は「新しい PC {name} に同期の鍵を渡しました」（同期を切っているときは出さない）
- この PC の行は `host.state` が `taken`（「つなぎ直す」→ 確かめの窓 → `plusHostRebind`）・`limit`・`removed`（利用者が外した。「この PC を登録し直す」→ `plus.hostReregister` 操作）のときと、`host.notice === 'reregistered'`（「この PC の登録が外れていたので、登録し直しました」）のときだけ。ほかは出さない。`plusHostRebind` は後の段階が作る。知らないコマンドが返ったら何も出さない
- 「Pleiad Plus にする」は `urls.account` のオリジンの `/plus`（`new URL('/plus', urls.account)`。`urls.account` は `/account` のようなパスを持つ）を、「アカウントを管理」は `urls.account` を外のブラウザーで開く。「ログアウト」は `plusLogout`

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
- 手順: `GET /v1/hosts` で自分の `hostId`（`base32(SHA-256(公開鍵))` の先頭 26 字）を探す。あって公開鍵が同じなら違う欄だけ `PATCH`。無ければ `POST /v1/hosts/challenge { hostId, publicKey }` で `{ challengeId, nonce, serverPublicKey }` を受け、`proof = base64url(HMAC-SHA256(HKDF-SHA256(X25519(ホストの秘密鍵, serverPublicKey), "pleiad host proof v1"), nonce ‖ utf8(hostId) ‖ utf8("register")))` を作って `PUT /v1/hosts/{hostId}`（`{ challengeId, proof, publicKey, name, platform: win32|darwin|linux, appVersion }`。`name` は `cfg.hostName` を 1〜64 字に整えたもの。同期の公開鍵 `syncPublicKey`（下の「同期」）があれば載せる。載せずに登録済みなら、上の `PATCH` で足す）
- その後: ホスト名が変わったら `PATCH { name }`、`via:'plus'` の端末の数が変わったら `PATCH { deviceCount }`（0〜64）
- 登録の外れ（下の「同期の始め直しと登録の外れ」）: 同期の `403 forbidden`（`host`）・中継の `4401 host`・登録したあとの 30 分ごとの見直し（`recheck`）で、`GET /v1/hosts` に自分が無いと分かったら登録し直す（鍵の行が戻る）。`removed` に自分が `by: "user"` で載っていれば登録し直さず `removed` で待ち、人の「この PC を登録し直す」（`plus.hostReregister` 操作 → `reregister`。設定の画面だけ）で登録する。外れていたのを登録し直したときは `notice: 'reregistered'` を載せる
- 誤り（`status.host = { state, hostId, error, notice? }` で出す。`state`: `none`・`registering`・`registered`・`removed`・`taken`・`limit`・`error`）:
  - `409 host_taken`（同じ hostId がほかのアカウントのもの）→ `taken`。自動ではやり直さない。人の「つなぎ直す」（`plusHostRebind`。人だけ）でホストの鍵を作り直し、端末を全部取り消し、新しい hostId で登録し直す
  - `429 host_limit` → `limit`（アカウントのホスト数の上限）
  - `422 bad_proof` → 新しい challenge で 1 回だけやり直す（だめなら `error`）
  - ネットの誤り・5xx → `error` で 1 分おきにやり直す

## Plus のつながり（`core/remote/plus-link.mjs`。docs/remote.md §6.4）

- 張るのは「ほかの端末からの操作を許可する」（`enabled`）・`signedIn`・`account.status === 'plus'`・`remote/settings.json` の `plus.connect`（既定 true、2026-10-21 承認。`setRemoteSettings { plusConnect }` で切り替える。人だけ。人が決めた値には `plus.userSet: true` が付き、印の無い古い値はオンと読む）・登録が `registered`、が全部そろったとき
- 行き先は `/v1/auth/config` の `urls.relay`。ヘッダーは `{ 'x-pleiad-host': hostId, 'x-pleiad-account': <ID トークン> }`（張るたびに取る）。中継の中身は Noise の暗号のまま（own と同じ）
- `remoteStatus.plus = { connect, link: { state, error, since, retryAt }, host: { state, error }, devices }`
- 中継が制御用の接続を閉じたとき: `4401 'account'` → 止まる（link の error `account`。張り直さない）。`4401 'host'` → この PC の登録が外れた（link の error `host`）。登録を確かめ直し（上の `recheck`）、登録し直したら張り直す。`4429 'account limit'` → `limit`。ほかの `4401` → ID トークンを取り直して 1 回だけ張り直す（また `4401` なら `auth`）。`1013` → 今の backoff で張り直す。ほか → 今と同じ。`account`・`accountStatus`・`plus.connect`・`enabled`・登録・ログインが変わったときに ready() から見直す
- `4401 'account'` の止まり: 止まっている間は、ほかの条件がそろっていても ready() が `{ error: account }` を返し、中継へ張りに行かない（session の知らせのたびの見直し・設定の書き換えに伴う張り直しでも）。次のどれかで解いて、ready() から張り直す
  - アカウントが Plus で使えると新しく分かった: 止まったあとに `GET /v1/account` を読めて `status: 'plus'`（`accountReadAt` が止まったときより進んだ）。読むのは 15 分ごと・設定 › リモートや設定 › Pleiad Plus を開いたとき（30 秒に 1 回まで）・ログインした直後・起動したとき。止まった瞬間には読み直さない（中継と api の言い分が食い違うと、読むたびに張り直して断られるのを繰り返すため）
  - 張る条件がいったん崩れた: `account.status` が `plus` でなくなった（停止で `disabled` と読めた）・設定 › リモートの Pleiad Plus のスイッチ（`plus.connect`）か「ほかの端末からの操作を許可する」を切った・ログアウト・登録が `registered` でなくなった。そろい直したら張る
  - ほかのアカウントになった（uid が変わった）・アプリを起動し直した（止まりはメモリにだけ持つ）
- 止まっている間の設定 › リモートは「このアカウントでは公式の中継を使えません」の 1 行を出す（ほかの PC へ のまとまりと同じ形。ボタンは足さない）。`account.status` が `plus` と読めている間は Pleiad Plus のスイッチを押せる（切って入れ直すとつなぎ直す）。`disabled` と読めている間は押せない（`plus` に戻れば、読めたところで張り直す）
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
- 同期の口（下の「同期」の表の形。`baseRev`・`previousKeyId` を照合し、`PUT` の決めた欄以外は `400`）。試験から変えるもの: `state.syncLimitBytes`（容量）・`state.syncItemLimit`（1 項目の暗号文の上限）・`state.syncFail`（誤りの差し込み `[{ method?, path, status, code, message, headers?, extra?, count? }]`）。受けた本文は `state.syncBodies` に残す（中身が平文で届いていないことの確かめに使う）。同期を切ったアカウント（`sync.enabled: false`）には `state` 以外の口が `403 forbidden`（`sync_disabled`）
- ホストの台帳: `GET /v1/hosts`・`POST /v1/hosts/challenge`・`PUT`/`PATCH`/`DELETE /v1/hosts/{hostId}`（証明は本物と同じく X25519+HKDF+HMAC で照合し `state.hosts` に残す。`state.failNextProof` で次の 1 回だけ 422 bad_proof）
- 同期の始め直しと登録の外れ（下の節の約束どおり）: `state` の足した欄・`reset` の `confirm` と `409 reset_confirm`・同期の口の `403 forbidden`（`host`）。ホストを外すと鍵の行に `detachedAt`・`name` を付けて残し、`state.hostsRemoved` に `by` を書く（`unbindHost(hostId, by)` で運営が外したのも作れる）。`state.legacySync = true` の間は前の版の api のふり（足した欄・`removed`・`confirm` の照合が無く、外すと鍵の行を消す）

中継側の「公式の中継」の身代わりは `tests/lib/plus-relay-authz.mjs`（中継に差し込む authz。`X-Pleiad-Account` の確かめ・ペアリングの断り・`admit: true`。`remote-plus.mjs` が一連の流れを確かめる）。

## 同期（`core/plus/sync/`）

Plus のアカウントの PC どうしで、設定・スキル・全体の指示ファイルをそろえる。中身は PC の中で暗号化してから api に上げ、受けた PC が PC の中で開く。暗号化と復号は PC の中だけで行い、鍵は api に渡さない。

### 同期するもの・しないもの

| 論理名 | この PC の実体 |
| --- | --- |
| `settings/<key>` | `defineSetting` の設定のうち `sync` のもの（下の表）。既定の値のままのものは項目にしない |
| `skills/claude/<相対パス>` | `<CLAUDE_CONFIG_DIR か ~/.claude>/skills/` の下 |
| `skills/agents/<相対パス>` | `~/.agents/skills/` の下 |
| `skills/pleiad/<相対パス>` | `<data>/skills/` の下 |
| `instructions/claude`・`instructions/codex`・`instructions/gemini` | 全体の指示ファイル `<CLAUDE_CONFIG_DIR か ~/.claude>/CLAUDE.md`・`<CODEX_HOME か ~/.codex>/AGENTS.md`・`~/.gemini/GEMINI.md`（`core/context-scan.mjs` の `userInstructionPaths`。文脈の一覧のユーザーの段と同じ場所） |

- 中身はバイト列のまま運ぶ（改行・文字コード・BOM を変えない）。受けたファイルの mtime は送った側の mtime にする
- **「秘密情報と変数」は同期しない**。`<data>` の直下のファイル（`secrets.json`・`secret-values.json`・`plus-secrets.json`・`api-keys.json` など）は読まない
- スキルの置き場の中でも運ばないもの: 名前に `secret` を含むもの・`.env*`・`api-keys.json` などの秘密の置き場の名前・`.git/`・`node_modules/`・`__pycache__/`・`logs/`・`backups/`・`*.log`・`*.bak`・文脈のキャッシュ・1MB を超えるファイル
- リンク（symlink・ジャンクション）は運ばず、その先も読まない。受けたときもリンクの先には書かない・消さない。置き場や指示ファイルそのものがリンクなら、それごと運ばない
- 項目の平文（下の JSON）が 1MB を超えるものは送らない（ログに `sync item too large`）

設定は `sync`（`defineSetting` の欄。既定 true）で決める。human-only・guarded・`riskOf` を持つもの・読むだけのものは `sync: false` でなければならない（`defineSetting` が断る）。受けた値は画面からの変更と同じ `normalize`・`write` を通して書く（受けた PC に無いエージェント・知らないモデルなどは `normalize` で落ちる）。既定に戻した設定は、ほかの PC でも既定に戻る。

| 運ぶ | 運ばない |
| --- | --- |
| `locale`・`linkOpen`・`instructionBudget`・`backend`・`memoryLearnBackend`・`memoryLearnAt`・`memoryLearnPaused`・`model`・`effort`・`shellTool`・`composer.historyRecall`・`composer.suggestions`・`compaction.auto` | human-only（`mode`・`claudeAccount`・`account`）・guarded（`launchAtLogin`・`delegationRouting`・`plyInstructions`・`addedContext`・`context.default`）・`riskOf`（`confirmAgentSites`・`chromeAutoAllow`・`confirmExternalLoads`・`agentSitePermissions`・`externalSitePermissions`・`computerUse`・`voice`）・読むだけ（`repoDefaults`）・この PC に固有（`chromeProfileNotes`・`chromeNewProfile`） |

全部の判断と理由は `tests/unit/ops-settings.mjs` の表にある（設定を足すと、表に無いことで試験が落ちる）。

### 暗号の形（`core/plus/sync/crypto.mjs`）

1. アカウントの同期鍵 K（32 バイトの乱数）と `keyId`（8 バイトの小文字の hex）。K から 2 つの鍵を導く:
   - `K_enc = HKDF-SHA256(K, salt 空, "pleiad sync enc v1")`（項目の中身の AES-256-GCM の鍵）
   - `K_id = HKDF-SHA256(K, salt 空, "pleiad sync item id v1")`（項目の ID の鍵）
2. ホストごとの同期の鍵対（X25519）。秘密鍵は手元の `plus:syncKey`、公開鍵は台帳の `syncPublicKey`（raw 32 バイトの base64url）。K を W（持つホスト）が T のために包む:
   - `kek = HKDF-SHA256(X25519(W の秘密鍵, T の公開鍵), salt = W の公開鍵 ‖ T の公開鍵, "pleiad sync wrap v1")`
   - `wrapped = base64url(nonce12 ‖ AES-256-GCM(kek, nonce12, K, aad = "pleiad-sync-wrap-v1|<uid>|<T の hostId>|<keyId>"))`（60 バイト）
   - T は `wrappedBy` のホストの公開鍵で開く。開けなければ使わない
3. 項目:
   - `itemId = base64url(HMAC-SHA256(K_id, 論理名))` の先頭 32 字（api に論理名を見せない）
   - 平文 = `{"v":1,"path":<論理名>,"mtime":<ISO 8601>,"deleted":<bool>,"content":<中身の base64>}`
   - 暗号文 = `"v1." + keyId + "." + base64url(nonce12) + "." + base64url(AES-256-GCM(K_enc, nonce12, 平文, aad = "pleiad-sync-item-v1|<uid>|<itemId>|<rev>"))`（`rev` は書き込む版）
   - 開いた平文の論理名から求めた `itemId` が、受けた `itemId` と違えば捨てる

K は手元の `plus:syncAccountKey`（`{ keyId, key }`）に置く。保管は `plus-secrets.json`（ほかの Plus の秘密と同じ置き場）。

#### 試験ベクトル（`tests/unit/plus-sync-crypto.mjs` と同じ値）

`seq(a, n)` は a, a+1, … の n バイト。

| 入力 | 値 |
| --- | --- |
| K | `seq(0x00, 32)` |
| keyId | `0011223344556677` |
| uid | `test-user` |
| W の秘密鍵・T の秘密鍵 | `seq(0x40, 32)`・`seq(0x60, 32)` |
| T の hostId | `host-target` |
| 包む nonce・項目の nonce | `seq(0xa0, 12)`・`seq(0xb0, 12)` |
| 論理名・mtime・中身・rev | `skills/pleiad/demo/SKILL.md`・`2026-01-02T03:04:05.000Z`・`hello\r\n`・1 |

| 出力 | 値 |
| --- | --- |
| W の公開鍵 | `eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo` |
| T の公開鍵 | `Z13VdO13iTELPS52gfN5C0ZsdzsVIf7PNld5WDcepS8` |
| K_enc（hex） | `5148e946bc3b28b72b9454ed12758b194eb8b7dc535c1ada0a410caa3c305c3f` |
| K_id（hex） | `4280c95d06eb920592e3eab530cd79d123104de4dc4f4ec5418cc1c9f3b8551e` |
| wrapped | `oKGio6SlpqeoqaqrtTglUOa9GkxgTALVD1CWBroh_HpFU5OBb_UCJmUoSiCb9eGAAD9NEAIIA_4UnMW7` |
| itemId | `Yxk-Pddt_fEXUSeObnwpP9_aCuErsMz6` |
| 平文 | `{"v":1,"path":"skills/pleiad/demo/SKILL.md","mtime":"2026-01-02T03:04:05.000Z","deleted":false,"content":"aGVsbG8NCg=="}` |
| 暗号文 | `v1.0011223344556677.sLGys7S1tre4ubq7.sqVME4Kd2WWoXG3_Bz7DB7q80JMLwTpEKrfhR4RbgEoJGp9HXG-Jmx8X8qDZgApn7eCJ6v-3YSMhIrt78ZRxU1ki0seYF8niA0GsGy7sVL3LbTn7UusQec2QbeBL-fEY5DVuhTnMia5_MyCOLTF81UjwV0jp7_jnjV2eC0kGGuM823nMfWFXNg` |

### 口（Plus の api）

共通のヘッダーと誤りの形は上の「api を呼ぶ手」と同じ。どの口も、同期を切ったアカウントには `403 forbidden`（`message: sync_disabled`）を返しうる（`state` だけは `enabled: false` を返す）。`429 rate_limited`（`Retry-After`）と `503 unavailable` はどの口でも返りうる。容量（`limitBytes`）・本文の大きさの上限・`cursor` の扱いは、サーバーの返す値に従う（クライアントは受けた `cursor` を次の `since` にするだけ）。

| メソッドとパス | 入力 | 出力 | 誤り |
| --- | --- | --- | --- |
| `GET /v1/sync/state[?hostId=<自分>]` | - | `{ enabled, keyId\|null, hostsWithKey: [hostId], pending: [hostId], totalBytes, limitBytes, cursor, itemCount, updatedAt, lastWriter, holders, resetAt, resetBy }`（`itemCount` からあとは下の節） | `not_plus`・`account_disabled` |
| `GET /v1/sync/keys/{hostId}` | - | `{ keyId, wrapped, wrappedBy }` | `404 not_found`（宛てが無い） |
| `PUT /v1/sync/keys/{hostId}` | `{ keyId, wrapped, wrappedBy }` | `204` | `409 conflict`（`message: keyId` か `wrappedBy`） |
| `POST /v1/sync/reset` | `{ keyId, hostId, wrapped, previousKeyId, confirm? }` | `state` と同じ | `409 conflict`（`message: previousKeyId`。同時にほかの PC が作り直した）・`409 reset_confirm`（人の確かめが要る。下の節） |
| `GET /v1/sync/items?since=<cursor>&limit=200` | - | `{ items: [{ itemId, rev, seq, keyId, ciphertext\|null, deleted, updatedAt }], cursor, more }` | - |
| `PUT /v1/sync/items/{itemId}` | `{ baseRev, keyId, ciphertext, deleted, hostId }`（この 5 つだけ。ほかの欄は `400`） | `{ rev, seq }` | `409 conflict`（`message: rev` なら本文の一番外に `current`、か `keyId`）・`413 too_large`（1 項目が大きすぎる）・`413 sync_quota`（容量を超える。`error.limitBytes`） |

`reset` は前の項目と包んだ鍵を消す（サーバーの返す値に従う）。消した項目も `ciphertext` 付きの `deleted: true` で上げる（平文の `deleted` も true）。`ciphertext` の無い項目・`deleted` が平文と食い違う項目は受けない。どの口も、自分のものでない（外された・無い）ホストの `hostId` を渡すと `403 forbidden`（`message: host`）。

### 同期の始め直しと登録の外れ（api とアプリの約束）

この節は Pleiad の `docs/plus.md` と Plus の api の設計に同じ文で置く。片方を変えたら、もう片方も同じに変える。

**サーバーのデータを消す前に人が確かめる。** 鍵を持たない PC が、サーバーの同期のデータを黙って消して始め直すことを、api が断る（古い版のアプリも止まる）。

- `GET /v1/sync/state[?hostId=<自分の hostId>]` の出力に次の欄を足す（前からの欄はそのまま）:
  - `itemCount`: 墓標を除く項目の数
  - `updatedAt`: 最後に項目が書かれた時刻（無ければ `null`）
  - `lastWriter`: `{ hostId, name } | null`（最後に書いた PC）
  - `holders`: `[{ hostId, name, lastSyncAt, registered }]`。今の `keyId` の鍵の行。外されたホストの行も `registered: false` で出す。並びは `registered` が先、次に `lastSyncAt` の新しい順、次に `hostId`
  - `resetAt`・`resetBy`（`{ hostId, name } | null`。最後に始め直した PC）
  - `hostsWithKey`・`pending` は、外されていない今の鍵の行だけで数える
  - `?hostId=` を付けると、その PC の鍵の行の `lastSyncAt` を 1 時間に 1 回まで書く（自分のホストでなければ何もしない）。`GET /v1/sync/keys/{自分}` と `PUT /v1/sync/items/*` も同じく書く
  - 古い api はこれらの欄を返さない。アプリは `itemCount` が無ければ「サーバーにデータがあるかもしれない」と扱い、自分から始め直さない
- `POST /v1/sync/reset` の入力に `confirm: { keyId, itemCount } | null` を足す
  - 要るとき: 今の `keyId` があり、`itemCount` が 1 以上で、呼んだ PC が今の鍵を持たない（鍵の行が無い・`keyId` が違う・外された行）とき。鍵を持つ PC の「同期をやり直す」と最初の 1 台（`keyId` が無い）には要らない
  - 無い・今の値と合わない → `409 reset_confirm`。本文は `{"error":{"code":"reset_confirm","message":"confirm","keyId","itemCount","totalBytes","updatedAt","holders"}}`（今の値）。何も消さない
  - アプリはこの値（件数・大きさ・最後の更新・鍵を持つ PC）を人に見せ、チェックを入れて確かめたら、受けた `keyId` と `itemCount` を `confirm` に入れて送り直す。その間にデータが変わっていれば、また `409 reset_confirm`（新しい値）になる
  - `confirm` の形が違う → `400 bad_request`（`message: confirm`）。`previousKeyId` の照合が先（`409 conflict`）
  - 始め直すと、外された行を含む全部の鍵の行と項目を消す。監査 `sync.reset` の detail は `{ hostId, items, confirmed, byHolder }`
- 同期の口に自分のものでない（外された・無い）ホストの `hostId` を渡すと `403 forbidden`（`message: host`）。アプリはこれで登録を確かめ直す

**登録が外れても鍵の行を残し、PC は自分で登録し直す。**

- ホストを外す（`DELETE /v1/hosts/{hostId}`、運営が外すときも同じ処理）:
  - 台帳から消す。`sync_keys` の行は消さず、`detachedAt`（外した時刻）と `name` を付けて残す。外された行は鍵を渡す元（`wrappedBy`）に使えない（`409 conflict`、`message: wrappedBy`）
  - `hosts_removed/{hostId}` に `{ uid, hostId, by, at }` を書く。`by` は `user`（利用者が外した）か `admin`（運営が外した）
  - 中継に `close { tag: "h:<hostId>", code: 4401, reason: "host" }`
- `PUT /v1/hosts/{hostId}` で登録し直すと、鍵の行の `detachedAt` を消し（鍵が戻る）、`hosts_removed` を消す
- `GET /v1/hosts` の出力に `removed: [{ hostId, by, at }]`（自分のアカウントの外されたホスト。`at` の古い順）を足す
- 中継: ホストの口で束縛が外れていたら `4401` の reason は `host`（端末の口は前と同じ `account`）。前からのアプリは `4401 host` を `auth` の誤りとして扱う
- アプリは、`403 forbidden`（`host`）・`4401 host`・30 分ごとの見直しで、自分の `hostId` が `GET /v1/hosts` に無いと分かったら:
  - `removed` に自分が `by: "user"` で載っていれば、登録し直さない（状態 `removed`。人が「この PC を登録し直す」を押すまで待つ）
  - それ以外（`by: "admin"`・載っていない）は登録し直す。鍵の行が戻るので、同期はそのまま続く

### 鍵の始め方（`core/plus/sync/keys.mjs`）

1. `GET /v1/sync/state?hostId=<自分>`。`enabled: false` なら何もしない（`disabled`）
2. `keyId` が null（最初の 1 台）: 新しい K を作り、自分宛てに包んで `POST /v1/sync/reset`（`previousKeyId: null`）
3. 手元の K の `keyId` が同じなら、それを使う
4. 違えば `GET /v1/sync/keys/{自分}` を開く。`404` なら、ほかの PC が渡すのを待つ（`waiting_key`。待つ間に見せる `wait` に、鍵を持つ PC・件数・大きさ・最後の更新を載せる）。サーバーに項目が無く（`itemCount` が 0）、鍵を持つほかのホストも台帳（`GET /v1/hosts`）に居なければ、確かめずに作り直す（`previousKeyId` は今の `keyId`）。項目がある・`itemCount` が無い（前の api）ときは自分から作り直さない
5. `409 conflict`（`previousKeyId`）なら `state` を読み直す（3 回まで）。`409 reset_confirm` は `confirm_needed`（`wait` は誤りの本文の今の値）で返し、人が確かめたら `setup({ forceNew: true, confirm: { keyId, itemCount } })` で送り直す
6. K を持つ PC は、毎回 `state.pending` のホストへ包んで渡す（`PUT /v1/sync/keys/{T}`。T の公開鍵は台帳の `syncPublicKey`）

ログアウト・アカウントの切り替えでは K と手元の覚えを捨てる（ホストの鍵対は残す）。「同期をやり直す」は新しい K で作り直し、手元の全部を上げ直す（ほかの PC は新しい K を受け直す）。

### 回し方（`core/plus/sync/engine.mjs`）

- 1 回の流れ: 鍵の始め方 → 宛ての無いホストへ鍵を渡す → 受ける → 上げる。同時に 1 本だけ回し、回っている間に頼まれたら、終わったあとにまとめて 1 回回す
- いつ: 回し始めたとき（ログインしていて `account.status` が `plus`、この PC が台帳に載っている）・手元の変更（スキルの置き場と指示ファイルの親の `fs.watch`、設定の変更。最初の変更から 5 秒まとめる）・10 分ごと。鍵の受け渡しだけは 5 分ごとにも見る
- 受けて書いたファイル・設定は、その出来事で上げ直さない
- 受けた skill と全体の指示ファイルは書かずに待たせる（下の「同期で届いた skill と指示ファイル」）。設定は今のまま書く
- `409 conflict`（`rev`）: 受けてから競合を解き、勝った手元の版を上げ直す
- 誤り: `429` は `Retry-After` の秒数（無ければ 60 秒）後に、ほかは 1 分・2 分・4 分…（10 分まで）後にやり直す。`401` は止める（`error`。タイマーを外し、セッションが変わるまで回さない）。`not_plus`・`account_disabled` は下の「アカウントの停止」。`403 sync_disabled` は `disabled`。`413 sync_quota` は `quota`（消すのは上げ続け、次の回でまた試す）。`413 too_large` の項目は中身が変わるまで上げない。`403 forbidden`（`host`。この PC の登録が外れた）は `unregistered` で止め（タイマーも外す。誤りにしない）、`onHostLost` で登録を確かめ直してから回し直す。知らせるのは次にうまく回るまで 1 回だけ
- アカウントの停止: api が `403 not_plus`・`account_disabled` を返したら、`stop` まで行う（タイマー・watch・設定の購読を外す）。状態は `stopped`（`error` に理由。誤りにしない）。条件から外れた（`account.status` が `plus` でなくなった・登録が外れた）ときも、回していれば止める（`plus` でないなら `stopped`、ほかは `off`）。次のどれかで、回し始めと同じく `start` から回し直す（10 分ごと・5 分ごとのタイマーも張り直す。人の操作は要らない）
  - 条件がそろい直した（停止で `disabled` と読めたあと、`GET /v1/account` を読み直して `plus` と分かった）
  - セッションが `plus` と読んだまま api に止められたときは、止まったあとに `GET /v1/account` を読めて `plus` と分かった（`accountReadAt` が止まったときより進んだ）。読むたびに 1 回だけ試す
  - アプリを起動し直した
- `401 unauthenticated` を `stopped` にしないのは、セッションの側（ID トークンの取り直し・ログアウトの扱い）が直すもので、アカウントの停止とは別だから。今のまま `error` で止め、セッションが変わる（ログインし直す）か「今すぐ同期」で回す
- ログには論理名・中身・鍵を出さない（項目は `itemId` だけ）
- 手元の覚え: `<data>/plus/sync-state.json`（`{ keyId, cursor, items: { <論理名>: { itemId, rev, sha256, deleted, mtime } }, rejoinedAt, sharedTo, dropped }`。中身と鍵は入れない）
  - `rejoinedAt`: 前の鍵を持っていて、別の鍵に替わった時刻。覚えを空にしたあと、覚えの無い設定の時刻にこれを使う（始め直したほかの PC の「初めて上げた設定」に、手元の設定が負けないように。初めて加わる PC は 0 のままで、アカウントの設定を採る）
  - `sharedTo`: 鍵を渡した新しい PC（新しい順に 3 つ `{ hostId, name, at }`。状態には 7 日の間だけ出す）
  - `dropped`: 人が「捨てる」を押した版（`{ <論理名>: 中身の sha256 か 'deleted' }`）。同じ版が届き直しても待ちに出さない。違う版が届いたら忘れる
- 状態: `getSyncStatus()` → `{ state: off|disabled|waiting_key|syncing|idle|quota|stopped|unregistered|error, lastSyncedAt, totalBytes, limitBytes, conflicts, error, wait, sharedTo, inbox, inboxAt }`（`totalBytes`・`limitBytes` は `state` の値。`wait` は鍵を待つ間に見せるもの。`inbox` は取り込むのを待っている数、`inboxAt` はその中で一番新しく届いた時刻）。変わるたびに `plusSyncStatus` イベントを全接続へ送る（ポーリングはしない）
- 画面・口からの入口は操作の一覧（`core/ops/plus.mjs`）: `plus.syncStatus`（状態）・`plus.syncSetEnabled`（スイッチ。`PATCH /v1/account {"sync":{"enabled":bool}}`）・`plus.syncNow`（1 回回す）・`plus.syncReset`（やり直し。鍵を持たない PC は `confirm { keyId, itemCount }` を付ける。足りない・合わなければ `{ confirmNeeded: true, status }` を返して何も消さない）・`plus.hostReregister`（利用者が外した PC を登録し直す）・`plus.syncOpenConflicts`（写しのフォルダーをこの PC で開く。hostScreenOnly）・`plus.syncInbox`・`plus.syncInboxItem`・`plus.syncInboxTake`・`plus.syncInboxDrop`（受け入れ待ち。下の節）。変更系は設定 › Pleiad Plus の画面だけが呼ぶ

### 同期で届いた skill と指示ファイル（ADR 0245）

ほかの PC から届いた skill（`skills/…`）と全体の指示ファイル（`instructions/…`）は、すぐには書かない。人が中身を見て「取り込む」を押したものだけを書く。消すもの（`deleted`）も同じで、押すまで消さない。どの PC から届いたものでも同じに扱う（前に鍵を渡した PC でも、毎回見る）。設定（`settings/…`）は今のまま自動で書く（受けた値は `normalize` を通る）。

- 置き場: `<data>/plus/sync-inbox/<id>/`（`id` は論理名の sha256 の先頭 32 字。鍵が替わっても同じ項目は同じ場所）。`incoming`（届いた中身。消すものには無い）・`base`（届いたときの手元の中身。手元に無ければ無い）・`meta.json`（`{ path, from, at, mtime, kind: change|new|delete, rev, sha256, baseSha }`）。`meta.json` を最後に書き、読めない・形の違うフォルダーは無いものとして扱う
- 同じ項目の新しい版が届いたら、待っている版を置き換える（1 項目 1 件）。同じ版が同じ手元に対して届き直したときは、届いた時刻を変えない
- 手元がもう届いた版と同じ中身なら、待たせずに覚えだけ進める
- 待っている間、手元の覚えは `rev` だけ進め、`sha256` は手元の版のままにする（手元の版を上げ直さない。待っている間に手元で変えたものは、ふつうに上げる）
- 取り込む（`plus.syncInboxTake { id }`）: 今の手元の中身が `base` と同じときだけ書く（消すものは消す）。書く道はふつうの受け取りと同じ（リンクの先には書かない）。届いた後に手元が変わっていたら書かず `{ taken: false, reason: 'local_changed' }`。`incoming` が `meta.json` の `sha256` と合わない・もう無いものは `gone` で待ちから消す。書けなかったら `not_applied`
- 捨てる（`plus.syncInboxDrop { id }`）: 待ちから消し、その版を `dropped` に覚える。手元のファイルも api の項目も変えない
- 一覧（`plus.syncInbox`）は新しく届いた順の `{ id, path（画面に出す形。`~/.claude/skills/…`）, kind, at, fromName（台帳の名前。読めなければ null）}`。1 件（`plus.syncInboxItem { id }`）は `before`・`after`（文字として読めないものは `binary: true`）。どれも人の画面の操作で、agent・CLI には出さない
- 回と、取り込む・捨てるは 1 本ずつ通す（回の途中で書き換わった手元に書かない）。ログアウト・アカウントの切り替えで待ちは消える
- 平文に上げた PC の `hostId`（`from`）を入れる。画面に「どの PC から」を出すためだけで、取り込むかどうかには使わない
- 受けない項目: 暗号文の無いもの（中身の無い消した印）・api の `deleted` が暗号文の中の `deleted` と食い違うもの・`rev` が 1 以上の整数でないもの。消すかどうかも、暗号文の中の `deleted` だけを見る

画面（設定 › Pleiad Plus › 同期 › 届いた変更。`web/plus-inbox.mjs`・`web/plus-settings.mjs`）:

- 「‹ Pleiad Plus」・題「届いた変更」・1 件ごとの見出しの行（パス・「変更｜新しいファイル｜削除 · PC の名前 · 届いた時刻」・開閉の山）。開くのは 1 件だけで、面を開くと最初の 1 件が開く
- 開いた 1 件に差分（`web/line-diff.mjs`。文脈の一覧と同じ `.scx-lines`）。変更は手元と届いたものの差、新しいファイルは + の行だけ、消すものは − の行だけ。下に「捨てる」「取り込む」
- 押したら、その行に「取り込みました」「捨てました」を残して次の 1 件を開く（フォーカスも次の見出しへ）。手元が変わっていたら、わけを出して「取り込む」を押せなくする（「捨てる」は押せる）
- 「すべて取り込む」は置かない
- 通知の一覧には、待っているものがある間「同期で届いた変更が N 件あります」（あなた待ち・場所は「設定 › Pleiad Plus」）の 1 行を置く。押すとこの面を開く。新しく届くと未読で載せ直し、件数だけ変わったら同じ行を直す。0 件になったら消す。起動時に承認のあなた待ちを決着させる処理（`settleAllWaiting`）では消さない

### 競合

同じ設定を 2 台で変えたら、平文の `mtime` の新しい方を採る（同じなら相手の版）。負けた方は `<data>/plus/sync-conflicts/<YYYYMMDD-HHmmss>/<論理名>` に写す（日時はこの PC の時刻。設定は `<論理名>.json`）。skill と指示ファイルは競合にせず、届いた版を待たせる（上の節。手元の版は手元に残り、そのまま上げる）。写しのフォルダーは作ってから 30 日を過ぎたら、回し始めるときに消す。`conflicts` は残っている写しの数。

### 守るもの・守らないもの

守るもの:

- 中身（ファイル・設定の値）と論理名（パス）は暗号文の中にある。api が受け取るのは、暗号文・包んだ鍵・項目の ID・大きさ・時刻（と書いたホストの `hostId`）だけ
- K と同期の秘密鍵は PC の外に出さない
- ほかの PC から届いた skill と指示ファイルは、人が中身を見て取り込むまで書かない（消すものも消さない）
- api が暗号文を書き換える・別の項目や別の版・別のアカウントの暗号文と入れ替える、は開けずに捨てる（aad に uid・itemId・rev、包んだ鍵の aad に uid・hostId・keyId）

守らないもの:

- 項目の数・大きさ・更新の時刻・どのホストが書いたかは api に見える
- api が項目を返さない・前の版をそのまま返し直す、は見分けない
- 鍵を渡す相手は、api の返すホストの台帳（`syncPublicKey`）に従う。台帳を偽られると、偽のホストにも K を包んで渡しうる
- PC そのものが乗っ取られれば、K も中身も読まれる

## Android

対象: `mobile/`（Capacitor の殻）。ログインの計算と更新の決まりは Android に依らない Kotlin（`remote-core` の
`dev.pleiad.app.plus`）に置き、単体試験は `./gradlew :remote-core:test` で回す。

### 設定は起動時に受け取る

- 起動時と、前面にいる間は 5 分ごとに `GET <api>/v1/auth/config` を読む。使う欄だけを読む:
  `state`・`visibility`・`token.projectId`・`token.apiKey`・`urls`（`login`・`account`・`profile`・`relay`・`refresh`）・
  `minClient.android`。それ以外の欄は読まない
- api のベースの URL は `BuildConfig.PLUS_API`（既定 `https://api.pleiad.dev`）。gradle のプロパティ
  `pleiadPlusApi` で debug のビルドだけ替えられる（release では替えられない）
- 読めないときは前に読んだ値（SharedPreferences `plus` の `config`。平文。秘密は無い）を使う。
  一度も読めていなければ、一覧の上の Plus の入口に「サーバーに接続できません」を出し、ログインのボタンは
  押せない
- `state` が `off` のときは Plus の入口を全部隠して今の見た目に戻る。`minClient.android` より古い版は
  「Pleiad を更新してください」を出す
- `visibility` が `optin` の間は、この端末の印（SharedPreferences `plus` の `entrance`）が無い限り入口を
  全部隠す（`stateJson` が `off` と同じ見た目を返す）。`pleiad://plus/enable|disable` が印を変える
  （intent-filter は host `plus`、無関係な `pleiad://plus/…` は無視。「入口を出すリンク」の節）

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
- 読めた一覧に無くなった PC（PC の側で台帳から外した、など）は一覧から消し、端末に残した Plus の記録も捨てる（`PlusHostList.gone`）。自分の中継サーバーでも組んでいれば、その PC は自分の中継サーバーの行として残る。読めなかったときは前回の一覧のままで、何も消さない。
- 自前の中継と Plus のホストは見出しで分けず、`hostId` ごとに 1 行にまとめる。自前の記録と Plus の記録が両方ある行は、Plus の一覧でその PC がオンラインなら Plus で、そうでなければ自前で開く。すでにつながっている窓があればその経路のまま開き、状態の行には開く経路（「オンライン · Pleiad Plus」「オンライン · 自分の中継サーバー」）を出す（2026-10-21 承認。規則は `HostRoute`、docs/remote.md §8.2）。最後に使った時刻が新しい行を先にし、まだ使っていない Plus のホストは API の順に後ろへ置く。
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
