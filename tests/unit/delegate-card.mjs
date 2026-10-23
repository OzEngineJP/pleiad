import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderToolCall, applyToolResult } from '../../web/render.mjs';
import { delegateResult, delegateTaskId } from '../../web/delegate-result.mjs';
import { el } from '../../web/dom.mjs';
import { liveSnapshot } from '../../core/live-snapshot.mjs';
import { transcriptToMessages } from '../../core/backends/claude-normalize.mjs';
import * as shared from '../../core/backends/shared.mjs';

export const name = 'delegate-card';
export const title = '委譲カードは入力中の別のタスク id を使わず、結果と履歴から自分のタスクに結び付く';

export default async function(t) {
  const A = 'ply-task-11111111-1111-4111-8111-111111111111';
  const B = 'ply-task-22222222-2222-4222-8222-222222222222';
  const input = { kind: 'mechanical', title: 'Follow up', task: `Investigate cancelled task ${A}` };
  const routing = { mode: 'pinned', target: { backend: 'fake' } };
  const result = { text: JSON.stringify({ taskId: B, routing, context: A }) };
  const source = fs.readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = source.indexOf('function linkDelegateCard(');
  const link = vm.runInNewContext(source.slice(start, source.indexOf('\n}', start) + 2) + '\nlinkDelegateCard', {
    delegateResult, delegateTaskId, cardCtx: new WeakMap(), cardRouting: new WeakMap(),
    isDelegateTool: n => n.endsWith('ply_delegate'), retitleDelegate() {}, decorateFailedDelegate() {},
    decorateDelegateCard: card => { card.dataset.routed = '1'; },
    goButton: (_label, onclick) => { const b = el('button', 'tc-go'); b.onclick = onclick; return b; },
    openFromCard: card => card.dataset.taskId, watchValueWidth() {}, t: k => k,
  });
  const card = renderToolCall('mcp__ply_agents__ply_delegate', input);
  // The DOM stub does not implement :scope child selectors.
  const query = card.querySelector.bind(card);
  card.querySelector = sel => query(sel === ':scope > .tc-go' ? '.tc-go' : sel);
  // Include the request text even with the minimal DOM's innerHTML representation.
  card.querySelector('.tc-details-body').append(el('span', null, input.task));
  link(card, input);
  assert.equal(card.dataset.taskId, undefined);
  assert.equal(card.querySelector('.tc-go'), null);
  t.ok('結果前は入力のタスク id に結び付けず、矢印も出さない', true);

  applyToolResult(card, result);
  link(card, null, result);
  assert.equal(card.dataset.taskId, B);
  assert.equal(card.querySelector('.tc-go').onclick(), B);
  // A pre-existing arrow must not prevent checking the authoritative result again.
  card.dataset.taskId = A;
  card.append(el('div', 'rt-detail', 'old task'));
  link(card, null, result);
  assert.equal(card.dataset.taskId, B);
  assert.equal(card.querySelector('.rt-detail'), null);
  assert.equal(card.querySelectorAll('.tc-go').length, 1);
  t.ok('結果が届いたら自分の id を使い、古い結び付きと内訳を残さない', true);

  // Shared workspaces must never be attributed to one delegated child.
  const gitStart = source.indexOf('async function paintDelegateGit(');
  const gitCode = source.slice(gitStart, source.indexOf('\n}', gitStart) + 2) + '\npaintDelegateGit';
  let gitCalls = 0, rendered = 0;
  const gitTask = { taskId: B, sessionId: 'child' };
  const paintGit = vm.runInNewContext(gitCode, {
    taskById: () => gitTask,
    cmd: async () => { gitCalls++; return { git: {} }; },
    renderDelegateGit: () => { rendered++; return null; },
  });
  card.isConnected = true;
  card.append(el('div', 'git-delegate', 'stale'));
  await paintGit(card);
  assert.equal(gitCalls, 0);
  assert.equal(card.querySelector('.git-delegate'), null);
  gitTask.worktree = { path: '/isolated', branch: 'work' };
  await paintGit(card);
  assert.equal(gitCalls, 1);
  assert.equal(rendered, 1);
  t.ok('Only worktree children query and render changes; shared children remove stale changes', true);

  const history = renderToolCall('mcp__ply_agents__ply_delegate', input);
  applyToolResult(history, result);
  link(history, input, result);
  assert.equal(history.dataset.taskId, B);
  assert.equal(delegateTaskId(result.text), B);
  for (const value of [null, '', `Task ${A}`, { text: JSON.stringify({ context: A }) },
    { text: JSON.stringify({ taskId: 123 }) }, { text: '{bad json' }, { text: '[]' }]) {
    assert.equal(delegateTaskId(value), null);
  }
  t.ok('履歴も結果の id で結び付き、結果に taskId が無ければ推測しない', true);

  // 2000 文字を超える結果（振り分けの記録が長い。2026-10-23 の 87 件中 86 件）。taskId は 2000 文字より後ろ
  const tool = 'mcp__ply_agents__ply_delegate';
  const longText = JSON.stringify({ backend: 'fake', routing: { mode: 'auto', skipped: 'r'.repeat(2500) }, taskId: B, status: 'queued', task: input.task });
  assert.ok(longText.length > shared.MAX_RESULT_CHARS && longText.indexOf(B) > shared.MAX_RESULT_CHARS);
  const live = liveSnapshot({ events: [
    { type: 'text.delta', text: 'A' },
    { type: 'tool.start', id: 'd1', name: tool, input }, { type: 'tool.result', id: 'd1', text: longText, isError: false, truncated: false },
    { type: 'tool.start', id: 'b1', name: 'Read', input: {} }, { type: 'tool.result', id: 'b1', text: longText, isError: false, truncated: false },
    { type: 'text.end' }, { type: 'text.delta', text: 'B' },
  ].map((e, i) => ({ sessionId: 's', streamSeq: i + 1, ...e })) }, { backend: 'fake' });
  const [liveDelegate, liveRead] = live.messages[0]?.toolCalls ?? [];
  assert.equal(liveDelegate?.result.text, longText);
  assert.equal(delegateTaskId(liveDelegate.result), B);
  assert.equal(liveRead?.result.truncated, true);
  const transcript = transcriptToMessages([
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'd1', name: tool, input }, { type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 'd1', content: [{ type: 'text', text: longText }] }, { type: 'tool_result', tool_use_id: 'b1', content: longText }] } },
  ]);
  const [readDelegate, readBash] = transcript[0].toolCalls;
  assert.equal(readDelegate.result.text, longText);
  assert.equal(readDelegate.result.truncated, false);
  assert.equal(delegateTaskId(readDelegate.result), B);
  assert.equal(readBash.result.truncated, true);
  // 保存した会話の読み込み（core/conversations.mjs の getMessages）も同じ切り方を使う
  assert.equal(typeof shared.cutToolResult, 'function');
  const kept = { text: longText, isError: false };
  assert.equal(shared.cutToolResult(tool, kept, '…'), kept);
  assert.equal(shared.cutToolResult('codex.ply_delegate', kept, '…'), kept);
  const cutOther = shared.cutToolResult('Bash', kept, '…');
  assert.equal(cutOther.truncated, true);
  assert.ok(cutOther.text.length < longText.length);
  t.ok('履歴の経路（走っているターンの畳み・transcript・保存した会話）は ply_delegate の結果を切らず、ほかのツールは今までどおり切る', true);

  const fromHistory = renderToolCall(tool, input);
  applyToolResult(fromHistory, readDelegate.result);
  link(fromHistory, input, readDelegate.result);
  assert.equal(fromHistory.dataset.taskId, B);
  assert.ok(fromHistory.querySelector('.tc-go'));
  assert.equal(fromHistory.dataset.routed, '1');
  t.ok('2000 文字を超える結果でも、履歴から描いたカードに委譲の内訳と矢印が付く', true);

  // 前の版のサーバー・ほかのバックエンドで切られた結果（JSON として読めない）。taskId が先頭にあればキーの値から拾う
  const headFirst = JSON.stringify({ taskId: B, backend: 'fake', routing: { mode: 'auto', skipped: 'r'.repeat(2500) }, note: `see "taskId":"${A}"` });
  const cut = { text: shared.cutText(headFirst, shared.MAX_RESULT_CHARS, '\n…'), truncated: true };
  assert.equal(delegateResult(cut), null);
  assert.equal(delegateTaskId(cut), B);
  assert.equal(delegateTaskId({ text: cut.text }), null);
  const onlyInTask = { text: shared.cutText(JSON.stringify({ backend: 'fake', task: `"taskId":"${A}"`, routing: 'r'.repeat(2500), taskId: B }), shared.MAX_RESULT_CHARS, '\n…'), truncated: true };
  assert.equal(delegateTaskId(onlyInTask), null);
  t.ok('切られた結果は taskId のキーの値だけを拾い、依頼文の中の id は使わない', true);
}
