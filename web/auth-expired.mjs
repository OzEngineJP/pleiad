// 会話の中の「ログインの期限切れ」の失敗の行（#53。docs/design-system.md「ログインの期限切れ」、ADR 0212）。
// ターンが 401（turnResult の kind: 'auth'。server が auth: { mode: cli | token } を添える）で失敗したときだけ、
// ふつうの「✕ 失敗 <エラー文>」の代わりに、何が切れたかの一文と直す入口を出す:
//   - CLI のログイン（mode: cli）: ［ログインし直す］（設定の「ログイン」と同じ authLogin）→ 回る印と「ブラウザーでログインしてください…」・［キャンセル］
//     → 済んだら、この行から始めた・失敗したターンで何も出ていない（pristine）・前と同じアカウント、がそろえば自動でもう一度送り
//       （「✓ ログインし直して、もう一度送りました」）、そろわなければ「✓ ログインしました」と［もう一度送る］
//   - Pleiad の Claude のアカウントのトークン（mode: token）: ［トークンを再発行］（Claude のアカウントの面を開いて再発行を始める）。自動では送らない
//   - リモートの窓は CLI のログインを始めない（ログインの戻り先はホストの PC）。ボタンの代わりに remote.loginOnHost の一文
// 行は会話の流れの中だけ（ほかの失敗の行と同じく、開き直すと出ない）。動き（ログイン・送り直し・面を開く）は呼び手（web/client.mjs）が渡す
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

/** 「✕ 失敗」に続く一文。agent はエージェントの名前（Claude Code）、accountName は名前が添えられていないときの控え（アカウントの一覧） */
export function authFailureMessage(auth, { agent = '', accountName = '' } = {}) {
  if (auth?.mode === 'account') return t('chat.authExpired.account', { agent, name: auth.name || accountName });
  if (auth?.mode === 'token') {
    const name = auth.name || accountName;
    return name ? t('chat.authExpired.token', { name }) : t('chat.authExpired.tokenUnnamed');
  }
  return auth?.email ? t('chat.authExpired.login', { agent, email: auth.email }) : t('chat.authExpired.loginNoEmail', { agent });
}

/**
 * ログインし直したあと、失敗した発言を自動でもう一度送るか。3 つがそろったときだけ:
 * この行の［ログインし直す］から始めた（fromRow）・失敗したターンでツールの実行も返答も出ていない（pristine）・
 * ログインし直したアカウントが前と同じ（before・after のメールアドレス。どちらかが分からなければ送らない）
 */
export function shouldAutoResend({ fromRow = false, pristine = false, before = null, after = null } = {}) {
  return Boolean(fromRow && pristine === true && before && after && String(before) === String(after));
}

/**
 * 失敗の行を描く。node は会話の出来事の行（.m.sys）。返すのは { signedIn() }: ほか（設定）からのログインが済んだと伝える口
 * opts:
 *   auth, pristine, agent, accountName, before（失敗した時点のアカウント）, remote（リモートの窓）
 *   login() → Promise<{ account }>（authLogin。失敗は reject、取り消しは code: 'CANCELLED'）, cancel()
 *   resend({ auto }) → Promise<boolean>（送れたら true）, reissue()（トークンの再発行を始める）, spinner()（回る印。web/arc.mjs の runMark）
 */
export function paintAuthFailure(node, opts) {
  const { auth, pristine = false, agent = '', accountName = '', before = null, remote = false, login, cancel, resend, reissue, spinner = () => el('span') } = opts;
  node.classList.add('turn-failed', 'auth-fail');
  const head = el('div');
  head.append(el('b', null, t('timeline.result.failed')), document.createTextNode(` ${authFailureMessage(auth, { agent, accountName })}`));
  const acts = el('div', 'acts');
  acts.setAttribute('role', 'status');
  node.replaceChildren(head, acts);
  let phase = 'expired';

  const button = (label, onClick, primary = false) => {
    const b = el('button', primary ? 'btn btn-primary' : 'btn', label);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    return b;
  };
  const paint = (next, { error = '' } = {}) => {
    phase = next;
    acts.classList.remove('fade');
    void acts.offsetWidth;   // 状態が替わるたびに、短い出し入れ（.fade）をやり直す
    if (next !== 'expired') acts.classList.add('fade');
    if (auth?.mode === 'account') {
      acts.replaceChildren(button(t('chat.authExpired.openAccounts'), () => reissue?.(), true));
      return;
    }
    if (auth?.mode === 'token') {
      acts.replaceChildren(button(t('chat.authExpired.reissue'), () => reissue?.(), true));
      return;
    }
    if (next === 'expired') {
      if (remote) { acts.replaceChildren(el('span', 'auth-fail-note', t('remote.loginOnHost'))); return; }
      acts.replaceChildren(button(t('chat.authExpired.signInAgain'), () => start(), true));
      if (error) acts.append(el('span', 'auth-fail-note', error));
    } else if (next === 'waiting') {
      const wait = el('span', 'wait');
      wait.append(spinner(), el('span', null, t('chat.authExpired.waiting')));
      acts.replaceChildren(wait, button(t('chat.authExpired.cancel'), (b) => { b.disabled = true; cancel?.(); }));
    } else if (next === 'resending') {
      acts.replaceChildren(el('span', null, t('chat.authExpired.signedIn')));
    } else if (next === 'resent') {
      acts.replaceChildren(el('span', null, t('chat.authExpired.resent')));
    } else if (next === 'manual') {
      acts.replaceChildren(el('span', null, t('chat.authExpired.signedIn')), button(t('chat.authExpired.sendAgain'), async (b) => {
        b.disabled = true;
        const sent = await resend?.({ auto: false }).catch(() => false);
        if (!sent && b.isConnected) b.disabled = false;
      }, true));
      if (error) acts.append(el('span', 'auth-fail-note', error));
    }
  };

  async function start() {
    if (phase === 'waiting' || !login) return;
    paint('waiting');
    let after;
    try { after = await login(); }
    catch (e) {
      if (!node.isConnected) return;
      paint('expired', { error: e?.code === 'CANCELLED' ? '' : t('chat.authExpired.loginFailed', { error: e?.message ?? '' }) });
      return;
    }
    if (!node.isConnected) return;
    if (!shouldAutoResend({ fromRow: true, pristine, before, after: after?.account })) { paint('manual'); return; }
    paint('resending');
    const sent = await resend?.({ auto: true }).catch(() => false);
    // 送り直すと、この行は消えた範囲（巻き戻した発言の後ろ）に入る。呼び手が送り直した発言の手前に「送りました」の行を置く
    if (node.isConnected) paint(sent ? 'resent' : 'manual');
  }

  paint('expired');
  return {
    get phase() { return phase; },
    /** 設定やほかの窓からログインが済んだ。自動では送らず［もう一度送る］にする（期限切れのまま待っている行だけ） */
    signedIn() { if (phase === 'expired' && auth?.mode === 'cli' && node.isConnected) paint('manual'); },
  };
}

/** 自動で送り直したあと、送り直した発言の手前に置く一行（元の失敗の行は巻き戻した範囲と一緒に消える） */
export function resentNote(auth, { agent = '' } = {}) {
  const node = el('div', 'm sys turn-failed auth-fail');
  const head = el('div');
  head.append(el('b', null, t('timeline.result.failed')), document.createTextNode(` ${authFailureMessage(auth, { agent })}`));
  const acts = el('div', 'acts', t('chat.authExpired.resent'));
  acts.setAttribute('role', 'status');
  node.append(head, acts);
  return node;
}
