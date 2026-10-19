# Grok の使用量

会話ヘッダーと設定の「使用量」は、Grok CLI の読み取り専用 ACP 拡張 `_x.ai/billing` が返す使用枠を表示する。認証は CLI に任せ、Pleiad はトークンを読み取って保存しない。モデルへの問い合わせや会話の新規作成は行わない。

共有利用枠の `config.creditUsagePercent` と `config.currentPeriod` を優先し、使用率・残率・リセット日時を既存の表示に渡す。旧形式では、含まれる月次予算と使用額が両方ある場合だけ比率を計算する。値が無い場合や取得に失敗した場合は、不明として扱う。トークン数から契約の使用率を推定しない。設定画面と `ply_usage` は既存の共通キャッシュを使う。

Pleiad 内の実績は、ライブの `turn_completed.usage` から入力・出力・キャッシュ読み・費用を記録する。途中送信が同じ Pleiad のターン内で続けて処理された場合は、その分を合計する。再生された記録と同じ prompt ID の通知は重複計上しない。入力はキャッシュ読みを含む。費用は `costUsdTicks` を USD に変換する。使用量全体が不完全な場合は各実績を不明にし、費用だけが部分的な場合は費用を不明にする。`usage_update` の文脈占有量やセッション累積費用を、そのターンの使用量として数えない。過去の未計測ターンをゼロで埋めたり、遡って補完したりしない。旧版が保存した費用はセッション累計の可能性があるため、更新前の記録を含む最大7日間の実績費用は正確とは限らない。

「利用枠不足」のエラーは、Grok がその応答を返した事実を示す。現在の残高や、その状態が続いていることを断定しない。発言を自動再送せず、使用状況の確認と手動の再送を案内する。サービス側が使用量を返せない間は、Pleiad からも残り使用枠は確定できない。

取得元の仕様: [Grok Build billing](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs)、[usage 通知](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/notification.rs)。
