// Run in the authenticated isolated fake server; no live accounts or LLM calls.
async page => page.evaluate(async () => {
  const results = [];
  const check = (condition, label) => { if (!condition) throw Error(label); results.push(label); };
  const { t } = await import('/i18n.mjs');
  const wait = () => new Promise(resolve => setTimeout(resolve, 80));
  const more = document.querySelector('#sessionMore');
  const openMenu = () => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); more.click(); };
  const row = label => [...document.querySelectorAll('.pop.menu:not([hidden]) button')].find(b => b.querySelector('.lbl')?.textContent === label);
  const mobile = matchMedia('(max-width:700px)').matches;
  const { makeBranchRow, layoutBranchSpine } = await import('/branch-view.mjs');
  const fixture = document.createElement('div'); fixture.className = 'thread';
  Object.assign(fixture.style, { position: 'fixed', width: '300px', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  const spine = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); spine.classList.add('spine');
  const branch = makeBranchRow('test', [{ id: 'a', name: 'A', n: 1 }, { id: 'b', name: 'B', n: 1 }], 'a', () => {});
  fixture.append(spine, branch); document.body.append(fixture);
  branch.layout(); layoutBranchSpine(fixture);
  const ring = branch.querySelector('.branch-ring').getBoundingClientRect(), box = branch.getBoundingClientRect();
  const origin = mobile ? 12 : 20;
  check(Math.abs(ring.x + ring.width / 2 - box.x - origin) < 1, 'Branch ring aligns with gutter center');
  check(spine.querySelector('path')?.getAttribute('d').startsWith(`M${origin},`), 'Branch spine uses the same center');
  fixture.remove();
  if (!mobile) {
    check(getComputedStyle(document.querySelector('#usageChip')).display !== 'none', 'PC keeps the usage chip');
    document.querySelector('#usageChip').click(); await wait();
    check(!document.querySelector('dialog.conversation-sheet[open]'), 'PC keeps its anchored usage popover');
    check(!document.querySelector('#usagePop').hidden, 'PC usage popover opens');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { results };
  }
  check(getComputedStyle(document.querySelector('#usageChip')).display === 'none', 'Mobile hides the composer usage chip');
  check(getComputedStyle(document.querySelector('#prompt')).fontSize === '17px', 'Mobile input is 17px');
  check(getComputedStyle(document.querySelector('#titleEdit')).fontSize === '20px', 'Mobile title is 20px');
  check(getComputedStyle(document.querySelector('.m.ai > .body')).fontSize === '17px', 'Mobile body is 17px');
  check(getComputedStyle(document.querySelector('#thread')).getPropertyValue('--gut').trim() === '24px', 'Mobile gutter is 24px');
  if (document.querySelector('.tc-main')) {
    check(getComputedStyle(document.querySelector('.tc-main')).fontSize === '15px', 'Tool target is 15px');
    check(getComputedStyle(document.querySelector('.tc-label')).fontSize === '13px', 'Tool verb is 13px');
    check(document.querySelector('.tc-head').getBoundingClientRect().height >= 44, 'Tool row is at least 44px');
  }
  openMenu();
  const labels = [...document.querySelectorAll('.pop.menu:not([hidden]) .lbl')].map(b => b.textContent);
  check(labels.includes(t('usage.header.title')) && labels.includes(t('compaction.short')), 'Menu has usage and compact');
  check(!labels.includes(t('compaction.disableConversation')), 'Auto-compaction switch is absent from root menu');
  check(!labels.includes(t('session.menu.rename')) && !labels.includes(t('session.menu.delete')), 'Full sidebar operations leave header menu');
  const buttons = [...document.querySelectorAll('.pop.menu:not([hidden]) button')];
  check(buttons.every(b => b.querySelector('svg.conversation-menu-icon')), 'All menu rows have icons');
  const iconStyle = getComputedStyle(buttons[0].querySelector('svg'));
  check(iconStyle.width === '16px' && iconStyle.strokeWidth === '1.6px', 'Icons are 16px with 1.6px strokes');
  check(row(t('usage.header.title')).querySelector('.usage-mini i')?.style.width === '73%', 'Usage row uses most constrained window');
  check(row(t('compaction.short')).querySelector('.usage-mini i')?.style.width === '82%', 'Compact row uses context usage');
  row(t('compaction.short')).click(); await wait();
  let dialog = document.querySelector('dialog.conversation-sheet[open]');
  check(dialog && dialog.querySelector('.conversation-graph'), 'Compact opens a context sheet');
  check(dialog.querySelector('[role=switch]'), 'Compact sheet contains per-conversation toggle');
  check([...dialog.querySelectorAll('button')].some(b => b.textContent === t('compaction.now')), 'Compact sheet has compact-now action');
  const toggle = dialog.querySelector('[role=switch]');
  const before = toggle.getAttribute('aria-checked'); toggle.click();
  for (let i = 0; i < 60 && dialog.querySelector('[role=switch]').getAttribute('aria-checked') === before; i++) await wait();
  check(dialog.querySelector('[role=switch]').getAttribute('aria-checked') !== before, 'Auto-compaction toggle saves');
  dialog.querySelector('[role=switch]').click();
  for (let i = 0; i < 60 && dialog.querySelector('[role=switch]').getAttribute('aria-checked') !== before; i++) await wait();
  check(dialog.querySelector('[role=switch]').getAttribute('aria-checked') === before, 'Auto-compaction toggle restores');
  dialog.close(); await wait();
  check(document.activeElement === more, 'Closing sheet returns focus to header menu');
  openMenu(); row(t('usage.header.title')).click(); await wait();
  dialog = document.querySelector('dialog.conversation-sheet[open]');
  check(dialog && dialog.contains(document.querySelector('#usagePop')), 'Usage opens a bottom sheet');
  check(dialog.querySelector('.conversation-context .usage-bar'), 'Usage sheet includes context graph');
  check(dialog.querySelector('.usage-agent .usage-bar'), 'Usage sheet includes quota graphs');
  const others = dialog.querySelector('.usage-other-agents');
  check(!others || !others.open, 'Other agents start collapsed');
  dialog.close(); await wait();
  document.querySelector('#titleEdit').focus();
  check(getComputedStyle(document.querySelector('#titleWand')).display !== 'none', 'AI title action is reachable while editing title');
  document.querySelector('#titleEdit').blur();
  return { results, emulation: { width: innerWidth, touch: navigator.maxTouchPoints, coarse: matchMedia('(pointer:coarse)').matches, ua: navigator.userAgent } };
})
