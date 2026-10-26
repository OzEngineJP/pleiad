// 外部の stdio MCP を保持役の子にする（ADR 0270 段 2c。docs/adr/0270-server-may-die-anytime.md）。
//
// 規則 ①: 長く生きる子（MCP のサーバーは会話のあいだ生き続ける）は保持役でしか起こさない。`core/process.mjs` の start() で起こし、
// policy は `jsonrpc`（答えていない依頼の控えを、付け直した親へ渡し直す）。子はサーバーが終わっても止めない（止めるのはアプリの終了と、
// 会話の後片付け＝warm の idle と worktree を消す前だけ）。
//
// 規則 ③: 起動の処理が復元の処理。MCP の子の札（label）に「鍵・サーバー id・名前・cwd」と、**initialize の結果**を置く。
// 新しいサーバーは起動で保持役の子の札を読み（readHeldMcpChildren）、次の利用（core/context-connections.mjs の acquire）で
// その子に付く。`initialize` は送り直さない: Client.connect() が出す initialize への答えを、札に残した結果で返す
// （MCP の子に 2 回目の initialize を受けさせない。確かめたことは ADR に書く）。
//
// 子の ID はサーバーごとに作る（`mcp-<鍵の頭>-<乱数>`）。付け直す側は ID ではなく札の key で見分ける。
import crypto from 'node:crypto';
import { start } from './process.mjs';
import { bootEnv } from './boot-env.mjs';
import { holderLink } from './holder/link.mjs';
import { holderSource } from './adopt.mjs';

/** 札の種類（core/adopt.mjs の registerChildExpander とは別。MCP の子はターンを運ばない） */
export const MCP_LABEL_KIND = 'mcp';
/** 親（サーバー）が居ない間に子を残す上限。ターンの子と同じ 10 分（core/backends/codex-held.mjs） */
export const MCP_KEEP_MS = 10 * 60_000;
/** 札に載せる initialize の結果の上限（超えるときは instructions を落とす。札の上限は 256 KB） */
const INIT_LABEL_MAX_BYTES = 64 * 1024;

/**
 * MCP の子は常に保持役に載せる。明示的な off は起動拒否として扱い、サーバーの子へ落とさない。
 */
export function heldMcpPlan({ value = bootEnv('AGENT_HOST_MCP_HOLDER'), root = bootEnv('AGENT_HOST_RUNTIME_ROOT') } = {}) {
  const flag = String(value ?? '').trim();
  if (flag === 'off') return false;
  return true;
}

const labelOf = ({ key, serverId, name, cwd }) => ({ k: MCP_LABEL_KIND, v: 1, key: String(key ?? ''), serverId: String(serverId ?? ''), name: String(name ?? ''), cwd: String(cwd ?? '') });

/**
 * 保持役に MCP の子を起こす。戻り値 { id, client, source, label }。保持役を使えない・起こせないときは失敗させる。
 */
export async function startHeldMcp({ command, args = [], cwd, env, key, serverId, name, dataDir, root = bootEnv('AGENT_HOST_RUNTIME_ROOT'), appVersion = '', log = () => {} } = {}) {
  if (!dataDir || !command || !heldMcpPlan({ root })) return null;
  const label = labelOf({ key, serverId, name, cwd });
  const id = `mcp-${String(key ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 8)}-${crypto.randomBytes(5).toString('hex')}`;
  try {
    const started = await start({ id, command, args, cwd, env, policy: 'jsonrpc', label, keepMs: MCP_KEEP_MS, dataDir, root, appVersion, log });
    return started ? { ...started, label } : null;
  } catch (error) { throw Object.assign(error, { code: error?.code ?? 'MCP_HOLDER_START_FAILED' }); }
}

/**
 * 起動で、保持役に残っている MCP の子（札の種類が mcp）を読む。居る保持役にだけつなぐ（起こさない）。
 * 戻り値 { client, children }。保持役が居なければ { client: null, children: [] }
 */
export async function readHeldMcpChildren({ dataDir, root = bootEnv('AGENT_HOST_RUNTIME_ROOT'), appVersion = '', log = () => {} } = {}) {
  if (!dataDir || !heldMcpPlan({ root })) return { client: null, children: [] };
  let client;
  try { client = await holderLink({ dataDir, root, appVersion, launch: false, log }); }
  catch (error) { if (error?.code === 'HOLDER_NONE') return { client: null, children: [] }; throw error; }
  const children = (client.welcome?.children ?? []).filter(child => child?.label?.k === MCP_LABEL_KIND && typeof child.label.key === 'string' && child.label.key);
  return { client, children };
}

/** 札の initialize の結果（無ければ null） */
export const initOfLabel = label => (label?.init && typeof label.init === 'object' && typeof label.init.protocolVersion === 'string' ? label.init : null);

const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/**
 * 保持役の子 1 つを、MCP SDK の Transport に見せる（core/context-bridge.mjs の Client.connect が使う）。
 *
 * - start()  子の記録を読む列を始める。付け直した子は attach（state.acked + 1 から）してから始める
 * - send()   子の stdin へ 1 行書く。**initialize は付け直した子には送らない**（札に残した結果を返す）。
 *            requests の id は、前のサーバーが飛ばしたままの依頼とぶつからないよう、この口だけの文字列に付け替える
 * - close()  子を木ごと止めて記録を捨てる（keepHeld のときは手を離すだけ。サーバーの終わり）
 *
 * 前のサーバーの依頼への返事（この口が知らない id）は捨てる（別の依頼の返事として渡さない）。
 */
export class HeldMcpTransport {
  constructor({ id, source, adopted = false, init = null, label = null, log = () => {} } = {}) {
    this.id = id;
    this.source = source;
    this.adopted = adopted;
    this.init = init ?? null;
    this.label = label ?? null;
    this.log = log;
    this.prefix = `h${crypto.randomBytes(4).toString('hex')}:`;
    this.next = 0;
    this.outgoing = new Map();      // 付け替えた id -> { id, method }
    this.from = 1;
    this.closed = false;
    this.exited = null;
    this.keepHeld = false;
    this.pumping = null;
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
  }

  async start() {
    const from = this.adopted ? Math.max(1, (Number(this.source.state?.acked) || 0) + 1) : 1;
    this.from = from;
    // 付け直した子は、書く前に attach を済ませる（attach の前の write は保持役が捨てる）
    if (this.adopted) await this.source.open(from);
    this.pumping = this.#pump(from);
  }

  #receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.method !== undefined) { this.onmessage?.(message); return; }   // 子からの依頼・通知
    if (message.id === undefined) { this.onmessage?.(message); return; }
    const entry = this.outgoing.get(String(message.id));
    // 前のサーバーが飛ばしたままの依頼への返事（この口が知らない id）は捨てる
    if (!entry) return;
    this.outgoing.delete(String(message.id));
    if (entry.method === 'initialize' && message.result && !this.adopted) this.#recordInit(message.result);
    this.onmessage?.({ ...message, id: entry.id });
  }

  /** initialize の結果を札に残す（付け直した側が initialize を送り直さずに済むように） */
  #recordInit(result) {
    const init = {
      protocolVersion: result.protocolVersion, capabilities: result.capabilities, serverInfo: result.serverInfo,
      ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
    };
    const label = { ...(this.label ?? {}), init };
    if (Buffer.byteLength(JSON.stringify(label)) > INIT_LABEL_MAX_BYTES) delete label.init.instructions;
    this.init = label.init;
    this.label = label;
    try { this.source.client?.label(this.id, label); } catch (error) { this.log(`  external MCP: could not put the initialize result on the label (${error?.message ?? error})`); }
  }

  async #pump(from) {
    try {
      for await (const item of this.source.attach(from)) {
        if (item.exit) { this.exited = item.exit; break; }
        if (item.seq >= this.from) this.from = item.seq + 1;
        const message = parse(item.line);
        if (message) this.#receive(message);
        this.source.ack(item.seq);
      }
    } catch (error) {
      if (!this.closed) this.log(`  external MCP: the record of ${this.id} stopped (${error?.message ?? error})`);
      this.error = error;
    } finally {
      this.onclose?.();
    }
  }

  async send(message) {
    if (!message || typeof message !== 'object') return;
    if (message.method === 'initialize' && this.adopted && this.init) {
      // 2 回目の initialize は送らない。札に残した結果を、この Client の依頼への返事として返す
      const result = this.init;
      queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
      return;
    }
    if (message.method === 'notifications/initialized' && this.adopted) return;   // 前のサーバーが送り済み
    this.source.write(`${JSON.stringify(this.#outgoing(message))}\n`);
  }

  /** この口から出る依頼の id を付け替える（前のサーバーの依頼とぶつからないように） */
  #outgoing(message) {
    if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
      const id = `${this.prefix}${++this.next}`;
      this.outgoing.set(id, { id: message.id, method: message.method });
      return { ...message, id };
    }
    if (message.method === 'notifications/cancelled' && message.params?.requestId !== undefined) {
      for (const [mapped, entry] of this.outgoing) if (entry.id === message.params.requestId) return { ...message, params: { ...message.params, requestId: mapped } };
    }
    return message;
  }

  /** サーバーの終わり（手を離すだけ）にする。connections の dispose が close の前に呼ぶ */
  setKeepHeld(flag) { this.keepHeld = Boolean(flag); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepHeld) { this.source.stop(); this.source.dispose(); return; }
    if (!this.exited) {
      // 止まったのを待ってから記録を捨てる（release は生きた子を断る）。読みの列が動いていなくても届くよう、口の exit を見る
      const client = this.source.client;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); client?.off('exit', onExit); resolve(); };
        const onExit = frame => { if (frame?.id === this.id) finish(); };
        const timer = setTimeout(finish, 3000);
        timer.unref?.();
        client?.on('exit', onExit);
        try { client?.kill(this.id, { tree: true }); } catch { finish(); }
      });
    }
    this.source.stop();
    this.source.dispose();
    try { this.source.release(); } catch { /* 記録が無い・生きている（保持役が断る） */ }
  }
}
