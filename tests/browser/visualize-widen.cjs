// playwright-cli run-code --filename=tests/browser/visualize-widen.cjs
// 会話内の可視化を「広げる」（web/visualize-widen.mjs、ADR 0252）: 道具の並びの左端にあり、押すと列の幅を越えて本文の領域の右端の 4px 内側まで広がる。
//   名前が「元の幅に戻す」に変わる・Esc で戻る・広げたまま窓の幅を変えても端に付いたまま・幅 700px 以下では出さない。
// 道具の並びは触れたときかフォーカスが入ったときに出る。ここはキーボード（フォーカス）で出す
// （headless では、別プロセスの iframe の上のポインターが親の :hover にならないことがある）。
// 種を入れた fake サーバーを別ポート・別のデータ置き場で立ててから流す（実データには向けない）:
//   node tests/browser/visualize-widen-seed.mjs <空のデータ置き場> <作業ディレクトリ>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<データ置き場> AGENT_HOST_PORT=7439 AGENT_HOST_TOKEN=visualize-widen-test AGENT_HOST_LOCALE=ja node core/server.mjs
async (page) => {
  const HOME = 'http://127.0.0.1:7439/?token=visualize-widen-test';
  const ID = 'visualize-widen';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const near = (a, b, d = 1.5) => Math.abs(a - b) <= d;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(HOME);
  await page.locator(`.row[data-session="${ID}"]`).waitFor();
  // 初めての案内は少し遅れて開くことがある
  if (await page.locator('#onboardingDialog[open]').waitFor({ timeout: 1500 }).then(() => true, () => false)) await page.locator('#closeOnboarding').click();
  await page.locator(`.row[data-session="${ID}"]`).click();
  await page.locator('#thread .present-visualization.visualize-seamless iframe').waitFor();
  await page.waitForTimeout(400);

  const card = '#thread .present-visualization';
  const button = page.locator(`${card} .visualize-widen`);
  // 可視化の枠と、広げられる範囲（.mw-body の padding の箱）
  const geo = () => page.evaluate((sel) => {
    const c = document.querySelector(sel), b = c.closest('.mw-body');
    const cr = c.getBoundingClientRect(), br = b.getBoundingClientRect();
    const tools = c.querySelector('.present-tools'), btn = c.querySelector('.visualize-widen');
    return {
      left: cr.left, right: cr.right, width: cr.width, bodyLeft: br.left, bodyRight: br.right,
      widened: c.classList.contains('visualize-widened'), label: btn.getAttribute('aria-label'),
      shown: getComputedStyle(btn).display !== 'none', first: tools.querySelector('button') === btn, toolsOpacity: getComputedStyle(tools).opacity,
    };
  }, card);
  const settle = () => page.waitForTimeout(800); // margin の動き（--dur-slow）が終わるまで

  // 1. 元の幅。道具の並びの左端に「広げる」がある
  const before = await geo();
  check(before.shown && before.first && before.label === '広げる', `「広げる」は道具の並びの左端にある（${JSON.stringify(before)}）`);
  check(before.width <= 768 + 1, `元の幅は列（760px）と左右の 4px（${before.width}）`);
  await button.focus();
  await page.waitForTimeout(300); // 不透明度の動き（--dur-fast）
  check((await geo()).toolsOpacity === '1', 'フォーカスが入ると道具の並びが出る');

  // 2. 押すと本文の領域の右端の 4px 内側まで広がり、名前が変わる
  await page.keyboard.press('Enter');
  await settle();
  const wide = await geo();
  check(wide.widened && wide.width > before.width + 40, `広げると幅が増える（${before.width} → ${wide.width}）`);
  check(near(wide.left, wide.bodyLeft + 4) && near(wide.right, wide.bodyRight - 4), `広げた枠は本文の領域の 4px 内側に収まる（${JSON.stringify(wide)}）`);
  check(wide.label === '元の幅に戻す', `広げた後の名前は「元の幅に戻す」（${wide.label}）`);

  // 3. Esc で元の幅に戻る
  await page.keyboard.press('Escape');
  await settle();
  const back = await geo();
  check(!back.widened && near(back.width, before.width) && back.label === '広げる', `Esc で元の幅と名前に戻る（${back.width}）`);

  // 4. 広げたまま窓を広げても、右端に付いたまま
  await button.focus();
  await page.keyboard.press('Enter');
  await settle();
  await page.setViewportSize({ width: 1600, height: 800 });
  await settle();
  const wider = await geo();
  check(wider.widened && near(wider.left, wider.bodyLeft + 4) && near(wider.right, wider.bodyRight - 4), `窓を広げても本文の領域の 4px 内側に付いたまま（${JSON.stringify(wider)}）`);

  // 5. 幅 700px 以下では出さない
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(300);
  check(!(await geo()).shown, '幅 700px では「広げる」を出さない');
  return { passed: true, checks: results };
}
