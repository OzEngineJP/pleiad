// fake サーバーで案内とログインを済ませて実行する。docs/design-system.md §6・会話の圧縮。ADR 0265。
// 稼働表示は会話の筋（#thread）の末尾の節。筋はその点の中心で終わり、ほかの発言の本文と同じ列に弧・衛星、その右に文言。
// 入力欄の上の帯（#contextStrip）は作業・文脈・使用量だけで、右のパネルで列が狭まっても列の中に収める。
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
  const stop = async () => {
    await page.locator('#abort').click();
    await page.locator('#thread .mw.activity').waitFor({ state: 'detached' });
    await page.locator('#abort').waitFor({ state: 'hidden' });
  };
  const panel = async open => {
    const shown = await page.evaluate(() => !!document.body.classList.contains('file-preview-open'));
    if (shown !== open) await page.locator('#contextEntry').click();
    await page.waitForTimeout(400);
  };
  const measure = () => page.evaluate(() => {
    const q = s => document.querySelector(s);
    const box = n => n.getBoundingClientRect().toJSON();
    const thread = q('#thread');
    const row = thread.lastElementChild;
    const gutter = row.querySelector(':scope > .mw-gutter');
    const g = box(gutter), dotStyle = getComputedStyle(gutter, '::before');
    const dot = { left: g.left + parseFloat(dotStyle.left), top: g.top + parseFloat(dotStyle.top), size: parseFloat(dotStyle.width) };
    dot.cx = dot.left + dot.size / 2; dot.cy = dot.top + dot.size / 2; dot.right = dot.left + dot.size;
    const spine = [...thread.querySelectorAll(':scope > .spine path')].at(-1);
    const sp = spine ? box(spine) : null;
    const m = row.querySelector('.m.activity');
    const tip = m.querySelector('.activity-tip'), txt = m.querySelector('.txt'), el = m.querySelector('.el');
    // ほかの発言の本文の左端（見出しの「Fake (test)」と本文の段落）
    const who = [...thread.querySelectorAll(':scope > .mw:not(.activity) .m.ai:not(.cont) > .who')].at(-1);
    const para = [...thread.querySelectorAll(':scope > .mw:not(.activity) .m.ai > .body > *')].at(-1);
    const tipStyle = getComputedStyle(tip), strip = q('#contextStrip');
    const stripBox = box(strip), right = Math.max(0, ...[...strip.children].filter(n => n.offsetParent).map(n => n.getBoundingClientRect().right));
    return {
      last: row.classList.contains('mw') && row.classList.contains('activity'), inStrip: !!strip.querySelector('.activity'),
      dot, spine: sp && { x: sp.left + sp.width / 2, bottom: sp.bottom },
      tip: box(tip), txt: box(txt), el: el.hidden ? null : box(el), m: box(m), row: box(row),
      textWidth: (() => { const r = document.createRange(); r.selectNodeContents(txt); return r.getBoundingClientRect().width; })(),
      whoLeft: who && box(who).left, paraLeft: para && para.getBoundingClientRect().left,
      arcs: tip.querySelectorAll('.run:not(.sat) path').length, sats: tip.querySelectorAll('.run.sat circle').length,
      surface: tipStyle.backgroundColor, outline: tipStyle.outlineStyle, border: tipStyle.borderTopStyle,
      runSurface: tip.firstElementChild ? getComputedStyle(tip.firstElementChild).backgroundColor : null,
      old: !!document.querySelector('.wait-dot, .wait-mark, .wait-band, .wait-pulse, .wait-flow'),
      lineHeight: parseFloat(getComputedStyle(txt).lineHeight) || parseFloat(getComputedStyle(txt).fontSize) * 1.6,
      stripShown: !strip.hidden, strip: stripBox, stripRight: right, stripClass: strip.className,
      stripSurface: getComputedStyle(strip).backgroundColor, column: box(q('#log')),
      input: box(q('#cbox')), logBottom: box(q('#log')).bottom,
      prev: box(row.previousElementSibling.querySelector('.m') ?? row.previousElementSibling),
      // 筋の中で稼働表示の下に残る余白（スクロールしきった列の下端まで）
      tail: (() => { const log = q('#log'); return log.scrollHeight - (m.getBoundingClientRect().bottom - log.getBoundingClientRect().top + log.scrollTop); })(),
      work: q('#workEntry').hidden ? null : box(q('#workEntryButton')),
      context: q('#contextMeterWrap').offsetParent ? box(q('#contextMeterWrap')) : null,
      usage: q('#usageChip').offsetParent ? box(q('#usageChip')) : null,
    };
  });
  const cases = [{ name: 'スマホ 360', width: 360 }, { name: 'PC 1280', width: 1280 }, { name: 'PC 1280 パネル', width: 1280, panel: true }];
  const shape = async (kind, c) => {
    await page.setViewportSize({ width: c.width, height: 800 });
    await panel(!!c.panel);
    if (kind === 'arc') await page.waitForFunction(() => document.querySelector('#thread .m.activity .el:not([hidden])')?.textContent);
    await page.evaluate(() => { const log = document.querySelector('#log'); log.scrollTop = log.scrollHeight; });
    await page.waitForTimeout(150);
    const r = await measure();
    const at = `${c.name} ${kind === 'arc' ? '弧' : '衛星'}`;
    check(`${at}: 稼働表示は #thread の最後の子の節で、帯には入れない`, r.last && !r.inStrip, r);
    check(`${at}: 筋は節の点の中心で終わる`, r.spine && Math.abs(r.spine.x - r.dot.cx) < 1 && Math.abs(r.spine.bottom - r.dot.cy) < 1 && Math.abs(r.dot.size - 7) < 0.1, r);
    check(`${at}: 点はほかの発言の節と同じ溝の ${c.width < 700 ? 12 : 20}px`, Math.abs(r.dot.cx - r.row.left - (c.width < 700 ? 12 : 20)) < 1, r);
    check(`${at}: 印は${kind === 'arc' ? '弧（道 1 本）' : '衛星（点 1 個）'}`, kind === 'arc' ? r.arcs === 1 && r.sats === 0 : r.sats === 1 && r.arcs === 0, r);
    check(`${at}: 円の台・輪郭・点滅するドットを置かない`, r.surface === 'rgba(0, 0, 0, 0)' && r.outline === 'none' && r.border === 'none' &&
      r.runSurface === 'rgba(0, 0, 0, 0)' && !r.old, r);
    check(`${at}: 印の左端はほかの発言の本文の左端（見出し・段落）と同じ列、中心は点と揃う`, r.whoLeft != null && r.paraLeft != null &&
      Math.abs(r.tip.left - r.whoLeft) < 0.5 && Math.abs(r.tip.left - r.paraLeft) < 0.5 && Math.abs(r.tip.top + r.tip.height / 2 - r.dot.cy) < 1.5, r);
    check(`${at}: 文言は印の 8px 右で 1 行`, Math.abs(r.txt.left - r.tip.right - 8) < 1 && r.txt.height < r.lineHeight * 1.5, r);
    if (r.el) check(`${at}: 経過は${c.width < 700 ? '文言の後ろ' : '列の右端'}`, c.width < 700
      ? Math.abs(r.el.left - r.txt.right - 8) < 1 && r.txt.width - r.textWidth < 1 : Math.abs(r.el.right - r.m.right) < 1 && r.el.left > r.txt.right, r);
    const below = r.stripShown ? r.strip.top : r.input.top;
    check(`${at}: 最後の発言のすぐ下に置き、帯の段（高さ 40px）は無い`, r.m.top - r.prev.bottom >= 0 && r.m.top - r.prev.bottom <= 24 && r.m.height <= 30, r);
    check(`${at}: 下の余白は小さく、入力欄と重ならない`, r.tail <= 32 && r.m.bottom <= r.logBottom + 0.5 && r.logBottom <= below + 1, r);
    if (r.stripShown) {
      check(`${at}: 帯は透明で入力欄の 8px 上`, r.stripSurface === 'rgba(0, 0, 0, 0)' && Math.abs(r.input.top - r.strip.bottom - 8) < 1, r);
      check(`${at}: 帯の札は列からはみ出さない`, r.stripRight <= r.strip.right + 0.5 && r.strip.right <= r.input.right + 1 && r.strip.left >= r.input.left - 1, r);
    }
    // 文脈と使用量だけなら 402px にそのまま入る。作業ボタンも並ぶと入り切らないので詰めた形（.compact）にする
    if (c.panel) check(`${at}: パネルで狭まった列に${r.work ? '詰めた帯' : '帯'}が収まる`, r.strip.width < 700 && r.stripRight <= r.strip.right + 0.5 &&
      (!r.work || /\bcompact\b/.test(r.stripClass)), r);
    if (c.width === 1280 && !c.panel && r.work) check(`${at}: 760px 列に作業・文脈・使用量が 1 行`, Math.abs(r.strip.width - 760) < 1 &&
      r.context && r.usage && r.work.right <= r.context.left && r.context.right <= r.usage.left && Math.abs(r.work.top + r.work.height / 2 - (r.usage.top + r.usage.height / 2)) < 2, r);
    return r;
  };

  await page.evaluate(() => document.querySelector('#newSession').click());
  // 列があふれる長さにして、末尾までスクロールした列で入力欄との間を測る
  await send(`echo:${Array.from({ length: 40 }, (_, i) => `${i + 1} 行目の返答`).join('\n\n')}`);
  await page.locator('.m.ai .body').waitFor();
  await page.locator('#abort').waitFor({ state: 'hidden' });

  // 走っている間（弧）
  await send('slow');
  await page.locator('#thread .m.activity .run:not(.sat)').waitFor();
  try {
    for (const c of cases) await shape('arc', c);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('動きを減らす設定で弧を止める', await page.evaluate(() =>
      getComputedStyle(document.querySelector('#thread .m.activity .run svg')).animationName === 'none'), null);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  } finally { await panel(false); await stop(); }

  // 裏の結果待ち（衛星）。作業ボタンが帯に出る
  await send('bg 1 300');
  await page.locator('#thread .m.activity .run.sat').waitFor();
  try {
    for (const c of cases) await shape('sat', c);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('動きを減らす設定で衛星を止める', await page.evaluate(() =>
      getComputedStyle(document.querySelector('#thread .m.activity .run.sat svg')).animationName === 'none'), null);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  } finally { await panel(false); await stop(); }

  // 完了した作業の入口を共通の描画部品で作る。fake の完了履歴は一覧を開くまで取得されない。
  const idleFixture = await page.evaluate(async () => {
    const { createBackgroundChip } = await import('/background-chip.mjs');
    const button = document.querySelector('#workEntryButton');
    window.__waitStripOriginal = [...button.childNodes];
    const old = { workHidden: document.querySelector('#workEntry').hidden, stripHidden: document.querySelector('#contextStrip').hidden };
    button.replaceChildren();
    createBackgroundChip(button).update([{ group: 'agent', live: false, kind: 'compat' }], 'idle');
    document.querySelector('#workEntry').hidden = false;
    document.querySelector('#contextStrip').hidden = false;
    return old;
  });
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const r = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const strip = q('#contextStrip').getBoundingClientRect();
      const work = q('#workEntryButton').getBoundingClientRect();
      const input = q('#cbox').getBoundingClientRect();
      return { shown: !q('#contextStrip').hidden && !q('#workEntry').hidden,
        fits: work.right <= strip.right + 1 && work.left >= strip.left,
        gap: input.top - strip.bottom, activity: !!q('.m.activity'),
        surface: getComputedStyle(q('#workEntryButton')).backgroundColor };
    });
    check(`${width}: 待ちがなくても作業ボタンの段が成立し、常時の背景は透明`, r.shown && r.fits && !r.activity && Math.abs(r.gap - 8) < 1 && r.surface === 'rgba(0, 0, 0, 0)', r);
  }
  await page.evaluate(old => {
    document.querySelector('#workEntryButton').replaceChildren(...window.__waitStripOriginal);
    delete window.__waitStripOriginal;
    document.querySelector('#workEntry').hidden = old.workHidden;
    document.querySelector('#contextStrip').hidden = old.stripHidden;
  }, idleFixture);
  return results.join('\n');
}
