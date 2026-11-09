// Claude の内部呼出し（Issue #180）: 会話も履歴も作らないオプションと、管理 hooks / policyHelper / 設定不読の
// fail-closed、oauthToken/接続先を指定しても INTERNAL_UNAVAILABLE の code を失わないことを、偽の SDK で確かめる。
// 実 CLI・実 SDK・LLM は呼ばない（setClaudeSdkForTest の query / resolveSettings を差し替える）。
import assert from 'node:assert/strict';
import { backend, setClaudeSdkForTest } from '../../core/backends/claude.mjs';

export const name = 'claude-internal-call';
export const title = 'Claude の内部呼出し: persistSession/tools/strictMcpConfig/hooks の閉じ方と管理ポリシーの fail-closed';

export default async function (t) {
  let restore = () => {};
  const fakeToken = 'fake-token';
  const useSdk = (over) => { restore(); restore = setClaudeSdkForTest({ executable: () => 'claude-fake', ...over }); };
  try {
    // ---- 成功: 会話を残さない・道具を渡さない・MCP を閉じる・hooks を止める
    let seen = null, queried = 0;
    useSdk({
      resolveSettings: async () => ({ sources: [], effective: { disableAllHooks: true } }),
      query: async function* (args) {
        queried += 1;
        seen = args.options;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '内部の返事' }] } };
        yield { type: 'result', usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 }, total_cost_usd: 0.02 };
      },
    });
    const out = await backend.internalTurn({ prompt: 'p', oauthToken: fakeToken, locale: 'ja' });
    assert.equal(out.text, '内部の返事');
    assert.equal(out.usage.inputTokens, 4);
    assert.equal(out.usage.outputTokens, 2);
    assert.equal(out.usage.cachedTokens, 1);
    assert.equal(out.usage.costUsd, 0.02);
    assert.equal(queried, 1);
    assert.equal(seen.persistSession, false);
    assert.equal(seen.maxTurns, 1);
    assert.deepEqual(seen.tools, []);
    assert.deepEqual(seen.allowedTools, []);
    assert.equal(seen.permissionMode, 'dontAsk');
    assert.equal(seen.strictMcpConfig, true);
    assert.deepEqual(seen.mcpServers, {});
    assert.deepEqual(seen.settingSources, []);
    assert.equal(seen.settings.disableAllHooks, true);
    assert.equal(seen.managedSettings.disableAllHooks, true);
    t.ok('成功: persistSession:false・tools:[]・strictMcpConfig・MCP 空・hooks 停止・1 ターンで、usage を返す', true);

    // ---- 管理 hooks / policyHelper / 設定不読は、query を始めず INTERNAL_UNAVAILABLE
    for (const [label, resolveSettings] of [
      ['管理 hooks', async () => ({ sources: [{ source: 'managed', settings: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } } }] })],
      ['policyHelper', async () => ({ sources: [{ source: 'managed', settings: { policyHelper: { path: '/admin/helper' } } }] })],
      ['settings 不読', async () => { throw new Error('cannot read settings'); }],
    ]) {
      let calls = 0;
      useSdk({ resolveSettings, query: async function* () { calls += 1; yield { type: 'result' }; } });
      // oauthToken を付けても、包み直しで code を失わない（pulse の恒常停止・title の unsupported へ届く）
      await assert.rejects(() => backend.internalTurn({ prompt: 'p', oauthToken: fakeToken }),
        (e) => e?.code === 'INTERNAL_UNAVAILABLE', label);
      assert.equal(calls, 0, `${label}: query を始めない`);
      t.ok(`${label}: 内部呼出しを始めず、code を保って拒否する`, true);
    }
  } finally {
    restore();
  }
}
