import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { createTranscriptReader, feedBufferLines } from '../../core/backends/claude-transcript.mjs';
import { parseSessionTranscript, mergeQueuedCommands, transcriptToMessages, createSubagentParser, invalidSubagentTranscript } from '../../core/backends/claude-normalize.mjs';
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

    // --- 追記読み（ADR 0330）: 末尾の窓を照合して増えた分だけを読み、結果は全部読み直しと同じ ---
    const APP = '00000000-1111-4111-8111-00000000000a';
    const appFile = path.join(project, `${APP}.jsonl`);
    let opens = 0;
    const io2 = { ...io, open: async (...args) => { opens++; return fs.open(...args); } };
    const growing = createTranscriptReader({ projects: () => path.join(dir, 'projects'), io: io2, selectMessages });
    const grownRows = [
      user('g1', null, 'first', { version: '2.1.288' }),
      assistant('g2', 'g1', [{ type: 'text', text: 'answer' }]),
    ];
    const fragment = '{"type":"user","uuid":"g3","parentUuid":"g2","timestamp":"2026-10-01T00:00:02Z","message":{"role":"user","content":"ste';
    await fs.writeFile(appFile, jsonl(grownRows) + fragment);
    const seed = await growing(APP);
    t.ok('書きかけの末尾のある版も最初は全部読む', seed.entries.length === 2);
    const sameAs = async (snapshot, label) => {
      const fresh = parseSessionTranscript(await fs.readFile(appFile, 'utf8'));
      assert.deepEqual(snapshot.rows, fresh.rows);
      assert.deepEqual([...snapshot.followUps], [...fresh.followUps]);
      assert.deepEqual(snapshot.marks, fresh.marks);
      assert.equal(snapshot.version, fresh.version);
      assert.equal(snapshot.invalidQueued, fresh.invalidQueued);
      assert.deepEqual(snapshot.entries, await getSessionMessages(APP));
      t.ok(label, true);
    };
    let readsBefore = reads;
    await fs.appendFile(appFile, 'er"}}\n' + jsonl([assistant('g4', 'g3', [{ type: 'text', text: 'steered' }])]));
    await sameAs(await growing(APP), '書きかけの行が完結しても全部読み直しと同じ結果');
    t.ok('追記は readFile せず窓の照合と差分だけ読む', reads === readsBefore && opens === 1);
    await fs.appendFile(appFile, jsonl([
      { type: 'attachment', uuid: 'gq', parentUuid: 'g4', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued' } },
      assistant('g5', 'gq', [{ type: 'text', text: 'after queued' }]),
    ]));
    await sameAs(await growing(APP), '追記で増えた途中送信の行も全部読み直しと同じ結果');
    // 書きかけが queued_command の途中の版 → 完結しても invalidQueued が全部読み直しと同じ
    await fs.appendFile(appFile, '{"type":"attachment","queued_command":');
    t.ok('書きかけの途中送信の形も全部読み直しと同じ', (await growing(APP)).invalidQueued === parseSessionTranscript(await fs.readFile(appFile, 'utf8')).invalidQueued);
    await fs.appendFile(appFile, 'bad"}\n');
    t.ok('書きかけのまま壊れて完結した行も全部読み直しと同じ', (await growing(APP)).invalidQueued === parseSessionTranscript(await fs.readFile(appFile, 'utf8')).invalidQueued);
    // 縮んだ版は差分にせず全部読み直す
    await fs.writeFile(appFile, jsonl(grownRows));
    const shrunk = await growing(APP);
    t.ok('縮んだ版は全部読み直す', shrunk.entries.length === 2 && shrunk.entries.every(e => e.uuid !== 'g3'));
    // 大きくなっても中身が違う（書き換え）版は、先頭・末尾の窓で見抜いて全部読み直す
    const rewrittenRows = [user('h1', null, 'rewritten', { version: '2.1.288' }), ...Array.from({ length: 30 }, (_, i) => assistant(`h${i + 2}`, i ? `h${i + 1}` : 'h1', [{ type: 'text', text: 'x'.repeat(200) }]))];
    await fs.writeFile(appFile, jsonl(rewrittenRows));
    const rewritten = await growing(APP);
    t.ok('大きくなったが中身の違う版は全部読み直す', rewritten.entries.every(e => e.uuid.startsWith('h')));
    t.ok('直後の同じ版はキャッシュから返す', await growing(APP) === rewritten);

    // サブエージェントの transcript も同じ窓照合で差分読みする（ADR 0330）
    const SUB = '00000000-1111-4111-8111-00000000000b';
    const agentId = 'abcdef';
    const subDir = path.join(project, SUB, 'subagents');
    await fs.mkdir(subDir, { recursive: true });
    const subFile = path.join(subDir, `agent-${agentId}.jsonl`);
    await fs.writeFile(subFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ toolUseId: 'toolu_parent' }));
    await fs.writeFile(subFile, jsonl([
      user('s1', null, 'task', { sessionId: SUB }),
      assistant('s2', 's1', [{ type: 'text', text: 'working' }], { sessionId: SUB }),
    ]));
    const firstSub = await backend.getSubagentMessages(SUB, agentId, {});
    await fs.appendFile(subFile, jsonl([assistant('s3', 's2', [{ type: 'text', text: 'done' }], { sessionId: SUB })]));
    const secondSub = await backend.getSubagentMessages(SUB, agentId, {});
    t.ok('サブエージェントの追記も差分で読み全部読み直しと同じ', secondSub.length === firstSub.length + 1 && secondSub.at(-1).text === 'done');
    await fs.writeFile(subFile, jsonl([user('t1', null, 'replaced', { sessionId: SUB })]));
    const replacedSub = await backend.getSubagentMessages(SUB, agentId, {});
    t.ok('サブエージェントの縮んだ版も全部読み直す', replacedSub.length === 1 && replacedSub[0].text === 'replaced');

    // 大きい行は蒸留して持ち、返す分だけ行のバイト位置から読み直す（ADR 0330）。
    // 同じ版を 2 回読み、追記をはさんで 3 回目を読む。毎回全部読み直しと同じ結果になること
    const BIG = '00000000-1111-4111-8111-00000000000c';
    const bigFile = path.join(project, `${BIG}.jsonl`);
    const toolResultArr = { type: 'user', uuid: 'b8', parentUuid: 'b7', timestamp: '2026-10-01T00:00:00Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu9', content: [{ type: 'text', text: 'r'.repeat(2500) }] },
        { type: 'tool_result', tool_use_id: 'tu8', is_error: true,
          content: [{ type: 'text', text: '[Request interrupted by user] ' + 'i'.repeat(2000) }] } ] } };
    await fs.writeFile(bigFile, jsonl([
      user('b1', null, 'big start', { version: '2.1.288' }),
      assistant('ba', 'b1', [{ type: 'text', text: 'before compact' }]),
      { type: 'system', subtype: 'compact_boundary', uuid: 'bc', parentUuid: 'ba', timestamp: '2026-10-01T00:00:01Z', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 100 } },
      user('bs', 'bc', 'summary ' + 's'.repeat(1800), { isCompactSummary: true }),
      user('b2', 'bs', 'x'.repeat(3000)),
      user('b3', 'b2', '[Request interrupted by user]' + 'y'.repeat(2000)),
      assistant('b5', 'b3', [{ type: 'text', text: 'after big' }]),
      // 同じ message.id に分かれた大きい assistant の行
      assistant('b6', 'b5', [], { message: { role: 'assistant', id: 'msg_dup', model: 'claude', content: [{ type: 'text', text: 'a'.repeat(1500) }] } }),
      assistant('b7', 'b6', [], { message: { role: 'assistant', id: 'msg_dup', model: 'claude', content: [{ type: 'text', text: 'a'.repeat(1500) }, { type: 'tool_use', id: 'tu8', name: 'Read', input: { file_path: '/x/' + 'f'.repeat(2100) } }] } }),
      toolResultArr,
      { type: 'attachment', uuid: 'bq', parentUuid: 'b8', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued ' + 'q'.repeat(1600) } },
      assistant('b9', 'bq', [{ type: 'text', text: 'after queued ' + 't'.repeat(1500) }]),
    ]));
    const bigRead = make();
    const sameBig = async (snapshot) => {
      const fresh = parseSessionTranscript(await fs.readFile(bigFile, 'utf8'));
      assert.deepEqual(snapshot.rows, fresh.rows);
      assert.deepEqual([...snapshot.followUps], [...fresh.followUps]);
      assert.deepEqual(snapshot.marks, fresh.marks);
      assert.equal(snapshot.version, fresh.version);
      assert.equal(snapshot.invalidQueued, fresh.invalidQueued);
      assert.deepEqual(snapshot.entries, await getSessionMessages(BIG));
    };
    const bigSnap = await bigRead(BIG);
    await sameBig(bigSnap);
    const bigEntry = bigSnap.entries.find(e => e.uuid === 'b2');
    t.ok('蒸留した行の履歴は行から読み直して全部読み直しと同じ', bigEntry?.message?.content === 'x'.repeat(3000));
    t.ok('同じ版の再読は読み直した行の値を返す', (await bigRead(BIG)) === bigSnap);
    readsBefore = reads;
    await fs.appendFile(bigFile, jsonl([assistant('b10', 'b9', [{ type: 'text', text: 'p'.repeat(3000) }])]));
    const bigSnap2 = await bigRead(BIG);
    await sameBig(bigSnap2);
    const bigEntry10 = bigSnap2.entries.find(e => e.uuid === 'b10');
    t.ok('追記の大きい行も行から読み直して全部読み直しと同じ', reads === readsBefore && bigEntry10?.message?.content?.[0]?.text === 'p'.repeat(3000));
    const entriesBefore = JSON.stringify(bigSnap2.entries);
    transcriptToMessages(mergeQueuedCommands(bigSnap2.entries, bigSnap2.rows), { followUps: bigSnap2.followUps });
    t.ok('下流の変換は読み込みの行を書き換えない', JSON.stringify(bigSnap2.entries) === entriesBefore);

    // 安全網: SDK が行や message を組み直して蒸留形が返り値に残る版は、蒸留なしで読み直す（保持しない）
    const rebuild = (e) => ({ ...e, message: e.message && typeof e.message === 'object'
      ? { ...e.message, content: Array.isArray(e.message.content) ? e.message.content.map(b => ({ ...b })) : e.message.content }
      : e.message });
    let rebuilds = 0, leaks = 0;
    const rebuilding = createTranscriptReader({
      projects: () => path.join(dir, 'projects'), io,
      selectMessages: async (id, entries) => {
        rebuilds++;
        return entries.filter(e => e?.type === 'user' || e?.type === 'assistant').map(rebuild);
      },
      onSlimLeak: async () => { leaks++; },
    });
    const leaked = await rebuilding(BIG);
    const whole = parseSessionTranscript(await fs.readFile(bigFile, 'utf8'));
    assert.deepEqual(leaked.entries, whole.entries.filter(e => e?.type === 'user' || e?.type === 'assistant').map(rebuild));
    const leakedEntry = leaked.entries.find(e => e.uuid === 'b2');
    t.ok('蒸留形が残る版は蒸留なしで読み直して同じ結果（1 回記録）',
      leakedEntry?.message?.content === 'x'.repeat(3000) && rebuilds === 2 && leaks === 1);
    await rebuilding(BIG);
    t.ok('漏れた版は保持せず次も安全網が働く', rebuilds === 4 && leaks === 2);

    // 保持の上限は「保持するメモリ」: 蒸留した行で数えるので、本文が大きくても差分読みの記録を保てる
    const FAT = '00000000-1111-4111-8111-00000000000d';
    const fatFile = path.join(project, `${FAT}.jsonl`);
    await fs.writeFile(fatFile, jsonl([
      user('f1', null, 'fat', { version: '2.1.288' }),
      { type: 'progress', uuid: 'f2', parentUuid: 'f1', timestamp: '2026-10-01T00:00:00Z', data: { blob: 'q'.repeat(12 * 1024) } },
      assistant('f3', 'f2', [{ type: 'text', text: 'end' }]),
    ]));
    const fatSize = (await fs.stat(fatFile)).size;
    // 見積もり（行ごとに min(バイト長, 8 KiB)＋読み直した行）はファイルの大きさより小さい → 大きさでは捨てない
    const fatReader = make({ maxBytes: fatSize - 2048 });
    const fat1 = await fatReader(FAT);
    t.ok('保持量の上限で数えるので、本文の大きい版も差分読みの記録を保つ', (await fatReader(FAT)) === fat1);

    // サブエージェントの大きい行も同じく読み直して返す
    await fs.appendFile(subFile, jsonl([assistant('s4', 's3', [{ type: 'text', text: 'w'.repeat(2500) }], { sessionId: SUB })]));
    const bigSub = await backend.getSubagentMessages(SUB, agentId, {});
    t.ok('サブエージェントの大きい行も行から読み直す', bigSub.at(-1).text === 'w'.repeat(2500));

    // --- 初回の全部読みを区切ってイベントループへ返す（ADR 0333）---
    // sliceMs: 0 は 1 行ごとに区切る。区切った結果は一気に読んだときと同じ
    const SLICED = '00000000-1111-4111-8111-00000000000e';
    const slicedFile = path.join(project, `${SLICED}.jsonl`);
    await fs.writeFile(slicedFile, jsonl(Array.from({ length: 300 }, (_, i) =>
      user(`v${i}`, i ? `v${i - 1}` : null, 'x'.repeat(4000), i === 0 ? { version: '2.1.288' } : {}))));
    const slicedSnap = await make({ sliceMs: 0 })(SLICED);
    const slicedFresh = parseSessionTranscript(await fs.readFile(slicedFile, 'utf8'));
    assert.deepEqual(slicedSnap.rows, slicedFresh.rows);
    assert.deepEqual(slicedSnap.marks, slicedFresh.marks);
    assert.deepEqual(slicedSnap.entries, await getSessionMessages(SLICED));
    t.ok('区切った全部読みは一気に読んだときと同じ結果', true);

    // 区切りのあいだに追記された版は保持せず、次の要求で読み直す。
    // readFile が返った直後に追記を始め、SDK の選別の中で追記の終わりを待つ（確実に「読み中の追記」にする）
    let appending = null;
    const midWrite = createTranscriptReader({
      projects: () => path.join(dir, 'projects'), sliceMs: 0,
      selectMessages: async (id, entries) => { await appending; return selectMessages(id, entries); },
      io: { ...io, readFile: async (...args) => {
        const buf = await io.readFile(...args);
        appending ??= fs.appendFile(slicedFile, jsonl([user('v-mid', 'v299', 'appended during parse')]));
        return buf;
      } },
    });
    const duringSnap = await midWrite(SLICED);
    await appending;
    const midReads = reads;
    const afterWrite = await midWrite(SLICED);
    t.ok('読み中に追記された版は読んだ時点の履歴を返す', !duringSnap.entries.some(e => e.uuid === 'v-mid'));
    t.ok('区切りのあいだに追記された版は保持せず読み直す', reads === midReads + 1 && afterWrite.entries.some(e => e.uuid === 'v-mid'));

    // 偽の大きいデータで、区切った全部読みがイベントループを閾値以上に止めないこと。
    // 区切らない同じ読みは ~180 ms 止まる（87 MB・10,000 行）ので 100 ms が境目になる
    const LOOP = '00000000-1111-4111-8111-00000000000f';
    await fs.writeFile(path.join(project, `${LOOP}.jsonl`), jsonl(Array.from({ length: 10000 }, (_, i) =>
      user(`e${i}`, i ? `e${i - 1}` : null, 'z'.repeat(9000), i === 0 ? { version: '2.1.288' } : {}))));
    const loopDelay = monitorEventLoopDelay();
    loopDelay.enable();
    await make({ selectMessages: async () => [] })(LOOP);
    loopDelay.disable();
    t.ok(`区切った全部読みはイベントループを 100 ms 以上止めない（実測 ${Math.round(loopDelay.max / 1e6)} ms）`, loopDelay.max < 100 * 1e6);

    // 子の transcript の版と形の検査は解釈器の feed に畳み込んだ（invalidSubagentTranscript と同じ判定。ADR 0333）
    const shape = async (text) => { const p = createSubagentParser(); await feedBufferLines(p, Buffer.from(text)); return p; };
    const goodSub = jsonl([user('u', null, 'ok', { sessionId: 's', version: '2.1.288' }), assistant('a', 'u', [{ type: 'text', text: 'hi' }], { sessionId: 's' })]);
    for (const text of [
      goodSub,
      goodSub + '{"bad mid"}\n',          // 途中の読めない行は違反
      goodSub + '{"bad tail"',            // 書きかけの末尾だけは違反に数えない
      jsonl([{ type: 'user', uuid: 'u', message: null }]),
      jsonl([{ type: 'system', data: 'x "message" y' }]),   // 発言 0 件で "message" が残る
      '',
    ]) {
      const p = await shape(text);
      assert.equal(p.invalid, invalidSubagentTranscript(text), JSON.stringify(text).slice(0, 60));
    }
    t.ok('畳み込んだ形の検査は本文を見る検査と同じ判定', true);
    t.ok('畳み込んだ版の検出は先頭 20 行の最初の version を返す', (await shape(goodSub)).version === '2.1.288');

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
