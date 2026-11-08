// Run on an authenticated, isolated fake server. Keyboard input uses the browser's input events.
async page => {
  const checks = [], evidence = [], K = page.keyboard;
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const check = (name, got, want = true) => checks.push({ name, passed: equal(got, want), got, want });
  const snap = async name => {
    const x = await page.evaluate(async () => {
      const p = document.querySelector('#prompt'), state = p.editor.getState();
      const m = await import('/md-doc.mjs'), { parseStructure } = await import('/md-structure.mjs');
      const { renderMarkdown } = await import('/render.mjs');
      const structure = parseStructure(p.value.split('\n'));
      const posToOffset = m.posToOffset, st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null);
      const depth = n => { let q = 0, list = 0; for (; n; n = n.parent) { q += n.t === 'bq'; list += n.t === 'item'; } return [q, list]; };
      return { raw: p.value, state, editing: p.editor.snapshotEditing(), sentHtml: renderMarkdown(p.value), events: window.__exitEvents ?? [],
        rows: [...p.children].map((b, i) => ({ kind: b.dataset.k, marker: state.blocks[i].marker,
          q: +(b.dataset.q ?? 0), boundary: sepOf(i), text: b.textContent,
          indent: b.style.getPropertyValue('--md-ind'), height: b.getBoundingClientRect().height,
          sentDepth: depth(structure.lines[p.value.slice(0, m.posToOffset(state.blocks, { b: i, v: 0 })).split('\n').length - 1]?.node),
        })) };
    });
    evidence.push({ name, ...x });
    check(name + ' 編集行と選択位置', x.rows.length === x.state.blocks.length && x.state.sel.s.b < x.rows.length && x.state.sel.e.b < x.rows.length);
    check(name + ' 確定記号とDOM', x.rows.every((r, i) => r.kind === x.state.blocks[i].kind && r.height > 0));
    check(name + ' 引用の深さは送信と一致', x.rows.every((r, i) => (r.kind === 'p' && ['>', '-', '1.'].includes(r.text)) || !x.state.blocks[i].runs.some(r => r.text.trim()) || r.q === r.sentDepth[0]));
    return x;
  };
  const op = async (key, name = key) => { await K.press(key); return snap(name); };
  const type = async text => { await K.type(text); return snap('入力 ' + text); };
  const reset = async (text = '') => {
    await page.evaluate(text => { const p = document.querySelector('#prompt'); p.value = text; p.focus(); p.setSelectionRange(p.value.length, p.value.length); }, text);
  };
  const ready = async () => {
    await page.waitForTimeout(1400);
    await page.evaluate(() => { for (const b of document.querySelectorAll('dialog[open] button')) if (b.textContent === 'あとで') b.click(); });
    await page.waitForTimeout(800);
  };
  const base = async mark => {
    await reset(); const pending = await type(mark);
    check(mark + ' Space前は装飾しない', [pending.rows[0].kind, pending.rows[0].q], ['p', 0]);
    await op('Space'); await type('a'); await op('Enter'); return op('Enter', mark + ' Enter×2');
  };
  await ready();
  await page.evaluate(() => {
    window.__exitEvents = [];
    for (const event of ['beforeinput', 'input', 'compositionstart', 'compositionend']) document.querySelector('#prompt').addEventListener(event, e => window.__exitEvents.push({ event, type: e.inputType, trusted: e.isTrusted, composing: e.isComposing }));
  });
  for (const mark of ['>', '-', '1.']) {
    const out = await base(mark);
    check(mark + ' 空行Enterは同じ2行目で解除', [out.raw, out.rows.length, out.rows[1].kind, out.rows[1].boundary, out.state.sel.s], [mark + ' a\n', 2, 'p', null, { b: 1, v: 0 }]);
    await type('b'); const typed = await snap(mark + ' 外へ入力');
    check(mark + ' Enter×2の直後の文字は構造外', [typed.raw, typed.rows[1].sentDepth], [mark + ' a\n\nb', [0, 0]]);
    await base(mark); const joined = await op('Backspace', mark + ' ユーザーの結合');
    check(mark + ' Backspace直後から1行の構造', [joined.raw, joined.rows.length, joined.state.sel.s, joined.rows[0].kind], [mark + ' a', 1, { b: 0, v: 1 }, mark === '>' ? 'quote' : mark === '-' ? 'ul' : 'ol']);
    check(mark + ' ユーザーの手順そのもの', (await type('b')).raw, mark + ' ab');
    await base(mark); await op('Control+z'); await op('Control+Shift+z');
    check(mark + ' Undo→Redo→入力', (await type('b')).raw, mark + ' a\n\nb');
    await base(mark); await op('ArrowLeft'); const del = await op('Delete');
    check(mark + ' 前行末Deleteは即座に結合', [del.raw, del.rows.length], [mark + ' a', 1]);
    check(mark + ' Delete後の文字も安定', (await type('b')).raw, mark + ' ab');
    await base(mark); await op('Backspace'); const twice = await op('Backspace', mark + ' 2連Backspace');
    check(mark + ' 2回目は結合した行の文字を削除', [twice.raw, twice.rows.length, twice.state.sel.s], [mark + ' ', 1, { b: 0, v: 0 }]);
    check(mark + ' 2連Backspace後の入力', (await type('b')).raw, mark + ' b');
    await base(mark); await type('消す'); await op('Home'); await op('Shift+End'); await op('Backspace');
    await page.evaluate(() => { const d = new DataTransfer(); d.setData('text/plain', '貼付\n次'); document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); });
    const pasted = await snap(mark + ' 選択削除→貼付');
    check(mark + ' 貼付後も境界を保つ', [pasted.raw, pasted.rows.length, pasted.rows[1].boundary], [mark + ' a\n\n貼付\n次', 3, '']);
    await op('Control+z'); await op('Control+Shift+z');
    await base(mark); await page.waitForTimeout(1100); await op('Control+z'); await page.waitForTimeout(1100); await op('Control+Shift+z');
    check(mark + ' 遅いUndo/Redoでも境界を保つ', (await type('b')).raw, mark + ' a\n\nb');
  }
  for (const [seed, marker, kind, depth] of [
    ['> > a', '> ', 'quote', [1, 0]], ['> - a', '> ', 'quote', [1, 0]],
    ['- a\n  - b', '- ', 'ul', [0, 1]], ['1. a\n   1. b', '2. ', 'ol', [0, 1]],
    ['> 1. a\n>    - b', '> 2. ', 'ol', [1, 1]],
  ]) {
    await reset(seed); const continued = await op('Enter'); const out = await op('Enter', seed + ' 解除');
    check(seed + ' 空の子項目を残さず一段解除', [out.rows.length, out.rows.at(-1).marker, out.rows.at(-1).kind, out.rows.at(-1).q, out.state.sel.s.b], [continued.rows.length, marker, kind, depth[0], continued.state.sel.s.b]);
    const typed = await type('c'); check(seed + ' 入力後の送信も同じ深さ', typed.rows.at(-1).sentDepth, depth);
    await page.waitForTimeout(1900); await page.reload(); await ready();
    const restored = await snap(seed + ' 下書き再読込');
    check(seed + ' 下書きの編集行と記号を復元', [restored.raw, restored.rows.length, restored.rows.at(-1).marker], [typed.raw, typed.rows.length, marker]);
  }
  await base('>'); await op('ArrowLeft'); await op('ArrowRight'); await op('ArrowUp'); await op('ArrowDown'); await op('Home');
  check('移動しても解除行は同じ2行目', (await snap('移動後')).state.sel.s, { b: 1, v: 0 });
  const composition = await page.evaluate(() => {
    const p = document.querySelector('#prompt'); p.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true }); p.dispatchEvent(enter);
    p.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: 'あ', isComposing: true, bubbles: true }));
    const s = getSelection(), range = s.getRangeAt(0), node = document.createTextNode('あ'); range.deleteContents(); range.insertNode(node); s.setBaseAndExtent(node, 1, node, 1);
    p.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'あ', isComposing: true, bubbles: true }));
    p.dispatchEvent(new CompositionEvent('compositionend', { data: 'あ', bubbles: true }));
    return { prevented: enter.defaultPrevented, rows: p.children.length };
  });
  await page.waitForTimeout(50); const composed = await snap('合成イベントの確定後');
  check('変換中Enterで改行せず確定後も構造外', [composition, composed.raw, composed.rows[1]?.q], [{ prevented: false, rows: 2 }, '> a\n\nあ', 0]);
  await page.waitForTimeout(1900); await page.reload(); await ready();
  const reloaded = await snap('空行解除からの下書き復元');
  check('合成入力後の下書きも2編集行', [reloaded.raw, reloaded.rows.length, reloaded.rows[1]?.boundary], [composed.raw, 2, '']);
  await base('>');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  check('ブラウザーの変換中も解除行に留まる', (await snap('ブラウザーの変換中')).rows.length, 2);
  await cdp.send('Input.insertText', { text: '日本' }); await page.waitForTimeout(100);
  check('ブラウザーの日本語確定も引用外', (await snap('ブラウザーの日本語確定')).raw, '> a\n\n日本');
  await cdp.send('Input.imeSetComposition', { text: '取消', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  check('変換取消でも境界を保つ', (await snap('ブラウザーの変換取消')).raw, '> a\n\n日本');
  await cdp.detach();
  for (const raw of ['> a\nb', '- a\nb', '1. a\nb', '> > a\n> b', '> a\n\nb']) {
    await reset(raw); check('既存原文の保持 ' + raw, (await snap('既存原文')).raw, raw);
  }
  const events = await page.evaluate(() => window.__exitEvents ?? []);
  const recorded = evidence.flatMap(x => x.events);
  check('文字入力はブラウザーのbeforeinput/inputを通る', ['beforeinput', 'input'].every(event => recorded.some(e => e.event === event && e.type === 'insertText' && e.trusted)));
  return { checks, evidence, events, passed: checks.every(c => c.passed) };
}
