// サーバーの時計と、この画面の時計のずれ。サーバーが付けた時刻（tool.start の at・running のターン行の startedAt）から
// 経過を数えるとき、この画面の Date.now() の目盛りに直す。同じ PC ではほぼ 0。リモートの端末（docs/remote.md）は時計がずれうるので、
// 接続ごとの ready の now で合わせる（行き帰りの遅れの分だけ短く数えるが、秒の表示には効かない）。
let offset = 0;

/** ready を受けた。now はサーバーが送った時の時刻（ms）。無ければ（古いサーバー）ずれは 0 とみなす */
export function syncServerClock(now) {
  offset = Number.isFinite(now) ? now - Date.now() : 0;
}

/** サーバーの時刻（ms か ISO の文字列）を、この画面の時計の ms にする。分からなければ null。先の時刻は今に寄せる */
export function localTime(at) {
  const ms = typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isFinite(ms)) return null;
  return Math.min(ms - offset, Date.now());
}

/** ツールの始まり（tool.start の出来事か、stream-messages が畳んだ呼び出し）の、この画面の時計の ms。バックエンドの申告（startedAt）を先に見る */
export function toolStartedAt(ev) {
  return localTime(ev?.startedAt) ?? localTime(ev?.at);
}
