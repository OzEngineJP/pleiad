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
  // 初回の案内（ログイン → 会話を始める）は遅れて出ることがある。出ている間は進め、出なくなったら閉じる
  for (let i = 0; i < 60; i++) {
    const step = page.locator('#onboardingDialog[open] button:visible', { hasText: /^(ログイン|会話を始める)$/ }).first();
    if (await step.count()) { await step.click(); await page.waitForTimeout(600); } else if (i > 20) break; else await page.waitForTimeout(100);
  }
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
  check(await nf.locator('h2').count() === 4, '4 つの見出し（この会話・可視化・最近のファイル・作業フォルダー。種の会話に可視化がある）が最初の描画で出る');
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
  const htmlBody = (title, h, w) => `<!doctype html><meta charset="utf-8"><title>p</title><h1>${title}</h1><div style="height:${h}px;width:${w}px">長い</div><script>history.scrollRestoration='manual'</script>`;   // ブラウザー自身の位置の復元は切る（橋の追う処理だけが戻す）
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

  // ---- 5c. 読み直しの位置の保持の細部（ADR 0320）: 復元は「触れた」に数えない・smooth でも即座・連続した読み直しは最初の位置・利用者が触れたら追うのをやめる・偽の位置は何も起こさない
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const live = () => frameOf(/page\.html/);
  const textOf = async (f) => (await f?.evaluate(() => document.body.innerText).catch(() => '')) ?? '';
  const seen = (re) => async () => re.test(await textOf(live()));
  const bannerShown = async () => /更新を表示/.test(await page.locator('aside.file-preview').innerText());
  const frameBox = async () => (await live().frameElement()).boundingBox();   // 今の HTML のタブの枠（ほかのタブの枠も DOM にはある）
  const settle = async (ms = 400) => page.waitForTimeout(ms);
  const samePos = (want) => async () => { const v = await pos(live()).catch(() => null); return v && v.x === want.x && v.y === want.y ? v : null; };

  // 5c-1. 利用者が触れたタブは「更新を表示」。押して読み直した後の復元（プログラムの scroll）は「触れた」に数えず、次の更新は自動で読み直す
  await rewrite('page.html', htmlBody('c0', 3000, 3000));
  await address(HTML);
  await until(seen(/c0/), 'c0 の表示');
  await live().evaluate(() => scrollTo({ left: 0, top: 0, behavior: 'instant' }));
  await until(samePos({ x: 0, y: 0 }), '先頭へ戻した');
  await settle(800);   // 読み直しの直後の復元（追う処理）が終わるのを待つ
  let fbox = await frameBox();
  await page.mouse.move(fbox.x + 200, fbox.y + 200);
  await page.mouse.wheel(0, 900);
  await until(async () => { const v = await pos(live()); return v.y > 0 ? v : null; }, 'ホイールで動いた');
  await settle(800);
  const w0 = await pos(live());
  await rewrite('page.html', htmlBody('c1', 3000, 3000));
  await until(bannerShown, '利用者が触れたタブは「更新を表示」になる（ADR 0320 の決まり）');
  await page.getByRole('button', { name: /更新を表示/ }).first().click();
  await until(seen(/c1/), '「更新を表示」で読み直した');
  await until(samePos(w0), `「更新を表示」の後も位置が保たれる（${w0.x}, ${w0.y}）`);
  await settle(600);
  await rewrite('page.html', htmlBody('c2', 3000, 3000));
  await until(seen(/c2/), '復元の scroll で「触れた」にならず、次の更新も自動で読み直す', 6000);
  check(!(await bannerShown()), '2 回目の更新では「更新を表示」を出さない（復元は利用者の操作ではない）');
  await until(samePos(w0), `自動の読み直しでも位置が保たれる（${w0.x}, ${w0.y}）`);
  await settle(600);
  await rewrite('page.html', htmlBody('c3', 3000, 3000));
  await until(seen(/c3/), '3 回目の更新も自動で読み直す', 6000);
  check(!(await bannerShown()), '3 回目も「更新を表示」を出さない');
  await until(samePos(w0), '3 回目の後も位置が保たれる');

  // 5c-2. scroll-behavior: smooth の HTML: 復元は即座（0 → 目的地の間の途中の位置を通らない）
  const smoothBody = (t) => `<!doctype html><meta charset="utf-8"><title>p</title><style>html{scroll-behavior:smooth}</style><h1>${t}</h1><div style="height:3000px;width:3000px">長い</div><script>history.scrollRestoration='manual';window.__ys=[];addEventListener('scroll',function(){__ys.push(Math.round(scrollX)+','+Math.round(scrollY))})</script>`;
  await rewrite('page.html', smoothBody('s0'));
  await address(HTML);
  await until(seen(/s0/), 's0 の表示');
  await live().evaluate(() => scrollTo({ left: 300, top: 1200, behavior: 'instant' }));
  await until(samePos({ x: 300, y: 1200 }), 'smooth のページを (300, 1200) へ動かした');
  await rewrite('page.html', smoothBody('s1'));
  await address(HTML);
  const ys = new Set();
  const endAt = Date.now() + 8000;
  let reached = false;
  while (Date.now() < endAt && !reached) {
    const f = live();
    const t = await textOf(f);
    const v = await pos(f).catch(() => null);
    if (v && /s1/.test(t)) { ys.add(`${v.x},${v.y}`); if (v.x === 300 && v.y === 1200) reached = true; }
    await page.waitForTimeout(8);
  }
  check(reached, 'smooth のページでも読み直しの後に位置（300, 1200）へ戻る');
  await settle(600);
  check([...ys].every((p) => p === '0,0' || p === '300,1200'), `smooth のページの復元はアニメーションにならない（観測した位置: ${[...ys].join(' / ')}）`);
  // （ブラウザー自身の位置の復元は切ってある。橋の追う処理だけが戻す）
  // 読み込み直した文書が自分で記録した scroll の位置（8ms 間隔の見張りでは、アニメーションの途中の位置を取りこぼす）。即座なら 1 回で (300, 1200)
  const ownYs = await live().evaluate(() => window.__ys);
  check(ownYs.length > 0 && ownYs.every((p) => p === '300,1200'), `smooth のページの復元は、文書自身が見た scroll も途中を経ない（${ownYs.join(' / ')}）`);

  // 5c-3. 連続した読み直し（⟳ を続けて押す・間に書き換え）でも、最初の位置が保たれる
  await rewrite('page.html', htmlBody('d0', 3000, 3000));
  await address(HTML);
  await until(seen(/d0/), 'd0 の表示');
  await live().evaluate(() => scrollTo({ left: 500, top: 1000, behavior: 'instant' }));
  await until(samePos({ x: 500, y: 1000 }), '連続した読み直しの前に (500, 1000) にいる');
  await settle();
  const reloadBtn = page.locator('button.bu-icon[aria-label="再読み込み"]').first();
  await reloadBtn.click(); await page.waitForTimeout(30);
  await reloadBtn.click(); await page.waitForTimeout(30);
  await rewrite('page.html', htmlBody('d1', 3000, 3000));
  await reloadBtn.click(); await page.waitForTimeout(30);
  await reloadBtn.click();
  await until(seen(/d1/), '連続した読み直しの後の中身');
  await settle(2500);
  const d1 = await pos(live());
  check(d1.x === 500 && d1.y === 1000, `読み直しを続けて重ねても、最初の位置が保たれる（${d1.x}, ${d1.y}）`);

  // 5c-4. 追っている間に利用者が触れたら、追うのをやめる（高さが遅れて届くページ。ホイール。つまみは別の試験）
  const lateBody = (t) => `<!doctype html><meta charset="utf-8"><title>p</title><h1>${t}</h1><div id="s" style="height:2000px;width:100px">長い</div><script>setTimeout(function(){document.getElementById('s').style.height='6000px'},1500)</script>`;
  const lateTall = async () => until(async () => { const v = await pos(live()).catch(() => null); return v && v.maxY > 4500 ? v : null; }, '高さが届いた', 8000);
  await live().evaluate(() => scrollTo({ left: 0, top: 0, behavior: 'instant' }));   // 幅の狭いページへ (500, 1000) を持ち込まない（横に届かないと追う処理が 3 秒続く）
  await until(samePos({ x: 0, y: 0 }), '遅れて高くなるページの前に先頭へ戻した');
  await rewrite('page.html', lateBody('l0'));
  await address(HTML);
  await until(seen(/l0/), 'l0 の表示');
  await lateTall();
  await live().evaluate(() => scrollTo({ left: 0, top: 4000, behavior: 'instant' }));
  await until(samePos({ x: 0, y: 4000 }), '遅れて高くなるページを (0, 4000) へ動かした');
  await settle();
  // 対照: 触れなければ、高さが届いたあとに目的地まで追いつく
  await rewrite('page.html', lateBody('l1'));
  await address(HTML);
  await until(seen(/l1/), 'l1 の表示');
  await until(samePos({ x: 0, y: 4000 }), '触れなければ、高さが届いたあと目的地（0, 4000）に追いつく', 8000);
  await settle(500);
  // 追っている間（高さが届く前）に次の読み直しが重なっても、橋は目的地（最初の位置）を返す。届く前の低い位置を次の目的地にしない
  await rewrite('page.html', lateBody('l1b'));
  await reloadBtn.click(); await page.waitForTimeout(30);
  await reloadBtn.click();
  await until(seen(/l1b/), 'l1b の表示');
  await until(samePos({ x: 0, y: 4000 }), '追っている間に読み直しが重なっても、最初の位置（0, 4000）へ追いつく', 10000);
  await settle(500);
  // ホイール: 追っている間に上へ戻すと、そのあと高さが届いても目的地へは引き戻さない
  await rewrite('page.html', lateBody('l2'));
  await address(HTML);
  await until(seen(/l2/), 'l2 の表示');
  fbox = await frameBox();
  await page.mouse.move(fbox.x + 200, fbox.y + 200);
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, -300);
  await lateTall();
  await settle(1200);
  const wheelEnd = await pos(live());
  check(wheelEnd.y < 3500, `追っている間にホイールで動かしたら、追うのをやめる（高さが届いても目的地 4000 へ引き戻さない: ${wheelEnd.y}）`);
  // スクロールバーのつまみのドラッグは、この実行の Chromium（--hide-scrollbars）では描かれず触れない。tests/browser/page-scroll-chase-input.mjs で確かめる

  // 5c-5. 偽の位置（ページ自身が親へ送る pleiad:page-scroll）: 読み直しの外では何も起こさず、おかしな数も無害。本物の位置は壊れない
  await rewrite('page.html', htmlBody('f0', 3000, 3000));
  await address(HTML);
  await until(seen(/f0/), 'f0 の表示');
  await live().evaluate(() => scrollTo({ left: 200, top: 1300, behavior: 'instant' }));
  await until(samePos({ x: 200, y: 1300 }), '偽の位置の前に (200, 1300) にいる');
  await settle();
  const forge = (data) => live().evaluate((d) => { parent.postMessage(d, '*'); }, data);
  for (const bad of [{ x: Infinity, y: Infinity }, { x: 1e12, y: 1e12 }, { x: NaN, y: NaN }, { x: '700', y: '900' }, { x: -5, y: -5 }, { x: null, y: undefined }, { y: 800 }, { x: {}, y: [] }]) await forge({ type: 'pleiad:page-scroll', ...bad });
  await live().evaluate(() => { for (let i = 0; i < 300; i++) parent.postMessage({ type: 'pleiad:page-scroll', x: 5000 + i, y: 7000 + i }, '*'); });
  await settle(800);
  const f1 = await pos(live());
  check(f1.x === 200 && f1.y === 1300, `読み直しの外で偽の位置を送っても、位置は動かない（${f1.x}, ${f1.y}）`);
  await rewrite('page.html', htmlBody('f1', 3000, 3000));
  await address(HTML);
  await until(seen(/f1/), 'f1 の表示');
  await until(samePos({ x: 200, y: 1300 }), '偽の位置を送った後の読み直しでも、本物の位置が戻る');
  // 読み直しの最中に届いた偽の数: 親が受けるのは有限の数だけ。送り先の文書の中で収まるところ（端）へ届くだけで、止まったり壊れたりしない
  await settle();
  await reloadBtn.click();
  for (let i = 0; i < 20; i++) { await forge({ type: 'pleiad:page-scroll', x: Infinity, y: 1e12 }).catch(() => {}); await page.waitForTimeout(15); }
  await settle(1800);
  check(await page.locator('.bu-load:not([hidden])').count() === 0, '読み直しの最中に偽の位置が届いても、読み込み線が残らない');
  await reloadBtn.click();
  await until(async () => { const v = await pos(live()).catch(() => null); return v ? v : null; }, '偽の位置の後の読み直しも完了する');
  check(errors.length === 0, `偽の位置・連打でページのエラーは出ない（${errors.join(' | ')}）`);
  await rewrite('page.html', htmlBody('HTML ページ', 3000, 3000));

  // ---- 5d. 可視化（visualize）のタブでも同じ: 読み直し（⟳）・題だけ違う URL・別の会話へ移って戻る
  await page.locator('.row[data-session="bf-1"]').click();
  await settle(600);
  if (await page.locator('aside.file-preview').isHidden()) await page.locator('#browserEntry').click();
  const viz = () => frameOf(/embed=tab/);
  const vpos = () => viz().evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY), mark: window.__marker ?? null }));
  const vizTabs = () => page.locator('.bu-tab').count();
  const tabsBeforeViz = await vizTabs();
  await page.locator('.visualize-open').first().evaluate((b) => b.click());
  await until(async () => viz() && await viz().evaluate(() => !!document.getElementById('title')).catch(() => false), '可視化のタブの表示');
  check(await vizTabs() === tabsBeforeViz + 1, '可視化は右の欄のタブで開く');
  await viz().evaluate(() => { window.__marker = 1; scrollTo(500, 900); });
  await until(async () => { const v = await vpos().catch(() => null); return v && v.x === 500 && v.y === 900 && v.mark === 1 ? v : null; }, '可視化のタブを (500, 900) へスクロールした');
  await shot('viz-before');
  await page.locator('button.bu-icon[aria-label="再読み込み"]').first().click();
  const v1 = await until(async () => { const v = await vpos().catch(() => null); return v && v.mark === null && v.x === 500 && v.y === 900 ? v : null; }, '⟳ で文書が読み直され（目印が消え）、位置（500, 900）が戻る');
  check(v1.mark === null && v1.x === 500 && v1.y === 900, `可視化のタブも ⟳ で読み直して位置（縦・横）が保たれる（${v1.x}, ${v1.y}）`);
  await shot('viz-reread-kept');
  // 題だけ違う URL（アドレスバーに同じ可視化を別の題で入れ直す）: タブの URL は ?title だけ変わる。その後の ⟳ は同じ文書の読み直しで、位置が保たれる
  // （題の違いを文書の違いと見ると、枠を張り直して位置が先頭へ飛ぶ）
  await viz().evaluate(() => { window.__marker = 2; });
  const tabsViz = await vizTabs();
  const retitled = viz().url().replace(/([?&]title=)[^&#]*/, `$1${encodeURIComponent('別の題に替えた')}`);   // 定数 URL（このファイルの頭）が URL を隠している
  check(retitled !== viz().url(), '前提: 題だけ違う URL を作れた');
  await address(retitled);
  await settle(1200);
  await reloadBtn.click();
  await until(async () => { const v = await vpos().catch(() => null); return v && v.mark === null ? v : null; }, '題だけ違う URL でも ⟳ で文書が読み直される', 8000);
  const v2 = await until(async () => { const v = await vpos().catch(() => null); return v && v.x === 500 && v.y === 900 ? v : null; }, '題だけ違う URL の読み直しでも位置が保たれる');
  check(v2.x === 500 && v2.y === 900, `題だけ違う URL の後の ⟳ でも、同じ文書として位置（縦・横）が保たれる（${v2.x}, ${v2.y}）`);
  check(await vizTabs() === tabsViz, `題だけ違う URL では新しいタブを増やさない（${tabsViz} 枚のまま）`);
  // 別の会話へ移って戻る
  await viz().evaluate(() => { window.__marker = 3; scrollTo(400, 700); });
  await until(async () => { const v = await vpos().catch(() => null); return v && v.x === 400 && v.y === 700 ? v : null; }, '移る前に (400, 700) へスクロールした');
  const away2 = await page.locator('.row[data-session]:not([data-session="bf-1"])').first().getAttribute('data-session').catch(() => null);
  check(!!away2, '移り先の別の会話がある（可視化）');
  await page.locator(`.row[data-session="${away2}"]`).click();
  await settle(1200);
  await page.locator('.row[data-session="bf-1"]').click();
  await settle(800);
  if (await page.locator('aside.file-preview').isHidden()) await page.locator('#browserEntry').click();
  const v3 = await until(async () => { const v = await vpos().catch(() => null); return v && v.x === 400 && v.y === 700 ? v : null; }, '別の会話から戻っても、可視化の位置が戻る');
  check(v3.x === 400 && v3.y === 700, `別の会話へ移って戻っても、可視化のタブの位置（縦・横）が保たれる（${v3.x}, ${v3.y}。目印 ${v3.mark}）`);
  await shot('viz-away-kept');

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
