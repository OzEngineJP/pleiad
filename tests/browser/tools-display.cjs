// Run against an authenticated, isolated fake server with agent-browser eval.
// Wrap this function in parentheses and invoke it; it returns the passed checks.
async () => {
  const { renderToolCall, applyToolResult, applyToolHints } = await import('/render.mjs');
  const { terminalView, updateTerminal } = await import('/terminal.mjs');
  const checks = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const main = c => c.querySelector('.tc-pane-main').classList.contains('on');
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const host = document.createElement('div');
  document.body.append(host);
  try {
    applyToolHints({ toolsTestEdit: { shape: 'edit' }, toolsTestWrite: { shape: 'write' } });
    for (const [name, input, initial] of [
      ['Bash', { command: 'npm test' }, false], ['Read', { file_path: 'a.ts' }, false],
      ['Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, true],
      ['toolsTestEdit', { files: ['a.ts'] }, false],
      ['toolsTestWrite', { CodeContent: 'new' }, true],
      ['Grep', { pattern: 'x' }, false], ['WebSearch', { query: 'x' }, false],
      ['Agent', { prompt: 'look' }, false], ['mcp__ply_agents__ply_delegate', { task: 'look' }, false],
    ]) {
      const card = renderToolCall(name, input); host.append(card);
      check(!card.querySelector('.tc-details').open && main(card) === initial, `${name}: closed and initial pane`);
      applyToolResult(card, { text: '' });
      check(main(card) === initial, `${name}: empty result`);
      applyToolResult(card, { text: name.endsWith('ply_delegate') ? '{"taskId":"ply-task-test"}' : '0 matches' });
      check(main(card), `${name}: nonempty result`);
      card.querySelector('.tc-details').open = true;
      await frame();
      card.querySelectorAll('.tc-tabs button')[1].click();
      applyToolResult(card, { text: 'updated' });
      check(!main(card), `${name}: chosen input survives updates`);
      card.remove();
    }
    const pending = renderToolCall('Bash', { command: 'npm test' }); host.append(pending);
    pending.querySelector('.tc-details').open = true;
    await frame();
    applyToolResult(pending, { text: 'arrived' });
    check(!main(pending), 'Opening input freezes the pane without clicking a tab');
    pending.querySelectorAll('.tc-tabs button')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    check(!main(pending), 'Arrow keys select the input tab');
    pending.remove();
    const term = terminalView(); host.append(term);
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    updateTerminal(term, { command: 'npm test', output: lines, running: true });
    await frame();
    check(getComputedStyle(term).fontFamily.includes('mono') && term.clientHeight <= 341 && term.scrollHeight > term.clientHeight, 'Terminal uses monospace and a bounded scrolling surface');
    term.scrollTop = term.scrollHeight;
    updateTerminal(term, { command: 'npm test', output: lines + '\nnew', running: true });
    check(term.scrollHeight - term.scrollTop - term.clientHeight < 2, 'Tail follows new output');
    term.scrollTop = 40;
    updateTerminal(term, { command: 'npm test', output: lines + '\nnew\nmore', running: true });
    check(term.scrollTop === 40, 'Scrollback remains at its reading position');
    check(Boolean(term.querySelector('.tc-term-cursor')), 'Running terminal shows cursor');
    updateTerminal(term, { command: '<script>bad</script>', output: lines, exitCode: 0 });
    check(!term.querySelector('script') && !term.querySelector('.tc-term-cursor') && term.textContent.endsWith('exit 0'), 'Completed terminal escapes command, removes cursor, shows exit 0');
    // Exercise the card decorator with a controlled git response, independent of
    // whether a backend can create isolated children on the verification host.
    const source = await (await fetch('/client.mjs')).text();
    const start = source.indexOf('async function paintDelegateGit(');
    const code = source.slice(start, source.indexOf('\n}', start) + 2);
    const { renderDelegateGit } = await import('/git-view.mjs');
    const task = { taskId: 'browser-git-fixture', sessionId: 'child' };
    let calls = 0;
    const paintGit = Function('taskById', 'cmd', 'renderDelegateGit', code + ';return paintDelegateGit;')(
      () => task,
      async () => { calls++; return { git: { branch: 'work', linked: true, session: { files: 1, add: 2, del: 1 } } }; },
      renderDelegateGit,
    );
    const child = renderToolCall('mcp__ply_agents__ply_delegate', { task: 'Inspect pricing' });
    child.dataset.taskId = task.taskId;
    const where = document.createElement('div'); where.className = 'rt-where';
    child.querySelector('.tc-pane-main').append(where); host.append(child);
    await paintGit(child);
    check(calls === 0 && !child.querySelector('.git-delegate'), 'Shared child has no changes row or git request');
    task.worktree = { path: '/fixture/work', branch: 'work' };
    await paintGit(child);
    check(calls === 1 && child.querySelector('.git-delegate')?.textContent.includes('変更'), 'Worktree child retains changes row');
    delete task.worktree;
    await paintGit(child);
    check(!child.querySelector('.git-delegate') && calls === 1, 'Shared child removes any stale changes row');
    return { passed: checks.length, checks };
  } finally { host.remove(); }
}
