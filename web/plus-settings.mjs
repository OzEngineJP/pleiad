// 設定 › Pleiad Plus（docs/plus.md「設定 › Pleiad Plus」）。ログイン・プラン・今月の利用・アカウントの管理・ログアウト。
// 状態はサーバーが持つ（plusStatus コマンドと、変わるたびに届く plusStatus イベント）。
// この画面は表示と、B1 のコマンド（plusLogin・plusLoginCancel・plusLogout・plusHostRebind）を送ることだけをする。
// 利用者が外した PC（host.state removed）は「この PC を登録し直す」で plus.hostReregister 操作を送る。
// 見た目の部品は設定 › リモートと同じ（web/remote-parts.mjs、web/manage-panel.css の .rm-*）。見出しの丸は .rm-av。
// 「同期」の「届いた変更 N 件」を押すと、このページの中身を届いた変更の面（web/plus-inbox.mjs。ADR 0246）に替える。
// 通知の一覧の ◆ の行からは openInbox で直に開く。届いた変更が増えたら（plusSyncStatus）一覧を読み直し、新しいものを上に足す
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';
import { button, rmIcon, keyValues, errorLine, waitLine, paintInto } from './remote-parts.mjs';
import { openExternalLink } from './link-open.mjs';
import { renderSync, syncCodeText, pcPlatform } from './plus-sync.mjs';
import { renderInbox } from './plus-inbox.mjs';
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
 * @param reregister  利用者が外した PC を登録し直す（plus.hostReregister 操作）
 */
export function renderPlus(status, { send = () => {}, openExternal = () => {}, askRebind = () => {}, cancelRebind = () => {}, confirming = false, syncView = {},
  retrying = false, onRetry = () => {}, reregister = () => {} } = {}) {
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
  // つなぎ直す（ホストの鍵を作り直す）: ほかのアカウントの PC と同じ鍵のとき・外されて同じ鍵では戻れないとき
  const rebindRow = () => {
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
  };
  if (s.host?.state === 'taken') {
    out.push(el('p', 'rm-warn', t('settings.plus.hostTaken')));
    rebindRow();
  } else if (s.host?.state === 'limit') {
    out.push(el('p', 'rm-warn', t('settings.plus.hostLimit')));
  } else if (s.host?.state === 'removed' && s.host.error?.permanent) {
    // 外された PC は同じ鍵では戻れない（受け入れの v2 の api）。続けるにはつなぎ直す
    out.push(el('p', 'rm-warn', t('settings.plus.hostRemovedForGood')));
    rebindRow();
  } else if (s.host?.state === 'removed') {
    // 利用者がこの PC を外した: 自分では登録し直さない（docs/plus.md「同期の始め直しと登録の外れ」）
    out.push(el('p', 'rm-warn', t('settings.plus.hostRemoved')));
    const acts = el('div', 'rm-acts');
    acts.append(actButton(t('settings.plus.hostReregister'), reregister, 'btn', { fk: 'hostReregister' }));
    out.push(acts);
  } else if (s.host?.notice === 'reregistered') {
    out.push(el('p', 'rm-weak', t('settings.plus.hostReregistered')));
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
  /** 鍵を持たない PC の確かめの窓: チェックを入れたか・確かめている間にサーバーの件数が変わったか */
  let syncChecked = false, syncChanged = false;
  /**
   * 届いた変更の面（null は Pleiad Plus のページ）: { items, open, details: id → 中身, results: id → 押した結果, busy, loading, message }。
   * 押し終えた行は一覧から外さずに残す（「取り込みました」）
   */
  let inbox = null;
  /** 前に受けた受け入れ待ちの件数と時刻（変わったときだけ一覧を読み直す） */
  let inboxSeen = { at: null, count: 0 };
  /** 回復の操作の結果の一言（plus-sync.mjs の recoveryNote） */
  let recoveryNote = '';

  function syncView() {
    return {
      enabled: status?.account?.sync?.enabled !== false, sync: syncStatus,
      confirming: syncConfirming, message: syncMessage, busy: syncBusy,
      resetChecked: syncChecked, resetChanged: syncChanged, onResetCheck: v => { syncChecked = v === true; paint(); },
      onToggle: syncToggle, onNow: () => syncSend('plus.syncNow'),
      onAskReset: askSyncReset, onCancelReset: cancelSyncReset, onReset: syncReset,
      onOpenConflicts: () => syncSend('plus.syncOpenConflicts'),
      onOpenInbox: openInbox,
      recoveryNote, onRecovery: syncRecovery, onAcceptRestart: acceptSyncRestart, onLogin: () => send('plusLogin'),
      onOpenAccount: status?.urls?.account ? () => openExternalLink(status.urls.account) : null,
    };
  }

  function inboxView() {
    return { ...inbox, onBack: closeInbox, onToggle: toggleInboxItem, onTake: id => inboxAct(id, 'take'), onDrop: id => inboxAct(id, 'drop'),
      onAskTake: askInboxTake, onCancelTake: cancelInboxTake };
  }

  /** 届いた変更の面を開き、一覧を読んで最初の 1 件を開く */
  function openInbox() {
    if (!inbox) inbox = { items: [], open: null, details: {}, results: {}, renewed: {}, confirming: null, busy: false, loading: true, message: '' };
    paint();
    loadInbox({ openFirst: true });
  }
  function closeInbox() {
    inbox = null;
    paint();
    queueMicrotask(() => root.querySelector('[data-fk="syncInbox"]')?.focus() ?? root.querySelector('[data-fk="syncToggle"]')?.focus());
  }

  /** 次に開く 1 件（押し終えていないもの。after の後ろを先に、無ければ前から） */
  function nextOpen(after = null) {
    const rest = inbox.items.filter(i => !inbox.results[i.id]?.done);
    const at = after ? inbox.items.findIndex(i => i.id === after) : -1;
    return (rest.find(i => inbox.items.indexOf(i) > at) ?? rest[0])?.id ?? null;
  }

  /**
   * 一覧を読み直す。新しく届いたものは上に足し、押し終えたものは残す。同じ id で届き直した（届いた時刻が変わった）ものは
   * 中身を読み直し、押した結果を消す（捨てた後に新しい版が届いた）。開いていたものなら「新しい版が届きました」を出す
   */
  async function loadInbox({ openFirst = false } = {}) {
    let list;
    try { list = (await cmd('invoke', { op: 'plus.syncInbox', args: {} }))?.items ?? []; }
    catch (e) { if (inbox) { inbox.loading = false; inbox.message = e.message; paint(); } return; }
    if (!inbox) return;
    const server = new Map(list.map(i => [i.id, i]));
    const known = new Map(inbox.items.map(i => [i.id, i]));
    for (const [id, was] of known) {
      const now = server.get(id);
      if (now && now.at !== was.at) {
        if (inbox.open === id && inbox.details[id]) inbox.renewed[id] = true;
        if (inbox.confirming === id) inbox.confirming = null;
        delete inbox.details[id]; delete inbox.results[id];
      }
    }
    const fresh = list.filter(i => !known.has(i.id));
    inbox.items = [...fresh, ...inbox.items.filter(i => server.has(i.id) || inbox.results[i.id]?.done).map(i => server.get(i.id) ?? i)];
    inbox.loading = false;
    if (inbox.open && !server.has(inbox.open)) inbox.open = null;
    if (openFirst || !inbox.open) inbox.open = inbox.open ?? nextOpen();
    paint();
    if (inbox.open) loadInboxItem(inbox.open);
  }

  async function loadInboxItem(id) {
    if (!inbox || inbox.details[id]) return;
    try {
      const out = await cmd('invoke', { op: 'plus.syncInboxItem', args: { id } });
      if (!inbox) return;
      if (out?.item) inbox.details[id] = out.item;
      else inbox.results[id] = { done: 'gone' };
    } catch (e) { if (inbox) inbox.message = e.message; }
    paint();
  }

  function toggleInboxItem(id) {
    if (!inbox || inbox.results[id]?.done) return;
    inbox.open = inbox.open === id ? null : id;
    inbox.confirming = null;
    paint();
    if (inbox.open) loadInboxItem(id);
  }

  /** 文字として見せられないものの「取り込む」: もう一度確かめる */
  function askInboxTake(id) {
    if (!inbox || inbox.busy || !inbox.details[id]) return;
    inbox.confirming = id;
    paint();
    queueMicrotask(() => root.querySelector(`[data-fk="${CSS.escape(`takeNo:${id}`)}"]`)?.focus());
  }
  function cancelInboxTake() {
    if (!inbox) return;
    const id = inbox.confirming;
    inbox.confirming = null;
    paint();
    if (id) queueMicrotask(() => root.querySelector(`[data-fk="${CSS.escape(`take:${id}`)}"]`)?.focus());
  }

  /**
   * 取り込む（take）・捨てる（drop）。人が見た版（sha256・rev）を一緒に送る。済んだら次の 1 件を開く。
   * 手元が変わっていて取り込めなかったものは開いたまま。見ている間に新しい版が届いていたら（changed）、差分を読み直す
   */
  async function inboxAct(id, act) {
    if (!inbox || inbox.busy) return;
    const seen = inbox.details[id];
    if (!seen) return;
    inbox.busy = true; inbox.message = '';
    inbox.confirming = null;
    delete inbox.results[id];
    delete inbox.renewed[id];
    paint();
    try {
      const op = act === 'take' ? 'plus.syncInboxTake' : 'plus.syncInboxDrop';
      const out = await cmd('invoke', { op, args: { id, sha256: seen.sha256 ?? null, rev: seen.rev } });
      if (!inbox) return;
      if (out?.reason === 'changed') {
        inbox.renewed[id] = true;
        delete inbox.details[id];
        inbox.busy = false;
        inbox.open = id;
        paint();
        await loadInbox();
        queueMicrotask(() => root.querySelector(`[data-fk="${CSS.escape(`inx:${id}`)}"]`)?.focus());
        return;
      }
      if (act === 'take' && out?.taken !== true) {
        inbox.results[id] = out?.reason === 'gone' ? { done: 'gone' } : { error: out?.reason === 'local_changed' ? 'local_changed' : 'not_applied' };
      } else inbox.results[id] = { done: act === 'take' ? 'taken' : (out?.dropped === false ? 'gone' : 'dropped') };
    } catch (e) { if (inbox) inbox.results[id] = { error: e.message }; }
    if (!inbox) return;
    inbox.busy = false;
    if (inbox.results[id]?.done) {
      inbox.open = nextOpen(id);
      if (inbox.open) loadInboxItem(inbox.open);
    }
    paint();
    const focus = inbox.open ? `inx:${inbox.open}` : 'back';
    queueMicrotask(() => root.querySelector(`[data-fk="${CSS.escape(focus)}"]`)?.focus());
  }

  function paint() {
    paintApproval();
    // status.available === false のときはメニューの項目ごと出さない（ページにも行けない）
    if (status) tab.hidden = status.available === false;
    // 届いた変更の面は、ログインしていて Plus のときだけ（外れたら Pleiad Plus のページに戻す）
    if (inbox && status && (status.signedIn === false || (status.account && status.account.status !== 'plus'))) inbox = null;
    if (inbox) {
      paintInto(root, JSON.stringify(['inbox', inbox]), () => renderInbox(inboxView()));
      return;
    }
    const sig = JSON.stringify([status, confirming, busy, message, autoNotice, syncStatus, syncConfirming, syncBusy, syncMessage, retrying, syncChecked, syncChanged, recoveryNote]);
    paintInto(root, sig, () => {
      const nodes = renderPlus(status, { send, openExternal: openExternalLink, askRebind, cancelRebind, confirming, syncView: syncView(), retrying, onRetry: retryPlan, reregister: hostReregister });
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
    syncConfirming = true; syncChecked = false; syncChanged = false;
    paint();
    queueMicrotask(() => (root.querySelector('[data-fk="syncResetNo"]') ?? root.querySelector('[data-fk="syncHelpClose"]'))?.focus());
  }
  function cancelSyncReset() { syncConfirming = false; syncChecked = false; syncChanged = false; paint(); }

  /** 確かめの窓で見せている数字（鍵を待つときの keyId と件数）。変わったらチェックを外す */
  const waitSig = s => (s?.state === 'waiting_key' && s.wait ? `${s.wait.keyId ?? ''}:${s.wait.itemCount ?? ''}` : '');

  /**
   * 「同期をやり直す」「消して始め直す」。鍵を待つ PC は、見せた keyId と件数を confirm に付けて送る。
   * 数字が変わっていた（confirmNeeded）ら窓を開いたまま、新しい数字でもう一度チェックしてもらう
   */
  async function syncReset() {
    if (syncBusy) return;
    const waiting = syncStatus?.state === 'waiting_key';
    if (waiting && !syncChecked) return;
    const w = waiting ? syncStatus.wait : null;
    const confirm = w?.keyId && Number.isInteger(w.itemCount) ? { keyId: w.keyId, itemCount: w.itemCount } : null;
    syncBusy = true; syncMessage = '';
    paint();
    try {
      const out = await cmd('invoke', { op: 'plus.syncReset', args: confirm ? { confirm } : {} });
      if (out?.status && typeof out.status === 'object') syncStatus = out.status;
      if (out?.confirmNeeded) { syncChecked = false; syncChanged = true; }
      else { syncConfirming = false; syncChecked = false; syncChanged = false; }
    } catch (e) { syncMessage = e.message; syncConfirming = false; syncChecked = false; }
    finally { syncBusy = false; paint(); }
  }

  /**
   * 回復の操作（plus.syncRecovery*）。結果を一言にして出す（最近のログインが要る・ほかの PC が先に頼んだ など）。
   * complete は「新しい鍵で始め直す」の確かめの窓から（チェックを入れたときだけ）
   */
  async function syncRecovery(action) {
    if (syncBusy) return;
    if (action === 'complete' && !syncChecked) return;
    const op = { request: 'plus.syncRecoveryRequest', cancel: 'plus.syncRecoveryCancel', complete: 'plus.syncRecoveryComplete', stop: 'plus.syncRecoveryStop' }[action];
    if (!op) return;
    syncBusy = true; syncMessage = ''; recoveryNote = '';
    paint();
    try {
      const out = await cmd('invoke', { op, args: {} });
      if (out?.status && typeof out.status === 'object') syncStatus = out.status;
      recoveryNote = out?.reauth ? 'reauth' : out?.other ? 'other' : out?.holder ? 'holder' : out?.waiting ? 'waiting' : out?.gone ? 'gone'
        : action === 'stop' ? (out?.stopped ? 'stopped' : 'stopFailed') : '';
      if (action === 'complete') { syncConfirming = false; syncChecked = false; syncChanged = false; }
    } catch (e) { syncMessage = e.message; if (action === 'complete') { syncConfirming = false; syncChecked = false; } }
    finally { syncBusy = false; paint(); }
  }

  /** 前の鍵では確かめられない新しい鍵を受け取る（回復など）。この後、鍵を持つ PC の承認の窓を通して届く */
  async function acceptSyncRestart(keyId) {
    if (syncBusy || !keyId) return;
    syncBusy = true; syncMessage = '';
    paint();
    try {
      const out = await cmd('invoke', { op: 'plus.syncAcceptRestart', args: { keyId } });
      if (out?.status && typeof out.status === 'object') syncStatus = out.status;
      if (out?.changed) syncMessage = t('settings.plus.syncRestartChanged');
    } catch (e) { syncMessage = e.message; }
    finally { syncBusy = false; paint(); }
  }

  // ---- 同期の鍵を渡す承認の窓（端末の承認の窓と同じ組み方。どの画面にいても出す）
  /** 窓（初めて要るときに作る）・出している申し込み（hostId:code）・次に窓に出す一言 */
  let approvalDialog = null, approving = '', approvalNote = '';
  function paintApproval() {
    const list = Array.isArray(syncStatus?.approvals) ? syncStatus.approvals : [];
    const current = list.find(a => `${a.hostId}:${a.code}` === approving) ?? list[0];
    if (!current) {
      approving = '';
      if (approvalDialog?.open) approvalDialog.close();
      return;
    }
    const sig = `${current.hostId}:${current.code}`;
    if (sig === approving && approvalDialog?.open) return;
    if (!approvalDialog) {
      approvalDialog = document.createElement('dialog');
      approvalDialog.className = 'rm-dialog';
      approvalDialog.id = 'plusSyncApproval';
      approvalDialog.setAttribute('aria-labelledby', 'plusSyncApprovalTitle');
      approvalDialog.addEventListener('cancel', e => e.preventDefault());   // Esc で黙って閉じない（決めるまで残す）
      document.body.append(approvalDialog);
    }
    approving = sig;
    const name = current.name || t('settings.plus.syncUnnamedPc');
    const kind = el('p', 'rm-dialog-kind');
    kind.append(el('span', 'card-kind', `◆ ${t('settings.plus.syncApprove.mark')}`));
    const title = el('h2', null, t('settings.plus.syncApprove.title', { name }));
    title.id = 'plusSyncApprovalTitle';
    const meta = [pcPlatform(current.platform), current.app].filter(Boolean).join(' · ');
    const state = el('p', 'mp-state rm-dialog-state', approvalNote);
    state.setAttribute('role', 'status');
    approvalNote = '';
    const deny = button(t('settings.plus.syncApprove.deny'), () => decideApproval(current, false, state), 'btn btn-quiet');
    const approve = button(t('settings.plus.syncApprove.approve'), () => decideApproval(current, true, state), 'btn btn-primary');
    deny.dataset.fk = 'syncApproveNo';
    approve.dataset.fk = 'syncApproveYes';
    const actions = el('div', 'rm-dialog-actions');
    actions.append(deny, approve);
    approvalDialog.replaceChildren(kind, title, ...(meta ? [el('p', 'rm-dialog-meta', meta)] : []),
      el('p', 'rm-dialog-label', t('settings.plus.syncCode')), el('p', 'rm-dialog-code', syncCodeText(current.code)),
      el('p', 'rm-dialog-hint', t('settings.plus.syncApprove.hint', { name })), state, actions);
    if (!approvalDialog.open) approvalDialog.showModal();
    deny.focus();   // 既定の居場所は「渡さない」（Enter の押し間違いで渡さない）
  }
  /** 渡す・渡さない。渡す前にコードを読み直し、変わっていたら新しいコードで窓を出し直す */
  async function decideApproval(a, yes, state) {
    for (const b of approvalDialog.querySelectorAll('button')) b.disabled = true;
    try {
      const out = await cmd('invoke', yes
        ? { op: 'plus.syncApprove', args: { hostId: a.hostId, code: a.code } }
        : { op: 'plus.syncDeny', args: { hostId: a.hostId } });
      if (out?.status && typeof out.status === 'object') syncStatus = out.status;
      if (yes && out?.shared === false) {
        // i18n-dynamic: settings.plus.syncApprove.
        const note = t(`settings.plus.syncApprove.${out.reason === 'changed' ? 'changed' : out.reason === 'no_key' ? 'noKey' : 'gone'}`);
        if (out.reason === 'changed') approvalNote = note; else syncMessage = note;
      }
      approving = '';
      paint();
    } catch (e) {
      state.textContent = e.message;
      for (const b of approvalDialog.querySelectorAll('button')) b.disabled = false;
    }
  }

  /** 利用者が外した PC を登録し直す。状態は届く plusStatus で描き直す */
  async function hostReregister() {
    if (busy) return;
    busy = true; message = '';
    paint();
    try { await cmd('invoke', { op: 'plus.hostReregister', args: {} }); }
    catch (e) { message = e.message; }
    finally { busy = false; paint(); }
  }

  /** 同期の操作（plus.sync* 操作。docs/plus.md「同期」）。状態は届く plusSyncStatus で描き直す */
  async function syncSend(op) {
    if (syncBusy) return;
    syncBusy = true; syncMessage = '';
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
    if (ev?.type === 'plusSyncStatus') {
      const before = waitSig(syncStatus);
      syncStatus = ev.status ?? syncStatus;
      const after = waitSig(syncStatus);
      // 確かめている間にほかの PC が上げて件数が変わった: 新しい数字でもう一度チェックしてもらう
      if (syncConfirming && before && after && before !== after) { syncChecked = false; syncChanged = true; }
      // 届いた変更の面を開いている間に、届いたもの・残りの数が変わった: 一覧を読み直す
      if (inbox && !inbox.loading && (syncStatus?.inboxAt !== inboxSeen.at || syncStatus?.inbox !== inboxSeen.count)) loadInbox();
      inboxSeen = { at: syncStatus?.inboxAt ?? null, count: syncStatus?.inbox ?? 0 };
      paint();
      return;
    }
    if (ev?.type !== 'plusStatus') return;
    status = ev.status ?? status;
    paint();
  }

  $('plusTab').onclick = () => { inbox = null; recoveryNote = ''; page('plus'); refresh(); };
  // メニューの出し入れ・開いているページのために、つながった（つなぎ直した）あとに取る。
  // 起動の直後は WS がまだ開いていないので client.mjs が ready の後に呼ぶ
  function reconnected() {
    cmd('plusStatus').then(s => { status = s; paint(); }).catch(() => {});
    if (!root.hidden) cmd('invoke', { op: 'plus.syncStatus', args: {} }).then(s => { syncStatus = s; paint(); }).catch(() => {});
  }
  paint();
  return { refresh, event, reconnected, openInbox: () => { refresh(); openInbox(); }, openMain: () => { inbox = null; refresh(); paint(); }, get status() { return status; } };
}
