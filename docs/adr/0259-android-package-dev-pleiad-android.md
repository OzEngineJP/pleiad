# 0259 Android のアプリ ID を dev.pleiad.android にし、署名鍵を新しくする

- 状態: 承認（2026-10-23。利用者の指示）

## 状況

Android のアプリ ID（パッケージ名）は `dev.pleiad.app`（iOS の Bundle ID と同じ）で、GitHub Release の APK と Google Play のアプリ署名鍵は同じ鍵（SHA-256 `70:4C:…`）だった（[ADR 0142](0142-android-play-distribution.md)）。

- この鍵と `dev.pleiad.app` は、準備中に別のデベロッパーのアカウントで Android デベロッパーの確認に登録されていた。そのアカウントの Play のアプリは消えていて、登録を外す手段が無い。
- Oz Engine の Play のアプリ（`dev.pleiad.app`）は、パッケージ名と今の署名鍵・アップロード鍵を Oz Engine の名義で登録済みだが、`70:4C` の鍵は「別のデベロッパーがこの鍵ですでに登録しています」で追加できない。アプリ署名鍵は `70:4C` から切り替えてあったが、前の鍵として履歴に残る。
- そのため Play は `dev.pleiad.app` の AAB を「パッケージ名がデベロッパーの確認済みの ID に登録されていない」で受け付けず、自動の配布（[ADR 0258](0258-mobile-store-upload-on-main.md)）も手動の配布も止まっていた。
- 解決は Google のサポートへの問い合わせ（結果も期間も分からない）か、パッケージ名を変えることだった。利用者は 2026-10-23 に、パッケージ名を変えることを選んだ。

## 決定

1. **Android のアプリ ID を `dev.pleiad.android` にする**（`mobile/android/app/build.gradle` の `applicationId`）。Kotlin のパッケージ（`namespace`）と iOS の Bundle ID・`capacitor.config.json` の `appId` は `dev.pleiad.app` のまま。
2. **APK と Play のアプリ署名鍵を新しい鍵にする**（RSA 4096、SHA-256 `7F:BC:3F:2A:…:E1:F8:C8`）。Play の新しいアプリには PEPK で登録し、GitHub Release の APK も同じ鍵で署名する。`70:4C` の鍵は使わない。
3. アップロード鍵は今の別の鍵（SHA-256 `07:86:…`）を使い続ける。
4. Play の `dev.pleiad.app` のアプリと、そのパッケージ名の Android デベロッパーの確認の登録は、消さずに未公開のまま残す。

## 理由

- 新しいパッケージ名と鍵は、別のデベロッパーの登録とぶつからず、問い合わせの返事を待たずにすぐ出せる。アプリを作った時点で、Play が `dev.pleiad.android` と新しい鍵を Oz Engine の名義で登録する。
- アプリ ID が変わると、既存の端末はどのみち入れ直しになる。署名鍵を同時に変えても利用者の手間は増えないので、問題の鍵の履歴を持ち越さない。
- GitHub の APK と Play のアプリ署名鍵を同じにしておくと、2 つの配り方の間を入れ直さずに移れる（[ADR 0142](0142-android-play-distribution.md) の考えを引き継ぐ）。
- 古い名前の Play のアプリと登録を残すと、Play では一度使ったパッケージ名を誰も使い直せず、Android デベロッパーの確認でも後から来た人は審査なしに登録できないので、同じ名前を第三者に使われない。

## 影響

- `dev.pleiad.app` の APK を入れた端末は、`dev.pleiad.android` の版で上書きできない。消して入れ直し、ペアリングをやり直す。
- 環境 `release` の Secrets（`PLY_ANDROID_KEYSTORE_*`・`PLY_ANDROID_KEY_*`）と変数 `PLY_ANDROID_CERT_SHA256` を新しい鍵に替える。替えるのはこの変更が `main` に入るときで、それより前に替えると `main` の `dev.pleiad.app` の APK が別の鍵で出てしまう。
- Plus のログインの App Links（`https://account.pleiad.dev/app/callback`）の `assetlinks.json` は、`dev.pleiad.android` と新しい鍵を足すまで確かめられない。その間は予備の戻り道（`pleiad://auth`）で戻る（`docs/plus.md`）。
- 掲載情報・アプリのコンテンツの申告・テストの設定は、Play の新しいアプリに入れ直す。
- iOS と Android でアプリ ID が違う。サーバー・文書でアプリ ID を書くところは、どちらの値かを書き分ける。
