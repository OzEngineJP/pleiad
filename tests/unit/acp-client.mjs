// ACP の共通の口（core/backends/acp-client.mjs）。Devin（devin-acp.mjs）・Grok（grok-acp.mjs）はこの薄いサブクラスで、
// 差は routeNotification・decorateError・vendorKinds・onDrop / onOverflow だけ。ここでは基底を直に、fake-devin（ACP の偽物）に繋いで測る。
// 起動・初期化・RPC・通知の振り分け・エラーの印・行の上限・保持役（held）の起動と付け直し・閉じる、を順に見る。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, CALLBACK_CODES, PROCESS_CODES, SAFE_ERROR, rpcError, waitForExit } from '../../core/backends/acp-client.mjs';
import { acpRequestFailure } from '../../core/backends/acp-error.mjs';
import { COGNITION_VENDOR_KINDS, DevinAcp } from '../../core/backends/devin-acp.mjs';
import { GrokAcp } from '../../core/backends/grok-acp.mjs';

export const name = 'acp-client';
export const title = 'ACP 共通の口（AcpClient）: 起動・RPC・通知の振り分け・安全なエラー・行の上限・保持役の起動と付け直し・終了';

const fake = fileURLToPath(new URL('../lib/fake-devin.mjs', import.meta.url));
const inject = (client, frame) => client.proc.stdout.emit('data', Buffer.from(typeof frame === 'string' || Buffer.isBuffer(frame) ? frame : `${JSON.stringify(frame)}\n`));
const textPrompt = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] });
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const until = async (fn, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await new Promise(r => setTimeout(r, 10)); } return false; };

export default async function test(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-acp-client-'));
  const launch = (options = {}) => new AcpClient({
    label: 'Fake', args: ['acp'], command: [process.execPath, fake], cwd: process.cwd(),
    env: { ...process.env, FAKE_DEVIN_STATE_DIR: root }, timeoutMs: 2000, ...options,
  });
  const clients = [];
  const open = async (options) => { const client = launch(options); clients.push(client); await client.start(); return client; };
  try {
    // ---- 出すもの・サブクラス
    const safe = rpcError('fixed text', -32042);
    t.ok('rpcError は固定の文面と code だけの安全なエラー（SAFE_ERROR の印つき）',
      safe instanceof Error && safe.message === 'fixed text' && safe.code === -32042 && safe[SAFE_ERROR] === true && rpcError('x').code === -32000);
    t.ok('PROCESS_CODES・CALLBACK_CODES は集合で、spawn の種別と JSON-RPC の標準の番号を持つ',
      PROCESS_CODES instanceof Set && PROCESS_CODES.has('ENOENT') && CALLBACK_CODES instanceof Set && CALLBACK_CODES.has(-32601) && !CALLBACK_CODES.has(-32000));
    const exited = { exitCode: 0, signalCode: null, off() {}, once() { throw new Error('must not wait'); } };
    t.ok('waitForExit は終わっている子を待たず、終わらない子は上限で返る',
      await waitForExit(exited, 5000).then(() => true) && await (async () => {
        const handlers = [];
        const child = { exitCode: null, signalCode: null, once: (_event, fn) => handlers.push(fn), off() {} };
        const began = Date.now();
        await waitForExit(child, 40);
        return Date.now() - began >= 30 && handlers.length === 1;
      })());
    const devin = new DevinAcp({ command: [process.execPath, fake] });
    const grok = new GrokAcp({ command: [process.execPath, fake], args: ['--model', 'm'] });
    t.ok('DevinAcp・GrokAcp は AcpClient のサブクラスで、固有の差（label・引数・vendorKinds・onNotification）だけを持つ',
      devin instanceof AcpClient && grok instanceof AcpClient
        && devin.label === 'Devin' && JSON.stringify(devin.cliArgs) === '["acp"]' && devin.vendorKinds === COGNITION_VENDOR_KINDS && typeof devin.onNotification === 'function'
        && grok.label === 'Grok' && JSON.stringify(grok.cliArgs) === '["agent","--model","m","stdio"]' && JSON.stringify(grok.args) === '["--model","m"]' && grok.vendorKinds === null && typeof grok.onInterjection === 'function',
      JSON.stringify({ devin: devin.cliArgs, grok: grok.cliArgs }));
    await devin.close(); await grok.close();

    // ---- 起動・RPC
    const before = launch();
    clients.push(before);
    t.ok('起動の前は init が null・alive が false で、call は走っていないと断る（notify は投げる）',
      before.init === null && before.alive === false && before.pid === null
        && await before.call('session/list', {}).then(() => false, e => e?.[SAFE_ERROR] === true && /Fake ACP is not running/.test(e.message))
        && (() => { try { before.notify('x', {}); return false; } catch (e) { return e?.[SAFE_ERROR] === true; } })());
    const updates = [], routed = [];
    const client = await open({ onUpdate: params => updates.push(params), routeNotification: (method, params, opts) => routed.push({ method, params, opts }) });
    t.ok('start は initialize を送り、その答えを init で返す（start を重ねても同じ約束）',
      client.init?.protocolVersion === 1 && client.init === await client.start() && Number.isInteger(client.pid) && client.alive === true,
      JSON.stringify(client.init));
    const first = client.newId(), second = client.newId();
    t.ok('newId は pleiad-<n> を 1 つずつ進める（call の id と同じ数列）',
      /^pleiad-\d+$/.test(first) && second === `pleiad-${Number(first.slice(7)) + 1}` && client.nextId === Number(second.slice(7)));
    const { sessionId } = await client.call('session/new', { cwd: process.cwd(), mcpServers: [] });
    t.ok('call は id を pleiad-<n> で進めて応答の result を返す', /^devin-fixture-/.test(sessionId) && client.nextId === Number(second.slice(7)) + 1, sessionId);
    t.ok('session/update は onUpdate に届く（session/new の config_option_update）',
      updates.some(p => p.sessionId === sessionId && p.update.sessionUpdate === 'config_option_update'), JSON.stringify(updates.map(p => p.update?.sessionUpdate)));
    const compact = await client.call('session/prompt', textPrompt(sessionId, '/compact'));
    t.ok('session/update 以外の通知は routeNotification に（method・params・opts の順で）渡り、onUpdate には行かない',
      compact.stopReason === 'end_turn' && routed.some(r => r.method === '_cognition.ai/compaction' && r.params?.status === 'started')
        && routed.every(r => r.method !== 'session/update') && routed.every(r => r.opts == null)
        && updates.every(p => p.update.sessionUpdate !== undefined), JSON.stringify(routed.map(r => r.method)));
    const duplicate = client.call('fixture/no-reply', {}, { id: 'dup-1', timeoutMs: 0 });
    t.ok('同じ id の依頼は重ねて送らない', await client.call('fixture/no-reply', {}, { id: 'dup-1', timeoutMs: 0 }).then(() => false, e => e.message === 'Duplicate JSON-RPC id'));
    inject(client, { jsonrpc: '2.0', id: 'dup-1', result: { ok: true } });
    t.ok('応答は id で待っている依頼に届く（届いた後の同じ id は無視する）', (await duplicate).ok === true && (inject(client, { jsonrpc: '2.0', id: 'dup-1', result: {} }), client.alive));
    const slow = await settle(client.call('session/prompt', textPrompt(sessionId, '[slow]'), { timeoutMs: 30 }));
    t.ok('期限を過ぎた依頼は -32001 の安全なエラーで断る', slow.error?.code === -32001 && slow.error[SAFE_ERROR] === true && slow.error.message === 'Fake ACP request timed out', JSON.stringify({ ...slow.error, message: slow.error?.message }));

    // ---- 走っている session/prompt の id・途中送信の枠
    const responses = [];
    const turn = await open({ onResponse: info => responses.push(info.method) });
    const turnSession = (await turn.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    const running = settle(turn.call('session/prompt', textPrompt(turnSession, '[slow]'), { timeoutMs: 0 }));
    const runningIds = turn.pendingPromptIds();
    t.ok('pendingPromptIds は走っている session/prompt の id だけを返す', runningIds.length === 1 && runningIds[0] === `pleiad-${turn.nextId}`, JSON.stringify(runningIds));
    turn.adoptTrailing(['pleiad-9001', runningIds[0]]);
    t.ok('adoptTrailing は走っている途中送信の枠を足す（すでにある id は足さない）',
      turn.pendingPromptIds().join() === `${runningIds[0]},pleiad-9001` && turn.trailing.length === 1, JSON.stringify(turn.pendingPromptIds()));
    const began = Date.now();
    await turn.settleTrailing(60);
    t.ok('settleTrailing は決着しない途中送信を上限まで待って閉じる', Date.now() - began >= 40 && turn.trailing.length === 0);
    turn.adoptTrailing(['pleiad-9002']);
    inject(turn, { jsonrpc: '2.0', id: 'pleiad-9002', result: { stopReason: 'end_turn' } });
    const settled = Date.now();
    await turn.settleTrailing(5000);
    t.ok('途中送信の応答が先に届けば settleTrailing はすぐ戻る', Date.now() - settled < 1500 && !turn.pendingPromptIds().includes('pleiad-9002'));
    await turn.close();
    const stopped = await running;
    t.ok('close は走っている依頼を -32800 の安全なエラーで断り、その後の start・call は閉じていると断る',
      stopped.error?.code === -32800 && stopped.error.message === 'Fake ACP closed' && turn.alive === false
        && await turn.start().then(() => false, e => /closed/.test(e.message))
        && await turn.call('session/list', {}).then(() => false, e => /not running/.test(e.message)),
      JSON.stringify({ code: stopped.error?.code, message: stopped.error?.message }));
    t.ok('onResponse は成功した応答を { method, params, result } で順に見る（initialize が先・途中送信の応答も見る）',
      responses[0] === 'initialize' && responses[1] === 'session/new' && responses.includes('session/prompt'), JSON.stringify(responses));

    // ---- エラー: 断られた依頼は文面を固定にし、decorateError が印だけを足す
    const seen = [];
    const decorated = await open({ decorateError: (reject, info) => { seen.push(info); reject.marked = info.method; } });
    const decoratedSession = (await decorated.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    const failed = await settle(decorated.call('session/prompt', textPrompt(decoratedSession, '[fail]')));
    t.ok('断られた依頼は固定の文面・wire の code・SAFE_ERROR だけで、wire の message を出さない',
      failed.error?.message === 'Fake ACP request failed' && failed.error.code === -32000 && failed.error[SAFE_ERROR] === true && !JSON.stringify(failed.error).includes('fake devin failure'),
      JSON.stringify({ code: failed.error?.code, message: failed.error?.message }));
    t.ok('decorateError は { error, method, params } を受け、載せた印が断りのエラーに付く',
      failed.error?.marked === 'session/prompt' && seen.length === 1 && seen[0].error.message === 'fake devin failure' && seen[0].params.sessionId === decoratedSession,
      JSON.stringify(seen.map(s => s.method)));
    const brokenDecorate = await open({ decorateError: () => { throw new Error('decorate boom'); } });
    const brokenSession = (await brokenDecorate.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    const brokenFailed = await settle(brokenDecorate.call('session/prompt', textPrompt(brokenSession, '[fail]')));
    t.ok('decorateError が投げても断りは安全なエラーのまま返り、接続は続く（投げた中身は出さない）',
      brokenFailed.error?.message === 'Fake ACP request failed' && !brokenFailed.error.message.includes('boom') && brokenDecorate.alive === true);

    // ---- vendorKinds（プロバイダ固有の構造化種別）。文面の判定は共通
    const vendorKinds = { 'vendor/kind': { out_of_credit: 'usageExhausted' } };
    const quota = await open({ vendorKinds });
    const plain = await open();
    const reply = async (target, error) => {
      const pending = settle(target.call('fixture/no-reply', {}, { timeoutMs: 0 }));
      inject(target, { jsonrpc: '2.0', id: `pleiad-${target.nextId}`, error });
      return (await pending).error;
    };
    const expectedExhausted = acpRequestFailure({ code: -32000, message: 'wire', data: { 'vendor/kind': 'out_of_credit' } }, 'Fake', 'fallback', { vendorKinds }).message;
    const kinded = await reply(quota, { code: -32000, message: 'wire', data: { 'vendor/kind': 'out_of_credit' } });
    const unkinded = await reply(plain, { code: -32000, message: 'wire', data: { 'vendor/kind': 'out_of_credit' } });
    t.ok('vendorKinds を渡した口だけが、固有の構造化種別を使い切りの文面にする（渡さない口は固定の文面のまま）',
      expectedExhausted !== 'fallback' && kinded?.message === expectedExhausted && unkinded?.message === 'Fake ACP request failed',
      JSON.stringify({ kinded: kinded?.message, unkinded: unkinded?.message }));
    const limited = await reply(plain, { code: 429, message: 'Too Many Requests' });
    t.ok('429・402・quota の文面の判定はどの口にも共通（固有の設定が要らない）',
      limited?.message !== 'Fake ACP request failed' && limited.message === acpRequestFailure({ code: 429, message: 'Too Many Requests' }, 'Fake', 'x').message, limited?.message);
    const devinKind = new DevinAcp({ command: [process.execPath, fake] });
    t.ok('Devin の vendorKinds は cognition.ai/errorKind の resource_exhausted を使い切りにする',
      acpRequestFailure({ code: -32000, message: 'x', data: { 'cognition.ai/errorKind': 'resource_exhausted' } }, 'Devin', 'f', { vendorKinds: devinKind.vendorKinds }).message !== 'f'
        && acpRequestFailure({ code: -32000, message: 'x', data: { 'cognition.ai/errorKind': 'resource_exhausted' } }, 'Devin', 'f').message === 'f');
    await devinKind.close();

    // ---- 通知の処理が投げたとき・既定の依頼の処理
    for (const [label, route, expected] of [
      ['routeNotification の run が投げる', (m, p, o, run) => run(() => { throw new Error('route boom'); }, 'update'), 'Fake ACP update handler failed'],
      ['routeNotification 自身が投げる', () => { throw new Error('route boom'); }, 'Fake ACP notification handler failed'],
      ['routeNotification の run が断った約束を受ける', (m, p, o, run) => run(() => Promise.reject(new Error('route boom')), 'custom'), 'Fake ACP custom handler failed'],
    ]) {
      const gone = [];
      const handler = await open({ routeNotification: route, onGone: error => gone.push(error) });
      const s = (await handler.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
      const result = await settle(handler.call('session/prompt', textPrompt(s, '/compact')));
      t.ok(`${label}と、接続を失敗にして文面は固定（${expected}）`,
        result.error?.message === expected && result.error[SAFE_ERROR] === true && gone.length === 1 && gone[0].message === expected && handler.alive === false
          && !result.error.message.includes('boom'), JSON.stringify({ message: result.error?.message, gone: gone.map(g => g.message) }));
    }
    const goneUpdate = [];
    const badUpdate = await open({ onUpdate: () => { throw new Error('update boom'); }, onGone: error => goneUpdate.push(error) });
    const badSession = await settle(badUpdate.call('session/new', { cwd: process.cwd(), mcpServers: [] }));
    t.ok('onUpdate が投げると接続を失敗にする（Fake ACP update handler failed）',
      badSession.error?.message === 'Fake ACP update handler failed' && goneUpdate[0]?.message === 'Fake ACP update handler failed' && badUpdate.alive === false);
    const standard = await open();
    const standardSession = (await standard.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    const refused = await settle(standard.call('session/prompt', textPrompt(standardSession, '[permission]')));
    t.ok('onRequest を渡さない口は、子の依頼（許可の確認）を -32601 で断り、接続は続く',
      refused.error?.[SAFE_ERROR] === true && standard.alive === true && await standard.call('session/list', {}).then(r => Array.isArray(r.sessions)), JSON.stringify({ ...refused.error }));
    const exitGone = [];
    const dying = await open({ onGone: error => exitGone.push(error) });
    const dyingSession = (await dying.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    const lost = await settle(dying.call('session/prompt', textPrompt(dyingSession, '[kill]'), { timeoutMs: 0 }));
    t.ok('子が止まると走っている依頼を安全なエラーで断り、onGone を 1 回呼ぶ',
      lost.error?.message === 'Fake ACP exited' && exitGone.length === 1 && exitGone[0].message === 'Fake ACP exited' && dying.alive === false,
      JSON.stringify({ message: lost.error?.message, gone: exitGone.length }));

    // ---- 行の上限: onDrop は改行が届いた時点・onOverflow は上限を超えたと分かった時点
    const sizes = (options) => { const log = { drop: [], overflow: [] }; return [log, { maxFrameBytes: 256, onDrop: options.drop ? info => log.drop.push(info) : null, onOverflow: options.overflow ? info => log.overflow.push(info) : null }]; };
    const [dropLog, dropOptions] = sizes({ drop: true });
    const onlyDrop = await open(dropOptions);
    inject(onlyDrop, Buffer.alloc(300, 'a'));
    const droppedEarly = dropLog.drop.length;
    inject(onlyDrop, '\n');
    t.ok('onDrop だけの口は、改行が届くまで知らせず、届いたとき（捨てた長さつき）に 1 回知らせる',
      droppedEarly === 0 && dropLog.drop.length === 1 && dropLog.drop[0].reason === 'oversize' && dropLog.drop[0].bytes === 300, JSON.stringify(dropLog));
    const [overflowLog, overflowOptions] = sizes({ overflow: true });
    const onlyOverflow = await open(overflowOptions);
    inject(onlyOverflow, Buffer.alloc(300, 'a'));
    const overflowedEarly = overflowLog.overflow.length;
    inject(onlyOverflow, '\n');
    t.ok('onOverflow だけの口は、改行を待たず上限を超えたと分かった時点で 1 回知らせ、改行では重ねて知らせない',
      overflowedEarly === 1 && overflowLog.overflow.length === 1 && overflowLog.overflow[0].reason === 'oversize', JSON.stringify(overflowLog));
    const both = { drop: [], overflow: [] };
    const bothClient = await open({ maxFrameBytes: 256, onDrop: info => both.drop.push(info), onOverflow: info => both.overflow.push(info) });
    inject(bothClient, Buffer.alloc(300, 'a'));
    inject(bothClient, '\n');
    t.ok('両方を渡した口は別々に知らせる（上限を超えた時点と、捨てた時点）', both.overflow.length === 1 && both.drop.length === 1, JSON.stringify(both));
    const afterDrop = [];
    const resume = await open({ maxFrameBytes: 256, onUpdate: params => afterDrop.push(params) });
    inject(resume, `${Buffer.alloc(300, 'a')}\n${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after drop' } } } })}\n`);
    t.ok('どちらも省くと既定で黙って捨て、次の行から読み続ける', afterDrop.length === 1 && afterDrop[0].update.content.text === 'after drop' && resume.alive === true);
    const dropped = await open({ maxFrameBytes: 256 });
    dropped.timeoutMs = 120;   // 起動（initialize）が済んでから縮める。捨てた行の後に付く期限はこの値
    const unbound = settle(dropped.call('fixture/no-reply', {}, { timeoutMs: 0 }));
    inject(dropped, `${Buffer.alloc(300, 'a')}\n`);
    const unboundResult = await unbound;
    t.ok('行を捨てたら、期限の無い依頼にも期限を付け、答えを待ち続けない（-32001）',
      unboundResult.error?.code === -32001 && unboundResult.error.message === 'Fake ACP request timed out after a dropped frame', JSON.stringify({ ...unboundResult.error, message: unboundResult.error?.message }));

    // ---- 壊れた行・壊れた枠
    for (const [label, frame, code, message] of [
      ['JSON でない行', '{not-json}\n', -32700, 'Invalid Fake ACP JSON frame'],
      ['jsonrpc が 2.0 でない枠', { id: 1, result: {} }, -32600, 'Invalid Fake ACP JSON-RPC frame'],
      ['method の無い id の無い枠', { jsonrpc: '2.0' }, -32600, 'Invalid Fake ACP response'],
    ]) {
      const goneFrames = [];
      const target = await open({ onGone: error => goneFrames.push(error) });
      const pending = settle(target.call('fixture/no-reply', {}, { timeoutMs: 0 }));
      inject(target, frame);
      const result = await pending;
      t.ok(`${label}は接続を失敗にし、依頼を安全なエラーで断る（${code}）`,
        result.error?.code === code && result.error.message === message && goneFrames.length === 1 && target.alive === false, JSON.stringify({ code: result.error?.code, message: result.error?.message }));
    }

    // ---- 起動に失敗したとき
    let goneMissing = null;
    const missing = launch({ command: [path.join(root, 'missing-command.exe')], onGone: error => { goneMissing = error; } });
    clients.push(missing);
    t.ok('起動に失敗すると、実行ファイルのパスや生の message を出さず、種別（ENOENT）だけを返す',
      await missing.start().then(() => false, e => e.message === 'Fake ACP process failed' && e.code === 'ENOENT' && !e.message.includes('missing-command'))
        && goneMissing?.code === 'ENOENT' && await missing.start().then(() => false, e => /closed/.test(e.message)));

    // ---- 保持役の子として起動する（held）。付け直し（adopt）は initialize を送らず、走っている prompt の応答の枠を開ける
    const heldLog = [];
    const fakeHeld = () => {
      let child = null;
      return {
        start({ argv, cwd, env }) { heldLog.push(['start', argv.slice(1).map(a => path.basename(a)).join(' ')]); child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); return child; },
        begin({ onLine }) { heldLog.push(['begin', typeof onLine]); },
        async open(from) { heldLog.push(['open', from]); return { pendingRequests: [{ requestId: '"req-3"' }] }; },
        kill() { heldLog.push(['kill']); child?.kill('SIGKILL'); },
        async close() { heldLog.push(['close']); if (!child) return; child.kill('SIGKILL'); await waitForExit(child, 3000); },
      };
    };
    const held = await open({ held: fakeHeld() });
    const heldSession = (await held.call('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    t.ok('held を渡すと、その口で子を起こして読みを始め、initialize を送って RPC が通る',
      heldLog[0]?.[0] === 'start' && heldLog[0][1].endsWith('acp') && heldLog.some(l => l[0] === 'begin' && l[1] === 'function') && held.init?.protocolVersion === 1 && /^devin-fixture-/.test(heldSession),
      JSON.stringify(heldLog));
    t.ok('open は付け直した子の答えていない依頼（pendingRequests）の id を覚える', await held.open(5).then(state => state.pendingRequests.length === 1) && held.pendingRequests.has('"req-3"') && heldLog.some(l => l[0] === 'open' && l[1] === 5));
    await held.close();
    t.ok('held の close は held.close に任せる（自分では木を落とさない）', heldLog.some(l => l[0] === 'close') && held.alive === false && !heldLog.some(l => l[0] === 'kill'), JSON.stringify(heldLog));

    heldLog.length = 0;
    const adopted = launch({ held: fakeHeld(), adopt: { promptId: 'pleiad-7' } });
    clients.push(adopted);
    const adoptedInit = await adopted.start();
    t.ok('adopt は initialize を送らず（init は null）、走っている prompt の枠を開け、番号をその続きから振る',
      adoptedInit === null && adopted.init === null && adopted.adopted === true && adopted.pendingPromptIds().join() === 'pleiad-7' && adopted.nextId === 7 && adopted.newId() === 'pleiad-8'
        && !heldLog.some(l => l[0] === 'begin'), JSON.stringify({ heldLog, ids: adopted.pendingPromptIds(), nextId: adopted.nextId }));
    adopted.begin();
    t.ok('adopt の読みは begin() で始める（写しを組み立てた後）', heldLog.filter(l => l[0] === 'begin').length === 1);
    const adoptedSettled = settle(adopted.running);
    inject(adopted, { jsonrpc: '2.0', id: 'pleiad-7', result: { stopReason: 'end_turn' } });
    t.ok('adopt した prompt の応答は running で受ける', (await adoptedSettled).value?.stopReason === 'end_turn');
    await adopted.close();
    const noPrompt = launch({ held: fakeHeld(), adopt: {} });
    clients.push(noPrompt);
    t.ok('adopt に走っている依頼の id が無ければ、起動を安全なエラーで断る',
      await noPrompt.start().then(() => false, e => e?.[SAFE_ERROR] === true && /adoption has no running request/.test(e.message)));
    await noPrompt.close();
    // 保持役の子が止まったとき: 保持役ごと失われた（status.lost）なら木を落とす相手が無いので kill を呼ばず、ただの終了なら kill を呼ぶ
    const exitOf = async (status) => {
      const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { writable: true, write() {}, destroy() {} }), stdout: new EventEmitter(), stderr: new EventEmitter() });
      const calls = [], gone = [];
      const exiting = launch({ held: { start: () => child, begin() {}, async open() { return null; }, kill: () => calls.push('kill'), close: async () => calls.push('close') }, adopt: { promptId: 'pleiad-2' }, onGone: error => gone.push(error) });
      clients.push(exiting);
      await exiting.start();
      const pending = settle(exiting.running);
      child.emit('exit', null, null, status);
      await exiting.reaping;
      return { calls, gone, alive: exiting.alive, error: (await pending).error };
    };
    const lostExit = await exitOf({ lost: true }), plainExit = await exitOf(undefined);
    t.ok('保持役ごと失われた子（exit の status.lost）は木を落とさず、ただの終了は落とす。どちらも走っている依頼を断って onGone を 1 回呼ぶ',
      lostExit.calls.length === 0 && plainExit.calls.join() === 'kill' && lostExit.alive === false && plainExit.alive === false
        && lostExit.gone.length === 1 && plainExit.gone.length === 1 && lostExit.error?.message === 'Fake ACP exited' && plainExit.error?.message === 'Fake ACP exited',
      JSON.stringify({ lostExit: lostExit.calls, plainExit: plainExit.calls }));
  } catch (error) {
    t.ok('acp-client の試験が途中で止まらない', false, error.stack);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
