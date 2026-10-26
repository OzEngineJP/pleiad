# ランディングサイトと使い方の文書

Pleiad の紹介ページ（`/`）とダウンロードのページ（`/download/`）と Pleiad Plus のページ（`/plus/`）、使い方の文書（`/docs/`）。日本語と英語（`/en/`・`/en/download/`・`/en/plus/`・`/docs/en/`）の 2 言語。正本は `index.html`・`download/index.html`・`plus/index.html`（日本語）で、英語は 1 つの辞書から生成する。辞書で訳すページは `tools/build-site.mjs` の `PAGES`。文書は `site/docs/` の Astro Starlight のプロジェクトで組む（下の「文書」）。

```bash
node site/tools/check-i18n.mjs                 # 辞書と各ページの突き合わせ
node site/tools/build-site.mjs                 # _site/ に組む（--out <dir> で変える。--offline で GitHub を引かない）
npm ci --prefix site/docs                      # 文書の依存（build-site.mjs も、無ければ入れる）
python -m http.server 8799 --directory _site   # http://127.0.0.1:8799/ ・/download/ ・/en/ ・/en/download/ ・/docs/ ・/docs/en/
```

`site/` を直接配ると日本語だけが見える（言語の切り替えと英語は生成物にだけある）。公開は Cloudflare Workers の静的アセット（https://pleiad.dev/）。main への push で、Cloudflare がリポジトリの根でビルドコマンド `node site/tools/check-i18n.mjs && node site/tools/build-site.mjs` を走らせ（検査が落ちたら公開しない）、デプロイコマンド `npx wrangler deploy --config site/wrangler.jsonc` で `_site` を配る。

- `index.html`・`styles.css`・`main.js`: ページと、スクロールで場面を切り替えるアプリ画面の再現。`plus/index.html`・`plus.js`: Pleiad Plus のページと、機能のカルーセル。
- 訳す要素には `data-i18n="キー"`（中身を置き換える。`<br>` や `<span class="nw">` を含めてよい）か、`data-i18n-attr="属性:キー;属性:キー"` を付け、英語を `locales/en.json` に書く。値の `{claude}` `{openai}` `{antigravity}` は各ロゴの `<img>` になる。
- JS が使う文言（星図の状態・状態の印・スマホの「許可した」など）は `index.html` の `<script id="strings">` に置く。英語は `en.json` の `strings`。分岐の札の文言は `<template>` の `data-i18n`。JS の中に文言を書かない（check が落とす）。
- ダウンロードのリンクはビルドのときに GitHub の Releases（API）から焼き込む。`data-release="キー"` の要素の href を置き換える（`version` だけは中身を「v0.31.1 · 日付」にする）。キーは `win-x64`・`win-arm64`・`mac-arm64`・`mac-x64`・`android`・`notes`・`all`。デスクトップは先行版を除いた最新の `vX.Y.Z`、Android は最新の `android-v*` の `.apk`。取れないとき（API の失敗・ファイルが無い・`--offline`）は Releases の一覧に向ける。環境変数 `GITHUB_TOKEN` があれば使う（無くても公開の API で足りる）。main への push のビルドはリリースの公開より先に走るので、Evaluation release の `publish` が通った後に、別のジョブ `site-rebuild`（権限も checkout も持たない）が Cloudflare のデプロイフック（`release` 環境のシークレット `CF_SITE_DEPLOY_HOOK`）を呼んで組み直す。呼べなかったときはジョブに警告が出て、次の main への push までリンクが前の版のまま。
- `site/docs/`（`/docs/`）: 使い方の文書。Astro Starlight で組み、日本語を根に、英語を `/docs/en/` に置く（訳の無いページは日本語に戻し、その旨を出す。Starlight の fallback）。検索は Pagefind（日本語の分かち書きに対応）。文書のプロジェクトは `site/docs/` に置き、アプリの `package.json` と分けて自分の `package.json` と `package-lock.json` を持つ。版は固定する（Astro 7.4.0・Starlight 0.42.6。Cloudflare のビルド環境の Node は 24.21.0 で、Astro 7 は 22.22 以上が要る）。favicon は `site/assets/favicon.svg` の写しを `site/docs/public/` に置く（Starlight は `public/` から配る）。色と書体は `site/docs/src/styles/docs.css` で `styles.css` に軽く合わせる（使う字だけに削った `site/assets/fonts/` は、文書の字が欠けるので使わない）。
- 文書のうち、コードから作れる部分（エージェントの一覧）は `site/docs/scripts/generate.mjs` が `core/backends/agents.mjs` から組む。`build-site.mjs` が、最新の安定版の Release のタグ（ダウンロードのリンクと同じ）から raw.githubusercontent.com でそのファイルを取り、`site/docs/scripts/generate.mjs` に渡す。Cloudflare のビルド環境は clone が浅くタグが無いので、`git show` ではなく Releases API のタグを使う。取れた写しは `site/docs/.cache/<タグ>/` に残す（追跡しない）。取れないとき（`--offline`・API の失敗）は作業ツリーの `core/` から作り、その旨をページに出す。
- `build-site.mjs` は、`site/docs/node_modules` が無ければ `npm ci` で文書の依存を入れてから Astro を組み、`site/docs/dist` を `_site/docs/` に写す。`--no-install` を付けると依存を入れずに組む（無ければ止まる）。生成に使う `core/` のファイルを増やすときは `build-site.mjs` の `DOCS_SOURCE_FILES` に足す（そのファイルが import するファイルも足す）。
- 手で書く文書のページは `site/docs/src/content/docs/`（日本語）と `site/docs/src/content/docs/en/`（英語）に置き、`site/docs/astro.config.mjs` の `sidebar` に足す。コードから作るページの出力（`src/content/docs/agents/`）は追跡しない。`site/docs/` で `npm run dev` でも見られる（先に生成が走る）。
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
