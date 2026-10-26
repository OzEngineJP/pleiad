# 0271 モバイル版のリリースノートは前の <os>-v* のタグからの変更の題で自動で作る

- 状態: 提案

## 状況

- Android 版の GitHub Release のノートは、インストールの仕方と対応 OS だけの定型で、変更内容が載らなかった。Google Play の内部テストと TestFlight へも、`main` への push で自動で上げるようになった（[ADR 0258](0258-mobile-store-upload-on-main.md)）が、どちらにもリリースノート（Play の「新機能」・TestFlight の「テスト内容」）を渡していなかった（Issue #150）。
- モバイル版は、Android・iOS に効く変更があるたびに版が出る（ビルドごと）。デスクトップのように版ごとに原稿を書く形（`releases/<version>.json`）は、この頻度には合わない。

## 決定

1. **ノートは自動で作る。** 前に出した版から今のコミットまでの、その OS に効く変更（ワークフローの `on.push.paths` と同じ範囲）のコミットの題を並べる。マージのコミットは除き（連れてきた変更のコミットは数える）、件数が多いときは 20 件で切って「ほか N 件」とする。
2. **作るのは 1 本のスクリプト**（`scripts/mobile-release-notes.mjs`）にして、GitHub Release・Play・TestFlight の 3 か所から使う。「その OS に効く変更」の paths の一覧はスクリプトが正本で、ワークフローとのずれは `tests/unit/mobile-release-notes.mjs` が落とす。出し先ごとの形（GitHub の markdown の節・Play の言語ごとに 500 文字・TestFlight の 4000 文字）もスクリプトが収める。
3. **前の版の知り方は `<os>-v*` のタグにそろえる。** Android はリリースが作る `android-v<versionName>` をそのまま使う。iOS は GitHub Release を作らないので、`ios-testflight.yml` がビルドを上げたコミットに `ios-v<版>-<ビルド>`（例 `ios-v0.1.0-2565`）の軽いタグを付けて push する（upload ジョブに `contents: write`）。リリースの作業と同じコミットにタグが付くので、リリースの後に動く側（Play への呼び出し・手動のやり直し）では「そのコミット自身のタグなら 1 つ前を見る」とする。
   - ほかの案: 前に成功したワークフロー実行の `head_sha` を `gh api` で引く案は、実行の履歴が保存期間（既定 90 日）で消えるのと `actions: read` の権限が要るためやめた。App Store Connect の前のビルドから戸す案は、ビルド番号（`git rev-list --count`）からコミットを逆引きできないためやめた。
4. **前の版が見つからない・ノートの失敗ではリリースを止めない。** 最初の版やタグが無いときは変更の欄を省いて今までどおり出す。ノートの生成・Play の whatsnew・TestFlight の What to Test・タグの push が失敗しても `::warning::` で終える。

## 理由

- 前の版の基点をタグにすると、ストアの API や Actions の履歴の保存期間に関わらず、git だけで確実に戻せる。Android の `android-v*` と同じ形にすると、「最後に出した版のコミット」の印が 2 つの OS で共通になる。
- iOS のタグは軽いタグで、`ios-v` の接頭辞を付けるので、デスクトップの `v*`（自動更新が見る semver）にも Android の `android-v*` にも当たらない。
- Play の「新機能」は ja-JP、TestFlight の「テスト内容」は ja のローカライズに書く（アプリの既定の言語は日本語。英語のローカライズは今は無い）。

## 影響

- Android の GitHub Release の本文の頭に「変更」の節が出る（定型のインストールの文は残す）。Play の内部テストの「新機能」と TestFlight の「テスト内容」に同じ一覧が入る。
- `ios-v*` のタグがリポジトリに増える（上げたビルドごとに 1 つ）。
- コミットの題がそのまま公開の場所（GitHub Release・ストアのノート）に出る。リポジトリは public で題はもともと公開されているが、題に秘密・個人情報は書かないことが前提になる。
- 運用は [android-releases.md](../android-releases.md)・[ios.md](../ios.md)。
