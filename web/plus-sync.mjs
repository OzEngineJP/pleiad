// 設定 › Pleiad Plus の「同期」のまとまり（docs/plus.md「同期」。承認済みの形は docs/design-system.md「設定 › Pleiad Plus › 同期」）。
// 状態から DOM を作る純粋な関数（tests/unit/plus-sync-ui.mjs が tests/lib/dom-stub.mjs で動かす）。
// スイッチはアカウントの sync.enabled（status.account.sync）、状態は getSyncStatus() の形。
// 人に鍵を意識させない（ADR 0346）: 画面には「鍵」と出さない。状態はスイッチの行の中の 1 行で、見え方は 4 つだけ:
//   同期済み · {時刻}（idle）／同期しています…（syncing）／ほかの PC の許可を待っています（waiting_key の approval）
//   ／準備しています…（waiting_key の preparing・restarted。preparing に startsAt があれば「· {時刻} に始まります」）
// waiting_key の中身（status.wait.kind）:
//   approval  → 開く PC の名前（3 台まで）。確認コードの途中なら「{PC} の画面で、この数字を確かめて許可してください」と数字。
//               許可されなかった（deniedAt）ら 1 時間待つことを出す
//   preparing → relogin なら「ログインし直してください」とログインのボタン。ほかは状態の行だけ
//   restarted → 前の K の PC（scene 04）。「{name} で同期が始め直されました」と「{name} と同期する」（人が押すまで移らない）
// この PC が外された・活動していないが今の K を持っていて、ほかの PC が始め直そうとしている（status.recoveryAlert。scene 05）
//   → 知らせと「止める」。状態の行は出さない
// 「同期をリセット」は容量の上限（quota）のときだけ出す。確かめの窓を通してから送る
// stopped（アカウントの停止で止まっている）は誤りにしない。Plus と分かり直せば自動で回し直すので、ボタンも出さない
// update_required（この版では使えない api）→ 更新を促す。error の api_downgraded（券を取れた後に api が前の版を名乗った）→ 「同期できませんでした」
// 受け入れ待ち（status.inbox）が 1 件以上あれば、まとまりの終わりに「届いた変更 N 件」の行（押すと web/plus-inbox.mjs の面。ADR 0250）
import { el } from './dom.mjs';
import { t, lang } from './i18n.mjs';
import { button, switchButton, spinner } from './remote-parts.mjs';
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

/** 確認コードを 3 桁ずつに分ける（「731 058」。ほかの PC の許可の窓と同じ区切り）。6 桁でなければそのまま */
export function syncCodeText(code) {
  const s = String(code ?? '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

const PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
/** 台帳の platform（win32・darwin・linux）の名前。知らない値はそのまま */
export const pcPlatform = p => PLATFORMS[p] ?? (typeof p === 'string' ? p : '');

/** PC の名前。無ければ「名前の無い PC」 */
const pcName = name => (typeof name === 'string' && name ? name : t('settings.plus.syncUnnamedPc'));

/** PC の名前を「a」「a か b」「a・b か c」に（3 台まで。copy の syncNamesOr・syncNamesOrMore） */
export function pcNames(names) {
  const n = (Array.isArray(names) ? names : []).slice(0, 3).map(pcName);
  if (n.length <= 1) return n[0] ?? '';
  if (n.length === 2) return t('settings.plus.syncNamesOr', { a: n[0], b: n[1] });
  return t('settings.plus.syncNamesOrMore', { a: n[0], b: n[1], c: n[2] });
}

/**
 * スイッチの行の中の状態（4 つの見え方）。出さないときは null。
 * 戻り値 { kind: ok|wait|spin, text }
 */
export function syncStatusLine(s, { now = new Date() } = {}) {
  if (!s) return null;
  if (s.state === 'idle') return { kind: 'ok', text: t('settings.plus.syncSynced', { time: syncTimeText(s.lastSyncedAt, { now }) }) };
  if (s.state === 'syncing') return { kind: 'spin', text: t('settings.plus.syncing') };
  if (s.state !== 'waiting_key') return null;
  const w = s.wait ?? null;
  if (w?.kind === 'approval') return { kind: 'wait', text: t('settings.plus.syncWaitApproval') };
  if (w?.kind === 'preparing' && w.startsAt && Date.parse(w.startsAt) > now.getTime()) {
    return { kind: 'spin', text: t('settings.plus.syncPreparingAt', { time: syncTimeText(w.startsAt, { now }) }) };
  }
  return { kind: 'spin', text: t('settings.plus.syncPreparing') };
}

function statusSpan(line) {
  const st = el('span', `sync-st${line.kind === 'wait' ? ' is-wait' : ''}`);
  st.setAttribute('role', 'status');
  st.dataset.state = line.kind;
  st.append(line.kind === 'spin' ? spinner() : el('i', `rm-dot ${line.kind === 'ok' ? 'rm-dot-ok' : 'rm-dot-off'}`), el('span', null, line.text));
  return st;
}

/** 許可を待つ間の中身（approval）: 開く PC の名前・確認コード・許可されなかった */
function approvalLines(w, live) {
  const names = Array.isArray(w.approvers) ? w.approvers : [];
  if (w.deniedAt) {
    live.append(el('p', 'rm-warn', t('settings.plus.syncJoinDenied')), el('p', 'rm-sub', t('settings.plus.syncJoinDeniedHint')));
    return;
  }
  if (w.code) {
    live.append(el('p', 'rm-sub', names.length > 1
      ? t('settings.plus.syncApproveOnAny', { names: pcNames(names) })
      : t('settings.plus.syncApproveOn', { name: pcName(names[0]) })));
    const code = el('p', 'rm-ccode sync-code', syncCodeText(w.code));
    code.setAttribute('aria-label', `${t('settings.plus.syncCode')} ${syncCodeText(w.code)}`);
    live.append(code);
    return;
  }
  if (names.length) live.append(el('p', 'rm-sub', t('settings.plus.syncWaitApprovalHint', { names: pcNames(names) })));
}

/** 「同期するもの」の折り畳み。開くと同期するものの箇条書き（言語で変わる 3 項目は辞書、パスはコードの定数） */
function whatSynced() {
  const det = el('details', 'sync-what');
  det.append(el('summary', null, t('settings.plus.syncWhat')));
  const body = el('div', 'sync-what-body');
  const ul = el('ul', 'sync-what-list');
  for (const item of [t('settings.plus.syncWhatItem.settings'), '~/.claude/skills', '~/.agents/skills', t('settings.plus.syncWhatItem.pleiadSkills'), t('settings.plus.syncWhatItem.instructions')])
    ul.append(el('li', null, item));
  body.append(ul);
  det.append(body);
  return det;
}

/**
 * 「同期」の中身（見出し・スイッチと状態の行・中身・ボタン・競合の行）を返す。
 * @param enabled  account.sync.enabled（null・未定義は入）
 * @param sync     getSyncStatus() の形。まだ取れていなければ null
 * @param confirming  「同期をリセット」の確かめを出しているか（容量の上限のときだけ）
 * @param message  スイッチ・操作がうまくいかなかったときの文言（'' なら出さない）
 * @param busy     コマンドを送っている最中（ボタンを押せなくする）
 * @param recoveryNote  始め直しを止める操作の結果の一言（stopped・stopFailed・gone。'' なら出さない）
 * @param onRecoveryStop  ほかの PC の始め直しを止める（scene 05）
 * @param onAcceptRestart  (keyId) ほかの PC で始め直された同期に加わる（scene 04）
 * @param onLogin     ログインし直す（始め直しに最近のログインが要るとき）
 * @param now         いまの時刻（時刻の書式・始まる時刻が過ぎたか）
 */
export function renderSync({ enabled = true, sync = null, confirming = false, message = '', busy = false,
  onToggle = () => {}, onNow = () => {}, onAskReset = () => {}, onCancelReset = () => {}, onReset = () => {}, onOpenConflicts = () => {},
  onOpenInbox = () => {}, recoveryNote = '', onRecoveryStop = () => {}, onAcceptRestart = () => {}, onLogin = null, now = new Date() } = {}) {
  const out = [];
  out.push(el('div', 'rm-gh', t('settings.plus.sync')));

  const s = sync ?? {};
  const alert = enabled && s.state !== 'disabled' ? s.recoveryAlert ?? null : null;
  const line = enabled && !alert ? syncStatusLine(s, { now }) : null;
  const row = el('div', 'rm-mrow sync-row');
  const text = el('div', 'rm-rt');
  text.append(el('span', 'rm-lbl', t('settings.plus.syncSwitch')));
  if (line) text.append(statusSpan(line));
  const sw = switchButton(t('settings.plus.syncSwitch'), () => onToggle(!enabled));
  sw.setAttribute('aria-checked', String(enabled === true));
  sw.disabled = busy;
  sw.dataset.fk = 'syncToggle';
  row.append(text, sw);
  out.push(row);
  out.push(whatSynced());
  if (message) out.push(el('p', 'rm-err', message));

  if (!enabled) return out;   // アカウントで切っている: 状態は出さない
  const live = el('div', 'sync-live');
  live.setAttribute('aria-live', 'polite');
  const acts = el('div', 'rm-acts');
  let hasActs = false;
  const act = (label, onclick, className, fk) => { hasActs = true; acts.append(actButton(label, onclick, className, fk)); };

  switch (s.state) {
    case 'disabled':    // アカウントで止められている。状態は出さない
    case 'syncing':
      break;
    case 'idle':        // 状態はスイッチの行に出ている。ボタンは「今すぐ同期」だけ
      act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
      break;
    case 'waiting_key': {
      const w = s.wait ?? null;
      if (w?.kind === 'approval') approvalLines(w, live);
      else if (w?.kind === 'restarted') {
        // scene 04: 前の K では確かめられない始め直し。人が押すまで移らない
        const name = pcName(w.byName);
        live.append(el('p', 'rm-warn', t('settings.plus.syncRestarted', { name })), el('p', 'rm-sub', t('settings.plus.syncRestartedHint')));
        act(t('settings.plus.syncAcceptRestart', { name }), () => onAcceptRestart(w.keyId), 'btn', 'syncAcceptRestart');
      } else if (w?.kind === 'preparing' && w.relogin) {
        live.append(el('p', 'rm-sub', t('settings.plus.syncPreparingRelogin')));
        if (onLogin) act(t('settings.plus.syncRelogin'), onLogin, 'btn btn-primary', 'syncRelogin');
      }
      break;
    }
    case 'unregistered':   // この PC の登録が外れた。登録し直すと自動で回し直す
      if (!alert) live.append(el('p', 'rm-weak', t('settings.plus.syncUnregistered')), el('p', 'rm-sub', t('settings.plus.syncUnregisteredHint')));
      break;
    case 'update_required':   // この版では使えない api。更新すると再開する
      live.append(el('p', 'rm-err', t('settings.plus.syncUpdateRequired')), el('p', 'rm-sub', t('settings.plus.syncUpdateRequiredHint')));
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
        // api の 503: Pleiad Plus が止まっている。誤りではなく待ち（engine が間をおいてやり直す）
        live.append(el('p', 'rm-weak', t('settings.plus.paused')), el('p', 'rm-sub', t('settings.plus.syncPausedNote')));
        act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
        break;
      }
      const detail = code === 'network' ? t('settings.plus.syncErrUnavailable')
        : code === 'rate_limited' ? t('settings.plus.syncErrRetry')
        : code === 'api_downgraded' ? t('settings.plus.syncErrServer') : t('settings.plus.syncErrOther');
      live.append(el('p', 'rm-err', t('settings.plus.syncFailed')), el('p', 'rm-sub', detail));
      // api_downgraded は起動し直すまで試さない（今すぐ同期を押しても同じ）
      if (code !== 'api_downgraded') act(t('settings.plus.syncNow'), onNow, 'btn', 'syncNow');
      break;
    }
    default:   // 'off'・まだ取れていない
      if (!alert) live.append(el('p', 'rm-weak', t('settings.plus.syncOff')));
  }

  // scene 05: 外された・活動していないこの PC が今の K を持っていて、ほかの PC が始め直そうとしている。止められる
  if (alert) {
    live.append(el('p', 'rm-warn', t('settings.plus.syncRecoveryAlert', { name: pcName(alert.requestedByName) })),
      el('p', 'rm-sub', t('settings.plus.syncRecoveryAlertHint', { time: syncTimeText(alert.readyAt, { now }) })));
    act(t('settings.plus.syncRecoveryStop'), onRecoveryStop, 'btn', 'syncRecoveryStop');
  }
  if (recoveryNote) {
    // i18n-dynamic: settings.plus.syncRecoveryNote.
    live.append(el('p', recoveryNote === 'stopped' ? 'rm-sub' : 'rm-warn', t(`settings.plus.syncRecoveryNote.${recoveryNote}`)));
  }
  // 許可した新しい PC（7 日の間）。この PC が同期している間だけ出す（待っている間は出さない）
  if (!alert && (s.state === 'idle' || s.state === 'syncing')) {
    for (const to of Array.isArray(s.sharedTo) ? s.sharedTo : []) {
      live.append(el('p', 'rm-sub', t('settings.plus.syncSharedTo', { name: pcName(to.name), time: syncTimeText(to.at, { now }) })));
    }
  }
  if ((s.conflicts ?? 0) >= 1) {
    const ctext = el('span', 'rm-rt');
    ctext.append(el('span', 'rm-nm', t('settings.plus.syncConflicts', { n: s.conflicts })), el('span', 'rm-sub', t('settings.plus.syncConflictDays')));
    const box = el('div', 'rm-mrow');
    box.append(ctext, actButton(t('settings.plus.syncOpenFolder'), onOpenConflicts, 'btn btn-quiet', 'syncOpenConflicts'));
    live.append(box);
  }
  out.push(live);
  if (confirming && s.state === 'quota') {
    const box = el('div', 'rm-confirm');
    box.append(el('p', 'sync-confirm-title', t('settings.plus.syncResetTitle')), el('p', null, t('settings.plus.syncResetBody')));
    const cacts = el('div', 'rm-acts');
    const no = actButton(t('settings.plus.cancel'), onCancelReset, 'btn btn-quiet', 'syncResetNo');
    const yes = actButton(t('settings.plus.syncResetYes'), onReset, 'btn rm-danger', 'syncResetYes');
    no.disabled = busy; yes.disabled = busy;
    cacts.append(no, yes);
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
