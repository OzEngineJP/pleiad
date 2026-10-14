# ADR 0206: Claude Agent SDK を配布物に入れず、初めて要るときに npm のレジストリから取る

- 状態: 提案
- 日付: 2026-10-14
- 関連: [desktop-releases.md](../desktop-releases.md)「Claude Agent SDK は同梱しない」、[zero-downtime-update/design.md](../zero-downtime-update/design.md) §5.1、[ADR 0151](0151-zero-downtime-update.md)

## 状況

SignPath Foundation の無償のコード署名を受けるには、署名するインストーラーとアプリの中身がすべて OSI 承認のライセンスでなければならない。

これまでのデスクトップ版は `@anthropic-ai/claude-agent-sdk` を `resources/app/node_modules/` に入れていた。このパッケージのライセンスは `SEE LICENSE IN README.md` で、`LICENSE.md` は「© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements …」である。OSI のライセンスではない。Claude Code の実行ファイル（optionalDependencies の `@anthropic-ai/claude-agent-sdk-<os>-<arch>`）は、すでに同梱から外している。

SDK の依存は peerDependencies の 3 つだけである。

| パッケージ | ライセンス |
|---|---|
| `@anthropic-ai/sdk` | MIT |
| `@modelcontextprotocol/sdk` | MIT |
| `zod` | MIT |

`@modelcontextprotocol/sdk` と `zod` は Pleiad 自身も使うので、もとから同梱している。`@anthropic-ai/sdk` は SDK の peer として入っていただけで、Pleiad のコードは読まない。

## 決定

1. **配布物に SDK を入れない。** `package.json` の `devDependencies` に版を固定して置く（開発とテストのため）。`electron-builder.yml` の `files` でも `!node_modules/@anthropic-ai/claude-agent-sdk/**` を除く。`@anthropic-ai/sdk` も devDependencies 扱いになり、同梱されない。リリース版・Store 版は `electron-builder.yml` から派生するので、同じく入らない。
2. **版はビルドで 1 つに固定する。** `core/claude-sdk-pin.json` に名前・版・`integrity`（sha512）・tarball の URL を書く。値は `package-lock.json` と同じで、`tests/unit/claude-sdk-pin.mjs` が食い違いを落とす。
3. **取り方**（`core/claude-sdk-install.mjs`）。
   - `registry.npmjs.org` の tarball を取る。https だけを許す（テストの loopback の http は除く）。リダイレクトは 5 回まで、大きさは 64 MB まで。プロキシは `HTTPS_PROXY` などの環境変数に従い、OS の証明書ストアも使う。
   - 固定の sha512 と比べ、合わなければ何も置かずに断る（`integrity`）。
   - tar は自前で読み、書く前に全部の項目を確かめる。置き場の外へ出るパス（`..`・絶対パス・ドライブ名・Windows の予約名）、シンボリックリンク・ハードリンク・デバイス、同じ名前の重複は、1 つでもあれば全体を断る。
   - `<データ置き場>/claude-sdk/.tmp-<版>-…` に展開し、最後に印のファイル `.pleiad-sdk.json` を書いてから `claude-sdk/<版>/` へ名前を替える。途中で止まったものは印が無いので使われず、1 時間後の掃除で消える。
4. **読み方**（`core/claude-sdk.mjs`）。
   - 置き場の版を `pathToFileURL` で動的 import する。
   - SDK の中の素の指定子（`@anthropic-ai/sdk`・`@modelcontextprotocol/sdk`・`zod` など）は、Node のモジュールの hook（`module.registerHooks`、無ければ `module.register`）で、アプリの `package.json` を起点に解決し直す。peer はアプリに同梱した写しを読む。
   - `@anthropic-ai/sdk` は同梱しない。いまの SDK は読み込みの時点でこれを要らない（テストで確かめる）。
5. **どこから読むかは `claudeSdkSource` の 1 か所で決める。** アプリの直下の `node_modules/@anthropic-ai/claude-agent-sdk` があれば `local`（開発・テスト）、無ければ `download`（配布物）。上の階層は探さない。`AGENT_HOST_CLAUDE_SDK=local|download` でどちらかに固定できる。
6. **取る時と、利用者への案内。**
   - 取るのは、Claude のバックエンドを初めて使うとき、または設定の「エージェント」の取得のボタンを押したときだけ。アプリの起動や、ほかのバックエンドは待たせない。
   - 取る前に、「Anthropic の SDK を npm から取得し、Anthropic の利用条件が適用される」と案内し、規約へのリンクを出す。ボタンを押すことを同意とし、`claude-sdk/consent.json` に残す。同意が無い間は、Claude の送信は SDK が無いエラーで戻り、設定を開く。
   - 進み具合と失敗（`offline`・`proxy`・`tls`・`http`・`integrity`・`extract`・`disk`・`aborted`）は画面に出し、もう一度取れるようにする。
   - 取得の操作 `claudeSdkInstall` は human-only にする（AI は、人の同意の代わりに取りに行けない）。
7. **更新で版が変わるとき。**
   - 新しい main が、組み終えた実行場所の `pleiad-node.exe` で新しい版の `core/claude-sdk-fetch.mjs` を走らせ、切り替えの前に新しい版を取っておく。同意が無ければ取らない。
   - 取れなかったときに保持役に載った Claude のターンがあれば、引き継ぎをやめ、作業が終わるのを待つ切り替えに戻る（新しいサーバーが SDK 無しで Claude のターンを付け直すことはしない）。待つ間も 60 秒ごとに取り直し、取れたら引き継ぎに戻る。Claude のターンが無ければ、取れなくても今までどおり引き継ぐ。
   - 古い版は、今の固定の版と、直前に使った版を 1 つ残す。消すのは起動から 5 分後の裏の掃除である。走っている会話は止めない。

## 理由

- **SDK を同梱しない以外に、署名の条件を満たす道が無い。** SDK のライセンスは配布を認めていない。npm から利用者の PC へ直に取れば、Pleiad は Anthropic のコードを配らない。
- **npm の CLI は使わない。** 利用者の PC に Node と npm があるとは限らない。また、npm は依存の解決や scripts の実行まで行い、確かめる範囲が広がる。取るのは tarball 1 つなので、自前で取って確かめるほうが小さく、テストもしやすい。
- **版を固定し、`package-lock.json` と同じ sha512 で確かめる。** 開発で試した版と利用者が動かす版が同じになり、レジストリやプロキシで中身を差し替えられても気付ける。
- **展開を検証してから名前を替える。** tar のパスの抜け道は典型的な穴である。途中で止まった展開を使わないためにも、確かめ終えたものだけを最後に置く。
- **peer の解決を hook で直す。** 取った SDK はアプリの外の置き場にあるので、素の Node の解決ではアプリの `node_modules` を見つけられない。SDK の側に依存を入れ直す（npm install）と、同梱と二重になり、版もずれる。

## 影響

- 初めて Claude を使う前に、取得が入る（0.3.288 の tarball は 1.5 MB、展開すると 19 ファイル・5.4 MB）。オフラインでは、取るまで Claude のバックエンドは使えない。ほかのバックエンドは影響を受けない。
- データ置き場に `claude-sdk/` が増える。中身は版ごとのフォルダー・`consent.json`・使った印 `.pleiad-used` である。
- `@anthropic-ai/sdk` が同梱から外れる。SDK が読み込みの時点でこれを要るようになったら、取得の方法を見直す（`tests/unit/claude-sdk.mjs` が、SDK が読むのは Node の組み込みとアプリの依存だけであることを確かめている）。
- SDK を上げるときは、`package.json`・`package-lock.json`・`core/claude-sdk-pin.json` を一緒に直す。食い違いはテストで落ちる。
- 開発版（`npm run desktop`）とテストは、今までどおり `node_modules` の SDK を読む。配布物の経路は `AGENT_HOST_CLAUDE_SDK=download` で試せる。`AGENT_HOST_CLAUDE_SDK_REGISTRY` で取得元を替えられる（テストの偽のレジストリ用）。
