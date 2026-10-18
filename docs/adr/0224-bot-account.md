# 0224 bot を動かすアカウントを、bot のページで人が選ぶ

- 状態: 承認（2026-10-18）
- 関連: [0082](0082-control-surface-principals-and-risk.md)（操作の主体と危険度・human-only）、[0205](0205-ai-chooses-claude-account.md)（AI が委譲の子のアカウントを選ぶ）、[0119](0119-channel-budget-and-resting.md)（チャンネルの予算と休憩）、[0222](0222-agent-accounts-and-provider-quota.md)（Claude 以外のエージェントのアカウントと使用枠）

## 状況

- bot（`core/bots/`）は、いつもそのエージェントのログイン中のアカウントで動いていた。その週の枠を使い切ると、bot とそのルーティンが「使用量の上限」で止まる。
- 会話（Chats）には、会話ごとにアカウントを選ぶ仕組みがある（会話のメタの `claudeAccount`〔名前は歴史的で、どのエージェントのアカウントの id も入る〕、入力欄のモデルの面の「アカウント」の節）。
  Claude はトークンのアカウント（`core/claude-accounts.mjs`）、Codex・OpenCode は資格情報のアカウント（`core/agent-accounts.mjs`、[ADR 0222](0222-agent-accounts-and-provider-quota.md)）。bot には、それを選ぶ口が無かった。
- アカウントの切り替えは human-only の 5 つの 1 つ（[ADR 0082](0082-control-surface-principals-and-risk.md)）。AI が選べるのは、自分が委譲する子のアカウントだけ（[ADR 0205](0205-ai-chooses-claude-account.md)）。
- 利用者が、モック（AsIs / ToBe）で画面の形を承認した（2026-10-18）。入力欄が Codex・OpenCode のアカウントも選べるようになった（0.21.0）のに揃え、bot もアカウントに対応したエージェントならどれでも選べるようにする（2026-10-18、依頼元の判断）。

## 決定

- **bot の定義に `account`（bot のエージェントのアカウントの id。`''` = ログイン中）を足す。** 古い行・文字列でない値は `''` として読む。
- **変えられるのは人だけ。** 新しい操作 `bots.setAccount`（`risk: 'human-only'`、`surfaces: { ui: true, mcp: false, cli: false }`。`HUMAN_ONLY.accounts` に入れる）。`bots.update` の引数には入れない（AI からも人からも、`bots.update` では変わらない）。
  bot のエージェントに登録の無い id は `INVALID`（not registered）、使えない（トークン・資格情報の無い）アカウントは `INVALID`（not ready）で断る。`''` はいつでも選べる。同じ値なら何も書かない。
  組み込みのエージェント（`plain`）は bot の既定を持たない（スレッドごとに選ぶ）ので断る。
- **アカウントは、そのエージェントがアカウントを持てる（能力の印 `capabilities.accounts` が `'token'` か `'agent'`）ときだけ効く。** backend の id では比べない。
  一覧と検査は server の `accountRows`（入力欄の `accountList` と同じ。Claude はトークン、ほかは資格情報）。持てないエージェント（Antigravity）の bot は `''` だけ。
  - **bot のエージェントを替えると、アカウントは `''` に戻す。** id はエージェントごとで、替えた先には無い。
  - 会話を作るとき（DM・スレッド・ルーティン・学習）に、会話のメタの `claudeAccount` を入れる。変えたら、今ある会話（ルーティンの実行の会話も）を揃える（次のターンから効く）。
    Claude の会話と、まだ送っていない会話は `claudeAccount` を直に書く。送った `'agent'` の会話（Codex など）は、ネイティブの会話がアカウントごとなので、次のターンの予約（`reserveTurnSettings` の `account`）で替える（ターンの始めに会話を起こし直す）。
  - 心拍は、bot 自身の backend で走るときだけ bot のアカウントを使う。
  - 休憩（[ADR 0119](0119-channel-budget-and-resting.md)）は枠がアカウントごとなので、アカウントを持てる bot の休憩の key にアカウントを足す（アカウントを替えれば休憩から出る）。
  - スレッドで人が選んだ上書き（sidecar の `bot.overrides`）は、アカウントには作らない（bot の値に揃える）。
- `bots.list` / `bots.get` の返りに `account`（id）を入れる。名前は画面が登録の一覧から引く。
- **画面**（[design-system.md](../design-system.md)「bot のページ」）:
  - 「動かし方」のモデルの面の末尾に「アカウント」の節を出す。会話の入力欄と同じ部品・同じ行（ログイン中〔既定〕・登録したアカウント）。
    一覧は bot のエージェントのもの（Claude は `claudeAccounts`、ほかは `accounts.list`）。`claudeAccountsChanged`・`agentAccountsChanged` で読み直す。
    出すのは、エージェントが `capabilities.accounts` を持ち、かつ登録が 1 つ以上あるか bot が選んでいるときだけ。
  - 選んだアカウントが消えた・使えないときは、入力欄と同じ警告の文を出す。
  - ログイン中以外なら、チップの末尾（「Opus 5.5 · high · OZ」。aria-label にも）と名前の下の一行（「Claude Code · Opus 5.5 · OZ · 待機」）にアカウントの名前を付ける。
  - 節を出すときは、鍵の注記を「承認モードとアカウントは人間だけが変えられる」にする。
  - アカウントの行の右に、そのアカウントの週の使用量（小さな棒＋「週 N%」）を出す。会話の入力欄のアカウントの節も同じにする。
    出どころはそのエージェントの使用枠（[ADR 0222](0222-agent-accounts-and-provider-quota.md) の provider quota）の `accounts` のそのアカウントの行の、全体の週次。行や週の枠が無ければ今までの補足のまま。
    使用量の札の high の閾値以上は、字も棒も `--ink-strong` にする（% の字があるので、色だけに頼らない）。

## 理由

- アカウントを選べないと、ログイン中のアカウントの週の枠を使い切ったとき、bot もルーティンも止まり、ほかの登録済みのアカウントに逃がせない。Codex の bot も同じ。
- アカウントは誰の枠と請求で動くかを決めるので、承認モードと同じく人だけが変えられるようにする。`bots.update` に入れると、AI の書き込み（`write`）の口から変えられてしまう。
- 会話の入力欄と同じ部品・同じ行・同じ一覧にすると、覚えることが増えない。使用量を行に出すと、どのアカウントに替えれば止まらないかが選ぶその場で分かる。
- 使用量の行を先頭の行へ寄せると（`quotaOf` の既定）、別のアカウントの値に見える。行が無ければ出さない。
- エージェントを替えたときに古い id を残すと、替えた先で「削除済み」に見えるか、別のエージェントのアカウントとして解かれる。ログイン中に戻すのが分かりやすい。

## 影響

- 操作の表は [channels.md](../channels.md)（`bots.setAccount`）、画面の形は [design-system.md](../design-system.md)「bot のページ」。
- 試験: `tests/unit/ops-bots.mjs`（human-only・断る場合・会話の `claudeAccount`・Codex の bot と予約・Antigravity・エージェントを替えたとき）、`tests/unit/bots-store.mjs`（`normalizeBot`）、`tests/unit/bot-budget.mjs`（休憩の key）、`tests/unit/header-usage.mjs`（週の使用量。Codex の使用枠の形も）、`tests/unit/ops-coverage.mjs`・`tests/ops-surface.snap.json`（human-only の操作の一覧）。
- 登録を消したアカウントを選んだままの bot は、ターンの始めにアカウントが見つからず止まる（会話と同じ）。bot のページの警告で選び直しを促す。
