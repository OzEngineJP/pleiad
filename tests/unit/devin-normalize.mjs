import assert from 'node:assert/strict';
import { createDevinMapper } from '../../core/backends/devin-normalize.mjs';

export const name = 'devin-normalize';
export const title = 'Devin ACP replay と本文・思考・ツールを同じ正規化履歴へ写し、再読込で UUID を保つ';
const chunk = (role, text) => ({ sessionUpdate: `${role}_message_chunk`, content: { type: 'text', text } });
export default function (t) {
  const events = [], live = createDevinMapper('s', e => events.push(e));
  live.beginTurn('hello'); live.accept(chunk('user', 'hel')); live.accept(chunk('user', 'lo'));
  live.accept({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } });
  live.accept({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read file', rawInput: { path: 'test' }, status: 'running' });
  live.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'result' } }] });
  live.accept(chunk('agent', '日本語')); live.accept(chunk('agent', '🙂')); live.finish();
  const first = live.messages();
  assert.deepEqual(first.map(m => [m.role, m.text]), [['user', 'hello'], ['assistant', '日本語🙂']]);
  t.ok('入力の echo を重複させず、本文はチャンクを連結する', true);
  t.ok('思考とツールの入出力は既存 backend の履歴形式に合う', first[1].thinking === 'think' && first[1].toolCalls[0].input.path === 'test' && first[1].toolCalls[0].result.text === 'result');
  t.ok('本文・思考・ツールと本文の区切りを逐次流す', ['text.delta', 'thinking.start', 'thinking.delta', 'tool.start', 'tool.result', 'text.end'].every(type => events.some(e => e.type === type)));
  const replayEvents = [], replay = createDevinMapper('s', e => replayEvents.push(e));
  replay.accept(chunk('user', 'hello')); replay.accept({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } });
  replay.accept({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read file', rawInput: { path: 'test' } });
  replay.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'result' });
  replay.accept(chunk('agent', '日本語🙂'));
  assert.deepEqual(replay.messages(), first);
  t.ok('replay はライブの出来事を出さず同じ UUID・履歴を再現する', replayEvents.length === 0);
  replay.beginTurn('next'); replay.accept(chunk('agent', 'answer')); replay.finish();
  t.ok('続きで前の発言の UUID を変えない', first.every((m, i) => replay.messages()[i].uuid === m.uuid) && replay.messages().length === 4);
  const failed = createDevinMapper('f'); failed.accept(chunk('user', 'x'));
  failed.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'failed', status: 'failed', rawOutput: 'x'.repeat(5000) });
  t.ok('失敗ツールと長い結果を保持し、表示用の結果を制限する', failed.messages()[1].toolCalls[0].result.isError && failed.messages()[1].toolCalls[0].result.truncated);
  const snapshot = replay.messages(); snapshot[0].text = 'modified';
  t.ok('読み出した配列を書き換えても内部履歴は変わらない', replay.messages()[0].text === 'hello');
}
