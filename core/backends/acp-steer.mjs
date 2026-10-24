import { randomUUID } from 'node:crypto';

// Standard ACP prompt calls settle when their work finishes. Grok's interject
// request only admits input; its separate session notification confirms it.
export const PROTOCOL_REJECT_CODES = new Set([-32600, -32601, -32602]);

/**
 * confirmOnAccept … 呼び出しが即座に拒否されなかった時点で「渡った」を出す。Devin のように
 * session/prompt の応答が回の終わりまで返らないバックエンド用（折り込んだ時点＝渡った時点。docs/design.md「配送」）。
 * 受理後の cancelled・接続断は、読まれたかを区別できないので合図を出さない（送信待ちへ戻さない）
 */
export function createAcpSteer({ client, sessionId, emit, ready, onSent, interject = null, confirmOnAccept = false }) {
  const calls = new Map(), interjections = new Map();
  let canInterject = typeof interject === 'function';
  const remove = (key, entry) => { interjections.delete(key); entry.resolve(); };
  return {
    get size() { return calls.size + interjections.size; },
    hasInterjection(key) { return interjections.has(key); },
    confirmed(key, nativeId) {
      const entry = interjections.get(key);
      if (!entry) return false;
      entry.confirmed = true;
      remove(key, entry);
      if (entry.id) emit({ type: 'userMessage.delivered', messageId: entry.id, ...(nativeId ? { nativeId } : {}) });
      return true;
    },
    async steer(item) {
      if (!ready()) return false;
      const text = String(item?.args?.prompt ?? '');
      if (canInterject) {
        const key = `pleiad-${randomUUID()}`;
        let resolve;
        const entry = { id: item?.id, confirmed: false, done: new Promise(r => { resolve = r; }) };
        entry.resolve = resolve;
        // The native notification can precede the RPC response.
        interjections.set(key, entry);
        let ack;
        try { ack = await interject(text, item, key); }
        catch (error) {
          remove(key, entry);
          if (entry.confirmed) return true;
          throw error;
        }
        if (entry.confirmed) return true;
        if (ack === 'unsupported') { remove(key, entry); canInterject = false; }
        else if (!ack) { remove(key, entry); return false; }
        else return true;
      }
      let call;
      try { call = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, { timeoutMs: 0 }); }
      catch { return false; }
      const withdraw = onSent?.(text);
      const entry = { id: item?.id ?? null, delivered: false };
      calls.set(call, entry);
      const early = await Promise.race([call.then(() => null, e => e), new Promise(resolve => setTimeout(resolve, 300)).then(() => null)]);
      if (early instanceof Error) {
        calls.delete(call);
        if (PROTOCOL_REJECT_CODES.has(early.code)) { withdraw?.(); return false; }
        throw early;
      }
      call.then(
        result => {
          if (!calls.delete(call) || !entry.id || entry.delivered) return;
          const nativeId = withdraw?.nativeId;
          emit({ type: result?.stopReason === 'cancelled' ? 'userMessage.dropped' : 'userMessage.delivered', messageId: entry.id,
            ...(result?.stopReason === 'cancelled' ? { unknown: true } : {}), ...(nativeId ? { nativeId } : {}) });
        },
        () => { if (calls.delete(call) && entry.id && !entry.delivered) emit({ type: 'userMessage.dropped', messageId: entry.id, unknown: true }); });
      // 即座の拒否が無い＝折り込まれた。応答を待たずに渡ったことにする（決着の側では何も出さない）
      if (confirmOnAccept && entry.id && calls.has(call)) {
        entry.delivered = true;
        const nativeId = withdraw?.nativeId;
        emit({ type: 'userMessage.delivered', messageId: entry.id, ...(nativeId ? { nativeId } : {}) });
      }
      return true;
    },
    async drain({ alive = () => true, confirmationMs = 1000 } = {}) {
      while (calls.size && alive()) await Promise.allSettled([...calls.keys()]);
      if (interjections.size && alive()) {
        let timer;
        try { await Promise.race([Promise.allSettled([...interjections.values()].map(x => x.done)), new Promise(r => { timer = setTimeout(r, confirmationMs); })]); }
        finally { clearTimeout(timer); }
      }
      // A lost confirmation is ambiguous: never silently repeat the instruction.
      for (const [key, entry] of interjections) {
        remove(key, entry);
        if (entry.id) emit({ type: 'userMessage.dropped', messageId: entry.id, unknown: true });
      }
    },
  };
}
