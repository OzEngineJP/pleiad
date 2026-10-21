// 設定 › Pleiad Plus（web/plus-settings.mjs）: 状態ごとの行とボタン、送るコマンド、届かないときの一行、メニューの出し入れ（DOM の代役）
import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { renderPlus, setupPlusSettings } from '../../web/plus-settings.mjs';

export const name = 'plus-settings';
export const title = '設定 › Pleiad Plus: 状態ごとの中身とボタン・コマンド・届かない行・メニューの出し入れ（DOM の代役）';

const text = nodes => nodes.map(n => n.textContent).join(' ');
// dom-stub の querySelector は [data-fk=…] を読めないので自前で探す
function byFk(nodes, fk) {
  const walk = n => {
    if (n.dataset?.fk === fk) return n;
    for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit; }
    return null;
  };
  for (const n of nodes) { const hit = walk(n); if (hit) return hit; }
  return null;
}
const buttonTexts = nodes => {
  const out = [];
  const walk = n => { if (n.tagName === 'BUTTON') out.push(n.textContent); for (const c of n.children ?? []) walk(c); };
  for (const n of nodes) walk(n);
  return out;
};

const BASE = { available: true, state: 'on', needsUpdate: false, signedIn: false, login: { phase: 'idle' }, account: null, reachable: true, error: null, urls: { account: 'https://account.example.com', profile: null }, host: null, checkedAt: '' };
// resetAt は UTC の正午にする（日付はその場の時間帯で出すので、真夜中にすると UTC の CI で前の日になる）
const ACCOUNT = { uid: 'u1', email: 'user@example.com', provider: 'google.com', status: 'plus', plan: { name: 'Pleiad Plus' }, limits: { creditsPerMonth: 500 }, usage: { credits: 120, resetAt: '2026-11-01T12:00:00Z' } };

export default async function (t) {
  const sent = [], opened = [];
  const deps = { send: c => sent.push(c), openExternal: u => opened.push(u) };
  const render = s => renderPlus(s, deps);

  // needsUpdate: 1 行だけ
  let nodes = render({ ...BASE, needsUpdate: true });
  t.ok('needsUpdate: 「Pleiad を更新してください」の 1 行だけ', text(nodes) === 'Pleiad を更新してください' && !buttonTexts(nodes).length);

  // maintenance: 行だけ。ログイン中はアカウントの行（ボタンは出さない）
  nodes = render({ ...BASE, state: 'maintenance' });
  t.ok('maintenance: 行だけ', text(nodes).includes('Pleiad Plus はメンテナンス中です') && !buttonTexts(nodes).length);
  nodes = render({ ...BASE, state: 'maintenance', signedIn: true, account: ACCOUNT });
  t.ok('maintenance + ログイン中: アカウントの行が出てボタンは出さない', text(nodes).includes('user@example.com') && !buttonTexts(nodes).length);

  // ログインしていない
  nodes = render(BASE);
  t.ok('未ログイン: 「ログインしていません」とボタン「ログイン」', text(nodes).includes('ログインしていません') && buttonTexts(nodes).includes('ログイン'));
  byFk(nodes, 'login').onclick();
  t.ok('「ログイン」は plusLogin を送る', sent.at(-1) === 'plusLogin');
  nodes = render({ ...BASE, error: { code: 'relogin' } });
  t.ok('relogin: 「もう一度ログインしてください」', text(nodes).includes('もう一度ログインしてください'));

  // ログインの途中・失敗
  for (const phase of ['waiting', 'finishing']) {
    nodes = render({ ...BASE, login: { phase } });
    t.ok(`${phase}: 「ブラウザーでログインしています…」と「やめる」`, text(nodes).includes('ブラウザーでログインしています…') && buttonTexts(nodes).includes('やめる'));
  }
  byFk(nodes, 'cancel').onclick();
  t.ok('「やめる」は plusLoginCancel', sent.at(-1) === 'plusLoginCancel');
  nodes = render({ ...BASE, login: { phase: 'failed' } });
  t.ok('failed: 「ログインできませんでした」と「もう一度」', text(nodes).includes('ログインできませんでした') && buttonTexts(nodes).includes('もう一度'));
  byFk(nodes, 'retry').onclick();
  t.ok('「もう一度」は plusLogin', sent.at(-1) === 'plusLogin');

  // locked: API キーの画面と同じ文言
  nodes = render({ ...BASE, error: { code: 'locked' } });
  t.ok('locked: 「この起動では鍵を開けません」', text(nodes).includes('この起動では鍵を開けません') && !buttonTexts(nodes).length);

  // disabled
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, status: 'disabled' } });
  t.ok('disabled: アカウントの行と「使えなくなっています」、ボタンはログアウトだけ', text(nodes).includes('user@example.com') && text(nodes).includes('このアカウントは使えなくなっています') && buttonTexts(nodes).join() === 'ログアウト');

  // free: 「無料」と「Pleiad Plus にする」（urls.account + /plus）、「アカウントを管理」（urls.account）
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, status: 'free', plan: null, limits: null, usage: null } });
  t.ok('free: プラン「無料」、3 つのボタン', text(nodes).includes('無料') && buttonTexts(nodes).join('・') === 'Pleiad Plus にする・アカウントを管理・ログアウト', buttonTexts(nodes).join('・'));
  byFk(nodes, 'getPlus').onclick();
  t.ok('「Pleiad Plus にする」は urls.account + /plus を開く', opened.at(-1) === 'https://account.example.com/plus');
  byFk(nodes, 'manage').onclick();
  t.ok('「アカウントを管理」は urls.account を開く', opened.at(-1) === 'https://account.example.com');

  // urls.account がパスを持つとき（本番は <オリジン>/account）: /account/plus ではなくオリジンの /plus を開く
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, status: 'free', plan: null, limits: null, usage: null }, urls: { account: 'https://account.example.com/account', profile: null } });
  byFk(nodes, 'getPlus').onclick();
  t.ok('urls.account がパスを持つとき「Pleiad Plus にする」はオリジンの /plus を開く', opened.at(-1) === 'https://account.example.com/plus', opened.at(-1));
  byFk(nodes, 'manage').onclick();
  t.ok('urls.account がパスを持つとき「アカウントを管理」は urls.account そのものを開く', opened.at(-1) === 'https://account.example.com/account', opened.at(-1));

  // plus: プラン名・今月の利用・同期の置き場・ログアウト
  nodes = render({ ...BASE, signedIn: true, account: ACCOUNT });
  const tx = text(nodes);
  t.ok('plus: アカウントの行（メール・Google でログイン）とプラン', tx.includes('user@example.com') && tx.includes('Google でログイン') && tx.includes('Pleiad Plus'));
  t.ok('plus: 今月の利用の行', tx.includes('今月の利用: 120 / 500 クレジット（11月1日 に戻ります）'), tx);
  const walk = (n) => { if (n.id === 'plusSyncSection') return n; for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit; } return null; };
  const syncBox = nodes.map(n => walk(n)).find(Boolean);
  t.ok('plus: 同期のまとまりが出る（見出し・スイッチ・同期するもの）', syncBox && syncBox.textContent.includes('同期') && syncBox.textContent.includes('設定・skill・指示ファイルを同期する'));
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, status: 'free', plan: null } });
  t.ok('free: 同期のまとまりは出さない', !nodes.map(n => walk(n)).find(Boolean));
  byFk(nodes, 'logout').onclick();
  t.ok('「ログアウト」は plusLogout', sent.at(-1) === 'plusLogout');
  // 上限
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, usage: { credits: 500, resetAt: '2026-11-01T12:00:00Z' } } });
  t.ok('used >= limit: 「上限に達しました」', text(nodes).includes('上限に達しました'));
  // usage・limits が無ければ行は出さない
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, usage: null } });
  t.ok('usage が無ければ今月の利用は出さない', !text(nodes).includes('今月の利用'));
  // provider が google.com 以外なら入り方の行は出さない
  nodes = render({ ...BASE, signedIn: true, account: { ...ACCOUNT, provider: 'apple.com' } });
  t.ok('provider が google.com 以外なら下の行は出さない', !text(nodes).includes('Google でログイン'));

  // この PC の行: taken → 確かめ → plusHostRebind / limit / ほかは出さない
  nodes = render({ ...BASE, signedIn: true, account: ACCOUNT, host: { state: 'taken' } });
  t.ok('host taken: 文と「つなぎ直す」', text(nodes).includes('ほかの Pleiad Plus のアカウントでつないでいます') && buttonTexts(nodes).includes('つなぎ直す'));
  let asked = false;
  nodes = renderPlus({ ...BASE, signedIn: true, account: ACCOUNT, host: { state: 'taken' } }, { ...deps, askRebind: () => { asked = true; } });
  byFk(nodes, 'rebind').onclick();
  t.ok('「つなぎ直す」は確かめを開く', asked);
  nodes = renderPlus({ ...BASE, signedIn: true, account: ACCOUNT, host: { state: 'taken' } }, { ...deps, confirming: true });
  t.ok('確かめの窓: 文と「作り直す」「やめる」', text(nodes).includes('この PC の鍵を作り直します') && buttonTexts(nodes).includes('作り直す') && buttonTexts(nodes).includes('やめる'));
  byFk(nodes, 'rebindYes').onclick();
  t.ok('「作り直す」は plusHostRebind', sent.at(-1) === 'plusHostRebind');
  nodes = render({ ...BASE, signedIn: true, account: ACCOUNT, host: { state: 'limit' } });
  t.ok('host limit: 「このアカウントの上限に達しています」', text(nodes).includes('このアカウントの上限に達しています') && !buttonTexts(nodes).includes('つなぎ直す'));
  nodes = render({ ...BASE, signedIn: true, account: ACCOUNT, host: { state: 'ok' } });
  t.ok('ほかの host.state ならこの PC の行は出さない', !text(nodes).includes('つないでいます'));

  // reachable === false: 中身の上に 1 行（⚠ は付けない）
  nodes = render({ ...BASE, reachable: false, signedIn: true, account: ACCOUNT });
  const plain = nodes.map(n => n.outerHTML).join('');
  t.ok('reachable: false → 先頭に「サーバーへの接続に失敗しました」（⚠ 無し）', nodes[0].textContent === 'サーバーへの接続に失敗しました' && !plain.includes('⚠'));

  // ---- メニューの出し入れ（available === false で項目ごと出さない） ----
  // 起動の直後は WS がまだ開いていないので、setup は取らず client.mjs が ready の後に reconnected() を呼ぶ
  for (const [available, want] of [[false, true], [true, false]]) {
    const nodes2 = { plusTab: new N('button'), plusPanel: new N('section') };
    nodes2.plusTab.hidden = true;    // index.html の初期は hidden
    nodes2.plusPanel.hidden = true;
    const savedGet = document.getElementById;
    document.getElementById = id => nodes2[id] ?? null;
    let calls = 0;
    try {
      const settings = setupPlusSettings({ cmd: async () => { calls++; return { ...BASE, available }; }, page: () => {} });
      await new Promise(r => setImmediate(r));
      t.ok(`available === ${available} → setup は取らない（項目は隠れたまま）`, calls === 0 && nodes2.plusTab.hidden === true);
      settings.reconnected();
      await new Promise(r => setImmediate(r));
      t.ok(`available === ${available} → つながったあと plusTab は ${want ? '出さない' : '出す'}`, calls > 0 && nodes2.plusTab.hidden === want);
    } finally { document.getElementById = savedGet; }
  }

  // ---- ログインで委譲と通話に plus が自動で選ばれた案内（apiKeysChanged の autoPlus。1 度きり） ----
  {
    const nodes2 = { plusTab: new N('button'), plusPanel: new N('section') };
    const savedGet = document.getElementById;
    document.getElementById = id => nodes2[id] ?? null;
    const calls = [];
    let prefs = {};
    try {
      const settings = setupPlusSettings({ cmd: async (name, args) => { calls.push([name, args]); return {}; }, page: () => {}, getPrefs: () => prefs });
      settings.event({ type: 'apiKeysChanged', autoPlus: true });
      const notice = nodes2.plusPanel.children.find(n => n.className === 'mp-card');
      const noticeText = nodes2.plusPanel.textContent;
      t.ok('案内: 本文が出る', notice && noticeText.includes('委譲先の自動選択と音声通話に Pleiad Plus を使います'), noticeText);
      const closeBtn = notice?.querySelector('button');
      t.ok('案内: 閉じるは BUTTON の要素（[object …] の文字に化けない）', closeBtn && closeBtn.tagName === 'BUTTON' && !noticeText.includes('[object'));
      closeBtn?.onclick();
      const setPref = calls.find(([n]) => n === 'setPref');
      t.ok('「閉じる」は plus.autoNoticeSeen を保存する', setPref && setPref[1].key === 'plus' && setPref[1].value.autoNoticeSeen === true, JSON.stringify(setPref));
      t.ok('閉じたあと案内は消える', !nodes2.plusPanel.textContent.includes('委譲先の自動選択'));
      // 既に閉じたことがある（prefs.plus.autoNoticeSeen）なら出さない
      prefs = { plus: { autoNoticeSeen: true } };
      settings.event({ type: 'apiKeysChanged', autoPlus: true });
      t.ok('autoNoticeSeen があれば案内は出さない', !nodes2.plusPanel.textContent.includes('委譲先の自動選択'));
    } finally { document.getElementById = savedGet; }
  }
}
