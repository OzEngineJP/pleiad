# 0240 Pleiad Plus の端末の受け入れは「同じアカウント」を Noise の中で確かめる

- 状態: 提案

## 状況

Pleiad Plus の公式の中継を使う端末は、QR のペアリング（`pleiad://pair` の秘密と確認コード）を踏めない。公式の中継は利用者の中継ではなく、ペアリングの入場券を置く口を開けてしまうと誰でもそのホストに入り込める。かといって端末に何の照合もなく入れてはいけない。

ホストはすでに Pleiad Plus のアカウントでログインしている。端末（スマホのアプリ）も同じアカウントでログインしている。アカウントの ID トークンは「この端末はこのアカウントのもの」という証明になるが、中継の `admit` の口（docs/remote.md §5.7）は deviceId の無い端末を通すだけで、アカウントの照合までは負わない設計にしてある。

## 決定

- **受け入れは Noise_IK の応答の中で行う。** 端末は公式の中継の `/v1/device` に `X-Pleiad-Host` と `X-Pleiad-Account`（ID トークン）だけでつなぐ（deviceId もペアリングも無し）。中継の認可の差し込みが `admit: true` で通すと、ホストがデータ用の接続を張り、Noise のハンドシェイクをする。端末はメッセージ 1 の中に `plus.idToken` を入れ、ホストはそれを自分で検証（core/plus/verify.mjs）し、uid が今ログインしているアカウントと同じときだけ端末を登録する。確認コードも人の承認も無い。
- **同じアカウントであることが承認の代わり。** 確認コードは「QR が漏れても人が見比べて止められる」ためのもので、人が既にログインして確かめたアカウント同士では意味が無い。なりすましは ID トークンの検証（署名・期限・audience）と、uid の一致で防ぐ。
- **断りは暗号の中で返す。** `{ type: 'denied', reason }`（`account`・`devices`・`unavailable`・`rate`）を transport で送って 1000 で閉じる。ハンドシェイクの前に断るのは「Plus のつながりが今オフ」だけで、それは平文の 4401 `plus off`。
- **台数と回数の歯止めはホストが持つ。** `limits.devicesPerHost`（最後に読んだ `/v1/account`。一度も読めていなければ `denied: 'unavailable'`）と、1 時間 20 台まで。同じ公開鍵の `via:'plus'` の端末は置き換える（数に入れない）。
- **端末の記録は `via:'plus'` と `plusUid` で持つ。** 照合は「`via:'plus'` かつ `plusUid` が今のアカウントの uid のもの」だけが plus のつながりで受ける。ほかのアカウントでログインし直しても前のアカウントの端末は受けない。
- **公式の中継はペアリングを受けない。** ホスト側の link でも `allowPairing: false`。ペアリングの仕組みは自分の中継（own）のままにする。

## 理由

- **QR が要らない導線を開けつつ、開きすぎない。** アカウントでログインする前提があるなら、「同じアカウントか」を確かめるのが一番簡単で強い照合になる。中継が `admit` の口を持つだけでは「誰でもつなげる」になるので、照合はホストに閉じ込める（中継が信用できなくても ID トークンを偽造できない。Noise の中でしか受け付けないので、中継が平文の誘導もできない）。
- **ID トークンはホストが自分で検証する。** 中継に頼ると「中継が言うアカウント」を信じることになる。検証をホストに置くと、中継が嘘をついても通らない。
- **上限をホスト側にも置く。** 台数の上限を中継（api）だけに任せると、ホストの側で数えられない。ホストが数えれば、中継の障害やすり抜けがあっても止められる。

## 影響

- `core/remote/plus-link.mjs`: 公式の中継への link の provider と、受け入れ（ハンドシェイク・検証・登録・返事・歯止め）。
- `core/plus/hosts.mjs`: この PC の登録（challenge → proof → PUT・PATCH・`host_taken`・`host_limit`・`bad_proof`・届かないときのやり直し）。
- `core/remote/connector.mjs`: `setPlusProvider`・`refreshPlus`・`plusHostRebind`（つなぎ直し）・`status().plus`・`onIncomingAdmit` の差し込み口。
- `core/remote/devices.mjs`: `settings.plus.connect`（既定 false）と `regenerateIdentity`。
- `relay/server.mjs`: `cutRevoked` が受け入れの最中（`admit` で deviceId の無い）接続を切らない。
- `core/server.mjs`: 配線（セッション・設定・登録の見直しと、ログアウト・アカウント変更での `via:'plus'` の取り消し）。`plusHostRebind` は人だけのコマンド。
- `tests/lib/plus-relay-authz.mjs`: 公式の中継の認可の差し込みの試験用の身代わり。
