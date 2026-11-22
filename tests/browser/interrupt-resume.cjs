// playwright-cli run-code --filename=tests/browser/interrupt-resume.cjs
// 更新理由で中断した会話を表示し、まとめて再開する（docs/design-system.md「中断と再開」、ADR 0036）。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（docs/dev-verification.md「fake で画面を出す」）。
// fake は "slow" で中断されるまで走り、"ask" で承認を待つ。更新理由の中断は WebSocket から作る。
// 撮った画面は temporary/screenshots/interrupt-resume-impl-*.png（playwright-cli を起動した作業ディレクトリからの相対）。
async page => {
  const shots = 'temporary/screenshots/interrupt-resume-impl';
  await page.addInitScript(() => {
    const hold = window.__hold = { log: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let m = null;
      try { m = JSON.parse(data); } catch {}
      if (m?.kind === 'command') {
        hold.socket = this;
        hold.log.push({ command: m.command, args: m.args });
      }
      return send.call(this, data);
    };
    // 更新で Pleiad が再起動したことにする: 印が立っていれば ready の startedAt（サーバーの起動時刻）を今にする。
    // 「更新で中断した会話が N 件」は起動より前の中断だけを数えるので、同じサーバーのままでは出ない
    const onmessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return onmessage.get.call(this); }, set(fn) {
      onmessage.set.call(this, fn && function (e) {
        if (sessionStorage.getItem('ply-test-restarted')) {
          try { const m = JSON.parse(e.data); if (m.kind === 'ready') return fn.call(this, { data: JSON.stringify({ ...m, startedAt: Date.now() }) }); } catch {}
        }
        return fn.call(this, e);
      });
    } });
  });
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const wait = (ms) => page.waitForTimeout(ms);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.locator('.row[data-session]').first().waitFor();
  await wait(800);

  // ---- 実行中 2 件（slow）と承認待ち 1 件（ask）を作る。前からある会話は数えない（同じデータ置き場で流し直せるように）
  const before = await page.evaluate(() => [...document.querySelectorAll('.row[data-session]')].map(r => r.dataset.session));
  const start = async (text) => {
    await page.locator('#newSession').click();
    await wait(800);
    await page.locator('#prompt').fill(text);
    await page.locator('#send').click();
    await wait(1500);
  };
  await start('slow');
  await start('slow');
  await start('ask');
  await page.waitForFunction(() => document.querySelectorAll('.row .run').length >= 2);
  await page.evaluate(() => window.__hold.socket.send(JSON.stringify({ kind: 'command', id: 'test-interrupt', command: 'abort', args: { reason: 'update' } })));
  await page.waitForFunction(() => document.querySelectorAll('.row-why').length >= 2);

  // ---- 更新のあと（画面を読み直す）: 三角・理由・脇の下の一行
  await page.evaluate(() => sessionStorage.setItem('ply-test-restarted', '1'));
  await page.reload();
  await page.locator('.row[data-session]').first().waitFor();
  await wait(1500);
  const side = await page.evaluate((before) => [...document.querySelectorAll('.row[data-session]')].filter(r => !before.includes(r.dataset.session)).map(r => ({
    mark: r.querySelector('.warn-mark')?.getAttribute('class') ?? null, why: r.querySelector('.row-why')?.textContent ?? null,
    label: r.querySelector('.warn-mark')?.getAttribute('aria-label') ?? null })), before);
  const stopped = side.filter(r => r.mark);
  // 承認待ちだけだった会話は、却下で普通に終わるので三角は付かない（モックの場面 5 と同じ）
  check('更新で止めた実行中の 2 件に三角と「更新のため中断」', stopped.length === 2 && stopped.every(r => r.why === '更新のため中断' && r.label === '更新のため中断'), JSON.stringify(side));
  check('開いていない会話の三角は未読（--ink）', stopped.some(r => r.mark === 'warn-mark'), JSON.stringify(side));
  const strip = await page.evaluate(() => ({ hidden: document.querySelector('#resumeStrip').hidden, text: document.querySelector('#resumeStripText').textContent }));
  check('脇の下に「更新で中断した会話が N 件あります」', !strip.hidden && /更新で中断した会話が \d+ 件あります/.test(strip.text), JSON.stringify(strip));
  // 中断した会話を開く（開くと三角は既読の --ink-weak になる）
  await page.locator('.row[data-session]:has(.warn-mark:not(.read))').first().click();
  await page.waitForFunction(() => document.querySelector('.row.sel .warn-mark.read') && document.querySelector('.m.sys[data-interrupted]'));
  const line = await page.evaluate(() => document.querySelector('.m.sys[data-interrupted]')?.textContent ?? null);
  check('開いている会話の末尾に「Pleiad の更新のため中断しました」', Boolean(line?.startsWith('Pleiad の更新のため中断しました')), String(line));
  await page.screenshot({ path: `${shots}-after-update.png` });

  // ---- 畳んだ見出しにも三角
  const groupLabel = await page.locator('.row.sel').evaluate(row => row.closest('.grp').querySelector(':scope > .grp-head .grp-name').textContent);
  const heading = page.locator('.grp-head').filter({ has: page.getByText(groupLabel, { exact: true }) });
  await heading.locator('.grp-name').click();
  const mark = heading.locator('.warn-mark');
  await mark.waitFor();
  const head = await mark.getAttribute('aria-label');
  check('畳んだ見出しに三角', head === '中の会話が中断', String(head));
  await page.locator('#sidebar').screenshot({ path: `${shots}-collapsed.png` });
  await heading.locator('.grp-name').click();

  // ---- まとめて再開
  await page.locator('#resumeAll').click();
  await page.waitForFunction(() => document.querySelector('#resumeStrip').hidden, null, { timeout: 10000 });
  await wait(2500);
  const resumes = await page.evaluate(() => window.__hold.log.filter(l => l.command === 'resume').length);
  check('まとめて再開は各会話に resume', resumes >= 2, String(resumes));
  // slow はまた走るので中断して片付ける（ask の承認待ちも中断で却下）
  await page.evaluate(() => window.__hold.socket.send(JSON.stringify({ kind: 'command', id: 'cleanup', command: 'abort', args: {} })));
  await wait(2000);
  return { passed: true, checks };
}
