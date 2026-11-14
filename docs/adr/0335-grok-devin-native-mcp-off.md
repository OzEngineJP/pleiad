# 0335 Devin 自身の MCP を名前で止める（設定の置き場の写し）。Grok は鍵のまま

- 状態: 提案（2026-11-15。同日のレビューを受けて書き直した）
- 関係: [ADR 0327](0327-external-mcp-by-name-and-agent.md)（外部 MCP を名前 × エージェントの一覧にする）の「Devin・Grok は鍵」のうち、Devin のユーザーの設定の定義だけを変える。Grok・Antigravity は変えない。

## 状況

ADR 0327 の一覧で、Grok・Devin 自身の設定にある MCP は鍵だった（能力の印 `nativeMcpOff: impossible`）。どちらの CLI にも、会話ごとに MCP を名前で止める引数が無い。止め方は「起動のときに Pleiad が止める」だけで、利用者の設定ファイルは書き換えない（ADR 0327）。

- Devin: 起動の `--config` は `config.json` の置き換えで、MCP は `mcp_config.json` から読む。`DEVIN_CONFIG_HOME/devin/mcp_config.json` の `disabled: true` は、ユーザーの設定の定義と、Claude の `~/.claude.json` からの取り込み（同じ名前なら mcp_config.json が勝つ）を止める（どちらも実機で確認）。作業場所の `.devin/mcp_config.json`・`.mcp.json` の定義は止まらない（作業場所の定義が勝つ。実機で確認、Devin 3000.11.92、2026-11-15）。
  - OpenCode・Zed の設定からの取り込みに `disabled: true` が効くかは確かめていない（実機のログでは、止めないときもその名前のサーバーが起動していなかったので、止まった裏付けにならない）。確かめたのは、Devin 自身の設定の定義と `~/.claude.json` からの取り込みが止まることまで。
- Grok: 起動の引数・ACP の `session/new` に止める口が無い。設定の置き場（GROK_HOME）の写しで止める形を作ったが、レビューで認証情報が失われることがわかった（下の「Grok を鍵に戻した理由」）。

最初の版（commit `940658c0`・`654edcaa`）は Grok・Devin の両方を写しで止めた。同じ日のレビュー（A〜M）で、次のことがわかった。

- 写しの中でエージェントが rename で書いたファイル（Grok の `auth.json` の token の更新など）を、次のターンの前に消していた（A）
- 何も新しく止めていない人も写しで起動していた（Pleiad にだけある名前の off・名前が重なるだけで、止める名前に入った）（B）
- シンボリックリンクを作れない PC では、ターンが英語のエラーで止まった（C）
- 一覧の「作業場所の定義」の鍵を、設定画面の場所で決めていた（会話の場所と違う）（E）

## 決定

### Devin: 利用者が Devin 自身の名前を止めたときだけ、設定の置き場の写しで起動する

- **止める名前**（`contextRuntime.mcp.suppress`）に入れるのは、Devin のユーザーの設定にある名前（Claude の `~/.claude.json` のユーザーの定義からの取り込みも含む）のうち、利用者が Devin の列で off にして保存した名前だけ（`core/context-runtime.mjs` の `agentMcpRules`・`resolveRuntime`）。
  - Pleiad にだけある名前の off は、止める名前に入れない（Pleiad の側を渡さないだけ。今までと同じ起動）。
  - 右パネルの「この会話では外す」（`removedMcp`）も、止める名前に入れない。外した名前は Pleiad の側を渡さないだけで、Devin 自身の側は使い続ける（行は `excluded`「自分の側を使う」）。会話ごとの一時の操作で、写しの組を増やして起動を替えないため。Devin 自身の側を止めたいときは、一覧の Devin の列で off にして保存する（第 2 のレビューの N2）。
  - 名前が Pleiad の登録と Devin の設定で重なるだけなら、今までと同じ（自分の側を使い、Pleiad の側は渡さない。止める名前は空。写しで起動しない）。
  - 重なる名前を Devin の列で off にしたら、自分の側を止め、Pleiad の側も渡さない。
  - 作業場所の定義もある名前は止めない（作業場所の定義が勝つので、ユーザーの定義だけ止めても使われ続ける）。右パネルの行に鍵の理由（`nativeLock: 'workspace'`）を付ける。
  - Claude・Codex・OpenCode（どの定義も止められる）の規則は変えない。
- **止める名前があるターンだけ写しで起動する**（`core/backends/mcp-off-home.mjs`、`core/backends/devin-config.mjs` の `prepareDevinLaunch`）。DEVIN_CONFIG_HOME を `<データ置き場>/devin/mcp-off/<組>/` に替える。止める名前が無いターンは今までと同じ起動（環境変数も引数も変えない）。
  - 写しは本物の置き場（`%APPDATA%\devin` など）のディレクトリをジャンクション（Windows）／シンボリックリンク、ファイルをシンボリックリンクでつなぐ。ファイルの中を書き換える書き込み・ディレクトリの中（`cli/` の会話の記録・ログ・`sessions.db`）への書き込みは、リンクを通って本物に届く。
  - Pleiad が写しに書くのは `mcp_config.json`（止める名前に `disabled: true`。本物に無い名前（Claude からの取り込み）は `{ "disabled": true }` を足す）だけ。Devin の `config.json` に `mcpServers` が残っている（Devin が `mcp_config.json` へ移す前の形）ときは、写しの `config.json` から外して写しの `mcp_config.json` に移す（リンクのままだと、Devin の移し替えが本物の `config.json` を書き換える）。
  - SQLite の DB（`*.db` と `-wal`・`-shm`・`-journal`）はリンクしない（本物と写しから同時に開くと壊れうる）。
  - 写しは「本物の置き場 × 止める名前の組」ごとに 1 つで、同じ組の会話は共有する。使うたびに印（mtime）を付け、12 個を超えて 24 時間以上使っていないものだけを古い順に消す（OpenCode の写しと同じ規則）。
- **写しの中で置き換わったファイルは本物へ運ぶ（settle）**。Devin は設定を一時ファイルからの rename で書く（バイナリの文字列 `Failed to create temp file for atomic write…rename`）。写しの中でそうすると、本物へのリンクが普通のファイルに置き換わり、書いた中身は写しにだけ残る。これを消さず、次のように扱う（`settleMcpOffHome`）。
  - 本物と同じ名前のファイル: 中身が同じならリンクに戻す。写しのほうが新しい（mtime）なら、本物の今の中身を kept に `replaced-<名前>` で残してから、写しの中身で本物を置き換え（一時ファイルからの rename）、本物の mtime を写しのファイルの mtime にそろえて、リンクに戻す。本物のほうが新しい（写しの外で本物が更新された）なら、本物を正とし、写しの中身は `<データ置き場>/devin/mcp-off-kept/` に移して残し、リンクに戻す。
    - mtime をそろえるのは、写しが 2 つ以上あるとき、運ぶ順で結果が変わらないようにするため（先に運んだ写しの中身が「今書いた本物」として新しく見え、後の写しのより新しい中身が kept に回るのを防ぐ。第 2 のレビューの N5）。
    - `replaced-` は、写しの中身が古い token などで本物を上書きしても、上書きの前の中身を手で戻せるようにするため（N12）。
  - 本物に無い名前のファイル（写しの中で新しく作られた）: **運ぶ一覧**にある名前だけ本物へ写し（本物に同じ名前ができていたら写さない）、リンクに替える。一覧に無い名前は kept に移す（N6）。一覧は Devin では `config.json`・`credentials.toml`・`mcp_config.json`（`core/backends/devin-config.mjs` の `DEVIN_CARRY`。Devin の設定の置き場の最上位に Devin が書くファイル）で、写しの記録（`devin.pleiad.json` の `carry`）に残す。一覧で絞るのは、写しの中の知らないファイル（一時ファイル・別の道具が置いたもの）を利用者の設定の置き場に書かないため。SQLite の DB・`*.lock` は一覧にあっても運ばない。
  - Pleiad が書く `mcp_config.json` を Devin が書き換えた（`devin mcp add` など）: 本物へは運ばない（止める名前の `disabled` と、本物の JSONC のコメントの消えた形を本物へ書かないため）。中身は kept に残し、写しは書き直す。
    - 写しの記録が無い（壊れた・前の版の写し）ときは、本物の中身と違えば Devin が書き換えたものとして kept に残す（N8）。
    - 前に Pleiad が書いたが、今は書かなくなった名前（本物の側で消えた・`mcpServers` の移し替えが要らなくなった）は、記録の指紋と同じならリンクに戻し、違えば kept に移す。前に書いた中身を本物へ運ばない（N7）。
  - 写しを消すとき（片付け）に運べなかったファイルは kept に移す。kept に移せないファイルが残ったら、写しを消さずに次の機会に回す（N3）。
  - 書きかけを運ばないよう、最後の更新から 5 秒たっていないファイルは次の機会に回す。運ぶ間に Devin がまた書いたら、リンクに戻さない。
  - 運ぶ機会: 写しをそろえるとき（その組のターンの起動）・Devin のターンを起こすとき（止める名前の無いターンも。同じ本物の置き場の写しすべて）・古い写しを消す前。
  - Pleiad が利用者の設定の置き場に書くのはここだけで、書く中身は Devin が写しの中で書いたもの（写しを使わないターンなら Devin が本物に書く中身）。
  - kept は 50 個まで、かつ 30 日まで（どちらかを超えたものから消す。Devin のターンを起こすたびに片付ける）。名前は `<日時>-<乱数>-<組>-[replaced-]<名前>`。
  - **kept には秘密が入りうる**（`credentials.toml`・token・MCP の環境変数）。ファイルは利用者だけが読める権限（0600）で作り、データ置き場の写し（`scripts/copy-data-dir.mjs`）では kept を写さない。
  - 写しの隣の `<組>/devin.pleiad.json` に、本物の置き場・kept・Pleiad が書いたファイルの指紋・運ぶ一覧を記録し、運ぶときに読む。
- **シンボリックリンクを作れない PC では、最初から鍵**（`canLinkMcpOffHome`）。Windows の既定（開発者モードが off）では作れない。データ置き場の中でファイルのリンクとディレクトリのジャンクションを作って確かめる。
  - 作れると分かったら、プロセスの間は覚えて確かめ直さない。作れないと分かったときは覚えず、一覧を出すたびに確かめ直す（2 秒（`MCP_OFF_NOLINK_RECHECK_MS`）以内の確かめ直しは前の結果を使う）。開発者モードを on にしたら、Pleiad を起動し直さなくても次に一覧を出すときから押せる。
  - 作れないなら、能力の印 `'user'` を「止める手が無い」として読む（`nativeMcpOffMode` が `null`）。一覧の Devin の列の自分の名前は鍵（`reason: 'nolinks'`）で、保存しない（`setMcpAgent` が断る）。右パネルの行にも `nativeLock: 'nolinks'` を付ける。
  - 実行時も写しを使わず、今までと同じ起動にする。前に保存した off があってもターンは止めない。
  - 写しを作る途中でリンクに失敗した（権限が変わった）ときもターンは止めず、今までと同じ起動にする。止められなかった名前の右パネルの行は「自分の側を使う」（`excluded`）に戻し、`nativeLock: 'nolinks'` を付けて保存する（`core/context-bridge.mjs` の `markUnstopped`。第 2 のレビューの N10）。
- **一覧の鍵（`reason: 'workspace'`）は、場所ごとの設定の一覧でだけ付ける**（`core/context-mcp-matrix.mjs` の `buildMcpMatrix` の `workspace`、`core/ops/context.mjs` の `matrixInput`）。
  - 全体の設定の一覧は、一覧を出した場所の作業場所の定義で鍵にしない（設定画面の場所に関わらず同じ）。Devin のユーザーの設定にある名前は押せ、off は作業場所に同じ名前の定義が無い会話で効く。
  - 場所ごとの設定（`place`）の一覧は、その場所の作業場所の定義がある名前を鍵にする。
  - 実行時は会話の cwd で決める。作業場所の定義があって止まらなかった名前は、右パネルの行に `nativeLock: 'workspace'` を付ける（右パネルはその行に一覧と同じ鍵と理由を出す）。

### Grok: 鍵のまま（`nativeMcpOff: impossible`）

写しで止める作り（commit `654edcaa` に残す）は消し、Grok 自身の MCP は ADR 0327 のとおり鍵にする。使わないコードは周りの変更に追いつかず腐るので残さない。確かめたことは下に残す。

### 能力の印と鍵の理由

- 能力の印 `nativeMcpOff` に `'user'` を足す。`true` はユーザーの設定・作業場所の設定のどちらの定義も止められる、`'user'` はユーザーの設定の定義だけ止められる（写しの置き場を使うので、リンクを作れる PC だけ）。Devin は `'user'`。Grok・Antigravity は `impossible`。
- 一覧の鍵に理由を付ける（`reason`）。`'own'` は止める手が無い（印が無い・Codex の点つきの名前）、`'nolinks'` は `'user'` のエージェントで、リンクを作れない（Windows の開発者モードが off）、`'workspace'` は `'user'` のエージェントで、場所ごとの設定の場所の作業場所にも定義がある名前、`'relay'` は中継を受け取れない担当の組み合わせ（`mode: 'blocked'`）。`'admin'`（管理者の設定）は今は使わない。
- 反映は次のターンから。Devin はターンごとに CLI を起こすので、次のターンの起動で写しを使う／使わなくなる。保持役（無停止の更新）に載るターンも、そのターンの起動の環境変数で子を起こす。

## Grok を鍵に戻した理由と、確かめたこと

Grok 1.0.62（2026-11-15）で確かめた。本物の Grok にはこれ以上ターンを送らない。

- **止める口は効く**: GROK_HOME の `config.toml` の最上位の `disabled_mcp_servers`（名前の配列）は、利用者の `config.toml`・Claude の設定からの取り込み・作業場所の `.grok/config.toml`・`.mcp.json` のどの定義にも効いた（実機）。
- **`managed_config.toml`・`requirements.toml` の `[[denied_mcp_servers]]` は使えない**: 起動のときは効くが、ログインした会話では Grok が起動の直後に管理の設定をサーバーと同期し、写しに書いたファイルを消した（実機）。
- **認証情報が失われる（鍵に戻した理由）**: Grok は `auth.json` を一時ファイルからの rename で書く（バイナリの文字列 `auth: failed to ensure owner-only permissions after rename`）。写しの中で token を更新すると、リンクが普通のファイルに置き換わり、ローテーションされた新しい refresh token は写しにだけ残る。本物の `~/.grok/auth.json` には無効になった古い token が残り、ターミナルの Grok・止める名前の無いターン・使用量の取得・アカウントごとの home がログアウトされうる。`mcp_credentials.json`・`settings_cache.json`・`models_cache.json` も同じ。偽の home で rename による置き換えを再現した（レビューの `q1-links.log`）。本物の Grok で token が失われるところまでは見ていない。
- **`GROK_AUTH_PATH` は確かめていない**: 使い捨ての home の実験で、Grok は GROK_HOME ではなく `GROK_AUTH_PATH` の場所の `auth.json` を読んだ（レビューの `q2-authpath.log`）。書き込み・ロックも同じ場所に向くかは確かめていない。これを使うと、利用者のログインの読み方を Pleiad が変えることになるので、使う前に利用者（依頼元）の同意が要る。`mcp_credentials.json` などには効かない。
- **`config.toml` の形によっては止められない（D）**: 写しの `config.toml` は本物の中身の先頭に `disabled_mcp_servers = [...]` を足す作りだった。
  - BOM 付きの UTF-8 の `config.toml` は、BOM がファイルの途中に移り、`parseToml` が読めない（`illegal character in key`）。止める名前のあるターンが「1 行の配列で書いて」という原因と合わないエラーで止まる。
  - 本物の `disabled_mcp_servers` が複数行の配列・文字列の中にキーの文字が入っている形は、書き換えられずに止まる（安全側だが、画面に鍵が出ない）。
  - CRLF のファイルは通るが、足した行だけが LF になる。
- **写しの中にだけ残る・消える書き込み**: 写しの中で作られたディレクトリ（memories など）は写しに残り、本物の中身を隠す。写しにだけある `trusted_folders.toml` は、本物の側に同じ名前ができた時点で消える。`/config` などで写しの `config.toml` に書いた変更は、次のターンで作り直されて失われる。

### Grok の鍵を外す前に確かめること

1. **何を**: 写しの中の `auth.json`・`mcp_credentials.json` の更新が本物に届くこと。Devin と同じ settle（写しのほうが新しければ本物へ運ぶ）で足りるか、`GROK_AUTH_PATH` を使うか（使うなら同意を取る）。BOM・CRLF・複数行の `disabled_mcp_servers` の `config.toml`。写しにだけ残るディレクトリ・`trusted_folders.toml` の扱い。ログインした会話で、管理の設定の同期が写しの `config.toml` を書き換えないこと。
2. **どう**: 使い捨ての `GROK_HOME`（偽の auth）で、access token の期限を短くして更新を起こし、ターンの後に本物（使い捨ての home）の `auth.json` が新しい token になっていることを見る。本物の `~/.grok` では試さない。commit `654edcaa` のコードと `tests/unit/mcp-off-home.mjs` の Grok の部分を戻し、settle の試験を Grok の名前で足す。
3. **戻し方**: 能力の印 `CAPABILITY_STATES.grok.nativeMcpOff` を `impossible` に戻せば、一覧は鍵になり、実行時は写しを使わない（保存した off は Pleiad の側を渡さないだけになる）。写しの置き場（`<データ置き場>/grok-mcp-off/`）は、中のリンク（ジャンクション）を 1 つずつ外してから消す。外さずにエクスプローラーなどで消すと、本物の `~/.grok` の中身まで消えるおそれがある。

## 影響

- **写しの中にだけ残るもの**（Devin）: 写しの中で新しく作られたディレクトリは運ばない（写しに残り、写しと一緒に消える）。Devin の設定の置き場の最上位は `config.json`・`credentials.toml`・`mcp_config.json`・`cli/` で、`cli/` はジャンクションなので中の書き込みは本物に届く。最上位に新しいディレクトリを作る Devin の機能は見つけていない。写しの中で作られた SQLite の DB も写しごとに別になる。
- **kept に移るもの**（Devin）: 写しを使うターンの間に `devin mcp add` などで `mcp_config.json` を変えた分と、写しの外で本物が先に更新されたファイルの写し側の中身。利用者には、その変更が本物に入っていないように見える（Devin を写しで起動しないターンで、もう一度やり直す）。kept の中身は手で戻せる。
- **本物に無いファイルを運ぶ**: 写しの中で作られたファイルを本物へ写すので、写しを使う間に本物から消したファイルが、写しに普通のファイルとして残っていれば本物へ戻ることがある（写しの中のリンクは本物から消えれば外すので、置き換わったファイルだけ）。
- **同時に動く会話**（J）: 同じ組の会話は同じ写しを共有する。片方の Devin が動いている間に、もう片方のそろえが置き換わったファイルを運ぶと、リンクに戻すまでの間（rename 1 回）だけ Devin から見えるファイルが替わる。最後の更新から 5 秒たっていないファイルは運ばないので、書いている最中のファイルには触らない。Pleiad が書く `mcp_config.json` は、本物の中身が変わったときだけ書き直す。Devin がそのファイルを開いている間に書き直すと Windows では失敗しうる（そのターンは `MCP_OFF` のエラーにならず、写しの作り直しの失敗としてターンが始まらない）。
- **24 時間の片付け**（J）: 写しの印を付けるのはターンの起動のときだけ。1 つのターンが 24 時間を超えて続き、その間にほかの組の写しが 12 個以上使われると、使用中の写しが片付けの対象になりうる。片付ける前に置き換わったファイルは本物へ運ぶ。起きる見込みは小さいので、使用中の印（ロック）は付けない。
- **空の `{ "disabled": true }` の定義**（K）: Claude の `~/.claude.json` から取り込んだ名前を止めるとき、写しの `mcp_config.json` に `command` の無い `{ "disabled": true }` の項目を足す。Pleiad にだけある名前では足さない（B）。Devin（2026-11 の版）はこの形を受け付け、取り込みの定義を止めることを実機で確かめた（`devin mcp list` で `(disabled)` と出て、ACP の `session/new` は通り、そのサーバーは起動しなかった）。
- **リンクを作れない PC**: Devin の自分の名前は鍵（理由 `nolinks`）になる。開発者モードを後から on にしたら、次に一覧を出すときから押せる。
- **作業場所の定義で止まらない名前（N11）**: 全体の設定の一覧で Devin の列を off にしても、作業場所の `.devin/mcp_config.json`・`.mcp.json` に同じ名前がある会話では止まらない（一覧のセルは off のまま）。その会話の右パネルの行に鍵（`workspace`）と理由を出して知らせる。全体の一覧には書かない（場所によって違うので、一覧のセルでは決められない）。
- **データ置き場の写し**: `scripts/copy-data-dir.mjs` はリンクを飛ばし、kept（`devin/mcp-off-kept`）も写さない。写しの中の普通のファイル（Pleiad が書く `mcp_config.json`、まだ運んでいない置き換わったファイル）は写す。`mcp_config.json` には MCP の秘密（環境変数など）が入りうる。
- ターンの外の起動（Devin のモデル一覧）は写しを使わない。MCP はターンでしかつながらない前提。
- 画面（`web/`）: 一覧の Devin の列の自分の名前は押せる。鍵のセルと右パネルの行の鍵は、理由（`reason`・`nativeLock`）ごとの説明をツールチップと名前に出す（ADR 0331 の鍵の説明）。
- **止められなかった名前しか無いターン**: 指示・Skills がエージェント任せで、中継する MCP も止める名前も無いターンは、エージェント任せの道にする（ADR 0327）。止められなかった名前（`nativeLock`）しか off に無いターンもここに入るので、エージェント任せの記録に `unstopped: [{ name, nativeLock }]` を残す（`core/context-runtime.mjs` の `unstoppedMcp`。中継の口は開かない）。右パネルのエージェント任せの一覧は、その名前の行に同じ鍵を付ける。
