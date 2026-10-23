// 設定 › Pleiad Plus の「同期」のまとまり（docs/plus.md「同期」）。
// 状態から DOM を作る純粋な関数（tests/unit/plus-sync-ui.mjs が tests/lib/dom-stub.mjs で動かす）。
// スイッチはアカウントの sync.enabled（status.account.sync）、状態の行は getSyncStatus() の形。
// enabled が false・state が disabled のときは状態の行を出さない（スイッチだけが残る）。
// stopped（アカウントの停止で止まっている）は誤りにしない。Plus と分かり直せば自動で回し直すので、ボタンも出さない。
// waiting_key は status.wait（鍵を持つ PC・サーバーの件数と大きさ）で中身を分ける（docs/plus.md「同期の始め直しと登録の外れ」）:
//   鍵を持つ PC が台帳に居る → その PC の名前と最後の同期。控えめな「鍵を持つ PC が使えないとき」
//   居ない → サーバーにあるデータの件数と大きさ。「鍵を持つ PC が使えない」
//   どちらも確かめの窓はチェック 1 つ（入れるまで「消して始め直す」を押せない）
// 受け入れ待ち（status.inbox）が 1 件以上あれば、まとまりの終わりに「届いた変更 N 件」の行（押すと web/plus-inbox.mjs の面。ADR 0250）
// 受け入れの v2 の api（wait.v2。docs/plus.md「同期の鍵の受け渡し」）では、鍵は鍵を持つ PC の承認でだけ届く:
//   鍵を持つ PC が居る → 承認を待つ行。明かし終えたら「{PC} の画面で承認してください」と確認コード。断られたら 1 時間待つ
//     「鍵を持つ PC が使えないとき」は、PC の外し方と回復の説明（始め直しの窓は出さない）
//   居ない → データの件数と回復（頼む・待つ・取り下げる・待ちが明けたら始め直す。ほかの PC の回復は今の鍵で止める）
//   外された PC が今の鍵を持っていて、回復が頼まれている（status.recoveryAlert）→ 知らせと「回復を止める」
//   前の鍵を持つ PC で、前の鍵では確かめられない新しい鍵が置かれた（wait.restarted。回復など）→ 自動では移らず「新しい鍵を受け取る」。
//   届いた鍵を確かめられなかった（wait.unverified・restarted.unverified）→ 受け取らずに止めていることと、直し方（外して登録し直す・鍵を持つ PC が 1 台だけなら回復）
//   update_required（この版では使えない api）→ 更新を促す。error が api_downgraded（券を取れた後に api が前の版を名乗った）→ 止めたことを知らせる
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';
import { button, switchButton, waitLine } from './remote-parts.mjs';
import { inboxRow } from './plus-inbox.mjs';

const MB = 1024 * 1024;
/** バイト数を「x.x MB」に（小数 1 桁。tests/unit/plus-sync-ui.mjs が試す） */
export const megaBytes = n => `${(Math.max(0, Number(n) || 0) / MB).toFixed(1)} MB`;

/** 最後の同期の時刻: 今日なら時刻だけ、それより前なら日付つき（表示の言語に従う） */
export function syncTimeText(iso, { lang: l = lang, now = new Date() } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit' }).format(d)
    : new Intl.DateTimeFormat(l, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

const actButton = (text, onclick, className, fk) => { const b = button(text, onclick, className); if (fk) b.dataset.fk = fk; return b; };

/** 確認コードを 3 桁ずつに分ける（「731 058」。端末の承認の窓と同じ区切り）。6 桁でなければそのまま */
export function syncCodeText(code) {
  const s = String(code ?? '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

const PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
/** 台帳の platform（win32・darwin・linux）の名前。知らない値はそのまま */
export const pcPlatform = p => PLATFORMS[p] ?? (typeof p === 'string' ? p : '');

/** PC の名前。無ければ「名前の無い PC」 */
const pcName = name => (typeof name === 'string' && name ? name : t('settings.plus.syncUnnamedPc'));

/** 鍵を待つ間の中身（場面 1・2）。ボタンの文言を返す */
function waitingLines(w, text) {
  const holder = (w.holders ?? []).find(h => h.registered);
  if (holder) {
    text.append(el('span', 'rm-nm', t('settings.plus.syncWaitingKey')),
      el('span', 'rm-sub', holder.lastSyncAt
        ? t('settings.plus.syncWaitHolder', { name: pcName(holder.name), time: syncTimeText(holder.lastSyncAt) })
        : t('settings.plus.syncWaitHolderNoTime', { name: pcName(holder.name) })));
    return { label: t('settings.plus.syncHolderUnavailable'), className: 'btn btn-quiet' };
  }
  dataLines(w, text);
  text.append(el('span', 'rm-sub', t('settings.plus.syncHolderGone')));
  const gone = (w.holders ?? []).filter(h => !h.registered && h.name).map(h => h.name);
  if (gone.length) text.append(el('span', 'rm-sub', t('settings.plus.syncHolderGoneNames', { names: new Intl.ListFormat(lang).format(gone) })));
  return { label: t('settings.plus.syncNoHolder'), className: 'btn' };
}

/** サーバーにある同期のデータの行（鍵を持つ PC が居ないとき） */
function dataLines(w, text) {
  text.append(el('span', 'rm-nm', Number.isInteger(w.itemCount)
    ? t('settings.plus.syncDataFound', { count: w.itemCount, size: megaBytes(w.totalBytes) })
    : t('settings.plus.syncDataMaybe')));
  if (w.updatedAt) {
    const time = syncTimeText(w.updatedAt);
    text.append(el('span', 'rm-sub', w.lastWriter?.name
      ? t('settings.plus.syncDataUpdatedBy', { time, name: w.lastWriter.name }) : t('settings.plus.syncDataUpdated', { time })));
  }
}

/**
 * 鍵を待つ間の中身（v2）。行は live に、ボタンは act で足す。
 * 鍵を持つ PC が居れば承認を待つ・確認コード・断られた。居なければデータと回復
 */
function approvalLines(w, live, act, { onAskReset, onRecovery, onAcceptRestart, now }) {
  if (w.unverified || w.restarted?.unverified) {
    live.append(el('p', 'rm-err', t('settings.plus.syncKeyUnverified')), el('p', 'rm-sub', t('settings.plus.syncKeyUnverifiedHint')));
    return;
  }
  if (w.restarted) {
    // 前の鍵では確かめられない新しい鍵（回復など）: 人が選ぶまで申し込まない
    live.append(el('p', 'rm-warn', t('settings.plus.syncRestarted')), el('p', 'rm-sub', t('settings.plus.syncRestartedHint')));
    act(t('settings.plus.syncAcceptRestart'), () => onAcceptRestart(w.restarted.keyId), 'btn', 'syncAcceptRestart');
    return;
  }
  const text = el('span', 'rm-rt');
  const box = el('div', 'rm-row rm-plain-row');
  box.append(text);
  live.append(box);
  if (w.holder) {
    const holders = (w.holders ?? []).filter(h => h.registered);
    const j = w.join ?? null;
    if (j?.state === 'denied') {
      text.append(el('span', 'rm-nm', t('settings.plus.syncJoinDenied')), el('span', 'rm-sub', t('settings.plus.syncJoinDeniedHint')));
    } else if (j?.state === 'revealed' && j.code) {
      const h = holders.find(x => x.hostId === j.approver?.hostId);
      text.append(el('span', 'rm-nm', t('settings.plus.syncApproveOn', { name: pcName(j.approver?.name ?? h?.name) })));
      if (h?.lastSyncAt) text.append(el('span', 'rm-sub', t('settings.plus.syncLast', { time: syncTimeText(h.lastSyncAt, { now }) })));
      const code = el('p', 'rm-ccode sync-code', syncCodeText(j.code));
      code.setAttribute('aria-label', `${t('settings.plus.syncCode')} ${syncCodeText(j.code)}`);
      live.append(code);
    } else {
      const names = new Intl.ListFormat(lang, { type: 'disjunction' }).format(holders.map(h => pcName(h.name)));
      text.append(el('span', 'rm-nm', t('settings.plus.syncWaitApproval')), el('span', 'rm-sub', t('settings.plus.syncWaitApprovalHint', { name: names })));
    }
    act(t('settings.plus.syncHolderUnavailable'), onAskReset, 'btn btn-quiet', 'syncReset');
    return;
  }
  dataLines(w, text);
  text.append(el('span', 'rm-sub', t('settings.plus.syncHolderGoneAll')));
  const gone = (w.holders ?? []).filter(h => !h.registered && h.name).map(h => h.name);
  if (gone.length) text.append(el('span', 'rm-sub', t('settings.plus.syncHolderGoneNames', { names: new Intl.ListFormat(lang).format(gone) })));
  const r = w.recovery ?? null;
  if (!r) {
    live.append(el('p', 'rm-weak', t('settings.plus.syncRecoveryAbout')));
    act(t('settings.plus.syncRecoveryAsk'), () => onRecovery('request'), 'btn', 'syncRecoveryRequest');
  } else if (w.recoveryMine) {
    const ready = Date.parse(r.readyAt) <= now.getTime();
    live.append(el('p', 'rm-weak', ready ? t('settings.plus.syncRecoveryReady') : t('settings.plus.syncRecoveryWaiting', { time: syncTimeText(r.readyAt, { now }) })));
    act(t('settings.plus.syncRecoveryWithdraw'), () => onRecovery('cancel'), 'btn btn-quiet', 'syncRecoveryCancel');
    if (ready) act(t('settings.plus.syncRecoveryStart'), onAskReset, 'btn', 'syncReset');
  } else {
    live.append(el('p', 'rm-weak', t('settings.plus.syncRecoveryOther', { name: pcName(r.requestedByName), time: syncTimeText(r.readyAt, { now }) })));
    if (w.recoveryStop) act(t('settings.plus.syncRecoveryStop'), () => onRecovery('stop'), 'btn', 'syncRecoveryStop');
  }
}

/** 「鍵を持つ PC が使えないとき」（v2）: PC の外し方と回復の説明。始め直しはできない（鍵を持つ PC の承認か回復だけ） */
function holderHelpBox({ onClose, onOpenAccount }) {
  const box = el('div', 'rm-confirm');
  box.append(el('p', 'sync-confirm-title', t('settings.plus.syncHolderUnavailable')),
    el('p', null, t('settings.plus.syncHelpRemove')), el('p', null, t('settings.plus.syncHelpRecovery')));
  const cacts = el('div', 'rm-acts');
  if (onOpenAccount) cacts.append(actButton(t('settings.plus.manage'), onOpenAccount, 'btn btn-quiet', 'syncHelpAccount'));
  cacts.append(actButton(t('settings.plus.syncHelpClose'), onClose, 'btn', 'syncHelpClose'));
  box.append(cacts);
  return box;
}

/** 鍵を持たない PC の確かめの窓（場面 3）。消えるもの・消えないもの・ほかの PC と、チェック 1 つ */
function startOverBox(w, { checked, changed, busy, onCheck, onCancel, onReset }) {
  const box = el('div', 'rm-confirm');
  box.append(el('p', 'sync-confirm-title', t('settings.plus.syncStartOverTitle')));
  if (changed) box.append(el('p', 'rm-warn', t('settings.plus.syncStartOverChanged')));
  box.append(
    el('p', null, Number.isInteger(w?.itemCount)
      ? t('settings.plus.syncStartOverLost', { count: w.itemCount, size: megaBytes(w.totalBytes) })
      : t('settings.plus.syncStartOverLostMaybe')),
    el('p', null, t('settings.plus.syncStartOverKept')),
    el('p', null, w?.v2 ? t('settings.plus.syncStartOverOthersApproval') : t('settings.plus.syncStartOverOthers')),
  );
  const check = el('label', 'mp-check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = checked === true;
  cb.disabled = busy;
  cb.dataset.fk = 'syncResetCheck';
  cb.onchange = () => onCheck(cb.checked);
  check.append(cb, el('span', null, t('settings.plus.syncStartOverCheck')));
  box.append(check);
  const cacts = el('div', 'rm-acts');
  const yes = actButton(t('settings.plus.syncStartOverYes'), onReset, 'btn rm-danger', 'syncResetYes');
  yes.disabled = busy || checked !== true;
  cacts.append(actButton(t('settings.plus.cancel'), onCancel, 'btn btn-quiet', 'syncResetNo'), yes);
  box.append(cacts);
  return box;
}

/** 「同期するもの」の折り畳み。開くと同期するもの・しないものと暗号の一言 */
function whatSynced() {
  const det = el('details', 'sync-what');
  det.append(el('summary', null, t('settings.plus.syncWhat')));
  const body = el('div', 'sync-what-body');
  body.append(
    el('p', 'sync-what-line', t('settings.plus.syncWhatYes')),
    el('p', 'sync-what-line', t('settings.plus.syncWhatNo')),
    el('p', 'sync-what-line', t('settings.plus.syncEncrypted')),
  );
  det.append(body);
  return det;
}

/**
 * 「同期」の中身（見出し・スイッチ・状態の行・ボタン・競合の行）を返す。
 * @param enabled  account.sync.enabled（null・未定義は入）
 * @param sync     getSyncStatus() の形。まだ取れていなければ null
 * @param confirming  「同期をやり直す」の確かめを出しているか
 * @param message  スイッチを変えられなかったときの文言（'' なら出さない）
 * @param busy     コマンドを送っている最中（ボタンを押せなくする）
 * @param resetChecked  鍵を持たない PC の確かめの窓で、チェックを入れたか（onResetCheck で知らせる）
 * @param resetChanged  確かめている間にサーバーの件数が変わった（もう一度確かめてもらう）
 * @param recoveryNote  回復の操作の結果の一言（reauth・other・holder・waiting・gone・stopped・stopFailed。'' なら出さない）
 * @param onRecovery  回復の操作（'request'・'cancel'・'complete'・'stop'）
 * @param onAcceptRestart  (keyId) 前の鍵では確かめられない新しい鍵を受け取ると選んだ
 * @param onLogin     ログインし直す（回復を頼むのに最近のログインが要るとき）
 * @param onOpenAccount  アカウントのページを開く（「鍵を持つ PC が使えないとき」の説明から。無ければボタンを出さない）
 * @param now         いまの時刻（回復の待ちが明けたか・時刻の書式）
 */
export function renderSync({ enabled = true, sync = null, confirming = false, message = '', busy = false,
  resetChecked = false, resetChanged = false, onResetCheck = () => {},
  onToggle = () => {}, onNow = () => {}, onAskReset = () => {}, onCancelReset = () => {}, onReset = () => {}, onOpenConflicts = () => {},
  onOpenInbox = () => {}, recoveryNote = '', onRecovery = () => {}, onAcceptRestart = () => {}, onLogin = null, onOpenAccount = null, now = new Date() } = {}) {
  const out = [];
  out.push(el('div', 'rm-gh', t('settings.plus.sync')));

  const row = el('div', 'rm-mrow');
  const sw = switchButton(t('settings.plus.syncSwitch'), () => onToggle(!enabled));
  sw.setAttribute('aria-checked', String(enabled === true));
  sw.disabled = busy;
  sw.dataset.fk = 'syncToggle';
  row.append(el('span', 'rm-lbl', t('settings.plus.syncSwitch')), sw);
  out.push(row);
  out.push(whatSynced());
  if (message) out.push(el('p', 'rm-err', message));

  if (!enabled) return out;   // アカウントで切っている: 状態の行は出さない
  const s = sync ?? {};
  const live = el('div', 'sync-live');
  live.setAttribute('aria-live', 'polite');
  const acts = el('div', 'rm-acts');
  let hasActs = false;
  const act = (text, onclick, className, fk) => { hasActs = true; acts.append(actButton(text, onclick, className, fk)); };

  switch (s.state) {
    case 'disabled':    // アカウントで止められている。状態の行は出さない
      break;
    case 'waiting_key': {
      const w = s.wait ?? null;
      // ほかの PC で始め直されて、手元の鍵が古くなった（場面 5）
      if (w?.stale && w.resetAt) {
        live.append(el('p', 'rm-weak', t('settings.plus.syncResetBy', { name: pcName(w.resetBy?.name), time: syncTimeText(w.resetAt) })));
      }
      if (w?.v2) { approvalLines(w, live, act, { onAskReset, onRecovery, onAcceptRestart, now }); break; }
      const text = el('span', 'rm-rt');
      let label = t('settings.plus.syncReset'), className = 'btn btn-quiet';
      if (w) ({ label, className } = waitingLines(w, text));
      else text.append(el('span', 'rm-nm', t('settings.plus.syncWaitingKey')), el('span', 'rm-sub', t('settings.plus.syncWaitingKeyHint')));
      const box = el('div', 'rm-row rm-plain-row');
      box.append(text);
      live.append(box);
      act(label, onAskReset, className, 'syncReset');
      break;
    }
    case 'unregistered':   // この PC の登録が外れた。登録し直すと自動で回し直す
      live.append(el('p', 'rm-weak', t('settings.plus.syncUnregistered')), el('p', 'rm-sub', t('settings.plus.syncUnregisteredHint')));
      break;
    case 'update_required':   // この版では使えない api。更新すると再開する
      if (sync.error === 'api_downgraded') {
        // 券を取れたアカウントで、api が前の版を名乗った。前の版のやり方では鍵を渡さずに止めている
        live.append(el('p', 'rm-err', t('settings.plus.syncApiDowngraded')), el('p', 'rm-sub', t('settings.plus.syncApiDowngradedHint')));
        break;
      }
      live.append(el('p', 'rm-err', t('settings.plus.syncUpdateRequired')), el('p', 'rm-sub', t('settings.plus.syncUpdateRequiredHint')));
      break;
    case 'syncing':
      live.append(waitLine(t('settings.plus.syncing')));
      break;
    case 'idle':
      live.append(el('p', 'rm-weak', t('settings.plus.syncLast', { time: syncTimeText(s.lastSyncedAt) })));
      act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
      act(t('settings.plus.syncReset'), onAskReset, 'btn btn-quiet', 'syncReset');
      break;
    case 'quota':
      live.append(el('p', 'rm-err', t('settings.plus.syncQuota')),
        el('p', 'rm-sub', t('settings.plus.syncQuotaUsage', { used: megaBytes(s.totalBytes), limit: megaBytes(s.limitBytes) })),
        el('p', 'rm-sub', t('settings.plus.syncQuotaNote')));
      act(t('settings.plus.syncReset'), onAskReset, 'btn btn-quiet', 'syncReset');
      break;
    case 'stopped':
      live.append(el('p', 'rm-weak', t('settings.plus.syncStopped')),
        el('p', 'rm-sub', s.error === 'not_plus' ? t('settings.plus.syncStoppedNotPlus') : t('settings.plus.syncStoppedDisabled')));
      break;
    case 'error': {
      const code = s.error;
      if (code === 'unavailable') {
        // api の 503: Pleiad Plus が止まっている。誤りではなく待ち（engine が間をおいてやり直す）。やり直し（reset）も断られるので出さない
        live.append(el('p', 'rm-weak', t('settings.plus.paused')), el('p', 'rm-sub', t('settings.plus.syncPausedNote')));
        act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
        break;
      }
      const detail = code === 'network' ? t('settings.plus.syncErrUnavailable')
        : code === 'rate_limited' ? t('settings.plus.syncErrRetry') : t('settings.plus.syncErrOther');
      live.append(el('p', 'rm-err', t('settings.plus.syncFailed')), el('p', 'rm-sub', detail));
      act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
      act(t('settings.plus.syncReset'), onAskReset, 'btn btn-quiet', 'syncReset');
      break;
    }
    default:   // 'off'・まだ取れていない
      live.append(el('p', 'rm-weak', t('settings.plus.syncOff')));
  }

  // 外されたこの PC が今の鍵を持っていて、ほかの PC が回復を頼んでいる: 止められる
  const alert = s.state !== 'disabled' ? s.recoveryAlert : null;
  if (alert) {
    live.append(el('p', 'rm-warn', t('settings.plus.syncRecoveryAlert', { name: pcName(alert.requestedByName), time: syncTimeText(alert.readyAt, { now }) })));
    act(t('settings.plus.syncRecoveryStop'), () => onRecovery('stop'), 'btn', 'syncRecoveryStop');
  }
  // 回復の操作の結果
  if (recoveryNote) {
    // i18n-dynamic: settings.plus.syncRecoveryNote.
    live.append(el('p', recoveryNote === 'stopped' ? 'rm-sub' : 'rm-warn', t(`settings.plus.syncRecoveryNote.${recoveryNote}`)));
    if (recoveryNote === 'reauth' && onLogin) act(t('settings.plus.syncRelogin'), onLogin, 'btn btn-primary', 'syncRelogin');
  }
  // 鍵を渡した新しい PC（場面 6。7 日の間）
  if (s.state !== 'disabled') {
    for (const to of Array.isArray(s.sharedTo) ? s.sharedTo : []) {
      live.append(el('p', 'rm-sub', t('settings.plus.syncSharedTo', { name: pcName(to.name), time: syncTimeText(to.at) })));
    }
  }

  if ((s.conflicts ?? 0) >= 1) {
    const text = el('span', 'rm-rt');
    text.append(el('span', 'rm-nm', t('settings.plus.syncConflicts', { n: s.conflicts })), el('span', 'rm-sub', t('settings.plus.syncConflictDays')));
    const box = el('div', 'rm-mrow');
    box.append(text, actButton(t('settings.plus.syncOpenFolder'), onOpenConflicts, 'btn btn-quiet', 'syncOpenConflicts'));
    live.append(box);
  }
  out.push(live);

  if (confirming && s.state === 'waiting_key' && s.wait?.v2 && s.wait.holder) {
    out.push(holderHelpBox({ onClose: onCancelReset, onOpenAccount }));
  } else if (confirming && s.state === 'waiting_key' && s.wait?.v2) {
    // 回復の待ちが明けた: 新しい鍵で始め直す（サーバーのデータは消える）
    out.push(startOverBox(s.wait, { checked: resetChecked, changed: resetChanged, busy, onCheck: onResetCheck, onCancel: onCancelReset, onReset: () => onRecovery('complete') }));
  } else if (confirming && s.state === 'waiting_key') {
    out.push(startOverBox(s.wait, { checked: resetChecked, changed: resetChanged, busy, onCheck: onResetCheck, onCancel: onCancelReset, onReset }));
  } else if (confirming) {
    const box = el('div', 'rm-confirm');
    box.append(el('p', 'sync-confirm-title', t('settings.plus.syncResetTitle')), el('p', null, t('settings.plus.syncResetBody')));
    const cacts = el('div', 'rm-acts');
    cacts.append(actButton(t('settings.plus.cancel'), onCancelReset, 'btn btn-quiet', 'syncResetNo'),
      actButton(t('settings.plus.syncResetYes'), onReset, 'btn rm-danger', 'syncResetYes'));
    box.append(cacts);
    out.push(box);
  } else if (hasActs) {
    for (const b of acts.children ?? []) b.disabled = busy;
    out.push(acts);
  }
  // 届いた変更（受け入れ待ち）。止まっていても、待っているものは見せる
  if (s.state !== 'disabled' && Number.isInteger(s.inbox) && s.inbox > 0) out.push(inboxRow(s.inbox, onOpenInbox));
  return out;
}
