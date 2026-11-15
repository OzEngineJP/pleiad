# 0338 Hooks を、Hook × エージェントの一覧にする（担当の 2 択をやめる。保存・実行時・操作）

- 状態: 採用（2026-11-15。第 3 段の core の保存・実行時・操作と、画面（設定 › プラグイン › Hooks の表・会話の右の欄）を実装した。実機での確かめは末尾「確かめ」）
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
- 一覧の行には `hooks.scan` の `id`（`scanIds`、まとめた行は複数）を入れる。画面は中身ではなく id で突き合わせる。

### 書き換えた定義へ選択を引き継ぐ

`hk-` は中身から作るので、利用者が設定ファイルでコマンドや matcher を直すと名前が変わる。外した・広げた選択が黙って消える（＝外した Hook がオンに戻る）のを防ぐため、最後に見た名前を覚えて突き合わせる。

- 覚える単位は「エージェント・scope（user / project / local）・ファイル・イベント」の組（以下、グループ）。グループごとに、見えていた行 ID と数（同じ定義が 2 つあれば 2）を `seen` に残す。
- 次に一覧を開いたとき・選択を書くとき・ターンの計画のとき、グループごとに消えた ID と現れた ID を数ごと（多重集合）で比べる。
  - **消えたのが 1 つ・現れたのが 1 つ**で、消えた側に選択があり、現れた側が前から在った ID でも選択を持つ ID でもないときだけ、1 対 1 に対応するとみて、外した状態・広げた状態・使わない・場所ごとの選択を現れた側へ移す（同じ ID が残っているとき＝2 つあった定義の片方だけ直したときは、元の側にも残す）。
  - それ以外（2 つ以上を一度に直した・行を消して別の行を足した・直した結果が既存の定義と同じになった）は**引き継がない**。選択の付いていた ID のうち見えなくなったものを、一覧の返り値の `orphans` に `reason: 'ambiguous'`（何か現れた）か `'gone'`（何も現れない）で返す。候補（`candidates`、そのグループに現れた ID）も添える。黙って捨てず、画面の段で「行き先の無くなった設定」として出し、捨てる操作を置く。
  - 広げた状態（ほかのエージェントでも実行する）は、上の 1 対 1 のときだけ移す。あいまいなら移さない（実行する側へは倒さない）。
  - 行を足す・消す・並べ替えるだけなら、残った ID は変わらないので選択もそのまま。足した行・同じ定義の 2 つ目に、ほかの行の選択は付かない。
  - ファイルが読めない・一部しか読めないグループは比べない（見えないだけで消えたとは言えない）。プラグイン・スキルの Hook は対象外。
- `seen` は一覧を開いたとき（移った・覚えが変わったときだけ、その間にファイルが変わっていなければ）と、選択を書くときに保存する。ターンの計画では保存しない。`seen` は一覧の `revision` に入れない（開くたびに版が変わって書き込みが断られないように）。
- 限り: Pleiad が一度も見ないうちに行を足し、さらに別の行を直すと、足した行も「現れた」側に数えるので、あいまい（引き継がない・`orphans` に出す）になる。

### 保存

- `<data>/hooks-agents.json`（0600）。在れば「一覧の形に移った」（以下、移行済み）。無ければ今までの 2 択（`hooks.json` の担当）のまま動く。
  ```
  { version: 1,
    off:    { <行 ID>: [エージェント] },   // 元の集合から外したエージェント
    spread: { <行 ID>: [エージェント] },   // 元の集合に足したエージェント
    unused: [<行 ID>],                     // 全体のスイッチを切った行（エージェントごとの選択は覚えたまま）
    compat: { grok: 'native'|'off', devin: 'native'|'off' }, // 互換の読み込み元（旧「そろえる」の止め方を引き継ぐ）
    places: { <pathKey>: { path, skip?: [<行 ID>], agents?: { off, spread, unused, compat } } },
    adoptedFrom: { owner: 'native'|'ply', at },
    seen: [{ agent, scope, path, event, keys: { <行 ID>: 数 }, lost?: { <行 ID>: 'gone'|'ambiguous' } }] } // 書き換えた定義の突き合わせ用
  ```
  - `places[].skip` は「この場所では使わない」。`places[].agents` は、旧 2 択で場所ごとに担当を変えていた人の移行でだけ書く（その場所は全体の操作の影響を受けない。元へ戻す操作 `hooks.setPlace { reset: true }` で消す）。
- `hooks.json` には書かない（`ply-hooks.mjs` の書き込みは知らないキーを落とすため、別のファイルにする）。登録の本文（`targets`・`enabled`）と旧の担当はそのまま残す。
- 古い Pleiad はこのファイルを知らず、`hooks.json` の担当で今までどおり起動する（設定は消えない。新しい Pleiad へ戻れば移行済みの形で動く）。
- 移行済みから戻す操作（`hooks.resetAgents`）はファイルを消すだけで、旧の担当の動きへ戻る。
- **読めないとき**（JSON が壊れた・知らない `version`・読み取りの失敗）は、`hooks.json` が読めないときと同じ側に倒す: 会話を断る（`HOOKS_REFUSED`）。ただし、このプロセスで最後に読めた選択で、そのターンに止めるもの・渡すもの・互換の止めが何も無かったエージェントは続ける（`hooks.json` の、確かにエージェント任せだった場所だけ続けるのと同じ）。
  - 理由: 旧の担当（`hooks.json`）で動かすと、一覧で外したネイティブの Hook（見張り・止める Hook を外した、など）が黙って動き出す。止めた Hook が動くのは取り返しがつかないが、会話を断るのは直せば戻る。
  - 直す操作: `hooks.repair`（修復。`hooks.json` の修復と同じ操作。`hooks.json` が無事なら書き直さない）と `hooks.resetAgents`（以前の担当へ戻す）。どちらも壊れたファイルを消さずに隣の `hooks-agents.broken-<時刻>.json` へ名前を変えて残し（中身を読まないので、権限で読めないときも残る）、移行前（旧の担当）の動きに戻す。壊れたファイルから選択は取り戻さない（JSON として読めない・版を知らない、のどちらも、どの行を外していたか確かに言えない）。
  - 一覧（`hooks.matrix`）は投げずに `{ unreadable: true, error, repair: ['hooks.repair', 'hooks.resetAgents'], rows: [] }` を返し、画面の段で Hooks のタブに直す操作を出す。一覧を変える操作（`hooks.setAgent` など）は `UNREADABLE` で断り、ファイルに触らない。断る文は、この 2 つの操作と退避を案内する。

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
| Devin の Claude からの取り込み | Devin（`read_config_from` の既定。Claude の設定の定義を Devin が自分で読んで動かす。2026-11-15 実機で、作業場所の Claude の Stop が Devin のターンで動いた）。取り込みが止まるターン（下の `compat.devin`）では届かない |

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
- セルの `warnings`（`[{ code, params, evidence }]`）: 渡すときの注意（アダプター越し・Stop の意味の違いなど `deliverable` の warnings、Devin の `devinConfig`（取り込みが続く場所。利用者の Devin の設定に重ねて渡す）と `devinImportsStop`（`compat.devin` が `off` の場所。入れたターンから Devin の取り込みが全部止まり、AGENTS.md と Claude などから取り込む指示・Skills・MCP・Hooks が Devin に届かなくなる。Devin へ渡す Hook をすべて止めると、また取り込む）、Codex の `codexTrustAtTurn`、`grokTrustUnknown`、`stoppedWithOthers`（渡し直せずに一緒に止まっている））。

### 移行（触るまで何も変えない。最初に押したとき、そのときの実効の状態を写す）

- 旧「任せる」: ネイティブの定義は今のまま（元の集合）。登録はすべて `off[id] = targets`（動いていなかった）。`compat` は `native`。
- 旧「そろえる」: 
  - Pleiad が止めていた定義（`nativeFate` が `stopped`）は、元のエージェントを `off` に入れる。止めずに動き続けていたもの（`kept`）はそのまま。
  - 作業場所の定義も止めていたので `off['ws:hooks'] = [claude, codex, antigravity]`。
  - 登録は `targets` のとおり（オフのものは空のまま）。場所で外していた登録（`disabled`）は `unused`。
  - `compat.grok = 'off'`（Claude・Cursor・Codex の互換の読み込み元を止めていた）。
  - Devin へ向けた登録は `off[id] = ['devin']` から始め、`compat.devin` は Devin へ向けた登録があれば `'off'`（無ければ `'native'`）。
    - main は Devin の `--config` を起動の直後に消していた。Devin CLI はそのファイルを起動の後の `session/new` で読むので、旧「そろえる」でも、登録は Devin で動かず、取り込みも止まっていなかった（2026-11-15 実機。main の会話の記録は「渡した」と書いていた）。
    - 更新しただけで Devin の動きが変わらないよう、Devin のマスはオフ（取り込みは動く）から始める。利用者が Devin のマスを入れて渡すものができたターンから、旧の規則どおり取り込みが止まる（そのマスの注意は `devinImportsStop`）。止まっていない場所を止まる状態に変える操作は、どの入口（マス・行のスイッチ・まとまりのスイッチ・会話の右の欄の「この場所で使う」・場所の上書きを戻す（`setPlace` の `reset`））でも保存の前に知らせる（下の「画面」「操作」）。
  - 移行前（`adopted: false`）のターンは Devin へ何も渡さない（`prepareHooksTurn` の旧い道は、`HOOK_VIA` が `config` のエージェントでは `null`）。指示・Skills・外部 MCP の表が使う `devinImportsStopped` も、移行前はいつも `false`。
- 場所ごとに担当を変えていた人: その場所の担当と `disabled` で同じ計算をして `places[].agents` に書く。
- 写しを持つ人: 写し（相手のファイルの、アダプター越しのコマンド。`parseAdapterCommand`）は相手のエージェント自身の行のまま。元の行の、その相手の列は鍵（`copyExists`）で、状態は写しの状態。黙って消さず、二重に動かさない。
- 写しの式: `on(行, A) = 旧の A のターンで実際に動くもの`（Devin だけは会話の記録と実際が違っていたので、実際の動き）。更新しただけの人のターンは、main の値で固定した試験（`tests/unit/hooks-main-pinned.mjs`）で比べる。テスト（`tests/unit/hooks-agents.mjs`）で、4 つの組（旧「任せる」・旧「そろえる」・写しを持つ人・場所ごとに変えていた人）について、移行の前後で各エージェントのターンに動く Hook が同じことを確かめる。

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
    - 取り込みが止まる場所では、指示・Skills の表（`core/context-doc-matrix.mjs`）と外部 MCP の表（`core/context-mcp-matrix.mjs` の `importStopped`）で、取り込んだだけの物の Devin のマスを鍵つきのオフ（`devinHooks`）に見せる（表示だけで、実行時は変えない。2026-11-15 実機で、Devin のマスを入れると Claude・Cursor から取り込んだ MCP は Devin で起動されなかった）。Devin 自身の設定の物は鍵にしない。
    - Devin へ渡す Hook をすべて止めると、確認なしで取り込みに戻る（取り込みを広げる向きだが、旧「そろえる」と同じ。確認は足していない）。
    - `--config` を読まれるようにしたので、渡すものがあるターンの `--config` に載るほかの物も効くようになった。シェルの制限（`shellTool.devin === 'ply'` の `disabled_tools`）は Hooks の表と別に付き、main では読まれず効いていなかった。これも利用者の `config.json` に重ねるので、利用者のファイルが壊れていると、シェルの制限だけのターンでも `DEVIN_USER_CONFIG_INVALID` で断る。
    - **`--config` は利用者の `config.json` を置き換える**（重ねない。2026-11-15 実機 3000.11.92）。そのまま渡すと、利用者の hooks・`permissions` の allow/deny・`read_config_from`・`agent.model`・`devin.org_id` が黙って外れる。`mcp_config.json`・`credentials.toml`・作業場所の `.devin/` は影響を受けない。Devin に重ねる口は無い。
    - そこで渡すファイルは、利用者の `config.json`（MCP を切るターンは、MCP を外した置き場の写しの `config.json`）を土台に、Pleiad の分だけを重ねたものにする（`overlayDevinConfig`）。
      - hooks: イベントごとに利用者の後ろへ足す。
      - `read_config_from`: 利用者の値に、Pleiad が止める取り込み（`false`）だけを上書きする。利用者が止めた取り込みは広げない。
      - `disabled_tools`: 和集合。
      - そのほかのキーは利用者のまま。Devin が受け付けない値は、Devin 自身と同じくキーごとに既定へ戻る。
    - 断る（`DEVIN_USER_CONFIG_INVALID`、ターンを始めない。誤りの文に中身は載せない）:
      - 利用者の `config.json` が読めない、JSONC として壊れている、全体がオブジェクトでない。Devin 自身は警告を 1 行出して既定の設定で動くが、Pleiad の中では警告が見えず、見張りの Hook と拒否の権限が黙って外れるため。
      - Pleiad が足すキー（hooks・`read_config_from`・`disabled_tools`）に、Devin が受け付けない値がある。Devin はキーごとに既定へ戻すので、足した Pleiad の分も一緒に外れるため。特に hooks は、どこか 1 か所が受け付けられない（未知のイベント名・matcher の `null`・`type` の欠け・小数や負の timeout など）だけで丸ごと外れる。
    - 無い・空なら Pleiad の分だけを渡す。渡すものが無いターンは `--config` を付けず、利用者のファイルを Devin が自分で読む（壊れていても断らない。今までと同じ）。
    - Pleiad の分の hooks に Devin の知らないイベント名があれば、その定義は渡さない（1 つでもあると、利用者の分も含めて hooks が丸ごと外れる）。
    - 写しは鍵にしない（ADR 0336 の教訓との違い）: `config.json` には資格情報が無い（`credentials.toml` は別のファイルで、置き場から読まれる）。Devin が書き戻すのは `version` だけで、会話中の変更（許可・モデル）は保存しない。写しはデータ置き場の `devin/turn-configs`（フォルダー 0700・ファイル 0600、`wx` で作り、プロセスが終わったら消す。残ったものは 1 日で消す）に置き、中身はログに出さない。鍵にすると、利用者の hooks と権限を持つ人は Pleiad から Devin へ何も渡せなくなり、渡せば外れる、の 2 択になるため、重ねる方を採る。

### 画面（段 3）

形の細部は design-system.md「Hooks」。ここには決めたことだけを書く。

- 設定 › プラグイン › Hooks を、指示・Skills・外部 MCP と同じ共有の部品（`agentChip`・`rowSwitch`・`askBanner`・`agentLegend`・`web/lock-tip.mjs`）の表にした（`web/hooks-matrix.mjs`）。担当の 2 択とその確認・取り込みの選択・「ほかのエージェントへ写す」は画面から消した。旧カードの状態の文は行の詳細へ移した。
- アイコンは「そのエージェントのターンで実行する」。`MATRIX_ICON` に「実行する」の記号は無いので、新しい記号を作らず、指示・Skills と同じエージェントのロゴにした。読み上げ名は「{エージェント} で {名前} を実行する」。
- 広げる（`needsConfirm`）ときだけ、押した行の下で「{出どころ} の設定の Hook を、{相手} でも実行します」と聞き、`warnings` を箇条で並べる。注意があっても入れられる。
- 押すと Devin の取り込みが止まり始める操作は、広げるかどうかに関わらず、保存の前に押した行の下で「この操作で、この場所の Devin の取り込み（read_config_from）が止まります」と聞く。表のマス（`stopsDevinImports`）・行のスイッチ（`switchConfirm`）・右の欄の「この場所で使う」（`here.confirm`）の印は core の一覧が付け、画面は作り直さない。既に止まっている場所の 2 つ目の Devin では聞かない。この確認は覚えず、Devin を切って取り込みが戻った後に入れ直すときはまた聞く。まとまりのスイッチと場所の上書きを戻す操作は画面に無く、エージェント・CLI からは承認のカードで知らせる。
- 作業場所の Hooks は 1 行（`ws:hooks`）にまとめ、件数には数えない。場所ごとに使うかは会話の右の欄の「この場所で使うか」（`setHookPlace`）で選ぶ。右の欄にエージェントのアイコンは出さない。
- 移行前（`adopted: false`）は開いただけでは保存せず、最初に押したときに移行する。`hooks.resetAgents` は画面に置かない（押すと、移行してから選んだものが黙って全部消える。戻したいときは CLI・MCP から呼ぶ）。
- 行き先の無くなった選択（`orphans`）は、件数の注記だけを出す（捨てる操作はまだ置いていない）。
- 人が画面で押したときは承認のカードを出さない（画面の口は操作を `by: 'human', via: 'ui'` で呼ぶ）。エージェント・CLI から同じ操作を呼ぶと、上の「操作」の強さで承認を求める。

### 操作（`context.mcpMatrix` に当たるもの）

- `hooks.matrix`（read）: `{ adopted, agents, groups, cwd, place, skipFrom, compat, grok, claudeAllOff, trustPending, revision, orphans: [{ key, agent, scope, path, event, reason, candidates, off, spread, unused, places }], rows: [{ key, group, agent, source, scope, event, matcher, command（伏せ字）, scanIds?, on, switchable, here?, status?, targets?, enabled?, switchConfirm?, cells: { <A>: { state, mode, reason?, detail?, warnings?, needsConfirm?, stopsDevinImports?, copy?, reasons? } } }] }`。`needsConfirm` は、押すと広げるセル（元の集合に無く、今オフで押せる）と、押すと Devin の取り込みが止まり始めるセル（`stopsDevinImports: true`、`warnings` に `devinImportsStop`）に `true` で付く。止まり始めるかは実行時と同じ物差し（`compat.devin` が `off` で、Devin へ渡すものができる）で、止まっていない状態から止まる状態へ変わるときだけ印を付ける。行の `switchConfirm: { warnings }` は、行のスイッチを入れると止まり始める行、`here.confirm` は、この場所で使うに戻すと止まり始める行に付く。
- `hooks.setAgent`・`setRow`・`setGroup`・`setPlace` は `dry: true` で、何も書かずに `{ devinImportsStop, revision }` を返す。エージェント・CLI から呼ぶと、止まり始める操作は承認待ちになり、承認のカードの文に取り込みが止まることを足す（`opsApproval.hooksDevinImportsStop`）。動いた操作の戻りにも `devinImportsStop: true` を付ける。
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

- 新: `core/hooks-agents.mjs`（保存・行 ID・元の集合・セルの規則・移行の式・一覧・ターンで動く Hook）。一覧は列の短い名前（`labels`。エージェントの記述の `shortLabel`）を返す。画面の短い名前は有効なエージェントの分しか届かないため。場所を指定した一覧では、その場所に定義が無い作業場所のマスに `empty` を付ける（設定の画面は場所を指定しないので出ない。会話の右の欄・AI・CLI から場所つきで呼んだときだけ）。
- 変: `core/context-session.mjs`・`core/context-scan.mjs`・`core/context-mcp-matrix.mjs`（取り込みが止まる場所の外部 MCP の Devin のマスの鍵）。
- 変: `core/hooks-unify.mjs`（移行済みのターンの準備）、`core/hooks-plan.mjs`（Codex の行ごとの止め・agy のアダプターの絶対パス）、`core/backends/claude.mjs`・`codex.mjs`・`devin*.mjs`・`antigravity-context.mjs`、`core/ops/hooks.mjs`、`core/server.mjs`（`opsHooks`）、`tests/data-writes-allowlist.mjs`。
- 画面の文言の鍵だけ `web/locales/{en,ja}/{agent,server}.json` に足した（鍵・注意・断りの文。画面の部品は触っていない）。
- 画面: `web/hooks-matrix.mjs`（新）、`web/context.mjs`（タブ）・`web/session-context.mjs`（右の欄）・`web/hooks-card.mjs`（行の詳細とシートだけ残した）・`web/hooks-unify-ui.mjs`（理由・注意の文、登録の詳細とシート、会話の Hooks の面だけ残した）、`web/context.css`。旧の担当の 2 択・取り込み・写すの画面と、その文言・CSS は消した。
- 移行済みの人には、旧の操作（担当の切り替え `hooks.setOwner`・場所ごとの担当・取り込み・切り替えの確認 `hooks.unifyPreview`・写す `hooks.copy`）を `HOOKS_MOVED` で断り、エラーの文で一覧の操作と `hooks.resetAgents` を案内する（効かないのに効いたように見えるのを防ぐ。画面からは段 3 で消した）。

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

Devin の `--config` に利用者の設定を重ねる直しは、試験用の設定の置き場（利用者の hooks・allow/deny・`read_config_from`・model を持つ `config.json`）と本物の Devin で、製品の経路で確かめた（2026-11-15）。

- (1) 何も渡さない: `--config` 無し。利用者・作業場所・取り込んだ Claude の hook が各 1 回。allow のコマンドは確認無しで走り、deny のコマンドは走らない。
- (2) Pleiad の登録を Devin へ広げる: 渡したファイルは、利用者のキーをすべて残し、UserPromptSubmit が利用者 → Pleiad の順。登録が 1 回、利用者と取り込んだ Claude の hook も各 1 回。allow・deny とも効いたまま。
- (3) シェルの制限: `disabled_tools` が足され、hooks は (2) と同じく動く。ただしコマンドは ply_shell で走り、Devin の `Exec(...)` の allow/deny は当たらない（ply_shell は Pleiad の承認だけを通る。ほかのエージェントの ply_shell と同じ性質で、`--config` とは別。今までも、置き換えで deny は外れていた）。
- (4) 戻す: (1) と同じ動き（`--config` 無し）。
- どのターンの後も写しは残らず、利用者の `config.json` は `version` 以外変わらなかった。

旧「そろえる」の人の Devin を main と比べた（2026-11-15、本物の Devin、試験用のデータ置き場と作業場所。作業場所に Claude の Stop と AGENTS.md、Pleiad の登録を Devin へ向けた）。

| 場合 | 渡したファイル | 登録 | 作業場所の Claude の Stop（取り込み） | 答え（作業場所の AGENTS.md の合言葉） |
|---|---|---|---|---|
| main・旧「そろえる」 | 取り込みを全部止め登録を載せたものを書いたが、起動の直後に消えた（`{"version":1}` の残りが溜まる） | 動かない（記録は「渡した」） | 動く | 答えた |
| main・旧「任せる」 | 無し | 動かない | 動く | 答えた |
| この版・移行前と移行の後 | 無し | 動かない（Devin のマスはオフ、注意は `devinImportsStop`） | 動く | 答えた |
| この版・Devin のマスを入れた | 取り込みを止め登録を載せたもの（ターンの間残る） | 1 回 | 動かない | 答えない |
| この版・もう一度切った | 無し | 動かない | 動く | 答えた |
| この版・旧「任せる」で Devin のマスを入れた | 登録だけを重ねたもの（取り込みは止めない。注意は `devinConfig`） | 1 回 | 動く | 答えた |

- 外部 MCP: 取り込みが続く場所では Claude・Cursor の MCP が Devin で起動された。Devin のマスを入れると起動されず、外部 MCP の表の Devin のマスは `devinHooks` の鍵になった。
- 指示・Skills: Devin のマスを入れると、取り込む物の Devin のマスが `devinHooks` の鍵になった。Devin 自身の Skill はオンのまま。
