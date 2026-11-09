// Authenticated fake server; use the normal steps script and reload while the last tool is still running.
async page => {
  await page.evaluate(() => { document.querySelector('#onboardingDialog')?.close(); return true; });
  await page.locator('#newSession').click();
  const steps = [
    ...Array.from({ length: 36 }, (_, i) => [{ newMessage: true }, { text: `Earlier response ${i}.` }]).flat(),
    // No text.end boundaries in this suffix: it must remain responsive even on old streams.
    ...Array.from({ length: 320 }, (_, i) => ({ tool: 'Bash', input: { command: `echo ${i}` }, result: `result ${i}`, ms: 0 })),
    { tool: 'Bash', input: { command: 'replay-running-tool' }, result: 'done', ms: 20000 },
    { text: 'Finished.' },
  ];
  await page.locator('#prompt').fill('steps:' + JSON.stringify({ steps }));
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('.tc-at-end .tc-main').filter({ hasText: 'replay-running-tool' }).waitFor();
  const before = await page.evaluate(() => {
    const card = document.querySelector('.tc-at-end');
    return { id: card.dataset.id, start: card.toolStarted };
  });
  await page.addInitScript(() => {
    window.replayTasks = [];
    window.replayTicks = 0;
    new PerformanceObserver(list => window.replayTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask' });
    setInterval(() => window.replayTicks++, 20);
  });
  await page.reload();
  await page.evaluate(() => { document.querySelector('#onboardingDialog')?.close(); return true; });
  await page.waitForFunction(() => !document.querySelector('#prompt').readOnly && document.querySelectorAll('#thread .tc').length === 321);
  await page.locator('.tc-at-end').waitFor();
  const after = await page.evaluate(() => {
    const card = document.querySelector('.tc-at-end');
    return { id: card.dataset.id, start: card.toolStarted, count: document.querySelectorAll('.tc-at-end').length,
      last: card.closest('.mw') === document.querySelector('#thread > .mw:last-child') };
  });
  const work = await page.evaluate(() => ({ ticks: window.replayTicks, longest: Math.max(0, ...window.replayTasks) }));
  if (work.ticks < 2 || work.longest > 1000) throw Error('history blocked the browser: ' + JSON.stringify(work));
  if (before.id !== after.id || Math.abs(before.start - after.start) > 250 || after.count !== 1 || !after.last) throw Error(JSON.stringify({before,after}));
  await page.waitForFunction(() => !document.querySelector('.tc-at-end'));
  return { restoredSameCall: true, retainedStart: true, completedInHistory: true };
}
