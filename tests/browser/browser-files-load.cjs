// playwright-cli run-code --filename=tests/browser/browser-files-load.cjs
// 右の欄のファイルの読み直しと待っている間の見せ方（ADR 0320、docs/design-system.md §4.6）:
//   新しいタブは見出しとボタンを先に出す（件数は後・ボタンは動かない・最近は件数を待たない）・
//   開き直すと読み直す（同じタブ 1 枚のまま問い合わせが増える）・最近のファイルが増える・
//   150ms 未満は何も出さない・超えたら読み込み線とタブの印と骨組み（PC の幅）・届いたら消える・失敗は止まって文言・動きを減らす設定。
// HTML のスクロール位置の確認（5b）には、書き換えの口も立てる: node tests/browser/browser-files-load-writer.mjs <リポジトリ>（port 7457）
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
    if (delay[kind]) await page.waitForTimeout(delay[kind]);
    await route.continue().catch(() => {});
  });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(URL);
  await page.waitForTimeout(800);
  const login = page.getByRole('button', { name: 'ログイン', exact: true });
  if (await login.count()) { await login.first().click(); await page.waitForTimeout(500); }
  for (let i = 0; i < 40 && !(await page.locator('#closeOnboarding:visible').count()); i++) await page.waitForTimeout(100);   // 初回の案内は遅れて出ることがある
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
  await nf.waitForSelector('.recent-row, [data-slot="recent"] .empty, [data-slot="recent"] p', { timeout: 5000 });   // 届かなければ（timeout）ここで落ちる
  const recentBefore = await nf.locator('.recent-row').count();
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
  await nf2.waitForFunction((n) => document.querySelectorAll('.recent-row').length > n, recentBefore, { timeout: 8000 });
  check(await nf2.locator('.recent-row').count() > recentBefore, `あとから開いたファイルが、新しいタブの最近のファイルに増える（${recentBefore} → ${await nf2.locator('.recent-row').count()}）`);
  await shot('recent-grown');

  // ---- 2b. [変更] の名札は、git の答えを待つ間も「変更」のまま（骨組み → 「git」→「変更」と入れ替わらない）。前の結果は会話ごとに覚えている
  delay.git = 1500;
  const knownFrames = new Set(page.frames());
  await page.locator('.bu-new').click();
  let nf3 = null;
  for (let i = 0; i < 300 && !nf3; i++) { nf3 = page.frames().find((f) => !knownFrames.has(f) && /\/new(\?|$)/.test(f.url())) ?? null; if (!nf3) await page.waitForTimeout(20); }
  if (!nf3) throw Error('2 枚目の新しいタブが出ない');
  await nf3.waitForSelector('a.shortcut[data-kind="git"]');
  const waiting = await nf3.evaluate(() => { const link = document.querySelector('a.shortcut[data-kind="git"]'); return { text: link.querySelector('span')?.textContent ?? '', pending: !!link.querySelector('.shortcut-pending'), cnt: !!link.querySelector('.cnt') }; });
  check(/^変更/.test(waiting.text) && !waiting.pending && waiting.cnt, `覚えている会話では、git の答えを待つ間も名札は「変更」で、件数の所だけ骨組み（「${waiting.text}」）`);
  await nf3.waitForFunction(() => /\d+ ファイル/.test(document.querySelector('a.shortcut[data-kind="git"] span')?.textContent ?? ''), null, { timeout: 8000 });
  delay.git = 0;

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
  const host = page.locator('.bu-page-host[aria-busy="true"]');   // 本体側の入れ物（右の欄のページの箱）
  const sf = await waitFrame(/app\.js/);
  check(await sf.locator('.sk[aria-hidden="true"]').count() >= 1, 'ファイルのページの中身の位置に骨組みが出る（押せず読み上げない）');
  check(await sf.locator('#content[aria-busy="true"]').count() === 1, 'ページの入れ物（#content）に aria-busy が付く');
  check(await host.count() === 1, '本体側の入れ物（.bu-page-host）にも aria-busy が付く');
  await shot('loading-code');
  await page.locator('.bu-load:not([hidden])').waitFor({ state: 'detached', timeout: 8000 });
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

  // ---- 5b. HTML の読み直しはスクロール位置（縦・横）を保つ。短くなったら届くところまで・別のファイルへ替えたら上から（ADR 0320 の読み直しの後も位置が飛ばない）
  delay.preview = 0;
  const WRITER = 'http://127.0.0.1:7457/write';   // tests/browser/browser-files-load-writer.mjs（run-code の中では fs が使えない）
  const rewrite = async (name, body) => { const r = await page.request.post(`${WRITER}?name=${name}`, { data: body }); if (!r.ok()) throw Error(`書き換えられない: ${name}`); };
  const HTML = `${REPO}/page.html`, OTHER = `${REPO}/other.html`;
  const htmlBody = (title, h, w) => `<!doctype html><meta charset="utf-8"><title>p</title><h1>${title}</h1><div style="height:${h}px;width:${w}px">長い</div>`;
  const pos = (f) => f.evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY), maxY: document.documentElement.scrollHeight - innerHeight }));
  const until = async (cond, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) throw Error(`時間切れ: ${what}`); await page.waitForTimeout(40); } };
  await rewrite('page.html', htmlBody('HTML ページ', 3000, 3000));
  await address(HTML);
  const hf = await waitFrame(/page\.html/);
  await until(async () => /HTML ページ/.test(await hf.evaluate(() => document.body.innerText).catch(() => '')), 'HTML の初回表示');
  await hf.evaluate(() => scrollTo(700, 1200));
  await page.waitForTimeout(300);
  const p0 = await pos(hf);
  check(p0.x > 0 && p0.y > 0, `HTML を縦横にスクロールした（${p0.x}, ${p0.y}）`);
  await rewrite('page.html', htmlBody('更新後の HTML', 3000, 3000));
  await address(HTML);
  await until(async () => /更新後の HTML/.test(await hf.evaluate(() => document.body.innerText).catch(() => '')), '読み直した中身');
  const p1 = await until(async () => { const v = await pos(hf).catch(() => null); return v && v.y === p0.y && v.x === p0.x ? v : null; }, `読み直しの後に位置が戻る（${p0.x}, ${p0.y}）`);
  check(p1.x === p0.x && p1.y === p0.y, `開き直して中身が更新され、位置（縦・横）が保たれる（${p1.x}, ${p1.y}）`);
  await shot('html-reread-kept');
  // ⟳ ボタン
  await hf.evaluate(() => scrollTo(300, 800));
  await page.waitForTimeout(300);
  await page.locator('button.bu-icon[aria-label="再読み込み"]').first().click();
  await page.waitForTimeout(1200);
  const p2 = await until(async () => { const v = await pos(hf).catch(() => null); return v && v.y === 800 && v.x === 300 ? v : null; }, '⟳ の後も位置が保たれる');
  check(p2.y === 800 && p2.x === 300, `⟳ の再読み込みでも位置が保たれる（${p2.x}, ${p2.y}）`);
  // ページが短くなった: 届くところまで
  await hf.evaluate(() => scrollTo(0, 1200));
  await page.waitForTimeout(300);
  await rewrite('page.html', htmlBody('短くなった HTML', 1400, 100));
  await address(HTML);
  await until(async () => /短くなった HTML/.test(await hf.evaluate(() => document.body.innerText).catch(() => '')), '短くなった中身');
  const p3 = await until(async () => { const v = await pos(hf).catch(() => null); return v && v.maxY > 0 && v.y === v.maxY ? v : null; }, '短くなったら届くところまで');
  check(p3.y === p3.maxY && p3.y < 1200, `短くなったページでは届くところまでスクロールする（${p3.y} / 最大 ${p3.maxY}）`);
  // 別のファイルへ替えたタブは上から
  await hf.evaluate(() => scrollTo(0, 500));
  await page.waitForTimeout(300);
  await address(OTHER);
  await until(async () => /別の HTML/.test(await hf.evaluate(() => document.body.innerText).catch(() => '')), '別の HTML');
  await page.waitForTimeout(1500);
  const p4 = await pos(hf);
  check(p4.x === 0 && p4.y === 0, `別のファイルへ替えたら位置は引き継がず上から始まる（${p4.x}, ${p4.y}）`);
  // 別の会話へ移って戻る（右の欄は閉じ、枠は見えない間に読み直される。文書は中の位置を知らない）
  await rewrite('page.html', htmlBody('HTML ページ', 3000, 3000));
  await address(HTML);
  await until(async () => /HTML ページ/.test(await hf.evaluate(() => document.body.innerText).catch(() => '')), '戻る前の HTML');
  await hf.evaluate(() => scrollTo(600, 1100));
  await page.waitForTimeout(400);
  const q0 = await pos(hf);
  check(q0.x === 600 && q0.y === 1100, `会話を移る前にスクロールした（${q0.x}, ${q0.y}）`);
  const away = await page.locator('.row[data-session]:not([data-session="bf-1"])').first().getAttribute('data-session').catch(() => null);
  check(!!away, '移り先の別の会話がある');
  await rewrite('page.html', htmlBody('離れている間に更新', 3000, 3000));
  await page.locator(`.row[data-session="${away}"]`).click();
  await page.waitForTimeout(1200);
  await page.locator('.row[data-session="bf-1"]').click();
  await page.waitForTimeout(800);
  if (await page.locator('aside.file-preview').isHidden()) await page.locator('#browserEntry').click();
  await until(async () => { const f = frameOf(/page\.html/); return f && /離れている間に更新/.test(await f.evaluate(() => document.body.innerText).catch(() => '')); }, '戻った後の更新');
  const q1 = await until(async () => { const v = await pos(frameOf(/page\.html/)).catch(() => null); return v && v.y === 1100 && v.x === 600 ? v : null; }, '別の会話から戻っても位置が戻る');
  check(q1.x === 600 && q1.y === 1100, `別の会話へ移って戻り、離れている間に更新されても位置（縦・横）が保たれる（${q1.x}, ${q1.y}）`);
  await shot('html-reread-away-kept');
  await rewrite('page.html', htmlBody('HTML ページ', 3000, 3000));

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
