# 0338 Hooks を、Hook × エージェントの一覧にする（担当の 2 択をやめる。保存・実行時・操作）

- 状態: 提案（2026-11-15。第 3 段のうち core の保存・実行時・操作。画面は別の仕事）
- 関係: [ADR 0327](0327-external-mcp-by-name-and-agent.md)（外部 MCP を名前 × エージェントの一覧にする）と同じ形にする。[ADR 0049](0049-hooks-pleiad-managed.md)（Pleiad がそろえる）の渡し方・止め方を使い回し、担当の 2 択（`hooks.json` の `defaults`・`places` の `owner`）を、触った人から置き換える。[ADR 0047](0047-hooks-copy-adapter.md)（写す）の変換をそのまま使う。

## 状況

設定 › プラグイン › Hooks は、担当を「エージェントに任せる」か「Pleiad がそろえる」の 2 択で決めていた。
- 「そろえる」は全部か全く無しで、「Claude の guard-rm だけ Codex でも動かす」「Codex の notify だけ止める」ができなかった。
- 別のエージェントで動かすには、相手の設定ファイルへ「写す」しかなかった（相手のファイルを書き換える）。
- 承認したモック（`temporary/mockups/context-tabs-matrix`）は、外部 MCP と同じ一覧で、エージェントのアイコンが「そのエージェントのターンで実行する」を表す。

## 決定

### 一覧の形

- 行は「出どころ・イベント・matcher・1 つのコマンド」。列は 6 つのエージェント（Claude・Codex・Antigravity・OpenCode・Devin・Grok）。行には全体のスイッチと、詳細に出す状態の文（今までのカードの状態の文は詳細へ移す）。
- 組は「Pleiad に登録」（`ply`）・「エージェントの設定」（`own`）・「作業場所」（`place`）。全体の一覧の作業場所は 1 行（`ws:hooks`、「.claude\settings.json・.codex\hooks.json」）。場所ごとの一覧は作業場所の行を 1 つずつ出し、行ごとに「この場所で使う」だけを操作できる。
- 担当の 2 択と「ほかのエージェントへ写す」は一覧から無くす（既にある写しは、相手のエージェント自身の行として残る）。
- 名前に無いエージェントのアイコンを入れると、その Hook を広げる。広げる前に行ごとに 1 回、その場で聞く（「{出どころ} の設定の Hook を、{相手} でも実行します」［やめる］［実行する］）。外すときは聞かない。

### 行の名前（行 ID）

- Pleiad の登録: 登録の `id`（`h-` + 12 桁）。
- エージェントの設定の定義: `hk-` + sha256(JSON `[エージェント, scope, ファイル, イベント, matcher ?? '', コマンドの前後の空白を除いたもの, 名前 ?? '']`) の先頭 16 桁。ファイルは `pathKey(path)`、プラグインは `plugin:<id>`。並びの位置（group・handler の番号）は入れない（前に 1 つ足しても名前が変わらない）。
- 同じファイル・同じイベント・matcher・コマンドが 2 回書かれていれば 1 行にまとめる（どちらもエージェント自身が動かすので、止めるときは両方止める）。

### 保存

- `<data>/hooks-agents.json`（0600）。在れば「一覧の形に移った」（以下、移行済み）。無ければ今までの 2 択（`hooks.json` の担当）のまま動く。
  ```
  { version: 1,
    off:    { <行 ID>: [エージェント] },   // 元の集合から外したエージェント
    spread: { <行 ID>: [エージェント] },   // 元の集合に足したエージェント
    unused: [<行 ID>],                     // 全体のスイッチを切った行（エージェントごとの選択は覚えたまま）
    compat: { grok: 'native'|'off', devin: 'native'|'off' }, // 互換の読み込み元（旧「そろえる」の止め方を引き継ぐ）
    places: { <pathKey>: { path, skip?: [<行 ID>], agents?: { off, spread, unused, compat } } },
    adoptedFrom: { owner: 'native'|'ply', at } }
  ```
  - `places[].skip` は「この場所では使わない」。`places[].agents` は、旧 2 択で場所ごとに担当を変えていた人の移行でだけ書く（その場所は全体の操作の影響を受けない。元へ戻す操作 `hooks.setPlace { reset: true }` で消す）。
- `hooks.json` には書かない（`ply-hooks.mjs` の書き込みは知らないキーを落とすため、別のファイルにする）。登録の本文（`targets`・`enabled`）と旧の担当はそのまま残す。
- 古い Pleiad はこのファイルを知らず、`hooks.json` の担当で今までどおり起動する（設定は消えない。新しい Pleiad へ戻れば移行済みの形で動く）。
- 移行済みから戻す操作（`hooks.resetAgents`）はファイルを消すだけで、旧の担当の動きへ戻る。

### 元の集合（そのエージェントが自分で動かす）

| 定義 | 元の集合 |
|---|---|
| Pleiad の登録 | `enabled` なら `targets`、オフなら空 |
| Claude のユーザー（`~/.claude/settings.json`） | Claude、Grok（互換の読み込み。`compat.grok` が `native` のとき） |
| Claude の作業場所（`.claude/settings.json`・`settings.local.json`） | Claude。Grok はフォルダーを信頼したときだけ読む（`~/.grok/trusted_folders.toml`。無ければ信頼なし、在れば分からないので Grok の列は鍵） |
| Claude のプラグイン・Skill・管理者 | Claude |
| Codex のユーザー・作業場所・プラグイン・管理者 | Codex（信頼されていない・無効・書き換えられたものは空） |
| Antigravity のユーザー・作業場所 | Antigravity（無効のものは空） |
| Grok 自身（`~/.grok/hooks`・`config.toml`） | Grok |
| Devin の Claude からの取り込み | 未確認（実機で確かめる。確かめられなければ Devin の列は鍵） |

### セルの状態（一覧と実行時が同じ規則を使う）

- オン = 全体のスイッチがオン ∧ この場所で使う ∧ ((元の集合にある ∧ off に無い) ∨ spread にある)。
- 作業場所の定義は、全体の `off['ws:hooks']` にそのエージェントがあれば止める。
- 鍵（`mode: 'locked'`）のセルは保存に関わらず元の集合のとおり（止められない・渡せない）。押せるのは `mode: 'toggle'` だけ。
- 一覧（`hooks.matrix`）と実行時（`prepareHooksTurn` → `hooksForTurn`）は、同じ関数（`core/hooks-agents.mjs` の `cellsOf`）で決める。

### 鍵と理由（`reason`）

- `'admin'`: Claude・Codex の管理者の定義（オンのまま。ほかの列は `mode: 'none'` で、点で出す）。
- `'own'`: エージェント自身が読むので止められない・ほかへ広げられない。Claude・Codex・Antigravity のプラグイン、Claude の Skill の hooks、Grok 自身の hooks、Devin の取り込み（未確認の間）、既に写しがある組（`detail: 'copyExists'`。写しの側で切り替える）、Claude で止めると渡し直せないものが巻き添えになるとき（`detail: 'claudeAllOrNothing'`）。
- `'workspace'`: 作業場所の定義を止められないエージェント（Grok・OpenCode）の作業場所の行、Grok のフォルダーの信頼が分からないときの Claude の作業場所の定義。
- `'relay'`: そのエージェントへ渡せない（イベントが無い・ツールが写せない・アダプターが要るのに node が無いなど。理由の code と根拠を付ける）。
- 押せるように見えて何も変わらないセルは作らない。

### 移行（触るまで何も変えない。最初に押したとき、そのときの実効の状態を写す）

- 旧「任せる」: ネイティブの定義は今のまま（元の集合）。登録はすべて `off[id] = targets`（動いていなかった）。`compat` は `native`。
- 旧「そろえる」: 
  - Pleiad が止めていた定義（`nativeFate` が `stopped`）は、元のエージェントを `off` に入れる。止めずに動き続けていたもの（`kept`）はそのまま。
  - 作業場所の定義も止めていたので `off['ws:hooks'] = [claude, codex, antigravity]`。
  - 登録は `targets` のとおり（オフのものは空のまま）。場所で外していた登録（`disabled`）は `unused`。
  - `compat.grok = 'off'`（Claude・Cursor・Codex の互換の読み込み元を止めていた）。`compat.devin = 'off'`（Devin へ渡すものがあるターンは取り込みを止めていた。渡すものが無いターンは今までどおり取り込む）。
- 場所ごとに担当を変えていた人: その場所の担当と `disabled` で同じ計算をして `places[].agents` に書く。
- 写しを持つ人: 写し（相手のファイルの、アダプター越しのコマンド。`parseAdapterCommand`）は相手のエージェント自身の行のまま。元の行の、その相手の列は鍵（`copyExists`）で、状態は写しの状態。黙って消さず、二重に動かさない。
- 写しの式: `on(行, A) = 旧の会話の記録で A のターンに動くもの`。テスト（`tests/unit/hooks-agents.mjs`）で、4 つの組（旧「任せる」・旧「そろえる」・写しを持つ人・場所ごとに変えていた人）について、移行の前後で各エージェントのターンに動く Hook が同じことを確かめる。

### 実行時（エージェント A のターン、場所 cwd）

- want = A でオンの行。native = A が自分で動かす行（元の集合に A がある）。止める = native − want（押せる行だけ）。渡す = want − native ＋ 巻き添えの渡し直し。
- 止めるものも渡すものも無く、互換の止めも無いターンは `null`（今までと同じ起動・同じ経路）。
- 渡し方は「Pleiad がそろえる」の経路（`deliverable`・`claudeHookCallbacks`・`codexHooksTable`・`agyHooksFile`・`grokHooksFile`・OpenCode のコールバック・Devin の `--config`）をそのまま使う。エージェントの設定ファイルは書き換えない。相手のファイルへ書く道は足さない。
- 同じ A に同じイベント・matcher・コマンドが 2 つ渡る（登録とその取り込み元など）ときは 1 つにする。
- エージェントごと:
  - Claude: 1 つずつ止める口が無い。止める行があるときだけ `disableAllHooks` にして、止めない行をコールバックで渡し直す。渡し直せないもの（SessionStart・Setup、Skill の hooks、`CLAUDE_PLUGIN_DATA` を使うもの、コマンドでないもの）が巻き添えになるなら、その場所の Claude の列は鍵（`claudeAllOrNothing`）。実行時に状態がずれていたら（新しく足された定義など）ターンを始めない（`hooksAgents.claudeAllOrNothing`）。管理者は止めない。
  - Codex: `hooks/list` の key のうち、止める行の key だけ `enabled: false`（`runtime.stopKeys`）。止めない行は動き続ける。**本物では未確認**（週次の上限のため走らせない）。
  - Antigravity: 名前で止める（置き場の `.agents/hooks.json` の `{ enabled: false }`）。同じ名前のほかのオンの定義は `pleiad-*` で渡し直す。第 2 段の `inheritCustomizations` 用に、このターンで動く Hook を返す入口 `hooksForTurn(agent, cwd)` を出す。
  - Grok: Claude のユーザーの定義を Grok の列で止めたときだけ `GROK_CLAUDE_HOOKS_ENABLED=false` で起こし、止めないユーザーの定義をプラグインの置き場で渡し直す。Cursor の互換は `compat.grok` が `off` のときだけ止める（旧「そろえる」）。Grok 自身の hooks は止めない。
  - OpenCode: 渡すだけ（コールバック）。利用者のプラグインは一覧に出さない。
  - Devin: 渡すものがあるターンは `--config`（`read_config_from` をすべて false）。旧「そろえる」と同じく、そのターンは Devin の取り込み（MCP・ルールを含む）も止まる。

### 操作（`context.mcpMatrix` に当たるもの。画面はまだ呼ばない）

- `hooks.matrix`（read）: `{ adopted, agents, groups, rows: [{ key, group, source, scope, event, matcher, command（伏せ字）, on, cells: { <A>: { state, mode, reason?, detail? } }, needsConfirm: [A], status }], place?, revision }`。
- `hooks.setAgent`（セル）・`hooks.setRow`（全体のスイッチ）・`hooks.setGroup`（組のセル・組のスイッチ）・`hooks.setPlace`（この場所で使う・場所の上書きを戻す）・`hooks.resetAgents`（移行前へ戻す）。
- 承認（AGENTS.md・ADR 0327）: 外す向き（狭める）は `write`、入れる・広げる・戻す向き（ほかのエージェントのターンでコマンドを動かす＝関所を緩める）は `riskOf` で `guarded`（`approvalWords: 'hooks'`、`loosens: true`）。

## 理由

- 外部 MCP と同じ形にすれば、画面も操作も 1 つの考え方で済む。広がる範囲は 1 つの Hook × 1 つのエージェントに限られ、確認も行ごとで足りる。
- 写す（相手のファイルへ書く）をやめ、Pleiad がターンごとに渡す・止めるだけにすれば、利用者の設定ファイルは書き換わらない。
- 止める手段の無い組は、押せるように見せず、鍵と理由を出す。

## 影響

- 新: `core/hooks-agents.mjs`（保存・行 ID・元の集合・セルの規則・移行の式・ターンで動く Hook）、`core/hooks-matrix.mjs`（一覧を組む）。
- 変: `core/hooks-unify.mjs`（移行済みのターンの準備）、`core/hooks-plan.mjs`（Codex の key ごとの止め）、`core/backends/claude.mjs`・`codex.mjs`・`grok.mjs`・`devin*.mjs`（止める範囲の受け取り）、`core/ops/hooks.mjs`、`core/server.mjs`（`opsHooks`）、`tests/data-writes-allowlist.mjs`。
- 画面（`web/`）は変えない。今の Hooks の画面（担当の 2 択・写す）は移行前の人にはそのまま動く。移行済みの人には担当の 2 択が効かない（第 3 段の画面の仕事で消す）。
