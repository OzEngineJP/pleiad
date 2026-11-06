// utilityProcess（core/server.mjs）からの「サーバーのある PC で開く」依頼を main の shell で実行する。
// 相手は core/os-open.mjs の parentPortOpener。許可範囲（作業ディレクトリ・添付・生成画像）と接続元の判定はサーバーが済ませている。
// main は範囲を知らないので、ここでは形だけを確かめ直す: 絶対パス・UNC でない・実在・「開く」は HTML のファイルだけ・
// 「既定のアプリで開く」は許した拡張子のファイルだけ（一覧は core/os-open.mjs の DEFAULT_APP_EXTENSIONS。ADR 0291 の 3）。
//   { type:'os-open', id, action:'reveal'|'open'|'default', path } -> { type:'os-open', id, ok, code?, detail? }
// 本体は画面の言語を知らないので、失敗は code で返し、文言はサーバーが辞書から引く（core/os-open.mjs の bridgeError）。
const path = require('node:path');
const fs = require('node:fs');

const OPENABLE = /\.html?$/i;
const ACTIONS = new Set(['reveal', 'open', 'default']);

const failure = (code, detail) => Object.assign(new Error(detail || code), { code });

// 許す一覧はサーバーと同じものを使う（2 つ持たない）。core は ESM なので動的 import で読む（desktop/i18n.cjs と同じ）
let osOpen = null;
const loadDefaultAppAllowed = async () => (osOpen ??= await import('../core/os-open.mjs')).defaultAppAllowed;

/**
 * 依頼を確かめる。通らなければ code 付きの例外。
 * default（既定のアプリ）はリンク・ジャンクションを解いた実体の名前で判断し、開くのも実体（realpath）。
 * defaultAppAllowed を渡さなければ default は断る
 */
function checkRequest(message, { stat = fs.statSync, realpath = fs.realpathSync.native, defaultAppAllowed = null } = {}) {
  const file = message?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || /[\u0000-\u001f]/.test(file)) throw failure('invalid-path');
  if (!ACTIONS.has(message.action)) throw failure('invalid-path', 'unknown action');
  let info;
  try { info = stat(file); } catch { throw failure('not-found'); }
  const directory = info.isDirectory();
  if (!directory && !info.isFile()) throw failure('not-file');
  if (message.action === 'open' && (directory || !OPENABLE.test(file))) throw failure('html-only');
  if (message.action === 'default') {
    if (directory) throw failure('type-not-allowed');
    let real;
    try { real = realpath(file); } catch { throw failure('not-found'); }
    if (typeof real !== 'string' || /^[\\/]{2}/.test(real)) throw failure('invalid-path');
    if (!defaultAppAllowed?.(real)) throw failure('type-not-allowed');
    return { action: 'default', file: real, directory: false };
  }
  return { action: message.action, file, directory };
}

/**
 * 依頼を受けて返すメッセージを作る（送るのは呼び出し側）。
 * beforeBrowserOpen: HTML のファイルを既定のブラウザーで開く直前の下準備（desktop/main.cjs。隠した Chrome の窓に
 *   開かれないよう、先に見える窓を前面にする）。省けば何もしない（テスト用）
 */
function createFileHandler({ shell, stat, realpath, beforeBrowserOpen = null, defaultAppAllowed = null }) {
  return async function handle(message) {
    const reply = { type: 'os-open', id: message?.id };
    try {
      const allowed = message?.action === 'default' ? (defaultAppAllowed ?? await loadDefaultAppAllowed()) : null;
      const { action, file, directory } = checkRequest(message, { stat, realpath, defaultAppAllowed: allowed });
      if (action === 'reveal' && !directory) shell.showItemInFolder(file);
      else {
        // フォルダーはその中を開き、HTML は既定のブラウザーで、default は関連付けのアプリで開く。失敗は文字列で返ってくる
        if (action === 'open' && !directory) await beforeBrowserOpen?.();
        const error = await shell.openPath(file);
        if (error) throw failure('open-failed', String(error).slice(0, 200));
      }
      return { ...reply, ok: true };
    } catch (e) {
      return { ...reply, ok: false, code: e?.code ?? 'open-failed', detail: String(e?.message ?? '').slice(0, 200) };
    }
  };
}

function attachFileBridge(worker, { shell, beforeBrowserOpen }) {
  const handle = createFileHandler({ shell, beforeBrowserOpen });
  worker.on('message', async message => {
    if (message?.type === 'os-open') worker.postMessage(await handle(message));
  });
}

module.exports = { attachFileBridge, createFileHandler, checkRequest };
