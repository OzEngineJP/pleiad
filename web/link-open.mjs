// Shared destination for external links from the app (conversation, work dialog, side panel documents) and preview frames.
// They always go to the default browser: on the desktop host screen through the shell (ply:open-external, which also
// takes http for localhost), elsewhere as a new tab. Pleiad's own pages open in the conversation's Chrome tab (ADR 0294).
/** デスクトップ版のホストの画面か（殻が既定のブラウザーへ渡す口を持つ）。リモートの窓は持たない */
export const desktopHost = () => typeof window !== 'undefined' && typeof window.plyDesktop?.openExternal === 'function' && !window.plyRemote;

/** 既定のブラウザーで開く。http/https だけ（ユーザー名・パスワード付きは断る） */
export function openExternalLink(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  // The desktop window refuses new windows and only passes https on; the shell's open-external also takes http (localhost).
  if (desktopHost()) {
    Promise.resolve(window.plyDesktop.openExternal(parsed.href)).catch(() => {});
    return true;
  }
  const link = document.createElement('a');
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow';
  document.body.append(link);
  try { link.click(); } finally { link.remove(); }
  return true;
}

/** アプリの中の外部リンク（http/https）。文中の URL・名前付きのリンク・取得の見出し。ファイルリンクは含まない（target が無い） */
export const APP_LINK = 'a.md-link[target="_blank"]';
export function appLinkOf(node) {
  const link = node?.closest?.(APP_LINK);
  return link && /^https?:\/\//i.test(link.getAttribute('href') || '') ? link : null;
}

export function handlePreviewLinkMessage(event) {
  if (event.data?.type !== 'ply-preview-open-link' || typeof event.data.url !== 'string' ||
      typeof event.data.newWindow !== 'boolean') return false;
  for (const frame of document.querySelectorAll('iframe.visualize-frame')) {
    if (frame.contentWindow === event.source) return openExternalLink(event.data.url);
  }
  return false;
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('message', handlePreviewLinkMessage);
  const conversationLink = event => {
    // Already handled (e.g. web/host-only-links.mjs stops localhost links on remote screens)
    if (event.defaultPrevented) return null;
    return appLinkOf(event.target);
  };
  document.addEventListener('click', event => {
    const link = conversationLink(event);
    if (!link) return;
    event.preventDefault();
    openExternalLink(link.href);
  });
  // Middle click fires auxclick, not click
  document.addEventListener('auxclick', event => {
    if (event.button !== 1) return;
    const link = conversationLink(event);
    if (!link) return;
    event.preventDefault();
    openExternalLink(link.href);
  });
}
