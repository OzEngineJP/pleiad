# 0222 bot を動かす Claude のアカウントを、bot のページで人が選ぶ

- 状態: 承認（2026-10-18）
- 関連: [0082](0082-control-surface-principals-and-risk.md)（操作の主体と危険度・human-only）、[0205](0205-ai-chooses-claude-account.md)（AI が委譲の子のアカウントを選ぶ）、[0119](0119-channel-budget-and-resting.md)（チャンネルの予算と休憩）

## 状況

- bot（`core/bots/`）は、いつも Claude のログイン中のアカウントで動いていた。その週の枠を使い切ると、bot とそのルーティンが「使用量の上限」で止まる。
- 会話（Chats）には、会話ごとに Claude のアカウントを選ぶ仕組みがある（`core/claude-accounts.mjs`、会話のメタの `claudeAccount`、入力欄のモデルの面の「アカウント」の節）。bot には、それを選ぶ口が無かった。
- アカウントの切り替えは human-only の 5 つの 1 つ（[ADR 0082](0082-control-surface-principals-and-risk.md)）。AI が選べるのは、自分が委譲する子のアカウントだけ（[ADR 0205](0205-ai-chooses-claude-account.md)）。
- 利用者が、モック（AsIs / ToBe）で画面の形を承認した（2026-10-18）。

## 決定

- **bot の定義に `account`（Claude のアカウントの id。`''` = ログイン中）を足す。** 古い行・文字列でない値は `''` として読む。
- **変えられるのは人だけ。** 新しい操作 `bots.setAccount`（`risk: 'human-only'`、`surfaces: { ui: true, mcp: false, cli: false }`。`HUMAN_ONLY.accounts` に入れる）。`bots.update` の引数には入れない（AI からも人からも、`bots.update` では変わらない）。
  登録の無い id・トークンの無いアカウントは `INVALID` で断る。`''` はいつでも選べる。同じ値なら何も書かない。
  組み込みのエージェント（`plain`）は bot の既定を持たない（スレッドごとに選ぶ）ので断る。
- **アカウントは、そのエージェントが Claude のアカウントを使える（能力の印 `capabilities.claudeAccounts`）ときだけ効く。** backend の id では比べない。
  - 会話を作るとき（DM・スレッド・ルーティン・学習）に、会話のメタの `claudeAccount` を入れる。変えたら、今ある会話（ルーティンの実行の会話も）の `claudeAccount` を揃える（次のターンから効く）。
  - 使えないエージェントの bot（Codex など）でも値は保存する（Claude に戻したときに効く）が、会話には `claudeAccount` を書かない。
  - 心拍は、bot 自身の backend で走るときだけ bot のアカウントを使う。
  - 休憩（[ADR 0119](0119-channel-budget-and-resting.md)）は枠がアカウントごとなので、アカウントを使える bot の休憩の key にアカウントを足す（アカウントを替えれば休憩から出る）。
  - スレッドで人が選んだ上書き（sidecar の `bot.overrides`）は、アカウントには作らない（bot の値に揃える）。
- `bots.list` / `bots.get` の返りに `account`（id）を入れる。名前は画面が登録の一覧から引く。
- **画面**（[design-system.md](../design-system.md)「bot のページ」）:
  - 「動かし方」のモデルの面の末尾に「アカウント」の節を出す。会話の入力欄と同じ部品・同じ行（ログイン中〔既定〕・登録したアカウント）。
    出すのは、エージェントが `claudeAccounts` を持ち、かつ登録が 1 つ以上あるか bot が選んでいるときだけ。
  - 選んだアカウントが消えた・トークンが無いときは、入力欄と同じ警告の文を出す。
  - ログイン中以外なら、チップの末尾（「Opus 5.5 · high · OZ」。aria-label にも）と名前の下の一行（「Claude Code · Opus 5.5 · OZ · 待機」）にアカウントの名前を付ける。
  - 節を出すときは、鍵の注記を「承認モードとアカウントは人間だけが変えられる」にする。
  - アカウントの行の右に、そのアカウントの週の使用量（小さな棒＋「週 N%」）を出す。会話の入力欄のアカウントの節も同じにする。
    出どころは使用量の `quota.accounts` のそのアカウントの行の、全体の週次。行や週の枠が無ければ今までの補足のまま。
    使用量の札の high の閾値以上は、字も棒も `--ink-strong` にする（% の字があるので、色だけに頼らない）。

## 理由

- アカウントを選べないと、ログイン中のアカウントの週の枠を使い切ったとき、bot もルーティンも止まり、ほかの登録済みのアカウントに逃がせない。
- アカウントは誰の枠と請求で動くかを決めるので、承認モードと同じく人だけが変えられるようにする。`bots.update` に入れると、AI の書き込み（`write`）の口から変えられてしまう。
- 会話の入力欄と同じ部品・同じ行にすると、覚えることが増えない。使用量を行に出すと、どのアカウントに替えれば止まらないかが選ぶその場で分かる。
- 使用量の行を先頭の行へ寄せると（`quotaOf` の既定）、別のアカウントの値に見える。行が無ければ出さない。

## 影響

- 操作の表は [channels.md](../channels.md)（`bots.setAccount`）、画面の形は [design-system.md](../design-system.md)「bot のページ」。
- 試験: `tests/unit/ops-bots.mjs`（human-only・断る場合・会話の `claudeAccount`・Codex の bot）、`tests/unit/bots-store.mjs`（`normalizeBot`）、`tests/unit/bot-budget.mjs`（休憩の key）、`tests/unit/header-usage.mjs`（週の使用量）、`tests/unit/ops-coverage.mjs`・`tests/ops-surface.snap.json`（human-only の操作の一覧）。
- 登録を消したアカウントを選んだままの bot は、ターンの始めにアカウントが見つからず止まる（会話と同じ）。bot のページの警告で選び直しを促す。
