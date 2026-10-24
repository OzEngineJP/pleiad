// fake サーバーで案内とログインを済ませて実行する。ADR 0266・docs/design-system.md「入力欄と上端」。
// 会話の入力欄（#composer）は履歴（#log）の下端に重ね、空いた所（帯の左・箱の左右）から履歴が透けて見える。
// 見る所: 末尾の行は帯と入力欄に隠れない／空いた所は押しても選んでも履歴に届く／末尾の余白は入力欄の高さに付いていく／最新へと末尾の判定。
async page => {
  const results = [];
  const check = (label, ok, detail) => {
    if (!ok) throw Error(`${label}: ${JSON.stringify(detail)}`);
    results.push(`OK ${label}`);
  };
  const send = async text => {
    await page.locator('#prompt').fill(text);
    await page.locator('#prompt').press('Control+Enter');
  };
  const frames = (n = 2) => page.evaluate(n => new Promise(done => { const step = () => (--n ? requestAnimationFrame(step) : done()); requestAnimationFrame(step); }), n + 1);
  const toEnd = async () => { await page.evaluate(() => { const log = document.querySelector('#log'); log.scrollTop = log.scrollHeight; }); await page.waitForTimeout(250); };
  const panel = async open => {
    const shown = await page.evaluate(() => document.body.classList.contains('file-preview-open'));
    if (shown !== open) await page.locator('#contextEntry').click();
    await page.waitForTimeout(400);
  };
  // 入力欄の高さ・#log の末尾の余白・末尾の行と、入力欄の見える部品の位置
  const measure = () => page.evaluate(() => {
    const q = s => document.querySelector(s);
    const box = n => n.getBoundingClientRect().toJSON();
    const log = q('#log'), composer = q('#composer'), strip = q('#contextStrip');
    const rows = [...q('#thread').children].filter(n => n.classList.contains('mw'));
    const narrow = matchMedia('(max-width:700px)').matches;
    return {
      composerH: composer.offsetHeight, varH: parseFloat(getComputedStyle(q('#logFrame')).getPropertyValue('--composer-h')),
      pad: parseFloat(getComputedStyle(log).paddingBottom), gap: narrow ? 12 : 24,
      atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 2,
      last: box(rows.at(-1)), log: box(log), main: box(q('main')), composer: box(composer), cbox: box(q('#cbox')),
      strip: strip.hidden ? null : box(strip), top: strip.hidden ? box(q('#cbox')).top : box(strip).top,
      latest: (() => { const b = q('#logFrame > .nav-latest'); return b.hidden ? null : box(b); })(),
    };
  });
  // その点で、押したときに当たる要素が履歴（#log の中。inFrame は右端の地図も含む）か
  const hit = (x, y) => page.evaluate(([x, y]) => {
    const n = document.elementFromPoint(x, y);
    return { inLog: !!n?.closest('#log'), inFrame: !!n?.closest('#logFrame'), inComposer: !!n?.closest('#composer'), tag: n?.tagName, id: n?.id, cls: n?.className?.baseVal ?? n?.className };
  }, [x, y]);
  // 末尾の行が帯と入力欄の上に出ていて、余白が入力欄の高さに合っている
  const settled = async (at) => {
    const r = await measure();
    check(`${at}: --composer-h は入力欄の高さ`, Math.abs(r.varH - r.composerH) < 1, r);
    check(`${at}: #log の末尾の余白は 入力欄の高さ + ${r.gap}px`, Math.abs(r.pad - (r.composerH + r.gap)) < 1, r);
    check(`${at}: 末尾にいて、最後の行は帯と入力欄に隠れない`, r.atEnd && r.last.bottom <= r.top + 0.5, r);
    return r;
  };

  await page.evaluate(() => document.querySelector('#newSession').click());
  // リンクは段落の頭（帯の左の空いた所に持ってくる）
  const para = i => `[資料 ${i}](https://example.com/${i}) の **${i} 番目の段落**: ファイルの一覧を作るだけで、同じ曲を開いているほかの窓がわきへ移した録音まで、元へ戻してしまいます。`;
  await send(`echo:${Array.from({ length: 30 }, (_, i) => para(i + 1)).join('\n\n')}`);
  await page.locator('.m.ai .body').waitFor();
  await page.locator('#abort').waitFor({ state: 'hidden' });
  // 裏の作業（帯に作業ボタン、筋の末尾に衛星の行）
  await send('bg 1 400');
  await page.locator('#thread .m.activity .run.sat').waitFor();

  const cases = [{ name: 'PC 1280', width: 1280 }, { name: 'スマホ 360', width: 360 }, { name: 'PC 1280 パネル', width: 1280, panel: true }];
  for (const c of cases) {
    await page.setViewportSize({ width: c.width, height: 800 });
    await panel(!!c.panel);
    await toEnd();
    const r = await settled(c.name);
    check(`${c.name}: 履歴は入力欄の後ろ（main の下端）まで伸びる`, Math.abs(r.log.bottom - r.main.bottom) < 1 && r.log.bottom >= r.cbox.bottom, r);
    check(`${c.name}: 入力欄は main の幅の中（脇・右のパネルにはみ出さない）`, r.composer.left >= r.main.left - 0.5 && r.composer.right <= r.main.right + 0.5 && Math.abs(r.composer.bottom - r.main.bottom) < 1, r);
    check(`${c.name}: 末尾では最新へを出さない`, !r.latest, r);
    // 空いた所は履歴に届き、見える部品（箱・メーター）は入力欄のまま
    const midY = r.cbox.top + r.cbox.height / 2;
    if (r.strip) {
      const left = await hit(r.strip.left + 4, r.strip.top + r.strip.height / 2);
      check(`${c.name}: 帯の左の空いた所は履歴に届く`, left.inLog && !left.inComposer, left);
    }
    if (r.cbox.left - r.main.left >= 8) {
      const side = await hit(r.cbox.left - 4, midY);
      check(`${c.name}: 箱の左の余白は履歴（地図を含む）に届く`, side.inFrame && !side.inComposer, side);
    }
    if (r.main.right - r.cbox.right >= 8) {
      const side = await hit(r.cbox.right + 4, midY);
      check(`${c.name}: 箱の右の余白は履歴（地図を含む）に届く`, side.inFrame && !side.inComposer, side);
    }
    const inBox = await hit(r.cbox.left + r.cbox.width / 2, midY);
    check(`${c.name}: 箱の中は入力欄`, inBox.inComposer && !inBox.inLog, inBox);
    const under = await hit(r.cbox.left + r.cbox.width / 2, r.cbox.bottom + 2);
    check(`${c.name}: 箱の下の余白は紙で塞ぎ、履歴に届かない`, under.inComposer && !under.inLog, under);
    const meter = await page.evaluate(() => { const b = document.querySelector('#contextMeter'); if (!b?.offsetParent) return null; const r = b.getBoundingClientRect(); const n = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!n?.closest('#contextMeter'); });
    if (meter !== null) check(`${c.name}: 帯のメーターは押せる`, meter, null);
  }
  await panel(false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await toEnd();

  // 帯の左の空いた所に履歴のリンクを持ってきて、押すとリンクに届く・字を選べる
  const link = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const log = q('#log'), strip = q('#contextStrip').getBoundingClientRect();
    const a = [...log.querySelectorAll('.m.ai .body a')].at(-3);
    const y = strip.top + strip.height / 2;
    log.scrollTop += a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2 - y;
    const r = a.getBoundingClientRect();
    window.__overlayClicks = [];
    log.addEventListener('click', e => { const hitA = e.target.closest('a'); if (hitA) { e.preventDefault(); window.__overlayClicks.push(hitA.textContent); } }, { capture: true });
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: a.textContent, strip: strip.toJSON(), work: q('#workEntryButton').getBoundingClientRect().left };
  });
  await page.waitForTimeout(150);
  check('リンクが帯の行の高さにあり、帯の札にかからない', link.y > link.strip.top && link.y < link.strip.bottom && link.x < link.work, link);
  await page.mouse.click(link.x, link.y);
  const clicked = await page.evaluate(() => window.__overlayClicks);
  check('帯の左の空いた所で、履歴のリンクを押せる', clicked.length === 1 && clicked[0] === link.text, { clicked, link });
  const para2 = await page.evaluate(() => {
    const strip = document.querySelector('#contextStrip').getBoundingClientRect();
    const a = [...document.querySelectorAll('#log .m.ai .body a')].at(-3);
    const ar = a.getBoundingClientRect(), work = document.querySelector('#workEntryButton').getBoundingClientRect();
    return { y: strip.top + strip.height / 2, x0: ar.right + 6, x1: Math.min(work.left - 8, ar.right + 160) };
  });
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(para2.x0, para2.y);
  await page.mouse.down();
  await page.mouse.move(para2.x1, para2.y, { steps: 6 });
  await page.mouse.up();
  const selected = await page.evaluate(() => ({ text: getSelection().toString(), inLog: !!getSelection().anchorNode?.parentElement?.closest('#log') }));
  check('帯の左の空いた所で、履歴の字を選べる', selected.inLog && selected.text.length >= 4, selected);
  await page.evaluate(() => getSelection().removeAllRanges());

  // 最新へ: 末尾からの距離の判定（120px）は、重ねた入力欄の分を引いて今までと同じ
  const away = async px => {
    await page.evaluate(px => { const log = document.querySelector('#log'); log.scrollTop = log.scrollHeight - log.clientHeight - px; }, px);
    await page.waitForTimeout(300);
    return measure();
  };
  let r = await away(60);
  check('末尾から 60px では最新へを出さない', !r.latest, r);
  r = await away(400);
  check('末尾から 400px で最新へを出し、帯と入力欄の上に置く', r.latest && r.latest.bottom <= r.top - 4, r);
  await page.locator('#logFrame > .nav-latest').click();
  await page.waitForFunction(() => document.querySelector('#logFrame > .nav-latest').hidden);
  await page.waitForTimeout(300);
  await settled('最新へで戻った後');

  // 余白は入力欄の高さに付いていく: 字の欄が伸びる・添付の札・帯が消える。末尾にいたら末尾に合わせ直す
  const before = await settled('伸ばす前');
  await page.locator('#prompt').fill(Array.from({ length: 6 }, (_, i) => `${i + 1} 行目`).join('\n'));
  await frames(3);
  const tall = await settled('字の欄が 6 行');
  check('字の欄が伸びると入力欄が高くなる', tall.composerH > before.composerH + 40, { before: before.composerH, tall: tall.composerH });
  await page.locator('#fileIn').setInputFiles({ name: 'overlay-note.txt', mimeType: 'text/plain', buffer: Buffer.from('composer overlay') });
  await page.waitForFunction(() => document.querySelector('#cbox').textContent.includes('overlay-note.txt'));
  await frames(3);
  const att = await settled('添付の札');
  check('添付の札で入力欄が高くなる', att.composerH > tall.composerH, { tall: tall.composerH, att: att.composerH });
  await page.locator('#prompt').fill('');
  await page.evaluate(() => { for (const b of document.querySelectorAll('#cbox [aria-label]')) if (/外す|削除|Remove/.test(b.getAttribute('aria-label'))) b.click(); });
  await frames(3);
  await page.evaluate(() => { document.querySelector('#contextStrip').hidden = true; });
  await frames(3);
  const bare = await settled('帯なし');
  check('帯が消えると入力欄が低くなる', bare.composerH < before.composerH && !bare.strip, { before: before.composerH, bare: bare.composerH });
  await page.evaluate(() => { document.querySelector('#contextStrip').hidden = false; });
  await frames(3);
  // 末尾から離れていたら、入力欄の高さが変わっても読んでいる位置を動かさない
  await page.evaluate(() => { const log = document.querySelector('#log'); log.scrollTop = 300; });
  await page.waitForTimeout(150);
  const keep = await page.evaluate(() => document.querySelector('#log').scrollTop);
  await page.locator('#prompt').fill('1\n2\n3\n4');
  await frames(3);
  const kept = await page.evaluate(() => document.querySelector('#log').scrollTop);
  check('末尾から離れているときは位置を動かさない', Math.abs(kept - keep) < 1, { keep, kept });
  await page.locator('#prompt').fill('');
  return results.join('\n');
}
