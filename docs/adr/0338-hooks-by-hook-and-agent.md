# 0338 Hooks を、Hook × エージェントの一覧にする（担当の 2 択をやめる。保存・実行時・操作）

- 状態: 採用（2026-11-15。第 3 段のうち core の保存・実行時・操作を実装した。画面は別の仕事。実機での確かめは末尾「確かめ」）
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

セルの `reason` は 4 つ、`detail` はその中の訳（英字の code。画面の文言は画面の仕事で足す。注意の `evidence` だけ `web/locales/*/server.json` の `hooksAgents.evidence.*` で文にして返す）。
- `'admin'`: Claude・Codex の管理者の定義（`managed`。オンのまま）。
- `'own'`: エージェント自身が読むので、1 つずつは止められない・広げられない。
  - `grokOwn`（Grok 自身の hooks）・`plugin`（Claude 以外のプラグイン）・`pluginOrSkill`（プラグイン・Skill の定義をほかへ広げる）・`nativeInactive`（エージェント自身が無効にしている定義）。
  - `devinImports`: Devin が Claude の設定から取り込む定義。Devin の列はオン（取り込みのとおり）で押せない。`compat.devin` を切り替える操作は無く、旧「そろえる」からの移行でだけ `off` になる。`off` でも、止まるのは Devin へ渡すものがあるターンだけ（旧と同じ）なので、その場所で Devin へ渡すものがあるときだけ `'workspace'`・`devinCompatOff`（切り）、無ければ `devinImports`（入り）に見せる（`cellsFor` が渡すものの有無で決める）。
  - `copyExists`: 既に写しがある組（写しの側で切り替える。セルに `copy`（写しの行 ID））。
  - `claudeAllOff`: 利用者の Claude の設定が `disableAllHooks`（Claude の列は止まったまま）。
  - `claudeAllOrNothing`・`grokAllOrNothing`・`agySameName`・`stoppedWithOthers`: 押すと、渡し直せないほかの定義が黙って一緒に止まる（Claude は全部止めて渡し直す、Grok の互換はまとめて止める、Antigravity は名前で止める）。
- `'workspace'`: 作業場所の定義。`followsWorkspace`（この場所の一覧の作業場所の定義は、作業場所の 1 行 `ws:hooks` に従う）・`placeNoSpread`（作業場所の定義はほかのエージェントへ広げない）・`grokWorkspace`・`grokTrustUnknown`（Grok のフォルダーの信頼）・`noWorkspaceHooks`（OpenCode は作業場所の Hooks を読まない）・`devinCompatOff`。
- `'relay'`: そのエージェントへ渡せない（`detail` は `deliverable` の理由の code。`reasons` に根拠を付ける）。
- 押せるように見えて何も変わらないセルは作らない（`decideModes`: 押した後の状態を計算し、そのセルが変わり、ほかのセルが黙って止まらないときだけ `mode: 'toggle'`）。
- セルの `warnings`（`[{ code, params, evidence }]`）: 渡すときの注意（アダプター越し・Stop の意味の違いなど `deliverable` の warnings、Devin の `devinConfig`（そのターンは Devin の取り込みも止まる）、Codex の `codexTrustAtTurn`、`grokTrustUnknown`、`stoppedWithOthers`（渡し直せずに一緒に止まっている））。

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
  - Claude: 1 つずつ止める口が無い。止める行があるときだけ `disableAllHooks` にして（記録の `stopAll`）、止めない行をコールバックで渡し直す。渡し直せないもの（SessionStart・Setup、Skill の hooks、`CLAUDE_PLUGIN_DATA` を使うもの、コマンドでないもの）が巻き添えになるセルは、一覧では押せない（`claudeAllOrNothing`）。押した後に足された定義などで実行時にずれたときは、渡し直せないものは一緒に止まり、セルに `stoppedWithOthers` の注意が出る。管理者は止めない。
  - Codex: `hooks/list` の定義のうち、止める行（`runtime.stopRows`: ファイル・イベント・group・handler の番号。作業場所の 1 行を止めるときは `{ source: 'project' }`）に当たる key だけ `enabled: false`。止めない行は動き続ける。**本物では未確認**（週次の上限のため走らせなかった。今の「そろえる」の経路の上に、止める key の絞り込みを足しただけ）。
  - Antigravity: 名前で止める（置き場の `.agents/hooks.json` の `{ enabled: false }`）。同じ名前のほかのオンの定義は `pleiad-*` で渡し直す。アダプターは置き場の絶対パスで書く（今の agy は置き場の hook を `.agents` 以外のフォルダーで動かし、相対パスでは見つからなかった。2026-11-15 実機。置き場のパスに空白・安全でない文字があれば相対パスのまま）。第 2 段の `inheritCustomizations` 用に、このターンで動く Hook を返す入口 `hooksForTurn(agent, cwd)` を出す。
  - Grok: Claude のユーザーの定義を Grok の列で止めたときだけ `GROK_CLAUDE_HOOKS_ENABLED=false` で起こし、止めないユーザーの定義をプラグインの置き場で渡し直す。Cursor の互換は `compat.grok` が `off` のときだけ止める（旧「そろえる」）。Grok 自身の hooks は止めない。
  - OpenCode: 渡すだけ（コールバック）。利用者のプラグインは一覧に出さない。
  - Devin: 渡すものがあるターンは `--config`（`read_config_from` は `compat.devin` のとおり）。`compat.devin` が `off` なら、旧「そろえる」と同じく、渡すものがあるターンだけ Devin の取り込み（MCP・ルールを含む）も止まる（`runtime.stopImports`。渡すものが無いターンは `null` で、今までと同じ起動）。`--config` のファイルは Devin のプロセスが終わるまで消さない（Devin CLI は起動の後の `session/new` のときに読む。起動の直後に消していたため、旧「そろえる」でも渡したものが載っていなかった。2026-11-15 実機。閉じずに残ったものは次の起動で 1 日を過ぎた分だけ消す）。

### 操作（`context.mcpMatrix` に当たるもの。画面はまだ呼ばない）

- `hooks.matrix`（read）: `{ adopted, agents, groups, cwd, place, skipFrom, compat, grok, claudeAllOff, trustPending, revision, rows: [{ key, group, agent, source, scope, event, matcher, command（伏せ字）, on, switchable, here?, status?, targets?, enabled?, cells: { <A>: { state, mode, reason?, detail?, warnings?, needsConfirm?, copy?, reasons? } } }] }`。`needsConfirm` は、押すと広げるセル（元の集合に無く、今オフで押せる）だけに `true` で付く。
- `revision` は保存の中身の hash（移行の時刻 `adoptedFrom.at` は入れない。移行前の一覧は開くたびに写し直すため）。操作に `revision` を渡すと、違えば `CONFLICT` で断る。押せないセルは `INVALID`（`hooksAgents.notPressable`）。
- `hooks.setAgent`（セル）・`hooks.setRow`（全体のスイッチ）・`hooks.setGroup`（組のセル・組のスイッチ）・`hooks.setPlace`（この場所で使う・場所の上書きを戻す）・`hooks.resetAgents`（移行前へ戻す）。
- 承認（AGENTS.md・ADR 0095・0327）: 同じ結果になる今の操作と同じ強さにそろえる（write の操作で guarded の変更ができると抜け道になる。ADR 0095）。
  - Pleiad の登録（`h-…`）を外す向き（`setAgent`・`setRow` の `on: false`、`setGroup { group: 'ply', on: false }`、`setPlace { key: h-…, use: false }`）は `write`（今の `togglePlyHook` の `enabled: false` と同じ）。
  - エージェントの設定の定義（`hk-…`）・作業場所の Hooks（`ws:hooks`）・組 `own`/`place` を外す向き、場所の上書きを消す向き（`setPlace { reset: true }`）は `guarded`（利用者の見張りの Hook を止めるので、`hooks.setOwner`・`hooks.saveNative` と同じ）。承認カードは `loosens: true`（関所を変える側として出す）。
  - 入れる・広げる・戻す向き（ほかのエージェントのターンでコマンドを動かす＝関所を緩める）は、どの行も `riskOf` で `guarded`（`approvalWords: 'hooks'`、`loosens: true`）。

## 理由

- 外部 MCP と同じ形にすれば、画面も操作も 1 つの考え方で済む。広がる範囲は 1 つの Hook × 1 つのエージェントに限られ、確認も行ごとで足りる。
- 写す（相手のファイルへ書く）をやめ、Pleiad がターンごとに渡す・止めるだけにすれば、利用者の設定ファイルは書き換わらない。
- 止める手段の無い組は、押せるように見せず、鍵と理由を出す。

## 影響

- 新: `core/hooks-agents.mjs`（保存・行 ID・元の集合・セルの規則・移行の式・一覧・ターンで動く Hook）。
- 変: `core/hooks-unify.mjs`（移行済みのターンの準備）、`core/hooks-plan.mjs`（Codex の行ごとの止め・agy のアダプターの絶対パス）、`core/backends/claude.mjs`・`codex.mjs`・`devin*.mjs`・`antigravity-context.mjs`、`core/ops/hooks.mjs`、`core/server.mjs`（`opsHooks`）、`tests/data-writes-allowlist.mjs`。
- 画面の文言の鍵だけ `web/locales/{en,ja}/{agent,server}.json` に足した（鍵・注意・断りの文。画面の部品は触っていない）。
- 画面（`web/`）は変えない。今の Hooks の画面（担当の 2 択・写す）は移行前の人にはそのまま動く。移行済みの人には、旧の操作（担当の切り替え `hooks.setOwner`・場所ごとの担当・取り込み・切り替えの確認 `hooks.unifyPreview`・写す `hooks.copy`）を `HOOKS_MOVED` で断り、エラーの文で一覧の操作と `hooks.resetAgents` を案内する（効かないのに効いたように見えるのを防ぐ。画面からも消すのは第 3 段の画面の仕事）。

## 確かめ（2026-11-15、試験用のデータ置き場・作業場所・別のポートのサーバー。利用者の設定ファイルは書き換えていないことを hash で確かめた）

エージェントごとに (1) 何も触らない (2) 1 つオフ (3) ほかのエージェントの Hook を広げる (4) 戻す、を本物のターンで見た。

| エージェント | (1) | (2) | (3) | (4) |
|---|---|---|---|---|
| Claude | 本物 | 本物（利用者の Stop を止め、作業場所の定義は渡し直されて動いた） | 本物（agy の登録がコールバックで 1 回） | 本物 |
| OpenCode | 本物 | 本物 | 本物（Claude の登録がコールバックで 1 回） | 本物 |
| Devin | 本物（作業場所の定義。利用者の Stop は Devin のターンでは跡を残さず観測できない） | 本物（取り込みは鍵のまま動き続ける） | 本物（`--config` で 1 回。直した後） | 本物 |
| Antigravity | 本物 | 本物（作業場所の 1 行を止めた） | 直す前は本物で失敗（アダプターが見つからない）。直した後は Gemini の週次の上限で走らせられず、同じコマンドを 3 つのフォルダーから動かして確かめただけ | 未確認（試験だけ） |
| Grok | 本物（利用者の Stop が互換で動いた。会話の記録は残らない＝起動は今までどおり） | 本物（利用者の Stop を止めた） | 本物（Claude の登録がプラグインで 1 回） | 未確認（会話の上限のため。試験だけ） |
| Codex | 未確認（週次の上限） | 未確認 | 未確認 | 未確認 |
