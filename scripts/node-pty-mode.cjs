// node-pty 1.1.0 の macOS の prebuild（prebuilds/darwin-*/spawn-helper）は、npm から入れると実行権限が無い。
// 無いと pty.spawn が「posix_spawnp failed.」で失敗し、Claude のアカウントの認可（core/claude-login.mjs）が始まらない（issue #70）。
// npm ci の後（package.json の postinstall）と、パッケージを作るとき（scripts/after-pack.cjs。署名の前）に実行権限を付ける。
const fs = require('node:fs');
const path = require('node:path');

/** nodeModules の下の node-pty の darwin の spawn-helper に実行権限を付ける。付けたファイルを返す（Windows では何もしない） */
function fixSpawnHelperMode(nodeModules, { platform = process.platform } = {}) {
  if (platform === 'win32') return [];
  const prebuilds = path.join(nodeModules, 'node-pty', 'prebuilds');
  let dirs;
  try { dirs = fs.readdirSync(prebuilds); } catch { return []; }
  const fixed = [];
  for (const dir of dirs) {
    if (!dir.startsWith('darwin-')) continue;
    const file = path.join(prebuilds, dir, 'spawn-helper');
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if ((stat.mode & 0o111) !== 0o111) fs.chmodSync(file, stat.mode | 0o755);
    fixed.push(file);
  }
  return fixed;
}

module.exports = { fixSpawnHelperMode };
if (require.main === module) fixSpawnHelperMode(path.join(__dirname, '..', 'node_modules'));
