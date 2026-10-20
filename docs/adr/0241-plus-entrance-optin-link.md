# 0241 Pleiad Plus の入口の出し入れは api の `visibility` と端末ごとの印で決め、`pleiad://` リンクが印を立てる

- 状態: 承認（2026-10-21）

## 状況

Pleiad Plus の入口（設定のメニューの項目・委譲・通話・リモートの Plus のまとまり・初回の案内の行）は、
今は `/v1/auth/config` の `state` が `off` でない・`AGENT_HOST_PLUS` が `0` でない限り全部の利用者に出る。
公開するまでは案内を出したくないが、`off` にするとログイン済みの利用者の中継や判定まで止めてしまうので、
「入口だけを隠す」段階が要る。案内のページからその端末にだけ入口を出したい。

## 決定

- **api が `visibility` 欄を返す。** `public` は今までどおり出す。`optin` の間は、その端末に
  「入口を出す」印が無い限り入口を全部隠す（`stateJson`/`derive` の `available` が false。
  `off` と同じ見た目）。欄が無い・知らない値は `optin` として扱う。
- **印はリンクが立てる。** `pleiad://plus/enable` が印を立て、`pleiad://plus/disable` が外す。
  ほかの `pleiad://…` は何もしない。印の置き場はデスクトップ・サーバーでは `prefs.plus.entrance`
  （`sync: false`。同期しない）、Android では SharedPreferences `plus` の `entrance`（同じく端末だけ）。
- **ログイン・セッションとは別。** 印を外してもログアウトしない・中継や判定の利用は止まらない。
  印はあくまで画面の入口の出し入れだけに効く。
- **デスクトップは `pleiad` プロトコルを OS に登録する。** electron-builder.yml の `protocols`
  （MSIX は build/appx-manifest.xml の Extensions）。実行時の `app.setAsDefaultProtocolClient` は
  パッケージ版だけが呼ぶ（開発の `electron .` は electron.exe を登録してしまい、インストール版の
  登録を奪うので呼ばない）。main が argv（Windows・Linux）と `open-url`（macOS）からリンクを拾い、
  受けたら主の窓を前に出して、動作をサーバーへ `{ type: 'plus-entrance', action }` で渡す。
  起動前に届いた分は起動後に流す。
- **開発と試験のために `AGENT_HOST_PLUS=1` を足す。** 印が無くても `optin` の間でも入口を出す。
  `0` はこれまでどおり全部隠す。
- **iOS は対象外。** この段階の iOS アプリは Pleiad Plus に対応しない。

## 理由

- **`state: off` と入口の出し入れを分ける。** `off` は機能そのものを止める（セッション・中継・判定）。
  公開前の段階で必要なのは「まだ知らない人に案内を見せない」だけなので、隠すのは入口の出し入れに絞る。
- **アカウントではなく端末ごとの印。** 同じアカウントの別の PC や、同じ PC の別の利用者に
  いきなり入口を出さない。リンクを開いた端末にだけ出る。同期の対象にすると全端末に伝染するので
  `sync: false` にする。
- **リンクは OS のプロトコルで届ける。** 案内のページから 1 タップでその端末のアプリを動かせるのが
  `pleiad://` リンク。ペアリング（`pleiad://pair`）と同じ仕組みで、新しい秘密や問い合わせの口は要らない。
- **欄が無いときは安全側（`optin`）に倒す。** `visibility` は api が公開段階を切り替えるための欄なので、
  読めない・知らない形は「まだ出さない」に倒す。誤って公開になる方向には倒れない。

## 影響

- `core/plus/config.mjs`: `visibility` を読む。`derive` が `available` に `visibility`・端末の印・`AGENT_HOST_PLUS=1` を折り込む。
- `core/plus/session.mjs`: `refresh()`（印が変わったときに状態を送り直す）。
- `core/ops/settings.mjs`: `plus` 設定に `entrance`（真偽）を足す。`sync: false` のまま。
- `core/server.mjs`: 起動時に `prefs.plus.entrance` を読み、`plus-entrance` の message（`enable`/`disable`）で印を書き換える。
- `desktop/main.cjs`: `pleiad` プロトコルの登録（パッケージ版）・argv・`open-url` のリンクの受け取り・主の窓の前面化・サーバーへの引き渡し。
- `desktop/plus-link.cjs`: `pleiad://plus/enable|disable` の解析（ほかのリンクは扱わない）。
- `electron-builder.yml`（`protocols`）・`build/appx-manifest.xml`（MSIX の `uap3:Protocol`）。
- `mobile/android/`: `PlusConfig.visibility`・`PlusStore` の印・`PlusManager.stateJson` の出し入れ・`MainActivity` の `pleiad://plus` リンク・AndroidManifest の intent-filter。
- `tests/`: `fake-plus` に `visibility`（既定 `public`）、`plus-session`（判定表）・`desktop-plus-link`・`desktop-exit-dialog`（argv・second-instance）・`PlusConfigTest`。
