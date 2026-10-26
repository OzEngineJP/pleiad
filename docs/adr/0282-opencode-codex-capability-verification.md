# 0282 OpenCode と Codex の委譲機能の能力確認

- 状態: 提案（2026-10-27）
- 関連: [0273](0273-capability-states.md)、[0278](0278-capability-delivery-tests.md)、[#151](https://github.com/OzEngineJP/pleiad/issues/151)

## 決定

- OpenCode 2.0.32 のモデル切替は `POST /api/session/{id}/model` を使う。OpenCode が現在の推論呼び出しを中断するのではなく、同じ session の次の provider 呼び出しへ適用する。
- OpenCode 2.0.32 の承認モード切替は `PATCH /api/session/{id}` の `permissions` を更新する。実行中の session に新しい権限規則を反映する。
- OpenCode 2.0.32 の compaction は `compaction.buffer` で開始時期を調整できるが、この値は全体設定であり session ごとの設定 API が無い。別の会話へ漏らさず委譲の子だけ変更する手段が無いため、`autoCompactWindow` は不可能とする。
- OpenCode 2.0.32 の API は native な次の発言候補通知を持たない。Pleiad は全ツールを拒否する使い捨て session で候補を作り、session を削除して履歴を残さない。
- Codex CLI 0.160.0 の app-server は `thread/start` と `thread/resume` の thread config で `model_auto_compact_token_limit` を受ける。Claude の窓から 33,000 トークンの余白を引いて渡す。閾値が変わったロード済み thread は app-server の仕様に合わせて一度外して読み直す。

## 確認

- OpenCode 2.0.32 のローカル `/openapi.json` に v2 API があり、起動処理の検査も `/api/session` と `/api/event` を要求する。
- Codex CLI 0.160.0 の `codex app-server generate-json-schema` が thread config に `model_auto_compact_token_limit` を出力する。設定の範囲と新規・再開への配達は `backend-delivery` で確かめる。
- OpenCode の live model・live mode・提案の使い捨て session は `server-opencode` と `server-prompt-suggestions` で確かめる。

## 参考

- [OpenCode v2 API](https://dev.opencode.ai/v2/docs/api)（session のモデル切替・権限更新・削除）
- [OpenCode v2 compaction](https://dev.opencode.ai/v2/docs/compaction/)（`compaction.buffer` の設定範囲）
- [Codex の設定リファレンス](https://learn.chatgpt.com/docs/config-file/config-reference)（`model_auto_compact_token_limit`）
