// 項目 3: agy（ACP。agy acp）の stdio の相手が数秒いなくなる／入れ替わるとき。LLM を 3 回呼ぶ（安いモデル。短い応答）。
//   (a) 走っているターン（session/prompt）の最中に、相手がいなくなる + stdout を誰も読まない 4 秒間 → 続くか・詰まらないか
//   (b) 新しい相手が付け直し、(a) の session/prompt の応答（stopReason）と、再生された session/update を受け取れるか
//   (c) 新しい相手が session/prompt を書いた直後に、もう 1 本を書く（ターンの最中の 2 本目。本体の steer と同じ）→ どちらにも応答が返るか・順序
//   (d) 何も書かない 6 秒（stdin を開けたまま）で落ちないか
// agy は AGENT_HOST_AGY_BIN で身代わり（node tests/lib/fake-agy.mjs）に替えられる（段取りだけの確かめ。(b) の行数は台本なので外れる）。
import { HolderSim } from './holder-sim.mjs';
import { Rpc, log, sleep } from './lib.mjs';
import { agyLaunch, desc, expectResponse, parse, promptParams, replyText, request, setModel, startSession } from '../agy/acp-probe.mjs';
import fs from 'node:fs'; import path from 'node:path';
const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'agy-work-'));
const model = process.env.PROBE_AGY_MODEL ?? 'gemini-3.8-flash-low';
const { command, args } = agyLaunch({ cwd: work, skipPermissions: true });
const h = new HolderSim(command, args, { cwd: work });
// 保持役の記録（通番つき）を読む 1 人分の親。after は前の親が使った最後の依頼 id（続きの id）。expect は、その依頼の応答を受ける枠を、付け直しの再生より前に開ける
class Client {
  constructor(name, from = 0, { after = 0, expect = false } = {}) {
    this.name = name; this.frames = []; this.rpc = new Rpc(name, (s) => h.write(s));
    this.rpc.nextId = after;
    if (expect) this.expected = expectResponse(this.rpc, after, 90_000);
    h.attach((line, seq) => { const m = parse(line); if (!m) return; this.frames.push({ seq, at: Date.now(), m }); this.last = seq; this.rpc.feed(`${line}\n`); }, from);
  }
}
const chunks = (client) => client.frames.filter((f) => f.m.params?.update?.sessionUpdate === 'agent_message_chunk');
let sessionId = null;
try {
  const A = new Client('A');
  const started = await startSession(A.rpc, { cwd: work });
  sessionId = started.sessionId;
  log('model applied:', await setModel(A.rpc, sessionId, model));
  const promptId = ++A.rpc.nextId;
  const t0 = Date.now();
  h.write(request(promptId, 'session/prompt', promptParams(sessionId, 'Write the integers from 1 to 120, one per line, each followed by a single English adjective. Output only the list.')));
  while (!chunks(A).length && Date.now() - t0 < 60000) await sleep(50);
  log('(a) A saw the first chunk after', Date.now() - t0, 'ms; session', sessionId);
  await sleep(300);
  const early = A.frames.find((f) => f.m.id === promptId && f.m.method === undefined);
  if (early) log('(a) WARNING: the turn had already finished before A detached (the swap is not exercised; use a longer prompt)');
  const ack = A.last; h.detach();
  h.child.stdout.pause(); log('(a) A detached at seq', ack, '; stdout NOT read for 4s (paused)');
  await sleep(4000);
  h.child.stdout.resume(); log('(a) stdout reading resumed; holder log lines now', h.seq, '(prompt response already in log:', h.log.some((e) => /"stopReason"/.test(e.line)), ')');
  await sleep(1500);
  const B = new Client('B', ack, { after: promptId, expect: !early });
  log('(b) B attached from seq', ack, '; B replayed frames:', B.frames.length, B.frames.slice(0, 12).map((f) => desc(f.m)).join(' | '));
  const r1 = early ? { result: early.m.result } : await B.expected;
  const text = replyText([...A.frames, ...B.frames].map((f) => f.m));
  log('(b) B got the response of the interrupted-attachment turn:', JSON.stringify(r1.result ?? r1), 'lines in reply', text.trim().split('\n').length, '(expect 120)');
  // (c) 2 本目をターンの最中に
  const n0 = B.frames.length;
  const p2 = B.rpc.request('session/prompt', promptParams(sessionId, 'Reply with exactly: two'), 90_000);
  await sleep(150);
  const p3 = B.rpc.request('session/prompt', promptParams(sessionId, 'Reply with exactly: three'), 90_000);
  const [r2, r3] = await Promise.all([p2, p3]);
  const tail = B.frames.slice(n0);
  const answered = [r2, r3].every((r) => r.result?.stopReason);
  log('(c) both extra prompts answered:', answered, JSON.stringify({ two: r2.result ?? r2, three: r3.result ?? r3 }),
    '\n     response order (id):', tail.filter((f) => f.m.id !== undefined && !f.m.method).map((f) => `#${f.m.id}`).join(' < '),
    '\n     reply:', JSON.stringify(replyText(tail.map((f) => f.m)).slice(0, 120)));
  // (d) 何も書かない
  await sleep(6000);
  log('(d) alive after 6s with no writes (stdin open):', h.exit === null);
  const sessions = new Set(B.frames.map((f) => f.m.params?.sessionId).filter(Boolean));
  log('session ids seen after the swap:', [...sessions].map((s) => s.slice(0, 8)).join(','), '(one session for all turns)');
} finally {
  log('SESSION_ID(for cleanup):', sessionId);
  try { h.child.stdin.end(); } catch {}
  await Promise.race([h.exited, sleep(15000)]);
  if (h.exit === null) h.kill();
  await sleep(500); fs.rmSync(work, { recursive: true, force: true });
  log('stderr:', h.err.slice(0, 300));
}
