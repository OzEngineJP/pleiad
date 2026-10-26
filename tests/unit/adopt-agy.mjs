// 段階 3（agy）: 保持役に載せた agy（偽物 tests/lib/fake-agy.mjs）を、サーバーの入れ替えをまたいで付け直す
// （docs/zero-downtime-update/stage3-agy.md。載せ方は core/backends/antigravity-held.mjs、付け直しは antigravity.mjs の adoptTurn）。
//   1. 載せるかの切り替え: 実行場所の置き場が無い・AGENT_HOST_AGY_HOLDER=off では agy は保持役の子にならない（今の流れ）。置き場があれば既定で載る。
//      ターンが終わった子は idle（札も印も無い）で、次のターンにも使われる
//   2. 途中で落とす（ADR 0270 の形: A を普通に止める。札はターンの間に保持役の子へ置き直されている）。同じデータ置き場で B が起動で付け直す。
//      時点: ツールの実行中（ゲートで止める）・A が居ない間に agy が result まで出した（終わった子）。どちらも turnEnd・completedAt・使用量（presentKey の 1 件）が
//      1 回だけ、本文・ツールの結果・人の発言は履歴に 1 回、restart の中断にならない。付け直した子は会話の次のターンにも使う（同じ agy。起こし直さない）。
//      A の最初の保持役の使用が、前のサーバーが残した idle の子を止める
//   3. 強制終了（2e の形。手を離す口を経ない）: ツールの実行中のまま A を SIGKILL しても、札の置き直しで B が付け直す
//   4. main が起こした起動（名前付きパイプ・同じトークンとポート）: A を普通に止めて B を起こすと、保持役の agy のターンを起動で付け直す。idle の agy は B の最初の保持役の使用が止める
//      （新サーバーは知らないので）。次のターンは agy を起こし直して続く
//   5. サーバーが普通に終わる（更新・落ちたとき）: 保持役の agy は止めない（アプリの終了だけが止める）
//   6. 後片付け: 保持役・偽の agy が残らない
// agy には対話承認が無いので、承認待ちの時点は無い。待ちは実時間でなく、ゲート（FAKE_AGY_GATE_DIR のファイル）と偽の agy が置く印のファイル
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');

export const name = 'adopt-agy';
export const title = '付け直し: 保持役に載せた agy（偽物）を、サーバーの入れ替えをまたいで途中から引き継ぐ';

const WAIT_MS = 20_000;
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

/** 偽の main（adopt-claude と同じ）: パイプにつなぎ、受けたメッセージを溜める */
async function attachMain(dataDir, server) {
  const pid = server.child.pid;
  const info = await until(() => { const found = readLinkInfo(dataDir); return found?.pid === pid ? found : null; }, WAIT_MS, `main-link.json (pid ${pid})`)
    .catch(error => { throw new Error(`${error.message}\n${server.tail(15)}`); });
  const link = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
  const seen = { messages: [] };
  link.on('message', message => {
    seen.messages.push(message);
    // Chrome の層は無い（答えないと、ターンごとに層の準備を待たされる）
    if (message.type === 'chrome-os-ready-request') link.postMessage({ type: 'chrome-os-ready', supported: false, reason: 'platform' });
  });
  await link.connect();
  return { link, seen, request: async (type, extra = {}, ms = 40_000) => {
    const id = Math.floor(Math.random() * 1e9);
    link.postMessage({ ...extra, type, id });
    return until(() => seen.messages.find(m => m.type === type && m.id === id), ms, `${type} の答え`);
  } };
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-agy-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const work = path.join(scratch, 'work');
  const pidFile = path.join(scratch, 'agy-pids.json');
  await fs.mkdir(work, { recursive: true });
  const gates = await createFakeGates(scratch);
  const gateDir = gates.env.AGENT_HOST_FAKE_GATE_DIR;
  const gateDone = name => fs.stat(path.join(gateDir, `${name}.done`)).then(() => true, () => false);
  const fake = path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs');
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = key => (readUsage(dataDir)?.records ?? []).filter(r => r.id === key);
  const spawned = async () => JSON.parse(await fs.readFile(pidFile, 'utf8').catch(() => '[]'));
  const base = { AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: `node "${fake}"`, FAKE_AGY_PID_FILE: pidFile, FAKE_AGY_GATE_DIR: gateDir };
  const env = { ...base, AGENT_HOST_RUNTIME_ROOT: root };
  /** 保持役の子（agy のもの）。つなぐと親の座を取るので、サーバーが動いている間は呼ばない */
  const heldChildren = async () => {
    const probe = await connectHolder({ dataDir, root });
    const children = probe.welcome.children.filter(c => c.id.startsWith('agy-'));
    probe.close();
    return children;
  };
  let a = null, b = null, ca = null, cb = null, m1 = null, m2 = null, holderPid = null;
  try {
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // 1. 切り替え。置き場が無い・off は載せない。置き場があれば既定で載る
    let leftover = null;   // 手を離さずに終わらせたサーバーが残した idle の子（2 で A の最初の使用が止める）
    for (const [label, extra, expectHeld] of [['実行場所の置き場が無い', {}, false], ['AGENT_HOST_AGY_HOLDER=off', { AGENT_HOST_RUNTIME_ROOT: root, AGENT_HOST_AGY_HOLDER: 'off' }, false], ['置き場があれば既定で載せる', { AGENT_HOST_RUNTIME_ROOT: root }, true]]) {
      const s = await startServer({ env: { ...base, ...extra }, dataDir, timeoutMs: 30_000 });
      const c = await open({ port: s.port, token: s.token });
      try {
        const res = await c.runTurn({ backend: 'antigravity', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', `${label}: ${s.tail(10)}`);
        const children = await heldChildren();
        if (!expectHeld) assert.equal(children.length, 0, `${label}: agy は保持役の子にならない`);
        else {
          assert.equal(children.length, 1, `${label}: agy は保持役の子になる`);
          // 札と印を外す依頼は、ターンの終わりにサーバーが送る（保持役が読み終えるまで少しかかる）
          const child = await until(async () => { const [one] = await heldChildren(); return one && one.marks.turn === undefined ? one : null; }, WAIT_MS, 'ターンが終わった子の印が外れる');
          assert.equal(child.alive, true);
          assert.equal(child.policy, 'none', 'agy の子は行だけ（policy none）');
          assert.ok((await spawned()).includes(child.pid), '保持役の子の pid は偽の agy の pid');
          assert.equal(child.label, null, 'ターンが終わった子は札を持たない（付け直す対象でない）');
          leftover = child;
        }
      } finally { c.close(); await s.stop(); }
    }
    t.ok('切り替え: 置き場が無い・off では保持役に載せない。置き場があれば既定で載り、ターンが終わった子は札も印も無い idle', true);

    // 2. 途中で引き継ぐ
    a = await startServer({ env, dataDir, timeoutMs: 30_000 });
    ca = await open({ port: a.port, token: a.token });
    const ids = {};
    for (const k of ['T', 'F', 'K', 'R', 'I', 'X']) {
      const res = await ca.runTurn({ backend: 'antigravity', cwd: work, prompt: `hello ${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok', a.tail(10));
      ids[k] = res.sessionId;
      if (k === 'T') await until(() => !alive(leftover.pid), 10_000, '前のサーバーが残した idle の子は、A の最初の保持役の使用が止める')
        .catch(async error => { throw new Error(`${error.message}\n${a.tail(15)}\n[holder.log]\n${(await fs.readFile(path.join(root, 'logs', 'holder.log'), 'utf8').catch(() => '')).split('\n').slice(-15).join('\n')}`); });
    }
    assert.ok((await spawned()).length >= 6, '会話ごとに別の agy');
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
    const markA = ca.mark();
    void ca.cmd('sendMessage', { sessionId: ids.T, messageId: 'adopt-T-0001', prompt: 'gated:t-tool' }).catch(() => {});
    void ca.cmd('sendMessage', { sessionId: ids.F, messageId: 'adopt-F-0001', prompt: 'gated:f-fin' }).catch(() => {});
    for (const k of ['T', 'F']) await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids[k], { ms: WAIT_MS, from: markA });
    await sleep(800);   // 札の置き直し（touchCard）が保持役へ届くまで
    ca.close(); ca = null;
    // A を普通に落とす（更新・落ちたときと同じ道。保持役の子は止めない）
    await a.kill(); a = null;
    // F: A が居ない間に agy が result まで出す（終わった直後の形）。T はゲートのまま走り続ける
    await gates.open('f-fin');
    await until(() => gateDone('f-fin'), WAIT_MS, 'F の agy が result を出し終える');
    const taken = {};
    {
      const children = await heldChildren();
      for (const k of ['T', 'F']) {
        const child = children.find(c => c.label?.sessionId === ids[k]);
        assert.ok(child, `${k}: 札つきの子が残る`);
        assert.ok(Number.isInteger(child.marks.turn), `${k}: ターンの印がある`);
        taken[k] = { card: child.label };
      }
      // agy はターンが終わっても会話のあいだ生きる（idle）。A が居ない間に result まで書き、誰も読んでいない
      const f = children.find(c => c.label?.sessionId === ids.F);
      assert.ok(f.seq > f.acked, 'F: A が処理していない行（result）が記録に残る');
      assert.equal(children.find(c => c.label?.sessionId === ids.T).alive, true, 'T: agy は走り続けている');
    }
    for (const k of ['T', 'F']) {
      const agy = taken[k].card.backendCard?.agy;
      assert.equal(taken[k].card.backendCard?.held, true, `${k}: 札に agy の欄`);
      assert.ok(Number.isFinite(agy?.sentAt) && typeof agy.sentHash === 'string', `${k}: 札に発言の時刻とハッシュ`);
      assert.equal(agy.resumed, true, `${k}: 再開した会話`);
      assert.ok(agy.keys && typeof agy.keys === 'object', `${k}: 札に次のターンの印の比べ`);
      assert.ok(!JSON.stringify(taken[k]).includes('gated:'), `${k}: 発言の本文は札に無い`);
      assert.ok(!/Bearer|[a-f0-9]{64}/.test(JSON.stringify(agy)), `${k}: 札のバックエンドの欄にトークンは入らない`);
    }

    b = await startServer({ env, dataDir, timeoutMs: 30_000 });
    cb = await open({ port: b.port, token: b.token });
    await gates.open('t-tool');
    for (const k of ['T', 'F']) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS }).catch(e => { throw new Error(`${k}: ${e.message}\n${b.tail(20)}`); });
    await sleep(300);
    for (const k of ['T', 'F']) {
      const id = ids[k];
      const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
      assert.deepEqual(ends.map(e => e.outcome), ['ok'], `${k}: turnEnd は 1 回で ok`);
      const meta = sessionMeta(id);
      assert.equal(meta.interrupted ?? null, null, `${k}: restart の中断にならない`);
      assert.equal(meta.turnStartedAt ?? null, null, `${k}: 走っている印は片付く`);
      assert.ok(meta.completedAt > before[k], `${k}: 完了時刻を書く`);
      assert.equal(usageOf(taken[k].card.presentKey).length, 1, `${k}: 使用量は presentKey で 1 件`);
      const loaded = await cb.cmd('loadSession', { sessionId: id });
      assert.equal(loaded.messages.filter(m => m.role === 'user' && m.text === `gated:${k === 'T' ? 't-tool' : 'f-fin'}`).length, 1, `${k}: 人の発言は履歴に 1 回`);
      const finals = loaded.messages.filter(m => m.role === 'assistant' && String(m.text).includes(`終わり: ${k === 'T' ? 't-tool' : 'f-fin'}`));
      assert.equal(finals.length, 1, `${k}: 最後の本文は履歴に 1 回 ${b.tail(40)}`);
      assert.equal(finals[0].text, `前置き。終わり: ${k === 'T' ? 't-tool' : 'f-fin'}`, `${k}: 本文は再生と続きで欠けず重ならない`);
      const calls = loaded.messages.flatMap(m => m.toolCalls ?? []).filter(c => String(c.result?.text).startsWith('out-'));
      assert.deepEqual(calls.map(c => c.result.text), [`out-${k === 'T' ? 't-tool' : 'f-fin'}`], `${k}: ツールの結果は 1 回`);
    }
    assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
    assert.ok(b.tail(200).includes('ターンを付け直した'), b.tail(20));
    t.ok('ツールの実行中: B が印からの再生と続きで締め、turnEnd・completedAt・使用量は 1 回。本文・ツールの結果・人の発言は履歴に 1 回', true);
    t.ok('終わった直後（A が読まないうちに agy が result まで出した）: B が続きの result で締める。同じく 1 回', true);

    cb.close(); cb = null;
    await b.stop(); b = null;

    // 中断（引き継ぎとは別: 保持役に載った agy のターンを止める）: agy は木ごと止まり、保持役の子の記録は捨てられ、会話の次のターンは agy を起こし直して続く
    {
      a = await startServer({ env, dataDir, timeoutMs: 30_000 });
      ca = await open({ port: a.port, token: a.token });
      const markX = ca.mark();
      void ca.cmd('sendMessage', { sessionId: ids.X, messageId: 'abort-X-0001', prompt: 'gated:x-never' }).catch(() => {});
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.X, { ms: WAIT_MS, from: markX });
      const xPid = (await spawned()).at(-1);
      assert.ok(alive(xPid));
      await ca.cmd('abort', { sessionId: ids.X });
      const end = await ca.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.X, { ms: WAIT_MS, from: markX });
      assert.equal(end.outcome, 'aborted', '中断で終わる');
      await until(() => !alive(xPid), 10_000, '中断した agy が止まる');
      const spawnedBefore = (await spawned()).length;
      const again = await ca.runTurn({ backend: 'antigravity', sessionId: ids.X, cwd: work, prompt: 'after abort X' }, { ms: WAIT_MS });
      assert.equal(again.outcome, 'ok', a.tail(10));
      assert.equal((await spawned()).length, spawnedBefore + 1, '中断した会話の次のターンは agy を起こし直す');
      t.ok('中断: 保持役に載った agy は止まり、記録が捨てられ、次のターンは起こし直して続く', true);
      ca.close(); ca = null;
      await a.stop(); a = null;
      // サーバーが動いている間に保持役へつなぐと、その親の座を取ってしまう（A の読みが切れる）ので、止めた子の記録が捨てられたかは A が終わってから見る
      assert.ok(!(await heldChildren()).some(c => c.pid === xPid), '止めた子の記録は保持役から捨てられている');
    }

    // 3. 強制終了: ツールの実行中のまま A2 を落とす。札は agy を起こした直後に置いてある（A2 がツールの出来事を受け取る前に、保持役へ届いている）
    {
      a = await startServer({ env, dataDir, timeoutMs: 30_000 });
      ca = await open({ port: a.port, token: a.token });
      const markK = ca.mark();
      const doneBefore = sessionMeta(ids.K).completedAt;
      void ca.cmd('sendMessage', { sessionId: ids.K, messageId: 'crash-K-0001', prompt: 'gated:k-tool' }).catch(() => {});
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.K, { ms: WAIT_MS, from: markK });
      ca.close(); ca = null;
      await a.kill(); a = null;
      b = await startServer({ env, dataDir, timeoutMs: 30_000 });
      cb = await open({ port: b.port, token: b.token });
      await gates.open('k-tool');
      const end = await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.K, { ms: WAIT_MS }).catch(e => { throw new Error(`${e.message}\n${b.tail(20)}`); });
      await sleep(300);
      assert.equal(end.outcome, 'ok');
      assert.equal(cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids.K).length, 1);
      assert.ok(sessionMeta(ids.K).completedAt > doneBefore);
      assert.equal(sessionMeta(ids.K).interrupted ?? null, null, '強制終了でも restart の中断にならない');
      const loaded = await cb.cmd('loadSession', { sessionId: ids.K });
      assert.equal(loaded.messages.filter(m => m.role === 'assistant' && String(m.text).includes('終わり: k-tool')).length, 1, '最後の本文は履歴に 1 回');
      t.ok('強制終了（手を離す口を経ない）: 札の置き直しで B が付け直し、ツールが終わると続いて 1 回だけ締まる', true);
      cb.close(); cb = null;
      await b.stop(); b = null;
    }

    // 4. main が起こした起動（名前付きパイプ・同じトークンとポート）。R は実行中（ゲートで止める）、I は ターンが終わって idle の agy
    {
      const envH = { ...env, AGENT_HOST_HANDOVER: 'on', AGENT_HOST_GRACE_MS: '600000' };
      a = await startServer({ env: envH, dataDir, timeoutMs: 40_000 });
      m1 = await attachMain(dataDir, a);
      ca = await open({ port: a.port, token: a.token });
      const markH = ca.mark();
      // R と I を、この A で（それぞれ 1 ターン）走らせて、I だけ idle にする
      const idleRes = await ca.runTurn({ backend: 'antigravity', sessionId: ids.I, cwd: work, prompt: 'again I' }, { ms: WAIT_MS });
      assert.equal(idleRes.outcome, 'ok', a.tail(10));
      const doneBeforeR = sessionMeta(ids.R).completedAt;
      void ca.cmd('sendMessage', { sessionId: ids.R, messageId: 'handover-R-0001', prompt: 'gated:r-tool' }).catch(() => {});
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.R, { ms: WAIT_MS, from: markH });
      // 起こした順（I → R）。I は idle、R は実行中
      const [idlePid, rPid] = (await spawned()).slice(-2);
      const portA = a.port, tokenA = a.token;
      await sleep(800);   // 札の置き直しが保持役へ届くまで
      ca.close(); ca = null;
      await a.kill(); a = null;
      b = await startServer({ env: { ...envH, AGENT_HOST_PORT: String(portA), AGENT_HOST_TOKEN: tokenA }, dataDir, timeoutMs: 60_000 });
      assert.equal(b.port, portA, 'B は A と同じポートで待ち受ける');
      m2 = await attachMain(dataDir, b);
      // B は起動で保持役につなぎ、付け直す。この間に保持役へつなぐと親の座を取ってしまうので、見るのは pid だけ
      assert.ok(alive(rPid), '付け直したターンの agy は走り続ける');
      cb = await open({ port: portA, token: tokenA });
      await gates.open('r-tool');
      await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.R, { ms: WAIT_MS }).catch(e => { throw new Error(`${e.message}\n${b.tail(20)}`); });
      await sleep(300);
      assert.deepEqual(cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids.R).map(e => e.outcome), ['ok'], 'R: turnEnd は 1 回で ok');
      assert.equal(sessionMeta(ids.R).interrupted ?? null, null, 'R: 中断にならない');
      assert.ok(sessionMeta(ids.R).completedAt > doneBeforeR, 'R: 完了時刻を書く');
      const spawnedBefore = (await spawned()).length;
      // 付け直した agy は会話の次のターンも使う（B は A と同じポート・トークンなので、起動時にしか渡せないものの印は変わらない）
      const nextR = await cb.runTurn({ backend: 'antigravity', sessionId: ids.R, cwd: work, prompt: 'next turn R' }, { ms: WAIT_MS });
      assert.equal(nextR.outcome, 'ok', b.tail(10));
      assert.equal((await spawned()).length, spawnedBefore, 'R: 付け直した agy が次のターンも使われる（起こし直さない）');
      // B の最初の agy の使用（sweepIdle）が、前のサーバーが残した idle の agy（札も印も無い）を止める
      await until(() => !alive(idlePid), 10_000, 'idle の agy を B の最初の agy の使用が止める');
      // idle だった I の次のターンは、B が agy を起こし直して続く
      const next = await cb.runTurn({ backend: 'antigravity', sessionId: ids.I, cwd: work, prompt: 'after handover I' }, { ms: WAIT_MS });
      assert.equal(next.outcome, 'ok', b.tail(10));
      assert.equal((await spawned()).length, spawnedBefore + 1, 'I: idle だった会話の次のターンは agy を起こし直す');
      assert.ok(!b.tail(300).includes('[unhandledRejection]'), b.tail(20));
      t.ok('main が起こした起動: A を普通に止めて B を起こすと、保持役の agy のターンを起動で付け直して 1 回だけ締まる。idle の agy は B の最初の保持役の使用が止め、次のターンは起こし直して続く', true);
      t.ok('付け直した agy は会話の次のターンにも使われる（B が同じポート・トークンなので印の比べが合う）', true);

      // 5. サーバーが普通に終わる（更新・落ちたとき）: 保持役の agy は止めない（次の起動が拾う。止めるのはアプリの終了だけ）。
      //    この間も保持役へはつながない（B の親の座を取らない）
      {
        const pids = [rPid, (await spawned()).at(-1)];
        cb.close(); cb = null;
        m2.link.kill(); m2 = null;
        await until(() => b.child.exitCode !== null, 20_000, 'B が終わる');
        b = null;
        await sleep(500);
        for (const pid of pids) assert.ok(alive(pid), `保持役の agy（${pid}）はサーバーが終わっても止まらない`);
        t.ok('サーバーが普通に終わる（更新・落ちたとき）: 保持役の agy は止まらない（アプリの終了だけが止める）', true);
      }
      m1 = null;   // A と一緒に切れている
      a = null;
    }

    // 6. 後片付け
    {
      // 終わりを待つのは、保持役が今生きていると言う子だけ。起動の記録の pid を全部待つと、とっくに終わって別のプロセスへ使い回された pid
      // （Windows は早く使い回す）を「終わらない」と取り違える
      const probe = await connectHolder({ dataDir, root });
      const pids = new Set(probe.welcome.children.filter(c => c.pid && c.alive).map(c => c.pid));
      probe.shutdown();
      probe.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる');
      for (const pid of pids) await until(() => !alive(pid), 10_000, `偽の agy（${pid}）が終わる`);
      holderPid = null;
      t.ok('後片付け: 保持役・偽の agy が残らない', true);
    }
  } finally {
    ca?.close();
    cb?.close();
    for (const m of [m1, m2]) { try { m?.link?.kill(); } catch { /* 終わっていれば何もしない */ } }
    await a?.stop();
    await b?.stop();
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
