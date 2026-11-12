// playwright-cli run-code --filename=tests/browser/browser-handoff-ai-tab.cjs
// AI のタブの映像は、[引き継ぐ] を押すまで見るだけ（ADR 0321。実際の画面・web/browser-unify.mjs・web/chrome-panel.mjs・web/screencast-frame.mjs・web/chrome-control.mjs）:
//   映像の上の 1 行（<名前> が Chrome を操作中 [引き継ぐ]・role=status）・触っても何も送らず [引き継ぐ] を強調・Tab で [引き継ぐ] に届き Enter・Space で引き継げる（スマホの幅も外付けのキーボードで輪が出る）・
//   引き継ぐと「あなたが操作中 [AI に戻す]」（同じ高さ）で映像が操作できる・人が開いたタブは引き継ぎなしで触れる・最初の絵が届くまでの骨組み（タブの列・スマホのタブ一覧・カードの「画面を開く」から）・スマホの 1 行。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (AGENT_HOST_LOCALE=ja). Never run against live data.
// Chrome の窓の知らせ・映像・状態はサーバーに無い（偽の Chrome が要る）ので、ページの中で届いたことにする。映像への入力・引き継ぎは WebSocket の送りを包んで控え、応答を作る。
// page.__shot(name) があれば、場面ごとに画像を撮る（runner が渡す）。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); page.__trace?.(label); };
  const phone = page.viewportSize().width <= 600;   // スマホ幅は、アドレスバーの下の 1 行・指のタップ・キーボード無し
  const shot = async name => { if (page.__shot) await page.__shot(name); };

  await page.addInitScript(() => {
    if (window.__hoWrapped) return;
    window.__hoWrapped = true;
    window.__sockets = [];
    window.__sent = [];
    window.__sid = null;
    window.__state = null;
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          const m = JSON.parse(e.data);
          if (m.kind === 'response' && m.result && typeof m.result === 'object' && 'osActions' in m.result && 'hostName' in m.result) m.result.chromeWindow = true;
          return fn({ data: JSON.stringify(m) });
        });
      }
      get onmessage() { return super.onmessage; }
      send(d) {
        try {
          const m = JSON.parse(d);
          const stub = ['chromeTakeOver', 'chromeResume', 'chromeStop', 'chromePinWindow', 'browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput'];
          if (m.kind === 'command' && stub.includes(m.command)) {
            window.__sent.push({ command: m.command, args: m.args });
            let result = {};
            if (m.command === 'browserScreencast') result = { tabId: window.__state?.tabId ?? 'T1', state: window.__state };
            else if (m.command === 'chromeTakeOver' || m.command === 'chromeResume') {
              const human = m.command === 'chromeTakeOver';
              result = { sessionId: m.args.sessionId, state: human ? 'paused' : 'running', since: null };
              // 持ち手は、サーバーが知らせる（tab:holder）。引き継ぎは AI のタブ（agentTabId）の持ち手を替える
              const target = window.__state?.agentTabId;
              if (window.__autoHolder !== false) queueMicrotask(() => window.__event({ type: 'tab:holder', sessionId: m.args.sessionId, targetId: target, holder: human ? 'human' : 'ai', by: 'pc' }));
            }
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result }) })));
            return;
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (message) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    window.__event = (event) => window.__deliver({ kind: 'event', event });
    // 偽の Chrome の様子: AI のタブ T1 と、人が開いたタブ H1。映像は T1 を映す
    window.__setState = (patch) => { window.__state = { ...window.__state, ...patch, sequence: (window.__state?.sequence ?? 0) + 1 }; window.__deliver({ kind: 'screencast', source: 'chrome', type: 'state', sessionId: window.__sid, state: window.__state }); };
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});

  // 本物の Chrome の絵に見えるよう、ページ 1 枚の絵を描いて frame として送る
  const frame = async (title) => {
    const data = await page.evaluate(([name]) => {
      const c = document.createElement('canvas'); c.width = 1000; c.height = 640;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 1000, 640);
      g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, 1000, 70);
      g.fillStyle = '#1f2328'; g.font = 'bold 30px sans-serif'; g.fillText(name, 40, 46);
      g.fillStyle = '#d0d7de'; for (let i = 0; i < 6; i++) g.fillRect(40, 120 + i * 70, 620 - (i % 3) * 120, 22);
      return c.toDataURL('image/jpeg', 0.8).split(',')[1];
    }, [title]);
    return data;
  };
  const sendFrame = async (tabId, title, seq) => {
    const data = await frame(title);
    await page.evaluate(([id, tab, data, seq]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, tabId: tab, seq, data, metadata: { deviceWidth: 1000, deviceHeight: 640 } }), [await page.evaluate(() => window.__sid), tabId, data, seq]);
  };
  const sent = (command) => page.evaluate((c) => window.__sent.filter((x) => x.command === c), command);

  if (!phone) await page.locator('#newSession').click();
  await page.locator('#prompt').fill('echo:handoff ai tab');
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('#thread .m.user').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  check(!!sessionId, 'a conversation exists');
  await page.evaluate((id) => { window.__sid = id; }, sessionId);

  // 窓がある。映像は AI のタブ T1（agentTabId）を映し、人が開いたタブ H1 もある
  await page.evaluate((id) => {
    window.__state = { sequence: 1, tabId: 'T1', agent: true, suspended: false, tabs: 2, pinnedWindowId: null, pinnedTabId: null, agentTabId: 'T1', list: [{ tabId: 'T1', windowId: 1, title: '請求書の一覧' }, { tabId: 'H1', windowId: 1, title: '調べもの' }] };
    window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: true });
    window.__event({ type: 'chromeControl', sessionId: id, state: 'running', since: null });
    window.__event({ type: 'tab:info', sessionId: id, reset: true, tabs: [
      { sessionId: id, targetId: 'T1', windowId: 1, title: '請求書の一覧', url: 'https://app.example.test/invoices' },
      { sessionId: id, targetId: 'H1', windowId: 1, title: '調べもの', url: 'https://docs.example.test/notes' }] });
  }, sessionId);
  await page.locator('#browserEntry').click();
  await page.locator('#filePreview[data-panel="chrome-window"]').waitFor();
  await page.locator('.cp-screen').waitFor();
  await sendFrame('T1', '請求書の一覧', 1);
  await page.waitForFunction(() => document.querySelector('.cp-frame')?.getAttribute('src'));
  await page.waitForTimeout(400);

  // ============ 1. AI のタブを見ている間: 「Claude が Chrome を操作中 [引き継ぐ]」。操作できる前の 1 行
  const take = page.getByRole('button', { name: '引き継ぐ', exact: true });
  await take.waitFor({ state: 'visible' });
  const status = page.locator('.b2-control:not([hidden])').first();
  check(await status.isVisible() && await status.getAttribute('role') === 'status', 'the row is exposed as a status');
  const text = await status.textContent();
  check(/が Chrome を操作中/.test(text) && /引き継ぐ/.test(text), 'the row says who operates, with the take-over button: ' + text.trim());
  const heightAi = await status.evaluate((el) => el.getBoundingClientRect().height);
  await shot('ai-row-light');

  // ============ 2. 見るだけ: タップ・キー・ホイールは何も送らず、人の操作にも数えない。触れたら [引き継ぐ] を強調する
  const screen = page.locator('.cp-screen');
  const box = await screen.boundingBox();
  const touch = (dx = 0) => phone ? page.touchscreen.tap(box.x + box.width / 2 + dx, box.y + box.height / 2) : page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2);
  await touch();
  await page.waitForTimeout(150);
  check(await take.evaluate((el) => el.classList.contains('nudge')), 'touching the view-only video emphasizes the take-over button');
  await shot('ai-nudge-light');
  if (!phone) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await screen.focus();
    await page.keyboard.type('x');
  }
  await page.waitForTimeout(450);
  const inputs = () => page.evaluate(() => window.__sent.filter((x) => x.command === 'browserScreencastInput' && x.args.input.type !== 'cursor').map((x) => x.args.input.type));   // 読むだけのカーソルの問い合わせは数えない
  const sentInputs = await inputs();
  check(sentInputs.length === 0, 'click, wheel and keys are not sent to the page while view-only: ' + JSON.stringify(sentInputs));
  check((await sent('chromeTakeOver')).length === 0, 'touching does not take over');
  await page.waitForTimeout(1000);
  check(!(await take.evaluate((el) => el.classList.contains('nudge'))), 'the emphasis goes away by itself');

  // ============ 3. キーボード: Tab で [引き継ぐ] に届き、Enter で引き継ぐ。押したら入力が映像へ移る
  // 行は映像のすぐ上にあるので、映像から Shift+Tab で届き、そこから Tab で映像へ戻れる
  if (!phone) {
    await screen.focus();
    await page.keyboard.press('Shift+Tab');
    check(await take.evaluate((el) => document.activeElement === el), 'Shift+Tab from the video reaches the take-over button (it sits right above the video)');
    await page.keyboard.press('Tab');
    check(await screen.evaluate((el) => document.activeElement === el), 'Tab from the button goes back to the video');
    await page.keyboard.press('Shift+Tab');
    await shot('ai-focus-light');
    await page.keyboard.press('Enter');
  } else await take.tap();
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'chromeTakeOver'));
  const tk = (await sent('chromeTakeOver'))[0].args;
  check(tk.by === 'screen' && tk.sessionId === sessionId, 'Enter sends chromeTakeOver by screen');
  const back = page.getByRole('button', { name: 'AI に戻す', exact: true }).first();
  await back.waitFor({ state: 'visible' });
  const humanText = await page.locator('.b2-control[data-mode="human"]:not([hidden])').first().textContent();
  check(/あなたが操作中/.test(humanText), 'after taking over: ' + humanText.trim());
  if (!phone) check(await page.locator('.cp-screen').evaluate((el) => document.activeElement === el || el.contains(document.activeElement)), 'focus moved to the video');
  const heightHuman = await page.locator('.b2-control[data-mode="human"]:not([hidden])').first().evaluate((el) => el.getBoundingClientRect().height);
  check(Math.abs(heightAi - heightHuman) < 0.5, `the row keeps its height (${heightAi} → ${heightHuman})`);
  await shot('human-row-light');
  await touch(-40);
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'browserScreencastInput' && x.args.input.type === 'tap'));
  check(true, 'after taking over, a tap is sent to the page');

  // ============ 4. AI に戻すと、また見るだけ
  await back.click();
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'chromeResume'));
  await take.waitFor({ state: 'visible' });
  const before = (await inputs()).length;
  await touch(30);
  await page.waitForTimeout(450);
  check((await inputs()).length === before, 'after handing back to the AI, the video is view-only again');

  // ============ 4b. Space でも [引き継ぐ] を押せる。スマホ幅も、外付けのキーボードで映像から Shift+Tab で届き、輪が出る
  await screen.focus();
  await page.keyboard.press('Shift+Tab');
  check(await take.evaluate((el) => document.activeElement === el), 'Shift+Tab from the video reaches the take-over button' + (phone ? ' (phone width, external keyboard)' : ' (again)'));
  const ring = await take.evaluate((el) => { const c = getComputedStyle(el); return el.matches(':focus-visible') && c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0 ? c.outlineWidth + ' ' + c.outlineStyle : ''; });
  check(!!ring, 'the take-over button shows the focus ring: ' + ring);
  if (phone) await shot('ai-focus-light');
  const takesBefore = (await sent('chromeTakeOver')).length, resumesBefore = (await sent('chromeResume')).length;
  await page.keyboard.press('Space');
  await page.waitForFunction((n) => window.__sent.filter((x) => x.command === 'chromeTakeOver').length > n, takesBefore, { timeout: 3000 });
  check((await sent('chromeTakeOver')).at(-1).args.by === 'screen', 'Space presses the take-over button too (chromeTakeOver by screen)');
  await back.waitFor({ state: 'visible' });
  await back.click();
  await page.waitForFunction((n) => window.__sent.filter((x) => x.command === 'chromeResume').length > n, resumesBefore);
  await take.waitFor({ state: 'visible' });

  // ============ 5. 人が開いたタブ（AI のタブでない）は、引き継ぎなしで触れる
  await page.evaluate(() => { window.__setState({ tabId: 'H1' }); });
  await sendFrame('H1', '調べもの', 2);
  await page.waitForTimeout(300);
  check(await take.count() === 0 || !(await take.isVisible()), 'no take-over button on a tab the human opened');
  await touch(-20);
  await page.waitForFunction(() => window.__sent.filter((x) => x.command === 'browserScreencastInput' && x.args.input.type === 'tap').length >= 2);
  check(true, 'a human-opened tab is touchable without taking over');
  await shot('human-tab-light');
  await page.evaluate(() => { window.__setState({ tabId: 'T1' }); });
  await sendFrame('T1', '請求書の一覧', 3);

  // ============ 6. 骨組み: 最初の絵が届くまで 150ms を超えたら出す。届いたら消える
  await page.evaluate(() => { window.__setState({ tabId: 'H1' }); });
  await sendFrame('H1', '調べもの', 4);
  await page.waitForTimeout(200);
  if (phone) {
    // スマホはタブの列が無い。アドレスバーの [N] でタブ一覧を開き、カードを選ぶ
    await page.locator('.bu-count').click();
    await page.locator('.bu-card-pick').filter({ hasText: '請求書の一覧' }).first().click();
  } else await page.locator('.bu-tab, .bu-tabrow [role="tab"]').filter({ hasText: '請求書の一覧' }).first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const sk = await page.locator('.cp-skeleton').evaluate((el) => !el.hidden).catch(() => false);
  check(sk, 'the skeleton shows while the first frame of the switched tab has not arrived' + (phone ? ' (phone: via the tab list)' : ''));
  await shot('skeleton-light');
  await page.evaluate(() => { window.__setState({ tabId: 'T1' }); });
  await sendFrame('T1', '請求書の一覧', 5);
  await page.waitForTimeout(300);
  check(await page.locator('.cp-skeleton').evaluate((el) => el.hidden), 'the skeleton goes away when the first frame arrives (was shown: ' + sk + ')');

  // ============ 7. カードの [画面を開く] も AI のタブを映し、最初の絵が届くまで骨組みを出す（人のタブを見ている途中から）
  await page.evaluate(() => { window.__setState({ tabId: 'H1' }); });
  await sendFrame('H1', '調べもの', 6);
  await page.waitForTimeout(200);
  if (phone) await page.locator('.bu-conversation').click();   // スマホは会話へ戻ってカードを押す
  await page.evaluate(() => window.__event({ type: 'permission', id: 'handoff-card', sessionId: window.__sid, browserHandoff: { reason: 'login', state: 'operating', by: 'pc' } }));
  const openScreen = page.getByRole('button', { name: '画面を開く', exact: true }).last();
  await openScreen.waitFor({ state: 'visible', timeout: 5000 });
  await openScreen.click();
  await page.waitForTimeout(400);
  const sk2 = await page.locator('.cp-skeleton').evaluate((el) => !el.hidden && el.getBoundingClientRect().height > 0).catch(() => false);
  check(sk2, 'the open-screen button on the card shows the skeleton until the first frame of the AI tab arrives');
  check(await page.evaluate(() => window.__sent.some((x) => x.command === 'chromePinWindow' && x.args.tabId == null)), 'the card unpins the tab the human chose, so the AI tab comes to the front');
  await shot('card-skeleton-light');
  await page.evaluate(() => { window.__setState({ tabId: 'T1' }); });
  await sendFrame('T1', '請求書の一覧', 7);
  await page.waitForTimeout(300);
  check(await page.locator('.cp-skeleton').evaluate((el) => el.hidden), 'the skeleton goes away when the first frame of the AI tab arrives (card path)');

  return results;
}
