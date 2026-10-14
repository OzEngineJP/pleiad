// playwright-cli run-code --filename=tests/browser/git-panel-load.cjs
// git パネルの読み込み（docs/design-system.md「git パネルの読み込み」）: 段ごとの表示（頭と変更の一覧が先・履歴と作業場所は後から骨組み → 入れ替え）・
// 会話の始まり ⚑（読んだ範囲の中なら行に・外なら札 → 「始まりまで読む」→ 畳んで本来の位置に・見つからなければ注記）・
// 作業場所は開くまで中身を読まない（件数はタブの名前だけ）・キーボード・動きを減らす設定。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token git-panel-test, port 7433, AGENT_HOST_LOCALE=ja, AGENT_HOST_GIT_SNAPSHOTS=on). Never run against live data:
//   node tests/browser/git-panel-load-seed.mjs <empty data dir> <empty repo dir>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<data dir> AGENT_HOST_PORT=7433 AGENT_HOST_TOKEN=git-panel-test AGENT_HOST_LOCALE=ja AGENT_HOST_GIT_SNAPSHOTS=on node core/server.mjs
// 骨組みが見える時間を作るため、履歴・作業場所の問い合わせだけ WebSocket の上で遅らせる（画面から core への経路。core は触らない）。
// SHOTS に絶対パスを書くと、確認した画面を保存する（空なら撮らない）。
async (page) => {
  const SHOTS = '';
  const URL = 'http://127.0.0.1:7433/?token=git-panel-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const sent = [];
  const delay = { gitHistory: 1500, gitWorktrees: 1500 };
  await page.routeWebSocket(/127\.0\.0\.1:7433/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      let d = null; try { d = JSON.parse(String(m)); } catch { /* 文字列でないものはそのまま */ }
      if (d?.kind === 'command') sent.push({ command: d.command, args: d.args ?? {}, at: Date.now() });
      const ms = d?.kind === 'command' ? delay[d.command] : 0;
      if (ms) setTimeout(() => server.send(m), ms); else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}git-panel-load-${name}.png` }); };
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(URL);
  await page.waitForTimeout(800);
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();

  const openPanel = async (id) => {
    await page.locator(`.row[data-session="${id}"]`).click();
    await page.locator('#gitEntry:not([hidden])').waitFor({ timeout: 60000 });   // git の状態が届くと入口が出る
    sent.length = 0;
    await page.locator('#prompt').click();
    await page.keyboard.press('Control+Shift+G');
  };
  const closePanel = async () => { await page.keyboard.press('Control+Shift+G'); await page.waitForTimeout(300); };
  const rowsReady = () => page.waitForFunction(() => document.querySelectorAll('.gp .cg-row:not(.sk)').length >= 3);

  // ---- 1. 段ごとの表示（gpl-far）
  await openPanel('gpl-far');
  await page.locator('.gp .rbar [data-rg]').first().waitFor();   // 頭と変更の一覧（gitPanel light）が届いた印。履歴はまだ 1.5 秒遅れている
  check(await page.locator('.gp .cg-row:not(.sk)').count() === 0, 'while history is loading, no commit rows yet');
  check(await page.locator('.gp .cg-row.sk').count() === 6, 'six skeleton rows stand in for the history');
  check(await page.locator('.gp .cg[aria-busy="true"]').count() === 1, 'the graph is marked busy while it fills');
  check(await page.locator('.gp .cg-row.sk .history-line').count() >= 6, 'skeleton rows use the existing shimmer line');
  check(await page.locator('.gp [data-clean], .gp .cl .fr:not(.sk), .gp .cg-row.wt').count() >= 1, 'the change list (or its empty line) is already painted');
  check(await page.locator('.gp .rbar [data-rg]').count() >= 1 && (await page.locator('.gp-br .bn').first().innerText()).includes('main'), 'the head (branch) and the range bar are painted before history');
  const skFocusable = await page.evaluate(() => [...document.querySelectorAll('.gp .cg-row.sk')].every((r) => r.tabIndex < 0 && r.getAttribute('aria-hidden') === 'true'));
  check(skFocusable, 'skeleton rows are not focusable and hidden from assistive tech');
  await shot('s1-skeleton');
  const histAsked = sent.filter((x) => x.command === 'gitHistory');
  // 入れ替えの 240ms は短いので、印が付いたことは観察で拾う
  await page.evaluate(() => { window.__sawIn = 0; new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains('in') && m.target.closest('.cg')) window.__sawIn++; }).observe(document.querySelector('.gp'), { subtree: true, attributes: true, attributeFilter: ['class'] }); });
  await rowsReady();
  const lightAt = sent.find((x) => x.command === 'gitPanel')?.at;
  check(histAsked.length === 1 && histAsked[0].args.through !== true, 'history is asked once, one page (no page-by-page search for the start)');
  check(await page.locator('.gp .cg-row.sk').count() === 0 && await page.locator('.gp .cg[aria-busy="true"]').count() === 0, 'skeleton rows are gone once history arrives');
  check(await page.evaluate(() => window.__sawIn) > 0, 'arriving rows are marked for the 240ms fade-in');
  await page.waitForTimeout(500);
  check(await page.locator('.gp .in').count() === 0, 'the marker is removed after the animation ends');
  const anim = await page.evaluate(() => { const s = document.createElement('div'); s.className = 'gp'; const i = document.createElement('div'); i.className = 'in'; s.appendChild(i); document.body.appendChild(s); const cs = getComputedStyle(i); const r = { name: cs.animationName, dur: cs.animationDuration, fn: cs.animationTimingFunction }; s.remove(); return r; });
  check(anim.name === 'gp-appear' && anim.dur === '0.24s', 'the swap-in is gp-appear for 240ms');
  check(!sent.some((x) => x.command === 'gitWorktrees' && x.args.only !== 'list'), 'the worktree contents are not read on first open');
  const wl = sent.filter((x) => x.command === 'gitWorktrees');
  check(wl.length === 1 && wl[0].args.only === 'list', 'only the worktree list is asked (one git worktree list), for the tab name');
  await page.waitForFunction(() => /\d+ 件/.test(document.querySelectorAll('.gp-tab')[1]?.getAttribute('aria-label') ?? ''));
  const tabLabels = await page.evaluate(() => [...document.querySelectorAll('.gp-tab')].map((b) => b.getAttribute('aria-label')));
  check(/^Worktree、4 件$/.test(tabLabels[1]), `the worktree count is in the tab's accessible name only (${tabLabels[1]})`);

  // ---- 2. 会話の始まりが範囲より前（札 → 始まりまで読む）
  const note = page.locator('.gp .startnote');
  check(await note.count() === 1, 'the start note is shown when the start is older than the range read');
  const noteText = await note.innerText();
  check(/会話の始まり/.test(noteText) && /読み込んだ範囲より前です/.test(noteText) && /始まりまで読む/.test(noteText), 'the note says where the start is and offers the button');
  check(await page.locator('.gp .cg-row .startmk').count() === 0, 'no flag on any row yet');
  await shot('s2-startnote');
  const before = await page.locator('.gp .cg-row:not(.sk)').count();
  // キーボード: ボタンへ Tab で入って Enter
  await page.locator('.gp [data-startfind]').focus();
  const gate = page.evaluate(() => new Promise((r) => { const o = new MutationObserver(() => { const n = document.querySelector('.gp .startnote .sn-t'); if (n && n.classList.contains('pending-glint')) { r(n.textContent); o.disconnect(); } }); o.observe(document.querySelector('.gp'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); setTimeout(() => r(null), 4000); }));
  sent.length = 0;
  await page.keyboard.press('Enter');
  check(await gate === '読み込み中…', 'pressing the button turns the row into the loading state (読み込み中…, pending glint)');
  await shot('s3-startnote-loading');
  await page.waitForFunction(() => !document.querySelector('.gp .startnote') && document.querySelectorAll('.gp .cg-row .startmk').length === 1, null, { timeout: 8000 });
  const through = sent.filter((x) => x.command === 'gitHistory');
  check(through.length === 1 && through[0].args.through === true, 'one request reads on to the start (through)');
  const after = await page.locator('.gp .cg-row:not(.sk)').count();
  check(after > before, `rows were added after the button (${before} → ${after})`);
  check(await page.locator('.gp .startnote').count() === 0 || (await page.locator('.gp [data-start].shut').count()) === 1, 'the note collapses');
  check(await page.locator('.gp .cg-row .startmk').count() === 1, 'the flag now sits on the row of the start');
  const focused = await page.evaluate(() => document.activeElement?.classList?.contains('cg-row') && !!document.activeElement.querySelector('.startmk'));
  check(focused === true, 'focus lands on the flagged row after the read');
  await page.waitForTimeout(900);   // 焦点を合わせた行へのスクロールと入れ替えが落ち着いてから撮る
  await shot('s4-flag-at-real-position');

  // ---- 3. 作業場所のタブ: 開くまで中身は読まない → 開くと骨組みから実物へ
  sent.length = 0;
  await page.locator('.gp-tab[data-t="worktrees"]').click();
  await page.locator('.gp .wrow').first().waitFor();
  check(await page.locator('.gp .wrow.sk, .gp .wrow .m.ph').count() >= 1, 'on opening the tab, skeleton rows / placeholders show while the contents load');
  await page.waitForTimeout(350);
  await shot('s5-worktrees-loading');
  const full = sent.filter((x) => x.command === 'gitWorktrees');
  check(full.length === 1 && full[0].args.only !== 'list', 'opening the tab reads the contents (one request)');
  await page.waitForFunction(() => document.querySelectorAll('.gp .wrow:not(.sk)').length >= 4 && !document.querySelector('.gp .wrow .m.ph'), null, { timeout: 8000 });
  check(await page.locator('.gp .wrow:not(.sk)').count() === 4, 'four worktrees listed (main + three)');
  check((await page.locator('.gp .wrow:not(.sk)').allInnerTexts()).some((x) => /ui-polish/.test(x)), 'names and states are filled in');
  await page.waitForTimeout(350);
  await shot('s6-worktrees-filled');
  await page.locator('.gp-tab[data-t="changes"]').click();
  await closePanel();

  // ---- 4. 始まりが範囲の中（gpl-near）: 札は出ず、⚑ は行に付く
  await openPanel('gpl-near');
  await rowsReady();
  check(await page.locator('.gp .startnote').count() === 0 && await page.locator('.gp .cg-row .startmk').count() === 1, 'start inside the range: the flag is on the row and there is no note');
  await shot('s7-near');
  await closePanel();

  // ---- 5. 始まりが見つからない（gpl-lost）
  await openPanel('gpl-lost');
  await rowsReady();
  const lost = page.locator('.gp .startnote');
  await lost.waitFor();
  check(/この会話の始まりのコミットは見つかりませんでした/.test(await lost.innerText()) && await lost.locator('button').count() === 0, 'start not found: the note says so and offers no button');
  check(await page.locator('.gp .startnote .startmk').count() === 1, 'the note carries the start flag and time');
  await shot('s8-lost');
  await closePanel();

  // ---- 6. 動きを減らす設定: 入れ替えは動かさない
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPanel('gpl-far');
  await rowsReady();
  const still = await page.evaluate(() => { const r = document.querySelector('.gp .cg-row'); return { anim: getComputedStyle(r).animationName, inClass: document.querySelectorAll('.gp .in').length }; });
  check(still.anim === 'none' && still.inClass === 0, 'reduced motion: rows swap in without movement');
  await closePanel();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  return results;
}
