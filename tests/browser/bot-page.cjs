// playwright-cli -s=bot-page run-code --filename=tests/browser/bot-page.cjs
// fake,codex,antigravity を有効にした、実データと分離したサーバー（別ポート・使い捨ての置き場）を開いてから実行する
// （AGENT_HOST_BACKENDS=fake,codex,antigravity AGENT_HOST_CODEX_BIN="node tests/lib/fake-codex.mjs" AGENT_HOST_AGY_BIN="node tests/lib/fake-agy.mjs"）。
// bot のページと作成・記憶の一覧（web/channels/bot-page.mjs・memory-list.mjs。ADR 0109・0110）:
//   作る 3 段（名前 → 色 → 人格。名前が空なら次へ進めない。ADR 0362）・設定の変更（名前・色・人格・モデル・エフォート・承認モード・フォルダー・他の会話に送る）、
//   Antigravity（承認モードは 5 つ。ADR 0365）・全部自動ではフォルダーを「すべてのフォルダー」で非活性（Codex の全部自動は限れるので活性のまま）、
//   記憶の直す・忘れる・元に戻す・出どころ、360 幅で横にはみ出さない。
//   作ると、その bot の DM が開いて入力欄に焦点がある（ADR 0358）。DM の見出しの名前から bot のページへ行ける。
//   畳んだ 3 行（他の会話に送る・ルーティン・活動メモ）は閉じていて、右に今の値だけを出し、長い説明文と「今週」は無い。
async page => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する（フォルダーを足す確認に使う）
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  // 画面を撮るときだけ、撮影の置き場（絶対パス）を書く。書かなければ撮らない
  const SHOTS = 'C:/path/to/shots';
  const shot = async name => { if (!SHOTS.startsWith('C:/path/to/')) await page.screenshot({ path: `${SHOTS}/bots-w4-botpage-${name}.png` }); };
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(`${label} （直前に通った項目: ${results.at(-1) ?? '無し'}）`); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible().catch(() => false)) await later.click();

  // 操作の一覧を、画面と同じ WS で呼ぶ（検証用の読み書き）
  const call = (op, args = {}) => page.evaluate(({ op, args }) => new Promise((resolve, reject) => {
    const token = new URL(location.href).searchParams.get('token') ?? '';
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'command', command: 'invoke', id: 'bp1', args: { op, args } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.kind !== 'response' || m.id !== 'bp1') return;
      ws.close();
      m.ok ? resolve(m.result) : reject(new Error(String(m.error)));
    };
    ws.onerror = () => reject(new Error('ws'));
  }), { op, args });
  const open = detail => page.evaluate(d => document.dispatchEvent(new CustomEvent('channels:show', { detail: d })), detail);
  const botPage = async id => { await open({ kind: 'bot', id }); await page.waitForSelector('#botView:not([hidden])'); await page.waitForSelector('#channelsView .top.bot-top #botName'); await page.waitForFunction(() => document.querySelector('#botModelChip .v')?.textContent && !document.querySelector('#botModelChip .v').textContent.includes('…')); };
  const pickChip = async (chip, key) => { await page.locator(chip).click(); if (key.startsWith('backend:')) await page.locator('#botModelPop [data-key="nav:agent"]').click(); await page.locator(`[data-key="${key}"]`).click(); };
  const botOf = async name => (await call('bots.list')).bots.find(b => b.name === name);
  // 作る 3 段を通して作る（名前 → 色 → 人格）。作ると DM が開いて入力欄に焦点がある
  const openNew = async () => { await open({ kind: 'bot', id: 'new' }); await page.waitForSelector('#botView:not([hidden]) #botObName'); };
  const makeBot = async (name, persona = '') => {
    await openNew();
    await page.locator('#botObName').fill(name);
    await page.locator('#botView .bp-ob-actions .btn-primary').click();
    await page.locator('#botView .bp-ob-actions .btn-primary').click();
    if (persona) await page.locator('#botObPersona').fill(persona);
    await page.locator('#botView .bp-create').click();
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('#chFeed .ch-input')));
  };
  const waitBot = async (name, pred, label) => {
    for (let i = 0; i < 40; i++) { const b = await botOf(name); if (b && pred(b)) return b; await page.waitForTimeout(100); }
    throw Error(`${label} （保存されなかった。直前に通った項目: ${results.at(-1) ?? '無し'}）`);
  };

  // ---- 作る 3 段: 名前が空なら次へ進めない。名前 → 色 → 人格で作ると、その bot の DM に替わる
  await page.setViewportSize({ width: 1280, height: 800 });
  await open({ kind: 'channel', id: 'none' });   // 先に別の面（チャンネル）を開いていても、bot のページに替わる
  await openNew();
  check(await page.locator('#botView.is-new').count() === 1 && await page.locator('#botView .bp-ob').isVisible(), '作る画面は 3 段の形');
  check(await page.locator('#botView .bp-grid').isHidden() && await page.locator('#botView .bp-head').isHidden(), '作る画面にモデル・フォルダー・畳んだ行・記憶は無い');
  check(await page.locator('#botView .bp-ob-actions .btn-primary').isDisabled(), '名前が空なら次へ進めない');
  check(await page.evaluate(() => { const h = document.getElementById('channelsPageTitle').getBoundingClientRect(); return h.width <= 1 && h.height <= 1; }), 'bot のページの上に、汎用の「Channels」の見出しは出さない');
  await shot('01-new');
  await page.locator('#botObName').fill('Owl');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#botView .bp-ob-step .bp-swatches');
  check(await page.locator('#botView .bp-ob-step .bp-swatch').count() === 8 && await page.locator('#botView .bp-ob-step .bp-swatch[aria-pressed="true"]').count() === 1, '2 段目は 8 色で、1 つが選ばれている');
  await page.locator('#botView .bp-ob-step .bp-swatch[data-color="5"]').click();
  await page.locator('#botView .bp-ob-actions .btn-primary').click();
  await page.locator('#botObPersona').fill('落ち着いた口調で、結論から短く。');
  await page.locator('#botView .bp-create').click();
  // 作ると、その bot の DM が開いて入力欄に焦点がある（bot のページには留まらない）
  await page.waitForFunction(() => Boolean(document.activeElement?.closest('#chFeed .ch-input')));
  const owl = await waitBot('Owl', b => b.color === 5, '作った bot が選んだ色で保存される');
  check(owl.persona === '落ち着いた口調で、結論から短く。' && owl.dmChannelId, '作ると人格が保存され、DM のチャンネルができる');
  check(await page.locator('#botView').isHidden() && await page.locator('#channelsPageTitle .ch-nm').count() === 1 && (await page.locator('#channelsPageTitle .ch-nm').textContent()).includes('Owl'), '作ると、その bot の DM が開き、見出しに bot の名前が出る');
  check(await page.locator('#chFeed .ch-input').evaluate(n => n === document.activeElement), '作った直後の DM は入力欄に焦点がある');
  await shot('01b-dm');
  // 見出しの名前を押すと bot のページ（作った後の形）へ行く
  await page.locator('#channelsPageTitle .ch-nm').click();
  await page.waitForSelector('#botView:not([hidden]):not(.is-new)');
  await page.waitForSelector('#channelsView .top.bot-top #botName');   // 名前の欄はメインの頭の行（題の場所）にある（承認済み（2026-11-26））
  check(await page.locator('#channelsView .top.bot-top > .bp-more svg.i').count() === 1 && await page.locator('#botView .bp-head .bp-more').count() === 0, '⋮ は頭の行の右の svg（ページの頭には無い）');
  check(await page.locator('#botView .bp-av .bot-face-svg').count() === 1, '頭の顔は色の顔（64px）');
  check(await page.locator('#botView .bp-av .bp-av-edit[aria-hidden="true"]').count() === 1 && await page.locator('#botView .bp-av button').count() === 0, '鉛筆は常時表示する飾りで、アバターが単一のボタン');
  check(await page.locator('#botName').inputValue() === 'Owl' && await page.locator('#botView .bp-folders').isVisible() && await page.locator('#botView .bp-memory').isVisible(), 'DM の見出しから開く bot のページには、フォルダーと記憶がある');
  check(await page.locator('#botView .bp-usage').count() === 0 && !(await page.locator('#botView').innerText()).includes('今週'), 'bot 専用の使用量（今週）は出さない（ADR 0357）');
  const activity = page.getByRole('switch', { name: '自発的な活動' });
  await activity.waitFor();
  check(await activity.getAttribute('aria-checked') === 'true', '自発的な活動は設定にあり、未設定ではオン');
  const folders = page.locator('#botView .mem-folder-toggle');
  check(await folders.count() === 7 && await folders.first().getAttribute('aria-expanded') === 'true', '記憶は 7 フォルダーで、やりかけが初めから開いている');
  await folders.nth(1).press('Space');
  check(await folders.nth(1).getAttribute('aria-expanded') === 'true', 'Space で決めたことを開く');
  await shot('02-created');

  // ---- 設定の変更: 名前・人格・アイコン・モデル・エフォート・他の会話に送る
  await page.locator('#botName').fill('Owl2');
  await page.locator('#botName').blur();
  await waitBot('Owl2', () => true, '名前を変えると保存される');
  await page.locator('#botPersona').fill('推測は推測と書く。');
  await page.locator('#botPersona').blur();
  await waitBot('Owl2', b => b.persona === '推測は推測と書く。', '人格は離れたときに保存される');
  // 顔を押すと 8 色の面。選ぶと保存され、顔に焦点が戻る
  await page.locator('#botView .bp-av').click();
  await page.waitForSelector('#botColorPop:not([hidden]) .bp-swatch');
  check(await page.locator('#botColorPop .bp-swatch').count() === 8 && await page.locator('#botColorPop .bp-swatch[aria-pressed="true"]').getAttribute('data-color') === '5', '顔の面に 8 色が出て、今の色が選ばれている');
  await page.locator('#botColorPop .bp-swatch[data-color="2"]').click();
  const withIcon = await waitBot('Owl2', b => b.color === 2, '色を選ぶと保存される');
  check(await page.locator('#botColorPop').isHidden(), '選ぶと面が閉じる');
  // 入力欄と同じ 2 段の面: 1 段目の「モデル」の行 → 2 段目のモデルの一覧
  await page.locator('#botModelChip').click();
  await page.locator('#botModelPop [data-key="nav:model"]').click();
  const modelKeys = await page.locator('#botModelPop [data-key^="model:"]').evaluateAll(n => n.map(x => x.dataset.key));
  check(modelKeys.length >= 2, '入力欄と同じモデルの面が開く');
  const other = modelKeys.find(k => k !== `model:${withIcon.model}`);
  await page.locator(`#botModelPop [data-key="${other}"]`).click();
  await waitBot('Owl2', b => `model:${b.model}` === other || b.model === other.slice(6), 'モデルを選ぶと保存される');
  // エフォートは 1 段目の棒の行（role=slider）。既定でない端の段へ Home / End で移ると保存される
  if (await page.locator('#botModelPop').isHidden()) await page.locator('#botModelChip').click();
  const slider = page.locator('#botModelPop [data-key="effort"]');
  const bars = await slider.locator('i').evaluateAll(n => n.map(x => x.classList.contains('def')));
  check(bars.length >= 2 && bars.includes(false), 'エフォートの段が出る');
  await slider.focus();
  await page.keyboard.press(bars[0] ? 'End' : 'Home');
  const level = (await slider.getAttribute('aria-valuetext')).split(/[（(]/)[0].trim();
  await waitBot('Owl2', b => b.effort === level, 'エフォートを選ぶと保存される');
  // 保存の後に面が描き直されて、棒のフォーカスが外れていることがある。面の中の棒へ押して確かに Esc を届ける（1 段目の Esc で閉じる）
  await page.locator('#botModelPop [data-key="effort"]').press('Escape');
  const sw = page.locator('#botSendSwitch');
  check(await sw.isVisible() && await sw.getAttribute('aria-checked') === 'true', '他の会話に送るは既定で ON');
  await sw.click();
  await waitBot('Owl2', b => b.sendToOthers === false, '他の会話に送るを切ると保存される');
  await page.waitForFunction(() => document.querySelector('#botSendSwitch')?.getAttribute('aria-checked') === 'false');
  await sw.click();
  await waitBot('Owl2', b => b.sendToOthers === true, '入れ直すと戻る');
  await page.waitForFunction(() => document.querySelector('#botSendSwitch')?.getAttribute('aria-checked') === 'true');

  // ---- フォルダー: 足す・読み取りにする・外す
  await page.locator('#botAddFolder').click();
  await page.locator('#botFolderPop .cpath').fill(`${ROOT}/web`);
  await page.keyboard.press('Enter');
  await waitBot('Owl2', b => b.folders.length === 1 && b.folders[0].access === 'rw', 'フォルダーを足すと保存される（読み書き）');
  await page.locator('#botView .bp-fold .bp-fold-acc').click();
  await waitBot('Owl2', b => b.folders[0].access === 'ro', '押すと読み取りに切り替わる');
  await page.locator('#botAddFolder').click();
  await page.locator('#botFolderPop .cpath').fill(`${ROOT}/no-such-dir`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#botFolderPop .cerr:not(:empty)');
  check((await botOf('Owl2')).folders.length === 1, '無いフォルダーは足さず、理由を出す');
  await page.keyboard.press('Escape');
  await page.locator('#botView .bp-fold .bp-fold-rm').click();
  await waitBot('Owl2', b => b.folders.length === 0, 'フォルダーを外せる');
  await page.locator('#botAddFolder').click();
  await page.locator('#botFolderPop .cpath').fill(`${ROOT}/web`);
  await page.keyboard.press('Enter');
  await waitBot('Owl2', b => b.folders.length === 1, '足し直す');

  // ---- 全部自動（範囲 full）ではフォルダーを「すべてのフォルダー」で非活性。戻すと活性
  await pickChip('#botModeChip', 'mode:bypass');
  await waitBot('Owl2', b => b.mode === 'bypass', '承認モードを全部自動（bypass）にできる（bots.setMode）');
  check(await page.locator('#botView .bp-fold.allf').isVisible() && await page.locator('#botAddFolder').isDisabled(), '全部自動では「すべてのフォルダー」を出し、足せない');
  check(await page.locator('#botView .folders-off').count() === 1, '限っていたフォルダーは薄く残す');
  await shot('03-all-folders');
  await pickChip('#botModeChip', 'mode:auto');
  await waitBot('Owl2', b => b.mode === 'auto', '承認モードを戻す');
  check(await page.locator('#botView .bp-fold.allf').count() === 0 && await page.locator('#botAddFolder').isEnabled(), '戻すとフォルダーを限れる');

  // ---- 記憶: あなたについて（共通）と、この bot だけ。直す・忘れる・元に戻す・出どころ
  const dm = (await call('bots.list')).bots.find(b => b.name === 'Owl2').dmChannelId;
  const post = await call('channels.post', { channelId: dm, text: 'ベンチマークは 3 回の中央値で比べて' });
  const botId = (await botOf('Owl2')).id;
  await call('memory.write', { layer: botId, text: 'ベンチマークは 3 回の中央値で比べる', sources: [{ kind: 'post', channelId: dm, postId: post.id, quote: '3 回の中央値で比べて' }] });
  await call('memory.write', { layer: 'user', text: 'です・ます調で短く', kind: 'pref' });
  const panel = page.locator('#botView .bp-memory');
  const scope = panel.locator('select.mem-control');
  const note = panel.locator('[data-folder="note"]');
  const pref = panel.locator('[data-folder="pref"]');
  const own = panel.locator('.mem').filter({ hasText: 'ベンチマーク' });
  const shared = panel.locator('.mem').filter({ hasText: 'です・ます調で短く' });
  const openNote = async () => { if (await note.getAttribute('aria-expanded') !== 'true') await note.click(); };
  await openNote();
  await own.waitFor();
  check((await own.locator('.mem-origin').innerText()).includes('ベンチマーク'), '記憶の行に元のスレッド名が出る');
  await scope.selectOption('user');
  if (await pref.getAttribute('aria-expanded') !== 'true') await pref.click();
  await shared.waitFor();
  check(await shared.locator('.mem-origin').innerText() === 'あなたが書いた', '全 bot 共通に切り替えると出どころの無い記憶を読める');
  await scope.selectOption('own');
  await openNote();
  await own.locator('.mem-record').click();
  await shot('04-memory');
  await page.evaluate(() => { window.__shown = null; document.addEventListener('channels:show', e => { window.__shown = e.detail; }); });
  await own.locator('.src-link').click();
  check(await page.evaluate(() => window.__shown?.id) === dm, '出どころを押すとその投稿へ移動する');
  await botPage(botId);
  await openNote();
  await own.locator('.mem-record').click();
  await own.locator('[data-act="edit"]').click();
  await panel.locator('.memedit').fill('ベンチマークは 5 回の中央値で比べる');
  await page.keyboard.press('Enter');
  await panel.getByText('ベンチマークは 5 回の中央値で比べる', { exact: true }).waitFor();
  const listed = await call('memory.list', { layer: botId });
  check(listed.length === 1 && listed[0].text.includes('5 回') && listed[0].sources.length === 1, '直すと本文が変わり、出どころは残る');
  if (await own.locator('.mem-record').getAttribute('aria-expanded') !== 'true') await own.locator('.mem-record').click();
  await own.locator('[data-act="edit"]').click();
  await panel.locator('.memedit').fill('捨てる字');
  await page.keyboard.press('Escape');
  check(await panel.locator('.memedit').count() === 0 && (await own.innerText()).includes('5 回'), 'Esc で直すのをやめる');
  await own.locator('[data-act="forget"]').click();
  await panel.locator('.mem-undo:not([hidden])').waitFor();
  check((await call('memory.list', { layer: botId })).length === 0 && await own.count() === 0, '忘れると一覧から消える');
  await shot('05-forgotten');
  await panel.locator('.mem-undo .btn').click();
  await own.waitFor();
  const back = await call('memory.list', { layer: botId });
  check(back.length === 1 && back[0].sources.length === 1, '元に戻すと出どころごと戻る');
  await scope.selectOption('user');
  if (await pref.getAttribute('aria-expanded') !== 'true') await pref.click();
  await shared.locator('.mem-record').click();
  await shared.locator('[data-act="forget"]').click();
  await shared.waitFor({ state: 'detached' });
  check((await call('memory.list', { layer: 'user' })).length === 0, '共通の記憶も忘れられる');
  await call('memory.write', { layer: 'user', text: '金曜に本番へ出さない', kind: 'pref' });
  await panel.getByText('金曜に本番へ出さない', { exact: true }).waitFor();
  check(true, '別の経路で書いた記憶が一覧に現れる');

  // ---- Antigravity: 承認モードは 5 つ（ACP。ADR 0365）。「1 つだけ」の 1 行は出ない。全部自動（yolo）ではフォルダーは「すべてのフォルダー」
  await makeBot('Kit');
  await botPage((await botOf('Kit')).id);
  await pickChip('#botModelChip', 'backend:antigravity');
  await page.waitForFunction(() => document.querySelector('#botModelChip').dataset.backend === 'antigravity');
  check(!(await page.locator('#botView .bp-fact').isVisible()), 'Antigravity は承認モードを複数選べるので、「だけ」の 1 行は出ない');
  await page.locator('#botModeChip').click();
  check(await page.locator('#botModePop [role=option]').count() === 5, '承認モードの面に選べるのは 5 つ（都度確認・編集は自動・自動判断・計画のみ・全部自動）');
  await page.keyboard.press('Escape');
  const kit = await waitBot('Kit', b => b.backend === 'antigravity', 'bot のエージェントを Antigravity に替えられる');
  await botPage(kit.id);
  check(kit.mode === 'default', 'Antigravity の bot の承認モードは、作業場所に限るモードが無いので語彙の先頭の default（都度確認）');
  await pickChip('#botModeChip', 'mode:yolo');
  await waitBot('Kit', b => b.mode === 'yolo', 'Antigravity の全部自動（yolo）にする');
  check(await page.locator('#botView .bp-fold.allf').isVisible() && await page.locator('#botAddFolder').isDisabled(), 'Antigravity の全部自動は「すべてのフォルダー」で非活性');
  await shot('06-antigravity');

  // ---- Codex: 全部自動 (full) は書き込みを作業場所に限るので、フォルダーは活性のまま。Bypass は非活性
  await makeBot('Lynx');
  await botPage((await botOf('Lynx')).id);
  await pickChip('#botModelChip', 'backend:codex');
  await page.waitForFunction(() => document.querySelector('#botModelChip').dataset.backend === 'codex');
  const lynx = await waitBot('Lynx', b => b.backend === 'codex', 'bot のエージェントを Codex に替えられる');
  await botPage(lynx.id);
  await pickChip('#botModeChip', 'mode:full');
  await waitBot('Lynx', b => b.mode === 'full', 'Codex の全部自動にする');
  check(await page.locator('#botView .bp-fold.allf').count() === 0 && await page.locator('#botAddFolder').isEnabled(), 'Codex の全部自動はフォルダーを限れるので、活性のまま');
  await pickChip('#botModeChip', 'mode:yolo');
  await waitBot('Lynx', b => b.mode === 'yolo', 'Codex の Bypass にする');
  check(await page.locator('#botView .bp-fold.allf').isVisible() && await page.locator('#botAddFolder').isDisabled(), 'Codex の Bypass は sandbox を外すので「すべてのフォルダー」で非活性');
  check(await page.locator('#botModeChip').evaluate(n => n.classList.contains('danger')), 'Bypass は入力欄と同じ ⚠ の印');

  // ---- 見た目: 360 幅で横にはみ出さない・ダーク
  await botPage((await botOf('Owl2')).id);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(200);
  await shot('07a-360-folded');
  await page.evaluate(() => { for (const d of document.querySelectorAll('#botView details.bp-frow')) d.open = true; });
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => { const r = document.getElementById('botView'); return { sw: r.scrollWidth, cw: r.clientWidth, doc: document.documentElement.scrollWidth, vw: innerWidth }; });
  check(over.sw <= over.cw + 1 && over.doc <= over.vw + 1, `360 幅で横にはみ出さない (${JSON.stringify(over)})`);
  await shot('07-360');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await shot('08-360-dark');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('09-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  return { passed: true, checks: results };
}
