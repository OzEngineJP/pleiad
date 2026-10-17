# 0215 macOS 版を Evaluation release で Windows 版と一緒に出す

- 状態: 提案

## 状況

macOS のパッケージは `Desktop packages`（署名なし・手動）と `Desktop signed release`（`platforms=all`）で作れたが、普段の配布（`Evaluation release`。タグの push で Windows だけを公開する）には入っていなかった。署名の無い macOS 版は Gatekeeper に止められ、electron-updater（Squirrel.Mac）の自動更新も使えない。Developer ID の署名と公証には Apple Developer Program の資格情報が要る。

## 決定

- `Evaluation release` に `mac` のジョブを足す。Repository Variable `PLY_MAC_RELEASE` が `on` のときだけ走る。
- 署名は Developer ID Application の証明書（`MAC_CSC_LINK`・`MAC_CSC_KEY_PASSWORD`）、公証は App Store Connect の API キー（`APPLE_API_KEY`・`APPLE_API_KEY_ID`・`APPLE_API_ISSUER`）。どれも Environment `release` の Secrets に置く（ADR 0214）。`scripts/release-signing.cjs` は Apple ID の形も引き続き受け付ける。
- Windows（`windows`）と macOS（CPU ごとの `mac (x64)`・`mac (arm64)`）のビルドは並んで走り、`publish` のジョブが両方を同じ下書きに入れ、照合してから一緒に公開する。どれかが落ちたら公開しない。

## 理由

- 公開までの時間は、いちばん遅いジョブで決まる。macOS の時間の大半は Apple の公証の待ちなので、CPU ごとに分けて待ちを重ねる。
- 1 つのタグ・1 つのリリースに両 OS をそろえれば、`latest.yml`・`latest-mac.yml` の版が食い違わない。immutable releases のため、公開後に macOS の分を足す運用は取れない。
- API キーは個人の Apple ID・2 要素認証に依らず、権限を絞って作り直せる。
- 変数で切り替えるので、資格情報を登録するまで今の Windows の配布は変わらない。

## 影響

- `PLY_MAC_RELEASE=on` の間、公開は `windows` と `mac` の遅い方を待ち、macOS の失敗は Windows の公開も止める。macOS の実行枠は CPU ごとの 2 つ分を使う。
- main の CI に macOS の脚は無く、`mac` のジョブもテストは配布に関わるものだけを流す。
- 手順は `docs/desktop-releases.md`「macOS の配布」。
