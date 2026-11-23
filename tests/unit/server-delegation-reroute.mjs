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
export const title = '委譲の再振り分け: 上限なら同じ子で継続し、仕事前のエラーなら次の候補で再試行する';
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

    // ---- 返事の前に上限で断られた子は、同じ会話を次の候補で続ける
    await setTiers(['antigravity:gemini-3.8-flash-high', 'fake:fast']);
    const limited = await delegate(sid, { kind: 'trivial', task: 'limit-no-reply' });
    t.ok('（準備）自動の振り分けは先頭の候補（agy の flash-high）を選ぶ', !limited.isError && limited.data?.routing?.mode === 'auto'
      && limited.data.routing.target.model === 'gemini-3.8-flash-high', limited.text.slice(0, 300));
    const oldChild = limited.data.sessionId;
    const done = await settle(limited.data.taskId);
    t.ok('次の候補（fake:fast）が同じ子の会話で元の依頼を引き継ぎ、完了する', done?.status === 'completed'
      && done.backend === 'fake' && done.model === 'fast' && done.sessionId === oldChild && done.result.includes('limit-no-reply'),
      JSON.stringify({ s: done?.status, b: done?.backend }));
    const attempts = done?.routing?.attempts ?? [];
    t.ok('routing.attempts に、断られた回（委譲先・会話・limited）が残る', attempts.length === 1
      && attempts[0].target?.backend === 'antigravity' && attempts[0].target?.model === 'gemini-3.8-flash-high'
      && attempts[0].sessionId === oldChild && attempts[0].outcome === 'limited' && attempts[0].continued, JSON.stringify(attempts));
    t.ok('振り分けは、止まった候補を recently_limited で飛ばした記録を持つ',
      (done?.routing?.skipped ?? []).some(x => x.candidate === 'antigravity:gemini-3.8-flash-high' && x.reason === 'recently_limited'),
      JSON.stringify(done?.routing?.skipped));
    t.ok('子の会話は同じ id のまま新しい実行先に切り替わる', (await sessionMeta(oldChild))?.backend === 'fake');
    const notice = await noticeOf(sid, limited.data.taskId);
    t.ok('上限での切り替えを一行だけ知らせる',
      notice.split('\n').filter(line => /^使用量の上限のため .+ · fast に切り替えて続けています。$/.test(line)).length === 1, notice.slice(0, 500));

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

    await setTiers(['antigravity:gemini-3.8-pro-high', 'fake:fast']);
    const follow = await delegate(sid, { kind: 'trivial', task: 'original request marker' });
    await settle(follow.data.taskId);
    await call(sid, 'ply_task_send', { taskId: follow.data.taskId, message: 'limit-no-reply' });
    const followed = await settle(follow.data.taskId);
    const status = await call(sid, 'ply_task_status', { taskId: follow.data.taskId });
    t.ok('追加指示の上限でも同じ子が元の依頼と追加指示を引き継ぎ、状態ツールで変更を読める',
      followed?.status === 'completed' && followed.sessionId === follow.data.sessionId && followed.result.includes('original request marker')
      && followed.result.includes('limit-no-reply') && status.data?.routing?.target?.backend === 'fake'
      && status.data.routing.attempts.at(-1).continued, JSON.stringify(status.data?.routing));

    await setTiers(['antigravity:gemini-3.8-nano-high', 'antigravity:gemini-3.8-turbo-high']);
    const exhaustedLimit = await delegate(sid, { kind: 'trivial', task: 'limit-no-reply' });
    const limitStop = await settle(exhaustedLimit.data.taskId);
    t.ok('候補がすべて上限なら、同じ子で各候補を一度ずつ試して止まる',
      limitStop?.status === 'failed' && limitStop.sessionId === exhaustedLimit.data.sessionId && limitStop.limit?.resetsAt
      && limitStop.model === 'gemini-3.8-turbo-high' && limitStop.routing?.attempts?.length === 1
      && limitStop.routing.attempts[0].target.model === 'gemini-3.8-nano-high', JSON.stringify(limitStop?.routing));
    const stopped = await noticeOf(sid, exhaustedLimit.data.taskId);
    t.ok('候補が尽きたときは上限と時刻だけ知らせる', stopped.split('\n').some(line => /^使用量の上限で止まりました。.+ に枠が戻ります。$/.test(line)));

    await setTiers(['antigravity:gemini-3.8-mini-high', 'fake:fast']);
    const fixedBySend = await delegate(sid, { kind: 'trivial', task: 'pin with send' });
    await settle(fixedBySend.data.taskId);
    await call(sid, 'ply_task_send', { taskId: fixedBySend.data.taskId, backend: 'antigravity', message: 'limit-no-reply' });
    const fixedSendRow = await settle(fixedBySend.data.taskId);
    t.ok('ply_task_send で同じ実行先を指定しても固定し、上限なら止まる',
      fixedSendRow?.status === 'failed' && fixedSendRow.limit && fixedSendRow.routing?.targetPinned && !fixedSendRow.routing.attempts?.length);

    const fixedLimit = await delegate(sid, { kind: 'trivial', backend: 'antigravity', model: 'gemini-3.8-mini-high', task: 'limit-no-reply' });
    const fixedLimitRow = await settle(fixedLimit.data.taskId);
    t.ok('最初から固定の委譲が上限なら、使える候補があっても同じ実行先で止まる',
      fixedLimitRow?.status === 'failed' && fixedLimitRow.limit && fixedLimitRow.sessionId === fixedLimit.data.sessionId
      && fixedLimitRow.backend === 'antigravity' && !fixedLimitRow.routing?.attempts?.length);

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
    const pinnedBadRow = await settle(pinnedBad.data.taskId);
    t.ok('固定の未掲載モデルも CLI へ渡し、断られたら同じ子で失敗する（別モデルへ替えない）', !pinnedBad.isError
      && pinnedBadRow?.status === 'failed' && pinnedBadRow.model === 'rejected-a' && pinnedBadRow.sessionId === pinnedBad.data.sessionId
      && !(pinnedBadRow.routing?.attempts ?? []).length, JSON.stringify({ model: pinnedBadRow?.model, status: pinnedBadRow?.status, error: pinnedBadRow?.error }));
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
