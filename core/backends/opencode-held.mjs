// OpenCode の共有のサーバー（`opencode serve`）を保持役（core/holder/）の子に載せる（無停止の更新。docs/multi-backend.md §2.10、ADR 0221）。
// Codex の app-server（codex-held.mjs）と同じく全部の会話で共有する 1 本だが、話すのは stdio ではなく HTTP と SSE なので、保持役に持たせるのはプロセスだけ:
//   - 子の stdout は起動の 1 行（`opencode server listening on …`）を読むだけで、記録は来たそばから ack して捨てる（再生には使わない）
//   - 新しいサーバーは札（label）の server（待ち受けの URL・basic 認証・中継の合言葉・Pleiad の待ち受け）でつなぎ直し、
//     走っていたターンは会話の発言（GET /session/{id}/message）と答えていない承認・質問（GET /permission・/question）から組み立て直す（opencode.mjs の adoptTurn）
//   札（label）: { k: 'opencode-server', v: 1, server: { base, auth, origin, secret }, turns: { <OpenCode の会話の id>: <サーバーの札> } }
//     origin は OpenCode に渡した Pleiad の待ち受け（中継の口・プラグインの env の URL）。違うポートで立った新しいサーバーは、走っているターンが無くなったら起こし直す
//   手を離す（handOff）: 同じ tick に来た全部のターンの札を置いて、保持役に detach する。以後このサーバーは子に書かない（HTTP は新しいサーバーのもの）
//   付け直し（expand）: 起動で保持役の子の札を読み、子に付けて、札のターンごとの元を返す。ターンの無い子も引き継ぐ（起こし直しの数秒を省く）
// 会話のシェルの環境変数（秘密情報を含む）は札に入れず、データ置き場の run/opencode-env-<uuid>.json に 0600 で置いて名前だけを札に書く（Claude の claude-env-file.mjs と同じ扱い）
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { bootEnv } from '../boot-env.mjs';
import { holderLink } from '../holder/link.mjs';
import { LABEL_MAX_BYTES } from '../holder/protocol.mjs';
import { ADOPT_TURN_MARK, registerChildExpander } from '../adopt.mjs';
import { accountKey } from './opencode-accounts.mjs';

export const OPENCODE_CHILD = 'opencode-server';
export const OPENCODE_LABEL_KIND = 'opencode-server';
/** 親が居ない状態が続いたとき、保持役が OpenCode を止めるまで（codex-held.mjs と同じ。引き継ぎ・落ちた後の起こし直しよりずっと長く、Pleiad を閉じた後に残り続けない長さ） */
const KEEP_MS = 10 * 60_000;
const LISTENING = /opencode server listening on (http:\/\/[^\s]+)/i;
const ENV_FILE = /^opencode-env-[0-9a-f-]+\.json$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 保持役に載せる切り替え。off で今の流れ（Pleiad の子）。何も書かなければ、置き場（AGENT_HOST_RUNTIME_ROOT = パッケージ版・on の起動）があるとき */
export function opencodeHeldEnabled(env = process.env) {
  const value = String(bootEnv('AGENT_HOST_OPENCODE_HOLDER') ?? env.AGENT_HOST_OPENCODE_HOLDER ?? '').toLowerCase();
  if (value === 'off') return false;
  return Boolean(bootEnv('AGENT_HOST_RUNTIME_ROOT'));
}

let dataDirOf = () => null;
let onAdopt = () => {};
let onForget = () => {};
/**
 * opencode.mjs が起動で 1 回呼ぶ。adopt(server, turns) は、前のサーバーの子を引き継いだとき（中継の合言葉を前の値にし、付け直す会話を待たせる）。
 * forget(sessionId) は、付け直さなかったターン（中継の待ちを外す）
 */
export function configureOpencodeHeld({ dataDir, adopt, forget }) { dataDirOf = dataDir; onAdopt = adopt ?? (() => {}); onForget = forget ?? (() => {}); }

const current = new Map();
const pendingAdopt = new Map();
export const opencodeChildId = account => account ? `${OPENCODE_CHILD}-${crypto.createHash('sha256').update(accountKey(account)).digest('hex').slice(0, 24)}` : OPENCODE_CHILD;

/** 保持役の子としての OpenCode。opencode-server.mjs が起こす・つなぎ直す・止めるのに使い、opencode.mjs が札を置く */
export class HeldOpencode {
  constructor({ client, spawned, server = null, id = OPENCODE_CHILD }) {
    this.client = client;
    this.id = id;
    this.adopted = !spawned;
    this.server = server;                 // { base, auth, origin, secret }
    this.cards = new Map();               // OpenCode の会話の id -> 札
    this.detached = false;
    this.closed = false;
    this.handing = null;
    this.labelTimer = null;
    this.ackTimer = null;
    this.pendingAck = 0;
    this.stderr = [];
    this.lineListeners = new Set();
    this.exitListeners = new Set();
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    this.onOut = frame => {
      if (frame.id !== this.id || this.detached) return;
      for (const fn of this.lineListeners) { try { fn(String(frame.line ?? '')); } catch { /* 受け手の失敗で読みを止めない */ } }
      this.#ack(frame.seq);
    };
    this.onErr = frame => {
      if (frame.id !== this.id) return;
      for (const line of String(frame.chunk ?? '').split(/\r?\n/)) if (line.trim()) { this.stderr.push(line); if (this.stderr.length > 40) this.stderr.shift(); }
    };
    this.onExit = frame => {
      if (frame.id !== this.id || this.closed) return;
      this.closed = true;
      try { this.client.release(this.id); } catch { /* つながりが切れていれば、記録は保持役が終わるときに消える */ }
      if (current.get(this.id) === this) current.delete(this.id);
      this.resolveExited();
      const exit = { code: frame.code ?? null, signal: frame.signal ?? null, error: frame.error ?? null };
      for (const fn of this.exitListeners) { try { fn(exit); } catch { /* 受け手の失敗で止めない */ } }
    };
    client.on('out', this.onOut);
    client.on('err', this.onErr);
    client.on('exit', this.onExit);
  }

  get writable() { return !this.detached && !this.closed && this.client.connected; }
  tail() { return this.stderr.slice(-3).join(' / '); }
  onLine(fn) { this.lineListeners.add(fn); return () => this.lineListeners.delete(fn); }
  onGone(fn) { this.exitListeners.add(fn); return () => this.exitListeners.delete(fn); }

  /** 引き継いだ子に付ける（答えは子の状態）。記録は捨ててあるので、続きの行だけを読む */
  async open(from) {
    const state = await this.client.attach(this.id, from ? { from } : {});
    return state;
  }

  /** 起こす。待ち受けの URL（stdout の最初の 1 行）で解決する。終わった・時間切れなら投げる */
  spawn({ command, args, env, cwd, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const done = (fn, value) => { clearTimeout(timer); offLine(); offGone(); fn(value); };
      const timer = setTimeout(() => done(reject, new Error(`opencode serve did not start in ${timeoutMs}ms: ${this.tail()}`.slice(0, 500))), timeoutMs);
      timer.unref?.();
      const offLine = this.onLine(line => { const m = LISTENING.exec(line); if (m) done(resolve, m[1].replace(/\/$/, '')); });
      const offGone = this.onGone(exit => done(reject, new Error(`opencode serve exited (${exit.code ?? exit.signal ?? exit.error}): ${this.tail()}`.slice(0, 500))));
      this.client.spawn({ id: this.id, command, args, cwd, env, policy: 'none', label: this.labelObject(), keepMs: KEEP_MS });
    });
  }

  /** 来た行はすぐ捨ててよい（同じ tick の分をまとめて ack する） */
  #ack(seq) {
    if (!(seq > this.pendingAck)) return;
    this.pendingAck = seq;
    this.ackTimer ??= setImmediate(() => { this.ackTimer = null; if (this.writable) this.client.ack(this.id, this.pendingAck); });
  }

  /** 待ち受けの値（起こした・つなぎ直した後に opencode-server.mjs が置く） */
  setServer(server) { this.server = server; this.touchLabel(); }
  putCard(sessionId, card) { this.cards.set(sessionId, card); this.touchLabel(); }
  endTurn(sessionId) { if (this.cards.delete(sessionId)) this.touchLabel(); }

  labelObject() { return { k: OPENCODE_LABEL_KIND, v: 1, server: this.server, turns: Object.fromEntries(this.cards) }; }

  touchLabel() {
    if (this.detached || this.labelTimer) return;
    this.labelTimer = setTimeout(() => { this.labelTimer = null; this.#sendLabel(); }, 0);
    this.labelTimer.unref?.();
  }

  #sendLabel() {
    if (!this.writable) return;
    const label = this.labelObject();
    // 上限を超えるなら札を載せない（付け直しはできず、新しいサーバーは今の流れの「中断」で残す）
    if (Buffer.byteLength(JSON.stringify(label), 'utf8') > LABEL_MAX_BYTES - 1024) label.turns = {};
    this.client.label(this.id, label);
  }

  /** 旧サーバーの引き継ぎ: 同じ tick に来た全部のターンの札を置き、1 回だけ detach する */
  handOff() {
    this.handing ??= (async () => {
      await new Promise(resolve => setImmediate(resolve));
      clearTimeout(this.labelTimer);
      this.labelTimer = null;
      this.#sendLabel();
      await this.client.detach(this.id);
      this.detached = true;
      if (current.get(this.id) === this) current.delete(this.id);
      this.dispose();
    })();
    return this.handing;
  }

  kill() { if (this.writable) this.client.kill(this.id, { tree: true }); }

  /** 止めて終わるのを待つ。手を離していれば何もしない（新しいサーバーが引き継ぐ） */
  async stop({ waitMs = 3000 } = {}) {
    if (this.detached || this.closed) { this.dispose(); return; }
    // 止め始めたら、もう使わせない（止めている最中の子を acquire が返さない）
    if (current.get(this.id) === this) current.delete(this.id);
    if (pendingAdopt.get(this.id) === this) pendingAdopt.delete(this.id);
    this.kill();
    await Promise.race([this.exited, sleep(waitMs)]);
    if (current.get(this.id) === this) current.delete(this.id);
    this.dispose();
  }

  dispose() {
    clearTimeout(this.labelTimer);
    clearImmediate(this.ackTimer);
    this.labelTimer = null;
    this.ackTimer = null;
    this.client.off('out', this.onOut);
    this.client.off('err', this.onErr);
    this.client.off('exit', this.onExit);
  }
}

/** このプロセスが使っている子（無ければ null） */
export const heldOpencode = (account = null) => { const held = current.get(opencodeChildId(account)); return held && !held.closed && !held.detached ? held : null; };

export function accountHeldOpencode(account) {
  const id = opencodeChildId(account), held = current.get(id) ?? pendingAdopt.get(id);
  return held && !held.closed && !held.detached ? held : null;
}

/**
 * opencode-server.mjs の起動の口。保持役に載せないときは null（今の流れ）。
 * 起動で引き継いだ子があればそれ（server を持つ。起こさない）、無ければ保持役の子として起こす口（spawn 前の HeldOpencode）を返す。
 * 前の起動の子が札なしで残っていれば止めてから起こす（中継の合言葉と待ち受けが分からないので、つなぎ直せない）
 */
export async function acquireHeldOpencode({ argv, account = null }) {
  if (!opencodeHeldEnabled()) return null;
  const id = opencodeChildId(account);
  if (heldOpencode(account)) return heldOpencode(account);
  if (pendingAdopt.has(id)) { const held = pendingAdopt.get(id); pendingAdopt.delete(id); if (!held.closed) { current.set(id, held); return held; } }
  const dataDir = dataDirOf();
  const root = bootEnv('AGENT_HOST_RUNTIME_ROOT');
  // npm の .cmd の包みは、保持役が shell 無しで起こせない
  if (!dataDir || !root || !argv?.length || /\.(cmd|bat)$/i.test(argv[0])) return null;
  const client = await holderLink({ dataDir, root, key: bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '' });
  const known = (client.welcome?.children ?? []).find(child => child.id === id);
  if (known?.alive) {
    const stale = new HeldOpencode({ client, spawned: false, id });
    const state = await stale.open().catch(() => null);
    if (state?.alive) await stale.stop({ waitMs: 3000 });
    else stale.dispose();
  }
  if (known) client.release(id);   // 終わった子の記録は、同じ id で起こす前に捨てる
  const held = new HeldOpencode({ client, spawned: true, id });
  current.set(id, held);
  return held;
}

/** 札のターン 1 つ分の付け直す元（server の restoreTurn が読む形）。記録は使わない（adoptTurn が OpenCode に聞き直す） */
function turnSource({ held, sessionId, card }) {
  const id = `${held.id}#${sessionId}`;
  let released = false;
  return {
    id,
    state: { id, label: card, alive: true, acked: 0, seq: 0, first: 1, truncated: false, marks: { [ADOPT_TURN_MARK]: 1 } },
    attachable: true,
    acked: 0,
    held: true,
    opencode: held,
    sessionId,
    replay: async () => [],
    ack() {},
    release() {},
    dispose() {
      if (released) return;
      released = true;
      // 付け直さなかったターンの札は外す（次に置く札に残さない）。付け直したターンは、終わるときに adoptTurn が外す
      if (held.cards.get(sessionId) === card) held.endTurn(sessionId);
      onForget(sessionId);
    },
  };
}

/** 起動で保持役の子（札の種類が opencode-server）を引き継ぐ（core/adopt.mjs の readHolderSources が呼ぶ） */
export async function expandHeldOpencode({ client, child, log }) {
  if (!opencodeHeldEnabled() || !child.alive || child.label?.v !== 1 || !child.label.server?.base || !child.label.server?.auth) return [];
  if (child.id !== opencodeChildId(child.label.server.account)) return [];
  const held = new HeldOpencode({ client, spawned: false, server: child.label.server, id: child.id });
  const state = await held.open().catch(error => { log?.(`  OpenCode のサーバーを引き継げない: ${error?.message ?? error}`); return null; });   // i18n-ignore: サーバーのログ
  if (!state?.alive) { held.dispose(); return []; }
  const turns = child.label.turns && typeof child.label.turns === 'object' ? child.label.turns : {};
  for (const [sessionId, card] of Object.entries(turns)) held.cards.set(sessionId, card);
  pendingAdopt.get(child.id)?.dispose();
  pendingAdopt.set(child.id, held);
  onAdopt(held.server, turns);
  log?.(`  OpenCode のサーバーを引き継いだ（保持役の子 ${child.id}・付け直すターン ${Object.keys(turns).length}）`);   // i18n-ignore: サーバーのログ
  return Object.entries(turns).map(([sessionId, card]) => turnSource({ held, sessionId, card }));
}

registerChildExpander(OPENCODE_LABEL_KIND, expandHeldOpencode);

/** このサーバーが終わるときに、手を離していない子を止めて、終わるのを待つ（server の exitAfterStoppingHeld） */
export async function stopHeldOpencode() {
  for (const held of new Set([...pendingAdopt.values(), ...current.values()]))
    if (!held.detached && !held.closed) await held.stop({ waitMs: 2000 });
}

// 上の流れを通らない終わり方の保険（同期で送れる kill の frame だけ。取りこぼしても keepMs が止める）
process.once('exit', () => {
  for (const held of new Set([...pendingAdopt.values(), ...current.values()]))
    if (!held.detached && !held.closed) held.kill();
});

// ---- 会話のシェルの環境変数（秘密情報を含む）。札には名前だけを置く

/** 書く。vars が空なら書かずに null。返りの name を札に置き、dispose() で消す */
export async function writeOpencodeEnvFile(dataDir, vars) {
  if (!vars || !Object.keys(vars).length) return null;
  const dir = path.join(dataDir, 'run');
  await fs.mkdir(dir, { recursive: true });
  const name = `opencode-env-${crypto.randomUUID()}.json`;
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(vars), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.chmod(file, 0o600).catch(() => {});
  return envFileHandle(file, name);
}

/** 付け直したターンのファイル（旧サーバーが書き、札が名前を持つ）。名前の形が違えば null（run\ の外は指さない）。vars は中身（読めなければ {}） */
export async function adoptOpencodeEnvFile(dataDir, name) {
  if (typeof name !== 'string' || !ENV_FILE.test(name)) return null;
  const file = path.join(dataDir, 'run', name);
  let vars = {};
  try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); if (parsed && typeof parsed === 'object') vars = parsed; } catch { /* 消えていれば空 */ }
  return { ...envFileHandle(file, name), vars };
}

function envFileHandle(file, name) {
  let gone = false;
  return { file, name, dispose: async () => { if (gone) return; gone = true; await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 前の起動で消し損ねたファイルを片付ける（起動時）。except は付け直すターンの札が指すファイルの名前 */
export async function sweepOpencodeEnvFiles(dataDir, { olderThanMs = 0, except = [] } = {}) {
  const dir = path.join(dataDir, 'run');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!ENV_FILE.test(name) || except.includes(name)) continue;
    const f = path.join(dir, name);
    const st = await fs.stat(f).catch(() => null);
    if (!st || (olderThanMs > 0 && Date.now() - st.mtimeMs < olderThanMs)) continue;
    await fs.rm(f, { force: true }).catch(() => {}); n++;
  }
  return n;
}
