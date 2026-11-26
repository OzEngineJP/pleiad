// playwright-cli -s=main-panel-unify run-code --filename=tests/browser/main-panel-unify.cjs
// fake を有効にした、実データと分離したサーバー（別ポート・使い捨ての置き場。AGENT_HOST_BACKENDS=fake）を開いてから実行する。// メインの頭を全部の面で 1 つの部品にした（docs/design-system.md「メインの頭」。承認済み 2026-11-26）ことを、
// Chats・チャンネル・スレッド・DM・bot のページの 5 面で、1280・360・ダークの幅と配色ごとに測る:
//   - 頭の行（見えている .top）の高さ: 広い画面 48px、700px 以下 60px
//   - ≡（.side-opener）: 360 では面ごとにちょうど 1 つ見え、44px 四方・絵 20px・画面の左端から 8px・頭の縦の中央・aria-expanded を持つ。1280 では出ない（P の印が開閉を持つ）
//   - 角: デスクトップの窓（.desktop）で、メインの左上の 1px が紙の色で塗られていない（中の面が角の外を塗らない）
async page => {
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(`${label} （直前に通った項目: ${results.at(-1) ?? '無し'}）`); results.push(label); };
  // 初回の案内（ログイン → 会話を始める）は起動時の判定の後に開き、閉じても出し直す（窓が ≡ を押すのを塞ぐ）。
  // browser-files-load.cjs と同じく、出ている間は進めて済ませる
  await page.waitForFunction(() => document.documentElement.dataset.agentGate);
  for (let i = 0; i < 60; i++) {
    const step = page.locator('#onboardingDialog[open] button:visible', { hasText: /^(ログイン|会話を始める)$/ }).first();
    if (await step.count()) { await step.click(); await page.waitForTimeout(600); } else if (i > 20) break; else await page.waitForTimeout(100);
  }
  if (await page.locator('#closeOnboarding:visible').count()) await page.locator('#closeOnboarding').click();

  const call = (op, args = {}) => page.evaluate(({ op, args }) => new Promise((resolve, reject) => {
    const token = new URL(location.href).searchParams.get('token') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'command', command: 'invoke', id: 'mpu1', args: { op, args } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.kind !== 'response' || m.id !== 'mpu1') return;
      ws.close();
      m.ok ? resolve(m.result) : reject(new Error(String(m.error)));
    };
    ws.onerror = () => reject(new Error('ws'));
  }), { op, args });
  const open = detail => page.evaluate(d => document.dispatchEvent(new CustomEvent('channels:show', { detail: d })), detail);

  // ---- 種: bot 1 体・チャンネルとスレッド・その bot の DM
  const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
  const ch = await call('channels.create', { name: 'mpu-ci', purpose: 'リリースの CI を見張る', members: [owl.id] });
  const root = await call('channels.post', { channelId: ch.id, text: '@Owl ok' });
  for (let i = 0; i < 100; i++) {
    const r = await call('channels.read', { channelId: ch.id, threadId: root.id });
    if (r.posts.some(p => p.turn && p.state === 'done')) break;
    await page.waitForTimeout(150);
  }
  const dm = (await call('channels.list')).channels.find(c => c.kind === 'dm' && (c.members ?? []).includes(owl.id));
  check(Boolean(dm), 'bot を作ると DM がある');

  const surfaces = {
    chat: { detail: { kind: 'channel', id: 'home' }, ready: 'main > header.top #titleEdit' },
    channel: { detail: { kind: 'channel', id: ch.id }, ready: '#channelsView .ch-feed' },
    thread: { detail: { kind: 'channel', id: ch.id, threadId: root.id }, ready: '#channelsView .th-top .th-title' },
    dm: { detail: { kind: 'channel', id: dm.id }, ready: '#channelsView .ch-feed' },
    botpage: { detail: { kind: 'bot', id: owl.id }, ready: '#channelsView .top.bot-top #botName' },
  };

  // 見えている頭の行・≡・メインの箱を測る
  const measure = () => page.evaluate(() => {
    // 覆われた面（Channels の面の下の Chats の頭・スレッドの一人の間のフィード）は inert。見えているものに数えない
    const shown = n => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden' && !n.closest('[inert]');
    const box = n => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const inChannels = document.body.classList.contains('channels');
    const scope = inChannels ? document.getElementById('channelsView') : document.querySelector('body > main');
    const tops = [...scope.querySelectorAll('.top')].filter(n => (inChannels || !n.closest('#channelsView')) && shown(n))
      .map(n => ({ cls: n.className, ...box(n) }));
    const openers = [...document.querySelectorAll('.side-opener')].filter(shown).map(n => {
      const top = n.closest('.top'); const svg = n.querySelector('svg.i');
      return { id: n.id || n.className, ...box(n), svg: svg ? svg.getBoundingClientRect().width : 0, expanded: n.getAttribute('aria-expanded'),
        topY: top ? top.getBoundingClientRect().y : null, topH: top ? top.getBoundingClientRect().height : null };
    });
    const main = document.querySelector('body > main');
    return { tops, openers, main: box(main), paper: getComputedStyle(main).backgroundColor };
  });

  // メインの左上の 1px の色（撮った画をページの canvas で読む）
  const cornerPixel = async (main) => {
    const png = await page.screenshot({ clip: { x: Math.round(main.x), y: Math.round(main.y), width: 2, height: 2 }, animations: 'disabled' });
    return page.evaluate(async b64 => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data; return `rgb(${r}, ${gg}, ${b})`;
    }, png.toString('base64'));
  };

  const modes = [
    { name: '1280', width: 1280, height: 800, theme: 'light', desktop: true },
    { name: '1280-dark', width: 1280, height: 800, theme: 'dark', desktop: true },
    { name: '360', width: 360, height: 760, theme: 'light', desktop: false },
    { name: '360-dark', width: 360, height: 760, theme: 'dark', desktop: false },
  ];
  for (const mode of modes) {
    await page.setViewportSize({ width: mode.width, height: mode.height });
    await page.evaluate(({ theme, desktop }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('desktop', desktop);
      document.documentElement.classList.toggle('overlay', desktop);
    }, mode);
    const narrow = mode.width <= 700;
    for (const [name, s] of Object.entries(surfaces)) {
      await open(s.detail);
      await page.waitForSelector(s.ready, { state: 'visible' });
      await page.mouse.move(mode.width - 2, mode.height - 2);
      await page.waitForTimeout(350);
      const m = await measure();
      const at = `${mode.name} の ${name}`;
      check(m.tops.length >= 1, `${at}: 頭の行が見えている`);
      for (const t of m.tops) check(Math.round(t.h) === (narrow ? 60 : 48), `${at}: 頭の行（${t.cls}）の高さは ${narrow ? 60 : 48}px（${t.h}）`);
      if (narrow) {
        check(m.openers.length === 1, `${at}: ≡ はちょうど 1 つ（${m.openers.map(o => o.id).join(',')}）`);
        const o = m.openers[0];
        check(Math.round(o.w) === 44 && Math.round(o.h) === 44, `${at}: ≡ は 44px 四方（${o.w}×${o.h}）`);
        check(Math.round(o.svg) === 20, `${at}: ≡ の絵は 20px（${o.svg}）`);
        check(Math.round(o.x) === 8, `${at}: ≡ は画面の左端から 8px（${o.x}）`);
        check(Math.abs(o.y + o.h / 2 - (o.topY + o.topH / 2)) <= 1.5, `${at}: ≡ は頭の縦の中央`);
        check(o.expanded === 'false', `${at}: ≡ は aria-expanded="false" を持つ（${o.expanded}）`);
      } else {
        check(m.openers.length === 0, `${at}: 広い画面では ≡ を出さない（${m.openers.map(o => o.id).join(',')}）`);
        if (mode.desktop) {
          const px = await cornerPixel(m.main);
          check(px !== m.paper, `${at}: 左上の角の外を紙の色で塗らない（${px} / 紙 ${m.paper}）`);
        }
      }
    }
  }

  // ≡ を押すと引き出しが開き、全部の ≡ の aria-expanded が true になる（スレッドの面で押す）
  await page.setViewportSize({ width: 360, height: 760 });
  await open(surfaces.thread.detail);
  await page.waitForSelector('#chThreadOpenSidebar', { state: 'visible' });
  await page.locator('#chThreadOpenSidebar').click();
  await page.waitForFunction(() => document.documentElement.classList.contains('side-open'));
  const expanded = await page.evaluate(() => [...document.querySelectorAll('.side-opener')].map(b => b.getAttribute('aria-expanded')));
  check(expanded.length >= 3 && expanded.every(v => v === 'true'), `引き出しを開くと全部の ≡ が aria-expanded="true"（${expanded.join(',')}）`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
  check(await page.evaluate(() => document.activeElement?.id) === 'chThreadOpenSidebar', '閉じると押した ≡ に焦点が戻る');

  return `ok ${results.length} 項目`;
}
