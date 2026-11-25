// ply_shell（core/shell-bridge.mjs、ADR 0227 §1）を使い捨てのポートの HTTP で確かめる。サーバーは立てない。LLM は呼ばない。
//   - run: 出力と終了コードを返す。裏に残ったプロセスがあっても戻り、そのことを書く
//   - run は待ちを過ぎても止めない（ADR 0227 の 2026-11-25 の追記）: 裏のジョブ（start と同じ扱い）に移して戻る。
//     timeoutMs は「移すまでの待ち」（上限を超えた値も弾かず丸める）。output・stop・終わりの知らせ・裏の一覧が start と同じ。
//     待っている run を人が止めたら、run の戻りで返る（ターンは続く）。ターンが止まったら、待っている run は止め、裏へ移したものは止めない
//   - 保持役に載ったジョブも、裏へ移したら同じ扱い（札を置き直す。保持役には 24 時間の上限で頼み、待ちでは止めない）
//   - start → output → stop: すぐ戻る・出力の続きを since で読む・子ごと止める・終わりを onJobEnd で知らせる
//   - 同時のジョブの本数は限らない（1 つの会話で 9 本以上の start が通る）
//   - 承認: 読み取りだけのモードは断る。確認なしのモードは聞かない。ほかは聞き、断られたら走らせない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createShellBridge, shellTools, SHELL_TOOL_NAMES, RUN_WAIT_MS, RUN_WAIT_MAX_MS, JOB_TIMEOUT_MS } from '../../core/shell-bridge.mjs';

export const name = 'shell-bridge';
export const title = 'ply_shell: run・start・output・stop・承認の関門・裏に残ったプロセスを待たない・run は待ちを過ぎたら裏へ移す';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-shell-bridge-'));
  const asked = [], started = [], ended = [], changed = [];
  let allow = true;
  // 保持役の代わり（run が裏へ移ったとき札を置き直すか・保持役には待ちではなく 24 時間の上限で頼むかを見る）
  const heldStarts = [], heldLabels = [];
  let heldEnd = null;
  const fakeHeld = {
    alive: true, finished() {}, release() {}, label: (job) => heldLabels.push(job.kind),
    drive: ({ signal, onOutput }) => new Promise((resolve) => {
      onOutput('stdout', 'held-out\n');
      heldEnd = () => resolve({ exitCode: 0, endedAt: Date.now() });
      signal?.addEventListener?.('abort', () => resolve({ exitCode: null, stopped: true, endedAt: Date.now() }), { once: true });
    }),
  };
  let useHolder = false;
  const holder = { start: async (job, { timeoutMs }) => { if (!useHolder) return null; heldStarts.push({ kind: job.kind, timeoutMs }); return fakeHeld; } };
  const bridge = createShellBridge({
    askPermission: async (req) => { asked.push(req); return { allow }; },
    onJobStart: (sessionId, job) => started.push({ sessionId, job }),
    onJobChange: (sessionId, job) => changed.push({ sessionId, job }),
    onJobEnd: (sessionId, job, tail) => ended.push({ sessionId, job, tail }),
    holder,
    listedAfterMs: 300,
  });
  const server = http.createServer((req, res) => bridge.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let mode = { scope: 'workspace', autonomy: 'never' };
  let turnSignal = null;
  const port = bridge.open({ origin, locale: 'ja', owner: async () => ({ sessionId: 's1', cwd: dir, mode, signal: turnSignal, env: { PLY_SHELL_PROBE: 'probe-value' } }) });
  let seq = 0;
  const call = async (name, args = {}) => {
    const res = await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.json();
    return { text: body.result?.content?.[0]?.text ?? '', isError: Boolean(body.result?.isError) };
  };
  const until = async (fn, ms = 10_000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; };
  const jobOf = (id) => bridge.jobs('s1').find((j) => j.jobId === id);
  try {
    t.ok('ツールは run・start・output・stop・list', shellTools('ja').map((x) => x.name).join() === SHELL_TOOL_NAMES.join() && shellTools('en').every((x) => x.description && x.inputSchema));

    // ---- run
    let r = await call('run', { command: `${node} -e "console.log('hello ' + process.env.PLY_SHELL_PROBE); process.exit(3)"` });
    t.ok('run: 出力と終了コードを返し、会話の環境変数を渡す', r.text.includes('hello probe-value') && /終了コード 3/.test(r.text) && r.isError, r.text);
    t.ok('確認なしのモードでは聞かない', asked.length === 0);

    const pidFile = path.join(dir, 'leftover.pid').replace(/\\/g, '/');
    const t0 = Date.now();
    r = await call('run', { command: `${node} -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 15000)" & echo spawned` });
    const took = Date.now() - t0;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try { process.kill(pid); } catch {}
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(50); }
    t.ok('run: 裏に残ったプロセスがあっても戻り、そのことを書く', took < 9000 && r.text.includes('spawned') && r.text.includes('出力を握ったまま'), `${took}ms ${r.text}`);

    // ---- run は待ちを過ぎても止めず、裏のジョブ（start と同じ扱い）へ移す（ADR 0227 の 2026-11-25 の追記）
    const longNode = `${node} -e "setTimeout(() => {}, 20000)"`;
    const jobIdIn = (text) => /jobId: (sh-[a-f0-9]+)/.exec(text)?.[1];
    t.ok('既定の待ちは 30 秒。timeoutMs で伸ばせる上限は、MCP の通信が切れる 300 秒前後より短い 240 秒。止め忘れの保険は 24 時間',
      RUN_WAIT_MS === 30_000 && RUN_WAIT_MAX_MS === 240_000 && RUN_WAIT_MAX_MS < 300_000 && JOB_TIMEOUT_MS === 24 * 60 * 60_000);
    const timeoutSchema = shellTools('ja').find((x) => x.name === 'run').inputSchema.properties.timeoutMs;
    t.ok('timeoutMs はスキーマで範囲を弾かない（弾くと呼び出しごと失敗する。範囲は丸める）', timeoutSchema.type === 'integer' && timeoutSchema.maximum === undefined && timeoutSchema.minimum === undefined, JSON.stringify(timeoutSchema));
    r = await call('run', { command: 'echo within-cap', timeoutMs: 2_400_000 });
    t.ok('timeoutMs が上限を超えても断らず、丸めて走らせる', !r.isError && r.text.includes('within-cap') && /終了コード 0/.test(r.text), r.text);
    t.ok('短い run は裏の一覧に出さない（ちらつかせない）', !changed.some((x) => x.job.command === 'echo within-cap'));

    r = await call('run', { command: `${node} -e "console.log('early-line'); setTimeout(() => {}, 20000)"`, timeoutMs: 1000 });
    const movedId = jobIdIn(r.text);
    t.ok('run: 待ちを過ぎたら止めずに裏へ移し、ジョブ id と「まだ走っている」を返す（エラーにしない・止めたとは書かない）',
      Boolean(movedId) && !r.isError && r.text.includes('まだ走っています') && r.text.includes('止めずに裏のジョブに移しました') && !r.text.includes('止めました'), r.text);
    const moved = jobOf(movedId);
    t.ok('裏へ移ったジョブは start と同じ扱い（kind: start・走っている・裏の一覧に出る・会話の裏のジョブに数える・変わったと知らせる）',
      moved?.kind === 'start' && moved.running && moved.listed && bridge.sessionsWithJobs().includes('s1') && changed.some((x) => x.job.jobId === movedId && x.job.kind === 'start'));
    t.ok('裏へ移しても終わりの知らせは出さない（まだ走っている）', !ended.some((x) => x.job.jobId === movedId));
    await until(() => (bridge.job('s1', movedId)?.output ?? '').includes('early-line'));
    r = await call('output', { jobId: movedId });
    t.ok('output: 裏へ移ったジョブの出力を読める（移したと繰り返さない）', r.text.includes('early-line') && r.text.includes('まだ走っています') && !r.text.includes('裏のジョブに移しました'), r.text);
    r = await call('stop', { jobId: movedId });
    t.ok('stop: 裏へ移ったジョブを止められる（エージェントが止めたものは知らせの対象外）', r.text.includes('止めました') && ended.some((x) => x.job.jobId === movedId && x.job.kind === 'start' && x.job.stoppedBy === 'agent'), r.text);

    r = await call('run', { command: `${node} -e "console.log('first'); setTimeout(() => console.log('second'), 2500)"`, timeoutMs: 1000 });
    const naturalId = jobIdIn(r.text);
    t.ok('2 本目も、待ちを過ぎたら裏へ移る', Boolean(naturalId) && r.text.includes('まだ走っています'), r.text);
    t.ok('裏へ移ったジョブが自分で終わると、start と同じく終わりを知らせる（kind: start・止めた人なし・終了コード 0）',
      await until(() => ended.some((x) => x.job.jobId === naturalId)) && (({ job }) => job.kind === 'start' && !job.stoppedBy && job.exitCode === 0)(ended.find((x) => x.job.jobId === naturalId)));
    r = await call('output', { jobId: naturalId });
    t.ok('終わった後の output に、裏で出た出力と終了コードがある', r.text.includes('second') && /終了コード 0/.test(r.text), r.text);

    // 待っている run を人が裏の一覧から止める: run の戻りで「人が止めた」と返る（ターンは続く）
    const waiting = call('run', { command: longNode, timeoutMs: 30_000 });
    await until(() => bridge.jobs('s1').some((j) => j.running && j.kind === 'run' && j.listed));
    const waitingJob = bridge.jobs('s1').find((j) => j.running && j.kind === 'run');
    t.ok('待っている run は、少し走ると裏の一覧に出る（人が 1 本だけ止められる）', Boolean(waitingJob?.listed) && bridge.sessionsWithJobs().includes('s1') && changed.some((x) => x.job.jobId === waitingJob.jobId && x.job.kind === 'run' && x.job.listed));
    const humanStopped = await bridge.stop('s1', waitingJob.jobId);
    r = await waiting;
    t.ok('待っている run を人が止めると、run の戻りで「人が止めた」と返る（結果として返り、呼び出しは失敗しない）', humanStopped && r.isError && r.text.includes('人がこのコマンドだけを止めました') && r.text.includes('ターンは続いています'), r.text);
    t.ok('… 戻りで返したので、終わりの知らせの対象にしない（kind: run のまま・stoppedBy: human）', (({ job }) => job.kind === 'run' && job.stoppedBy === 'human' && job.stopped)(ended.find((x) => x.job.jobId === waitingJob.jobId)));

    // 裏へ移った後に人が止める: 終わりの知らせ（server の deliverJobEnd）の対象で、止めたのは人と分かる
    r = await call('run', { command: longNode, timeoutMs: 1000 });
    const movedForHuman = jobIdIn(r.text);
    t.ok('人が裏の一覧から止められる', await bridge.stop('s1', movedForHuman));
    const humanEnd = ended.find((x) => x.job.jobId === movedForHuman)?.job;
    t.ok('裏へ移ったジョブを人が止めると、終わりの知らせの対象になる（kind: start・stoppedBy: human）', humanEnd?.kind === 'start' && humanEnd.stoppedBy === 'human' && humanEnd.stopped);
    r = await call('output', { jobId: movedForHuman });
    t.ok('output にも「人が止めた」と出る', r.text.includes('人がこのコマンドだけを止めました'), r.text);

    // ターンが止まったとき: 待っている run は止める（戻りを受け取る側が居ない）。裏へ移したものは止めない（start と同じ）
    const turn1 = new AbortController();
    turnSignal = turn1.signal;
    const aborted = call('run', { command: longNode, timeoutMs: 30_000 });
    await until(() => bridge.jobs('s1').some((j) => j.running && j.kind === 'run'));
    const abortedId = bridge.jobs('s1').find((j) => j.running && j.kind === 'run')?.jobId;
    turn1.abort();
    await aborted;
    t.ok('ターンが止まったら、待っている run は止める（stoppedBy: turn）', ended.some((x) => x.job.jobId === abortedId && x.job.stoppedBy === 'turn' && x.job.stopped));
    const turn2 = new AbortController();
    turnSignal = turn2.signal;
    r = await call('run', { command: longNode, timeoutMs: 1000 });
    const keptId = jobIdIn(r.text);
    turn2.abort();
    await sleep(400);
    t.ok('裏へ移ったジョブは、ターンが止まっても走り続ける', Boolean(keptId) && jobOf(keptId)?.running === true);
    await bridge.stop('s1', keptId);
    turnSignal = null;

    // 保持役に載ったジョブも同じ扱い（保持役には待ちではなく 24 時間の上限で頼み、待ちでは止めない。裏へ移したら札を置き直す）
    useHolder = true;
    r = await call('run', { command: 'held-command-not-run', timeoutMs: 1000 });
    const heldId = jobIdIn(r.text);
    useHolder = false;
    t.ok('保持役: 待ちを過ぎたら裏へ移す。保持役には 24 時間の上限で頼む（待ちの時間では止めない）',
      Boolean(heldId) && r.text.includes('held-out') && r.text.includes('止めずに裏のジョブに移しました') && heldStarts.length === 1 && heldStarts[0].kind === 'run' && heldStarts[0].timeoutMs === JOB_TIMEOUT_MS, `${JSON.stringify(heldStarts)} ${r.text}`);
    t.ok('保持役: 札の種類を start に置き直す', heldLabels.includes('start') && jobOf(heldId)?.held === true && jobOf(heldId)?.kind === 'start');
    heldEnd();
    t.ok('保持役: 自分で終わると、start と同じく終わりを知らせる', await until(() => ended.some((x) => x.job.jobId === heldId)) && ended.find((x) => x.job.jobId === heldId).job.kind === 'start');

    // 起動で復元する run のジョブ: 待っていた接続は無いので、終わりを知らせる start として扱う
    let finishRestored = null;
    const restoredHeld = { alive: true, finished() {}, release() {}, label() {}, drive: () => new Promise((resolve) => { finishRestored = () => resolve({ exitCode: 0, endedAt: Date.now() }); }) };
    bridge.restore([{ card: { sessionId: 's2', jobId: 'sh-restored1', jobKind: 'run', command: 'restored-run', cwd: dir, shell: 'default', startedAt: Date.now() }, held: restoredHeld }]);
    t.ok('復元した run のジョブは start として扱う（裏の一覧に出る）', bridge.jobs('s2')[0]?.kind === 'start' && bridge.jobs('s2')[0].listed && bridge.sessionsWithJobs().includes('s2'));
    finishRestored();
    t.ok('復元したジョブが終わると、終わりを知らせる（kind: start）', await until(() => ended.some((x) => x.job.jobId === 'sh-restored1' && x.job.kind === 'start')));
    t.ok('ここまでで走っているジョブは残っていない', !bridge.running('s1') && !bridge.running('s2'));

    // ---- start / output / stop
    r = await call('start', { command: `${node} -e "let i = 0; const h = setInterval(() => { console.log('tick ' + (++i)); if (i === 3) clearInterval(h); }, 150); setTimeout(() => {}, 30000)"` });
    const jobId = /ジョブ (sh-[a-f0-9]+)/.exec(r.text)?.[1];
    t.ok('start: すぐ戻り、ジョブの id を返す・見張りに知らせる', Boolean(jobId) && started.some((x) => x.job.jobId === jobId), r.text);
    // ジョブのプロセスが立ち上がって 3 回目の tick が出るまで待つ（重い試験と並走すると 900ms では足りない）
    let since = 0;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      r = await call('output', { jobId });
      if (r.text.includes('tick 3')) { since = Number(/since=(\d+)/.exec(r.text)?.[1]); break; }
    }
    t.ok('output: ここまでの出力と、続きの位置を返す（まだ走っている）', r.text.includes('tick 3') && r.text.includes('まだ走っています') && since > 0, r.text);
    r = await call('output', { jobId, since });
    t.ok('output: since から先だけを返す', !r.text.includes('tick 1'), r.text);
    r = await call('list');
    t.ok('list: この会話のジョブ', JSON.parse(r.text).jobs.some((j) => j.jobId === jobId && j.running));
    r = await call('stop', { jobId });
    t.ok('stop: 子ごと止めて、止めたと書く・終わりを知らせる', r.text.includes('止めました') && ended.some((x) => x.job.jobId === jobId && x.job.stopped), r.text);
    t.ok('止めた後は走っていない', !bridge.running('s1') && bridge.jobs('s1').every((j) => !j.running));

    // ---- 同時のジョブの本数は限らない（ADR 0227 追記 2026-11-23、Issue #207。前は 9 本目の start を断っていた）
    const many = [];
    for (let i = 0; i < 10; i++) {
      r = await call('start', { command: `${node} -e "setTimeout(() => {}, 30000)"` });
      many.push({ r, jobId: /ジョブ (sh-[a-f0-9]+)/.exec(r.text)?.[1] });
    }
    const runningIds = new Set(bridge.jobs('s1').filter((j) => j.running).map((j) => j.jobId));
    t.ok('1 つの会話で 10 本の start が断られずに通り、どれも走っている', many.every((x) => !x.r.isError && x.jobId && runningIds.has(x.jobId)),
      many.map((x) => x.r.text).filter((s) => !/ジョブ sh-/.test(s)).join(' | ') || `running=${runningIds.size}`);
    await Promise.all(many.filter((x) => x.jobId).map((x) => bridge.stop('s1', x.jobId)));
    t.ok('10 本とも止まる', !bridge.running('s1'));

    // ---- 承認の関門
    mode = { scope: 'readonly', autonomy: 'ask' };
    r = await call('run', { command: 'echo nope' });
    t.ok('読み取りだけのモードは断る', r.isError && r.text.includes('読み取りだけ') && asked.length === 0, r.text);
    mode = { scope: 'workspace', autonomy: 'ask' };
    allow = false;
    r = await call('run', { command: 'echo denied-run' });
    t.ok('尋ねるモードでは聞き、断られたら走らせない', r.isError && asked.length === 1 && asked[0].toolName === 'ply_shell' && asked[0].input.command === 'echo denied-run' && !r.text.includes('denied-run\n'), r.text);
    allow = true;
    r = await call('run', { command: 'echo allowed-run' });
    t.ok('許されたら走らせる', r.text.includes('allowed-run') && asked.length === 2, r.text);
    r = await call('output', { jobId: 'sh-missing' });
    t.ok('知らないジョブは断る', r.isError && r.text.includes('sh-missing'));
  } finally {
    await bridge.closeAll();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
