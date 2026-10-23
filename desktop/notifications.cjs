// Kept outside the window lifecycle so duplicate renderer deliveries stay silent.
// 見出しは画面（web/notifications.mjs）が今の言語で作って渡す。無いときだけ main の言語の既定の文
const { t } = require('./i18n.cjs');

/**
 * 窓が実際に前面にあって見えているか。Windows の isFocused は、裏で起動して一度も前に出ていない窓でも true になるので、
 * foreground（OS の前面の窓の HWND）があれば、それとこの窓を比べる。無い OS・読めないときは isFocused まで
 */
function windowInFront(window, foreground = null) {
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !window.isFocused()) return false;
  if (!foreground) return true;
  try { return foreground() === Number(window.getNativeWindowHandle().readBigUInt64LE()); } catch { return false; }
}

/** isInFront() は Pleiad の窓が前面で見えているか（端末の追加の承認待ちは、承認の窓が目の前に出ているので通知しない） */
function createDesktopNotifications({ Notification, getWindow, icon, isInFront = () => false }) {
  const seen = new Map(), seenReplies = new Set(), live = new Set();
  return notice => {
    // 種類: 完了（kind なし）・返事待ち（reply）・失敗（failed。完了と同じく completedAt で重複を抑える）・
    // 端末の追加の承認待ち（device。noticeId で重複を抑え、sessionId には押したときに開く 設定 の行き先 settings:remote が入る）
    const reply = notice?.kind === 'reply' || notice?.kind === 'device';
    if (!notice || typeof notice.sessionId !== 'string' || !notice.sessionId || notice.sessionId.length > 500
        || typeof notice.body !== 'string' || (notice.kind && !reply && notice.kind !== 'failed')
        || (notice.kind === 'device' && notice.sessionId !== 'settings:remote')
        || (reply ? typeof notice.noticeId !== 'string' || !notice.noticeId || notice.noticeId.length > 500
          : !Number.isFinite(notice.completedAt))) return false;
    if ((reply ? seenReplies.has(notice.noticeId) : notice.completedAt <= (seen.get(notice.sessionId) ?? 0))
        || !Notification.isSupported() || (notice.kind === 'device' && isInFront())) return false;
    try {
      const title = typeof notice.title === 'string' && notice.title.trim() ? notice.title.slice(0, 200)
        : notice.kind === 'device' ? t('notifications.deviceWaiting') : reply ? t('notifications.waitingReply')
          : notice.kind === 'failed' ? t('notifications.failed') : t('notifications.completed');
      const notification = new Notification({ title, body: notice.body.slice(0, 200), icon });
      notification.on('click', () => {
        const window = getWindow();
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
        window.webContents.send('ply:notification-click', notice.sessionId);
      });
      const release = () => live.delete(notification);
      notification.on('close', release);
      notification.on('failed', release);
      live.add(notification);
      notification.show();
      if (reply) seenReplies.add(notice.noticeId);
      else seen.set(notice.sessionId, notice.completedAt);
      return true;
    } catch { return false; }
  };
}
module.exports = { createDesktopNotifications, windowInFront };
