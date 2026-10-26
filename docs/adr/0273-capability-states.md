# 0273 能力の印を対応・補う・不可能・未実装の 4 つの状態にし、コードを唯一の正本にする

- 状態: 承認（2026-10-26）
- 関連: [0220](0220-backend-contract-and-agent-descriptors.md)（能力の印の明示）、[0231](0231-run-args-delivery-capabilities.md)（配達物を印で絞る）、[0234](0234-common-backend-delivery-minimum.md)（標準の最低限）、[0020](0020-i18n-dictionary-and-ratchet.md)（ラチェットの形）、[0081](0081-control-surface-registry.md)（載せ忘れの lint）、[0274](0274-capability-traits-and-public-marks.md)（性質の分離とデータの置き場）

## 状況

- [ADR 0220](0220-backend-contract-and-agent-descriptors.md) は「全部のエージェントに実装させるのではなく、全部のエージェントに『対応する／しない』を書かせる」ことにした。
  しかし値は `true`／`false` だけで、`false` が「技術的に無理」「まだ作っていない」「Pleiad の共通処理が補う」「該当しない」を区別しなかった。
- 全部 `false` の雛形（`NO_CAPABILITIES`）を現役のエージェントが使えたため、Devin・Grok は追加時に 17 個ずつの未対応を、
  「書いていない」ではなく「全部 `false` と書いた」形で隠した（[#108](https://github.com/OzEngineJP/pleiad/issues/108)）。
- `compact: true` でも `compact()` が無くても通り、印とメソッドの対応が一部で甘かった。Claude は `compact()` を持たず、
  server が `/compact` を発言として送っている。
- 対応表は `docs/backend-matrix.md` に写していた。コードと文書の二重管理になり、`false` の理由・Issue を書く場所が無かった。

## 決定

- **印の値を 4 つの状態にする。** 対応は今までの値（`true`・`'host'`・`'native'`・`'turn'`・`{ images: … }` など）。
  それ以外は `covered`（Pleiad の共通処理が補う）・`impossible('理由')`（技術的に無理・該当しない。理由が必須）・
  `todo('#Issue')`（手段はあるが未実装。Issue 番号が必須）。値は 1 行で読める形にする（`hooks: todo('#98')`・
  `accounts: impossible('…')`・`fork: covered`）。
- **`CAPABILITIES` に状態の決まりを持たせる。** `valid`（対応の値）・`absent`（状態のときに server・画面へ渡す今までの値）・
  `covered`（`covered` を持てる印か）・`requires`（値ごとに要るメソッド）・`coveredRequires`（`covered` のときに要るメソッド）。
  `false` は書けない。`approvals`・`mcpApproval` は状態を持てない（`'none'`・`'agent'` などが対応の値）。
- **`compact` は圧縮の仕方を値で表す。** `true` は `compact()` で圧縮する（メソッドが必須）。`'prompt'` は `/compact` を
  発言として送る（Claude。server の `compactConversation`）。`compact: true` なのに `compact()` が無い、を落とせるようにする。
- **現役のエージェントは `NO_CAPABILITIES` を使えない。** `NO_CAPABILITIES` は対応を終えたバックエンドだけが使う
  （全部 `impossible('対応を終えた')`）。バックエンドのファイルに `NO_CAPABILITIES` があれば `backend-contract` が落とす。
- **未実装は減る方向にしか動かせない。** `tests/backend-todos.json` に「エージェント × 印 → Issue」を持ち、基準に無い `todo` が
  増えたら `backend-contract` が落ちる。減った・Issue が変わったときは `node tests/lib/backend-todos.mjs --update-baseline` で
  基準を下げる（増える更新は拒む）。lint（ADR 0020・0081）と同じ形。
- **印を足したら全エージェントの状態を書かないと落ちる。** 落ちた文は `core/backends/agent-marks.mjs` の
  `CAPABILITY_STATES.<id>` に何を書くか（対応の値・`covered`・`impossible('理由')`・`todo('#Issue')`）を案内する。
  メソッドが要る印は `core/backends/<id>.mjs` を案内する（[0274](0274-capability-traits-and-public-marks.md)）。
- **server・画面へは今までどおりの値を渡す。** レジストリ（`core/backends/index.mjs`）が状態を
  `legacyCapabilities` で今までの値に引いてから包む（`covered`・`impossible`・`todo` は `false`）。UI と server の出し方は変えない。
- **印の定義と説明は `core/backends/capability-marks.mjs`、エージェントごとの状態は `core/backends/agent-marks.mjs` に置く**
  （[0274](0274-capability-traits-and-public-marks.md)）。`contract.mjs` は検査とイベントの契約を持ち、定義を re-export する。
- **性質（traits）は能力ではないので分ける**（[0274](0274-capability-traits-and-public-marks.md)）。`effortInModelId`・
  `instructionsAtStart`・`failureDiagnostics`・`promptDelivery` は `true` / `false` だけで書き、状態を持たない。
- **写しの文書を消す。** `docs/backend-matrix.md` を消し、一覧は `node tests/lib/backend-matrix.mjs` で端末に出す。
  `docs/multi-backend.md`「エージェントを足す」は試験の案内に寄せて短くする。

## 理由

- 「無理」「まだ」「Pleiad が補う」を分けると、未対応がコードとレビューで見える。`false` を書けば通る道を塞ぐ。
- 状態を 1 行で書けるので、各エージェントのファイルを読めば対応の全体が分かる。`impossible` の理由は今は作る人向けの短い日本語でよい。
  利用者向けの文は `capability-marks.mjs` の `CAPABILITY_DOCS`（`unavailable`）に持ち、公開文書はそこから作る（[0274](0274-capability-traits-and-public-marks.md)）。
- 写しの文書を消すと、コードと文書がずれない。一覧は必要になったときにコマンドで出す。
- `compact` の仕方を値にすると、Claude の `/compact` と Codex・OpenCode・Devin の `compact()` を、同じ「対応」の中で区別できる。

## 影響

- ADR 0220 の「対応する／しないを書かせる」を改める。ほかの決定（エージェントの記述・共通の契約の試験・イベントの検査・
  id の直書きのラチェット）は残す。
- 各エージェントの `false` は `covered`・`impossible`・`todo` に振り分けた。未実装は 29 件
  （[#108](https://github.com/OzEngineJP/pleiad/issues/108)・[#148](https://github.com/OzEngineJP/pleiad/issues/148)・
  [#151](https://github.com/OzEngineJP/pleiad/issues/151)・[#98](https://github.com/OzEngineJP/pleiad/issues/98)）から始まる。
- 利用者向けの対応表（#149）は、この状態と `CAPABILITY_DOCS` から作る（[0274](0274-capability-traits-and-public-marks.md)）。画面には対応表を足さない。
- 性質の印（`effortInModelId` など）は能力の表から外れた（[0274](0274-capability-traits-and-public-marks.md)）。
- `NO_CAPABILITIES` の値は全部 `impossible` になった。対応を終えたバックエンドの `describeBackends` は今までどおり `false` を受け取る。
