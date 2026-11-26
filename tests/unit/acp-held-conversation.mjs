// ACP の CLI を保持役の子に載せる口（core/backends/acp-held.mjs）の「会話寿命」（lifetime: 'conversation'。agy の ACP が使う）。
// ターン寿命（既定。Devin・Grok）は 1 ターン 1 プロセスで、変わらない。会話寿命は、ターンが終わっても子が生きて idle で次のターンを待つ。
//   endTurn は札と印を外すだけで子を止めない・idle の間は札を置かない・markTurn で次のターンの印を打ち直す・exitFrames でアプリの終了に止める
//   sweepIdleAcp は、札か印の欠けた idle の子だけを止める（付け直せる子・自分の子・ほかのバックエンドの子には触れない）
//   付け直し（adopt）の後は、前のサーバーが付けた依頼の id（pleiad-<n>）の続きから番号を振る（次のターンが前の id と重ならない）
// 保持役は同じプロセスに立てた本物（tests/lib/holder-harness.mjs）、ACP の相手は fake-devin（tests/lib/fake-devin.mjs）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../../core/backends/acp-client.mjs';
import { ACP_CHILD_PREFIX, createHeldAcp, sweepIdleAcp } from '../../core/backends/acp-held.mjs';
import { ADOPT_TURN_MARK, holderSource } from '../../core/adopt.mjs';
import { fakeChild, isAlive, sleep, startHolder, waitFor } from '../lib/holder-harness.mjs';

export const name = 'acp-held-conversation';
export const title = 'ACP の保持役の会話寿命: endTurn は子を止めない・idle の間は札を置かない・再ターン・exitFrames・sweepIdleAcp・付け直しの後の id の続き';

const fake = fileURLToPath(new URL('../lib/fake-devin.mjs', import.meta.url));
const textPrompt = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] });
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const MARK = ADOPT_TURN_MARK;

export default async function test(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-acp-held-conv-'));
  const gateDir = path.join(scratch, 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const h = await startHolder();
  const originalError = console.error;
  const launch = (held, options = {}) => new AcpClient({
    label: 'Fake', args: ['acp'], command: [process.execPath, fake], cwd: scratch,
    env: { ...process.env, FAKE_DEVIN_STATE_DIR: scratch, FAKE_DEVIN_GATE_DIR: gateDir }, timeoutMs: 8000, held, ...options,
  });
  /** 保持役の中の、この子の今の状態。つながる親は常に 1 つ（新しい接続が古い接続を追い出す）ので、接続を足さず、保持役の中から直に読む */
  const snapshot = id => h.holder.snapshot().children.find(child => child.id === id) ?? null;
  const eventually = (id, check, label) => waitFor(async () => { const child = await snapshot(id); return check(child) ? child : null; }, 8000, label);
  const marked = child => Number.isInteger(child?.marks?.[MARK]);
  const bare = child => Boolean(child) && !child.label && !marked(child);
  try {
    // ---- 引数
    t.ok('寿命の既定は turn で、知らない寿命は断る', (() => {
      try { createHeldAcp({ client: {}, lifetime: 'forever' }); return false; } catch (error) { return /unknown held lifetime/.test(error.message); }
    })() && createHeldAcp({ client: {} }).exitFrames().length === 0);
    const unborn = createHeldAcp({ client: {}, lifetime: 'conversation' });
    t.ok('起こす前の口は、印・札・ターンの終わりに何もせず、exitFrames は空', (() => { unborn.markTurn(); unborn.label({ k: 'x' }); unborn.endTurn(); return unborn.exitFrames().length === 0 && unborn.id === null; })());

    // ---- ターン寿命（既定。Devin・Grok）は今のまま: id は acp-・endTurn の後も札を置き直せる
    const A = await h.connect();
    const sent = [];
    const originalLabel = A.client.label.bind(A.client);
    A.client.label = (id, card) => { sent.push({ id, card }); return originalLabel(id, card); };
    const turnHeld = createHeldAcp({ client: A.client });
    const turnAcp = launch(turnHeld);
    await turnAcp.start();
    turnHeld.markTurn(); turnHeld.label({ k: 'turn', n: 1 });
    await eventually(turnHeld.id, child => child?.label?.n === 1 && marked(child), 'turn: label and mark');
    t.ok('ターン寿命: 子の id は acp- で始まり、印と札が置かれる', turnHeld.id.startsWith(ACP_CHILD_PREFIX) && ACP_CHILD_PREFIX === 'acp-');
    turnHeld.endTurn();
    const afterTurnEnd = await eventually(turnHeld.id, child => bare(child), 'turn: label and mark removed');
    t.ok('ターン寿命: endTurn は札と印を外す（子はそのまま。止めるのは close）', afterTurnEnd.alive === true && turnHeld.exited === null);
    turnHeld.label({ k: 'turn', n: 2 });
    await eventually(turnHeld.id, child => child?.label?.n === 2, 'turn: late label');
    t.ok('ターン寿命: endTurn の後の札の置き直しは今のまま通る（idle にしない）', sent.some(entry => entry.card?.n === 2));
    await turnAcp.close();
    t.ok('ターン寿命: close は子を止める', turnHeld.exited !== null);

    // ---- 会話寿命: endTurn は子を止めず、idle の間は札を置かず、markTurn で次のターンを受ける
    const heldA = createHeldAcp({ client: A.client, lifetime: 'conversation', childPrefix: 'fake-' });
    const acp = launch(heldA);
    await acp.start();
    const session = (await acp.call('session/new', { cwd: scratch, mcpServers: [] })).sessionId;
    t.ok('会話寿命: 子の id は childPrefix で始まる（acp- ではない）', heldA.id.startsWith('fake-') && !heldA.id.startsWith('acp-'), heldA.id);
    sent.length = 0;
    heldA.markTurn(); heldA.label({ k: 'conv', turn: 1 });
    const firstMark = (await eventually(heldA.id, child => child?.label?.turn === 1 && marked(child), 'conv: turn 1 label and mark')).marks[MARK];
    const first = await acp.call('session/prompt', textPrompt(session, 'turn one'));
    const pid = (await snapshot(heldA.id)).pid;
    t.ok('会話寿命: 1 ターン目が通る', first?.stopReason === 'end_turn' && Number.isInteger(pid), JSON.stringify({ first, pid }));
    heldA.endTurn();
    const idleChild = await eventually(heldA.id, child => bare(child), 'conv: idle');
    t.ok('会話寿命: endTurn は札と印を外すだけで、子を止めない（idle で次のターンを待つ）',
      idleChild.alive === true && idleChild.pid === pid && isAlive(pid) && heldA.exited === null && acp.alive === true,
      JSON.stringify({ alive: idleChild.alive, pid: idleChild.pid, exited: heldA.exited, acpAlive: acp.alive }));
    sent.length = 0;
    heldA.label({ k: 'conv', turn: 'late' });
    heldA.label({ k: 'conv', turn: 'late2' });
    await sleep(80);
    t.ok('会話寿命: idle の間の札は置かない（遅れて届いた置き直しで、idle の子を付け直す対象に戻さない）',
      sent.length === 0 && bare(await snapshot(heldA.id)), JSON.stringify(sent));
    heldA.markTurn();
    heldA.label({ k: 'conv', turn: 2 });
    const second = await eventually(heldA.id, child => child?.label?.turn === 2 && marked(child), 'conv: turn 2 label and mark');
    t.ok('会話寿命: markTurn で idle が明け、札と印が置き直される（印は進む）',
      sent.length === 1 && sent[0].card.turn === 2 && second.marks[MARK] > firstMark, JSON.stringify({ sent, firstMark, secondMark: second.marks[MARK] }));
    const again = await acp.call('session/prompt', textPrompt(session, 'turn two'));
    t.ok('会話寿命: 同じ子で 2 ターン目が通る（同じプロセス・同じ会話）',
      again?.stopReason === 'end_turn' && (await snapshot(heldA.id)).pid === pid && acp.alive, JSON.stringify({ again, pid }));
    heldA.endTurn();
    await eventually(heldA.id, child => bare(child), 'conv: idle again');
    heldA.markTurn();
    heldA.label({ k: 'conv', turn: 3 });
    await eventually(heldA.id, child => child?.label?.turn === 3 && marked(child), 'conv: turn 3');
    heldA.endTurn(); heldA.endTurn();
    t.ok('会話寿命: ターンを何度繰り返しても、endTurn を重ねても子は生きている', (await eventually(heldA.id, child => bare(child), 'conv: idle 3')).alive === true && acp.alive);

    // ---- exitFrames（アプリの終了）
    const frames = heldA.exitFrames();
    t.ok('exitFrames: 生きている子には end と木ごとの kill の 2 つ',
      frames.length === 2 && JSON.stringify(frames[0]) === JSON.stringify({ t: 'end', id: heldA.id }) && JSON.stringify(frames[1]) === JSON.stringify({ t: 'kill', id: heldA.id, tree: true }), JSON.stringify(frames));
    A.client.sendBatch(frames);
    await waitFor(() => heldA.exited && !acp.alive, 8000, 'exitFrames stops the child');
    t.ok('exitFrames を 1 回で送ると子が終わり、終わった子の exitFrames は空', heldA.exited !== null && heldA.exitFrames().length === 0 && !isAlive(pid));
    heldA.markTurn(); heldA.label({ k: 'x' }); heldA.endTurn();
    await acp.close();

    // ---- 付け直し: 走っているターンを、別のサーバーの接続が引き継ぎ、その後の次のターンも同じ子で受ける
    const S1 = await h.connect();
    const held1 = createHeldAcp({ client: S1.client, lifetime: 'conversation', childPrefix: 'fake-' });
    const acp1 = launch(held1, { onGone: () => {} });
    await acp1.start();
    const adoptSession = (await acp1.call('session/new', { cwd: scratch, mcpServers: [] })).sessionId;
    held1.markTurn(); held1.label({ k: 'conv', adopt: true });
    const promptId = acp1.newId();
    const running1 = settle(acp1.call('session/prompt', textPrompt(adoptSession, '[slow][gate:g1] first'), { id: promptId, timeoutMs: 0 }));
    await waitFor(() => fs.existsSync(path.join(gateDir, 'g1.ready')), 8000, 'the prompt is held by the gate');
    const steerId = acp1.newId();
    const steer1 = settle(acp1.call('session/prompt', textPrompt(adoptSession, 'steer'), { id: steerId, timeoutMs: 0 }));
    await waitFor(() => acp1.pendingPromptIds().length === 2, 3000, 'two prompts are running');
    const prompts = acp1.pendingPromptIds();
    await eventually(held1.id, child => child?.label?.adopt === true && marked(child), 'adopt: label and mark are on the child');
    // 古いサーバーが落ちる（保持役と子は残る）
    console.error = () => {};
    S1.client.close();
    await Promise.all([running1, steer1]);
    const B = await h.connect();
    const survivor = B.client.welcome.children.find(child => child.id === held1.id);
    console.error = originalError;
    t.ok('付け直し: 古いサーバーが落ちても、子は札と印を持ったまま生きている', survivor?.alive === true && survivor.label?.adopt === true && marked(survivor), JSON.stringify(survivor));
    const source = holderSource(B.client, survivor, { redelivered: true });
    const held2 = createHeldAcp({ source, lifetime: 'conversation', childPrefix: 'fake-' });
    const acp2 = launch(held2, { adopt: { promptId: prompts[0] } });
    t.ok('付け直し: initialize を送らずに起動する（init は null）', await acp2.start() === null && acp2.init === null && acp2.adopted === true && held2.adopting === true);
    await acp2.open(1);
    acp2.adoptTrailing(prompts.filter(id => id !== prompts[0]));
    const top = Math.max(...prompts.map(id => Number(id.slice('pleiad-'.length))));
    t.ok('付け直し: 走っている prompt と途中送信の id の続きから番号を振る（途中送信の id と重ならない）',
      prompts.length === 2 && top >= 3 && acp2.nextId === top && acp2.pendingPromptIds().join() === prompts.join(), JSON.stringify({ nextId: acp2.nextId, prompts }));
    const response = acp2.running;
    acp2.begin();
    fs.writeFileSync(path.join(gateDir, 'g1'), '');
    const adoptedResult = await response;
    await acp2.settleTrailing(8000);
    t.ok('付け直し: 走っていたターンは新しい接続で決着する（本文の応答と途中送信の応答）',
      adoptedResult?.stopReason === 'end_turn' && acp2.pendingPromptIds().length === 0, JSON.stringify(adoptedResult));
    held2.endTurn();
    await eventually(held2.id, child => bare(child) && child.alive === true, 'adopt: idle after the adopted turn');
    held2.markTurn(); held2.label({ k: 'conv', adopt: 2 });
    const nextId = acp2.newId();
    const nextResult = await acp2.call('session/prompt', textPrompt(adoptSession, 'next turn after adopt'), { id: nextId });
    t.ok('付け直し: 付け直した後も、同じ子で次のターンを受ける（番号は前の id の後ろ）',
      nextResult?.stopReason === 'end_turn' && nextId === `pleiad-${top + 1}` && acp2.alive === true, JSON.stringify({ nextId, nextResult }));
    held2.endTurn();
    await eventually(held2.id, child => bare(child) && child.alive === true, 'adopt: idle again');
    B.client.sendBatch(held2.exitFrames());
    await waitFor(() => held2.exited, 8000, 'adopted child stops');
    await acp2.close();
    t.ok('付け直した子も、exitFrames で止まる', held2.exited !== null && held2.exitFrames().length === 0);

    // ---- 付け直しの再生の中の番号（保持役の記録の再生に出てくる前のサーバーの依頼の答え）
    const makeChild = () => {
      const child = new EventEmitter();
      const stdin = Object.assign(new EventEmitter(), { writable: true, write() { return true; }, destroy() {} });
      return Object.assign(child, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), pid: null, exitCode: null, signalCode: null, kill() {} });
    };
    const replayHeld = () => {
      const state = { onLine: null };
      return { state, start: () => makeChild(), begin({ onLine }) { state.onLine = onLine; }, async open() { return null; }, kill() {}, async close() {} };
    };
    const hold = replayHeld();
    const replaying = new AcpClient({ label: 'Fake', command: ['none'], args: [], held: hold, adopt: { promptId: 'pleiad-7' } });
    await replaying.start();
    replaying.begin();
    const feed = (frame, opts) => hold.state.onLine(JSON.stringify({ jsonrpc: '2.0', ...frame }), opts);
    t.ok('再生の中の答えの id（pleiad-<n>）の最大の続きから番号を振る', (() => {
      feed({ id: 'pleiad-9', result: {} }, { replay: true });
      feed({ id: 'pleiad-12', result: {} }, { replay: true });
      feed({ id: 'pleiad-10', result: {} }, { replay: true });
      return replaying.nextId === 12 && replaying.newId() === 'pleiad-13';
    })(), String(replaying.nextId));
    t.ok('再生でない答え・pleiad-<n> でない id・桁あふれする番号では番号を進めない（相手に番号を吊り上げさせない）', (() => {
      const before = replaying.nextId;
      feed({ id: 'pleiad-900', result: {} }, null);
      feed({ id: 'pleiad-901', result: {} }, undefined);
      feed({ id: 'req-5000', result: {} }, { replay: true });
      feed({ id: 5000, result: {} }, { replay: true });
      feed({ id: 'pleiad-99999999999999999999', result: {} }, { replay: true });
      feed({ id: 'pleiad-0x20', result: {} }, { replay: true });
      return replaying.nextId === before && !replaying.gone;
    })(), String(replaying.nextId));
    replaying.adoptTrailing(['pleiad-20', 'pleiad-3']);
    t.ok('途中送信の id を開けたら、その続きから番号を振る（小さい id では戻らない）', replaying.nextId === 20 && replaying.newId() === 'pleiad-21', String(replaying.nextId));
    const running = settle(replaying.running);
    feed({ id: 'pleiad-7', result: { stopReason: 'end_turn' } }, null);
    t.ok('走っている prompt の応答は running で受ける', (await running).value?.stopReason === 'end_turn');
    await replaying.close();

    // ---- sweepIdleAcp: 札か印の欠けた idle の子だけを止める
    const E = await h.connect();
    const spawnIdle = id => E.client.spawn({ ...fakeChild(id, 'echo'), cwd: scratch, keepMs: 120_000 });
    const names = ['fake-idle', 'fake-label-only', 'fake-mark-only', 'fake-ready', 'fake-own', 'agy-other', 'acp-leftover'];
    for (const id of names) spawnIdle(id);
    E.client.label('fake-label-only', { k: 'half' });
    E.client.mark('fake-mark-only', MARK);
    E.client.label('fake-ready', { k: 'ready', backendCard: { agy: { home: 'held-ready' } } });
    E.client.mark('fake-ready', MARK);
    await eventually('fake-ready', child => child?.label?.k === 'ready' && marked(child), 'sweep: the adoptable child');
    await eventually('fake-mark-only', child => marked(child) && !child.label, 'sweep: a mark without a label');
    await eventually('fake-label-only', child => child?.label?.k === 'half', 'sweep: a label without a mark');
    for (const id of names) await eventually(id, child => child?.alive === true, `sweep: ${id} is alive`);

    // 前の節の子（終わった記録が残ることがある）と見分けるため、この節の子の id だけを見る
    const ours = list => list.filter(id => names.includes(id));
    const D0 = await h.connect();
    const byDefault = await sweepIdleAcp(D0.client);
    await eventually('acp-leftover', child => child?.alive === false, 'sweep: acp-leftover stopped');
    t.ok('既定の prefix は acp-（Devin・Grok の子）で、ほかの prefix の子には触れない',
      byDefault.includes('acp-leftover') && byDefault.every(id => id.startsWith('acp-'))
      && (await Promise.all(names.filter(id => id !== 'acp-leftover').map(snapshot))).every(child => child?.alive === true), JSON.stringify(byDefault));

    const D1 = await h.connect();
    const homes = [];
    const stopped = await sweepIdleAcp(D1.client, { prefix: 'fake-', ids: new Set(['fake-own']), onHomes: kept => homes.push(ours(kept.map(child => child.id))) });
    for (const id of ['fake-idle', 'fake-label-only', 'fake-mark-only']) await eventually(id, child => child?.alive === false, `sweep: ${id} stopped`);
    t.ok('札も印も無い・札だけ・印だけの子は止める', JSON.stringify(ours(stopped).sort()) === JSON.stringify(['fake-idle', 'fake-label-only', 'fake-mark-only']), JSON.stringify(stopped));
    t.ok('札と印の両方を持つ子・ids の子（自分がつないでいた子）・prefix の違う子は止めない',
      (await Promise.all(['fake-ready', 'fake-own', 'agy-other'].map(snapshot))).every(child => child?.alive === true));
    t.ok('onHomes は止めた後に 1 回、付け直せる生きた子（札と印を持つもの）だけを渡される', homes.length === 1 && JSON.stringify(homes[0]) === '["fake-ready"]', JSON.stringify(homes));
    const D2 = await h.connect();
    const again2 = await sweepIdleAcp(D2.client, { prefix: 'fake-', ids: new Set(['fake-own']), onHomes: kept => homes.push(ours(kept.map(child => child.id))) });
    t.ok('止めた後の再実行は、終わった子の記録を捨てるだけで、生きた子には触れない（onHomes は毎回呼ぶ）',
      JSON.stringify(ours(again2).sort()) === JSON.stringify(['fake-idle', 'fake-label-only', 'fake-mark-only'])
      && (await Promise.all(['fake-ready', 'fake-own', 'agy-other'].map(snapshot))).every(child => child?.alive === true)
      && homes.length === 2 && JSON.stringify(homes[1]) === '["fake-ready"]', JSON.stringify({ again2, homes }));
    t.ok('保持役の記録が無い・子が居ない接続でも投げない（onHomes を省ける）',
      JSON.stringify(await sweepIdleAcp({ welcome: null }, { prefix: 'fake-' })) === '[]' && JSON.stringify(await sweepIdleAcp({ welcome: { children: [] } })) === '[]');
  } finally {
    console.error = originalError;
    // 残した子を止める（保持役の終わりでも止まるが、確かめて待つ）
    try {
      const sweep = await h.connect();
      const alive = sweep.client.welcome.children.filter(child => child.alive);
      for (const child of alive) {
        try { await sweep.client.attach(child.id, { from: (child.seq ?? 0) + 1 }); sweep.client.kill(child.id, { tree: true }); } catch { /* 消えた */ }
      }
      await waitFor(() => alive.every(child => !isAlive(child.pid)), 5000, 'children stopped').catch(() => {});
    } catch { /* 保持役が終わっている */ }
    await h.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
