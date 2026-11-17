// 外から渡った URL が、隠した専用の窓にタブとして入ったかの判定（純粋な関数。ADR 0154 の隠した窓の副作用の後始末）。
//
// 背景: 隠した窓は作られた瞬間に一度アクティブになり、Chrome の「最後にアクティブな窓」に残る。Slack などほかのアプリが
// ShellExecute で渡した URL は、Chrome が last-active の窓にタブとして開くので、利用者には何も起きないように見える。
// 過去の対策（6fe76bf9: Pleiad 経由の URL の前に見える窓を前面へ、17dde7c1: 画面の外に残った窓を見える窓に数えない）は、
// Pleiad 自身が URL を渡す経路だけを直す。ここは外のアプリから渡った URL を、CDP で後から拾って見える窓へ移すための判定。
//
// 誤って移さないための条件（全部満たしたときだけ 'relocate'）:
//   - type が page で、まだ範囲のタブでない
//   - openerId が無い（window.open・target=_blank・OAuth の子窓は必ず openerId を持つ。開いた元が範囲に無くても、openerId があれば移さない）
//   - 会話の窓（範囲に入っている窓）に入ったタブ。窓が分からない・会話の窓でない（利用者の窓）なら見ない
//   - つなぎ終えたあとに届いた知らせ（つなぎ直し・更新の持ち越しで既存のタブを数え直す知らせは、会話のタブとして戻す）
//   - 会話の窓を人が引き継いでいない（見せている窓・一時停止中の人のタブは会話のもの）
//   - その会話が窓・タブを開いている最中でない（エージェントが createTarget で作ったタブを外のタブと取り違えない）
//   - URL が http(s) で、空白・NUL を含まない（about:blank や chrome:// は移さない）
//   - 同じ URL を短時間に繰り返し移していない（移した先がまた隠した窓に入っても、堂々巡りにしない）

export const RELOCATE_WINDOW_MS = 15_000;
export const RELOCATE_MAX_PER_URL = 2;

/** 移せる URL か（http・https だけ。空白・NUL を含むものは渡さない） */
export function isRelocatableUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S/i.test(url) && !/[\s\0]/.test(url);
}

/**
 * @param {{ info: object, tracked?: boolean, openerKnown?: boolean, windowKnown?: boolean, live?: boolean, handedOver?: boolean, opening?: boolean, url?: string }} input
 *   info: Target.targetInfo。tracked: すでに範囲のタブ。openerKnown: 開いた元が範囲にある。windowKnown: そのタブの窓が会話の窓。
 *   live: つなぎ終えたあとに届いた知らせ。handedOver: 窓が人の引き継ぎ中（見せている・一時停止）。opening: その会話が窓・タブを開いている最中。
 *   url: 落ち着いたあとの URL（未指定なら info.url）。settled: もう待てない（待った後）
 * @returns {'ignore' | 'adopt' | 'popup' | 'relocate' | 'wait'}
 *   ignore: 見ない（利用者の窓のタブ・範囲の外） / popup: 範囲のタブが開いたタブ（今までどおり） / adopt: 今までどおり会話のタブにする / relocate: 見える窓へ移す / wait: 移す条件はそろっているが URL がまだ空（settled: false のときだけ。少し待って決め直す）
 */
export function classifyNewTab({ info, tracked = false, openerKnown = false, windowKnown = false, live = false, handedOver = false, opening = false, url, settled = true } = {}) {
  if (info?.type !== 'page' || tracked) return 'ignore';
  if (openerKnown) return 'popup';
  if (info.openerId) return windowKnown ? 'adopt' : 'ignore';
  if (!windowKnown) return 'ignore';
  if (!live || handedOver || opening) return 'adopt';
  const target = url ?? info.url;
  if (isRelocatableUrl(target)) return 'relocate';
  return settled || !(target === '' || target == null || target === 'about:blank') ? 'adopt' : 'wait';
}

/** 同じ URL を短時間に移しすぎていないか。移してよければ記録して true */
export function allowRelocation(history, url, now, { windowMs = RELOCATE_WINDOW_MS, max = RELOCATE_MAX_PER_URL } = {}) {
  for (const [key, times] of history) {
    const recent = times.filter(at => now - at < windowMs);
    if (recent.length) history.set(key, recent); else history.delete(key);
  }
  const times = history.get(url) ?? [];
  if (times.length >= max) return false;
  history.set(url, [...times, now]);
  return true;
}
