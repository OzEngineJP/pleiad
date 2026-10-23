// 走っているターンを開くときの形（ADR 0255）。出来事のうち、もう変わらない頭を履歴と同じ形の発言に畳み（web/stream-messages.mjs の splitLive・
// core/live-snapshot.mjs）、まだ動いている末尾だけを再生する出来事として返す。サーバー越しには、長いターンの途中で開いても末尾の窓だけが運ばれ、
// 走っている間の手前の読み込みも同じ並びでつながり、ターンが終わると保存済みの履歴に戻ることを見る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { splitLive, streamMessages } from '../../web/stream-messages.mjs';
import { liveSnapshot } from '../../core/live-snapshot.mjs';
import { MAX_RESULT_CHARS } from '../../core/backends/shared.mjs';
import { joinOlder, WINDOW_MESSAGES, WINDOW_BYTES, anchorSig } from '../../web/history-sync.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'live-snapshot';
export const title = '走っているターンを開く: もう変わらない頭を発言に畳み、末尾の窓だけを運び、動いている末尾だけを再生する';

const seq = (events) => events.map((e, i) => ({ sessionId: 's', streamSeq: i + 1, ...e }));
const json = (x) => JSON.stringify(x);
/** 並びの比べ方（時刻は畳む位置で持ち越しが変わるので見ない） */
const shape = (messages) => messages.map(m => [m.role, m.text ?? '', m.thinking ?? '', (m.toolCalls ?? []).map(c => [c.id, c.result?.text ?? null]), m.uuid ?? null, m.kind ?? null]);

export default async function (t) {
  // ---- 分け方
  t.ok('出来事が無ければ何も畳まない', json(splitLive([])) === json({ messages: [], presents: [], events: [], folded: 0 }));
  const one = seq([{ type: 'text.delta', text: 'A' }, { type: 'tool.start', id: 'c1', name: 'Bash', input: {} }]);
  t.ok('分けられる所が無ければ全部を出来事のまま返す（今までと同じ）', (() => { const s = splitLive(one); return s.folded === 0 && s.events === one && !s.messages.length; })());

  const base = seq([
    { type: 'activity', state: 'writing' },
    { type: 'text.delta', text: '調べ' }, { type: 'text.delta', text: 'ます' },
    { type: 'tool.start', id: 'c1', name: 'Bash', input: { command: 'ls' }, at: 1_790_000_000_000 },
    { type: 'tool.result', id: 'c1', text: 'a.txt', isError: false, truncated: false },
    { type: 'text.end', uuid: 'u1' },
    { type: 'activity', state: 'thinking' },
    { type: 'contextWindow', usedTokens: 10, windowTokens: 100 },
    { type: 'text.delta', text: '次' },
    { type: 'tool.start', id: 'c2', name: 'Read', input: {} },
  ]);
  const s1 = splitLive(base, { backend: 'fake' });
  t.ok('閉じた発言の後に本文が始まる所で分ける', s1.folded === 8 && s1.messages.length === 1 && s1.messages[0].text === '調べます'
    && s1.messages[0].uuid === 'u1' && s1.messages[0].toolCalls[0].result?.text === 'a.txt', json(s1));
  t.ok('畳んだ発言の時刻は手前の出来事の時刻', s1.messages[0].at === undefined || typeof s1.messages[0].at === 'string');
  t.ok('頭にあった稼働表示・文脈の量は最後の 1 件だけを、流れの順で末尾の前に付ける',
    json(s1.events.map(e => e.type)) === json(['activity', 'contextWindow', 'text.delta', 'tool.start']) && s1.events[0].state === 'thinking', json(s1.events));

  const running = seq([
    { type: 'text.delta', text: 'A' }, { type: 'text.end' },
    { type: 'tool.start', id: 'long', name: 'Bash', input: {} },
    { type: 'text.delta', text: 'B' }, { type: 'text.end' },
    { type: 'text.delta', text: 'C' },
  ]);
  t.ok('結果の無いツールより後では分けない（走っているカードは再生で描く）',
    (() => { const s = splitLive(running); return s.folded === 0; })());
  const runningLater = seq([
    { type: 'text.delta', text: 'A' }, { type: 'text.end' },
    { type: 'text.delta', text: 'B' },
    { type: 'tool.start', id: 'long', name: 'Bash', input: {} },
    { type: 'text.end' }, { type: 'text.delta', text: 'C' },
  ]);
  // Claude は確定した発言ごとに text.end を先に出し、その後にツールを出す（claude-normalize）。ターンの最初がツールだけの発言なら、
  // 入れ物の無いまま閉じた後にツールが入れ物を作る。onEvent の ensureTurnEl は閉じた印を残すので、続く本文は別の発言になる
  const claudeOrder = seq([
    { type: 'text.end', uuid: 'u0' },
    { type: 'tool.start', id: 'c0', name: 'Bash', input: {} }, { type: 'tool.result', id: 'c0', text: '1' },
    { type: 'text.delta', text: 'step 1' }, { type: 'text.end', uuid: 'u1' },
    { type: 'text.end', uuid: 'u2' },
    { type: 'tool.start', id: 'c1', name: 'Bash', input: {} }, { type: 'tool.result', id: 'c1', text: 'step 1' },
    { type: 'text.delta', text: 'step 2' }, { type: 'text.end', uuid: 'u3' },
  ]);
  t.ok('最初のツールだけの発言に続く本文は、ツールと同じ発言に入れない（onEvent と同じ）',
    json(shape(streamMessages(claudeOrder).messages)) === json(shape([
      { role: 'assistant', text: '', toolCalls: [{ id: 'c0', result: { text: '1' } }], uuid: 'u0' },
      { role: 'assistant', text: 'step 1', uuid: 'u1' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', result: { text: 'step 1' } }], uuid: 'u2' },
      { role: 'assistant', text: 'step 2', uuid: 'u3' },
    ])), json(shape(streamMessages(claudeOrder).messages)));
  t.ok('走っているツールの手前の、新しい発言が始まる所までは畳む', (() => { const s = splitLive(runningLater); return s.folded === 2 && json(shape(s.messages)) === json(shape([{ role: 'assistant', text: 'A' }])); })());

  const pending = seq([
    { type: 'text.delta', text: 'A' }, { type: 'text.end' },
    { type: 'userMessage', messageId: 'm1', text: '追加', pending: true },
    { type: 'text.delta', text: 'B' }, { type: 'text.end' },
    { type: 'text.delta', text: 'C' },
  ]);
  t.ok('渡っていない人の発言より後では分けない（配達の合図は再生で受ける）', splitLive(pending).folded === 2);
  const early = seq([
    { type: 'text.delta', text: 'A' }, { type: 'text.end' },
    { type: 'userMessage.delivered', messageId: 'm9' },
    { type: 'text.delta', text: 'B' }, { type: 'text.end' },
    { type: 'userMessage', messageId: 'm9', text: '後から', pending: true },
  ]);
  t.ok('吹き出しより先に届いた配達の合図が残る間は分けない', splitLive(early).folded === 0);

  const carried = seq([
    { type: 'interruptionNote', messageId: 'm0', text: '止めたもの' },
    { type: 'compaction', phase: 'start' },
    { type: 'text.delta', text: 'A' }, { type: 'text.end' },
    { type: 'turnResult', outcome: 'ok' },
    { type: 'text.delta', text: 'B' },
  ]);
  const s2 = splitLive(carried);
  t.ok('中断の知らせ・圧縮・ターンの結果は畳まず、全部を流れの順で再生に回す',
    s2.folded === 5 && json(s2.events.map(e => e.type)) === json(['interruptionNote', 'compaction', 'turnResult', 'text.delta']), json(s2.events));

  // 畳んだ頭と、末尾を畳んだものをつなぐと、全部を畳んだものと同じ並び（画面は頭を履歴として描き、末尾を onEvent で描く）
  const mixed = seq([
    { type: 'userMessage', messageId: 'm0', text: '依頼', initial: true },
    { type: 'thinking.start' }, { type: 'thinking.delta', text: '考え' },
    { type: 'text.delta', text: '答え1' }, { type: 'text.end', uuid: 'a1' },
    { type: 'tool.start', id: 't1', name: 'Grep', input: {} }, { type: 'tool.result', id: 't1', text: 'r1' },
    { type: 'text.end', uuid: 'a2' },
    { type: 'tool.start', id: 't2', name: 'Read', input: {} }, { type: 'tool.result', id: 't2', text: 'r2' },
    { type: 'text.end', uuid: 'a3' },
    { type: 'tool.start', id: 't3', name: 'Read', input: {} }, { type: 'tool.result', id: 't3', text: 'r3' },
    { type: 'text.end', uuid: 'a4' },
    { type: 'taskNotice', text: '子の結果' },
    { type: 'text.delta', text: '答え2' }, { type: 'text.end', uuid: 'a5' },
    { type: 'userMessage', messageId: 'm1', text: '途中の指示', pending: true },
    { type: 'userMessage.delivered', messageId: 'm1' },
    { type: 'present', kind: 'image', path: 'a.png' },
    { type: 'text.delta', text: '答え3' },
    { type: 'tool.start', id: 't4', name: 'Bash', input: {} },
  ]);
  const opts = { backend: 'fake', initialMessageId: 'm0' };
  const s3 = splitLive(mixed, opts);
  const whole = streamMessages(mixed, opts);
  const tail = streamMessages(s3.events, opts);
  t.ok('頭と末尾を畳んでつなぐと、全部を畳んだものと同じ並び', s3.folded > 0
    && json(shape([...s3.messages, ...tail.messages])) === json(shape(whole.messages))
    && json([...s3.presents, ...tail.presents]) === json(whole.presents), json({ folded: s3.folded, a: shape([...s3.messages, ...tail.messages]), b: shape(whole.messages) }));
  t.ok('ツールだけの発言が続いても 1 つの発言のまま（画面のライブ・履歴と同じ）',
    whole.messages.filter(m => m.role === 'assistant' && !m.text && m.toolCalls?.length).length === 1
    && json(whole.messages.find(m => m.role === 'assistant' && !m.text)?.toolCalls.map(c => c.id)) === json(['t2', 't3']), json(shape(whole.messages)));

  // ---- サーバーへ渡す形: 畳んだ発言の印と、結果の長さ
  const big = 'x'.repeat(MAX_RESULT_CHARS + 500);
  const snap = liveSnapshot({ events: seq([
    { type: 'text.delta', text: 'A' },
    { type: 'tool.start', id: 'b1', name: 'Read', input: {} }, { type: 'tool.result', id: 'b1', text: big, isError: false, truncated: false },
    { type: 'tool.start', id: 'b2', name: 'Read', input: {} }, { type: 'tool.result', id: 'b2', text: 'small', isError: false, truncated: false },
    { type: 'text.end' },
    { type: 'text.delta', text: 'B' },
    { type: 'tool.start', id: 'b3', name: 'Read', input: {} }, { type: 'tool.result', id: 'b3', text: big },
  ]) }, { backend: 'fake', model: 'm' });
  const calls = snap.messages[0]?.toolCalls ?? [];
  t.ok('畳んだ発言には live の印と発言者を付ける', snap.messages.length === 1 && snap.messages[0].live === true && snap.messages[0].backend === 'fake' && snap.messages[0].model === 'm');
  t.ok('畳んだ発言のツールの結果は履歴と同じ長さに切り、切った印を付ける',
    calls[0].result.text.length < big.length && calls[0].result.text.startsWith('x'.repeat(MAX_RESULT_CHARS)) && calls[0].result.truncated === true
    && calls[1].result.text === 'small' && calls[1].result.truncated === false, json(calls.map(c => [c.result.text.length, c.result.truncated])));
  t.ok('再生する末尾の結果は切らない（走っているカードの全文）', snap.events.find(e => e.type === 'tool.result')?.text === big);

  // ---- 画面の配線（client.mjs は文字列で）
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const sync = source.slice(source.indexOf('async function syncHistory('), source.indexOf('\n}', source.indexOf('async function syncHistory(')));
  t.ok('ターンの終わりの読み直しは、畳んだ発言を持つ窓なら添字で照合せずに読み直す',
    sync.includes('state.messages.some(m => m?.live)') && sync.indexOf('m?.live') < sync.indexOf('loadHistory('));

  // ---- サーバー越し: 長いターンの途中で開く
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-live-snapshot-'));
  const steps = [];
  const result = 'r'.repeat(5000);
  for (let i = 0; i < 400; i++) {
    if (i % 4 === 0) steps.push({ text: `段落 ${i}` });
    steps.push({ tool: 'Read', input: { file_path: `f${i}` }, result, ms: 0 });
  }
  steps.push({ text: '最後の段落' });
  steps.push({ tool: 'Bash', input: { command: 'wait' }, result: 'done', ms: 6000 });
  const script = path.join(scratch, 'steps.json');
  await fs.writeFile(script, JSON.stringify({ steps }));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const from = c.mark();
    await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: `steps:@${script}` });
    const last = await c.waitFor(e => e.type === 'tool.start' && e.input?.command === 'wait', { from, ms: 60_000 });
    const sessionId = last.sessionId;
    const all = await c.cmd('loadSession', { sessionId, live: true });
    const events = all.stream?.events ?? [];
    t.ok('窓なしで読んでも、再生する出来事は動いている末尾だけ', events.length > 0 && events.length < 40
      && events.some(e => e.type === 'tool.start' && e.id === last.id) && !events.some(e => e.type === 'tool.start' && e.input?.file_path === 'f0'), `events ${events.length}`);
    const folded = all.messages.filter(m => m.live);
    t.ok('頭は畳んだ発言として、ターン前の履歴と依頼の後ろに並ぶ', all.messages[0]?.role === 'user' && folded.length >= 100 && all.messages.indexOf(folded[0]) === 1
      && folded[0].text === '段落 0' && folded[0].toolCalls.length === 4, json(all.messages.slice(0, 2).map(m => [m.role, m.text])));
    t.ok('畳んだ発言の結果は履歴と同じ長さ', folded.every(m => m.toolCalls.every(call => call.result.text.length <= MAX_RESULT_CHARS + 200 && call.result.truncated)));

    const win = await c.cmd('loadSession', { sessionId, live: true, lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES });
    const size = JSON.stringify(win).length;
    t.ok('開くとき（末尾の窓）は、ターンの長さによらず窓の分だけを運ぶ', win.base > 0 && win.total === all.messages.length && size < WINDOW_BYTES * 3
      && json(win.messages.at(-1)) === json(all.messages.at(-1)), `base ${win.base} total ${win.total} size ${size}`);

    const request = { before: win.base, presentBefore: win.presentBase };
    const older = await c.cmd('loadSession', { sessionId, lazy: true, older: { ...request, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(win.messages[0]) } });
    const joined = joinOlder(win, older, request);
    t.ok('走っている間の手前の読み込みは、同じ並び（ターン前の履歴＋畳んだ発言）でつながる', Boolean(joined)
      && json(joined.messages.map(m => m.text)) === json(all.messages.slice(joined.base).map(m => m.text)), json({ stale: older.stale, base: older.base }));

    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 30_000 });
    const done = await c.cmd('loadSession', { sessionId, live: true });
    t.ok('ターンが終われば保存済みの履歴だけ（畳んだ印も出来事も無い）', !done.stream && !done.messages.some(m => m.live) && done.messages.length > 1);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
