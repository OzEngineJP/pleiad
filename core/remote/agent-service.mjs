// 端末の main の側の橋（docs/remote.md §4.5、ADR 0146）。ローカルのサーバー（utilityProcess）から parentPort で届く
// { type: 'remote-agent', id, action, … } を、ホストへの AI 用の線（agent-link.mjs。device.mjs が持つ）へ渡し、
// ホストの便りと線の状態を { type: 'remote-agent-event' | 'remote-agent-state' | 'remote-agent-hosts' } でサーバーへ返す。
// デスクトップ版の main（desktop/remote-agent-bridge.cjs）とテスト（tests/lib/remote-agent-parent-port.mjs）が同じものを使う。
//
// 守り: 承認の答え（answer）・経過の読み出し（view）を線へ運ぶのは、サーバーが画面（human）の処理の中で出したときだけ（サーバー側の取り決め。
// remote.md §4.5）。この橋は「どの経路から来たか」を見分けられないので、サーバーが human の経路の外から作らないことに頼る。
// AI が呼べる道具（MCP・CLI・ply_task_*）には、answer・view を作る道が無い。
import { AgentError } from './agent-link.mjs';

const displayName = rec => String(rec?.label || rec?.hostName || String(rec?.hostId ?? '').slice(0, 8));

/**
 * @param getDevice  () => Promise<createRemoteDevice の戻り値>
 * @param post       (message) => void。サーバーへ送る
 */
export function createRemoteAgentService({ getDevice, post, log = () => {} }) {
  const aborts = new Map();   // 依頼の id → AbortController
  let hooked = null;

  async function device() {
    const d = await getDevice();
    if (hooked !== d) {
      hooked = d;
      d.on('agent-state', async s => {
        post({ type: 'remote-agent-state', hostId: s.hostId, state: s.state, allowed: s.allowed === true, view: s.view === true, features: s.features ?? null, hostName: s.hostName ?? '' });
        await withHosts(hosts => post({ type: 'remote-agent-hosts', hosts })).catch(() => {});
      });
    }
    return d;
  }

  /** サーバーが知る「ホストの一覧」。線を張っているホスト（取り消されていないもの）が状態を持つ */
  async function withHosts(send) {
    const d = await device();
    // 同じホストに own と plus の記録があっても 1 行にする（線は 1 本。張った方の記録が状態を持つ。device.mjs の pickHostRecord）
    const byId = new Map();
    for (const h of await d.list()) if (!byId.has(h.hostId) || (h.agent && !byId.get(h.hostId).agent)) byId.set(h.hostId, h);
    // 一覧の読み込み中にも状態は変わる。送る直前の状態を読み、別の便りが割り込む前に送る。
    return send([...byId.values()].map(h => {
      const status = d.agent(h.hostId)?.status;
      return {
        hostId: h.hostId, name: displayName(h), hostName: h.hostName ?? '',
        state: status?.state ?? 'offline', allowed: status?.allowed === true, view: status?.view === true, features: status?.features ?? null,
      };
    }));
  }

  /** 線に聞き手を付ける（ホストの便りをサーバーへ）。同じ線に二重に付けない */
  const listened = new WeakSet();
  function listen(hostId, agent) {
    if (!agent || listened.has(agent)) return;
    listened.add(agent);
    agent.on('event', event => post({ type: 'remote-agent-event', hostId, event }));
    agent.on('ready', status => post({ type: 'remote-agent-ready', hostId, ...status }));
  }

  async function syncAgents(d) {
    await d.agentSync();
    for (const h of await d.store.hosts()) listen(h.hostId, d.agent(h.hostId));
  }

  async function refresh() {
    await syncAgents(await device());
    await withHosts(hosts => post({ type: 'remote-agent-hosts', hosts }));
  }

  /**
   * サーバーがつなぎ直した（付け直した・切り替えで新しい版のサーバーに替わった。desktop/remote-agent-bridge.cjs が ready で呼ぶ）。
   * サーバーは空か古い一覧から始まるので、一覧を送り直し、つながっている線は ready を送り直す（サーバーが動いているタスクと中継する承認を同期し直す）。
   * 線は main のもので、切り替えの間も張ったまま。ready の便りは線がつながったときしか出ないので、ここで補う
   */
  async function resync() {
    await syncAgents(await device());
    await withHosts(hosts => {
      post({ type: 'remote-agent-hosts', hosts });
      for (const h of hosts) {
        if (h.state === 'ready') post({ type: 'remote-agent-ready', hostId: h.hostId, state: h.state, allowed: h.allowed, view: h.view, features: h.features, hostName: h.hostName });
      }
    });
  }

  const fail = (id, e) => post({ type: 'remote-agent', id, ok: false, code: e instanceof AgentError || typeof e?.code === 'string' ? e.code : 'ERROR', error: String(e?.message ?? e) });

  async function handle(message) {
    const { id, action } = message;
    try {
      const d = await device();
      switch (action) {
        case 'hosts': {
          await syncAgents(d);
          return await withHosts(hosts => post({ type: 'remote-agent', id, ok: true, hosts }));
        }
        case 'request': {
          const agent = d.agent(message.hostId);
          if (!agent) throw new AgentError('OFFLINE', 'the host is not available');
          listen(message.hostId, agent);
          const ac = new AbortController();
          aborts.set(id, ac);
          try {
            const result = await agent.request(String(message.op), message.args ?? {}, message.requester ?? null, { signal: ac.signal, ...(Number.isFinite(message.timeoutMs) ? { timeoutMs: message.timeoutMs } : {}) });
            return post({ type: 'remote-agent', id, ok: true, result });
          } finally { aborts.delete(id); }
        }
        case 'lines': {
          // 読むだけ（張り直さない）。remote.status の agentLines（線の経路・状態・最後に変わった時刻・次の張り直し）
          return post({ type: 'remote-agent', id, ok: true, result: d.agentLines?.() ?? [] });
        }
        case 'abort': { aborts.get(message.target)?.abort(); return; }
        case 'answer': {
          const agent = d.agent(message.hostId);
          if (!agent) throw new AgentError('OFFLINE', 'the host is not available');
          const result = await agent.answer(message.relay ?? {});
          return post({ type: 'remote-agent', id, ok: true, result });
        }
        case 'view': {
          const agent = d.agent(message.hostId);
          if (!agent) throw new AgentError('OFFLINE', 'the host is not available');
          const result = await agent.view(String(message.taskId ?? ''), message.cursor ?? null);
          return post({ type: 'remote-agent', id, ok: true, result });
        }
        case 'sync': {
          const agent = d.agent(message.hostId);
          return post({ type: 'remote-agent', id, ok: true, result: agent ? agent.sync(Array.isArray(message.taskIds) ? message.taskIds : []) : false });
        }
        default: throw new AgentError('BAD_REQUEST', `unknown action: ${action}`);
      }
    } catch (e) {
      log(`remote agent: ${action}: ${e?.message ?? e}`);
      if (id !== undefined) fail(id, e);
    }
  }

  return {
    handle: message => { if (message?.type === 'remote-agent') return handle(message); },
    /** ホストが増減した・名前が変わった。線を張り直し、一覧をサーバーへ */
    refresh: () => refresh().catch(e => log(`remote agent: ${e?.message ?? e}`)),
    resync: () => resync().catch(e => log(`remote agent: ${e?.message ?? e}`)),
    close() { for (const ac of aborts.values()) ac.abort(); aborts.clear(); },
  };
}
