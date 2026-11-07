// リモート（スマホ・デスクトップ版のリモートの窓・LAN のブラウザー）でリンクを押したときの行き先（docs/remote.md §8.5）。
//   - web/host-only-links.mjs: localhost・ループバックは、サーバーのある PC の画面でなければ開かずに知らせる
//   - desktop/remote-windows.cjs の linkTarget: Web（既定のブラウザー）・localhost（知らせだけ）・それ以外（プロキシのページも開かない）
//   - Android・iOS の殻（HostActivity・HostViewController・LinkPolicy）: 新しい窓を殻が受けて振り分ける取り決めを文字列で。規則そのものは
//     mobile/android の LinkPolicyTest（Gradle）と mobile/ios の PolicyTests（swift test）が同じ表で確かめる
//   - web/file-preview.mjs: 「ブラウザーで開く」は写しの口（/visualization-snapshot）を使わない（ADR 0294 の 6）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isHostOnlyUrl, watchHostOnlyLinks } from '../../web/host-only-links.mjs';

export const name = 'remote-links';
export const title = 'リモートのリンク: localhost は知らせるだけ・Web は端末のブラウザー・プロキシのページは開かない（アプリの中の窓は無い）';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { linkTarget, isLoopbackHost } = require('../../desktop/remote-windows.cjs');

const LOOPBACK = ['http://localhost:3000/', 'http://LOCALHOST/', 'http://app.localhost:5173/', 'http://127.0.0.1:5173/', 'http://127.1.2.3/',
  'http://0.0.0.0:8080/', 'http://[::1]:3000/', 'https://localhost./', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/'];
const WEB = ['https://example.com/a?b=c', 'http://example.org/', 'http://192.168.1.10:3000/', 'https://localhost.example.com/'];

export default async function (t) {
  // ---- 画面（web/host-only-links.mjs）
  const page = 'http://127.0.0.1:51234';
  t.ok('ループバックの http(s) はホストの PC でだけ開ける（10 進の IPv4・IPv4 射影の IPv6 も）',
    LOOPBACK.every(u => isHostOnlyUrl(u, page)), LOOPBACK.filter(u => !isHostOnlyUrl(u, page)).join(' '));
  t.ok('Web のページ・画面自身のオリジン・相対・ほかのスキームは止めない',
    [...WEB, `${page}/viz/x/index.html`, '/local-file?path=x', '#top', 'mailto:a@example.com', 'not a url']
      .every(u => !isHostOnlyUrl(u, page)));

  const listeners = {};
  const root = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; } };
  let onHost = false;
  const told = [];
  watchHostOnlyLinks({ root, onHostScreen: () => onHost, notify: text => told.push(text), origin: () => page });
  const click = (href, extra = {}) => {
    const anchor = { getAttribute: () => href };
    const ev = { type: 'click', button: 0, defaultPrevented: false, target: { closest: sel => (sel === 'a[href]' ? anchor : null) },
      preventDefault() { this.defaultPrevented = true; }, ...extra };
    (listeners[ev.type])(ev);
    return ev.defaultPrevented;
  };
  t.ok('ほかの端末の画面では localhost のリンクを止めて知らせる（文言は辞書）',
    click('http://localhost:3000/') && told.length === 1 && /localhost/.test(told[0]) && !told[0].includes('timeline.link'));
  t.ok('Web のリンクは止めない（行き先はブラウザー・殻が決める）', !click('https://example.com/') && told.length === 1);
  t.ok('中クリック（auxclick）も同じ。右クリックは見ない',
    click('http://127.0.0.1:5173/', { type: 'auxclick', button: 1 }) && !click('http://127.0.0.1:5173/', { type: 'auxclick', button: 2 }));
  onHost = true;
  t.ok('サーバーのある PC の画面では止めない', !click('http://localhost:3000/'));

  // ---- デスクトップ版のリモートの窓（desktop/remote-windows.cjs）
  const origin = 'http://127.0.0.1:51234';
  t.ok('この窓のプロキシのページはどれも開かない（前の版の写しの口も）、ほかのポートは host-only',
    linkTarget(`${origin}/`, origin) === 'blocked' && linkTarget(`${origin}/local-file?path=x`, origin) === 'blocked'
      && linkTarget(`${origin}/visualization-snapshot?sessionId=s&id=i`, origin) === 'blocked'
      && linkTarget('http://127.0.0.1:51235/x', origin) === 'host-only');
  t.ok('Web は http も https も既定のブラウザー、localhost は host-only',
    WEB.every(u => linkTarget(u, origin) === 'external') && LOOPBACK.every(u => linkTarget(u, origin) === 'host-only'));
  t.ok('資格情報つき・ほかのスキーム・壊れた URL は開かない',
    ['https://user:pass@example.com/', 'file:///C:/x.html', 'javascript:alert(1)', 'intent://x#Intent;end', 'about:blank', '::']
      .every(u => linkTarget(u, origin) === 'blocked'));
  t.ok('isLoopbackHost は [] 付きの IPv6 と末尾の点を受ける', isLoopbackHost('[::1]') && isLoopbackHost('localhost.') && !isLoopbackHost('128.0.0.1'));
  const rw = read('desktop/remote-windows.cjs');
  t.ok('リモートの窓は新しい窓を開かせず、Web だけ既定のブラウザーへ（アプリの中の窓は作らない）',
    /setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(linkTarget\(url, entry\.origin\) === 'external'\) openOutside\(url\);\s*return \{ action: 'deny' \};/.test(rw)
      && !/openSnapshot/.test(rw));
  t.ok('クリップボードの許可はリモートの窓そのものだけ',
    /contents === windows\.get\(hostId\)\?\.win\.webContents/.test(rw));

  // ---- Android の殻（HostActivity）
  const host = read('mobile/android/app/src/main/kotlin/dev/pleiad/app/HostActivity.kt');
  t.ok('新しい窓は殻が受ける（setSupportMultipleWindows(true)）。押したときだけ（isUserGesture）',
    /setSupportMultipleWindows\(true\)/.test(host) && /override fun onCreateWindow\([^)]*\): Boolean \{\s*if \(!isUserGesture\) return false/.test(host));
  const popup = host.slice(host.indexOf('private fun newPopup'), host.indexOf('private fun place'));
  t.ok('受けた窓にはホストの画面の口を入れない（plyRemote・ダウンロード・さらに窓を開く）',
    popup.length > 0 && !/injectRemote|addDocumentStartJavaScript|setDownloadListener/.test(popup) && /setSupportMultipleWindows\(false\)/.test(popup)
      && /allowFileAccess = false/.test(popup));
  t.ok('受けた窓はページを読まない（スクリプトも切る）。最初の行き先を振り分けたら捨てる',
    /javaScriptEnabled = false/.test(popup) && /private fun place\(view: WebView, u: Uri\) \{\s*openOutside\(u\)\s*if \(view === popup\) root\.post \{ if \(popup === view\) closePopup\(\) \}/.test(host));
  t.ok('振り分けは LinkPolicy（Web は ACTION_VIEW、localhost は知らせ）。アプリの中の写しのシートは無い',
    /LinkPolicy\.classify\(/.test(host) && /Intent\.ACTION_VIEW/.test(host) && /R\.string\.link_host_only/.test(host)
      && !/SNAPSHOT|showSheet|sheet_close/.test(host));
  const ui = { ja: JSON.parse(read('web/locales/ja/ui.json')), en: JSON.parse(read('web/locales/en/ui.json')) };
  const res = lang => read(`mobile/android/app/src/main/res/${lang === 'ja' ? 'values-ja' : 'values'}/strings.xml`);
  const str = (xml, key) => xml.match(new RegExp(`<string name="${key}">([^<]*)</string>`))?.[1]?.replace(/\\'/g, "'");
  t.ok('殻の知らせは画面の辞書と同じ文言（ja・en）',
    ['ja', 'en'].every(l => str(res(l), 'link_host_only') === ui[l].timeline.link.hostOnly) && !/sheet_close/.test(res('ja') + res('en')));

  // ---- iOS の殻（HostViewController・LinkPolicy）
  const ios = read('mobile/ios/App/App/HostViewController.swift');
  const policy = read('mobile/ios/remote-core/Sources/PleiadRemote/Policies.swift');
  t.ok('iOS も新しい窓の行き先が分かれば外へ振り分けるだけ。アプリの中の写しのシートは無い',
    /createWebViewWith[\s\S]*?if let u = action\.request\.url, !u\.absoluteString\.isEmpty, u\.absoluteString != "about:blank" \{\s*openOutside\(u\)\s*return nil/.test(ios)
      && !/snapshot|showSheet|sheetClose/i.test(ios) && !/snapshot|SNAPSHOT_PATH/.test(policy) && !/sheetClose/.test(read('mobile/ios/App/App/ShellTexts.swift')));

  // ---- 「ブラウザーで開く」は写しの口（/visualization-snapshot）を使わない（ADR 0294 の 6）
  t.ok('画面は写しの URL を作らない', !/visualization-snapshot/.test(read('web/file-preview.mjs')));
}
