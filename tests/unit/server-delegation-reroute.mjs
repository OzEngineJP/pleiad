// 自動の振り分けの子が仕事を始める前に断られたら、次の候補へ任せ直す（ADR 0302）をサーバー全体で確かめる。
// 委譲先は偽の agy（tests/lib/fake-agy.mjs: limit-no-reply は返事の前に上限で断る・error-body は本文を書いてから失敗・
// limit-after-reply は返事を終えてから上限なので、返事は結果として残る）と手元の偽物（fail・fail-auth tool）。
// 本物の自動選択のサービス・LLM へは送らない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-reroute';
export const title = '委譲の任せ直し: 仕事前の拒否は次の候補へ・痕跡があれば替えない・固定と追加指示は替えない・回数の上限と記録';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-reroute-'));
  const server = await startServer({ dataDir: scratch, env: {
    AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"`,
    FAKE_AGY_EXTRA_MODELS: 'gemini-3.8-flash-high,gemini-3.8-pro-high,gemini-3.8-mini-high,gemini-3.8-nano-high,gemini-3.8-turbo-high',
    AGENT_HOST_ROUTING_USAGE: 'on' } });
  // antigravity の子は親より強い（yolo）ので、委譲のたびに親の会話で 1 回聞かれる。ここでは許す
  const c = await open({ port: server.port, token: server.token, onEvent: async (ev, api) => {
    if (ev.type === 'permission') await api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
  } });
  // 子の完了通知が依頼元の会話で走っている間は、その会話で次のターンを始められない。空くまで待って頼み直す
  const turnOn = async (sessionId, text) => {
    for (let i = 0; ; i++) {
      try { return sessionId ? await c.runTurn({ sessionId, prompt: text }) : await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: text }); }
      catch (e) { if (i > 200 || !/切り替え中|実行中|running/.test(e.message)) throw e; await sleep(50); }
    }
  };
  const call = async (sessionId, tool, args) => {
    const from = c.mark();
    const turn = await turnOn(sessionId, prompt(tool, args));
    const id = sessionId ?? turn.sessionId;
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === id, { from, ms: 60000 });
    let data = null;
    try { data = JSON.parse(ev.text); } catch { /* エラーは文 */ }
    return { sessionId: id, isError: ev.isError, text: ev.text, data };
  };
  const delegate = (sessionId, args) => call(sessionId, 'ply_delegate', args);
  const rowOf = async taskId => (await c.cmd('agentTasks')).find(x => x.taskId === taskId);
  const settle = async taskId => {
    let got;
    for (let i = 0; i < 1200 && !['completed', 'failed', 'cancelled'].includes(got?.status); i++) { got = await rowOf(taskId); await sleep(50); }
    return got;
  };
  // 完了通知が依頼元の会話へ届くまで待って、通知の本文を読む
  const noticeOf = async (sessionId, taskId) => {
    for (let i = 0; i < 1200 && (await rowOf(taskId))?.notification !== 'sent'; i++) await sleep(50);
    return (await c.cmd('loadSession', { sessionId })).messages.filter(m => m.internalTaskNotice).map(m => m.text).join('\n');
  };
  // 子の会話のメタデータ（delegation.superseded など）。一覧は操作の一覧（sessions.list）で見る
  const sessionMeta = async id => (await c.cmd('invoke', { op: 'sessions.list', args: {} })).find(s => s.id === id);
  const superseded = async (oldId, ms = 30000) => {
    for (let i = 0; i < 600; i++) { const s = await sessionMeta(oldId); if (s?.delegation?.superseded) return s.delegation.superseded; await sleep(50); }
    return null;
  };
  const setTiers = async t1 => c.cmd('setDelegationRouting', { settings: { table: { trivial: ['t1', 't1', 't1'] }, tiers: { t1 } } });
  try {
    // 使用量が取れて agy の候補が使えるようになるまで待つ（判定は 3 レベル同じ段なので送らない。fallback: same_level）
    let state;
    for (let i = 0; i < 200; i++) {
      state = await c.cmd('delegationRouting');
      if (state.candidates.find(x => x.candidate === 'antigravity:gemini-3.8-flash-high')?.usable) break;
      await sleep(100);
    }
    const sid = (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;

    // ---- 返事の前に上限で断られた子は、次の候補へ任せ直して同じタスクを走らせる
    await setTiers(['antigravity:gemini-3.8-flash-high', 'fake:fast']);
    const limited = await delegate(sid, { kind: 'trivial', task: 'limit-no-reply' });
    t.ok('（準備）自動の振り分けは先頭の候補（agy の flash-high）を選ぶ', !limited.isError && limited.data?.routing?.mode === 'auto'
      && limited.data.routing.target.model === 'gemini-3.8-flash-high', limited.text.slice(0, 300));
    const oldChild = limited.data.sessionId;
    const done = await settle(limited.data.taskId);
    t.ok('上限で断られた子は任せ直し、次の候補（fake:fast）が同じタスクを完了する', done?.status === 'completed'
      && done.backend === 'fake' && done.model === 'fast' && done.sessionId !== oldChild, JSON.stringify({ s: done?.status, b: done?.backend }));
    const attempts = done?.routing?.attempts ?? [];
    t.ok('routing.attempts に、断られた回（委譲先・会話・limited）が残る', attempts.length === 1
      && attempts[0].target?.backend === 'antigravity' && attempts[0].target?.model === 'gemini-3.8-flash-high'
      && attempts[0].sessionId === oldChild && attempts[0].outcome === 'limited', JSON.stringify(attempts));
    t.ok('任せ直しの振り分けは、断られた候補を rejected_before_work で飛ばした記録を持つ',
      (done?.routing?.skipped ?? []).some(x => x.candidate === 'antigravity:gemini-3.8-flash-high' && x.reason === 'rejected_before_work'),
      JSON.stringify(done?.routing?.skipped));
    t.ok('断られた子の会話は残り、次の会話の id（superseded）が付く', (await superseded(oldChild)) === done.sessionId);
    t.ok('断られた子の会話は開ける（失敗の経緯として残す）', ((await c.cmd('loadSession', { sessionId: oldChild })).messages ?? []).length >= 0
      && Boolean(await sessionMeta(oldChild)));
    const notice = await noticeOf(sid, limited.data.taskId);
    t.ok('完了の通知に、元の委譲先・理由・実際に走った委譲先の 1 行を添える',
      notice.includes('antigravity:gemini-3.8-flash-high は仕事を始める前に使用量の上限で断られたので、fake:fast へ任せ直しました'), notice.slice(0, 500));

    // ---- 返事を書いてから失敗した子は任せ直さない（痕跡があるので、同じ仕事を 2 箇所で走らせない）
    await setTiers(['antigravity:gemini-3.8-pro-high', 'fake:fast']);
    const afterReply = await delegate(sid, { kind: 'trivial', task: 'error-body' });
    const replyRow = await settle(afterReply.data.taskId);
    t.ok('返事を書いてから失敗した子は任せ直さない', replyRow?.status === 'failed' && replyRow.backend === 'antigravity'
      && replyRow.sessionId === afterReply.data.sessionId && !(replyRow.routing?.attempts ?? []).length, JSON.stringify({ s: replyRow?.status, at: replyRow?.routing?.attempts }));
    // 返事を終えてから上限で断られた分は、agy の仕様で返事を結果として残す（ok）。失敗ではないので任せ直しの対象にもならない
    const afterLimit = await delegate(sid, { kind: 'trivial', task: 'limit-after-reply' });
    const limitRow = await settle(afterLimit.data.taskId);
    t.ok('返事を終えてから上限で断られた分は、残った返事で完了する（失敗ではないので任せ直さない）', limitRow?.status === 'completed'
      && limitRow.sessionId === afterLimit.data.sessionId && !(limitRow.routing?.attempts ?? []).length, JSON.stringify({ s: limitRow?.status, at: limitRow?.routing?.attempts }));

    // ---- ツールの痕跡がある失敗は任せ直さない
    await setTiers(['fake:fast', 'fake:smart']);
    const afterTool = await delegate(sid, { kind: 'trivial', task: 'fail-auth tool' });
    const toolRow = await settle(afterTool.data.taskId);
    t.ok('ツールを動かしてから失敗した子は任せ直さない', toolRow?.status === 'failed' && toolRow.sessionId === afterTool.data.sessionId
      && !(toolRow.routing?.attempts ?? []).length, JSON.stringify({ s: toolRow?.status }));

    // ---- エラー（上限でなく）で返事の前に断られた子も任せ直す。次の候補も同じ失敗ならそこで終わる
    const failFirst = await delegate(sid, { kind: 'trivial', task: 'fail' });
    t.ok('（準備）自動の振り分けは先頭の候補（fake:fast）を選ぶ', failFirst.data?.routing?.target?.backend === 'fake' && failFirst.data.routing.target.model === 'fast', failFirst.text.slice(0, 300));
    const failRow = await settle(failFirst.data.taskId);
    t.ok('返事の前のエラーは次の候補へ任せ直す。次も仕事前のエラーなら候補が尽きて失敗になる', failRow?.status === 'failed'
      && failRow.model === 'smart' && failRow.sessionId !== failFirst.data.sessionId && failRow.routing?.attempts?.length === 1
      && failRow.routing.attempts[0].outcome === 'error', JSON.stringify({ s: failRow?.status, at: failRow?.routing?.attempts }));

    // ---- 固定（backend 指定）は任せ直さない
    const pinned = await delegate(sid, { kind: 'trivial', backend: 'fake', task: 'fail' });
    t.ok('（準備）backend を書けば固定', pinned.data?.routing?.mode === 'pinned', pinned.text.slice(0, 300));
    const pinnedRow = await settle(pinned.data.taskId);
    t.ok('固定の委譲は仕事前の失敗でも任せ直さない', pinnedRow?.status === 'failed' && pinnedRow.sessionId === pinned.data.sessionId
      && !(pinnedRow.routing?.attempts ?? []).length, JSON.stringify({ s: pinnedRow?.status }));

    // ---- 追加の指示（ply_task_send）で再開した回は任せ直さない
    await setTiers(['fake:fast']);
    const sent = await delegate(sid, { kind: 'trivial', task: 'echo:hi' });
    const sentDone = await settle(sent.data.taskId);
    t.ok('（準備）まず普通に完了する子を作る', sentDone?.status === 'completed', JSON.stringify({ s: sentDone?.status }));
    const more = await call(sid, 'ply_task_send', { taskId: sent.data.taskId, message: 'fail' });
    t.ok('（準備）追加の指示を送れる', !more.isError, more.text.slice(0, 300));
    const moreRow = await settle(sent.data.taskId);
    t.ok('追加の指示の回は、仕事前の失敗でも同じ子の会話で失敗になる（任せ直さない）', moreRow?.status === 'failed'
      && moreRow.sessionId === sentDone.sessionId && !(moreRow.routing?.attempts ?? []).length, JSON.stringify({ s: moreRow?.status, sid: moreRow?.sessionId }));

    // ---- 任せ直しは 2 回まで（最初を含め 3 回の試行）。3 つ目も断られたら、まだ候補があっても失敗で止まる
    await setTiers(['antigravity:gemini-3.8-nano-high', 'antigravity:gemini-3.8-turbo-high', 'antigravity:gemini-3.8-pro-high', 'fake:fast']);
    const capped = await delegate(sid, { kind: 'trivial', task: 'limit-no-reply' });
    t.ok('（準備）自動の振り分けは先頭の候補（agy の nano-high）を選ぶ', capped.data?.routing?.target?.model === 'gemini-3.8-nano-high', capped.text.slice(0, 300));
    const cappedRow = await settle(capped.data.taskId);
    const cappedAttempts = cappedRow?.routing?.attempts ?? [];
    t.ok('任せ直しは 2 回まで: 3 つ目の候補（pro-high）で止まり、4 つ目（fake:fast）には進まない', cappedRow?.status === 'failed' && Boolean(cappedRow.limit)
      && cappedRow.model === 'gemini-3.8-pro-high' && cappedAttempts.length === 2
      && cappedAttempts.every(a => a.outcome === 'limited' && a.target?.backend === 'antigravity')
      && cappedAttempts.map(a => a.target?.model).join() === 'gemini-3.8-nano-high,gemini-3.8-turbo-high',
      JSON.stringify({ s: cappedRow?.status, b: cappedRow?.model, at: cappedAttempts.map(a => a.target?.model) }));
    t.ok('2 回任せ直すと 3 つの子の会話ができる。前の 2 つには順に次の会話の id（superseded）が付く',
      cappedAttempts[0]?.sessionId && cappedAttempts[1]?.sessionId && cappedRow.sessionId
      && (await superseded(cappedAttempts[0].sessionId)) === cappedAttempts[1].sessionId
      && (await superseded(cappedAttempts[1].sessionId)) === cappedRow.sessionId,
      JSON.stringify([cappedAttempts[0]?.sessionId, cappedAttempts[1]?.sessionId, cappedRow?.sessionId]));
    const cappedNotice = await noticeOf(sid, capped.data.taskId);
    t.ok('任せ直しが 2 回なら、通知には任せ直しの行が 2 本（nano→turbo・turbo→pro）出る',
      cappedNotice.includes('antigravity:gemini-3.8-nano-high は仕事を始める前に使用量の上限で断られたので、antigravity:gemini-3.8-turbo-high へ任せ直しました')
      && cappedNotice.includes('antigravity:gemini-3.8-turbo-high は仕事を始める前に使用量の上限で断られたので、antigravity:gemini-3.8-pro-high へ任せ直しました'), cappedNotice.slice(0, 600));

    // ---- モデルを CLI に断られた子（ADR 0311）。一覧に無い名前（fake:rejected-a は fake の一覧に無い）も、飛ばさず選ぶ
    await setTiers(['fake:rejected-a', 'fake:fast']);
    const refusedFirst = await delegate(sid, { kind: 'trivial', task: 'echo:after-refusal' });
    t.ok('（準備）一覧に無いモデルでも飛ばさず、先頭の候補として選ぶ', refusedFirst.data?.routing?.target?.backend === 'fake' && refusedFirst.data.routing.target.model === 'rejected-a'
      && !(refusedFirst.data.routing.skipped ?? []).some(x => x.candidate === 'fake:rejected-a'), JSON.stringify(refusedFirst.data?.routing?.skipped));
    const refusedRow = await settle(refusedFirst.data.taskId);
    t.ok('最初のターンでモデルを断られた子は、次の候補（fake:fast）で作り直して完了する（発言は断りの文面だけでも仕事の痕跡にしない）',
      refusedRow?.status === 'completed' && refusedRow.model === 'fast' && refusedRow.sessionId !== refusedFirst.data.sessionId
      && refusedRow.routing?.attempts?.length === 1 && refusedRow.routing.attempts[0].target?.model === 'rejected-a' && refusedRow.routing.attempts[0].reason === 'model_rejected',
      JSON.stringify({ s: refusedRow?.status, m: refusedRow?.model, at: refusedRow?.routing?.attempts }));
    t.ok('断られた候補は skipped に model_rejected で残る', (refusedRow?.routing?.skipped ?? []).some(x => x.candidate === 'fake:rejected-a' && x.reason === 'model_rejected'),
      JSON.stringify(refusedRow?.routing?.skipped));
    // 設定を替えずにもう一度: 断られた候補はしばらく選ばない（サーバーの間だけ覚える）
    const second = await delegate(sid, { kind: 'trivial', task: 'echo:again' });
    t.ok('しばらくは断られた候補を選ばず、最初から次の候補へ（skipped に model_rejected と外す期限）', second.data?.routing?.target?.model === 'fast'
      && (second.data.routing.skipped ?? []).some(x => x.candidate === 'fake:rejected-a' && x.reason === 'model_rejected' && x.until), second.text.slice(0, 400));
    await settle(second.data.taskId);
    // 振り分けの設定を保存すると、断りの記録は忘れる
    await setTiers(['fake:rejected-a', 'fake:fast']);
    const forgot = await delegate(sid, { kind: 'trivial', task: 'echo:forgot' });
    t.ok('設定を保存すると断りの記録は消え、また先頭の候補から試す', forgot.data?.routing?.target?.model === 'rejected-a', forgot.text.slice(0, 300));
    await settle(forgot.data.taskId);
    // 候補が尽きたら、理由つきで失敗する
    await setTiers(['fake:rejected-a', 'fake:rejected-b']);
    const exhausted = await delegate(sid, { kind: 'trivial', task: 'echo:none' });
    const exhaustedRow = await settle(exhausted.data.taskId);
    t.ok('候補がすべて断られたら失敗し、理由（routing.exhausted）に断られた候補を載せる', exhaustedRow?.status === 'failed'
      && /rejected-a/.test(exhaustedRow.error ?? '') && /rejected-b/.test(exhaustedRow.error ?? '') && exhaustedRow.routing?.attempts?.length >= 1,
      JSON.stringify({ s: exhaustedRow?.status, e: exhaustedRow?.error }));
    // 固定（backend と model を書く）は、これまでどおり
    const pinnedBad = await delegate(sid, { kind: 'trivial', backend: 'fake', model: 'rejected-a', task: 'echo:x' });
    t.ok('固定でモデルが一覧に無ければ、これまでどおり model_unknown で断る（子を作らない）', pinnedBad.isError && pinnedBad.text.includes('model_unknown'), pinnedBad.text.slice(0, 300));
    const pinnedRefused = await delegate(sid, { kind: 'trivial', backend: 'fake', model: 'fast', task: 'fail-model' });
    const pinnedRefusedRow = await settle(pinnedRefused.data.taskId);
    t.ok('固定の委譲でモデルを断られても、作り直さず同じ子の会話で失敗になる', pinnedRefusedRow?.status === 'failed' && pinnedRefusedRow.sessionId === pinnedRefused.data.sessionId
      && !(pinnedRefusedRow.routing?.attempts ?? []).length, JSON.stringify({ s: pinnedRefusedRow?.status, at: pinnedRefusedRow?.routing?.attempts }));

    // 後片付け: 走っている子を止める
    for (const task of await c.cmd('agentTasks')) if (['queued', 'running'].includes(task.status)) await c.cmd('cancelAgentTask', { taskId: task.taskId }).catch(() => {});
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
