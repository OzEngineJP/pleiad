<!-- 手書きの断片（つなぎ方）。site/docs/scripts/generate.mjs が Antigravity のページへ差し込む。
     _ で始まる名前なので、このファイル自体はページになりません。 -->

## つなぎ方

1. Antigravity CLI（`agy`）をインストールします（[導入の案内](https://antigravity.google/docs/cli/install/)）。
2. Pleiad の 設定 ›「エージェント設定」で、Antigravity の行の「状態を再確認」を押します。
   - Windows では、インストーラーが `%LOCALAPPDATA%\agy\bin` に置き、そのあと `agy install` が PATH を書きます。見つからないときは「状態を再確認」を押すか、Pleiad を起動し直してください。
3. 「ログイン」を押すと、端末で実行するコマンドが出ます。「コピー」して端末で実行し、画面の案内に沿って Google のアカウントでログインします（Antigravity のログインは端末からしか行えません）。
4. 終わると行が自動で「ログイン中」に切り替わります（およそ 10 分で時間切れになります）。

- Antigravity からのログアウトは Pleiad からはできません。`agy` 側で行ってください（資格情報は OS の資格情報ストアにあります）。
- 待っているログインを止めたいときは「やめる」を押します。
