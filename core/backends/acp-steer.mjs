// ACP の session/prompt による途中送信（control.steer）の共通部品（devin.mjs・grok.mjs）。
//
// 走っているターンへの session/prompt は、Devin では同じ回に折り込まれ（実測 3000.11.92）、
// Grok では内蔵の待ち行列に積まれて今の回の直後に続けて回る（実測 1.0.62）。
// どちらも呼び出しの応答は回の決着まで返らないので、「受理」は「書き込みが直ぐに断られなかった」こと、
// 「渡らなかった」は拒否・中断での決着で分かる。決着が拒否・中断だった分は userMessage.dropped にし、
// server が送信待ちの保留へ戻す（読まれたか不明なので勝手に送り直さない）。
//
// 回の終わりに並んだまま残った分は、ターンを畳む前に drain で決着まで待つ（待たずに畳むと、
// 接続の終了で全部 dropped になり、並んだだけのメッセージが答えられない）。

/** 直ぐに断られるプロトコルの拒否（届いていない＝送信待ちに戻してよい。codex.mjs と同じ基準） */
const PROTOCOL_REJECT_CODES = new Set([-32600, -32601, -32602]);

export function createAcpSteer({ client, sessionId, emit, ready }) {
  const calls = new Map();   // 決着を待っている呼び出し -> { id }
  return {
    get size() { return calls.size; },
    async steer(item) {
      if (!ready()) return false;
      let call;
      try {
        call = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: String(item?.args?.prompt ?? '') }] }, { timeoutMs: 0 });
      } catch { return false; }
      const entry = { id: item?.id ?? null };
      calls.set(call, entry);
      call.then(
        result => { if (calls.delete(call) && entry.id && result?.stopReason === 'cancelled') emit({ type: 'userMessage.dropped', messageId: entry.id }); },
        () => { if (calls.delete(call) && entry.id) emit({ type: 'userMessage.dropped', messageId: entry.id }); });
      // プロトコル上の拒否（会話が無い・パラメータの不備）は直ぐに返る。少し待って、断られなければ受理にする
      const early = await Promise.race([call.then(() => null, e => e), new Promise(resolve => setTimeout(resolve, 300)).then(() => null)]);
      if (early instanceof Error) {
        calls.delete(call);
        if (PROTOCOL_REJECT_CODES.has(early.code)) return false;
        throw early;
      }
      return true;
    },
    /** 並んだ分の決着まで待つ。alive() が false になったら（中断・失敗）待つのをやめる */
    async drain({ alive = () => true } = {}) {
      while (calls.size && alive()) await Promise.allSettled([...calls.keys()]);
    },
  };
}
