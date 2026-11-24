import { t } from './i18n.mjs';
import { limitTime } from './interrupt.mjs';
import { el, svgEl, dotsIcon } from './dom.mjs';
import { whenText, leftText } from './schedule-times.mjs';

// 送信待ちが何を待っているか（core/message-queue.mjs の waiting）。待ちの理由が無い送信待ち（受け付けたばかり）は「送信中」
function queuedLabel(wait) {
  // 次のターンの設定の予約がある間は、main の返答が終わった時点（裏だけを待つ間も含む）で流れる（core/message-queue.mjs）
  if (wait?.reason === 'turn') return wait.detail === 'reserved' ? t('outbox.waitReply') : t('outbox.waitTurn');
  if (wait?.reason === 'order') return t('outbox.waitOrder');
  if (wait?.reason === 'preparing') return t('outbox.preparing');
  if (wait?.reason === 'limit') return t('outbox.waitLimit', { time: limitTime(wait.resetsAt) ?? t('interrupt.unknownTime') });
  return t('chat.delivery.sending');
}

/**
 * 送った発言の吹き出しの下の 1 行を、渡るまでの間の姿へ描く（docs/design-system.md「送信の表示」）。
 * 送信待ち・保留・結果不明・送れなかったものは、入力欄の上のカードではなく、会話の中の吹き出しの下に出す。
 *   queued   送信待ち（待っている理由）            ［取り消す］（act.edit があれば［編集］も）
 *   paused   送信を保留中（中断のあと）             ［再送する］［取り消す］
 *   unknown  送信結果を確認できません ＋ 注意の一文  ［再送する］［取り消す］
 *   failed   ✕ 送れませんでした · 理由              ［再送する］［取り消す］
 * 「送信中」（渡る前の弧と一言）は conversation-view.mjs の markDelivery が描く。
 * @param {HTMLElement} status 吹き出しの下の .outbox-status
 * @param {'queued'|'paused'|'unknown'|'failed'} kind
 * @param {{ waiting?: object|null, error?: string, act?: Record<string, () => Promise<unknown>> }} [o]
 *   act: 押したときの動き（retry・cancel・edit のうち使うもの）。失敗したら行の中に理由を出す
 */
export function paintUnsent(status, kind, { waiting = null, error = '', act = {} } = {}) {
  status.classList.remove('outbox-status-mark', 'outbox-fix', 'conn-fail');
  status.classList.add('outbox-status-failed');
  delete status.dataset.connectors;
  if (kind === 'failed') status.replaceChildren(el('b', null, t('chat.delivery.failed')), document.createTextNode(error ? ` · ${error}` : ''));
  else if (kind === 'unknown') status.replaceChildren(el('b', null, t('outbox.status.unknown')), el('span', 'hint', t('outbox.unknownHint')));
  else status.replaceChildren(document.createTextNode(kind === 'paused' ? t('outbox.status.paused') : queuedLabel(waiting)));
  unsentActions(status, kind === 'queued' ? ['edit', 'cancel'] : ['retry', 'cancel'], act);
}

/** 吹き出しの下の行に操作のボタンを足す（act に無いものは出さない）。押して失敗したら、行の最後に理由を出す */
export function unsentActions(status, names, act) {
  for (const name of names) {
    if (!act[name]) continue;
    const button = el('button', 'btn', name === 'retry' ? t('outbox.retry') : name === 'edit' ? t('schedule.rowEdit') : t('outbox.cancel'));
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      status.querySelector(':scope > .hint.err')?.remove();
      try { await act[name](); }
      catch (e) { status.append(el('span', 'hint err', e?.message ?? String(e))); }
      finally { button.disabled = false; }
    };
    status.append(button);
  }
}

// 画面に出した送信予定の id。新しく増えた行だけ、下から滑り込ませる
const seenSchedules = new Set();

/**
 * 送信予定の 1 行（docs/design-system.md「送信日時の指定」）。時刻を強い字、「あと 7 時間」と本文を弱い字にして 1 行に畳む。
 * 操作は［今すぐ送る］［編集］［取り消す］。枠が 540px より狭ければ ⋯ にまとめる。
 * 時刻を過ぎても送らなかった予定（entry.held）は「9:00 を過ぎました」と理由を出し、［今すぐ送る］［取り消す］で確かめさせる。
 */
function scheduleRow(entry, actions, now) {
  const missed = Boolean(entry.held);
  const row = el('div', `sched${missed ? ' missed' : ''}`);
  row.dataset.scheduleId = entry.id;
  const when = el('span', 'when');
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 12, cy: 12, r: 8 }), svgEl('path', { d: 'M12 7v5l3 2' }));
  when.append(svg, document.createTextNode(missed ? t('schedule.rowMissed', { when: whenText(entry.at, now) }) : whenText(entry.at, now)));
  if (!missed) when.append(el('span', 'left', `· ${leftText(entry.at, now)}`));
  const text = el('span', 'txt', missed ? `${t('schedule.rowMissedWhy')} ${entry.args?.prompt ?? ''}` : entry.args?.prompt ?? '');
  text.title = entry.args?.prompt ?? '';
  const acts = el('span', 'acts');
  const button = (name, label, cls) => {
    const b = el('button', `btn${cls ? ` ${cls}` : ''}`, label); b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      try { await actions[name](entry); }
      catch (e) { text.textContent = e.message; b.disabled = false; }
    };
    return b;
  };
  acts.append(button('now', t('schedule.sendNow'), 'btn-blue'), ...(missed ? [] : [button('edit', t('schedule.rowEdit'))]), button('cancel', t('schedule.rowCancel')));
  const more = el('button', 'btn more'); more.type = 'button';
  more.setAttribute('aria-label', t('schedule.rowMore')); more.setAttribute('aria-expanded', 'false');
  more.append(dotsIcon());
  more.onclick = () => { const open = row.classList.toggle('open'); more.setAttribute('aria-expanded', String(open)); };
  row.append(when, text, acts, more);
  if (!seenSchedules.has(entry.id)) {
    seenSchedules.add(entry.id);
    row.classList.add('enter');
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('enter')));
  }
  return row;
}

/**
 * 入力欄の上の送信予定の行（送信待ちのメッセージは会話の中の吹き出しへ出す。paintUnsent）。
 * @param {object[]} schedules この会話の送信予定（schedule.json の kind: 'send'。時刻順）
 * @param {{ now: Function, edit: Function, cancel: Function }|null} scheduleActions
 */
export function renderOutbox(root, schedules = [], scheduleActions = null) {
  root.replaceChildren();
  if (scheduleActions) {
    const now = Date.now();
    for (const entry of schedules) root.append(scheduleRow(entry, scheduleActions, now));
  }
  root.hidden = !root.children.length;
}
