import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, writeSessions } from '../lib/data-store.mjs';
import { seedClaudeAccount } from '../lib/claude-account-seed.mjs';

export const name = 'server-limit-resume';
export const title = '上限で中断しても先回りで止めない（ADR 0352）。止まった後に送った指示も人の「再開」も、解除時刻の前に普通に送られ、まだ上限なら実際に断られてまた止まる。古い自動再開の予定と印は読まない';

const HOUR = 3_600_000;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-limit-'));
  const dataDir = path.join(scratch, 'data');
  const codexState = path.join(scratch, 'codex');
  await fs.mkdir(codexState);
  const launch = () => startServer({ env: { AGENT_HOST_BACKENDS: 'fake,codex', AGENT_HOST_FAKE_GATE_DIR: scratch,
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_STATE_DIR: codexState }, dataDir });
  let server = await launch();
  t.ok('fake サーバーを起動', Number.isFinite(server.port), server.tail());
  let c = await open({ port: server.port, token: server.token, autoAllow: true });
  t.ok('fake サーバーに接続', Boolean(c.ready));
  const op = (name, args = {}) => c.cmd('invoke', { op: name, args });
  const info = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  const userTexts = async id => (await c.cmd('loadSession', { sessionId: id })).messages.filter(m => m.role === 'user').map(m => m.text);
  const newSession = async () => (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
  const idle = async id => (await c.cmd('running')).turns.every(x => x.sessionId !== id);
  const itemOf = async (sessionId, messageId) => (await c.cmd('listMessages', { sessionId })).find(m => m.id === messageId);
  try {
    // ---- 1. 上限で止まった会話は、予定を置かず、送信も止めない。解除時刻の前に送った指示は、普通にすぐ送られる
    const sessionId = await newSession();
    t.ok('会話を作成', Boolean(sessionId), sessionId);
    const resetsAt = Date.now() + 3 * HOUR;
    const from = c.mark();
    const result = await c.runTurn({ sessionId, prompt: `limit ${resetsAt}` }, { ms: 3000 })
      .catch(err => { throw new Error(`${err.message}\n${JSON.stringify(c.since(from))}\n${server.tail()}`); });
    const end = c.since(from).find(e => e.type === 'turnEnd' && e.sessionId === sessionId);
    t.ok('上限は完了・失敗ではなく limited', result.outcome === 'limited' && end?.interrupted?.reason === 'limit', JSON.stringify(end));
    t.ok('解除時刻と枠が会話に残り（表示だけの情報）、自動再開の印は付かない', end.interrupted.resetsAt === resetsAt && end.interrupted.window === 'five_hour' && !('autoResume' in end.interrupted));
    t.ok('完了通知は出ない', !c.since(from).some(e => e.type === 'completionReady' && e.sessionId === sessionId));
    t.ok('再開の予定を置かない', (await op('sessions.schedules', { sessionId })).length === 0);
    t.ok('上限の会話の自動再開の切り替え（sessions.setAutoResume）は無い', await op('sessions.setAutoResume', { sessionId, enabled: false }).then(() => false, () => true));

    const id = 'limitqueued0001';
    const sendFrom = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId: id, prompt: 'echo:after-reset' });
    const again = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from: sendFrom, ms: 10000 });
    const sentItem = await itemOf(sessionId, id);
    const messages = await userTexts(sessionId);
    t.ok('解除時刻の前でも、送った指示は送信待ちにならずすぐ送られる', again.interrupted === null && sentItem?.status === 'sent' && !sentItem.waiting
      && messages.filter(x => x === 'echo:after-reset').length === 1, JSON.stringify({ sentItem, messages }));
    t.ok('最初の上限を出した指示は送り直さず、続けての文も足さない', messages.length === 2 && messages.filter(x => x === `limit ${resetsAt}`).length === 1, JSON.stringify(messages));

    // 送ってもまだ上限なら、実際に断られてまた止まる（先回りでは止めない）
    const still = await newSession();
    await c.runTurn({ sessionId: still, prompt: `limit ${Date.now() + 3 * HOUR}` });
    const stillResetsAt = Date.now() + 4 * HOUR;
    const stillAgain = await c.runTurn({ sessionId: still, prompt: `limit ${stillResetsAt}` }, { ms: 3000 });
    t.ok('まだ上限のまま送ると、また limited で止まる（解除時刻は新しい失敗のもの）', stillAgain.outcome === 'limited'
      && (await info(still)).interrupted?.reason === 'limit' && (await info(still)).interrupted.resetsAt === stillResetsAt);

    // ---- 2. 何も送っていない会話は、解除時刻を過ぎても自分では動かない。人の「再開」で続く
    const manual = await newSession();
    await c.runTurn({ sessionId: manual, prompt: `limit ${Date.now() + 1500}` });
    await sleep(2300);
    t.ok('解除時刻を過ぎても自動では再開しない', (await info(manual)).interrupted?.reason === 'limit' && await idle(manual)
      && (await userTexts(manual)).length === 1);
    const manualFrom = c.mark();
    const manualResult = await op('sessions.resume', { sessionId: manual });
    t.ok('解除の後は人の「再開」が効く', manualResult.sent === 'text');
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === manual && e.outcome === 'ok', { from: manualFrom, ms: 10000 });
    t.ok('再開すると中断の印が消える', (await info(manual)).interrupted === null);

    const early = await newSession();
    await c.runTurn({ sessionId: early, prompt: `limit ${Date.now() + 3 * HOUR}` });
    const earlyFrom = c.mark();
    t.ok('解除時刻の前でも、人の「再開」は断られず送られる', (await op('sessions.resume', { sessionId: early })).sent === 'text');
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === early && e.outcome === 'ok', { from: earlyFrom, ms: 10000 });
    t.ok('解除の前に再開しても中断の印は消える', (await info(early)).interrupted === null);

    // ---- 3. 解除が遠い先（週の上限など）でも予定は置かず、終了の確認に再開の件数は無い
    const weekly = await newSession();
    const farAt = Date.now() + 3 * 24 * HOUR;
    await c.runTurn({ sessionId: weekly, prompt: `limit ${farAt}` });
    t.ok('遠い先の解除時刻も会話に残す', (await info(weekly)).interrupted?.resetsAt === farAt);
    t.ok('遠い先の解除でも予定を置かない', (await op('sessions.schedules', { sessionId: weekly })).length === 0);
    t.ok('終了の確認に再開の件数を載せない', !('resume' in (await c.cmd('running')).scheduled));

    // ---- 4. 解除時刻が分からない上限も、同じ。送った指示はすぐ送られ、人の「再開」も断らない
    const unknown = await newSession();
    await c.runTurn({ sessionId: unknown, prompt: 'limit unknown' });
    const stopped = (await info(unknown)).interrupted;
    t.ok('解除時刻が分からない上限も中断として残る（予定は置かない）', stopped?.reason === 'limit' && stopped.resetsAt === null
      && (await op('sessions.schedules', { sessionId: unknown })).length === 0);
    const unknownFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: unknown, messageId: 'unknownq000001', prompt: 'echo:right-away' });
    t.ok('解除時刻が分からない上限の会話に送った指示は、待たずにすぐ送られる',
      await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === unknown && e.outcome === 'ok', { from: unknownFrom, ms: 10000 }).then(() => true, () => false)
      && (await userTexts(unknown)).includes('echo:right-away'));
    const unknownAgain = await newSession();
    await c.runTurn({ sessionId: unknownAgain, prompt: 'limit unknown' });
    t.ok('解除時刻が分からない上限は、人の「再開」を断らない', (await op('sessions.resume', { sessionId: unknownAgain })).sent === 'text');

    // ---- 5. アカウントを替えて送ると、替えた先で送られる。替えなくても待たない
    const switched = await newSession();
    await c.runTurn({ sessionId: switched, prompt: `limit ${Date.now() + 3 * HOUR}` });
    const account = { id: await seedClaudeAccount(dataDir, '別のアカウント') };
    await c.cmd('setTurnSettings', { sessionId: switched, account: account.id });
    const switchedFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: switched, messageId: 'switchedq00001', prompt: 'echo:after-switch' });
    t.ok('アカウントを替えて送ると、すぐ送られる', await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === switched && e.outcome === 'ok', { from: switchedFrom, ms: 10000 }).then(() => true, () => false));
    t.ok('替えた会話は替えた先で続き、中断の印は消える', (await info(switched)).interrupted === null && (await info(switched)).claudeAccount === account.id);
    const switchedAgain = await newSession();
    await c.runTurn({ sessionId: switchedAgain, prompt: `limit ${Date.now() + 3 * HOUR}` });
    // 新しい会話の既定のアカウントは、さっき選んだ別のアカウント。ログイン中のアカウント（''）へ替える
    await c.cmd('setTurnSettings', { sessionId: switchedAgain, account: '' });
    t.ok('替えた会話の中断の印は残る', (await info(switchedAgain)).interrupted?.reason === 'limit');
    t.ok('替えた後も、解除時刻の前に人の「再開」が通る', (await op('sessions.resume', { sessionId: switchedAgain })).sent === 'text');

    // 押した時点の設定（settings。ADR 0347）を持つ送信も、上限で止まった会話に待たずすぐ、その設定で送られる
    const captured = await newSession();
    const capturedMeta = await info(captured);
    await c.runTurn({ sessionId: captured, prompt: `limit ${Date.now() + 3 * HOUR}` });
    const capturedAccount = (await info(captured)).interrupted?.account ?? '';
    const capturedSettings = { backend: 'fake', cwd: ROOT, model: capturedMeta.model ?? '', effort: '', mode: 'default', account: capturedAccount, endpoint: '', worktreePending: false };
    const capturedFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: captured, messageId: 'capturedq00001', prompt: 'echo:captured', settings: capturedSettings });
    const capturedEnd = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === captured && e.outcome === 'ok', { from: capturedFrom, ms: 10000 }).catch(() => null);
    const capturedAfter = await itemOf(captured, 'capturedq00001');
    t.ok('押した時点の設定を持つ送信も、上限で止まった会話にすぐ送られる（待たない）', Boolean(capturedEnd) && capturedAfter?.status === 'sent' && !capturedAfter.waiting
      && (await info(captured)).claudeAccount === capturedAccount && (await userTexts(captured)).includes('echo:captured'),
      JSON.stringify({ capturedAfter, account: (await info(captured)).claudeAccount }));
    t.ok('押した時点の設定は受け付けた形のまま残る（同じ id の送り直しの照合）', capturedAfter?.args?.settings?.account === capturedAccount);

    // 上限以外（作業中のターン）で待っている発言は、後から設定を替えても押した時点の設定で届く
    const busy = await newSession();
    const busyMeta = await info(busy);
    const busyFrom = c.mark();
    const busyTurn = c.runTurn({ sessionId: busy, prompt: 'HOLD_TURN:busy-hold' });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === busy && e.state === 'thinking', { from: busyFrom, ms: 10000 });
    const busyAccount = busyMeta.claudeAccount ?? '';
    const busySettings = { backend: 'fake', cwd: ROOT, model: busyMeta.model ?? '', effort: '', mode: 'default', account: busyAccount, endpoint: '', worktreePending: false };
    await c.cmd('sendMessage', { sessionId: busy, messageId: 'busyq000000001', prompt: 'echo:busy', settings: busySettings });
    await c.cmd('setTurnSettings', { sessionId: busy, account: busyAccount ? '' : account.id });
    const busyItem = await itemOf(busy, 'busyq000000001');
    t.ok('作業中のターンを待つ発言は、設定を替えても押した時点の設定のまま', busyItem?.status === 'queued' && busyItem.waiting?.reason !== 'limit'
      && Object.entries(busySettings).every(([key, value]) => busyItem.args?.settings?.[key] === value), JSON.stringify(busyItem));
    await fs.writeFile(path.join(scratch, 'busy-hold'), '');
    await busyTurn;
    for (let i = 0; i < 100 && (await itemOf(busy, 'busyq000000001'))?.status !== 'sent'; i++) await sleep(100);
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === busy && e.outcome === 'ok', { from: busyFrom, ms: 10000 }).catch(() => null);
    for (let i = 0; i < 50 && !(await idle(busy)); i++) await sleep(100);
    t.ok('作業中のターンを待った発言は、押した時点のアカウントで届く', (await itemOf(busy, 'busyq000000001'))?.status === 'sent'
      && (await info(busy)).claudeAccount === busyAccount, JSON.stringify({ item: await itemOf(busy, 'busyq000000001'), account: (await info(busy)).claudeAccount }));

    // 上限で止まったターンの後ろで保留になった発言は、新しく送った発言より先に届く（上限そのものは待たない）
    const held = await newSession();
    const heldMeta = await info(held);
    const heldFrom = c.mark();
    const heldTurn = c.runTurn({ sessionId: held, prompt: `limit ${Date.now() + 3 * HOUR} HOLD_TURN:held-limit` });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === held && e.state === 'thinking', { from: heldFrom, ms: 10000 });
    const heldAccount = heldMeta.claudeAccount ?? '';
    await c.cmd('sendMessage', { sessionId: held, messageId: 'heldq000000001', prompt: 'echo:held',
      settings: { backend: 'fake', cwd: ROOT, model: heldMeta.model ?? '', effort: '', mode: 'default', account: heldAccount, endpoint: '', worktreePending: false } });
    await fs.writeFile(path.join(scratch, 'held-limit'), '');
    t.ok('上限で止まったターンの後ろの発言は保留になる', (await heldTurn).outcome === 'limited' && (await itemOf(held, 'heldq000000001'))?.status === 'paused');
    const heldSwitch = c.mark();
    await c.cmd('sendMessage', { sessionId: held, messageId: 'heldnew0000001', prompt: 'echo:held-new',
      settings: { backend: 'fake', cwd: ROOT, model: heldMeta.model ?? '', effort: '', mode: 'default', account: heldAccount, endpoint: '', worktreePending: false } });
    await c.waitFor(e => e.type === 'userMessage' && e.messageId === 'heldnew0000001', { from: heldSwitch, ms: 20000 })
      .catch(async err => { throw new Error(`${err.message}\n${JSON.stringify(await c.cmd('listMessages', { sessionId: held }))}\n${server.tail()}`); });
    t.ok('解除の前に新しく送ると、保留していた発言が先に届き、新しい発言が続く',
      c.since(heldSwitch).filter(e => e.type === 'userMessage' && e.sessionId === held).map(e => e.messageId).join() === 'heldq000000001,heldnew0000001');

    const late = await newSession();
    const lateFrom = c.mark();
    const limitedTurn = c.runTurn({ sessionId: late, prompt: `limit ${Date.now() + HOUR} HOLD_TURN:late-limit` });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === late && e.state === 'thinking', { from: lateFrom, ms: 10000 });
    await c.cmd('setTurnSettings', { sessionId: late, backend: 'codex' });
    await c.cmd('sendMessage', { sessionId: late, messageId: 'latelimitq0001', prompt: 'run on Codex' });
    await fs.writeFile(path.join(scratch, 'late-limit'), '');
    t.ok('切替を予約した後で元のターンが上限終了する', (await limitedTurn).outcome === 'limited');
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === late && e.outcome === 'ok', { from: lateFrom, ms: 10000 });
    t.ok('元のターンの上限に関わらず別エージェントへ配送する', (await info(late)).backend === 'codex');

    // ---- 6. 古いデータ: 保存済みの自動再開の予定（kind: resume）と会話の印は読まない。送信予定は残る
    const legacy = await newSession();
    await c.runTurn({ sessionId: legacy, prompt: `limit ${Date.now() + 1000}` });
    const sendRow = { id: 'send:legacy-keep', kind: 'send', sessionId: legacy, at: Date.now() + 24 * HOUR, createdAt: Date.now(), by: 'human',
      messageId: 'legacysend0001', prompt: 'echo:scheduled' };
    c.close(); await server.stop();
    const sessions = readSessions(dataDir);
    sessions[legacy] = { ...sessions[legacy], interrupted: { ...sessions[legacy].interrupted, autoResume: true }, autoResumeOff: false };
    writeSessions(dataDir, sessions);
    const stoppedAt = sessions[legacy].interrupted.at;
    await fs.writeFile(path.join(dataDir, 'schedule.json'), JSON.stringify({ version: 1, entries: [
      { id: `resume:${legacy}`, kind: 'resume', sessionId: legacy, at: Date.now() - 1000, createdAt: stoppedAt, by: 'limit', account: '' },
      { id: `resume:${unknown}`, kind: 'resume', sessionId: unknown, at: Date.now() - 1000, createdAt: 1, by: 'limit', poll: true },
      sendRow,
    ] }));
    await sleep(1200);
    server = await launch(); c = await open({ port: server.port, token: server.token, autoAllow: true });
    await sleep(1500);
    const rows = await op('sessions.schedules');
    t.ok('古い kind: resume の予定は読まず、送信予定は残る', rows.length === 1 && rows[0].id === sendRow.id, JSON.stringify(rows));
    const legacyInfo = await info(legacy);
    t.ok('古い自動再開の印は読まず、解除時刻を過ぎても会話は動かない', legacyInfo.interrupted?.reason === 'limit' && !('autoResume' in legacyInfo.interrupted)
      && await idle(legacy) && (await userTexts(legacy)).length === 1, JSON.stringify(legacyInfo.interrupted));
    t.ok('古い印の残った会話も、人の「再開」で続く', (await op('sessions.resume', { sessionId: legacy })).sent === 'text');
  } finally {
    c.close(); await server.stop();
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }
}
