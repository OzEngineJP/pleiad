// 各画面が「いま見ている会話」をホストへ知らせる仕組み（presence）。通知を送る・消すかどうかの判定に使う（ADR 0086）。
//
// 画面が可視（visible）で、その会話を開いているときだけ見ていることにする。画面は変わるたびと 1 分ごとに送り直し、
// 一定時間（PRESENCE_TTL_MS）たっても更新が無い印は無かったことにする（落ちた画面が見ている印を残し続けない）。
// 接続（ws）ごとに、枠（slot）ごとに 1 件。枠は main（メインの画面の会話）と modal（作業のダイアログで開いた子。ADR 0024 の改訂）。
// 接続を閉じたら消える。
// shownAt は、その画面がこの会話を読み込んで描き終えた履歴の時点（サーバーの時計。loadSession の返事の shownAt）。
// 読み込み中・読み込みに失敗した画面は付けない。通知の一覧の既読（showing）はこれがある印だけを数え、
// プッシュ通知を送らない・消す判定（viewing・policy の isViewed）は今までどおり見ている印だけで決める（ADR 0347 第 3 段）。
import { PRESENCE_TTL_MS } from './policy.mjs';

export function createPresence({ now = Date.now } = {}) {
  const byConn = new Map();   // conn -> Map(slot -> { deviceId, platform, visible, sessionId, at })
  return {
    /** deviceId: 中継越しの端末ならその id、ホストの PC の画面なら null */
    set(conn, { deviceId = null, platform = null, visible, sessionId, slot = 'main', shownAt = null }) {
      const entry = { deviceId, platform, visible: visible === true, sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null, at: now(),
        shownAt: visible === true && Number.isFinite(shownAt) ? shownAt : null };
      const key = slot === 'modal' ? 'modal' : 'main';
      const slots = byConn.get(conn) ?? new Map();
      slots.set(key, entry);
      byConn.set(conn, slots);
      return entry;
    },
    clear(conn) { return byConn.delete(conn); },
    /** 期限内の印。 */
    entries() {
      const t = now();
      const out = [];
      for (const [conn, slots] of byConn) {
        for (const [key, e] of slots) {
          if (t - e.at > PRESENCE_TTL_MS) { slots.delete(key); continue; }
          out.push(e);
        }
        if (!slots.size) byConn.delete(conn);
      }
      return out;
    },
    /** その会話を見ている印（見え始めたときの取り消しの判定用）。 */
    viewing(sessionId) { return this.entries().some(e => e.visible && e.sessionId === sessionId); },
    /** その会話を描き終えて見ている印（いま起きた出来事がその画面に映る）。通知の一覧に最初から既読で載せるかの判定用 */
    showing(sessionId) { return this.entries().some(e => e.visible && e.sessionId === sessionId && e.shownAt != null); },
  };
}
