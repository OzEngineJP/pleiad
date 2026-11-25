// ply_shell（core/shell-bridge.mjs、ADR 0227 §1）を使い捨てのポートの HTTP で確かめる。サーバーは立てない。LLM は呼ばない。
//   - run: 出力と終了コードを返す。裏に残ったプロセスがあっても戻り、そのことを書く
//   - run は待ちを過ぎても止めない（ADR 0227 の 2026-11-25 の追記）: 裏のジョブ（start と同じ扱い）に移して戻る。
//     timeoutMs は「移すまでの待ち」（上限を超えた値も弾かず丸める）。output・stop・終わりの知らせ・裏の一覧が start と同じ。
//     待っている run を人が止めたら、run の戻りで返る（ターンは続く）。ターンが止まったら、待っている run は止め、裏へ移したものは止めない
//   - 保持役に載ったジョブも、裏へ移したら同じ扱い（札を置き直す。保持役には 24 時間の上限で頼み、待ちでは止めない）
//   - output の waitMs: 走っていれば、終わるか waitMs が過ぎるまで待つ（新しい出力だけでは戻らない・省けばすぐ戻る・範囲は丸める）。
//     待っている間に人が止めたらすぐ戻って「人が止めた」と返す。ターンが止まった・呼び出した側が切れたら、待つのをやめるだけでジョブは止めない
//   - start → output → stop: すぐ戻る・出力の続きを since で読む・子ごと止める・終わりを onJobEnd で知らせる
//   - 同時のジョブの本数は限らない（1 つの会話で 9 本以上の start が通る）
//   - 承認: 読み取りだけのモードは断る。確認なしのモードは聞かない。ほかは聞き、断られたら走らせない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createShellBridge, shellTools, SHELL_TOOL_NAMES, RUN_WAIT_MS, RUN_WAIT_MAX_MS, JOB_TIMEOUT_MS } from '../../core/shell-bridge.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'shell-bridge';
export const title = 'ply_shell: run・start・output・stop・承認の関門・裏に残ったプロセスを待たない・run は待ちを過ぎたら裏へ移す・output は waitMs で待てる';

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
  // 短い run が裏の一覧に出ないことを見る専用の橋。出し始めるまでの時間を 60 秒にして、この PC の Git Bash の起動（300 ms を超えることがある）に左右されないようにする。
  // 上の橋の 300 ms は、「少し走った run が一覧に出る」側の試験を短く済ませるためのもの
  const changedLong = [];
  const longBridge = createShellBridge({ askPermission: async () => ({ allow: true }), onJobChange: (sessionId, job) => changedLong.push({ sessionId, job }), listedAfterMs: 60_000 });
  const longServer = http.createServer((req, res) => longBridge.handle(req, res));
  await new Promise((r) => longServer.listen(0, '127.0.0.1', r));
  const longPort = longBridge.open({ origin: `http://127.0.0.1:${longServer.address().port}`, locale: 'ja', owner: async () => ({ sessionId: 's1', cwd: dir, mode: { scope: 'workspace', autonomy: 'never' }, env: {} }) });
  let seq = 0;
  const callOn = async (p, name, args = {}, signal) => {
    const res = await fetch(p.url, { method: 'POST', headers: { ...p.headers, 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.json();
    return { text: body.result?.content?.[0]?.text ?? '', isError: Boolean(body.result?.isError) };
  };
  const call = (name, args = {}, signal) => callOn(port, name, args, signal);
  const until = async (fn, ms = 10_000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; };
  const jobOf = (id) => bridge.jobs('s1').find((j) => j.jobId === id);
  const timed = async (fn) => { const from = Date.now(); const value = await fn(); return { value, ms: Date.now() - from }; };
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
    // 一覧に出し始めるまでに終わる run は、一覧に出さない（ちらつかせない）。待ちの timer は終わったら消える
    r = await callOn(longPort, 'run', { command: 'echo within-cap' });
    t.ok('短い run は裏の一覧に出さない（ちらつかせない。終わるまで一覧に出す知らせも出ない）',
      !r.isError && r.text.includes('within-cap') && changedLong.length === 0 && longBridge.jobs('s1').every((j) => !j.listed) && !longBridge.sessionsWithJobs().includes('s1'), `${r.text} ${JSON.stringify(changedLong)}`);

    r = await call('run', { command: `${node} -e "console.log('early-line'); setTimeout(() => {}, 20000)"`, timeoutMs: 1000 });
    const movedId = jobIdIn(r.text);
    t.ok('run: 待ちを過ぎたら止めずに裏へ移し、ジョブ id と「まだ走っている」を返す（エラーにしない・止めたとは書かない）',
      Boolean(movedId) && !r.isError && r.text.includes('まだ走っています') && r.text.includes('止めずに裏のジョブに移しました') && !r.text.includes('止めました'), r.text);
    t.ok('… 戻りに、output の waitMs で終わるまで待てること・sleep を挟んで何度も呼ばなくてよいことを書く', r.text.includes('waitMs') && r.text.includes('sleep'), r.text);
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

    // ---- output の waitMs: 走っているジョブを、終わるか waitMs が過ぎるまで待ってから返す（ADR 0227 の 2026-11-25 の追記）
    const startJob = async (command) => /ジョブ (sh-[a-f0-9]+)/.exec((await call('start', { command })).text)?.[1];
    const waitArgOf = (tools) => tools.find((x) => x.name === 'output').inputSchema.properties.waitMs.description;
    const waitSchema = shellTools('ja').find((x) => x.name === 'output').inputSchema.properties.waitMs;
    t.ok('waitMs はスキーマで範囲を弾かない（run の timeoutMs と同じ。範囲は丸める）', waitSchema?.type === 'integer' && waitSchema.maximum === undefined && waitSchema.minimum === undefined && Boolean(waitSchema.description), JSON.stringify(waitSchema));
    for (const lng of ['ja', 'en']) {
      const tools = shellTools(lng);
      const x = { output: tools.find((y) => y.name === 'output').description, run: tools.find((y) => y.name === 'run').description, arg: waitArgOf(tools),
        instructions: agentT(lng, 'shell.instructions'), promoted: agentT(lng, 'shell.promoted', { seconds: 30, jobId: 'sh-x', since: 0 }), stillRunning: agentT(lng, 'shell.stillRunning', { jobId: 'sh-x', since: 0 }) };
      t.ok(`説明（${lng}）: output・run・使い方の指示・「まだ走っています」の文に、waitMs で待てることと、sleep を挟んで何度も呼ばなくてよいことがある。引数の説明に上限がある`,
        [x.output, x.run, x.instructions, x.promoted, x.stillRunning].every((s) => s.includes('waitMs')) && [x.output, x.instructions, x.promoted, x.stillRunning].every((s) => s.includes('sleep')) && x.arg.includes(String(RUN_WAIT_MAX_MS)), JSON.stringify(x));
    }

    // 待っている間に終われば、終わった時点で戻る（出力と終了コード）
    const soonId = await startJob(`${node} -e "console.log('soon-1'); setTimeout(() => console.log('soon-2'), 1500)"`);
    const soon = await timed(() => call('output', { jobId: soonId, waitMs: 60_000 }));
    t.ok('output + waitMs: 待っている間にジョブが終われば、終わった時点で戻る（60 秒は待たない・出力と終了コード・「まだ走っています」とは書かない）',
      soon.ms >= 1000 && soon.ms < 20_000 && soon.value.text.includes('soon-2') && /終了コード 0/.test(soon.value.text) && !soon.value.text.includes('まだ走っています') && !soon.value.isError, `${soon.ms}ms ${soon.value.text}`);

    // 新しい出力が出ただけでは戻らない。waitMs が過ぎたら、ここまでの出力と続きの位置を返す（ジョブは止めない）
    const chattyId = await startJob(`${node} -e "let i = 0; setInterval(() => console.log('chat ' + (++i)), 100); setTimeout(() => {}, 30000)"`);
    const chatty = await timed(() => call('output', { jobId: chattyId, waitMs: 3000 }));
    t.ok('出力が出続けても、新しい出力だけでは戻らない。waitMs が過ぎたら、ここまでの出力と続きの位置・「まだ走っています」を返す（ジョブは止めない）',
      chatty.ms >= 2800 && chatty.ms < 15_000 && chatty.value.text.includes('chat 1') && chatty.value.text.includes('まだ走っています') && /since=\d+/.test(chatty.value.text) && jobOf(chattyId)?.running === true && !jobOf(chattyId)?.stoppedBy, `${chatty.ms}ms ${chatty.value.text.slice(-300)}`);

    // 省く・数でない・0 以下は今までどおりすぐ戻る
    for (const waitMs of [undefined, 0, -5, '30000']) {
      const quick = await timed(() => call('output', waitMs === undefined ? { jobId: chattyId } : { jobId: chattyId, waitMs }));
      t.ok(`waitMs が ${waitMs === undefined ? '無い' : JSON.stringify(waitMs)} なら、待たずにすぐ戻る`, quick.ms < 2000 && !quick.value.isError && quick.value.text.includes('まだ走っています'), `${quick.ms}ms ${quick.value.text.slice(-200)}`);
    }

    // 上限を超えた waitMs は断らず、RUN_WAIT_MAX_MS に丸めて待つ（待ちの timer の時間を見る）
    const clampId = await startJob(`${node} -e "setTimeout(() => {}, 1200)"`);
    const delays = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
    let big;
    try { big = await call('output', { jobId: clampId, waitMs: 99_999_999 }); } finally { globalThis.setTimeout = realSetTimeout; }
    t.ok('waitMs が上限を超えても断らず、RUN_WAIT_MAX_MS（240 秒）に丸めて待つ', !big.isError && /終了コード 0/.test(big.text) && delays.includes(RUN_WAIT_MAX_MS) && !delays.includes(99_999_999), `${big.text} ${delays.filter((ms) => ms > 100_000)}`);

    // 待っている間に人がそのジョブを止めたら、すぐ戻って「人が止めた」と返す
    const humanId = await startJob(longNode);
    let humanReturned = false;
    const humanWait = timed(() => call('output', { jobId: humanId, waitMs: 60_000 })).then((x) => { humanReturned = true; return x; });
    await sleep(500);
    const returnedBeforeStop = humanReturned;
    await bridge.stop('s1', humanId);
    const human = await humanWait;
    t.ok('待っている間に人がそのジョブを止めたら、止めるまで戻らず、止めたらすぐ戻って「人が止めた」と返す（60 秒は待たない）',
      !returnedBeforeStop && human.ms < 20_000 && human.value.text.includes('人がこのコマンドだけを止めました') && !human.value.text.includes('まだ走っています'), `${human.ms}ms ${human.value.text}`);

    // ターンが止まった・呼び出した側が切れたら、待つのをやめるだけ。ジョブは止めない（裏のジョブなので）
    const keepId = await startJob(longNode);
    const turn3 = new AbortController();
    turnSignal = turn3.signal;
    let turnReturned = false;
    const turnWait = timed(() => call('output', { jobId: keepId, waitMs: 60_000 })).then((x) => { turnReturned = true; return x; });
    await sleep(500);
    const returnedBeforeAbort = turnReturned;
    turn3.abort();
    const turnOut = await turnWait;
    turnSignal = null;
    t.ok('ターンが止まったら、待つのをやめて戻る。ジョブは止めない（走り続ける・止めた人も付かない）',
      !returnedBeforeAbort && turnOut.ms < 20_000 && turnOut.value.text.includes('まだ走っています') && jobOf(keepId)?.running === true && !jobOf(keepId)?.stoppedBy && !ended.some((x) => x.job.jobId === keepId), `${turnOut.ms}ms ${turnOut.value.text}`);
    const gone = new AbortController();
    const goneCall = call('output', { jobId: keepId, waitMs: 60_000 }, gone.signal).catch(() => null);
    await sleep(500);
    gone.abort();
    await goneCall;
    await sleep(300);
    t.ok('呼び出した側が切れても、待つのをやめるだけでジョブは止めない', jobOf(keepId)?.running === true && !jobOf(keepId)?.stoppedBy && !ended.some((x) => x.job.jobId === keepId));
    // 切れた後でも、同じジョブを waitMs でもう一度待てる（待ちの後始末が残らない）
    const resumed = call('output', { jobId: keepId, waitMs: 60_000 });
    await sleep(300);
    await bridge.stop('s1', keepId);
    t.ok('… 待ち直せる（あとから止めれば、その待ちも戻る）', (await resumed).text.length > 0);

    // 終わったジョブ・知らないジョブは waitMs があっても今までどおり
    const finished = await timed(() => call('output', { jobId: soonId, waitMs: 60_000 }));
    t.ok('終わったジョブは、waitMs があってもすぐ返る（出力と終了コード）', finished.ms < 2000 && finished.value.text.includes('soon-2') && /終了コード 0/.test(finished.value.text), `${finished.ms}ms`);
    const missingWait = await timed(() => call('output', { jobId: 'sh-missing', waitMs: 60_000 }));
    t.ok('知らないジョブは、waitMs があっても待たずに断る', missingWait.ms < 2000 && missingWait.value.isError && missingWait.value.text.includes('sh-missing'), `${missingWait.ms}ms ${missingWait.value.text}`);
    await bridge.stop('s1', chattyId);
    t.ok('waitMs の試験で起こしたジョブは残っていない', !bridge.running('s1'));

    // 保持役に載ったジョブも同じ扱い（保持役には待ちではなく 24 時間の上限で頼み、待ちでは止めない。裏へ移したら札を置き直す）
    useHolder = true;
    r = await call('run', { command: 'held-command-not-run', timeoutMs: 1000 });
    const heldId = jobIdIn(r.text);
    useHolder = false;
    t.ok('保持役: 待ちを過ぎたら裏へ移す。保持役には 24 時間の上限で頼む（待ちの時間では止めない）',
      Boolean(heldId) && r.text.includes('held-out') && r.text.includes('止めずに裏のジョブに移しました') && heldStarts.length === 1 && heldStarts[0].kind === 'run' && heldStarts[0].timeoutMs === JOB_TIMEOUT_MS, `${JSON.stringify(heldStarts)} ${r.text}`);
    t.ok('保持役: 札の種類を start に置き直す', heldLabels.includes('start') && jobOf(heldId)?.held === true && jobOf(heldId)?.kind === 'start');
    // 保持役のジョブでも waitMs で待てる（終わった時点で戻る）
    const heldWait = timed(() => call('output', { jobId: heldId, waitMs: 60_000 }));
    await sleep(300);
    heldEnd();
    const heldOut = await heldWait;
    t.ok('保持役: output + waitMs は、ジョブが終わった時点で戻る', heldOut.ms < 20_000 && /終了コード 0/.test(heldOut.value.text) && !heldOut.value.text.includes('まだ走っています'), `${heldOut.ms}ms ${heldOut.value.text}`);
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
    t.ok('尋ねるモードでは聞き、断られたら走らせない', r.isError && asked.length === 1 && asked[0].toolName === 'ply_shell' && asked[0].canAlways === true && asked[0].input.command === 'echo denied-run' && !r.text.includes('denied-run\n'), r.text);
    allow = true;
    r = await call('run', { command: 'echo allowed-once' });
    t.ok('一度だけの許可（once）で走らせても、印は残さず次の呼び出しでまた聞く', r.text.includes('allowed-once') && asked.length === 2, r.text);
    r = await call('run', { command: 'echo allowed-once-again' });
    t.ok('… 2 回目もカードが出る', r.text.includes('allowed-once-again') && asked.length === 3, r.text);
    r = await call('output', { jobId: 'sh-missing' });
    t.ok('知らないジョブは断る', r.isError && r.text.includes('sh-missing'));

    // ---- 「常に許可」（この会話の間、再起動をまたいでも残る・ほかの会話には効かない・読むだけのモードでは断る）
    const persisted = new Map();
    const askedAlways = [];
    let replyAlways = { allow: true, always: false };
    const bootBridge = () => {
      const b = createShellBridge({
        askPermission: async (req) => { askedAlways.push(req); return replyAlways; },
        isAlwaysAllowed: async (sid) => persisted.get(sid) === true,
        rememberAlwaysAllow: async (sid) => { persisted.set(sid, true); },
      });
      const srv = http.createServer((req, res) => b.handle(req, res));
      return { b, srv };
    };
    const b1 = bootBridge();
    await new Promise((res) => b1.srv.listen(0, '127.0.0.1', res));
    const origin1 = `http://127.0.0.1:${b1.srv.address().port}`;
    let mode1 = { scope: 'workspace', autonomy: 'ask' };
    const p1 = b1.b.open({ origin: origin1, locale: 'ja', owner: async () => ({ sessionId: 'conv-1', cwd: dir, mode: mode1, env: {} }) });
    const p2 = b1.b.open({ origin: origin1, locale: 'ja', owner: async () => ({ sessionId: 'conv-2', cwd: dir, mode: { scope: 'workspace', autonomy: 'ask' }, env: {} }) });
    try {
      // 1. 「常に許可」で許可すると、以後の run・start はカードを出さない
      replyAlways = { allow: true, always: true };
      r = await callOn(p1, 'run', { command: 'echo first-always' });
      t.ok('常に許可: 初回は canAlways: true のカードを出し、許可で実行する', !r.isError && r.text.includes('first-always') && askedAlways.length === 1 && askedAlways[0].canAlways === true && persisted.get('conv-1') === true);
      r = await callOn(p1, 'run', { command: 'echo second-no-card' });
      t.ok('常に許可の後は、次の run でカードを出さない', !r.isError && r.text.includes('second-no-card') && askedAlways.length === 1);
      r = await callOn(p1, 'start', { command: 'echo start-no-card' });
      const alwaysStartId = /ジョブ (sh-[a-f0-9]+)/.exec(r.text)?.[1];
      t.ok('常に許可の後は、start でもカードを出さない', !r.isError && Boolean(alwaysStartId) && askedAlways.length === 1);
      if (alwaysStartId) { await until(() => !b1.b.job('conv-1', alwaysStartId)?.running); }

      // 2. ほかの会話には効かない
      replyAlways = { allow: true, scope: 'once' };
      r = await callOn(p2, 'run', { command: 'echo other-session' });
      t.ok('別の会話には効かず、承認カードを出す（once では印を残さない）', !r.isError && r.text.includes('other-session') && askedAlways.length === 2 && askedAlways[1].sessionId === 'conv-2' && !persisted.has('conv-2'));

      // 3. 読むだけのモードに変わったら、印があっても断る
      mode1 = { scope: 'readonly', autonomy: 'ask' };
      r = await callOn(p1, 'run', { command: 'echo readonly-after-always' });
      t.ok('常に許可の印があっても、承認モードが読むだけに変わったら断る', r.isError && r.text.includes('読み取りだけ') && askedAlways.length === 2, r.text);
    } finally {
      await b1.b.closeAll();
      b1.srv.close();
    }

    // 4. 再起動後も残る（新しい bridge インスタンスでも、会話のデータから印を読む）
    const b2 = bootBridge();
    await new Promise((res) => b2.srv.listen(0, '127.0.0.1', res));
    const p1After = b2.b.open({ origin: `http://127.0.0.1:${b2.srv.address().port}`, locale: 'ja', owner: async () => ({ sessionId: 'conv-1', cwd: dir, mode: { scope: 'workspace', autonomy: 'ask' }, env: {} }) });
    try {
      r = await callOn(p1After, 'run', { command: 'echo after-restart' });
      t.ok('再起動後も会話のデータの印が残り、カードを出さずに通る', !r.isError && r.text.includes('after-restart') && askedAlways.length === 2);
    } finally {
      await b2.b.closeAll();
      b2.srv.close();
    }
  } finally {
    await bridge.closeAll();
    await longBridge.closeAll();
    server.close();
    longServer.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
