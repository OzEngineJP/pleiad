# 0271 公開の文書を Astro Starlight で組み、リリースのタグから作る

- 状態: 提案

## 状況

公開サイト（`site/`）は紹介・ダウンロード・Plus・プライバシーの 4 ページだけで、一般の利用者向けの使い方の文書が無い（Issue #149）。`docs/` は作る人向け。文書のうち、エージェントの一覧・設定の項目・操作の一覧はコードが正本で、手で写すとリリースのたびにずれる。公開は Cloudflare Workers の静的アセットで、ビルドコマンドは `node site/tools/check-i18n.mjs && node site/tools/build-site.mjs`（リポジトリから変えられない前提）。Cloudflare のビルド環境の clone は浅く、タグを持たない（2026-10 時点の観測）。

## 決定

- 文書は Astro Starlight で組み、`pleiad.dev/docs/` に置く（base `/docs`）。日本語を根に、英語を `/docs/en/` に置き、訳の無いページは日本語に戻してその旨を出す。検索は Pagefind。
- 文書のプロジェクトは `site/docs/` に置き、アプリの `package.json` と分けて自分の `package.json` と lockfile を持つ。版は固定する。
- 組むのは `site/tools/build-site.mjs`。Cloudflare のビルドコマンドを変えられないので、`build-site.mjs` が `site/docs` の依存を入れ（`node_modules` が無ければ `npm ci`）、Astro を組み、`site/docs/dist` を `_site/docs/` に写す。
- コードから作る部分は、最新の安定版の Release のタグ（先行版を除く `vX.Y.Z`。ダウンロードのリンクと同じ）の `core/` から作る。タグは Releases API で決め、`raw.githubusercontent.com` から必要なファイルだけを取る。取れないときは作業ツリーの `core/` から作り、その旨をページに出す。

## 理由

- Starlight は静的ファイルを出し、今の Cloudflare Workers の静的アセットにそのまま載る。日本語を根に英語を足せて、訳の無いページの戻しと Pagefind の日本語の検索がある。組むときに Node で動くので、リポジトリのモジュールを読んでページを作れる（Issue #149 の「作り方」で決めた）。
- 文書の依存をアプリと分けると、Electron の依存を文書のビルドへ持ち込まずに済む。版を固定すると、組むたびに出力が変わるのを防げる。
- タグから作ると、main への push で組んでも、まだ出していない機能が文書に載らない。リリースの公開後に `site-rebuild` がデプロイフックで組み直すので、ダウンロードのリンクと文書が同じ版になる。
- Cloudflare の clone にタグが無いので、`git show` ではタグの中身を取れない。Releases API は既にダウンロードのリンクで引いているので、同じタグを使って raw からファイルを取る。

## 影響

- main への push のビルドで、`site/docs` の `npm ci` と Astro のビルドが走る（数十秒）。Cloudflare のビルド環境の Node は 24.21.0 で、Astro 7 は 22.22 以上が要る。
- 生成に使う `core/`（や `tests/`）のファイルを増やすときは `site/tools/build-site.mjs` の `DOCS_SOURCE_FILES` に足す（そのファイルが import するファイルも足す）。
- タグのファイルを取れないときは作業ツリーから作り、ビルドは止めない。そのときは公開中の版と文書がずれうるので、ビルドのログの警告を見る。
- 手で書く文書のページは `site/docs/src/content/docs/`（日本語）と `site/docs/src/content/docs/en/`（英語）に置く。コードから作るページの出力（`src/content/docs/agents/`・`src/content/docs/reference/` の `.md`・`.mdx` と英語側）は追跡しない。エージェントごとのページに差し込む手書きの断片 `agents/<id>/_connect.md`・`en/agents/<id>/_connect.md` は追跡する。
- 利用者に見える機能（エージェント・操作・設定・能力の印）の一覧は `site/tools/docs-features.mjs` がコードから作る（エージェントの一覧は `agents.mjs` を import して取る）。`site/docs/docs-coverage.json` が機能ごとに、載せるページ（`cover`）か載せない理由（`except`）を持ち、`tests/unit/docs-coverage.mjs` が対応表と一覧・ページ・断片の有無を検査する。機能を足したら対応表を直す。
- `scripts/release-bump.mjs` は、見える機能が前の版のタグから変わったのに `site/docs/` が変わっていなければ止める。生成の一覧で足りるなど、変えなくてよいときは `--docs-unchanged "理由"` で理由を残して通す。
