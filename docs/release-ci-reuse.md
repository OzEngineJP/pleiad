# リリースでの main の CI の結果の使い方

タグの `Evaluation release`（`.github/workflows/evaluation-release.yml`）は、同じ commit の main の CI（`.github/workflows/test.yml` の push の run）が、必須のジョブを全部通していれば、その結果を使って release の中の `npm test` を省く。
CI が赤ければ公開しない。使える成功が無ければ、今までどおり release の中で `npm test` を全部回す（[ADR 0130](adr/0130-release-reuses-main-ci.md)）。

## 流れ

1. `ci-gate` ジョブ（ubuntu、権限は `actions: read` と `contents: read` だけ）が `scripts/release-ci-gate.mjs` を走らせる。
   タグを commit に解き（注釈つきのタグは指す commit まで剥がす）、GitHub の API を読むだけ（GET）で判定する。トークンは `github.token` で、値はログに出さない。
2. ビルド・署名・公証をする `windows`・`mac` ジョブと、macOS の検査をする `mac-smoke` ジョブは、`ci-gate` を待たずに並んで走る（時間を縮めるため）。`push` のときは、タグの指す commit（`$GITHUB_SHA^{commit}`）を checkout して作る。
3. 判定が `reuse` 以外（`fallback`・空・想定外の値）なら、`release-tests` ジョブ（Windows）が `npm test` を全部回す。`reuse` なら走らない（`skipped`）。
4. `publish` ジョブだけが、公開してよいかの判定を待つ。`ci-gate` が `success`（赤ならここで止まる）、`reuse` か `release-tests` が `success`、`windows`・`mac`・`mac-smoke` が `success`（`mac`・`mac-smoke` は macOS を配らないとき `skipped` でよい）のときだけ走る。
   `publish` は、checkout した commit が `ci-gate` の照合した commit と同じか、`push` ではさらにそれがビルドに使ったタグの commit と同じかを確かめる。
5. 判定が「赤」のとき、先に走っていた `windows`・`mac` は最後まで走る。赤い commit は Apple の公証まで進むことがあるが、`publish` が走らないので公開はされない（下書きも作らない。配布物は artifact に 7 日残るだけ）。

## 判定の規則

対象にする run は次をすべて満たすものだけ。API の絞り込みに加えて、スクリプトでも 1 件ずつ確かめる。

- workflow が `.github/workflows/test.yml`（名前で引いた workflow の id と path が一致し、`active`）
- `head_sha` がタグの指す commit、`event` が `push`、`head_branch` が `main`、リポジトリ（fork でない）が同じ
- jobs は run の**最新の attempt**の番号で読み、各ジョブの `run_id`・`run_attempt`・`head_sha` も一致する

| 状態 | 判定 |
|---|---|
| 最新の attempt で、必須の `test-summary` がちょうど 1 つ `success`、ほかのジョブも `success`（push で飛ばす `safe-storage-macos` だけは `skipped` でよい）、run の結論も `success` | `reuse` |
| run かジョブ（必須でないものも）が `failure`・`timed_out`・`action_required`・`startup_failure` | **赤**。公開しない。走っている途中でも、終わったジョブが赤ければ待たずに止める。同じ commit の run が複数あり、どれかが赤ければ止める |
| run・ジョブが終わっていない | 待つ（下記） |
| run が無い（`site/**` だけの変更・まとめて push した途中の commit など） | `fallback` |
| `cancelled`（PR の古い run が次の push に取り消された、または手動で取り消した）・`skipped`・`neutral` など | `fallback`（main への push の run は後の push で取り消さない。下記） |
| 必須のジョブの欠け・重複・一部だけの成功、必須でないジョブの `cancelled`・`skipped`・`neutral`、run の総合の `success` だけ、jobs を読めない | `fallback` |
| 別の commit・別の workflow・PR・手動の起動・別の枝の成功しか無い | `fallback` |
| `reuse` と判定した直後に run を読み直すと、attempt・状態・結論が変わっていた（jobs を読んだ後に再実行が始まった） | 待つ。新しい attempt を同じ規則で見直す |
| API の失敗（HTTP の失敗・時間切れ）が 3 回続いた | `fallback`。テストを省く方には倒さない |

必須のジョブ（`REQUIRED_JOBS`）は `test-summary` の 1 つだけ。test.yml の `test-summary` は `needs: [test, safe-storage]` で、main の push で回るほかのジョブ（`test` の shard 全部と、`safe-storage` の 3 本）が全部 `success` のときだけ走る（`if` を持たないので、落ちた・取り消された・飛ばされたジョブが 1 つでもあれば走らない）。
`test` は `npm test` を shard ごとのジョブに分けている（Windows 6・ubuntu は Node の版ごとに 2）ので、shard の数や matrix を変えても `REQUIRED_JOBS` は直さなくてよい。
週次・手動だけの `safe-storage-macos` は push では `skipped` になる。`skipped` を許すのはこれだけ（`SKIPPED_ON_PUSH`）。
test.yml に push で回るジョブを足したら、`test-summary` の `needs` に入れる。`tests/unit/release-ci-gate.mjs` が test.yml を読んで、`needs` が push で回るほかのジョブ全部と一致するか、`test` の shard が (os, node) ごとに 1..N 欠けず揃うかを突き合わせるので、入れ忘れるとその commit の CI が赤くなり、そのままではリリースできない。
入れ忘れたジョブが `success` 以外で終わっても、`reuse` にはならない（上の表）。

## CI の流し直しと、取り消さない push

- test.yml の `npm test` の脚（shard ごとの `node tests/run.mjs --jobs 2 --retry-failed 1 --shard k/N`）と、release の fallback の全部のテスト（`release-tests`。こちらは shard に分けない）は、**落ちた suite だけを新しい worker で 1 回流し直す**。通ればそのジョブは success で終わるので、この照合は何も変えずに `reuse` と読む（ジョブの結論だけを見る。警告の注釈は結論を変えない）。2 回目も落ちたジョブは `failure` で、今までどおり赤（[ADR 0162](adr/0162-ci-retry-failed-suites.md)）。
- 流し直したことは、ジョブの警告の注釈（`::warning`）とジョブのまとめ（step summary）に、どの suite が 1 回目のどの判定で落ちたかと一緒に残る。`test-timings-*` の成果物の `suites[].retried` にも入る。リリースの前後で気になったら、test.yml の run のまとめを見る。
- test.yml の `concurrency` は、PR だけ古い run を止める。main への push と手動の起動は、group を commit ごとに分けて取り消さない（タグを打った commit の run が後の push で `cancelled` になって `fallback` に落ち、release が全部のテストを回し直すのを避ける）。
- `--shard` の分け方は、OS ごとの重みの表（`tests/suite-weights.win32.json`・`tests/suite-weights.linux.json`）で決まる。重みは分け方のためだけで、表が古くても全部の suite がちょうど 1 つの shard に入ることは変わらない（偏ると 1 つの shard が長くなるだけ。更新は [dev-verification.md](dev-verification.md)）。

## 待ち方

- 30 秒ごとに読み直し、40 分で打ち切る（`--wait-minutes 40`。test.yml の `test` の 1 ジョブ（1 shard）の上限は 25 分で、shard は並んで走る。runner の順番待ちなどで 40 分を超えて終わらないときは、待ちを打ち切って `fallback` になる）。打ち切ったら `fallback`。
- ビルドは判定を待たずに走っているので、ここで待つ間も `windows`・`mac` は進む。待ちが長くても、公開までの時間は「ビルド・公証」と「判定」の長いほうで決まる。
- 始めの 5 分は、run が無いのも待つ（`--missing-grace-minutes 5`）。タグと main を同時に push すると、release が test.yml の run より先に始まることがあるため。
- API の 1 回の呼び出しは、応答の本文を読み終えるまでを 20 秒で打ち切る（`--request-timeout-seconds 20`）。接続や本文が止まっても、待ちの期限の判定へ戻る。
- API から来た文字（ジョブの名前など）は 1 行にしてから書く。ログは `ci-gate: ` で始め、`GITHUB_OUTPUT` は `decision` を最後の行に書く（ログの行頭が workflow command の `::` にならず、出力の行も増やせない）。
- 待つのは `ci-gate`（ubuntu）で、Windows の runner は使わない。ジョブの上限は 50 分。
- 引数は、知らない名前・同じ名前の 2 回目・10 進の 0 以上の数でない時間（NaN・Infinity・負など）・0 の間隔と時間切れを拒み、`ci-gate` を落とす（公開しない）。綴りを間違えた設定が既定値で走らないようにするため。

## CI との環境の差

`reuse` は「OS・Node・lockfile・commit が CI の Windows の脚と同じ」ことを前提にする。残る差と扱いは次のとおり。

| 差 | 扱い |
|---|---|
| Node の版 | release の `setup-node` を test.yml の Windows の脚と同じ `"22.16"` にした（前は `22` で、22 系の最新が入っていた）。テストが突き合わせる。配布物の中で core を動かすのは Electron の同梱 Node（24 系）で、ビルドの Node ではない |
| 依存 | 同じ lockfile から `npm ci`。release だけ、その後に koffi の arm64 の本体を `--force` で足す。`windows` ジョブは（判定を待たずに）毎回、足した後の `node_modules` で、`koffi`・`node-pty` を読めるかと、`computer-native`（本物の koffi の構造体の配置）・`desktop-updates`（配布の手順のスクリプト）の 2 本を回す |
| `TEMP`・`TMP` | release はテストの一時ファイルを `RUNNER_TEMP` の下に分けている。テストの置き場の違いで、配布物には入らない。`release-tests`（全部のテスト）と `windows` の短い検査の両方に効く |
| runner の image | どちらも `windows-latest`。image の版までは揃えない |
| shard | CI は `npm test` を shard に分けて並べ、`release-tests`（`fallback` のとき）は 1 つのジョブで全部を回す。suite の集合は同じ（全 suite がちょうど 1 つの shard に入る。`tests/unit/runner-contract.mjs`）。`fallback` は shard で速くしない |

署名・ビルド・配布物の検査（`build-evaluation.ps1` の署名の確認、`release-artifacts.mjs`、アップロードしたものの SHA-256 の照合）は今までどおり release で行う。

## 保証の範囲

- 公開を止められるのは、照合が**読めた**結果が赤のときだけ。
- 次のときは `fallback` で release の中のテストを全部回し、通れば公開まで進む。
  - API の結果が分からない（失敗・時間切れが続いた）
  - 期限までに終わらなかった
  - run が無い
  - `cancelled`

  このとき main の CI が赤かどうかは分からないままで、照合はそれを保証しない。保証は「release の中の全部のテストが通った」ことだけになる。
- `reuse` の直前の読み直しの後に始まった再実行は見ない。その attempt が後で赤くなっても、公開は止まらない（同じ commit で、揃った成功を一度確かめている）。
- ビルドは判定を待たないので、**赤い commit でも署名と Apple の公証まで進むことがある**。公開は `publish` が判定を待ってから行い、赤・取り消し・`release-tests` の失敗では走らないので、赤い commit は公開されない（配布物は artifact に 7 日残るだけ）。
- `push`（タグの push）では、ビルドも `publish` も、タグの指す commit（`$GITHUB_SHA^{commit}`）を使う。`ci-gate` が照合した commit がそれと食い違えば `publish` が止まる。
- 手動の起動（`workflow_dispatch` に既存のタグ）には、この固定が無い。ビルドと照合の間にタグが付け替えられると、ビルドした commit と照合した commit が食い違いうる。`publish` は checkout と照合した commit が同じかを確かめるが、ビルドした commit までは見ない。タグの付け替えができるのは書き込み権限のある人だけで、main に含まれない commit を指すタグは各ジョブの `Validate release source` が止める。

## 止まったとき

- **赤で止まった**: 1 本の suite の揺れは、CI の中の流し直しで通るので、ここまで来る赤は 2 回とも落ちたもの（本物の失敗の疑い）が多い。ジョブのまとめで、どの suite がどう落ちたかを見る（落ちた shard のジョブを見る。shard の名前は `test (windows-latest, 22.16, 3/6)` のように末尾が番号）。`windows`・`mac` は先に走っていて、赤でも公証まで終わっていることがある。公開されないので、そのまま捨てる。main を直すか、test.yml の失敗したジョブを再実行して最新の attempt を揃った成功にしてから、Evaluation release を再実行する（失敗した run の再実行、または `workflow_dispatch` に同じタグ）。
- **`fallback` で全部のテストを回した**: 理由は `ci-gate` の step summary とログの `reason=` に出る。`fallback` は今までと同じ流れなので、そのまま公開まで進む。

## 範囲

- 手動の `desktop-release.yml` は変えていない。macOS も配る（test.yml は push で macOS を回さない）ので、同じ commit の CI だけでは代わりにならない。
- main の ruleset に required check は無い。この照合が見るのはリリースだけで、main への merge は止めない。
