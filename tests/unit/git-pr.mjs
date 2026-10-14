// 会話の PR の拾い方（core/git-timeline.mjs の gh pr create の読み取り、結果を切るときに末尾の URL を残す shared.cutText）。
// Claude の Bash・PowerShell、Codex の commandExecution、Antigravity の run_command の形を、git も gh も呼ばずに確かめる。
import { eventsFromCall, timelineOf } from '../../core/git-timeline.mjs';
import { cutText } from '../../core/backends/shared.mjs';

export const name = 'git-pr';
export const title = 'PR の拾い方: シェルの包み・-R・前置き・連結・複数、結果を切っても末尾の URL を残す';

const URL = 'https://github.com/example/pleiad/pull/412';
const prs = (command, text = `${URL}\n`) => eventsFromCall({ command, text }).filter((e) => e.kind === 'pr');
const one = (command, text) => { const r = prs(command, text); return r.length === 1 && r[0].number === 412 && r[0].url === URL; };

export default async function (t) {
  t.ok('素の gh pr create', one('gh pr create --title "x" --body "y"'));
  t.ok('gh.exe と絶対パス', one('"C:\\Program Files\\GitHub CLI\\gh.exe" pr create --fill') && one('/usr/bin/gh pr create --fill'));

  // シェルの包み（1 段）
  t.ok('powershell -Command \'…\'', one(`powershell -NoProfile -Command 'gh pr create --title "a b" --body "c"'`));
  t.ok('powershell.exe の絶対パスと -Command "…"', one('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "gh pr create --title t"'));
  t.ok('pwsh -c', one(`pwsh -c 'gh pr create --fill'`));
  t.ok('bash -lc "…"', one('bash -lc "gh pr create --fill"') && one(`/bin/bash -lc 'cd repo && gh pr create --fill'`));
  t.ok('cmd /c', one('cmd /c gh pr create --fill') && one('cmd.exe /d /s /c "gh pr create --fill"'));
  t.ok('Codex の配列を空白でつないだ形（bash -lc の後ろが語に割れる）', one('bash -lc gh pr create --title t --body b'));
  t.ok('包みの中の連結 && ;', one(`bash -lc "git push -u origin x && gh pr create --fill"`) && one(`powershell -Command 'git push; gh pr create --fill'`));
  t.ok('包みを 2 段にしたものは読まない（1 段まで）', prs(`bash -lc "bash -lc 'gh pr create --fill'"`).length === 0);
  t.ok('包みの中身が gh pr create でなければ拾わない', prs(`bash -lc "echo gh pr create"`).length === 0 && prs(`powershell -Command 'gh pr view 412'`).length === 0);

  // gh の前置き
  t.ok('-R / --repo / --repo=', one('gh -R example/pleiad pr create --fill') && one('gh --repo example/pleiad pr create --fill') && one('gh --repo=example/pleiad pr create --fill'));
  t.ok('create の後ろの --repo', one('gh pr create --repo example/pleiad --fill'));
  t.ok('環境変数の前置き', one('GH_TOKEN=abc gh pr create --fill') && one('GH_HOST=github.com GH_TOKEN=abc gh pr create --fill') && one('env GH_TOKEN=abc gh pr create --fill'));
  t.ok('PowerShell の $env: の前置き', one(`powershell -Command '$env:GH_TOKEN="abc"; gh pr create --fill'`));
  t.ok('X=$(gh pr create …)', one('URL=$(gh pr create --fill)', `${URL}\n`) && one('url=$(gh pr create --title "a b" --body c) && echo $url', `${URL}\n${URL}\n`));
  t.ok('PowerShell の $x = gh pr create / & gh', one(`powershell -Command '$u = gh pr create --fill; $u'`) && one(`powershell -Command '& gh pr create --fill'`));

  // 連結・結果の形
  t.ok('&& ; の連結（git の動きも一緒に拾う）', (() => {
    const e = eventsFromCall({ command: 'git push -u origin fix/x && gh pr create --fill; echo done', text: `${URL}\ndone\n` });
    return e.length === 1 && e[0].kind === 'pr';
  })());
  t.ok('包みの中の commit も拾う（Codex は全部 bash -lc で包む）', (() => {
    const e = eventsFromCall({ command: `bash -lc "git checkout -b fix/x && git commit -m a"`, text: '[fix/x 3f2a9c1] a\n' });
    return e.map((x) => x.kind).join() === 'branch,commit';
  })());
  t.ok('結果の前後に文字があっても、末尾の URL を取る（途中の別の PR の URL を拾わない）',
    one('gh pr create --fill', `Warning: 1 uncommitted change (see https://github.com/example/pleiad/pull/3)\nCreating pull request for fix/x into main in example/pleiad\n\n${URL}\n`));
  t.ok('同じ URL が 2 回出ても 1 件', prs('gh pr create --fill', `${URL}\n${URL}\n`).length === 1);
  t.ok('create を 2 回呼んだら 2 件', (() => {
    const r = prs('gh pr create --fill -B a && gh pr create --fill -B b', `https://github.com/e/p/pull/1\nhttps://github.com/e/p/pull/2\n`);
    return r.map((x) => x.number).join() === '1,2';
  })());
  t.ok('gh pr view / pr list / issue create は PR の作成ではない', prs('gh pr view 412', `${URL}\n`).length === 0 && prs('gh pr list', `${URL}\n`).length === 0 && prs('gh issue create --fill', 'https://github.com/e/p/issues/5\n').length === 0);
  t.ok('失敗・URL の無い結果・exit!=0 は拾わない', eventsFromCall({ command: 'gh pr create', text: URL, isError: true }).length === 0
    && prs('gh pr create', 'a pull request for branch "x" into branch "main" already exists\n').length === 0
    && eventsFromCall({ command: 'gh pr create', text: `exit=1\n${URL}` }).length === 0);
  t.ok('Antigravity の run_command（CommandLine）の形', (() => {
    const e = timelineOf([{ role: 'assistant', uuid: 'a', at: 'x', toolCalls: [{ id: 't', name: 'run_command', input: { CommandLine: `powershell -Command 'gh -R example/pleiad pr create --fill'`, Cwd: 'D:/x' }, result: { text: `${URL}\n`, isError: false } }] }]);
    return e.length === 1 && e[0].kind === 'pr' && e[0].number === 412;
  })());
  t.ok('Codex の commandExecution（command が配列）の形', (() => {
    const e = timelineOf([{ role: 'assistant', uuid: 'a', at: 'x', toolCalls: [{ id: 't', name: 'shell', input: { command: ['bash', '-lc', 'gh pr create --fill'] }, result: { text: `exit=0\n${URL}\n`, isError: false } }] }]);
    return e.length === 1 && e[0].kind === 'pr' && e[0].number === 412;
  })());

  // 結果を切るとき、末尾の PR の URL を残す
  const long = `${'x'.repeat(3000)}\n${URL}\n`;
  const cut = cutText(long, 2000, '…省略');
  t.ok('切っても末尾の PR の URL を残す', cut.includes(URL) && cut.length < 2200 && cut.startsWith('xxxx'), cut.slice(-120));
  t.ok('切った結果からも PR が拾える', one('gh pr create --fill', cut));
  t.ok('短ければそのまま・URL が無ければ今までどおり切る', cutText('abc', 2000, '…') === 'abc' && cutText('y'.repeat(2500), 2000, '…') === `${'y'.repeat(2000)}…`);
  t.ok('切る前の本文の先頭側にある URL は残さない（捨てた末尾にあるものだけ）', !cutText(`${URL}\n${'z'.repeat(3000)}`, 2000, '…').slice(2000).includes(URL));
}
