// 入力欄から会話へ送る配送の核（docs/design-system.md「入力欄と上端」、ADR 0315 段 4）。
// 「入力欄 × 送る先の会話」の組で動く: メインの会話の入力欄（web/client.mjs の submit）と、子の会話のモーダルの入力欄が同じものを使う。
//   - 本文と添付から送る文を作る（文中の印はそのまま、文中に無い添付だけ末尾に印を足す）
//   - 日時を指定した送信は予定として置く（応答が届かず送り直しても同じ予定を二重に作らない）
//   - 送信は受け取り（receipts）で冪等にする（応答が失われたまま読み直しても二重に送らない）
// 送る前の確かめ（編集中・シェル・書けない待ち・設定の保存待ち・/compact）と、送った後の欄の片付けは呼び出し側が持つ。
// 状態（送信中の集合・受け取り・予定の印）は入力欄ごとに呼び出し側が渡す（会話の id で引く）。
export const NL = String.fromCharCode(10);

/** 本文と添付から、エージェントへ送る文を作る。文中の印（[添付] パス）にある添付は足さず、無いものだけ末尾に印で足す */
export function composeSend({ text, attachments, inDoc, attachedKey, attachmentLine, agentLang }) {
  const tail = attachments.filter((a) => !inDoc.has(attachedKey(a.path)));
  return [String(text).trim(), tail.map((a) => attachmentLine(agentLang, a.path)).join(NL)].filter(Boolean).join(NL + NL);
}

/** 送る添付（画面の添付の札 → 送る形） */
export const sendAttachments = (ordered) => ordered.map((a) => ({ path: a.path, name: a.name, mime: a.mime ?? '' }));

/**
 * @param {object} d
 * @param {(key: string, args?: object) => string} d.t
 * @param {(command: string, args: object) => Promise<any>} d.cmd
 * @param {(op: string, args: object) => Promise<any>} d.limitOp
 * @param {() => string} d.randomId
 * @param {Map<string, object>} d.receipts 会話 id → 送りかけの要求（再読み込みを越えて持つ。saveReceipts で保存）
 * @param {() => void} d.saveReceipts
 * @param {(sessionId: string) => Promise<object[]>} d.refreshOutbox 送信待ちを読み直す
 * @param {(sessionId: string) => void} d.scheduled 予定を置いた（時刻のチップを外す）
 * @param {(sessionId: string, text: string, attachments: object[]) => Promise<void>} d.clearSent 送った分の下書きを片付ける
 * @param {(sessionId: string, request: object, full: string, ordered: object[]) => void} d.beforeSend 送る前に仮の添付を覚える
 * @param {(sessionId: string, request: object, full: string) => void} d.afterSend 送った後の仮の行
 * @param {(text: string) => void} d.say 理由の一行（成功のときは ''）
 */
export function createSender(d) {
  let scheduleAttempt = null;   // 予定を置く応答が届かず送り直しても、同じ予定を二重に作らない
  return {
    /**
     * 1 通送る。失敗は投げる（呼び出し側が理由の一行にする）。成功か「すでに届いていた」なら true、何も送らなかったなら false
     * @param {object} o
     * @param {string} o.sessionId 送る先の会話
     * @param {string} o.text 欄の本文
     * @param {object[]} o.ordered 添付の札（並び順）
     * @param {number|null} [o.at] 日時を指定した送信
     * @param {string} o.agentLang 添付の印を書く言語
     * @param {Set<string>} o.inDoc 文中の印の添付の鍵
     * @param {(path: string) => string} o.attachedKey
     * @param {(lang: string, path: string) => string} o.attachmentLine
     * @param {string} [o.cwd]
     * @param {string} [o.mode]
     */
    async send({ sessionId, text, ordered, at = null, agentLang, inDoc, attachedKey, attachmentLine, cwd, mode }) {
      const attachments = sendAttachments(ordered);
      const full = composeSend({ text, attachments, inDoc, attachedKey, attachmentLine, agentLang });
      const args = { sessionId, prompt: full, cwd: cwd || undefined, mode, ...(attachments.length ? { attachments } : {}) };
      // 日時を指定した送信は、送信待ちではなく予定として置く（時刻が来たら同じ送信待ちへ入る。core/send-schedule.mjs）
      if (at) {
        const key = `${sessionId}\n${full}\n${at}`;
        if (scheduleAttempt?.key !== key) scheduleAttempt = { key, messageId: d.randomId() };
        await d.limitOp('sessions.scheduleSend', { sessionId, prompt: full, at, messageId: scheduleAttempt.messageId,
          ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.mode ? { mode: args.mode } : {}), ...(attachments.length ? { attachments } : {}) });
        scheduleAttempt = null;
        d.scheduled(sessionId);
        await d.clearSent(sessionId, text, attachments);
        d.say('');
        return true;
      }
      const previous = d.receipts.get(sessionId);
      if (previous) {
        const known = (await d.refreshOutbox(sessionId)).find((m) => m.id === previous.messageId);
        if (!known && previous.prompt !== full) throw new Error(d.t('chat.send.unknownPrevious'));
        if (known && previous.prompt === full) {
          await d.clearSent(sessionId, text, attachments);
          d.receipts.delete(sessionId); d.saveReceipts();
          return true;
        }
      }
      const request = previous && previous.prompt === full ? previous : { ...args, messageId: d.randomId() };
      d.receipts.set(sessionId, request); d.saveReceipts();
      d.beforeSend(sessionId, request, full, ordered);
      await d.cmd('sendMessage', request);
      d.afterSend(sessionId, request, full);
      await d.clearSent(sessionId, text, attachments);
      d.receipts.delete(sessionId); d.saveReceipts();
      d.say('');
      return true;
    },
  };
}
