import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyAddressInput as classify, resolveAddressInput } from '../../core/address-input.mjs';

export const name = 'address-input';
export const title = 'Address classification and host file policy';

export default async function(t) {
  const win = { platform: 'win32', cwd: 'D:\\work', home: 'C:\\Users\\person' };
  const unix = { platform: 'linux', cwd: '/work', home: '/home/person' };
  const cases = [
    ['C:\\', win, 'path', 'C:\\'],
    ['C:/dir/a b.md', win, 'path', 'C:\\dir\\a b.md'],
    ['~\\a', win, 'path', 'C:\\Users\\person\\a'],
    ['.\\a', win, 'path', 'D:\\work\\a'],
    ['..\\a', win, 'path', 'D:\\a'],
    ['./a', win, 'path', 'D:\\work\\a'],
    ['file:///C:/a%20b%23.md', win, 'path', 'C:\\a b#.md'],
    ['file://localhost/C:/a.md', win, 'path', 'C:\\a.md'],
    ['file:///tmp/a%20b', unix, 'path', '/tmp/a b'],
    ['~/a', unix, 'path', '/home/person/a'],
    ['../a', unix, 'path', '/a'],
    ['/tmp/a', unix, 'path', '/tmp/a'],
    ['\\\\server\\share', win, 'blocked', 'network-path'],
    ['//server/share', unix, 'blocked', 'network-path'],
    ['\\\\?\\C:\\x', win, 'blocked', 'network-path'],
    ['\\\\.\\pipe\\x', win, 'blocked', 'network-path'],
    ['file://server/share/a', win, 'blocked', 'network-path'],
    ['file:///C:/a%2fb', win, 'blocked', 'invalid-path'],
    ['file:///C:/%5c%5cserver/share', win, 'blocked', 'invalid-path'],
    ['file://%', win, 'blocked', 'invalid-path'],
    ['C:relative', win, 'blocked', 'invalid-path'],
    ['\\rooted', win, 'blocked', 'invalid-path'],
    ['/tmp/a', win, 'blocked', 'different-host'],
    ['C:/a', unix, 'blocked', 'different-host'],
    ['./a', { platform: 'linux' }, 'blocked', 'cwd-unknown'],
    ['docs/a.md', win, 'blocked', 'invalid-path'],
    ['docs\\a.md', win, 'blocked', 'invalid-path'],
    ['localhost:3000', win, 'url', 'http://localhost:3000/'],
    ['127.0.0.1:8080/a', win, 'url', 'http://127.0.0.1:8080/a'],
    ['[::1]:8080/a', win, 'url', 'http://[::1]:8080/a'],
    ['example.com', win, 'url', 'https://example.com/'],
    ['https://example.com/a?q=b', win, 'url', 'https://example.com/a?q=b'],
    ['javascript:alert(1)', win, 'blocked', 'invalid-url'],
    ['https://user:pass@example.com', win, 'blocked', 'invalid-url'],
    ['about:blank', win, 'url', 'about:blank'],
    ['words', win, 'search', 'words'],
    ['日本語の検索', win, 'search', '日本語の検索'],
    ['  ', win, 'blocked', 'empty-input'],
  ];
  for (const [input, options, kind, expected] of cases) {
    const result = classify(input, options);
    t.ok(input, result.kind === kind && (result.path ?? result.url ?? result.query ?? result.code) === expected, JSON.stringify(result));
  }
  // The address bar shows and edits the absolute path on PC and phone alike (ADR 0294 2.5), so what it shows can be submitted unchanged
  for (const [file, options] of [['D:\\work\\docs\\a.md', win], ['D:\\work\\notes', win], ['/work/docs/a.md', unix], ['/work/notes', unix], ['/other/a', unix], ['/work', unix], ['C:\\other\\a', win]]) {
    const result = classify(file, options);
    t.ok('absolute address can be submitted unchanged', result.kind === 'path' && result.path === file);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-address-'));
  try {
    const dataDir = path.join(root, 'data'), uploadDir = path.join(dataDir, 'uploads'), workspace = path.join(root, 'work');
    await fs.mkdir(uploadDir, { recursive: true }); await fs.mkdir(workspace);
    await fs.writeFile(path.join(dataDir, 'private.txt'), 'private');
    await fs.writeFile(path.join(uploadDir, 'attachment.txt'), 'attachment');
    await fs.writeFile(path.join(workspace, 'a.md'), 'hello');
    const options = { cwd: workspace, access: { dataDir, uploadDir } };
    t.ok('existing file resolves', (await resolveAddressInput('./a.md', options)).page === 'file');
    t.ok('existing directory resolves', (await resolveAddressInput('./', options)).page === 'dir');
    t.ok('data directory blocked', (await resolveAddressInput(dataDir, options)).code === 'protected-data');
    t.ok('uploads allowed', (await resolveAddressInput(path.join(uploadDir, 'attachment.txt'), options)).kind === 'path');
    t.ok('missing file never searches', (await resolveAddressInput('./missing', options)).code === 'not-found');
    t.ok('missing access fails closed', (await resolveAddressInput('./a.md', { cwd: workspace })).code === 'access-unavailable');
    t.ok('review confines path', (await resolveAddressInput(uploadDir, { ...options, access: { ...options.access, confine: workspace } })).code === 'protected-data');
    const alias = path.join(workspace, 'alias');
    await fs.symlink(dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    t.ok('realpath blocks data alias', (await resolveAddressInput(path.join(alias, 'private.txt'), options)).code === 'protected-data');
    await fs.unlink(alias);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
