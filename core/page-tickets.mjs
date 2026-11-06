// 既定のブラウザーで Pleiad のページ（フォルダーのページ）を開くための、1 回だけ使える入場券（ADR 0294 の 3 の 3・ADR 0295 の 2）。
// 既定のブラウザーはページの Cookie を持たないので、ホストの画面の「既定のブラウザーで開く」（openPath）のときだけ券を作り、
// http://localhost:<pages port>/_pleiad/enter?ticket=<券> を OS に開かせる。ファイルのページの port は券を 1 回だけ受け、
// ページの Cookie を置いて、券を作ったときに決めた行き先（URL からは受けない）へ移す。
//   - 券は 32 バイトの乱数。メモリだけに置き、60 秒で切れ、使ったら消す。持てるのは 20 枚まで（古いものから捨てる）
//   - 受けるのは Sec-Fetch-Site が none（アドレスバー・OS からの起動）か見出しが無い GET だけ。ほかのページからの移動では使えない
// ログに券・行き先を書かない。
import crypto from 'node:crypto';

export const TICKET_TTL_MS = 60_000;
export const MAX_TICKETS = 20;
export const ENTER_PATH = '/_pleiad/enter';
const TICKET = /^[0-9a-f]{64}$/;

/**
 * @returns
 *   - issue(next): 券（文字列）。next は /_pleiad/ で始まる行き先のパスと検索
 *   - take(ticket): 券が生きていれば行き先を返して消す。無い・切れた・形の外は null
 */
export function createPageTickets({ now = Date.now, ttlMs = TICKET_TTL_MS, max = MAX_TICKETS } = {}) {
  const tickets = new Map();
  const sweep = () => { for (const [key, entry] of tickets) if (now() - entry.at > ttlMs) tickets.delete(key); };
  return {
    issue(next) {
      if (typeof next !== 'string' || !next.startsWith('/_pleiad/') || next.startsWith('/_pleiad/enter')) throw new Error('invalid destination');
      sweep();
      while (tickets.size >= max) tickets.delete(tickets.keys().next().value);
      const ticket = crypto.randomBytes(32).toString('hex');
      tickets.set(ticket, { next, at: now() });
      return ticket;
    },
    take(ticket) {
      if (typeof ticket !== 'string' || !TICKET.test(ticket)) return null;
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      return entry && now() - entry.at <= ttlMs ? entry.next : null;
    },
  };
}
