# 0280 Grok Build のネイティブ shell を会話ターンごとに外す

- 状態: 決定（2026-10-27）
- 関連: [0227](0227-ply-shell-and-command-notices.md)（Pleiad のシェルのツール）、[#108](https://github.com/OzEngineJP/pleiad/issues/108)、[#100](https://github.com/OzEngineJP/pleiad/issues/100)

## 状況

Grok Build 1.0.62 は ACP の起動引数として `--agent-profile <PATH>` を受け付ける。上流の Grok Build ガイドは、エージェントプロファイルの `disallowedTools` でツールを外せることと、shell の内部ツール ID が `run_terminal_cmd` であることを示している。

ACP の `session/new` / `session/resume` に「ツール一覧」を渡す標準欄は無い。`--disallowed-tools` はヘッドレスの単発実行向けで、ACP 起動のシェル切替には使わない。

## 決定

- 設定が `shellTool: ply` のターンだけ、一時エージェントプロファイルを作り、ACP 起動時に `--agent-profile` で渡す。プロファイルは `run_terminal_cmd` だけを `disallowedTools` に指定する。
- ACP 起動時に適用するため、新規会話と再開会話の両方で同じ処理を通す。承認モードや読み取り専用モードは既存の ACP 設定で引き続き適用する。
- プロファイルはターンごとに別の場所へ置き、ACP の初期化が終わった時点で削除する。初期化に失敗した場合もターン終了時に削除する。
- Grok ACP を起動できない場合、またはプロファイルを書けない場合はターンを失敗させ、native shell が有効なまま続行しない。

## 理由

プロファイルは Grok CLI が公開している会話単位のツール制御であり、Pleiad の `ply_shell` を選んだターンだけ shell ツールを外せる。共有の Grok 設定ファイルを書き換えず、別会話の設定を変えない。

## 検証

- 手元の Grok Build 1.0.62 で `grok agent --help` が `--agent-profile` を示し、実際の `grok agent stdio` が一時プロファイル付きで ACP `initialize` に応答することを確認。
- `tests/unit/grok-backend.mjs` で新規・再開、読み取り専用モード、一時ファイル削除、別会話への非混入を確認。
- `tests/lib/backend-delivery.mjs` で配達試験が `run_terminal_cmd` のプロファイル指定も確認する。
