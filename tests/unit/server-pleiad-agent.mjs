import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startPleiadAgentFixture } from '../lib/pleiad-agent-fixture.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-pleiad-agent';
export const title = 'Pleiad Agent の道具・添付と送信待ち';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agent-'));
  const cwd = path.join(scratch, '日本語 の作業場所');
  const fixture = await startPleiadAgentFixture({ token: 'fixture-key-only' });
  const options = { dataDir: path.join(scratch, 'data'), env: {
    ...fixture.env, AGENT_HOST_KIND: 'cloud', AGENT_HOST_BACKENDS: 'fake,claude',
  } };
  let server, client;
  async function waitForCard(sessionId, kind, from) {
    return client.waitFor(e => e.type === 'permission' && e.sessionId === sessionId && e.kind === kind, { from });
  }
  async function restart() {
    client.close();
    await server.kill();
    server = await startServer(options);
    client = await open(server);
  }
  try {
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, '添付 ファイル.txt'), '道具の結果');
    server = await startServer(options);
    client = await open(server);
    const backends = await client.cmd('backends');
    t.ok('管理下ホストは実際の Pleiad Agent だけを公開する', backends.map(backend => backend.id).join() === 'pleiad-agent');
    const { sessionId } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
    const name = '送信する ファイル.txt';
    const file = await client.cmd('attachFile', { sessionId, name, mime: 'text/plain', data: Buffer.from('添付の内容').toString('base64') });
    const mark = client.mark();
    fixture.model.hold();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-read-001', prompt: '[fixture:read]' });
    await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'ply-agent-read-001', { from: mark });
    const queued = { sessionId, messageId: 'ply-agent-attach-001', prompt: '添付を見る\n[添付] ' + file.path,
      attachments: [{ path: file.path, name, mime: 'text/plain' }] };
    await client.cmd('sendMessage', queued);
    await client.cmd('sendMessage', queued);
    const waiting = await client.cmd('listMessages', { sessionId });
    t.ok('同じ送信 ID の添付は、実行中のターンの後ろに一つだけ並ぶ',
      waiting.filter(row => row.id === queued.messageId && row.status === 'queued').length === 1, JSON.stringify(waiting.map(({ id, status }) => ({ id, status }))));
    fixture.model.release();
    const delivered = await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === queued.messageId, { from: mark });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: client.events.indexOf(delivered) + 1 });
    const events = client.since(mark);
    const tool = events.find(e => e.type === 'tool.start' && e.name === 'read_file');
    t.ok('ファイル読み取りと結果が同じ道具の ID で表示される',
      Boolean(tool && events.some(e => e.type === 'tool.result' && e.id === tool.id && e.text.includes('道具の結果'))));
    t.ok('添付の本文とパスが会話に表示され、モデルにはパスが一度だけ届く',
      events.some(e => e.type === 'present' && e.path === file.path && e.content === '添付の内容') &&
      fixture.model.calls.filter(body => JSON.stringify(body.messages.at(-1)).includes('添付を見る')).length === 1);
    const history = await client.cmd('loadSession', { sessionId });
    const attached = history.presents.find(item => item.path === file.path);
    t.ok('再読み込みした会話に添付と読み取り結果が残る',
      Boolean(attached?.content === '添付の内容' &&
        history.messages.some(message => message.uuid === attached.messageId && message.role === 'user') &&
        history.messages.some(message => message.toolCalls?.some(call => call.id === tool?.id && call.result?.content === '道具の結果'))));
    t.ok('モデルの認証キーをリクエスト本文や会話に出さない',
      !JSON.stringify([fixture.model.calls, history, events]).includes('fixture-key-only'));

    const filePath = path.join(cwd, '結果 ファイル.txt');
    const exists = () => fs.stat(filePath).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    const writeArgs = { sessionId, messageId: 'ply-agent-write-001', prompt: '[fixture:write]', mode: 'default' };
    const writeMark = client.mark();
    await client.cmd('sendMessage', writeArgs);
    const approval = await waitForCard(sessionId, 'tool', writeMark);
    t.ok('道具を実行する前に書き込みの承認カードを表示する', approval.editableField === 'content' && !await exists());
    await restart();
    const restoredApproval = await waitForCard(sessionId, 'tool', 0);
    t.ok('再起動後も承認カードの ID と変更内容が一致する', restoredApproval.id === approval.id &&
      restoredApproval.input.content === 'proposed text' && !await exists());
    const approveMark = client.mark();
    await client.cmd('resolvePermission', { id: restoredApproval.id, allow: true, editedInput: '画面で編集した本文' });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: approveMark });
    t.ok('承認された編集内容を書き込む', await fs.readFile(filePath, 'utf8') === '画面で編集した本文');
    t.ok('書き込みの再開で利用者の発言は増えない',
      (await client.cmd('loadSession', { sessionId })).messages.filter(m => m.role === 'user' && m.text.includes('[fixture:write]')).length === 1);

    const surveyMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-survey-001', prompt: '[fixture:survey]' });
    const survey = await waitForCard(sessionId, 'question', surveyMark);
    await restart();
    const restoredSurvey = await waitForCard(sessionId, 'question', 0);
    t.ok('再起動後に同じ質問と選択肢が現れる', restoredSurvey.id === survey.id &&
      restoredSurvey.questions[0].options.map(item => item.label).join() === 'Blue,Red');
    const answerMark = client.mark();
    await client.cmd('resolvePermission', { id: restoredSurvey.id, allow: true, answers: { 'Color?': 'Blue' } });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: answerMark });
    t.ok('質問の回答が元の質問 ID でモデルに届く', fixture.model.calls.at(-1).messages.some(message =>
      message.role === 'tool' && message.content.includes('Blue') && message.content.includes('color')));

    const stopMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-stop-001', prompt: '[fixture:survey]' });
    const waitingQuestion = await waitForCard(sessionId, 'question', stopMark);
    await client.cmd('abort', { sessionId });
    const settled = await client.waitFor(e => e.type === 'permissionSettled' && e.id === waitingQuestion.id, { from: stopMark });
    t.ok('中断すると未回答の質問カードを閉じる', settled.allow === false);
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: stopMark });

    const mcpMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-mcp-001', prompt: '[fixture:mcp:mcp__ply_agents__ply_task_list]' });
    const mcpCard = await waitForCard(sessionId, 'tool', mcpMark);
    t.ok('会話に結び付けた Pleiad の道具にも承認が効く', mcpCard.toolName === 'mcp__ply_agents__ply_task_list');
    await client.cmd('resolvePermission', { id: mcpCard.id, allow: true });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mcpMark });
    t.ok('承認後にホストの道具が実行される', fixture.model.calls.at(-1).messages.some(message =>
      message.role === 'tool' && message.content.includes('ply_task_list ok')));
  } finally {
    client?.close();
    try { await server?.stop(); } finally {
      await fixture.close();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}
