// Codex の共有の app-server を保持役（core/holder/）の子に載せる（無停止の更新 段階 3。docs/zero-downtime-update/stage3-codex.md・plan.md「段階 3」）。
// Claude の CLI（claude-held.mjs）は 1 ターン 1 プロセスだが、`codex app-server` は全会話で共有する 1 本で、走っているターンも読み込み済みのスレッドも裏の端末も持つ。
// サーバーを入れ替えても app-server は走り続け、新しいサーバーが子を引き継ぐ（stdio の JSON-RPC。付け直しに initialize は要らない。stage0-codex-agy.md §1）。
//   載せるか（codexHeldEnabled・acquireHeldAppServer）: AGENT_HOST_CODEX_HOLDER が off でない・実行場所の置き場（AGENT_HOST_RUNTIME_ROOT）がある
//     （on と書けば置き場があるだけで足りる。何も書かなければ置き場があるとき）・codex が直に起こせる（.cmd の包みは載せない）・保持役につなげる。外れたら今の流れ
//   子は 1 つ（id codex-app-server）。ターンごとに「印」（mark `turn:<threadId>`。turn/start の直前）と「札」（label の turns.<threadId>）を置く。
//     記録の 1 行は全部のスレッドの出力が混ざるので、再生は印からの記録をスレッドごとに（threadId と、その子孫のサブエージェント）選ぶ（codex-rpc.mjs の adoptThread）
//   札（label）: { k: 'codex-app-server', v: 1, turns: { <threadId>: <サーバーの札> }, loaded: { <threadId>: [接続先, 指示の指紋, hooks の指紋] }, watch: { <threadId>: <会話の id> } }。
//     loaded は、ロード済みのスレッドの設定の控え（codex.mjs の loadedProvider など。新しいサーバーが忘れると、ロード済みのスレッドの設定の変更が黙って効かなくなる）。
//     watch は、裏の端末を数えているスレッドと報告先（新しいサーバーは thread/backgroundTerminals/list で端末を引き直す）
//   付け直し（expand。起動で保持役の子の札を読む）: 子に付けて（attach）、札のターンごとの元（記録の再生・控えの鍵）を返す。続きの frame は、スレッドの付け直しが済むまで預かる
// 起動の掃除: 親が居ない間の保険に spawn の keepMs（holder.mjs）を渡す。子を止めるのはアプリの終了（server の stopHeldChildren）だけ
import crypto from 'node:crypto';
import { bootEnv } from '../boot-env.mjs';
import { holderLink } from '../holder/link.mjs';
import { LABEL_MAX_BYTES } from '../holder/protocol.mjs';
import { ADOPT_TURN_MARK, holderSource, registerChildExpander } from '../adopt.mjs';
import { cliCommand, directCommand } from '../cli-installation.mjs';
import { codexAccountChildId, prepareCodexAccount } from './codex-accounts.mjs';

export const CODEX_CHILD = 'codex-app-server';
export const CODEX_LABEL_KIND = 'codex-app-server';
/** ターン専用の app-server（Pleiad がコンテキストを持つ会話。1 ターン 1 本）の子の id の頭 */
export const CODEX_TURN_PREFIX = 'codex-turn-';
/** 親が居ない状態が続いたとき、保持役が app-server を止めるまで。引き継ぎ・落ちた後の起こし直しの数秒〜数十秒よりずっと長く、Pleiad を閉じた後に残り続けない長さ */
const KEEP_MS = 10 * 60_000;
/** 付け直すスレッドの引き取りを待つ上限（これを過ぎたら預かった frame を片付ける。付け直しが呼ばれなかった場合の保険） */
const ADOPT_WAIT_MS = 60_000;

const markName = threadId => `turn:${threadId}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 保持役に載せる切り替え。off で今の流れ。on は置き場があれば載せる。何も書かなければ、置き場（AGENT_HOST_RUNTIME_ROOT = パッケージ版・on の起動）があるとき */
export function codexHeldEnabled(env = process.env) {
  const value = String(bootEnv('AGENT_HOST_CODEX_HOLDER') ?? env.AGENT_HOST_CODEX_HOLDER ?? '').toLowerCase();
  if (value === 'off') return false;
  return Boolean(bootEnv('AGENT_HOST_RUNTIME_ROOT'));
}

/** ターン専用の app-server を保持役に載せる切り替え（AGENT_HOST_CODEX_TURN_HOLDER）。意味は codexHeldEnabled と同じ */
export function codexTurnHeldEnabled(env = process.env) {
  const value = String(bootEnv('AGENT_HOST_CODEX_TURN_HOLDER') ?? env.AGENT_HOST_CODEX_TURN_HOLDER ?? '').toLowerCase();
  if (value === 'off') return false;
  return Boolean(bootEnv('AGENT_HOST_RUNTIME_ROOT'));
}

let dataDirOf = () => null;
/** codex.mjs が起動で 1 回呼ぶ（データ置き場は store が持つ。codex-rpc.mjs から store を読むと循環するので、ここは受け取る） */
export function configureCodexHeld({ dataDir }) { dataDirOf = dataDir; }

/** アカウントごとに app-server の子（保持役の口）を持つ。付け直した子は同じアカウントの acquire が取る */
const current = new Map();
const pendingAdopt = new Map();
/** ターン専用の app-server（1 ターン 1 本。終わると止める。起動で拾ったものは終わりの後片付けで止める） */
const dedicatedServers = new Set();

/**
 * 保持役の子としての app-server。CodexRpc（codex-rpc.mjs）が run(sink) で読みを始め、write・ack・kill を呼ぶ。
 * 札・印・手を離す口は codex.mjs の runTurn が使う
 */
export class HeldAppServer {
  /** state: 保持役の子の状態の見込み（付け直しは welcome.children の 1 件）。from: 読み始める通番。skipUpTo: これより前の行は誰も要らない（引き継いだが印の無い子）。meta: 前のサーバーが札に置いた控え */
  /** dedicated: ターン専用の app-server（1 ターン 1 本。Pleiad がコンテキストを持つ会話）。config は起こしたときの -c（付け直す側は起こさないので使わない） */
  constructor({ client, state, spawned, from = 1, skipUpTo = 0, meta = null, expected = [], account = null, dedicated = false, config = null }) {
    this.client = client;
    this.account = account ?? meta?.account ?? null;
    this.dedicated = Boolean(dedicated ?? meta?.dedicated);
    this.config = config ?? meta?.config ?? null;
    this.id = state.id ?? codexAccountChildId(this.account);
    this.adopted = !spawned;
    this.expected = expected;
    this.from = from;
    this.skipUpTo = skipUpTo;
    this.cards = new Map();            // threadId -> 札（このサーバーが持つターン）
    this.meta = meta && typeof meta === 'object' ? meta : {};   // 付け直した子の、前のサーバーの控え（ロード済みのスレッドの設定・裏の端末を数えていたスレッド。codex.mjs が戻す）
    this.metaSnapshot = null;          // () => 今の控え（codex.mjs が渡す）
    this.source = holderSource(client, { ...state, id: this.id }, { spawned });
    this.sink = null;
    this.frozen = false;
    this.closed = false;
    this.pendingAck = 0;
    this.ackTimer = null;
    this.labelTimer = null;
    this.stderrTail = typeof state.stderr === 'string' ? state.stderr : '';
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
  }

  get writable() { return !this.closed && this.client.connected; }
  write(text) { return this.writable ? this.source.write(text) : false; }

  /** 付け直す子は、attach の答え（控えの鍵 pendingRequests）まで先に済ませる */
  async open() {
    this.attachedState = await this.source.open(this.from);
    return this.attachedState;
  }

  /** CodexRpc が読みを始める。sink: { line(text, seq), err(chunk), exit({ code, signal, error }), lost(reason), overflow({ reason, bytes }) } */
  run(sink) {
    this.sink = sink;
    const onErr = frame => { if (frame.id === this.id) sink.err(String(frame.chunk ?? '')); };
    // 保持役が長すぎる行（1 行の上限を超えた応答）を捨てた。待っている依頼を待たせ続けないよう CodexRpc に伝える
    const onOverflow = frame => { if (frame.id === this.id && frame.reason === 'line') sink.overflow?.(frame); };
    this.client.on('err', onErr);
    this.client.on('overflow', onOverflow);
    this.offErr = () => { this.client.off('err', onErr); this.client.off('overflow', onOverflow); };
    if (this.stderrTail) sink.err(this.stderrTail);
    if (this.skipUpTo > 0) this.ack(this.skipUpTo);
    void (async () => {
      try {
        for await (const item of this.source.attach(this.from)) {
          if (this.frozen) return;
          if (item.exit) {
            this.#exited(item.exit);
            return;
          }
          if (item.seq <= this.skipUpTo) continue;
          sink.line(item.line, item.seq);
        }
      } catch (error) {
        if (this.closed) return;
        this.#lost(error);
      }
    })();
  }

  #exited(exit) {
    if (this.closed) return;
    this.closed = true;
    try { this.source.release(); } catch { /* つながりが切れていれば、記録は保持役が終わるときに消える */ }
    if (current.get(this.id) === this) current.delete(this.id);
    dedicatedServers.delete(this);
    this.resolveExited();
    this.sink?.exit({ code: exit.code ?? null, signal: exit.signal ?? null, error: exit.error ?? null });
  }

  #lost(error) {
    if (this.closed) return;
    this.closed = true;
    if (current.get(this.id) === this) current.delete(this.id);
    dedicatedServers.delete(this);
    this.resolveExited();
    this.sink?.lost(`holder: ${error?.message ?? error}`);
  }

  /** 処理し終えた最後の行まで ack する（行ごとには送らず、同じ tick のものを 1 つにまとめる） */
  ack(seq) {
    if (this.frozen || !(seq > this.pendingAck)) return;
    this.pendingAck = seq;
    if (!this.ackTimer) this.ackTimer = setImmediate(() => { this.ackTimer = null; this.#flushAck(); });
  }

  #flushAck() {
    clearImmediate(this.ackTimer);
    this.ackTimer = null;
    if (this.pendingAck > 0) this.source.ack(this.pendingAck);
  }

  kill() {
    if (!this.closed) this.client.kill(this.id, { tree: true });
  }

  /** 止める（rpc.stop） */
  async stop({ waitMs = 3000 } = {}) {
    if (this.closed) { this.dispose(); return; }
    this.kill();
    await Promise.race([this.exited, sleep(waitMs)]);
    this.dispose();
  }

  dispose() {
    this.offErr?.();
    this.offErr = null;
    clearTimeout(this.labelTimer);
    clearImmediate(this.ackTimer);
    this.labelTimer = null;
    this.ackTimer = null;
    this.source.dispose();
  }

  // ---- ターンの印と札

  /** ターンの始まり（turn/start の直前）。記録の再生の始点。同じ接続の順序は保たれるので、turn/start の書き込みより前に届く */
  markTurn(threadId) {
    if (this.writable) this.client.mark(this.id, markName(threadId));
  }

  /** ターンの札を置く（置き直す）。まとめて 1 回で子の札（label）に載せる */
  putCard(threadId, card) {
    this.cards.set(threadId, card);
    this.touchLabel();
  }

  /** ターンが終わった・手を離せなかった。札と印を外す（印を外すと、記録は ack の次まで捨てられる） */
  endTurn(threadId) {
    const had = this.cards.delete(threadId);
    if (this.writable) this.client.unmark(this.id, markName(threadId));
    if (had) this.touchLabel();
  }

  /** 札の控え（ロード済みのスレッドの設定・裏の端末を数えているスレッド）が変わった（codex.mjs） */
  touchLabel() {
    if (this.frozen || this.labelTimer) return;
    this.labelTimer = setTimeout(() => { this.labelTimer = null; this.#sendLabel(); }, 0);
    this.labelTimer.unref?.();
  }

  labelObject({ withMeta = true } = {}) {
    return { k: CODEX_LABEL_KIND, v: 1, ...(this.account ? { account: { id: this.account.id, dir: this.account.dir } } : {}), ...(this.dedicated ? { dedicated: true, config: this.config } : {}), turns: Object.fromEntries(this.cards), ...(withMeta ? this.metaSnapshot?.() ?? { loaded: this.meta.loaded ?? {}, watch: this.meta.watch ?? {} } : {}) };
  }

  #sendLabel() {
    if (!this.writable) return;
    let label = this.labelObject();
    // 保持役の札の上限を超えるときは、控えを外す（付け直した後の最初の送信で、ロード済みのスレッドを外してから読み直すので、設定は効く）
    if (Buffer.byteLength(JSON.stringify(label), 'utf8') > LABEL_MAX_BYTES - 1024) label = this.labelObject({ withMeta: false });
    this.client.label(this.id, label);
  }

}

/** このプロセスが見ている app-server（子）。無ければ null */
export const heldAppServer = (account = null) => {
  const held = current.get(codexAccountChildId(account));
  return held && !held.closed ? held : null;
};

/**
 * CodexRpc の acquire（共有の app-server だけ）。保持役の子の口を返す。載せないときは null（今の流れ）。
 * 付け直した子（expand が作ったもの）があればそれ、居る子があれば付け、無ければ起こす
 */
export async function acquireHeldAppServer(config = {}, { account = null, env = null, link = holderLink } = {}) {
  if (!codexHeldEnabled() || Object.keys(config).some(k => !account || k !== 'cli_auth_credentials_store')) return null;
  const id = codexAccountChildId(account);
  if (heldAppServer(account)) return current.get(id);
  if (pendingAdopt.has(id)) { const held = pendingAdopt.get(id); current.set(id, held); pendingAdopt.delete(id); return held; }
  const dataDir = dataDirOf();
  const root = bootEnv('AGENT_HOST_RUNTIME_ROOT');
  const argv = cliCommand('codex');
  // npm の .cmd の包みは、中の node のスクリプトに解いてから起こす（shell 無しでは起こせない）
  const target = argv ? directCommand(argv) : null;
  if (!dataDir || !root || !target) return null;
  const client = await link({ dataDir, root, key: bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '' });
  const known = (client.welcome?.children ?? []).find(child => child.id === id);
  if (known && codexAccountChildId(known.label?.account ?? null) !== id) throw new Error('Codex holder account does not match its child');
  if (known?.alive) {
    // 札を持たずに残っていた app-server（引き継ぎで誰のターンも運んでいなかった）。付けて、記録は次の行から読む（誰のターンも持たないので、再生は要らない）。
    // つないだ時の一覧は古いことがある（その後に終わっていた・保持役が作り直された）ので、付けた答えで確かめる
    const held = new HeldAppServer({ client, state: known, spawned: false, from: (known.seq ?? 0) + 1, meta: known.label, account });
    const state = await held.open().catch(error => (error?.reason === 'unknown' ? null : Promise.reject(error)));
    if (state?.alive) {
      // 付け直されなかったターンの印（前のサーバーが置いたまま）は外す（外さないと、記録が印より前を捨てられず溜まる）。札はこのサーバーのターンだけにする
      for (const name of Object.keys(known.marks ?? {})) if (name.startsWith('turn:')) client.unmark(id, name);
      held.touchLabel();
      current.set(id, held);
      return held;
    }
    held.dispose();
  }
  if (known) client.release(id);   // 終わった子の記録は、同じ id で起こす前に捨てる
  const held = new HeldAppServer({ client, state: { id, acked: 0, seq: 0, marks: {} }, spawned: true, account });
  // 出来事の購読（holderSource）は spawn より前に始まっている。起こした直後の札で、付け直しの元になる（札の無いターンは付け直せない）
  client.spawn({ id, command: target.command, args: [...target.args, 'app-server', ...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])], cwd: process.cwd(), env: env ?? { ...process.env }, policy: 'jsonrpc',
    label: held.labelObject(), keepMs: KEEP_MS });
  current.set(id, held);
  return held;
}

/**
 * ターン専用の app-server を保持役の子として起こす（Pleiad がコンテキストを持つ会話。1 ターン 1 本）。
 * 載せないときは null（今の流れ）。子の id は起こすたびに新しく、終わったら呼び出し側が rpc.stop() で止める。
 * 札は起こした時点ではターンを持たない（runTurn の bindHeld が putCard で入れる。印の無い子は付け直さない）
 */
export async function acquireHeldTurnAppServer(config = {}, { env = null, account = null, link = holderLink } = {}) {
  if (!codexTurnHeldEnabled()) return null;
  const dataDir = dataDirOf();
  const root = bootEnv('AGENT_HOST_RUNTIME_ROOT');
  const argv = cliCommand('codex');
  const target = argv ? directCommand(argv) : null;
  if (!dataDir || !root || !target) return null;
  const client = await link({ dataDir, root, key: bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '' });
  const id = `${CODEX_TURN_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
  const held = new HeldAppServer({ client, state: { id, acked: 0, seq: 0, marks: {} }, spawned: true, account, dedicated: true, config });
  client.spawn({ id, command: target.command, args: [...target.args, 'app-server', ...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])], cwd: process.cwd(), env: env ?? { ...process.env }, policy: 'jsonrpc',
    label: held.labelObject(), keepMs: KEEP_MS });
  dedicatedServers.add(held);
  return held;
}

/**
 * 付け直すターンの元（restoreTurn が読む形）。子の記録の再生・控えの鍵は、子を引き継いだ HeldAppServer を通す。
 * 1 つの子から札のターンの数だけ作る。dispose は、付け直しをあきらめた・済んだときに待ちを外す
 */
function turnSource({ held, child, threadId, card, rpc }) {
  const mark = child.marks?.[markName(threadId)];
  const id = `${held.id}#${threadId}`;
  const pendingKeys = new Set((held.attachedState?.pendingRequests ?? []).map(p => p.requestId));
  let released = false;
  const source = {
    id,
    state: { id, label: card, alive: true, acked: child.acked ?? 0, seq: child.seq ?? 0, first: child.first ?? 1, truncated: Boolean(child.truncated) && !(mark >= (child.first ?? 1)),
      marks: Number.isInteger(mark) ? { [ADOPT_TURN_MARK]: mark } : {} },
    attachable: true,
    acked: child.acked ?? 0,
    threadId,
    held,
    rpc,
    account: held.account,
    pendingKeys,
    /** 印から ack までの記録（全部のスレッドの行）。付け直す側が、このスレッドの分を選ぶ */
    replay: (from, to) => held.source.replay(from, to),
    ack() {},
    release() {},
    dispose() {
      if (released) return;
      released = true;
      rpc.unexpect(threadId);
    },
  };
  return source;
}

/**
 * 起動で保持役の子（札の種類が codex-app-server）を引き継ぐ（core/adopt.mjs の readHolderSources が呼ぶ）。子に付け、CodexRpc を子につないで（initialize は送らない）、
 * 札のターンごとの元を返す。付け直すスレッドの frame は、adoptThread が引き取るまで預かる
 */
export async function expandCodexHeld({ client, child, log }) {
  const dedicated = child.label?.dedicated === true;
  if (!child.alive || (dedicated ? !codexTurnHeldEnabled() : !codexHeldEnabled())) return [];
  const account = child.label?.account ?? null;
  if (!dedicated && child.id !== codexAccountChildId(account)) throw new Error('Codex holder account does not match its child');
  if (account) await prepareCodexAccount(account);
  const turns = child.label?.turns && typeof child.label.turns === 'object' ? child.label.turns : {};
  const threads = Object.keys(turns).filter(threadId => Number.isInteger(child.marks?.[markName(threadId)]));
  const acked = child.acked ?? 0;
  const held = new HeldAppServer({ client, state: child, spawned: false, from: acked + 1, meta: child.label, expected: threads, dedicated, config: child.label?.config ?? null });
  pendingAdopt.get(child.id)?.dispose();
  await held.open();
  pendingAdopt.set(child.id, held);
  if (dedicated) dedicatedServers.add(held);
  let rpc;
  try {
    rpc = dedicated ? await (await import('./codex.mjs')).codexRpcForHeld({ held })
      : account ? await (await import('./codex.mjs')).codexRpcForAccount(account) : (await import('./codex-rpc.mjs')).rpc;
    await rpc.start();
  } catch (error) {
    if (pendingAdopt.get(child.id) === held) pendingAdopt.delete(child.id);
    dedicatedServers.delete(held);
    held.dispose();
    log?.(`  Codex の app-server を引き継げない: ${error?.message ?? error}`); return [];   // i18n-ignore: サーバーのログ
  }
  log?.(`  Codex の app-server を引き継いだ（保持役の子 ${child.id}${dedicated ? '（ターン専用）' : ''}・付け直すターン ${threads.length}・ack ${acked}）`);   // i18n-ignore: サーバーのログ
  const timer = setTimeout(() => { for (const threadId of threads) rpc.unexpect(threadId); }, ADOPT_WAIT_MS);
  timer.unref?.();
  return threads.map(threadId => turnSource({ held, child, threadId, card: turns[threadId], rpc }));
}

registerChildExpander(CODEX_LABEL_KIND, expandCodexHeld);

/**
 * アプリの終了で、app-server を止めて、終わるのを待つ（server の stopHeldChildren）。ターン専用の app-server も止める。
 * 更新・落ちたときは呼ばない（保持役の子は残り、新しいサーバーが起動で拾う）
 */
export async function stopHeldAppServer() {
  for (const held of new Set([...pendingAdopt.values(), ...current.values(), ...dedicatedServers])) {
    if (!held.closed) await held.stop({ waitMs: 2000 });
  }
}
