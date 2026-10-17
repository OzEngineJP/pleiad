// playwright-cli --raw run-code --filename=tests/browser/composer-recall-suggest.cjs
// 入力欄の ↑ の呼び出しと次のメッセージの候補（docs/design-system.md「入力欄の呼び出しと候補」）。
// fake バックエンドを別ポート・別のデータ置き場で立て、authLogin { backend: 'fake' } と最初の案内（「あとで」）を済ませてから流す（AGENTS.md）。
// fake は本文の「suggest:…」を候補として返す。並びの読み込み（sessions.sentMessages）は、ページ上で WebSocket.prototype.send を包んで遅らせる。
//   - 候補が出ている空の欄の Ctrl+Enter は送らず、Tab の印が光り、読み上げに「Tab で候補を入れます」
//   - Esc で候補が薄れて消え、欄を打って空に戻しても出ない
//   - ↑ はこの会話 → ほかの会話。ほかの会話の分だけ会話名の札。一番古いものでさらに ↑ は数が跳ねる（字は変わらない）
//   - ↑ から戻すと、候補は欄と同じ位置に出る（閉じかけの行の分だけずれない）
//   - 読み込みが遅いときは「読み込み中…」（Esc の印は出さない）。待つ間に打った字は上書きしない
//   - タッチの画面: 候補のボタンは ⇥。欄が空で候補も無いときは履歴のボタン（面なし）。押すと行に「前へ」「次へ」「下書きに戻す」
// 撮った画面は temporary/composer-recall-suggest-shots/ に置く（playwright-cli を起動した作業ディレクトリからの相対）。
async page => {
  const shots = 'temporary/composer-recall-suggest-shots';
  const wrap = () => {
    if (window.__recallWrapped) return;
    window.__recallWrapped = true;
    window.__recallDelay = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let m = null;
      try { m = JSON.parse(data); } catch {}
      const ms = m?.command === 'invoke' && m.args?.op === 'sessions.sentMessages' ? window.__recallDelay : 0;
      if (ms) { setTimeout(() => send.call(this, data), ms); return; }
      return send.call(this, data);
    };
  };
  await page.addInitScript(wrap);
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const ui = (p) => p.evaluate(() => {
    const vis = (s) => { const e = document.querySelector(s); return Boolean(e && !e.hidden && e.offsetParent); };
    const row = document.querySelector('.recall-row'), prompt = document.querySelector('#prompt'), ghost = document.querySelector('.composer-ghost');
    return {
      value: prompt.value, row: row.classList.contains('on') ? row.innerText.replace(/\s+/g, ' ').trim() : null, loading: row.classList.contains('loading'),
      conv: vis('.recall-conv') && row.classList.contains('on') ? document.querySelector('.recall-conv').innerText : null,
      bump: document.querySelector('.recall-pos').classList.contains('bump'), esc: vis('.recall-esc'),
      ghost: ghost.hidden ? null : document.querySelector('.cg-text').textContent, ghostDy: ghost.hidden ? null : Math.round(ghost.getBoundingClientRect().top - prompt.getBoundingClientRect().top),
      nudge: document.querySelector('.cg-key').classList.contains('nudge'), take: vis('.cg-take'), open: vis('.recall-open'),
      openBg: vis('.recall-open') ? getComputedStyle(document.querySelector('.recall-open')).backgroundColor : null,
      rowBtns: row.classList.contains('on') ? [...document.querySelectorAll('.recall-btn')].filter((b) => !b.hidden).map((b) => b.getAttribute('aria-label') + (b.disabled ? '(off)' : '')) : [],
      said: [...document.querySelectorAll('[aria-live]')].some((e) => e.textContent.includes('Tab で候補を入れます')),
      users: document.querySelectorAll('.m.user').length,
    };
  });
  const closeDialog = (p) => p.evaluate(() => { const d = document.getElementById('onboardingDialog'); if (d?.open) d.close(); });
  const newSession = async (p) => { await p.evaluate(() => document.getElementById('newSession').click()); await p.waitForTimeout(700); await closeDialog(p); };
  const send = async (p, text) => {
    const before = await p.locator('.m.user').count();
    await p.locator('#prompt').click();
    await p.keyboard.insertText(text);
    await p.keyboard.press('Control+Enter');
    await p.waitForFunction((n) => document.querySelectorAll('.m.user').length > n, before, { timeout: 8000 });
    await p.waitForFunction(() => !document.querySelector('#abort:not([hidden])'), null, { timeout: 15000 });
    await p.waitForTimeout(700);
  };

  await page.reload();
  await page.locator('.row[data-session]').first().waitFor().catch(() => {});
  await closeDialog(page);

  // ---- 種: ほかの会話と、この会話（候補つき）
  await newSession(page);
  await send(page, 'echo:CI が Windows でだけ落ちる理由を調べて');
  await newSession(page);
  await send(page, 'echo:README の手順を最新に合わせて直して');
  await send(page, 'echo:テストも流して suggest:コミットして、PR を作って');
  await page.locator('.composer-ghost.on').waitFor({ timeout: 8000 });
  await page.locator('#prompt').click();
  await page.waitForTimeout(400);

  // ---- 空の欄の Ctrl+Enter
  let s = await ui(page);
  const users = s.users;
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(150);
  s = await ui(page);
  check('候補の出ている空の欄の Ctrl+Enter は送らない', s.users === users && s.value === '', JSON.stringify(s));
  check('代わりに Tab の印が光り、読み上げに「Tab で候補を入れます」', s.nudge && s.said, JSON.stringify(s));
  await page.screenshot({ path: `${shots}/1-nudge.png` });
  await page.waitForTimeout(800);

  // ---- ↑ でこの会話 → ほかの会話
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  s = await ui(page);
  check('↑ の 1 つ目はこの会話の分（札なし・Esc の印）', s.value.startsWith('echo:テストも流して') && !s.conv && s.esc, JSON.stringify(s));
  let guard = 0;
  while (!(s = await ui(page)).conv && guard++ < 6) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(350); }
  check('ほかの会話の分には会話名の札', Boolean(s.conv), JSON.stringify(s));
  await page.screenshot({ path: `${shots}/2-recall-other.png` });
  guard = 0;
  while (!s.row?.match(/^(\d+) \/ \1 /) && guard++ < 50) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(80); s = await ui(page); }
  const oldest = s.value;
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(40);
  s = await ui(page);
  check('一番古いものでさらに ↑ は数が跳ねるだけ（字は変わらない）', s.bump && s.value === oldest, JSON.stringify(s));

  // ---- 戻すと、候補は欄と同じ位置
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  s = await ui(page);
  check('Esc で書きかけに戻り、候補が欄と同じ位置に出る', s.value === '' && !s.row && s.ghost === 'コミットして、PR を作って' && s.ghostDy === 0, JSON.stringify(s));

  // ---- Esc で候補を消す
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  s = await ui(page);
  check('候補の出ている空の欄の Esc で候補が消える', s.ghost === null, JSON.stringify(s));
  await page.keyboard.type('a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  check('消した候補は、打って空に戻しても出ない', (await ui(page)).ghost === null);

  // ---- 読み込みが遅いとき（1.5 秒）
  await page.evaluate(() => { window.__recallDelay = 1500; });
  await newSession(page);
  await page.locator('#prompt').click();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  s = await ui(page);
  check('読み込み中は「読み込み中…」（Esc の印なし）', s.loading && s.row === '読み込み中…' && !s.esc, JSON.stringify(s));
  await page.screenshot({ path: `${shots}/3-loading.png` });
  await page.keyboard.type('打った字');
  await page.waitForTimeout(1800);
  s = await ui(page);
  check('待つ間に打った字は上書きしない', s.value === '打った字' && !s.row, JSON.stringify(s));
  await page.evaluate(() => { window.__recallDelay = 0; });

  // ---- タッチの画面（360px）
  const ctx = await page.context().browser().newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
  const touch = await ctx.newPage();
  await touch.addInitScript(wrap);
  await touch.goto(page.url());
  await touch.locator('#prompt').waitFor();
  await touch.waitForTimeout(800);
  await closeDialog(touch);
  await newSession(touch);
  await send(touch, 'echo:直して suggest:Google Cloud KMS で署名する手順を教えてください');
  await touch.locator('.composer-ghost.on').waitFor({ timeout: 8000 });
  s = await ui(touch);
  check('タッチ: 候補のボタン（⇥）が出て、履歴のボタンは出さない', s.take && !s.open, JSON.stringify(s));
  check('タッチ: 候補のボタンは Tab の記号', await touch.evaluate(() => document.querySelector('.cg-take path').getAttribute('d') === 'M4 12h12M11 7l5 5-5 5M20 5v14'));
  await touch.screenshot({ path: `${shots}/4-touch-suggest.png` });
  await newSession(touch);
  await touch.waitForTimeout(600);
  s = await ui(touch);
  check('タッチ: 欄が空で候補も無いときは履歴のボタン（面なし）', s.open && !s.take && s.openBg === 'rgba(0, 0, 0, 0)', JSON.stringify(s));
  await touch.locator('.recall-open').tap();
  await touch.waitForTimeout(600);
  s = await ui(touch);
  check('タッチ: 押すと呼び出し、行に「前へ」「次へ」「下書きに戻す」（Esc の印なし）', s.value.length > 0 && JSON.stringify(s.rowBtns.map((b) => b.replace('(off)', ''))) === '["前へ","次へ","下書きに戻す"]' && !s.esc && !s.open, JSON.stringify(s));
  await touch.screenshot({ path: `${shots}/5-touch-recall.png` });
  const first = s.value;
  await touch.locator('.recall-btn[aria-label="前へ"]').tap();
  await touch.waitForTimeout(400);
  check('タッチ: 「前へ」で古い方へ', (await ui(touch)).value !== first);
  await touch.locator('.recall-btn[aria-label="下書きに戻す"]').tap();
  await touch.waitForTimeout(600);
  s = await ui(touch);
  check('タッチ: 「下書きに戻す」で空の欄に戻り、履歴のボタンがまた出る', s.value === '' && !s.row && s.open, JSON.stringify(s));
  await ctx.close();

  return checks.join('\n');
}
