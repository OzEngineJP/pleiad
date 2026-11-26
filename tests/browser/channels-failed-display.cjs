// playwright-cli -s=channels-failed-display run-code --filename=tests/browser/channels-failed-display.cjs
// Start an isolated fake server on port 7433 with AGENT_HOST_TOKEN=channels-test.
async page => {
  await page.goto('http://127.0.0.1:7433/?token=channels-test');
  await page.getByRole('button', { name: 'あとで', exact: true }).click().catch(() => {});
  await page.getByRole('radio', { name: 'チャンネル' }).click();
  const shown = await page.evaluate(async () => {
    const { renderPost } = await import('/channels/post.mjs');
    const host = { state: { backends: [] }, renderAssistantMarkdown: (text) => `<p>${text}</p>` };
    const ctx = { host, bots: new Map([['b_owl', { name: 'Owl', icon: '🦉' }]]),
      actions: { react() {}, quick() {}, openThread() {}, menu() {} } };
    const base = { channelId: 'c_test', threadId: 'p_root', author: { kind: 'bot', botId: 'b_owl' },
      at: Date.now(), mentions: [], reactions: {}, turn: { botId: 'b_owl', sessionId: 's_test' }, state: 'failed' };
    // 返事のない失敗（failure を持つ）: 本文は出さず「✕ 失敗 · 理由」と［やり直す］（最後の投稿のとき）
    const retried = [];
    const retryCtx = { ...ctx, actions: { ...ctx.actions, canRetry: (p) => p.id === 'p_failure', retry: async (p) => { retried.push(p.id); } } };
    const fixture = document.createElement('div');
    fixture.append(renderPost({ ...base, id: 'p_with_body', text: '途中の返事です', failedWithBody: true }, ctx),
      renderPost({ ...base, id: 'p_without_body', text: '失敗しました: エラー' }, ctx),
      renderPost({ ...base, id: 'p_failure', text: '失敗しました: エラー', failure: 'Claude Code が終了しました（終了コード 1）' }, retryCtx),
      renderPost({ ...base, id: 'p_failure_old', text: '失敗しました: エラー', failure: 'Claude Code が終了しました（終了コード 1）' }, retryCtx));
    document.body.append(fixture);
    const result = [...fixture.querySelectorAll('.post')].map((post) => {
      const status = post.querySelector('.post-state');
      const retry = post.querySelector('.post-retry');
      return { body: post.querySelector('.post-body')?.textContent, bodyHidden: post.querySelector('.post-body')?.hidden, label: status?.textContent,
        className: status?.className, marks: status?.querySelectorAll('.post-state-mark').length,
        weight: Number(getComputedStyle(status.querySelector('.post-state-text')).fontWeight), retry: retry?.textContent ?? null };
    });
    fixture.querySelector('[data-post-id="p_failure"] .post-retry')?.click();
    result.push({ retried: [...retried] });
    fixture.remove();
    return result;
  });
  if (shown[0]?.body !== '途中の返事です' || shown[0]?.label !== '終わり方に問題がありました'
    || shown[0]?.className !== 'post-state failed-body' || shown[0]?.marks !== 0
    || shown[1]?.label !== '✕失敗' || shown[1]?.marks !== 1 || shown[0].weight >= shown[1].weight
    || shown[1]?.bodyHidden || shown[1]?.retry !== null
    || shown[2]?.label !== '✕失敗Claude Code が終了しました（終了コード 1）' || !shown[2]?.bodyHidden || shown[2]?.retry !== 'やり直す'
    || shown[3]?.retry !== null || shown[4]?.retried?.join() !== 'p_failure') {
    throw Error(JSON.stringify(shown));
  }
  return shown;
}
