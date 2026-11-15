# ADR 0337: 設定 › プラグインの指示・Skills を「名前ごと・エージェントごと」の行にする（段 2）

- Status: 承認（2026-11-15）。引き継いだ担当が、実装と本物での確かめに合わせて書き直し、レビュー（`temporary/reports/context-agents-stage2-review.md`）を受けて §3-4・§4・§5 を直し、§6〜§10 を足した
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
   - 押したときの保存は `core/context-doc-matrix.mjs` の `applyDocTouch` 1 つにまとめ、画面の操作（`setDocAgent` / `setDocRow`）・試験が同じ関数を通る。表の初期のマスと実行時の計画も、同じ `resolveDocForAgent` から出す。
   - 旧い「Pleiad がそろえる」の場所を初めて触るときは、ユーザーの物の行の広げ（`spread`）も写す（写さないと、その場所だけ旧い広げが消える）。
   - 旧い `excludePaths` は保存されている絶対パスで、その下の物と、リンクの実体の下の物を除外として数える（main の探し方と同じ）。
4. **場所の行を「使う」に戻すとき**
   - 右パネルや場所の行のスイッチで行をオンに戻すと、全エージェントをオンにせず、オフにする前の状態に戻す。前の状態が無ければ、出どころのエージェントだけオンにする（§4 の行のスイッチ）。main で除外を外したときの動きと同じ。

### 4. エージェント別の実行時抑止・再配布と鍵の規則

ADR 0336 の教訓（写しホーム `GROK_HOME` 等で認証切れ・無関係ユーザーの起動変化・シンボリックリンク制限を起こさない）に従い、各 CLI の実測・コード検証済みの仕組みだけを使う。利用者の設定ファイルは書き換えない。

| エージェント | 指示（`instruction`）の止め方・鍵 | Skills（`skill`）の止め方・鍵 |
|---|---|---|
| **Claude** | `claudeMdExcludes` で実ファイル単位（`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`）に個別抑止。維持または代理配布分のみ既定注入／`instructions_for_path`。作業場所の `AGENTS.md` は、同じフォルダーに `CLAUDE.md`・`.claude/CLAUDE.md`・`CLAUDE.local.md` が無いときだけ Claude が代わりに読む（Claude Code 2.1.322 で 4 つの置き方を本物で確かめた）。横にあるときは Claude のマスは既定でオフ（広げれば Pleiad が渡す）。そのフォルダーの `CLAUDE.md` 類を止めると Claude が `AGENTS.md` を読み始めるので、そのターンは `AGENTS.md` も一緒に外す。鍵なし。 | 保持したいスキルがネイティブ版と一致する場合は `skills: [keptNames]` を渡して絞り込み。内容が `prefer` で別ソースへ差し替わる・全オフにする場合は `skills: []` + `disable-slash-commands` + `Skill` ツール抑止の上で `ply_context.load_skill` へ載せる。無改変時は `skills: "all"` のまま維持。鍵なし。 |
| **Codex** | ネイティブと差が出る場合のみ `project_doc_max_bytes = 0` で一括停止し、残す非条件付き指示を `developerInstructions`、条件付きを `instructions_for_path` で再配布。ユーザーの `~/.codex/AGENTS.md`（`AGENTS.override.md`）は `project_doc_max_bytes` では止まらず main も止めていないため **オンのまま鍵（`own`）**。 | `skills/config` でオフ対象・`prefer` で上書きされたネイティブパス単位に `enabled: false`。代理配布分（別ソースや `prefer` 差し替え分）は `ply_context.load_skill`。鍵なし。 |
| **Antigravity** | ユーザー `~/.gemini/GEMINI.md` はカスタムエージェントでも止められないため **オンのまま鍵（`own`）**。ワークスペース指示（`__workspace__` / `<ws>/AGENTS.md` / `GEMINI.md`）は `--agent ply-context` + `nativeInjected` のフィルタ＋`instructions_for_path` で切替可。 | Antigravity が自分で読む Skill を 1 つでも止めると `inheritCustomizations: false` になり、Hooks・プラグイン・サブエージェントも一緒に消える。このため、main でもそうなる旧い「Pleiad がそろえる」の場所でだけ押せる（`--agent ply-context` の `inheritCustomizations: false` で一括停止し、残す・代理配布するスキルを `ply_context.load_skill` で再配布）。それ以外の場所では、自分で読む Skill とまとめ行は **オンのまま鍵（`bundled`）**。自分で読まない Skill を広げるマスは押せる。本物の Antigravity では未確認（使用枠の都合）。 |
| **OpenCode** | ネイティブと差が出るターンは専用の管理 `serve`（`managedLaunch`：空の `OPENCODE_CONFIG_DIR` と `OPENCODE_DISABLE_PROJECT_CONFIG=1`）で起動してネイティブ指示を止め、維持・配布分のみ `system` / `instructions_for_path` で渡す（1 件でも変えると管理 `serve` 経路になる点は報告へ明記）。鍵なし。 | ネイティブと差が出るターンは `managedLaunch` 上で `skill: deny` + `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` + 隔離 `HOME` により `.opencode/skills` / `.claude/skills` / `.agents/skills` を停止し、維持・配布分を `ply_context.load_skill` で渡す。無改変時は既存の起動経路を維持。鍵なし。 |
| **Devin** | 写しホームは作らない。Devin が自分で読む物は **オンのまま鍵**：自前の置き場（`%APPDATA%/devin/*`, `~/.devin/*`, `<ws>/.devin/*`）は `read_config_from` で止まらないので `own` / `workspace`、取り込む形式（`agents_standard`, `claude`, `cursor`, `windsurf`, `copilot`, `opencode`）の物（作業場所の `CLAUDE.md`・`AGENTS.md`・`.windsurfrules`、`.claude` / `.cursor` / `.opencode` の下の物、まとめ行 `__workspace__` を含む）は `bundled`。形式を止めると同じ形式から取り込む Hooks・MCP も止まるので、表からは止めない（§8）。`.codex`・`.config/opencode`・`.grok` の下の `AGENTS.md` と `.agent/rules` などは Devin が読まない物として数え、広げるマスだけ押せる（Pleiad が `ply_context` で渡す）。作業場所の `.windsurf/global_rules.md` も Devin が読まない物として数える。 | 写しホームは作らない。自前スキル（`.devin/skills`, `.cognition/skills`, `%APPDATA%/devin/skills`、`DEVIN_CONFIG_HOME` の置き場）、main が Devin の物として並べる `~/.codeium`・`~/.copilot` の Skills、共通 `.agents/skills`、取り込む形式の Skills（`.claude/skills`・`.cursor`・windsurf・copilot・`.opencode` の下、出どころが opencode の物）は **オンのまま鍵**（`own` / `workspace` / `bundled`）。入れてある Devin（3000.11.92）は `codex`・`kiro` の取り込みを持たないので、`~/.codex` などの Skill は Devin が読まない物として数え、広げるマスだけ押せる（新しい版の文書には `codex`・`kiro`・`cloud` があり、版を上げるときに確かめ直す）。 |
| **Grok** | `GROK_HOME` の写しは使わない（ADR 0336）。ファイル由来の指示・Skills は全て鍵（Grok が自分で読む Grok/共通/Claude 系はオン＋`own`/`workspace`、その他はオフ＋`relay`）。**例外として `Pleiad の指示`（`plyInstructions`）は今も Grok に渡せるため鍵を外し 6 エージェントすべて切替可とする**（右端「委譲と連動」セルのみ `linked` 鍵）。 | ファイル由来は指示と同様に全て鍵（自前・共通・Claude 系はオン＋`own`/`workspace`、その他はオフ＋`relay`）。 |

無改変状態（あるエージェントについて、有効指示セット＝そのエージェントのネイティブ読込指示セット かつ 有効スキルセット＝そのエージェントのネイティブ読込スキルセット）では、そのエージェントに対して余計な抑制・代理起動を発動せず、従来通りの起動経路・引数・環境を維持する。

#### 行のスイッチ（レビューの決定 (a)）

- **見え方**：どれかのエージェントに実際に渡っていればオン（鍵つきでオンのマスも数える）。全部のマスがオフのときだけオフ。一部のマスだけオンなら「一部」（`aria-checked="mixed"`）。右パネルの「全体の設定で外しています」は、実際にどのエージェントにも渡っていない行にだけ付ける。
- **オフにする**：押せるマスを全部オフにし、オフにする前の状態を `was` に覚える。鍵つきでオンのマスが残る行は、押してもスイッチがオンのまま変わらないので、押せない見た目（`aria-disabled`・鍵の理由の吹き出し）にし、操作（`setDocRow`）でも理由と代わりの操作（マスを押す）を書いて断る。押したのに変わらない、を作らない。
- **オンにする**：オフにする前の状態（`was`）に戻す。前の状態が無ければ、出どころのエージェント（自分で読むエージェント）だけオン。自分で読むエージェントが無い物（探す場所に足したフォルダーの物）は渡せる全エージェント。ほかのエージェントへ広げるのは、アイコンを押して確認を通ったときだけ（モックの `toggleAll` のとおり）。右パネルの「この場所で使う」も同じ。
- **場所のまとめ行**（指示の `CLAUDE.md・AGENTS.md`、Skills の `.claude\skills・.agents\skills`）を押すと、その場所で明示の規則を持つ作業場所の行にも同じ操作をする。
- まとまりのチップと確認の後の広げは、`setDocAgent` の `keys` で複数の名前を 1 回で書く。知らない名前が混ざればどれも書かない（途中まで書かれた食い違いを作らない）。外部 MCP の行のスイッチも同じ見え方と押せる条件にそろえる。
- この規則と Devin・Grok の鍵（§4 の表・§8）の組み合わせで、**Devin か Grok が自分で読む行の行スイッチは押せない**。作業場所の Claude 系・共通の指示（`CLAUDE.md`・`AGENTS.md`、`.claude` の下の物）と `__workspace__` のまとめ行がそれにあたる。これらはマスを 1 つずつ押して切り替える。

### 5. UI コンポーネントの共有と右パネル

- **`web/context-matrix.mjs`（共有行コンポーネント）**：外部 MCP・指示・Skills のすべてが行・束・全体スイッチ・6 エージェントアイコン・出どころアイコン・追加固定列（`linked` 鍵）・鍵吹き出し（`web/lock-tip.mjs`）を共通 API で描画する。段階 3（Hooks）がこのコンポーネントをそのまま再利用できるよう `docs/design-system.md` に仕様を残す。
- **設定 › プラグイン（指示・Skills タブ）**：旧来の 2 択（エージェントに任せる／Pleiad がそろえる）と「探す形式」の札を廃止する。全体の規定画面ではワークスペース向けまとめ行を 1 行だけ出し、開いている会話の画面ではワークスペース内の実ファイル／Skill 行を展開する。指示の最大文字数は折りたたみ `<details>` に収め、Skills は絞り込み・重複時の優先選択（`prefer`）・中身プレビュー（peek）・パスコピー・追加フォルダー管理を維持する。
- **右パネル（セッション側パネル `web/session-context.mjs`）**：スペース制約（1 画面以内）のため、指示・Skills には 6 エージェントアイコンを並べず「この場所だけ変える」上の単一トグル（`この場所で使うか`）のみを残し、旧来の 2 択 `ownerSeg` と `formats` 札を削除する（Hooks のタブ・右パネルは触れない）。行スイッチが一部エージェントのみオン（混在）の場合は `mixed` 表現とし、右パネルのスイッチ（この場所で使う）は設定の表の行のスイッチと同じ規則（§4 の行のスイッチ）で切り替える。注記「全体の設定で外しています / この場所では外しています」は、行ごとに、この場所の設定を除いたときにオンか（`docMatrix` の `inheritedOn`）で決める（無関係な行を押しても注記が変わらない）。
- **モックとの意図した違い**：外した行でも、エージェントのチップは灰色で出したままにする（どのエージェントに渡っていたかが見える）。共通の置き場だけから来た物を広げるときは、共通の置き場の確認文を出す。

### 6. 承認（AI・CLI からの操作）

設定 › プラグインの表を変える操作は、人の画面からはそのまま通り、AI の会話（承認モードが ask）からは承認待ちになり、会話に紐づかない CLI からは断る（`NEEDS_UI`）。外す向きも緩めない。指示や Skill を外すのは「守るべき決まり」を減らすことになり、今の除外（`context.setSettings`）と同じ強さにそろえる。

| 操作 | 強さ | 理由 |
|---|---|---|
| `context.setDocAgent`（マス・まとまりのチップ） | guarded（入れる・外すとも） | 入れる・広げるは渡す物を増やす。外すは決まりを減らす。指示も Skills も同じ |
| `context.setDocRow`（行・まとめ行のスイッチ） | guarded（入れる・外すとも） | 同上 |
| `context.repairDocAgents`（読めない `context-agents.json` を退避） | guarded | 表で外していた物が旧い設定に戻って渡る |
| `context.setPlyInstructions`（表の Pleiad の指示のマス） | guarded | 全部の会話に渡る文脈を変える（ADR 0088） |
| `context.setSettings`（旧い担当・探す形式・除外・場所の登録） | guarded | 同上。表を触った後は §9 の規則で断ることがある |
| `context.setMcpAgent`（外部 MCP） | オフは write、オンは guarded | MCP を外すのは呼べる物を狭めるだけ。つなぐ向きだけ上げる（ADR 0327） |
| `context.docMatrix` | read | 読むだけ |

外す向きも承認の札では緩める変更として出す。

### 7. 保存の知らせと失敗の見せ方

- 「Antigravity と Grok は、新しい会話から反映します」は、その保存で Antigravity か Grok のマスが変わったときだけ出す。ほかは「保存しました」。外部 MCP・Pleiad の指示・指示の最大文字数の保存も同じ判定にする（レビューの決定 (b)）。どのエージェントが「会話を始めるときだけ読む」かは、画面に名前の並びを持たず、エージェントの記述の `contextAt`（`'turn'` / `'conversation'`。core/backends/agents.mjs）から引く。冒頭の文は「始まっている会話にも次のターンから反映します（Antigravity と Grok は新しい会話から）」。右パネルは、開いている会話が Antigravity か Grok のときだけ小見出しを「設定の変更は新しい会話から反映」にする。
- 保存の失敗は、パネルの先頭の文に加えて固定の位置のトーストにも出す（長い表の下の行で失敗しても見える）。`context-agents.json` の書き込みの失敗は、生の Node の誤り（`EISDIR: …`）でなく理由（同じ名前のフォルダーがふさいでいる・書き込めない・ディスクの空きが足りない）を書いた日本語にする。
- 表の保存の後に場所の登録（`context-scans.json`）が失敗したら、表の保存を戻す（片方だけ書かれた状態を作らない）。保存は通って再読み込みだけ失敗したときは「保存できませんでした」と言わず、「保存しました。表を読み直せませんでした」と言う。

### 8. Devin が自分で読む物は止めない

Devin の `read_config_from[fmt] = false` は、形式（`claude`・`cursor`・`opencode` など）ごとに指示・Skills・Hooks・MCP をまとめて止める。指示・Skills の表の 1 マスで形式を止めると、利用者が触っていない Hooks と MCP まで消える（MCP は外部 MCP 中継で補えたが、Hooks は補えない）。このため段 2 では次のようにする。

- Devin が自分で読む物（自前の置き場は `own` / `workspace`、取り込む形式の物は `bundled`）のマスは、**オンのまま鍵**にする。まとめ行 `__workspace__` も同じ。鍵の吹き出しは、自前の物は「Devin の設定にあるため、Pleiad からは止められません」、取り込む物は「Devin では止めると Hooks などほかの設定も一緒に止まるため、ここでは止められません」と理由を書く。
- 形式を止める仕組み（`devinDisableFormats`・`coupleDevinFormats`・MCP の補い）は外し、Devin の起動（`core/backends/devin.mjs`・`devin-config.mjs`）は main と同じにする。一時の `--config` の寿命は段 3（Hooks）で扱う。
- Devin が読まない物（`~/.codex/AGENTS.md`、`.agent/rules`、`.codex/skills` など）を Devin へ広げるマスは押せる。Pleiad が `ply_context` で渡す。
- Devin の版を上げて取り込む形式が増えたら（新しい版の文書には `codex`・`kiro`・`cloud` がある）、`core/backends/context-capabilities.mjs` の `devinImportFormat` を確かめ直す。

### 9. 旧い担当を覚える（`legacyOwner` / legacyPly）と、触った後の旧い操作

- 場所と種類の組み（`(placeOrDefault, kind)`）を初めて触ったとき、全項目の状態の写しと一緒に、その時点の旧い担当（`context-scans.json` の `owner`、`native` / `ply`）を `legacyOwner` に写す。
- 旧い「Pleiad がそろえる」（`ply`）の場所は、触った後も main と同じ止め方で起動する（legacyPly）。エージェントが自分で読む物はまとめて止め（Claude は `claudeMdExcludes` のグロブと自動メモリの停止、Codex は `project_doc_max_bytes = 0`、ほかも main の止め方）、表でオンの物を Pleiad が渡す。表に無い物（入れ子の `CLAUDE.md`・`CLAUDE.local.md`・ほかの `.claude/rules`）も止めたまま `instructions_for_path` で渡す。こうしないと、1 マス押しただけで、押していない物の届き方（自動メモリが書かれる・入れ子の `CLAUDE.md` が二重に届く）が変わる。
- 旧い `ply` で外していた物は、鍵のマスでも `off` に覚え、触った後も Pleiad が渡さない。Grok の受け付けも旧い担当で決める（main と同じく旧い `ply` の場所では受けない）。
- 写しを選んでいない同じ名前の Skill は、どの種類のマスを押してもエージェント自身に選ばせる。
- **表を触った後の旧い操作（担当の切り替え・探す形式・除外）は「通るなら効く、効かないなら断る」**。旧い操作を保存したと仮定して表を組み直し、保存の前と後で表（行・マス）が変わらなければ、理由（この場所は表で決めている）と代わりの操作（表のマスか行のスイッチ）を書いて断る（`INVALID`）。変わるなら通す。黙って保存されて何も起きない、を作らない。

### 10. 上限と掃除の理由

- `context-agents.json` は会話ごと（ターンの準備のたび）に読むので小さく保つ。上限は `places` 100 件・`agents` のキーの合計 2,000 件（`context-scans.json` と同じ水準）。
- 書くたびに、もう無いフォルダーの場所の設定は必ず外す（場所ごと消えたので、残しても効かない）。
- もう無いファイルのキー（`file:`）は、上限を超えるときだけ外す。ブランチを切り替えると一時的に消えるファイルがあり、戻したときに設定が戻るよう、上限に余裕がある間は残す。
- Skill のキー（`skill:`）は名前で指すので外さない（同じ名前の Skill がまた入れば同じ設定が効く）。
- 外せない物だけで上限を超えたら、次にすることを書いた日本語の誤り（`DOC_AGENTS_LIMIT`）で断る。
- 読めないファイル（壊れた JSON・知らない版・知らない項目・上限を超えた中身）は、`context-scans.json` と同じく会話を断り、表の設定は上書きしない。設定 › プラグインの「壊れたファイルを退避して直す」（`context.repairDocAgents`）で `context-agents.broken-<時刻>.json` へ移し、表を触る前の動きに戻す。退避は 5 つまで残し、古い物から消す。

## Consequences

- 利用者は外部 MCP と同じ操作感で、指示・Skills についてもエージェントごと・名前ごとの細かい制御が可能になる。
- 未編集の利用者およびベータダウングレード時の互換性を完全に保ち、Grok・Devin で不安定な写しホームを増やさない。
- OpenCode だけは 1 件でもネイティブと異なる構成にしたターンから管理 `serve` 経路へ切り替わるが、設定を変えていない通常時は従来経路を維持する。
- Devin が自分で読む物（`.claude` 系・共通・取り込む形式の物）は表から止められない（鍵つきでオン）。止めると同じ形式の Hooks・MCP も消えるため（§8）。その分、作業場所の Claude 系・共通の指示とまとめ行は、行のスイッチでなくマスで切り替える。
- 旧い「Pleiad がそろえる」の場所は、表を触った後も main と同じ止め方で起動する（§9）。旧い操作は効くときだけ通る。
