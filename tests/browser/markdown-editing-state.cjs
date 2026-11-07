// Run against an isolated fake server; no OS clipboard or external backend.
async page => {
  const checks = [], evidence = [], K = page.keyboard;
  const stable = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  const check = (name, got, want = true) => checks.push({ name, passed: stable(got) === stable(want), got, want });
  const snap = async name => {
    const x = await page.evaluate(async () => { const p = document.querySelector('#prompt'); const { posToOffset } = await import('/md-doc.mjs'), st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null); return { raw: p.value, state: p.editor.getState(), rows: [...p.children].map((b, i) => ({ kind: b.dataset.k, text: b.textContent, q: b.dataset.q ?? null, boundary: sepOf(i), indent: b.style.getPropertyValue('--md-ind'), h: b.getBoundingClientRect().height })), offset: [p.selectionStart, p.selectionEnd] }; });
    evidence.push({ name, ...x }); return x;
  };
  const ready = async () => { await page.waitForTimeout(1400); await page.evaluate(() => { for (const b of document.querySelectorAll('dialog[open] button')) if (b.textContent === 'あとで') b.click(); }); await page.waitForTimeout(800); };
  const reset = text => page.evaluate(text => { const p = document.querySelector('#prompt'); p.value = text ?? ''; p.focus(); p.setSelectionRange(p.value.length, p.value.length); }, text);
  const two = (x, second = null) => x.rows.length === 2 && x.rows[0].q === '1' && x.rows[1].q === second && x.rows.every(r => r.h > 0);
  await ready();
  await page.evaluate(() => { const p = document.querySelector('#prompt'); for (const key of p.editor.attachmentKeys()) p.editor.removeAttachment(key); });
  for (const mark of ['>', '-', '1.']) {
    await reset(); await K.type(mark); const p = await snap('pending-' + mark);
    check(mark + ' 確定前は本文・装飾なし', [p.rows[0].kind, p.rows[0].q, p.rows[0].text, p.rows[0].indent.includes('0 * var(--md-list-indent)')], ['p', null, mark, true]);
    await K.press('Space'); await K.type('a'); await K.press('Enter'); const e = await snap('enter-' + mark);
    check(mark + ' Enterは2行目へ', [e.rows.length, e.state.sel.s.b], [2, 1]);
    if (mark === '>') check('空引用の線も継続', two(e, '1'));
    await K.press('Backspace'); const x = await snap('empty-exit-' + mark);
    check(mark + ' 空行解除は2行・同じ行頭', [x.rows.length, x.rows[1].kind, x.state.sel.s], [2, 'p', { b: 1, v: 0 }]);
    await K.press('Control+z'); check(mark + ' Undo1回', (await snap('undo-' + mark)).raw, e.raw);
    await K.press('Control+Shift+z'); await K.type('b'); const typed = await snap('outside-' + mark);
    check(mark + ' Redo再入力も2行・境界あり', [typed.rows.length, typed.rows[1].boundary, typed.rows[1].kind], [2, '', 'p']);
  }
  await reset(); await K.type('>'); await K.press('Space'); await K.type('本文'); await K.press('Enter'); await K.type('続き'); await K.press('Home'); await K.press('Backspace');
  const exited = await snap('nonempty-exit'); check('非空解除は2行・同じ行頭・区切りは原文のみ', [two(exited), exited.raw, exited.state.sel.s], [true, '> 本文\n\n続き', { b: 1, v: 0 }]);
  await K.press('Control+z'); check('非空解除のUndo', two(await snap('nonempty-undo'), '1'));
  await K.press('Control+Shift+z'); await K.press('ArrowLeft'); check('左は前行末へ直接移動', (await snap('left')).state.sel.s, { b: 0, v: 2 });
  await K.press('ArrowRight'); check('右は区切りを飛ばして次行頭', (await snap('right')).state.sel.s, { b: 1, v: 0 });
  await K.press('ArrowUp'); check('上は前の編集行', (await snap('up')).state.sel.s.b, 0);
  await K.press('ArrowDown'); await K.press('Home'); check('下・Homeは2行目先頭', (await snap('down-home')).state.sel.s, { b: 1, v: 0 });
  await K.press('Delete'); check('Deleteは文字だけ削除', (await snap('delete-character')).raw, '> 本文\n\nき');
  await K.press('Control+z'); await K.press('Home'); await K.press('Backspace'); check('再度の行頭Backspaceは1回で結合', (await snap('join-back')).raw, '> 本文続き');
  await K.press('Control+z'); await K.press('Home'); await K.press('ArrowLeft'); await K.press('Delete'); check('前行末Deleteも1回で結合', (await snap('join-delete')).raw, '> 本文続き');
  await K.press('Control+z'); await K.press('Control+End'); await K.press('Home'); await K.press('Shift+End'); await K.press('Backspace'); await K.type('再入力'); check('範囲削除と再入力は外の本文', (await snap('retype')).raw, '> 本文\n\n再入力');
  // The textarea-compatible API uses serialized Markdown offsets, while editing has two rows.
  await page.evaluate(() => { const p = document.querySelector('#prompt'), at = p.value.indexOf('再入力'); p.setRangeText('置換', at, at + 3); p.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  check('範囲置換APIは境界を保持', (await snap('range-api')).raw, '> 本文\n\n置換');
  const copy = await page.evaluate(() => { const p = document.querySelector('#prompt'), data = {}; p.focus(); p.setSelectionRange(0, p.value.length); const e = new Event('copy', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'clipboardData', { value: { setData: (k, v) => data[k] = v } }); p.dispatchEvent(e); return data['text/plain']; });
  check('範囲コピーはMarkdown境界を含む', copy, '> 本文\n\n置換');
  const cut = await page.evaluate(() => { const p = document.querySelector('#prompt'), data = {}; const e = new Event('cut', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'clipboardData', { value: { setData: (k, v) => data[k] = v } }); p.dispatchEvent(e); return { raw: p.value, copied: data['text/plain'] }; });
  check('切取りは原文コピーと編集行削除を一緒に行う', cut, { raw: '', copied: copy });
  await K.press('Control+z'); check('切取りUndoで2行と境界が復帰', two(await snap('cut-undo')));
  await K.press('Control+End');
  await page.evaluate(() => { const d = new DataTransfer(); d.setData('text/plain', '\n貼付'); document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); });
  const pasted = await snap('paste'); check('貼付後も境界と本文を保持', [pasted.raw, pasted.rows.length], ['> 本文\n\n置換\n貼付', 3]);
  await page.waitForTimeout(1900); await page.reload(); await ready(); const reloaded = await snap('draft-reload');
  check('画面再読込でも境界・編集行数を保持', [reloaded.raw, reloaded.rows.length, reloaded.rows[1].boundary], [pasted.raw, 3, '']);
  // Exercise the same model scenario independently and compare it with direct input.
  const scenario = await page.evaluate(async () => { const m = await import('/md-doc.mjs'); let s = { blocks: m.markdownToDoc(''), sel: m.caret(0, 0) }; s = m.insertText(s, '> '); s = m.applyTriggers(s, ' ').state; s = m.insertText(s, '本文'); s = m.enter(s); s = m.backspaceAtStart(s); s = m.insertText(s, '続き'); return { raw: m.docToMarkdown(s.blocks), rows: s.blocks.length, second: s.blocks[1].kind }; });
  check('比較方針の操作も直接入力と同じ2行・送信境界', scenario, { raw: exited.raw, rows: 2, second: 'p' });
  return { checks, evidence, passed: checks.every(c => c.passed) };
}
