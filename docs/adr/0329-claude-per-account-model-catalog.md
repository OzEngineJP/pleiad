# 0329 Claude のモデル一覧とモデル名の確かめをアカウントごとに引き、Mythos は Fable の使用枠で数える

## 状態

提案。[ADR 0310](0310-claude-model-catalog-cwd-and-exact-match.md)（一覧は作業場所ごとに引く・短い一覧で完全な一覧を上書きしない・当て方は正確な一致だけ）の続編として、一覧を引く単位にアカウントを足す。

## 状況

Claude で選べるモデルは、アカウント（組織）で変わる。承認された組織のアカウントにだけ出るモデル（Claude Mythos 5.2 など）があり、同じ CLI でも、アカウントのトークンで引いた `supportedModels()` の行はアカウントごとに違う。Pleiad は一覧を作業場所（cwd）でしか分けておらず、4 つの問題があった。

1. **一覧の取得と記憶がアカウントを見ていなかった。** Claude は `capabilities.accounts: 'token'` で、`backendForAccount`（`core/backends/index.mjs`）は `'agent'` 種にしかアカウントを束縛しない。一覧の取得（`probeCatalog`、`core/backends/claude.mjs`）は常にログイン中のアカウントで CLI を起こし、記憶（鍵は cwd と設定の署名）・「どれか 1 件取れた一覧」（`anyCatalog`）・起動直後の待ち（`coldSince`）・進行中の取得の重複排除も、アカウント共通の 1 系統だった
2. **モデル名の確かめ・読み替え（`validModel` / `matchModel` / `canonicalModel` / `resolveModel`）もアカウントを見ていなかった。** 別のアカウントにしか無いモデルを、そのアカウントの会話・bot・`ply_delegate` で選んでも、ログイン中のアカウントの一覧で判定されて `model_unknown` で断られる
3. **画面もアカウントを見ていなかった。** モデル一覧の要求・取得の鍵・名前引きにアカウントが入らず、アカウントを替えても一覧が替わらない
4. **Mythos の行が使いにくかった。** CLI は Mythos の行を説明なし（`description: ""`）で返す。Mythos は Fable の使用枠で数えるが、ヘッダーの使用量（`web/header-usage.mjs`）と自動委譲の枠判定（`core/delegation-routing.mjs`）は `fable|opus|sonnet|haiku` の 4 系統しか見ず、Mythos の会話・候補でモデル別の週次枠が落ちる

## 決定

### 1. Claude の一覧・状態・確かめをアカウントごとに分ける

- **アカウントの束縛。** `backendForAccount` は、`capabilities.accounts` を持ち `forAccount` を実装した backend（Claude）にもアカウントを束縛する。トークンの無いアカウントは、ログイン中のアカウントへ落とさず、一覧の取得・確かめを断る。アカウント未指定（ログイン中）と互換の接続先の振る舞いは変えない
- **資格情報だけを分ける。** 一覧の取得は、会話・内部呼出しと同じく設定フォルダー（`CLAUDE_CONFIG_DIR`）を利用者の共有のままにし、資格情報だけを `claudeEnv(process.env, { token })` で渡す（アカウント別の設定フォルダーへ切り替えると、プロジェクトの設定・既定のモデルとエフォートを引けない）。記憶の鍵・ログ・エラー文にトークンを入れない（鍵は `'login'` / `'account:<id>'`）
- **状態を分ける。** 記憶・`anyCatalog`・`coldSince`・進行中の取得・無効化の世代をアカウントごとに持つ。別のアカウントの一覧を代わりに返さない。一覧をまだ一度も取れていないアカウントは、起動直後と同じく短く待ってから固定の一覧を返し、そのあいだは形の正しい ID を断らない。ADR 0310 の「短い一覧で完全な一覧を上書きしない」もアカウントごとに守る。記憶の数の上限は、アカウントごとに 64 とする（それまでは全体で 32。古い順に捨てる）
- **先読みと無効化。** `warmModels` はログイン中に加え、使える登録アカウントの分も 1 つずつ順に引く。アカウントの追加・トークンの差し替え・削除では、そのアカウントの記憶だけを捨て（`invalidateModels(accountId)`）、追加・差し替えは引き直す
- **一覧が手元に入ったことを画面へ知らせる。** 画面の要求が先に着くと、一覧がまだ無いアカウントは固定の一覧で答える。あとで本物の一覧が取れた（答えていた一覧と中身が変わった）ときは、`onModelsChanged` の口からサーバーが `claudeAccountsChanged` を送り、画面は固定の一覧を持ち続けずに引き直す。起動時は、各アカウントの最初の一覧で 1 回ずつ送る
- **使用量の監視は一覧の CLI を起こさない。** 自動委譲の設定の「一覧に見当たらない」の判定（使用量の取り置きの `modelKnown`）は、アカウントごとに一覧を持つエージェントでは、手元の一覧だけで答える（`passive`。待たない・取り直さない。手元に無ければ固定の一覧）。監視の側で一覧を引くのは先読み（`warm` → `warmModels`）だけで、一覧に無い候補があったときの確かめ直しは、使用量を公開した後に 1 本の列で順に回す（`warm` は 30 分に 1 回まで。確かめ直しで判定が変わったときだけ、もう 1 回画面へ知らせる）。取り直しのたびにアカウントの数だけ一覧の CLI が並んで起きない
- **サーバーの全経路で、その会話・委譲先・bot のアカウントの一覧で判定する。** 画面のモデル選択、`sessions.setModel` / `setTurnSettings`、`ply_delegate`（固定・自動の候補 `claude@<アカウント>:<モデル>`）、`ply_task_send` とやり直しでのアカウントの切り替え、bot の設定（`core/bots/`）、エフォートの段の引き、既定の `resolvesTo`、`matchModel` / `canonicalModel` までを、アカウントで束縛した backend に通す。`core/delegation-usage.mjs` は候補をアカウントごとに引いて `accountModels` に持ち、`core/delegation-routing.mjs` は候補のアカウントの一覧で `model_unknown` の注意を判定する
- **アカウントを切り替えて、今のモデルが新しいアカウントの一覧に無いとき**は、一覧がアカウントごとに違う既存のエージェント（`accounts: 'agent'`）と同じ扱いにし、新しい規則は作らない。会話は予約のモデルを新しいアカウントの一覧で確かめて、無ければ `settings.modelUnavailable` で断る。bot の `bots.setAccount` は `bot.model` を保ち、bot に追従している会話のモデルだけ、新しい一覧に無ければ既定（`''`）へ戻す

### 2. 画面もアカウントごとに引く

- モデル一覧の要求と取得の鍵（`vocabKey`・`vocabRequests`）にアカウントを入れ、名前引き（`routingNames.model(backend, model, account)`）にも渡す。会話のモデル選択・Channels のスレッド・bot の設定・設定 › 委譲・委譲カードが対象。アカウントを切り替えたら引き直す
- bot の新規作成でアカウントとモデルを両方選んだときは、`bots.create` → `bots.setAccount` → `bots.update` の順で設定する。アカウントの変更は人だけの操作（`bots.setAccount`。[ADR 0224](0224-bot-account.md)）のままにするため、`bots.create` にアカウントを足さない
- `bots.create` の後の段（承認モード・アカウント・モデルの設定）で落ちたときは、bot はもうあるので、作る画面に留めず、できた bot のページへ移して「一部の設定が効かなかった」理由を出し、そこで選び直してもらう。bot は自動では消さない（作る画面に留めると、同じ名前で作り直して落ち続ける）

### 3. Mythos

- CLI が返す Mythos の行（表示名「Mythos 5.2」など）はそのまま出し、空の説明の代わりに辞書の補足（ja「承認された組織向け。使用枠は Fable と共有」、en「For verified organizations. Shares the Fable usage limit.」）を付ける
- Mythos を使えないアカウントもあるので、`familyOf` / `catalogIsComplete` / 別名の行には入れず、固定の自動委譲の段（t1〜t4）にも入れない。利用者が書いた候補 `claude@<アカウント>:claude-mythos-5-2` は、そのアカウントの一覧にあれば通る
- 使用枠は、ヘッダーの使用量と自動委譲の枠判定（`windowsFor`）で、Mythos を Fable の系統として数える（`familyOf` とは別の、Mythos から Fable への対応で持つ）

## 理由

- **資格情報だけ分け、設定フォルダーは分けない。** 一覧は、実際にそのアカウントで走る会話と同じ条件で引かないと、画面の選択肢と実際の動きがずれる
- **別のアカウントの一覧を代わりに使わない。** 承認の要るモデルが、持たないアカウントの選択肢や確かめに混ざる（持つアカウントから消える）のを防ぐ。一覧が取れるまでは、既存の起動直後と同じ道（短く待って固定の一覧）に任せる
- **新しい規則を作らない。** 一覧がアカウントで変わるエージェントの扱いが既にあり、同じ画面・同じ断りで揃える方が、利用者にも保守にも分かりやすい
- **`bots.create` にアカウントを足さない。** アカウントの変更を人だけに限る ADR 0224 を崩さない
- **Mythos を `catalogIsComplete` に入れない。** 完全な一覧の見分けは 4 系統の別名の行で決めており（ADR 0310）、Mythos は持たないアカウントがあるので、入れると短い一覧の判定が崩れる

## 影響

- アカウントごとに使えるモデルだけが、画面の一覧・確かめ・委譲・bot 設定に出る。Mythos の会話・候補は Fable の枠で数える
- 起動時・SDK 取得後の先読みは、登録アカウントの数だけ増える。先読み（`warmModels`）は 1 つずつ順に引くので、一覧の CLI を同時に何本も起こさない
- 使用量の監視は手元の一覧しか読まなくなったので、一覧に出たばかりのモデルを候補に書くと、「一覧に見当たらない」の知らせが残ることがある。手元の一覧は、寿命（30 分）が過ぎてから、画面の一覧の要求か先読み（確かめ直しは 30 分に 1 回まで）が引き直すためで、監視が自分で引き直して早めることはしない。知らせだけで、振り分けも実行も止めない（[ADR 0311](0311-auto-routing-does-not-skip-by-model-list.md)）
- 対象: `core/backends/{claude,claude-models,index}.mjs`・`core/server.mjs`・`core/bots/{service,sessions}.mjs`・`core/brain/pulse.mjs`・`core/delegation-{usage,routing}.mjs`・`web/{client,header-usage,delegation-settings,delegation-routing-view}.mjs`・`web/channels/{bot-page,thread,thread-composer}.mjs`・辞書（`web/locales/{ja,en}/server.json`）・`docs/{design,agent-delegation,backends,channels,multi-backend}.md`・試験
