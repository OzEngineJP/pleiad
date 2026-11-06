import { recentFilesOf, visualizationLinksOf } from '../../core/session-files.mjs';

export const name = 'session-files';
export const title = 'ファイルのページの最近のファイル・可視化の一覧を会話の記録から拾う';

const HASH = 'a'.repeat(64), HASH2 = 'b'.repeat(64);

export default async function (t) {
  const messages = [
    { role: 'user', at: '2026-11-06T00:00:00Z', toolCalls: [{ name: 'Read', input: { file_path: '/u/should-not.md' } }] },
    { role: 'assistant', at: '2026-11-06T00:01:00Z', toolCalls: [
      { name: 'Read', input: { file_path: '/w/a.md' }, at: '2026-11-06T00:01:00Z', result: { text: 'x' } },
      { name: 'Edit', input: { file_path: '/w/b.mjs' }, at: '2026-11-06T00:02:00Z', result: { text: 'ok' } },
      { name: 'Write', input: { file_path: '/w/fail.mjs' }, at: '2026-11-06T00:03:00Z', result: { isError: true } },
      { name: 'Bash', input: { command: 'cat /w/c.md' }, result: { text: '' } },
      { name: 'read_file', input: { path: '/w/codex.md' }, at: '2026-11-06T00:04:00Z', result: {} },
      { name: 'NotebookEdit', input: { notebook_path: '/w/n.ipynb' }, at: '2026-11-06T00:05:00Z', result: {} },
      { name: 'Read', input: { file_path: '/w/a.md' }, at: '2026-11-06T00:06:00Z', result: {} },
    ] },
  ];
  const presents = [
    { by: 'human', kind: 'file', path: '/w/attached.png', at: '2026-11-06T00:07:00Z' },
    { by: 'ai', kind: 'file', path: '/w/ai-present.png', at: '2026-11-06T00:08:00Z' },
    { by: 'human', kind: 'visualization', path: '/w/viz.html', at: '2026-11-06T00:09:00Z' },
  ];
  const files = recentFilesOf({ messages, presents, toolHints: { read_file: { shape: 'read' } }, actor: 'Claude Code' });
  t.ok('読んだ・編集した・添付したファイルを新しい順に、同じパスは新しい 1 つだけ',
    JSON.stringify(files.map(f => [f.path, f.source])) === JSON.stringify([
      ['/w/attached.png', 'attached'], ['/w/a.md', 'read'], ['/w/n.ipynb', 'edited'], ['/w/codex.md', 'read'], ['/w/b.mjs', 'edited']]));
  t.ok('失敗したツール・シェル・人の発言・AI の提示・可視化は拾わない',
    !files.some(f => ['/w/fail.mjs', '/w/c.md', '/u/should-not.md', '/w/ai-present.png', '/w/viz.html'].includes(f.path)));
  t.ok('AI のものに担当（バックエンドの名前）を付け、添付には付けない',
    files.find(f => f.path === '/w/a.md').actor === 'Claude Code' && !Object.hasOwn(files[0], 'actor'));
  t.ok('記録が壊れていても投げない', recentFilesOf({ messages: null, presents: 'x' }).length === 0 && recentFilesOf().length === 0);

  const rows = [
    { kind: 'visualization', caption: '古い図', bundle: { hash: HASH, entry: 'index.html' } },
    { kind: 'visualization', caption: '失敗', error: 'x', bundle: { hash: HASH, entry: 'index.html' } },
    { kind: 'visualization', caption: '束なし' },
    { kind: 'visualization', path: '/w/report.html', bundle: { hash: HASH2, entry: 'sub dir/レポート.html' } },
    { kind: 'visualization', caption: '形違い', bundle: { hash: 'zz', entry: 'index.html' } },
  ];
  const links = visualizationLinksOf(rows, 49199);
  t.ok('束のある可視化を新しい順に、隔離の origin の別のタブの URL にする（入口の名前は区切りごとに符号化。題はタブの <title> に使う）',
    links.length === 2 && links[0].title === '/w/report.html'
    && links[0].url === `http://localhost:49199/viz/${HASH2}/sub%20dir/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.html?embed=tab&title=%2Fw%2Freport.html`
    && links[1].url === `http://localhost:49199/viz/${HASH}/index.html?embed=tab&title=%E5%8F%A4%E3%81%84%E5%9B%B3`);
  t.ok('隔離の port がまだ無ければ空', visualizationLinksOf(rows, undefined).length === 0 && visualizationLinksOf(rows, 0).length === 0);
}
