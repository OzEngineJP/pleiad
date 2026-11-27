# 0371 procway-code をもとに Pleiad Agent を追加する

- 状態: 承認（2026-11-28）。Pleiad Agent の追加と、Pleiad 内で Claude Code と同等の機能を提供することを承認。個々の対応方法は提案。

## 状況

Pleiad は公式以外のモデルを使うために procway-code を組み込んでいたが、2026-09-23 に対応を終え、Claude Code と Codex の互換接続先を選ぶ形に移った。クラウドで Pleiad 自身のエージェントを利用できるようにするには、モデルへの接続先に加え、会話と作業を実行するエージェントが要る。[ADR 0011](0011-compat-endpoints.md)

## 決定

- **承認（2026-11-28）。** procway-code から分岐させた公開のオープンソースソフトウェアを、Pleiad 自身のエージェント「Pleiad Agent」とする。Pleiad Agent を既存のエージェントと同じ枠組みで選べるようにする。クラウドでは Pleiad Agent が動き、使える PC でも選べる。[ADR 0004](0004-multiple-agent-backends.md)、[ADR 0370](0370-managed-host-agent-restriction.md)
- **承認（2026-11-28）。** Pleiad の中で Claude Code でできることを、Pleiad Agent でもできるようにする。対象には会話の再開、ツール実行と中断、利用者への質問と承認、Pleiad の操作と委譲を含む。対応の基準は Pleiad での利用者の操作と結果とする。
- **提案。** 既存の会話・承認・ツールの仕組みに合わせ、機能ごとに動作を確かめてから利用できるものとして出す。同等と判断する機能の一覧、個々の対応順、旧 procway-code の会話を再開・移行できる条件は未承認。

## 理由

- procway-code が備える会話の実行と履歴をもとに、Pleiad が持つ会話画面や承認などの操作を生かせる。
- ADR 0011 で互換接続先を選んだ理由は、既存のエージェントで公式以外のモデルを使うためだった。今回は Pleiad 自身のエージェントを持ち、利用者が Pleiad の中で同じ作業を続けられることが目的となる。

## 影響

- ADR 0011 のうち procway-code 系のエージェントを扱わない判断を見直し、分岐した Pleiad Agent として加える。Claude Code と Codex の互換接続先は引き続き、それぞれのエージェントでモデルを選ぶために使う。
- 実装時に、Pleiad Agent が利用できる機能と既存の会話の扱いを記す。[複数のエージェント](../multi-backend.md)
