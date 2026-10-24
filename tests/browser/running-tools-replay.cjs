// Authenticated fake server; use the normal steps script and reload while the last tool is still running.
async page => {
  await page.evaluate(() => { document.querySelector('#onboardingDialog')?.close(); return true; });
  await page.locator('#newSession').click();
  const steps = [
    ...Array.from({ length: 36 }, (_, i) => [{ newMessage: true }, { text: `Earlier response ${i}.` }]).flat(),
    { tool: 'Bash', input: { command: 'replay-running-tool' }, result: 'done', ms: 9000 },
    { text: 'Finished.' },
  ];
  await page.locator('#prompt').fill('steps:' + JSON.stringify({ steps }));
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('.tc-at-end').waitFor();
  const before = await page.evaluate(() => {
    const card = document.querySelector('.tc-at-end');
    return { id: card.dataset.id, start: card.toolStarted };
  });
  await page.reload();
  await page.waitForTimeout(1200);
  await page.evaluate(() => { document.querySelector('#onboardingDialog')?.close(); return true; });
  await page.locator('.tc-at-end').waitFor();
  const after = await page.evaluate(() => {
    const card = document.querySelector('.tc-at-end');
    return { id: card.dataset.id, start: card.toolStarted, count: document.querySelectorAll('.tc-at-end').length,
      last: card.closest('.mw') === document.querySelector('#thread > .mw:last-child') };
  });
  if (before.id !== after.id || Math.abs(before.start - after.start) > 250 || after.count !== 1 || !after.last) throw Error(JSON.stringify({before,after}));
  await page.waitForFunction(() => !document.querySelector('.tc-at-end'));
  return { restoredSameCall: true, retainedStart: true, completedInHistory: true };
}
