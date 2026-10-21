// 設定 › Pleiad Plus（docs/plus.md「設定 › Pleiad Plus」）。ログイン・プラン・今月の利用・アカウントの管理・ログアウト。
// 状態はサーバーが持つ（plusStatus コマンドと、変わるたびに届く plusStatus イベント）。
// この画面は表示と、B1 のコマンド（plusLogin・plusLoginCancel・plusLogout・plusHostRebind）を送ることだけをする。
// 見た目の部品は設定 › リモートと同じ（web/remote-parts.mjs、web/manage-panel.css の .rm-*）。見出しの丸は .rm-av。
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';
import { button, rmIcon, keyValues, errorLine, waitLine, paintInto } from './remote-parts.mjs';
import { openExternalLink } from './link-open.mjs';
import { renderSync } from './plus-sync.mjs';
import { loadingMark } from './plus-key-row.mjs';

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

/**
 * プランの行の値。名前はサーバーの plan.name をそのまま出す（招待の人は「Pleiad Plus（招待）」）。
 * 「無料」は status が free と読めたときだけ。読み込み中は場所取り、読めなかったときは「読み込めませんでした」と「再試行」（承認 2026-10-21）
 */
export function planValue(s, { retrying = false, onRetry = () => {} } = {}) {
  const account = s?.account ?? null;
  if (account?.status === 'plus') return account.plan?.name || 'Pleiad Plus';
  if (account?.status === 'free') return t('settings.plus.free');
  if (account?.status) return account.plan?.name || '';
  if (s?.reachable === false && !retrying) {
    const box = el('span', 'rm-plan-failed');
    const retry = button(t('settings.plus.retry'), onRetry, 'btn btn-quiet');
    retry.dataset.fk = 'planRetry';
    box.append(el('span', 'rm-strong', t('settings.plus.loadFailed')), retry);
    return box;
  }
  return loadingMark();
}

// urls.account はパスを持ちうる（本番は <オリジン>/account）。/plus はパスの下ではなくオリジンの直下
const plusUrl = account => new URL('/plus', account).href;

/**
 * 状態から DOM を作る純粋な関数（tests/unit/plus-settings.mjs が tests/lib/dom-stub.mjs で動かす）。
 * @param status  plusStatus の形（docs/plus.md「状態と知らせ」）
 * @param send    WS コマンドを送る受け手（'plusLogin'・'plusLoginCancel'・'plusLogout'・'plusHostRebind'）
 * @param openExternal  URL を外のブラウザーで開く受け手
 * @param askRebind / cancelRebind  「つなぎ直す」の確かめの出し入れ（画面の中だけの状態）
 * @param confirming  確かめを出しているか
 * @param syncView    「同期」の中身に渡す引数（web/plus-sync.mjs の renderSync）
 * @param retrying / onRetry  プランを読めなかったときの「再試行」（読み直している間は場所取りに戻す）
 */
export function renderPlus(status, { send = () => {}, openExternal = () => {}, askRebind = () => {}, cancelRebind = () => {}, confirming = false, syncView = {},
  retrying = false, onRetry = () => {} } = {}) {
  const s = status ?? {};
  const account = s.account ?? null;
  const out = [];
  // 届かないときは、当てはまった中身（最後に知ったアカウント）の上に 1 行（⚠ は付けない）。
  // まだ 1 度も読めていないときは、プランの行の「読み込めませんでした」と「再試行」で伝える
  if (s.reachable === false && (account || !s.signedIn)) out.push(el('p', 'rm-warn', t('settings.remote.failed')));

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
  // account を読めるまでは、ログインのときに覚えたメールだけで行を出す
  if (account) out.push(accountRow(account));
  else if (s.email) out.push(accountRow({ email: s.email }));
  if (account?.status === 'disabled') {
    out.push(el('p', 'rm-warn', t('settings.plus.disabled')));
    const acts = el('div', 'rm-acts');
    acts.append(actButton(t('settings.plus.signOut'), () => send('plusLogout'), 'btn', { fk: 'logout' }));
    out.push(acts);
    return out;
  }
  out.push(keyValues([[t('settings.plus.plan'), planValue(s, { retrying, onRetry })]]));

  if (account?.status === 'plus' && account?.usage && account?.limits) {
    const num = new Intl.NumberFormat(lang);
    const used = num.format(account.usage.credits ?? 0), limit = num.format(account.limits.creditsPerMonth ?? 0);
    const date = account.usage.resetAt ? new Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric' }).format(new Date(account.usage.resetAt)) : '';
    out.push(el('p', 'rm-weak', t('settings.plus.usage', { used, limit, date })));
    if ((account.usage.credits ?? 0) >= (account.limits.creditsPerMonth ?? Infinity)) out.push(el('p', 'rm-warn', t('settings.plus.limitReached')));
  }
  // 同期（web/plus-sync.mjs。docs/plus.md「同期」）。plus のときだけ
  if (account?.status === 'plus') {
    const sync = el('div', null);
    sync.id = 'plusSyncSection';
    sync.append(...renderSync(syncView));
    out.push(sync);
  }

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
  /** 同期の状態（plus.syncStatus 操作と plusSyncStatus 出来事）・「やり直す」の確かめ・同期の操作の失敗 */
  let syncStatus = null, syncConfirming = false, syncBusy = false, syncMessage = '';
  /** プランの「再試行」で読み直している間 */
  let retrying = false;

  function syncView() {
    return {
      enabled: status?.account?.sync?.enabled !== false, sync: syncStatus,
      confirming: syncConfirming, message: syncMessage, busy: syncBusy,
      onToggle: syncToggle, onNow: () => syncSend('plus.syncNow'),
      onAskReset: askSyncReset, onCancelReset: cancelSyncReset, onReset: () => syncSend('plus.syncReset'),
      onOpenConflicts: () => syncSend('plus.syncOpenConflicts'),
    };
  }

  function paint() {
    // status.available === false のときはメニューの項目ごと出さない（ページにも行けない）
    if (status) tab.hidden = status.available === false;
    const sig = JSON.stringify([status, confirming, busy, message, autoNotice, syncStatus, syncConfirming, syncBusy, syncMessage, retrying]);
    paintInto(root, sig, () => {
      const nodes = renderPlus(status, { send, openExternal: openExternalLink, askRebind, cancelRebind, confirming, syncView: syncView(), retrying, onRetry: retryPlan });
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
    const actions = el('div', 'mp-card-actions');
    actions.append(close);
    row.append(actions);
    box.append(row);
    return box;
  }

  function askRebind() {
    confirming = true;
    paint();
    queueMicrotask(() => root.querySelector('[data-fk="rebindNo"]')?.focus());
  }
  function cancelRebind() { confirming = false; paint(); }

  function askSyncReset() {
    syncConfirming = true;
    paint();
    queueMicrotask(() => root.querySelector('[data-fk="syncResetNo"]')?.focus());
  }
  function cancelSyncReset() { syncConfirming = false; paint(); }

  /** 同期の操作（plus.sync* 操作。docs/plus.md「同期」）。状態は届く plusSyncStatus で描き直す */
  async function syncSend(op) {
    if (syncBusy) return;
    syncBusy = true; syncMessage = '';
    if (op === 'plus.syncReset') syncConfirming = false;
    paint();
    try { await cmd('invoke', { op, args: {} }); }
    catch (e) { syncMessage = e.message; }
    finally { syncBusy = false; paint(); }
  }

  /** スイッチの入り切り（アカウントの sync.enabled）。失敗したら戻して「変えられませんでした」 */
  async function syncToggle(next) {
    if (syncBusy || !status?.account) return;
    syncBusy = true; syncMessage = '';
    const before = status.account.sync ?? null;
    status = { ...status, account: { ...status.account, sync: { ...before, enabled: next } } };
    paint();
    try {
      const out = await cmd('invoke', { op: 'plus.syncSetEnabled', args: { enabled: next } });
      if (out && typeof out === 'object') status = { ...status, account: { ...status.account, ...out } };
    } catch (e) {
      status = { ...status, account: { ...status.account, sync: before } };
      syncMessage = t('settings.plus.syncChangeFailed');
    } finally { syncBusy = false; paint(); }
  }

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

  /** プランの「再試行」: アカウントを読み直す（まだ読めていないときは 30 秒の間引きを越えて読み、読み終えるまで待つ） */
  async function retryPlan() {
    if (retrying) return;
    retrying = true; paint();
    try { status = await cmd('plusStatus', { refresh: true }); }
    catch (e) { message = e.message; }
    finally {
      retrying = false; paint();
      queueMicrotask(() => { if (!root.contains(document.activeElement)) root.querySelector('[data-fk="planRetry"]')?.focus(); });
    }
  }

  async function refresh() {
    try { status = await cmd('plusStatus', { refresh: true }); }
    catch (e) { message = e.message; }
    cmd('invoke', { op: 'plus.syncStatus', args: {} }).then(s => { syncStatus = s; paint(); }).catch(() => {});
    paint();
  }
  function event(ev) {
    if (ev?.type === 'apiKeysChanged') {
      // ログインで委譲と通話の両方に plus が自動で選ばれた（core/api-keys.mjs の onChange の autoPlus）
      if (ev.autoPlus === true && !getPrefs().plus?.autoNoticeSeen) { autoNotice = true; paint(); }
      return;
    }
    if (ev?.type === 'plusSyncStatus') { syncStatus = ev.status ?? syncStatus; paint(); return; }
    if (ev?.type !== 'plusStatus') return;
    status = ev.status ?? status;
    paint();
  }

  $('plusTab').onclick = () => { page('plus'); refresh(); };
  // メニューの出し入れ・開いているページのために、つながった（つなぎ直した）あとに取る。
  // 起動の直後は WS がまだ開いていないので client.mjs が ready の後に呼ぶ
  function reconnected() {
    cmd('plusStatus').then(s => { status = s; paint(); }).catch(() => {});
    if (!root.hidden) cmd('invoke', { op: 'plus.syncStatus', args: {} }).then(s => { syncStatus = s; paint(); }).catch(() => {});
  }
  paint();
  return { refresh, event, reconnected, get status() { return status; } };
}
