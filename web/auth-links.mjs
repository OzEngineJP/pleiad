// ログインを待っている間の、ログインの画面への入口（設定のカード・初回の案内・会話の失敗の行。docs/design-system.md「ログインを待っている間」、ADR 0243）。
// ブラウザーが別のプロフィールで開いた・閉じてしまったときに、開き直すかリンクを写して続けられるようにする。
// URL（http(s)）なら［ログインの画面を開く］［リンクをコピー］、端末で打つコマンド（Grok・Devin・Antigravity・OpenCode）ならコマンドと［コピー］。
// URL はサーバー経由とはいえ外から来うるので、http(s) と確かめたものだけリンクにする
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

/** 写した結果をボタンの字で少しだけ見せて戻す（label・done は訳した字） */
function copyButton(text, label, done, cls) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = async (e) => {
    e.stopPropagation();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 下で失敗を出す */ }
    b.textContent = ok ? done : t('timeline.code.copyFailed');
    clearTimeout(b.copyTimer);
    b.copyTimer = setTimeout(() => { b.textContent = label; }, 1600);
  };
  return b;
}

/** url はログインの URL か端末で打つコマンド。無ければ null。cls はボタンの class（会話の失敗の行は字のボタン） */
export function authLinks(url, { cls = 'btn' } = {}) {
  const value = String(url ?? '');
  if (!value) return null;
  const row = el('div', 'auth-links');
  if (/^https?:\/\//i.test(value)) {
    const open = el('a', cls, t('settings.agents.openLoginPage'));
    open.href = value; open.target = '_blank'; open.rel = 'noreferrer';
    open.onclick = (e) => e.stopPropagation();   // 初回の案内の行（radio）の選択を動かさない
    row.append(open, copyButton(value, t('settings.agents.copyLink'), t('settings.agents.linkCopied'), cls));
  } else {
    row.append(el('code', null, value), copyButton(value, t('settings.agents.copyCommand'), t('settings.agents.commandCopied'), cls));
  }
  return row;
}
