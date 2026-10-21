// 設定 › Pleiad Plus の「同期」のまとまり（docs/plus.md「同期」）。
// 状態から DOM を作る純粋な関数（tests/unit/plus-sync-ui.mjs が tests/lib/dom-stub.mjs で動かす）。
// スイッチはアカウントの sync.enabled（status.account.sync）、状態の行は getSyncStatus() の形。
// enabled が false・state が disabled のときは状態の行を出さない（スイッチだけが残る）。
// stopped（アカウントの停止で止まっている）は誤りにしない。Plus と分かり直せば自動で回し直すので、ボタンも出さない。
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';
import { button, switchButton, waitLine } from './remote-parts.mjs';

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
 */
export function renderSync({ enabled = true, sync = null, confirming = false, message = '', busy = false,
  onToggle = () => {}, onNow = () => {}, onAskReset = () => {}, onCancelReset = () => {}, onReset = () => {}, onOpenConflicts = () => {} } = {}) {
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
      const text = el('span', 'rm-rt');
      text.append(el('span', 'rm-nm', t('settings.plus.syncWaitingKey')), el('span', 'rm-sub', t('settings.plus.syncWaitingKeyHint')));
      const box = el('div', 'rm-row rm-plain-row');
      box.append(text);
      live.append(box);
      act(t('settings.plus.syncReset'), onAskReset, 'btn btn-quiet', 'syncReset');
      break;
    }
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

  if ((s.conflicts ?? 0) >= 1) {
    const text = el('span', 'rm-rt');
    text.append(el('span', 'rm-nm', t('settings.plus.syncConflicts', { n: s.conflicts })), el('span', 'rm-sub', t('settings.plus.syncConflictDays')));
    const box = el('div', 'rm-mrow');
    box.append(text, actButton(t('settings.plus.syncOpenFolder'), onOpenConflicts, 'btn btn-quiet', 'syncOpenConflicts'));
    live.append(box);
  }
  out.push(live);

  if (confirming) {
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
  return out;
}
