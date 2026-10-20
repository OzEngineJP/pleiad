# 審査用のホストを動かす

Play の審査員が使う、審査専用のホストと中継を動かす手順（[ADR 0172](../adr/0172-play-review-access.md)）。置いた後の「アプリへのアクセス」の文は [app-access.md](app-access.md)。

置くものは 2 つで、どちらも**利用者の PC や普段の中継とは別**にする。

| 何を | 何で | 役目 |
|---|---|---|
| (a) 審査用の中継 | `relay/`（普段の中継と同じ image）。登録用の秘密は**審査用に別のもの** | 審査員のスマートフォンと (b) をつなぐ |
| (b) 審査用のホスト | `deploy/review-host/Dockerfile` | 審査モードの Pleiad。fake のバックエンドだけ（LLM を呼ばない）、画面なし、非 root |

審査用の中継を別にするのは、審査の資料に載る URL と秘密を、普段使いの中継から切り離すため。(b) が持つ秘密は (a) の登録用の秘密だけで、Claude や GitHub などの鍵は一切入れない。

```
審査員のスマートフォン ──→ (a) 審査用の中継 ←── (b) 審査用のホスト（外向きにつなぐだけ。待ち受けは 127.0.0.1）
```

## 0. 用意するもの

- 審査用の中継のドメイン（例 `review-relay.<自分のドメイン>`）。**決めたら変えない**（招待のコードに URL が入るので、変えると招待を作り直して申告の文も書き換えることになる）
- 審査用の登録用の秘密。32 字以上の乱数（例: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`）。普段の中継の秘密と**別の値**にする
- コンテナを動かせるサーバー。中継は HTTPS の逆プロキシの後ろに置き、ドメインを付ける。ホストは 127.0.0.1 でしか待ち受けないので、外へ出す口は要らない

## 1. (a) 審査用の中継

普段の中継と同じ手順（[remote.md §5.4](../remote.md)、[relay/README.md](../../relay/README.md)）を、別の値で繰り返す。

```sh
docker build -t pleiad-relay relay/
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e RELAY_ENROLL_SECRET=<上の審査用の秘密> -e RELAY_TRUST_PROXY=1 -e RELAY_MAX_HOSTS=1 \
  pleiad-relay
```

- `RELAY_MAX_HOSTS=1` で、審査用のホストの 1 台だけを載せる
- 前に HTTPS を終えて WebSocket を通す逆プロキシを置き、`https://review-relay.<自分のドメイン>` で届くようにする
- 永続ストレージは付けない

## 2. (b) 審査用のホスト

```sh
docker build -f deploy/review-host/Dockerfile -t pleiad-review-host .
docker run -d --restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges \
  -v pleiad-review-data:/data \
  -e AGENT_HOST_RELAY_URL=https://review-relay.<自分のドメイン> \
  -e AGENT_HOST_RELAY_SECRET=<(a) の RELAY_ENROLL_SECRET と同じ値> \
  pleiad-review-host
```

環境変数（実行時だけ。ビルド時には渡さない）:

| 名前 | 値 | 意味 |
|---|---|---|
| `AGENT_HOST_RELAY_URL` | `https://review-relay.<自分のドメイン>` | (a) の URL |
| `AGENT_HOST_RELAY_SECRET` | (a) の `RELAY_ENROLL_SECRET` と同じ値 | ホストの登録用の秘密。(b) が持つ唯一の秘密 |
| `AGENT_HOST_REVIEW_NAME` | （任意）`Pleiad Review` | アプリのホスト一覧に出す名前。申告の文の「Pleiad Review」と合わせる |
| `REVIEW_QR_PORT` | （任意）`8081` | 置くと QR の画像を配る口も起こす（→ 「6. QR の画像」） |

`AGENT_HOST_REVIEW=1`・`AGENT_HOST_BACKENDS=fake`・`AGENT_HOST_LOCALE=en`・`AGENT_HOST_DATA=/data` などは Dockerfile が決めてある。変えない

- `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges` は任意だが勧める（権限を落とし、書ける場所を `/data` と `/tmp` だけにする。image は非 root の利用者で動き、権限はすべて落としてある）
- 永続ストレージ: 名前付きのボリュームを **`/data` に 1 つだけ**付ける。ホストのフォルダー（bind mount）は付けない。Docker のソケットも渡さない
- 置き直し（image の作り直しとコンテナの交換）は手で行う。リポジトリへの push のたびに作り直すと、会話が消えたり審査の最中に版が変わったりする
- 起動するとログに次が出る:

  ```
  Remote access is configured for https://review-relay.<自分のドメイン>.
  agent-host  http://localhost:7420/?token=...
  backends    fake
  review invite: none
  ```

image は非 root（`node`）で動く。中の `/data/remote/` にホストの鍵・中継の設定・端末・招待の秘密が入るので、このボリュームが守る対象になる。

## 3. 招待を作る・見る・取り消す

動いているコンテナの中で、次を打つ。

```sh
docker exec <コンテナ> node core/review-invite.mjs create --days 90    # 作る。今ある招待は置き換わり、それで入っていた端末は切れる
docker exec <コンテナ> node core/review-invite.mjs show                # 残り日数・端末の数・ペアリングのコード
docker exec <コンテナ> node core/review-invite.mjs show --code-only    # コードだけ（pleiad://pair?...）
docker exec <コンテナ> node core/review-invite.mjs revoke              # 取り消す。入った端末もすべて切れる
```

- 既定は 90 日、最長 180 日（`--days 1`〜`180`）。審査の期間より長めに作る
- 動いているホストは 10 秒ほどで招待の記録を読み直す。**作った・取り消した後、10 秒ほど待ってから**試す。ログに `review invite: active: 90 days left ...` が出る
- 招待は同時に 1 つだけ。コードは何度でも、複数の端末で使える。上限は**生きている端末 8 台**と**自動で通すのは 1 時間に 4 台**で、超えたらアプリは断られた表示になる（承認待ちにはならない）
- 8 台に達した・不要な端末を外したいときは、`create` で作り直す（その招待で入った端末がすべて切れる）。審査の最中は作り直さない（審査員の端末も切れ、申告したコードも使えなくなる）
- これらのコマンドは審査モードのときだけ動く。この image は常に審査モード

## 4. 申告に出す前にやること

1. 手元のスマートフォンで確かめる: アプリで「ホストを追加」→ 招待のコードを貼る → ホスト「Pleiad Review」が人の承認なしで入る → 新しい会話で `ask` と送り、承認の操作ができる
2. **ホストを起動し直す**（`docker restart <コンテナ>`）。起動のたびに、会話などのデータを消す（残るのは `/data/remote/` = ホストの鍵・中継の設定・端末・招待だけ）ので、確かめで作った会話が審査員に見えない。招待は起動し直しても続く
3. `show` で残りが 30 日以上あることを確かめる
4. `show --code-only` のコードと、`show` の期限（Expires、UTC）を、[app-access.md](app-access.md) の文の `〈 〉` に入れて Play Console に貼る

## 5. 運用

- **ログ**: 起動のたび、および 1 日 1 回、`review invite: 87 days left (expires ...), 3/8 devices` のように、残り日数と入った端末の数が出る。招待がなければ `review invite: none`、期限が切れていれば `expired` と出る。端末を通した・断った（`device limit` / `hourly limit`）ことも 1 行ずつ出る。コードや秘密はログに出さない
- **残りが 30 日を切ったら**: `create` で作り直し、新しいコードと期限を [app-access.md](app-access.md) の文に書き換えて、Play Console の「アプリへのアクセス」を更新する。期限が切れた招待のコードは使えず、切れたコードの審査は差し戻しの理由になる。申請・更新のたびに `show` で残りを見る
- **起動し直すと会話は消える**。fake のバックエンドの会話に残す値打ちはなく、起動し直しは掃除でもある。審査の前に起動し直す
- **審査員から「入れない」と連絡が来たら**: `show`（期限が切れていないか・端末が 8 台に達していないか）→ ログの `refused` の理由 → 中継 (a) とホスト (b) の両方が動いているか、の順に見る
- **申請を取り下げた後**: 審査が当面無いなら `revoke` で閉じてよい（次の審査の前に `create`）。常に開けておくなら、そのまま 90 日ごとに作り直す

## 6. QR の画像（任意）

Play Console の文にはコードの文字を貼れば足りる。QR の画像を URL で渡したいときだけ使う。

1. (b) の環境変数に `REVIEW_QR_PORT=8081` を足し、コンテナの口（`-p 127.0.0.1:8081:8081` など）を出して作り直す
2. 逆プロキシに `https://review-qr.<自分のドメイン>` をその口へ向ける設定を足す
3. `show` が出す `QR image URL path` が道（`/qr/<16 字>.svg`）。`https://review-qr.<自分のドメイン>/qr/<16 字>.svg` で SVG が返る。道は招待ごとに決まり、作り直すと変わる。招待が無い・切れていれば 404

この URL を知る人はコードを読めるのと同じなので、コードと同じ扱いで渡す（道は推測できない長さ）。

## 置いたものの安全の確認

- 外から入る口が無い: ホストは 127.0.0.1 でしか待ち受けず、中継へ外向きにつなぐだけ。ドメインは (a) にだけ付く
- 非 root・権限なし（`--cap-drop ALL`）・書けるのは `/data` と `/tmp` だけ・Docker のソケットもホストのフォルダーも無い
- 持つ秘密は (a) の登録用の秘密だけ（と、`/data/remote/` の中のホストの鍵・招待）。(a) は審査用に別で、漏れても普段の中継は無関係
- バックエンドは fake だけで、LLM もネットワークも呼ばない。審査員ができる操作の絞り込みは審査モードの関所の側（ADR 0172 の決定 1・2）
- 招待は期限（既定 90 日）と台数（8）と速さ（1 時間 4 台）で絞られ、取り消すと入った端末ごと切れる
