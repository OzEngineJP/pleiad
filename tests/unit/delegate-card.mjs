import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderToolCall, applyToolResult } from '../../web/render.mjs';
import { delegateResult, delegateTaskId } from '../../web/delegate-result.mjs';
import { el } from '../../web/dom.mjs';

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
}
