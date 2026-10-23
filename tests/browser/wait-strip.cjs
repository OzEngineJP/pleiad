// fake サーバーで案内とログインを済ませて実行する。docs/design-system.md §6・会話の圧縮。
async page => {
  const results = [];
  const check = (label, ok, detail) => {
    if (!ok) throw Error(`${label}: ${JSON.stringify(detail)}`);
    results.push(`OK ${label}`);
  };
  await page.evaluate(() => document.querySelector('#newSession').click());
  await page.locator('#prompt').fill('echo:ready');
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('.m.ai .body').waitFor();
  await page.locator('#abort').waitFor({ state: 'hidden' });
  await page.locator('#prompt').fill('bg 1 300');
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('#contextStrip .activity .wait-dot').waitFor();
  try {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const r = await page.evaluate(() => {
        const q = s => document.querySelector(s);
        // 通常のメーターと待ちの行を測る。圧縮予約の補足は別の状態として扱う。
        q('#contextStripText').textContent = '';
        for (const n of [...q('#contextStripStatus').children]) if (n.id !== 'contextStripText') n.remove();
        const box = s => q(s).getBoundingClientRect().toJSON();
        const style = s => getComputedStyle(q(s));
        const dot = box('#contextStrip .activity-tip');
        const text = box('#contextStrip .activity .txt');
        const band = box('#contextStrip .wait-band');
        const strip = box('#contextStrip');
        const work = box('#workEntryButton');
        const input = box('#cbox');
        return { dot, text, band, strip, work, input,
          surface: style('.activity-tip').backgroundColor, outline: style('.activity-tip').outlineStyle,
          workSurface: style('#workEntryButton').backgroundColor,
          inHistory: !!q('#thread .m.activity'),
          logBottom: box('#log').bottom,
          svg: q('#contextStrip .activity-tip svg') !== null,
          dotAnimation: style('.wait-dot').animationName,
          context: box('#contextMeterWrap'), usage: box('#usageChip'),
          textGap: input.top - text.bottom,
        };
      });
      check(`${width}: 円の面・輪郭・回転印を置かない`, r.surface === 'rgba(0, 0, 0, 0)' && r.outline === 'none' && !r.svg, r);
      check(`${width}: ドットの右に文言、直下の帯を揃える`, Math.abs(r.text.left - r.dot.right - 8) < 1 && Math.abs(r.band.left - r.text.left) < 1 && r.band.top >= r.text.bottom, r);
      check(`${width}: 入力欄まで8px、文字から24px以下`, Math.abs(r.input.top - r.strip.bottom - 8) < 1 && r.textGap <= 24, r);
      check(`${width}: 履歴と操作が重ならない`, !r.inHistory && r.logBottom <= r.strip.top && r.text.right <= r.work.left && r.work.right <= r.strip.right + 1, r);
      check(`${width}: 作業ボタンの常時背景は透明`, r.workSurface === 'rgba(0, 0, 0, 0)', r);
      if (width === 360) check('スマホ: ドットは端から約10px', r.dot.left >= 9 && r.dot.left <= 12, r);
      if (width === 1280) check('PC: 760px列に作業・文脈・使用量と待ちが同じ1行',
        Math.abs(r.strip.width - 760) < 1 && r.work.top < r.text.bottom && r.work.bottom > r.text.top &&
        r.work.right <= r.context.left && r.context.width > 0 && r.context.right <= r.usage.left && r.usage.width > 0 && r.usage.right <= r.strip.right + 1, r);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('動きを減らす設定でドット・帯を静止', await page.evaluate(() =>
      getComputedStyle(document.querySelector('#contextStrip .wait-dot')).animationName === 'none' &&
      getComputedStyle(document.querySelector('#contextStrip .wait-band'), '::after').animationName === 'none'), null);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  } finally {
    await page.locator('#abort').click();
    await page.locator('#contextStrip .activity').waitFor({ state: 'detached' });
  }
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
        gap: input.top - strip.bottom, activity: !!q('#contextStrip .activity') };
    });
    check(`${width}: 待ちがなくても作業ボタンの段が成立`, r.shown && r.fits && !r.activity && Math.abs(r.gap - 8) < 1, r);
  }
  await page.evaluate(old => {
    document.querySelector('#workEntryButton').replaceChildren(...window.__waitStripOriginal);
    delete window.__waitStripOriginal;
    document.querySelector('#workEntry').hidden = old.workHidden;
    document.querySelector('#contextStrip').hidden = old.stripHidden;
  }, idleFixture);
  return results.join('\n');
}
