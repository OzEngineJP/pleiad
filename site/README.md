# ランディングサイト

Pleiad の紹介ページ（`/`）とダウンロードのページ（`/download/`）。日本語と英語（`/en/`・`/en/download/`）の 2 言語。正本は `index.html`・`download/index.html`（日本語）で、英語は 1 つの辞書から生成する。辞書で訳すページは `tools/build-site.mjs` の `PAGES`。

```bash
node site/tools/check-i18n.mjs                 # 辞書と各ページの突き合わせ
node site/tools/build-site.mjs                 # _site/ に組む（--out <dir> で変える。--offline で GitHub を引かない）
python -m http.server 8799 --directory _site   # http://127.0.0.1:8799/ ・/download/ ・/en/ ・/en/download/
```

`site/` を直接配ると日本語だけが見える（言語の切り替えと英語は生成物にだけある）。公開は Cloudflare Workers の静的アセット（https://pleiad.dev/）。main への push で、Cloudflare がリポジトリの根でビルドコマンド `node site/tools/check-i18n.mjs && node site/tools/build-site.mjs` を走らせ（検査が落ちたら公開しない）、デプロイコマンド `npx wrangler deploy --config site/wrangler.jsonc` で `_site` を配る。

- `index.html`・`styles.css`・`main.js`: ページと、スクロールで場面を切り替えるアプリ画面の再現。
- 訳す要素には `data-i18n="キー"`（中身を置き換える。`<br>` や `<span class="nw">` を含めてよい）か、`data-i18n-attr="属性:キー;属性:キー"` を付け、英語を `locales/en.json` に書く。値の `{claude}` `{openai}` `{antigravity}` は各ロゴの `<img>` になる。
- JS が使う文言（星図の状態・状態の印・スマホの「許可した」など）は `index.html` の `<script id="strings">` に置く。英語は `en.json` の `strings`。分岐の札の文言は `<template>` の `data-i18n`。JS の中に文言を書かない（check が落とす）。
- ダウンロードのリンクはビルドのときに GitHub の Releases（API）から焼き込む。`data-release="キー"` の要素の href を置き換える（`version` だけは中身を「v0.31.1 · 日付」にする）。キーは `win-x64`・`win-arm64`・`mac-arm64`・`mac-x64`・`android`・`notes`・`all`。デスクトップは先行版を除いた最新の `vX.Y.Z`、Android は最新の `android-v*` の `.apk`。取れないとき（API の失敗・ファイルが無い・`--offline`）は Releases の一覧に向ける。環境変数 `GITHUB_TOKEN` があれば使う（無くても公開の API で足りる）。リリースした後は、サイトをビルドし直すまでリンクが前の版のまま。
- `os.js`: `<html data-os>` に `win`・`mac`・`linux`・`android`・`ios`・`other` を入れる。`data-for="win|mac"` はその OS だけ、`data-for="pc"` は Windows・Mac だけ、`data-for="any"` はそれ以外（JS が無いときも）に見せる。トップのヒーロー・ナビ・終わりのボタンは、Windows・Mac では OS の版を直に落とすボタンと「その他の OS」、それ以外では `/download/` への「ダウンロード」1 つ。`data-primary="win|mac|linux|android"` は、その OS のときに塗りのボタンになる（`/download/` の各列）。
- Windows の SmartScreen の一文は `/download/` だけにある（`download/index.html` の Windows の列の `.dl-note`、英語は `en.json` の `dl.smartscreen`）。Windows の配布に信頼される署名が付いたら、両方を消す。
- 画像は `main.js` の `asset()` で引く（英語は `/en/` にあり、文書からの相対では届かないため）。
- 公開先の URL（canonical・hreflang・og:url・og:image）は `tools/build-site.mjs` の `SITE_URL` 1 か所。
- `privacy/index.html`（日本語）・`en/privacy/index.html`（英語）: Android アプリのプライバシーポリシー（https://pleiad.dev/privacy/ 。Google Play の掲載に要る。`docs/android-releases.md`「Google Play」）。辞書を使わず、日本語と英語を別のファイルで持ち、そのまま写す。見た目は `legal.css`（字が多いので削った書体は使わない）。check は対があることと英語の側に日本語が無いことを見る。アプリが送るもの・権限・保存するものを変えたら、両方を直して制定日の下に更新日を書く。
- `branch.js`: アプリ画面の分岐（`web/branch-view.mjs` の移植。寸法・時間・加減速はアプリと同じ）。アプリの分岐の動きを変えたら合わせる。
- `hero.js`: ヒーローの星図（three.js。版は `index.html` の importmap で固定）。星 = 会話の節、線 = 分岐、青 = 今いる枝、赤紫の ◆ = 承認待ち、回る弧 = 実行中。色と印の意味はアプリと同じ（`docs/design-system.md`）。
- WebGL が無い環境では `assets/sky.webp`（星図を焼いた一枚）を出す。`assets/og.png`（日本語）・`assets/og-en.png`（英語）は共有用の画像。どれも星図の形や見出しを変えたら撮り直す（窓 1200×630、`.hero-copy .cta, .hero-copy .meta, .nav-links` を隠し、`.hero` の高さを 630px にして、星図が落ち着いた所を撮る）。
- 書体は使う字だけに削った woff2（`assets/fonts/`、OFL）。文言（`index.html`・`download/index.html`・`main.js`・`locales/en.json`）を変えたら `python site/tools/subset-fonts.py` で作り直す。
- 動きは `prefers-reduced-motion` で止まる。
