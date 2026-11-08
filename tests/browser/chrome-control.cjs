// playwright-cli run-code --filename=tests/browser/chrome-control.cjs
// 右の欄の Chrome の映像に重ねる層と、会話の側の一時停止の帯（web/chrome-control.mjs。ADR 0148・0154・0296）: 古い状態の一行が残っていない・押した位置の輪・
// 一時停止中の帯と戻すボタン・撮影を断つ幕は映像の側の 1 つだけ・窓が無くなっても一時停止中は戻せる・会話の引き継ぎの行・動きを減らす設定・狭い幅・スマホの帯の読み上げ。
// 誰が操作中かと止める・任せるはアドレスバーの札（tests/browser/browser-unify-tabs.cjs）。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token chrome-control-test, port 7435, AGENT_HOST_LOCALE=ja). Never run against live data.
// Chrome の窓の知らせ・映像・状態はサーバーに無い（偽の Chrome が要る）ので、ページの中で届いたことにする（WebSocket の onmessage で配り、送るコマンドは send を包んで控えて応答を作る）。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };

  await page.addInitScript(() => {
    if (window.__ccWrapped) return;
    window.__ccWrapped = true;
    window.__sockets = [];
    window.__sent = [];
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
          const control = { chromeTakeOver: 'paused', chromeResume: 'running', chromeStop: 'stopped' };
          if (m.kind === 'command' && (m.command in control || ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck'].includes(m.command))) {
            window.__sent.push({ command: m.command, args: m.args });
            const result = m.command === 'browserScreencast' ? { tabId: 'T1', state: { tabId: 'T1', agent: false, suspended: false, tabs: 1 } }
              : m.command in control ? { sessionId: m.args.sessionId, state: control[m.command], since: null } : {};
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result }) })));
            return;
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (message) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    window.__event = (event) => window.__deliver({ kind: 'event', event });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const sent = (command) => page.evaluate((c) => window.__sent.filter((x) => x.command === c), command);
  const control = (id, state, since = null) => page.evaluate(([i, s, at]) => window.__event({ type: 'chromeControl', sessionId: i, state: s, since: at }), [id, state, since]);

  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('echo:chrome control');
  await page.locator('#prompt').press('Control+Enter');
  // 自分の発言が会話に載り、返事が済んでから会話の id を読む（先に読むと、送る前の仮の id を掴む）
  await page.locator('#thread .m.user').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  check(!!sessionId, 'a conversation exists');

  // ============ 1. 窓があるとき、映像の上に層が重なる。古い状態の一行（止める・引き継ぐ）は無い
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.locator('#browserEntry').click();
  await page.locator('#filePreview[data-panel="chrome-window"]').waitFor();
  await page.locator('.cp-screen').waitFor();
  check(await page.locator('.cp-screen .cc-overlay').count() === 1, 'the overlay sits on top of the video');
  check(await page.locator('#chromeBanner .cc-banner').count() === 1 && await page.locator('#chromeBanner .cc-banner').isHidden(), 'the banner is in the conversation side and hidden');
  const oldRow = () => page.locator('.cc, .cc-status, .cc-text').count();
  const oldButtons = () => page.locator('#filePreview button:visible', { hasText: /^(止める|引き継ぐ)$/ }).count();
  check(await oldRow() === 0 && await oldButtons() === 0, 'no old status row and no stop / take-over buttons in the panel');

  // ============ 2. running でも古い一行は出ない（誰が操作中かはアドレスバーの札）
  await control(sessionId, 'running');
  await page.waitForTimeout(100);
  check(await oldRow() === 0 && await oldButtons() === 0 && await page.locator('#chromeBanner .cc-banner').isHidden(), 'running: no old row, no banner');

  // ============ 3. 押した位置の輪（映像の元の大きさが分かるとき、割合で置く）
  await page.evaluate(([id, data]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, seq: 1, data, metadata: { deviceWidth: 1000, deviceHeight: 500 } }), [sessionId, PNG]);
  await page.waitForFunction(() => document.querySelector('.cp-frame')?.getAttribute('src'));
  await page.evaluate((id) => window.__event({ type: 'chromeTap', sessionId: id, x: 250, y: 125, windowId: 1 }), sessionId);
  const ring = page.locator('.cp-screen .cc-ring');
  await ring.waitFor({ state: 'attached' });
  check(await ring.evaluate((el) => el.style.left === '25%' && el.style.top === '25%'), 'the ring is placed by the share of the page');
  check(await ring.evaluate((el) => getComputedStyle(el).borderTopWidth === '0px' && /rgb/.test(getComputedStyle(el).boxShadow)), 'the ring is a shadow ring (no border)');
  check(await ring.evaluate((el) => getComputedStyle(el).pointerEvents === 'none'), 'the ring never takes the pointer');
  await page.waitForFunction(() => !document.querySelector('.cp-screen .cc-ring'), null, { timeout: 3000 });
  check(true, 'the ring goes away');
  await page.evaluate(() => window.__event({ type: 'chromeTap', sessionId: 'someone-else', x: 1, y: 1 }));
  check(await page.locator('.cp-screen .cc-ring').count() === 0, 'taps of other conversations are ignored');

  // ============ 4. paused（帯と戻すボタン・映像の幕は映像の側の 1 つだけ）
  await control(sessionId, 'paused', 1);
  await page.locator('#chromeBanner .cc-banner').waitFor({ state: 'visible' });
  check((await page.locator('#chromeBanner .cc-banner-text').textContent()) === '一時停止中 · あなたが Chrome で操作しています', 'the banner text');
  check(await page.locator('#chromeBanner .cc-banner').getAttribute('role') === null, 'the banner has no role (the address-bar badge says the same)');
  check(/に戻す$/.test(await page.locator('#chromeBanner .cc-banner .cc-btn').textContent()) && await oldRow() === 0, 'paused: the banner has the hand-back button, and there is still no old row');
  // 撮影を断つ幕は映像の側（server が suspended を送る）。こちらの層は幕を持たない
  await page.evaluate((id) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'state', sessionId: id, state: { tabId: 'T1', agent: false, suspended: true, tabs: 1 } }), sessionId);
  await page.locator('.cp-veil').waitFor({ state: 'visible' });
  check(await page.locator('.cp-veil').count() === 1 && await page.locator('.cc-veil').count() === 0, 'one veil only (the video side)');
  check((await page.locator('.cp-veil').textContent()).includes('映像を止めています'), 'the veil says the video is stopped');
  // 窓が無くなっても、一時停止中は戻せる
  // 右の欄の入口は窓が無くても出たまま（見出しのアイコンは 1 つ）。知らせが届くのを少し待つ
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 0, operating: false }), sessionId);
  await page.waitForTimeout(200);
  check(await page.locator('#chromeBanner .cc-banner').isVisible(), 'the banner stays while paused even if the window is gone');
  await page.locator('#chromeBanner .cc-banner .cc-btn').click();
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'chromeResume'));
  check((await sent('chromeResume'))[0].args.sessionId === sessionId, 'the banner button sends chromeResume');
  await control(sessionId, 'running');
  await page.locator('#chromeBanner .cc-banner').waitFor({ state: 'hidden' });
  check(true, 'the banner goes away when resumed');

  // ============ 5. 窓が戻る。止めた後・待機中も帯は出ない。ほかの会話の一時停止も出ない
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.locator('#browserEntry').waitFor({ state: 'visible' });
  // ビューアの無い端末では、窓が無くなったときにパネルも閉じる。窓が戻っても閉じたままなので、入口から開き直す
  if (await page.locator('#browserEntry').getAttribute('aria-expanded') !== 'true') await page.locator('#browserEntry').click();
  await page.locator('.cp-screen').waitFor({ state: 'visible' });
  await control(sessionId, 'stopped');
  check(await page.locator('#chromeBanner .cc-banner').isHidden(), 'stopped: no banner');
  await control(sessionId, 'idle');
  check(await page.locator('#chromeBanner .cc-banner').isHidden(), 'idle: no banner');
  await page.evaluate(() => window.__event({ type: 'chromeControl', sessionId: 'someone-else', state: 'paused', since: 1 }));
  check(await page.locator('#chromeBanner .cc-banner').isHidden(), 'other conversations do not change this one');

  // ============ 6. 会話の中の行（引き継いで戻した）
  await page.evaluate((id) => window.__event({ type: 'present', sessionId: id, kind: 'chromeHandover', chromeHandover: { seconds: 72 }, by: 'ai', at: new Date().toISOString() }), sessionId);
  await page.locator('.cc-line').waitFor();
  check(/あなたが引き継ぎ · .+ に戻しました · 1 分 12 秒/.test(await page.locator('.cc-line').last().textContent()), 'the hand-over line in the conversation');

  // ============ 7. 動きを減らす設定では、輪は広がらず薄く出て消えるだけ
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // 開き直した映像には、まだフレームが届いていない（輪は元の大きさが分かってから置く）
  await page.evaluate(([id, data]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, seq: 2, data, metadata: { deviceWidth: 1000, deviceHeight: 500 } }), [sessionId, PNG]);
  await page.waitForFunction(() => document.querySelector('.cp-frame')?.getAttribute('src'));
  await page.evaluate((id) => window.__event({ type: 'chromeTap', sessionId: id, x: 10, y: 10, windowId: 1 }), sessionId);
  await page.locator('.cp-screen .cc-ring').waitFor({ state: 'attached' });
  check(await page.locator('.cp-screen .cc-ring').evaluate((el) => getComputedStyle(el).animationName === 'cc-ring-hold'), 'reduced motion: the ring only fades');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ============ 8. 狭い幅(360px): 一時停止の帯と戻すボタンが収まる
  await page.setViewportSize({ width: 360, height: 760 });
  await control(sessionId, 'paused', 1);
  await page.locator('#chromeBanner .cc-banner').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const box = await page.locator('#chromeBanner .cc-banner').boundingBox();
  check(!!box && box.width <= 360, `the banner fits 360px (${box?.width})`);
  check(await page.locator('#chromeBanner .cc-banner').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the banner does not overflow');
  await control(sessionId, 'running');
  await page.setViewportSize({ width: 1280, height: 800 });

  // ============ 9. 窓が無くなって一時停止でもなければ、帯は隠れたまま
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 0, operating: false }), sessionId);
  await page.waitForTimeout(200);
  check(await page.locator('#chromeBanner .cc-banner').isHidden(), 'no window and not paused: no banner');

  // 後片付け: パネルを閉じる
  await page.keyboard.press('Escape').catch(() => {});
  if (await page.locator('#filePreview[data-panel="chrome-window"]').isVisible()) await page.locator('#browserEntry').click();
  // Unified components are mounted independently of the legacy panel assembly.
  const unified = await page.evaluate(async () => {
    const { createControlBadge } = await import('/chrome-control.mjs');
    const mount = document.createElement('div'); document.body.append(mount);
    const calls = [], values = [];
    const badge = createControlBadge({ mount, onResume: () => calls.push('resume') });
    values.push(badge.element.hidden === true);
    badge.update({ visible: true });
    const btn = badge.element.querySelector('.b2-action');
    values.push(badge.element.hidden === false && badge.element.textContent.includes('あなたが操作中') && btn.textContent === 'AI に戻す');
    values.push(badge.element.querySelector('.b2-pause') !== null && badge.element.querySelector('.b2-grow') !== null);
    btn.click(); await Promise.resolve();
    values.push(calls.join() === 'resume');
    badge.destroy(); mount.remove(); return values;
  });
  check(unified.every(Boolean), `unified badge: hidden before visible, 「あなたが操作中」+「AI に戻す」, II mark, resume (${JSON.stringify(unified)})`);
  return results.join('\n');
}
