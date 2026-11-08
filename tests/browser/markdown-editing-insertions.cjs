// Isolated fake session with a modified sample.txt in its own Git repository.
async page => {
  const checks = [], evidence = [], K = page.keyboard;
  const check = (name, got, want) => {
    const passed = JSON.stringify(got) === JSON.stringify(want);
    checks.push({ name, passed, got, want });
    if (!passed) throw Error(`${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  };
  const reset = text => page.evaluate(text => { const p = document.querySelector('#prompt'); p.value = text; p.dispatchEvent(new Event('input', { bubbles: true })); p.focus(); p.setSelectionRange(text.length, text.length); }, text);
  const snap = () => page.evaluate(async () => {
    const p = document.querySelector('#prompt');
    // 行の前の区切りは、送る Markdown の前の行との間の行（無ければ null）
    const { posToOffset } = await import('/md-doc.mjs'), st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null);
    return { raw: p.value, kinds: [...p.children].map(d => d.dataset.k), before: [...p.children].map((d, i) => sepOf(i)), markers: [...p.children].map(d => d.dataset.m ?? ''), focus: document.activeElement.id };
  });
  const ready = async () => {
    await page.waitForTimeout(1800);
    await page.evaluate(() => document.querySelector('#closeOnboarding')?.click());
    await page.waitForFunction(() => { const p = document.querySelector('#prompt'); return !p.disabled && !p.readOnly && !document.querySelector('#cbox').hasAttribute('aria-busy'); });
  };
  const exit = async () => { await reset(''); await K.type('>'); await K.press('Space'); await K.type('引用'); await K.press('Enter'); await K.type('本文'); await K.press('Home'); await K.press('Backspace'); };
  const reload = async () => { await page.waitForTimeout(1800); await page.reload(); await ready(); };
  const schedule = async () => {
    await reset('予約本文'); await page.click('#sendMore');
    await page.waitForFunction(() => !!document.querySelector('#sendPop .copt'));
    await page.evaluate(() => [...document.querySelectorAll('#sendPop .copt')].find(b => b.textContent.includes('明日の朝 9:00')).click());
    await page.waitForFunction(() => !!document.querySelector('.sched .acts button'));
  };
  const editSchedule = async () => {
    await page.evaluate(() => [...document.querySelectorAll('.sched .acts button')].find(b => b.textContent === '編集').click());
    await page.waitForFunction(() => !document.querySelector('.sched'));
  };
  await ready();
  await reset('echo:ready'); await K.press('Control+Enter');
  await page.waitForFunction(() => !!document.querySelector('#log .m.user'));
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  await schedule(); await exit();
  check('予約編集前は引用1行と本文1行', (await snap()).kinds, ['quote', 'p']);
  await editSchedule();
  const prefixed = await snap(); evidence.push({ name: 'scheduled-prefix', ...prefixed });
  check('予約編集は既存2行と境界を保持', [prefixed.raw, prefixed.kinds, prefixed.before, prefixed.focus], ['予約本文\n\n> 引用\n\n本文', ['p', 'p', 'quote', 'p'], [null, null, null, ''], 'prompt']);
  await reload();
  const restoredPrefix = await snap();
  check('予約編集後の下書きを再読込しても境界を復元', [restoredPrefix.raw, restoredPrefix.kinds, restoredPrefix.before], [prefixed.raw, prefixed.kinds, prefixed.before]);
  await page.evaluate(() => { if (!document.querySelector('#armedChip').hidden) document.querySelector('#armedRemove').click(); });
  await schedule(); await reset(''); await K.type('>'); await editSchedule();
  const pending = await snap();
  check('予約編集で前置きしても末尾の記号は未確定', [pending.raw, pending.kinds, pending.markers.at(-1)], ['予約本文\n\n\\>', ['p', 'p', 'p'], '']);  // 確定していない行頭の記号はエスケープして送る（ADR 0301 の S3）
  await reload(); check('前置き後の未確定記号も復元', (await snap()).kinds, ['p', 'p', 'p']);
  await page.evaluate(() => { if (!document.querySelector('#armedChip').hidden) document.querySelector('#armedRemove').click(); });
  await exit();
  await page.waitForFunction(() => !!document.querySelector('#cwdChip .git-br:not([hidden])'));
  if (!await page.evaluate(() => !!document.querySelector('[data-cuse]'))) await K.press('Control+Shift+g');
  await page.waitForFunction(() => !!document.querySelector('[data-cuse]'));
  await page.click('[data-cuse]');
  const appended = await snap(); evidence.push({ name: 'git-append', ...appended });
  check('Gitの会話で使うから既存2行へ追記して境界保持', [appended.kinds, appended.before, appended.raw.startsWith('> 引用\n\n本文\n'), appended.raw.includes('git:'), appended.focus], [['quote', 'p', 'p'], [null, '', null], true, true, 'prompt']);
  await reload();
  const restoredAppend = await snap();
  check('Git追記後の保存復元でも3編集行を保持', [restoredAppend.raw, restoredAppend.kinds, restoredAppend.before], [appended.raw, appended.kinds, appended.before]);
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.focus(); }); await K.press('Control+Enter');
  await page.waitForFunction(raw => [...document.querySelectorAll('#log .m.user .body')].some(b => b.dataset.raw === raw), appended.raw);
  check('追記した送信履歴でも本文は引用の外', await page.evaluate(raw => { const b = [...document.querySelectorAll('#log .m.user .body')].find(b => b.dataset.raw === raw); return b.querySelector('blockquote').textContent.trim() === '引用' && [...b.querySelectorAll('p')].some(p => p.textContent === '本文' + raw.split('\n').at(-1) && p.querySelector('br') && !p.closest('blockquote')); }, appended.raw), true);
  await reset(''); await K.type('>'); await K.press('Enter'); await K.type('>'); await K.press('Space'); await K.type('a');
  check('未確定行の次の確定引用は線を描く', await page.evaluate(() => [...document.querySelector('#prompt').children].map(d => [d.dataset.k, d.dataset.q ?? null])), [['p', null], ['quote', '1']]);
  await reset('- A\n- B\n  > > x\n  > > y'); await K.press('Home'); await K.press('Backspace');
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.setSelectionRange(6, 6); }); await K.press('Tab');
  const indented = await snap(); evidence.push({ name: 'nested-indent', ...indented });
  check('実際のTabで解除境界も子項目内へ移動', [indented.raw, indented.before.at(-1)], ['- A\n  - B\n    > > x\n    >\n    > y', '    >']);  // 引用の中の空行は `>` だけで送る（ADR 0301 の S2）
  await K.press('Shift+Tab');
  check('Shift+Tabで境界も戻る', (await snap()).raw, '- A\n- B\n  > > x\n  >\n  > y');
  await reload(); check('字下げ後の保存復元でも4編集行', (await snap()).kinds.length, 4);
  return { checks, evidence, passed: checks.every(c => c.passed) };
}
