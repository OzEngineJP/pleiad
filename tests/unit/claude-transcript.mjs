import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { createTranscriptReader } from '../../core/backends/claude-transcript.mjs';
import { parseSessionTranscript, mergeQueuedCommands, transcriptToMessages } from '../../core/backends/claude-normalize.mjs';
import { classifySystemMessages } from '../../core/system-messages.mjs';
import { backend } from '../../core/backends/claude.mjs';
import { createLoadTiming } from '../../core/load-timing.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { anchorSig } from '../../web/history-sync.mjs';

export const name = 'claude-transcript';
export const title = 'Claude 履歴: SDK と同じ出力・1 回の読みと解析・版の無効化・キャッシュの上限・outline と older';
const ID = '00000000-1111-4111-8111-000000000001';
const OTHER = '00000000-1111-4111-8111-000000000002';
const THIRD = '00000000-1111-4111-8111-000000000003';
const user = (uuid, parentUuid, content, extra = {}) => ({ type: 'user', uuid, parentUuid, timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content }, ...extra });
const assistant = (uuid, parentUuid, content, extra = {}) => ({ type: 'assistant', uuid, parentUuid, timestamp: '2026-10-01T00:00:01Z', message: { role: 'assistant', content }, ...extra });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-transcript-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const project = path.join(dir, 'projects', 'test');
  const file = path.join(project, `${ID}.jsonl`);
  let reads = 0, selects = 0;
  const io = { ...fs, readFile: async (...args) => { reads++; return fs.readFile(...args); } };
  const selectMessages = async (id, entries) => {
    selects++;
    return getSessionMessages(id, { sessionStore: { load: async () => entries, append: async () => { throw Error('read only'); } } });
  };
  const make = options => createTranscriptReader({ projects: () => path.join(dir, 'projects'), io, selectMessages, ...options });
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    await fs.mkdir(project, { recursive: true });
    const rows = [
      user('u1', null, 'question', { version: '2.1.288' }),
      assistant('a1', 'u1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }]),
      user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }]),
      { type: 'system', subtype: 'stop_hook_summary', uuid: 'stop', parentUuid: 'r1', hookErrors: ['continue'], preventedContinuation: false },
      assistant('follow', 'stop', [{ type: 'text', text: 'follow-up' }]),
      { type: 'attachment', uuid: 'queued', parentUuid: 'follow', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'steer' } },
      assistant('answer', 'queued', [{ type: 'text', text: 'answer' }]),
      { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'answer', timestamp: '2026-10-01T00:00:02Z', compactMetadata: { trigger: 'manual', preTokens: 100, postTokens: 20 } },
      { type: 'attachment', uuid: 'date', parentUuid: 'compact', attachment: { type: 'date' } },
      user('summary', 'date', 'summary body', { isCompactSummary: true }),
      user('command', 'summary', '<command-name>/help</command-name>'),
      user('output', 'command', '<local-command-stdout>help</local-command-stdout>'),
      assistant('last', 'output', [{ type: 'text', text: 'done' }]),
      assistant('side', 'u1', [{ type: 'text', text: 'side' }], { isSidechain: true }),
    ];
    const text = jsonl(rows) + '{"type":"assistant"'; // 書きかけの末尾
    await fs.writeFile(file, text);
    const read = make();
    const [snapshot, concurrent] = await Promise.all([read(ID), read(ID)]);
    assert.deepEqual(snapshot.entries, await getSessionMessages(ID));
    t.ok('SDK のファイル経路と解析済み行の経路が同じ履歴を返す（枝・途中送信・圧縮・書きかけ）', true);
    t.ok('並行した読み込みも、ファイル読み・SDK の選別が 1 回', snapshot === concurrent && reads === 1 && selects === 1);
    await read(ID);
    t.ok('同じ版は読み直しも選別も無い', reads === 1 && selects === 1);
    assert.deepEqual([...snapshot.followUps], ['follow']);
    assert.deepEqual([...snapshot.marks.summaries], [['summary', 'compact']]);
    assert.deepEqual([...snapshot.marks.outputs], [['output', 'command']]);
    assert.deepEqual(snapshot.marks.compactions, [{ id: 'native:compact', nativeId: 'compact', phase: 'complete', trigger: 'manual', at: Date.parse('2026-10-01T00:00:02Z'), beforeTokens: 100, afterTokens: 20, summary: 'summary body' }]);
    t.ok('Stop フックの続き・要約・出力・圧縮の印を保つ', true);
    const expected = classifySystemMessages(transcriptToMessages(mergeQueuedCommands(snapshot.entries, snapshot.rows), { followUps: snapshot.followUps }), snapshot.marks);
    assert.deepEqual(await backend.getMessages(ID), expected);
    const marked = await backend.getCompactions(ID);
    marked[0].summary = 'changed';
    assert.equal((await backend.getCompactions(ID))[0].summary, 'summary body');
    t.ok('バックエンドは同じ出力を返し、返した圧縮を変更してもキャッシュに残らない', true);
    const tool = (await backend.getMessages(ID)).flatMap(m => m.toolCalls ?? [])[0];
    tool.input.file_path = 'mutated';
    assert.equal((await backend.getMessages(ID)).flatMap(m => m.toolCalls ?? [])[0].input.file_path, 'a.txt');
    t.ok('返したツール入力の変更を次の読み込みへ持ち越さない', true);
    const withoutSdk = make({ selectMessages: async () => { throw Error('SDK missing'); } });
    t.ok('SDK を読めなくても transcript の圧縮の印は返す', (await withoutSdk(ID)).marks.compactions.length === 1);
    const largeFile = path.join(project, `${OTHER}.jsonl`);
    const large = jsonl([
      user('kept-user', null, 'keep'),
      assistant('kept-answer', 'kept-user', [{ type: 'text', text: 'kept answer' }]),
      { type: 'progress', uuid: 'padding', data: 'x'.repeat(6 * 1024 * 1024) },
      { type: 'system', subtype: 'compact_boundary', uuid: 'large-compact', parentUuid: null,
        compactMetadata: { preservedMessages: { anchorUuid: 'large-compact', uuids: ['kept-user', 'kept-answer'] } } },
      user('large-summary', 'large-compact', 'large summary', { isCompactSummary: true }),
      assistant('large-last', 'large-summary', [{ type: 'text', text: 'after compaction' }]),
    ]);
    await fs.writeFile(largeFile, large);
    assert.deepEqual(await selectMessages(OTHER, parseSessionTranscript(large).entries), await getSessionMessages(OTHER));
    t.ok('SDK が圧縮前を読み飛ばす大きさでも、保存した発言を含めて同じ履歴になる', true);
    await fs.unlink(largeFile);

    await fs.writeFile(file, jsonl(rows));
    const complete = await read(ID);
    await fs.appendFile(file, jsonl([user('new', 'last', 'appended')]));
    const appended = await read(ID);
    t.ok('追記・縮小は新しい版を解析する', complete !== snapshot && appended !== complete && appended.entries.some(row => row.uuid === 'new'));
    const stat = await fs.stat(file);
    const replaced = (await fs.readFile(file, 'utf8')).replace('appended', 'replaced');
    await fs.writeFile(file, replaced);
    await fs.utimes(file, stat.atime, stat.mtime);
    const replacement = await read(ID);
    t.ok('同じ長さ・mtime を戻した置換も ctime で無効化', replacement !== appended && JSON.stringify(replacement.entries).includes('replaced'));
    await fs.unlink(file);
    t.ok('削除したファイルを古いキャッシュから返さない', await read(ID) === null);
    await fs.writeFile(file, jsonl([user('reborn', null, 'new file')]));
    t.ok('消えたファイルが戻れば読み直す', (await read(ID)).entries[0]?.uuid === 'reborn');
    let root = path.join(dir, 'projects');
    const relocated = make({ projects: () => root });
    await relocated(ID);
    root = path.join(dir, 'other-projects');
    await fs.mkdir(path.join(root, 'other'), { recursive: true });
    await fs.writeFile(path.join(root, 'other', `${ID}.jsonl`), jsonl([user('different', null, 'another config')]));
    t.ok('設定の置き場が変われば同じ id の別ファイルを読む', (await relocated(ID)).entries[0]?.uuid === 'different');
    t.ok('無い id と外へ出る id は空', await read(OTHER) === null && await read('../escape') === null);
    await fs.writeFile(path.join(project, `${OTHER}.jsonl`), jsonl([user('other', null, 'other')]));
    await fs.writeFile(path.join(project, `${THIRD}.jsonl`), jsonl([user('third', null, 'third')]));
    const limited = make({ maxEntries: 2 });
    await limited(ID); await limited(OTHER); await limited(ID); await limited(THIRD);
    let before = reads; await limited(OTHER);
    t.ok('件数上限では最後に使った順に残す', reads === before + 1);
    const size = (await fs.stat(file)).size;
    const budget = make({ maxBytes: size });
    await budget(ID); await budget(OTHER); before = reads; await budget(ID);
    t.ok('合計バイト上限でも古いファイルを捨てる', reads === before + 1);
    const oversize = make({ maxBytes: 1 });
    before = reads; await oversize(ID); await oversize(ID);
    t.ok('上限を超える 1 ファイルは保持しない', reads === before + 2);
    let fail = true;
    const flaky = make({ io: { ...io, readFile: (...args) => { if (fail) { fail = false; throw Error('unreadable'); } return io.readFile(...args); } } });
    t.ok('読み込みの失敗をキャッシュせず、次の要求で回復する', await flaky(ID) === null && (await flaky(ID)).entries[0]?.uuid === 'reborn');
    const changing = make({ io: { ...io, readFile: async (...args) => { const value = await io.readFile(...args); await fs.appendFile(file, '\n'); return value; } } });
    before = reads; await changing(ID); await changing(ID);
    t.ok('読んでいる間に変わった版は保持しない', reads === before + 2);

    const bad = parseSessionTranscript(jsonl([{ type: 'attachment', uuid: 'bad', attachment: { type: 'queued_command', prompt: 5 } }]) + '{"type":"attachment","queued_command":');
    t.ok('壊れた途中送信の形を検出する', bad.invalidQueued);
    let now = 0; const lines = [];
    const clock = () => createLoadTiming({ now: () => now, log: line => lines.push(line) });
    let timing = clock(); now = 199; timing.finish('open');
    t.ok('200 ms 未満はログを出さない', lines.length === 0);
    timing = clock(); await timing.run('transcript', async () => { now += 150; });
    timing.add('transcript.read', 70); now += 50; timing.finish('older');
    const logged = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
    t.ok('遅い要求のログは 1 行で、段階と所要時間・モードを持つ', lines.length === 1 && logged.totalMs === 200 && logged.transcript === 150 && logged['transcript.read'] === 70 && logged.mode === 'older');

    // 実際の loadSession の入口から open / outline / older を照合する。
    const long = [user('start', null, 'start')];
    for (let i = 0; i < 80; i++) long.push(user(`user-${i}`, long.at(-1).uuid, `question ${i}`), assistant(`answer-${i}`, `user-${i}`, [{ type: 'text', text: `answer ${i}` }]));
    await fs.writeFile(file, jsonl(long));
    let server, client;
    try {
      server = await startServer({ dataDir: path.join(dir, 'data'), env: { AGENT_HOST_BACKENDS: 'claude', CLAUDE_CONFIG_DIR: dir } });
      client = await open(server);
      const full = await client.cmd('loadSession', { sessionId: ID });
      const outline = await client.cmd('loadSession', { sessionId: ID, outline: true });
      const tail = await client.cmd('loadSession', { sessionId: ID, tail: 20, lazy: true });
      const older = await client.cmd('loadSession', { sessionId: ID, older: { before: tail.base, count: 2000, check: anchorSig(tail.messages[0]), presentBefore: tail.presentBase }, lazy: true });
      assert.deepEqual(outline.messages.map(m => m.text), full.messages.map(m => m.text));
      assert.deepEqual([...older.messages, ...tail.messages], full.messages);
      t.ok('outline と older も同じ履歴を返す', full.messages.length === 161);
    } finally { client?.close(); await server?.stop(); }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}
