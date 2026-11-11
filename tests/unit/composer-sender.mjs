// 入力欄の配送の核（web/composer/sender.mjs。ADR 0315 の段 4）。メインの入力欄と子の会話のモーダルの入力欄が同じものを使う。
//   - 送る文: 文中の印の添付は足さず、文中に無い添付だけ末尾に印で足す
//   - 送る先の会話ごとに受け取り（receipts）を持つ: 別の会話の送りかけと混ざらない・応答が失われても二重に送らない
//   - 日時を指定した送信は予定として置く（同じ中身を送り直しても同じ予定の id）
import { createSender, composeSend, sendAttachments } from '../../web/composer/sender.mjs';

export const name = 'composer-sender';
export const title = '入力欄の配送の核（送る先の会話ごとの受け取り・文中の添付の印・予定の冪等）';

const attachedKey = (p) => `p:${p}`;
const attachmentLine = (lang, p) => `[${lang}] ${p}`;

function setup({ sendFails = false } = {}) {
  const calls = [], receipts = new Map(), saved = [], cleared = [], said = [], scheduledFor = [];
  const outbox = new Map();   // 会話 -> 送信待ち（sendMessage で入る）
  let n = 0;
  const sender = createSender({
    t: (k) => `[${k}]`,
    cmd: async (command, args) => {
      calls.push([command, args]);
      if (command === 'sendMessage') {
        if (sendFails) throw new Error('lost');
        outbox.set(args.sessionId, [...(outbox.get(args.sessionId) ?? []), { id: args.messageId }]);
      }
    },
    limitOp: async (op, args) => { calls.push([op, args]); },
    randomId: () => `id${++n}`,
    receipts, saveReceipts: () => saved.push([...receipts.keys()]),
    refreshOutbox: async (sessionId) => outbox.get(sessionId) ?? [],
    scheduled: (id) => scheduledFor.push(id),
    clearSent: async (id, text, atts) => { cleared.push([id, text, atts.length]); },
    beforeSend: () => {}, afterSend: () => {},
    say: (text) => said.push(text),
  });
  return { sender, calls, receipts, cleared, said, scheduledFor, outbox };
}
const base = { agentLang: 'ja', attachedKey, attachmentLine, inDoc: new Set(), ordered: [] };

export default async function (t) {
  {
    const atts = [{ path: 'a.txt', name: 'a', mime: 'text/plain' }, { path: 'b.png', name: 'b' }];
    t.ok('文中に無い添付は末尾に印を足す', composeSend({ text: ' hi ', attachments: atts, inDoc: new Set(), attachedKey, attachmentLine, agentLang: 'ja' })
      === 'hi\n\n[ja] a.txt\n[ja] b.png');
    t.ok('文中の印にある添付は足さない', composeSend({ text: 'hi', attachments: atts, inDoc: new Set(['p:a.txt']), attachedKey, attachmentLine, agentLang: 'ja' })
      === 'hi\n\n[ja] b.png');
    t.ok('本文が空でも添付の印だけは送る文になる', composeSend({ text: '', attachments: atts.slice(0, 1), inDoc: new Set(), attachedKey, attachmentLine, agentLang: 'ja' })
      === '[ja] a.txt');
    t.ok('送る添付の形は path・name・mime だけ', JSON.stringify(sendAttachments([{ path: 'x', name: 'n', extra: 1 }])) === '[{"path":"x","name":"n","mime":""}]');
  }
  {
    const s = setup();
    await s.sender.send({ ...base, sessionId: 'child-1', text: 'こんにちは' });
    const sent = s.calls.find(([c]) => c === 'sendMessage');
    t.ok('送る先の会話へ sendMessage する', sent[1].sessionId === 'child-1' && sent[1].prompt === 'こんにちは' && sent[1].messageId === 'id1');
    t.ok('届いたら受け取りを消し、その会話の下書きを片付ける', !s.receipts.has('child-1') && s.cleared.length === 1 && s.cleared[0][0] === 'child-1');
    t.ok('成功したら理由の一行を空にする', s.said.at(-1) === '');
  }
  {
    // 応答が失われた送信は、受け取りを残して投げる。同じ中身を送り直すと同じ messageId（二重に作らない）
    const s = setup({ sendFails: true });
    let thrown = null;
    try { await s.sender.send({ ...base, sessionId: 'child-1', text: 'x' }); } catch (e) { thrown = e; }
    t.ok('失敗は投げる（呼び出し側が理由の一行にする）', thrown?.message === 'lost');
    t.ok('受け取りはその会話の分だけ残る（別の会話には無い）', s.receipts.get('child-1')?.messageId === 'id1' && !s.receipts.has('main-1'));
    s.outbox.set('child-1', [{ id: 'id1' }]);   // 実は届いていた
    await s.sender.send({ ...base, sessionId: 'child-1', text: 'x' });
    t.ok('実は届いていたものは、もう一度送らずに片付ける', s.calls.filter(([c]) => c === 'sendMessage').length === 1 && !s.receipts.has('child-1'));
  }
  {
    // 2 つの会話（メインと子）の送りかけが混ざらない
    const s = setup({ sendFails: true });
    await s.sender.send({ ...base, sessionId: 'main-1', text: 'a' }).catch(() => {});
    await s.sender.send({ ...base, sessionId: 'child-1', text: 'b' }).catch(() => {});
    t.ok('会話ごとに別の受け取り・別の messageId', s.receipts.get('main-1').prompt === 'a' && s.receipts.get('child-1').prompt === 'b'
      && s.receipts.get('main-1').messageId !== s.receipts.get('child-1').messageId);
  }
  {
    const s = setup();
    await s.sender.send({ ...base, sessionId: 'child-1', text: 'later', at: 123456 });
    const op = s.calls.find(([c]) => c === 'sessions.scheduleSend');
    t.ok('日時つきは予定として置く（送信待ちには入れない）', op[1].at === 123456 && op[1].sessionId === 'child-1' && !s.calls.some(([c]) => c === 'sendMessage'));
    t.ok('予定を置いたら時刻のチップを外す', s.scheduledFor[0] === 'child-1');
  }
  {
    const s = setup();
    s.receipts.set('child-1', { sessionId: 'child-1', prompt: 'old', messageId: 'zz' });
    let thrown = null;
    try { await s.sender.send({ ...base, sessionId: 'child-1', text: 'new' }); } catch (e) { thrown = e; }
    t.ok('前の送りかけが届いたか分からず中身も違うなら、送らずに理由を投げる', thrown?.message === '[chat.send.unknownPrevious]'
      && !s.calls.some(([c]) => c === 'sendMessage'));
  }
}
