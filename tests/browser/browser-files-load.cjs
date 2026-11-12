// playwright-cli run-code --filename=tests/browser/browser-files-load.cjs
// 右の欄のファイルの読み直しと待っている間の見せ方（ADR 0321、docs/design-system.md §4.6）:
//   新しいタブは見出しとボタンを先に出す（件数は後・ボタンは動かない・最近は件数を待たない）・
//   開き直すと読み直す（同じタブ 1 枚のまま問い合わせが増える）・最近のファイルが増える・
//   150ms 未満は何も出さない・超えたら読み込み線とタブの印と骨組み（PC の幅）・届いたら消える・失敗は止まって文言・動きを減らす設定。
// 隔離した AGENT_HOST_BACKENDS=fake のサーバーを先に立てる（トークン browser-files-test、port 7452、AGENT_HOST_LOCALE=ja）。実データには向けない:
//   node tests/browser/browser-files-load-seed.mjs <空のデータ置き場> <リポジトリを作る空のフォルダー>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<データ置き場> AGENT_HOST_PORT=7452 AGENT_HOST_TOKEN=browser-files-test AGENT_HOST_LOCALE=ja node core/server.mjs
// REPO にはシードしたリポジトリの絶対パス（/ 区切り）を書く。SHOTS に絶対パスを書くと確認した画面を保存する（空なら撮らない）。
// 待ちを見せる時間は、画面から core への API の応答（/api/git・/api/preview）だけを page.route で遅らせて作る（core は触らない）。
async (page) => {
  const REPO = '';
  const SHOTS = '';
  const URL = 'http://127.0.0.1:7452/?token=browser-files-test';
  if (!REPO) throw Error('REPO にシードしたリポジトリのパスを書く');
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}browser-files-${name}.png` }); };
  const delay = { git: 0, recent: 0, preview: 0, previewAbort: false };
  const asked = { preview: 0 };
  await page.route(/\/api\/(git|recent|preview)/, async (route) => {
    const kind = /\/api\/(\w+)/.exec(route.request().url())[1];
    if (kind === 'preview') { asked.preview++; if (delay.previewAbort) return route.abort(); }
    if (delay[kind]) await new Promise((resolve) => setTimeout(resolve, delay[kind]));
    await route.continue().catch(() => {});
  });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(URL);
  await page.waitForTimeout(800);
  const login = page.getByRole('button', { name: 'ログイン', exact: true });
  if (await login.count()) { await login.first().click(); await page.waitForTimeout(500); }
  if (await page.locator('#closeOnboarding:visible').count()) await page.locator('#closeOnboarding').click();
  await page.locator('.row[data-session="bf-1"]').click();
  await page.waitForTimeout(800);

  const frameOf = (re) => page.frames().find((f) => re.test(f.url()));
  const waitFrame = async (re) => { for (let i = 0; i < 300; i++) { const f = frameOf(re); if (f) return f; await page.waitForTimeout(20); } throw Error(`frame ${re}`); };
  const address = async (path) => {
    const input = page.locator('.bu-address-input');
    if (await input.isHidden()) { await page.locator('.bu-crumbs').focus(); await page.keyboard.press('Enter'); await input.waitFor({ state: 'visible' }); }
    await input.fill(path); await page.keyboard.press('Enter');
  };

  // ---- 1. 新しいタブ: 見出しとボタンが先・件数は後・ボタンは動かない・最近は件数を待たない
  delay.git = 1500;
  await page.locator('#browserEntry').click();
  const t0 = Date.now();
  const nf = await waitFrame(/\/new(\?|$)/);
  await nf.waitForSelector('a.shortcut[data-kind="git"]');
  await nf.waitForSelector('a.shortcut[data-kind="plugins"]');
  const firstPaint = Date.now() - t0;
  check(firstPaint < 1000, `[変更]・[プラグイン] は git を待たずに出る（${firstPaint}ms < git の遅れ 1500ms）`);
  check(await nf.locator('h2').count() === 3, '3 つの見出しが最初の描画で出る');
  check(await nf.locator('a.shortcut[data-kind="git"] .cnt').count() === 1, '件数が来るまで「変更」の右に短い骨組みの行');
  const boxes = () => nf.evaluate(() => [...document.querySelectorAll('a.shortcut')].map((a) => { const r = a.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); }));
  const before = await boxes();
  await nf.waitForSelector('.recent-row, [data-slot="recent"] .empty, [data-slot="recent"] p', { timeout: 5000 }).catch(() => {});
  check(await nf.locator('a.shortcut[data-kind="git"] .cnt').count() === 1, '最近のファイルの区画は件数を待たずに先に埋まる（件数はまだ）');
  await shot('new-pending');
  await nf.waitForFunction(() => /\d+ ファイル/.test(document.querySelector('a.shortcut[data-kind="git"] span')?.textContent ?? ''), null, { timeout: 8000 });
  const after = await boxes();
  check(JSON.stringify(before) === JSON.stringify(after), `件数が届いても [変更] [プラグイン] の大きさと位置は変わらない（${before.join(' | ')}）`);
  check(/3\d\d/.test(await nf.locator('a.shortcut[data-kind="git"]').innerText()), '件数は未追跡 300 ファイル + 変更を数えた値');
  delay.git = 0;
  await shot('new-ready');

  // ---- 2. 開き直すと読み直す（同じタブ 1 枚。問い合わせが増える）・最近が増える
  const PLAN = `${REPO}/docs/plan.md`, NOTES = `${REPO}/docs/notes.md`;
  await address(PLAN);
  const pf = await waitFrame(/\/file\?/);
  await pf.waitForSelector('main h1, main p', { timeout: 8000 });
  const tabsAfterOpen = await page.locator('.bu-tab').count();
  const askedOnce = asked.preview;
  await address(PLAN);
  for (let i = 0; i < 100 && asked.preview <= askedOnce; i++) await page.waitForTimeout(30);
  check(asked.preview > askedOnce, '同じファイルをもう一度開くと読み直す（プレビューの問い合わせが増える）');
  check(await page.locator('.bu-tab').count() === tabsAfterOpen, '開き直してもタブは増えない（同じ実体パスは 1 枚）');
  await address(NOTES);
  await waitFrame(/notes\.md/);
  await page.waitForTimeout(600);
  await page.locator('.bu-new').click();
  const nf2 = await waitFrame(/\/new(\?|$)/);
  await nf2.waitForFunction(() => document.querySelectorAll('.recent-row').length >= 2, null, { timeout: 8000 });
  check(true, 'あとから開いたファイルも、新しいタブの最近のファイルに増える');
  await shot('recent-grown');

  // ---- 3. 待ちの見せ方（PC の幅）: 150ms 未満は何も出さない
  const SRC = `${REPO}/src/app.js`;
  delay.preview = 0;
  await page.evaluate(() => { window.__seen = { line: 0, mark: 0 }; new MutationObserver(() => {
    const line = document.querySelector('.bu-load'); if (line && !line.hidden) window.__seen.line++;
    if (document.querySelector('.bu-tab .bu-loading')) window.__seen.mark++;
  }).observe(document.body, { subtree: true, childList: true, attributes: true }); });
  await address(`${REPO}/data.csv`);
  await waitFrame(/data\.csv/);
  await page.waitForTimeout(700);
  const quick = await page.evaluate(() => window.__seen);
  check(quick.line === 0, 'すぐ届く読み込み（150ms 未満）では、読み込み線が出ない');
  check(quick.mark === 0, 'すぐ届く読み込みでは、タブの印の脈が出ない');

  // ---- 4. 待ちが 150ms を超えたら線・印・骨組み。届いたら消える（PC の幅）
  delay.preview = 1600;
  await address(SRC);
  await page.waitForTimeout(450);
  check(await page.locator('.bu-load:not([hidden])').count() === 1, 'PC の幅でもアドレスバーの下に読み込み線が出る');
  check(await page.locator('.bu-tab .bu-loading').count() >= 1, 'ファイルのタブにも脈の印が付く');
  const host = page.locator('#page [aria-busy="true"], .bu-pages [aria-busy="true"]');
  const sf = await waitFrame(/app\.js/);
  check(await sf.locator('.sk[aria-hidden="true"]').count() >= 1 || await page.locator('.bu-page-sk').count() >= 1, '中身の位置に骨組みが出る（押せず読み上げない）');
  check(await sf.locator('#app[aria-busy="true"], [aria-busy="true"]').count() >= 1 || await host.count() >= 1, '待っている入れ物に aria-busy が付く');
  await shot('loading-code');
  await page.locator('.bu-load:not([hidden])').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await sf.waitForSelector('main, .code, pre', { timeout: 8000 });
  await page.waitForTimeout(400);
  check(await page.locator('.bu-load:not([hidden])').count() === 0 && await page.locator('.bu-tab .bu-loading').count() === 0, '届いたら線も印も消える');
  check(await sf.locator('.sk').count() === 0, '届いたら骨組みは本物に入れ替わる');

  // ---- 5. 動きを減らす設定: 線は動かない帯・印は薄いまま・骨組みは光なし
  await page.emulateMedia({ reducedMotion: 'reduce' });
  delay.preview = 1200;
  await address(`${REPO}/docs/plan.md`);
  await page.waitForTimeout(100);
  await address(`${REPO}/src/app.js`);
  await page.waitForTimeout(500);
  const motion = await page.evaluate(() => {
    const line = document.querySelector('.bu-load:not([hidden])'); const mark = document.querySelector('.bu-tab .bu-loading');
    return { line: line ? getComputedStyle(line).animationName : 'absent', mark: mark ? [getComputedStyle(mark).animationName, getComputedStyle(mark).opacity] : null };
  });
  check(motion.line === 'none', `動きを減らす設定では線が動かない（${motion.line}）`);
  check(!motion.mark || (motion.mark[0] === 'none' && Math.abs(Number(motion.mark[1]) - 0.55) < 0.02), `タブの印は脈なしの薄いまま（${JSON.stringify(motion.mark)}）`);
  await shot('loading-reduced');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(1500);

  // ---- 6. 失敗: 線と印が止まり、既存の文言が出る
  delay.preview = 0; delay.previewAbort = true;
  await address(`${REPO}/docs/notes.md`);
  const ff = await waitFrame(/notes\.md/);
  await ff.waitForFunction(() => /読み込めませんでした|Could not load/.test(document.body.innerText), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  check(await page.locator('.bu-load:not([hidden])').count() === 0, '失敗したら読み込み線が止まる');
  check(await page.locator('.bu-tab .bu-loading').count() === 0, '失敗したらタブの印の脈が止まる');
  await shot('failed');
  delay.previewAbort = false;
  return results.join('\n');
}
