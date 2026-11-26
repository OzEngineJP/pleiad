// 無停止の更新 段階 3（agy）の最初の実測: 本物の agy（ACP。agy acp）を本物の保持役（core/holder/）の子に載せ、サーバー（親）が入れ替わっても続くかを測る。
// stage0-codex-agy §3 は保持役の身代わり（holder-sim）だったので、ここは本物の保持役・本物のクライアントで、agy 1.5.15 以降を使う。
// agy の ACP は 1 会話 1 プロセス（本体と同じ lifetime: 'conversation'）。依頼は initialize → session/new → session/set_config_option（モデル）→ session/prompt で、
// 応答は stopReason、本文・ツールは session/update の通知で来る。承認は --dangerously-skip-permissions で省く（承認の往復は見ない）。
//   (a) 親 A が spawn → initialize・session/new・モデルを当てる → 印（turn）→ session/prompt を書く。ツールを呼ぶターンの途中で A が detach して切れる
//   (b) 親 B が付け直す（attach）。印から ack までの再生と、続きの出力で session/prompt の応答（stopReason）まで届くか（sessionId・ツールの通知・本文）
//   (c) B が同じプロセスに 2 ターン目の session/prompt を書く（印を打ち直す）。記録の捨てられ方（first の進み）と、同じ sessionId のままか
//   (d) 保持役に載った子を B が木ごと止めて、agy と中継の孫が残らないか
// LLM は gemini-3.8-flash-low で 2 ターン（短い応答・シェルは echo 1 回）。agy の会話は ~/.gemini/antigravity-cli に残る（終わりに sessionId を出す）。
// 置き場は worktree の temporary/zdu-agy-held/（データ置き場・実行場所・作業場所）。保持役は終わりに shutdown する。
// agy は AGENT_HOST_AGY_BIN で身代わり（node tests/lib/fake-agy.mjs）に替えられる（段取りだけの確かめ。台本のターンは付け直しの前に終わるので、(b) の中継ぎは通らない）。
//
//   node scripts/zero-downtime/agy/held-swap.mjs [--model <id>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureHolder, connectHolder } from '../../../core/holder/client.mjs';
import { holderSource, ADOPT_TURN_MARK } from '../../../core/adopt.mjs';
import { KEEP_MS } from '../../../core/process.mjs';
import { Rpc } from '../codex/lib.mjs';
import { agyLaunch, desc, expectResponse, parse, promptParams, replyText, request, setModel, startSession, toolEnds, toolStarts } from './acp-probe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'gemini-3.8-flash-low';
const scratch = path.join(repo, 'temporary', 'zdu-agy-held');
await fs.rm(scratch, { recursive: true, force: true });
const dataDir = path.join(scratch, 'data'), root = path.join(scratch, 'runtime'), work = path.join(scratch, 'work');
await Promise.all([dataDir, root, work].map(dir => fs.mkdir(dir, { recursive: true })));
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(50); } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const imageNames = () => { try { return execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).split('\n').map(l => /^"([^"]+)","(\d+)"/.exec(l)).filter(Boolean).map(m => [m[1], Number(m[2])]); } catch { return []; } };
const summary = child => child && (({ alive: up, seq, first, acked, marks }) => ({ alive: up, seq, first, acked, marks }))(child);
// source.attach の列を読む。onItem が false を返すか exit で終わる。保持役とのつながりを閉じると列は「lost」で投げて終わる（それは正常な終わり）
const pump = async (source, from, onItem) => {
  try { for await (const item of source.attach(from)) if (onItem(item) === false || item.exit) break; }
  catch (error) { if (!/connection was lost/.test(String(error?.message))) throw error; }
};

// 本体（antigravity.mjs）と同じ引数・同じ spawn（policy: 'jsonrpc'。子の id は本体の接頭辞 acp-agy- に揃える）
const { command, args } = agyLaunch({ cwd: work, skipPermissions: true });
const id = 'acp-agy-held-probe';
const out = { ok: false };
let holderPid = null, clientA = null, clientB = null, sessionId = null;
try {
  const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
  holderPid = found.pid;
  clientA = found.client;
  log('holder', holderPid, 'agy', command, args.join(' '), `model=${model}`);

  // (a) 親 A
  const sourceA = holderSource(clientA, { id, acked: 0, seq: 0, marks: {} }, { spawned: true });
  clientA.spawn({ id, command, args, cwd: work, env: { ...process.env }, policy: 'jsonrpc', keepMs: KEEP_MS });
  const rpcA = new Rpc('A', text => sourceA.write(text));
  const seenA = [];
  const readA = pump(sourceA, 1, item => {
    if (item.exit) return false;
    seenA.push({ seq: item.seq, m: parse(item.line) });
    rpcA.feed(`${item.line}\n`);
    sourceA.ack(item.seq);
  });
  sessionId = (await startSession(rpcA, { cwd: work })).sessionId;
  log('A: session', sessionId, '; model applied:', await setModel(rpcA, sessionId, model));
  clientA.mark(id, ADOPT_TURN_MARK);   // 印は session/prompt を書く直前。次の行から再生の対象になる
  const promptId = ++rpcA.nextId;
  sourceA.write(request(promptId, 'session/prompt', promptParams(sessionId, 'Run the shell command `echo zdu-agy-held` with your shell tool, then reply with exactly one word: finished')));
  const answered = frames => frames.find(f => f.m?.id === promptId && f.m.method === undefined);
  // ターンの途中（ツールの通知が出るまで。出なければ本文の途中か応答まで）で手を離す
  await until(() => toolStarts(seenA.map(f => f.m)).length || answered(seenA), 90_000, 'tool call');
  const early = answered(seenA);
  const ackSeq = seenA.at(-1).seq;
  sourceA.ack(ackSeq);
  await sleep(100);
  clientA.label(id, { probe: true, sessionId });   // 札（付け直せる子の目印）。本体は touchCard が置く
  await clientA.detach(id);
  log('A: detached after', seenA.length, 'lines; events:', seenA.map(f => desc(f.m)).join(' | '));
  if (early) log('A: WARNING: the turn had already finished before A detached (the swap is not exercised)');
  clientA.close();   // つながりを閉じる（親が落ちるのと同じ。読みの列は lost で終わる）
  await Promise.race([readA, sleep(2000)]);
  sourceA.dispose(); clientA = null;
  await sleep(2500);   // 親が居ない間（切り替えの間に当たる数秒）にも子は進む

  // (b) 親 B
  clientB = await connectHolder({ dataDir, root });
  const child = clientB.welcome.children.find(c => c.id === id);
  log('B: welcome child', JSON.stringify({ ...summary(child), label: child?.label }));
  const sourceB = holderSource(clientB, child, { redelivered: true });
  const rpcB = new Rpc('B', text => sourceB.write(text));
  rpcB.nextId = promptId;
  const turn1 = early ? null : expectResponse(rpcB, promptId, 120_000);   // A が書いた session/prompt の答えを受ける枠（再生より前に開ける）
  const mark = child.marks[ADOPT_TURN_MARK];
  const replayed = [];
  if (child.acked >= mark) for (const [seq, line] of await sourceB.replay(mark, child.acked)) replayed.push({ seq, m: parse(line) });
  log('B: replayed', replayed.length, 'lines (mark', mark, '..', child.acked, '):', replayed.map(r => desc(r.m)).join(' | '));
  const live = [];
  void pump(sourceB, child.acked + 1, item => {
    if (item.exit) { live.push({ exit: item.exit }); return false; }
    if (item.redelivered) return;
    live.push({ seq: item.seq, m: parse(item.line) });
    rpcB.feed(`${item.line}\n`);
    sourceB.ack(item.seq);
  });
  const r1 = early ? { result: answered(seenA).m.result } : await turn1;
  const lines = items => items.filter(f => f.m).map(f => f.m);
  log('B: continued', live.length, 'lines; events:', live.map(l => l.exit ? 'exit' : desc(l.m)).join(' | '));
  log('B: turn 1 response', JSON.stringify(r1.result ?? r1), 'reply', JSON.stringify(replyText([...lines(seenA), ...lines(live)])));
  log('turn 1 completed tool calls seen (A + live):', toolEnds([...lines(seenA), ...lines(live)]).length);

  // (c) 同じプロセスに 2 ターン目（印を打ち直す。本体の markTurn と同じ）
  clientB.mark(id, ADOPT_TURN_MARK);
  const n2 = live.length;
  const r2 = await rpcB.request('session/prompt', promptParams(sessionId, 'Reply with exactly one word: second'), 120_000);
  log('B: turn 2 response', JSON.stringify(r2.result ?? r2), 'reply', JSON.stringify(replyText(lines(live.slice(n2)))));
  const sessions = new Set([...lines(seenA), ...lines(replayed), ...lines(live)].map(m => m.params?.sessionId).filter(Boolean));
  const sameSession = sessions.size > 0 && [...sessions].every(s => s === sessionId);
  log('session ids seen across the swap and turn 2:', [...sessions].map(s => s.slice(0, 8)).join(','), '; all equal to the first:', sameSession);
  sourceB.dispose();   // 次の接続（probe）に親の枠を渡す前に、B の購読をやめる
  await sleep(200);
  const probe = await connectHolder({ dataDir, root }).catch(() => null);
  log('holder child after 2 turns (probe connection takes the parent slot)', JSON.stringify(summary(probe?.welcome.children.find(c => c.id === id))));
  clientB = probe ?? clientB;

  // (d) 木ごと止める
  const childNow = clientB.welcome.children.find(c => c.id === id);
  const childPid = childNow?.pid;
  const agyBefore = imageNames().filter(([n]) => /^agy/i.test(n)).map(([, pid]) => pid);
  const sourceK = holderSource(clientB, childNow);
  void pump(sourceK, childNow.acked + 1, () => {}).catch(() => { /* 親が切れた */ });
  await sleep(300);
  clientB.kill(id, { tree: true });
  await sleep(2500);
  log('(d) child pid', childPid, 'agy processes before', agyBefore.join(','), '; alive after kill(tree):', childPid ? alive(childPid) : 'n/a', '; agy processes now', imageNames().filter(([n]) => /^agy/i.test(n)).map(([, pid]) => pid).join(','));
  out.ok = r1.result?.stopReason === 'end_turn' && r2.result?.stopReason === 'end_turn' && sameSession;
  out.resultBeforeDetach = Boolean(early);
} catch (error) {
  log('FAILED:', error?.stack ?? error);
} finally {
  log('SESSION_ID(for cleanup):', sessionId);
  try { clientB?.shutdown(); clientA?.shutdown(); } catch { /* 下で pid を確かめる */ }
  await sleep(1500);
  if (holderPid) log('holder alive after shutdown:', alive(holderPid));
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
