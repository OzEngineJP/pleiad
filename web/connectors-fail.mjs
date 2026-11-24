// 登録した Claude アカウントの claude.ai のコネクター（ADR 0340 段 3）で止まった会話の、失敗の行の中身。
// 止めた理由の一文と、直す入口・［コネクターをオフにして送る］・［取り消す］を出す（docs/design-system.md「登録した Claude アカウントごとの claude.ai のコネクター」）。
//   - 直す入口: ログイン切れ・設定の破損 → ［claude.ai にログインし直す］、未ログイン → ［claude.ai にログイン］、持ち主の不一致 → ［アカウントを開く］、
//     共有の設定フォルダーへの反映の失敗・Mac のキーチェーンを開けない（ロックの解除の後） → ［再送する］。版・OS・環境変数・settings.json・履歴の置き場は直す入口が無い（オフにして送るが塗り）
//   - ログインが済んだら、発言は渡っていない・ターンで何も出ていないので自動でもう一度送る（「✓ claude.ai にログインし直して、もう一度送りました」）
//   - ［コネクターをオフにして送る］は、そのアカウントのスイッチを切って（同じアカウントのほかの会話にも効く。横に一文で書く）送り直す
// 置き場は 2 つ: 送れなかった発言の下（layout: 'outbox'。発言は送信待ちの「送れませんでした」に戻っている）と、
// ターンの途中で切れたときの会話の失敗の行（layout: 'sys'。.m.sys.turn-failed）。動き（ログイン・送り直し・スイッチ）は呼び手（web/client.mjs）が渡す
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

const KEYS = ['expired', 'login', 'owner', 'version', 'platform', 'env', 'settings', 'history', 'profile', 'format', 'ownDirLogin', 'ownDirLinks', 'ownDirLinksWindows', 'ownDirProfile', 'keychain'];
const FIX = { expired: 'relogin', format: 'relogin', login: 'login', owner: 'openAccount', profile: 'resend', ownDirLogin: 'login', ownDirProfile: 'resend', keychain: 'resend' };

/** 止めた理由の鍵（env の settings.json の分は settings） */
export function connectorsFailKey(ce) {
  const k = ce?.kind === 'env' && ce?.scope === 'settings' ? 'settings' : ce?.kind;
  return KEYS.includes(k) ? k : 'login';
}

/** 止めた理由の一文。name はアカウントの名前 */
// i18n-dynamic: chat.connectorsFail.why.
export function connectorsFailMessage(ce, name = '') {
  const p = ce?.params ?? {};
  return t(`chat.connectorsFail.why.${connectorsFailKey(ce)}`, { name: name || ce?.accountName || '', cli: p.cli ?? '?', sdk: p.sdk ?? '?', verified: p.verified ?? '?' });
}

/**
 * 失敗の行を描く。node は layout が 'outbox' なら発言の下の .outbox-status、'sys' なら会話の失敗の行（.m.sys）。
 * on: { login() → Promise<'done'|'error'|'cancelled'>, openAccount(), resend({ auto }) → Promise<boolean>, off() → Promise, cancel()? , spinner() }
 */
// i18n-dynamic: chat.connectorsFail.fix.
// i18n-dynamic: chat.connectorsFail.done.
export function paintConnectorsFailure(node, { ce, name = '', layout = 'outbox', on = {} }) {
  const key = connectorsFailKey(ce);
  const fix = FIX[key] ?? null;
  const who = name || ce?.accountName || '';
  const cause = connectorsFailMessage(ce, who);
  const acts = el('div', 'acts');
  acts.setAttribute('role', 'status');
  if (layout === 'sys') {
    node.classList.add('turn-failed', 'auth-fail');
    const head = el('div');
    head.append(el('b', null, t('timeline.result.failed')), document.createTextNode(` ${cause}`));
    node.replaceChildren(head, acts);
  } else {
    node.classList.add('outbox-fix', 'conn-fail');
    node.replaceChildren(el('div', 'fail-head', t('chat.delivery.failed')), el('div', 'fail-cause', cause), acts);
  }
  let phase = 'failed';
  const button = (label, onClick, primary = false, data = '') => {
    const b = el('button', primary ? 'btn btn-primary' : 'btn', label);
    b.type = 'button';
    if (data) b.dataset.fix = data;
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    return b;
  };
  const focusOn = (data) => acts.querySelector(`[data-fix="${data}"]`)?.focus();
  const hadFocus = () => acts.contains(document.activeElement) || document.activeElement === document.body;

  const paint = (next, { error = '', done = '', focus = '' } = {}) => {
    phase = next;
    if (next === 'done') { acts.replaceChildren(el('span', 'done', t(`chat.connectorsFail.done.${done}`, { name: who }))); return; }
    if (next === 'sending') { const s = el('span', 'wait'); s.append(on.spinner?.() ?? el('span'), el('span', null, t('chat.connectorsFail.sending'))); acts.replaceChildren(s); return; }
    const items = [];
    if (next === 'waiting') { const s = el('span', 'wait'); s.append(on.spinner?.() ?? el('span'), el('span', null, t('chat.connectorsFail.waiting'))); items.push(s); }
    if (fix) items.push(button(t(`chat.connectorsFail.fix.${fix}`), () => runFix(), next !== 'waiting', 'fix'));
    items.push(button(t('chat.connectorsFail.off'), () => runOff(), !fix, 'off'));
    if (on.cancel) items.push(button(t('chat.connectorsFail.cancel'), (b) => { b.disabled = true; on.cancel(); }, false, 'cancel'));
    acts.replaceChildren(...items, el('span', 'auth-fail-note', t('chat.connectorsFail.offNote', { name: who })));
    if (error) acts.append(el('span', 'auth-fail-note', error));
    if (focus) focusOn(focus);
  };

  async function resendAfter(done, focusBack) {
    paint('sending');
    let sent = false, error = '';
    try { sent = await on.resend?.({ auto: true }); } catch (e) { error = e?.message ?? ''; }
    if (!node.isConnected) return;
    if (sent) paint('done', { done });
    else paint('failed', { error: error ? t('chat.connectorsFail.resendFailed', { error }) : '', focus: focusBack });
  }
  async function runFix() {
    const back = hadFocus() ? 'fix' : '';
    if (fix === 'openAccount') { on.openAccount?.(); return; }
    if (fix === 'resend') { await resendAfter('resend', back); return; }
    if (phase === 'waiting') { on.login?.(); return; }   // 面を閉じてしまったときに開き直す（待ちは前のまま）
    paint('waiting');
    let r;
    try { r = await on.login?.(); } catch { r = 'error'; }
    if (!node.isConnected || phase !== 'waiting') return;
    if (r === 'done') await resendAfter(fix, back);
    else paint('failed', { error: r === 'error' ? t('chat.connectorsFail.loginFailed') : '', focus: back });
  }
  async function runOff() {
    const back = hadFocus() ? 'off' : '';
    paint('sending');
    try { await on.off?.(); }
    catch (e) { if (node.isConnected) paint('failed', { error: t('chat.connectorsFail.offFailed', { error: e?.message ?? '' }), focus: back }); return; }
    await resendAfter('off', back);
  }

  paint('failed');
  return { get phase() { return phase; } };
}
