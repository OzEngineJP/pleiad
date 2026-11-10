// CLI/API が「知らないモデル」と断った枠（エージェント・モデル・アカウント）の記録（ADR 0311）。委譲の自動の振り分けが、しばらく飛ばす。
// 覚えるのはこのサーバーの間だけ（保存しない）。副作用はこの Map だけ。core/slot-limits.mjs（上限で止まった枠）と同じ鍵・同じ引き方。
//
// - 外す長さは HOLD_MS（30 分）。モデルの提供状況は上限と違い数分で変わらないので、上限の最低保留（1 分）より長い。
//   何度断られても延ばさない（30 分後にまた試し、また断られたらもう 30 分）。
// - 同じ枠のターンが通ったら記録ごと消す（モデルが使えるようになった）。
// - 振り分けの設定が変わったら全部忘れる（reset。候補の組が替わったので、前の断りは当てにしない）。

import { slotKey } from './slot-limits.mjs';

export const HOLD_MS = 30 * 60_000;

export function createModelRejects({ now = Date.now } = {}) {
  /** key -> { backend, model, account, until: ms, message } */
  const slots = new Map();
  const live = (key, at) => {
    const s = slots.get(key);
    if (!s) return null;
    if (s.until > at) return s;
    slots.delete(key);
    return null;
  };
  return {
    /** 断られた。記録した枠を返す */
    record({ backend, model, account = null, message = null }) {
      const at = now();
      const next = { backend, model: model ?? null, account: account ?? null, until: at + HOLD_MS, message: message ? String(message).slice(0, 300) : null };
      slots.set(slotKey(backend, model, account), next);
      return { ...next };
    },
    /** 同じ枠のターンが通った */
    clear(backend, model, account) { slots.delete(slotKey(backend, model, account)); },
    /** 今外している枠。無ければ null */
    get(backend, model, account) {
      const s = live(slotKey(backend, model, account), now());
      return s ? { ...s } : null;
    },
    list(backend = null) {
      const at = now(), out = [];
      for (const key of [...slots.keys()]) {
        const s = live(key, at);
        if (s && (backend == null || s.backend === backend)) out.push({ ...s });
      }
      return out;
    },
    /** 全部忘れる（振り分けの設定が変わったとき） */
    reset() { slots.clear(); },
  };
}
