// 登録した Claude アカウントの claude.ai のコネクター（ADR 0340 段 3）で止まった会話の、失敗の行の中身。
// 止めた理由の一文と、直す入口・［取り消す］を出す（docs/design-system.md「登録した Claude アカウントごとの claude.ai のコネクター」）。
//   - 直す入口: 未ログイン・ログイン切れ → ［claude.ai にログイン］、
//     共有の設定フォルダーへの反映の失敗・Mac のキーチェーンを開けない（ロックの解除の後） → ［再送する］、
//     Mac でログインが断られた（ロックか取り消し） → ［再送する］と［claude.ai にログインし直す］。版・OS・ssh からの起動・環境変数・settings.json・履歴の置き場は直す入口が無い（一文で直し方を書く）
//   - ログインが済んだら、発言は渡っていない・ターンで何も出ていないので自動でもう一度送る（「✓ claude.ai にログインし直して、もう一度送りました」）
//   - ［コネクターをオフにして送る］は出さない。ADR 0352 から、コネクターをオフにしたアカウントも同じ条件で止まるため
// 置き場は 2 つ: 送れなかった発言の下（layout: 'outbox'。発言は会話の中の吹き出しに戻っていて、その下の 1 行になる）と、
// ターンの途中で切れたときの会話の失敗の行（layout: 'sys'。.m.sys.turn-failed）。動き（ログイン・送り直し）は呼び手（web/client.mjs）が渡す
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

const KEYS = ['login', 'version', 'platform', 'env', 'settings', 'history', 'profile', 'ownDirLogin', 'ownDirLinks', 'ownDirLinksWindows', 'ownDirProfile', 'keychain', 'keychainAuth', 'ssh'];
const FIX = { login: 'login', profile: 'resend', ownDirLogin: 'login', ownDirProfile: 'resend', keychain: 'resend', keychainAuth: 'resend' };
// 主の入口のあとに並べる 2 つ目の入口。Mac でログインが断られたとき（keychainAuth）は、ロックの解除の後の再送を主に、
// 解除しても続くとき（サーバー側の取り消しかもしれない。ADR 0351 の M6 は未確認）のログインし直しも出す
const FIX_ALSO = { keychainAuth: 'relogin' };

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
 * on: { login() → Promise<'done'|'error'|'cancelled'>, resend({ auto }) → Promise<boolean>, cancel()? , spinner() }
 */
// i18n-dynamic: chat.connectorsFail.fix.
// i18n-dynamic: chat.connectorsFail.done.
export function paintConnectorsFailure(node, { ce, name = '', layout = 'outbox', on = {} }) {
  const key = connectorsFailKey(ce);
  const fix = FIX[key] ?? null;
  const also = FIX_ALSO[key] ?? null;
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
    if (also) items.push(button(t(`chat.connectorsFail.fix.${also}`), () => runFix(also, 'also'), false, 'also'));
    if (on.cancel) items.push(button(t('chat.connectorsFail.cancel'), (b) => { b.disabled = true; on.cancel(); }, false, 'cancel'));
    acts.replaceChildren(...items);
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
  async function runFix(which = fix, data = 'fix') {
    const back = hadFocus() ? data : '';
    if (which === 'resend') { await resendAfter('resend', back); return; }
    if (phase === 'waiting') { on.login?.(); return; }   // 面を閉じてしまったときに開き直す（待ちは前のまま）
    paint('waiting');
    let r;
    try { r = await on.login?.(); } catch { r = 'error'; }
    if (!node.isConnected || phase !== 'waiting') return;
    if (r === 'done') await resendAfter(which, back);
    else paint('failed', { error: r === 'error' ? t('chat.connectorsFail.loginFailed') : '', focus: back });
  }

  paint('failed');
  return { get phase() { return phase; } };
}
