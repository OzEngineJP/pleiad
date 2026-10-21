// 上限で止まったばかりの枠（エージェント・モデル・アカウント）の記録（ADR 0229、Issue #111）。委譲の自動の振り分けが飛ばす。
// 覚えるのはこのサーバーの間だけ（保存しない）。副作用はこのモジュールの Map だけ。
//
// - 保留は、エージェントが告げた解除の見込みまで。ただし最低 MIN_HOLD_MS（「0 seconds」でも、すぐ同じ枠へ戻さない）。
// - 解除の見込みを過ぎた後に、同じ枠がまた止まった（MEMORY_MS 以内）なら、前回の保留の 2 倍に延ばす（上限 MAX_BACKOFF_MS。
//   告げられた見込みがそれより長ければ見込みのまま）。Devin の見込みは下限で、試すたびに後ろへずれる（実測 2026-10-21）。
// - 保留の間に別の子が同じ枠で止まった（並べて走っていた）ものは、延ばす回数に数えない（遅い方の見込みに合わせるだけ）。
// - 解除時刻が分からない上限は、同じ枠のターンが通るまで外さない（until: null）。
// - 同じ枠のターンが通ったら、記録ごと消す（延ばす回数も戻る）。

export const MIN_HOLD_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const MEMORY_MS = 30 * 60_000;

export const slotKey = (backend, model, account) => `${backend}\n${model ?? ''}\n${account ?? ''}`;

export function createSlotLimits({ now = Date.now } = {}) {
  /** key -> { backend, model, account, until: ms | null, hold: ms | null, strikes, since, resetsAt } */
  const slots = new Map();
  const active = (s, at) => s.until == null || s.until > at;
  return {
    /**
     * 上限で止まった。resetsAt はエージェントが告げた解除の見込み（ms。分からなければ null）。
     * 告げられた時刻がもう過ぎている（取得元が古い）なら覚えない。記録した枠を返す
     */
    record({ backend, model = null, account = null, resetsAt = null }) {
      const at = now();
      const told = Number.isFinite(resetsAt) ? resetsAt : null;
      if (told != null && told <= at) return null;
      const key = slotKey(backend, model, account);
      const prev = slots.get(key);
      const base = { backend, model: model ?? null, account: account ?? null, resetsAt: told };
      let next;
      if (told == null) {
        next = { ...base, until: null, hold: null, strikes: (prev?.strikes ?? 0) + (prev && !active(prev, at) ? 1 : 0), since: prev && active(prev, at) ? prev.since : at };
      } else if (prev && active(prev, at)) {
        // 保留の間に別の子も同じ枠で止まった。遅い方に合わせる（延ばす回数は増やさない）。
        // 解除時刻の分からない保留の後に見込みが届いたら、見込みの方を使う（分からないまま外さない状態を残さない）
        const until = Math.max(prev.until ?? 0, told, at + MIN_HOLD_MS);
        next = { ...base, until, hold: until == null ? null : until - prev.since, strikes: prev.strikes, since: prev.since };
      } else {
        // 見込みを過ぎて（または初めて）止まった。過ぎてから MEMORY_MS 以内の再発は、前回の保留の 2 倍に延ばす
        const again = prev && prev.until != null && at - prev.until <= MEMORY_MS;
        const strikes = again ? prev.strikes + 1 : 0;
        const backoff = again ? Math.min(Math.max(prev.hold ?? MIN_HOLD_MS, MIN_HOLD_MS) * 2, MAX_BACKOFF_MS) : MIN_HOLD_MS;
        const until = Math.max(told, at + backoff);
        next = { ...base, until, hold: until - at, strikes, since: at };
      }
      slots.set(key, next);
      return { ...next };
    },
    /** 同じ枠のターンが通った。記録ごと消す */
    clear(backend, model, account) { slots.delete(slotKey(backend, model, account)); },
    /** 今止まっている枠の記録。止まっていなければ null（見込みを過ぎた記録は、延ばすために MEMORY_MS の間だけ残す） */
    get(backend, model, account) {
      const key = slotKey(backend, model, account), s = slots.get(key), at = now();
      if (!s) return null;
      if (active(s, at)) return { ...s };
      if (at - s.until > MEMORY_MS) slots.delete(key);
      return null;
    },
    /** 今止まっている枠の一覧（backend を渡せばそのエージェントの分だけ） */
    list(backend = null) {
      const at = now(), out = [];
      for (const [key, s] of slots) {
        if (!active(s, at)) { if (at - s.until > MEMORY_MS) slots.delete(key); continue; }
        if (backend == null || s.backend === backend) out.push({ ...s });
      }
      return out;
    },
  };
}
