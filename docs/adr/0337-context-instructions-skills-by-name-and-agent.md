# ADR 0337: 設定 › プラグインの指示・Skills を「名前ごと・エージェントごと」の行にする（段 2）

- Status: Accepted
- Date: 2026-11-15
- Related: ADR 0327（外部 MCP の名前×エージェント一覧）, ADR 0331（段 1：4 タブ・フォルダー束・鍵吹き出し）, ADR 0336（Grok・Devin の写しホームを見送り）, `temporary/mockups/context-tabs-matrix-report.md`

## Context

ADR 0327 で外部 MCP を「名前ごと × 6 エージェント」の一覧にし、ADR 0331（段 1）で 4 つのタブ（外部 MCP・指示・Skills・Hooks）・フォルダー束・Skills 絞り込み・鍵の吹き出しを入れた。
しかし段 1 の段階では、指示・Skills・Hooks の保存形式と実行時解決が旧来の「担当（`native` / `ply`）の 2 択」と「探す形式（`sources`）」のままだったため、行ごとの ON/OFF や「この Skill だけは Claude にだけ渡す」といったエージェントごとの制御ができなかった。

段 2 では、指示（`instruction`）と Skills（`skill`）を外部 MCP と同じ「名前ごと・エージェントごと」の一覧と保存・実行時に揃える。Hooks の保存・実行時・UI（段 3）は別 worktree で進行中のため、段 2 では触れない。

## Decision

### 1. 保存先とダウングレード互換性（`context-agents.json`）

旧版（0.42.5-beta.31 以前）の `core/context-settings.mjs` は `context-scans.json`（version 3）の `kindSchema` に `.strict()` を付けており、`kind !== 'mcp'` に `agents` が含まれると `context.settings.unreadable` で読み込みを拒否する。
ダウングレード時の破損を防ぐため、**`context-scans.json` は v3 スキーマのまま変更せず**、指示・Skills の名前×エージェント設定は独立したバージョン付き JSON ファイル **`<dataDir>/context-agents.json`**（version 1）に保存する。

```json
{
  "version": 1,
  "defaults": {
    "instruction": { "agents": { "<itemKey>": { "off": ["grok"], "spread": ["codex"] } } },
    "skill": { "agents": { "<itemKey>": { "off": [], "spread": ["claude"] } } }
  },
  "places": {
    "<pathKey>": {
      "instruction": { "agents": { "...": { "off": [], "spread": [] } } },
      "skill": { "agents": { "...": { "off": [], "spread": [] } } }
    }
  }
}
```

- 上限：`places` 最大 100 件、合計キー数（`agents` の合計エントリ数）最大 2,000 件（`context-settings.mjs` と同水準の有界チェック）。
- `context-scans.json` 側で `place`（この場所だけ変える）が削除された場合は、`context-agents.json` の該当 `place` も削除する。
- `context-scans.json` には既存の `prefer`（同名 Skill の優先ファイル）・`budget`（指示の最大文字数）・`sources` / `excludePaths`（未編集時や旧版互換の参照元）・`hooks`・`mcp` をそのまま残す。
- **`Pleiad の指示`（`prefs.json` の `plyInstructions.items[]`）** はすでに行ごとの `{ on, agents, route, ... }` を持っているため二重管理せずそのまま使う。既存スキーマ `agents.min(1)` を壊さないよう、最後の 1 つのエージェントをオフにする操作は `on: false` へ反転して `agents: [last]` を保持し、`on: false` の行で任意のエージェントを押した場合は `on: true, agents: [agent]` として有効化する。

### 2. 行を一意に指すキー（Item Identity Key）

指示・Skills の各行（とフォルダー外まとめ行）は次のキーで一意に識別する。

| 種類 | キー形式 | 備考 |
|---|---|---|
| ワークスペース共通まとめ行 | `__workspace__` | 全体の規定画面（`default`）と、未上書きワークスペースでの継承元行（指示：`CLAUDE.md・AGENTS.md`、Skills：`.claude\skills・.agents\skills`） |
| 指示（実ファイル） | `file:${normalizedRealPath}` | `realPath`（無ければ `path`）を `pathKey` 正規化し `/` 区切りに揃えたもの。別パスのシンボリックリンク等で同じ実体を指すものは 1 行に統合し `origins` を合算する |
| Skill（名前単位） | `skill:${name}` | `entry.name` をキーとする（UI の Skill 名まとめおよび重複除外と一致）。複数箇所に同名 Skill がある場合は `context-scans.json` の `prefer[name]` が代表ファイルと内容を決定する |

### 3. 最初の操作まで動きを変えない規則と変換式（`docAgentsFromLegacy`）

更新しただけの利用者の動作を 1 つも変えないため、`(placeKeyOrDefault, kind)` ごとに `context-agents.json` の適用深さ `agentsDepth` と `context-scans.json` の適用深さ `legacyDepth` を比較する。

1. **`agentsDepth < 0`（未編集）または `legacyDepth > agentsDepth`（子ディレクトリ側に旧来の場所別上書きが残っている場合）**
   - 実行時は旧来ロジック（`context-scans.json` の `owners[kind]`・`sources`・`excludePaths`）をそのまま実行し、例えば `owner === 'native'` なら一切の抑制・`ply_context` 注入を行わない。
   - UI（設定タブ・右パネル）の初期表示アイコンも同じ規則から出す **`docAgentsFromLegacy(...)`** で算出し、「画面の初期アイコン」と「実行時に実際に渡る物」を一致させる。
2. **`docAgentsFromLegacy` の対応式**
   - 旧設定の `excludePaths` または `sources` によって除外されていた行（ロックオンされる CLI 停止不能セルを除く）→ 切り替え可能な全エージェントを `off`（行スイッチもオフ）。
   - 有効だった行：
     - 旧 `owner === 'native'`：その行をネイティブに読むエージェント（`nativeReaders(kind, entry)`。自ソースおよび仕様上ネイティブ読込するクロス互換形式）をオン（`native`）、それ以外を `off`。
     - 旧 `owner === 'ply'`：Pleiad が配布可能な全エージェントをオン（ネイティブ読込するものは `native`、代理注入するものは `spread`）、配布不能かつ非ネイティブ（後述 Grok の他エージェント製ファイル等）は `off`（`reason: 'relay'` 鍵）。
3. **初回編集時の実体化**
   - 利用者が `(placeOrDefault, kind)` で初めて行またはセルを切り替えた瞬間、現在のスキャン結果と継承元（親ディレクトリの `agents` 設定または `docAgentsFromLegacy`）から全項目の `agents` 状態を切り出して `context-agents.json` に確定保存し、当該操作を反映する。
   - 未接続・読込前のプレースホルダのみにならないよう、`context-agents.json` 未登録の間は未編集フラグを保ち、既存 `sources` / `excludePaths` は後方互換の読み取り専用フォールバックとして扱う。

### 4. エージェント別の実行時抑止・再配布と鍵の規則

ADR 0336 の教訓（写しホーム `GROK_HOME` 等で認証切れ・無関係ユーザーの起動変化・シンボリックリンク制限を起こさない）に従い、各 CLI の実測・コード検証済みの仕組みだけを使う。利用者の設定ファイルは書き換えない。

| エージェント | 指示（`instruction`）の止め方・鍵 | Skills（`skill`）の止め方・鍵 |
|---|---|---|
| **Claude** | `claudeMdExcludes` で実ファイル単位（`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`）に個別抑止。維持または代理配布分のみ既定注入／`instructions_for_path`。鍵なし。 | 保持したいスキルがネイティブ版と一致する場合は `skills: [keptNames]` を渡して絞り込み。内容が `prefer` で別ソースへ差し替わる・全オフにする場合は `skills: []` + `disable-slash-commands` + `Skill` ツール抑止の上で `ply_context.load_skill` へ載せる。無改変時は `skills: "all"` のまま維持。鍵なし。 |
| **Codex** | ネイティブと差が出る場合のみ `project_doc_max_bytes = 0` で一括停止し、残す非条件付き指示を `developerInstructions`、条件付きを `instructions_for_path` で再配布。鍵なし。 | `skills/config` でオフ対象・`prefer` で上書きされたネイティブパス単位に `enabled: false`。代理配布分（別ソースや `prefer` 差し替え分）は `ply_context.load_skill`。鍵なし。 |
| **Antigravity** | ユーザー `~/.gemini/GEMINI.md` はカスタムエージェントでも止められないため **オンのまま鍵（`own`）**。ワークスペース指示（`__workspace__` / `<ws>/AGENTS.md` / `GEMINI.md`）は `--agent ply-context` + `nativeInjected` のフィルタ＋`instructions_for_path` で切替可。 | ネイティブと差が出る場合は `--agent ply-context` の `inheritCustomizations: false` で一括停止し、残す・代理配布するスキルを `ply_context.load_skill` で再配布。鍵なし。 |
| **OpenCode** | ネイティブと差が出るターンは専用の管理 `serve`（`managedLaunch`：空の `OPENCODE_CONFIG_DIR` と `OPENCODE_DISABLE_PROJECT_CONFIG=1`）で起動してネイティブ指示を止め、維持・配布分のみ `system` / `instructions_for_path` で渡す（1 件でも変えると管理 `serve` 経路になる点は報告へ明記）。鍵なし。 | ネイティブと差が出るターンは `managedLaunch` 上で `skill: deny` + `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` + 隔離 `HOME` により `.opencode/skills` / `.claude/skills` / `.agents/skills` を停止し、維持・配布分を `ply_context.load_skill` で渡す。無改変時は既存の起動経路を維持。鍵なし。 |
| **Devin** | 写しホームは作らない。自前パス（`%APPDATA%/devin/*`, `~/.devin/*`, `<ws>/.devin/*`）は `read_config_from` で止まらないため **オンのまま鍵（`own` / `workspace`）**。インポート形式（`agents_standard`, `claude`, `cursor`, `windsurf`, `copilot`, `opencode`）は全停止または同一形式グループ内にオフ行がある場合 `read_config_from[fmt] = false` で止め、同グループ内の維持行は `ply_context` で再配布。よってグローバル指示 `__workspace__`（`CLAUDE.md・AGENTS.md`）は切替可。 | 写しホームは作らない。自前スキル（`.devin/skills`, `.cognition/skills`, `%APPDATA%/devin/skills`）と共通 `.agents/skills`（グローバル行 `__workspace__` `.claude\skills・.agents\skills` を含む）は止まらないため **オンのまま鍵（`own` / `workspace`）**。`.claude/skills` 等インポート形式の行は `read_config_from[fmt] = false`＋`ply_context.load_skill` で切替可。**重要**：`read_config_from.claude = false`（または `cursor = false`）を使うターンでは、Devin CLI が `.mcp.json` / `~/.claude.json` 等も同時に読まなくなるため、Devin で有効な該当ソース MCP があれば自動的に `ply_context` リレーへ補完する。 |
| **Grok** | `GROK_HOME` の写しは使わない（ADR 0336）。ファイル由来の指示・Skills は全て鍵（Grok が自分で読む Grok/共通/Claude 系はオン＋`own`/`workspace`、その他はオフ＋`relay`）。**例外として `Pleiad の指示`（`plyInstructions`）は今も Grok に渡せるため鍵を外し 6 エージェントすべて切替可とする**（右端「委譲と連動」セルのみ `linked` 鍵）。 | ファイル由来は指示と同様に全て鍵（自前・共通・Claude 系はオン＋`own`/`workspace`、その他はオフ＋`relay`）。 |

無改変状態（あるエージェントについて、有効指示セット＝そのエージェントのネイティブ読込指示セット かつ 有効スキルセット＝そのエージェントのネイティブ読込スキルセット）では、そのエージェントに対して余計な抑制・代理起動を発動せず、従来通りの起動経路・引数・環境を維持する。

### 5. UI コンポーネントの共有と右パネル

- **`web/context-matrix.mjs`（共有行コンポーネント）**：外部 MCP・指示・Skills のすべてが行・束・全体スイッチ・6 エージェントアイコン・出どころアイコン・追加固定列（`linked` 鍵）・鍵吹き出し（`web/lock-tip.mjs`）を共通 API で描画する。段階 3（Hooks）がこのコンポーネントをそのまま再利用できるよう `docs/design-system.md` に仕様を残す。
- **設定 › プラグイン（指示・Skills タブ）**：旧来の 2 択（エージェントに任せる／Pleiad がそろえる）と「探す形式」の札を廃止する。全体の規定画面ではワークスペース向けまとめ行を 1 行だけ出し、開いている会話の画面ではワークスペース内の実ファイル／Skill 行を展開する。指示の最大文字数は折りたたみ `<details>` に収め、Skills は絞り込み・重複時の優先選択（`prefer`）・中身プレビュー（peek）・パスコピー・追加フォルダー管理を維持する。
- **右パネル（セッション側パネル `web/session-context.mjs`）**：スペース制約（1 画面以内）のため、指示・Skills には 6 エージェントアイコンを並べず「この場所だけ変える」上の単一トグル（`この場所で使うか`）のみを残し、旧来の 2 択 `ownerSeg` と `formats` 札を削除する（Hooks のタブ・右パネルは触れない）。行スイッチが一部エージェントのみオン（混在）の場合は `mixed` 表現とし、右パネルのスイッチ操作は当該場所の解放可能セルを一括でオン／オフする。

## Consequences

- 利用者は外部 MCP と同じ操作感で、指示・Skills についてもエージェントごと・名前ごとの細かい制御が可能になる。
- 未編集の利用者およびベータダウングレード時の互換性を完全に保ち、Grok・Devin で不安定な写しホームを増やさない。
- OpenCode だけは 1 件でもネイティブと異なる構成にしたターンから管理 `serve` 経路へ切り替わるが、設定を変えていない通常時は従来経路を維持する。
- Devin で `.claude` 系指示・Skill をオフにすると `read_config_from.claude = false` に伴う `.mcp.json` / `~/.claude.json` の消失をランタイムが自動で `ply_context` MCP へ補完するため、設定の見た目通りに MCP が生き続ける。
