// 自動の振り分けの子が仕事を始める前に断られたら、次の候補へ任せ直す（ADR 0302）をサーバー全体で確かめる。
// 委譲先は偽の agy（tests/lib/fake-agy.mjs: limit-no-reply は返事の前に上限で断る・error-body は本文を書いてから失敗・
// limit-after-reply は返事を終えてから上限なので、返事は結果として残る）と手元の偽物（fail・fail-auth tool）。
// 本物の自動選択のサービス・LLM へは送らない
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-reroute';
export const title = '委譲の再振り分け: 上限なら同じ子で継続し、仕事前のエラーなら次の候補で再試行する';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const slash = p => String(p ?? '').replaceAll('\\', '/');
// Windows では裏の git（状態の読み取り）が .git を一瞬掴み、名前の付け替えが EPERM / EBUSY になる。少し待って付け替え直す
const renameRetry = async (from, to) => {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to); }
    catch (e) { if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e; await sleep(100); }
  }
};

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-reroute-'));
  const repo = path.join(scratch, 'repo');
  const gateDir = path.join(scratch, 'gates');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(gateDir, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');
  const server = await startServer({ dataDir: scratch, env: {
    AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"`,
    AGENT_HOST_FAKE_GATE_DIR: gateDir, AGENT_HOST_WORKTREES: 'on', AGENT_HOST_WORKTREE_GRACE_MS: '0',
    FAKE_AGY_EXTRA_MODELS: 'gemini-3.8-flash-high,gemini-3.8-pro-high,gemini-3.8-mini-high,gemini-3.8-nano-high,gemini-3.8-turbo-high,gemini-3.8-iso-high,gemini-3.8-keep-high',
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
    // fake-agy の使用量は Claude 系の 5 時間枠が残り 0 だが、使用率だけでは先に断らない（ADR 0352）。上の段の Claude 系も一度試し、
    // 実際に断られてから次の候補（fake:fast）へ移る。断られた回は順に残り、使用率を理由にした除外（quota_full）は残らない
    t.ok('routing.attempts に、断られた回（委譲先・会話・limited）が順に残る', attempts.length === 2
      && attempts[0].target?.backend === 'antigravity' && attempts[0].target?.model === 'gemini-3.8-flash-high'
      && attempts[1].target?.backend === 'antigravity' && attempts[1].target?.model === 'claude-opus-4-6-thinking'
      && attempts.every(a => a.sessionId === oldChild && a.outcome === 'limited' && a.continued), JSON.stringify(attempts));
    t.ok('使用率が 100% の枠を、quota_full で先に除かない', !(done?.routing?.skipped ?? []).some(x => x.reason === 'quota_full'),
      JSON.stringify(done?.routing?.skipped));
    t.ok('振り分けは、止まった候補を recently_limited で飛ばした記録を持つ',
      (done?.routing?.skipped ?? []).some(x => x.candidate === 'antigravity:gemini-3.8-flash-high' && x.reason === 'recently_limited'),
      JSON.stringify(done?.routing?.skipped));
    t.ok('子の会話は同じ id のまま新しい実行先に切り替わる', (await sessionMeta(oldChild))?.backend === 'fake');
    const notice = await noticeOf(sid, limited.data.taskId);
    t.ok('上限での切り替えを一行だけ知らせる',
      notice.split('\n').filter(line => /^使用量の上限のため .+ · fast に切り替えて続けています。$/.test(line)).length === 1, notice.slice(0, 500));

    // ---- isolate の子が上限で切り替わっても、同じ worktree のまま続ける。終わったら決まりどおり片付く
    const isoParent = (await c.cmd('newSession', { backend: 'fake', cwd: repo })).sessionId;
    // 上の節で上限になった flash-high は recently_limited で飛ばされるので、この節だけで使うモデルを先頭に置く
    await setTiers(['antigravity:gemini-3.8-iso-high', 'fake:fast']);
    const isoFrom = c.mark();
    const iso = await delegate(isoParent, { kind: 'trivial', task: 'limit-no-reply\nHOLD_TURN:iso-switch', isolate: true });
    const wt0 = iso.data?.worktree;
    t.ok('（準備）isolate の子に worktree ができ、最初の委譲先は agy', Boolean(wt0?.id && wt0.path && wt0.branch) && iso.data?.backend === 'antigravity',
      JSON.stringify({ wt0, backend: iso.data?.backend, model: iso.data?.model }));
    let isoMid;
    for (let i = 0; i < 1200 && !(isoMid?.backend === 'fake' && isoMid.status === 'running'); i++) { isoMid = await rowOf(iso.data.taskId); await sleep(50); }
    const isoMidStatus = await call(isoParent, 'ply_task_status', { taskId: iso.data.taskId });
    const isoMidChild = await sessionMeta(iso.data.sessionId);
    t.ok('切り替えの間も ply_task_status は同じ worktree を「片付け済み」でなく返し、2 つ目の委譲先はその場所で動く',
      isoMid?.worktree?.id === wt0.id && slash(isoMid.cwd) === slash(wt0.path) && slash(isoMidChild?.cwd) === slash(wt0.path)
      && isoMidStatus.data?.workspace?.state && isoMidStatus.data.workspace.state !== 'gone'
      && slash(isoMidStatus.data.workspace.path) === slash(wt0.path),
      JSON.stringify({ row: isoMid && { worktree: isoMid.worktree, cwd: isoMid.cwd }, childCwd: isoMidChild?.cwd, workspace: isoMidStatus.data?.workspace }));
    const isoBeforeRelease = c.mark();
    await fs.writeFile(path.join(gateDir, 'iso-switch'), '');
    const isoDone = await settle(iso.data.taskId);
    const isoEvents = c.since(isoFrom);
    const isoPreReleaseEvents = isoEvents.slice(0, isoBeforeRelease - isoFrom);
    const isoPathExists = wt0?.path ? await fs.stat(wt0.path).then(s => s.isDirectory(), () => false) : false;
    const isoBranches = wt0 ? sh(repo, 'branch', '--list', wt0.branch) : '';
    t.ok('切り替えの後もタスクの worktree と cwd は最初の場所のまま',
      isoDone?.status === 'completed' && isoDone.sessionId === iso.data.sessionId && isoDone.backend === 'fake'
      && (isoDone.routing?.attempts ?? []).some(a => a.outcome === 'limited' && a.continued)
      && isoDone.worktree?.id === wt0.id && slash(isoDone.worktree?.path) === slash(wt0.path) && slash(isoDone.cwd) === slash(wt0.path),
      JSON.stringify({ status: isoDone?.status, worktree: isoDone?.worktree, cwd: isoDone?.cwd, wt0 }));
    t.ok('切り替えで子の会話の cwd を元の場所へ戻さない（worktreeBack が無い）',
      !isoPreReleaseEvents.some(e => e.type === 'cwd' && e.sessionId === iso.data.sessionId && e.reasonKey === 'worktreeBack'),
      JSON.stringify(isoPreReleaseEvents.filter(e => e.type === 'cwd' && e.sessionId === iso.data.sessionId)));
    t.ok('次の委譲先に渡した指示は、タスクの今の worktree を指す',
      Boolean(isoDone?.result && isoDone.worktree?.path && isoDone.result.includes(isoDone.worktree.path)), String(isoDone?.result ?? '').slice(0, 500));
    t.ok('変わっていなければ、完了の片付けでフォルダーとブランチが消える',
      isoDone?.workspace?.removed === true && !isoPathExists && !isoBranches.includes(wt0.branch),
      JSON.stringify({ workspace: isoDone?.workspace, isoPathExists, isoBranches }));

    // ---- 切り替えの後に worktree を変えた子は、完了しても残って「未取り込み」になる
    await setTiers(['antigravity:gemini-3.8-keep-high', 'fake:fast']);
    const keep = await delegate(isoParent, { kind: 'trivial', task: 'limit-no-reply\nHOLD_TURN:iso-keep', isolate: true });
    const wt1 = keep.data?.worktree;
    t.ok('（準備）2 つ目の isolate の子も agy から始まる', Boolean(wt1?.id) && keep.data?.backend === 'antigravity', JSON.stringify({ wt1, backend: keep.data?.backend }));
    let keepMid;
    for (let i = 0; i < 1200 && !(keepMid?.backend === 'fake' && keepMid.status === 'running'); i++) { keepMid = await rowOf(keep.data.taskId); await sleep(50); }
    if (wt1?.path) await fs.writeFile(path.join(wt1.path, 'changed.txt'), 'changed\n');
    await fs.writeFile(path.join(gateDir, 'iso-keep'), '');
    const keepDone = await settle(keep.data.taskId);
    const keepStatus = await call(isoParent, 'ply_task_status', { taskId: keep.data.taskId });
    const keepExists = wt1?.path ? await fs.stat(wt1.path).then(s => s.isDirectory(), () => false) : false;
    t.ok('変わっていれば、完了しても同じ worktree が残り「未取り込み」になる',
      keepDone?.status === 'completed' && keepDone.backend === 'fake' && keepDone.worktree?.id === wt1?.id
      && (keepDone.routing?.attempts ?? []).some(a => a.outcome === 'limited' && a.continued) && slash(keepDone.cwd) === slash(wt1?.path)
      && keepDone.workspace?.state === 'unmerged' && keepDone.workspace.removed === false && keepExists
      && sh(repo, 'branch', '--list', wt1.branch).includes(wt1.branch)
      && keepStatus.data?.workspace?.state === 'unmerged' && slash(keepStatus.data.workspace.path) === slash(wt1.path),
      JSON.stringify({ status: keepDone?.status, worktree: keepDone?.worktree, cwd: keepDone?.cwd, workspace: keepDone?.workspace, keepExists, statusWs: keepStatus.data?.workspace }));

    // ---- 仕事前のエラーで新しい子の会話へ任せ直しても（run.reroute）、同じ worktree を使い、終わったら前の子の会話の分も外して片付ける
    await setTiers(['fake:fast', 'fake:smart']);
    const isoFail = await delegate(isoParent, { kind: 'trivial', task: 'fail', isolate: true });
    const wt2 = isoFail.data?.worktree;
    const isoFailRow = await settle(isoFail.data.taskId);
    const firstChild = await sessionMeta(isoFail.data.sessionId);
    const wt2Exists = wt2?.path ? await fs.stat(wt2.path).then(s => s.isDirectory(), () => false) : false;
    t.ok('任せ直した子も同じ worktree で動き、終わったら前の子の会話を元の場所へ戻して消す',
      Boolean(wt2?.id) && isoFailRow?.status === 'failed' && isoFailRow.sessionId !== isoFail.data.sessionId
      && isoFailRow.routing?.attempts?.length === 1 && isoFailRow.worktree?.id === wt2.id && slash(isoFailRow.cwd) === slash(wt2.path)
      && isoFailRow.workspace?.removed === true && !wt2Exists && slash(firstChild?.cwd) === slash(repo),
      JSON.stringify({ status: isoFailRow?.status, worktree: isoFailRow?.worktree, cwd: isoFailRow?.cwd, workspace: isoFailRow?.workspace, wt2Exists, firstCwd: firstChild?.cwd }));

    // ---- 片付いた作業場所を作り直せないときは、元の場所で走らせず失敗で返す
    await renameRetry(path.join(repo, '.git'), path.join(repo, 'git-disabled'));
    const renewSend = await call(isoParent, 'ply_task_send', { taskId: iso.data.taskId, message: 'echo:should-not-run' });
    t.ok('（準備）片付け済みの子へ追加の指示を積める', !renewSend.isError, renewSend.text.slice(0, 300));
    const renewRow = await settle(iso.data.taskId);
    t.ok('作業場所を作り直せない追加の指示は失敗になり、子の返事は走らない',
      renewRow?.status === 'failed' && /worktree.*作り直せなかった/.test(renewRow.error ?? '') && !String(renewRow.result ?? '').includes('should-not-run'),
      JSON.stringify({ status: renewRow?.status, error: renewRow?.error, result: renewRow?.result }));

    // ---- 片付いた子へ人が直接送ったとき（外から起きたターン。ADR 0355）も、作り直せなければ元の場所で走らせない。
    // 発言は送信待ちに「送れなかった」で残り、作り直せなかった理由と次にすることが出る。タスクの行は起こす前のまま
    const isoChild = iso.data.sessionId;
    // 上の失敗の知らせが依頼元へ届くのを待ってから比べる（届く途中だと通知の状態が並行して動く）
    await noticeOf(isoParent, iso.data.taskId);
    const humanRowBefore = await rowOf(iso.data.taskId);
    const humanFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: isoChild, messageId: 'renew-human-0001', prompt: 'echo:human-after-fix' });
    let humanItem;
    for (let i = 0; i < 400 && !['failed', 'sent', 'unknown'].includes(humanItem?.status); i++) {
      humanItem = (await c.cmd('listMessages', { sessionId: isoChild })).find(m => m.id === 'renew-human-0001');
      await sleep(50);
    }
    for (let i = 0; i < 100 && (await c.cmd('running')).turns.some(x => x.sessionId === isoChild); i++) await sleep(50);
    const humanEvents = c.since(humanFrom).filter(e => e.sessionId === isoChild);
    const humanReplied = (await c.cmd('loadSession', { sessionId: isoChild })).messages.some(m => m.role === 'assistant' && String(m.text ?? '').includes('human-after-fix'));
    const humanRowAfter = await rowOf(iso.data.taskId);
    t.ok('作業場所を作り直せないとき、人の発言のターンは元の場所で走らない',
      !humanReplied && !humanEvents.some(e => ['text.delta', 'turnEnd'].includes(e.type)),
      JSON.stringify({ humanReplied, events: humanEvents.map(e => e.type).slice(0, 20), childCwd: (await sessionMeta(isoChild))?.cwd }));
    t.ok('発言は送信待ちに「送れなかった」で残り、作り直せなかった理由（git でない）と次にすることが出る',
      humanItem?.status === 'failed' && humanItem.args?.prompt === 'echo:human-after-fix'
      && /作り直せなかった/.test(humanItem.error ?? '') && /git のリポジトリではない/.test(humanItem.error ?? '') && /再送/.test(humanItem.error ?? ''),
      JSON.stringify(humanItem));
    t.ok('始まらなかったので、タスクの行（状態・通知・出来事）は起こす前のまま',
      humanRowAfter?.status === humanRowBefore?.status && humanRowAfter?.notification === humanRowBefore?.notification
      && (humanRowAfter?.events ?? []).length === (humanRowBefore?.events ?? []).length && humanRowAfter?.worktree?.id === humanRowBefore?.worktree?.id,
      JSON.stringify({ before: { s: humanRowBefore?.status, n: humanRowBefore?.notification, e: humanRowBefore?.events?.length }, after: { s: humanRowAfter?.status, n: humanRowAfter?.notification, e: humanRowAfter?.events?.length } }));
    await renameRetry(path.join(repo, 'git-disabled'), path.join(repo, '.git'));

    // ---- 直してから［再送する］と、今までどおり作業場所を作り直してから走り、タスクが動いて終わる
    const retryFrom = c.mark();
    await c.cmd('messageAction', { sessionId: isoChild, messageId: 'renew-human-0001', action: 'retry' });
    let retried;
    for (let i = 0; i < 1200 && !(retried?.status === 'completed' && String(retried.result ?? '').includes('human-after-fix')); i++) { retried = await rowOf(iso.data.taskId); await sleep(50); }
    const retriedCwd = c.since(retryFrom).find(e => e.type === 'cwd' && e.sessionId === isoChild && e.reasonKey === 'worktreeSplit')?.cwd ?? null;
    const retriedItem = (await c.cmd('listMessages', { sessionId: isoChild })).find(m => m.id === 'renew-human-0001');
    t.ok('作り直せるようになって再送すると、新しい worktree を作ってから走り、タスクが完了する',
      retried?.status === 'completed' && Boolean(retriedCwd) && slash(retriedCwd) !== slash(repo) && slash(retriedCwd) !== slash(wt0.path)
      && retried.worktree?.id && retried.worktree.id !== wt0.id && slash(retried.cwd) === slash(retriedCwd) && (!retriedItem || retriedItem.status === 'sent'),
      JSON.stringify({ status: retried?.status, cwd: retried?.cwd, worktree: retried?.worktree, retriedCwd, item: retriedItem?.status }));

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
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
