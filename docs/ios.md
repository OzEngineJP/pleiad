# iOS の殻と TestFlight

iPhone・iPad（iOS / iPadOS 16 以上）向けの Capacitor の殻は `mobile/ios/App/`。ホスト一覧は Android と同じ `mobile/www`、暗号とループバックの中継は `mobile/ios/remote-core/` を使う（[ADR 0174](adr/0174-ios-capacitor-shell.md)）。通知は対象外（ADR 0086）。公式の中継とログインを入れるときの App Review の危険（4.2.7 のリモートデスクトップのクライアント・4.8 の Sign in with Apple・5.1.1(v) のアカウントの削除）は [ADR 0183](adr/0183-accounts-and-hosted-relay.md)（提案）の「影響」。

ログインの受け口（`pleiad://auth`）だけを置いてある。流れは [plus.md](plus.md) の iOS の節。

## 登録前にできること

Apple Developer Program の登録も署名も、シミュレーターのビルドには要らない。

```sh
npm ci
cd mobile
npm ci
npm run sync:ios
```

`cap sync ios` は `www`・設定のコピーと `CapApp-SPM` の生成を行う。remote-core は Xcode プロジェクトの別のローカル依存なので、sync しても消えない。CocoaPods は使わない。

Mac では Xcode 26.3 を選び、次を実行する（[Capacitor 8 は Xcode 26 以上](https://capacitorjs.com/docs/updating/8-0)）。

```sh
xcodebuild build -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
xcodebuild test -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=<利用可能な iPad>' CODE_SIGNING_ALLOWED=NO
```

`.github/workflows/ios-app.yml` が macos-15 / Xcode 26.3 で同じビルドと、Keychain・殻の受け渡しの単体試験を行う（TestFlight へ上げる `ios-testflight.yml` も、上げる前にこれを呼ぶ）。既存の `ios-remote-core.yml` は Xcode 16.4 のまま、CryptoKit と Node の中継との往復を検証する。Windows ではルートの `npm ci` 後に以下を実行できる。

```sh
swift test --package-path mobile/ios/remote-core
node tests/run.mjs ios-shell
node tests/run.mjs mobile-shell
node tests/run.mjs mobile-web
```

`PLEIAD_INTEROP=on` を付けると、Node が無い場合も往復試験を黙って省略しない。シミュレーターでは QR カメラを使えないので、ペアリング用リンクを貼り付けて接続する。Xcode では `npm run open:ios` から App スキームを開ける。

## TestFlight への自動の配布

`main` に iOS に効く変更が入ると、`.github/workflows/ios-testflight.yml`（Actions の **iOS TestFlight**）が署名した archive を TestFlight へ上げる。Actions の画面から手動でも起こせる（`main` の上だけ）。Android の Play の内部テストへの自動の配布と同じ考え方（[ADR 0258](adr/0258-mobile-store-upload-on-main.md)）。

- **いつ動くか**: `main` への push のうち、`mobile/ios/**`（`App/AppTests/**`・`remote-core/Tests/**` の試験だけの変更は除く）・`mobile/www/**`・`mobile/capacitor.config.json`・`mobile/package.json`・`mobile/package-lock.json`・上げる道具（`mobile/scripts/ios-testflight.sh`・`mobile/scripts/asc-build.mjs`・ワークフロー自身）に変更があるとき。PR からは上げない。
- **流れ**: `ios-app.yml` の試験（シミュレーターのビルドと Keychain の試験。`workflow_call` で呼ぶ）→ Secrets の確かめ（足りなければ名前を出して止まる）→ 版の決定 → App Store Connect の確かめ（`asc-build.mjs`。アプリがあり、同じビルド番号がまだ無いこと）→ `npm ci`・`cap sync ios` → 署名した archive を `xcodebuild -exportArchive` で上げる（`ios-testflight.sh`）。実行は 1 つずつ順に走る。
- **版**: ビルド番号（`CFBundleVersion`）は Android の `versionCode` と同じ `git rev-list --count HEAD`、版（`CFBundleShortVersionString`）は `mobile/package.json` の `version`（Android の `versionName` の頭と同じ）。同じビルド番号が App Store Connect にもうあれば、ビルドせずに正常終了する（同じコミットのやり直しで二重に上げない）。
- **版を上げるとき**: App Store で公開した版（例 `0.1.0`）には、後からビルドを足せない（Apple が拒む）。審査に出した版が公開されたら、次の変更の前に `mobile/package.json` の `version` を上げる（Android の `versionName` の頭も一緒に変わる）。
- **秘密の扱い**: 証明書・プロファイル・API キーは実行の間だけ一時の Keychain とランナーの一時領域に復元し、成否にかかわらず消す。Keychain の検索リストは終わったら元に戻す（手元の Mac で流しても利用者の設定を残さない）。プロファイルの Bundle ID が `capacitor.config.json` の `appId` と違えば止まる。
- **上がった後**: App Store Connect の処理が終わると TestFlight に出る。暗号の輸出コンプライアンスは Info.plist の `ITSAppUsesNonExemptEncryption` = NO で宣言し、ビルドごとの質問を出さない（暗号は HTTPS と、リモートの Noise の計算に使う iOS の CryptoKit の標準の方式〈AES-GCM・ChaChaPoly・Curve25519・SHA-256〉だけで、独自の暗号は使わない。2026-10-23 に利用者が決めた）。独自の暗号や iOS に無い暗号のライブラリを足すときは、この宣言を見直す。内部テスターのグループに自動で配るかは、TestFlight のグループの設定で決める。

Secrets は Environment `release` に置く（[ADR 0214](adr/0214-release-environment-secrets.md)。`gh secret set <名前> --env release`）。秘密ファイルはリポジトリに置かない（`temporary/` も含む）。

| Secret | 内容 |
| --- | --- |
| `IOS_TEAM_ID` | Developer の Team ID |
| `IOS_DISTRIBUTION_P12_BASE64` | 秘密鍵付き Apple Distribution 証明書 `.p12` の Base64 |
| `IOS_DISTRIBUTION_P12_PASSWORD` | `.p12` のパスワード（空にしない） |
| `IOS_PROVISION_PROFILE_BASE64` | `dev.pleiad.app` の App Store Connect 用 `.mobileprovision` の Base64 |
| `ASC_KEY_ID` | API キーの Key ID |
| `ASC_ISSUER_ID` | API キーの Issuer ID |
| `ASC_PRIVATE_KEY_BASE64` | API キー `.p8` の Base64 |

2026-10-22 に入れたもの: Team は Oz Engine Inc.、証明書は CSR を手元の openssl で作った Apple Distribution（期限 2027-10-22）、プロファイルは「Pleiad iOS App Store CI」（同じ期限）、API キーは「Pleiad CI TestFlight」（App Manager）。証明書とプロファイルの期限の前に作り直して Secrets を入れ替える。

### 作り直すとき

1. CSR を作る: `openssl genrsa -out dist.key 2048` と `openssl req -new -key dist.key -out dist.csr -subj "/emailAddress=<メール>/CN=<名前>/C=JP"`。Apple Developer の Certificates で「Apple Distribution」を選んで CSR を上げ、`.cer` を落とす。
2. `.p12` にする: `openssl x509 -inform DER -in dist.cer -out dist.pem` と `openssl pkcs12 -export -legacy -inkey dist.key -in dist.pem -out dist.p12`（macOS の `security import` が読める形にするため `-legacy`）。
3. Profiles で「App Store Connect」を選び、App ID `dev.pleiad.app` と 1 の証明書でプロファイルを作って落とす。
4. App Store Connect の「ユーザとアクセス」→「統合」→「チームキー」で App Manager のキーを作る（`.p8` は一度しか落とせない）。[API キーの管理](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
5. 上の表の Secrets を入れ、手元のファイルを消す。

手元で同じことを確かめるときは、上の Secrets と同じ名前の環境変数に `RUNNER_TEMP`・`IOS_BUNDLE_ID`・`IOS_BUILD_NUMBER`・`IOS_MARKETING_VERSION` を足して、`mobile/` の `npm ci`・`npm run sync:ios` の後に `bash mobile/scripts/ios-testflight.sh` を流す（本当に TestFlight へ上がる。ビルド番号は CI の番号より小さいものにしない）。2026-10-22 に、この手順でビルド 2565 を上げられること（archive・署名・アップロード）と、`asc-build.mjs` が本物の App Store Connect でアプリ・ビルドの有無と鍵・Bundle ID の誤りを見分けることを確かめた。`tests/unit/ios-testflight-workflow.mjs` が、起動の条件・版の決め方（Android との突き合わせ）・Secrets の確かめ・偽の App Store Connect API への `asc-build.mjs` を確かめる。

## アイコンとスプラッシュ（承認済み（2026-10-09））

アイコンとスプラッシュは Pleiad の印（青 `#3a499e` の地に白い印。Android と同じ形）。形と作り方は [android-releases.md](android-releases.md)「アイコンとスプラッシュ」、書き出しは `mobile/scripts/generate-icons.mjs`（`cd mobile && npm run icons`）。

- **AppIcon**: `Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`（1024×1024・透過なし。OS が角を丸めるので、角は丸めない全面塗り）。印の幅は全体の約 60%。
- **Splash**: `Splash.imageset` の `splash-2732x2732{,-1,-2}.png`（明。白地に ink 色の印）と `splash-2732x2732-dark{,-1,-2}.png`（暗。`#1b1c23` の地に明るい印。`Contents.json` の `appearances` が `luminosity: dark`）。`LaunchScreen.storyboard` は `scaleAspectFill` で全面に出すので、印は 2732 の正方形の中央に全体の約 14% の幅で置いてある（iPhone で幅の約 3 割、iPad の横向きでも切れない）。1x/2x/3x は同じ画素（既定の `@capacitor/assets` と同じ作り）。

実機（iPhone・iPad の明・暗、ホーム画面・App Switcher・起動の一瞬）での見え方は、Xcode のない環境では確かめていない。TestFlight の確認の項目に入れる。

## iPad の TestFlight 確認

App Store Connect で処理が終わった後、内部テスターのグループにビルドを追加する。招待先の iPad に TestFlight を入れ、招待を受けて Pleiad をインストールする。外部テスターへ配る場合はベータ版の審査も必要になる。[内部テスターを招待](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)

- ホストの QR を読み、双方の 6 桁のコードを確認して承認する。カメラ拒否・キャンセル・貼り付け・外部の `pleiad://pair` リンクも試す。
- 会話の表示・送信、添付の選択と保存、可視化の別窓、外部リンク、縦横の回転・キーボード・Split View を試す。
- 背面・画面ロック・Wi-Fi の切替後に戻り、接続と最後の会話が復帰するか見る。再起動、一旦一覧へ戻った後の起動、端末の失効、ホスト削除も試す。
- WKWebView のループバックで `isSecureContext`・`crypto.randomUUID()`・Cookie・WebSocket が動くか確認する（[remote.md §11](remote.md#11-未決)）。端末移行後は Keychain の鍵が移らず、再ペアリングすることを確かめる。

Windows では UIKit・WebKit・AVFoundation・Security の型検査と署名を実行できない。Swift の核と JS の試験が通っても、アプリ全体のビルド・Keychain の試験は macOS CI、カメラ・中断復帰・配布は実機で初めて確かめられる。
