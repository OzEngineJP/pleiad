'use strict';
// pleiad:// リンクのうち、Pleiad Plus の入口をこの端末で出す印を変えるもの（docs/plus.md「入口を出すリンク」）。
//   pleiad://plus/enable   印を立てる（visibility: optin の間だけ効く）
//   pleiad://plus/disable  印を外す
// それ以外の pleiad://…（pleiad://pair など）と pleiad 以外は null。呼び出し側が今までどおり扱う・無視する

/** リンクの URL から 'enable' | 'disable' | null */
function plusLinkAction(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'pleiad:') return null;
  const seg = `${url.hostname || ''}${url.pathname || ''}`.replace(/\/+$/, '').toLowerCase();
  if (seg === 'plus/enable') return 'enable';
  if (seg === 'plus/disable') return 'disable';
  return null;
}

/** 起動・2 つ目の起動の argv から最初に見つかったリンクの動作（無ければ null） */
function plusLinkArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) { const action = plusLinkAction(arg); if (action) return action; }
  return null;
}

module.exports = { plusLinkAction, plusLinkArgv };
