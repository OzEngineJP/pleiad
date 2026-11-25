// 委譲の子の完了通知のうち、出来事の行と「結果」「エラー」の段落を組む（ADR 0352 §7）。
// core/server.mjs の completionNotice が使う。サーバーを立てずに文を確かめられるよう分けている（tests/unit/task-notice-events.mjs）
import { agentT } from './i18n.mjs';

// 子の回が再び動いたきっかけの文の鍵（ADR 0352）
// i18n-dynamic: agent:delegation.wake
const WAKE_NOTICE_KEYS = { parent: 'delegation.wakeParent', human: 'delegation.wakeHuman', handoff: 'delegation.wakeHandoff', resume: 'delegation.wakeResume', relay: 'delegation.wakeRelay' };
// 子の回の終わり方の文の鍵（ADR 0352）。止めた側（stoppedBy）が分からない取り消しは「取り消された」
// i18n-dynamic: agent:delegation.eventEnd
const EVENT_END_KEYS = { completed: 'delegation.eventEndCompleted', failed: 'delegation.eventEndFailed', human: 'delegation.eventEndHuman', parent: 'delegation.eventEndParent', owner: 'delegation.eventEndOwner', cancelled: 'delegation.eventEndCancelled' };
const TASK_ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STOPPERS = new Set(['human', 'parent', 'owner']);

/**
 * 通知に載せる出来事（ADR 0352）。出来事を持たない古い行（版を上げる前に積まれた通知）は、状態と止めた側から回の終わりを 1 つ組み立てる（legacy）
 */
export function noticeEvents(task) {
  const active = TASK_ACTIVE.has(task.status);
  const events = Array.isArray(task.events) ? task.events : [];
  if (!active && !events.some(e => e.kind === 'run') && ['completed', 'failed', 'cancelled'].includes(task.status)) {
    return { active, legacy: true, events: [{ kind: 'run', status: task.status, stoppedBy: task.stoppedBy, cause: task.wake?.kinds ?? [], result: '' }, ...events] };
  }
  return { active, legacy: false, events };
}

/**
 * 通知の「結果」「エラー」の段落を出すか（ADR 0352 §7）。row.result・row.error は、結果を書いた最後の回のもの。
 * - 子が動いている（次の回が始まった）: 出さない。終わった回の返答・エラーは出来事の行に載る（同じ返答を 2 度載せない）
 * - 止まっている: 最後の回の終わりの出来事に返答かエラーがあるときだけ出す。結果を書かずに止まった回（始まる前・取り直しの途中で止めた）に、
 *   前の回の古い結果を今の結果として見せない。出来事の無い古い行・回の終わりが無い行は今までどおり出す
 */
export function noticeOwnsResult(task) {
  const { active, legacy, events } = noticeEvents(task);
  if (active) return { result: false, error: false };
  const last = events.findLast(e => e.kind === 'run');
  if (legacy || !last) return { result: true, error: true };
  return { result: Boolean(last.result), error: Boolean(last.error) };
}

/**
 * 完了通知の「これまでの出来事」（ADR 0352）。agent-tasks が残した、まだ届けていない出来事（task.events）を起きた順に 1 行ずつ並べ、
 * 届ける時点の子の状態を添える。子が止まっているときの最後の回の返答・エラーは、通知の「結果」「エラー」の段落に載るので行には載せない。
 * 子が動いているときは「結果」の段落を出さないので（noticeOwnsResult）、どの回の返答も行に載せる
 */
export function eventsNotice(lng, task) {
  const { active, events } = noticeEvents(task);
  if (!events.length) return '';
  const lastRun = events.findLastIndex(e => e.kind === 'run');
  const lines = [];
  if (task.eventsDropped > 0) lines.push(agentT(lng, 'delegation.eventsDropped', { count: task.eventsDropped }));
  events.forEach((e, i) => {
    const then = i ? agentT(lng, 'delegation.eventThen') : '';
    if (e.kind === 'human') {
      lines.push(agentT(lng, 'delegation.eventHuman', { then, text: e.text ?? '',
        attachments: e.attachments > 0 ? agentT(lng, 'delegation.eventAttachments', { count: e.attachments }) : '' }));
      return;
    }
    const how = e.status === 'cancelled' ? (STOPPERS.has(e.stoppedBy) ? e.stoppedBy : 'cancelled') : e.status;
    const causes = (e.cause ?? []).filter(kind => WAKE_NOTICE_KEYS[kind]).map(kind => agentT(lng, WAKE_NOTICE_KEYS[kind]));
    const shown = active || i !== lastRun;
    // i18n-dynamic: agent:delegation.eventPartial
    // i18n-dynamic: agent:delegation.eventReply
    lines.push(agentT(lng, 'delegation.eventRun', { then,
      how: EVENT_END_KEYS[how] ? agentT(lng, EVENT_END_KEYS[how]) : how,
      cause: causes.length ? agentT(lng, 'delegation.eventCause', { causes: causes.join(agentT(lng, 'delegation.wakeSeparator')) }) : '',
      reply: shown && e.result ? agentT(lng, e.status === 'cancelled' ? 'delegation.eventPartial' : 'delegation.eventReply', { text: e.result }) : '',
      error: shown && e.error ? agentT(lng, 'delegation.eventError', { text: e.error }) : '' }));
  });
  const hint = (events.some(e => e.kind === 'run' && e.status === 'cancelled') ? agentT(lng, 'delegation.eventStopHint') : '')
    + (events.some(e => e.kind === 'human') ? agentT(lng, 'delegation.eventHumanHint') : '');
  // i18n-dynamic: agent:delegation.eventStateRunning
  // i18n-dynamic: agent:delegation.eventStateStopped
  return agentT(lng, 'delegation.noticeEvents', { lines: lines.join(''),
    state: agentT(lng, active ? 'delegation.eventStateRunning' : 'delegation.eventStateStopped'), hint });
}

/**
 * 通知の「結果」「エラー」の段落（completionNotice の result・error）。出さないときは空。結果は limit 字まで（切った分は ply_task_status の offset で読める）
 */
export function noticeResultParts(lng, task, limit) {
  const own = noticeOwnsResult(task);
  const result = String(task.result ?? '');
  return {
    result: own.result ? agentT(lng, 'delegation.noticeResult', { text: result.slice(0, limit),
      more: result.length > limit ? agentT(lng, 'delegation.noticeMore', { offset: limit }) : '' }) : '',
    error: own.error ? task.error ?? '' : '',
  };
}
