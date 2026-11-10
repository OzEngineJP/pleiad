// 右の欄のタブの列と開け閉めを、本物の画面（身代わりのバックエンドのサーバー）と本物のマウス・タッチで確かめる
// （docs/design-system.md「会話の頭の行のアイコン」「PC のタブとアドレスバー」、ADR 0312）。
// tests/unit/right-panel-tabs.mjs から B1_BROWSER_TEST=1 のときだけ呼ぶ。利用者のデータ置き場・本物の Chrome は使わない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';

const TAB_MIN = 96, TAB_MIN_ON = 120;

/** 位置と大きさが続けて変わらなくなるまで待つ（ばねが止まるまで） */
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => {
    const snap = () => JSON.stringify([
      ...[...document.querySelectorAll('#filePreview, #filePreview .bu-tab, #filePreview .bu-new, #filePreview .bu-list, #browserEntry, .panel-flier')]
        .map(n => { const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width), n.hidden]; }),
      Math.round(document.querySelector('#filePreview .bu-tabs')?.scrollLeft ?? 0),
      document.body.className,
    ]);
    let last = snap(), same = 0; const start = performance.now();
    const step = () => { const now = snap(); same = now === last ? same + 1 : 0; last = now; if (same >= 10 || performance.now() - start > 5000) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }));
}

/** 本物のマウス（座標で押して離す） */
async function mouseAt(page, x, y) { await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up(); }
async function mouseOn(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await mouseAt(page, box.x + box.width / 2, box.y + box.height / 2);
}
async function tapOn(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

const readStrip = page => page.evaluate(() => {
  const fp = document.querySelector('#filePreview');
  const shown = n => !!n && !n.hidden && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
  const r = n => { if (!shown(n)) return null; const b = n.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
  const root = fp.querySelector('.bu-tabs');
  const tabs = [...fp.querySelectorAll('.bu-tab:not(.bu-ghost)')].map(el => { const b = el.getBoundingClientRect(); return { id: el.dataset.target, on: el.classList.contains('on'), w: b.width, l: b.left, r: b.right }; });
  return { tabs, overflow: root.scrollWidth > root.clientWidth + 1, root: r(root), plus: r(fp.querySelector('.bu-new')), list: r(fp.querySelector('.bu-list')),
    x: r(fp.querySelector('.bu-panel-close')), row: r(fp.querySelector('.bu-tabrow')), ghosts: fp.querySelectorAll('.bu-ghost').length };
});

/** 列の決まり: 最小幅・∨ は入りきらないときだけ・＋∨✖ が見えて重ならない・＋ の位置。破った所を返す */
function stripProblems(s) {
  const bad = [];
  for (const tab of s.tabs) if (tab.w < (tab.on ? TAB_MIN_ON : TAB_MIN) - 0.5) bad.push(`tab ${tab.id} ${tab.w.toFixed(1)}px`);
  if (!!s.list !== s.overflow) bad.push(`list ${s.list ? 'shown' : 'hidden'} while overflow=${s.overflow}`);
  if (!s.plus || !s.x) bad.push('plus or close not visible');
  else {
    const next = s.list ?? s.x;
    if (s.plus.r > next.l + 0.5) bad.push(`plus overlaps ${s.list ? 'list' : 'close'}`);
    if (s.list && s.list.r > s.x.l + 0.5) bad.push('list overlaps close');
    if (s.x.r > s.row.r + 0.5) bad.push('close outside the row');
    const last = s.tabs.at(-1);
    if (!s.overflow && last && (s.plus.l < last.r - 0.5 || s.plus.l - last.r > 12)) bad.push(`plus not next to the last tab (${(s.plus.l - last.r).toFixed(1)}px)`);
    if (s.overflow && s.plus.l < s.root.r - 0.5) bad.push('plus not at the end while overflowing');
  }
  return bad;
}

/** 会話を 1 つ作り、作業フォルダーを置く */
async function prepare(page, base, ws) {
  await page.goto(base);
  await page.locator('#prompt').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(ws);
  await page.locator('#cwdPop .cpath').press('Enter');
  await page.locator('#prompt').fill('echo:右の欄の確認');
  await page.locator('#send').click();
  await page.locator('.mw .m[data-uuid]').first().waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
}

const panelState = page => page.evaluate(() => {
  const fp = document.querySelector('#filePreview'), entry = document.querySelector('#browserEntry'), flier = document.querySelector('.panel-flier');
  const visible = n => { if (!n || n.hidden) return false; const s = getComputedStyle(n), b = n.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01 && b.width > 0; };
  return { open: document.body.classList.contains('file-preview-open') && visible(fp), panelVisible: visible(fp), leaving: fp.classList.contains('fp-leaving') || document.body.classList.contains('file-preview-leaving'),
    inert: fp.inert === true, flier: visible(flier), entry: visible(entry), close: visible(fp.querySelector('.bu-panel-close')),
    focusInPanel: fp.contains(document.activeElement), focusOnEntry: document.activeElement === entry, ghosts: fp.querySelectorAll('.bu-ghost').length };
});
const cleanClosed = s => !s.open && !s.panelVisible && !s.leaving && !s.inert && !s.flier && s.entry;
const cleanOpen = s => s.open && !s.leaving && !s.inert && !s.flier && !s.entry && s.close;

export default async function rightPanelTabs({ browser, check }) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-right-panel-'));
  const dataDir = path.join(scratch, 'data'), ws = path.join(scratch, 'rp-demo-ws');
  await fs.mkdir(path.join(ws, 'docs'), { recursive: true });
  await fs.writeFile(path.join(ws, 'docs', 'notes.md'), '# notes\n');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  const base = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  const errors = [];
  try {
    // ---- マウス（PC） ----
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await prepare(page, base, ws);

    await mouseOn(page, '#browserEntry');
    await settle(page);
    let p = await panelState(page);
    check('opening with the head icon leaves the panel open with no leftovers and hides the head icon', cleanOpen(p), JSON.stringify(p));
    check('opening moves focus into the panel', p.focusInPanel, JSON.stringify(p));
    const firstMark = await page.evaluate(() => { const icon = document.querySelector('#filePreview .bu-tab.on .bu-tab-pick .bu-favicon'); return { tag: icon?.tagName, children: icon?.childElementCount }; });
    check('the new tab in the real strip carries no mark', firstMark.tag === 'SPAN' && firstMark.children === 0, JSON.stringify(firstMark));

    // 1 枚目をフォルダーにする（一覧の検索で絞るため）
    await page.frameLocator('#filePreview iframe.bu-local-page').getByText('rp-demo-ws', { exact: true }).first().click();
    await page.waitForFunction(() => /rp-demo-ws/.test(document.querySelector('#filePreview .bu-tab.on .bu-tab-title')?.textContent ?? ''), null, { timeout: 10000 });
    await settle(page);

    // ---- 境目の幅: ∨ が出る直前・直後で決まりを破らず、出たり消えたりを繰り返さない（初めて溢れた枚数で、窓の幅を少しずつ狭める） ----
    const sweep = []; const shownAt = new Set(); let sweptAt = 0;
    async function sweepWidths() {
      await page.evaluate(() => {
        window.listFlips = 0;
        new MutationObserver(() => { window.listFlips++; }).observe(document.querySelector('#filePreview .bu-list'), { attributes: true, attributeFilter: ['hidden'] });
      });
      for (let width = 1920; width >= 1000; width -= 10) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        const flipsBefore = await page.evaluate(() => window.listFlips);
        await page.waitForTimeout(120);
        const s = await readStrip(page);
        const flipsAfter = await page.evaluate(() => window.listFlips);
        shownAt.add(!!s.list);
        const bad = stripProblems(s);
        if (flipsAfter !== flipsBefore) bad.push(`list flipped ${flipsAfter - flipsBefore} times while still`);
        if (bad.length) sweep.push({ width, room: s.root && s.root.w, bad });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await settle(page);
    }

    // ---- タブを 1 枚ずつ足す（＋ をマウスで） ----
    const growProblems = []; let firstOverflow = 0;
    for (let n = 2; n <= 14; n++) {
      await mouseOn(page, '#filePreview .bu-new');
      await settle(page);
      const s = await readStrip(page);
      if (s.tabs.length !== n) growProblems.push(`${n}: ${s.tabs.length} tabs`);
      for (const bad of stripProblems(s)) growProblems.push(`${n}: ${bad}`);
      const on = s.tabs.find(tab => tab.on);
      if (!on || on.l < s.root.l - 0.5 || on.r > s.root.r + 0.5) growProblems.push(`${n}: the added tab is not in view`);
      if (s.overflow && !firstOverflow) { firstOverflow = n; sweptAt = n; await sweepWidths(); }
    }
    check('adding tabs one by one keeps min widths, + next to the last tab then pinned, and the list only while overflowing', growProblems.length === 0 && firstOverflow > 2, JSON.stringify({ growProblems, firstOverflow }));

    check('across the widths around the list threshold the strip keeps its rules and the list does not flicker', sweep.length === 0 && shownAt.size === 2, JSON.stringify({ sweptAt, sweep: sweep.slice(0, 6), shownAt: [...shownAt] }));

    // ---- ∨ の一覧を本物のマウスで ----
    const before = await readStrip(page);
    const firstId = before.tabs[0].id;
    await mouseOn(page, '#filePreview .bu-list');
    await page.locator('.bu-alltabs').waitFor({ timeout: 3000 });
    check('the list opens with the search field focused', await page.evaluate(() => document.activeElement?.classList.contains('bu-alltabs-q')));
    await mouseOn(page, `.bu-alltabs li[data-target="${firstId}"]`);
    await page.waitForTimeout(100);
    await settle(page);
    let s = await readStrip(page);
    const picked = s.tabs.find(tab => tab.id === firstId);
    check('picking a row of the list with a real mouse switches to that tab', picked?.on === true && await page.locator('.bu-alltabs').count() === 0, JSON.stringify({ on: s.tabs.find(tab => tab.on)?.id, firstId, open: await page.locator('.bu-alltabs').count() }));
    check('the picked tab is scrolled into view', !!picked && picked.l >= s.root.l - 0.5 && picked.r <= s.root.r + 0.5, JSON.stringify({ picked, root: s.root }));

    await mouseOn(page, '#filePreview .bu-list');
    await page.locator('.bu-alltabs').waitFor({ timeout: 3000 });
    await page.keyboard.type('rp-demo');
    const filtered = await page.locator('.bu-alltabs li[role="option"]').count();
    check('typing in the list narrows the rows', filtered === 1, String(filtered));
    // 検索欄の中を押す・文字をなぞって選ぶ（閉じない）
    const q = await page.locator('.bu-alltabs-q').boundingBox();
    await mouseAt(page, q.x + q.width - 12, q.y + q.height / 2);
    await page.mouse.move(q.x + 10, q.y + q.height / 2); await page.mouse.down(); await page.mouse.move(q.x + q.width - 10, q.y + q.height / 2, { steps: 6 }); await page.mouse.up();
    check('clicking and selecting text inside the search field keeps the list open', await page.locator('.bu-alltabs').count() === 1);
    await page.keyboard.press('Escape');
    check('Escape closes the list and returns focus to the list button', await page.locator('.bu-alltabs').count() === 0 && await page.evaluate(() => document.activeElement?.classList.contains('bu-list')));

    // 一覧のスクロールバーをなぞる（閉じない）
    await page.setViewportSize({ width: 1280, height: 420 });
    await settle(page);
    await mouseOn(page, '#filePreview .bu-list');
    await page.locator('.bu-alltabs').waitFor({ timeout: 3000 });
    const ul = await page.evaluate(() => { const u = document.querySelector('.bu-alltabs ul'), b = u.getBoundingClientRect(); return { scrolls: u.scrollHeight > u.clientHeight + 1, bar: u.offsetWidth - u.clientWidth, r: b.right, t: b.top, h: b.height }; });
    if (ul.scrolls && ul.bar > 0) {
      await page.mouse.move(ul.r - ul.bar / 2, ul.t + 12); await page.mouse.down(); await page.mouse.move(ul.r - ul.bar / 2, ul.t + 12 + ul.h / 3, { steps: 6 }); await page.mouse.up();
      const after = await page.evaluate(() => ({ open: !!document.querySelector('.bu-alltabs'), top: document.querySelector('.bu-alltabs ul')?.scrollTop ?? 0 }));
      check('dragging the scrollbar of the list keeps it open and scrolls', after.open && after.top > 0, JSON.stringify({ ul, after }));
    } else check('the list scrolls with a visible scrollbar at a low height', false, JSON.stringify(ul));
    if (await page.locator('.bu-alltabs').count()) await page.keyboard.press('Escape');   // 閉じていたら押さない（Esc は右の欄を閉じる）
    await page.setViewportSize({ width: 1280, height: 800 });
    await settle(page);

    // ---- 今のタブの ✕ に Tab で届く。Delete も残る ----
    await page.evaluate(() => document.querySelector('#filePreview .bu-tab.on .bu-tab-pick').focus());
    await page.keyboard.press('Tab');
    const onClose = await page.evaluate(() => !!document.activeElement?.matches('#filePreview .bu-tab.on .bu-tab-close'));
    check('Tab from the current tab reaches its close button', onClose);
    const count0 = (await readStrip(page)).tabs.length;
    await page.keyboard.press('Enter');
    await settle(page);
    s = await readStrip(page);
    check('Enter on the close button closes the tab and focus returns to the current tab', s.tabs.length === count0 - 1 && await page.evaluate(() => !!document.activeElement?.matches('#filePreview .bu-tab.on .bu-tab-pick')), JSON.stringify({ count0, now: s.tabs.length }));
    check('only the current tab close button is in the Tab order', await page.evaluate(() => [...document.querySelectorAll('#filePreview .bu-tab-close')].filter(b => b.tabIndex >= 0).length === 1));
    await page.keyboard.press('Delete');
    await settle(page);
    s = await readStrip(page);
    check('Delete on a tab still closes it', s.tabs.length === count0 - 2 && s.ghosts === 0, JSON.stringify({ count0, now: s.tabs.length, ghosts: s.ghosts }));

    // ---- 手で流したら、ばねのスクロールが奪い返さない ----
    await page.evaluate(() => { const root = document.querySelector('#filePreview .bu-tabs'); root.scrollLeft = root.scrollWidth; });
    await page.evaluate(() => document.querySelector('#filePreview .bu-tab-pick').focus({ preventScroll: true }));
    await page.keyboard.press('Home');     // 先頭へばねで流れ始める
    await page.waitForTimeout(60);
    const tabsBox = await page.locator('#filePreview .bu-tabs').boundingBox();
    await page.mouse.move(tabsBox.x + tabsBox.width / 2, tabsBox.y + tabsBox.height - 2);
    await page.mouse.down();
    const held = await page.evaluate(() => document.querySelector('#filePreview .bu-tabs').scrollLeft);
    await page.waitForTimeout(400);
    const later = await page.evaluate(() => document.querySelector('#filePreview .bu-tabs').scrollLeft);
    await page.mouse.up();
    check('touching the strip stops the scroll spring where it is', Math.abs(later - held) < 1, JSON.stringify({ held, later }));
    await settle(page);

    // ---- 片付け: 動いている途中で destroy しても、ばねが残らず、閉じて縮んでいるタブも消える ----
    const torn = await page.evaluate(async () => {
      const { createTabStrip } = await import('/tab-strip.mjs');
      const { motionClock } = await import('/motion.mjs');
      const frame = () => new Promise(r => requestAnimationFrame(() => r()));
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;width:300px;display:flex;background:#fff';
      document.body.append(host);
      const strip = createTabStrip({});
      host.append(...strip.items); strip.relayout();
      const tab = id => ({ sessionId: 'x', targetId: id, windowId: 1, title: 'tab ' + id, url: 'about:blank' });
      strip.update(['a', 'b', 'c', 'd', 'e', 'f'].map(tab), 'a'); await frame(); await frame();
      strip.update(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(tab), 'g'); await frame();
      strip.update(['a', 'c', 'd', 'e', 'f', 'g'].map(tab), 'g'); await frame();
      const before = { moving: motionClock.moving, ghosts: host.querySelectorAll('.bu-ghost').length };
      strip.destroy(); await frame(); await frame();
      const after = { moving: motionClock.moving, ghosts: host.querySelectorAll('.bu-ghost').length, list: !!document.querySelector('.bu-alltabs') };
      host.remove();
      return { before, after };
    });
    check('destroy in the middle of motion stops every spring and removes the closing tabs', torn.before.moving > 0 && torn.before.ghosts > 0 && torn.after.moving === 0 && torn.after.ghosts === 0 && !torn.after.list, JSON.stringify(torn));

    // ---- ✖ で閉じる ----
    await mouseOn(page, '#filePreview .bu-panel-close');
    await settle(page);
    p = await panelState(page);
    check('the close button closes the panel with no leftovers', cleanClosed(p) && p.ghosts === 0, JSON.stringify(p));
    check('closing returns focus to the head icon', p.focusOnEntry, JSON.stringify(p));

    // ---- 開け閉めの途中で逆にする ----
    await mouseOn(page, '#browserEntry');
    await page.waitForTimeout(120);
    let flier = await page.locator('.panel-flier').boundingBox();
    if (flier) await mouseAt(page, flier.x + flier.width / 2, flier.y + flier.height / 2);
    await settle(page);
    p = await panelState(page);
    check('reversing an opening panel ends closed with no leftovers', !!flier && cleanClosed(p), JSON.stringify({ flier, p }));
    await mouseOn(page, '#browserEntry');
    await settle(page);
    await mouseOn(page, '#filePreview .bu-panel-close');
    await page.waitForTimeout(120);
    flier = await page.locator('.panel-flier').boundingBox();
    if (flier) await mouseAt(page, flier.x + flier.width / 2, flier.y + flier.height / 2);
    await settle(page);
    p = await panelState(page);
    check('reversing a closing panel ends open with no leftovers', !!flier && cleanOpen(p), JSON.stringify({ flier, p }));
    // 近道を続けて押す
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(70); }
    await settle(page);
    p = await panelState(page);
    check('pressing the shortcut repeatedly mid-motion ends in a clean state', cleanOpen(p) || cleanClosed(p), JSON.stringify(p));
    await ctx.close();

    // ---- タッチ（タブレットの幅） ----
    const touch = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ja-JP', hasTouch: true });
    const tp = await touch.newPage();
    tp.on('pageerror', e => errors.push(e.message));
    await prepare(tp, base, ws);
    await tapOn(tp, '#browserEntry');
    await settle(tp);
    for (let i = 0; i < 14 && !(await readStrip(tp)).list; i++) { await tapOn(tp, '#filePreview .bu-new'); await settle(tp); }
    const ts = await readStrip(tp);
    await tapOn(tp, '#filePreview .bu-list');
    await tp.locator('.bu-alltabs').waitFor({ timeout: 3000 });
    const targetId = ts.tabs[0].id;
    await tapOn(tp, `.bu-alltabs li[data-target="${targetId}"]`);
    await tp.waitForTimeout(100);
    await settle(tp);
    const tsAfter = await readStrip(tp);
    check('tapping a row of the list switches to that tab', tsAfter.tabs.find(tab => tab.id === targetId)?.on === true && await tp.locator('.bu-alltabs').count() === 0, JSON.stringify({ list: !!ts.list, on: tsAfter.tabs.find(tab => tab.on)?.id, targetId }));
    await touch.close();

    check('no page errors', errors.length === 0, errors.join('\n'));
  } finally {
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
