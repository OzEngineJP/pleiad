// Devin の圧縮の区切りを transcript（sessions.db の message_nodes）から読む（core/backends/devin-compaction.mjs）。
// 区切りの無い会話では履歴の全行を読まないこと（compact() の実効の確認が 1 秒ごとに呼ぶ）も確かめる
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSqlite } from '../../core/db.mjs';
import { devinCompactionsFromDb, devinCompactionFromNotification, extractDevinSummary } from '../../core/backends/devin-compaction.mjs';

export const name = 'devin-compaction';
export const title = 'Devin の圧縮の区切りを sessions.db の継続ノードから、軽い読みで取る';
export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-devin-compact-'));
  const dbFile = path.join(dir, 'sessions.db');
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`create table sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, main_chain_id INTEGER);
             create table message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)`);
    const now = Math.floor(Date.now() / 1000);
    const add = (sid, nid, pid, role, content, meta = null) =>
      db.prepare('insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values (?,?,?,?,?,?)')
        .run(sid, nid, pid, JSON.stringify({ role, content }), now, meta);
    // 区切りの無い会話（発言だけ）
    let pid = null;
    for (let i = 0; i < 60; i++) { add('plain', i, pid, i % 2 ? 'assistant' : 'user', `message ${i}`); pid = i; }
    db.prepare('insert into sessions (id, working_directory, created_at, last_activity_at, main_chain_id) values (?,?,?,?,?)').run('plain', '', now, now, 59);

    // prepare → all で返した行数を数える DB の包み（全件を読んだかを測る）
    const counting = (file) => {
      const inner = new DatabaseSync(file, { readOnly: true });
      let rows = 0;
      const orig = inner.prepare.bind(inner);
      inner.prepare = (sql) => {
        const st = orig(sql);
        return { all: (...a) => { const r = st.all(...a); rows += r.length; return r; }, get: (...a) => st.get(...a), iterate: (...a) => st.iterate(...a) };
      };
      inner.counted = () => rows;
      return inner;
    };

    // 継続ノードが無ければ、履歴の行を 1 行も読まずに終わる（候補の絞り込みだけ）
    let probe;
    const open = (file) => (probe = counting(file));
    assert.deepEqual(devinCompactionsFromDb({ dataDir: dir, sessionId: 'plain', dbFile, open }), []);
    t.ok('区切りの無い会話は履歴を読まずに終わる', probe.counted() === 0, `rows=${probe.counted()}`);

    // 圧縮済みの会話: 発言 → 継続ノード（system + summarized_from）
    pid = null;
    for (let i = 0; i < 10; i++) { add('compact', i, pid, i % 2 ? 'assistant' : 'user', `msg ${i}`); pid = i; }
    const content = 'You are continuing work from a previous conversation thread.\nFull conversation history saved at fixture-history.md.\nSummary:\n<summary>past work</summary>';
    add('compact', 10, pid, 'system', content, JSON.stringify({ summarized_from: pid }));
    db.prepare('insert into sessions (id, working_directory, created_at, last_activity_at, main_chain_id) values (?,?,?,?,?)').run('compact', '', now, now, 10);
    let entries = devinCompactionsFromDb({ dataDir: dir, sessionId: 'compact', dbFile, open });
    t.ok('継続ノードを区切りとして読み、要約と位置（直前の発言の uuid）を持つ',
      entries.length === 1 && entries[0].nativeId === 'node-10' && entries[0].summary === 'past work'
      && entries[0].afterMessageId === 'compact:assistant:9' && !entries[0].beforeMessageId,
      JSON.stringify(entries));

    // あとから送ったリクエストの鎖に写った複製（compact/prior_node_ids 付き）は元のノードへ寄せる
    add('compact', 11, 10, 'system', content, JSON.stringify({ summarized_from: pid, extensions: { 'compact/prior_node_ids': [10] } }));
    db.prepare('update sessions set main_chain_id = 11 where id = ?').run('compact');
    entries = devinCompactionsFromDb({ dataDir: dir, sessionId: 'compact', dbFile });
    t.ok('複製の継続ノードは元のノードに寄せて 1 つだけにする', entries.length === 1 && entries[0].nativeId === 'node-10', JSON.stringify(entries));

    // 通知（_cognition.ai/compaction）→ 区切りの出来事
    assert.equal(devinCompactionFromNotification({ status: 'completed', summary: 'x <summary>S</summary>' }).summary, 'S');
    assert.equal(devinCompactionFromNotification({ status: 'started' }).status, 'started');
    assert.equal(devinCompactionFromNotification({ status: 'other' }), null);
    assert.equal(extractDevinSummary('no tag'), null);
    t.ok('通知の形を区切りの出来事に写す', true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
