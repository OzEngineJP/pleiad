// pleiad://plus/enable|disable リンクの解析（desktop/plus-link.cjs。docs/plus.md「入口を出すリンク」）
import { createRequire } from 'node:module';

export const name = 'desktop-plus-link';
export const title = 'pleiad://plus/enable|disable リンクを解析する';

const { plusLinkAction, plusLinkArgv } = createRequire(import.meta.url)('../../desktop/plus-link.cjs');

export default async function (t) {
  t.ok('enable を受ける', plusLinkAction('pleiad://plus/enable') === 'enable');
  t.ok('disable を受ける', plusLinkAction('pleiad://plus/disable') === 'disable');
  t.ok('末尾のスラッシュを許す', plusLinkAction('pleiad://plus/enable/') === 'enable');
  t.ok('大文字小文字を区別しない', plusLinkAction('PLEIAD://Plus/Enable') === 'enable');
  for (const url of [
    'pleiad://pair?x',                  // ペアリングなど、デスクトップが今扱っていないリンク
    'pleiad://plus',                    // 引数なし
    'pleiad://plus/foo',
    'pleiad://plus/enables',
    'pleiad://auth?code=x&state=y',     // ログインの戻り（Android 専用）
    'https://pleiad.dev/plus/enable',
    'pleiad+web://plus/enable',
    'pleiad://plus/enable?x',           // クエリーは取る（ホストとパスだけで決める）
  ]) {
    t.ok(`${url} → 扱わない${url === 'pleiad://plus/enable?x' ? '（クエリー付きの enable は受ける）' : ''}`,
      plusLinkAction(url) === (url === 'pleiad://plus/enable?x' ? 'enable' : null));
  }
  for (const junk of ['', null, undefined, 'not a url', 'pleiad://', 42]) {
    t.ok(`${JSON.stringify(junk)} → null`, plusLinkAction(junk) === null);
  }
  t.ok('argv から最初のリンクを拾う', plusLinkArgv(['Ply.exe', '--hidden', 'pleiad://plus/enable']) === 'enable');
  t.ok('argv に無ければ null', plusLinkArgv(['Ply.exe', '--hidden']) === null);
  t.ok('argv が無ければ null', plusLinkArgv(undefined) === null && plusLinkArgv('x') === null);
}
