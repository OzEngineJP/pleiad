// Codex の内部呼出し（Issue #180）: ephemeral の thread、道具と利用者 MCP を閉じる config、config/read の
// キャッシュ迂回と失敗時の非開始を、RPC の境界だけを差し替えて確かめる（子プロセス・CLI・LLM は使わない）。
import assert from 'node:assert/strict';
import { backend } from '../../core/backends/codex.mjs';
import { rpc } from '../../core/backends/codex-rpc.mjs';

export const name = 'codex-internal-call';
export const title = 'Codex の内部呼出し: ephemeral・道具/MCP の閉じ方・config/read の毎回読みと失敗時の非開始';

export default async function (t) {
  const originals = { request: rpc.request, attach: rpc.attach, claimOrphan: rpc.claimOrphan };
  const threads = new Map();
  let handlers = null;
  let sequence = 0;
  const starts = [];
  const turns = [];
  const configReads = [];
  let configFail = false;

  rpc.attach = (_id, h) => { handlers = h; return () => {}; };
  rpc.claimOrphan = (h) => { handlers = h; return () => {}; };
  rpc.request = async (method, params) => {
    if (method === 'config/read') {
      configReads.push(params);
      if (configFail) throw new Error('config read failed');
      return { config: { mcp_servers: { danger: { command: 'user-mcp' } } } };
    }
    if (method === 'model/list') return { data: [] };
    if (method === 'thread/start') {
      starts.push(params);
      const thread = { id: `thread-${++sequence}` };
      const state = { thread, approvalPolicy: params.approvalPolicy, sandbox: params.sandbox };
      threads.set(thread.id, state);
      return state;
    }
    if (method === 'thread/resume') return threads.get(params.threadId);
    if (method === 'turn/start') {
      turns.push(params);
      const turnId = `turn-${++sequence}`;
      const h = handlers;
      queueMicrotask(() => {
        h?.onNotification?.('turn/completed', { turn: { id: turnId, status: 'completed' } });
      });
      return { turn: { id: turnId } };
    }
    return {};
  };

  try {
    const cwd = process.cwd();
    const first = await backend.internalTurn({ prompt: '内部の問い', cwd });
    assert.equal(typeof first.text, 'string');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].ephemeral, true);
    assert.equal(starts[0].approvalPolicy, 'untrusted');
    assert.equal(starts[0].sandbox, 'read-only');
    assert.equal(starts[0].config['features.shell_tool'], false);
    assert.equal(starts[0].config['features.unified_exec'], false);
    assert.equal(starts[0].config['features.multi_agent'], false);
    assert.equal(starts[0].config['features.hooks'], false);
    assert.equal(starts[0].config['web_search'], 'disabled');
    assert.deepEqual(starts[0].config.notify, []);
    assert.equal(starts[0].config['mcp_servers.danger.enabled'], false);
    assert.equal(turns[0].approvalPolicy, 'untrusted');
    assert.ok(configReads.length >= 1);
    assert.ok(configReads.every((p) => p.cwd === cwd), '利用者の cwd の config を読む（実行の cwd と一致）');
    t.ok('内部呼出しは ephemeral の thread で、shell・子・hooks・Web・利用者 MCP を閉じ、read-only/untrusted で回す', true);

    // config/read は 30 秒の覚えを使わず、毎回読む（直前に足した MCP も閉じる）
    const readsBefore = configReads.length;
    await backend.internalTurn({ prompt: '2 回目', cwd });
    assert.ok(configReads.length > readsBefore, 'config/read をキャッシュせず毎回読む');
    assert.equal(starts.length, 2);
    t.ok('config/read はキャッシュを迂回して毎回読む', true);

    // 読めないときは thread を始めない（利用者 MCP を開いたままにしない）
    configFail = true;
    const before = starts.length;
    await assert.rejects(() => backend.internalTurn({ prompt: '失敗', cwd }), (e) => e?.code === 'INTERNAL_UNAVAILABLE');
    assert.equal(starts.length, before, 'config/read が失敗したら thread/start しない');
    t.ok('config/read が失敗したら内部呼出しを始めない（fail-closed）', true);

    // exported backend の titlePrompt は Promise を返す。server 側は await して指示文にする
    const pendingPrompt = backend.titlePrompt('ja');
    assert.equal(typeof pendingPrompt?.then, 'function', 'titlePrompt は Promise を返す');
    assert.match(await pendingPrompt, /次の作業ログ/);
    t.ok('titlePrompt が Promise でも解決した指示文になる', true);
  } finally {
    rpc.request = originals.request;
    rpc.attach = originals.attach;
    rpc.claimOrphan = originals.claimOrphan;
  }
}
