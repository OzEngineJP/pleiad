# 0274 能力の印から性質を分け、公開文書のエージェントのページを軽いデータから作る

- 状態: 承認（2026-10-26）
- 関連: [0220](0220-backend-contract-and-agent-descriptors.md)（能力の印の明示）、[0271](0271-public-docs-astro-starlight.md)（公開文書をタグから組む）、[0273](0273-capability-states.md)（印を 4 つの状態にする）、[#144](https://github.com/OzEngineJP/pleiad/issues/144)・[#149](https://github.com/OzEngineJP/pleiad/issues/149)・[#151](https://github.com/OzEngineJP/pleiad/issues/151)

## 状況

- [0273](0273-capability-states.md) で能力の印を 4 つの状態にした。しかし `effortInModelId`・`instructionsAtStart`・
  `failureDiagnostics` は機能ではなく、そのエージェントの性質（強さをどこに載せるか、指示がいつ効くか、失敗の理由を残すか）を
  表していた。持たないエージェントが `impossible('…')` になり、「できないこと」として数えられていた（#144 の残り）。
- `promptDelivery` も、利用者が選ぶ機能ではなく、プロトコルが「渡った合図」を返せるかという性質。無いことを「未対応」として
  数えると、agy のような接続方法がいつまでも未達として残る。
- 公開文書（#149）のエージェントごとのページは、印の状態と利用者向けの説明から作る。しかし状態は各
  `core/backends/<id>.mjs` にあり、SDK などを import するので、タグから raw で 1 本ずつ取る今の仕組みでは読めない。
- v0.40.0 のタグには新しいファイルが無い。無いタグでもビルドを落とさず、一覧だけを作る必要がある。

## 決定

- **能力（CAPABILITIES）と性質（TRAITS）を分ける。** 能力は 4 つの状態（対応・`covered`・`impossible('理由')`・
  `todo('#Issue')`）で全キーを書く。性質は `true` / `false` だけで書き、状態を持たない。`false` は未対応ではなく、
  そのエージェントの特徴（全エージェントにそろえる対象ではない）。性質は `effortInModelId`・`instructionsAtStart`・
  `failureDiagnostics`・`promptDelivery` の 4 つ。
- **データの置き場を分ける。**
  - `core/backends/capability-marks.mjs`: 印の定義（値の形・`requires`・`covered` の可否）、状態の作り方、キー、
    性質の定義、利用者向けの説明（`CAPABILITY_DOCS`。ja・en の `label`・`summary`・`unavailable`・値ごとの補足）。
    相対 import を持たない。
  - `core/backends/agent-marks.mjs`: エージェントごとの能力の状態（`CAPABILITY_STATES`）と性質（`AGENT_TRAITS`）。
    `capability-marks.mjs` と `computer-timing.mjs` だけを相対 import する。
  - `core/backends/computer-timing.mjs`: 能力の値と橋が共有する定数（agy の 150 秒）。
  - `core/backends/contract.mjs`: 検査（`checkBackendShape`・`capabilityProblem`・`traitProblem`）とイベントの契約。
    定義は `capability-marks.mjs` から re-export する（既存の import を壊さない）。
- **バックエンドは `agent-marks.mjs` から自分の分を読む。** `capabilities: CAPABILITY_STATES.<id>`・
  `traits: AGENT_TRAITS.<id>`。写しを持たない（backend-contract が一致を確かめる）。試験用の fake だけは環境変数で
  印を切り替えるので capabilities を自分に持ち、性質だけ `AGENT_TRAITS.fake` を読む。
- **性質は server・bot・委譲の振り分けが `backend.traits` から読む。** 画面へは出さない（`describeBackends` に載せない）。
  一覧（`node tests/lib/backend-matrix.mjs`）と公開文書の表にも出さない。
- **公開文書のエージェントのページは、軽いファイルの閉包から作る。**
  - `site/tools/docs-sources.mjs` の `DOCS_SOURCE_FILES` が、タグから取るファイルの一覧（`agents.mjs`・
    `capability-marks.mjs`・`agent-marks.mjs`・`computer-timing.mjs`）。`tests/unit/docs-source.mjs` が、相対 import を
    辿った閉包と一致すること・相対 import と `node:` の組み込みだけで閉じることを確かめる。
  - `site/docs/scripts/generate.mjs` は、一覧・できること（対応・`covered`）・できないこと（`impossible` の利用者向けの理由）・
    対応予定（`todo`。Issue 番号は出さない）を日英で作る。手書きの「つなぎ方」は
    `site/docs/src/content/docs/agents/<id>/_connect.md`（英語は `en/agents/<id>/_connect.md`）を読む。無ければ空。
  - 古いタグ（v0.40.0）には `capability-marks.mjs` が無い。取れなかったときは `agents.mjs` だけを取り、一覧だけを作る
    （`site/docs/.cache/<タグ>/.index-only` を残す）。ビルドは落とさない。
- **性質に当たるほかの印は動かさない。** `mcpApproval`・`shell`・`compact`・`rewind` などは値が 2 つ以上あるが、
  利用者が選ぶ機能（誰が承認を聞くか、`!` を誰が走らせるか、圧縮の仕方、巻き戻しの仕方）で、持たないことは未対応になる。
  `promptDelivery` だけは利用者が選ぶ機能ではなく、合図の有無が server の扱い（未達か結果不明か）を変えるだけなので
  性質に移した。

## 理由

- 「そろえる対象ではない」ものを能力の表から外すと、未対応の件数が実際の機能の差だけになる。
- 状態と説明を SDK を読まないファイルに置くと、タグから 1 本ずつ取って公開文書を作れる。バックエンドは同じデータを読むので、
  コードと文書がずれない。
- 古いタグで一覧だけに落とすと、リリースの公開後にサイトを組み直してもビルドが止まらない。

## 影響

- `describeBackends`（WS の `backends`）から 4 つのキーが消える。画面はどれも読んでいない。`agents.list`（AI 向け）の
  `features` からも消える（性質は機能ではない）。
- `tests/backend-todos.json` は変わらない（性質は `todo` を持たない）。
- 公開文書の `/docs/agents/<id>/` が増える。v0.40.0 の公開では一覧だけ。
- 印を足すときは、`capability-marks.mjs`（定義・説明）・`agent-marks.mjs`（全エージェントの状態）・`ABOUT`・
  `CAPABILITY_CONTRACTS`・`CAPABILITY_DOCS` を書く。性質を足すときは `TRAITS`・`AGENT_TRAITS`・`TRAIT_CONTRACTS`。
