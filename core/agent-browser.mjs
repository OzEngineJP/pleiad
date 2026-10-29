import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { run, detach } from './process.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';

export function browserSocketDirectory(dir, platform = process.platform) {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24);
  // Use workspace-write's default temporary roots without adding sandbox grants.
  if (platform === 'win32') return path.join(os.tmpdir(), `ply-ab-${hash}`);
  // macOS TMPDIR can exceed agent-browser's 103-byte Unix socket path limit.
  return path.join('/tmp', `ply-ab-${os.userInfo().uid}`, hash);
}

const configHash = configSessionId => crypto.createHash('sha256').update(configSessionId).digest('hex');

/** 会話ごとの agent-browser の設定ファイル（{ cdp }）の場所。会話の id（ネイティブの id に替わった後も最初の id）から決まる */
export function browserConfigFile(dataDir, configSessionId) {
  return path.join(dataDir, 'agent-browser', configHash(configSessionId), 'agent-browser.json');
}

/** agent-browser のセッション名（設定の置き場ごと） */
const sessionName = dir => `ply-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}`;

/**
 * 暇なデーモンを落とすまでの時間（AGENT_BROWSER_IDLE_TIMEOUT_MS）。agent-browser の既定の 1 時間は、--cdp でつないだデーモンには効かない。
 * 明示して渡すと --cdp でも効き、落ちるときは Chrome にもタブにも何も送らない（実機、2026-10-09。ADR 0180）
 */
export const BROWSER_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

const TABS_MAX = 500;

// 設定の置き場ごとの順番待ち。ターンの終わりの片付け（settle）は待たずに走るので、次のターンが置き場を書くのと、片付けが消すのを重ねない
const queues = new Map();
function inOrder(dir, fn) {
  const run = (queues.get(dir) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => {}, () => {});
  queues.set(dir, tail);
  tail.then(() => { if (queues.get(dir) === tail) queues.delete(dir); });
  return run;
}

/**
 * main が報告した内蔵ブラウザーのタブの写し（{ tabs: [{ sessionId, url, selected }] }）の形を整える。
 * 戻った main がタブを開き直すのに使う（core/browser-viewer.mjs）。http(s) の URL だけ（file: のタブ・空のタブは戻さない）
 */
export function cleanTabState(message) {
  const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
  const tabs = [];
  for (const tab of Array.isArray(message?.tabs) ? message.tabs : []) {
    const url = text(tab?.url, 4096), sessionId = tab?.sessionId == null ? null : text(tab.sessionId, 200);
    if (!url || !/^https?:\/\//i.test(url) || (tab.sessionId != null && !sessionId)) continue;
    tabs.push({ sessionId, url, selected: tab.selected === true });
    if (tabs.length >= TABS_MAX) break;
  }
  return { tabs };
}

/**
 * エージェントのブラウザーの道は PC の Chrome の中継（core/chrome/relay.mjs）だけ。Chrome の中継を browserEnvironment の bridge の形にする。endpoint は parentPort の往復なしで core の中継から取る。
 * pinTab: agent-browser を自分のタブに縛る（AGENT_BROWSER_PIN_TAB=1。無いと最初の open が「アクティブなタブ」を書き換えうる。ADR 0148）
 * 縛りはソケットの置き場の <セッション名>.target に残り、縛ったタブが消えると次の open からも tab_gone で断る。会話のタブがエージェントの外で全部無くなったら
 * （窓を閉じる操作・人が窓を閉じた・Chrome が切れた。relay.onTabsLost）この記録を消す。消したら true を返し、中継が接続を切るので、デーモンはつなぎ直して新しい専用窓を開く
 */
export function chromeRelayBrowser(relay, { dataDir } = {}) {
  const configIds = new Map();
  if (dataDir) relay.onTabsLost?.(sessionId => {
    const dir = path.dirname(browserConfigFile(dataDir, configIds.get(sessionId) ?? sessionId));
    try { rmSync(path.join(browserSocketDirectory(dir), `${sessionName(dir)}.target`)); return true; } catch { return false; }   // 記録が無い（縛っていない）
  });
  return {
    pinTab: true,
    endpoint: (sessionId, options) => relay.endpoint(sessionId, options),
    rebind(from, to) { configIds.set(to, configIds.get(from) ?? from); relay.rebind(from, to); },
    configSessionId: sessionId => configIds.get(sessionId) ?? sessionId,
    // 今の会話の id と設定の置き場の id の組（ID 確定後の会話だけ）。掃除が置き場の持ち主を引くのに使う（sweepBrowserEnvironments）
    bindings: () => [...configIds],
    forget: sessionId => { configIds.delete(sessionId); },
    endTurn: sessionId => relay.endTurn(sessionId),
  };
}

/**
 * daemon: Pleiad が先にデーモンを起こすときの agent-browser（locateAgentBrowser の { exe, version }）。null なら起こさない（今までどおり、エージェントの最初の呼び出しが起こす）。
 * Windows だけ（platform は試験用）。cwd はデーモンの作業場所（相対パスの保存先。エージェントのシェルの最初の場所に合わせる）
 */
export async function browserEnvironment({ bridge, dataDir, sessionId, unlock = false, daemon = null, cwd = undefined, log = () => {} }) {
  if (!bridge || !sessionId) return null;
  const url = await bridge.endpoint(sessionId, { unlock });
  // Keep the shell config path and agent-browser namespace stable after a new thread gets its native ID.
  const configSessionId = bridge.configSessionId?.(sessionId) ?? sessionId;
  const file = browserConfigFile(dataDir, configSessionId);
  const dir = path.dirname(file);
  const session = sessionName(dir);
  const socketDir = browserSocketDirectory(dir);
  const env = { AGENT_BROWSER_CONFIG: file, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_NAMESPACE: '',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(BROWSER_IDLE_TIMEOUT_MS), ...(bridge.pinTab ? { AGENT_BROWSER_PIN_TAB: '1' } : {}) };
  await inOrder(dir, async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Windows のデーモンはソケットの置き場を自分で作る（無くても動く。実機、2026-10-09）。前もって作ると、ブラウザーを使わなかった会話の空の置き場が
    // 一時領域に残るので作らない。Unix は確かめていないので今どおり作り、使わなかったターンの終わりに消す（settleBrowserEnvironment。ADR 0180）
    if (process.platform !== 'win32') await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify({ cdp: url }), { mode: 0o600 });
    if (daemon?.exe && (daemon.platform ?? process.platform) === 'win32') {
      // 起こせなくてもターンは止めない（エージェントの最初の呼び出しが今までどおり起こす）
      const state = await prestartBrowserDaemon({ dir, env, cdp: url, cwd, ...daemon }).catch(error => { log(`agent-browser prestart failed: ${error.message}`); return 'failed'; });
      if (state !== 'running' && state !== 'started') log(`agent-browser prestart: ${state}`);
    }
  });
  return env;
}

// ---- デーモンを先に起こす（Windows。ADR 0285）
//
// Windows の agent-browser の CLI は、デーモンを CreateProcess の bInheritHandles=TRUE で起こすので、CLI の標準出力・標準エラーが
// パイプ（`agent-browser … | tail`・`$(agent-browser …)`）だと、デーモンがそのパイプの書き口を持ったまま残り、シェルのコマンドが返らない（Issue #156）。
// Pleiad がターンの初めに、標準入出力を受け継がない形（detach）で先に起こしておくと、CLI は起きているデーモンにつなぐだけになる。
// CLI が「使える」と見なす条件（agent-browser 0.38.1 の cli/src/connection.rs の ensure_daemon）を全部満たして起こす:
//   - <セッション名>.port のポートに TCP でつながる（デーモンが自分で書く）
//   - <セッション名>.version が CLI の版と同じ（デーモンが自分で書く）
//   - <セッション名>.config が CLI の設定の指紋と同じ（CLI が書く。無いと 1 秒待ってから起こし直す）→ Pleiad が書く（daemonConfigFingerprint）

/** 先に起こしたデーモンの印（中身は起こした pid）。CLI もデーモンも触らない名前 */
const PRESTART_MARK = 'ply-prestart';

/** 設定の指紋を変える環境変数。利用者が付けていたら、指紋を合わせられないので先に起こさない */
const FINGERPRINT_ENV = ['AGENT_BROWSER_DEBUG', 'AGENT_BROWSER_ACTION_POLICY', 'AGENT_BROWSER_CONFIRM_ACTIONS', 'AGENT_BROWSER_DEFAULT_TIMEOUT', 'AGENT_BROWSER_NO_AUTO_DIALOG'];

const U64 = (1n << 64n) - 1n;
const rotl = (x, b) => ((x << BigInt(b)) | (x >> BigInt(64 - b))) & U64;

/** Rust の std の DefaultHasher（鍵 0 の SipHash-1-3）の 16 桁 */
function sipHash13(bytes) {
  let v0 = 0x736f6d6570736575n, v1 = 0x646f72616e646f6dn, v2 = 0x6c7967656e657261n, v3 = 0x7465646279746573n;
  const round = () => {
    v0 = (v0 + v1) & U64; v1 = rotl(v1, 13); v1 ^= v0; v0 = rotl(v0, 32);
    v2 = (v2 + v3) & U64; v3 = rotl(v3, 16); v3 ^= v2;
    v0 = (v0 + v3) & U64; v3 = rotl(v3, 21); v3 ^= v0;
    v2 = (v2 + v1) & U64; v1 = rotl(v1, 17); v1 ^= v2; v2 = rotl(v2, 32);
  };
  const word = (at, count) => { let m = 0n; for (let i = 0; i < count; i++) m |= BigInt(bytes[at + i]) << BigInt(8 * i); return m; };
  const full = bytes.length - (bytes.length % 8);
  for (let at = 0; at < full; at += 8) { const m = word(at, 8); v3 ^= m; round(); v0 ^= m; }
  const last = (BigInt(bytes.length & 0xff) << 56n) | word(full, bytes.length - full);
  v3 ^= last; round(); v0 ^= last;
  v2 ^= 0xffn; round(); round(); round();
  return (v0 ^ v1 ^ v2 ^ v3).toString(16).padStart(16, '0');
}

/**
 * CLI が <セッション名>.config に書く設定の指紋（connection.rs の daemon_config_fingerprint）。
 * (debug, action_policy, confirm_actions, idle_timeout, default_timeout, no_auto_dialog) を Rust の Hash の並びで混ぜる:
 * bool は 1 バイト、Option は判別子（isize の 8 バイト）と中身、str は UTF-8 の後に 0xff、u64 は 8 バイト（どれもリトルエンディアン）。
 * Pleiad が渡すのは idle_timeout（AGENT_BROWSER_IDLE_TIMEOUT_MS）だけ。実物の CLI と同じ値になることは tests/unit/agent-browser-prestart.mjs が確かめる
 */
export function daemonConfigFingerprint({ idleTimeout = null } = {}) {
  const isize = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return [...b]; };
  const optionText = text => (text == null ? isize(0) : [...isize(1), ...Buffer.from(String(text), 'utf8'), 0xff]);
  return sipHash13(Uint8Array.from([0, ...optionText(null), ...optionText(null), ...optionText(idleTimeout), ...isize(0), 0]));
}

const located = new Map();
/**
 * PATH の上の agent-browser.exe（デスクトップ版が先頭に足す同梱のもの。desktop/agent-browser-bin.cjs）と、その版（`--version`）。
 * 子のシェルが呼ぶのと同じものを起こす。Windows 以外・見つからない・版が読めないなら null（先に起こさない）。PATH ごとに 1 回だけ引く
 */
export function locateAgentBrowser({ env = process.env, platform = process.platform, runner = run } = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  const pathValue = env[Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'] ?? '';
  if (!located.has(pathValue)) located.set(pathValue, (async () => {
    for (const entry of pathValue.split(';').filter(Boolean)) {
      const exe = path.join(entry.replace(/^"|"$/g, ''), 'agent-browser.exe');
      if (!(await fs.stat(exe).then(stat => stat.isFile(), () => false))) continue;
      const result = await runner(exe, ['--version'], { windowsHide: true, timeoutMs: 10_000 });
      const version = /agent-browser\s+(\S+)/.exec(String(result.stdout ?? ''))?.[1];
      return result.exitCode === 0 && version ? { exe, version } : null;
    }
    return null;
  })().catch(() => null));
  return located.get(pathValue);
}

/** 127.0.0.1:port に TCP でつながるか（CLI の daemon_ready と同じ見方） */
function portOpen(port, timeoutMs = 300) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * 設定の置き場 dir のデーモンを、標準入出力を受け継がない形で先に起こす。CLI がそのまま使えるデーモンがもう居れば何もしない。
 * env はエージェントのシェルへ渡す agent-browser の環境（browserEnvironment）、cdp は中継の接続先。
 * readyMs は起こした後にポートへつながるまで待つ上限。起こせなければ投げる（書いた .config は消す）。
 * @returns 'running'（使えるデーモンが居る）・'started'（起こしてつながった）・'slow'（起こしたが readyMs の内につながらない）・
 *   'skipped'（指紋を変える環境変数がある）・'busy'（古いデーモンを止められない）
 */
export async function prestartBrowserDaemon({ dir, env, cdp, exe, version, cwd, baseEnv = process.env, spawn = detach, probe = portOpen, readyMs = 2000, ...options }) {
  if (FINGERPRINT_ENV.some(name => baseEnv[name])) return 'skipped';
  const session = sessionName(dir);
  const socketDir = env.AGENT_BROWSER_SOCKET_DIR;
  const file = suffix => path.join(socketDir, `${session}.${suffix}`);
  const read = suffix => fs.readFile(file(suffix), 'utf8').then(text => text.trim(), () => null);
  const fingerprint = daemonConfigFingerprint({ idleTimeout: env.AGENT_BROWSER_IDLE_TIMEOUT_MS });
  const port = Number(await read('port'));
  if (Number.isInteger(port) && port > 0 && await probe(port)) {
    if (await read('version') === version && await read('config') === fingerprint) return 'running';
  }
  // 起きていない・版や指紋が合わない（CLI が起こし直す）デーモンは、Pleiad が止めてから起こし直す。止められなければ触らない
  const state = await stopBrowserDaemon(dir, options);
  if (state === 'unknown' || state === 'alive') return 'busy';
  // CLI の cleanup_stale_files と同じ記録を消す（デーモンは起きるときに .port・.stream などを自分で消す）
  for (const suffix of ['pid', 'version', 'config', 'stream', 'port', PRESTART_MARK]) await fs.rm(file(suffix), { force: true });
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file('config'), fingerprint);
  // CLI の apply_daemon_env が渡すもののうち、Pleiad の設定で決まるもの。ほかの AGENT_BROWSER_* は今の環境のまま受け継ぐ（CLI が起こすときと同じ）
  let pid;
  try {
    ({ pid } = await spawn(exe, [], { cwd, windowsHide: true, env: { ...baseEnv, ...env, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_CDP: cdp,
      AGENT_BROWSER_HIDE_SCROLLBARS: '1', AGENT_BROWSER_PLUGINS: '[]' } }));
  } catch (error) {
    // 起こせなければ書いた指紋を消す。.config だけが残ると、使った会話（daemonUsed）に見えるのに先に起こした印が無く、置き場が消えない
    await fs.rm(file('config'), { force: true });
    throw error;
  }
  await fs.writeFile(file(PRESTART_MARK), String(pid));
  // デーモンが .port を書いてつながるまで待つ（実機で 45ms ほど）。待たずに返すと、その間に呼んだ CLI がデーモンを自分で起こしうる。
  // 間に合わなければ 'slow' を返す（ターンは止めない。遅れて起きたデーモンは CLI がつなぐ）
  for (const end = Date.now() + readyMs; ;) {
    const ready = Number(await read('port'));
    if (Number.isInteger(ready) && ready > 0 && await probe(ready)) return 'started';
    if (Date.now() >= end) return 'slow';
    await sleep(25);
  }
}

/**
 * Pleiad が先に起こしたまま、エージェントが一度もタブを使っていないデーモンか。
 * 印の pid が今の .pid と同じ（CLI が起こし直していない）で、縛りの記録（.target。ブラウザーを触るたびにデーモンが書く）が無い
 */
async function prestartedIdle(dir) {
  const socketDir = browserSocketDirectory(dir), session = sessionName(dir);
  const read = suffix => fs.readFile(path.join(socketDir, `${session}.${suffix}`), 'utf8').then(text => text.trim(), () => null);
  const mark = await read(PRESTART_MARK);
  if (!mark || mark !== await read('pid')) return false;
  return await read('target') === null;
}

// ---- デーモンと置き場の寿命（ADR 0180）
//
// デーモンは会話ごとに 1 つで、エージェントが最初に agent-browser を呼んだときに起き、Pleiad の子ではない（Pleiad が落ちても残る）。
// 止めるのは「委譲の子が終わったとき」「会話を消したとき」「掃除（起動の後と 1 時間ごと）で持ち主が居ないと分かったとき」。
// 依頼元の会話（人が続けて使う）は、消すまで止めない。暇なデーモンは AGENT_BROWSER_IDLE_TIMEOUT_MS で自分で落ちる。

/** agent-browser の実行ファイルの名前（同梱の agent-browser.exe・npm の agent-browser-win32-x64.exe・Linux の ps の 15 文字で切れた名前） */
const DAEMON_IMAGE = /^agent-browser(?:-[a-z0-9-]+)?(?:\.exe)?$/i;
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 動いているプロセスの pid -> 実行ファイル名。引けなければ null（そのときは落とさない） */
export async function listProcesses() {
  const win = process.platform === 'win32';
  const [command, args] = win ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'pid=,comm=']];
  const result = await run(command, args, { windowsHide: true, timeoutMs: 10_000, maxOutputChars: 32 * 1024 * 1024 });
  if (result.startError || result.exitCode !== 0) return null;
  const map = new Map();
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    // "agent-browser.exe","12345","Console","1","10,000 K" / "  12345 /path/to/agent-browser"
    const hit = win ? /^"([^"]+)","(\d+)"/.exec(line) : /^\s*(\d+)\s+(.+)$/.exec(line);
    if (hit) map.set(Number(win ? hit[2] : hit[1]), path.basename((win ? hit[1] : hit[2]).trim()));
  }
  return map.size ? map : null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** デーモンが一度でも起きたか（ソケットの置き場に、そのセッション名の記録がある） */
async function daemonUsed(dir) {
  const prefix = `${sessionName(dir)}.`;
  return (await fs.readdir(browserSocketDirectory(dir)).catch(() => [])).some(name => name.startsWith(prefix));
}

/**
 * 設定の置き場 dir のデーモンを止める。pid の記録（<ソケットの置き場>/<セッション名>.pid）の pid が生きていて、実行ファイルが agent-browser のときだけ落とす
 * （pid は使い回される。名前が違えばデーモンはもう居ない）。
 * `agent-browser close` は使わない: デーモンが居ないと新しいデーモンを起こし（中継につながらないまま残る）、中継が切れた後は「閉じた」と返しても落ちないことがある。
 * 落とすのは TerminateProcess / SIGTERM。--cdp のデーモンは Chrome を持たないので、Chrome もタブも残り、CDP には何も送らない（どれも実機、2026-10-09）
 * @returns 'none'（記録が無い）・'gone'（もう居ない・別のプロセス）・'stopped'・'unknown'（確かめられない）・'alive'（落ちない）
 */
export async function stopBrowserDaemon(dir, { processes = listProcesses, kill = pid => process.kill(pid), isAlive = alive, waitMs = 5000 } = {}) {
  const text = await fs.readFile(path.join(browserSocketDirectory(dir), `${sessionName(dir)}.pid`), 'utf8').catch(() => null);
  if (text === null) return 'none';
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  const list = await processes();
  if (!list) return isAlive(pid) ? 'unknown' : 'gone';
  const name = list.get(pid);
  if (!name || !DAEMON_IMAGE.test(name)) return 'gone';
  try { kill(pid); } catch { return isAlive(pid) ? 'alive' : 'gone'; }
  for (const end = Date.now() + waitMs; isAlive(pid);) {
    if (Date.now() >= end) return 'alive';
    await sleep(100);
  }
  return 'stopped';
}

/**
 * 設定の置き場 dir のデーモンを止めてから、ソケットの置き場と設定の置き場を消す。pid の記録を消す前に止める（消すと、残ったデーモンを誰も止められない）。
 * 止めたと確かめられなければ何も消さない（次の掃除でやり直す）。busy は消す直前の見直し（その間に始まったターンの設定を消さない）
 */
function discard(dir, { busy = () => false, ...options } = {}) {
  return inOrder(dir, async () => {
    const state = await stopBrowserDaemon(dir, options);
    if (state === 'unknown' || state === 'alive' || busy()) return null;
    await fs.rm(browserSocketDirectory(dir), RM);
    await fs.rm(dir, RM);
    return state;
  });
}

/** 会話の id から、その会話が使いうる設定の置き場（ID 確定前の id の置き場と、再起動で組を忘れた後の今の id の置き場） */
function directoriesOf({ bridge, dataDir, sessionId }) {
  const ids = new Set([bridge?.configSessionId?.(sessionId) ?? sessionId, sessionId]);
  return [...ids].map(id => path.dirname(browserConfigFile(dataDir, id)));
}

/**
 * 委譲の子が終わったとき（完了・失敗・取り消し）に、その会話のデーモンを止めて置き場を消す。続きの指示で動き直せば、次のターンが作り直す。
 * busy は、その間にこの会話のターンが始まったか（始まったら消さない）
 */
export async function discardBrowserEnvironment({ bridge, dataDir, sessionId, busy = () => false, ...options }) {
  if (!sessionId) return false;
  let done = true;
  for (const dir of directoriesOf({ bridge, dataDir, sessionId })) done = Boolean(await discard(dir, { busy: () => busy(sessionId), ...options })) && done;
  return done;
}

/** 会話を消したときに、その会話のデーモンを止め、agent-browser の設定とソケットの置き場を消す（sessions.delete。ADR 0147・0180） */
export async function forgetBrowserEnvironment({ bridge, dataDir, sessionId, ...options }) {
  if (!sessionId) return;
  await discardBrowserEnvironment({ bridge, dataDir, sessionId, ...options });
  bridge?.forget?.(sessionId);
}

/**
 * ターンの終わり: このターンでエージェントが agent-browser を呼ばなかった（デーモンが一度も起きていない）なら、ターンの初めに書いた設定の置き場を消す。
 * Pleiad が先に起こしたデーモン（ADR 0285）のうち、エージェントが一度もタブを使っていないものは、止めてから消す。
 * ブラウザーを使わない会話の置き場とデーモンを残さない。使った会話は、縛りの記録（.target）を次のターンへ残すため消さない
 */
export async function settleBrowserEnvironment({ bridge, dataDir, sessionId, busy = () => false, ...options }) {
  if (!sessionId) return false;
  const dir = path.dirname(browserConfigFile(dataDir, bridge?.configSessionId?.(sessionId) ?? sessionId));
  return inOrder(dir, async () => {
    if (busy(sessionId)) return false;
    if (await daemonUsed(dir)) {
      if (!(await prestartedIdle(dir))) return false;
      const state = await stopBrowserDaemon(dir, options);
      if (state === 'unknown' || state === 'alive' || busy(sessionId)) return false;
    }
    await fs.rm(browserSocketDirectory(dir), RM);
    await fs.rm(dir, RM);
    return true;
  });
}

/**
 * 持ち主の居ないデーモンと置き場の掃除（起動の後と 1 時間ごと。core/server.mjs）。
 * - 設定の置き場（<dataDir>/agent-browser/<hash>）の持ち主の会話が無い（消した・ID 確定前の id のまま再起動した）か、終わった委譲の子（finished）なら、デーモンを止めて両方を消す
 * - 持ち主が居て、デーモンが一度も起きていない置き場は、unusedMs より古ければ消す（ターンの初めに書き直す）
 * - 走っている・人が引き継いでいる会話（busy）は触らない
 * - この Pleiad の置き場に当たらないソケットの置き場（ply-ab-*。別のデータの置き場の Pleiad・前の版が前もって作ったもの）は、空で emptyMs より古いものだけ消す。生きているデーモンは触らない
 * sessions は持ち主として数える会話の id（記録にある会話と、走っているターンの id）
 */
export async function sweepBrowserEnvironments({ bridge, dataDir, sessions, finished = () => false, busy = () => false, now = Date.now(),
  unusedMs = 60 * 60_000, emptyMs = 10 * 60_000, processes = listProcesses, socketRoot = null, ...options }) {
  const owners = new Map();
  for (const id of sessions) owners.set(configHash(id), id);
  for (const [id, configId] of bridge?.bindings?.() ?? []) owners.set(configHash(configId), id);
  const root = path.join(dataDir, 'agent-browser');
  let listed;
  const once = () => (listed ??= processes());   // 実行ファイル名の一覧は 1 回の掃除で 1 回だけ引く
  const result = { stopped: 0, removed: 0, unused: 0, empty: 0, kept: 0 };
  const known = new Set();
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const dir = path.join(root, name);
    const id = owners.get(name);
    if (id !== undefined && busy(id)) { known.add(path.basename(browserSocketDirectory(dir))); result.kept++; continue; }
    if (id === undefined || finished(id)) {
      const state = await discard(dir, { processes: once, busy: () => id !== undefined && busy(id), ...options });
      if (state) { result.removed++; if (state === 'stopped') result.stopped++; }
      else { known.add(path.basename(browserSocketDirectory(dir))); result.kept++; }
      continue;
    }
    known.add(path.basename(browserSocketDirectory(dir)));
    if (await daemonUsed(dir)) {
      // 先に起こしたまま使われなかったデーモン（ターンの終わりの片付けが届かなかった。ADR 0285）は止める
      const state = await prestartedIdle(dir) ? await discard(dir, { processes: once, busy: () => busy(id), ...options }) : null;
      if (state) { result.unused++; if (state === 'stopped') result.stopped++; } else result.kept++;
      continue;
    }
    const removed = await inOrder(dir, async () => {
      const stat = await fs.stat(path.join(dir, 'agent-browser.json')).catch(() => fs.stat(dir)).catch(() => null);
      if (!stat || now - stat.mtimeMs <= unusedMs || busy(id) || await daemonUsed(dir)) return false;
      await fs.rm(browserSocketDirectory(dir), RM); await fs.rm(dir, RM);
      return true;
    });
    if (removed) result.unused++; else result.kept++;
  }
  // ソケットの置き場は Windows は %TEMP%\ply-ab-<hash>、Unix は /tmp/ply-ab-<uid>/<hash>
  const tmp = socketRoot ?? path.dirname(browserSocketDirectory(path.join(root, 'x')));   // socketRoot は試験用
  const pattern = process.platform === 'win32' ? /^ply-ab-[a-f0-9]{24}$/ : /^[a-f0-9]{24}$/;
  for (const name of await fs.readdir(tmp).catch(() => [])) {
    if (!pattern.test(name) || known.has(name)) continue;
    const socketDir = path.join(tmp, name);
    const stat = await fs.stat(socketDir).catch(() => null);
    if (!stat?.isDirectory() || now - stat.mtimeMs <= emptyMs) continue;
    // 中身があれば rmdir が断る（他の Pleiad の会話の縛りの記録やデーモンを消さない）
    if (await fs.rmdir(socketDir).then(() => true, () => false)) result.empty++;
  }
  return result;
}

export function browserInstruction(env, locale, translate) {
  return env ? translate(locale, 'browser.instructions') : null;
}
