// Open a running ply_shell command in the isolated fake server's work dialog.
// This test stops that command through the UI and keeps its final terminal open.
async () => {
  const checks = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const until = async fn => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 100)); }
    throw Error('Timed out waiting for background update');
  };
  const term = document.querySelector('#workBody .tc-term');
  check(Boolean(term) && !document.querySelector('#workBody .work-command, #workBody .work-output'), 'Command and output share one terminal');
  check(term.textContent.includes('checked item') && !term.textContent.includes('出力の取得に対応していません'), 'ply_shell shows real output');
  check(Boolean(document.querySelector('#workHead .work-stop')), 'ply_shell offers stop');
  term.scrollTop = 35;
  const before = term.textContent;
  await until(() => term.textContent !== before);
  check(Math.abs(term.scrollTop - 35) < 2, 'Background refresh preserves scrollback');
  term.scrollTop = term.scrollHeight;
  const tail = term.textContent;
  await until(() => term.textContent !== tail);
  check(term.scrollHeight - term.scrollTop - term.clientHeight < 2, 'Background refresh follows the tail');
  document.querySelector('#workHead .work-stop').click();
  await until(() => document.querySelector('#workBody [role=status]')?.textContent.includes('終了') && !term.querySelector('.tc-term-cursor'));
  check(document.querySelector('#workBody .tc-term') === term && term.textContent.includes('checked item'), 'Stopped command retains final output and completed state');
  check(!document.querySelector('#workHead .work-stop:not(:disabled)'), 'Stopped command cannot be stopped again');
  return { passed: checks.length, checks };
}
