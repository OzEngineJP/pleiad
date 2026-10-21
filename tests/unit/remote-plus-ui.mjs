// 設定 › リモート「この PC へ」の Pleiad Plus の状態行・スイッチ・つなぎ方（DOM の代役）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { methodOptions, stateLine, todoList, liveRow } from '../../web/remote-parts.mjs';
import { createRemoteStore } from '../../core/remote/devices.mjs';
import { plusRemoteLine, ownRemoteLine, plusRemoteToggleMode, partitionRemoteDevices, plusRemoteAvailable, initialRemoteMethod } from '../../web/remote.mjs';

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
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'connecting' } } }, '接続しています…', 'enabled', 'connecting'],
    // つながっているときも、切っているときも、見出しの下で一行を言う（承認 2026-10-21）
    [PLUS, REMOTE, 'つながっています · user@example.com', 'enabled', 'ok'],
    [{ ...PLUS, account: { status: 'plus' } }, REMOTE, 'つながっています', 'enabled', 'ok'],
    [PLUS, { ...REMOTE, relayUrl: 'https://relay.example.com', plus: { ...REMOTE.plus, connect: false, link: { state: 'idle' } } }, 'オフ · スマホからは自分の中継サーバーでつながります', 'enabled', 'off'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, connect: false, link: { state: 'idle' } } }, 'オフ', 'enabled', 'off'],
    // まだ張り始めていない（link が無い）ときは接続中
    [PLUS, { enabled: true, plus: { connect: true } }, '接続しています…', 'enabled', 'connecting'],
  ];
  for (const [plus, remote, expected, toggle, kind] of cases) {
    const line = plusRemoteLine(plus, remote);
    t.ok(`${expected}: 状態行`, line?.text === expected && (!kind || line.kind === kind), JSON.stringify(line));
    t.ok(`${expected}: トグル状態`, plusRemoteToggleMode(plus, remote) === toggle);
  }

  const RELAY = 'https://relay.example.com';
  const own = [
    [{ enabled: true, configured: true, relayUrl: RELAY, connection: { state: 'connected' } }, 'ok', 'つながっています · relay.example.com'],
    [{ enabled: true, configured: true, relayUrl: RELAY, connection: { state: 'connecting' } }, 'connecting', '接続しています…'],
    [{ enabled: true, configured: false, connection: { state: 'idle' } }, 'off', '未設定 · 「編集」で中継の URL と登録用の秘密を入れます'],
  ];
  for (const [remote, kind, text] of own) {
    const line = ownRemoteLine(remote);
    t.ok(`自分の中継サーバー: ${text}`, line?.kind === kind && line.text === text, JSON.stringify(line));
  }
  t.ok('自分の中継サーバーにつながらないときは状態行ではなく注意の一行（null）',
    ownRemoteLine({ enabled: true, configured: true, relayUrl: RELAY, connection: { state: 'retrying' } }) === null);

  const ok = stateLine('ok', 'つながっています · user@example.com');
  t.ok('状態行（ok）は塗りの点と文字、読み上げは status', ok.className === 'rm-st rm-st-ok' && ok.getAttribute('role') === 'status'
    && ok.children[0].className === 'rm-dot rm-dot-ok' && ok.textContent === 'つながっています · user@example.com');
  t.ok('状態行（off）は中抜きの点', stateLine('off', 'オフ').children[0].className === 'rm-dot rm-dot-off');
  t.ok('状態行（connecting）は回る印', /rm-spin/.test(stateLine('connecting', '接続しています…').children[0].getAttribute('class') ?? ''));

  const todo = todoList([{ text: 'スマホに Pleiad を入れる', done: true }, { text: 'スマホの Pleiad で Pleiad Plus にログイン', sub: 'user@example.com', done: false }]);
  const [first, second] = todo.children;
  t.ok('するべきことの並び: 済んだものはチェック、まだのものは番号とメール', todo.tagName.toLowerCase() === 'ol' && first.className === 'done'
    && second.className === '' && second.children[0].textContent === '2' && second.textContent.includes('user@example.com'));
  const waiting = liveRow({ ok: false, text: 'スマホを待っています' });
  const done = liveRow({ ok: true, text: 'Pixel をつなぎました' });
  t.ok('待っている行は回る印から、チェックと強い字の「つなぎました」に替わる', waiting.className === 'rm-live' && done.className === 'rm-live rm-live-ok'
    && done.textContent === 'Pixel をつなぎました' && done.getAttribute('role') === 'status');
  // 公式の中継の既定は入。人が切り替えた印（userSet）の無い connect: false は、既定が切だった頃の値なので入として読む
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-remote-plus-default-'));
  try {
    const store = createRemoteStore({ dataDir: dir });
    t.ok('設定が無ければ Pleiad Plus の中継は入', (await store.settings()).plus.connect === true);
    await fs.mkdir(path.join(dir, 'remote'), { recursive: true });
    const file = path.join(dir, 'remote', 'settings.json');
    await fs.writeFile(file, JSON.stringify({ enabled: true, plus: { connect: false } }));
    t.ok('印の無い connect: false（前の既定のまま）は入として読む', (await store.settings()).plus.connect === true);
    await fs.writeFile(file, JSON.stringify({ enabled: true, plus: { connect: false, userSet: true } }));
    t.ok('人が切った（userSet）connect: false は切のまま', (await store.settings()).plus.connect === false);
    await store.saveSettings({ enabled: false });
    t.ok('ほかの設定を保存しても、人が切った印は残る', (await store.settings()).plus.connect === false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }

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
