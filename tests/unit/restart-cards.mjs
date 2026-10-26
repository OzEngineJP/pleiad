// 段 3（ADR 0270 の ②）: 承認・質問のカードを、サーバーを普通に止めて起こし直しても失わないことを確かめる。
// 止め方は引き継ぎ（handover）ではなく、普通に止めて普通に起こす（SIGTERM → 5 秒で SIGKILL。tests/lib/restart.mjs）。
// 起こし直したサーバーは、起動で保持役の子の札と記録からターンを拾う（restoreTurn → adoptTurn。AGENT_HOST_ADOPT_HOLDER=1 は仕掛けが渡す）。
//
//   1. 保持役に載ったターンの承認待ち: 同じ id のカードが出直し、答えるとターンが続く（答えは保持役の子の控えへ届く）
//   2. 保持役に載らないターンの承認待ち: カードは出直さないが、黙って消えず「止めたもの」（stops の approvals）として会話に届く
//   3. ターンの外の待ち（outlivesTurn。Chrome の接続・ログインの代わりに fake_handoff）: 取り下げが stops の waits として会話に届く
//   4. 設定の変更の承認（detached）: カードの行は消え、台帳（setting-approvals）の「取り下げ（再起動）」が会話に届く
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readWaitingCards } from '../lib/data-store.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-cards';
export const title = '途中でサーバーを止めて起こし直す: 承認・質問のカード（保持役のターンは同じ id で出直す・載らないものとターンの外の待ちは取り下げを会話へ）';

const WAIT_MS = 30_000;
const steps = list => `held:steps:${JSON.stringify({ steps: list })}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}
const control = (name, args) => 'control:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-cards-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_RUNTIME_ROOT: root };
  // 環境変数で入っている仕掛け（PLEIAD_TEST_RESTART）は外し、この suite は明示的に起こし直す
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  let holderPid = null, server = null, c = null;
  const childPids = new Set();
  try {
    // 保持役を先に起こしておく（detached。サーバーが入れ替わっても子は残る）
    const found = await ensureHolder({ dataDir, root, idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // 設定の変更の承認（シナリオ 4）を guarded にする（既定は確認しない）。startServer は既存の prefs.json を残す
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ confirmAgentSites: true }));
    server = await startServer({ env, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token });
    const seed = async () => (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:seed' }, { ms: WAIT_MS })).sessionId;
    const cardRows = () => readWaitingCards(dataDir);
    const waitTurnEnd = (sessionId, from) => c.waitFor(event => event.type === 'turnEnd' && event.sessionId === sessionId, { ms: WAIT_MS, from });

    // ---- 1. 保持役に載ったターンの承認待ち
    {
      const sessionId = await seed();
      const from = c.mark();
      const prompt = steps([
        { tool: 'Read', input: { path: 'held-a.txt' }, ask: true, result: 'approved held', ms: 10 },
        { text: 'held done' },
      ]);
      await c.cmd('sendMessage', { sessionId, messageId: 'restart-cards-held-0001', prompt });
      const first = await c.waitFor(event => event.type === 'permission' && event.sessionId === sessionId && event.toolName === 'Read', { from, ms: WAIT_MS });
      const held = await until(async () => (await c.cmd('running')).turns.find(turn => turn.sessionId === sessionId)?.held ? true : null, WAIT_MS, 'held のターン');
      assert.ok(held, 'ターンが保持役に載っている');
      assert.ok(cardRows().some(row => row.id === first.id), 'カードの行が DB にある');

      server = await controller.restart();
      assert.equal(controller.restarts, 1);
      // 起こし直したサーバーが、答えていない同じ承認を聞き直す（id はツールの id から決まる同じ値）
      const again = await c.waitFor(event => event.type === 'permission' && event.sessionId === sessionId && event.id === first.id, { from, ms: WAIT_MS });
      assert.equal(again.id, first.id, '同じ id のカードが出直す');
      await c.cmd('resolvePermission', { id: again.id, allow: true });
      const end = await waitTurnEnd(sessionId, from);
      const loaded = await c.cmd('loadSession', { sessionId });
      t.ok('保持役のターンの承認待ち: 起こし直しても同じ id のカードが出直し、答えるとターンが最後まで続く',
        end.outcome === 'ok' && loaded.messages.some(message => message.role === 'assistant' && String(message.text).includes('held done')),
        JSON.stringify({ end, messages: loaded.messages.map(message => [message.role, message.text]) }));
      t.ok('答えた承認のツールの結果が履歴に 1 回だけ載る',
        loaded.messages.flatMap(message => message.toolCalls ?? []).filter(call => call.result?.text === 'approved held').length === 1);
      await until(() => !cardRows().some(row => row.id === first.id), 10_000, '決着したカードの行が消える');
      t.ok('答えたカードの行は DB から消える', !cardRows().some(row => row.id === first.id));
    }

    // ---- 2. 保持役に載らないターンの承認待ち: 取り下げを stops に残す
    {
      const sessionId = await seed();
      const from = c.mark();
      await c.cmd('sendMessage', { sessionId, messageId: 'restart-cards-ask-0001', prompt: 'ask' });
      const card = await c.waitFor(event => event.type === 'permission' && event.sessionId === sessionId && event.toolName === 'fake_write', { from, ms: WAIT_MS });
      await until(() => cardRows().some(row => row.id === card.id), 10_000, 'カードの行');
      server = await controller.restart();
      assert.equal(controller.restarts, 2);
      await until(() => !cardRows().some(row => row.id === card.id), 10_000, '取り下げた行が消える');
      const stops = readSessions(dataDir)[sessionId]?.stops;
      t.ok('載らないターンのカードは、黙って消えず stops の approvals に残る',
        stops?.approvals?.some(item => item.key === `ap:${card.id}` && item.tool === 'fake_write' && item.target === 'a.txt'), JSON.stringify(stops));
      const noteFrom = c.mark();
      await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:after-ask', sessionId }, { ms: WAIT_MS });
      const note = c.since(noteFrom).find(event => event.type === 'interruptionNote' && event.sessionId === sessionId);
      t.ok('次のターンの始めに、取り下げた承認が会話へ届く', Boolean(note) && note.text.includes('fake_write') && note.text.includes('a.txt'), note?.text);
    }

    // ---- 3. ターンの外の待ち（outlivesTurn）: 取り下げを stops の waits に残す
    {
      const sessionId = await seed();
      const from = c.mark();
      await c.cmd('sendMessage', { sessionId, messageId: 'restart-cards-outlives-0001', prompt: 'outlives:{"open":{}}' });
      const card = await c.waitFor(event => event.type === 'permission' && event.sessionId === sessionId && event.toolName === 'fake_handoff', { from, ms: WAIT_MS });
      await waitTurnEnd(sessionId, from);
      const waiting = await c.cmd('running');
      assert.ok(waiting.permissions.some(permission => permission.id === card.id && permission.outlivesTurn === true), 'ターンの外の待ちとして残っている');
      server = await controller.restart();
      assert.equal(controller.restarts, 3);
      await until(() => !cardRows().some(row => row.id === card.id), 10_000, '取り下げた行が消える');
      const stops = readSessions(dataDir)[sessionId]?.stops;
      t.ok('ターンの外の待ちは、取り下げが stops の waits に残る（黙って消えない）',
        stops?.waits?.some(item => item.key === `wait:${card.id}` && item.tool === 'fake_handoff'), JSON.stringify(stops));
      const noteFrom = c.mark();
      await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:after-wait', sessionId }, { ms: WAIT_MS });
      const note = c.since(noteFrom).find(event => event.type === 'interruptionNote' && event.sessionId === sessionId);
      t.ok('次のターンの始めに、ターンの外の待ちを取り下げたことが会話へ届く', Boolean(note) && note.text.includes('fake_handoff'), note?.text);
    }

    // ---- 4. 設定の変更の承認（detached）: 台帳の「取り下げ（再起動）」が届き、カードの行は消える
    {
      const sessionId = await seed();
      const from = c.mark();
      const turn = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: control('set_setting', { key: 'confirmAgentSites', value: false, reason: 'テスト' }), sessionId }, { ms: WAIT_MS });
      const card = await c.waitFor(event => event.type === 'permission' && event.sessionId === sessionId && event.settingChange, { from, ms: WAIT_MS });
      assert.equal(turn.outcome, 'ok');
      await until(() => cardRows().some(row => row.id === card.id && row.detached === true), 10_000, '設定のカードの行');
      const after = c.mark();
      server = await controller.restart();
      assert.equal(controller.restarts, 4);
      // 届けは起動直後の新しいターンで会話に入る。画面の taskNotice は接続し直す前だと取りこぼすので、履歴で確かめる
      const notice = await until(async () => {
        const loaded = await c.cmd('loadSession', { sessionId });
        return loaded.messages.find(message => message.role === 'user' && String(message.text).includes(card.settingChange.requestId)) ?? null;
      }, WAIT_MS, '設定の変更の承認の取り下げが会話に届く');
      t.ok('設定の変更の承認は、起動で「取り下げ（再起動）」を会話へ届ける（今までどおり）', /取り下げ/.test(notice.text) && /再起動/.test(notice.text), notice.text);
      await until(() => !cardRows().some(row => row.id === card.id), 10_000, '設定のカードの行が消える');
      t.ok('設定の変更のカードの行は残らない（出し直さない）', !cardRows().some(row => row.id === card.id));
      await c.waitFor(event => event.type === 'turnEnd' && event.sessionId === sessionId, { from: after, ms: WAIT_MS }).catch(() => null);
    }

    assert.ok(!server.tail(300).includes('[unhandledRejection]'), server.tail(20));
    assert.deepEqual(controller.errors, [], '起こし直しの間に、仕掛けの中の失敗が無い');
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    // 保持役を終わらせる（子も木ごと止まる）
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      for (const child of probe?.welcome.children ?? []) if (child.pid) childPids.add(child.pid);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
    }
    for (const pid of childPids) await until(() => !alive(pid), 10_000, `子（${pid}）が終わる`).catch(() => {});
    uninstallRestartMode();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
