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

/** ツールの行の右端の時刻 HH:MM（発言の行の hhmm と同じく、この画面のローカルの時計で切る） */
export function toolTimeShort(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 5);
}

/** 時刻の詳細のポップオーバー用 HH:MM:SS */
export function toolTimeLong(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
}

/** 所要の幅（ms）→ 「3.4」「12」の文字。10 秒未満は小数 1 位まで、それ以上は整数秒 */
export function toolDuration(ms) {
  const s = Math.max(0, Number(ms) / 1000);
  if (!Number.isFinite(s)) return "";
  return s < 10 ? s.toFixed(1) : String(Math.round(s));
}
