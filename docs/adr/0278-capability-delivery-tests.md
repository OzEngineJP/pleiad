# 0278 配達物の印ごとに、エージェントごとの「届いたか」の試験を必須にする

- 状態: 提案（2026-10-26）
- 関連: [0220](0220-backend-contract-and-agent-descriptors.md)（能力の印の明示）、[0231](0231-run-args-delivery-capabilities.md)（配達物を印で絞る）、[0273](0273-capability-states.md)（印を 4 つの状態にする）、[0081](0081-control-surface-registry.md)（載せ忘れの lint）

## 状況

- 能力の印ごとの契約の索引（`tests/lib/backend-contracts.mjs` の `CAPABILITY_CONTRACTS`）は、**suite があるか**しか見ていなかった。
  どのエージェントで確かめたかは問わないので、`login` は Codex と fake、`compact` は Claude と Codex、`secrets` は fake だけで通り、
  印が「対応」でもそのエージェントで実際に届くかは見ていなかった（[#146](https://github.com/OzEngineJP/pleiad/issues/146)）。
- 全エージェントに同じ流れを流す試験（`backend-conformance`）は、1 ターン・履歴・タイトル・分岐だけで、機能の渡し物は見ていない。
- runArgs の渡し物は、受け取らないエージェントでは引数の分割代入で黙って捨てられる。Devin でブラウザー・`ply_control`・秘密情報・
  可視化が届いていなかった（[525d6fb2](https://github.com/OzEngineJP/pleiad/commit/525d6fb2)）のは、印を足すまで気づけなかった。
- 実物の CLI で流す確かめ（e2e）は Devin・Grok が 0 件で、CI でも回していない。

## 決定

- **配達物を持つ印**（`core/backends/contract.mjs` の `RUN_ARG_FEATURES` の値 = `browser`・`computerUse`・`plyControl`・`secrets`・
  `plyShell`・`plyAgents`・`plyContext`・`plyInstructions`・`visualize`・`hooks`）について、**対応（または `covered`）のエージェントごとに
  「その機能が届いたか」を確かめる試験**を必須にする。
- 試験はエージェントごとの偽のプロセス・プロトコルで、**1 ターン流して受け取ったか**を見る（`tests/unit/backend-delivery.mjs`）。
  渡し物は server と同じく `gateRunArgs` で印に絞り、偽のプロセス・SDK の `query` の身代わり・app-server の身代わりが控えた
  起動の引数・環境変数・MCP の登録・発言に足した指示を見る（届け方は `tests/lib/backend-delivery.mjs` の `DELIVERY_PROBES`）。
- **`CAPABILITY_CONTRACTS` を「印 → エージェントごとの試験」にする**（`{ suites, agents: { <id>: <suite> } }`）。
  印が対応なのに `agents.<id>` が無い・名前の suite が無い・`DELIVERY_PROBES` が無いと `backend-contract` が落ち、
  「どのファイルに何を書くか」（`DELIVERY_PROBES` の `<id>` の probe と `CAPABILITY_CONTRACTS.<印>.agents.<id>`）を案内する。
  対象は印の値と身代わりから機械的に決めるので、新しいエージェント・新しい配達物を足したときに漏れない。`RUN_ARG_FEATURES` にキーを足したのに
  届け方の試験で渡していない（`DELIVERY_ARG_KEYS` に無い）ときも落ちる。
- **実物の CLI で 1 エージェント 1 ターンの入口を持つ**（`npm run test:delivery`、`tests/delivery-cli.mjs`）。Pleiad の指示の合言葉・
  `ply_control` の `list_ops`・秘密情報の変数が届いたかを見る。CI では回さない（使用量がかかる）。CLI が無い・ログインしていない
  エージェントは SKIP と理由を出す。

## 理由

- 「suite がある」ではなく「このエージェントで届いた」を確かめれば、印と実際の届け方の食い違い（Devin の 525d6fb2 と同じ形）を
  その場で落とせる。runArgs のキーを足したのに受け取らない、という変更は JS ではエラーにならないので、試験でしか止められない。
- 対象を `RUN_ARG_FEATURES` から決めると、配達物を足した人は印を足すだけで、全エージェントの届け方の試験を書くことを強制される
  （印の無い配達物は `gateRunArgs` が渡さないので、印を足さない道は無い）。`todo`・`impossible` のエージェントには要求しないので、
  未実装の印が試験の負担にならない。
- 偽のプロセスでの試験は LLM を呼ばず CI で常時回せる。実物の CLI は使用量がかかるので、1 ターンだけの入口を手で流す。
  偽の試験が「渡し物を組み立てた」ことを見るのに対し、実物は「CLI が受け取って使えた」ことを見る（モデルの従い方に依存する部分は
  SKIP・NG の理由に出す）。

## 影響

- `tests/unit/backend-delivery.mjs` が `npm test` に入る（6 エージェント × 対応の印。現在 56 判定・約 11 秒）。
- 偽のプロセスに、届いた配達物を控える口を足した: Devin・Grok は `mcpServers`・環境変数・ターンのプラグイン、agy は `--add-dir` の
  `agent.md`・`hooks.json`・環境変数・届いた本文、Codex は `thread/start` の `config`（`FAKE_CODEX_LOG`）。
- `tests/lib/backend-contracts.mjs` の `CAPABILITY_CONTRACTS` の形が変わる（配列 → `{ suites, agents }`）。既存の suite の名前はそのまま。
- 実物の CLI で 2026-10-26 に 6 エージェントを 1 回ずつ流し、すべての項目が届いた（`npm run test:delivery`）。
- 印が対応のまま届かないエージェントが見つかったら、印を `todo`・`impossible` に直すか、届ける実装を足す。どちらもせずに
  `agents` の行だけを足すことはできない（`DELIVERY_PROBES` の証拠が要る）。
