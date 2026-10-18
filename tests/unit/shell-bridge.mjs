// ply_shell（core/shell-bridge.mjs、ADR 0227 §1）を使い捨てのポートの HTTP で確かめる。サーバーは立てない。LLM は呼ばない。
//   - run: 出力と終了コードを返す。裏に残ったプロセスがあっても戻り、そのことを書く。上限で止める
//   - start → output → stop: すぐ戻る・出力の続きを since で読む・子ごと止める・終わりを onJobEnd で知らせる
//   - 承認: 読み取りだけのモードは断る。確認なしのモードは聞かない。ほかは聞き、断られたら走らせない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createShellBridge, shellTools, SHELL_TOOL_NAMES } from '../../core/shell-bridge.mjs';

export const name = 'shell-bridge';
export const title = 'ply_shell: run・start・output・stop・承認の関門・裏に残ったプロセスを待たない';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-shell-bridge-'));
  const asked = [], started = [], ended = [];
  let allow = true;
  const bridge = createShellBridge({
    askPermission: async (req) => { asked.push(req); return { allow }; },
    onJobStart: (sessionId, job) => started.push({ sessionId, job }),
    onJobEnd: (sessionId, job, tail) => ended.push({ sessionId, job, tail }),
  });
  const server = http.createServer((req, res) => bridge.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let mode = { scope: 'workspace', autonomy: 'never' };
  const port = bridge.open({ origin, locale: 'ja', owner: async () => ({ sessionId: 's1', cwd: dir, mode, signal: null, env: { PLY_SHELL_PROBE: 'probe-value' } }) });
  let seq = 0;
  const call = async (name, args = {}) => {
    const res = await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.json();
    return { text: body.result?.content?.[0]?.text ?? '', isError: Boolean(body.result?.isError) };
  };
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

    r = await call('run', { command: `${node} -e "setTimeout(() => {}, 20000)"`, timeoutMs: 1000 });
    t.ok('run: 上限で止め、start を使うよう書く', r.text.includes('上限の時間を過ぎた'), r.text);

    // ---- start / output / stop
    r = await call('start', { command: `${node} -e "let i = 0; const h = setInterval(() => { console.log('tick ' + (++i)); if (i === 3) clearInterval(h); }, 150); setTimeout(() => {}, 30000)"` });
    const jobId = /ジョブ (sh-[a-f0-9]+)/.exec(r.text)?.[1];
    t.ok('start: すぐ戻り、ジョブの id を返す・見張りに知らせる', Boolean(jobId) && started.some((x) => x.job.jobId === jobId), r.text);
    await sleep(900);
    r = await call('output', { jobId });
    const since = Number(/since=(\d+)/.exec(r.text)?.[1]);
    t.ok('output: ここまでの出力と、続きの位置を返す（まだ走っている）', r.text.includes('tick 3') && r.text.includes('まだ走っています') && since > 0, r.text);
    r = await call('output', { jobId, since });
    t.ok('output: since から先だけを返す', !r.text.includes('tick 1'), r.text);
    r = await call('list');
    t.ok('list: この会話のジョブ', JSON.parse(r.text).jobs.some((j) => j.jobId === jobId && j.running));
    r = await call('stop', { jobId });
    t.ok('stop: 子ごと止めて、止めたと書く・終わりを知らせる', r.text.includes('止めました') && ended.some((x) => x.job.jobId === jobId && x.job.stopped), r.text);
    t.ok('止めた後は走っていない', !bridge.running('s1') && bridge.jobs('s1').every((j) => !j.running));

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
