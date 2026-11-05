// playwright-cli -s=sidebar-create run-code --filename=tests/browser/sidebar-create.cjs
// 実データと分離したサーバー（AGENT_HOST_BACKENDS=fake・別ポート・使い捨ての置き場。ポート 7434・トークン sidebar-create）を開いてから実行する。
// 脇の作る入口（web/channels/sidebar.mjs・web/side.mjs・web/client.mjs。ADR 0288）:
//   「チャンネル ＋」の ＋ で名前の欄が出て、Enter で本物の channels.create が作り、木に出てそのチャンネルが開く・同じ名前は欄の下に理由が出て字が残る・Esc で閉じて ＋ へ戻る・
//   見出しの文字を押しても欄が出る・打った名前は絞り込みを掛けて外しても残る・欄の中でも Ctrl+Shift+O が効く・
//   木のキーボードで「チャンネル」の見出しに来て Enter でも欄が出る・
//   一時チャットの見出しの ＋（#newSession）は触れなくても見え、Ctrl+Shift+O（macOS は ⌘⇧O）と同じく新しい会話を始める・
//   どちらも絞り込みの条件（エージェントが 1 つ・状態・作業場所）を newSession に引き継ぐ・入力中の字（IME の変換中）では始めない。
async page => {
  const URL = 'http://127.0.0.1:7434/?token=sidebar-create';
  // 画面を撮るときだけ、撮影の置き場（絶対パス）を書く。書かなければ撮らない
  const SHOTS = 'C:/path/to/shots';
  const shot = async name => { if (!SHOTS.startsWith('C:/path/to/')) await page.screenshot({ path: `${SHOTS}/sidebar-create-${name}.png` }); };
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(`${label} （直前に通った項目: ${results.at(-1) ?? '無し'}）`); results.push(label); };

  // ---- 準備: 送ったコマンドを window.__sent に写す（中身はそのままサーバーへ届く）。ready の homeDir も覚える
  await page.addInitScript(() => {
    if (window.__scWrapped) return;
    window.__scWrapped = true;
    window.__sent = [];
    window.__answered = new Set();
    // ready は最初の送信より前に届くので、つないだ時点で聞き始める
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.kind === 'ready') window.__homeDir = m.homeDir; if (m.kind === 'response') window.__answered.add(m.id); } catch { /* 無視 */ } });
      }
    };
    const send = Native.prototype.send;
    Native.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.kind === 'command') window.__sent.push({ id: m.id, command: m.command, args: m.args }); } catch { /* 文字列でない */ }
      return send.call(this, data);
    };
  });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  await page.evaluate(() => { localStorage.removeItem('agent-host-side'); localStorage.removeItem('agent-host-side-routines-open'); });
  await page.reload();
  await page.locator('#closeOnboarding').click({ timeout: 2000 }).catch(() => {});
  await page.locator('#backToChat').click({ timeout: 1000 }).catch(() => {});
  await page.locator('#csChannelsLabel').waitFor();
  const sent = command => page.evaluate(c => window.__sent.filter(m => m.command === c || m.args?.op === c), command);

  // ---- チャンネルを作る: ＋ → 名前 → Enter
  const label = page.locator('#csChannelsLabel');
  const add = label.locator('.cs-add');
  check(await add.evaluate(n => getComputedStyle(n).opacity) === '1', '「チャンネル ＋」の ＋ は触れなくても見える');
  await add.click();
  const input = page.locator('#groups .cs-new-input');
  await input.waitFor();
  check(await input.evaluate(n => n === document.activeElement), '＋ を押すと名前の欄が出て、字を打てる');
  await shot('01-field');
  const name = 'plan' + String(Date.now()).slice(-5);
  await input.fill(name);
  await input.press('Enter');
  const heading = page.locator('#groups > .chsec > .grp-head .chsec-name', { hasText: name });
  await heading.waitFor();
  check((await sent('channels.create')).some(m => m.args.args?.name === name), 'Enter で channels.create に名前を渡す');
  check(await page.locator('#groups .cs-new').count() === 0, '作ると欄は閉じる');
  await page.waitForFunction(n => document.querySelector('.channels-view .top h2')?.textContent.includes(n), name);
  check(true, '作ったチャンネルが木に出て、その流れが開く');
  check(await heading.evaluate(n => n.closest('.chsec').classList.contains('no-threads')) && await heading.evaluate(n => getComputedStyle(n.closest('.grp-head').querySelector('.chsec-chev')).visibility) === 'hidden',
    'スレッドの無いチャンネルは畳む印を出さない');
  await shot('02-created');

  // ---- 同じ名前: 理由が欄の下に出て、打った字は残る。Esc で閉じて ＋ へ戻る
  await add.click();
  await input.waitFor();
  await input.fill(name);
  await input.press('Enter');
  await page.locator('#groups .cs-new-err').waitFor();
  check(await input.inputValue() === name && (await page.locator('#groups .cs-new-err').textContent()).length > 0, '同じ名前は欄の下に理由が出て、打った字は残る');
  await input.press('Escape');
  check(await page.locator('#groups .cs-new').count() === 0 && await add.evaluate(n => n === document.activeElement), 'Esc で欄が閉じ、＋ へ戻る');

  // ---- 木のキーボード: 「チャンネル」の見出しで Enter
  await page.locator('#groups').focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 40; i++) {
    const key = await page.evaluate(() => document.getElementById(document.getElementById('groups').getAttribute('aria-activedescendant'))?.dataset.key);
    if (key === 'c:new-channel') break;
    await page.keyboard.press('ArrowDown');
  }
  check(await page.evaluate(() => document.getElementById('groups').getAttribute('aria-activedescendant')) === 'csChannelsLabel', '木の ↓ で「チャンネル」の見出しに来る');
  await page.keyboard.press('Enter');
  await input.waitFor();
  check(await input.evaluate(n => n === document.activeElement), '見出しで Enter を押しても名前の欄が出る');
  await input.press('Escape');

  // ---- 新しいチャット: 見出しの ＋ と Ctrl+Shift+O。どちらも絞り込みを引き継ぐ
  const newChat = page.locator('#newSession');
  await page.mouse.move(900, 400);
  const shownNew = await page.waitForFunction(() => { const n = document.getElementById('newSession'); return n?.closest('[data-side-key="chsec:home"]') && getComputedStyle(n).opacity === '1'; }, null, { timeout: 2000 }).then(() => true, () => false);
  check(shownNew, '新しいチャットの ＋ は一時チャットの見出しにあり、触れなくても見える');
  check(await newChat.getAttribute('aria-keyshortcuts') === 'Control+Shift+O' && (await newChat.getAttribute('title')).includes('Ctrl+Shift+O'), '＋ の名前に近道 Ctrl+Shift+O が出る');
  check(await page.locator('#sidebar header #newSession').count() === 0, '頭の行にはもう ＋ が無い');
  const waitNew = async (before) => {
    await page.waitForFunction(n => window.__sent.filter(m => m.command === 'newSession').length > n, before);
    const last = (await sent('newSession')).at(-1).args;
    // 作り終わるまで待つ（作っている間の 2 度目は同じ作成に寄る）
    await page.waitForFunction(() => window.__sent.filter(m => m.command === 'newSession').every(m => window.__answered.has(m.id)));
    return last;
  };

  let before = (await sent('newSession')).length;
  await page.locator('#groups').focus();
  await page.keyboard.press('Control+Shift+O');
  let args = await waitNew(before);
  check(args.status == null && !args.backend, '絞っていなければ Ctrl+Shift+O は条件なしで始める');
  check(await page.locator('#prompt').evaluate(n => n === document.activeElement), '新しい会話の入力欄へ移る');

  // 入力欄で書いている字（IME の変換中）では始めない
  before = (await sent('newSession')).length;
  await page.locator('#prompt').dispatchEvent('keydown', { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, isComposing: true });
  await page.waitForTimeout(400);
  check((await sent('newSession')).length === before, '変換中の Ctrl+Shift+O では始めない');

  // 「チャンネル」の見出しは文字を押しても欄が出る。打った名前は絞り込みを掛けて外しても残り、欄の中でも Ctrl+Shift+O は効く
  await label.locator('.cs-label-t').click();
  await input.waitFor();
  check(await input.evaluate(n => n === document.activeElement), '「チャンネル」の見出しの文字を押しても名前の欄が出る');
  await input.fill('draft-x');
  await page.locator('#filterBtn').click();
  await page.locator('#filterPop [data-backend="fake"]').click();
  await page.keyboard.press('Escape');
  await page.locator('#fchips .fchip .x').first().click();
  await input.waitFor();
  check(await input.inputValue() === 'draft-x', '打った名前は、絞り込みを掛けて外しても残る');
  await input.focus();
  before = (await sent('newSession')).length;
  await input.press('Control+Shift+O');
  await waitNew(before);
  check(true, '名前の欄の中でも Ctrl+Shift+O で新しい会話を始める');

  // 絞り込み: エージェント（fake だけ）・状態（進行中）・作業場所
  const home = await page.evaluate(() => window.__homeDir);
  check(typeof home === 'string' && home.length > 0, 'ready の homeDir を受け取る');
  await page.evaluate(h => localStorage.setItem('agent-host-side', JSON.stringify({ filter: { backends: ['fake'], dir: h, status: '進行中' } })), home);
  await page.reload();
  await page.locator('#closeOnboarding').click({ timeout: 1000 }).catch(() => {});
  await page.locator('#newSession').waitFor();
  check(await page.locator('#fchips .fchip').count() === 3, '絞り込みの札が 3 つ出る');
  check(await page.locator('#groups .cs-sec').count() === 0, '絞っている間はルーティンと「チャンネル ＋」を出さない');
  before = (await sent('newSession')).length;
  await page.locator('#newSession').click();
  args = await waitNew(before);
  check(args.backend === 'fake' && args.status === '進行中' && args.cwd === home, '見出しの ＋ は絞り込みのエージェント・状態・作業場所を引き継ぐ');
  before = (await sent('newSession')).length;
  await page.locator('#groups').focus();
  await page.keyboard.press('Control+Shift+O');
  args = await waitNew(before);
  check(args.backend === 'fake' && args.status === '進行中' && args.cwd === home, 'Ctrl+Shift+O も同じく引き継ぐ');
  await shot('03-filtered');
  await page.evaluate(() => localStorage.removeItem('agent-host-side'));

  // ---- 360 幅: 引き出しの脇でも同じ入口があり、横にはみ出さない
  await page.setViewportSize({ width: 360, height: 760 });
  await page.reload();
  await page.locator('#closeOnboarding').click({ timeout: 1000 }).catch(() => {});
  if (!await page.locator('#csChannelsLabel').isVisible()) await page.locator('#openSidebar:visible, #chOpenSidebar:visible').first().click();
  await page.locator('#csChannelsLabel').waitFor({ state: 'visible' });
  check(await page.evaluate(() => { const s = document.getElementById('sidebar'); return s.scrollWidth <= s.clientWidth + 1 && document.getElementById('botStrip').scrollWidth <= document.getElementById('botStrip').clientWidth + 1; }), '360 幅でも脇と Bots の帯が横にはみ出さない');
  await shot('04-360');
  return { passed: true, results };
}
