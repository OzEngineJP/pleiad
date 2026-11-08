// Run on an authenticated, isolated fake server with a chat already created.
// This suite sends real posts and restores drafts; never use production data.
async page => {
  const checks = [], evidence = [], K = page.keyboard;
  const check = (name, got, want = true) => checks.push({ name, passed: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ready = async () => {
    await page.waitForTimeout(1400);
    await page.evaluate(() => { for (const b of document.querySelectorAll('dialog[open] button')) if (b.textContent === 'あとで') b.click(); });
    await page.waitForFunction(() => !document.querySelector('#cbox').hasAttribute('aria-busy'));
  };
  const snap = async (name, selector = '#prompt') => {
    const x = await page.evaluate(async selector => {
      const p = document.querySelector(selector);
      const { posToOffset } = await import('/md-doc.mjs'), st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null);
      return { raw: p.value, state: p.editor.getState(), editing: p.editor.snapshotEditing(), rows: [...p.children].map((r, i) => ({ kind: r.dataset.k, q: +(r.dataset.q ?? 0), boundary: sepOf(i) })) };
    }, selector);
    evidence.push({ name, ...x }); return x;
  };
  const base = async (mark = '>', selector = '#prompt') => {
    await page.evaluate(selector => { const p = document.querySelector(selector); p.value = ''; p.focus(); }, selector);
    await K.type(mark); await K.press('Space'); await K.type('a'); await K.press('Enter'); await K.press('Enter');
    return snap('解除 ' + mark, selector);
  };
  const assertRestored = (name, before, after) => check(name, [after.raw, after.editing, after.rows], [before.raw, before.editing, before.rows]);
  // An independent authenticated socket uses the same public commands as the UI.
  const rpc = (op, args = {}) => page.evaluate(([op, args]) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${location.host}/ws${location.search}`), id = 'md-exit-' + Math.random();
    const timer = setTimeout(() => { ws.close(); reject(new Error('RPC timeout: ' + op)); }, 10000);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.kind === 'ready') ws.send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op, args } }));
      if (m.kind === 'response' && m.id === id) { clearTimeout(timer); ws.close(); m.ok ? resolve(m.result) : reject(new Error(String(m.error))); }
    };
  }), [op, args]);
  const show = (id, threadId) => page.evaluate(([id, threadId]) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id, ...(threadId ? { threadId } : {}) } })), [id, threadId]);
  await page.evaluate(() => { if (document.body.classList.contains('channels')) document.querySelector('#groups .row[data-session]:not([data-thread])')?.click(); });
  await ready();
  for (const mark of ['>', '-', '1.']) {
    const empty = await base(mark);
    await page.waitForTimeout(1900); await page.reload(); await ready();
    assertRestored(mark + ' 空の解除行をローカル保存から復元', empty, await snap('空行再読込'));
    await page.evaluate(() => { const p = document.querySelector('#prompt'); p.focus(); p.setSelectionRange(p.value.length, p.value.length); });
    await K.type('b'); const typed = await snap('送信直前');
    const count = await page.evaluate(() => document.querySelectorAll('#log .m.user .body').length);
    await K.press('Control+Enter');
    await page.waitForFunction(n => document.querySelectorAll('#log .m.user .body').length > n, count);
    const sent = await page.evaluate(() => {
      const body = [...document.querySelectorAll('#log .m.user .body')].at(-1);
      const p = [...body.querySelectorAll('p')].find(p => p.textContent === 'b');
      return { raw: body.dataset.raw, outside: !!p && !p.closest('blockquote, li') };
    });
    check(mark + ' 送信履歴でもbは独立した段落', [sent.raw, sent.outside], [typed.raw, true]);
    await page.waitForFunction(() => !document.querySelector('#cbox').hasAttribute('aria-busy'));
  }
  for (const [seed, depth] of [
    ['> > a', [1, 0]], ['> - a', [1, 0]], ['- a\n  - b', [0, 1]],
    ['1. a\n   1. b', [0, 1]], ['> 1. a\n>    - b', [1, 1]],
  ]) {
    await page.evaluate(text => { const p = document.querySelector('#prompt'); p.value = text; p.focus(); p.setSelectionRange(text.length, text.length); }, seed);
    await K.press('Enter'); await K.press('Enter'); await K.type('c');
    const typed = await snap(seed + ' 解除後の送信');
    const count = await page.evaluate(() => document.querySelectorAll('#log .m.user .body').length);
    await K.press('Control+Enter');
    await page.waitForFunction(n => document.querySelectorAll('#log .m.user .body').length > n, count);
    const sent = await page.evaluate(() => {
      const body = [...document.querySelectorAll('#log .m.user .body')].at(-1);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let text; while ((text = walker.nextNode())) if (text.textContent.trim() === 'c') break;
      let q = 0, li = 0;
      for (let n = text?.parentElement; n && n !== body; n = n.parentElement) { q += n.tagName === 'BLOCKQUOTE'; li += n.tagName === 'LI'; }
      return [body.dataset.raw, !!text, [q, li]];
    });
    check(seed + ' 送信履歴でも一段だけ解除', sent, [typed.raw, true, depth]);
    await page.waitForFunction(() => !document.querySelector('#cbox').hasAttribute('aria-busy'));
  }
  const empty = await base(); await page.waitForTimeout(1900);
  await page.waitForFunction(() => document.querySelector('#draftSaved').dataset.state === 'saved');
  await page.evaluate(() => {
    localStorage.removeItem('agent-host-drafts-v1');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key !== 'agent-host-drafts-v1') original.call(this, key, value); };
  });
  await page.reload(); await ready();
  assertRestored('ローカル保存が無くてもサーバーの空行と境界を復元', empty, await snap('サーバーから復元'));
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.focus(); p.setSelectionRange(p.value.length, p.value.length); });
  await K.press('Backspace');
  check('空本文の結合はその場で引用1行', [(await snap('結合直後')).raw, (await snap('結合後の行数')).rows.length], ['> a', 1]);
  await K.press('Control+z');
  assertRestored('結合のUndoで境界つき2行へ戻る', empty, await snap('結合のUndo'));
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.focus(); p.setSelectionRange(p.value.length, p.value.length); });
  await K.type('b'); const draft = await snap('コピー前');
  const copy = await page.evaluate(() => {
    const p = document.querySelector('#prompt'), d = new DataTransfer(); p.focus(); getSelection().selectAllChildren(p);
    p.dispatchEvent(new ClipboardEvent('copy', { clipboardData: d, bubbles: true, cancelable: true })); return d.getData('text/plain');
  });
  check('コピーも送信用の段落境界を含む', copy, draft.raw);
  const copied = await page.evaluate(() => {
    const p = document.querySelector('#prompt'), d = new DataTransfer(); p.focus(); getSelection().selectAllChildren(p);
    p.dispatchEvent(new ClipboardEvent('cut', { clipboardData: d, bubbles: true, cancelable: true })); return d.getData('text/plain');
  });
  check('切取りは送信用の段落境界を含む', copied, draft.raw);
  check('切取り後は空の本文行', [(await snap('切取り後')).raw, (await snap('切取り行数')).rows.length], ['', 1]);
  await K.press('Control+z'); assertRestored('切取りUndoで2編集行と境界を復帰', draft, await snap('切取りUndo'));
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.value = ''; p.focus(); });
  await page.evaluate(text => { const d = new DataTransfer(); d.setData('text/plain', text); document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); }, copied);
  const pasted = await snap('別欄へのMarkdown貼付');
  check('コピーしたMarkdownは同じ送信境界を保つ', pasted.raw, draft.raw);
  for (const raw of ['> a\nb\n\n# title', '> a\nb\n\n```js\nx\n```', '> a\nb\n\n**bold** and `code`']) {
    const at = raw.includes('```') ? raw.indexOf('\nx\n') + 2 : raw.includes('`code`') ? raw.indexOf('code') + 4 : raw.length;
    await page.evaluate(([raw, at]) => { const p = document.querySelector('#prompt'); p.value = raw; p.focus(); p.setSelectionRange(at, at); }, [raw, at]);
    await K.type('z');
    // 編集した後は、どの行も自分の入れ物の記号を全部持って送る（ADR 0301 の S1）。履歴での見え方は元と同じ
    const typedRaw = raw.slice(0, at) + 'z' + raw.slice(at), sent = (await snap('無関係な原文を保持')).raw;
    const sameView = await page.evaluate(async ([a, b]) => { const { renderMarkdown } = await import('/render.mjs'); return renderMarkdown(a) === renderMarkdown(b); }, [sent, typedRaw]);
    check('見出し・コード・装飾を編集すると、引用の続きの行は記号を付けて送り、見え方は変えない ' + raw, [sent, sameView], [typedRaw.replace('> a\nb', '> a\n> b'), true]);
  }

  const suffix = Date.now().toString().slice(-7);
  const ch = await rpc('channels.create', { name: 'md-exit-' + suffix });
  const other = await rpc('channels.create', { name: 'md-other-' + suffix });
  const root = await rpc('channels.post', { channelId: ch.id, text: 'Markdown入力の確認' });
  await show(ch.id); await page.waitForSelector('#chFeedComposerInput');
  await page.waitForFunction(() => !document.querySelector('#chFeed .ch-loading'));
  const feed = await base('>', '#chFeedComposerInput'); await K.type('b'); const feedTyped = await snap('チャンネル入力', '#chFeedComposerInput');
  await page.waitForTimeout(700); await show(other.id); await page.waitForTimeout(350); await show(ch.id); await page.waitForTimeout(350);
  assertRestored('別チャンネルから戻っても境界と2編集行を保持', feedTyped, await snap('チャンネル復元', '#chFeedComposerInput'));
  await show(ch.id, root.id); await page.waitForSelector('#thPrompt');
  const thread = await base('1.', '#thPrompt'); await K.type('b'); const threadTyped = await snap('スレッド入力', '#thPrompt');
  check('チャンネルとスレッドで同じ解除規則', [feed.rows.length, feedTyped.rows[1].boundary, thread.rows.length, threadTyped.rows[1].boundary], [2, '', 2, '']);
  await page.waitForTimeout(2500); await page.reload(); await ready();
  await show(ch.id, root.id); await page.waitForSelector('#thPrompt'); await page.waitForTimeout(700);
  assertRestored('スレッド下書きを再読込しても行数と境界を保持', threadTyped, await snap('スレッド復元', '#thPrompt'));
  assertRestored('スレッドの下書きがチャンネルへ混ざらない', feedTyped, await snap('チャンネルは独立', '#chFeedComposerInput'));
  await page.evaluate(() => { const p = document.querySelector('#thPrompt'); p.focus(); p.setSelectionRange(p.value.length, p.value.length); });
  await K.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#thPrompt').value === '');
  const replies = await rpc('channels.read', { channelId: ch.id, threadId: root.id });
  check('スレッド送信も段落境界を保持', replies.posts.at(-1).text, threadTyped.raw);
  await page.click('button[aria-label="スレッドを閉じる"]');
  await show(ch.id); await page.waitForTimeout(350);
  await page.evaluate(() => { const p = document.querySelector('#chFeedComposerInput'); p.focus(); p.setSelectionRange(p.value.length, p.value.length); });
  await K.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#chFeedComposerInput').value === '');
  const posts = await rpc('channels.read', { channelId: ch.id });
  check('チャンネル送信も段落境界を保持', posts.posts.at(-1).text, feedTyped.raw);
  await page.evaluate(() => document.querySelector('#groups .row[data-session]:not([data-thread])')?.click());
  return { checks, evidence, passed: checks.every(c => c.passed) };
}
