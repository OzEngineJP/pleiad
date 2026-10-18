# 0228 エージェントの選び方を、一覧の行にする

- 状態: 承認（2026-10-18）
- 関連: [0160](0160-header-and-destination-chip.md)（宛先とモデルのチップと面）、[0222](0222-agent-accounts-and-provider-quota.md)（エージェントの使用枠）

## 状況

- 宛先とモデルの面の「エージェント」は、面の幅を頭数で等分する pill の 1 列（`.seg.cseg`）だった。5 つのエージェントで短い名前が途中で切れ（「Clau…」「Anti…」「Ope…」）、増えるほど読めなくなる。正式名は title に逃げるだけだった。
- 面のほかの節（接続先・モデル・アカウント）は、全部同じ一覧の行（`.copt`）で、この区切りだけが別の部品だった。
- Devin は `brand: null` のため、ロゴを出す場所（会話の行・入力欄のチップ・この面・使用量の画面）が全部汎用の ◇ だった。
- 利用者が、モック（AsIs / ToBe）で「一覧の行にし、行の右に週の使用量を出し、Devin に本物のロゴを付ける」形を承認した（2026-10-18）。

## 決定

- **エージェントは、モデル・接続先・アカウントと同じ一覧の行（`.clistbox` / `.copt`）にする。** 行は ✓・ロゴ・正式名（`backend.label`）。区切りの `shortLabel` はここでは使わない。
- **行の右端に、そのエージェントの週の使用量（小さな棒＋「週 N%」）を出す。** アカウントの行（[ADR 0224](0224-bot-account.md)）と同じ部品（`weekRight`）・同じ値（`weekUsage` のログイン中の行）。取れないエージェントは何も出さない。選んでいるエージェントの下の使用量の 1 行（窓ごとの内訳と「使用量 ›」）はそのまま残す。
- **Devin に `devin.svg`（LobeHub の集、単色）を登録する。** `brand: { logo: 'devin.svg', mark: true }`。暗いマークなので、Codex と同じく `--ink-brand`（ライトで黒・ダークで白）で描く（`.row-be-devin`）。
- キーボード操作は一覧の ↑↓・Esc・面の外を押す、の既存の動きに揃える（区切りの ←→ の特別扱いは消す）。

## 理由

- 等分で潰れる 1 列は、エージェントが増える前提に合わない。行なら正式名が全部読め、何個増えても縦に伸びるだけで潰れない。
- 面の中のほかの節と同じ部品にすると覚えることが増えず、初回の案内のエージェント選び（縦の一覧）とも揃う。
- 週の使用量を行に出すと、枠のあるエージェントを選ぶ材料が、その選ぶ場面で見える。

## 影響

- `web/composer-controls.mjs`（区切り → 一覧。`row` に `mark` の口）。`web/client.mjs`・`web/channels/thread-composer.mjs`・`web/channels/bot-page.mjs` が `backendUsage`（id → `weekUsage` の値）を渡す。bot のページは面を開いている間、全エージェントの使用量を 1 度ずつ読む。
- `core/backends/agents.mjs` の devin に `brand`、`web/brand/devin.svg` を追加、`web/style.css` に `.row-be-devin` と `.main.hasmark`、区切りの CSS（`.cseg`）を削除。
- 見た目の決まりは [design-system.md](../design-system.md)「入力欄の設定」のモデルの面。
