// playwright-cli run-code --filename=tests/browser/channels-todo.cjs
// スレッドと DM の ToDo（ADR 0358。Chats と同じ部品 web/session-todo.mjs を、スレッド・DM の頭の入口から開く）:
//   - スレッドの頭の ToDo の入口は、そのスレッドの bot の会話ができてから出る。件数は入口の名前に出て、押すとスレッドの上に Chats と同じ浮く面が開く。
//   - 中身はスレッドごと（別のスレッドへ移ると替わる）。bot が（ここでは操作で）ToDo を足すと、開いていなくても入口の名前の件数が変わる。
//   - DM の頭の入口は、DM の会話（bot の dmSessionId）ができてから出る。bot ページ・ほかの面へ集計は出さない。
//   - 狭い画面（360px）のスレッドの頭は、検索の虫眼鏡と ⋮ と ✕ だけ。ToDo は ⋮ のメニューの先頭「ToDo · n/m 完了」から、下からのシートで開く。入力欄の案内は「スレッドに返信」だけ。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (port 7436, token thread-deck-test):
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_FAKE_USAGE=1 AGENT_HOST_WORKTREES=off AGENT_HOST_LOCALE=ja AGENT_HOST_TOKEN=thread-deck-test AGENT_HOST_PORT=7436 AGENT_HOST_DATA=<一時の置き場> node core/server.mjs
// Never run against live data（新しい置き場で。bot・チャンネル・スレッドは本物の操作で作る）。
async page => {
  const URL = 'http://127.0.0.1:7436/?token=thread-deck-test';
  const results = [];
  const check = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  const sleep = (ms) => page.waitForTimeout(ms);
  const until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(80); }
    throw Error('timeout: ' + label + ' ' + JSON.stringify(last ?? null).slice(0, 300));
  };

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  await page.addInitScript(() => {
    if (window.__tdWrapped) return;
    window.__tdWrapped = true;
    window.__sockets = [];
    window.__calls = new Map();
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          try {
            const m = JSON.parse(e.data);
            const call = m.kind === 'response' ? window.__calls.get(m.id) : null;
            if (call) { window.__calls.delete(m.id); if (m.ok) call.res(m.result); else call.rej(new Error(String(m.error))); return; }
          } catch {}
          return fn(e);
        });
      }
      get onmessage() { return super.onmessage; }
    };
    window.__rpc = (op, args = {}) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op, args } }));
    });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);

  // ---- 準備: bot・チャンネル・スレッド 2 本（本物の操作で）
  const bots = (await rpc('bots.list')).bots ?? [];
  const owl = bots.find((b) => b.name === 'Owl') ?? await rpc('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
  const ch = (await rpc('channels.list')).channels?.find((c) => c.name === 'todo-test') ?? await rpc('channels.create', { name: 'todo-test', purpose: 'ToDo の確認', members: [owl.id] });
  const A = await rpc('channels.post', { channelId: ch.id, text: '@Owl 集計の SQL を直したい' });
  const B = await rpc('channels.post', { channelId: ch.id, text: '@Owl 別件: ログの形を揃えたい' });
  const sessionOf = async (threadId) => (await rpc('channels.read', { channelId: ch.id, threadId })).threads.find((th) => th.threadId === threadId)?.sessions?.[owl.id] ?? null;
  const settledTurn = async (threadId) => (await rpc('channels.read', { channelId: ch.id, threadId })).posts.some((p) => p.turn && p.state === 'done');
  await until(() => settledTurn(A.id), 'A done');
  await until(() => settledTurn(B.id), 'B done');
  const sa = await until(() => sessionOf(A.id), 'A session'), sb = await until(() => sessionOf(B.id), 'B session');
  check(sa !== sb, 'each thread has its own bot conversation');
  const todoCount = (sid) => rpc('todos.list', { sessionId: sid }).then((r) => (r.items ?? []).length);

  // ================================================================ スレッド
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator(`#chFeed .post[data-post-id="${A.id}"] .thread-summary`).click();
  await page.locator('#chThread .post').first().waitFor();
  const entry = page.locator('#chThread .th-todo');
  await until(() => entry.isVisible(), 'the thread ToDo entry shows once the bot conversation exists');
  check(await page.locator('#chThread .th-entries > *').evaluateAll((els) => els.map((e) => e.className.split(' ').find((c) => /^th-|^voice/.test(c)) ?? '').filter((c) => /th-todo|th-toc|th-browser/.test(c)).join())
    === 'th-todo,th-toc,th-browser', 'the head order is ToDo, search (toc), browser');
  check(!(await page.locator('#todoEntry').isVisible()), 'the Chats ToDo entry is not shown on the Channels face');
  check(/ToDo/.test(await entry.getAttribute('aria-label')), 'the entry has a name (ToDo)', await entry.getAttribute('aria-label'));

  await rpc('todos.add', { sessionId: sa, items: [{ text: 'SQL の集計を直す' }, { text: 'テストを足す' }] });
  await until(async () => /0\/2/.test(await entry.getAttribute('aria-label')), 'the entry name shows 0/2 after the ToDo is added (not open)');
  await entry.click();
  const pop = page.locator('#chThread > .todo-pop');
  await until(() => pop.isVisible(), 'the ToDo surface opens inside the thread');
  const texts = (await pop.locator('.td-canvas > .td-item .td-text').allTextContents()).map((x) => x.trim());
  check(texts.join('|') === 'SQL の集計を直す|テストを足す', 'the surface shows this thread\'s ToDo', texts);
  check(await entry.getAttribute('aria-expanded') === 'true', 'the entry shows it is open');
  await page.keyboard.press('Escape');
  await until(async () => !(await pop.isVisible()), 'Escape closes the surface');

  // 別のスレッドへ: 中身が替わる（B はまだ ToDo が無い）
  await page.locator('#chThread .th-close').click();
  await page.locator(`#chFeed .post[data-post-id="${B.id}"] .thread-summary`).click();
  await until(async () => (await page.locator('#chThread .th-title').textContent()).includes('別件'), 'thread B is open');
  await until(async () => !/\d\/\d/.test(await entry.getAttribute('aria-label')), 'thread B has its own (empty) ToDo');
  await rpc('todos.add', { sessionId: sb, items: [{ text: 'ログの形を決める' }] });
  await until(async () => /0\/1/.test(await entry.getAttribute('aria-label')), 'thread B shows its own count');
  check(await todoCount(sa) === 2 && await todoCount(sb) === 1, 'the two threads keep separate lists');
  await page.locator('#chThread .th-close').click();
  await page.locator(`#chFeed .post[data-post-id="${A.id}"] .thread-summary`).click();
  await until(async () => /0\/2/.test(await entry.getAttribute('aria-label')), 'back in thread A the count is A\'s');

  // ================================================================ DM
  const dmId = (await rpc('bots.list')).bots.find((b) => b.id === owl.id).dmChannelId;
  check(dmId, 'the bot has a DM channel');
  await page.locator('#chThread .th-close').click().catch(() => {});
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), dmId);
  await page.locator('#chFeed > .top > .ch-more').waitFor();
  const dmEntry = page.locator('#chFeed > .top > .ch-todo');
  check(await dmEntry.count() === 1 && !(await dmEntry.isVisible()), 'the DM ToDo entry is hidden until the DM conversation exists');
  await rpc('channels.post', { channelId: dmId, text: 'こんにちは' });
  await until(async () => (await rpc('bots.list')).bots.find((b) => b.id === owl.id).dmSessionId, 'DM session');
  await until(() => dmEntry.isVisible(), 'the DM ToDo entry shows once the DM conversation exists');
  const order = await page.locator('#chFeed > .top > .ch-head-x').evaluateAll((els) => els.map((e) => e.className.split(' ').find((c) => /ch-todo|ch-more/.test(c)) ?? '').filter(Boolean).join());
  check(order === 'ch-todo,ch-more', 'the DM entry sits just before the ⋮', order);
  const dmSession = (await rpc('bots.list')).bots.find((b) => b.id === owl.id).dmSessionId;
  await rpc('todos.add', { sessionId: dmSession, items: [{ text: 'DM で頼まれたこと' }] });
  await until(async () => /0\/1/.test(await dmEntry.getAttribute('aria-label')), 'the DM entry shows its count');
  await dmEntry.click();
  const dmPop = page.locator('#channelsView > .todo-pop');
  await until(() => dmPop.isVisible(), 'the DM ToDo surface opens');
  const dmTexts = (await dmPop.locator('.td-canvas > .td-item .td-text').allTextContents()).map((x) => x.trim());
  check(dmTexts.join('|') === 'DM で頼まれたこと', 'the DM surface shows the DM conversation\'s ToDo', dmTexts);
  await page.keyboard.press('Escape');
  // チャンネルへ移ると DM の入口は外れ、チャンネルの頭には ToDo を出さない
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await until(async () => !(await dmEntry.isVisible()), 'the DM entry goes away on a channel');
  check(await page.locator('#chFeed > .top > .ch-todo').count() === 0, 'a channel head has no ToDo entry');

  // ================================================================ 狭い画面（360px）のスレッドの頭
  await page.setViewportSize({ width: 360, height: 740 });
  await page.locator(`#chFeed .post[data-post-id="${A.id}"] .thread-summary`).click();
  await page.locator('#chThread .post').first().waitFor();
  await until(async () => /\d\/\d/.test(await entry.getAttribute('aria-label')), 'the thread ToDo is loaded at 360px');
  const shown = await page.evaluate(() => [...document.querySelectorAll('#chThread .th-top button')]
    .filter((b) => b.getClientRects().length && !b.closest('.th-crumb')).map((b) => b.className.split(' ').find((c) => /^th-/.test(c)) ?? '').join());
  check(shown === 'th-side,th-toc,th-more,th-close', 'at 360px the head has only ☰, search, ⋮ and ✕', shown);
  check(await page.locator('#thPrompt').getAttribute('placeholder') === 'スレッドに返信', 'at 360px the input hint is just 「スレッドに返信」', await page.locator('#thPrompt').getAttribute('placeholder'));
  await page.locator('#chThread .th-more').click();
  const menu = page.locator('.pop.menu:not([hidden]):not(.context-meter-pop)');
  await until(() => menu.isVisible(), 'the ⋮ menu opens');
  const labels = (await menu.locator('.li .lbl').allTextContents()).map((x) => x.trim());
  check(/^ToDo · 0\/2 完了/.test(labels[0] ?? ''), 'the first item of the ⋮ menu is 「ToDo · n/m 完了」', labels);
  check(labels.includes('AI にタイトルを考えてもらう'), 'the ⋮ menu has the title suggestion', labels);
  await menu.locator('.li').first().click();
  const sheet = page.locator('#chThread > .todo-pop');
  await until(() => sheet.isVisible(), 'the ToDo opens from the ⋮ menu');
  const box = await sheet.boundingBox();
  check(box && box.y + box.height >= 740 - 2 && box.width >= 340, 'at 360px the ToDo is a bottom sheet', box);
  await page.keyboard.press('Escape');
  await until(async () => !(await sheet.isVisible()), 'Escape closes the sheet');
  // 虫眼鏡: 下からのシートの検索欄にカーソルが入る
  await page.locator('#chThread .th-toc').click();
  await until(() => page.evaluate(() => document.activeElement?.classList.contains('toc-query')), 'the cursor is in the search box');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 820 });
  // Ctrl+F: スレッドを見ている間は、虫眼鏡と同じ面（目次と検索）が開き、検索欄にカーソルが入る（入力欄にカーソルがあっても）
  await page.locator('#thPrompt').click();
  await page.keyboard.press('Control+f');
  await until(() => page.evaluate(() => document.activeElement?.classList.contains('toc-query')), 'Ctrl+F opens the thread search with the cursor in its box');
  results.push('Ctrl+F opens the thread search with the cursor in its box');
  return results;
}
