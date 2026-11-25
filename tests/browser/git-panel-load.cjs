// playwright-cli run-code --filename=tests/browser/git-panel-load.cjs
// git パネルの読み込み（docs/design-system.md「git パネルの読み込み」）: 段ごとの表示（頭と変更の一覧が先・履歴と作業場所は後から骨組み → 入れ替え）・
// 作業場所は開くまで中身を読まない（件数はタブの名前だけ）・動きを減らす設定。
// 会話の始まり ⚑ と「この会話の間」の範囲は ADR 0354 で消した（ターンごとの変更の記録をやめたため）ので、ここでは確かめない。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token git-panel-test, port 7433, AGENT_HOST_LOCALE=ja). Never run against live data:
//   node tests/browser/git-panel-load-seed.mjs <empty data dir> <empty repo dir>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<data dir> AGENT_HOST_PORT=7433 AGENT_HOST_TOKEN=git-panel-test AGENT_HOST_LOCALE=ja node core/server.mjs
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
    await page.locator('#cwdChip .git-br:not([hidden])').waitFor({ state: 'attached', timeout: 60000 });   // git の状態が届くと入力欄のチップにブランチが出る
    sent.length = 0;
    await page.locator('#prompt').click();
    await page.keyboard.press('Control+Shift+G');
  };
  const closePanel = async () => { await page.keyboard.press('Control+Shift+G'); await page.waitForTimeout(300); };
  const rowsReady = () => page.waitForFunction(() => document.querySelectorAll('.gp .cg-row:not(.sk)').length >= 3);

  // ---- 1. 段ごとの表示（gpl-far）
  await openPanel('gpl-far');
  await page.locator('.gp .gp-br .bn').first().waitFor();   // 頭と変更の一覧（gitPanel light）が届いた印。履歴はまだ 1.5 秒遅れている
  check(await page.locator('.gp .cg-row:not(.sk)').count() === 0, 'while history is loading, no commit rows yet');
  check(await page.locator('.gp .cg-row.sk').count() === 6, 'six skeleton rows stand in for the history');
  check(await page.locator('.gp .cg[aria-busy="true"]').count() === 1, 'the graph is marked busy while it fills');
  check(await page.locator('.gp .cg-row.sk .history-line').count() >= 6, 'skeleton rows use the existing shimmer line');
  check(await page.locator('.gp [data-clean], .gp .cl .fr:not(.sk), .gp .cg-row.wt').count() >= 1, 'the change list (or its empty line) is already painted');
  check((await page.locator('.gp-br .bn').first().innerText()).includes('main'), 'the head (branch) is painted before history');
  check(await page.locator('.gp [data-rg]').count() === 0, 'no range bar (the in-conversation range was removed)');
  const skFocusable = await page.evaluate(() => [...document.querySelectorAll('.gp .cg-row.sk')].every((r) => r.tabIndex < 0 && r.getAttribute('aria-hidden') === 'true'));
  check(skFocusable, 'skeleton rows are not focusable and hidden from assistive tech');
  await shot('s1-skeleton');
  const histAsked = sent.filter((x) => x.command === 'gitHistory');
  // 入れ替えの 240ms は短いので、印が付いたことは観察で拾う
  await page.evaluate(() => { window.__sawIn = 0; new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains('in') && m.target.closest('.cg')) window.__sawIn++; }).observe(document.querySelector('.gp'), { subtree: true, attributes: true, attributeFilter: ['class'] }); });
  await rowsReady();
  check(histAsked.length === 1 && histAsked[0].args.through === undefined, 'history is asked once, one page (no page-by-page search for a conversation start)');
  check(await page.locator('.gp .cg-row.sk').count() === 0 && await page.locator('.gp .cg[aria-busy="true"]').count() === 0, 'skeleton rows are gone once history arrives');
  check(await page.evaluate(() => window.__sawIn) > 0, 'arriving rows are marked for the 240ms fade-in');
  await page.waitForTimeout(500);
  check(await page.locator('.gp .in').count() === 0, 'the marker is removed after the animation ends');
  const anim = await page.evaluate(() => { const s = document.createElement('div'); s.className = 'gp'; const i = document.createElement('div'); i.className = 'in'; s.appendChild(i); document.body.appendChild(s); const cs = getComputedStyle(i); const r = { name: cs.animationName, dur: cs.animationDuration, fn: cs.animationTimingFunction }; s.remove(); return r; });
  check(anim.name === 'gp-appear' && anim.dur === '0.24s', 'the swap-in is gp-appear for 240ms');
  check(await page.locator('.gp .startnote, .gp .startmk').count() === 0, 'no conversation-start note or flag');
  check(!sent.some((x) => x.command === 'gitWorktrees' && x.args.only !== 'list'), 'the worktree contents are not read on first open');
  const wl = sent.filter((x) => x.command === 'gitWorktrees');
  check(wl.length === 1 && wl[0].args.only === 'list', 'only the worktree list is asked (one git worktree list), for the tab name');
  await page.waitForFunction(() => /\d+ 件/.test(document.querySelectorAll('.gp-tab')[1]?.getAttribute('aria-label') ?? ''));
  const tabLabels = await page.evaluate(() => [...document.querySelectorAll('.gp-tab')].map((b) => b.getAttribute('aria-label')));
  check(/^Worktree、4 件$/.test(tabLabels[1]), `the worktree count is in the tab's accessible name only (${tabLabels[1]})`);

  // ---- 2. 作業場所のタブ: 開くまで中身は読まない → 開くと骨組みから実物へ
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

  // ---- 3. 動きを減らす設定: 入れ替えは動かさない
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPanel('gpl-far');
  await rowsReady();
  const still = await page.evaluate(() => { const r = document.querySelector('.gp .cg-row'); return { anim: getComputedStyle(r).animationName, inClass: document.querySelectorAll('.gp .in').length }; });
  check(still.anim === 'none' && still.inClass === 0, 'reduced motion: rows swap in without movement');
  await closePanel();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  return results;
}
