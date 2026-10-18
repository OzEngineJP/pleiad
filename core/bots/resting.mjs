// 使用量の上限で休んでいる bot（「休憩中」。ADR 0119）。使うのは core/bots/dispatch.mjs、見せるのは bots.overview の restingUntil。
// 上限は会話ではなくバックエンドとモデルの枠に当たるので、同じバックエンド・同じモデルの bot は一緒に休む。持つのはメモリだけ
// （再起動で忘れる。忘れた後の最初の @ はまた上限に当たって、ここに戻る）。
//
//   createResting({ now, onChange, takesAccount }) → Resting
//     rest(bot, resetsAt): number|null       … 上限に当たった。解除の時刻（ms）まで休む。時刻が分からない・過ぎているなら休まない（null）
//     until(bot): number|null                … 休んでいれば解除の時刻
//     noticeOnce(bot, place): boolean        … 休憩中の @ を、その場所（スレッド・DM）で知らせるのは休憩 1 回につき 1 回。初めてなら true
//     key(bot): string                       … その bot の休憩の key（restKey に takesAccount を渡したもの）
//     stop(): void
//   onChange(key) … 休み始めた・休み終えた（key は `${backend}:${model}`。dispatch が botsChanged を出す）
//   Claude のアカウントを選んだ bot（ADR 0222）は、枠がアカウントごとなので key に `:${account}` を足す（アカウントを替えれば休憩から出る）。
//   足すのは、そのアカウントで動くバックエンド（takesAccount(backendId)。capabilities.claudeAccounts）の bot だけ（ほかの backend の bot に残った
//   account は使われないので、同じ枠の bot と一緒に休む）

export const restKey = (bot, takesAccount = () => true) =>
  `${bot?.backend ?? ''}:${bot?.model ?? ''}${bot?.account && takesAccount(bot.backend ?? '') ? `:${bot.account}` : ''}`;

export function createResting({ now = Date.now, onChange = () => {}, takesAccount = () => true } = {}) {
  const restKey_ = (bot) => restKey(bot, takesAccount);
  const until = new Map();     // key → 解除の時刻（ms）
  const noticed = new Map();   // key → 知らせた場所の Set（休み終えたら捨てる）
  const timers = new Map();

  function end(key) {
    until.delete(key);
    noticed.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  const self = {
    rest(bot, resetsAt) {
      if (!Number.isFinite(resetsAt) || resetsAt <= now()) return null;
      const key = restKey_(bot);
      if ((until.get(key) ?? 0) >= resetsAt) return until.get(key);
      until.set(key, resetsAt);
      clearTimeout(timers.get(key));
      const timer = setTimeout(() => { end(key); onChange(key); }, Math.min(resetsAt - now(), 2 ** 31 - 1));
      timer.unref?.();
      timers.set(key, timer);
      onChange(key);
      return resetsAt;
    },
    until(bot) {
      const key = restKey_(bot);
      const at = until.get(key);
      if (!at) return null;
      if (at <= now()) { end(key); return null; }
      return at;
    },
    noticeOnce(bot, place) {
      if (!self.until(bot)) return false;
      const key = restKey_(bot);
      const seen = noticed.get(key) ?? noticed.set(key, new Set()).get(key);
      if (seen.has(place)) return false;
      seen.add(place);
      return true;
    },
    clear(bot) {
      const key = restKey_(bot);
      if (!until.has(key)) return false;
      end(key);
      onChange(key);
      return true;
    },
    key: restKey_,
    stop() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
  return self;
}
