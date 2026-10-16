// electron-builder.yml の afterPack。順番が大事なので 1 つにまとめる:
// agent-browser を resources に置いた後で、実行場所の材料（公式の Node・manifest。agent-browser の SHA-256 も控える）を作る。
// macOS は node-pty の spawn-helper に実行権限を付ける（署名の前に。scripts/node-pty-mode.cjs）
const path = require('node:path');
const packAgentBrowser = require('./pack-agent-browser.cjs');
const packRuntime = require('./pack-runtime.cjs');
const { fixSpawnHelperMode } = require('./node-pty-mode.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    fixSpawnHelperMode(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app', 'node_modules'), { platform: 'darwin' });
  }
  await packAgentBrowser(context);
  await packRuntime(context);
};
