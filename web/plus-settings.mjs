// 設定 › Pleiad Plus（docs/plus.md「設定 › Pleiad Plus」）。ログイン・プラン・今月の利用・アカウントの管理・ログアウト。
// 状態はサーバーが持つ（plusStatus コマンドと、変わるたびに届く plusStatus イベント）。
// この画面は表示と、B1 のコマンド（plusLogin・plusLoginCancel・plusLogout・plusHostRebind）を送ることだけをする。
// 見た目の部品は設定 › リモートと同じ（web/remote-parts.mjs、web/manage-panel.css の .rm-*）。見出しの丸は .rm-av。
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';
import { button, rmIcon, keyValues, errorLine, waitLine, paintInto } from './remote-parts.mjs';
import { openExternalLink } from './link-open.mjs';

/** ボタン。外のブラウザーで開くものは外へのリンクの印を付ける */
function actButton(text, onclick, className, { external = false, fk } = {}) {
  const b = button(text, onclick, className);
  if (fk) b.dataset.fk = fk;
  if (external) b.append(rmIcon('external'));
  return b;
}

/** 丸の中にメールの頭の 1 文字（大文字） */
function avatar(email) {
  const letter = String(email ?? '').trim().charAt(0).toUpperCase() || '?';
  return el('span', 'rm-av', letter);
}

/** アカウントの行: 丸・メール・その下に入り方（google.com のときだけ） */
function accountRow(account) {
  const row = el('div', 'rm-row');
  const text = el('span', 'rm-rt');
  text.append(el('span', 'rm-nm rm-strong', account?.email ?? ''));
  if (account?.provider === 'google.com') text.append(el('span', 'rm-sub', t('settings.plus.providerGoogle')));
  row.append(avatar(account?.email), text);
  return row;
}

const plusUrl = account => `${String(account ?? '').replace(/\/+$/, '')}/plus`;

/**
 * 状態から DOM を作る純粋な関数（tests/unit/plus-settings.mjs が tests/lib/dom-stub.mjs で動かす）。
 * @param status  plusStatus の形（docs/plus.md「状態と知らせ」）
 * @param send    WS コマンドを送る受け手（'plusLogin'・'plusLoginCancel'・'plusLogout'・'plusHostRebind'）
 * @param openExternal  URL を外のブラウザーで開く受け手
 * @param askRebind / cancelRebind  「つなぎ直す」の確かめの出し入れ（画面の中だけの状態）
 * @param confirming  確かめを出しているか
 */
export function renderPlus(status, { send = () => {}, openExternal = () => {}, askRebind = () => {}, cancelRebind = () => {}, confirming = false } = {}) {
  const s = status ?? {};
  const account = s.account ?? null;
  const out = [];
  // 届かないときは、当てはまった中身（最後に知ったアカウント）の上に 1 行（⚠ は付けない）
  if (s.reachable === false) out.push(el('p', 'rm-warn', t('settings.remote.failed')));

  if (s.needsUpdate) {
    out.push(el('p', 'rm-warn', t('settings.plus.needsUpdate')));
    return out;
  }
  if (s.state === 'maintenance') {
    out.push(el('p', 'rm-warn', t('settings.plus.maintenance')));
    if (s.signedIn && account) out.push(el('div', 'rm-gh', t('settings.plus.account')), accountRow(account));
    return out;
  }
  const phase = s.login?.phase;
  if (phase === 'waiting' || phase === 'finishing') {
    out.push(waitLine(t('settings.plus.signingIn')));
    const acts = el('div', 'rm-acts');
    acts.append(actButton(t('settings.plus.cancel'), () => send('plusLoginCancel'), 'btn', { fk: 'cancel' }));
    out.push(acts);
    return out;
  }
  if (phase === 'failed') {
    out.push(errorLine(t('settings.plus.signInFailed')));
    const acts = el('div', 'rm-acts');
    acts.append(actButton(t('settings.plus.tryAgain'), () => send('plusLogin'), 'btn btn-primary', { fk: 'retry' }));
    out.push(acts);
    return out;
  }
  if (s.error?.code === 'locked') {
    // API キーの画面が保管を読めないときに出す文言（mcp.state.locked）
    out.push(el('p', 'rm-warn', t('mcp.state.locked')));
    return out;
  }
  if (!s.signedIn) {
    out.push(el('div', 'rm-gh', t('settings.plus.account')));
    const row = el('div', 'rm-mrow');
    row.append(el('span', 'rm-lbl rm-plain', s.error?.code === 'relogin' ? t('settings.plus.relogin') : t('settings.plus.signedOut')),
      actButton(t('settings.plus.signIn'), () => send('plusLogin'), 'btn btn-primary', { external: true, fk: 'login' }));
    out.push(row);
    return out;
  }

  // ---- ログインしている ----
  out.push(el('div', 'rm-gh', t('settings.plus.account')));
  out.push(accountRow(account));
  if (account?.status === 'disabled') {
    out.push(el('p', 'rm-warn', t('settings.plus.disabled')));
    const acts = el('div', 'rm-acts');
    acts.append(actButton(t('settings.plus.signOut'), () => send('plusLogout'), 'btn', { fk: 'logout' }));
    out.push(acts);
    return out;
  }
  const planName = account?.status === 'plus' ? (account?.plan?.name || 'Pleiad Plus') : t('settings.plus.free');
  out.push(keyValues([[t('settings.plus.plan'), planName]]));

  if (account?.status === 'plus' && account?.usage && account?.limits) {
    const num = new Intl.NumberFormat(lang);
    const used = num.format(account.usage.credits ?? 0), limit = num.format(account.limits.creditsPerMonth ?? 0);
    const date = account.usage.resetAt ? new Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric' }).format(new Date(account.usage.resetAt)) : '';
    out.push(el('p', 'rm-weak', t('settings.plus.usage', { used, limit, date })));
    if ((account.usage.credits ?? 0) >= (account.limits.creditsPerMonth ?? Infinity)) out.push(el('p', 'rm-warn', t('settings.plus.limitReached')));
  }
  // 同期の置き場。中身と見出しは同期の画面の issue が入れる（この issue では隠した入れ物だけ）
  const sync = el('div', null);
  sync.id = 'plusSyncSection';
  sync.hidden = true;
  sync.append(el('div', 'rm-gh', t('settings.plus.sync')));
  out.push(sync);

  // この PC の行（host は B4 が埋める。null なら出さない）
  if (s.host?.state === 'taken') {
    out.push(el('p', 'rm-warn', t('settings.plus.hostTaken')));
    if (confirming) {
      // 確かめの窓は今の設定の画面の確かめと同じ作り（.rm-confirm）
      const box = el('div', 'rm-confirm');
      box.append(el('p', null, t('settings.plus.rebindConfirm')));
      const acts = el('div', 'rm-acts');
      acts.append(actButton(t('settings.plus.cancel'), cancelRebind, 'btn btn-quiet', { fk: 'rebindNo' }),
        actButton(t('settings.plus.rebindYes'), () => send('plusHostRebind'), 'btn btn-primary', { fk: 'rebindYes' }));
      box.append(acts);
      out.push(box);
    } else {
      const acts = el('div', 'rm-acts');
      acts.append(actButton(t('settings.plus.rebind'), askRebind, 'btn btn-quiet', { fk: 'rebind' }));
      out.push(acts);
    }
  } else if (s.host?.state === 'limit') {
    out.push(el('p', 'rm-warn', t('settings.plus.hostLimit')));
  }

  const acts = el('div', 'rm-acts');
  if (account?.status === 'free' && s.urls?.account) acts.append(actButton(t('settings.plus.getPlus'), () => openExternal(plusUrl(s.urls.account)), 'btn btn-primary', { external: true, fk: 'getPlus' }));
  if (s.urls?.account) acts.append(actButton(t('settings.plus.manage'), () => openExternal(s.urls.account), 'btn btn-quiet', { external: true, fk: 'manage' }));
  acts.append(actButton(t('settings.plus.signOut'), () => send('plusLogout'), 'btn', { fk: 'logout' }));
  out.push(acts);
  return out;
}

/**
 * @param cmd  WS コマンド
 * @param page 設定のページを切り替える（onboarding.page）
 */
export function setupPlusSettings({ cmd, page, getPrefs = () => ({}) }) {
  const $ = id => document.getElementById(id);
  const root = $('plusPanel'), tab = $('plusTab');
  let status = null;
  /** 「つなぎ直す」の確かめ中か・操作中か・画面に出す失敗 */
  let confirming = false, busy = false, message = '';
  /** ログインで委譲と通話に plus が自動で選ばれた案内を出す（閉じたら prefs.plus.autoNoticeSeen に書いて二度と出さない） */
  let autoNotice = false;

  function paint() {
    // status.available === false のときはメニューの項目ごと出さない（ページにも行けない）
    if (status) tab.hidden = status.available === false;
    const sig = JSON.stringify([status, confirming, busy, message, autoNotice]);
    paintInto(root, sig, () => {
      const nodes = renderPlus(status, { send, openExternal: openExternalLink, askRebind, cancelRebind, confirming });
      if (autoNotice) nodes.unshift(autoNoticeRow());
      if (message) nodes.push(errorLine(message));
      return nodes;
    });
  }

  /** 「委譲先の自動選択と音声通話に Pleiad Plus を使います」の 1 度きりの案内（閉じると出さない） */
  function autoNoticeRow() {
    const box = el('div', 'mp-card');
    const row = el('div', 'mp-row');
    const info = el('div', 'mp-card-info');
    info.append(el('small', null, t('settings.plus.autoNotice')));
    row.append(info);
    const close = el('button', 'btn btn-quiet', t('voice.note.close'));
    close.type = 'button';
    close.onclick = () => {
      autoNotice = false;
      cmd('setPref', { key: 'plus', value: { ...(getPrefs().plus ?? {}), autoNoticeSeen: true } }).catch(() => {});
      paint();
    };
    row.append(el('div', 'mp-card-actions', close));
    box.append(row);
    return box;
  }

  function askRebind() {
    confirming = true;
    paint();
    queueMicrotask(() => root.querySelector('[data-fk="rebindNo"]')?.focus());
  }
  function cancelRebind() { confirming = false; paint(); }

  async function send(command) {
    if (busy) return;
    busy = true; message = '';
    if (command === 'plusHostRebind') confirming = false;
    paint();
    try {
      const next = await cmd(command);
      if (next && typeof next === 'object' && 'signedIn' in next) status = next;
    } catch (e) {
      // plusHostRebind は B4 が作る。B4 が入る前の「知らないコマンド」は何も出さない
      if (command !== 'plusHostRebind') message = e.message;
    } finally { busy = false; paint(); }
  }

  async function refresh() {
    try { status = await cmd('plusStatus', { refresh: true }); }
    catch (e) { message = e.message; }
    paint();
  }
  function event(ev) {
    if (ev?.type === 'apiKeysChanged') {
      // ログインで委譲と通話の両方に plus が自動で選ばれた（core/api-keys.mjs の onChange の autoPlus）
      if (ev.autoPlus === true && !getPrefs().plus?.autoNoticeSeen) { autoNotice = true; paint(); }
      return;
    }
    if (ev?.type !== 'plusStatus') return;
    status = ev.status ?? status;
    paint();
  }

  $('plusTab').onclick = () => { page('plus'); refresh(); };
  // メニューの出し入れのために起動時に 1 回取る
  cmd('plusStatus').then(s => { status = s; paint(); }).catch(() => {});
  paint();
  return { refresh, event, get status() { return status; } };
}
