// 「途中でサーバーを止めて起こし直す」モード（issue #143 段 1。docs/adr/0270-server-may-die-anytime.md）。
//
// 既存の試験の土台（tests/lib/server.mjs の startServer・tests/lib/ws-client.mjs の open）に被せる。試験は
// 1 つのサーバー・1 つの接続を使っているつもりのまま、途中でサーバーを**普通に**止め（SIGTERM → 5 秒で SIGKILL）、
// 同じデータ置き場・同じトークン・同じポートで**普通に**起こした先へ、接続とイベントを続ける。保持役（core/holder/）は生かしたまま。
//
// 復元の有効・無効を示す環境変数は渡さない。通常の起動が常に保持役の子を復元する。
//
//   installRestartMode({ trigger })  このプロセスに仕掛けを入れる（1 つだけ）。戻り値は { restart(), restarts, clients }
//   installRestartFromEnv(env)       環境変数 PLEIAD_TEST_RESTART があれば入れる（tests/run.mjs と run-worker.mjs が読む）
//   restartMode()                    入っていれば仕掛け、無ければ null
//   PLEIAD_TEST_RESTART は 1 本の suite に使う（例: PLEIAD_TEST_RESTART=turnEnd node tests/run.mjs server-shell --jobs 1）。
//   tests/unit/restart-mode.mjs は自分の仕掛け（manual）を入れるため、環境変数の仕掛けを外す
//   trigger:
//     'manual'（既定）  試験が restart() を呼んだときだけ
//     'work'            最初の tool.start か permission が届いたとき（何かが走っている最中）
//     'turnEnd'         最初の turnEnd が届いたとき（ターンの境目）
//     'shell'           最初の shell.start / shell.output が届いたとき
//     'ms:<n>'          入れてから n ms 後
//
// 仕掛けが届く範囲（段 1 で確かめたこと）:
//   - 接続（open）は、渡された port/token が登録したサーバーのものなら、そのサーバーに付く。起こし直すと新しい port/token へつなぎ直し、
//     イベント・mark/since/waitFor・runTurn は続きに積む。cmd は、飛んでいるものが終わるのを 2 秒まで待ってから止め、
//     起こし直しの最中に投げられたものは新しいサーバーへ回す（それでも長い cmd は落ちる）
//   - startServer を 2 回呼んで 2 台を並べる試験は、それぞれのサーバーに付く。restart() は最後に登録した 1 台を対象にする
//   - サーバーの child・port・token・tail() を直に見る試験は、起こし直した後の値をハンドル越しに読み直すこと（同じハンドルは古い値のまま）
const KEY = Symbol.for('pleiad.test.restart');
const log = line => console.log(`  [restart] ${line}`);

export const restartMode = () => globalThis[KEY] ?? null;

export function installRestartMode({ trigger = 'manual', stop = 'stop', logger = log } = {}) {
  if (globalThis[KEY]) return globalThis[KEY];
  const controller = new RestartController({ trigger, stop, logger });
  globalThis[KEY] = controller;
  return controller;
}

/** 環境変数 PLEIAD_TEST_RESTART（tests/run.mjs・tests/lib/run-worker.mjs が読む）。無ければ null */
export function installRestartFromEnv(env = process.env) {
  const trigger = String(env.PLEIAD_TEST_RESTART ?? '').trim();
  if (!trigger) return null;
  return installRestartMode({ trigger });
}

/** 試験の後片付け（このプロセスの仕掛けを外す。次の suite に持ち越さない） */
export function uninstallRestartMode() {
  const controller = globalThis[KEY];
  delete globalThis[KEY];
  controller?.dispose();
  return controller;
}

const triggerMatches = (trigger, event) => {
  if (trigger === 'work') return event?.type === 'tool.start' || event?.type === 'permission';
  if (trigger === 'turnEnd') return event?.type === 'turnEnd';
  if (trigger === 'shell') return event?.type === 'shell.start' || event?.type === 'shell.output';
  return false;
};

class RestartController {
  constructor({ trigger, stop, logger }) {
    this.trigger = trigger;
    this.stopMode = stop;
    this.log = logger;
    this.servers = [];        // { handle, options, start }
    this.clients = new Set(); // RestartClient（このサーバーに付いたもの）
    this.restarting = null;
    this.restartingEntry = null;
    this.restarts = 0;
    this.triggered = false;
    this.errors = [];
    this.disposed = false;
    this.timers = new Set();
    if (String(trigger).startsWith('ms:')) {
      const ms = Number(String(trigger).slice(3));
      if (Number.isFinite(ms) && ms >= 0) {
        const timer = setTimeout(() => { this.timers.delete(timer); void this.restart().catch(error => this.#fail(error)); }, ms);
        this.timers.add(timer);
        timer.unref?.();
      }
    }
  }

  get current() { return this.servers.at(-1) ?? null; }

  /** tests/lib/server.mjs の startServer が、起こしたサーバーを登録する。start(options) は startServer をもう一度呼ぶ口 */
  registerServer(handle, options, start) {
    // 起こし直しの中で呼ばれた分は、同じ登録を新しいハンドルで置き換える（接続が付けている登録を変えない。
    // 別の登録にすると、その接続は「自分のサーバーではない」と見て付け直されない）
    if (this.restartingEntry) {
      this.restartingEntry.handle = handle;
      this.restartingEntry.options = options;
      return this.restartingEntry;
    }
    const entry = { handle, options, start };
    this.servers.push(entry);
    return entry;
  }

  /** tests/lib/ws-client.mjs の open。port/token が登録したサーバーのものでなければ、素の接続をそのまま返す */
  async open(options, rawOpen) {
    // 起こし直しの最中に開いた接続（試験が境目の直後に開く 2 本目など）は、終わってからつなぐ
    if (this.restarting) await this.restarting.catch(() => {});
    const entry = this.#find(options);
    if (!entry) return rawOpen(options);
    const client = new RestartClient(this, entry, options, rawOpen);
    this.clients.add(client);
    await client.connect(entry.handle);
    return client.api;
  }

  #find({ port, token }) {
    return this.servers.findLast(entry => entry.handle.port === port && entry.handle.token === token) ?? null;
  }

  /** 届いた出来事（RestartClient が呼ぶ）。trigger に合えば 1 回だけ起こし直す */
  noteEvent(event) {
    if (this.triggered || this.restarting) return;
    if (!triggerMatches(this.trigger, event)) return;
    this.triggered = true;
    // すぐ始める（restarting をこの tick のうちに立てる。境目の直後に試験が開く接続が、古いサーバーへ行かないように）
    void this.restart().catch(error => this.#fail(error));
  }

  /**
   * 今のサーバーを普通に止め、同じデータ置き場・同じトークン・同じポートで普通に起こし直し、接続を付け直す。
   * 保持役とその子には触れない。戻り値は新しいサーバーのハンドル
   */
  restart() {
    if (this.restarting) return this.restarting;
    const entry = this.current;
    if (!entry) return Promise.reject(new Error('restart: no server was started'));
    this.restarting = (async () => {
      const { handle, options, start } = entry;
      if (handle.port == null) throw new Error('restart: the server was started lazily (lazy: true); start it with ready() first');
      // 飛んでいる cmd（短い処理）が終わるのを少し待つ。ターンの終わりのような境目で止めても、
      // 試験がその直後に投げた cmd が「接続が閉じた」で落ちないように（長い待ちは waitFor なので、ここには数えない）
      const idle = await this.#waitCommandsIdle(2000);
      if (!idle) this.log('stopping with commands still in flight');
      this.log(`stopping the server (pid ${handle.child?.pid ?? '?'}, port ${handle.port})`);
      await this.#stop(handle);
      const env = {
        ...options.env,
        AGENT_HOST_TOKEN: handle.token,
        AGENT_HOST_PORT: String(handle.port),
      };
      this.restartingEntry = entry;
      let next;
      try { next = await start({ ...options, env, lazy: false }); }
      finally { this.restartingEntry = null; }
      entry.handle = next;
      entry.options = { ...options, env };
      this.restarts++;
      this.log(`started the server again (pid ${next.child?.pid ?? '?'}, port ${next.port})`);
      for (const client of [...this.clients]) {
        if (client.entry !== entry) continue;
        await client.connect(next).catch(error => this.#fail(error));
      }
      return next;
    })().finally(() => { this.restarting = null; });
    return this.restarting;
  }

  async #stop(handle) {
    if (this.stopMode === 'kill') return handle.kill();
    return handle.stop();
  }

  /** 付けている接続の cmd が 0 になるまで待つ（上限つき）。戻り値は 0 になったか */
  async #waitCommandsIdle(ms) {
    const end = Date.now() + ms;
    for (;;) {
      const busy = [...this.clients].reduce((sum, client) => sum + client.inflight, 0);
      if (!busy) return true;
      if (Date.now() >= end) return false;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  #fail(error) {
    this.errors.push(String(error?.stack ?? error));
    this.log(`failed: ${String(error?.message ?? error)}`);
  }

  removeClient(client) { this.clients.delete(client); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const client of this.clients) client.dispose();
    this.clients.clear();
  }
}

/**
 * open の代わり。1 つの接続に見えるが、中ではサーバーの入れ替えのたびに新しい接続を作り、イベントを続きに積む。
 * 試験が使う口（cmd・events・mark・since・waitFor・runTurn・turnResult・close・terminate・ws・ready）は ws-client の open と同じ
 */
class RestartClient {
  constructor(controller, entry, options, rawOpen) {
    this.controller = controller;
    this.entry = entry;
    this.options = options;
    this.rawOpen = rawOpen;
    this.events = [];
    this.watchers = new Set();
    this.inner = null;
    this.connecting = null;
    this.closed = false;
    this.disposed = false;
    this.inflight = 0;      // 飛んでいる cmd（起こし直す前に 0 になるのを少し待つ）
    const self = this;
    this.api = {
      get ws() { return self.inner?.ws; },
      get ready() { return self.inner?.ready ?? Promise.resolve(); },
      cmd: (command, args, opts) => self.#withInner(inner => inner.cmd(command, args, opts)),
      events: this.events,
      mark: () => self.events.length,
      since: from => self.events.slice(from),
      waitFor: (pred, opts) => self.waitFor(pred, opts),
      runTurn: (args, opts) => self.runTurn(args, opts),
      turnResult: (from, opts) => self.turnResult(from, opts),
      close: () => self.close(),
      terminate: () => self.terminate(),
    };
  }

  async connect(handle) {
    if (this.closed) throw new Error('restart: the client was closed');
    this.connecting = (async () => {
      const options = {
        ...this.options,
        port: handle.port,
        token: handle.token,
        onEvent: (event) => this.#onEvent(event),
      };
      const inner = await this.rawOpen(options);
      this.inner = inner;
      return inner;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  #onEvent(event) {
    this.events.push(event);
    // 試験の onEvent（承認の自動許可など）には、この接続を渡す。起こし直しても同じ見え方にする
    const own = this.options.onEvent;
    if (own) {
      try { Promise.resolve(own(event, this.api)).catch(error => console.log(`      onEvent で例外: ${error?.stack ?? error}`)); }
      catch (error) { console.log(`      onEvent で例外: ${error?.stack ?? error}`); }
    }
    for (const watcher of [...this.watchers]) {
      if (!watcher.pred(event)) continue;
      this.watchers.delete(watcher);
      clearTimeout(watcher.timer);
      watcher.res(event);
    }
    this.controller.noteEvent(event);
  }

  async #withInner(work) {
    if (this.closed) throw new Error('restart: the client was closed');
    // 起こし直しの最中に投げた cmd は、新しいサーバーにつないでから送る（止まりかけの古い接続へ送って「接続が閉じた」にしない）
    const controller = this.controller;
    if (controller.restarting && this.entry === controller.current) await controller.restarting.catch(() => {});
    if (this.connecting) await this.connecting;
    if (!this.inner) throw new Error('restart: the client is not connected');
    this.inflight++;
    try { return await work(this.inner); }
    finally { this.inflight--; }
  }

  /** ws-client の waitFor と同じ。ただしイベントはこの接続のもの（サーバーの入れ替えをまたいで積んだ分） */
  waitFor(pred, { ms = 300000, from = 0 } = {}) {
    const hit = this.events.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const watcher = { pred, res, rej, timer: null };
      this.watchers.add(watcher);
      watcher.timer = setTimeout(() => {
        if (this.watchers.delete(watcher)) rej(new Error(`waitFor が ${ms}ms で timeout`));
      }, ms);
      watcher.timer.unref?.();
    });
  }

  /** ws-client の runTurn と同じ（events はこの接続のもの） */
  async runTurn(args, { ms = 300000 } = {}) {
    const from = this.events.length;
    let acceptedFrom = null;
    const known = new Set(this.events.map(event => event.sessionId).filter(Boolean));
    let own = args?.sessionId ?? null;
    const mine = event => {
      if (acceptedFrom === null) return false;
      if (!own && event.type === 'session' && event.sessionId && !known.has(event.sessionId)) own = event.sessionId;
      return event.type === 'turnEnd' && (event.sessionId ?? null) === own;
    };
    await this.api.cmd('runTurn', args, { onReply: () => { acceptedFrom = this.events.length; } });
    await this.waitFor(mine, { ms, from: acceptedFrom });
    return { ...this.turnResult(acceptedFrom, { sessionId: own }), events: this.events.slice(from) };
  }

  /** ws-client の turnResult と同じ */
  turnResult(from, { sessionId } = {}) {
    const slice = this.events.slice(from);
    const scoped = sessionId === undefined ? slice : slice.filter(event => event.sessionId === sessionId);
    return {
      events: slice,
      tools: slice.filter(event => event.type === 'tool.start').map(event => event.name),
      sessionId: sessionId !== undefined ? sessionId : slice.find(event => event.type === 'session')?.sessionId ?? null,
      permissions: slice.filter(event => event.type === 'permission'),
      initModel: scoped.find(event => event.type === 'session' && event.model)?.model ?? null,
      outcome: scoped.find(event => event.type === 'turnResult')?.outcome ?? null,
    };
  }

  close() {
    this.closed = true;
    for (const watcher of this.watchers) { clearTimeout(watcher.timer); watcher.res(undefined); }
    this.watchers.clear();
    this.controller.removeClient(this);
    try { this.inner?.close(); } catch { /* 既に閉じている */ }
  }

  terminate() {
    this.closed = true;
    for (const watcher of this.watchers) { clearTimeout(watcher.timer); watcher.res(undefined); }
    this.watchers.clear();
    this.controller.removeClient(this);
    try { this.inner?.terminate(); } catch { /* 既に切れている */ }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const watcher of this.watchers) {
      clearTimeout(watcher.timer);
      watcher.res(undefined);
    }
    this.watchers.clear();
    this.close();
  }
}
