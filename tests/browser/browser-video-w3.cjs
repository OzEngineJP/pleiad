// playwright-cli run-code --filename=tests/browser/browser-video-w3.cjs
// W3 映像の触り心地（web/screencast-frame.mjs + core の問い合わせの口）: マウスのドラッグは選択として送る・2・3 回押し・
// 右クリックは点の下のものを聞いて手元にメニュー（コピー・リンクをコピー・リンクを開く・すべて選択）・Ctrl+A/C/X・Shift+矢印・
// hover でカーソルを聞いて合わせる・ホイールはスクロール・貼り付けは入力として送る。
// Chrome 本体は居ない（fake バックエンド）。browserScreencastInput の問い合わせは WS の送りを包んで応答を作る。
// Open an isolated AGENT_HOST_BACKENDS=fake server first. Never run against live data.
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };

  await page.addInitScript(() => {
    if (window.__w3Wrapped) return;
    window.__w3Wrapped = true;
    window.__sockets = [];
    window.__sent = [];
    window.__copied = null;
    window.__info = { menu: { text: '選んだ文字', editable: false, link: 'http://127.0.0.1/target' }, copy: { text: '選んだ文字', editable: false }, cursor: { cursor: 'text' } };
    // クリップボードは許可されない環境があるので、書き込みは覚えるだけの身代わりにする
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => (window.__copied = text, Promise.resolve()), readText: () => Promise.resolve('') } });
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      send(d) {
        try {
          const m = JSON.parse(d);
          if (m.kind === 'command' && (m.command === 'browserScreencast' || m.command === 'browserScreencastStop' || m.command === 'browserScreencastAck' || m.command === 'browserScreencastInput' || m.command === 'chromeNavigate')) {
            window.__sent.push({ command: m.command, args: m.args });
            const input = m.args?.input ?? {};
            const result = m.command === 'browserScreencast' ? { tabId: 'T1', state: { tabId: 'T1', agent: false, suspended: false, tabs: 1 } }
              : m.command === 'browserScreencastInput' && window.__info[input.type] ? { info: window.__info[input.type] } : {};
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result }) })));
            return;
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (message) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    window.__event = (event) => window.__deliver({ kind: 'event', event });
    window.__inputs = () => window.__sent.filter(x => x.command === 'browserScreencastInput').map(x => x.args.input);
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});

  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('echo:w3 video input');
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('#thread .m.user').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  check(!!sessionId, 'a conversation exists');
  const inputs = () => page.evaluate(() => window.__inputs());
  const sent = (command) => page.evaluate((c) => window.__sent.filter((x) => x.command === c), command);

  // 窓があると知らせ、右の欄（一本化のパネル）を開く
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.locator('#browserEntry').click();
  await page.locator('.cp-screen').waitFor();
  check(true, 'the video panel opened');

  // 実際のページらしい絵のフレームを届ける（800×500 の JPEG を canvas で作る）
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 800, 500);
    g.fillStyle = '#222'; g.font = '20px sans-serif';
    g.fillText('The quick brown fox jumps over the lazy dog.', 40, 80);
    g.fillText('Pack my box with five dozen liquor jugs.', 40, 115);
    g.fillStyle = '#0645ad'; g.fillText('リンク先のページへ', 40, 170);
    g.strokeStyle = '#888'; g.strokeRect(40, 210, 320, 36); g.fillStyle = '#666'; g.font = '16px sans-serif'; g.fillText('入力欄', 52, 233);
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
  });
  await page.evaluate(([id, data]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, seq: 1, data, metadata: { deviceWidth: 800, deviceHeight: 500 } }), [sessionId, jpeg]);
  await page.waitForFunction(() => document.querySelector('.cp-frame')?.naturalWidth === 800);
  const screen = page.locator('.cp-screen');
  // <img> は object-fit: contain — 画面の箱の内側で、映像が実際に並ぶ矩形（余白は入力にならない）
  const ibox = await page.locator('.cp-frame').boundingBox();
  const imageScale = Math.min(ibox.width / 800, ibox.height / 500);
  const cw = 800 * imageScale, ch = 500 * imageScale;
  const ox = ibox.x + (ibox.width - cw) / 2, oy = ibox.y + (ibox.height - ch) / 2;
  const at = (x, y) => ({ x: ox + x * imageScale, y: oy + y * imageScale });
  const inputTypes = async () => (await inputs()).map(i => `${i.type}${i.phase ? ':' + i.phase : ''}`).join(',');

  // ============ 1. マウスのドラッグはページの選択として送る（スクロールにしない）
  const p1 = at(60, 80), p2 = at(360, 80);
  const diag = await page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return { hit: hit ? `${hit.tagName}.${hit.className}` : 'null', unify: document.body.classList.contains('browser-unify') };
  }, [p1.x, p1.y]);
  check(/^IMG\.cp-frame|^DIV\.cp-screen/.test(diag.hit) && diag.unify, `the point hits the video surface ${JSON.stringify(diag)}`);
  await page.mouse.move(p1.x, p1.y); await page.mouse.down(); await page.mouse.move(p2.x, p2.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(50);
  check((await inputTypes()).replace(/,cursor$/, '') === 'drag:start,drag:move,drag:move,drag:move,drag:move,drag:end', `mouse drag sends drag start/move/end, not scroll (got: ${await inputTypes()})`);
  // ドラッグの座標は映像の左上からページの CSS px（映像の元の大きさと画面の大きさから変換する）
  const dragStart = (await inputs())[0];
  check(Math.round(dragStart.x) === 60 && Math.round(dragStart.y) === 80, 'drag coords are page CSS px');

  // ============ 2. 続けた押しは 2・3 と数える
  const tap = at(120, 80);
  await page.mouse.click(tap.x, tap.y); await page.mouse.click(tap.x, tap.y); await page.mouse.click(tap.x, tap.y);
  await page.waitForTimeout(50);
  const taps = (await inputs()).filter(i => i.type === 'tap');
  check(taps.map(i => i.clicks).join(',') === '1,2,3', 'repeated presses count 2 and 3');

  // ============ 3. 右クリックは点の下のものを聞いて、手元のメニューを出す
  await page.evaluate(() => { window.__sent = window.__sent.filter(x => x.command !== 'browserScreencastInput'); });
  const menuAt = at(80, 170);
  await page.mouse.click(menuAt.x, menuAt.y, { button: 'right' });
  await page.waitForFunction(() => window.__inputs().some(i => i.type === 'menu'));
  const menuPanel = page.locator('.pop.menu').last();
  await menuPanel.waitFor({ state: 'visible' });
  const menuText = await menuPanel.textContent();
  check(menuText.includes('コピー') && menuText.includes('リンクをコピー') && menuText.includes('リンクを開く') && menuText.includes('すべて選択'), 'the local menu has copy/copy-link/open-link/select-all');
  await page.screenshot({ path: 'D:/dev/pleiad/temporary/screenshots/v8-w3/menu.png' });
  await menuPanel.getByText('リンクを開く').click();
  check((await sent('chromeNavigate'))[0]?.args?.input === 'http://127.0.0.1/target', 'open-link asks Chrome to navigate');
  // 選択の無い答えならコピーは押せない
  await page.evaluate(() => { window.__info.menu = { text: '', editable: false, link: null }; });
  await page.mouse.click(at(80, 80).x, at(80, 80).y, { button: 'right' });
  await page.locator('.pop.menu').last().waitFor({ state: 'visible' });
  const copyRow = page.locator('.pop.menu').last().locator('button', { hasText: 'コピー' }).first();
  check(await copyRow.isDisabled(), 'copy is disabled without a selection');
  check(await page.locator('.pop.menu').last().locator('button', { hasText: '切り取り' }).count() === 0, 'no cut without an editable selection');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__info.menu = { text: '選んだ文字', editable: false, link: 'http://127.0.0.1/target' }; });

  // ============ 4. Ctrl+A はすべて選択のキー、Ctrl+C はページの選択を読んで手元へコピー
  await page.evaluate(() => { window.__sent = window.__sent.filter(x => x.command !== 'browserScreencastInput'); window.__copied = null; });
  await page.mouse.click(at(60, 60).x, at(60, 60).y);   // 映像にフォーカスを入れる
  await page.waitForTimeout(30);
  await page.keyboard.press('Control+a');
  await page.waitForFunction(() => window.__inputs().some(i => i.type === 'key' && i.key === 'a' && i.modifiers?.includes('accel')));
  check(true, 'Ctrl+A sends the accel key');
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => window.__copied === '選んだ文字');
  check((await inputs()).some(i => i.type === 'copy'), 'Ctrl+C asks the page for its selection, then writes the local clipboard');
  // 編集できない選択の Ctrl+X は消さない
  await page.evaluate(() => { window.__copied = null; });
  await page.keyboard.press('Control+x');
  await page.waitForTimeout(120);
  check((await inputs()).filter(i => i.type === 'key' && i.key === 'Backspace').length === 0, 'Ctrl+X does not delete a read-only selection');
  check((await page.evaluate(() => window.__copied)) === null, 'Ctrl+X does not copy a read-only selection');
  // Shift+矢印は修飾つきのキー、普通の文字は text
  await page.evaluate(() => { window.__sent = window.__sent.filter(x => x.command !== 'browserScreencastInput'); });
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.type('q');
  await page.waitForTimeout(80);
  const tail = (await inputs()).slice(-2);
  check(tail[0]?.type === 'key' && tail[0].key === 'ArrowLeft' && tail[0].modifiers?.includes('shift'), `Shift+Arrow sends the shift key (got: ${JSON.stringify(tail)})`);
  check(tail[1]?.type === 'text' && tail[1].text === 'q', `plain characters go as text (got: ${JSON.stringify(tail)})`);

  // ============ 5. hover で点の下のカーソルを聞いて合わせる（読むだけ）
  await page.evaluate(() => { window.__sent = window.__sent.filter(x => x.command !== 'browserScreencastInput'); });
  await page.mouse.move(at(60, 40).x, at(60, 40).y);
  await page.waitForFunction(() => window.__inputs().some(i => i.type === 'cursor'));
  await page.waitForFunction(() => document.querySelector('.cp-frame')?.style.cursor === 'text');
  check(true, 'hover asks the cursor under the point and applies it');
  // ホイールはスクロール
  await page.mouse.move(at(400, 250).x, at(400, 250).y);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => window.__inputs().some(i => i.type === 'scroll'));
  check(true, 'wheel scrolls the page');

  // ============ 6. 貼り付けは手元の文字を入力として送る
  await page.evaluate(() => {
    window.__sent = window.__sent.filter(x => x.command !== 'browserScreencastInput');
    const dt = new DataTransfer(); dt.setData('text/plain', '貼り付けた文字');
    document.querySelector('.cp-screen').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForFunction(() => window.__inputs().some(i => i.type === 'text' && i.text === '貼り付けた文字'));
  check(true, 'paste sends the local text as input');

  return { results: results.length, pass: results };
}
