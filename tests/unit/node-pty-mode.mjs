// node-pty の macOS の spawn-helper に実行権限を付ける（scripts/node-pty-mode.cjs。issue #70）。
//   - darwin-* の spawn-helper だけに付ける（ほかの OS・CPU の prebuild とほかのファイルには触れない）
//   - Windows では何もしない・node-pty が無くても落ちない
//   - npm ci の後（postinstall）と、パッケージを作るとき（afterPack）に呼ぶ
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { fixSpawnHelperMode } = require('../../scripts/node-pty-mode.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'node-pty-mode';
export const title = 'node-pty の macOS の spawn-helper に実行権限を付ける（postinstall・afterPack）';

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-node-pty-mode-'));
  try {
    const prebuilds = path.join(dir, 'node-pty', 'prebuilds');
    const put = (rel, mode) => { const f = path.join(prebuilds, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); fs.chmodSync(f, mode); return f; };
    const arm = put('darwin-arm64/spawn-helper', 0o644), x64 = put('darwin-x64/spawn-helper', 0o644);
    const node = put('darwin-arm64/pty.node', 0o644), linux = put('linux-x64/spawn-helper', 0o644);
    const mode = f => fs.statSync(f).mode & 0o777;
    const posix = process.platform !== 'win32';

    const fixed = fixSpawnHelperMode(dir, { platform: 'darwin' });
    t.ok('darwin の spawn-helper（arm64・x64）を返す', fixed.sort().join() === [arm, x64].sort().join(), JSON.stringify(fixed));
    if (posix) {
      t.ok('darwin の spawn-helper は実行できる（rwxr-xr-x）', mode(arm) === 0o755 && mode(x64) === 0o755, [mode(arm), mode(x64)].map(m => m.toString(8)).join());
      t.ok('ほかのファイルと、ほかの OS の prebuild には触れない', mode(node) === 0o644 && mode(linux) === 0o644);
    }
    t.ok('もう一度呼んでも同じ結果', fixSpawnHelperMode(dir, { platform: 'darwin' }).length === 2);
    t.ok('Windows では何もしない', fixSpawnHelperMode(dir, { platform: 'win32' }).length === 0);
    t.ok('node-pty が無くても落ちない', fixSpawnHelperMode(path.join(dir, 'nothing'), { platform: 'darwin' }).length === 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  t.ok('package.json: postinstall で実行権限を付ける', pkg.scripts.postinstall === 'node scripts/node-pty-mode.cjs');
  const after = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack.cjs'), 'utf8');
  t.ok('after-pack.cjs: macOS のパッケージでも実行権限を付ける', /electronPlatformName === 'darwin'[\s\S]*fixSpawnHelperMode\(/.test(after));
}
