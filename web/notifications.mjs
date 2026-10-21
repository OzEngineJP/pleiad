// Live completions only: replayed history must never produce desktop alerts.
import { t } from './i18n.mjs';
import { savedTitle } from './saved-text.mjs';
import { approvalApps, approvalNotice } from './computer-use.mjs';
import { approvalChange, changeNotice } from './setting-change.mjs';

/** 人に見せない bot の会話（夜の整理・心拍。core/channels/types.mjs の HIDDEN_BOT_KINDS と同じ） */
const HIDDEN_BOT_KINDS = new Set(['learner', 'pulse']);

/** 押すと設定を開く通知の行き先（デスクトップ版の通知の押下で、会話の id の代わりに届く） */
const SETTINGS_TARGET = 'settings:';

/**
 * この PC の通知（デスクトップ版の OS 通知・ブラウザーの Notification）。
 * settings は設定 › 通知 › この PC（{ done, reply, failed }。切った種類は出さない）、
 * isViewing(sessionId) はその会話を今見ているか（見ている間は出さない。ADR 0086）、
 * isFocused() は Pleiad の窓を見て操作しているか（承認の窓が目の前に出るので、端末の追加の通知は出さない）、
 * openSettings(page) は設定のそのページを開く
 */
export function createCompletionNotifications({ host = window, openSession, openSettings = () => {}, settings = () => ({ done: true, reply: true, failed: true }),
  isViewing = () => false, isFocused = () => false }) {
  const seen = new Map();
  const seenReplies = new Set();
  let requested = false;
  const openTarget = id => String(id).startsWith(SETTINGS_TARGET) ? openSettings(String(id).slice(SETTINGS_TARGET.length)) : openSession(id);
  host.plyDesktop?.onNotificationClick?.(id => { void openTarget(id); });
  const show = notice => {
    try {
      if (host.plyDesktop?.notifyCompletion) {
        Promise.resolve(host.plyDesktop.notifyCompletion(notice)).catch(() => {});
      } else if (host.Notification?.permission === 'granted') {
        const notification = new host.Notification(notice.title, { body: notice.body,
          tag: notice.kind === 'reply' || notice.kind === 'device' ? `ply:${notice.kind}:${notice.noticeId}` : `ply:${notice.sessionId}` });
        notification.onclick = () => { notification.close(); host.focus(); void (notice.kind === 'device' ? openSettings('remote') : openSession(notice.sessionId)); };
      }
    } catch { /* Unsupported OS / denied permission must not affect the conversation. */ }
  };
  const body = title => String(title ? savedTitle(title) : t('notify.untitled')).slice(0, 200);
  return {
    requestPermission() {
      if (host.plyDesktop || requested || host.Notification?.permission !== 'default') return;
      requested = true;
      try { Promise.resolve(host.Notification.requestPermission()).catch(() => {}); } catch {}
    },
    completed(event, session, replay = false) {
      if (replay || event.type !== 'completionReady'
          || !event.sessionId || !Number.isFinite(event.completedAt)) return;
      if (session?.delegation) return;
      // bot の会話（server が completionReady の bot に種類を載せる。一覧にまだ無い会話もあるので、event を先に見る）。
      // 隠れた会話（夜の整理・心拍）は何も出さない。スレッド・DM・ルーティンの会話はスマホと同じく、完了は出さず失敗だけ出す（ADR 0109・0127）
      const bot = event.bot ?? session?.bot?.kind ?? null;
      const failed = event.outcome === 'error';
      if (HIDDEN_BOT_KINDS.has(bot) || (bot && !failed)) return;
      if (event.completedAt <= (seen.get(event.sessionId) ?? 0)) return;
      seen.set(event.sessionId, event.completedAt);
      // 失敗（outcome: error）は完了と別の種類。見ている間・切った種類は出さない（出さなかった分も、後から出し直さない）
      if (!(failed ? settings().failed : settings().done) || isViewing(event.sessionId)) return;
      const notice = { sessionId: event.sessionId, completedAt: event.completedAt, ...(failed ? { kind: 'failed' } : {}),
        title: failed ? t('notify.failed') : t('notify.completed'), body: body(session?.title) };
      show(notice);
    },
    waiting(event, session, replay = false) {
      if (replay || event.type !== 'permission' || !event.notifyReply || !event.id || !event.sessionId
          || seenReplies.has(event.id)) return;
      seenReplies.add(event.id);
      if (!settings().reply || isViewing(event.sessionId)) return;
      // コンピューターの操作のアプリの承認は、誰が何の許可を待っているかを見出しに出す（本文は会話の題）
      const computer = event.computerApp ? approvalApps(event.computerApp) : null;
      const change = event.settingChange ? approvalChange(event.settingChange) : null;
      show({ kind: 'reply', noticeId: event.id, sessionId: event.sessionId,
        title: computer ? approvalNotice(computer) : change ? changeNotice(change) : t('notify.waitingReply'), body: body(session?.title || event.conversationTitle) });
    },
    /**
     * 新しい端末が承認を待っている（remotePairing の request。ADR 0248）。ホストの画面だけが呼ぶ。
     * あなた待ちの一つなので「返事待ち」の設定に従う。押すと 設定 › リモート（承認の窓もそこに出ている）
     */
    deviceWaiting(request) {
      if (!request?.id || seenReplies.has(`device:${request.id}`)) return;
      seenReplies.add(`device:${request.id}`);
      if (!settings().reply || isFocused()) return;
      const name = String(request.name || t('settings.remote.devices.unnamed')).slice(0, 100);
      show({ kind: 'device', noticeId: request.id, sessionId: `${SETTINGS_TARGET}remote`, title: t('notify.deviceWaiting'), body: t('notify.deviceBody', { name }) });
    },
  };
}
