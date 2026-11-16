# 0217 秘密情報と変数をエージェントに預ける（API キーの画面を広げる）

- 状態: 承認（2026-10-17）。利用者がモック（AsIs / ToBe）を見て、下の形と次の 3 点を決めた: ページの名前は「秘密情報と変数」、AI が自分で作った値は承認を通して新しい項目として足せる（人が入れた項目は AI が差し替え・削除できない）、入力する先はまず Chrome（`ply_browser`）だけ
- 関連: [ADR 0155](0155-api-keys-in-one-place.md)（API キーの置き場と同意の分け方。画面の名前とカードの操作をこの ADR で変える）、[ADR 0094](0094-human-only-five.md)（「秘密の値」の組にコマンドを足す。組は 5 つのまま）、[ADR 0213](0213-login-shell-env.md)（サーバーへ渡す環境変数）、[ADR 0083](0083-control-surface-cli.md)（会話のシェルへ渡す環境変数）、docs/inapp-browser.md（`hand_to_user`）

## 状況

思想 §2.2（AI は人間と同じパートナー）を、もう一段深くする。人がふだん自分の手でしていること、たとえばサイトにログインする・手元に開発の環境を作る（テスト用の API キーや DB の URL を入れて動かす）ことを、AI が人の代わりにできるようにしたい。

今はできない。

- エージェントに環境変数を足すには、OS の環境変数を変えて Pleiad を起こし直すしかない。Windows はログインシェルの環境も読まない（ADR 0213）。会話に値を貼れば、値はモデルと各 CLI の記録に残る。
- ログインの画面に来ると、AI は `hand_to_user` で人に渡す（docs/inapp-browser.md）。人がその場に居なければ止まったままになる。
- 置き場は API キー（ADR 0155）だけで、使うのは Pleiad の機能（接続先・通話・判定器・`wait_until` の問い）に限られる。

ほかの製品の形も見た（2026-10-17）。

- procway（ADR 0024・0034）: テナントとプロジェクトの 2 段のスコープ（プロジェクトが勝つ）。秘密の行は暗号化して値を画面に返さず、平文から秘密へは変えられるが逆はできない。予約キーは黙って落とさず断る。注入の道は 1 本。AI が人に値を頼むカード（AI にはキー名だけが返る）。システムプロンプトにはキー名と secret の印だけ。`.env` の貼り付けで取り込む。
- Codex cloud: シークレットは setup の段だけで、エージェントが動く前に外す。その結果、テストで使うキーは普通の変数にするしかない。
- Cursor: 「Redacted」の値はモデルに見えるものから外す。モデルが `[REDACTED]` をファイルに書き戻す事故が報告されている。
- 1Password `op run`: 参照（`op://…`）を実行の時だけ値にし、子の出力に出た値を既定で伏せる。
- Devin: シークレットに使い方の注記を付け、AI にも見せる。

## 決定

### 何を持つか

設定 › API キーを **「秘密情報と変数」** に広げる（承認したモックの形は docs/design-system.md「設定 › 秘密情報と変数」）。1 つのページに次を並べる。

| 種類 | 値を画面に出すか | 例 |
|---|---|---|
| API キー | 出さない | OpenRouter のキー。今の API キーそのもの |
| ログイン情報 | パスワードは出さない（ユーザー名は出す） | サイトのユーザー名とパスワード |
| 秘密の値 | 出さない | トークン・パスワード・接続文字列 |
| 変数 | 出す | `NODE_ENV=development` |

上の 3 つ（秘密情報）はカード、変数は 1 行ずつの一覧。

### 置き場

- **API キーの台帳は変えない。** `<data>/api-keys.json`・`<data>/api-key-secrets.json`（ADR 0155）はそのまま。`core/api-keys.mjs` の `clean` は知らない項目を書き戻しで落とし、開発版と配布版が同じデータ置き場を使う（ADR 0155）。API キーの行に項目を足すと、古い版が保存したときに消える。
- **新しい台帳 `<data>/secrets.json`**（秘密でないもの）: `{ version: 1, items: [{ id: 'sec-…', kind: 'login' | 'secret' | 'var', label, note, username?, value?（kind が var のときだけ）, sites: [host], env: { name, scope: 'all' | { folders: [path] } } | null, lastUse: { at, sessionId, site } | null, createdAt, by: 'human' | 'ai' }], keyUses: { '<API キーの id>': { env, note } } }`。上限は 500 件（`tests/data-writes-allowlist.mjs` に書く）。`lastUse` は上書きで、件数では増えない。
- **値 `<data>/secret-values.json`**: `core/secret-store.mjs`（safeStorage。暗号化できない起動は 0600 の平文で、ページに注意を出す）。エントリは `item:<id>`（ログイン情報は `{ password }`、秘密の値は文字列）。API キーの値は今のまま `api-key-secrets.json` に置き、`keyUses` は id で指すだけ。
- 古い版がキーを消した後に残った `keyUses` は、使うときに飛ばし、ページに ⚠ を出す（ADR 0155 の `pruneDangling` と同じ考え）。

### 同意: 登録しただけでは渡さない

ADR 0155 と同じ分け方にする。登録は置くだけで、**使い道を選ぶ操作**が「AI に使わせる」ことへの同意になる。使い道は 3 つ。

1. **環境変数として渡す**（名前と渡す場所）。
2. **サイトで入力する**（ホストの一覧）。ログイン情報だけ。
3. **Pleiad の機能**（今の API キーの `uses` と接続先の `keyRef`）。

既定は、秘密の値と変数が「環境変数として渡す」。名前を入れたのは、その名前で使うためだから。API キーは何も付けない（今と同じ）。ログイン情報は「サイトで入力する」（サイトを入れたのは、そこで使うため）。

### 環境変数の渡し方

- **渡す場所**: 「すべてのフォルダー」か、選んだフォルダー（リポジトリ）。会話の cwd を含むリポジトリの根で引く。worktree（ADR 0136）と委譲の子は、元のリポジトリの設定を引く。フォルダーの値が「すべて」の値に勝つ。
- **効き始め**: 当初は次のターンから。**2026-11-16 の追記で変更した**: `ply_shell` と途中反映に対応するエージェントのシェルには、走っているターンにも反映する。対応範囲・通知・自動継続は末尾の追記を参照。
- **道は今の 1 本だけ**: 会話ごとの env（`controlRuntimeFor(turn).env`・`browserEnv` と同じ所）に載せる。新しい注入の道は作らない。
  - **Claude**: CLI の `options.env` には入れず、`CLAUDE_ENV_FILE` で Bash ツールのシェルにだけ渡す。これは Claude Code が各 Bash コマンドの前に読むスクリプトで、データ置き場の `run/claude-env-<uuid>.sh`（0600）に書き、ターンの終わりに消す（消し損ねは起動時に片付ける。`run/claude-compat-<uuid>.json` と同じ扱い）。CLI 本体の env に入れないので、利用者が自分のアプリのために登録した `ANTHROPIC_API_KEY`・`ANTHROPIC_BASE_URL` が、Claude Code 自身の認証・接続先を替えることはない。**（2026-10-29 の [ADR 0284](0284-secrets-off-claude-command-line.md) で書き方を変えた: env file の中身は `bash.exe -c` の引数に載り値がコマンドラインに出るため、値は別の `run/claude-env-<uuid>.vals`（0600）に置き、`.sh` は読み込む行だけにした。Claude の PowerShell ツールには値が届かなくなった）**
  - **Codex**: スレッドの config の `shell_environment_policy.set`（今の `PLEIAD_CONTROL_*` と同じ所）。シェルにだけ届き、共有の app-server の env は変えない。
  - **Antigravity**: 会話ごとの agy のプロセスの env。agy が自分の認証に読む名前は agy のプロセスに入れず、ページのその行に ⚠ を出す（名前の一覧は段階 1 で確かめる）。
  - **入力欄の `!` の行**: そのシェルの env。
  - hooks と MCP には渡さない（MCP の `${VAR}` の展開元に足すのは段階 3）。
- **使えない名前**: Pleiad 自身のものと、CLI を壊すものだけ。`AGENT_HOST_*`・`PLEIAD_*`・`PLY_*`・`AGENT_BROWSER_*`・`ELECTRON_RUN_AS_NODE`・`CLAUDE_ENV_FILE`、`PATH`・`HOME`・`USERPROFILE`・`SystemRoot`・`ComSpec`。登録の時点で理由を付けて断り、黙って落とさない。**`ANTHROPIC_*`・`OPENAI_*` などは断らない**（上の渡し方で CLI 本体に届かないので、利用者のアプリのために使える）。
- 名前は `^[A-Za-z_][A-Za-z0-9_]*$`。

### サイトで入力する

- `ply_browser` に `fill_secret({ item, field: 'username' | 'password', target })` を足す。Pleiad が、その会話のブラウザーのタブの今の origin を確かめ、項目の `sites` に合うときだけ入力する。合うのは https で、ホストが同じか、そのサブドメイン。
- 値はモデルに渡さず、ツールの結果は「入力した／理由」だけ。会話にはツールの行「ログイン情報を入力 · <名前> · <ホスト>」を出す。`lastUse` を書く。
- `hand_to_user` の指示を変える。ログインの画面で、そのサイトのログイン情報が登録済みなら `fill_secret` を使う。無ければ今のとおり `hand_to_user`。CAPTCHA・2 段階認証・支払いは今のとおり人に渡す。
- PC のアプリ（`ply_computer`）への入力は、この ADR では足さない（入力先を確かめる手がかりが窓の名前だけになる）。

### AI への見せ方と権限

- システムプロンプトと `secrets.list`（read）には、名前・種類・環境変数の名前・サイト・メモ・ユーザー名を出す。**値は出さない**（変数の値だけは出す）。
- 権限（ADR 0082 の表）。

  | 操作 | 危険度 |
  |---|---|
  | 一覧（`secrets.list`） | read |
  | 変数を足す・変える | write |
  | 使い道を狭める（環境変数をやめる・場所を絞る・サイトを外す） | write |
  | 使い道を広げる（環境変数にする・場所を広げる・サイトを足す） | guarded |
  | 削除 | guarded |
  | サイトで入力する（`fill_secret`） | write |
  | 人に値を頼む（`secrets.request`） | write |
  | AI が作った値で新しい項目を足す・`by: 'ai'` の項目の値を差し替える（`secrets.create`） | guarded |
  | 秘密の値・パスワード・API キーを人の項目に入れる・差し替える | human-only（「秘密の値」の組。組の数は 5 のまま） |

- **人に値を頼む**: `secrets.request({ name, kind, reason, scope })` で、会話に入力のカード（承認カードと同じ並び。ターンを越えて残る）を出す。人が値を入れて保存すると、AI には保存した名前だけが返る。値はカードから保存先へ直に入り、会話の記録・イベント・AI の返りを通らない。
- **AI が自分で作った値**（AI がサービスにアカウントを作ったときのパスワードなど）は、AI が新しい項目として足せる（`secrets.create`。guarded = 承認を通す。`by: 'ai'` を付ける）。AI が差し替えられるのは `by: 'ai'` の項目の値だけで、人が入れた項目（`by: 'human'`）の値は差し替えられない。AI の削除は guarded。

### 値を外に出さない

- 値は、画面・操作の返り・WS のイベント・Pleiad のログ・エラー文・リモートの端末に出さない（ADR 0155 と同じ。単体テストが全部の出口に目印の値を入れて見る）。
- 会話の記録（`pleiad.db`）に入れる前と画面に出す前に、登録した秘密の値（8 文字以上）と完全に一致する部分を `***` に置き換える。変数は伏せない（Cursor の書き戻しの事故を避ける）。
- 防げないもの: エージェントがシェルで値を表示すれば、値はモデルの提供元と各 CLI の記録（`~/.claude/projects`・`~/.codex/sessions`）に入る。システムプロンプトで「値を表示しない」と伝える。

### 画面

- 設定のメニューの「API キー」を「秘密情報と変数」に替える（ADR 0155 のページの名前を置き換える）。
- 秘密情報のカード: 名前・「種類 · 状態」の弱い字・使い道（「環境変数 `NAME` · 場所」「サイト `host`」「Pleiad 通話 · 委譲の判定器」「最後の入力 時刻 · 会話」）・［編集］［確かめる］［削除］。ADR 0155 の［差し替える］は［編集］の中へ移す（値・名前・使い道・メモを 1 か所で変える）。使われていない項目は「どこにも使われていない項目」の下。
- 変数: 名前と値の 1 行と渡す場所。［.env を取り込む］（名前が KEY・SECRET・TOKEN・PASSWORD・CREDENTIAL を含む行は最初から秘密に付ける。登録済みの秘密は変数へ戻さない）。
- 追加: 種類の 4 択 → 種類ごとの欄 → 「使い道」の箱 → メモ（「何に使うか（AI にも見えます）」）。
- 細部は承認の後に docs/design-system.md に書く。

## 理由

- 人の代わりにログインする・環境を作るには、AI が秘密を「使える」必要がある。ただし AI が値を「知る」必要は無い。環境変数はシェルが展開し、サイトの入力は Pleiad が入れる。値をモデルに通さない道を先に作れば、値がモデルと記録に残る経路を減らせる。
- 登録と使い道を分けるのは ADR 0155 の同意の分け方と同じ。置いただけで AI に渡り始めない。
- サイトで入力する値を origin で縛るのは、ページに仕込まれた指示（プロンプトインジェクション）で別のサイトへ入力させられるのを防ぐため。パスワード管理ソフトがドメインで縛るのと同じ。
- `ANTHROPIC_*` を断らないのは、断る理由が「Claude Code 自身の認証を替えてしまう」ことだけで、それは CLI 本体の env に入れない渡し方（`CLAUDE_ENV_FILE`）で解けるから。利用者のアプリは Anthropic の API を使うことがある。
- API キーの台帳を変えずに新しい台帳を足すのは、古い版が知らない項目を書き戻しで落とすため（ADR 0155 の「古い置き場を消さない」と同じ事情）。
- 値を入れるのを人だけにするのは ADR 0094 の「秘密の値」と同じ（入力した人と契約の主体を AI が替えない）。AI が値を要るときは、カードで人に頼めば止まらずに済む。

## 影響

- 新しいファイル `secrets.json`・`secret-values.json`（`tests/data-writes-allowlist.mjs`）。DB の形は変えない。
- 新しい操作 `secrets.list`・`secrets.setVariable`・`secrets.setUses`・`secrets.delete`・`secrets.request`、`ply_browser` の `fill_secret`。値を入れる WS のコマンド（`setSecretValue`）を `HUMAN_ONLY` の「秘密の値」に足す（`tests/lint-ops.mjs`）。
- 読む側: `core/server.mjs`（ターンの env を組む所）、`core/backends/claude.mjs`（`CLAUDE_ENV_FILE`）、`core/backends/codex.mjs`（`shell_environment_policy.set`）、`core/backends/antigravity.mjs`、`core/shell-held.mjs`・`!` の行、`core/browser-bridge.mjs`。
- 文書: docs/design.md に「秘密情報と変数」の節。docs/design-system.md の「設定 › API キー」を置き換える。docs/inapp-browser.md の `hand_to_user` の規則。ADR 0155・0094 の状態の行に、この ADR が変えた範囲を書く。AGENTS.md の環境変数の表は変えない（利用者が登録するものは Pleiad の起動の変数ではない）。
- 辞書: `ui:secrets.*`・`server:secrets.*`・`agent:ops.secrets.*`。`ui:apiKeys.*` はページの中で使い続け、使わなくなった文言は消す。

## 段階

| 段階 | 中身 |
|---|---|
| 1 | 置き場・操作・ページ（「すべてのフォルダー」だけ）・3 つのエージェントと `!` の行への環境変数・使えない名前・記録の前に伏せること・システムプロンプトの一覧 |
| 2 | フォルダーごとの場所・`.env` の取り込み・入力のカード（`secrets.request`）・ログイン情報と `fill_secret`・`hand_to_user` の指示の変更 |
| 3（要れば） | MCP の `${VAR}` の展開元・PC のアプリへの入力・`op://` のような外部の参照・2 段階認証のコード（TOTP） |

## 確かめること（段階 1 の初め）

- `CLAUDE_ENV_FILE`: Windows の Bash ツール（Git Bash）で読まれるか。PowerShell ツールに届く条件（v2.1.296 以降）。利用者が自分で `CLAUDE_ENV_FILE` を付けている・SessionStart の hook がそこへ書くときに、Pleiad のファイルと両立できるか（できなければ、利用者のファイルを読み込む 1 行を Pleiad のファイルの頭に足す）。
- Codex: `shell_environment_policy.set` の値が、名前に KEY・SECRET・TOKEN を含んでもシェルに届くか（既定の除外より後に入るはず）。スレッドを resume するときに値を替えられるか。値が rollout と `~/.codex/logs_2.sqlite` に残らないか（2026-10-17 の手元の記録では、今渡している `PLEIAD_CONTROL_TOKEN` は残っていなかった）。
- agy: 認証に読む環境変数の名前。

## 追記（2026-10-17）: 実装で確かめたこと・決めたこと

- **確かめたこと**: Claude Code 2.1.299（Windows・Git Bash）で、`CLAUDE_ENV_FILE` に書いた値が Bash ツールのコマンドに届き、同じファイルに書いた `ANTHROPIC_API_KEY`（偽物）は CLI 本体の認証に使われなかった。codex-cli 0.160.0 で、`shell_environment_policy.set` に入れた名前に KEY を含む変数がシェルに届いた（Windows の Codex は PowerShell なので `$env:NAME`。エージェントへの一覧の文は「bash は $NAME、PowerShell は $env:NAME」と書く）。Codex の rollout と `logs_2.sqlite` に、今渡している `PLEIAD_CONTROL_TOKEN` は残っていなかった。
- **伏せる場所**: 本文の「会話の記録（pleiad.db）に入れる前」は採らず、**画面・リモートへ出す前**に伏せる。WS の送信と返事（履歴の読み直しを含む）・届け直しの置き場に加え、流れの切れ端（`text.delta`・`thinking.delta`・`shell.output`）は会話ごとに値の書き出しに当たる末尾だけを持ち越してつなぎ、`emitGlobal` の入口で伏せる（1 通ずつ伏せるだけでは、切れ端にまたがる値が漏れた）。手元の記録（pleiad.db の `!` の行の出力など）は伏せない。値はエージェントの CLI の記録（`~/.claude/projects` など）にも同じく残り、記録を伏せても守りにならないため。
- **入力のカードの届け方**: `secrets.request` は待たずに返り、結果は設定の変更の承認と同じ台帳（`setting-approvals.json`）と届け方で会話へ届ける（ply_control の呼び出しは Codex で 60 秒で切れるので、カードを待って返さない）。
- **ターンを止めない**: 値の復号は main に頼むため、main が居ない間は待たされる。ターンの始めに読む上限を 10 秒にし、過ぎたら渡さずに始める。秘密情報の無い会話（API キーに使い道を選んでいない）は、API キーの置き場にも暗号化にも触れない。
- **サイトで入力する**: `agent-browser fill` に値を渡すとプロセスの引数に載るので使わず、中継自身のセッションで今のタブに付けて `Input.insertText` で入れる。入力先は、エージェントが先に `agent-browser click` で選んだ欄（または `selector`）。

## 追記（2026-11-16）: 走っているターンのシェルにも反映する

画面の返答が終わっていても、Claude の Bash の裏実行などを待つターンは Pleiad では走り続ける。その間に `secrets.request` の答えが途中送信で届くと、開始時の env には値がなく、AI が人に次の発言を求めて止まった。このため「効き始め」を次のように変える。

- 秘密情報・変数・API キーの値、環境変数の名前・使い道・場所が変わる操作（入力のカードへの答え、`.env` の取り込み、削除を含む）は、各ターンの cwd の scope で env を引き直す。`ply_shell` はコマンドを始めるたびに引く。既に起動したコマンドのプロセスの env は変わらず、次のコマンドから効く。
- エージェントの途中反映は性質の印 `liveSecrets` で表す。サーバーは既存の `control` の `updateSecrets` を呼び、組み直した env 全体を置き換える。`readSecretsEnv` で初期化・付け直し中の変更も取り込む。削除・名前の変更・場所の縮小でも古い名前を残さない。値を読めない場合は空の env として扱う。
- **Claude**: ADR 0284 の同じ `.vals` を 0600 の一時ファイルから置き換える。空になっても export のないファイルを残し、`.sh` はターンの終わりまで残す。保持役から付け直したターンも札が指す同じ組を書き換える。値を CLI 本体の env や argv に移さない。PowerShell ツールへの制約は ADR 0284 のまま。
- **OpenCode**: `PUT /api/session/{id}/environment` を再送し、準備済みの子のセッションにも再送する。その後に作る子も最新の env を使う。既存の中継の env と、保持役からの付け直しに使う 0600 の `opencode-env-*.json` も同じ値にする。
- **Codex・Antigravity・Devin・Grok**: 途中反映は未対応として扱う。Codex 0.160.0 の実物の `app-server generate-json-schema` で、`turn/steer` に config/env の指定がなく、既存の `shell_environment_policy.set` は thread の開始・再開の指定であることを確認した。Antigravity・Devin・Grok の既存の注入先はプロセス起動時の env で、Pleiad が使う通信の口に実行中の env を置き換える手段を確認できなかった。Grok の [hooks の仕様](https://docs.x.ai/build/features/hooks) も許可・拒否などの応答で、実行中のシェルの env を置き換える指定はない。これらは実機の途中変更の試験を通したという意味ではなく、コード・通信の仕様からの判断。新たな hooks/MCP の注入経路は作らない。
- `secrets.request` の保存通知は、新しいターンで届く場合と途中反映に成功した場合に「今から使えます」と伝える。途中反映できないターンには、エージェントのシェルにはまだ入っていないことと、会話で `ply_shell` を提供していればそのターンでも使えることを伝える。開始時の名前一覧は変えられないため、名前はこの通知で伝える。
- 途中反映できないターンに保存通知が渡った場合は、設定変更の承認結果を届ける既存の台帳に「次のターンで続ける」を残す。今のターンが終わった後に内部の新しいターンを一度始め、続きを頼む。再起動時も同じ台帳から届ける。ログイン情報だけを頼み、環境変数を頼んでいないカードではこの継続は不要。

**Claude の実機確認（Windows・Claude Code 2.1.322、2026-11-16）**: 1 本の CLI を `-p --input-format stream-json --output-format stream-json --tools Bash --model haiku --no-session-persistence` で起動し、1 回の入力から Bash のコマンドを 4 回順に実行させた。`CLAUDE_ENV_FILE` は既存の `.sh`、読み先は同じ `.vals` に固定した。各コマンドの検査用プログラムを合図待ちにし、その間に親のプログラムが `.vals` を「未設定 → 検査用の値を追加 → 別の検査用の値へ差し替え → export なし」へ置き換えてから次へ進めた。4 回とも期待する有無・値との一致を確認し、CLI は終了コード 0 で終わった。出力は段階番号と一致したかの真偽だけで、実際の秘密は使っていない。値は CLI の引数に入れていない。この確認は、同じターンの次の Bash が書き換えた `.vals` を読むことと、export を外すと次の Bash で消えることを確かめたもの。

OpenCode の判断は v2 の [セッション環境変数の実装](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/environment.ts) と既存の environment API に基づく。[シェルの実装](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/shell.ts) でも、コマンドを作る `Shell.create` ごとに `SessionEnvironment` を引き、プロセスへ渡す env 全体を作ることを確認した。Pleiad 側は偽のサーバーを通した試験で再送を確認する。実物の OpenCode にモデルのターンを流して途中反映を確認したものではない。
