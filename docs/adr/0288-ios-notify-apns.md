# 0288 iOS の通知は APNs で届ける（Pleiad Plus の経路だけ）

- 状態: 承認

## 状況

[ADR 0086](0086-notifications-through-relay.md) は通知を Android の前面サービスと中継の通知の線（`WS /v1/device/notify`）で届けると決め、「iOS に広げるときは APNs を別の ADR で決める」と残した。iOS は背面で WebSocket を保てないので、0086 の届け方（C）は iOS では使えない。

モバイルは OS で差を作らない（[ADR 0263](0263-accounts-and-hosted-relay.md) 決定 5）が、届け方は OS の仕組みの違いで分かれる。候補は 2 つあった。

- A: 自分の中継を立てる iOS 利用者にも APNs を届ける。送り手（APNs の資格情報の持ち主）が各利用者の中継に届くようにするには、配布元の送り口の資格情報を利用者の中継ごとに配るか、配布元が常時送り口のサーバーを置く必要がある。前者は秘密を配ること、後者は「中継を立てるだけで使える」第三者を挟まない方針（[ADR 0013](0013-remote-via-relay-with-noise.md)）に反する。
- B: Pleiad Plus の経路で組んだホストへの通知だけを APNs で届ける。送り手は運営者の api だけで、資格情報は api が持つ。自分の中継だけで組んだ iOS 端末にはプッシュ通知は届かない（アプリを開いている間の通知は今までどおり）。

## 決定

1. **届け方は B。** iOS では、Pleiad Plus の経路で組んだホストの通知だけを APNs で届ける。自分の中継だけで組んだホストは対象外（設定画面に「iOS では Pleiad Plus でつないだ PC だけ通知が届きます」と出す）。Android は 0086 のまま（中継の通知の線）。
2. **中身の暗号は変えない。** APNs が運ぶのは、ホストが端末ごとの通知鍵で暗号化した `blob` をそのまま（APNs のカスタム領域 `p: { h, d, b }`。`h` は hostId、`d` は deviceId、`b` は `blob`）。運営の api・中継・Apple は中身を読めない。端末は Notification Service Extension（`NotifyService`、bundle `<本体>.notify`）が、共有の Keychain アクセスグループ（`$(AppIdentifierPrefix)dev.pleiad.app.shared`）の通知鍵で開き、題を会話名・本文を出来事の文にして出す。開けないときは汎用の文「新しい通知があります」。押すと `pleiad://open?h=&s=` で会話を開く。
3. **届け先の登録は Plus の api。** アプリは `PUT /v1/push/apns` に `{ hostId, deviceId, token, env, bundle }` を Plus の ID トークンで送り、サインアウト・通知を切・許可の剥奪では `DELETE /v1/push/apns` に `{ token }` を送る。ホストが組を外した（剥奪・削除）ときの掃除は api の役目（中継の `device-revoke` の出来事で消す）。APNs の環境は Release が `production`、Debug が `sandbox`。
4. **届ける条件**: 通知の設定が入・OS の通知の許可あり・Plus にサインイン・有効な Plus の組がある、の全部がそろったときだけ登録する。条件が崩れたら解く。
5. **署名**: 本体と拡張でプロファイルが 2 つ要る（拡張は共有の Keychain グループ）。CI（`ios-testflight.yml`）はビルドのたびに ASC API で名前（`Pleiad <bundle>`）でプロファイルを取り、取れなければ Secrets の代替を使う。App ID・Push の capability・プロファイルは `ios-provision.yml`（手動）が `asc-provision.mjs` で冪等に整える。ターゲットごとの署名は `PLEIAD_*` の変数で渡す（既定値は `mobile/ios/pleiad.xcconfig`）。

## 理由

- **B を採る理由**: APNs の資格情報（Token の .p8）は送り手 1 つに限られる。自分の中継に届けるには資格情報を配るしかなく、A は秘密の配布を生む。Plus の経路は api が届け先を知る（アカウントの台帳がある）ので、資格情報は api だけが持てばよい。自分の中継の iOS 端末に届かないのは 0086 の C と同じ「第三者を挟まない」選択の帰結で、設定画面で利用者に見せる。
- **NSE で開く理由**: APNs の通知は端末がロックされていても届く。拡張が端末の中でだけ開くので、運営・Apple には中身を見せずに済む（0086 決定 2 と同じ約束）。Keychain の共有グループで、アプリが書いた通知鍵を拡張が読む。
- **アプリと拡張で鍵を分けない理由**: 通知鍵は端末の 1 つ（`notify:<deviceId>` ではなく、ホストごとの `hostId`・`deviceId` が AAD に入るので 1 つで全ホストに使える。0086 と同じ）。
- **届ける条件に Plus を入れる理由**: 登録は ID トークンで認可される api の操作なので、サインアウト・無効なアカウントでは結び付けられない（招待された人が別端末の deviceId で他人のトークンを登録するのは、api が「別の uid は上書きできない」で抑える）。

## 影響

- ADR 0086 の「iOS には届かない」はこの ADR で一部置き換わる（Plus の経路だけ届く）。
- [ADR 0174](0174-ios-capacitor-shell.md) 決定 7（Keychain はアプリだけの項目）は、通知鍵だけ共有グループの項目に分ける形に一部置き換わる。
- [ADR 0263](0263-accounts-and-hosted-relay.md) の「運営が受け取るもの」に **APNs の端末トークン**が加わる（アカウント・ホスト・端末と結び付けて保持）。中身は引き続き読めない。
- `relay/server.mjs` の `authz.event` に `device-revoke`（組の剥奪）と `notify`（通知の塊が流れた）が足される。差し込みは待たずに呼ばれ、例外はログに出るだけ。api は `device-revoke` で APNs の結び付けを消し、`notify` で APNs へ運ぶ（Plus の中継側）。
- iOS のアプリの「通知」は Android と同じ画面・同じブリッジ（`plyRemote.notify`）で動くが、`state` は `plusOnly: true` と対象の組の数を返し、画面は Plus 限定の注記を出す。
- iOS の通知の許可はインストール時に尋ねず、通知を入れる操作のときだけ尋ねる（Android と同じ）。
- NSE の中で `removeDeliveredNotifications` が同じ会話の古い届け済みを消せるかは実機で確かめる（既知の危険）。取り消しは拡張では絞りきれないので、届いたまま残り、アプリを開いたときに整える。
