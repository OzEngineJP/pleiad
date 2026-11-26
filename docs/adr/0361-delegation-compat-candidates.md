# 0361 委譲の候補に互換の接続先を入れる

- 状態: 承認（2026-11-26）
- 関係: [ADR 0264](0264-delegation-account-scope.md)（委譲の候補はアカウントの単位。決定 1・8 を一部置き換え）・[ADR 0359](0359-connections-unify.md)（接続先を 1 つに。決定 6 を置き換え）・[ADR 0011](0011-compat-endpoints.md)（互換の接続先）・[ADR 0022](0022-delegation-routing.md)（委譲先の自動選択）・[ADR 0040](0040-delegation-routing-headroom.md)（使用量の後回し）・[ADR 0229](0229-opencode-limit-retry-wait.md)（上限で止まった枠）

## 状況

委譲先の自動選択の候補は「エージェント・モデル・アカウント」の組で（ADR 0264）、互換の接続先（OpenRouter・Z.ai など、URL とキーの口。ADR 0011）は候補に入れられなかった（ADR 0359 の決定 6）。互換の接続先で子を走らせるには、依頼元が同じエージェントの互換の会話にいて、接続先を継がせるしかなかった。

キー課金や安い接続先で軽い仕事を回したい、公式の枠が尽きたときの受け皿にしたい、という使い方が、設定 › 委譲 › レベルごとの候補からも ply_delegate からもできなかった。候補の面（入力欄と共通の 2 段）の接続先の一覧にも互換の接続先は出なかった。

## 決定

1. **候補の id は `backend@<接続先の id>:<モデル>`。** 今の `@` の場所を使い、中身が `ep-` で始まれば互換の接続先、ほかは登録したアカウント（`acct-…`）と読む（`parseCandidate` は `{ backend, model, account: null, endpoint }` を返す）。モデルは接続先の明示の ID を保存する（空 = メインのモデルは保存しない。接続先のメインが後で変わっても段の候補が黙って変わらないように）。古い版はこの候補を登録の無いアカウントとみなし、その候補だけを `no_account` で飛ばす（レベルは既定に戻らない）。
2. **既定のレベルには入れない。** 人が段に置くまで使わない（ADR 0264 の 2 と同じ）。
3. **使用量では後回しにしない。** 互換の接続先は使用量を返さないが、`usage_unknown` のように「余裕が少ない」扱いにはせず、使える候補とする。飛ばすのは次のときだけ。
   - 接続先が登録に無い（消した）・別のエージェントの接続先 … `no_endpoint`
   - 接続の確認に失敗した … `check_failed`
   - キーを読めない … `key_unreadable`
   - 直近に 429 を返した … `recently_limited`（枠は `endpoint:<id>` と実際に送ったモデル。`limitedSlots` に記録し、成功した回で外す）
4. **段の中は人が決めた順。** 公式と互換のどちらを先に試すかは並び順で決める（新しい設定は足さない）。互換を公式より下に置けば、公式が使えないときだけ互換を使う。
5. **選ばれた互換の候補は、その接続先で子を走らせる。** 自動の選択（auto・manual）でも固定の委譲でも、子の会話に `compatEndpoint` を書く。やり直し（人の［やり直す］と、上限での切り替え）も段の互換の候補を別の候補として選べる（同じ接続先の同じモデルは除く）。
6. **ply_delegate の `endpoint` 引数。** 接続先の id（`ep-…`）か名前（大文字・小文字を区別しない）。`backend` を省けば接続先のエージェント。段に無い接続先も通す（ADR 0264 の 5 と同じく、明示したものは通す）。次の場合は子を作らずに、依頼元の言葉で理由を返す。
   - 登録に無い … `endpoint_unknown`
   - 名前が 2 つ以上に当たる … `endpoint_ambiguous`（id で書くよう返す）
   - 別のエージェントの接続先 … `endpoint_other_agent`
   - 確認に失敗している … `endpoint_check_failed`
   - キーを読めない … `endpoint_key_unreadable`
   - `account` と一緒に書いた … 一緒に書けない旨
   - ホストに任せる（`host`）と一緒に書いた … 使えない旨
7. **同じエージェントの固定の委譲は、依頼元の互換の接続先を継ぐ（今のまま）。** `account` も `endpoint` も書かないときだけ。段の候補を使う自動の選択では継がず、段で決めたとおりに走る。
8. **エージェントへの返り値。** `ply_usage` のエージェントごとに `endpoints: [{ id, name, kind, mainModel?, models, ready, inTiers, held? }]`（キーは出さない。使用量の欄は持たない）。`routing.target` は `{ backend, model, account: null, endpoint, endpointLabel, effort }`。飛ばした候補の行は `- codex@ep-…:z-ai/glm-4.6 [OpenRouter] (t1): check_failed`。MCP のツールの説明は「接続先」の言葉で `endpoint` を書く。
9. **接続先を消すと、その候補を段から外す**（ADR 0264 の 6 と同じ）。
10. **画面（設定 › 委譲 › 詳しい設定 › レベルごとの候補）。** 規則は `docs/design-system.md`「委譲」（承認済み（2026-11-26））。
    - 候補の行のチップは「◇ モデル · 接続先」（入力欄と同じ ◇）。下の弱い字の行は「エージェント · 使用量は読めない」。確認に失敗した候補は `.off` と「使えない（確認に失敗） · 確認し直す」（文字だけのリンク。押すと接続を確かめ直し、結果を読み上げて行を描き直す）。
    - 候補の面の接続先の段は、入力欄と同じ並び（CLI のログイン → 登録したアカウント → 互換の接続先 → 接続先を管理…）。確認に失敗した・キーを読めない接続先は理由を添えて選べない。互換の接続先を選ぶと、モデルはその接続先のモデルのうちレベルに無いもの（メインが先）になり、モデルの段は入力欄の互換のモデルの段（検索と ID の入力・既定の札）と同じ形。同じレベルにある組は「同じレベルに追加済み」で選べない。
    - 委譲カードの内訳とタスクの一覧の委譲先は「モデル · 接続先」。

## 理由

- 段の中の順で公式と互換の先後を人が決められれば、「公式が尽きたら互換」も「軽い仕事は最初から互換」も、新しい設定を足さずに書ける。使用量を読めないことを理由に後回しにすると、人が互換を上に置いても上の順にならない。
- 候補の id を今の `@` の形に収めれば、保存・並べ替え・飛ばした行の読み直し（正規表現）がそのまま使え、古い版でもその候補だけが使えないとして飛ばされる（新しい印を使うと古い版はレベルを丸ごと既定に戻す）。
- `endpoint` を `account` と別の引数にすると、返り値・エラーの文・`ply_usage` の欄がアカウントと接続先で分かれ、AI が取り違えにくい。
- 継ぐ動きを残せば、bot の会話からの委譲が接続先のまま走る今の動き（ADR 0359）を変えずに済む。

## 影響

- `core/delegation-routing.mjs`（`parseCandidate`・`candidateId`・`checkCandidate`・`route`・`candidateStates`・`formatSkippedCandidates`・`pinnedRouting`・`tierEndpoints`・`endpointSlot`）、`core/compat-endpoints.mjs`（`routingStates`・名前で引く）、`core/server.mjs`（`requestedEndpoint`・`routeDelegation`・prepare・やり直し・`ply_usage`・`delegationRouting` の `endpoints`・`dropEndpointCandidates`・互換の 429 の記録）、`core/effort.mjs`（接続先の段）、`core/agent-bridge.mjs`・`core/ops/delegation.mjs`（`endpoint` 引数）。
- 画面: `web/delegation-settings.mjs`・`web/delegation-routing-view.mjs`・`web/composer-controls.mjs`（互換のモデルの段が選べない理由を出す）。
- 残すこと: ロゴの無いエージェント（Antigravity など）の代わりの印も ◇ なので、互換の候補と同じ形になる。下の行のエージェントの名前と「使用量は読めない」で見分けはつく。代わりの印を別の形に替えるのは別の小さな改修とする。
- 試験: `tests/unit/delegation-routing.mjs`（読み方・判定・順・飛ばした行）、`tests/unit/server-delegation-compat.mjs`（偽の codex と偽の互換 API で、名指し・断る理由・自動の選択・確認の失敗と 429・継ぐ・やり直し・消したら段から外す・キーを出さない）、`tests/browser/delegation-compat.mjs`（候補の行・確認し直す・候補の面の接続先とモデルの段・打鍵で追加）。
