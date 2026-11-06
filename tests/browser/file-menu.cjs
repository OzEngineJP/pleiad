// Run after browser-unify-nochrome.cjs; exercises Pleiad's own shared menu.
(async () => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const state = window.__b3, preview = state.preview;
  const rows = () => [...document.querySelectorAll('.pop.menu > button .lbl')].map(el => el.textContent);
  const expected = ['エクスプローラーで表示', '既定のアプリで開く', 'パスをコピー', '相対パスをコピー', '保存', '会話で使う'];
  const target = { path:'D:/work/docs/file-preview.md', kind:'file', defaultAppAllowed:true };
  await preview.menu(320, 100, target);
  check(JSON.stringify(rows()) === JSON.stringify(expected), 'conversation file menu');
  check(document.querySelector('.pop .head').textContent === target.path, 'menu title is path');
  for (const entry of ['tab-more', 'tab-contextmenu', 'directory-row']) {
    state.menu.close();
    if (entry === 'directory-row') await preview.menu(320, 100, target);
    else state.menu.open(320, 100, preview.tabMenu({ page:target }), target.path);
    check(JSON.stringify(rows()) === JSON.stringify(expected), entry + ' same order');
  }
  const calls = state.calls.length;
  state.host = false;
  // Even a previously displayed host menu must recheck the screen before executing.
  document.querySelector('.pop.menu > button').click();
  check(state.calls.length === calls, 'stale host menu cannot open external app remotely');
  await preview.menu(320, 100, target);
  check(!rows().some(label => /エクスプローラー|既定の/.test(label)), 'remote menu hides host actions');
  state.host = true;
  await preview.menu(320, 100, { path:'D:/work/docs', kind:'directory' });
  check(rows()[0] === 'エクスプローラーで開く' && !rows().includes('保存'), 'folder label and no save');
  await preview.menu(320, 100, { path:'D:/work/run.ps1' });
  check(!rows().includes('既定のアプリで開く'), 'script extension not allowed');
  await preview.menu(320, 100, target);
  return { ok:true, checks:9 };
})()
