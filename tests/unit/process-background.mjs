// 裏の作業の子（core/process.mjs の runBackground・killDeadlineMs。ADR 0353）: 止めても終われない子を待たずに上限で戻る。LLM は呼ばない。
//   - 止めた後 killDeadlineMs で、終われない子（遅いファイルシステムの I/O 待ちで kill が効かない子）を待たずに締める（stuck・onLeftover）
//   - 終われる子は今までどおり（stuck を付けず、onLeftover も呼ばない）
//   - 子は終わったが出力のパイプを握ったプロセスが残るときも、待たずに締める（leftover）
//   - 入力（input）を読まずに終わる子へ大きな入力を書いて EPIPE になっても、未処理の例外にしない
//   - 木ごと止める taskkill は非同期（spawnSync は runSync だけ）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runBackground, BACKGROUND_KILL_DEADLINE_MS } from '../../core/process.mjs';

export const name = 'process-background';
export const title = '裏の作業の子: 止めても終われない子を待たずに上限で戻る（stuck・onLeftover）・終われる子は今までどおり・taskkill は非同期';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const raceNull = (promise, ms) => Promise.race([promise.then(() => 'ended'), sleep(ms).then(() => null)]);
const HANG = ['-e', 'setInterval(() => {}, 1000)'];

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-process-bg-'));
  const stray = [];
  try {
    t.ok('裏の作業の子が止めてから待つ上限は 3 秒（木ごとの停止が約 1.3 秒かかる PC でも、止まる子を詰まり扱いにしない）', BACKGROUND_KILL_DEADLINE_MS === 3_000);

    // ---- kill を無視する子（killWith が何もしない）: 上限で戻り、生き残りを onLeftover で渡す
    {
      let left = null;
      const started = Date.now();
      const r = await run(process.execPath, HANG, { timeoutMs: 200, killDeadlineMs: 300, killWith: () => {}, onLeftover: (info) => { left = info; } });
      const elapsed = Date.now() - started;
      if (left?.pid) stray.push(left.pid);
      t.ok('kill が効かない子でも、上限 + killDeadlineMs で戻る（出力のパイプが閉じるのを待たない）', elapsed < 2500, `${elapsed}ms`);
      t.ok('結果は stuck・timedOut（終了コードなし）', r.stuck === true && r.timedOut === true && r.exitCode === null, JSON.stringify(r));
      t.ok('生き残りの pid と、終わったとき解ける ended を onLeftover に 1 回渡す', Number.isInteger(left?.pid) && left.pid > 0 && typeof left.ended?.then === 'function' && left.command === process.execPath, JSON.stringify({ pid: left?.pid }));
      t.ok('渡した時点で、その子はまだ生きている', alive(left.pid) && await raceNull(left.ended, 100) === null);
      process.kill(left.pid);
      t.ok('子が本当に終われば ended が解ける（生き残りを数える側が外せる）', await raceNull(left.ended, 5000) === 'ended' && !alive(left.pid));
    }
    {
      // 止める signal でも同じ（呼び出し側が諦めた）
      let left = null;
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 150);
      const started = Date.now();
      const r = await run(process.execPath, HANG, { signal: ctl.signal, killDeadlineMs: 300, killWith: () => {}, onLeftover: (info) => { left = info; } });
      const elapsed = Date.now() - started;
      if (left?.pid) stray.push(left.pid);
      t.ok('signal で止めた子も、終われなければ待たずに戻る（stopped・stuck）', elapsed < 2500 && r.stuck === true && r.stopped === true && !r.timedOut, `${elapsed}ms ${JSON.stringify(r)}`);
      if (left?.pid) { try { process.kill(left.pid); } catch { /* 既に終わっている */ } }
    }

    // ---- 終われる子は今までどおり
    {
      let calls = 0;
      const started = Date.now();
      const r = await run(process.execPath, HANG, { timeoutMs: 200, killDeadlineMs: 5_000, onLeftover: () => { calls++; } });
      const elapsed = Date.now() - started;
      t.ok('kill が効く子は、上限の後すぐ戻る（killDeadlineMs を待たない）', elapsed < 3000 && r.timedOut === true, `${elapsed}ms`);
      t.ok('終われた子は stuck を付けず、onLeftover も呼ばない', r.stuck === undefined && calls === 0, JSON.stringify(r));
    }
    {
      const r = await runBackground(process.execPath, ['-e', 'process.stdout.write("hello")'], { timeoutMs: 20_000 });
      t.ok('普通に終わる子は、出力と終了コードをそのまま返す', r.exitCode === 0 && r.stdout === 'hello' && !r.timedOut && !r.stuck && !r.leftover, JSON.stringify(r));
    }
    {
      // killDeadlineMs を渡さない run()（エージェント・人が頼んだコマンドの ply_shell・`!`）は、これまでと同じ（既定 0 = 使わない）
      const r = await run(process.execPath, HANG, { timeoutMs: 200, killTree: true });
      t.ok('killDeadlineMs の無い run() は、止めたら今までどおり終わりを待って戻る（stuck を付けない）', r.timedOut === true && r.stuck === undefined, JSON.stringify(r));
    }

    // ---- 木ごと止める（taskkill / プロセスグループ）で、実際に終わる
    {
      const started = Date.now();
      const r = await runBackground(process.execPath, HANG, { timeoutMs: 300 });
      const elapsed = Date.now() - started;
      t.ok('runBackground: 上限で止めた子が木ごと終わり、stuck なしで戻る', r.timedOut === true && !r.stuck && elapsed < 5000, `${elapsed}ms ${JSON.stringify(r)}`);
    }

    // ---- 子は終わったが、出力のパイプを握ったプロセスが残る
    {
      const grandPid = path.join(dir, 'grand.pid');
      fs.writeFileSync(path.join(dir, 'grand.cjs'), 'require("fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 8000);\n');
      fs.writeFileSync(path.join(dir, 'parent.cjs'),
        'const { spawn } = require("child_process");\n'
        + 'const c = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });\n'
        + 'c.unref();\nconsole.log("parent done");\n');
      const started = Date.now();
      const r = await runBackground(process.execPath, [path.join(dir, 'parent.cjs'), path.join(dir, 'grand.cjs'), grandPid], { timeoutMs: 20_000 });
      const elapsed = Date.now() - started;
      for (let i = 0; i < 60 && !fs.existsSync(grandPid); i++) await sleep(50);
      const pid = Number(fs.existsSync(grandPid) ? fs.readFileSync(grandPid, 'utf8') : NaN);
      if (Number.isInteger(pid)) stray.push(pid);
      t.ok('終わった子が残したプロセスがパイプを握っていても、2 秒ほどで待たずに戻る（leftover）', elapsed < 6500 && r.leftover === true && r.exitCode === 0 && r.stdout.includes('parent done'), `${elapsed}ms ${JSON.stringify(r)}`);
    }

    // ---- 入力を読まずに終わる子（隠し ref の削除で git が先に落ちる、など）に大きな入力を書いても、ホストは落ちない
    {
      const crashes = [];
      const onCrash = (error) => crashes.push(String(error?.code ?? error));
      process.on('uncaughtException', onCrash);
      try {
        const r = await runBackground(process.execPath, ['-e', 'process.exit(0)'], { input: 'x'.repeat(16 * 1024 * 1024), timeoutMs: 20_000 });
        await sleep(300);
        t.ok('入力を読まずに終わる子へ書いて EPIPE になっても、未処理の例外にならず、子の結果を返す', crashes.length === 0 && r.exitCode === 0 && !r.startError && !r.timedOut, `${JSON.stringify(crashes)} ${JSON.stringify({ ...r, stdout: '', stderr: '' })}`);
      } finally { process.off('uncaughtException', onCrash); }
    }

    // ---- taskkill は非同期（spawnSync はイベントループを止める。runSync だけが持つ）
    {
      const source = fs.readFileSync(new URL('../../core/process.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      const start = source.indexOf('export function runSync');
      const end = source.indexOf('\n}\n', start);
      const outside = source.slice(0, start) + source.slice(end);
      t.ok('core/process.mjs の spawnSync は runSync の中だけ（run の止める操作は非同期の spawn）', start > 0 && end > start && !/spawnSync\(/.test(outside) && /spawn\(systemTool\('taskkill'\)/.test(source));
    }
  } finally {
    for (const pid of stray) { try { process.kill(pid); } catch { /* 既に終わっている */ } }
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
