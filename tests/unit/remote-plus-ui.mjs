// 設定 › リモート「この PC へ」の Pleiad Plus の状態行・スイッチ・つなぎ方（DOM の代役）
import { methodOptions } from '../../web/remote-parts.mjs';
import { plusRemoteLine, plusRemoteToggleMode, partitionRemoteDevices, plusRemoteAvailable, initialRemoteMethod } from '../../web/remote.mjs';

export const name = 'remote-plus-ui';
export const title = '設定 › リモート「この PC へ」: Plus の状態・操作可否・端末の分け方・つなぎ方';

const PLUS = { available: true, state: 'on', signedIn: true, account: { status: 'plus', email: 'user@example.com' }, reachable: true };
const REMOTE = { enabled: true, plus: { connect: true, link: { state: 'connected' }, host: { state: 'registered' } } };

export default async function (t) {
  const cases = [
    [{ ...PLUS, needsUpdate: true }, REMOTE, 'Pleiad を更新してください', 'hide'],
    [{ ...PLUS, state: 'maintenance' }, REMOTE, 'Pleiad Plus はメンテナンス中です', 'disabled'],
    [{ ...PLUS, signedIn: false }, REMOTE, 'Pleiad Plus にログイン', 'hide'],
    [{ ...PLUS, account: { status: 'free' } }, REMOTE, 'Pleiad Plus にする', 'hide'],
    [{ ...PLUS, account: { status: 'disabled' } }, REMOTE, 'このアカウントでは公式の中継を使えません', 'disabled'],
    // 中継が 4401 account で閉じた。アカウントがまだ plus と読めているなら、スイッチの切り入れでつなぎ直せる
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'error', error: { code: 'account' } } } }, 'このアカウントでは公式の中継を使えません', 'enabled'],
    [{ ...PLUS, account: { status: 'disabled' } }, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'error', error: { code: 'account' } } } }, 'このアカウントでは公式の中継を使えません', 'disabled'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, host: { state: 'taken' } } },'この PC はほかの Pleiad Plus のアカウントでつないでいます。', 'disabled'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, host: { state: 'limit' } } }, 'このアカウントの上限に達しています', 'enabled'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'error' } } }, 'サーバーへの接続に失敗しました', 'enabled'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'connecting' } } }, '接続しています…', 'enabled'],
    [PLUS, REMOTE, null, 'enabled'],
  ];
  for (const [plus, remote, expected, toggle] of cases) {
    const line = plusRemoteLine(plus, remote);
    t.ok(`${expected ?? '通常'}: 状態行`, expected ? line?.text === expected : line === null, line?.text);
    t.ok(`${expected ?? '通常'}: トグル状態`, plusRemoteToggleMode(plus, remote) === toggle);
  }
  t.ok('Plus が利用できないときも status line に異常値を必要としない', plusRemoteLine({ ...PLUS, signedIn: false }, REMOTE).kind === 'login');
  t.ok('available: false はまとまりと手順の Plus 選択肢を隠す', !plusRemoteAvailable({ available: false }));
  t.ok('available: true は Plus 選択肢を出す', plusRemoteAvailable({ available: true }));
  t.ok('Plus 契約中だけ手順の既定選択が Plus', initialRemoteMethod({ account: { status: 'plus' } }) === 'plus' && initialRemoteMethod({ account: { status: 'free' } }) === 'own');

  const devices = partitionRemoteDevices([
    { id: 'made-up-a', via: 'own' }, { id: 'made-up-b', via: 'plus' }, { id: 'made-up-c' },
  ]);
  t.ok('端末は via で二つのまとまりに分かれる', devices.plus.map(d => d.id).join() === 'made-up-b' && devices.own.map(d => d.id).join() === 'made-up-a,made-up-c');

  let picked = '';
  const radios = methodOptions([
    { value: 'plus', label: 'Pleiad Plus', sub: 'user@example.com' },
    { value: 'own', label: '自分の中継サーバー', sub: 'relay.example.test' },
  ], 'plus', value => { picked = value; });
  const options = radios.children;
  t.ok('つなぎ方は選べる二つの radio', radios.getAttribute('role') === 'radiogroup' && options.length === 2 && options.every(n => n.getAttribute('role') === 'radio'));
  t.ok('選択した radio は aria-checked と tabindex に反映する', options[0].getAttribute('aria-checked') === 'true' && options[0].getAttribute('tabindex') === '0' && options[1].getAttribute('aria-checked') === 'false');
  options[1].onclick();
  t.ok('radio を押すと選択が変わる', picked === 'own');
}
