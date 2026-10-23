# ADR 0255: デスクトップのアプリ名と safeStorage の鍵を Pleiad へ揃える

## 状態

提案（2026-10-23）

## 状況

Pleiad デスクトップ版は、製品名が「Pleiad」、バンドル識別子が `jp.ply.desktop` と定義されているが、`package.json` の `name` が開発初期の `agent-host` のまま残っている。

このため、Electron の内部名（`app.getName()`）が `agent-host` となり、以下の問題が生じている：

1. **macOS の Keychain（キーチェーン）表示の不審さ**:
   `safeStorage` が生成する暗号化キーチェーン項目が `agent-host Safe Storage` となり、OS のアクセス許可ダイアログ等で利用者に不審な印象を与える。
2. **通知・OS 統合表示の不整合**:
   一部の OS 通知やシステムプロセスの識別名において `agent-host` が露出する。
3. **userData パスの混乱**:
   既定のユーザーデータ保存先が `agent-host` に紐づいており、製品名と乖離している。

単純に `app.setName('Pleiad')` を実行すると、macOS Keychain のサービス名や Linux の暗号化派生キーが切り替わるため、旧バージョンで暗号化保存されたセッションや秘密情報（`desktop/secret-bridge.cjs`）が復号不能となり、強制ログアウト等の障害が発生する。また、旧プロセスと新プロセスが同時に実行された場合の競合や、悪意あるプロセスによる秘密情報読み出しを防ぐ設計が求められる。

## 決定

- **アプリ名の統一**:
  - `desktop/main.cjs` のプロセス初期化直後で `app.setName('Pleiad')` を明示的に設定する。
  - 既存の更新設定や OS レベルのショートカットを維持するため、`appId`（`jp.ply.desktop`）および Windows 実行ファイル名（`Ply.exe`）は変更しない。
  - `userData` のディレクトリは、既存利用者のパス（`agent-host`）との互換性を保つため、必要に応じて明示的なパス指定（`app.setPath('userData', ...)`）によりシームレスに維持・移行する。

- **safeStorage キーチェーンの安全なワンタイム移行**:
  - **Single Instance Lock**: `app.requestSingleInstanceLock()` を取得し、旧版プロセスや多重起動による書き込み競合を確実に排除した状態で移行を行う。
  - **完了マーカーとアトミック更新**: `userData` 内に `.migration-v1-pleiad.done` を配置する。一時ファイルへの書き込みと `fs.renameSync` を用いてアトミックに完了状態を記録し、中断時は次回起動時に安全にリトライする。
  - **分離プロセスによる復号・再暗号化**:
    - 旧鍵（`agent-host Safe Storage`）での復号が必要な場合、一時的な移行子プロセス（`--migrate-decrypt-legacy`）を立ち上げ、標準入力経由で暗号文を渡して復号する。
    - 平文はメモリ上・パイプ上のみを通過させ、親プロセス（`Pleiad`）の `safeStorage.encryptString` で新しいキーチェーン項目（`Pleiad Safe Storage`）へ再暗号化して保存する。
    - ログやディスクには一切平文を残さない。

- **Electron Fuses によるバイナリ保護**:
  - `scripts/after-pack.cjs`（`afterPack` フック）にて `@electron/fuses` を導入し、配布バイナリのセキュリティヒューズを設定する。
  - `RunAsNode: false`、`EnableNodeOptionsEnvironmentVariable: false`、`EnableEmbeddedAsarIntegrityValidation: true`、`OnlyLoadAppFromAsar: true` を有効化する。
  - これにより、`ELECTRON_RUN_AS_NODE` や `--inspect` 等を用いた外部スクリプト注入から Pleiad の safeStorage 暗号化キーおよび秘密情報を堅牢に保護する。

## 理由

- キーチェーン項目が `Pleiad Safe Storage` に統一されることで、利用者が macOS のアクセス確認ダイアログを見た際の透明性と信頼性が向上する。
- 透過的な復号・再暗号化パイプラインにより、既存利用者に再ログインや設定再入力の手間を一切強いることなく移行を完了できる。
- アトミックな移行フラグと単一インスタンスロックにより、自動更新適用時のクラッシュやデータ不整合リスクを排除できる。
- Electron Fuses の適用により、Electron アプリケーション特有の既知の攻撃経路（別プロセスによるランタイム悪用・復号スクリプト実行）を抜本的に遮断できる。

## 影響

- macOS のキーチェーンに新しく `Pleiad Safe Storage` が作成され、旧 `agent-host Safe Storage` から安全に値が引き継がれる。
- 移行完了後は `.migration-v1-pleiad.done` により、以降の起動オーバーヘッドは生じない。
- ビルドパイプラインに `@electron/fuses` のフックが追加され、改ざん耐性が向上する。
- 移行手順および挙動は [desktop-releases.md](../desktop-releases.md) の保守ドキュメントに記載する。
