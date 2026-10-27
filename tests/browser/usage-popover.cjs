/** Run on the fake server with a setupHeaderUsage instance and synthetic quotas. */
async function({ usage, update } = {}) {
  const results = [];
  const check = (value, message) => { if (!value) throw new Error(message); results.push(message); };
  const wait = () => new Promise(resolve => setTimeout(resolve, 400));
  const pop = document.querySelector('#usagePop'), chip = document.querySelector('#usageChip');
  const opener = matchMedia('(max-width:700px)').matches ? document.querySelector('#sessionMore') : chip;
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const otherAgents = pop.querySelector('.usage-other-agents');
  if (otherAgents) otherAgents.open = false;
  if (!pop.hidden) escape();
  await wait();
  usage.open(opener); await wait();
  const sheet = document.querySelector('.usage-sheet[open]');
  const box = pop.getBoundingClientRect(), column = document.querySelector('main').getBoundingClientRect();
  const body = pop.querySelector('.usage-pop-body');
  if (!sheet) {
    check(pop.parentElement === document.body, 'Popover is outside the isolated conversation column');
    check(box.left >= column.left + 7.5 && box.right <= column.right - 7.5, 'Popover stays 8px inside the conversation column');
    check(box.width <= 340.5 && box.top >= 7.5 && box.bottom <= innerHeight, 'Popover width and height fit available space');
    check(document.activeElement === pop, 'Opening focuses the named nonmodal dialog');
  } else {
    check(sheet.matches(':modal'), 'Sheet uses the native modal dialog');
    check(sheet.getBoundingClientRect().bottom <= innerHeight + 1, 'Sheet fits the viewport');
    check(sheet.contains(document.activeElement), 'Opening focuses the modal sheet');
  }
  check(chip.getAttribute('aria-expanded') === 'true' && !!chip.getAttribute('aria-controls'), 'Entry describes expanded state and controlled content');
  check(pop.querySelector('.usage-other-agents') && !pop.querySelector('.usage-other-agents').open, 'Other agents start collapsed');
  for (const node of pop.querySelectorAll('.wl, .an small')) {
    check(getComputedStyle(node).whiteSpace !== 'nowrap', 'Quota and account labels wrap');
  }
  check(body.scrollWidth <= body.clientWidth + 1, 'Quota body has no horizontal scrolling');
  const firstMeter = pop.querySelector('[role=meter]');
  check(!!firstMeter?.getAttribute('aria-valuenow') && !!firstMeter.getAttribute('aria-description'), 'Meter has a value and recovery description');
  const grid = firstMeter.parentElement, label = grid.querySelector('.wl'), rate = grid.querySelector('.v');
  check(label.getBoundingClientRect().top <= rate.getBoundingClientRect().top + 3, 'Label and rate share the first row');
  check(firstMeter.getBoundingClientRect().width >= grid.clientWidth - 1, 'Meter uses the full row');
  const head = (sheet ?? pop).querySelector('.usage-pop-head');
  pop.querySelector('.usage-other-agents').open = true;
  await wait();
  const headTop = head.getBoundingClientRect().top;
  body.scrollTop = body.scrollHeight;
  await wait();
  check(head.getBoundingClientRect().top === headTop, 'Heading stays fixed while the body scrolls');
  const scroll = body.scrollTop, refresh = head.querySelector('.rf');
  refresh.focus({ preventScroll: true }); refresh.click(); await wait();
  check(document.activeElement === refresh && head.querySelector('.rf') === refresh, 'Refresh keeps the original focused button');
  check(pop.querySelector('.usage-other-agents').open && body.scrollTop === scroll, 'Refresh keeps expansion and body scroll');
  if (update) { await update(); await wait(); }
  escape(); await wait();
  check(pop.hidden && document.activeElement === opener, 'Escape closes and returns to the actual entry');
  usage.open(opener); await wait();
  const close = document.querySelector('.usage-sheet[open] .conversation-sheet-close') ?? pop.querySelector('.usage-pop-close');
  close.click(); await wait();
  check(pop.hidden && document.activeElement === opener, 'Close returns to the actual entry');
  usage.open(opener); await wait();
  if (!sheet) {
    const { createBrowserPanel } = await import('/browser-panel.mjs');
    const commands = [], state = { tabs: [], current: null };
    const bridge = { async command(action) { commands.push(action); return action === 'freeze' ? {} : state; }, layout() {}, onState() {} };
    const browser = createBrowserPanel({ bridge, showMenu() {} });
    const host = document.createElement('div'), rect = pop.getBoundingClientRect();
    Object.assign(host.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, visibility: 'hidden' });
    host.append(browser.body); Object.assign(browser.body.style, { width: '100%', height: '100%', visibility: 'visible' });
    document.body.append(host);
    try {
      browser.show(); await wait();
      check(commands.includes('freeze'), 'Body popover freezes an intersecting native browser view');
      pop.querySelector('.usage-pop-close').click(); await wait();
      check(commands.includes('unfreeze'), 'Closing popover restores the native browser view');
      const mark = commands.length;
      usage.open(opener); await wait();
      check(commands.slice(mark).includes('freeze'), 'Reopening popover is observed at its new body location');
    } finally { browser.hide(); host.remove(); }
  }
  return { results, viewport: [innerWidth, innerHeight], sheet: !!sheet };
}
