// Run on an authenticated, isolated fake,codex server (tests/lib/fake-codex.mjs).
// 送る前の会話では予約の帯（#nextSettings）を出さない（帯は走っているターンがあるときだけ。ADR 0341）ので、ここでは帯と［取り消す］を見ない。帯は tests/browser/settings-band.cjs の側
// 入力欄の設定はチップ（web/composer-controls.mjs）。モデルの面は 2 段: 1 段目の行（data-key="nav:<段>"）を押すと 2 段目の一覧。承認モードの id は #modelChip の data-mode（ADR 0252）
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const pick = async (chip, view, key) => {
    await page.locator('#' + chip).click();
    await page.locator(`#modelPop [data-key="nav:${view}"]`).click();
    await page.locator(`[data-key="${key}"]`).click();
    await page.keyboard.press('Escape');
  };
  const chooseMode = v => pick('modelChip', 'mode', 'mode:' + v);
  const chooseBackend = v => pick('modelChip', 'agent', 'backend:' + v);
  const mode = value => page.waitForFunction(v => document.querySelector('#modelChip').dataset.mode === v, value);
  await chooseMode('auto');
  await mode('auto');
  await chooseBackend('codex');
  await page.waitForFunction(() => document.querySelector('#modelChip').dataset.backend === 'codex');
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="nav:mode"]').click();
  await page.locator('#modelPop').getByRole('option', { name: /読むだけ/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await chooseMode('readonly');
  await mode('readonly');
  await page.reload();
  await mode('readonly');
  await page.locator('.row.sel').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /承認モード/ }).hover();
  await page.getByRole('menuitem', { name: /Bypass/ }).waitFor();
  await page.getByRole('menuitem', { name: /^都度確認/ }).click();
  await mode('ask');
  await chooseBackend('fake');
  await mode('auto');
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="nav:mode"]').click();
  await page.locator('#modelPop [data-key^="mode:"]').first().waitFor();
  if (await page.locator('#modelPop [data-key="mode:readonly"]').count()) throw Error('Previous agent modes remain');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await chooseBackend('codex');
  await mode('ask');
  await chooseMode('readonly');
  await mode('readonly');
  return { passed: true, checks: ['agent options', 'selection', 'reload', 'context menu', 'switch back'] };
}
