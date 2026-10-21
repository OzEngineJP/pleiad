# 0249 公式の中継と端末の受け入れに、ID トークンの代わりに api の券を使う

- 状態: 承認済み（2026-10-22）

## 状況

Pleiad Plus の公式の中継は、PC と端末の接続を `X-Pleiad-Account` の ID トークンで通していた。PC も、同じアカウントの端末を受け入れるときに、Noise のメッセージ 1 に入った ID トークンの uid を確かめていた（[ADR 0248](0248-device-approval-and-revocation.md)）。

ID トークンはアカウントのログインを表すもので、どの PC・どの鍵・どの用途の接続かを持たない。

api が、用途と鍵に結びついた短い券を出すようになった（`/v1/tickets`）。

## 決定

- **中継へは中継の券で張る。** PC の制御の接続・端末の接続・通知の線は、張るたびに api から券を取り、`X-Pleiad-Ticket` に付ける。券は鍵の持ち主の証明（登録と同じ式で、最後の語が `host` / `device`）と引き換えに出る。accept（端末ごとの接続）は今の制御の接続と同じ券を付け、中継は制御の接続が閉じたらその券を accept に使わせない。
- **受け入れは受け入れの券で確かめる。** 端末はメッセージ 1 に `plus: { ticket }` を入れる。PC は、署名（`<api>/.well-known/pleiad-keys`）・期限・`hostId` が自分・`devicePub` が Noise の相手の静的鍵・uid が今のアカウント・`jti` が初めて、を確かめる。どれかが違えば `account` で断る。通ったあとは今までどおり PC の画面の承認の窓へ回す（同じアカウントであることは承認の代わりにしない）。
- **api のすべての要求に `X-Pleiad-Admission: 2` を付ける。** 券の道に対応した版であることの印。同期の口（`/v1/sync/*`）と、同期の公開鍵を載せる登録には付けない（同期の券はまだ使わない）。
- **券の無い前の版の api では ID トークンの道に戻る。** `/v1/tickets/challenge` が `404` で、`/v1/auth/config` に `admission` が無いときだけ。5 分は問い直さない。
- **券だけを受ける api と中継では、古い道を「更新が要る」として扱う。** 中継の `4401 'update required'`・api の `426 update_required`・PC の `denied 'update_required'` は、どれも「Pleiad を更新してください」で止まり、自動ではやり直さない。
- **券の発行で台帳に無いと分かったら、登録を確かめ直す。** PC は `404`・`403 host_removed` で link の error を `host` にし、登録を見直す。端末は「ホストが見つかりません」。
- **外した PC の hostId が登録し直せないときは、鍵を作り直して戻る。** 登録が `403 host_removed` なら `removed`（`permanent`）にして問い直さず、「この PC を登録し直す」は鍵の作り直し（`plusHostRebind`）の確かめを出す。
- **券の公開鍵が取れないときは、期限の切れた覚えを、読んでから 24 時間まで使う。** 覚えが無いか、それより古いときは受け入れを `unavailable` で断る。

## 理由

- **接続ごとに、どの鍵の何のための接続かを確かめられる。** 券は 5 分で切れ、一度しか使えず、鍵と用途と hostId に結びつく。ID トークンの代わりに使えば、中継と PC が受け取るものは、その接続のためだけのものになる。
- **accept を制御の接続の券に結びつける。** accept は端末ごとに張られ、そのたびに券を取ると api への要求が端末の数だけ増える。制御の接続の券と同じ文字列で、制御の接続が生きている間だけ通せば、要求を増やさずに同じ PC の接続だと分かる。
- **前の版の api と並べて動かす。** api・中継・アプリは別々に更新される。券の口の有無と `admission` で道を選べば、どの組み合わせでも動き、切り替えは api と中継のフラグで行える。
- **更新が要るときは止まって知らせる。** 何度やり直しても通らない断りを、オフラインと同じように繰り返すと、電池と api の上限を使うだけで、人には理由が見えない。

## 影響

- `core/plus/tickets.mjs`（新規）: 証明・券の取り方（`createTicketIssuer`）・確かめ方（`createTicketVerifier`）・一度きり（`createJtiStore`）。`core/plus/hosts.mjs` の登録の証明も同じ式を使う。
- `core/plus/client.mjs`・`core/plus/config.mjs`: `X-Pleiad-Admission`・`admission`。
- `core/remote/plus-link.mjs`: 制御の接続の券・accept の同じ券・受け入れの券の既定の確かめ（`verifyAdmission` の差し込みは残す）・`update` の誤り。
- `core/remote/device*.mjs`・`desktop/remote-windows.cjs`: 端末の券（PC の端末として他の PC へつなぐとき）。`update` の状態。
- `core/plus/hosts.mjs`・`web/plus-settings.mjs`・`web/remote-hosts.mjs`: `removed`（`permanent`）・`update`。
- Android の `remote-core`（`PlusTickets`・`PlusAdmission`・`DeviceLink`・`NotifyLine`）と app（`PlusManager`）: 同じ券の道。`4401 'ticket'` は取り直し、`4401 'update required'` と `426` は更新を促す。iOS は公式の中継の受け入れをまだ持たない。
- 試験: `tests/unit/plus-tickets.mjs`・`tests/unit/remote-tickets.mjs`、偽の Plus（`tests/lib/fake-plus.mjs`）と中継の身代わり（`tests/lib/plus-relay-authz.mjs`）、Android の `PlusAdmissionTest`・`PlusInteropTest`。
