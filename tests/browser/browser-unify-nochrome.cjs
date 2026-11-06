// Evaluate in a browser serving this worktree's web/ modules (agent-browser eval --stdin).
// Uses the real preview and renderers; the host commands and Chrome are test doubles.
(async () => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const { setupFilePreview } = await import('/file-preview.mjs');
  const { createContextMenu } = await import('/context-menu.mjs');
  const { renderPresent, renderMarkdown, renderToolCall } = await import('/render.mjs');
  const { userBodyHtml } = await import('/user-message.mjs');
  const { configureIsolatedOrigin } = await import('/visualize-frame.mjs');
  location.hash = '';
  document.documentElement.classList.add('side-closed');
  document.body.innerHTML = '<aside id="sidebar"></aside><main><div id="log"></div></main>';
  const log = document.querySelector('#log');
  log.innerHTML = renderMarkdown('[ファイル](D:/work/docs/file-preview.md) · [Web](https://example.test/)');
  log.insertAdjacentHTML('beforeend', userBodyHtml('[添付] D:/work/report.html', [{ kind:'file', path:'D:/work/report.html', caption:'report.html' }]).html);
  log.append(renderToolCall('Read', { file_path:'D:/work/docs/file-preview.md' }));
  const state = window.__b3 = { host:true, connected:false, calls:[], tabs:[], sessionId:'b3' };
  const menu = createContextMenu();
  const cmd = async (name, args) => {
    state.calls.push([name, args]);
    if (state.pendingResolve) await new Promise(resolve => { state.finishResolve = resolve; });
    return { path:args.path, cwd:'D:/work', kind:args.path.endsWith('/docs') ? 'directory' : 'file', defaultAppAllowed:args.path.endsWith('.md') };
  };
  const preview = setupFilePreview({ getContext:() => ({ sessionId:state.sessionId }), cmd, useFile:() => {}, osActions:() => state.host,
    showMenu:(...args) => menu.open(...args) });
  preview.configureBrowserUnify({ caps:() => ({ pages:8124 }), connected:() => state.connected, tabs:() => state.tabs,
    openTab:args => { state.calls.push(['openTab', args]); if (args.path) state.tabs.push({ id:'tab1', path:args.path }); },
    focusTab:tab => state.calls.push(['focus', tab]), flashTab:tab => state.calls.push(['flash', tab]) });
  state.preview = preview; state.menu = menu;
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const link = log.querySelector('[data-file-path]');
  link.click(); await tick();
  check(document.querySelectorAll('iframe.page-frame').length === 1, 'file opens one iframe');
  check(document.querySelector('iframe.page-frame').src.includes('/_pleiad/s/b3/file?'), 'same Pleiad page');
  const attachment = log.querySelector('.msg-att-file');
  check(attachment, 'attachment renderer emits a file badge'); attachment.click(); await tick();
  check(document.querySelectorAll('iframe.page-frame').length === 1, 'attachment replaces iframe');
  check(document.querySelector('iframe.page-frame').src.includes('report.html'), 'attachment path routed');
  log.querySelector('.tc-file').click(); await tick();
  check(!state.calls.some(([name]) => /connect|openTab/.test(name)), 'no Chrome connection or tab request');
  const original = HTMLAnchorElement.prototype.click;
  let external = '';
  HTMLAnchorElement.prototype.click = function() { if (!this.className && this.target === '_blank') external = this.href; else original.call(this); };
  try { log.querySelector('a[target="_blank"]').click(); } finally { HTMLAnchorElement.prototype.click = original; }
  check(external === 'https://example.test/', 'Web link opens outside without chooser');
  state.connected = true;
  link.click(); await tick(); link.click(); await tick();
  check(state.calls.filter(([name]) => name === 'openTab').length === 1, 'canonical file reuses Chrome tab');
  check(state.calls.some(([name]) => name === 'focus') && state.calls.some(([name]) => name === 'flash'), 'existing tab focused and flashed');
  configureIsolatedOrigin({ port:8125 });
  const bundle = { hash:'a'.repeat(64), entry:'index.html', htmlOnly:true, reason:'legacy' };
  const card = renderPresent({ kind:'visualization', caption:'グラフ', content:'<p>グラフ</p>', bundle }); log.append(card);
  card.querySelector('.visualize-widen').click(); await tick();
  check(state.calls.at(-1)[1].url.endsWith('?embed=tab'), 'widen opens isolated tab');
  check(!card.classList.contains('visualize-widened'), 'connected widen does not widen in conversation');
  check(card.textContent.includes('関連ファイル'), 'HTML-only bundle notice');
  check(!card.querySelector('.visualize-open-browser'), 'one expand action on unified card');
  state.connected = false;
  preview.close(); card.querySelector('.visualize-widen').click(); await tick();
  if (matchMedia('(max-width:760px)').matches) {
    check(preview.panelOpen('visualization') && document.querySelector('.visualize-fill').src.includes(':8125/viz/'), 'phone expands isolated visualization into full-screen panel');
  } else check(card.classList.contains('visualize-widened'), 'no-Chrome desktop expands in conversation');
  preview.close(); state.pendingResolve = true;
  link.click(); await tick(); state.sessionId = 'other'; preview.sessionChanged('other');
  state.pendingResolve = false; state.finishResolve(); await tick();
  check(!document.querySelector('iframe.page-frame'), 'late file does not open in another conversation');
  state.sessionId = 'b3'; preview.sessionChanged('b3');
  const pendingMenu = preview.menu(200, 100, { path:'D:/work/docs/file-preview.md' });
  await pendingMenu;
  menu.close(); state.pendingResolve = true;
  const staleMenu = preview.menu(200, 100, { path:'D:/work/docs/file-preview.md' });
  await tick(); state.sessionId = 'other'; preview.sessionChanged('other');
  state.pendingResolve = false; state.finishResolve(); await staleMenu;
  check(!document.querySelector('.pop.menu'), 'late menu does not open in another conversation');
  state.sessionId = 'b3'; preview.sessionChanged('b3'); link.click(); await tick();
  return { ok:true, checks:16 };
})()
