#!/bin/sh
# 審査用のホストの起動（ADR 0172）。中継の設定を入れてから、Pleiad のサーバーを起こす。
# 必須: AGENT_HOST_RELAY_URL（審査用の中継の URL）・AGENT_HOST_RELAY_SECRET（その中継の登録用の秘密）
# 任意: AGENT_HOST_REVIEW_PLUS_EMAIL・AGENT_HOST_REVIEW_PLUS_PASSWORD（審査用の Plus アカウント。両方あれば、起動のたびにそのアカウントで Plus に入り、
#       審査員がアプリの「メールでログイン」で入ると、ペアリングも承認も無しでこのホストに入れる。core/review-plus-login.mjs）
# 任意: REVIEW_QR_PORT（QR の画像を配るポート。置くと core/review-invite.mjs serve も起こす）、AGENT_HOST_REVIEW_NAME（ホスト名）
set -eu
cd /app

: "${AGENT_HOST_RELAY_URL:?AGENT_HOST_RELAY_URL is required (the review relay URL)}"
: "${AGENT_HOST_RELAY_SECRET:?AGENT_HOST_RELAY_SECRET is required (the review relay enroll secret)}"

# 会話は残さない。起動のたびに、残すもの（remote/ = ホストの鍵・中継の設定・端末・審査の招待、plus-secrets.json = 審査用アカウントのログインの保管、plus-config.json = Plus の設定の写し）以外のデータを消す。
# 審査員が作った会話が次の審査まで残らず、置き場も増え続けない
find "${AGENT_HOST_DATA:-/data}" -mindepth 1 -maxdepth 1 ! -name remote ! -name review-data.json ! -name plus-secrets.json ! -name plus-config.json -exec rm -rf {} +

# 審査用の置き場の印（core/review-mode.mjs の REVIEW_MARK）を、招待の設定を書く前に置く。
# サーバーは印の無い使用済みの置き場では起動しないので、初回（空の置き場）はここで印を作り、2 回目からは上で残した印を使う
node --input-type=module -e "const m = await import('/app/core/review-mode.mjs'); m.prepareReviewHost({ dataDir: process.env.AGENT_HOST_DATA || '/data', backendIds: ['fake'] });"

node core/review-invite.mjs init

if [ -n "${REVIEW_QR_PORT:-}" ]; then
  node core/review-invite.mjs serve --bind 0.0.0.0 --port "$REVIEW_QR_PORT" &
fi

exec node core/server.mjs
