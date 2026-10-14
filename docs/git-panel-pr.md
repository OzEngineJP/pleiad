# git パネルの PR（頭の PR の行）

右パネル「git」の頭に、**この会話の PR と、委譲した子の会話の PR** を 1 つの一覧で出す（承認済み（2026-10-14）、[ADR 0206](adr/0206-git-panel-prs-of-conversation-and-children.md)）。画面は `docs/design-system.md`「git の動き」の右パネル「頭」。PR は git パネルの頭にだけ出し、会話の頭の行・委譲カード・脇の一覧には出さない（[ADR 0085](adr/0085-host-reads-git-and-turn-snapshots.md)）。

## PR の決め方

PR は「会話が `gh pr create` で作った PR」だけ。現在のブランチの PR を `gh` で探しはしない（推測で作らない）。

1. **コマンドから拾う**（`core/git-timeline.mjs` の `eventsFromCall`）。呼び出しの結果が成功で、コマンドに `gh pr create` があり、結果の末尾の URL（`…/pull/<番号>`）を呼んだ数だけ取る。`gh` は作った PR の URL を最後の行に出すので、途中に出る別の PR の URL は拾わない。見る形は次のとおり。
   - 連結: `&&`・`||`・`;`・`|`・改行で節に分ける。
   - 前置き: `FOO=bar`・`$x =`・`env`・`command`・`exec`・`time`・`X=$(…)`・`(`。
   - `gh -R <owner/repo> pr create` / `gh --repo …`。
   - シェルを 1 段かませた形: `powershell` / `pwsh -Command`、`bash` / `sh` / `zsh -lc`、`cmd /c`（スクリプトは 1 語でも、空白でつないで語が割れた形でも）。Codex の `commandExecution`、Antigravity の `run_command` の入力（`command` / `CommandLine`）も同じ関数に通す。
   - 失敗した呼び出し・結果の無い呼び出し・Codex の `exit=N`（0 以外）は拾わない。
2. **結果を切っても URL を残す**（`core/backends/shared.mjs` の `cutText`）。履歴に残す時点で結果を 2000 文字に切るが、切り捨てる側に PR の URL があれば、notice の後ろへ 1 行で残す。
3. **会話ごとに覚える**（`core/session-prs.mjs`）。ターンが流れる間（`makeEmit`）と終わるとき（`closeTurn`）に拾った PR を、会話のデータ `prs`（`{ number, url, at }` の列。上限 30、古いものから捨てる）へ足す。同じ PR（host・repo・番号）は 1 件のまま。履歴から拾い直す分は自分の会話の分だけで、**子の昔の PR は戻さない**（子の PR が親に出るのは、この仕組みが入った後に作ったものだけ）。
4. **親子の結びつきは委譲の記録から**。親の会話の一覧 = 自分の覚え書き + 履歴から拾った分 + 委譲した子孫（`agentTasks.descendants`）の覚え書き。子の分には `child: true` を付ける。同じ PR が自分と子の両方にあれば自分の分を取る。新しい順。

## 状態を読む（`git.prs`）

読み取り専用の操作（`core/ops/git-prs.mjs`、旧 WS コマンド `gitPrs`）。`gh pr view <URL> --json title,state,isDraft,statusCheckRollup` だけを呼ぶ（`core/git-prs.mjs`。書く `gh` は呼ばない）。

- 返す形: `{ number, url, repo, title?, state?, checks?, child? }` と `reason`。`state` は `open`・`draft`（open で `isDraft`）・`merged`・`closed`、`checks` は `pass`・`fail`・`pending`（チェックが 1 つも無ければ無し。1 つでも失敗があれば `fail`、未完了があれば `pending`）。
- 結果は URL ごとに 60 秒覚える。新しい方から 20 件まで、並行 4 本で読む。
- `states: false` は `gh` を呼ばず、番号・URL・repo だけを返す（画面が番号を先に出すため）。
- `gh` が無い（`no-gh`）・ログインしていない（`no-auth`）ときは、`state`・`title`・`checks` を付けず、1 件も状態が取れなかったときだけ `reason` で理由を返す。通信・権限・消えた PR などは `reason` にしない。
- 試験と画面の確認のため、`AGENT_HOST_GH` で `gh` の代わりを指せる（`.mjs` / `.js` なら今の node で動かす）。

## 画面

- 行: 輪郭だけの形（状態ごとに別の形）+ `#番号`（青い字）+ 題（1 行・省略・全文は `title`）+ 状態の語 + チェックの語 + ↗。行全体が別タブで開くリンク。
- **色は使わない**（`--diff-*` も使わない）。状態は形と語で、チェックの失敗だけ太字で強める。マージ済み・クローズは題を弱い字にする。
- 並び: オープン → ドラフト → マージ済み → クローズ。同じ状態の中は新しい順。状態がまだ分からないものは最後。
- 3 件まで出し、残りは「ほか N 件」（押すと全部開く。`aria-expanded`、読み上げの名前に件数）。PR が無ければ何も出さない。
- 読み込み: 番号は覚え書きからすぐ出し、題・状態・チェックは `gh` が返るまで `.history-line` の骨組み。読み直すとき、前に読めていた状態は新しい分が届くまで残す。
- `gh` が無い・ログインしていないときは、番号・repo・リンクだけにして、行の下に弱い字で 1 行（「PR の状態を読むには gh（GitHub CLI）を入れてください」/「PR の状態を読むには gh にログインしてください」）。
- 子の会話の PR: 見える印は足さず、行の `title` と読み上げの名前に「子の会話で作成」を入れる。
- 狭いパネル（幅 380px 以下）は、チェックの語をたたみ（形と読み上げの名前は残す）、状態の語を残す。コンテナクエリ（`.gp-prs`）で決める。

## 触るとき

- 行の組み立ては `web/git-prs.mjs`（`prsHTML` は純関数。試験 `git-prs-view`）。パネルの `web/git-panel.mjs` は、道具の列の先頭にその部品の要素を置き、パネルを読むたびに `load` を呼ぶだけ。
- 文字列は `web/locales/{ja,en}/ui.json` の `git.prs.*`。
- 試験: `git-pr`（拾い方）、`git-prs`（状態の読み取り・偽の `gh`）、`server-prs`（サーバー越し・親子）、`git-prs-view`（行の HTML）。
