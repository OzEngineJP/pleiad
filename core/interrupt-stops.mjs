// 中断で Pleiad が止めたもの（stops）の形と、再開後の最初のターンでエージェントへ添える文（docs/design.md「中断と再開」）。
//
// 止めたものは会話の行（sidecar の stops。core/store.mjs の addStops / takeStops）に残す:
//   - 委譲タスク: 取り消したもの（止めた時点の状態）・終わっていたが完了通知が届いていなかったもの（unread）・再起動で止まったもの（restart）
//   - バックグラウンドの作業: ターンが抱えていたもの（Claude の run_in_background の Bash・サブエージェント）。CLI の終了で止まる
//   - 実行中だったツール: 止めた時点で結果が返っていなかったもの（ツール名と対象の要約。承認待ちのものは承認待ちの方で数える）
//   - 承認待ち: 却下扱いにしたもの（ツール名と対象の要約）
// 次のターン（人の発言・再開の文・送り直し・完了通知のどれでも。圧縮は除く）の始めに、文を 1 つ作って発言の前に添える。
// 添えた文は <pleiad-interruption> で囲む。履歴はこの印で人の発言から切り分け、システム側の 1 行として描く（splitInterruptionNote）。
// SDK も DOM も import しない。
import { agentT } from './i18n.mjs';
import { redactForPeer } from './redact.mjs';
import { INTERRUPTION_TAG } from './system-messages.mjs';

const OPEN = `<${INTERRUPTION_TAG}>`, CLOSE = `</${INTERRUPTION_TAG}>`;
const TEXT_MAX = 200;
const REASONS = new Set(['user', 'update', 'quit', 'hostAway', 'restart', 'settings']);

const oneLine = (s, max = TEXT_MAX) => redactForPeer(String(s ?? '').replace(/\s+/g, ' ').trim(), max) ?? '';

/** 取り消した委譲タスク（agentTasks.cancelOwner・cancel・restored の項目）を stops の形にする */
export function taskStop(x, { restart = false, noticeUnconfirmed = false } = {}) {
  const key = noticeUnconfirmed ? `task-result:${x.taskId}:${x.noticeId ?? 'legacy'}` : `task:${x.taskId}`;
  return { key, taskId: x.taskId, title: oneLine(x.title, 80), status: String(x.status ?? ''),
    unread: Boolean(x.unread), ...(restart ? { restart: true } : {}),
    ...(x.stopUnconfirmed ? { stopUnconfirmed: true } : {}), ...(noticeUnconfirmed ? { noticeUnconfirmed: true } : {}) };
}

/** 止めた時点で結果が返っていなかったツール（makeEmit の turn.openTools の行） */
export function toolStop(x) {
  return { key: `tool:${x.id}`, tool: oneLine(x.name ?? '', 80), target: approvalTarget({ input: x.input }) };
}

/** ターンが抱えていたバックグラウンドの作業（turn.info.background の行） */
export function backgroundStop(x) {
  return { key: `bg:${x.id}`, id: String(x.id), kind: ['agent', 'shell', 'terminal'].includes(x.kind) ? x.kind : 'other', label: oneLine(x.label) };
}

/** 承認待ちの対象の要約。コマンド・パス・URL を優先し、無ければ入力を JSON で（秘密は伏せる） */
function approvalTarget(payload) {
  if (payload?.kind === 'question') return oneLine(payload.questions?.[0]?.question ?? '');
  // ターンの外の待ち（Chrome の接続・ログイン。ADR 0168）は、人に何を頼んだかが対象
  if (payload?.browserHandoff) return oneLine(payload.browserHandoff.message || payload.browserHandoff.reason || '');
  // 設定の変更の承認（detached。ADR 0088）と秘密情報の入力のカード（ADR 0217）
  if (payload?.settingChange) return oneLine(payload.settingChange.key ?? payload.settingChange.op ?? '');
  if (payload?.secretRequest) return oneLine(payload.secretRequest.name ?? payload.secretRequest.label ?? '');
  const input = payload?.input;
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'query', 'description']) {
    if (typeof input[k] === 'string' && input[k].trim()) return oneLine(input[k]);
  }
  const json = JSON.stringify(input);
  return json && json !== '{}' ? oneLine(json) : '';
}

/** 却下扱いにした承認待ち（runtime.waiting の行。id はカードの id） */
export function approvalStop(id, payload) {
  return { key: `ap:${id}`, tool: oneLine(payload?.toolName ?? '', 80), target: approvalTarget(payload) };
}

/** ターンの外で待っていたもの（outlivesTurn。Chrome の接続・ログイン。ADR 0168）。再起動で取り下げた分 */
export function waitStop(id, payload) {
  return { key: `wait:${id}`, tool: oneLine(payload?.toolName ?? '', 80), target: approvalTarget(payload) };
}

/**
 * エージェントへ添える文。止めたものが無ければ null。
 * 返り: { text, body, keys, dropped, hidden }。text はエージェントへ渡す文（印で囲む）、body は画面に出す中身。
 * keys は伝えた項目（渡ったら takeStops で消す）。
 * 作業中の設定の変更で止めた（reason: settings）ときは、印に reason="settings" を付け、画面には出さない（hidden）。
 * 利用者には「変えました」の跡の行だけを見せる（docs/design-system.md「作業中の設定の変更」・ADR 0341）
 */
export function interruptionNote(lng, stops, reason = null) {
  if (!stops) return null;
  const tasks = stops.tasks ?? [], tools = stops.tools ?? [], background = stops.background ?? [], approvals = stops.approvals ?? [], waits = stops.waits ?? [];
  const stopped = tasks.filter(x => !x.stopUnconfirmed && !x.noticeUnconfirmed);
  const cancelled = stopped.filter(x => !x.unread && !x.restart), unread = stopped.filter(x => x.unread), restarted = stopped.filter(x => x.restart && !x.unread);
  const unconfirmedStops = tasks.filter(x => x.stopUnconfirmed), unconfirmedNotices = tasks.filter(x => x.noticeUnconfirmed);
  if (!tasks.length && !tools.length && !background.length && !approvals.length && !waits.length) return null;
  const item = x => agentT(lng, 'stops.taskItem', { taskId: x.taskId, title: x.title || '-', status: x.status || '-' });
  const resultItem = x => agentT(lng, 'stops.unreadItem', { taskId: x.taskId, title: x.title || '-', status: x.status || '-' });
  const sections = [];
  if (cancelled.length) sections.push(agentT(lng, 'stops.cancelled', { items: cancelled.map(item).join('\n') }));
  if (unread.length) sections.push(agentT(lng, 'stops.unread', { items: unread.map(resultItem).join('\n') }));
  if (restarted.length) sections.push(agentT(lng, 'stops.restarted', { items: restarted.map(item).join('\n') }));
  if (unconfirmedStops.length) sections.push(agentT(lng, 'stops.stopUnconfirmed', { items: unconfirmedStops.map(resultItem).join('\n') }));
  if (unconfirmedNotices.length) sections.push(agentT(lng, 'stops.noticeUnconfirmed', { items: unconfirmedNotices.map(resultItem).join('\n') }));
  if (tools.length) sections.push(agentT(lng, 'stops.tools', { items: tools.map(x =>
    agentT(lng, 'stops.toolItem', { tool: x.tool || '-', target: x.target || '-' })).join('\n') }));
  if (background.length) sections.push(agentT(lng, 'stops.background', { items: background.map(x =>
    // i18n-dynamic: agent:stops.kind.
    agentT(lng, 'stops.backgroundItem', { id: x.id, kind: agentT(lng, `stops.kind.${x.kind}`), label: x.label || '-' })).join('\n') }));
  if (approvals.length) sections.push(agentT(lng, 'stops.approvals', { items: approvals.map(x =>
    agentT(lng, 'stops.approvalItem', { tool: x.tool || '-', target: x.target || '-' })).join('\n') }));
  if (waits.length) sections.push(agentT(lng, 'stops.waits', { items: waits.map(x =>
    agentT(lng, 'stops.waitItem', { tool: x.tool || '-', target: x.target || '-' })).join('\n') }));
  if (stops.dropped) sections.push(agentT(lng, 'stops.dropped', { count: stops.dropped }));
  // i18n-dynamic: agent:stops.reason.
  const why = REASONS.has(reason) ? agentT(lng, `stops.reason.${reason}`) : agentT(lng, 'stops.reason.unknown');
  const onlyUnconfirmed = !stopped.length && !tools.length && !background.length && !approvals.length && !waits.length;
  const heading = onlyUnconfirmed ? agentT(lng, 'stops.recoveryHeading') : agentT(lng, 'stops.heading', { reason: why });
  const body = [heading, ...sections, ...(!onlyUnconfirmed ? [agentT(lng, 'stops.footer')] : [])].join('\n\n');
  // 後ろを空けておく（人の発言と 1 つの文につながる履歴でも、読みやすく切れる）
  const hidden = reason === 'settings';
  const open = hidden ? `<${INTERRUPTION_TAG} reason="settings">` : OPEN;
  return { text: `${open}\n${body}\n${CLOSE}\n\n`, body, keys: [...tasks, ...tools, ...background, ...approvals, ...waits].map(x => x.key),
    dropped: Boolean(stops.dropped), ...(hidden ? { hidden: true } : {}) };
}

/**
 * ［今すぐ変える］で止めて新しい設定にしたあと、続きを頼む文（AI にだけ渡す。画面には出さない）。
 * 印 reason="settings" で囲むので、履歴でも人の発言にならず、見えない行になる（splitInterruptionNote）
 */
export function settingsResumePrompt(lng) {
  return `<${INTERRUPTION_TAG} reason="settings">\n${agentT(lng, 'stops.resumeSettings')}\n${CLOSE}`;
}
