// Run on an authenticated, isolated fake,codex server (tests/lib/fake-codex.mjs).
// 入力欄の設定はチップ（web/composer-controls.mjs）。承認モードはモデルの面の下端の区分けで、id は #modelChip の data-mode（ADR 0252）
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const pick = async (chip, key) => {
    await page.locator('#' + chip).click();
    await page.locator(`[data-key="${key}"]`).click();
    await page.keyboard.press('Escape');
  };
  const chooseMode = v => pick('modelChip', 'mode:' + v);
  const chooseBackend = v => pick('modelChip', 'backend:' + v);
  const mode = value => page.waitForFunction(v => document.querySelector('#modelChip').dataset.mode === v, value);
  await chooseMode('auto');
  await mode('auto');
  await chooseBackend('codex');
  await page.waitForFunction(() => document.querySelector('#modelChip').dataset.backend === 'codex');
  await page.locator('#modelChip').click();
  await page.locator('#modelPop').getByRole('radio', { name: /読むだけ/ }).waitFor();
  await page.keyboard.press('Escape');
  await chooseMode('readonly');
  await mode('readonly');
  await page.waitForFunction(() => document.querySelector('#nextSettingsText').textContent.includes('読むだけ'));
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
  if (await page.locator('#modelPop [data-key="mode:readonly"]').count()) throw Error('Previous agent modes remain');
  await page.keyboard.press('Escape');
  await chooseBackend('codex');
  await mode('ask');
  await chooseMode('readonly');
  await mode('readonly');
  await page.getByRole('button', { name: '取り消す', exact: true }).click();
  await mode('auto');
  return { passed: true, checks: ['agent options', 'selection', 'reload', 'context menu', 'switch back', 'cancel'] };
}
