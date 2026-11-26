// server-devin から分けた後半（サーバー越し）: 実行中の設定の変化の拒否・CLI の終了・中断・途中送信と、上限（limited・rate limit・委譲の子の分の上限）。
// 1 本の suite では、重い PC で suite の時間の上限（180 秒。tests/lib/runner-plan.mjs の suiteLimitMs）を超えたため、判定はそのままに分けた。
// 前半（ターン・再開・履歴・圧縮・文脈・再起動）は server-devin、サーバーを使わない backend の試験は server-devin-backend。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-devin-config';
export const title = 'Devin: fake ACP で実行中の設定変更の拒否・CLI の終了・中断・途中送信・上限と止まった枠';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-server-devin-config-'));
  const cwd = path.join(root, 'project'), nativeConfig = path.join(root, 'native-config');
  await Promise.all([cwd, nativeConfig].map(p => fs.mkdir(p)));
  const devinBin = `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`;
  let server, c;
  const permissions = [];
  try {
    // ---- 実行中の設定の変化・CLI の終了・中断・途中送信（server-devin の 1 つ目のサーバーと同じ設定）
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_ROUTING_USAGE: 'on', AGENT_HOST_DEVIN_BIN: devinBin, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open({ port: server.port, token: server.token, onEvent: async (e, self) => { if (e.type === 'permission') { permissions.push(e); await self.cmd('resolvePermission', { id: e.id, allow: false }); } } });
    for (const marker of ['model', 'thought_level', 'mode']) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}-drift]`, model: 'swe-2-high' });
      t.ok(`実行中の確認済み設定の変更を拒否する（${marker}）`, turn.outcome === 'error');
    }
    // speed は Pleiad が選ばず確かめもしない（ADR 0356）。CLI 側で変わっても、欠けても止めない
    for (const marker of ['speed-drift', 'speed-missing', 'speed-renamed']) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}]`, model: 'swe-2-high' });
      t.ok(`確かめていない speed の変化では止めない（${marker}）`, turn.outcome === 'ok');
    }
    const valid = await c.runTurn({ backend: 'devin', cwd, prompt: '[config-valid]', model: 'swe-2-high' });
    t.ok('完全な同一設定の通知は受け入れる', valid.outcome === 'ok');
    for (const marker of ['config-empty', 'config-invalid', 'speed-duplicate', ...['mode', 'model', 'thought_level'].flatMap(kind => ['missing', 'duplicate', 'renamed'].map(fault => `${kind}-${fault}`))]) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}]`, model: 'swe-2-high' });
      t.ok(`必須設定の不完全な通知を拒否する（${marker}）`, turn.outcome === 'error' && turn.events.filter(e => e.type === 'turnResult').length === 1);
    }
    const dead = await c.runTurn({ backend: 'devin', cwd, prompt: '[kill]', model: 'swe-2-high' });
    t.ok('CLI の終了を失敗として一度だけ確定する', dead.outcome === 'error' && dead.events.filter(e => e.type === 'turnResult').length === 1);
    const from = c.mark();
    const running = c.runTurn({ backend: 'devin', cwd, prompt: '[slow]', model: 'swe-2-high' });
    const active = await c.waitFor(e => e.type === 'session' && e.first === true, { ms: 10000, from });
    await c.cmd('abort', { sessionId: active.sessionId });
    const stopped = await running;
    t.ok('中断は cancel 通知で完了し turnResult は一度だけ', stopped.outcome === 'aborted' && stopped.events.filter(e => e.type === 'turnResult').length === 1);
    // ---- 途中送信（走っている回へ session/prompt を重ねると、同じ回に折り込まれて届く）
    const sm = c.mark();
    const holding = c.runTurn({ backend: 'devin', cwd, prompt: '[slow] first', model: 'swe-2-high' });
    const steerSession = await c.waitFor(e => e.type === 'session' && e.first === true, { ms: 10000, from: sm });
    await c.cmd('sendMessage', { sessionId: steerSession.sessionId, messageId: 'devin-steer-0001', prompt: 'steer-note' });
    const held = await holding;
    const heldText = held.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const umEvents = c.since(sm);
    t.ok('途中送信が同じ回に折り込まれて答えられ、発言の行が出て turnResult は一度だけ',
      heldText.includes('fixture: steer-note')
      && umEvents.some(e => e.type === 'userMessage' && e.messageId === 'devin-steer-0001')
      && held.events.filter(e => e.type === 'turnResult').length === 1 && held.outcome === 'ok', heldText);
    t.ok('受理した発言は pending で出し、呼び出しの決着で userMessage.delivered が届く',
      umEvents.find(e => e.type === 'userMessage' && e.messageId === 'devin-steer-0001')?.pending === true
      && umEvents.some(e => e.type === 'userMessage.delivered' && e.messageId === 'devin-steer-0001'), JSON.stringify(umEvents.filter(e => e.messageId === 'devin-steer-0001')));
    c.close(); c = null;
    await server.stop(); server = null;
    await cleanupTestHolder(path.join(root, 'data'));

    // ---- 上限（server-devin の再起動後のサーバーと同じ設定。委譲の依頼元に fake を使う）
    server = await startServer({ dataDir: path.join(root, 'limits-data'), env: { AGENT_HOST_BACKENDS: 'devin,fake', AGENT_HOST_DEVIN_BIN: devinBin, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open(server);
    for (const stop of ['max-tokens', 'max-turn-requests']) {
      const stopped = await c.runTurn({ backend: 'devin', cwd, prompt: `[${stop}]`, model: 'swe-2-high' });
      const result = stopped.events.find(e => e.type === 'turnResult');
      t.ok(`${stop} の上限はエラーや解除時刻を足さず limited のまま`, stopped.outcome === 'limited' && !result.error && result.resetsAt === null);
    }

    await c.cmd('setDelegationRouting', { settings: { tiers: { t3: ['devin:swe-2-high'] } } });
    await c.cmd('delegationRouting', { refresh: true });
    const limitBefore = Date.now();
    const limitTurn = await c.runTurn({ backend: 'devin', cwd, prompt: '[rate-limit] pause', model: 'swe-2-high' });
    const limitResult = limitTurn.events.find(e => e.type === 'turnResult');
    t.ok('provider の一時的な rate limit は有限の解除時刻つき limited になる',
      limitTurn.outcome === 'limited' && Number.isFinite(limitResult?.resetsAt) && limitResult.resetsAt >= limitBefore + 5000 && limitResult.resetsAt <= Date.now() + 5000,
      JSON.stringify(limitResult));
    const routeState = await c.cmd('delegationRouting');
    const heldCandidate = routeState.candidates.find(x => x.candidate === 'devin:swe-2-high');
    // 戻す時刻は告げられた見込み以上で、短い見込み（5 秒）でも最低 1 分は外す（core/slot-limits.mjs）
    const heldUntil = Date.parse(heldCandidate?.until);
    t.ok('制限中の同じモデルを自動選択の候補から外し、戻す時刻を示す（短い見込みでも最低 1 分）', heldCandidate?.reason === 'recently_limited' && heldUntil >= limitResult.resetsAt && heldUntil >= limitBefore + 60_000, JSON.stringify(heldCandidate));
    const followFrom = c.mark(), followId = 'devin-limit-followup';
    await c.cmd('sendMessage', { sessionId: limitTurn.sessionId, messageId: followId, prompt: 'after cooldown' });
    const queued = (await c.cmd('listMessages', { sessionId: limitTurn.sessionId })).find(x => x.id === followId);
    t.ok('解除前の次の指示も先回りして止めず、送信待ちの「上限」で保持しない（ADR 0352）', queued?.waiting?.reason !== 'limit', JSON.stringify(queued));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === limitTurn.sessionId && e.outcome === 'ok', { from: followFrom, ms: 15000 });
    const recovered = await c.cmd('loadSession', { sessionId: limitTurn.sessionId });
    const userTexts = recovered.messages.filter(x => x.role === 'user').map(x => x.text);
    t.ok('次の指示を解除前でも一度だけ送り、失敗した最初の指示は送り直さない', userTexts.filter(x => x === 'after cooldown').length === 1 && userTexts.filter(x => x.endsWith('[rate-limit] pause')).length === 1 && userTexts.length === 2, JSON.stringify(userTexts.map(x => x.slice(-40))));
    // 止まった枠の記録（slot-limits）は、実際に断られた枠だけ。同じ枠のターンが通れば外す（送信を止める仕組みではない。ADR 0302・0352）
    const recoveredRouting = await c.cmd('delegationRouting');
    t.ok('次の指示が通った後は、同じモデルの制限による除外を外す', recoveredRouting.candidates.find(x => x.candidate === 'devin:swe-2-high')?.reason !== 'recently_limited');

    // ---- 委譲の子が「N minutes」の上限で止まった（Issue #111）。日次・週次は 0% のままでも、通知・使用量・自動の振り分けに止まった枠が出る
    const pc = await open({ port: server.port, token: server.token, autoAllow: true });
    try {
      const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
      // 依頼元の会話（fake）から Pleiad の MCP ツールを 1 回呼び、その会話に届いた tool.result を返す
      const callTool = async (name, args) => {
        const from = pc.mark();
        const turn = await pc.runTurn({ backend: 'fake', cwd, prompt: ply(name, args) });
        return pc.waitFor(e => e.type === 'tool.result' && e.sessionId === turn.sessionId, { from, ms: 60000 });
      };
      const childFrom = Date.now();
      const pinned = await callTool('ply_delegate', { kind: 'implement', backend: 'devin', model: 'swe-2-high', task: '[rate-limit-minutes] child' });
      const taskId = JSON.parse(pinned.text).taskId;
      let row;
      for (let i = 0; i < 1200 && !(row?.status === 'failed' && row.notification === 'sent'); i++) { row = (await pc.cmd('agentTasks')).find(x => x.taskId === taskId); await sleep(50); }
      const childReset = typeof row?.limit?.resetsAt === 'number' ? row.limit.resetsAt : Date.parse(row?.limit?.resetsAt);
      t.ok('分の形（reset in 3 minutes）の上限も limited になり、委譲の記録に解除の見込みと止まった枠を残す',
        row?.status === 'failed' && childReset >= childFrom + 170_000 && childReset <= Date.now() + 190_000
          && row.limit.backend === 'devin' && row.limit.model === 'swe-2-high', JSON.stringify(row?.limit ?? row));
      const parent = await pc.cmd('loadSession', { sessionId: pinned.sessionId });
      const notice = parent.messages.filter(m => m.internalTaskNotice).map(m => m.text).join('\n');
      t.ok('固定の子が上限で止まったときは、解除の見込みを一行だけ知らせる',
        /^(使用量の上限で止まりました。.+ に枠が戻ります。|Stopped at a usage limit\. The quota resets at .+\.)$/.test(notice), notice.slice(0, 600));

      const usage = await pc.cmd('providerUsage', { backend: 'devin' });
      const heldSlot = usage.held?.find(x => x.model === 'swe-2-high');
      t.ok('使用量（providerUsage の held）に止まった枠と戻す時刻を出す',
        heldSlot?.reason === 'recently_limited' && Date.parse(heldSlot.until) >= childReset, JSON.stringify(usage.held));

      await pc.cmd('setDelegationRouting', { settings: { tiers: { t1: ['devin:swe-2-high'], t2: ['devin:swe-2-high'], t3: ['devin:swe-2-high'], t4: ['devin:swe-2-high'] } } });
      await pc.cmd('delegationRouting', { refresh: true });
      const auto = await callTool('ply_delegate', { kind: 'implement', task: 'after the limit' });
      const skipLine = /^- devin:swe-2-high \(t\d\): recently_limited until (\S+)$/m.exec(auto.text ?? '');
      t.ok('backend を省いた ply_delegate は止まった枠を選ばず、飛ばした理由と戻す時刻を返す',
        auto.isError === true && skipLine?.[1] === heldSlot?.until && (await pc.cmd('agentTasks')).filter(x => x.backend === 'devin').length === 1, auto.text?.slice(0, 600));
    } finally { pc.close(); }
  } finally {
    c?.close(); await server?.stop();
    await cleanupTestHolder(path.join(root, 'data')); await cleanupTestHolder(path.join(root, 'limits-data'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
