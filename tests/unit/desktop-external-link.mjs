// デスクトップ版の本体の窓が外へ出す URL（desktop/main.cjs の external）: http も https も既定のブラウザーで開く。
// 会話のリンク（md-link）は web/link-open.mjs が先に受けるが、設定・認証・PR の target=_blank の素のリンクは main の窓の開き口へ来る
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const name = 'desktop-external-link';
export const title = 'デスクトップ版: target=_blank の http・https は既定のブラウザーへ、資格情報つき・ほかのスキームは捨てる';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { externalUrl } = require('../../desktop/external-url.cjs');

export default async function (t) {
  t.ok('https はそのまま', externalUrl('https://example.com/a?b=c') === 'https://example.com/a?b=c');
  t.ok('http も通す（以前は黙って捨てていた）', externalUrl('http://localhost:5173/x') === 'http://localhost:5173/x' && externalUrl('http://example.org/') === 'http://example.org/');
  t.ok('資格情報つきは捨てる', externalUrl('https://user:pass@example.com/') === null && externalUrl('http://user@example.com/') === null);
  t.ok('ほかのスキーム・壊れた URL は捨てる', ['file:///C:/x.html', 'javascript:alert(1)', 'ms-settings:', 'data:text/html,x', 'not a url', ''].every(url => externalUrl(url) === null));
  const main = fs.readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8');
  t.ok('main は window.open と外のオリジンへの遷移を externalUrl で開く', /require\('\.\/external-url\.cjs'\)/.test(main) && /const href = externalUrl\(url\);\s*if \(href\) shell\.openExternal\(href\)/.test(main)
    && /setWindowOpenHandler\(\(\{ url \}\) => \{ external\(url\)/.test(main));
}
