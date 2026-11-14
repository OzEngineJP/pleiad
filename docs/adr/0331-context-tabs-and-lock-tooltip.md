# 0331 設定 › プラグイン・会話の右パネルを 4 タブ・フォルダー単位のまとまり・鍵の吹き出しにする

- 状態: 承認（2026-11-15、段 1 実装）
- 承認の内容: プロダクトオーナーが、モック（`temporary/mockups/context-tabs-matrix.html`、報告本文および追補 1）の方向性を承認し、保存形式と実行時計画を変えない範囲（段 1）を先行実装する。
- 関連: [ADR 0327](0327-external-mcp-by-name-and-agent.md)（外部 MCP の名前 × エージェント一覧。「タブで分ける案は作らない」を、プラグインの 4 種類の分割に限って改める）

## 状況

設定 › プラグインに「Pleiad の指示」「指示」「Skills」「外部 MCP」「Hooks」が縦 1 列に並び、1 画面が 4,000px を超えていた（会話の右パネル「この場所だけ変える」も同じ）。また外部 MCP のカードの下に出していた凡例「🔒 Pleiad からは止められません」が利用者の視界で目立ちすぎていた（追補 1）。

承認された最終形「4 つのタブ（指示・Skills・外部 MCP・Hooks）＋ どの種類も外部 MCP と同じ 6 エージェント行＋鍵の吹き出し」を 3 段に分けて出す。**段 1**は、`context-scans.json`・`hooks.json`・`prefs.json` の保存形式と `core/` の実行時計画を変えずにできる範囲とする。

## 決定

- **4 つの固定タブ（`.cx-tabs`）**: 設定 › プラグイン（`#contextPanel`、`web/context.mjs`）と会話の右パネルの「この場所だけ変える」（`web/session-context.mjs`）に、`指示`・`Skills`・`外部 MCP`・`Hooks` の 4 タブ（件数つき）を置き、1 度に 1 種類だけを見せる。
  - `role="tablist"` で `←` / `→` / `Home` / `End` キーに対応し、最後に開いたタブを `localStorage`（設定 `'ply-context-tab'`、右パネル `'ply-session-context-tab'`）に覚える（`prefs.json` は変えない）。
  - 切り替えたらスクロール位置を先頭（`0`）へ戻し、スクロールしても上端に残す（`.settings-content` の上余白 `24px` に対し `top: -24px`、右パネル `.scx` は `top: 0` で面 `--surface-0`、選択タブは `--surface-paper`）。フォーカス移動・`scrollIntoViewIfNeeded` がタブ帯の下に潜らないよう、該当コンテナに `scroll-padding-top: 64px` を付ける。
  - `docs/design-system.md` の「設定に pill 列や横タブは置かない」を「プラグインの 4 タブだけ置く」に改める。
- **フォルダー・置き場ごとのまとまり（`web/context-tabs.mjs`）**:
  - 指示（2 件以上）と Skills（1 件以上）を置き場フォルダー単位の 1 行（`.cx-row.grp`、件数の札・出どころのロゴ・パス・全体のスイッチ）にまとめ、開くと子の行（`.cx-row.kid`）を縦の繋ぎ線（`.cx-lead0::before`）付きで並べる。子の行は出どころのロゴとフォルダーパスを繰り返さない。`8` 件を超えるまとまりは初期状態で畳む。
  - 入れ子の `rules` は最寄りの `rules` フォルダーまでを親にし、子はその下の相対パスを表示する。
  - まとまりのスイッチは中身が割れているとき「一部」（`aria-checked="mixed"`）。ARIA の `role="switch"` は `mixed` を持てないため `role="checkbox"` を使い、読み上げ名に「（N 件中 M 件オン・一部）」を入れる。スイッチ操作は配下の複数件を 1 回の保存でまとめて切り替える（`toggleExcludeMany`）。Skills を絞り込んでいる間は、スイッチの状態（オン・オフ・一部）も切替も、見えている（当たった）行だけが対象で、絞り込みを消すとまとまり全体の状態に戻る。保存に失敗したときは、押した瞬間に変えた見た目を保存されている状態から描き直す（設定は失敗を出して全体を描き直し、右パネルの編集中はタブ帯の上に失敗を出す）。
- **タブの件数**: 「Pleiad が渡す件数」を出す。設定と右パネルで同じ定義にし、担当が「エージェントに任せる」の種類（指示・Skills・Hooks）は Pleiad が数えられないので `0` ではなく件数を出さない（`null`）。外部 MCP は、設定は行列の件数、右パネルは探索で見つかった名前の数（エージェントごとの設定のときは出さない）で、数える元だけが違う。
- **Skills の絞り込み（`.cx-find`）**:
  - Skills のタブに絞り込みの入力欄を置き、`input` 要素を作り直さず中身の一覧だけを描き直してフォーカスを保つ。入力中は当たったまとまりだけを自動で開き、0 件時は「見つかりません」を出す。タブを切り替えたら絞り込みを消す。
- **鍵付きの理由の吹き出し（`web/lock-tip.mjs`、`.cx-tip`）**:
  - 外部 MCP カード下の静的な凡例「🔒 Pleiad からは止められません」を廃止し、鍵付きの項目（アイコン・押せないスイッチ）のホバー（150ms 猶予）・キーボードフォーカス（即時）・タッチタップ（再タップで閉じる）で `.tc-when-pop` に揃えた浮く面（最大幅 `340px`）を出す。押しても状態は変えない。Esc（フォーカス維持）・外側押下・フォーカス離脱・スクロールで見えなくなる・リサイズで閉じ、`prefers-reduced-motion` では動きを止める。
  - ブラウザー標準の `title` は外し、押せないスイッチは `disabled` ではなく `aria-disabled="true"` にし、読み上げ名を「{元の名前}（{理由}）」にする。
  - 理由は `cell.reason`（`'own'` / `'workspace'` / `'relay'` / `'admin'` / `'linked'`）があればそれを選び、無ければ `mode`（`locked` → `'own'`、`blocked` → `'relay'`）から補う。`'linked'` の文言は辞書にあるが、`cell.reason` を埋める作業（`ply-7bbb`）まで段 1 では表に出さない。
  - 吹き出しの相手が描き直しで DOM から外れたら吹き出しも消し（外部 MCP の一覧は読み込み中 2.5 秒ごとに描き直す）、マウスがまだ同じ位置の鍵の上にあれば出し直す。重なりは `z-index: 70`（右パネル 45・メニュー 50・通知 60 より上）。
- **段 1 で残すもの（段 2・3 への境界）**:
  - 指示・Skills・Hooks の各行は単一のスイッチのまま（6 エージェント列は出さない）。
  - 担当の 2 択、探す形式の札、指示の量の目安、「探す場所を足す」、外部 MCP の「外の AI から Pleiad を使う」（`#cliSetup`）、Hooks の担当切り替え確認・コピー導線は各タブの中に機能を落とさず残す。

## 影響

- `web/context-tabs.mjs`・`web/lock-tip.mjs`（新規）
- `web/context.mjs`・`web/context.css`・`web/mcp-matrix.mjs`・`web/ply-instructions-card.mjs`・`web/hooks-card.mjs`・`web/session-context.mjs`
- `web/locales/{ja,en}/ui.json`・`tests/i18n-allow.json`
- `docs/design-system.md`・`docs/adr/0327-external-mcp-by-name-and-agent.md`
- `core/` および保存ファイル（`context-scans.json`・`hooks.json`・`prefs.json`）は変更しない。
