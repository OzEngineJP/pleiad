// 次の発言を待つ agy を AGENT_HOST_AGY_IDLE_MS で止める（core/backends/antigravity.mjs の armIdle）。
//
// 動いている agy は起動の時にしかキーチェーンの資格情報を読まず、メモリのトークンを更新して書き戻す。
// 長く生かした agy が、切り替えた後のログインを古い方で上書きするので、待っている agy を時間で止める（docs/multi-backend.md §2.8）。
// 保持役に載せない子（サーバーの子）と載せる子（保持役の子）の両方で、
// 止まる・次のターンは `--conversation` で起こし直す・ターンの間は止めない、を見る。
// setTimeout の上限（2^31−1 ms）を超える値・Infinity は止めない扱い（そのまま渡すと 1 ms になり、ターンのたびに止まる。idleDelay）。
// サーバーを起こし直したときの片付けは tests/unit/restart-agy-idle.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { idleDelay } from '../../core/backends/antigravity.mjs';

export const name = 'antigravity-idle';
export const title = '次の発言を待つ agy は時間で止め、次のターンで起こし直す';

// ターンの終わりから次のターンの送信までの間（混んだ CI では数秒）より十分に長くする。短いと、続けたターンの前に止まって揺れる（1.5 秒では落ちた）
const IDLE_MS = 8_000;
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

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-idle-')));
  const fake = path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs');
  const work = path.join(scratch, 'work');
  await fs.mkdir(work, { recursive: true });
  const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));

  const cases = [['保持役に載せない', false], ['保持役に載せる', true]];
  const dataDirs = [];
  // 起こされた pid のうち会話の agy だけを拾う（送信の関所・裏の一覧取得も同じ控えに残る。会話の起こしは --input-format を持つ）
  const convPids = async (pidFile, argsFile) => {
    const [pids, args] = await Promise.all([readJson(pidFile), readJson(argsFile)]);
    return pids.filter((_, i) => args[i]?.includes('--input-format'));
  };
  const convArgs = async (argsFile) => (await readJson(argsFile)).filter((a) => a.includes('--input-format'));
  // 既定が先から分かっている状態を作る一覧の写し。無いと、ターンのあいだに一覧が届いて渡すモデルが変わり、会話を --conversation で起こし直して揺れる
  const seedModels = async (dataDir) => {
    const dir = path.join(dataDir, 'antigravity');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({
      rows: [
        { id: 'fake-antigravity-1', label: 'Fake Antigravity 1' },
        { id: 'fake-antigravity-2', label: 'Fake Antigravity 2 (Thinking)' },
        { id: 'fake-flash-high', label: 'Fake Flash (High)' },
        { id: 'fake-flash-low', label: 'Fake Flash (Low)' },
      ],
      defaultLabel: 'Fake Flash (High)', fetchedAt: Date.now(),
    }));
  };
  try {
    // 値の読み: 止めない（null）のは 0 以下・数でない・setTimeout の上限を超える・Infinity
    {
      const values = [[30 * 60_000, 30 * 60_000], ['8000', 8000], [2 ** 31 - 1, 2 ** 31 - 1], [2 ** 31, null], ['99999999999', null], ['Infinity', null], [Infinity, null], ['0', null], ['-1', null], ['abc', null], ['', null]];
      t.ok('値の読み: setTimeout の上限（2^31−1 ms）までは ms のまま、超える値・Infinity・0 以下・数でないものは止めない',
        values.every(([value, expected]) => idleDelay(value) === expected), JSON.stringify(values.map(([value]) => [String(value), idleDelay(value)])));
    }
    // 上限を超える値を入れても、ターンの終わりに止めない（続けたターンは同じ agy を使う）
    {
      const dir = path.join(scratch, 'huge');
      const dataDir = path.join(dir, 'data');
      const pidFile = path.join(dir, 'agy-pids.json');
      const argsFile = path.join(dir, 'agy-args.json');
      dataDirs.push([dataDir, path.join(dir, 'runtime')]);
      const env = { AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: `node "${fake}"`, AGENT_HOST_AGY_IDLE_MS: String(2 ** 31), AGENT_HOST_AGY_HOLDER: 'off', FAKE_AGY_PID_FILE: pidFile, FAKE_AGY_ARGS_FILE: argsFile };
      await seedModels(dataDir);
      const s = await startServer({ env, dataDir, timeoutMs: 30_000 });
      const c = await open({ port: s.port, token: s.token });
      try {
        const first = await c.runTurn({ backend: 'antigravity', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
        assert.equal(first.outcome, 'ok', s.tail(10));
        const [p1] = await convPids(pidFile, argsFile);
        await sleep(500);   // 上限を超えた値が 1 ms のタイマーになっていれば、ここで止まる
        const next = await c.runTurn({ backend: 'antigravity', sessionId: first.sessionId, cwd: work, prompt: 'つづき' }, { ms: WAIT_MS });
        assert.equal(next.outcome, 'ok', s.tail(10));
        const convs = await convPids(pidFile, argsFile);
        t.ok('上限を超える値（2^31 ms）では待つ agy を止めず、続けたターンも同じ agy を使う', convs.length === 1 && alive(p1), JSON.stringify(convs));
      } finally { c.close(); await s.stop(); }
    }
    for (const [label, held] of cases) {
      const dir = path.join(scratch, held ? 'held' : 'plain');
      const dataDir = path.join(dir, 'data');
      const root = path.join(dir, 'runtime');
      const pidFile = path.join(dir, 'agy-pids.json');
      const argsFile = path.join(dir, 'agy-args.json');
      dataDirs.push([dataDir, root]);
      const env = {
        AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: `node "${fake}"`, AGENT_HOST_AGY_IDLE_MS: String(IDLE_MS),
        FAKE_AGY_PID_FILE: pidFile, FAKE_AGY_ARGS_FILE: argsFile,
        ...(held ? { AGENT_HOST_RUNTIME_ROOT: root } : { AGENT_HOST_AGY_HOLDER: 'off' }),
      };
      await seedModels(dataDir);
      const s = await startServer({ env, dataDir, timeoutMs: 30_000 });
      const c = await open({ port: s.port, token: s.token });
      try {
        const first = await c.runTurn({ backend: 'antigravity', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
        assert.equal(first.outcome, 'ok', `${label}: ${s.tail(10)}`);
        const sid = first.sessionId;
        const [p1] = await convPids(pidFile, argsFile);
        assert.ok(Number.isInteger(p1), `${label}: 偽の agy の pid が控えられる`);

        // 待ち始めた直後のターンは同じ agy を使う。ターンの間（IDLE_MS より長くかかる）は止めない
        const slow = await c.runTurn({ backend: 'antigravity', sessionId: sid, cwd: work, prompt: `delay${IDLE_MS + 1_000}` }, { ms: WAIT_MS + IDLE_MS });
        assert.equal(slow.outcome, 'ok', `${label}: IDLE_MS より長いターンが途中で止まらない ${s.tail(10)}`);
        assert.deepEqual(await convPids(pidFile, argsFile), [p1], `${label}: 待つ間に続けたターンは起こし直さない`);
        t.ok(`${label}: IDLE_MS の内に続けたターンは同じ agy を使い、ターンの間は止めない`, alive(p1), String(p1));

        // 待ったまま IDLE_MS を過ぎると止まる
        await until(() => !alive(p1), IDLE_MS + 10_000, `${label}: 待っている agy が止まる`)
          .catch(error => { throw new Error(`${error.message}\n${s.tail(15)}`); });
        t.ok(`${label}: 次の発言を待つ agy は IDLE_MS で止まる`, true);
        // Pleiad のコンテキストを渡したエージェント定義の置き場（--add-dir の最後）も片付ける
        const firstArgs = (await convArgs(argsFile))[0] ?? [];
        const home = firstArgs[firstArgs.lastIndexOf('--add-dir') + 1];
        assert.ok(home?.includes(path.join('antigravity', 'context')), `${label}: 置き場が --add-dir に渡る ${JSON.stringify(firstArgs)}`);
        await until(() => fs.stat(home).then(() => false, () => true), 10_000, `${label}: 止めた agy の置き場が消える`);
        t.ok(`${label}: 止めた agy のエージェント定義の置き場を消す`, true);

        // 次のターンは --conversation で起こし直す（会話は続く）
        const next = await c.runTurn({ backend: 'antigravity', sessionId: sid, cwd: work, prompt: 'つづき' }, { ms: WAIT_MS });
        assert.equal(next.outcome, 'ok', `${label}: ${s.tail(10)}`);
        const pids = await convPids(pidFile, argsFile);
        const last = (await convArgs(argsFile)).at(-1) ?? [];
        t.ok(`${label}: 止めた後のターンは --conversation で起こし直す`,
          pids.length === 2 && pids[1] !== p1 && last[last.indexOf('--conversation') + 1] === sid && next.sessionId === sid,
          JSON.stringify({ pids, last }));
      } finally { c.close(); await s.stop(); }
    }
  } finally {
    for (const [dataDir, root] of dataDirs) await cleanupTestHolder(dataDir, root).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
