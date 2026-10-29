import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserConfigFile, browserEnvironment, browserSocketDirectory, daemonConfigFingerprint, locateAgentBrowser, prestartBrowserDaemon,
  settleBrowserEnvironment, sweepBrowserEnvironments } from '../../core/agent-browser.mjs';
import { run, spawnChild } from '../../core/process.mjs';

export const name = 'agent-browser-prestart';
export const title = 'Windows で agent-browser のデーモンを Pleiad が先に起こす（子のシェルのパイプを持たせない。ADR 0284）';

const sessionName = dir => `ply-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}`;
const exists = file => fs.stat(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ab-pre-'));
  const socketRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ab-presock-'));
  const socketDirs = new Set();
  // 偽のプロセス表と偽の起動。本物のプロセスは起こさず落とさない
  const table = new Map();
  const killed = [];
  const spawned = [];
  let nextPid = 910001;
  const fakes = { processes: async () => new Map(table), kill: pid => { killed.push(pid); table.delete(pid); }, isAlive: pid => table.has(pid), waitMs: 300 };
  const spawn = async (exe, args, options) => { const pid = nextPid++; spawned.push({ exe, args, options, pid }); table.set(pid, 'agent-browser.exe'); return { pid }; };
  const ports = new Set();
  const probe = async port => ports.has(port);
  const daemon = { exe: 'C:/fake/agent-browser.exe', version: '0.38.1', platform: 'win32', spawn, probe, baseEnv: { PATH: 'x' }, ...fakes };
  const bridge = { pinTab: true, endpoint: async () => 'ws://127.0.0.1:1/devtools/browser/key', configSessionId: id => id };
  const files = env => {
    const at = suffix => path.join(env.AGENT_BROWSER_SOCKET_DIR, `${env.AGENT_BROWSER_SESSION}.${suffix}`);
    return { at, read: suffix => fs.readFile(at(suffix), 'utf8').then(text => text.trim(), () => null), write: (suffix, text) => fs.writeFile(at(suffix), String(text)) };
  };
  // デーモンが起きた後に自分で書く記録（.pid・.version・.port）を偽の起動の後に書く
  const boot = async (env, { version = '0.38.1', port = 50001 } = {}) => {
    const f = files(env), pid = spawned.at(-1).pid;
    await f.write('pid', pid); await f.write('version', version); await f.write('port', port);
    ports.add(port);
    return pid;
  };
  try {
    // ---- 指紋: 実物の CLI（0.38.1）が <セッション名>.config に書いた値と同じ
    t.ok('設定の指紋は CLI と同じ（idle_timeout 24 時間）', daemonConfigFingerprint({ idleTimeout: '86400000' }) === 'c0f0068199d04f06');
    t.ok('設定の指紋は CLI と同じ（idle_timeout 8 秒）', daemonConfigFingerprint({ idleTimeout: '8000' }) === '510613f90ae36384');

    // ---- ターンの初め: 起きていなければ、標準入出力を受け継がない形で起こす
    const env = await browserEnvironment({ bridge, dataDir, sessionId: 'pre-1', daemon, cwd: dataDir });
    socketDirs.add(env.AGENT_BROWSER_SOCKET_DIR);
    const first = spawned[0];
    const f = files(env);
    t.ok('ターンの初めにデーモンを 1 つ起こす', spawned.length === 1 && first.exe === daemon.exe && first.args.length === 0);
    t.ok('デーモンの環境: AGENT_BROWSER_DAEMON・セッション・ソケットの置き場・中継の接続先・暇の時間', first.options.env.AGENT_BROWSER_DAEMON === '1'
      && first.options.env.AGENT_BROWSER_SESSION === env.AGENT_BROWSER_SESSION && first.options.env.AGENT_BROWSER_SOCKET_DIR === env.AGENT_BROWSER_SOCKET_DIR
      && first.options.env.AGENT_BROWSER_CDP === 'ws://127.0.0.1:1/devtools/browser/key' && first.options.env.AGENT_BROWSER_IDLE_TIMEOUT_MS === '86400000'
      && first.options.env.AGENT_BROWSER_PIN_TAB === '1' && first.options.env.PATH === 'x', JSON.stringify(first.options.env));
    t.ok('デーモンの作業場所は会話の作業場所（相対パスの保存先）', first.options.cwd === dataDir);
    t.ok('CLI が見る設定の指紋と、先に起こした印（pid）を書く', await f.read('config') === 'c0f0068199d04f06' && await f.read('ply-prestart') === String(first.pid));
    const pid1 = await boot(env);

    // ---- 次のターン: CLI がそのまま使えるデーモンが居れば起こさない
    await browserEnvironment({ bridge, dataDir, sessionId: 'pre-1', daemon });
    t.ok('使えるデーモンが居れば起こさない', spawned.length === 1 && killed.length === 0);
    // 版が違う（Pleiad を更新した）デーモンは、CLI が起こし直す前に Pleiad が止めて起こし直す
    await f.write('version', '0.37.0');
    t.ok('版が違うデーモンは止めて起こし直す', await prestartBrowserDaemon({ dir: path.dirname(env.AGENT_BROWSER_CONFIG), env, cdp: 'ws://x', ...daemon }) === 'started'
      && killed.includes(pid1) && spawned.length === 2 && await f.read('version') === null && await f.read('ply-prestart') === String(spawned[1].pid));
    const pid2 = await boot(env);
    await f.write('config', 'ffffffffffffffff');
    t.ok('指紋が違う（エージェントが --debug などで起こし直した）デーモンも、止めて起こし直す', await prestartBrowserDaemon({ dir: path.dirname(env.AGENT_BROWSER_CONFIG), env, cdp: 'ws://x', ...daemon }) === 'started'
      && killed.includes(pid2) && await f.read('config') === 'c0f0068199d04f06');
    await boot(env, { port: 50002 });
    ports.delete(50002);
    const blind = { ...daemon, processes: async () => null, isAlive: () => true };
    t.ok('ポートにつながらず、古いデーモンが止められなければ触らない', await prestartBrowserDaemon({ dir: path.dirname(env.AGENT_BROWSER_CONFIG), env, cdp: 'ws://x', ...blind }) === 'busy'
      && spawned.length === 3);
    ports.add(50002);
    t.ok('指紋を変える環境変数（AGENT_BROWSER_DEBUG など）があれば起こさない', await prestartBrowserDaemon({ dir: path.dirname(env.AGENT_BROWSER_CONFIG), env, cdp: 'ws://x', ...daemon,
      baseEnv: { AGENT_BROWSER_DEBUG: '1' } }) === 'skipped');
    const failed = [];
    const broken = await browserEnvironment({ bridge, dataDir, sessionId: 'pre-broken', daemon: { ...daemon, spawn: async () => { throw new Error('ENOENT'); } }, log: line => failed.push(line) });
    socketDirs.add(broken.AGENT_BROWSER_SOCKET_DIR);
    t.ok('起こせなくてもターンの環境は返す（エージェントの最初の呼び出しが今までどおり起こす）', broken.AGENT_BROWSER_SESSION && failed.some(line => line.includes('ENOENT')));
    const before = spawned.length;
    const unix = await browserEnvironment({ bridge, dataDir, sessionId: 'pre-unix', daemon: { ...daemon, platform: 'linux' } });
    socketDirs.add(unix.AGENT_BROWSER_SOCKET_DIR);
    const plain = await browserEnvironment({ bridge, dataDir, sessionId: 'pre-none' });
    socketDirs.add(plain.AGENT_BROWSER_SOCKET_DIR);
    t.ok('Windows 以外・実行ファイルが無いときは起こさない', spawned.length === before);
    t.ok('PATH の agent-browser.exe を探すのは Windows だけ', await locateAgentBrowser({ platform: 'linux' }) === null);

    // ---- ターンの終わり: 先に起こしたまま使わなかったデーモンは止めて置き場を消す。使ったら残す
    for (const id of ['pre-1', 'pre-broken', 'pre-unix', 'pre-none']) await settleBrowserEnvironment({ bridge, dataDir, sessionId: id, ...fakes });
    killed.length = 0;
    const idle = await browserEnvironment({ bridge, dataDir, sessionId: 'idle-1', daemon });
    socketDirs.add(idle.AGENT_BROWSER_SOCKET_DIR);
    const idlePid = await boot(idle);
    t.ok('タブを一度も使わなかった先に起こしたデーモンは、ターンの終わりに止めて置き場を消す', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'idle-1', ...fakes }) === true
      && killed.includes(idlePid) && !(await exists(idle.AGENT_BROWSER_SOCKET_DIR)) && !(await exists(path.dirname(idle.AGENT_BROWSER_CONFIG))));
    const usedEnv = await browserEnvironment({ bridge, dataDir, sessionId: 'used-1', daemon });
    socketDirs.add(usedEnv.AGENT_BROWSER_SOCKET_DIR);
    const usedPid = await boot(usedEnv);
    await files(usedEnv).write('target', '{"targetId":"T","url":"https://example.com/","pinned":true}');
    t.ok('タブを使った（縛りの記録 .target がある）デーモンは止めない', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'used-1', ...fakes }) === false
      && !killed.includes(usedPid) && await exists(usedEnv.AGENT_BROWSER_CONFIG));
    const restarted = await browserEnvironment({ bridge, dataDir, sessionId: 'restarted-1', daemon });
    socketDirs.add(restarted.AGENT_BROWSER_SOCKET_DIR);
    await boot(restarted);
    await files(restarted).write('pid', 999999);   // CLI が起こし直した（印の pid と違う）
    t.ok('CLI が起こし直したデーモンは、今までどおり止めない', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'restarted-1', ...fakes }) === false && !killed.includes(999999));
    const running = await browserEnvironment({ bridge, dataDir, sessionId: 'busy-1', daemon });
    socketDirs.add(running.AGENT_BROWSER_SOCKET_DIR);
    const runningPid = await boot(running);
    t.ok('次のターンが始まっていたら（busy）止めない', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'busy-1', busy: () => true, ...fakes }) === false && !killed.includes(runningPid));

    // ---- 掃除: ターンの終わりの片付けが届かなかった、先に起こしたまま使わなかったデーモンを止める
    const result = await sweepBrowserEnvironments({ bridge, dataDir, socketRoot, sessions: ['used-1', 'restarted-1', 'busy-1'], ...fakes });
    t.ok('掃除は、持ち主の居る置き場でも先に起こしたまま使わなかったデーモンを止める', killed.includes(runningPid) && !killed.includes(usedPid)
      && !(await exists(path.dirname(running.AGENT_BROWSER_CONFIG))) && await exists(usedEnv.AGENT_BROWSER_CONFIG) && result.unused === 1 && result.stopped === 1, JSON.stringify(result));

    // ---- 実物の agent-browser（Windows・同梱の版があるときだけ）
    await realBinary(t);
  } finally {
    for (const socketDir of socketDirs) await fs.rm(socketDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(socketRoot, { recursive: true, force: true });
  }
}

/**
 * 先に起こしたデーモンに、パイプにつないだ CLI を呼ぶと、CLI が終わればパイプが閉じる（Issue #156 の再現の形）。
 * CLI がデーモンを起こし直さない（指紋・版・ポートが CLI の見方に合う）ことも確かめる。中継の接続先は誰も居ないポート（コマンドは失敗で返る）
 */
async function realBinary(t) {
  const exe = path.join(ROOT, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
  if (process.platform !== 'win32' || !existsSync(exe)) { t.ok('実物の agent-browser の確かめ（Windows で同梱の版があるときだけ。ここでは飛ばす）', true); return; }
  const version = /agent-browser\s+(\S+)/.exec((await run(exe, ['--version'], { timeoutMs: 10_000 })).stdout)?.[1];
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ab-real-'));
  const bridge = { pinTab: true, endpoint: async () => 'ws://127.0.0.1:9/devtools/browser/none', configSessionId: id => id };
  let env = null, pid = null;
  try {
    env = await browserEnvironment({ bridge, dataDir, sessionId: 'real-1', daemon: { exe, version }, cwd: dataDir });
    const at = suffix => path.join(env.AGENT_BROWSER_SOCKET_DIR, `${env.AGENT_BROWSER_SESSION}.${suffix}`);
    pid = Number(await fs.readFile(at('ply-prestart'), 'utf8'));
    for (let i = 0; i < 100 && !existsSync(at('port')); i++) await sleep(50);
    const daemonPid = Number(await fs.readFile(at('pid'), 'utf8').catch(() => '0'));
    t.ok('先に起こしたデーモンが起き、自分の pid を書く（起こした pid と同じ）', existsSync(at('port')) && daemonPid === pid, JSON.stringify({ pid, daemonPid }));
    // 標準出力・標準エラーをパイプにして CLI を呼ぶ。close はパイプの書き口が全部閉じたとき（デーモンが持っていれば来ない）
    const child = spawnChild(exe, ['get', 'url'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.resume();
    const closed = await Promise.race([new Promise(resolve => child.once('close', () => resolve(true))), sleep(15_000).then(() => false)]);
    if (!closed) child.kill();
    t.ok('パイプにつないだ CLI が終わると、パイプが閉じる（デーモンが書き口を持たない）', closed);
    t.ok('CLI はデーモンを起こし直さない（指紋・版が CLI の見方に合う）', Number(await fs.readFile(at('pid'), 'utf8').catch(() => '0')) === pid
      && (await fs.readFile(at('config'), 'utf8')).trim() === daemonConfigFingerprint({ idleTimeout: env.AGENT_BROWSER_IDLE_TIMEOUT_MS }));
  } finally {
    // 起こしたデーモンだけ落とす（CLI が起こし直していたら、その pid も）
    for (const target of new Set([pid, Number(await fs.readFile(path.join(env?.AGENT_BROWSER_SOCKET_DIR ?? dataDir, `${env?.AGENT_BROWSER_SESSION}.pid`), 'utf8').catch(() => '0'))])) {
      if (target > 0) try { process.kill(target); } catch { /* もう居ない */ }
    }
    await sleep(300);
    if (env) await fs.rm(env.AGENT_BROWSER_SOCKET_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
