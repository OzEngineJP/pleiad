# 0255 モバイル版の変更が main に入ったら、Play の内部テストと TestFlight へ自動で上げる

- 状態: 承認（2026-10-22。利用者の指示）

## 状況

モバイル版（`mobile/`）は、Android の APK を `main` への push で GitHub Release へ自動で出している（[ADR 0066](0066-android-release-on-main-push.md)）。ストアへは手動だけだった。

- Google Play へは `android-play.yml` を人が起こして上げる（[ADR 0142](0142-android-play-distribution.md) の決定 3）。上げるたびに審査とテスターを巻き込むことを理由に、手動にしていた。
- iOS は `ios-app.yml` の `testflight` の入力を人がオンにしたときだけ上げる雛形で、署名の Secrets が無く、一度も動いていなかった。ビルド番号は実行番号だった。
- Play のアプリと App Store Connect のアプリ（`dev.pleiad.app`）は登録済みで、Play には内部テストのトラックがある。利用者は 2026-10-22 に、モバイルの変更が `main` に入ったとき（と手動で）、iOS・Android ともストアへ自動で上げること、Android は内部テストへ公開してよいことを決めた。

## 決定

1. **Android**: `android-release.yml` が新しい版の APK を出したら、同じワークフローの続きのジョブが `android-play.yml` を `workflow_call` で呼び、同じコミットの AAB を内部テスト（`internal`）へ上げてすぐ公開する（`completed`）。版がもうあって APK を出さなかったときは上げない。ほかのトラック（クローズドテスト）・状態は、今までどおり手動の `android-play.yml` で上げる。`production`・`beta` は、自動でも手動でも弾いたまま。
2. **iOS**: 新しい `ios-testflight.yml` が、`main` への push のうち iOS に効く変更（`mobile/ios/**` の試験以外・Android と共有の `mobile/www/**`・`capacitor.config.json`・`package.json`・`package-lock.json`・上げる道具）と、手動の起動で動く。`ios-app.yml` の試験を `workflow_call` で通してから、署名した archive を TestFlight へ上げる。`ios-app.yml` からは配布のジョブを除く。
3. **版の決め方は Android と同じ**: iOS のビルド番号は `git rev-list --count HEAD`（Android の `versionCode`）、版は `mobile/package.json` の `version`（Android の `versionName` の頭）。同じコミットは両方で同じ番号になる。
4. **やり直しで二重に上げない**: Android は今までどおりタグの有無で、iOS は App Store Connect API で同じビルド番号の有無を、重いビルドの前に確かめる（`mobile/scripts/asc-build.mjs`）。
5. iOS の署名は、手元で作った鍵の Apple Distribution 証明書（`.p12`）と App Store Connect 用プロファイル、アップロード用の App Manager の API キーを、Environment `release` の Secrets に置く（[ADR 0214](0214-release-environment-secrets.md)）。クラウドの署名（Admin の API キーで Xcode に証明書を作らせる）は使わない。

## 理由

- 内部テストは Play の審査が無く、届く先は登録したテスターだけなので、[ADR 0142](0142-android-play-distribution.md) が手動にした理由（審査とテスターを毎回巻き込む）が小さい。審査のあるクローズドテストと製品版は、人が決めるまま残す。
- APK の流れの続きにすると、APK と同じコミット・同じ `versionCode` だけが Play へ行き、APK を出さなかったやり直しで Play が拒む `versionCode` を上げに行かない。Play の手順は `android-play.yml` の確かめ（入力・Secrets・署名の照合）をそのまま使い、2 つの道で同じものが動く。
- iOS を Android と同じ `rev-list --count` にすると、2 つのストアのビルドが同じコミットで対応し、実行番号のように再実行や別のワークフローで数がずれない。App Store Connect は同じ版のビルド番号の重複を拒むので、上げる前に有無を見て、10 分以上のビルドを無駄にせず正常に終える。
- 試験を `workflow_call` で通すのは、試験に落ちたコミットを TestFlight へ上げないため。`ios-app.yml` の単独の実行と組が重ならないよう、並びの組に呼び出し元の名前を入れる（重なると、待っている方が後の push で取り消される）。
- Admin の API キーを CI に置くと、証明書の発行・ユーザーの管理までできる。アップロードとビルドの読み取りには App Manager で足りるので、権限を絞り、証明書とプロファイルは人が作って期限の前に入れ替える。

## 影響

- `mobile/` の iOS・共有の部分の変更が `main` に入るたびに、TestFlight へビルドが上がる。Android に効く変更では、GitHub Release の APK と同じ版が Play の内部テストに公開される。
- iOS の版（`mobile/package.json` の `version`）が App Store で公開されたら、その版にはビルドを足せない。次の変更の前に `version` を上げる（Android の `versionName` も変わる）。
- 暗号の輸出コンプライアンスは Info.plist に宣言していないので、TestFlight のビルドごとに App Store Connect での回答が要る。
- 証明書とプロファイルの期限（2027-10-22）の前に作り直し、Secrets を入れ替える（[ios.md](../ios.md)「作り直すとき」）。
- 運用は [android-releases.md](../android-releases.md)「Google Play」と [ios.md](../ios.md)「TestFlight への自動の配布」。
