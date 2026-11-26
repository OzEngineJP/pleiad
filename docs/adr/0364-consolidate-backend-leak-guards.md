# 0364 エージェントの実装漏れ対策を、宣言・共通の試験・lint・実物の確認の 4 つと生成 1 つにまとめる

- 状態: 承認（2026-11-26）。実装済み
- 関係: [0220](0220-backend-contract-and-agent-descriptors.md)（能力の印の明示）・[0234](0234-common-backend-delivery-minimum.md)（共通機能の最低限）・[0273](0273-capability-states.md)（印の 4 つの状態）・[0274](0274-capability-traits-and-public-marks.md)（性質の分離と公開文書の表）・[0278](0278-capability-delivery-tests.md)（配達物の届いたかの試験）

## 状況

エージェントの種類を足す・印を足すときの実装漏れを落とす仕組みが、ADR ごとに足されて 10 か所近くに散っていた。

- 宣言の検査は `backend-contract`、届いたかは `backend-delivery`、基本の流れは `backend-conformance`、id の直書きは `lint-backends`、一覧の入れ忘れは `lint-agent-lists` にあった。
- `todo` の数の基準表（`tests/backend-todos.json`）、印ごとの試験の索引（`CAPABILITY_CONTRACTS`）、印の開発者向けの説明（`tests/lib/backend-matrix.mjs` の `ABOUT`）は、宣言の写しだった。宣言を変えるたびに手で合わせる必要があり、合わせ忘れても実装漏れは落ちなかった。
- `impossible('理由')` は理由の文しか持たず、「確かめていない」「#Issue」と書けば未実装を隠せた。
- 必須の共通機能（[0234](0234-common-backend-delivery-minimum.md)）は提案のままで、`false` と書けば契約を満たせた。
- `docs/multi-backend.md` §2.9「エージェントを足す」のチェックリストは、これらの置き場を全部並べていた。

## 決定

### 1. 守りは 4 つと生成 1 つにする

| 守り | 置き場 | 落とすもの |
|---|---|---|
| 宣言 | `core/backends/capability-marks.mjs`（印の定義と説明 `CAPABILITY_DOCS`）・`core/backends/agent-marks.mjs`（全エージェントの状態）・`definePerAgentMap` | 印の書き忘れ、エージェントごとの表の入れ忘れ、必須の印の未対応、理由と原因の無い `impossible`、説明の欠け |
| 共通の試験 | `tests/unit/backend-common.mjs`（部品 `tests/lib/backend-common.mjs`） | 全エージェント（身代わり）での 1 ターン・中断・失敗・再起動後の続き、配達物の証拠と宣言の食い違い |
| lint | `tests/lint-agents.mjs`（`tests/unit/agents-lint.mjs`） | id の直書きの増加、一覧の入れ忘れ、死んだ `backend-allow` の印 |
| 実物の確認 | `tests/delivery-cli.mjs`（`npm run test:delivery`。CI では回さない） | 実物の CLI で、指示・`ply_control`・秘密情報が届かない、モデルの一覧が空、既定のモデルで走らない |
| 生成 | `site/docs/scripts/generate.mjs` | 公開文書のエージェントのページと印の表を宣言から作る（手で写さない） |

エージェントを足す人は、宣言・バックエンド・身代わりと `RIGS` を書き、`npm test -- backend-contract backend-common agents-lint` が落ちた文に従う。落ちた文が、どのファイルに何を書くかを案内する。

### 2. ADR 0234 を採用する

`required: true` の 5 つの印（`plyInstructions`・`plyAgents`・`browser`・`plyControl`・`secrets`）は、現役のエージェントなら対応の値しか書けない（`RETIRED` だけ例外）。`false` で実装漏れを隠せない。

### 3. `todo` の数の基準を廃止し、`impossible(理由, 原因)` を構造にする

- `tests/backend-todos.json` と `tests/lib/backend-todos.mjs` を消した。`todo('#Issue')` は Issue 番号を持つ宣言そのものが記録で、数の上限は持たない（[0273](0273-capability-states.md) の「減る方向にしか動かせない」は廃止）。
- `impossible(理由, 原因)` は原因（`upstream`・`design`・`retired`）を必須にし、理由に「確かめていない」「#Issue」を書けない。手段があるのに未確認・未実装のものは `todo('#Issue')` に書く。

### 4. 宣言の写しを消す

- `CAPABILITY_CONTRACTS`（[0278](0278-capability-delivery-tests.md)。印ごとの suite の名前）と `DELIVERY_AGENTS` を廃止した。何を確かめるかは、印の `probe: true` と身代わりの証拠から共通の試験が決める。
- `tests/lib/backend-matrix.mjs`（[0273](0273-capability-states.md) の端末の一覧）と `ABOUT` を廃止した。開発者向けの意味は `CAPABILITIES` のコメント、利用者向けの説明は `CAPABILITY_DOCS` の 1 か所に書く。`ABOUT` にだけあった「Pleiad が補うときの補い方」は `CAPABILITY_DOCS` の `covered`（ja・en）に移し、補える印（`covered: true`）だけが持つことを `backend-contract` が確かめる。エージェントごとの対応は公開文書のエージェントのページで見る。

### 変えないもの

- 印の 35 個のキーは今回減らさない。重なる印の統合は、印ごとに使われ方を調べてから別に決める。
- 性質（traits）と `TRAIT_CONTRACTS`（[0274](0274-capability-traits-and-public-marks.md)）、イベントの形の検査（`BACKEND_EVENTS`）は変えない。

## 理由

- 宣言の写しは、宣言と合わせる手間だけ増やし、実装漏れは落とさなかった。落とすのは「宣言」と「実際の動き」の突き合わせで、写しを挟まなくても宣言から機械的に決められる。
- 置き場が 4 つなら、足す人が読む案内も「落ちた文に従う」1 行で済む。チェックリストを並べると、書き足すたびに古くなる。
- 原因を構造にすると、「上流が無い」と「まだ作っていない」を機械で分けられ、未実装を `impossible` で隠せない。

## 影響

- 消したファイル: `tests/backend-todos.json`・`tests/lib/backend-todos.mjs`・`tests/lib/backend-contracts.mjs`・`tests/lib/backend-matrix.mjs`・`tests/lib/backend-delivery.mjs`・`tests/unit/backend-delivery.mjs`・`tests/unit/backend-conformance.mjs`・`tests/lint-backends.mjs`・`tests/lint-agent-lists.mjs`・`tests/unit/backends-lint.mjs`・`tests/unit/agent-lists.mjs`。
- 端末で対応の一覧を見る手段（`node tests/lib/backend-matrix.mjs`）は無くなる。公開文書のエージェントのページ（`node site/docs/scripts/generate.mjs`）で見る。
- `tests/delivery-cli.mjs` は、実物の CLI に渡す実行ファイルを記述（`AGENTS[id].cli.binEnv`・`cli.exe`）から戻し、エージェントごとの上書き（Grok のログインの置き場・Antigravity の流すモデル）を `REAL_OVERRIDES` に全員分書く。
