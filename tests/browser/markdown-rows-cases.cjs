// Run on an isolated fake server (no real data). Types the keystroke cases of ADR 0301 with the real keyboard and IME,
// and pastes with ClipboardEvent (text/plain and text/html).
async page => {
  const checks = [], evidence = [], K = page.keyboard;
  const check = (name, got, want = true) => checks.push({ name, passed: JSON.stringify(got) === JSON.stringify(want), got, want });
  // 行ごとに、入力欄の見え方（DOM の種類・引用の線の数・行の項目の数）と、送る Markdown を履歴と同じ読み方で読んだ深さ
  const snap = () => page.evaluate(async () => {
    const p = document.querySelector('#prompt'), state = p.editor.getState();
    const { posToOffset, rowTree } = await import('/md-doc.mjs'), { parseStructure } = await import('/md-structure.mjs');
    const raw = p.value, sent = parseStructure(raw.split('\n')).lines, tree = rowTree(state.blocks).info;
    const depth = n => { let q = 0, item = 0; for (; n; n = n.parent) { q += n.t === 'bq'; item += n.t === 'item'; } return [q, item]; };
    return { raw, rows: [...p.children].map((d, i) => {
      const line = raw.slice(0, posToOffset(state.blocks, { b: i, v: 0 })).split('\n').length - 1;
      return { k: d.dataset.k, q: +(d.dataset.q ?? 0), item: depth(tree[i]?.node)[1], text: d.textContent, sent: depth(sent[line]?.node), model: state.blocks[i].kind };
    }) };
  });
  const view = s => s.rows.map(r => `${r.k}:${r.q}:${r.item}:${r.text}`);
  const cdp = await page.context().newCDPSession(page);
  const ime = async text => { await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 }); await cdp.send('Input.insertText', { text }); };
  const paste = (plain, html) => page.evaluate(([plain, html]) => {
    const d = new DataTransfer(); d.setData('text/plain', plain); if (html) d.setData('text/html', html);
    document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
  }, [plain, html]);
  const KEYS = { ' ': 'Space', shiftEnter: 'Shift+Enter', enter: 'Enter', backspace: 'Backspace', del: 'Delete', left: 'ArrowLeft', up: 'ArrowUp', end: 'End', tab: 'Tab', undo: 'Control+z' };
  // 引き金にならない字（打った行もほかの行も入れ物が変わらない）
  const plainChar = k => typeof k === 'string' && k.length === 1 && !' >-.0123456789'.includes(k);
  const press = async k => {
    if (Array.isArray(k)) await (k[0] === 'ime' ? ime(k[1]) : paste(k[1], k[2]));
    else if (KEYS[k]) await K.press(KEYS[k]);
    else await K.type(k);
    await page.waitForTimeout(40);
  };
  const run = async (name, keys, { seed = '', want = null, raw = null } = {}) => {
    await page.evaluate(seed => { const p = document.querySelector('#prompt'); p.value = seed; p.focus(); p.setSelectionRange(seed.length, seed.length); }, seed);
    await page.waitForTimeout(60);
    let before = await snap(), broken = [];
    for (const k of keys) {
      await press(k);
      const s = await snap();
      // SENT: 字のある行の見え方の深さが、送る Markdown を履歴と同じ読み方で読んだ深さと同じ。DOM の種類は行の種類と同じ
      for (const [i, r] of s.rows.entries()) {
        if (r.k !== r.model) broken.push(['DOM', JSON.stringify(k), i, r.k, r.model]);
        if (r.text.trim() && r.k !== 'code' && r.k !== 'att' && [r.q, r.item].join() !== r.sent.join()) broken.push(['SENT', JSON.stringify(k), i, [r.q, r.item], r.sent]);
      }
      // TYPE: 引き金にならない字を打っても、どの行の種類と深さも変わらない
      const ty = r => `${r.k}:${r.q}:${r.item}`;
      if ((plainChar(k) || k[0] === 'ime') && JSON.stringify(s.rows.map(ty)) !== JSON.stringify(before.rows.map(ty))) broken.push(['TYPE', JSON.stringify(k), before.rows.map(ty), s.rows.map(ty)]);
      before = s;
    }
    evidence.push({ name, raw: before.raw, rows: view(before) });
    check(`${name}: 打鍵ごとに見え方・送る形・履歴の深さが同じで、字を打っても行が動かない`, broken, []);
    if (want) check(`${name}: 行（種類:引用の数:項目の数:字）`, view(before), want);
    if (raw !== null) check(`${name}: 送る Markdown`, before.raw, raw);
  };
  await page.waitForTimeout(1200);
  await page.evaluate(() => { for (const b of document.querySelectorAll('dialog[open] button')) if (b.textContent === 'あとで') b.click(); });
  await page.click('#prompt');

  // 報告 1 章: 引用の Shift+Enter の後の Backspace（ADR 0301: 空の引用の Shift+Enter は引用の行を足す）
  const q2 = ['>', ' ', 'a', 'shiftEnter', 'shiftEnter'];
  await run('user-bs1-b', [...q2, 'backspace', 'b'], { want: ['quote:1:0:a', 'quote:1:0:', 'p:0:0:b'], raw: '> a\n> \nb' });
  await run('user-bs2-b', [...q2, 'backspace', 'backspace', 'b'], { want: ['quote:1:0:a', 'quote:1:0:b'], raw: '> a\n> b' });
  await run('user-bs1-ja', [...q2, 'backspace', ['ime', 'あ']], { want: ['quote:1:0:a', 'quote:1:0:', 'p:0:0:あ'], raw: '> a\n> \nあ' });
  await run('user-bs1-space', [...q2, 'backspace', ' '], { want: ['quote:1:0:a', 'quote:1:0:', 'p:0:0: '] });
  await run('user-bs1-gt', [...q2, 'backspace', '>'], { want: ['quote:1:0:a', 'quote:1:0:', 'p:0:0:>'], raw: '> a\n> \n\\>' });
  await run('user-up-del-b', [...q2, 'up', 'del', 'b'], { want: ['quote:1:0:a', 'quote:1:0:b'], raw: '> a\n> b' });
  await run('user-top-del-b', [...q2, 'up', 'up', 'end', 'del', 'b'], { want: ['quote:1:0:ab', 'quote:1:0:'] });
  await run('user-bs1-down-b', [...q2, 'b'], { want: ['quote:1:0:a', 'quote:1:0:', 'quote:1:0:b'] });
  await run('enter-bs1-b', ['>', ' ', 'a', 'enter', 'enter', 'backspace', 'b'], { want: ['quote:1:0:ab'], raw: '> ab' });

  // 報告 2 章: 系統ごとの代表
  await run('A-quote2-bs1-b', ['>', ' ', '>', ' ', 'a', 'shiftEnter', 'shiftEnter', 'backspace', 'b'], { want: ['quote:2:0:a', 'quote:2:0:', 'quote:1:0:b'] });
  await run('A-quote-bs1-undo', [...q2, 'backspace', 'b', 'undo'], { want: ['quote:1:0:a', 'quote:1:0:', 'p:0:0:'] });
  // 読み込んだ遅延の続きの行は引用に見え、手を入れると記号を付けて送る（S1）
  await run('A-lazy-load-edit', ['up', 'end', 'backspace', ['ime', 'あ']], { seed: '> a\nb', want: ['quote:1:0:あ', 'quote:1:0:b'], raw: '> あ\n> b' });
  await run('B-ul-start-shift2', ['-', ' ', 'a', 'left', 'shiftEnter', 'shiftEnter']);
  // モック 4: 項目の字の頭の Shift+Enter は、送っても入れ子のまま（区切りを足す）
  await run('B-nested-start-shift', ['-', ' ', 'a', 'enter', 'tab', 'b', 'left', 'shiftEnter'], { want: ['ul:0:1:a', 'ul:0:2:', 'cont:0:2:b'], raw: '- a\n\n  - \n    b' });
  await run('B-quote-ol-enter-bs-a', ['>', ' ', '1', '.', ' ', 'a', 'enter', 'backspace', 'a'], { want: ['ol:1:1:a', 'quote:1:0:a'], raw: '> 1. a\n>\n> a' });
  // モック 3: 項目の字の頭の空白は送らず、項目の記号は消えない
  await run('C-ul-lead-space', ['-', ' ', 'a', 'left', ' '], { want: ['ul:0:1: a'], raw: '- a' });
  await run('C-ol-empty-space-b', ['1', '.', ' ', 'a', 'backspace', ' ', 'b'], { want: ['ol:0:1: b'], raw: '1. b' });
  // モック 2: 項目の頭の `> `・`- ` は Space で確定する
  await run('D-ul-quote', ['-', ' ', '>', ' ', 'a'], { want: ['quote:1:1:a'], raw: '- > a' });
  await run('D-ul-ul', ['-', ' ', '-', ' ', 'a'], { want: ['ul:0:2:a'], raw: '- - a' });
  // モック 5: Space の無い `>a` は字のまま送る（S3）
  await run('mock-gt-no-space', ['>', 'a'], { want: ['p:0:0:>a'], raw: '\\>a' });

  // 貼り付け: 貼る前の行の入れ物に、貼った行が入る。その後の Enter・字も引用の中
  await run('paste-empty-multi-enter-z', ['>', ' ', ['paste', 'x\ny'], 'enter', 'z'], { want: ['quote:1:0:x', 'quote:1:0:y', 'quote:1:0:z'], raw: '> x\n> y\n> z' });
  await run('paste-end-htmlbr-shift-ime', ['>', ' ', 'a', ['paste', 'x\ny', '<div><span>x</span><br><span>y</span></div>'], 'shiftEnter', ['ime', '日本']], { want: ['quote:1:0:ax', 'quote:1:0:y', 'quote:1:0:日本'] });
  await run('paste-empty-htmlbq-enter-z', ['>', ' ', ['paste', 'q\n\ny', '<blockquote><p>q</p></blockquote><p>y</p>'], 'enter', 'z'], { want: ['quote:2:0:q', 'quote:1:0:y', 'quote:1:0:z'] });
  await run('paste-mid-multi-enter-z', ['>', ' ', 'a', 'b', 'left', ['paste', 'x\ny'], 'enter', 'z'], { want: ['quote:1:0:ax', 'quote:1:0:y', 'quote:1:0:zb'] });
  await run('paste-blank-backspace', ['>', ' ', 'a', ['paste', 'x\n\ny'], 'enter', 'backspace', 'z']);

  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.value = ''; });
  return { checks, evidence, passed: checks.every(c => c.passed) };
}
