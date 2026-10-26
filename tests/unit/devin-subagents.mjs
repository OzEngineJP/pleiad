import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSqlite } from '../../core/db.mjs';
import { getDevinSubagentMessages, getDevinSubagentOrigin, listDevinSubagents } from '../../core/backends/devin-subagents.mjs';

export const name = 'devin-subagents';
export const title = 'Devin の子エージェント一覧と履歴を親会話で分離する';

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-devin-subagents-'));
  const dbFile = path.join(dir, 'sessions.db');
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`create table sessions (id TEXT PRIMARY KEY, main_chain_id INTEGER);
             create table message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL);
             create table subagent_heads (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, chain_node_id INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    const now = Math.floor(Date.now() / 1000);
    const add = (sid, nid, pid, message) => db.prepare('insert into message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) values (?,?,?,?,?)').run(sid, nid, pid, JSON.stringify(message), now);
    add('parent', 0, null, { role: 'user', content: 'delegate this task' });
    add('parent', 1, 0, { role: 'assistant', content: '', tool_calls: [{ id: 'spawn-1', function: { name: 'run_subagent', arguments: '{"prompt":"inspect safely"}' } }] });
    add('parent', 2, 1, { role: 'tool', tool_call_id: 'spawn-1', content: 'agent_id=child-a' });
    db.prepare('insert into sessions (id, main_chain_id) values (?,?)').run('parent', 2);
    db.prepare('insert into subagent_heads (session_id,agent_id,chain_node_id,updated_at) values (?,?,?,?)').run('parent', 'child-a', 6, now);
    add('parent', 3, null, { role: 'user', content: 'inspect safely' });
    add('parent', 4, 3, { role: 'assistant', content: '', tool_calls: [{ id: 'child-tool', function: { name: 'read', arguments: '{"path":"src/a.mjs"}' } }] });
    add('parent', 5, 4, { role: 'tool', tool_call_id: 'child-tool', content: 'opened' });
    add('parent', 6, 5, { role: 'assistant', content: 'found one relevant file' });

    assert.deepEqual(listDevinSubagents({ dataDir: dir, sessionId: 'parent', dbFile }), ['child-a']);
    assert.deepEqual(listDevinSubagents({ dataDir: dir, sessionId: 'other-parent', dbFile }), []);
    const messages = getDevinSubagentMessages({ dataDir: dir, sessionId: 'parent', agentId: 'child-a', dbFile });
    assert.deepEqual(messages.map(m => [m.role, m.text]), [['user', 'inspect safely'], ['assistant', ''], ['assistant', 'found one relevant file']]);
    assert.deepEqual(messages[1].toolCalls, [{ id: 'child-tool', name: 'read', input: { path: 'src/a.mjs' }, result: 'opened' }]);
    assert.equal(getDevinSubagentMessages({ dataDir: dir, sessionId: 'other-parent', agentId: 'child-a', dbFile }).length, 0);
    assert.equal(getDevinSubagentOrigin({ dataDir: dir, sessionId: 'parent', agentId: 'child-a', dbFile }), 'spawn-1');
    t.ok('子の一覧・履歴・起動ツールは親の会話 ID で絞り、他の親には返さない', true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
