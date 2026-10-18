// OpenCode の上限と再試行の待ち（ADR 0229）を、バックエンドのターン・圧縮で通しで確かめる（偽の OpenCode。課金なし）:
// 待っても通らない上限は limited で終える・曖昧な 429 は待ちを出して OpenCode に任せる・待ちが明ければ running に戻る・待ちの間の中断・圧縮の待ち
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, summarize } from '../lib/harness.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { checkBackendEvent } from '../../core/backends/contract.mjs';

export const name = 'opencode-retry-turn';
export const title = 'OpenCode の上限と再試行の待ち: ターンと圧縮（limited で終える・待ちの表示・明けたら running・待ちの間の中断）';

export default async function testOpencodeRetryTurn(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-retry-turn-')));
  const gates = await createFakeGates(scratch);
  const envKeys = ['AGENT_HOST_DATA', 'AGENT_HOST_OPENCODE_DATA', 'AGENT_HOST_OPENCODE_BIN', 'AGENT_HOST_OPENCODE_HOLDER', 'AGENT_HOST_FAKE_GATE_DIR'];
  const before = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { AGENT_HOST_DATA: path.join(scratch, 'pleiad'), AGENT_HOST_OPENCODE_DATA: path.join(scratch, 'cli'),
    AGENT_HOST_OPENCODE_BIN: `"${process.execPath}" "${fileURLToPath(new URL('../lib/fake-opencode.mjs', import.meta.url))}"`,
    AGENT_HOST_OPENCODE_HOLDER: 'off', ...gates.env });
  let stop;
  try {
    await fs.mkdir(process.env.AGENT_HOST_OPENCODE_DATA, { recursive: true });
    const mod = await import('../../core/backends/opencode.mjs');
    const { backend } = mod;
    stop = mod.stopOpencodeServer;
    const { opencodeRelay } = await import('../../core/opencode-relay.mjs');
    opencodeRelay.setOrigin('http://127.0.0.1:1');
    const run = async (prompt, extra = {}) => {
      const events = [];
      const onEvent = extra.onEvent;
      delete extra.onEvent;
      const result = await backend.runTurn({ cwd: scratch, mode: 'ask', prompt, emit: e => { events.push(e); onEvent?.(e); }, ...extra });
      return { ...result, events, end: events.findLast(e => e.type === 'turnResult'), retries: events.filter(e => e.type === 'activity' && e.state === 'retrying'),
        states: events.filter(e => e.type === 'activity').map(e => e.state) };
    };
    const contractOk = (r) => r.events.every(e => checkBackendEvent(e) === null);
    const bad = (r) => JSON.stringify({ end: r.end, states: r.states, bad: r.events.map(checkBackendEvent).filter(Boolean) });

    // 待っても通らない上限（Zen の無料枠）: 待ちを出してから、OpenCode の再試行を待たずに limited で終える。解ける時刻は分からない
    const free = await run('retry-free');
    t.ok('Free の上限: 待ち（retrying・上限・free_tier_limit）を出し、limited で終える。resetsAt は付けない',
      free.retries[0]?.retry?.limit === true && free.retries[0].retry.reason === 'free_tier_limit' && Number.isFinite(free.retries[0].retry.next)
      && free.end?.outcome === 'limited' && !('resetsAt' in free.end) && /Free usage exceeded/.test(free.end.error ?? '') && contractOk(free), bad(free));

    // Go の枠: 次の再試行の時刻が解ける時刻
    const go = await run('retry-go');
    t.ok('Go の枠: limited で終え、resetsAt は次の再試行の時刻（epoch ms）', go.end?.outcome === 'limited' && go.end.resetsAt === go.retries[0]?.retry?.next
      && go.end.resetsAt > Date.now() && go.retries[0].retry.reason === 'account_rate_limit' && contractOk(go), bad(go));

    // 曖昧な 429: OpenCode の再試行（5 回）に任せ、待ちと再開を出し、なお 429 なら session.error の limited（retry-after から解除時刻）
    const rate = await run('retry-rate');
    t.ok('曖昧な 429: 5 回の待ち（retrying）と再開（running）を出し、最後の 429 で limited（retry-after の時刻）', rate.retries.length === 5
      && rate.retries.map(e => e.retry.attempt).join() === '1,2,3,4,5' && rate.states.filter(s => s === 'running').length >= 4
      && rate.end?.outcome === 'limited' && rate.end.resetsAt > Date.now() + 60_000 && contractOk(rate), bad(rate));

    // 待ちが明ければ running に戻り、普通に終わる
    const recover = await run('retry-recover');
    const ri = recover.states.indexOf('retrying');
    t.ok('待ちが明ける: retrying → running → ok', ri >= 0 && recover.states.slice(ri + 1).includes('running') && recover.end?.outcome === 'ok'
      && recover.retries[0].retry.limit === true && contractOk(recover), bad(recover));
    const nonext = await run('retry-nonext');
    t.ok('次の時刻の無い待ち: next は null のまま出し、明ければ ok', nonext.retries[0]?.retry?.next === null && nonext.retries[0].retry.limit === false
      && nonext.end?.outcome === 'ok' && contractOk(nonext), bad(nonext));

    // 待ちが長い間（ゲートが開くまで）も止まらず、開けば通る
    let sawWait;
    const waited = new Promise(r => { sawWait = r; });
    const gated = run('retry-gate:open-me', { onEvent: e => { if (e.type === 'activity' && e.state === 'retrying') sawWait(e); } });
    const gateWait = await waited;
    await gates.open('open-me');
    const opened = await gated;
    t.ok('長い待ち: 次の時刻は約 1 分後。ゲートが開けば running に戻って ok', gateWait.retry.next > Date.now() + 30_000 && opened.end?.outcome === 'ok'
      && opened.states.at(-1) !== 'retrying', bad(opened));

    // 待ちの間の中断（■）: すぐ aborted で終わる
    const abort = new AbortController();
    let sawAbortWait;
    const abortWaited = new Promise(r => { sawAbortWait = r; });
    const aborting = run('retry-gate:never', { signal: { signal: abort.signal }, onEvent: e => { if (e.type === 'activity' && e.state === 'retrying') sawAbortWait(); } });
    await abortWaited;
    const t0 = Date.now();
    abort.abort();
    const aborted = await aborting;
    t.ok('待ちの間の中断: aborted で終わる（limited にしない）', aborted.end?.outcome === 'aborted' && Date.now() - t0 < 10_000, bad(aborted));

    // 圧縮の待ち: 待ちを出し、待っても通らない上限なら止めて失敗にする
    const base = await run('compact-limited');
    const compactEvents = [];
    const c0 = Date.now();
    await backend.compact({ sessionId: base.sessionId, cwd: scratch, emit: e => compactEvents.push(e) });
    const failed = compactEvents.find(e => e.type === 'compaction' && e.phase === 'failed');
    t.ok('圧縮: 待ち（retrying）を出し、待っても通らない上限なら止めて failed（理由は上限の本文）',
      compactEvents.some(e => e.type === 'activity' && e.state === 'retrying' && e.retry.reason === 'free_tier_limit')
      && /Free usage exceeded/.test(failed?.reason ?? '') && !compactEvents.some(e => e.phase === 'complete') && Date.now() - c0 < 10_000,
      JSON.stringify(compactEvents));
    t.ok('失敗した圧縮で消費した token と cost も一度だけ計上する',compactEvents.filter(e=>e.type==='usage').length===1 && Math.abs((compactEvents.find(e=>e.type==='usage')?.costUsd??0)-0.0003)<1e-10,JSON.stringify(compactEvents));
    const cancelBase=await run('compact-abort');
    const cancellation=new AbortController(),cancelEvents=[];
    await backend.compact({sessionId:cancelBase.sessionId,cwd:scratch,signal:{signal:cancellation.signal},emit:e=>{cancelEvents.push(e);if(e.type==='activity'&&e.state==='compacting')cancellation.abort(new Error('User stopped'));}});
    const charged=cancelEvents.filter(e=>e.type==='usage');
    t.ok('手動中断: native の終了まで待ち、message に無い使用量を会話の累計差分から一度だけ回収する',charged.length===1 && charged[0].inputTokens===7 && Math.abs(charged[0].costUsd-0.0003)<1e-10 && cancelEvents.some(e=>e.phase==='failed') && !cancelEvents.some(e=>e.phase==='complete'),JSON.stringify(cancelEvents));
  } finally {
    await stop?.();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = summarize([await runCase({ name, title, default: testOpencodeRetryTurn })]);
