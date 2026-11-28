// playwright-cli run-code --filename=tests/browser/settings-band.cjs
// 作業中の設定の変更（docs/design-system.md「作業中の設定の変更」、ADR 0341）: 帯「以下の設定に変更予定」・［今すぐ変える］・［取り消す］・会話の跡の行。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（docs/dev-verification.md「fake で画面を出す」）。
// fake は "slow" で中断されるまで走る。fake のエフォートはその場で切り替えられる（止めずに効かせる）。
async page => {
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const wait = (ms) => page.waitForTimeout(ms);
  const ws = (command, args) => page.evaluate(([command, args]) => new Promise((res, rej) => {
    const s = new WebSocket(location.origin.replace('http', 'ws') + '/ws' + location.search);
    const id = 'band-' + Math.random();
    s.onopen = () => s.send(JSON.stringify({ kind: 'command', command, id, args }));
    s.onmessage = (m) => { try { const r = JSON.parse(m.data); if (r.kind === 'response' && r.id === id) { s.close(); res(r.result); } } catch {} };
    s.onerror = () => rej(new Error('ws'));
  }), [command, args]);
  const band = () => page.evaluate(() => ({
    hidden: document.querySelector('#nextSettings').hidden,
    text: document.querySelector('#nextSettingsText').textContent,
    apply: !document.querySelector('#applySettings').hidden,
  }));

  // 以前の版が残した予約を、サーバーから受け取った場合を再現する。
  let clientSocket;
  let savedReservation;
  await page.routeWebSocket(/\/ws/, socket => {
    const server = socket.connectToServer();
    if (clientSocket) return;
    clientSocket = socket;
    const lists = new Set();
    socket.onMessage(raw => {
      const msg = JSON.parse(raw);
      if (msg.command === 'listSessions') lists.add(msg.id);
      if (msg.command === 'listSessions' && savedReservation) {
        delete msg.args.since;
        server.send(JSON.stringify(msg));
      } else server.send(raw);
    });
    server.onMessage(raw => {
      const msg = JSON.parse(raw);
      if (msg.kind === 'response' && lists.delete(msg.id) && savedReservation) {
        const row = (msg.result?.rows ?? msg.result)?.find(s => s.id === savedReservation.sessionId);
        if (row) row.nextSettings = savedReservation.nextSettings;
        socket.send(JSON.stringify(msg));
      } else socket.send(raw);
    });
  });
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.locator('#newSession').click();
  await wait(800);
  await page.locator('#prompt').fill('slow');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.row.sel .run'));
  const id = await page.locator('.row.sel').getAttribute('data-session');
  check('帯は予約が無ければ出ない', (await band()).hidden);

  // ---- 作業中に選ぶと帯が出る（今のターンにはまだ効かない）
  await ws('setTurnSettings', { sessionId: id, model: 'fast', effort: 'high' });
  await page.waitForFunction(() => !document.querySelector('#nextSettings').hidden);
  const shown = await band();
  check('帯に変える内容が「名前: 値」で並ぶ', /モデル: ?Fast 2\.1/.test(shown.text) && /エフォート: ?high/.test(shown.text), JSON.stringify(shown));
  check('走っている間は［今すぐ変える］がある', shown.apply);

  // ---- ［今すぐ変える］はキーボードでも押せる。止めずに効かせ、跡の行は「作業の途中で…変えました」
  await page.locator('#applySettings').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#nextSettings').hidden);
  await page.locator('.st-line-t').last().waitFor();
  const trace = await page.locator('.st-line-t').last().textContent();
  check('跡の行は「変えました」まで（止めたことを言わない）', /作業の途中で/.test(trace) && /high に変えました/.test(trace) && !/中断/.test(trace), trace);
  check('止めずに効かせたのでターンは続く', await page.evaluate(() => Boolean(document.querySelector('.row.sel .run'))));
  const after = (await ws('listSessions', {})).find((s) => s.id === id);
  check('今の設定に入り、予約は空く', after?.effort === 'high' && !after?.nextSettings, JSON.stringify({ effort: after?.effort, next: after?.nextSettings }));

  // ---- ［取り消す］で予約を消す
  await ws('setTurnSettings', { sessionId: id, effort: 'low' });
  await page.waitForFunction(() => !document.querySelector('#nextSettings').hidden);
  await page.locator('#cancelSettings').click();
  await page.waitForFunction(() => document.querySelector('#nextSettings').hidden);
  const cancelled = (await ws('listSessions', {})).find((s) => s.id === id);
  check('取り消すと予約が消え、今の設定は変わらない', !cancelled?.nextSettings && cancelled?.effort === 'high', JSON.stringify({ effort: cancelled?.effort, next: cancelled?.nextSettings }));

  const showSavedReservation = nextSettings => {
    savedReservation = { sessionId: id, nextSettings };
    clientSocket.send(JSON.stringify({ kind: 'event', event: { type: 'nextSettings', ...savedReservation } }));
  };
  const same = { backend: cancelled.backend, model: cancelled.model, effort: cancelled.effort };
  showSavedReservation({ ...same, effort: 'low', mode: cancelled.mode });
  await page.waitForFunction(() => /low/.test(document.querySelector('#nextSettingsText').textContent));
  const sameMode = await page.locator('#nextSettingsText .next-item').allTextContents();
  showSavedReservation(same);
  await page.waitForFunction(() => document.querySelector('#nextSettings').hidden, null, { timeout: 2_000 }).catch(() => {});
  const empty = await band();
  const sameModeHidden = sameMode.length === 1 && /low/.test(sameMode[0]);
  check('今と同じ承認モードを項目に出さず、変更項目が 0 件なら帯も［今すぐ変える］も出さない', sameModeHidden && empty.hidden && !empty.apply, JSON.stringify({ sameMode, empty }));

  await ws('abort', { sessionId: id });
  return { passed: true, checks };
}
