import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t, agentT } from './i18n.mjs';
import { observeCommand, pauseCommands, commandElapsed, commandView, isWaitingCommand, commandKey, outputMoving, OUTPUT_MOVING_MS } from './task-commands.mjs';
import { taskTitle } from './task-title.mjs';
import { clockText } from './limit-resume.mjs';
import { openData } from './data-schema.mjs';
import { taskTable } from './db.mjs';
import { REMOTE_TASK_FIELDS } from './remote/agent-protocol.mjs';
import { redactForPeer } from './redact.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
// 完了通知がまだ依頼元に届いていない（終わった直後・送る前・送っている最中）。running にはこの間だけ終わったタスクも載せる
const UNDELIVERED = new Set(['none', 'pending', 'delivering']);
// ホストの便りから写しの行へ写す項目（agent-tasks の mirror）。便りの項目との対応は core/remote/agent-protocol.mjs の
// REMOTE_TASK_FIELDS が正本（cancelPending・hostLost は便りに無く、端末側が付ける印）
const MIRROR_FIELDS = [...REMOTE_TASK_FIELDS.flatMap(f => f.mirror ? [f.mirror].flat() : f.plain ? [f.wire] : []), 'cancelPending', 'hostLost'];
// ホストの子を止める依頼を待つ上限。応答しないホストが、会話の中断・「すべて止める」を長く止めない（届かなかった分は cancelPending でつながり直したときに送り直す）
const CANCEL_HOST_MS = 3000;
// 上限で止まった枠（エージェント・モデル・アカウント）。完了通知が、自動の振り分けでいつまで飛ばすかを引くのに使う（Issue #111）
const slotOf = limit => typeof limit?.backend === 'string' ? { backend: limit.backend, model: limit.model ?? null, account: limit.account ?? null } : {};
// ホストが便りで返す taskId の形。端末の台帳の鍵にするので、形を確かめる（__proto__ や手元のタスクの ID を入れさせない）
const TASK_ID = /^ply-task-[0-9a-f-]{36}$/;
// 保存障害の間、スケジューラーが保存をやり直す間隔の上限（ms）。500ms から倍にしていく
const RETRY_MAX = 15000;
// 保存障害の記録（agent-tasks-errors.log）の大きさの上限。超えたら新しい半分だけ残す
const LOG_MAX = 64 * 1024;
// 1 タスクに持つ「知らせた」印（同じコマンド・同じ無音の状態を繰り返し知らせないための印）の上限。古いものから捨てる（ADR 0138）
const NOTICED_MAX = 50;
// 1 タスクに持つ実行前の拒否（rejections）の上限。超えた分は捨て、rejectionsDropped に数だけ残す
const MAX_REJECTIONS = 50;
// 1 タスクに持つ、まだ依頼元へ届けていない出来事（events。回の終わり・人の直接の指示。ADR 0352）の上限。
// 超えたら古いものから捨て、eventsDropped に数だけ残す（届けるときの今に近い出来事を残す）
const MAX_EVENTS = MAX_REJECTIONS;
// 出来事に残す人の指示の本文・子の返答の長さ（core/redact.mjs で秘密の形を伏せてから切る）
const EVENT_TEXT_MAX = 300;
const clip = value => redactForPeer(String(value ?? ''), EVENT_TEXT_MAX) ?? '';
// 届けていない出来事に、回の終わりがあるか（あれば依頼元へ知らせる。人の指示だけなら次の知らせに載せる）
const runEvents = r => Boolean(r.events?.some(e => e.kind === 'run'));
// 完了通知を送ってよいタスクの状態。止まった子と、届けていない回の終わりを持つ子（次の回が走っていても先に届ける）
const deliverable = r => !ACTIVE.has(r.status) || runEvents(r);
// 自動の振り分けの子が仕事を始める前に断られたときの、任せ直しの上限（ADR 0302。2 回の任せ直し = 合計 3 候補まで）
const REROUTE_MAX = 2;
// CLI/API がモデルを断った回（ADR 0311）は、断られた枠が断った理由付きで残るので、全部の候補を順に試せる上限を高くする
const MODEL_REROUTE_MAX = 6;
// 子が返答を終えて裏の作業だけを待つ間の、最初の知らせまでの猶予（docs/agent-delegation.md「子に残った裏の作業」）。
// すぐ終わる裏の作業（短いサブエージェントなど）のたびに、依頼元のターンを起こさない。知らせ直す周期がこれより短ければ周期に合わせる
const BACKGROUND_FIRST_MS = 60_000;
// 子の再試行の待ち（ADR 0229）を「待っている」（status: waiting・依頼元への知らせ）に数える長さ。上限による待ちは長さによらず数える。
// 一時的な失敗の短い待ち（数秒〜数十秒で自分で戻る）のたびに、依頼元のターンを起こさない
const RETRY_WAIT_MS = 60_000;
// これらの通知の状態なら、今の rejections は依頼元へ渡した（か、止めた）。ply_task_send で始まる次の回は新しく数え直す
// read: 依頼元が ply_task_status / ply_task_wait で完了と結果を受け取った（完了通知は送らない。ADR 0057）
const NOTICED = new Set(['delivering', 'sent', 'unknown', 'suppressed', 'read']);
// 依頼元が結果を受け取ったら通知の対象から外す状態（終わって、まだ通知を送っていない）
const readable = r => ['completed', 'failed'].includes(r.status) && ['none', 'pending'].includes(r.notification);
// call() のエラーと子への依頼文はエージェントが読むので、会話の言語（locale）で引く（agent 名前空間）
const text = (locale, value, name, max = 60000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(agentT(locale, 'tasks.textLength', { name, max }));
  return value;
};

/**
 * 子の会話の記録（getMessages）から、委譲の結果にする返答を選ぶ（docs/agent-delegation.md「子の結果」）。
 * この回（最後の user の発言より後）の assistant の本文のうち、最後のもの。ただし、バックエンドが
 * stopHookFollowUp を付けた発言（Stop フックに止められて書いた、中身の仕事をしていない続き。Claude の
 * claude-normalize.mjs の stopHookFollowUps）は飛ばす。飛ばすと何も残らないときは、今までどおり最後の本文
 */
/**
 * 子の作業場所の git の 1 行の要約（変更: <branch> · N ファイル +a −d · コミット k。ADR 0085）。依頼元の言語で。
 * 完了通知（core/server.mjs）と ply_task_status・ply_task_wait の gitSummary が同じ文を使う。要約が無ければ空
 */
export function gitLine(locale, git) {
  if (!git) return '';
  return agentT(locale, 'delegation.noticeGit', { branch: git.branch ?? git.head ?? '(detached)', files: git.files, add: git.add, del: git.del, commits: git.commits });
}

/**
 * 子の worktree の 1 行（作業場所: worktree <branch>（未取り込み · N ファイル）。ADR 0089）。依頼元の言語で。
 * state は core/worktree-host.mjs の taskState（unmerged / merged / empty / unknown / gone）。完了通知と ply_task_status・ply_task_wait の workspaceSummary が同じ文を使う。
 * 作業場所が無ければ（分けていない子）空
 */
export function workspaceLine(locale, worktree, state) {
  if (!worktree) return '';
  const branch = state?.branch ?? worktree.branch, path = state?.path ?? worktree.path, origin = state?.origin ?? worktree.origin;
  const kind = state?.state ?? 'unknown';
  if (kind === 'unmerged') return agentT(locale, 'delegation.noticeWorkspaceUnmerged', { branch, files: state.files ?? 0, path, origin });
  if (kind === 'merged' || (kind === 'gone' && state?.removedAs === 'merged')) return agentT(locale, 'delegation.noticeWorkspaceMerged', { branch });
  if (kind === 'empty' || (kind === 'gone' && state?.removedAs === 'empty')) return agentT(locale, 'delegation.noticeWorkspaceEmpty', { branch });
  // 未取り込みだったものが、もう無い（依頼元が取り込んで片付いた・退避して消した）
  if (kind === 'gone') return agentT(locale, 'delegation.noticeWorkspaceGone', { branch });
  return agentT(locale, 'delegation.noticeWorkspaceUnknown', { branch, path });
}

/**
 * ply_delegate の依頼元へ返す形。taskId を先頭に置き（結果を切った履歴の画面でもカードを子に結び付けられる。web/delegate-result.mjs）、
 * 依頼元が書いた依頼文 task は返し直さない（依頼元は持っている。画面のカードの「依頼」は入力から描く）
 */
export function delegateReply({ taskId, task, ...rest }) {
  return { taskId, ...rest };
}

export function finalReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const reply = (m) => m?.role === 'assistant' && typeof m.text === 'string' && m.text;
  const run = list.slice(list.findLastIndex((m) => m?.role === 'user') + 1);
  return (run.findLast((m) => reply(m) && !m.stopHookFollowUp) ?? list.findLast(reply))?.text ?? '';
}

// Pleiad owns these tasks, independently of each engine's native subagent registry.
// Writes are serialized; only the scheduler starts work. No blind replay after a crash.
// 保存の失敗（docs/agent-delegation.md「保存・画面・再起動」）:
// - 保存に失敗しても manager は閉じない。closed は close()（正常終了）だけが立てる。
// - 先へ進む前に保存が要る書き換え（受け付け・子の実行の開始・通知を送る前の delivering）は、失敗したらメモリを戻して進まない（commit）。
// - 起きたことの記録（結果・送った通知・止めたこと）は取り消せないので、メモリはそのままにして後で書き直す（record）。
// - 障害の間は、スケジューラーは間隔を空けて保存をやり直すだけにする。list / status はメモリの状態を障害中の印付きで返す。
// ready は「親が完了通知を受け取れるか」。受け取れない間は delivering にせず、ファイルも書かない。
// 記録は SQLite の agent_tasks（1 タスク 1 行。core/db.mjs、ADR 0115）。保存するのは変わった行だけで、タスクが増えても 1 回の保存は重くならない。
// taskStorage・io・log・retryMax はテストで失敗を差し込み、記録を読み、待ちを縮めるためのもの（taskStorage は { loadRows(), save(rows) }、io は障害の記録のファイル）
// ready は「親が新しいターンで完了通知を受け取れるか」、steerable は「走っている親のターンへ今すぐ渡せるか」（ADR 0057）。
// deliver は同じ親へ届ける完了通知（1 件以上）をまとめて受け取る。無音・コマンドの通知は ready だけで決める
// childSteerable は「走っている子のターンへ追加指示を今すぐ渡せるか」、steer(task, { id, text }) はその途中送信。
// 'delivered'（受理。合図の無いバックエンドは渡ったものとして扱う）/ 'pending'（受理。渡った合図を steered() で待つ）/
// 'requeue'（受理されない。待機のまま次のターンで）/ 'wait'（今は渡せないが、このターンで受けられるかもしれない。
// 準備中・送信待ちの消化など。待機のまま残し、次の kick や ready の通知でまた試す）/ 'error'（結果不明。送り直さない）を返す（ADR 0065）。
// accepted は指示を受け付けて保存できた直後に 1 回だけ呼ぶ口（呼ぶ側は表示位置を確定させる）。
// anchorProbe(sessionId) は受け付けた時点で「直前に見えていたもの」の印を返す口（保存される instruction.anchor になる。
// 読み直し後の表示位置をその位置へ戻すための永続の錨）。Promise を返してよい（呼び出し側で await する）
// deliver / deliverSilence / deliverCommand / deliverBackground の最後の引数 { accepted } は「親の会話がこの通知を受け取った」合図で、
// 通知でターンが始まるときは、ターンが終わるまで待たずに呼ぶ。呼ぶと台帳は先に 'sent' を保存し（notify のみ）、通知を settling から外す。
// この一覧は実行中の作業を表示するための写し。更新は作業件数を待たず、DB と保持役の記録から通常起動で復元する（ADR 0270）。
// 受理の前（送ったかどうか分からない短い間）だけ settling に残す。受理の後は送り直さないので二重には届かない。
export async function createAgentTasks({ dataDir, prepare, rollback = async () => {}, execute, deliver, deliverSilence = async () => 'ok', deliverCommand = async () => 'ok', cancelBackground = async () => {}, ready = async () => true, steerable = async () => false, childSteerable = async () => false, steer = async () => 'requeue', changed = () => {}, waiting = () => false, accepted = () => {}, anchorProbe = () => null,
  // 自動の振り分けの子が仕事を始める前に断られたとき、次の候補で新しい子の会話を作る口（ADR 0302）。
  // (task, failed: { outcome, error }) → prepare の戻り値と同じ形、次の候補が無ければ null
  reroute = async () => null,
  // リモートのホストに任せたタスクの写し（row.host を持つ行。docs/agent-delegation.md「リモートのホストへ任せる」）: 今、依頼元の会話に中継された承認を待っているか・ホストのタスクを止める口
  remoteWaiting = () => false, cancelHost = async () => {},
  // コンピューターの操作のロックを待っているか（docs/computer-use.md「ロック・待ち・止めた印」）。承認待ちではないので status: waiting にはせず、沈黙の通知にだけ数えない
  lockWaiting = () => false,
  // 子の worktree の今の状態（core/worktree-host.mjs の taskState）。ply_task_status・ply_task_wait の workspaceSummary に使う
  workspaceState = async () => null,
  // 子が返答を終えて裏の作業だけを待っているか（ADR 0170）。待っていれば { since（待ち始めた時刻 ms）, tasks: [{ kind, label }] }、無ければ null。
  // 待っている間は止めず、依頼元へ deliverBackground で知らせ、backgroundMinutes ごとに知らせ直す
  backgroundWaiting = () => null, deliverBackground = async () => 'ok',
  // 止まったタスクに残った裏のコマンド（state: background）が、まだ生きているか（docs/agent-delegation.md「子に残った裏の作業」）。
  // (sessionId, { toolCallId, nativeTaskId, processId }) で引き、true / false、分からなければ null。false なら記録から外す。
  // OS のプロセス ID を渡すバックエンドは無いので、server はバックエンドが挙げている裏の作業の一覧（findBackgroundTask）で答える
  commandAlive = () => null,
  // 子が上限・一時的な失敗のあと再試行を待っているか（ADR 0229）。待っていれば { attempt, next（次の再試行の時刻 ms）, message, reason, limit, since（待ちの回の始まり）, seenAt }、
  // 無ければ null。長い・上限による待ちは status: waiting にし（ply_task_wait を待たずに返す）、待ちの回ごとに 1 回 deliverRetry で依頼元へ知らせる
  retrying = () => null, deliverRetry = async () => 'ok',
  deliverLimitSwitch = async () => 'ok',
  // 上限で止まった子の会話の、解除時刻までの待ち（{ resetsAt } か null）。待っている間は、積まれた指示（ply_task_send）で次の回を始めない
  held = () => null,
  // 依頼元の会話が止められているか（直前のターンが中断で終わり、その後ターンが始まっていない。ADR 0352）。
  // 止められている間は、その会話への終了通知でターンを始めない（次のターンの始めに takeHeld で渡す）
  ownerStopped = () => false,
  canStart = () => true, resumeQueued = false,
  now = Date.now, silenceMinutes = Number(process.env.AGENT_HOST_TASK_SILENCE_MINUTES ?? 5),
  commandMinutes = Number(process.env.AGENT_HOST_TASK_COMMAND_MINUTES ?? 5),
  backgroundMinutes = Number(process.env.AGENT_HOST_TASK_BACKGROUND_MINUTES ?? 30),
  io = fs, log = line => console.error(line), retryMax = RETRY_MAX, taskStorage = null,
  // 付け直すターン（無停止の更新 2b-7）の委譲の子のタスク id。起動の復元で interrupted にせず、adoptRun() が結果の確定を引き継ぐ（stage2-server-state.md S8）
  adopting = [], stopUnconfirmed = () => false, reportUnconfirmedStop = async () => {},
  recoverNotice = async () => 'unknown',
  // 子の回が終わり、止まった状態（完了・失敗・取り消し）になった。子の会話の id を渡す。エージェントのブラウザーのデーモンを止める（core/agent-browser.mjs。ADR 0180）
  ended = () => {} }) {
  const silenceMs = Number.isFinite(silenceMinutes) && silenceMinutes > 0 ? silenceMinutes * 60000 : 0;
  const commandMs = Number.isFinite(commandMinutes) && commandMinutes > 0 ? commandMinutes * 60000 : 0;
  const backgroundMs = Number.isFinite(backgroundMinutes) && backgroundMinutes > 0 ? backgroundMinutes * 60000 : 0;
  const commandNotices = new Map(), backgroundNotices = new Set();   // commandNotices は noticeId -> taskId
  const logFile = path.join(dataDir, 'agent-tasks-errors.log');
  let handle = null;
  let rowStore = taskStorage;
  if (!rowStore) {
    handle = openData(dataDir);
    const rows = taskTable(handle.db);
    rowStore = { loadRows: () => rows.loadRows(), save: list => rows.save(list) };
  }
  // 最後に DB へ書けた JSON（taskId -> 文字列）。変わった行だけを書くための比べ元
  const saved = new Map();
  let records = Object.create(null);   // 鍵はホストの便りの taskId も入る。Object.prototype の名前（__proto__ など）で引かれないようにする
  for (const [taskId, json] of rowStore.loadRows()) { records[taskId] = JSON.parse(json); saved.set(taskId, json); }
  // ホストに任せたタスクの写し（host）は、この PC の会話を持たない（sessionId なし）。会話の ID で引く表には入れない
  const bySession = new Map(Object.values(records).filter(r => r.sessionId).map(r => [r.sessionId, r]));
  // Older files kept only prompt strings in queue. Preserve their order and make
  // pending follow-ups visible without replaying the initial delegation request.
  // 承認待ちか。ホストに任せたタスクの写しは、ホストの便り（hostWaiting）か、依頼元の会話に中継された承認の有無で決まる
  // 子の再試行の待ち（走っている手元の子だけ）と、そのうち「待っている」に数えるもの（上限・長い待ち・次の時刻が分からない待ち）
  const retryOf = r => !r.host && r.status === 'running' && r.sessionId ? retrying(r.sessionId) ?? null : null;
  const longRetry = rt => Boolean(rt) && (rt.limit || !Number.isFinite(rt.next) || rt.next - (rt.seenAt ?? rt.since ?? now()) >= RETRY_WAIT_MS);
  const retryWaitOf = r => { const rt = retryOf(r); return longRetry(rt) ? rt : null; };
  const heldOf = r => !r.host && r.sessionId && r.status === 'queued' ? held(structuredClone(r)) ?? null : null;
  // 依頼元が止められている間の終了通知（ADR 0352）は送らず、依頼元の次のターンの始めに渡す（takeHeld）。
  // 依頼元の会話ごと止めた・取り消した子孫の行（ownerStop。依頼元のターンが始まったら ownerResumed が外す）と、
  // 依頼元の会話が中断のままの行（ownerStopped）。ホストに任せた子は決まりの外（今までどおり）
  const heldNotice = r => !r.host && Boolean(r.parentSessionId) && (r.ownerStop === true || ownerStopped(r.parentSessionId) === true);
  // 再試行を待っている子（retryWaitOf）も待っているものに数える（人の承認ではないが、待つ相手が子の外にある。ADR 0229）
  const waitingOf = r => r.host ? r.hostWaiting === true || remoteWaiting(r) : waiting(r.sessionId) || Boolean(retryWaitOf(r));
  const lockWaitingOf = r => r.host ? r.hostLockWaiting === true : lockWaiting(r.sessionId);
  const backgroundOf = r => r.host ? r.hostBackground ?? null : backgroundWaiting(r.sessionId);
  // 子の回が終わった（run.result・run.error）。前景のコマンド（running・承認待ち）は回と一緒に終わっている。
  // 終わりの合図（tool.result・task.command）が来ないまま回が終わった分（上限・バックエンドの異常終了で途中で止まった）を外す。
  // 裏へ回ったもの（background）と、再起動・app-server の入れ替わりで生存が分からないもの（unknown）は残す
  // （docs/agent-delegation.md「子に残った裏の作業」）
  const endTurnCommands = r => {
    if (r.activeCommands?.length) r.activeCommands = r.activeCommands.filter(c => ['background', 'unknown'].includes(c.state));
  };
  // 止まったタスク（完了・失敗・取り消し・中断）に残った裏のコマンドは、バックエンドがまだ裏の作業として挙げている間だけ残す。
  // 挙げなくなった（終わった・プロセスが居ない）ものは外す。commandAlive が分からない（null）と答えたものは残す
  const settleCommands = r => {
    if (r.host || ACTIVE.has(r.status) || !r.activeCommands?.length) return;
    r.activeCommands = r.activeCommands.filter(c => {
      if (c.state !== 'background') return true;
      let alive = null;
      try { alive = commandAlive(r.sessionId, { toolCallId: c.toolCallId, nativeTaskId: c.nativeTaskId ?? null, processId: c.processId ?? null }); } catch { alive = null; }
      return alive !== false;
    });
  };
  for (const r of Object.values(records)) {
    // In rows with instruction IDs, a plain first entry is the original prompt, even after a follow-up was queued.
    const initial = r.status === 'queued' && ((Array.isArray(r.instructions) && r.instructionRevision !== undefined) ||
      (!r.revision && !r.result && r.createdAt === r.updatedAt));
    r.instructions ??= [];
    r.queue = (r.queue ?? []).map((entry, index) => {
      if (typeof entry !== 'string' || (initial && index === 0)) return entry;
      const instruction = { id: crypto.randomUUID(), text: entry, at: r.updatedAt ?? r.createdAt ?? Date.now(), state: 'queued' };
      r.instructions.push(instruction);
      return { instructionId: instruction.id };
    });
  }
  const setInstruction = (r, id, state) => {
    if (!id) return;
    const instruction = r.instructions?.find(x => x.id === id);
    if (instruction && instruction.state !== state) { instruction.state = state; r.instructionRevision = (r.instructionRevision ?? 0) + 1; }
  };
  const dropInstructions = r => {
    for (const instruction of r.instructions ?? []) { deferredInstructions.delete(instruction.id); if (instruction.state === 'queued') setInstruction(r, instruction.id, 'dropped'); }
    r.queue = [];
  };
  let writes = Promise.resolve(), closed = false, mutating = false, probing = false;
  // fault: 保存障害（最後の失敗の errno・操作・タスク ID・時刻）。dirty: メモリにだけある記録が残っている
  let fault = null, dirty = false;
  // ファイルに書けた通知の状態（taskId → notification）。ファイルがすでに delivering なら送る前に書き直さない
  let persisted = new Map(Object.values(records).map(r => [r.taskId, r.notification]));
  // noticeOwners: 完了通知を送っている最中の親（同じ親への配送は 1 つずつ。次に溜まった分は次の kick でまとめて送る）
  // waited: 依頼元が ply_task_wait で待っているタスク（taskId → 待ちの数）。待ちの間は完了通知を送らない（ADR 0057）
  // steers: 走っている子のターンへ途中送信で渡している追加指示（taskId → 指示 ID の集合）。メモリだけ（再起動では sending が delivered に戻る）
  const steers = new Map();
  // RPC の送信順だけを直列化する。配送確認は次の送信を止めない。
  const instructionSends = new Map(), deferredInstructions = new Set(), settlingInstructions = new Set();
  const noticeRetryAt = new WeakMap(), noticeFailureShown = new Set();
  const live = new Map(), notices = new Set(), noticeOwners = new Set(), waited = new Map(), silenceNotices = new Set(), silenceWaiting = new Map(), listeners = new Set();
  // 外から起きた子のターン（人の送信・Chrome を戻した続き・再開・別の会話からの送信。ADR 0352）。
  // joiners: 走っている回（結果の確定の前）に合流して走るターンの数（taskId -> 数）。回の結果の確定は、これが 0 になるまで待つ
  // closing: 走っている回が結果の確定に入った（server の finishChild が closeRun を呼んだ）taskId。この後に来たターンは、回が終わるのを待って次の回で受ける
  // waking: 止まった子を起こそうとしている数（taskId -> 数）。起きるか分かるまで、前の回の完了通知を送らない（止まるたびに 1 回の通知にする）
  // runEnds: 回（run）が終わるのを待っている関数（taskId -> 関数の配列）
  const joiners = new Map(), closing = new Set(), waking = new Map(), runEnds = new Map();
  const bump = (map, id, by) => { const n = (map.get(id) ?? 0) + by; if (n > 0) map.set(id, n); else map.delete(id); };
  const runEnded = id => new Promise(resolve => { const list = runEnds.get(id) ?? []; list.push(resolve); runEnds.set(id, list); });
  // 止まった子が起きた（依頼元の追加の指示・外から起きたターン）。次の回の終わりの出来事に載せる「再び動いたきっかけ」を行に残す（ADR 0352）。
  // 回の終わりの出来事を作ったら（runEvent）消す。前の完了通知が渡っていれば（NOTICED）数え直す
  const wakeRow = (row, kind) => {
    if (!row.wake || NOTICED.has(row.notification)) row.wake = { kinds: [] };
    if (kind && !row.wake.kinds.includes(kind)) row.wake.kinds.push(kind);
  };
  // まだ依頼元へ届けていない出来事（ADR 0352）。起きた順に行の events へ足す。上限を超えたら古いものから捨てて数だけ残す
  // （送っている最中の出来事を捨てたときは、その通知に載っているので数えない）
  const pushEvent = (row, event) => {
    const list = row.events ??= [];
    list.push({ id: crypto.randomUUID(), at: Date.now(), ...event });
    if (list.length <= MAX_EVENTS) return;
    const sending = new Set(row.sending?.ids ?? []);
    const over = list.splice(0, list.length - MAX_EVENTS).filter(e => !sending.has(e.id)).length;
    if (over) row.eventsDropped = (row.eventsDropped ?? 0) + over;
  };
  // 子の回が終わった（完了・失敗・止められた）。終わり方・止めた側・きっかけ・返答を出来事に残す
  // エラーは終わった回のもの（失敗の文と、完了したが注意書きの付いた回。row.error は回の結果を書くときに入れ替わる）。取り消しの回には載せない
  const runEvent = (row, status, result = row.result) => {
    pushEvent(row, { kind: 'run', status, stoppedBy: status === 'cancelled' ? row.stoppedBy ?? null : null, cause: [...(row.wake?.kinds ?? [])],
      result: clip(result), ...(status !== 'cancelled' && row.error ? { error: clip(row.error) } : {}) });
    delete row.wake;
  };
  // 次の回が始まる・指示が積まれた: 届けていない回の終わりが残っていれば知らせを待たせ（pending）、無ければ none。
  // 送っている最中（delivering）は触らない（送り終えた時に delivered が決める）
  const resetNotice = row => { if (row.notification !== 'delivering') row.notification = runEvents(row) ? 'pending' : 'none'; };
  // 完了通知が渡った（state: sent・unknown）。その通知に載せた出来事（sending）を外し、送り直し（renotify）のために控える。
  // 届けていない回の終わりがまだあれば次の知らせを待たせる。子が動いていれば（次の回）、その回の終わりでまた知らせる
  const delivered = (r, state) => {
    const sending = r.sending; delete r.sending;
    if (sending) {
      const ids = new Set(sending.ids);
      const sent = (r.events ?? []).filter(e => ids.has(e.id));
      r.events = (r.events ?? []).filter(e => !ids.has(e.id));
      if (!r.events.length) delete r.events;
      const dropped = Math.min(sending.dropped ?? 0, r.eventsDropped ?? 0);
      if (dropped) { r.eventsDropped -= dropped; if (!r.eventsDropped) delete r.eventsDropped; }
      r.lastNotice = { noticeId: r.noticeId ?? null, events: sent, dropped };
      // 動いている子へ届けた: 載せた拒否は前の回の分。この回の分で数え直す
      if (ACTIVE.has(r.status)) { delete r.rejections; delete r.rejectionsDropped; }
      if (noticedDuring.has(r.taskId)) noticedDuring.set(r.taskId, state);
    }
    if (runEvents(r)) { r.notification = 'pending'; delete r.noticeId; }
    else if (ACTIVE.has(r.status)) { r.notification = 'none'; delete r.noticeId; }
    else r.notification = state;
  };
  // 依頼元へ渡す写し。送っている最中なら、その通知に載せた出来事だけにする（後から足された出来事は次の知らせへ）
  const noticeClone = r => {
    const c = structuredClone(r);
    if (r.sending) { const ids = new Set(r.sending.ids); c.events = (c.events ?? []).filter(e => ids.has(e.id)); c.eventsDropped = r.sending.dropped ?? 0; }
    return c;
  };
  // 人が子へ直接送ったターンが始まった（external の began）: その指示が台帳に載る（humanSent）まで、前の回の知らせを待たせる。
  // 止めた直後に送った指示を、止めた知らせと同じ 1 通に載せるため（taskId -> 待ちを解く関数）
  const humanWaits = new Map();
  // 外から起こした回（wake）が始まった後に、依頼元へ届いた通知の状態（taskId -> null | 'sent' | 'unknown'）。
  // その回が取り直し（externalRequeue）で起こす前の状態へ戻るとき、届け済みの出来事をもう一度知らせない。回が終わったら消す
  const noticedDuring = new Map();
  const serial = fn => {
    const next = writes.then(async () => { mutating = true; try { return await fn(); } finally { mutating = false; } });
    writes = next.catch(() => {});
    return next;
  };
  // 裏で走らせている仕事（実行・通知・保存のやり直し・障害の記録）。close() は、閉じる前に始まったこれらが書き終えるまで待つ。
  // 渡す Promise は reject しないもの（呼ぶ側で catch 済み）に限る
  const background = new Set();
  const spawn = p => { background.add(p); void p.finally(() => background.delete(p)); };
  const touched = () => { changed(); for (const fn of [...listeners]) fn(); };
  // 障害の記録。秘密・依頼文・結果・パスは書かない（errno・操作・タスク ID・時刻だけ）。
  // stderr はデスクトップ版ではファイルに残らないので、データ置き場にも大きさの上限付きで残す
  const report = entry => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    log(`[agent-tasks] ${line}`);
    spawn((async () => {
      const size = await io.stat(logFile).then(s => s.size, () => 0);
      if (size > LOG_MAX) { const old = await io.readFile(logFile, 'utf8'); await io.writeFile(logFile, old.slice(-LOG_MAX / 2).replace(/^[^\n]*\n/, '')); }
      await io.appendFile(logFile, line + '\n');
    })().catch(() => {}));
  };
  // ids の行（と、前に書けなかった行）のうち、最後に書けた JSON から変わったものだけを書く。ids が無ければ全部の行を見る。
  // 保存障害の間は、変わった行が無くても書き込みを試す（書けるようになったかを確かめる）
  const unsaved = new Set();
  const write = async ids => {
    const targets = new Set([...(ids === undefined ? Object.keys(records) : ids), ...unsaved]);
    const rows = [];
    for (const id of targets) {
      if (!records[id]) continue;
      const json = JSON.stringify(records[id]);
      if (saved.get(id) !== json) rows.push([id, json]);
    }
    try { if (rows.length || fault) await rowStore.save(rows); }
    catch (e) { for (const id of targets) unsaved.add(id); throw e; }
    for (const [id, json] of rows) { saved.set(id, json); persisted.set(id, records[id].notification); }
    for (const id of targets) { unsaved.delete(id); if (records[id] && !rows.some(([rowId]) => rowId === id)) persisted.set(id, records[id].notification); }
    dirty = unsaved.size > 0;
    if (fault) { report({ event: 'saveRecovered', failures: fault.failures, since: new Date(fault.since).toISOString() }); fault = null; }
  };
  const failed = (e, operation, taskId = null) => {
    const at = Date.now(), failures = (fault?.failures ?? 0) + 1;
    fault = { code: String(e?.code ?? 'UNKNOWN'), syscall: e?.syscall ?? null, operation, taskId, since: fault?.since ?? at, at, failures,
      retryAt: at + Math.min(retryMax, 500 * 2 ** (failures - 1)) };
    report({ event: 'saveFailed', code: fault.code, errno: e?.errno ?? null, syscall: fault.syscall, operation, taskId, failures });
  };
  // 起きたことを書く。失敗したらメモリはそのままにし、スケジューラーが後で書き直す
  // taskIds: 書き換えたタスクの id（1 つか配列）。無ければ全部。障害の記録には先頭の 1 件を載せる
  const persist = async (operation, taskIds) => {
    const ids = taskIds === undefined ? undefined : [taskIds].flat();
    try { await write(ids); } catch (e) { dirty = true; failed(e, operation, ids?.[0]); }
  };
  // 保存できないので受け付けなかった、という依頼元への返事
  const refused = locale => new Error(agentT(locale, 'tasks.storageFailed', { code: fault?.code ?? 'UNKNOWN' }));
  const storage = locale => fault ? { storageFault: { error: agentT(locale, 'tasks.storageFault', { code: fault.code, since: new Date(fault.since).toISOString() }),
    code: fault.code, since: fault.since, failures: fault.failures } } : {};
  // 再起動: 実行中だったものは再実行しない。まだ親に渡っていない pending はそのまま送り直す。
  // 途中で止まった通知は依頼元の受領記録と照合する。
  // restored: 再起動で止まった（interrupted にした）タスク。server が依頼元の会話の「止めたもの」に残す（docs/design.md「中断と再開」）
  function interrupt(row) {
    row.status = 'interrupted'; row.error = t('tasks.interruptedByRestart');
    delete row.heldQuit;
    for (const instruction of row.instructions ?? []) if (instruction.state === 'sending') setInstruction(row, instruction.id, 'delivered');
    dropInstructions(row);
  }
  function setStopUnconfirmed(row) {
    row.status = 'stopUnconfirmed';
    row.error = agentT(undefined, 'tasks.stopUnconfirmed');
  }
  const restored = [], quitStops = new Set();
  // 付け直す子のタスク（taskId -> 走っている印）。子のターンは新しいサーバーが続けているので、止めずに adoptRun() を待つ。
  // 走っているのは running か cancelling の行だけ（取り消しの最中なら、その印も付けておく）
  const adoptable = new Map();
  for (const taskId of adopting) {
    const r = records[taskId];
    if (!r || r.host || r.heldQuit || !['running', 'cancelling', 'stopUnconfirmed'].includes(r.status)) continue;
    if (r.status === 'stopUnconfirmed') { r.status = 'running'; r.error = null; }
    const ac = new AbortController();
    if (r.status === 'cancelling') ac.abort();
    adoptable.set(taskId, ac);
  }
  for (const r of Object.values(records)) {
    // ホストに任せたタスクの写しは、ホストで続いている。再起動で止めず、つながり直したときの同期で追いつく
    if (adoptable.has(r.taskId)) continue;
    // 再起動前の活動の写しは古い。ホストの sync が届くまで停滞の判定には使わない
    if (r.host) { delete r.hostTelemetry; delete r.hostBackground; delete r.activeCommands; delete r.lastActivityAt; delete r.lastOutputAt; }
    if (!r.host && !(resumeQueued && r.status === 'queued') &&
        (ACTIVE.has(r.status) || ['stopUnconfirmed', 'interrupted'].includes(r.status))) {
      const uncertain = r.status !== 'queued' && await stopUnconfirmed(r);
      const item = { taskId: r.taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status };
      if (uncertain) {
        setStopUnconfirmed(r);
        await reportUnconfirmedStop(item);
      } else if (r.status !== 'interrupted') {
        restored.push(item);
        interrupt(r);
      }
    }
    for (const c of r.activeCommands ?? []) { c.state = 'unknown'; c.pausedAt = null; }
    if (['delivering', 'unknown'].includes(r.notification)) {
      const state = await recoverNotice(structuredClone(r)).catch(() => 'unknown');
      // 渡っていた（か分からない）: その通知に載せた出来事を外す。渡っていなければ出来事を残して送り直す
      if (state === 'pending') { r.notification = 'pending'; delete r.sending; } else delivered(r, state);
    } else if (r.sending) delete r.sending;
  }
  for (const [taskId, ac] of adoptable) live.set(taskId, ac);
  await serial(() => persist('restore'));
  async function abandon(r) {
    if (quitStops.has(r.taskId)) return;
    const uncertain = await stopUnconfirmed(r);
    await record(r.taskId, row => { if (!quitStops.has(row.taskId)) (uncertain ? setStopUnconfirmed : interrupt)(row); }, 'adopt.abandon');
    if (uncertain) await reportUnconfirmedStop(r);
  }
  const owned = (owner, id, locale) => {
    const r = records[id];
    if (!r || r.parentSessionId !== owner) throw new Error(agentT(locale, 'tasks.notOwned'));
    return r;
  };
  // context は「別の候補でやり直す」で同じ依頼を渡し直すために持つだけ（長いので一覧・状態には載せない）
  const view = (r, offset = 0) => {
    const { result = '', queue, context, instructions, noticeId, heldQuit, rejections = [], silenceNotifiedAt, noticedCommands, noticedSilence, lastOutputAt, activeCommands = [], backgroundNotice, wake, stoppedBy, ownerStop, sending, lastNotice, ...rest } = r;
    if (!r.host) pauseCommands(r, now(), waitingOf(r));
    // 子が返答を終えて裏の作業だけを待っている間は、待っているものと経過分数を見せる（ADR 0170）
    const bg = r.status === 'running' ? backgroundOf(r) : null;
    // 古いホストの便り（活動の写しが無い）では写しに null が入る。分割代入の既定値は null に効かないので ?? で受ける
    // 再試行の待ち（ADR 0229）と、上限で止まった子の解除時刻までの待ち。依頼元が待つか、止めて別の委譲先に任せ直すかを決める材料
    const rt = retryOf(r), hold = heldOf(r);
    const iso = v => Number.isFinite(v) ? new Date(v).toISOString() : null;
    return { ...rest, activeCommands: (activeCommands ?? []).map(c => commandView(c, now())),
      ...(rt ? { retryWaiting: { attempt: rt.attempt ?? null, nextAt: iso(rt.next), reason: rt.reason ?? null, message: rt.message ?? '', limit: Boolean(rt.limit) } } : {}),
      ...(hold ? { limitHeld: { resetsAt: iso(hold.resetsAt) } } : {}),
      ...(bg ? { backgroundWaiting: { minutes: Math.max(0, Math.floor((now() - bg.since) / 60000)), tasks: bg.tasks } } : {}), silenceMinutes: r.status === 'running' && !bg && !waitingOf(r) && !lockWaitingOf(r) && r.lastActivityAt != null
      ? Math.max(0, Math.floor((now() - r.lastActivityAt) / 60000)) : null,
      rejections, pendingMessages: r.host ? (r.hostPendingMessages ?? 0) : instructions.filter(x => x.state === 'queued').length, result: result.slice(offset, offset + 16000), resultOffset: offset,
      resultLength: result.length, nextOffset: offset + 16000 < result.length ? offset + 16000 : null };
  };
  // 依頼元のエージェントへ返す形。人間の承認待ちは「いま待っているか」から導く見せかけの状態で、
  // 保存する status（queued / running …）は変えない。ACTIVE の集合と再起動時の interrupted の扱いを壊さないため
  const shown = (r, offset = 0) => {
    const v = view(r, offset);
    return ACTIVE.has(r.status) && waitingOf(r) ? { ...v, status: 'waiting' } : v;
  };
  // worktree の今の状態の 1 行（ply_task_status・ply_task_wait）。作業場所を持たない子・状態が引けないときは何も足さない。
  // 片付け済み（もう無い）は、完了時の状態（row.workspace）から言う
  async function workspaceOf(r, locale) {
    if (!r.worktree) return {};
    let state = await workspaceState(structuredClone(r)).catch(() => null);
    if (state?.state === 'gone' && r.workspace) state = { ...r.workspace, ...state, state: 'gone', removedAs: r.workspace.state };
    if (!state) state = r.workspace ?? null;
    return { workspace: state ? { branch: state.branch ?? r.worktree.branch, path: state.path ?? r.worktree.path, origin: r.worktree.origin, state: state.state, files: state.files ?? 0 } : undefined,
      workspaceSummary: workspaceLine(locale, r.worktree, state) };
  }
  const restore = (r, before) => { for (const key of Object.keys(r)) delete r[key]; Object.assign(r, before); };
  /**
   * ホストの子を止める。届かなければ（オフライン・許可切れ・応答なし）止める予定（cancelPending）として行に残し、つながり直したとき送り直す
   * （ホストの便りで running に戻さない。mirror）。待つのは CANCEL_HOST_MS まで
   */
  async function stopHost(r) {
    let sent = false, timer;
    try { sent = await Promise.race([cancelHost(structuredClone(r)), new Promise(res => { timer = setTimeout(res, CANCEL_HOST_MS, false); })]) === true; } catch { sent = false; } finally { clearTimeout(timer); }
    if (!sent && records[r.taskId]) await record(r.taskId, row => { row.cancelPending = true; }, 'cancel.pending');
  }
  // 保存できてから先へ進む書き換え。保存に失敗したらメモリを戻し、理由付きのエラーを投げる
  async function commit(id, fn, operation, locale) {
    return serial(async () => {
      const r = records[id], before = structuredClone(r);
      try { fn(r); r.updatedAt = Date.now(); } catch (e) { restore(r, before); throw e; }
      try { await write([id]); } catch (e) { restore(r, before); failed(e, operation, id); throw refused(locale); }
      touched();
    });
  }
  // 起きたことの記録。保存に失敗しても投げない（メモリが正しく、ファイルは後で追いつく）
  async function record(id, fn, operation) {
    return serial(async () => {
      const r = records[id];
      fn(r); r.updatedAt = Date.now();
      await persist(operation, id);
      touched();
    });
  }
  // 依頼元が ply_task_status / ply_task_wait で終了状態と結果を受け取った。同じ結果の完了通知は後から送らない（ADR 0057）。
  // 送っている最中（delivering）と送り終えたものは触らない。結果が長くて nextOffset が残っていても、受け取った時点で配達済みとする。
  // 終わった直後で通知がまだ始まっていない（none）ものも対象で、その後の run.notice が read を pending に戻さない
  // 届けていない出来事（events）も、この戻り値に載せて渡したので外す
  async function markRead(r) {
    if (!readable(r)) return;
    await record(r.taskId, row => { if (readable(row)) { row.notification = 'read'; delete row.events; delete row.eventsDropped; delete row.sending; } }, 'notify.read');
  }
  // 途中送信の指示を待機へ戻す（受理されない・捨てられた・合図が来ないままターンが終わった）。
  // 次のターンで 1 回だけ送る。ID で claim を持っているものだけ戻すので、合図が先に来て配送済みにしたものは戻さない
  const idsOf = value => Array.isArray(value) ? value : [value];
  // nextTurn=false は一時的な未受信（このターンでまだ受けられるかもしれない）。待機へ戻すが deferred にしないので、
  // 次の kick や子の ready の通知でもう一度途中送信を試す。true はこのターンでは渡せないもの（明示的拒否・ターンの終わり）→ 次のターンで送る
  function unclaim(taskId, instructionIds, { nextTurn = true } = {}) {
    return serial(async () => {
      const row = records[taskId], claims = steers.get(taskId);
      if (!row || !claims) return;
      const ids = idsOf(instructionIds).filter(id => claims.delete(id));
      if (!ids.length) return;
      if (!claims.size) steers.delete(taskId);
      if (['cancelling', 'cancelled', 'interrupted'].includes(row.status)) {
        for (const id of ids) setInstruction(row, id, 'dropped');
      } else {
        for (const id of ids) {
          row.queue.push({ instructionId: id }); setInstruction(row, id, 'queued');
          if (nextTurn) deferredInstructions.add(id);   // 明示的拒否・未受信は次のターンで送る
        }
        const order = new Map(row.instructions.map((instruction, index) => [instruction.id, index]));
        row.queue.sort((a, b) => (order.get(a.instructionId) ?? -1) - (order.get(b.instructionId) ?? -1));
        if (!ACTIVE.has(row.status)) { row.status = 'queued'; resetNotice(row); }
      }
      row.updatedAt = Date.now();
      await persist('send.steer.requeue', taskId); touched();
    });
  }
  function resolveClaim(taskId, instructionIds, state, { nativeId = null } = {}) {
    return serial(async () => {
      const row = records[taskId], claims = steers.get(taskId);
      if (!row || !claims) return;
      const ids = idsOf(instructionIds).filter(id => claims.delete(id));
      if (!ids.length) return;
      if (!claims.size) steers.delete(taskId);
      for (const id of ids) {
        setInstruction(row, id, state);
        if (nativeId) { const instruction = row.instructions?.find(x => x.id === id); if (instruction) instruction.nativeId = nativeId; }
      }
      row.updatedAt = Date.now();
      await persist('send.steer.done', taskId); touched();
    });
  }
  // その時点の待機分をまとめて送る。先の配送確認を待たず、RPC の受理後に次の待機分も送る。
  function steerInstructions(r) {
    if (instructionSends.has(r.taskId)) return instructionSends.get(r.taskId).then(async unknown => new Set([...unknown, ...await steerInstructions(r)]));
    const eligible = () => !closed && !fault && !settlingInstructions.has(r.taskId)
      && r.status === 'running' && live.has(r.taskId) && r.queue.length
      && !r.queue.some(entry => !entry.instructionId || deferredInstructions.has(entry.instructionId));
    const send = (async () => {
      const unknown = new Set();
      while (eligible()) {
        const head = r.instructions?.find(i => i.id === r.queue[0]?.instructionId) ?? null;
        // 先頭の指示が替えた設定のターン宛（設定と同じ呼び出しで積まれた）なら、それも含めて渡せるかを聞く。後ろの分の順序も守るため止まる
        if (!await childSteerable(structuredClone(r), head ? { id: head.id, nextTurn: head.nextTurn === true } : null).catch(() => false)) break;
        const batch = await serial(async () => {
          if (!eligible()) return null;
          const before = structuredClone(r);
          // 設定と同じ呼び出しで積まれた指示（nextTurn）は先頭以外に混ぜない（替えた後のターンで読まれる順序を守る）
          const ids = [];
          for (const entry of r.queue) {
            if (ids.length && r.instructions?.find(i => i.id === entry.instructionId)?.nextTurn) break;
            ids.push(entry.instructionId);
          }
          const text = ids.map(id => r.instructions.find(i => i.id === id).text).join('\n\n');
          r.queue = r.queue.slice(ids.length);
          const deliveryId = `task-send-${ids[0]}`;
          for (const id of ids) {
            setInstruction(r, id, 'sending');
            const instruction = r.instructions.find(i => i.id === id);
            if (instruction) instruction.deliveryId = deliveryId;
          }
          r.updatedAt = Date.now();
          try { await write([r.taskId]); }
          catch (e) { restore(r, before); failed(e, 'send.steer', r.taskId); throw e; }
          const claims = steers.get(r.taskId) ?? new Set();
          for (const id of ids) claims.add(id);
          steers.set(r.taskId, claims); touched();
          return { id: ids[0], ids, text, nextTurn: Boolean(r.instructions?.find(i => i.id === ids[0])?.nextTurn) };
        });
        if (!batch) break;
        const outcome = await steer(structuredClone(r), batch).catch(() => 'error');
        if (outcome === 'delivered') await resolveClaim(r.taskId, batch.ids, 'delivered');
        else if (outcome === 'error') {
          await resolveClaim(r.taskId, batch.ids, 'dropped');
          for (const id of batch.ids) if (r.instructions.find(i => i.id === id)?.state === 'dropped') unknown.add(id);
        }
        else if (outcome === 'wait') { await unclaim(r.taskId, batch.ids, { nextTurn: false }); break; }
        else if (outcome !== 'pending') { await unclaim(r.taskId, batch.ids); break; }
      }
      return unknown;
    })();
    instructionSends.set(r.taskId, send);
    const tracked = send.finally(() => instructionSends.delete(r.taskId));
    instructionSends.set(r.taskId, tracked);
    return tracked;
  }
  const limitSwitchNotices = new Map();
  const deliveringLimitSwitch = new Set();
  function queueLimitSwitch(taskId, target, first = false) {
    const notices = limitSwitchNotices.get(taskId) ?? [];
    if (!notices.includes(target)) {
      if (first) notices.unshift(target);
      else notices.push(target);
    }
    limitSwitchNotices.set(taskId, notices);
  }
  const autoTarget = row => row.routing?.mode === 'auto' && !row.routing.targetPinned && row.routing.changed?.by !== 'parent';
  // adopted: 付け直した子のターン（adopt）の、結果を確定する側（task, signal）=> execute と同じ形の結果。1 回目の実行だけ、実行の開始を書かずにこれを待つ。
  // external: 外から起きた子のターン（external()。ADR 0352）。1 回目の実行だけ、依頼元の指示の代わりにこのターンを走らせる。
  // 実行の開始（running）は、そのターンが本当に始まった時に external.began が書く。始まらなかったら行は変えずに終わる
  function run(r, controller, adopted = null, adoptedPrompt, external = null) {
    return runTask(r, controller, adopted, adoptedPrompt, external).finally(() => {
      closing.delete(r.taskId); noticedDuring.delete(r.taskId);
      const resolvers = runEnds.get(r.taskId) ?? [];
      runEnds.delete(r.taskId);
      for (const resolve of resolvers) resolve();
    });
  }
  async function runTask(r, controller, adopted, adoptedPrompt, external) {
    // stalled: 実行の開始を保存できなかった。子は動かしていないので queued のまま、次のタイマーでやり直す
    // unstarted: 外から起きたターンが始まらなかった（送信待ちへ戻した・渡せなかった）。行は起こす前のまま。完了通知も書かない
    // eventWritten: この回の終わりの出来事（runEvent）を書いた（依存の ended・外の runEnded と名前を分ける）。取り消しの締め（run.cancelled）で二重に書かない
    let stalled = false, requeued = false, unstarted = false, eventWritten = false, activeInstructionIds, wake = null;
    // close()（正常終了）の abort。止めたことは書かず、走っていた状態のままファイルに残す（再起動で interrupted になる。
    // docs/agent-delegation.md「保存・画面・再起動」）。利用者の取り消しは先に cancelling にするので、それは cancelled を書く
    const halted = () => quitStops.has(r.taskId) || (closed && r.status !== 'cancelling');
    try {
      while (!controller.signal.aborted) {
        // A held turn can finish during update preflight. Leave its next prompt in the queue.
        if (!adopted && !external && !canStart()) break;
        let prompt, instructionIds, continuing = false, triedLimits = [];
        settlingInstructions.delete(r.taskId); closing.delete(r.taskId);
        wake = external; external = null;
        if (wake) { instructionIds = []; prompt = null; }
        else if (adopted) {
          // この回の指示は、旧サーバーが実行の開始で sending にしたもの。途中送信で渡している最中の分（steers の claim）は含めない
          const claims = steers.get(r.taskId) ?? new Set();
          instructionIds = (r.instructions ?? []).filter(x => x.state === 'sending' && !claims.has(x.id)).map(x => x.id);
          // 取り直し（requeue）で元の入力へ戻す本文。instructions に無い（最初の依頼の本文）ときだけ使う
          prompt = adoptedPrompt ?? instructionIds.map(id => r.instructions.find(x => x.id === id)?.text ?? '').join('\n\n');
        } else try { await commit(r.taskId, row => {
          const entry = row.queue.shift();
          triedLimits = entry?.triedLimits ?? [];
          continuing = triedLimits.length > 0;
          instructionIds = [];
          if (entry?.instructionId) {
            instructionIds.push(entry.instructionId);
            while (row.queue[0]?.instructionId) instructionIds.push(row.queue.shift().instructionId);
            prompt = instructionIds.map(id => row.instructions.find(x => x.id === id)?.text ?? '').join('\n\n');
            const deliveryId = `task-send-${instructionIds[0]}`;
            for (const id of instructionIds) { const i = row.instructions.find(x => x.id === id); if (i) i.deliveryId = deliveryId; }
          } else prompt = continuing ? entry.prompt : entry;
          for (const id of instructionIds) { setInstruction(row, id, 'sending'); deferredInstructions.delete(id); }
          row.status = 'running'; row.lastActivityAt = now(); row.silenceNotifiedAt = null; delete row.stoppedBy;
        }, 'run.start'); }
        catch { stalled = true; break; }
        activeInstructionIds = instructionIds;
        const finish = adopted;
        adopted = null;
        const input = { messageId: instructionIds.length ? `task-send-${instructionIds[0]}` : undefined };
        let result = finish ? await finish(structuredClone(r), controller.signal)
          : wake ? await execute(structuredClone(r), null, controller.signal, { external: wake })
          : await execute(structuredClone(r), prompt, controller.signal, { ...input, continuing });
        if (halted()) return;
        if (wake && (!wake.started || result?.requeue)) {
          // 始まったのに取り直し（requeue）になった: 起こす前の状態へ戻す（送信待ちが次のターンでまた起こす）
          // 始まった後に通知が届いていれば（noticedDuring）、その状態のまま。起こす前の pending に戻すと、届け済みの完了をもう 1 通送ってしまう
          if (wake.started) await record(r.taskId, row => { row.status = wake.before.status; const noticed = noticedDuring.get(r.taskId); if (row.notification !== 'delivering') row.notification = runEvents(row) ? 'pending' : noticed ? noticed : wake.before.notification === 'delivering' ? 'sent' : wake.before.notification; if (wake.before.stoppedBy) row.stoppedBy = wake.before.stoppedBy; }, 'run.externalRequeue');
          unstarted = true; return;
        }
        // 上限とログイン切れは同じ会話で続ける。仕事前のエラーだけ従来どおり新しい会話で試す（ADR 0302）。
        // ログイン切れ（authFailed。Issue #232）は、同じエージェント・アカウントの枠をモデルを問わず外して選び直す。
        // 外から起きたターン（wake）は人や別の会話の発言なので、委譲先を替えて送り直さない
        for (let reroutes = 0; !wake && !r.host && autoTarget(r) && !controller.signal.aborted && !halted();) {
          const limited = result?.outcome === 'limited';
          const loggedOut = !limited && result?.outcome === 'error' && Boolean(result.authFailed);
          const switching = limited || loggedOut;
          if (!switching && (continuing || finish || instructionIds.length || result?.outcome !== 'error' || result.touched !== false
            || reroutes >= (result.modelRejected ? MODEL_REROUTE_MAX : REROUTE_MAX))) break;
          if (limited) {
            triedLimits.push(r.routing.target);
            if (result.limit?.backend && result.limit.model) triedLimits.push(result.limit);
          }
          if (loggedOut) {
            const { backend, model, account } = result.authFailed;
            triedLimits.push({ ...r.routing.target, auth: true }, { backend, model, account, auth: true });
          }
          const next = await reroute(structuredClone(r), { outcome: result.outcome, error: result.error ?? null,
            ...(switching ? { triedLimits, signal: controller.signal } : {}), ...(result.modelRejected ? { modelRejected: true } : {}),
            ...(loggedOut ? { authFailed: true } : {}) }).catch(() => null);
          // モデルを断られた後に候補が尽きた: 振り分けの失敗と同じ文面で失敗にする（ADR 0311）
          if (next?.exhausted) { result = { ...result, error: next.exhausted }; break; }
          if (!next?.sessionId) break;
          if (switching) {
            try { await commit(r.taskId, row => {
              if (controller.signal.aborted || halted() || row.status !== 'running' || !autoTarget(row)) throw new Error('Task changed');
              row.backend = next.backend; row.model = next.model; row.effort = next.effort; row.mode = next.mode; row.routing = next.routing;
              if (result.worktree) row.worktree = result.worktree;
              endTurnCommands(row); settleCommands(row);
            }, 'run.limitSwitch'); }
            catch { await next.rollback?.().catch(() => {}); break; }
            queueLimitSwitch(r.taskId, loggedOut ? { ...next.routing.target, reason: 'auth' } : next.routing.target);
            continuing = loggedOut ? 'auth' : true;
            const rejections = result.rejections ?? [];
            result = await execute(structuredClone(r), prompt || r.task, controller.signal, { ...input, continuing });
            result = { ...result, rejections: [...rejections, ...(result?.rejections ?? [])] };
            continue;
          }
          reroutes += 1;
          const previous = r.sessionId;
          // タスクの記録を新しい会話・委譲先・振り分けへ書き換える。保存できなければ任せ直しをやめ、作った子を巻き戻す
          try { await commit(r.taskId, row => {
            row.sessionId = next.sessionId;
            row.backend = next.backend; row.model = next.model; row.effort = next.effort;
            row.mode = next.mode; row.cwd = next.cwd;
            if (next.routing) row.routing = next.routing;
          }, 'run.reroute'); }
          catch { await rollback({ sessionId: next.sessionId }).catch(() => {}); break; }
          bySession.delete(previous); bySession.set(r.sessionId, r);
          // 交換で役目を終えた子の実行資材（ブラウザーのデーモンなど）を片付ける。会話そのものは失敗の経緯として残す
          try { ended(previous); } catch (e) { report({ event: 'unexpected', operation: 'reroute.ended', taskId: r.taskId, code: e?.code ?? null }); }
          result = await execute(structuredClone(r), prompt, controller.signal, {});
          if (halted()) return;
        }
        if (quitStops.has(r.taskId)) return;
        if (result?.adoptionFailed) {
          await abandon(r);
          return;
        }
        if (result?.requeue) {
          await record(r.taskId, row => {
            const entries = instructionIds.length ? instructionIds.map(instructionId => ({ instructionId }))
              : continuing ? [{ prompt: prompt || row.task }] : prompt ? [prompt] : [];
            if (continuing) entries[0].triedLimits = triedLimits;
            row.queue.unshift(...entries);
            for (const id of instructionIds) setInstruction(row, id, 'queued');
            row.status = 'queued';
          }, 'run.requeue');
          activeInstructionIds = undefined; requeued = true;
          return;
        }
        await record(r.taskId, row => {
          if (quitStops.has(r.taskId)) return;
          row.result = String(result?.text ?? ''); row.error = result?.error ?? null;
          // 子の作業場所の git の要約（ADR 0085。変更・コミットが無ければ載せない）。完了通知と ply_task_status に出る
          if (result?.git) row.git = result.git; else delete row.git;
          // 子の worktree の、終わった時点の状態（ADR 0089。取り込まれていなければ完了通知に 1 行出る）
          if (result?.workspace) row.workspace = result.workspace; else delete row.workspace;
          // 追加の指示で再開した回に、片付いていた作業場所を作り直したとき
          if (result?.worktree) row.worktree = result.worktree;
          for (const id of instructionIds) setInstruction(row, id, 'delivered');
          // 実行前に拒否されたコマンド。前の完了通知の後に走った回の分を足していく（通知の前に続けて走った回の分も落とさない）
          const got = Array.isArray(result?.rejections) ? result.rejections : [];
          if (got.length) {
            const all = [...(row.rejections ?? []), ...got];
            row.rejections = all.slice(0, MAX_REJECTIONS);
            if (all.length > MAX_REJECTIONS) row.rejectionsDropped = (row.rejectionsDropped ?? 0) + all.length - MAX_REJECTIONS;
          }
          // 前の版が止めた裏の作業の記録（ADR 0170 で止めなくなった）。次の回の結果で消す
          delete row.stoppedBackground;
          row.status = controller.signal.aborted ? 'cancelled' : result?.outcome === 'ok' ? (row.queue.length ? 'queued' : 'completed') : 'failed';
          // 使用量の上限で止まった（失敗のうち、待てば同じ委譲先で続けられるもの）。解除時刻と枠を残す（ADR 0229）
          if (row.status === 'failed' && result?.outcome === 'limited') row.limit = { resetsAt: result.limit?.resetsAt ?? null, window: result.limit?.window ?? null, ...slotOf(result.limit) };
          else delete row.limit;
          if (['failed', 'cancelled'].includes(row.status)) dropInstructions(row);
          // 回の終わりの出来事（ADR 0352）。止めた側が分からない取り消し（決まりの外の入口）は通知を止めるので残さない
          if (row.status !== 'queued' && (row.status !== 'cancelled' || row.stoppedBy)) { runEvent(row, row.status); eventWritten = true; }
          endTurnCommands(row); settleCommands(row);
        }, 'run.result');
        activeInstructionIds = undefined;
        if (r.status !== 'queued') break;
      }
    } catch (e) {
      // 外から起きたターンが始まる前に投げた（子の会話が消えていたなど）: 行は起こす前のまま。ターンは external() が素のまま流す
      if (wake && !wake.started) unstarted = true;
      else if (!halted()) await record(r.taskId, row => { if (quitStops.has(r.taskId)) return; row.status = controller.signal.aborted ? 'cancelled' : 'failed'; row.error = String(e.message ?? e); for (const id of activeInstructionIds ?? []) setInstruction(row, id, 'dropped'); dropInstructions(row);
        if (row.status !== 'cancelled' || row.stoppedBy) { runEvent(row, row.status, ''); eventWritten = true; }
        endTurnCommands(row); settleCommands(row); }, 'run.error');
    } finally {
      if (halted() || r.status === 'stopUnconfirmed' || r.status === 'interrupted') { live.delete(r.taskId); return; }
      // 外から起きたターンが始まらなかった: 起こす前の状態のまま手を離す（積まれた指示・前の回の通知は kick が拾う）
      if (unstarted && !controller.signal.aborted) { live.delete(r.taskId); settlingInstructions.delete(r.taskId); kick(); return; }
      // 止まった後（run.result / run.error で cancelled）に ply_task_send で積まれた指示は、止めた回の分ではない。
      // cancelled に戻して捨てず、下の kick で次の実行にする（docs/agent-delegation.md「ツール」の ply_task_send）
      // 結果を書かずに止まった回（取り直しの途中・始まる前に止めた）も、止めた側が分かれば回の終わりの出来事を残す
      if (r.status === 'cancelling' || controller.signal.aborted) await record(r.taskId, row => { if (!eventWritten && row.stoppedBy) { runEvent(row, 'cancelled', ''); eventWritten = true; } if (!requeued && row.status === 'queued' && row.queue.length) return; row.status = 'cancelled'; dropInstructions(row); endTurnCommands(row); settleCommands(row); }, 'run.cancelled');
      live.delete(r.taskId); settlingInstructions.delete(r.taskId);
      if (!stalled || controller.signal.aborted) {
        if (r.queue.length && !controller.signal.aborted) await record(r.taskId, row => { row.status = 'queued'; resetNotice(row); }, 'run.queued');
        // 依頼元が結果を先に受け取っていたら（read）通知を送らない。通知は次の指示で走る回のためにまた始まる。
        // 止められて終わった回も終了通知を 1 つ作る（人が止めた・依頼元が取り消した。stoppedBy。ADR 0352）。
        // 止めた側が分からない取り消し（終了・巻き戻し・ホストの子など、決まりの外の入口）は今までどおり通知を止める。
        // 送っている最中（前の回の出来事）は、送り終えた時に delivered が決める
        else if (!ACTIVE.has(r.status)) await record(r.taskId, row => { if (row.notification === 'delivering') return; row.notification = row.status === 'cancelled' && !row.stoppedBy ? 'suppressed' : row.notification === 'read' ? 'read' : 'pending'; }, 'run.notice');
        // 止めた後に積まれた指示で次の回が待っている: 止めた回の終わりは先に届ける
        else if (runEvents(r)) await record(r.taskId, resetNotice, 'run.event');
        if (!ACTIVE.has(r.status) && r.sessionId) { try { ended(r.sessionId); } catch (e) { report({ event: 'unexpected', operation: 'ended', taskId: r.taskId, code: e?.code ?? null }); } }
        // Busy sessions retry on the timer, never in a recursive write loop. 止めた後に積まれた指示はすぐ走らせる
        if (r.status !== 'queued' || controller.signal.aborted) kick();
      }
    }
  }
  // 通知を送る前に delivering と配送 ID を保存する。再起動ではこの ID で依頼元の記録を照合する。
  // ファイルがすでに delivering（直前の requeue をメモリだけで pending に戻した）なら書き直さない。保存できなければ送らない。
  // 同じ親への通知は 1 回の保存にまとめる。まだ pending のものだけ返す（依頼元が受け取り済みの read は外れる）
  async function begin(rows) {
    return serial(async () => {
      const list = rows.filter(r => r.notification === 'pending' && !waited.has(r.taskId) && !waking.has(r.taskId) && deliverable(r));
      if (!list.length) return [];
      const before = list.map(r => ({ updatedAt: r.updatedAt, sending: r.sending }));
      // sending: この通知に載せる出来事（今ある届けていない出来事すべて）。ファイルに残し、再起動で渡っていたら外す
      const sendingOf = r => ({ ids: (r.events ?? []).map(e => e.id), dropped: r.eventsDropped ?? 0 });
      const needsWrite = list.some(r => !r.noticeId || persisted.get(r.taskId) !== 'delivering' || JSON.stringify(r.sending ?? null) !== JSON.stringify(sendingOf(r)));
      for (const r of list) {
        r.notification = 'delivering';
        r.noticeId ??= crypto.randomUUID();
        r.sending = sendingOf(r);
      }
      if (!needsWrite) return list;
      for (const r of list) r.updatedAt = Date.now();
      try { await write(list.map(r => r.taskId)); } catch (e) {
        list.forEach((r, i) => { r.notification = 'pending'; r.updatedAt = before[i].updatedAt; delete r.noticeId; if (before[i].sending) r.sending = before[i].sending; else delete r.sending; });
        failed(e, 'notify.delivering', list[0].taskId); return [];
      }
      touched(); return list;
    });
  }
  async function notify(owner, rows) {
    noticeOwners.add(owner);
    for (const r of rows) notices.add(r.taskId);
    // deliver が「依頼元のターンに受け取られた」（プロンプトが渡った。引き継げる状態）と知らせる口。受け取られた後は、ターンの終わりまで待たない:
    // その時点で 'sent' を保存し（引き継ぎの前に記録を確定する。旧サーバーが引き継いだ後に書かず、新しいサーバーが再送しない）、settling から外す。
    // 保存が終わるまで notices に残すので、引き継ぎはこの短い区間だけ待つ
    let acceptance = null;
    try {
      // 親が受け取れない間（新しいターンも、走っているターンへの途中送信も）は delivering にせず、何も書かない（pending のまま次のタイマーで見る）
      const head = structuredClone(rows[0]);
      if (!(await ready(head).catch(() => false)) && !(await steerable(head).catch(() => false))) return;
      const sending = await begin(rows);
      if (!sending.length) return;
      // この通知のまま送っている最中か（配送 ID で見る。次の回が始まっても、送っている通知と出来事はそのまま）
      const ids = new Map(sending.map(r => [r.taskId, r.noticeId]));
      const current = r => r.noticeId === ids.get(r.taskId) && r.notification === 'delivering';
      const accepted = () => acceptance ??= (async () => {
        await serial(async () => {
          for (const r of sending) if (current(r)) { delivered(r, 'sent'); r.updatedAt = Date.now(); }
          await persist('notify.accepted', sending.map(r => r.taskId));
          touched();
        });
        noticeFailureShown.delete(owner);
        for (const r of sending) {
          noticeRetryAt.delete(r);
          notices.delete(r.taskId);
        }
      })();
      // requeue は受理前の待ち。undelivered はプロンプトを渡す前に失敗したと確定した場合。
      const claimFailureNotice = () => {
        if (noticeFailureShown.has(owner)) return false;
        noticeFailureShown.add(owner);
        return true;
      };
      const outcome = await deliver(sending.map(noticeClone), { accepted, claimFailureNotice }).catch(() => 'error');
      // 受け取られた後の結果（ターンの終わり・引き継ぎ・失敗）では記録を変えない。送った事実は受け取られた時点で確定している
      if (acceptance) { await acceptance; return; }
      if (outcome === 'requeue') {
        // 受け取られていない。親が空くまで何度も来るので、ファイルは delivering のまま書かず、メモリだけ pending に戻す
        await serial(async () => { for (const r of sending) if (current(r)) r.notification = 'pending'; });
        return;
      }
      const recovered = outcome === 'error'
        ? new Map(await Promise.all(sending.filter(current)
          .map(async r => [r.taskId, await recoverNotice(structuredClone(r)).catch(() => 'unknown')])))
        : new Map();
      const retryAt = now() + RETRY_WAIT_MS;
      if (outcome === 'ok') noticeFailureShown.delete(owner);
      await serial(async () => {
        for (const r of sending) {
          if (!current(r)) continue;
          if (outcome === 'undelivered') noticeRetryAt.set(r, retryAt);
          else noticeRetryAt.delete(r);
          const state = outcome === 'ok' ? 'sent' : outcome === 'undelivered' ? 'pending' : recovered.get(r.taskId) ?? 'unknown';
          if (state === 'pending') { r.notification = 'pending'; delete r.sending; } else delivered(r, state);
          r.updatedAt = Date.now();
        }
        await persist('notify.done', sending.map(r => r.taskId));
        touched();
      });
    } finally { for (const r of rows) notices.delete(r.taskId); noticeOwners.delete(owner); }
  }
  // 「止まっている可能性」の通知は、待っているだけの子には出さず、出すなら同じ子・同じコマンドで 1 回だけ（ADR 0138）。
  // 待っている先が動いている（実際の出力が伸びている）間と、明らかに待つためのコマンド（until / sleep / gh run watch など）は控える。
  // 控えたものは通知済みにしない（待ちが終わって、なお黙っているなら、そのとき 1 回だけ出す）
  // 裏（background）のコマンドは、子が別の道具や出力で動いている間は、その子の止まっている根拠にしない
  // 「動いている」とみなす間は 1 分。コマンドの時間を短くした設定（テスト）ではその長さまで縮める
  const quietMs = Math.min(OUTPUT_MOVING_MS, commandMs || OUTPUT_MOVING_MS);
  const childBusy = r => r.lastActivityAt != null && now() - r.lastActivityAt < quietMs;
  const commandFit = (r, c) => c.state !== 'unknown' && !isWaitingCommand(c.command) && !outputMoving(r, now(), quietMs) && !(c.state === 'background' && childBusy(r));
  const commandNoticed = (r, c) => Boolean(r.noticedCommands?.includes(commandKey(c.command)));
  const silenceSignature = r => (r.activeCommands ?? []).filter(c => c.state !== 'unknown').map(c => commandKey(c.command)).sort().join('\n');
  const silenceFit = r => !(r.activeCommands ?? []).some(c => c.state !== 'unknown' && isWaitingCommand(c.command));
  const remember = (r, field, key) => { const list = r[field] ??= []; if (!list.includes(key)) { list.push(key); if (list.length > NOTICED_MAX) list.shift(); } };
  const forget = (r, field, key) => { if (r[field]) r[field] = r[field].filter(k => k !== key); };
  async function notifySilence(r) {
    silenceNotices.add(r.taskId);
    const activityAt = r.lastActivityAt;
    const signature = silenceSignature(r);
    try {
      if (!(await ready(structuredClone(r)).catch(() => false))) return;
      if (r.status !== 'running' || (r.host && !r.hostTelemetry) || waitingOf(r) || lockWaitingOf(r) || r.lastActivityAt !== activityAt || r.silenceNotifiedAt === activityAt
        || !silenceFit(r) || r.noticedSilence?.includes(signature)) return;
      // Mark before delivery, as with completion notices: an uncertain delivery must not be repeated.
      try { await commit(r.taskId, row => { row.silenceNotifiedAt = activityAt; remember(row, 'noticedSilence', signature); }, 'silence.notice'); }
      catch { return; }
      if (r.status !== 'running' || (r.host && !r.hostTelemetry) || waitingOf(r) || lockWaitingOf(r) || r.lastActivityAt !== activityAt) return;
      let taken = false;
      const accepted = () => { taken = true; silenceNotices.delete(r.taskId); };
      const outcome = await deliverSilence(structuredClone(r), Math.max(1, Math.floor((now() - activityAt) / 60000)), { accepted }).catch(() => 'error');
      if (outcome === 'requeue' && !taken && r.lastActivityAt === activityAt) await record(r.taskId, row => { row.silenceNotifiedAt = null; forget(row, 'noticedSilence', signature); }, 'silence.requeue');
    } finally { silenceNotices.delete(r.taskId); }
  }
  async function notifyCommand(r, command) {
    const id = command.noticeId;
    commandNotices.set(id, r.taskId);
    const current = () => r.activeCommands?.find(c => c.noticeId === id);
    const eligible = () => {
      const c = current();
      return c && r.status === 'running' && (!r.host || r.hostTelemetry) && commandFit(r, c) && !waitingOf(r) && commandElapsed(c, now()) >= commandMs;
    };
    // 同じ子で同じコマンドは、もう知らせた（繰り返しの確認・再実行で何度も知らせない）
    const key = command.command;
    const release = () => { if (current()) current().notified = false; forget(r, 'noticedCommands', commandKey(key)); };
    try {
      if (!(await ready(structuredClone(r)).catch(() => false)) || !eligible() || current().notified || commandNoticed(r, current())) return;
      const marked = await serial(async () => {
        if (!eligible() || current().notified || commandNoticed(r, current())) return false;
        current().notified = true;
        remember(r, 'noticedCommands', commandKey(key));
        try { await write([r.taskId]); return true; }
        catch (e) {
          release();
          failed(e, 'command.notice', r.taskId);
          return false;
        }
      });
      if (!marked) return;
      if (!eligible()) {
        if (current()) await record(r.taskId, release, 'command.defer');
        return;
      }
      const c = current();
      // 依頼元のターンに受け取られたら、ターンの終わりまで待たない（印は送る前に保存済み。引き継ぎを止めない）
      let taken = false;
      const accepted = () => { taken = true; commandNotices.delete(id); };
      const outcome = await deliverCommand(structuredClone(r), { ...commandView(c, now()), noticeId: id }, { accepted }).catch(() => 'error');
      if (outcome === 'requeue' && !taken && current()) await record(r.taskId, release, 'command.requeue');
    } finally { commandNotices.delete(id); }
  }
  // 子が返答を終えて裏の作業だけを待っている（ADR 0170）。止めずに依頼元へ知らせ、待ちが続く間は backgroundMs ごとに知らせ直す。
  // 待ちの回（since）ごとに数え、子が再開して次の待ちに入ったら最初の知らせからやり直す。タスクは running のまま（完了にしない）
  const backgroundDue = (r, bg) => {
    const n = r.backgroundNotice?.since === bg.since ? r.backgroundNotice : null;
    return n ? now() - n.at >= backgroundMs : now() - bg.since >= Math.min(BACKGROUND_FIRST_MS, backgroundMs);
  };
  async function notifyBackground(r) {
    backgroundNotices.add(r.taskId);
    try {
      const bg = backgroundOf(r);
      if (!bg || !(await ready(structuredClone(r)).catch(() => false))) return;
      const current = () => { const w = r.status === 'running' ? backgroundOf(r) : null; return w?.since === bg.since ? w : null; };
      if (!current() || !backgroundDue(r, bg)) return;
      const before = r.backgroundNotice ?? null;
      const count = before?.since === bg.since ? before.count + 1 : 1;
      // 完了通知と同じく、送る前に印を保存する（送ったか分からないまま重ねて送らない）
      try { await commit(r.taskId, row => { row.backgroundNotice = { since: bg.since, at: now(), count }; }, 'background.notice'); }
      catch { return; }
      const live = current();
      if (!live) return;
      let taken = false;
      const accepted = () => { taken = true; backgroundNotices.delete(r.taskId); };
      const outcome = await deliverBackground(structuredClone(r), { count, minutes: Math.max(1, Math.floor((now() - bg.since) / 60000)),
        interval: Math.max(1, Math.round(backgroundMs / 60000)), tasks: live.tasks }, { accepted }).catch(() => 'error');
      if (outcome === 'requeue' && !taken) await record(r.taskId, row => { if (row.backgroundNotice?.since === bg.since && row.backgroundNotice.count === count) row.backgroundNotice = before; }, 'background.requeue');
    } finally { backgroundNotices.delete(r.taskId); }
  }
  // 子が再試行を待っている（ADR 0229）。待ちの回（since）ごとに 1 回だけ依頼元へ知らせる。印はメモリだけ（再起動では子のターンも続かない）。
  // 依頼元が ply_task_wait で待っていれば、その戻り値（status: waiting と retryWaiting）が知らせを兼ねる
  const retryNoticed = new Map(), retryNotices = new Set();
  async function notifyRetry(r, rt) {
    retryNotices.add(r.taskId);
    retryNoticed.set(r.taskId, rt.since);
    try {
      if (!(await ready(structuredClone(r)).catch(() => false)) && !(await steerable(structuredClone(r)).catch(() => false))) { retryNoticed.delete(r.taskId); return; }
      const current = retryWaitOf(r);
      if (!current || current.since !== rt.since) return;
      let taken = false;
      const accepted = () => { taken = true; retryNotices.delete(r.taskId); };
      const outcome = await deliverRetry(structuredClone(r), current, { accepted }).catch(() => 'error');
      if (outcome === 'requeue' && !taken && retryNoticed.get(r.taskId) === rt.since) retryNoticed.delete(r.taskId);
    } finally { retryNotices.delete(r.taskId); }
  }
  // 保存障害の間は、間隔を空けて保存だけをやり直す（1 回に 1 秒ほど待つ保存を、500ms ごとに仕事の数だけ重ねない）。
  // 書けたら障害を解き、次のタイマーから実行の開始と通知を再開する
  function probe() {
    if (probing || Date.now() < fault.retryAt) return;
    probing = true;
    spawn(serial(async () => { try { await write([]); touched(); } catch (e) { failed(e, dirty ? 'flush' : 'retry'); } })
      .finally(() => { probing = false; }));
  }
  function kick() {
    if (closed || mutating || !canStart()) return;
    if (fault) { probe(); return; }
    const groups = new Map();
    const notificationDue = r => r.notification === 'pending' && !limitSwitchNotices.has(r.taskId) && !notices.has(r.taskId) && !waited.has(r.taskId) && !waking.has(r.taskId) && deliverable(r)
      && (noticeRetryAt.get(r) ?? -Infinity) <= now() && !heldNotice(r);
    for (const r of Object.values(records)) {
      const switches = limitSwitchNotices.get(r.taskId);
      if (switches?.length && !deliveringLimitSwitch.has(r.taskId)) {
        deliveringLimitSwitch.add(r.taskId);
        const target = switches[0];
        let dropped = false;
        const redeliver = () => { dropped = true; queueLimitSwitch(r.taskId, target, true); };
        spawn(deliverLimitSwitch(structuredClone(r), target, { redeliver }).catch(() => 'error').then(outcome => {
          if (outcome !== 'requeue' && !dropped) switches.splice(switches.indexOf(target), 1);
          if (!switches.length) limitSwitchNotices.delete(r.taskId);
        }).finally(() => deliveringLimitSwitch.delete(r.taskId)));
      }
      // ホストに任せたタスクの写しは走らせない。新しいホストの活動の写しがあれば、通知だけ依頼元で判定する
      if (r.host) {
        if (r.hostTelemetry && !r.hostLost && r.status === 'running') {
          const bg = backgroundOf(r);
          for (const c of bg ? [] : r.activeCommands ?? []) {
            if (commandMs && commandFit(r, c) && !waitingOf(r) && !c.notified && !commandNoticed(r, c)
              && commandElapsed(c, now()) >= commandMs && !commandNotices.has(c.noticeId))
              spawn(notifyCommand(r, c).catch(e => report({ event: 'unexpected', operation: 'command', taskId: r.taskId, code: e?.code ?? null })));
          }
          const isWaiting = waitingOf(r) || lockWaitingOf(r);
          if (isWaiting) {
            if (!silenceWaiting.has(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
            silenceWaiting.set(r.taskId, true);
          } else if (silenceWaiting.delete(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
          if (silenceMs && !isWaiting && !bg && r.lastActivityAt != null && now() - r.lastActivityAt >= silenceMs
            && r.silenceNotifiedAt !== r.lastActivityAt && !silenceNotices.has(r.taskId)
            && silenceFit(r) && !r.noticedSilence?.includes(silenceSignature(r)))
            spawn(notifySilence(r).catch(e => report({ event: 'unexpected', operation: 'silence', taskId: r.taskId, code: e?.code ?? null })));
          if (backgroundMs && bg && !backgroundNotices.has(r.taskId) && backgroundDue(r, bg))
            spawn(notifyBackground(r).catch(e => report({ event: 'unexpected', operation: 'background', taskId: r.taskId, code: e?.code ?? null })));
        } else silenceWaiting.delete(r.taskId);
        if (notificationDue(r)) {
          if (!groups.has(r.parentSessionId)) groups.set(r.parentSessionId, []);
          groups.get(r.parentSessionId).push(r);
        }
        continue;
      }
      pauseCommands(r, now(), waitingOf(r));
      settleCommands(r);
      // 返答を終えて裏の作業だけを待つ子は、裏待ちの知らせ（ADR 0170）が受け持つ。「黙っている」「コマンドが長い」は重ねて送らない。
      // 長いコマンドを知らせるのは子が走っている間だけ。止まった子に残った裏のコマンドは知らせない（止める口は ply_task_cancel に残る）
      const bg = r.status === 'running' ? backgroundWaiting(r.sessionId) : null;
      for (const c of bg || r.status !== 'running' ? [] : r.activeCommands ?? []) {
        if (commandMs && commandFit(r, c) && !waitingOf(r) && !c.notified && !commandNoticed(r, c)
          && commandElapsed(c, now()) >= commandMs && !commandNotices.has(c.noticeId)) {
          spawn(notifyCommand(r, c).catch(e => report({ event: 'unexpected', operation: 'command', taskId: r.taskId, code: e?.code ?? null })));
        }
      }
      if (r.status === 'running') {
        if (r.queue.length && !instructionSends.has(r.taskId)) spawn(steerInstructions(r).catch(e => report({ event: 'unexpected', operation: 'steer', taskId: r.taskId, code: e?.code ?? null })));
        // 承認待ちとロック待ちは、どちらも「子が黙っている」ことに数えない（待ちが終わったら数え直す）
        const isWaiting = waitingOf(r) || lockWaiting(r.sessionId);
        if (isWaiting) {
          if (!silenceWaiting.has(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
          silenceWaiting.set(r.taskId, true);
        }
        else if (silenceWaiting.delete(r.taskId)) { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
        if (silenceMs && !isWaiting && !bg && r.lastActivityAt != null && now() - r.lastActivityAt >= silenceMs
          && r.silenceNotifiedAt !== r.lastActivityAt && !silenceNotices.has(r.taskId)
          && silenceFit(r) && !r.noticedSilence?.includes(silenceSignature(r))) {
          spawn(notifySilence(r).catch(e => report({ event: 'unexpected', operation: 'silence', taskId: r.taskId, code: e?.code ?? null })));
        }
        if (backgroundMs && bg && !backgroundNotices.has(r.taskId) && backgroundDue(r, bg)) spawn(notifyBackground(r).catch(e => report({ event: 'unexpected', operation: 'background', taskId: r.taskId, code: e?.code ?? null })));
        const rt = retryWaitOf(r);
        if (rt && retryNoticed.get(r.taskId) !== rt.since && !retryNotices.has(r.taskId)) {
          if (waited.has(r.taskId)) retryNoticed.set(r.taskId, rt.since);
          else spawn(notifyRetry(r, rt).catch(e => report({ event: 'unexpected', operation: 'retry', taskId: r.taskId, code: e?.code ?? null })));
        }
      } else { silenceWaiting.delete(r.taskId); if (!ACTIVE.has(r.status)) retryNoticed.delete(r.taskId); }
      // 上限で止まった子へ積まれた指示は、解除時刻まで走らせない（走らせても同じ上限で止まる。ADR 0229）
      if (r.status === 'queued' && !live.has(r.taskId) && !heldOf(r)) {
        const ac = new AbortController(); live.set(r.taskId, ac);
        spawn(run(r, ac).catch(e => { live.delete(r.taskId); report({ event: 'unexpected', operation: 'run', taskId: r.taskId, code: e?.code ?? null }); }));
      }
      if (notificationDue(r)) {
        if (!groups.has(r.parentSessionId)) groups.set(r.parentSessionId, []);
        groups.get(r.parentSessionId).push(r);
      }
    }
    // 同じ親へ届ける完了通知は 1 つにまとめる（ADR 0057）
    for (const [owner, rows] of groups) {
      if (noticeOwners.has(owner)) continue;
      spawn(notify(owner, rows).catch(e => report({ event: 'unexpected', operation: 'notify', taskId: rows[0].taskId, code: e?.code ?? null })));
    }
  }
  const timer = setInterval(kick, 500); timer.unref();
  return {
    // ホストに任せたタスクの写しは、ホストで動いている（この PC の更新・終了を止めない）。完了通知がまだ届いていないものだけ数える
    // 完了通知を渡している最中か（引き継ぎの前に終わるのを待つ。無停止の更新 2d。動いている子そのもの（busy）は、保持役に載った子は新しいサーバーが引き継ぐので数えない）
    get settling() { return notices.size > 0 || silenceNotices.size > 0 || commandNotices.size > 0 || backgroundNotices.size > 0 || Object.values(records).some(r => r.notification === 'delivering'); },
    blocksRestart(preservedTasks) {
      return this.settling || Object.values(records).some(r => !r.host && !preservedTasks.has(r.taskId) &&
        (live.has(r.taskId) || r.status === 'running' || r.status === 'cancelling'));
    },
    /** 引き継ぎを待たせている通知の依頼元の会話（画面に「どの会話を待っているか」を出す） */
    settlingSessions() {
      const taskIds = [...notices, ...silenceNotices, ...backgroundNotices, ...commandNotices.values(), ...Object.values(records).filter(r => r.notification === 'delivering').map(r => r.taskId)];
      return [...new Set(taskIds.map(id => records[id]?.parentSessionId).filter(Boolean))];
    },
    get busy() { return live.size > 0 || notices.size > 0 || silenceNotices.size > 0 || commandNotices.size > 0 || backgroundNotices.size > 0 || Object.values(records).some(r => (ACTIVE.has(r.status) && !r.host) || r.notification === 'pending'); },
    list(owner) { return Object.values(records).filter(r => !owner || r.parentSessionId === owner).map(r => view(r)); },
    /** sessionIds の会話が作った行と、その子孫の行の view（ホストに任された子の下の孫を数える・止める。docs/remote.md §4.5） */
    descendants(sessionIds) {
      const roots = new Set(sessionIds.filter(Boolean));
      const seen = new Set(), out = [];
      for (let grew = true; grew;) {
        grew = false;
        for (const r of Object.values(records)) {
          if (seen.has(r.taskId) || !roots.has(r.parentSessionId)) continue;
          seen.add(r.taskId); out.push(view(r)); grew = true;
          if (r.sessionId) roots.add(r.sessionId);
        }
      }
      return out;
    },
    /** 記録の行が条件に合うものだけの view（端末の AI に任された作業のように、全部を view にしたくないとき） */
    rowsWhere(predicate) { return Object.values(records).filter(predicate).map(r => view(r)); },
    /** 止まった（終わった・中断された）委譲の子の会話の id。エージェントのブラウザーの掃除に使う（core/agent-browser.mjs の sweepBrowserEnvironments） */
    finishedSessions() { return new Set(Object.values(records).filter(r => r.sessionId && !r.host && !ACTIVE.has(r.status)).map(r => r.sessionId)); },
    /**
     * 全端末へ配る running に載せる行（docs/agent-delegation.md「保存・画面・再起動」）。終わっていないものと、完了通知がまだ依頼元に
     * 届いていないものだけ。依頼文・振り分けの記録・結果は載せない（過去のタスクは画面が会話ごとに delegation.tasks で読む）
     */
    running() {
      return Object.values(records).filter(r => ACTIVE.has(r.status) || r.status === 'stopUnconfirmed' || UNDELIVERED.has(r.notification)).map(r => ({
        taskId: r.taskId, title: taskTitle(r.title, r.task), status: r.status, parentSessionId: r.parentSessionId, sessionId: r.sessionId,
        backend: r.backend ?? null, model: r.model ?? null, effort: r.effort ?? null, createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null,
        // 走っている間の最終活動。これが変わると running の配信が抑止を破り、開いているバックグラウンドの詳細が読み直される
        // （ネイティブのサブエージェントの行が発言数・時刻を載せているのと同じ役目。2026-10-24）
        lastActivityAt: r.lastActivityAt ?? null,
        notification: r.notification, error: r.error ? String(r.error).slice(0, 500) : null,
        pendingMessages: r.host ? (r.hostPendingMessages ?? 0) : (r.instructions ?? []).filter(x => x.state === 'queued').length, instructionRevision: r.instructionRevision ?? 0,
        worktree: r.worktree ?? null, retryOf: r.routing?.retry?.of ?? null,
        ...(r.host ? { host: r.host, remoteSessionId: r.remoteSessionId ?? null, hostWaiting: waitingOf(r) } : {}),
      }));
    },
    todoState(taskId) {
      const row = records[taskId];
      if (!row) return null;
      const needsHuman = row.host ? remoteWaiting(row) : waiting(row.sessionId);
      return { parentSessionId: row.parentSessionId, status: row.status, humanWaiting: ACTIVE.has(row.status) && Boolean(needsHuman) };
    },
    get(taskId, offset = 0) { return records[taskId] ? view(records[taskId], offset) : null; },
    /** リモート依頼元へ周期的に渡す小さな活動の写し。活動イベントごとの保存・送信はしない */
    remoteTelemetry(taskId) {
      const r = records[taskId];
      if (!r || r.host || r.status !== 'running') return null;
      return { lastActivityAt: r.lastActivityAt ?? null, lastOutputAt: r.lastOutputAt ?? null,
        activeCommands: (r.activeCommands ?? []).slice(0, 8).map(c => ({ ...c })) };
    },
    observe(sessionId, event) {
      const r = bySession.get(sessionId);
      if (!r || !event?.type) return;
      if (event.type === 'task.activity' && event.output) r.lastOutputAt = now();
      this.activity(sessionId);
      if (!['tool.start', 'tool.result', 'task.command'].includes(event.type)) return;
      observeCommand(r, event, now(), waiting(sessionId));
      // These observations are live state. A restart marks saved commands as
      // unknown, so saving the whole task file for each command adds no value.
    },
    activity(sessionId) {
      const r = bySession.get(sessionId);
      if (r?.status === 'running') { r.lastActivityAt = now(); r.silenceNotifiedAt = null; }
    },
    checkSilence: kick,
    /**
     * 走っているターンへ渡した完了通知が、読まれないままターンが終わった。まだ同じ回のものなら、空いたときの経路で送り直す
     * （人間の発言と違い、通知は送り直してよい。ADR 0057）。items: [{ taskId, revision, noticeId }]。
     * 出来事（events。ADR 0352）を載せた通知は、配送 ID で最後に渡した通知（lastNotice）と照らし、その出来事を先頭へ戻して送り直す
     */
    async renotify(items) {
      const back = r => r.lastNotice?.noticeId != null && !['read', 'suppressed'].includes(r.notification) && (r.lastNotice.events ?? []).some(e => e.kind === 'run')
        && items.some(x => x.taskId === r.taskId && x.noticeId === r.lastNotice.noticeId);
      const rows = items.map(x => records[x.taskId] && [records[x.taskId], x.revision ?? 0]).filter(Boolean)
        .filter(([r, revision]) => back(r) || (r.notification === 'sent' && (r.revision ?? 0) === revision && !ACTIVE.has(r.status)));
      if (!rows.length) return;
      await serial(async () => {
        for (const [r] of rows) {
          if (back(r)) {
            const { events = [], dropped = 0 } = r.lastNotice; delete r.lastNotice;
            const have = new Set((r.events ?? []).map(e => e.id));
            r.events = [...events.filter(e => !have.has(e.id)), ...(r.events ?? [])];
            if (dropped) r.eventsDropped = (r.eventsDropped ?? 0) + dropped;
            if (r.notification !== 'delivering') { r.notification = 'pending'; delete r.noticeId; }
            r.updatedAt = Date.now();
          } else if (r.notification === 'sent') { r.notification = 'pending'; delete r.noticeId; r.updatedAt = Date.now(); }
        }
        await persist('notify.renotify', rows.map(([r]) => r.taskId));
        touched();
      });
      kick();
    },
    /**
     * 途中送信で渡した追加指示への「渡った」合図（'delivered'）か、読まれずに捨てられた合図（'dropped'）。
     * 捨てられたら待機へ戻し、次のターンで送る（親からの指示なので送り直してよい。合図の ID で照合するので二重にならない）
     */
    async steered(taskId, instructionId, event, { nativeId = null } = {}) {
      if (event === 'delivered') await resolveClaim(taskId, instructionId, 'delivered', { nativeId });
      // 読まれたか分からない決着（cancelled・接続断。ACP のバックエンドは区別しない）は、
      // 指示を読んで既に実行した可能性があるので、dropped にして自動では送り直さない（steer の 'error' と同じ扱い）
      else if (event === 'unknown') await resolveClaim(taskId, instructionId, 'dropped');
      else await unclaim(taskId, instructionId);
    },
    /** 子のターンが終わった。渡った合図が来ないままの途中送信は読まれたか分からない（読まれていれば合図が先に来ている）ので待機へ戻し、次のターンで送る */
    async settleSteers(sessionId) {
      const r = bySession.get(sessionId);
      if (!r) return;
      settlingInstructions.add(r.taskId);
      await instructionSends.get(r.taskId)?.catch(() => {});
      await unclaim(r.taskId, [...(steers.get(r.taskId) ?? [])]);
    },
    /**
     * 子のターンが、ターン開始の入力（実行の開始で送ったプロンプト）を受け取った（バックエンドの onPromptDelivered。
     * 新しいターンは execute の onAccepted、付け直したターンは札の合図から来る）。ターン開始の入力にした指示
     * （sending で、途中送信の合図待ち＝steers の claim に無いもの）を delivered にする（ターンの終わりを待たない）。
     * 渡る前に戻した分（requeue で queued）や落とした分（dropped）は state が sending でないので触らない
     */
    async promptAccepted(taskId, nativeId = null) {
      const r = records[taskId];
      if (!r || !live.has(taskId)) return [];
      const has = () => { const claims = steers.get(taskId) ?? new Set(); return (r.instructions ?? []).some(x => x.state === 'sending' && !claims.has(x.id)); };
      if (!has()) return [];
      let flipped = [];
      await record(taskId, row => {
        const claims = steers.get(taskId) ?? new Set();
        for (const instruction of row.instructions ?? []) if (instruction.state === 'sending' && !claims.has(instruction.id)) {
          setInstruction(row, instruction.id, 'delivered');
          if (nativeId) instruction.nativeId = nativeId;
          flipped.push(instruction.id);
        }
      }, 'run.accepted');
      return flipped;
    },
    /**
     * 付け直した子のターン（起動の adopting に渡した taskId。無停止の更新 2b-7）の、結果の確定を引き継ぐ。
     * finish(task, signal) は execute の後半（子のターンが終わるのを待って結果を作る。execute と同じ形の結果を返す）。
     * claims は途中送信で渡している最中の追加指示の ID（旧サーバーの steers。札の liveInstructions）で、行がまだ sending のものだけ引き継ぐ
     * （旧サーバーが渡った合図を処理し終えていたら、行は delivered か queued になっていて、もう待たない）。
     * prompt は付け直す回の本文（取り直しで queue へ戻すときに使う。最初の依頼など instructions に無い分）。
     * finish が無ければ付け直せなかったので、起動の復元と同じに interrupted にする。引き継げたら true
     */
    adoptRun(taskId, finish, { claims = [], prompt } = {}) {
      const r = records[taskId], ac = live.get(taskId);
      if (!r || !ac || !adoptable.delete(taskId)) return false;
      if (!finish) {
        spawn(abandon(r).catch(() => {}).finally(() => live.delete(taskId)));
        return false;
      }
      const claimed = new Set(claims.filter(id => r.instructions?.find(x => x.id === id)?.state === 'sending'));
      if (claimed.size) steers.set(taskId, claimed);
      spawn(run(r, ac, finish, prompt).catch(e => { live.delete(taskId); report({ event: 'unexpected', operation: 'adopt', taskId, code: e?.code ?? null }); }));
      return true;
    },
    /** 子のバックエンドの入力が開いた。起動中に溜まった指示を現在のターンへ渡す */
    async sendQueued(sessionId) {
      const r = bySession.get(sessionId);
      if (r) return steerInstructions(r);
    },
    /**
     * 依頼元が子の設定（エージェント・モデル・思考の強さ・Claude のアカウント）を替えた（ply_task_send の backend・model・effort・account。ADR 0134・0205）。
     * 子の会話へ入れるのは server（applyTaskSettings）。ここはタスクの記録だけ: backend・model・effort（と替えたなら mode）を新しい値にし、
     * routing.target を新しい委譲先に、routing.changed に「依頼元が替えた」印（最初の委譲先 from・時刻・回数）を残す。保存できなければ断る。
     * account は次のターンで走るアカウント（内部の値。'' はログイン中。アカウントを持てないエージェントは null。ADR 0222）。accountLabels は内部の値 → 伏せた見出し。
     * 今の値と同じなら何も書かない（changed: false）。最初の委譲先へ戻したら印を外す。
     * 返すのは { task, changed, previous }。previous は書く前の値で、後の失敗で戻すとき（untarget）に使う
     */
    async retarget(owner, taskId, { backend, model, effort, mode, account, accountLabels = {}, pinTarget = false }, locale) {
      const r = owned(owner, taskId, locale);
      if (r.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
      if (r.status === 'stopUnconfirmed' && (live.has(taskId) || await stopUnconfirmed(r))) throw new Error(agentT(locale, 'tasks.stopUnconfirmed'));
      // アカウントは両方がアカウントを持てるとき（null でない）だけ比べる。from に account が無い（前の版で残した印）なら比べない
      const acct = v => v ?? '';
      const sameAccount = (a, b) => a.account == null || b.account == null || acct(a.account) === acct(b.account);
      const same = (a, b) => (a.backend ?? null) === (b.backend ?? null) && (a.model ?? '') === (b.model ?? '') && (a.effort ?? '') === (b.effort ?? '') && sameAccount(a, b);
      const now = { backend: r.backend, model: r.model, effort: r.effort, account: r.routing?.target?.backend === r.backend ? r.routing?.target?.account : undefined };
      const unchanged = same(now, { backend, model, effort, account }) && (r.mode ?? '') === (mode ?? '');
      if (unchanged && (!pinTarget || !autoTarget(r))) return { task: view(r), changed: false, previous: null };
      const previous = structuredClone({ backend: r.backend, model: r.model, effort: r.effort, mode: r.mode, routing: r.routing ?? null });
      await commit(r.taskId, row => {
        if (row.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
        if (unchanged) { row.routing.targetPinned = true; return; }
        const target = row.routing?.target ?? {};
        const was = target.account != null ? { account: acct(target.account), ...(target.accountLabel ? { accountLabel: target.accountLabel } : {}) } : {};
        const from = row.routing?.changed?.from ?? { backend: row.backend ?? null, model: row.model ?? null, effort: row.effort ?? null, ...was };
        const label = account == null ? null
          : accountLabels[acct(account)] ?? (target.backend === backend && target.account != null && acct(target.account) === acct(account) ? target.accountLabel : null);
        row.routing = { ...(row.routing ?? { mode: 'pinned', kind: null }),
          target: { backend, model, account: account == null ? null : acct(account), ...(label ? { accountLabel: label } : {}), effort: effort || null } };
        if (pinTarget && row.routing.mode === 'auto') row.routing.targetPinned = true;
        // 振り分けが決めた強さ（由来・段・合わせた元）は、依頼元が替えたら当てはまらない
        if ((previous.effort ?? '') !== (effort ?? '')) { row.routing.effortSource = 'parent'; delete row.routing.effortTier; delete row.routing.effortAsked; }
        if (same(from, { backend, model, effort, account })) delete row.routing.changed;
        else row.routing.changed = { by: 'parent', at: new Date().toISOString(), from, count: (previous.routing?.changed?.count ?? 0) + 1 };
        // 選んだ時点の使用率は前の委譲先のものなので外す
        if (backend !== target.backend || model !== target.model) { delete row.routing.targetWindows; delete row.routing.selectedWithLowHeadroom; }
        row.backend = backend; row.model = model; row.effort = effort;
        if (mode) row.mode = mode;
      }, 'retarget', locale);
      return { task: view(r), changed: true, previous };
    },
    /** retarget を書いた後に失敗した（指示を積めなかった）。書く前の値に戻す。保存に失敗しても投げない（メモリが正しく、後で追いつく） */
    async untarget(taskId, previous) {
      if (!records[taskId] || !previous) return;
      await record(taskId, row => {
        for (const k of ['backend', 'model', 'effort', 'mode']) { if (previous[k] === undefined) delete row[k]; else row[k] = previous[k]; }
        if (previous.routing) row.routing = previous.routing; else delete row.routing;
      }, 'untarget');
    },
    /**
     * 子のターンが始まった。子が実際に走る backend・model・effort・mode にタスクの記録を合わせる（人が子の予約を取り消した・替えたときの食い違いを残さない）。
     * 依頼元が替えた委譲（routing.changed）なら routing.target も合わせる（アカウントが食い違えば、見出しは分からないので外す）。同じなら書かない。書いたらタスクの id を返す
     */
    async sync(sessionId, { backend, model, effort, mode, account = null }) {
      const r = bySession.get(sessionId);
      const target = r?.routing?.changed ? r.routing.target : null;
      const accountMoved = !!target && (target.account ?? null) !== account && !(account != null && (target.account ?? '') === (account ?? ''));
      if (!r || ((r.backend ?? null) === backend && (r.model ?? '') === (model ?? '') && (r.effort ?? '') === (effort ?? '') && (r.mode ?? '') === (mode ?? '') && !accountMoved)) return null;
      await record(r.taskId, row => {
        row.backend = backend; row.model = model; row.effort = effort; row.mode = mode;
        if (row.routing?.changed && row.routing.target) {
          const moved = (row.routing.target.account ?? null) !== account && !(account != null && (row.routing.target.account ?? '') === (account ?? ''));
          const { accountLabel, ...rest } = row.routing.target;
          row.routing.target = { ...rest, backend, model, account, ...(accountLabel && !moved ? { accountLabel } : {}), effort: effort || null };
        }
      }, 'sync');
      return r.taskId;
    },
    /**
     * 子のターンで使った自動圧縮の閾値と内訳（{ threshold, base, source, headroom }。付けないターンは null。ADR 0166）。
     * 画面の委譲カードの内訳が読む。同じなら書かない。書いたらタスクの id を返す
     */
    async compaction(sessionId, plan) {
      const r = bySession.get(sessionId);
      if (!r || JSON.stringify(r.compaction ?? null) === JSON.stringify(plan ?? null)) return null;
      await record(r.taskId, row => { if (plan) row.compaction = structuredClone(plan); else delete row.compaction; }, 'compaction');
      return r.taskId;
    },
    instructions(taskId) { const r = records[taskId]; return r ? { taskId, revision: r.instructionRevision ?? 0, instructions: structuredClone(r.instructions) } : null; },
    /**
     * 委譲の子の会話で、依頼元の指示（execute）でないターンを始める（人の送信・Chrome を戻した続き・再開・別の会話からの送信。送信待ちの start が通す。ADR 0352）。
     * turn(hooks) がそのターンを走らせ、ターンの結果（runTurn の戻り）を返す。hooks が null なら、タスクと結ばずに素のまま走らせる。
     * hooks.began は、送信待ちがそのターンを受け付けた（onStarted が true）直後に呼ぶ。そこでタスクを running にする（ターンが始まる前に通す）。
     * - 止まった子（走っている回が無い）: 新しい回として走らせ、止まったら結果を書いて依頼元へ 1 回知らせる
     * - 走っている回の結果の確定の前（子が孫・裏の作業を待っている）: その回に合流する。回の結果の確定はこのターンの終わりを待つ
     * - 走っている回が結果の確定に入った後: 回が終わるのを待ってから、新しい回として走らせる
     * kind: 'human' | 'handoff' | 'resume' | 'relay' | null（回の終わりの出来事に載せるきっかけ。ADR 0352）。ホストに任せた子・委譲の子でない会話は素のまま
     */
    async external(sessionId, kind, turn) {
      const r = bySession.get(sessionId);
      if (!r || r.host || closed) return turn(null);
      const id = r.taskId;
      bump(waking, id, 1);
      let holding = true;
      const release = () => { if (humanWaits.get(id) === release) humanWaits.delete(id); if (holding) { holding = false; bump(waking, id, -1); kick(); } };
      try {
        for (;;) {
          if (closed || quitStops.has(id)) return await turn(null);
          // 止める合図を受けた回（取り消し中・中断済み）には合流しない。回が締まるのを待って、次の回として走らせる
          if (live.has(id) && (r.status === 'cancelling' || live.get(id).signal.aborted)) { await runEnded(id); continue; }
          if (r.status === 'cancelling') return await turn(null);
          if (live.has(id) && !closing.has(id)) {
            bump(joiners, id, 1);
            // 合流したターンが始まったら、動いた時刻だけ進める（行はもう running。きっかけは回を起こした方が書いている）
            try { return await turn({ signal: live.get(id).signal, taskId: id, began: async () => { await record(id, row => { if (ACTIVE.has(row.status)) row.lastActivityAt = now(); }, 'run.joined'); if (kind === 'human') humanWaits.set(id, release); else release(); } }); }
            finally { bump(joiners, id, -1); }
          }
          if (live.has(id)) { await runEnded(id); continue; }
          // 前の回が止まったか確かめられない（子がまだ動いているかもしれない）: タスクと結ばずに流す
          if (r.status === 'stopUnconfirmed' && await stopUnconfirmed(structuredClone(r))) return await turn(null);
          if (live.has(id)) continue;
          // 止まった子を新しい回として起こす。live を先に置き、kick が並べて run を始めないようにする
          const ac = new AbortController(); live.set(id, ac);
          let invoked = false, settle;
          const outcome = new Promise((resolve, reject) => { settle = { resolve, reject }; });
          const wake = { kind, started: false, before: null };
          wake.turn = async hooks => {
            invoked = true;
            try { const o = await turn({ ...hooks, began: async () => {
              try {
                await commit(id, row => {
                  if (row.status === 'stopUnconfirmed') interrupt(row);
                  wake.before = { status: row.status, notification: row.notification, stoppedBy: row.stoppedBy };
                  noticedDuring.set(id, null);
                  const noticed = NOTICED.has(row.notification);
                  if (!ACTIVE.has(row.status) || row.wake) wakeRow(row, kind);
                  // 送っている最中の通知（前の回の出来事）はそのまま送り終える。届けていない出来事は消さない（resetNotice）
                  if (row.notification !== 'delivering') delete row.noticeId;
                  row.revision = (row.revision ?? 0) + 1;
                  if (noticed) { delete row.rejections; delete row.rejectionsDropped; }
                  row.status = 'running'; row.lastActivityAt = now(); row.silenceNotifiedAt = null; row.error = null;
                  resetNotice(row); delete row.stoppedBy;
                  delete row.limit;
                }, 'run.external');
                wake.started = true;
              } catch (e) { report({ event: 'unexpected', operation: 'external', taskId: id, code: e?.code ?? null }); }
              // 人の送信は、その指示が台帳に載る（humanSent）まで前の回の知らせを待たせる（止めた知らせと同じ 1 通に載せる）
              if (kind === 'human' && wake.started) humanWaits.set(id, release); else release();
            } }); settle.resolve(o); return o; }
            catch (e) { settle.reject(e); throw e; }
          };
          spawn(run(r, ac, null, undefined, wake).catch(e => { live.delete(id); report({ event: 'unexpected', operation: 'run', taskId: id, code: e?.code ?? null }); })
            .finally(() => {
              release();
              // 回がターンを始めずに終わった（子の会話が消えていた・取り消された）: 人の送信は止めず、タスクと結ばずに流す
              if (!invoked) Promise.resolve().then(() => turn(null)).then(settle.resolve, settle.reject);
            }));
          return await outcome;
        }
      } finally { release(); }
    },
    /** 外から起きたターンが、走っている回に合流して走っているか（server の finishChild が、回の結果を確定する前に待つ） */
    joining(taskId) { return joiners.has(taskId); },
    /**
     * 走っている回の結果を確定してよいか（server の finishChild が、子のターン・孫・裏の作業を待ち終えた時に呼ぶ）。
     * 合流したターンが残っていれば false（もう一度待つ）。true を返したら、この後に来た外からのターンは回が終わるのを待つ
     */
    closeRun(taskId) {
      if (joiners.has(taskId)) return false;
      closing.add(taskId);
      return true;
    },
    /** 委譲の子（ホストに任せたものを除く）の会話か。人が直接送る入力欄の名札・数え方の分かれ目（ADR 0317） */
    isChild(sessionId) { const r = bySession.get(sessionId); return Boolean(r && !r.host); },
    /**
     * 人が子の会話へ直接送った指示が子に渡った（モーダルの入力欄・メインでその子を開いた入力欄。ADR 0317・0352）。
     * 中身（秘密の形を伏せて 300 字まで）と添付の数を、届けていない出来事に足す。これだけでは依頼元を起こさず、次の知らせに載せる。
     * humanInstructions は累計（画面・試験が渡った数を見る）。委譲の子（ホストに任せたものを除く）でなければ何もせず null。足したらタスクの id を返す
     */
    async humanSent(sessionId, { text = '', attachments = 0 } = {}) {
      const r = bySession.get(sessionId);
      if (!r || r.host) return null;
      await record(r.taskId, row => {
        row.humanInstructions = (row.humanInstructions ?? 0) + 1;
        pushEvent(row, { kind: 'human', text: clip(text), attachments: Number.isFinite(attachments) && attachments > 0 ? attachments : 0 });
      }, 'humanSent');
      // 人の送信のターンが待たせていた前の回の知らせを、この指示と一緒に送る
      humanWaits.get(r.taskId)?.();
      return r.taskId;
    },
    /** 最初の依頼（task と context）。やり直しで同じ依頼を渡す。context を持つ前に作ったタスクは task だけ */
    request(taskId) { const r = records[taskId]; return r ? { task: r.task, title: r.title ?? null, context: r.context ?? null } : null; },
    /**
     * ホストに任せたタスクの写しの行を足す（docs/agent-delegation.md「リモートのホストへ任せる」）。ホストが正本で、走らせるのはホスト。
     * row は { taskId（ホストのもの）, parentSessionId（依頼元の会話）, host: { hostId, name }, … }。同じ taskId が既にあれば何もしない。保存できなければ断る
     */
    async adopt(row, locale) {
      return serial(async () => {
        if (closed) throw new Error(agentT(locale, 'tasks.halted'));
        // ホストの便りの taskId は信じ切らない: 形を確かめ、手元のタスクと同じ ID は受けない（既にある行を返さない）
        if (typeof row.taskId !== 'string' || !TASK_ID.test(row.taskId) || records[row.taskId]) throw new Error(agentT(locale, 'tasks.remoteBadTaskId'));
        const parent = Object.values(records).find(r => r.sessionId === row.parentSessionId);
        const full = { manager: 'remote', depth: (parent?.depth ?? 0) + 1, createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', notification: 'none',
          result: '', error: null, instructions: [], instructionRevision: 0, queue: [], sessionId: null, ...row };
        // 最初から終わっている（すぐ終わった・すぐ失敗した）依頼は、結果を ply_delegate の戻りで渡すので、完了通知は送らない
        if (!ACTIVE.has(full.status) && full.status !== 'stopUnconfirmed') full.notification = 'read';
        records[full.taskId] = full;
        try { await write([full.taskId]); } catch (e) { delete records[full.taskId]; failed(e, 'adopt', full.taskId); throw refused(locale); }
        for (const target of full.routing?.limitSwitches ?? []) queueLimitSwitch(full.taskId, target);
        touched();
        return view(full);
      });
    },
    /**
     * ホストの便り（task）で、写しの行を更新する。ホストが正本なので、来た値をそのまま写す。終わった状態になったら、手元の委譲と同じに
     * 完了通知の対象にする（止めたもの suppressed・受け取り済み read はそのまま）。再開（動いている状態に戻る）なら通知をやり直す。変わらなければ書かない
     * 保存できなくても投げない（メモリが正しく、後で追いつく）。戻りは view（行が無い・写しでなければ null）
     */
    async mirror(taskId, patch) {
      const r = records[taskId];
      if (!r?.host) return null;
      return serial(async () => {
        const before = JSON.stringify(r);
        const previousSwitches = r.routing?.limitSwitches?.length ?? 0;
        // 追えなくなっていた（hostLost）行にホストの便りが戻ったら、ホストの状態に戻し、完了通知もやり直す
        const hostReturned = r.hostLost && patch.hostLost == null;
        if (hostReturned) r.notification = 'none';
        const was = r.status;
        // 止める予定（cancelPending）の間は、ホストの動いている状態の便り（running・waiting）で止めた状態を戻さない。終わった状態の便りは写し、予定を外す
        const keep = r.cancelPending === true && 'status' in patch && ACTIVE.has(patch.status) && !('cancelPending' in patch);
        for (const k of MIRROR_FIELDS) if (k in patch) {
          if (keep && ['status', 'hostWaiting', 'error'].includes(k)) continue;
          if (patch[k] == null) delete r[k]; else r[k] = patch[k];
        }
        if (patch.hostLost) { delete r.hostTelemetry; delete r.hostBackground; delete r.activeCommands; delete r.lastActivityAt; }
        if (r.cancelPending === true && !ACTIVE.has(r.status) && patch.status && !ACTIVE.has(patch.status)) delete r.cancelPending;
        if (patch.hostLost == null) delete r.hostLost;
        const wasActive = ACTIVE.has(was), isActive = ACTIVE.has(r.status);
        if (hostReturned || (isActive && !wasActive)) {
          delete r.noticeId;
          r.revision = (r.revision ?? 0) + 1;
        }
        if (r.status === 'stopUnconfirmed' || (isActive && !wasActive)) r.notification = 'none';
        else if (!isActive && (wasActive || r.notification === 'none')) r.notification = r.status === 'cancelled' ? 'suppressed' : r.notification === 'read' ? 'read' : 'pending';
        if (JSON.stringify(r) !== before) {
          r.updatedAt = Date.now();
          await persist('mirror', taskId);
          for (const target of r.routing?.limitSwitches?.slice(previousSwitches) ?? []) queueLimitSwitch(taskId, target);
          touched();
        }
        return view(r);
      });
    },
    /** 依頼元が結果を受け取った（ホストのタスクの ply_task_status・ply_task_wait の戻り）。完了通知を送らない */
    async markRead(taskId) { const r = records[taskId]; if (r) await markRead(r); },
    // locale は呼び出した会話（owner）の言語。子の会話も同じ言語を継ぐので、子への依頼文もこれで作る
    async call(owner, name, args = {}, signal, locale) {
      if (closed || signal?.aborted) throw new Error(agentT(locale, 'tasks.halted'));
      if (name === 'ply_delegate') {
        text(locale, args.backend, 'backend', 40); text(locale, args.task, 'task');
        if (args.context !== undefined) text(locale, args.context, 'context');
        if (args.isolate !== undefined && typeof args.isolate !== 'boolean') throw new Error(agentT(locale, 'tasks.isolateInvalid'));
        if (args.title !== undefined && typeof args.title !== 'string') throw new Error(agentT(locale, 'tasks.textLength', { name: 'title', max: 40 }));
        args = { ...args, title: taskTitle(args.title, args.task) };
        const row = await serial(async () => {
          // 保存できない間は新しい仕事を受けない。子の会話を作る前に、書けるかを確かめる
          if (fault) { try { await write([]); touched(); } catch (e) { failed(e, 'delegate'); throw refused(locale); } }
          // 同時の件数・1 会話の件数・深さに上限は置かない（2026-09-27 に廃止。端末の AI から任された作業の鎖の深さの上限も、2026-10-09 に外した。depth は記録だけ残す）
          const parent = Object.values(records).find(r => r.sessionId === owner);
          const depth = (parent?.depth ?? 0) + 1;
          const taskId = `ply-task-${crypto.randomUUID()}`;
          const prepared = await prepare(owner, args, taskId, signal);
          try {
          if (signal?.aborted) throw new Error(agentT(locale, 'tasks.aborted'));
          const row = { ...prepared, taskId, parentSessionId: owner, manager: 'ply', depth, task: args.task, title: args.title, ...(args.context !== undefined ? { context: args.context } : {}),
            createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', notification: 'none',
            result: '', error: null, instructions: [], instructionRevision: 0,
            queue: [(args.context ? agentT(locale, 'tasks.withContext', { task: args.task, context: args.context }) : args.task)
              + (prepared.worktree ? agentT(locale, 'tasks.worktreeInstruction', { path: prepared.worktree.path, branch: prepared.worktree.branch, origin: prepared.worktree.origin }) : '')] };
          records[taskId] = row; bySession.set(row.sessionId, row);
          try { await write([taskId]); } catch (e) { failed(e, 'delegate', taskId); throw refused(locale); }
          touched(); return view(row);
          } catch (e) { delete records[taskId]; bySession.delete(prepared.sessionId); await rollback(prepared); throw e; }
        });
        kick(); return row;
      }
      // 読み取りは保存障害の間も答える。状態はメモリのもので、障害中なら storageFault を添える
      // 一覧は短く保つ。拒否は件数だけ（中身は ply_task_status）
      if (name === 'ply_task_list') return { tasks: Object.values(records).filter(r => r.parentSessionId === owner).map(r => { const { result, rejections, ...rest } = shown(r); return { ...rest, rejectionCount: rejections.length }; }), ...storage(locale) };
      const r = owned(owner, text(locale, args.taskId, 'taskId', 100), locale);
      if (name === 'ply_task_status') {
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0) throw new Error(agentT(locale, 'tasks.offsetInvalid'));
        const out = { ...shown(r, offset), ...(r.git ? { gitSummary: gitLine(locale, r.git) } : {}), ...(await workspaceOf(r, locale)), ...storage(locale) };
        await markRead(r);
        return out;
      }
      if (name === 'ply_task_wait') {
        const seconds = args.seconds ?? 30;
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error(agentT(locale, 'tasks.secondsInvalid'));
        // 人間の承認待ちになったら待たずに戻る。待つ相手が人間に変わったことを依頼元へ早く伝える
        const pending = () => ACTIVE.has(r.status) && !waitingOf(r);
        // 待っている間に終わったら、結果はこの戻り値で渡す。同じ結果の完了通知を走っているターンへ重ねないよう、待ちの間は通知を控える
        waited.set(r.taskId, (waited.get(r.taskId) ?? 0) + 1);
        try {
          if (pending()) await new Promise(resolve => {
            const done = () => { clearTimeout(timeout); listeners.delete(check); signal?.removeEventListener('abort', done); resolve(); };
            const check = () => { if (!pending()) done(); };
            const timeout = setTimeout(done, seconds * 1000); listeners.add(check); signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted) done();
          });
          const out = { ...shown(r), ...(r.git ? { gitSummary: gitLine(locale, r.git) } : {}), ...(await workspaceOf(r, locale)), ...storage(locale) };
          // 再試行の待ちはこの戻り値で依頼元に渡った。同じ待ちの知らせは送らない
          const rt = retryWaitOf(r);
          if (rt) retryNoticed.set(r.taskId, rt.since);
          await markRead(r);
          return out;
        } finally {
          if (waited.get(r.taskId) > 1) waited.set(r.taskId, waited.get(r.taskId) - 1); else waited.delete(r.taskId);
        }
      }
      if (name === 'ply_task_send') {
        text(locale, args.message, 'message');
        const checkedStop = r.status === 'stopUnconfirmed' && !live.has(r.taskId) && !await stopUnconfirmed(r);
        // 追加の指示も新しい仕事なので、保存できなければ受けない（commit が理由付きで断る）
        // 錨（受け付けた時点で直前に見えていたもの）は会話の記録を読むことがあるので、commit の外で取る。
        // 取れなくても指示は受け付ける（錨が無い分は、届いた行の位置か時刻で置く）
        const anchor = await Promise.resolve().then(() => anchorProbe(r.sessionId)).catch(() => null);
        let instruction;
        await commit(r.taskId, row => {
          if (row.status === 'cancelling') throw new Error(agentT(locale, 'tasks.stopping'));
          if (quitStops.has(row.taskId)) throw new Error(agentT(locale, 'tasks.stopUnconfirmed'));
          if (row.status === 'stopUnconfirmed') {
            if (!checkedStop || live.has(row.taskId)) throw new Error(agentT(locale, 'tasks.stopUnconfirmed'));
            interrupt(row);
          }
          if (row.notification !== 'delivering') delete row.noticeId;
          row.revision = (row.revision ?? 0) + 1;
          // 前の回の拒否を依頼元へ渡し終えていれば、この指示で走る回の分で置き換える。まだ渡していなければ（走っている・通知の前）足していく
          if (NOTICED.has(row.notification)) { delete row.rejections; delete row.rejectionsDropped; }
          // nextTurn: 設定の変更と同じ呼び出しで積まれた指示は、替えた後のターン宛にする（server.mjs の applyTaskSettings）
          instruction = { id: crypto.randomUUID(), text: args.message, at: Date.now(), state: 'queued',
            ...(args.nextTurn === true ? { nextTurn: true } : {}),
            ...(anchor ? { anchor } : {}) };
          row.instructions.push(instruction); row.instructionRevision = (row.instructionRevision ?? 0) + 1;
          // 止まった子を起こす指示なら、完了通知に「依頼元の追加の指示」と添える（ADR 0352）。notification を書き換える前に見る
          if (!ACTIVE.has(row.status)) wakeRow(row, 'parent');
          // 届けていない前の回の終わり（人が止めたなど）は消さずに先に届ける（resetNotice。ADR 0352）
          row.queue.push({ instructionId: instruction.id }); resetNotice(row); row.error = null;
          if (!live.has(row.taskId) || !ACTIVE.has(row.status)) row.status = 'queued';
        }, 'send', locale);
        // 受け付けた位置（この時点の会話の末尾）を確定させる。呼ぶ側はここで表示の出来事を記録する
        accepted(r, structuredClone(instruction));
        const instructionId = instruction.id;
        // 子のターンが走っていて途中送信を受けられるなら、待たずに今のターンへ渡す（ADR 0065）
        const steered = await steerInstructions(r).catch(e => { report({ event: 'unexpected', operation: 'steer', taskId: r.taskId, code: e?.code ?? null }); });
        kick();
        // 戻りには、この呼び出しが受け付けた指示を載せる（近接する別の send の記録を誤って指さない。
        // リモートの口 server.mjs の remoteAgentInvoke が、send の答えに表示契約の形で添える元にする）
        const out = { ...view(r), instruction: structuredClone(instruction) };
        // 渡ったか分からない指示は送り直さない。依頼元のエージェントには、確かめるよう一言添える
        if (steered?.has(instructionId)) return { ...out, warning: agentT(locale, 'tasks.steerUnknown') };
        // 上限で止まった子は、解除時刻まで指示を走らせない。待つか、止めて別の委譲先に任せ直すかを選べるよう伝える
        const hold = heldOf(r);
        if (hold) return { ...out, warning: agentT(locale, 'tasks.limitHeld', { time: clockText(hold.resetsAt) }) };
        return out;
      }
      if (name === 'ply_task_cancel') {
        // ホストに任せた子は決まりの外（今までどおり。終わったタスクの結果はこの戻り値で渡り、同じ結果の完了通知を後から送らない）。
        // 止めたか確かめられていない子も今までどおり
        if (r.host || r.status === 'stopUnconfirmed') { await this.cancel(r.taskId); const out = view(r); await markRead(r); return out; }
        // 止める合図を送るだけ。止まったことは、ほかの終わり方と同じ終了通知で届く（ADR 0352）。
        // 合図が届く前に終わっていれば、その終わり方（完了・失敗）の通知になる
        const stopping = ACTIVE.has(r.status) || live.has(r.taskId) || r.queue.length > 0;
        if (stopping) {
          await this.cancel(r.taskId, { by: 'parent' });
          return { taskId: r.taskId, status: shown(r).status, message: agentT(locale, 'tasks.cancelSent') };
        }
        // もう終わっている。孫（このタスクの子の会話が任せた子）は今までどおり止める（その終了通知は、このタスクの子の会話の次のターンへ）
        await this.cancel(r.taskId, { by: 'parent' });
        // 終了通知がまだ届いていなければ、その通知をそのまま届ける（この戻り値では結果を渡さず、既読にもしない）
        if (readable(r)) {
          kick();
          return { taskId: r.taskId, status: r.status, message: agentT(locale, 'tasks.cancelEndedPending') };
        }
        return { taskId: r.taskId, status: r.status, message: agentT(locale, 'tasks.cancelEnded') };
      }
      throw new Error(agentT(locale, 'tasks.unknownTool'));
    },
    // 取り消したとき止まったもの（走っていた・待っていた）なら、止めた時点の状態を返す（無ければ null）。返すのは通知を止めた取り消し
    // （by の無い取り消し・ホストに任せた子）だけ。by のある取り消しは終了通知で依頼元へ伝わるので返さない（server が「止めたもの」に重ねて残さない）。
    // 終わったタスク（止めるものが無い）の届いていない完了通知は止めない。以前は止めていて、依頼元に結果が届かなかった。
    // by: 止めた側（'human' 人が止めた・'parent' 依頼元が取り消した）。止まったら終了通知を 1 つ作り、終わり方として載せる（ADR 0352）。
    // 子孫（descendant）は依頼元（このタスクの親の会話）ごと止まる。その終了通知は依頼元の次のターンの始めに渡す（ownerStop・takeHeld）。
    // by の無い取り消し（ホストの便りの口など、決まりの外の入口）とホストに任せた子は、今までどおり通知も止める
    async cancel(taskId, { descendant = false, by = null } = {}) {
      const r = records[taskId]; if (!r) return null;
      // Stop descendant Pleiad tasks too; engine-native children follow their engine's cancellation.
      for (const child of Object.values(records).filter(c => c.parentSessionId === r.sessionId)) await this.cancel(child.taskId, { descendant: true, by });
      if (r.status === 'stopUnconfirmed') return null;
      const was = r.status, stopping = ACTIVE.has(r.status) || live.has(taskId) || r.queue.length > 0;
      if (!descendant && !stopping && readable(r)) return null;
      const notice = Boolean(by) && !r.host;
      if (notice && !stopping && !descendant) return null;
      // 止めることは保存できなくても止める（record。ファイルは後で追いつく）
      await record(taskId, row => {
        row.revision = (row.revision ?? 0) + 1; dropInstructions(row);
        if (!notice) row.notification = 'suppressed';
        else {
          if (descendant) row.ownerStop = true;
          // 子孫は依頼元（このタスクの親の会話）ごと止まった（'owner'。依頼元の会話の中断）
          if (stopping && was !== 'cancelling') row.stoppedBy = descendant ? 'owner' : by;
        }
        if (ACTIVE.has(row.status)) row.status = live.has(taskId) ? 'cancelling' : 'cancelled';
        // 走る回の無いまま止めた（積まれただけの子）: 回の終わりが無いので、ここで終わりの出来事と終了通知を作る。
        // 前の回の上限（limit）は外す。残すと通知が上限の一言だけになり、止めたことが伝わらない（積んだ送信も捨てたので、上限の明けを待つものは無い）
        if (notice && stopping && row.status === 'cancelled' && !live.has(taskId)) { runEvent(row, 'cancelled', ''); resetNotice(row); delete row.limit; }
      }, 'cancel');
      live.get(taskId)?.abort();
      if (r.host && stopping) await stopHost(r);
      if (!live.has(taskId) && r.activeCommands?.length) await cancelBackground(view(r));
      return !notice && stopping && was !== 'cancelling' ? { taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: was } : null;
    },
    // 承認待ちの増減で ply_task_wait を起こす。保存する状態は変わらないので write() は通らない
    wake() { for (const r of Object.values(records)) pauseCommands(r, now(), waitingOf(r)); for (const fn of [...listeners]) fn(); },
    // 会話を止めたときに、その会話が作ったタスク（と子孫）をまとめて止める。cancel と同じ書き換えを、
    // 書き換えて何かが変わるものにだけ行い、保存は 1 回にする。以前は終わったタスクまで 1 件ずつ保存していて
    // （1 会話で数十件になる）、会話の停止を遅らせていた。止め終わって通知も抑えたもの（cancel を呼んでも
    // revision と updatedAt しか変わらない）は飛ばす。子孫は親を飛ばしても辿る。
    // 中断した会話を勝手に再開しないので、終わっていて完了通知が届いていない（none / pending）タスクの通知も止める。
    // その結果は捨てずに返す（unread: true。ply_task_status で読める）。走っていた・待っていたタスクは止めた時点の状態で返す。
    // 返すのは [{ taskId, parentSessionId, title, status, unread }]。server が依頼元の会話ごとに「止めたもの」に残し、
    // 次のターンでエージェントへ伝える（docs/design.md「中断と再開」）
    // since（ミリ秒）を渡すと、その時刻以後に作ったタスクだけを対象にする（巻き戻しで消える範囲で生まれた子。core/server.mjs の rewindConversation）
    // by（'human'）を渡すと、止まった子の終了通知を止めない（ADR 0352）。終わったら終了通知を 1 つ作り、依頼元の会話の次のターンの始めに渡す
    // （ownerStop・takeHeld）。そのとき返すのは、決まりの外のホストに任せた子だけ（server が今までどおり「止めたもの」に残す）
    async cancelOwner(owner, { since, by = null } = {}) {
      const targets = [], seen = new Set();
      const visit = r => {
        if (seen.has(r.taskId)) return;
        seen.add(r.taskId);
        for (const child of Object.values(records).filter(c => c.parentSessionId === r.sessionId)) visit(child);
        targets.push(r);
      };
      for (const r of Object.values(records).filter(r => (!owner || r.parentSessionId === owner) && (!Number.isFinite(since) || r.createdAt >= since))) visit(r);
      const quiet = r => !ACTIVE.has(r.status) && !r.queue.length && !live.has(r.taskId);
      const notifying = r => Boolean(by) && !r.host;
      // 止め終わって通知も抑えたもの。通知を止めない取り消しでは、終わって通知が届いたもの（止めるものも渡すものも無い）
      const settled = r => quiet(r) && (notifying(r) ? !['none', 'pending'].includes(r.notification) : r.notification === 'suppressed');
      const change = targets.filter(r => r.status !== 'stopUnconfirmed' && !settled(r));
      if (!change.length) return [];
      const stopped = [], hostStops = [];
      // cancel と同じく、保存できなくても止める
      await serial(async () => {
        for (const r of change) {
          const running = (ACTIVE.has(r.status) || live.has(r.taskId) || r.queue.length > 0) && r.status !== 'cancelling';
          if (r.host && running) hostStops.push(r);
          const notice = notifying(r);
          if (!notice && (running || readable(r))) stopped.push({ taskId: r.taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status, unread: !running });
          r.revision = (r.revision ?? 0) + 1; dropInstructions(r);
          if (!notice) r.notification = 'suppressed';
          // 依頼元の会話ごと止まった（'owner'。依頼元の会話の中断）
          else { r.ownerStop = true; if (running) r.stoppedBy = 'owner'; }
          if (ACTIVE.has(r.status)) r.status = live.has(r.taskId) ? 'cancelling' : 'cancelled';
          // 走る回の無いまま止めた（積まれただけの子）: 回の終わりが無いので、ここで終わりの出来事と終了通知を作る
          if (notice && running && r.status === 'cancelled') { runEvent(r, 'cancelled', ''); resetNotice(r); delete r.limit; }
          r.updatedAt = Date.now();
        }
        await persist('cancelOwner', change.map(r => r.taskId));
        touched();
      });
      for (const r of change) live.get(r.taskId)?.abort();
      // ホストの子を止める依頼は並列に・短い待ちで（応答しないホストの分だけ中断を遅らせない）
      await Promise.all(hostStops.map(stopHost));
      return stopped;
    },
    /**
     * 依頼元の会話でターンが始まる（server の beginTurn。圧縮のターンを除く）。ADR 0352。
     * 依頼元ごと止めた・取り消した子孫の印（ownerStop）を外し、止められている間に貯めた終了通知（pending）を渡す。
     * stopped: その会話がこのターンの直前まで止められていた（中断の印があった）。そのときはその会話宛ての pending をすべて渡す。
     * 渡すものがあれば delivering にして { tasks, settle } を返す。settle('ok') はプロンプトが渡った時（sent）、
     * それ以外はターンが渡さずに終わった時（pending に戻し、普通の配送に任せる）。無ければ null
     */
    async takeHeld(owner, { stopped = false } = {}) {
      if (!owner || closed) return null;
      const mine = Object.values(records).filter(r => r.parentSessionId === owner && !r.host);
      const flagged = mine.filter(r => r.ownerStop);
      const due = mine.filter(r => (stopped || r.ownerStop) && r.notification === 'pending' && deliverable(r)
        && !notices.has(r.taskId) && !waited.has(r.taskId) && !waking.has(r.taskId) && !limitSwitchNotices.has(r.taskId));
      for (const r of due) notices.add(r.taskId);
      try {
        if (flagged.length) await serial(async () => {
          for (const r of flagged) { delete r.ownerStop; r.updatedAt = Date.now(); }
          await persist('notify.ownerResumed', flagged.map(r => r.taskId));
          touched();
        });
        const sending = due.length ? await begin(due) : [];
        for (const r of due) if (!sending.includes(r)) notices.delete(r.taskId);
        if (!sending.length) return null;
        const ids = new Map(sending.map(r => [r.taskId, r.noticeId]));
        let settled = null;
        const settle = outcome => settled ??= (async () => {
          await serial(async () => {
            for (const r of sending) {
              if (r.noticeId !== ids.get(r.taskId) || r.notification !== 'delivering') continue;
              if (outcome === 'ok') delivered(r, 'sent'); else { r.notification = 'pending'; delete r.sending; }
              r.updatedAt = Date.now();
            }
            await persist('notify.held', sending.map(r => r.taskId));
            touched();
          });
          for (const r of sending) { noticeRetryAt.delete(r); notices.delete(r.taskId); }
          if (outcome !== 'ok') kick();
        })();
        return { tasks: sending.map(noticeClone), settle };
      } catch (e) {
        for (const r of due) notices.delete(r.taskId);
        throw e;
      }
    },
    /** 再起動で止まった（interrupted にした）タスク。[{ taskId, parentSessionId, title, status }]（status は止まる前の状態） */
    get restored() { return structuredClone(restored); },
    async deferHeldStop(taskId, childId) {
      const r = records[taskId];
      if (!r || !ACTIVE.has(r.status)) return false;
      await record(taskId, row => {
        if (!ACTIVE.has(row.status)) return;
        setStopUnconfirmed(row);
        row.heldQuit = childId;
        quitStops.add(taskId);
        row.notification = 'suppressed';
      }, 'quit.stopRequested');
      return r.heldQuit === childId;
    },
    async settleHeldStop(taskId, exited) {
      const r = records[taskId];
      if (!r?.heldQuit || r.status !== 'stopUnconfirmed') return null;
      if (exited) await record(taskId, row => {
        interrupt(row);
        row.status = 'cancelled';
        row.error = null;
      }, 'quit.stopConfirmed');
      return { taskId, parentSessionId: r.parentSessionId, title: r.title ?? null, status: r.status, stopUnconfirmed: !exited };
    },
    /** 保存障害（無ければ null）。errno・操作・タスク ID・時刻だけ */
    get fault() { return fault && { code: fault.code, syscall: fault.syscall, operation: fault.operation, taskId: fault.taskId, since: fault.since, at: fault.at, failures: fault.failures }; },
    // 正常終了。保存障害では閉じない。返す Promise は、閉じる前に始まった実行・通知・保存が書き終えると解ける
    // （閉じた後も、走っていた分の保存は続く。データ置き場を消す前に待つ）
    async close() {
      closed = true; clearInterval(timer); for (const ac of live.values()) ac.abort();
      await Promise.allSettled([...instructionSends.values()]);
      while (background.size) await Promise.all([...background]);
      await writes;
      handle?.release(); handle = null;
    },
  };
}
