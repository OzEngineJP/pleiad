// 無停止の更新: 保持役に載せた OpenCode の共有のサーバー（身代わり。tests/lib/fake-opencode.mjs）を、サーバーの入れ替えをまたいで引き継ぐ
// （載せ方は core/backends/opencode-held.mjs、組み立て直しは core/backends/opencode.mjs の adoptTurn、ADR 0221）。
//   1. 載せるかの切り替え: AGENT_HOST_OPENCODE_HOLDER=off では OpenCode は保持役の子にならない（今の流れ）
//   2. 本当に終わる（main の shutdown）ときは、手を離していない OpenCode も止める
//   3. 通常停止と起動: 承認待ち・ツールの実行中・本文の途中の 3 つのターンを、OpenCode を起こし直さずに復元する。
//      承認は同じ id で 1 つ、本文は欠けも重なりもなく、turnEnd・completedAt・使用量は 1 回。
//      復元後も、中継の口（Pleiad の MCP・会話のシェルの環境変数）が同じトークンで通る
//   4. ターンの無い通常起動: OpenCode の共有サーバーは起こし直さない
//   5. 強制終了（手を離す口を経ない）: 承認待ちのまま落ちても、札の置き直しで新しいサーバーが付け直す。待ち受けのポートが変わったら、
//      ターンが無くなってから OpenCode を起こし直す（中継の口の URL が古い）
//   6. 後片付け: 保持役・身代わりの OpenCode が残らない
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

export const name = 'adopt-opencode';
export const title = '付け直し: 通常停止後に保持役の OpenCode サーバー（身代わり）を起動時に付け直す';

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

/** 偽の main（tests/unit/adopt-codex.mjs と同じ）: パイプにつなぎ、受けたメッセージを溜める */
async function attachMain(dataDir, server) {
  const pid = server.child.pid;
  const info = await until(() => { const found = readLinkInfo(dataDir); return found?.pid === pid ? found : null; }, WAIT_MS, `main-link.json (pid ${pid})`)
    .catch(error => { throw new Error(`${error.message}\n${server.tail(15)}`); });
  const link = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
  const seen = { messages: [] };
  link.on('message', message => {
    seen.messages.push(message);
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
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-opencode-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const work = path.join(scratch, 'work');
  const ocData = path.join(scratch, 'oc-data');
  const startedFile = path.join(scratch, 'oc-started.txt');
  await Promise.all([work, ocData].map(dir => fs.mkdir(dir, { recursive: true })));
  const gates = await createFakeGates(scratch);
  const fake = path.join(ROOT, 'tests', 'lib', 'fake-opencode.mjs');
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = id => (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === id).length;
  /** 身代わりの OpenCode が起こされた回数と pid（FAKE_OPENCODE_STARTED_FILE） */
  const starts = async () => (await fs.readFile(startedFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  const env = {
    AGENT_HOST_BACKENDS: 'opencode', AGENT_HOST_OPENCODE_BIN: `node "${fake}"`, AGENT_HOST_OPENCODE_DATA: ocData, FAKE_OPENCODE_STARTED_FILE: startedFile,
    AGENT_HOST_RUNTIME_ROOT: root, ...gates.env,
  };
  const envH = { ...env, AGENT_HOST_HANDOVER: 'on' };
  /** 保持役の子（サーバーが居ない間にだけ見る。つなぐと親が替わる） */
  const holderChildren = async () => {
    const probe = await connectHolder({ dataDir, root });
    try { return probe.welcome.children.filter(x => !x.id.startsWith('chrome-link-')); } finally { probe.close(); }
  };
  const text = (client, id) => client.events.filter(e => e.type === 'text.delta' && e.sessionId === id).map(e => e.text).join('');
  const assertEndedOnce = (client, id, doneBefore, label) => {
    const ends = client.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
    assert.deepEqual(ends.map(e => e.outcome), ['ok'], `${label}: turnEnd は 1 回で ok`);
    const meta = sessionMeta(id);
    assert.equal(meta.interrupted ?? null, null, `${label}: restart・update の中断にならない`);
    assert.equal(meta.stops ?? null, null, `${label}: 付け直した承認を取り下げた記録が残らない`);
    assert.equal(meta.turnStartedAt ?? null, null, `${label}: 走っている印は片付く`);
    // 前の値と比べて大きいかではなく、書き換わったかを見る（WSL2 などは時刻合わせで時計が戻ることがある）
    assert.ok(Number.isFinite(meta.completedAt) && meta.completedAt !== doneBefore, `${label}: 完了時刻を書く`);
  };
  const assistantTexts = async (client, id) => (await client.cmd('loadSession', { sessionId: id })).messages.filter(m => m.role === 'assistant').map(m => m.text);
  let token = null;
  let s1 = null, s2 = null, s3 = null, s4 = null, c1 = null, c2 = null, c3 = null, c4 = null, m1 = null, m2 = null, m3 = null, holderPid = null;
  try {
    // 保持役は、子も親も居ない間が idleMs 続くと終わる。遅い環境（WSL など）で 1 の起動とターンの間に終わらないよう長めにする（後片付けで止める）
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 120_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // 1. 載せるかの切り替え: off では保持役の子にならない
    {
      const s = await startServer({ env: { ...env, AGENT_HOST_OPENCODE_HOLDER: 'off' }, dataDir, timeoutMs: 40_000 });
      const c = await open({ port: s.port, token: s.token, autoAllow: true });
      try {
        const res = await c.runTurn({ backend: 'opencode', cwd: work, prompt: 'plain', mode: 'full', model: 'fake/echo' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', s.tail(10));
      } finally { c.close(); await s.stop(); }
      assert.deepEqual((await holderChildren()).map(x => x.id), [], 'off: OpenCode は保持役の子にならない');
      t.ok('切り替え: AGENT_HOST_OPENCODE_HOLDER=off では OpenCode は保持役の子にならない（今の流れ）', true);
    }

    // 2. 本当に終わる（main の shutdown）ときは、手を離していない OpenCode も止める（保持役の子は、サーバーが終わっても残るため）
    {
      const s = await startServer({ env: envH, dataDir, timeoutMs: 40_000 });
      const main = await attachMain(dataDir, s);
      const c = await open({ port: s.port, token: s.token, autoAllow: true });
      try {
        assert.doesNotMatch(s.tail(200), /MaxListenersExceededWarning/, 'main につないだサーバーの起動時の購読は上限を超えない');
        const res = await c.runTurn({ backend: 'opencode', cwd: work, prompt: 'shutdown check', mode: 'full', model: 'fake/echo' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', JSON.stringify(res.events.filter(e => e.type === 'turnResult').map(e => e.error)) + '\n' + s.tail(10));
        const pid = (await starts()).at(-1);
        assert.ok(alive(pid), '終わる前: OpenCode は走っている');
        c.close();
        main.link.postMessage({ type: 'shutdown', stopHeld: true });
        await until(() => s.child.exitCode !== null, WAIT_MS, 'サーバーが終わる');
        await until(() => !alive(pid), WAIT_MS, '手を離していない OpenCode は、サーバーが終わると止まる');
      } finally { c.close(); try { main.link.kill(); } catch { /* 終わっている */ } await s.stop(); }
      t.ok('本当に終わるとき: 手を離していない OpenCode（保持役の子）も止める', true);
    }

    // 3. 通常停止と起動: 承認待ち（Q）・ツールの実行中（S）・本文の途中（T）
    const ids = {};
    const helloEnds = {};
    {
      s1 = await startServer({ env: envH, dataDir, timeoutMs: 40_000 });
      m1 = await attachMain(dataDir, s1);
      c1 = await open({ port: s1.port, token: s1.token });
      // B は、同じトークン・ポートで通常起動する
      token = s1.token;
      for (const k of ['Q', 'S', 'T']) {
        const res = await c1.runTurn({ backend: 'opencode', cwd: work, prompt: `hello ${k}`, mode: 'full', model: 'fake/echo' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', s1.tail(10));
        ids[k] = res.sessionId;
        helloEnds[k] = res.events.filter((x) => x.type === 'turnEnd' && x.sessionId === res.sessionId).map((x) => x.completedAt);
      }
      const ocPid = (await starts()).at(-1);
      const startsBefore = (await starts()).length;
      const doneBefore = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id).completedAt]));
      const usageBefore = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, usageOf(id)]));
      const mark = c1.mark();
      void c1.cmd('sendMessage', { sessionId: ids.Q, messageId: 'restart-Q-0001', prompt: 'ask Q' }).catch(() => {});
      void c1.cmd('sendMessage', { sessionId: ids.S, messageId: 'restart-S-0001', prompt: 'gate:s-tool' }).catch(() => {});
      void c1.cmd('sendMessage', { sessionId: ids.T, messageId: 'restart-T-0001', prompt: 'stream:t-text' }).catch(() => {});
      const askA = await c1.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: mark });
      await c1.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.S, { ms: WAIT_MS, from: mark });
      await until(() => c1.since(mark).filter(e => e.type === 'text.delta' && e.sessionId === ids.T).map(e => e.text).join('').includes('first half t-text / '), WAIT_MS, 'T の本文の前半');
      const portA = s1.port;
      c1.close(); c1 = null;
      await s1.stop(); s1 = null;
      s2 = await startServer({ env: { ...envH, AGENT_HOST_PORT: String(portA), AGENT_HOST_TOKEN: token }, dataDir, timeoutMs: 60_000 });
      assert.equal(s2.port, portA, 'B は A と同じポートで通常起動する');
      m2 = await attachMain(dataDir, s2);
      c2 = await open({ port: s2.port, token });
      const askB = await c2.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS }).catch(e => { throw new Error(`${e.message}\n${s2.tail(25)}`); });
      await sleep(300);
      assert.equal(askB.id, askA.id, 'Q: 承認の id は S1 と同じ');
      assert.equal(c2.events.filter(e => e.type === 'permission' && e.sessionId === ids.Q).length, 1, 'Q: B に承認が 1 つだけ');
      await c2.cmd('resolvePermission', { id: askB.id, allow: true });
      await gates.open('s-tool');
      await gates.open('t-text');
      for (const k of Object.keys(ids)) await c2.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS }).catch(e => { throw new Error(`${k}: ${e.message}\n${s2.tail(25)}`); });
      // 完了時刻と使用量は turnEnd の後に書かれる（遅い環境で決め打ちの待ちでは足りない）
      for (const k of Object.keys(ids)) await until(() => sessionMeta(ids[k])?.completedAt !== doneBefore[k] && usageOf(ids[k]) > usageBefore[k], WAIT_MS, `${k} の完了時刻と使用量`).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify({ completedAt: sessionMeta(ids[k])?.completedAt, doneBefore: doneBefore[k], interrupted: sessionMeta(ids[k])?.interrupted, usage: usageOf(ids[k]), usageBefore: usageBefore[k], ends: c2.events.filter((x) => x.type === 'turnEnd' && x.sessionId === ids[k]).map((x) => [x.outcome, x.completedAt]), helloEnds: helloEnds[k] })}`); });
      await sleep(300);
      for (const k of Object.keys(ids)) {
        assertEndedOnce(c2, ids[k], doneBefore[k], k);
        assert.equal(usageOf(ids[k]), usageBefore[k] + 1, `${k}: 使用量はこのターンの分が 1 件`);
      }
      assert.equal((await assistantTexts(c2, ids.Q)).filter(x => x.includes('allowed (once)')).length, 1, 'Q: 承認の後の本文は履歴に 1 回');
      assert.equal((await assistantTexts(c2, ids.S)).filter(x => x.includes('gate s-tool done')).length, 1, 'S: 最後の本文は履歴に 1 回');
      assert.deepEqual((await assistantTexts(c2, ids.T)).filter(x => x.includes('t-text')), ['first half t-text / second half t-text'], 'T: 本文は欠けも重なりもない');
      assert.ok(!text(c2, ids.T).includes('first half t-text / first half'), 'T: S2 の流れに前半が重ならない');
      assert.deepEqual(await starts(), (await starts()).slice(0, startsBefore), 'OpenCode を起こし直さない');
      assert.ok(alive(ocPid), '同じ OpenCode が走り続けている');
      assert.ok(!s2.tail(300).includes('[unhandledRejection]'), s2.tail(20));
      assert.ok(s2.tail(300).includes('ターンを付け直した'), s2.tail(20));
      t.ok('通常停止後の起動復元: 承認待ち・ツールの実行中・本文の途中の OpenCode のターンを B が同じ OpenCode につなぎ直して付け直す。承認は同じ id で 1 つ、本文は欠けも重なりもなく、turnEnd・completedAt・使用量は 1 回', true);

      // 起動復元の後も、中継の口（同じトークン）が通る: Pleiad の MCP と会話のシェルの環境変数
      const mcp = await c2.runTurn({ sessionId: ids.Q, prompt: `mcp:${JSON.stringify({ server: 'ply_agents', tool: 'ply_task_list', arguments: {} })}`, mode: 'full' }, { ms: WAIT_MS });
      assert.equal(mcp.outcome, 'ok', s2.tail(15));
      const mcpResult = mcp.events.find(e => e.type === 'tool.result' && e.sessionId === ids.Q)?.text ?? '';
      assert.ok(!/not available|Unauthorized|no mcp server/i.test(mcpResult) && mcpResult.length > 0, `MCP の中継: ${mcpResult}`);
      const envTurn = await c2.runTurn({ sessionId: ids.S, prompt: 'env', mode: 'full' }, { ms: WAIT_MS });
      assert.equal(envTurn.outcome, 'ok', s2.tail(15));
      assert.match(text(c2, ids.S), /env: \{/, 'シェルの環境変数の口');
      assert.doesNotMatch(text(c2, ids.S), /"status":40\d/, 'シェルの環境変数の口は前の合言葉で通る');
      assert.deepEqual(await starts(), (await starts()).slice(0, startsBefore), '続きのターンでも OpenCode を起こし直さない');
      t.ok('起動復元の後: 中継の口（Pleiad の MCP・会話のシェルの環境変数）は同じトークンで通り、続きのターンも同じ OpenCode で走る', true);
      try { m1.link.kill(); } catch { /* S1 は終わっている */ }
      m1 = null;
      s1 = null;
      s3 = s2; s2 = null;
      c3 = c2; c2 = null;
      m3 = m2; m2 = null;
    }

    // 5. 強制終了: 承認待ちのまま S3 を落とす。S4 は札（置き直し）で付け直す。待ち受けが変われば、ターンが無くなってから起こし直す
    {
      const startsBefore = (await starts()).length;
      const oldPid = (await starts()).at(-1);
      const doneBefore = sessionMeta(ids.Q).completedAt;
      const prevPort = s3.port;
      // 承認を自分で答えるつなぎ（4 のつなぎは自動で許可する）
      c3.close(); c3 = null;
      c3 = await open({ port: s3.port, token });
      void c3.cmd('sendMessage', { sessionId: ids.Q, messageId: 'crash-Q-0001', prompt: 'ask crash' }).catch(() => {});
      const askA = await c3.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
      await sleep(600);   // 札の置き直しが保持役へ届くまで
      c3.close(); c3 = null;
      try { m3.link.kill(); } catch { /* 終わっている */ }
      m3 = null;
      // 強制終了（SIGKILL）。stop() は Linux ではシグナルでサーバーの終わりの処理を走らせ、手を離していない OpenCode も止めてしまう（本番の落ち方ではない）
      await s3.kill(); s3 = null;
      s4 = await startServer({ env, dataDir, timeoutMs: 40_000 });
      c4 = await open({ port: s4.port, token: s4.token });
      const askB = await c4.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS }).catch(e => { throw new Error(`${e.message}\n${s4.tail(25)}`); });
      assert.equal(askB.id, askA.id, '強制終了: 承認の id は前と同じ');
      // 付け直しの最中は起こし直さない（ターンが終わった後は、待ち受けが変わったので次の問い合わせで起こし直してよい）
      assert.equal((await starts()).length, startsBefore, '付け直しでは OpenCode を起こし直さない');
      await c4.cmd('resolvePermission', { id: askB.id, allow: true });
      await c4.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.Q, { ms: WAIT_MS });
      await until(() => sessionMeta(ids.Q)?.completedAt !== doneBefore, WAIT_MS, '強制終了の Q の完了時刻');
      await sleep(300);
      assertEndedOnce(c4, ids.Q, doneBefore, '強制終了の Q');
      // S4 は別のポート（startServer が選ぶ）。ターンが無くなったので、次のターンで OpenCode を起こし直す（中継の口の URL が古い）
      if (s4.port !== prevPort) {
        // 身代わりの OpenCode は会話をメモリにだけ持つ（本物はディスクに残す）ので、起こし直した後は新しい会話で確かめる
        const res = await c4.runTurn({ backend: 'opencode', cwd: work, prompt: 'env', mode: 'full', model: 'fake/echo' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', s4.tail(15));
        assert.equal((await starts()).length, startsBefore, '新しい中継を参照し、OpenCode を起こし直さない');
        assert.ok(alive(oldPid),'会話を保持する OpenCode が継続する');
        assert.match(text(c4, res.sessionId), /env: \{/, s4.tail(15));
        assert.doesNotMatch(text(c4, res.sessionId), /"status":40\d/, '起こし直した OpenCode の中継の口が通る');
      }
      t.ok('強制終了: 同じ id の承認で復元し、ポート変更後も OpenCode を止めずに中継を付け直す', true);
    }
  } catch (error) {
    const brief = client => (client?.events ?? []).slice(-25).map(e => `${e.type}${e.sessionId ? `:${String(e.sessionId).slice(-6)}` : ''}`).join(' ');
    const failures = (c4 ?? c3 ?? c2 ?? c1)?.events.filter(e => e.type === 'turnResult' && e.outcome === 'error').map(e => ({ sessionId: e.sessionId, error: e.error }));
    error.message += `\n  turn failures: ${JSON.stringify(failures ?? [])}`;
    error.message += `\n  events: ${brief(c4 ?? c3 ?? c2 ?? c1)}\n  tail: ${(s4 ?? s3 ?? s2 ?? s1)?.tail(20)}`;
    throw error;
  } finally {
    for (const c of [c1, c2, c3, c4]) c?.close();
    for (const m of [m1, m2, m3]) { try { m?.link?.kill(); } catch { /* 終わっていれば何もしない */ } }
    for (const s of [s1, s2, s3, s4]) await s?.stop();
    // 6. 後片付け: 保持役に shutdown を送り、保持役の子（身代わりの OpenCode）を全部止める
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
    }
    for (const pid of await starts()) if (alive(pid)) { await until(() => !alive(pid), 5_000, `身代わりの OpenCode（${pid}）が終わる`).catch(() => { try { process.kill(pid); } catch { /* 既に終わっている */ } }); }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  t.ok('後片付け: 保持役・身代わりの OpenCode が残らない', true);
}
