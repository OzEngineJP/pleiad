// デスクトップ版の本体の窓が外へ出す URL（desktop/main.cjs の external）: http も https も既定のブラウザーで開く。
// 会話のリンク（md-link）は web/link-open.mjs が先に受けるが、設定・認証・PR の target=_blank の素のリンクは main の窓の開き口へ来る
// 既定のブラウザーで開く全部の経路（本体の窓・内蔵ブラウザーの道具・リモートの窓・OAuth の同意・HTML のファイル）は
// main.cjs の external / frontVisibleBrowser に集まる。隠した Chrome の窓に URL が入らないよう、開く前に見える窓を前面にする
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const name = 'desktop-external-link';
export const title = 'デスクトップ版: target=_blank の http・https は既定のブラウザーへ、資格情報つき・ほかのスキームは捨てる。開く前に見える Chrome の窓を前面にする';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { externalUrl } = require('../../desktop/external-url.cjs');

export default async function (t) {
  t.ok('https はそのまま', externalUrl('https://example.com/a?b=c') === 'https://example.com/a?b=c');
  t.ok('http も通す（以前は黙って捨てていた）', externalUrl('http://localhost:5173/x') === 'http://localhost:5173/x' && externalUrl('http://example.org/') === 'http://example.org/');
  t.ok('資格情報つきは捨てる', externalUrl('https://user:pass@example.com/') === null && externalUrl('http://user@example.com/') === null);
  t.ok('ほかのスキーム・壊れた URL は捨てる', ['file:///C:/x.html', 'javascript:alert(1)', 'ms-settings:', 'data:text/html,x', 'not a url', ''].every(url => externalUrl(url) === null));

  const main = fs.readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'desktop/browser-panel.cjs'), 'utf8');
  const remote = fs.readFileSync(path.join(ROOT, 'desktop/remote-windows.cjs'), 'utf8');
  const files = fs.readFileSync(path.join(ROOT, 'desktop/file-bridge.cjs'), 'utf8');
  t.ok('main は window.open と外のオリジンへの遷移を externalUrl で開く', /require\('\.\/external-url\.cjs'\)/.test(main) && /const href = externalUrl\(url\);\s*if \(!href\) return false;/.test(main)
    && /setWindowOpenHandler\(\(\{ url \}\) => \{ external\(url\)/.test(main));
  t.ok('external は、開く前に OS の層で見える Chrome の窓を前面にし（隠した窓に URL が入らないよう）、openExternal の失敗をログに残す',
    /await frontVisibleBrowser\(new URL\(href\)\.protocol\.slice\(0, -1\)\)/.test(main) && /chromeOs\?\.raiseVisibleBrowser/.test(main) && /log\(`external failed:/.test(main));
  t.ok('内蔵ブラウザー・リモートの窓・OAuth の同意も同じ出口（external）を通る',
    /openExternal: external/.test(main) && /attachSecretBridge\(messages, \{ safeStorage, openExternal: url => void external\(url\) \}\)/.test(main)
    && /void external\(url\)/.test(remote) && !/shell\(\)\.openExternal/.test(remote));
  t.ok('openExternal の失敗を .catch(() => {}) で捨てている箇所は残っていない',
    !/openExternal\([^)]*\)\.catch\(\(\) => \{\}\)/.test(main + panel + remote));
  t.ok('HTML のファイルを既定のブラウザーで開く前にも同じ下準備をする（openPath。既定かどうかは .html の関連付けで見る）',
    (main.match(/beforeBrowserOpen: \(\) => frontVisibleBrowser\('html'\)/g) ?? []).length === 2 && /await beforeBrowserOpen\?\.\(\)/.test(panel) && /await beforeBrowserOpen\?\.\(\)/.test(files));
}
