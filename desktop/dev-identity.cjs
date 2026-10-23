// 開発版（パッケージ版でない起動。npm run desktop・electron .）を、インストール版と別のアプリとして起こす（#126）。
// Electron はアプリの名前から macOS のキーチェーンの項目（"<名前> Safe Storage"）と userData の置き場所を決める。
// どちらも agent-host だと、開発版の Electron が作った項目をインストール版が使うたびにキーチェーンの確認が出て、
// 単一起動の鍵（userData ごと）も重なってインストール版と同時に起こせない。
// 名前を分けると safeStorage の鍵も変わるので、既定のデータ置き場も分ける（インストール版の鍵で暗号化した秘密は読めず、
// データ置き場のロックも取り合うため）。AGENT_HOST_DATA を渡せばその場所を使う。
// 名前は userData・safeStorage・単一起動の鍵より前に決める必要があるので、main.cjs の最初に呼ぶ。
const os = require('node:os');
const path = require('node:path');

const DEV_APP_NAME = 'Pleiad Dev';
const DEV_DATA_DIR = '.agent-host-dev';

function applyDevIdentity({ app, env = process.env, home = os.homedir() }) {
  if (app.isPackaged) return null;
  app.setName(DEV_APP_NAME);
  if (!env.AGENT_HOST_DATA) env.AGENT_HOST_DATA = path.join(home, DEV_DATA_DIR);
  return { name: DEV_APP_NAME, dataDir: env.AGENT_HOST_DATA };
}

module.exports = { applyDevIdentity, DEV_APP_NAME, DEV_DATA_DIR };
