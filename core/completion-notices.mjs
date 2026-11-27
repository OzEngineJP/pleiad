// A completed turn can leave delegated work or a background command running.
// Keep its notice until the conversation is idle, including when no new turn follows.
export const hasPendingChild = tasks => tasks.some(r =>
  ['queued', 'running', 'cancelling'].includes(r.status)
  || ['pending', 'delivering'].includes(r.notification)
  || (['completed', 'failed'].includes(r.status) && r.notification === 'none'));

/**
 * ターンの終わりを、会話が落ち着いてから 1 回だけ知らせる。正常終了（ok）と失敗（error）が対象で、中断は知らせない。
 * send は画面へ（届け先が居なければ false を返し、次に誰かがつながったとき届ける）。
 * ready は離れた端末への通知用で、画面が居るかによらず、落ち着いた時点で 1 回だけ呼ぶ（ADR 0086）。
 * info.startedAt は 30 秒未満のターンを通知から外すために ready へ渡す。info.uuid はターンの最後の発言の id で、通知の一覧の飛び先（ADR 0149）として ready へ渡す。info.bot は bot の会話の種類（sidecar の bot.kind）で、画面への completionReady に `bot` として載せる。
 */
export function createCompletionNotices({ busy, send, ready = () => {}, prepareChannelPost }) {
  const pending = new Map();
  const flush = (sessionId) => {
    const entry = pending.get(sessionId);
    if (!entry || (!entry.prepared && busy(sessionId))) return false;
    if (entry.channelPost && !entry.prepared) {
      if (entry.preparing) return false;
      entry.preparing = true;
      void prepareChannelPost(sessionId, entry.channelPost).then(post => {
        if (pending.get(sessionId) !== entry) return;
        if (!post) { pending.delete(sessionId); return; }
        entry.channelPost = post;
        entry.completedAt = post.completedAt;
        entry.prepared = true;
        deliver(sessionId, entry);
      }).catch(() => { if (pending.get(sessionId) === entry) pending.delete(sessionId); });
      return false;
    }
    return deliver(sessionId, entry);
  };
  const deliver = (sessionId, entry) => {
    const { startedAt, uuid, bot } = entry;
    const event = {
      completedAt: entry.completedAt, outcome: entry.outcome,
      ...(entry.channelPost ? { channelPost: entry.channelPost } : {}),
    };
    if (!entry.pushed) {
      entry.pushed = true;
      try { ready({ sessionId, ...event, startedAt, uuid }); } catch { /* 離れた端末への通知の失敗で画面の通知を止めない */ }
    }
    if (!send({ type: 'completionReady', sessionId, ...event, ...(bot ? { bot } : {}) })) return false;
    pending.delete(sessionId);
    return true;
  };
  return {
    finished(sessionId, outcome, completedAt, info = {}) {
      if (!sessionId) return;
      if ((outcome === 'ok' || outcome === 'error') && Number.isFinite(completedAt)) {
        const previous = pending.get(sessionId);
        pending.set(sessionId, { completedAt, outcome, startedAt: previous?.channelPost && !previous.pushed && info.channelPost
          ? previous.startedAt ?? info.startedAt : info.startedAt, bot: info.bot, uuid: info.uuid ?? null, channelPost: info.channelPost, pushed: false });
      }
      flush(sessionId);
    },
    changed(sessionId) {
      if (sessionId) flush(sessionId);
      else for (const id of pending.keys()) flush(id);
    },
    /** 会話を消した（sessions.delete。ADR 0147）。まだ知らせていない完了を捨てる */
    forget(sessionId) { pending.delete(sessionId); },
  };
}

/**
 * 走っているターンへ、完了通知（依頼元のターン。ADR 0057）や追加指示（子のターン。ADR 0065）を途中送信（control.steer）で渡してよいか。
 * 人間の送信待ち（unsent）を優先し、次ターンの設定が予約されている会話（outbox も途中送信を断る）・圧縮のターン・
 * 中断や終了に向かっているターン・途中送信を持たないバックエンドには渡さない
 */
export function canSteerNotice(turn, { unsent, nextSettings }) {
  if (!turn || turn.ac?.signal?.aborted || turn.outcome || turn.compactTrigger || typeof turn.control?.steer !== 'function') return false;
  return !unsent && !nextSettings;
}
