# 0356 Devin のモデルと思考の強さは ACP の選択肢だけに従い、Pleiad は名前を読み替えない

- 状態: 承認（2026-11-25）。実装済み。保存済みの古い名前の扱い（§4）は 2026-11-25 に利用者が決めた
- 関係: [0223](0223-devin-acp-backend.md)（Devin の ACP 接続）・[0311](0311-auto-routing-does-not-skip-by-model-list.md)（モデルを断られたら次の候補へ）・[0343](0343-explicit-delegation-model-passthrough.md)（一覧で拒否せず CLI に渡す）

## 状況

委譲が `-32602 Invalid value 'swe-2-1-high' for config option 'model'` で始まってすぐ止まった。

- 一覧は `devin models list` のカタログ（`families[].variants[].model_uid`）から作っていた。カタログの版の名前（`swe-2-1-high`・`swe-2-max-lightning` など）を、Pleiad が系列の基部・思考・速度の印に分解し（旧 `core/backends/devin-models.mjs:75` の `parseDevinUid`）、同じ基部で ACP が返す代表に読み替えて送っていた（旧 `:89` の `devinAcpModel`、`:172` の `applyDevinModel` が model → thought_level → speed を送る）。
- カタログに無い名前は、分解した形のまま送っていた（旧 `:121-128` の `resolveDevinModel` の素通し）。
- カタログと ACP の選択肢は別の物で、名前の形も版で変わる。読み替えの規則は CLI の更新のたびに外れ、外れると ACP に無い名前を送って断られる。
- ACP の断り（`-32602`）は「Devin ACP request failed」にまとめられ（旧 `core/backends/devin-acp.mjs:295`）、`turnResult` に `kind: 'model'` が付かなかった。委譲の振り分け（0311）は断られた候補を 30 分外せず、同じ候補を選び直した。

## 決定

**Devin のモデルは、ACP の会話が示す `model` の選択肢の値をそのまま使う。Pleiad は名前を分解・読み替え・補完しない。カタログ（`devin models list`）は使わない。**

1. **一覧**: 一覧用の ACP の会話（`session/new`）の `configOptions` の `model`（入れ子の group を開く）の値と表示名をそのまま並べる（`readDevinList`）。今の値（`currentValue`）を既定（空の名前）にする。料金の区分はカタログにしか無かったので出さない。TTL（5 分）・refresh・失敗を覚えない扱いは今までどおり。
2. **思考の強さ**: そのモデルの `thought_level` の選択肢を Pleiad の強さの軸（`efforts`・`defaultEffort`）に載せる。`thought_level` はモデルで有無と段が変わり、model を切り替えるとそのモデルの既定の段に戻るので、一覧を読んだ会話で裏でモデルを順に選び替えて読む（`core/backends/devin.mjs` の probe）。強さを待つ呼び出し（`requireModelCatalog`。`core/effort.mjs`・`core/server.mjs` の強さの解決）が来たモデルを先に読む。読み終えていないモデルは `effortReason` だけを載せる。`effortInModelId` は `false`（段をモデル名に入れない）。
   - 読んだ強さは CLI の版（`initialize` の `agentInfo.version`）ごとに覚える。一覧を読む会話でもターンの会話でも、版が前と違えば覚えた強さと一覧の控えを捨て、読みかけの probe を止めて、次の一覧で新しい版の選択肢を読み直す（TTL を待たない）。
   - 一覧と強さを読む会話は、読むたびに専用の置き場（`<dataDir>/devin/metadata-sessions/<uuid>`、`DEVIN_SESSIONS_DIR`）で開き、読み終えてプロセスを閉じたら置き場ごと消す（`core/backends/devin-config.mjs` の `launch.cleanup`）。Devin の会話の置き場に会話を溜めない。落ちて消し損ねた置き場と、前の版が 1 つの置き場に溜めた `metadata-sessions/cli` は、使っていなければ（10 分より古ければ）次の読み取りで消す。ACP の `session/delete` は使わない（実機 3000.14.30821 で一覧からは消えるが、ロックのファイルが残る）。
3. **ターンの設定**: mode を送った後、選んだモデルを送り、強さを選んでいればそのモデルの段を送る（`applyDevinSelection`）。モデルも強さも選ばなければ何も送らず、今の値を確かめた値として覚える。応答の `currentValue` で確かめ、違えば止める（今までどおり）。
4. **速さ（`speed`、category `model_config`）は扱わない**。選ばず、送らず、確かめない（変わっても欠けても止めない）。速さは料金に関わり、Pleiad に軸が無い。CLI の既定のまま走る。
5. **選択肢に無いもの**: 選んだモデル・段がその会話の選択肢に無ければ、送らずに断る（`DEVIN_MODEL_UNAVAILABLE`・`DEVIN_EFFORT_UNAVAILABLE`、`rejected: 'model' | 'thought_level'`）。送った値を CLI が `-32602` で断ったときは、`devin-acp.mjs` がどの設定か（`configRejected: { option }`）だけの印を付ける（wire の文面は外へ出さない）。どちらも prompt を送る前なので `undelivered` にし、`turnResult` に `kind: 'model'`・`pristine: true` を付ける。委譲の振り分けはその候補を 30 分外し（0311）、次の候補で作り直す。0343（一覧で拒否しない）とは食い違わない: 断るのは Pleiad の控えの一覧ではなく、CLI がその会話で示した選択肢で、CLI の答えそのものだから。
6. **保存済みの古い名前**（利用者の決定。Pleiad で Devin を使うのは利用者 1 人という前提）:
   - 委譲の設定（`prefs.json` の `delegationRouting.tiers` の候補と、その `efforts`）にある Devin の候補は、この版の最初の起動で 1 回だけ全部消す。古いカタログの名前か ACP の名前かは見分けず、置き換えない。
   - 1 回きりはデータの形の版（`DATA_SCHEMA` は 4 のまま）ではなく、`prefs.json` の印（`migrations` に `devin-acp-candidates`）で決める（`core/prefs-migrations.mjs` の `removeDevinCandidatesOnce`。起動の中で store が `prefs.json` を読む前に呼ぶ）。印が無いときだけ消して印を立て、同じ書き込み（一時ファイルから rename）で済ませる。消すものがあれば、移す前の `prefs.json` を `backup-prefs-<日時>/` に残す。消した数は起動のログに 1 行（`data.devinCandidatesRemoved`）残す。画面の通知は出さない。
   - 2 回目以降の起動は印があるので何もせず、利用者が選び直した Devin の候補は残る。前の版は `prefs.json` の知らないキーも書き戻すので、版を戻して上げ直しても印が残り、何もしない。
   - 読めない・書けないときは起動を止めない。ログに 1 行（`data.devinCandidatesFailed`）残し、印が立たないので次の起動でやり直す。
   - 会話のモデル・既定のモデルなど、ほかに残る古い名前は置き換えない。§5 のとおり「使えないモデル」として止め、人に選び直してもらう（新しい画面の部品は足さない）。

### 変えないもの

- 承認モードの扱い、実行中の確認済み設定（mode・model・thought_level）の変化で止めること、ACP の応答の確かめ方。
- 固定の委譲と `ply_task_send` は、指定した名前をそのまま渡す（0343）。断りは §5 の印で返る。

## 理由

- 選択肢の正本は ACP で、CLI がその会話で使える値を示している。別の物（カタログ）から規則で読み替えると、CLI の更新のたびに外れる。読み替えをやめれば、外れる規則が無くなる。
- 段の軸は ACP に `thought_level` として別にあるので、Pleiad の既存の強さの軸にそのまま載る（Claude・Codex と同じ持ち方）。
- 速さは選ぶと料金が変わるのに、Pleiad の画面に軸が無い。黙って既定と違う速さを送るより、CLI の既定に任せる。
- 断りに `kind: 'model'` を付けないと、振り分けは同じ候補を選び直し続ける。

## 影響

- 一覧の項目名が変わる（`swe-2-high`・`glm-5-2` など ACP の値）。前の一覧で選んだ委譲の候補は 1 回消えるので、利用者は設定 › 委譲で選び直す。
- Lightning など、カタログにだけあった版は選べなくなる（ACP の選択肢に無い）。
- 試験: `tests/unit/devin-models.mjs`（一覧・段・選択・選択肢に無いものの断り）・`tests/unit/devin-variants.mjs`（偽の CLI 越しの一覧・強さの読み取り・ターンの設定・断りの `kind: 'model'`・`pristine`）・`tests/unit/devin-acp.mjs`（`configRejected`）・`tests/unit/server-devin.mjs`（speed の変化で止めない・ACP に無い名前の断り）・`tests/unit/backend-model-cache.mjs`・`tests/unit/server-delegation-models-share.mjs`・`tests/unit/devin-metadata-sessions.mjs`（何度読んでも一覧と強さの会話が残らない・前の版の置き場を消す・CLI の版が変わったら一覧でもターンでも強さを読み直す）・`tests/unit/prefs-migrations.mjs`（Devin の候補が消える・ほかは残る・印が立つ・2 回目と版を戻して上げ直したときは何もしない・書き込みに失敗したらやり直せる・形式番号は 4 のまま）。
