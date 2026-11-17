// 外のアプリ（Slack など）から渡った URL が、隠した専用の窓にタブとして入ったとき、見える窓へ開き直す（core/chrome/external-tab.mjs と中継 relay.mjs）。
// 過去に「起きては直す」を繰り返した症状（Chrome は外からの URL を last-active の窓に開く。隠した窓は作られた瞬間にアクティブになり last-active に残る。
// 6fe76bf9: Pleiad 経由の URL の前に見える窓を前面へ / 17dde7c1: 画面の外に残った窓を見える窓に数えない）の、Pleiad を通らない経路を押さえる。
// 判定（純粋な関数）の全ケースと、偽の Chrome・偽の OS の層での通し（移す・移さない・開けなかったら残す）。
// 本物の Windows の Chrome での確かめは tests/manual/external-url-hidden-window.mjs（手元で明示的に流す）。
import { classifyNewTab, allowRelocation, isRelocatableUrl, RELOCATE_MAX_PER_URL } from '../../core/chrome/external-tab.mjs';
import { agent, rig } from '../lib/chrome-relay-rig.mjs';

export const name = 'chrome-external-tab';
export const title = '外のアプリから渡った URL が隠した窓に入ったタブを見える窓へ移す: 判定（移す・移さない全ケース）と偽の Chrome での通し';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

export default async function (t) {
  // ===== 1. 判定（純粋な関数） =====
  const page = (extra = {}) => ({ targetId: 'T1', type: 'page', url: 'https://example.com/a', ...extra });
  const base = { windowKnown: true, live: true };
  t.ok('外から渡った http(s) の URL が会話の窓に入った → 移す', classifyNewTab({ info: page(), ...base }) === 'relocate');
  t.ok('openerId がある（window.open・target=_blank・OAuth の子窓）→ 移さない（開いた元が範囲に居なくても）', classifyNewTab({ info: page({ openerId: 'X' }), ...base }) === 'adopt');
  t.ok('開いた元が範囲にある → 今までどおりの popup の経路', classifyNewTab({ info: page({ openerId: 'X' }), openerKnown: true, ...base }) === 'popup');
  t.ok('利用者の窓（会話の窓でない）に入ったタブは見ない', classifyNewTab({ info: page(), windowKnown: false, live: true }) === 'ignore');
  t.ok('つなぎ終える前の知らせ（既存のタブの数え直し・更新の持ち越し）は会話のタブとして戻す', classifyNewTab({ info: page(), windowKnown: true, live: false }) === 'adopt');
  t.ok('人が引き継いでいる窓（見せている・一時停止）のタブは会話のもの', classifyNewTab({ info: page(), ...base, handedOver: true }) === 'adopt');
  t.ok('エージェントが窓・タブを開いている最中は外のタブと取り違えない', classifyNewTab({ info: page(), ...base, opening: true }) === 'adopt');
  t.ok('すでに範囲のタブ・page でないターゲットは見ない', classifyNewTab({ info: page(), tracked: true, ...base }) === 'ignore' && classifyNewTab({ info: page({ type: 'service_worker' }), ...base }) === 'ignore');
  t.ok('URL が空・about:blank の間は待つ。待った後も決まらなければ移さない', classifyNewTab({ info: page({ url: '' }), ...base, settled: false }) === 'wait'
    && classifyNewTab({ info: page({ url: 'about:blank' }), ...base, settled: false }) === 'wait'
    && classifyNewTab({ info: page({ url: '' }), ...base, settled: true }) === 'adopt');
  t.ok('http(s) でない URL（chrome://・file:・data:・javascript:）は移さない', ['chrome://newtab/', 'file:///C:/a.html', 'data:text/html,hi', 'javascript:alert(1)', 'mailto:a@b.c']
    .every(url => classifyNewTab({ info: page({ url }), ...base }) === 'adopt'));
  t.ok('空白・NUL を含む URL は移さない', !isRelocatableUrl('https://a.example/ x') && !isRelocatableUrl('https://a.example/\0') && isRelocatableUrl('http://a.example/x?y=1'));
  {
    const history = new Map();
    const at = 1000;
    const results = [];
    for (let i = 0; i <= RELOCATE_MAX_PER_URL; i += 1) results.push(allowRelocation(history, 'https://loop.example/', at + i));
    t.ok('同じ URL は短時間に何度も移さない（移した先がまた隠した窓に入っても堂々巡りにしない）', results.slice(0, RELOCATE_MAX_PER_URL).every(Boolean) && results[RELOCATE_MAX_PER_URL] === false);
    t.ok('別の URL・時間が経った後は移せる', allowRelocation(history, 'https://other.example/', at + 5) && allowRelocation(history, 'https://loop.example/', at + 60_000));
  }

  // ===== 2. 偽の Chrome・偽の OS の層での通し =====
  const r = await rig();
  let a;
  try {
    const url = await r.relay.endpoint('ext');
    a = await agent(url);
    await a.cmd('Target.setDiscoverTargets', { discover: true });
    const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
    const agentWindow = r.fake.targets().find(x => x.targetId === tabId).windowId;
    const openVisibleCalls = () => r.os.log.filter(x => x.op === 'openVisible');
    const userTabs = () => r.fake.targets().filter(x => x.windowId === r.fake.userWindow);
    t.ok('前提: エージェントの窓は隠れていて、利用者の窓とは別', r.os.hwnds().find(h => h.windowId === agentWindow)?.concealed === true && agentWindow !== r.fake.userWindow);
    await sleep(100);   // 窓を作った直後の「開いている最中」を過ぎる

    // 外から渡った URL が、隠した窓にタブとして入った（last-active の窓）
    const before = a.events.length;
    const hijacked = r.fake.openUserTab('https://slack-link.example/thread', 'Linked page', agentWindow);
    t.ok('隠した窓に入った外の URL を、見える窓で開き直す', await until(() => openVisibleCalls().some(x => x.url === 'https://slack-link.example/thread')), JSON.stringify(r.os.log.slice(-5)));
    t.ok('隠した窓のタブは閉じる', await until(() => !r.fake.targets().some(x => x.targetId === hijacked)));
    t.ok('見える窓（利用者の窓）にそのタブがある', userTabs().some(x => x.url === 'https://slack-link.example/thread'));
    t.ok('エージェントには見せない（targetCreated も getTargets にも出ない）', !a.events.slice(before).some(e => JSON.stringify(e).includes('slack-link'))
      && !(await a.cmd('Target.getTargets')).result.targetInfos.some(x => x.targetId === hijacked || x.url.includes('slack-link')));
    t.ok('エージェントのタブは残る', r.fake.targets().some(x => x.targetId === tabId));

    // 移さないもの: window.open で開いたタブ（openerId あり）
    const calls1 = openVisibleCalls().length;
    await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true });
    const opened = r.fake.windowOpen(tabId, 'https://oauth.example/consent', { popup: false });
    await sleep(400);
    t.ok('window.open（openerId あり）のタブは移さない・閉じない', openVisibleCalls().length === calls1 && r.fake.targets().some(x => x.openerId === tabId || x.targetId === opened?.targetId));

    // 移さないもの: about:blank のままのタブ（外の URL ではない）
    const blank = r.fake.openUserTab('about:blank', '', agentWindow);
    await sleep(2600);   // URL を待つ長さ（2 秒）を過ぎても移さない
    t.ok('URL が決まらない（about:blank のまま）タブは移さず、今までどおり会話のタブにする', openVisibleCalls().length === calls1 && r.fake.targets().some(x => x.targetId === blank));

    // 見える窓で開けなかったときは、タブを失わず今までどおり会話のタブにする
    r.os.opts.openVisibleFails = true;
    const kept = r.fake.openUserTab('https://cannot-open.example/', 'Cannot', agentWindow);
    t.ok('見える窓で開けなかった → 隠した窓のタブを閉じない（タブを失わない）', await until(() => openVisibleCalls().some(x => x.url === 'https://cannot-open.example/'))
      && await (async () => { await sleep(150); return r.fake.targets().some(x => x.targetId === kept); })());
    t.ok('開けなかったことをログに残す（URL は残さない）', r.logs.some(line => /could not be opened in a visible window/.test(line)) && !r.logs.some(line => /cannot-open\.example/.test(line)));
    r.os.opts.openVisibleFails = false;

    // 隠し損ね: popup の窓を外形で探すため、印に画面の外へ動かす。見つからなかったら、動かしたまま残さず元の外形へ戻す
    r.os.opts.hideBounds = true;   // 外形で窓が見つからない
    const popupTab = r.fake.windowOpen(tabId, 'https://popup.example/x', { popup: true });
    const popupWindow = r.fake.targets().find(x => x.targetId === popupTab).windowId;
    const original = { ...r.fake.windowBounds(popupWindow) };
    t.ok('前提: popup の窓の外形が分かる', Number.isFinite(original.left) && Number.isFinite(original.top));
    t.ok('隠せなかった popup の窓は、画面の外へ動かしたまま残さない（元の位置へ戻す）', await until(() => r.logs.some(line => /put back where it was/.test(line)))
      && r.fake.windowBounds(popupWindow).left === original.left && r.fake.windowBounds(popupWindow).top === original.top, JSON.stringify([original, r.fake.windowBounds(popupWindow)]));
    r.os.opts.hideBounds = false;
  } finally {
    a?.close();
    await r.stop();
  }
}
