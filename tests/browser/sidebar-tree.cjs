// Isolated fake server only. Seed 18/50 sessions (at least 6 with the same status) and 4/10 channels.
// Run with the existing dedicated browser; this test never launches a browser or reads real data.
async (page, { url = page.url() } = {}) => {
  const results = [];
  const check = (ok, text) => { if (!ok) throw Error(text); results.push(text); };
  await page.evaluate(() => localStorage.removeItem('agent-host-side'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await page.locator('#closeOnboarding').click({ timeout: 1500 }).catch(() => {});
  await page.locator('#backToChat').click({ timeout: 1000 }).catch(() => {});
  await page.locator('#groups .chsec').first().waitFor();
  check(await page.locator('#sideOrder').count() === 0, 'one tree without the order switch');
  const home = page.locator('[data-side-key="chsec:home"]');
  const headings = await page.locator('#groups > .chsec > .grp-head .chsec-name').allTextContents();
  check(headings[0] === '一時チャット' && headings.slice(1).join() === [...headings.slice(1)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).join(), 'home then channels by name');
  check(await home.locator('.grp .row[data-session]').count() > 0, 'status groups are nested inside home');
  check(await page.locator('#groups .bot-waits').count() === 0, 'waiting does not get a separate section');

  const statusMore = home.locator('.grp .row.more').first();
  if (await statusMore.count()) {
    const before = await home.locator('.grp .row[data-session]').count();
    await statusMore.click();
    check(await home.locator('.grp .row[data-session]').count() > before, 'status more row expands the hidden chats');
    await statusMore.click();
    check(await home.locator('.grp .row[data-session]').count() === before, 'show less restores the five-chat limit');
  }

  const inProgress = page.locator('[data-side-key="group:進行中"]');
  const review = page.locator('[data-side-key="group:レビュー待ち"]');
  // Choose an imported row. Moving it must update the real server, not just the DOM.
  const source = inProgress.locator('.row[data-session]').first();
  const id = await source.getAttribute('data-session');
  await source.dragTo(review.locator(':scope > .grp-head'));
  await review.locator(`.row[data-session="${id}"]`).waitFor();
  check(await review.locator(`.row[data-session="${id}"]`).count() === 1, 'dragging a quick chat changes its status');
  await review.locator(`.row[data-session="${id}"]`).dragTo(inProgress.locator(':scope > .grp-head'));
  await inProgress.locator(`.row[data-session="${id}"]`).waitFor();

  const channel = page.locator('#groups > .chsec:not([data-side-key="chsec:home"])').first();
  check(await channel.locator('.row[data-thread]').count() === 3, 'channels initially show three recent threads');
  const thread = channel.locator('.row[data-thread]').first();
  check(await thread.getAttribute('draggable') !== 'true' && await thread.locator('.row-status[aria-label]').count() === 1, 'channel rows have status icons and do not drag');
  await thread.click({ button: 'right' });
  await page.getByText('状態を変更', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  check(true, 'thread status is available from its menu');

  // Keyboard nesting: home -> status -> row, then back to both parent headings.
  await page.locator('#groups').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  const activeLevel = () => page.evaluate(() => document.getElementById(document.getElementById('groups').getAttribute('aria-activedescendant'))?.getAttribute('aria-level'));
  check(await activeLevel() === '2', 'right arrow enters the home status headings');
  await page.keyboard.press('ArrowLeft'); // collapse status
  await page.keyboard.press('ArrowLeft'); // parent home
  check(await activeLevel() === '1', 'left arrow from a collapsed status reaches home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check(await activeLevel() === '3', 'right arrow reaches the quick chat row');

  // Fold a status and its parent independently; reopening the parent preserves the child's state.
  await inProgress.locator('.grp-name').click();
  check(await inProgress.locator(':scope > .rows').isHidden(), 'status header collapses');
  await home.locator(':scope > .grp-head .chsec-chev').click();
  await home.locator(':scope > .grp-head .chsec-chev').click();
  check(await inProgress.locator(':scope > .rows').isHidden() && await review.locator(':scope > .rows').isVisible(), 'reopening home preserves each status fold');
  await inProgress.locator('.grp-name').click();

  await page.locator('#filterBtn').click();
  await page.locator('#filterPop .li', { hasText: '進行中' }).click();
  check(await home.locator('.grp').count() === 1 && await page.locator('#groups .cs-sec').count() === 0, 'status filter keeps matching statuses and hides Bots/routines');
  check(await page.locator('#groups .row-status').evaluateAll(ns => ns.every(n => n.getAttribute('aria-label') === '進行中')), 'status filter applies to channel threads too');
  await page.locator('#fchips .x').first().click();
  await page.locator('#filterBtn').click();
  await page.locator('#filterPop [data-backend="fake"]').click();
  await page.keyboard.press('Escape');
  check(await page.locator('#groups > .chsec').count() === 1, 'agent filter hides threads which do not have that value');
  await page.locator('#fchips .x').first().click();

  await page.locator('#q').fill('サイドバー');
  await page.locator('#groups .row.res').first().waitFor();
  check(await page.locator('#groups .grp').count() === 0, 'search stays flat');
  await page.locator('#q').fill('');
  await home.waitFor();
  // Real fake-backend approval: reading the notification must not clear its waiting mark.
  await page.evaluate(async () => {
    const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws${location.search}`);
    const pending = new Map(); let sequence = 0;
    window.__sidebarEvents = [];
    window.__sidebarCmd = (command, args = {}) => new Promise((resolve, reject) => {
      const id = `sidebar-${++sequence}`; pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ kind: 'command', command, args, id }));
    });
    await new Promise(resolve => ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.kind === 'ready') { window.__sidebarHome = m.homeDir; resolve(); }
      if (m.kind === 'event') window.__sidebarEvents.push(m.event);
      if (m.kind === 'response' && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(Error(m.error));
      }
    }));
    window.__sidebarAsk = window.__sidebarCmd('runTurn', { prompt: 'ask', backend: 'fake', mode: 'default', cwd: window.__sidebarHome }).catch(e => String(e));
  });
  const waitFor = async (fn) => { for (let i = 0; i < 80; i++) { const result = await page.evaluate(fn); if (result) return result; await new Promise(r => setTimeout(r, 100)); } throw Error('waiting state timeout'); };
  const permission = await waitFor(() => window.__sidebarEvents.find(e => e.type === 'permission'));
  await page.evaluate(async sid => { await window.__sidebarCmd('setStatus', { sessionId: sid, status: '進行中' }); }, permission.sessionId);
  await waitFor(() => document.querySelector('[data-side-key="group:進行中"] .wait'));
  check(await inProgress.locator('.wait').count() > 0, 'waiting chat stays in its own status');
  await inProgress.locator('.grp-name').click();
  check(await inProgress.locator(':scope > .grp-head .wait').count() === 1, 'collapsed status shows waiting diamond');
  await home.locator(':scope > .grp-head .chsec-chev').click();
  check(await home.locator(':scope > .grp-head .wait').count() === 1, 'collapsed home shows waiting diamond');
  await home.locator(':scope > .grp-head .chsec-chev').click();
  await inProgress.locator('.grp-name').click();
  await page.locator('#notifBell').click();
  await page.locator('#notifPanel .nrow', { hasText: '承認を待っています' }).click();
  check(await page.locator('#notifBell .bell-badge .mark').count() === 1, 'opening a waiting notification preserves the bell diamond');
  await page.locator('#notifBell').click();
  await page.locator('#notifPanel .nhead .btn').click();
  await waitFor(() => document.querySelector('#notifBell .bell-badge')?.textContent === '◆');
  check(true, 'read all removes the unread count but preserves unresolved waiting');
  await page.locator('#notifBell').click();
  await page.evaluate(async id => { await window.__sidebarCmd('resolvePermission', { id, allow: false }); await window.__sidebarAsk; }, permission.id);
  await waitFor(() => !document.querySelector('#notifBell .bell-badge .mark'));
  check(true, 'answering the approval removes the waiting diamond');
  await page.setViewportSize({ width: 390, height: 844 });
  await new Promise(r => setTimeout(r, 400));
  if (!await home.isVisible()) await page.locator('#openSidebar').click();
  check(await home.isVisible() && await home.locator('.grp').count() >= 2, '390px drawer uses the same tree');
  return { passed: true, results };
}
