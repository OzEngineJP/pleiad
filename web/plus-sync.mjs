// 設定 › Pleiad Plus の「同期」のまとまり（docs/plus.md「同期」）。
// 状態から DOM を作る純粋な関数（tests/unit/plus-sync-ui.mjs が tests/lib/dom-stub.mjs で動かす）。
// スイッチはアカウントの sync.enabled（status.account.sync）、状態の行は getSyncStatus() の形。
// enabled が false・state が disabled のときは状態の行を出さない（スイッチだけが残る）。
// stopped（アカウントの停止で止まっている）は誤りにしない。Plus と分かり直せば自動で回し直すので、ボタンも出さない。
// waiting_key は status.wait（鍵を持つ PC・サーバーの件数と大きさ）で中身を分ける（docs/plus.md「同期の始め直しと登録の外れ」）:
//   鍵を持つ PC が台帳に居る → その PC の名前と最後の同期。控えめな「鍵を持つ PC が使えないとき」
//   居ない → サーバーにあるデータの件数と大きさ。「鍵を持つ PC が使えない」
//   どちらも確かめの窓はチェック 1 つ（入れるまで「消して始め直す」を押せない）
// 受け入れ待ち（status.inbox）が 1 件以上あれば、まとまりの終わりに「届いた変更 N 件」の行（押すと web/plus-inbox.mjs の面。ADR 0245）
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
  text.append(el('span', 'rm-nm', Number.isInteger(w.itemCount)
    ? t('settings.plus.syncDataFound', { count: w.itemCount, size: megaBytes(w.totalBytes) })
    : t('settings.plus.syncDataMaybe')));
  if (w.updatedAt) {
    const time = syncTimeText(w.updatedAt);
    text.append(el('span', 'rm-sub', w.lastWriter?.name
      ? t('settings.plus.syncDataUpdatedBy', { time, name: w.lastWriter.name }) : t('settings.plus.syncDataUpdated', { time })));
  }
  text.append(el('span', 'rm-sub', t('settings.plus.syncHolderGone')));
  const gone = (w.holders ?? []).filter(h => !h.registered && h.name).map(h => h.name);
  if (gone.length) text.append(el('span', 'rm-sub', t('settings.plus.syncHolderGoneNames', { names: new Intl.ListFormat(lang).format(gone) })));
  return { label: t('settings.plus.syncNoHolder'), className: 'btn' };
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
    el('p', null, t('settings.plus.syncStartOverOthers')),
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
 */
export function renderSync({ enabled = true, sync = null, confirming = false, message = '', busy = false,
  resetChecked = false, resetChanged = false, onResetCheck = () => {},
  onToggle = () => {}, onNow = () => {}, onAskReset = () => {}, onCancelReset = () => {}, onReset = () => {}, onOpenConflicts = () => {},
  onOpenInbox = () => {} } = {}) {
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
  const live = el('div', null);
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
      const detail = code === 'unavailable' || code === 'network' ? t('settings.plus.syncErrUnavailable')
        : code === 'rate_limited' ? t('settings.plus.syncErrRetry') : t('settings.plus.syncErrOther');
      live.append(el('p', 'rm-err', t('settings.plus.syncFailed')), el('p', 'rm-sub', detail));
      act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
      act(t('settings.plus.syncReset'), onAskReset, 'btn btn-quiet', 'syncReset');
      break;
    }
    default:   // 'off'・まだ取れていない
      live.append(el('p', 'rm-weak', t('settings.plus.syncOff')));
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

  if (confirming && s.state === 'waiting_key') {
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
