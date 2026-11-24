// Run on an authenticated, isolated fake backend with onboarding completed.
async page => {
  await page.locator('.row[data-session]').first().waitFor();
  const target = await page.evaluate(() => localStorage.getItem('ply-test-session'));
  await page.locator(`.row[data-session="${target}"]`).click();
  await page.waitForFunction(id => document.querySelector('.row.sel')?.dataset.session === id && document.querySelector('#cwdChip').dataset.value, target);
  await page.locator('#newSession').click();
  await page.waitForFunction(id => document.querySelector('.row.sel')?.dataset.session !== id, target);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled && !document.querySelector('#send').disabled);
  await page.locator('#prompt').fill('slow');
  await page.locator('#send').click();
  await page.locator('#abort').waitFor({state:'visible'});
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  await page.locator('#prompt').fill('echo:queued-browser-message');
  await page.locator('#prompt').press('Control+Enter');
  // 送信待ちは入力欄の上のカードではなく、会話の一番下の薄い吹き出し（下に「次の区切りで送ります」と［取り消す］）
  await page.locator('#thread .mw.notyet').filter({hasText:'queued-browser-message'}).waitFor();
  await page.screenshot({path:'temporary/ui-check/messages-pending.png'});
  await page.waitForFunction(() => document.querySelector('#prompt').value === '');
  await page.reload();
  await page.locator('#thread .mw.notyet').filter({hasText:'queued-browser-message'}).waitFor();
  if (await page.locator('#send').isDisabled()) throw Error('send disabled during running turn');
  if (await page.locator('.m[data-role="user"]').count() !== 2) throw Error('initial or queued message duplicated on reload');
  await page.locator('#thread .mw.notyet .outbox-status button').filter({hasText:'取り消す'}).click();
  await page.locator('#thread .mw.notyet').waitFor({state:'detached'});
  await page.locator('#prompt').fill('echo:after-stop');
  await page.locator('#send').click();
  await page.locator('#thread .mw.notyet').waitFor();
  await page.locator('#abort').click();
  await page.locator('#thread .mw.notyet .outbox-status').filter({hasText:'送信を保留中'}).waitFor();
  await page.locator('#thread .mw.notyet .outbox-status button').filter({hasText:'再送する'}).click();
  await page.locator('#thread .mw.notyet').waitFor({state:'detached'});
  await page.locator('.m[data-role="assistant"]').filter({hasText:'after-stop'}).waitFor();
  await page.screenshot({path:'temporary/ui-check/messages-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'temporary/ui-check/messages-mobile.png'});
  return {passed:true, checks:['send while running','keyboard send','reload','cancel','pause on stop','retry','no duplicate initial message']};
}
