// 実行: node tests/browser/ply-instructions-reorder.mjs（PW_CORE・PW_CHROMIUMでブラウザーを指定できる）。
// 一時のデータ置き場・fakeだけを使い、設定 › コンテキスト「Pleiad の指示」の並べ替えを、360px幅の実タッチと PC のキー・マウスで確かめる
// （docs/design-system.md「コンテキスト」の「Pleiad の指示の行」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const version = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
const executablePath = process.env.PW_CHROMIUM || path.join(base, version, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-instructions-reorder-'));
let server, browser, ws;
const results = [];
const check = (ok, label, detail = '') => { if (!ok) throw new Error(`${label} ${JSON.stringify(detail)}`); results.push(label); };
try {
  server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  ws = await open({ port: server.port, token: server.token });
  await ws.cmd('onboardingSeen');
  const agents = (await ws.cmd('plyInstructions', {})).agents.map(a => a.id);
  for (const name of ['指示 A', '指示 B', '指示 C']) await ws.cmd('setPlyInstructions', { action: 'save', name, body: `${name} の本文です。`, target: 'all', agents });
  const stored = async () => (await ws.cmd('plyInstructions', {})).items;
  const first = await stored();
  check(first.at(-1).tag === 'linked' && first.filter(i => i.tag !== 'linked').length >= 4, '動かせる行が 4 つ以上あり、「委譲と連動」が最後にある', first.map(i => i.tag));
  const linkedId = first.at(-1).id;
  // 並べ替えの位置は、動かせる行の中での番目。保存される順番は画面の順番と同じ
  const savedOrder = async () => (await stored()).map(i => i.id).join();

  browser = await chromium.launch({ executablePath });
  const errors = [];
  async function openContext(options) {
    const ctx = await browser.newContext({ locale: 'ja-JP', ...options });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/?token=${server.token}`, { waitUntil: 'load' });
    await page.locator('#prompt').waitFor({ state: 'attached' });
    await page.waitForTimeout(800);
    // fake は未ログインなので、最初の案内が開いていればその歯車から設定へ入る
    await page.evaluate(() => document.getElementById(document.getElementById('onboardingDialog')?.open ? 'onboardingGear' : 'railSettings').click());
    await page.waitForFunction(() => document.body.classList.contains('settings'));
    await page.evaluate(() => document.getElementById('openContext').click());
    await page.locator('.cx-ply .cx-item[data-order]').first().waitFor();
    await page.waitForTimeout(400);
    return { ctx, page };
  }
  const read = page => page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.cx-ply .cx-list > .cx-item')];
    const active = document.activeElement;
    return { ids: boxes.map(b => b.querySelector('.cx-row').dataset.id), movable: boxes.filter(b => b.dataset.order).map(b => b.dataset.order),
      focus: active?.dataset?.fk ?? '', said: document.querySelector('.cx-ply [role=status]')?.textContent ?? '',
      ghost: document.querySelectorAll('.rt-order-ghost').length, gap: document.querySelectorAll('.cx-ply .rt-order-gap').length,
      menu: [...document.querySelectorAll('.pop.menu:not([hidden]) .li')].map(li => ({ label: li.querySelector('.lbl')?.textContent ?? li.textContent.trim(), disabled: li.disabled || li.getAttribute('aria-disabled') === 'true' })) };
  });
  const nameOf = (page, id) => page.evaluate(id => document.querySelector(`.cx-ply .cx-item[data-order="${id}"] .nm`).firstChild.textContent, id);
  const grip = async (page, id) => {
    const handle = page.locator(`.cx-ply .cx-item[data-order="${id}"] .rt-grip`);
    await handle.scrollIntoViewIfNeeded();
    const b = await handle.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, height: b.height };
  };
  const rowBox = (page, id) => page.locator(`.cx-ply .cx-row[data-id="${id}"]`).boundingBox();

  // ---------------------------------------------------------------- 360px 幅・タッチ
  {
    const { ctx, page } = await openContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const wait = ms => page.waitForTimeout(ms);
    async function drag(x, y1, y2, { during } = {}) {
      await touch('touchStart', x, y1);
      for (let i = 1; i <= 12; i++) { await touch('touchMove', x, y1 + (y2 - y1) * i / 12); await wait(24); }
      await wait(120);
      if (during) await during();
      await touch('touchEnd');
      await wait(500);
    }
    async function tap(x, y) { await touch('touchStart', x, y); await wait(40); await touch('touchEnd'); await wait(350); }

    let now = await read(page);
    const [a, b] = now.movable;
    const size = await grip(page, a);
    const style = await page.evaluate(() => { const g = document.querySelector('.cx-ply .rt-grip'), s = getComputedStyle(g); return { touchAction: s.touchAction, gaps: document.querySelectorAll('.cx-ply .cx-grip-gap').length, label: g.getAttribute('aria-label'), popup: g.getAttribute('aria-haspopup') }; });
    check(size.width >= 32 && size.height >= 44 && style.touchAction === 'none', '取っ手は幅 32px・高さ 44px 以上で、指の動きをページの送りに渡さない', { size, style });
    check(now.ids.at(-1) === linkedId && !now.movable.includes(linkedId) && style.gaps === 1, '「委譲と連動」の行は取っ手を持たず最後にある', now);
    check(style.label === `${await nameOf(page, a)} を並べ替え` && style.popup === 'menu', '取っ手の名前は「〈名前〉を並べ替え」で、メニューを持つと伝える', style);

    // 取っ手を引いて、2 つ目の行の下へ
    const from = await grip(page, a), under = await rowBox(page, b);
    await drag(from.x, from.y, under.y + under.height * 0.8, { during: async () => {
      const mid = await read(page);
      check(mid.ghost === 1 && mid.gap === 1, '引いている間は、行が浮き、入る場所に空きが出る', mid);
    } });
    now = await read(page);
    check(now.movable[0] === b && now.movable[1] === a && now.ghost === 0 && now.gap === 0, 'タッチで取っ手を引くと、行が入れ替わる', now);
    check(now.said === `${await nameOf(page, a)} を 2 番目に移動しました`, '引いて動かした結果を読み上げる', now.said);
    check(now.focus === `order|ply|${a}`, '落とした後、フォーカスは動かした行の取っ手にある', now.focus);
    check(await savedOrder() === now.ids.join(), '引いて変えた順番が保存される', await savedOrder());

    // 一覧の下の端（「委譲と連動」の上）まで引く
    await page.evaluate(() => document.querySelector('.cx-ply .cx-list').scrollIntoView({ block: 'center' }));
    await wait(200);
    const start = await grip(page, a), linked = await rowBox(page, linkedId);
    check(linked.y + linked.height < 760 - 60, '一覧が画面に収まっている（端の自動スクロールの帯に掛からない）', linked);
    await drag(start.x, start.y, linked.y + linked.height * 0.9);
    now = await read(page);
    check(now.movable.at(-1) === a && now.ids.at(-1) === linkedId, '「委譲と連動」の行より下へは入らず、動かせる行の最後に入る', now);
    check((await stored()).at(-1).id === linkedId && await savedOrder() === now.ids.join(), '保存された順番でも「委譲と連動」が最後のまま');

    // 名前の上を引いたときは、並べ替えずにページを送る
    const before = now.ids.join();
    const scrollTop = () => page.evaluate(() => { let s = document.querySelector('.cx-ply'); while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement; return (s ?? document.scrollingElement).scrollTop; });
    await page.evaluate(() => document.querySelector('.cx-ply .cx-list').scrollIntoView({ block: 'center' }));
    await wait(200);
    const body = await rowBox(page, now.movable[1]), top0 = await scrollTop();
    await drag(body.x + body.width / 2, body.y + body.height / 2, body.y + body.height / 2 - 140, { during: async () => {
      check((await read(page)).ghost === 0, '名前の上を引いても、行は浮かない');
    } });
    now = await read(page);
    check(now.ids.join() === before && await scrollTop() !== top0, '名前の上を引くと、順番は変わらずページが送られる', { top0, top: await scrollTop() });

    // 取っ手を押すとメニュー。4 つの行き先で動く
    const target = now.movable[1];
    const pick = async label => {
      const at = await grip(page, target);
      await tap(at.x, at.y);
      const opened = await read(page);
      const li = page.locator('.pop.menu:not([hidden]) .li', { hasText: label });
      const box = await li.boundingBox();
      await tap(box.x + box.width / 2, box.y + box.height / 2);
      await wait(400);
      return { menu: opened.menu, height: box.height };
    };
    const last = now.movable.length - 1;
    const one = await pick('最後へ');
    check(one.menu.map(i => i.label).join() === '先頭へ,上へ,下へ,最後へ' && one.menu.every(i => !i.disabled), '取っ手を押すと「先頭へ・上へ・下へ・最後へ」のメニューが出る', one.menu);
    check(one.height >= 44, 'タッチ端末では、メニューの項目の高さが 44px 以上', one.height);
    now = await read(page);
    check(now.movable[last] === target && now.ids.at(-1) === linkedId, 'メニューの「最後へ」で動かせる行の最後へ動き、「委譲と連動」は最後のまま', now);
    check(now.focus === `order|ply|${target}` && now.said === `${await nameOf(page, target)} を ${last + 1} 番目に移動しました`, 'メニューで動かした後、フォーカスが取っ手に戻り、結果を読み上げる', now);
    const two = await pick('上へ');
    check(two.menu[2].disabled && two.menu[3].disabled && !two.menu[0].disabled, '最後の行では「下へ」「最後へ」を押せない', two.menu);
    check((await read(page)).movable[last - 1] === target, 'メニューの「上へ」で 1 つ上へ動く');
    await pick('下へ');
    check((await read(page)).movable[last] === target, 'メニューの「下へ」で 1 つ下へ動く');
    await pick('先頭へ');
    now = await read(page);
    check(now.movable[0] === target && await savedOrder() === now.ids.join(), 'メニューの「先頭へ」で先頭へ動き、保存される', now);
    const three = await pick('下へ');
    check(three.menu[0].disabled && three.menu[1].disabled, '先頭の行では「先頭へ」「上へ」を押せない', three.menu);
    await ctx.close();
  }

  // ---------------------------------------------------------------- PC（1280px 幅）・キーとマウス
  {
    const { ctx, page } = await openContext({ viewport: { width: 1280, height: 900 } });
    const wait = ms => page.waitForTimeout(ms);
    let now = await read(page);
    const start = now.movable, id = start[0], fk = `order|ply|${id}`;
    const size = await grip(page, id);
    check(size.width === 32, 'PC でも取っ手は 32px 幅', size);
    await page.locator(`.cx-ply .cx-item[data-order="${id}"] .rt-grip`).focus();
    await page.keyboard.press('ArrowDown');
    const moving = await page.evaluate(() => document.getAnimations().filter(a => a.effect?.target?.closest?.('.cx-ply .cx-item')).map(a => a.effect.getTiming().duration));
    check(moving.length > 0 && moving.every(d => d === 240), 'キーで動かすと、行が 240ms で移る', moving);
    await wait(700);   // 保存の応答と「設定が変わった」の知らせが届いた後
    now = await read(page);
    check(now.movable[1] === id && now.focus === fk, '↓ で 1 つ下へ動き、保存の後もフォーカスが取っ手に残る', now);
    await page.keyboard.press('ArrowDown'); await wait(700);
    now = await read(page);
    check(now.movable[2] === id && now.focus === fk, '続けて ↓ を押すと、もう 1 つ下へ動く', now);
    check(now.said === `${await nameOf(page, id)} を 3 番目に移動しました`, 'キーで動かした結果を読み上げる', now.said);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await wait(700);
    now = await read(page);
    check(now.movable[1] === id && now.focus === fk && await savedOrder() === now.ids.join(), '保存を待たずに続けて押しても、押した数だけ動いて保存される', now);
    await page.keyboard.press('End'); await wait(500);
    now = await read(page);
    check(now.movable.at(-1) === id && now.ids.at(-1) === linkedId && now.focus === fk, 'End で動かせる行の最後へ（「委譲と連動」は最後のまま）', now);
    await page.keyboard.press('ArrowDown'); await wait(300);
    check((await read(page)).ids.join() === now.ids.join(), '最後の行で ↓ を押しても動かない');
    await page.keyboard.press('Home'); await wait(500);
    now = await read(page);
    check(now.movable.join() === start.join() && now.focus === fk, 'Home で先頭へ戻る', now);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('ArrowDown');
    const still = await page.evaluate(() => document.getAnimations().filter(a => a.effect?.target?.closest?.('.cx-ply .cx-item')).length);
    await wait(500);
    check(still === 0 && (await read(page)).movable[1] === id, '動きを減らす設定では、すぐに移る', still);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // マウスで引く。引いている途中の Esc は取り消し
    const from = await grip(page, id), above = await rowBox(page, start[1]);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x, from.y - 20, { steps: 4 }); await page.mouse.move(from.x, above.y + 4, { steps: 6 });
    check((await read(page)).ghost === 1, 'マウスでも取っ手を引くと行が浮く');
    await page.keyboard.press('Escape'); await page.mouse.up(); await wait(300);
    now = await read(page);
    check(now.movable[1] === id && now.said === '並べ替えを取り消しました' && now.ghost === 0, '引いている途中の Esc で取り消し、順番は変わらない', now);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x, from.y - 20, { steps: 4 }); await page.mouse.move(from.x, above.y + 4, { steps: 6 });
    await page.mouse.up(); await wait(600);
    now = await read(page);
    check(now.movable.join() === start.join() && now.menu.length === 0 && await savedOrder() === now.ids.join(), 'マウスで引いて落とすと入れ替わり、落とした直後にメニューは開かない', now);

    // 開いた行は、中身ごと動く
    await page.locator(`.cx-ply .cx-row[data-id="${id}"] .cx-open`).click(); await wait(200);
    await page.locator(`.cx-ply .cx-item[data-order="${id}"] .rt-grip`).focus();
    await page.keyboard.press('ArrowDown'); await wait(600);
    const open = await page.evaluate(id => { const box = document.querySelector(`.cx-ply .cx-item[data-order="${id}"]`); return { peek: Boolean(box.querySelector('.cx-peek')), index: [...box.parentElement.children].indexOf(box), peeks: document.querySelectorAll('.cx-ply .cx-peek').length }; }, id);
    check(open.peek && open.index === 1 && open.peeks === 1, '開いた行を動かすと、開いた中身も一緒に移る', open);
    await ctx.close();
  }
  check(errors.length === 0, '画面の例外なし', errors);
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`ply-instructions-reorder: ${results.length} 件 通過`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.error(e.stack); process.exitCode = 1;
} finally {
  ws?.close();
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
