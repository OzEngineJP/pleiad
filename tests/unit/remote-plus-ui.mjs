// 設定 › リモート「この PC へ」の Pleiad Plus の状態行・スイッチ・つなぎ方（DOM の代役）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { methodOptions, stateLine, todoList, liveRow } from '../../web/remote-parts.mjs';
import { createRemoteStore } from '../../core/remote/devices.mjs';
import { plusRemoteLine, ownRemoteLine, plusRemoteToggleMode, partitionRemoteDevices, plusRemoteAvailable, plusRemoteShown, initialRemoteMethod, setupRemote } from '../../web/remote.mjs';
import { N } from '../lib/dom-stub.mjs';

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
    // アカウントから外された PC（つながりは disabled に落ち、誤りを持たない）: 「接続しています…」ではなく、登録し直す行
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'disabled' }, host: { state: 'removed' } } }, 'この PC は Pleiad Plus の登録から外されています。登録し直すと、中継と同期が再開します。', 'disabled', 'settings'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'disabled' }, host: { state: 'removed', error: { code: 'host_removed', permanent: true } } } }, 'この PC は Pleiad Plus の登録から外されています。登録し直すには、この PC の鍵を作り直します。', 'disabled', 'settings'],
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'error' } } }, 'サーバーへの接続に失敗しました', 'enabled'],
    // Plus が止まっている（api の 503・中継の 4401 plus unavailable）: つながらないのではなく、再開を待っている
    [PLUS, { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'retrying', error: { code: 'unavailable' } } } }, 'Pleiad Plus が一時的に止まっています（再開を待っています）', 'enabled'],
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
  // Plus が止まって（state off）入口が隠れても、つながりが再開を待っている間は「この PC へ」にまとまりと一行を出す
  const PLUS_OFF = { ...PLUS, available: false, state: 'off' };
  const WAITING = { ...REMOTE, plus: { ...REMOTE.plus, link: { state: 'retrying', error: { code: 'unavailable' } } } };
  t.ok('Plus が止まっている間はまとまりを出す', plusRemoteShown(PLUS_OFF, WAITING) && !plusRemoteShown(PLUS_OFF, REMOTE));
  t.ok('Plus が止まっている間の一行', plusRemoteLine(PLUS_OFF, WAITING)?.text === 'Pleiad Plus が一時的に止まっています（再開を待っています）');
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

  // ---- 「この PC へ」の画面（setupRemote を DOM の代役で描く）
  // 自分の中継サーバーを何も設定していなくても、まとまりと「未設定」の一行と「編集」を出す（承認 2026-10-21。docs/remote.md）
  const drawn = async (remote, plus = { available: false }, hostScreen = true) => {
    const saved = { getElementById: document.getElementById, createTextNode: document.createTextNode, body: document.body };
    const nodes = { remotePanel: new N('div'), remoteTab: new N('button') };
    document.getElementById = id => nodes[id] ?? null;
    document.createTextNode = text => String(text);   // 代役の append は文字列を文字のノードにする
    document.body = new N('body');   // createWizard は setup の時点で dialog を body に足す
    try {
      const panel = setupRemote({ cmd: async name => name === 'remoteStatus' ? remote : name === 'plusStatus' ? plus : {}, page: () => {} });
      panel.setHostScreen(hostScreen);
      await panel.refresh();
      return nodes.remotePanel;
    } finally {
      document.getElementById = saved.getElementById;
      document.createTextNode = saved.createTextNode;
      document.body = saved.body;
    }
  };
  const ownGroup = root => root.querySelectorAll('.rm-group').find(g => g.querySelector('.rm-gh')?.textContent === '自分の中継サーバー') ?? null;
  const unset = await drawn({ enabled: true, configured: false, relayUrl: null, connection: { state: 'idle' }, devices: [], plus: { connect: true }, pairing: { requests: [] } });
  const group = ownGroup(unset);
  t.ok('設定が無くても「自分の中継サーバー」のまとまりを出す', Boolean(group), unset.shown);
  t.ok('設定が無いときは中抜きの点で「未設定 · …」の一行', group?.querySelector('.rm-st')?.dataset.state === 'off'
    && group.querySelector('.rm-st').textContent === '未設定 · 「編集」で中継の URL と登録用の秘密を入れます', group?.shown);
  t.ok('設定が無いときも見出しの右に「編集」', group?.querySelector('.rm-gh-btn')?.dataset.fk === 'relayEdit' && group.querySelector('.rm-gh-btn').textContent === '編集');
  // 端末から開いた設定では、中継の設定はホストの画面だけの操作なので「編集」を出さない
  const fromDevice = ownGroup(await drawn({ enabled: true, configured: false, relayUrl: null, connection: { state: 'idle' }, devices: [], plus: { connect: true }, pairing: { requests: [] } }, { available: false }, false));
  t.ok('端末の画面では「編集」を出さない', Boolean(fromDevice) && !fromDevice.querySelector('.rm-gh-btn'));
  const off = await drawn({ enabled: false, configured: false, connection: { state: 'idle' }, devices: [], plus: { connect: true }, pairing: { requests: [] } });
  t.ok('許可がオフならまとまりは出さない', !ownGroup(off));
  const plusGroupOf = root => root.querySelectorAll('.rm-group').find(g => g.querySelector('.rm-gh')?.textContent?.includes('Pleiad Plus')) ?? null;
  const stopped = plusGroupOf(await drawn({ enabled: true, configured: false, connection: { state: 'idle' }, devices: [], pairing: { requests: [] },
    plus: { connect: true, link: { state: 'retrying', error: { code: 'unavailable' } } } }, PLUS_OFF));
  t.ok('Plus が止まっている間も「この PC へ」に Plus のまとまりと「一時的に止まっています」', Boolean(stopped)
    && (stopped.textContent ?? '').includes('Pleiad Plus が一時的に止まっています（再開を待っています）'), stopped?.textContent);

  // 「編集」の中の「中継の設定を消す」: 確かめてから URL と登録用の秘密を両方消す（issue #123）
  const SET = { enabled: true, configured: true, relayUrl: RELAY, hasEnrollSecret: true, connection: { state: 'connected' },
    devices: [{ id: 'made-up-own', via: 'own', name: 'Pixel' }, { id: 'made-up-plus', via: 'plus', name: 'iPad' }], plus: { connect: false }, pairing: { requests: [] } };
  const live = async (remote, fn) => {
    const saved = { getElementById: document.getElementById, createTextNode: document.createTextNode, body: document.body };
    const nodes = { remotePanel: new N('div'), remoteTab: new N('button') };
    document.getElementById = id => nodes[id] ?? null;
    document.createTextNode = text => String(text);
    document.body = new N('body');
    const sent = [];
    let current = remote;
    try {
      const panel = setupRemote({ page: () => {}, cmd: async (name, args) => {
        if (name === 'setRemoteSettings') {
          sent.push(args);
          current = { ...current, relayUrl: args.relayUrl ? current.relayUrl : null, hasEnrollSecret: args.enrollSecret === '' ? false : current.hasEnrollSecret, configured: false, connection: { state: 'disabled' } };
          return current;
        }
        return name === 'remoteStatus' ? current : name === 'plusStatus' ? { available: false } : {};
      } });
      panel.setHostScreen(true);
      await panel.refresh();
      const root = nodes.remotePanel;
      const byFk = fk => root.querySelectorAll('button').find(b => b.dataset.fk === fk) ?? null;
      await fn({ root, byFk, sent });
    } finally {
      document.getElementById = saved.getElementById;
      document.createTextNode = saved.createTextNode;
      document.body = saved.body;
    }
  };
  await live(SET, async ({ root, byFk, sent }) => {
    t.ok('閉じている間は「中継の設定を消す」を出さない', !byFk('relayRemove'));
    byFk('relayEdit').onclick();
    const remove = byFk('relayRemove');
    t.ok('「編集」の中に「中継の設定を消す」', remove?.textContent === '中継の設定を消す' && Boolean(byFk('relaySave')));
    remove.onclick();
    const ask = ownGroup(root)?.querySelector('.rm-relay-edit');
    t.ok('押すと欄の代わりに確かめ（own の端末の台数を添え、Plus の端末は数えない）', Boolean(ask) && !byFk('relaySave')
      && ask.textContent.includes('中継の URL と登録用の秘密を消しますか。') && ask.textContent.includes('この中継でつないだ端末 1 台は'), ask?.textContent);
    byFk('relayRemoveKeep').onclick();
    t.ok('「やめる」で欄に戻り、何も送らない', Boolean(byFk('relaySave')) && sent.length === 0);
    byFk('relayRemove').onclick();
    byFk('relayRemoveYes').onclick();
    await new Promise(r => setTimeout(r, 0));
    t.ok('「消す」は URL と秘密を空で送る', sent.length === 1 && sent[0].relayUrl === '' && sent[0].enrollSecret === '', JSON.stringify(sent));
    const group = ownGroup(root);
    t.ok('消した後は欄を閉じて「未設定 · …」の一行', !group?.querySelector('.rm-relay-edit')
      && group?.querySelector('.rm-st')?.textContent === '未設定 · 「編集」で中継の URL と登録用の秘密を入れます', group?.textContent);
  });
  // 環境変数の値だけのときは画面から消せないので出さない
  await live({ ...SET, relayUrlFromEnv: true, enrollSecretFromEnv: true }, async ({ byFk }) => {
    byFk('relayEdit').onclick();
    t.ok('環境変数の値だけなら「中継の設定を消す」を出さない', Boolean(byFk('relaySave')) && !byFk('relayRemove'));
  });
}
